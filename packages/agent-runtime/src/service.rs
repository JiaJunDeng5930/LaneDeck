use std::path::PathBuf;

use chrono::{DateTime, Duration, Utc};
use lanedeck_lane_engine::{
    EngineEffect, EngineError, HistoryRequest, HistoryStore, LaneEngine, StageRunner,
};
use lanedeck_protocol::{
    Frame, IngestBatch, LaneConfig, StageHistory, StageInvocation, StageKind, StageMode,
    StageResult,
};
use serde_json::Value;

use crate::{
    AgentConfig, AgentError, AgentRunReport, CenterClient, ControlMessage, ControlReply,
    FlushReport, LocalSpool, RetryReason, ScriptPurpose, ScriptRunOutput, ScriptRunRequest,
    ScriptRunner, ScriptSideEffectPolicy,
};

const BUILD_CONTENT_TIMEOUT_SECONDS: i64 = 300;

pub struct AgentService<C, P, R> {
    center: C,
    spool: P,
    runner: R,
    workspace_id: String,
    machine_id: String,
    flush_limit: usize,
    lanes: Vec<LaneRuntime>,
    next_batch_no: u64,
}

struct LaneRuntime {
    lane: LaneConfig,
    engine: LaneEngine<ServiceHistoryStore, PassthroughStageRunner>,
}

#[derive(Clone, Default)]
struct ServiceHistoryStore {
    upstream_frames: Vec<Frame>,
    metric_frames: Vec<Frame>,
    event_frames: Vec<Frame>,
}

#[derive(Clone, Default)]
struct PassthroughStageRunner;

impl<C, P, R> AgentService<C, P, R>
where
    C: CenterClient,
    P: LocalSpool,
    R: ScriptRunner,
{
    pub fn new(config: AgentConfig, center: C, spool: P, runner: R) -> Result<Self, AgentError> {
        let mut lanes = Vec::with_capacity(config.lanes.len());

        for lane in config.lanes {
            let lane_config = lane.config;
            validate_script_raw_stage(&lane_config)?;
            lanes.push(LaneRuntime::new(lane_config)?);
        }

        Ok(Self {
            center,
            spool,
            runner,
            workspace_id: config.workspace_id,
            machine_id: config.machine_id,
            flush_limit: config.flush.max_batch_size,
            lanes,
            next_batch_no: 1,
        })
    }

    pub async fn run_once(&mut self, now: DateTime<Utc>) -> Result<AgentRunReport, AgentError> {
        let mut report = AgentRunReport {
            lane_execution_count: 0,
            produced_frame_count: 0,
            enqueued_batch_count: 0,
        };

        for lane_index in 0..self.lanes.len() {
            let request = collect_source_request(&self.lanes[lane_index].lane)?;
            let output = self.runner.run_script(request)?;
            report.lane_execution_count += 1;

            let effects = {
                let lane = &mut self.lanes[lane_index];
                run_lane_pipeline(lane, output, now)?
            };
            let frames = frames_from_effects(effects);
            report.produced_frame_count += frames.len();

            if frames.is_empty() {
                continue;
            }

            let batch = self.next_batch(frames);
            self.spool.enqueue(batch)?;
            report.enqueued_batch_count += 1;
        }

        Ok(report)
    }

    pub async fn flush_spool(&mut self) -> Result<FlushReport, AgentError> {
        let mut report = FlushReport {
            uploaded_batch_count: 0,
            acked_entry_count: 0,
            retry_entry_count: 0,
        };
        let entries = self.spool.pending_batch(self.flush_limit)?;

        for entry in entries {
            let id = entry.id.clone();
            match self.center.post_ingest_batch(entry.batch).await {
                Ok(_) => {
                    self.spool.mark_acked(std::slice::from_ref(&id))?;
                    report.uploaded_batch_count += 1;
                    report.acked_entry_count += 1;
                }
                Err(error) => {
                    let reason = RetryReason::network(error.to_string());
                    self.spool.mark_retry(std::slice::from_ref(&id), reason)?;
                    report.retry_entry_count += 1;
                }
            }
        }

        Ok(report)
    }

    pub async fn handle_control_message(
        &mut self,
        message: ControlMessage,
    ) -> Result<ControlReply, AgentError> {
        match message {
            ControlMessage::ReloadLaneConfig { config } => {
                self.reload_lane_config(config)?;
                Ok(ControlReply::accepted("reload_lane_config"))
            }
            ControlMessage::BuildContent {
                content_id,
                cwd,
                command,
            } => {
                let request = ScriptRunRequest {
                    purpose: ScriptPurpose::BuildContent,
                    lane_id: content_id,
                    command,
                    cwd: cwd.into(),
                    timeout: Duration::seconds(BUILD_CONTENT_TIMEOUT_SECONDS),
                    capture_stdout: true,
                    capture_stderr: true,
                    side_effect_policy: ScriptSideEffectPolicy::ContentBuildBoundary,
                };
                self.runner.run_script(request)?;
                Ok(ControlReply::accepted("build_content"))
            }
            ControlMessage::Heartbeat => Ok(ControlReply::accepted("heartbeat")),
            ControlMessage::Unknown { message_type } => Ok(ControlReply::accepted(message_type)),
        }
    }

    fn reload_lane_config(&mut self, lane_config: LaneConfig) -> Result<(), AgentError> {
        validate_script_raw_stage(&lane_config)?;
        let lane_id = lane_config.lane_id.clone();
        let runtime = LaneRuntime::new(lane_config)?;

        if let Some(existing) = self
            .lanes
            .iter_mut()
            .find(|existing| existing.lane.lane_id == lane_id)
        {
            *existing = runtime;
        } else {
            self.lanes.push(runtime);
        }

        Ok(())
    }

    fn next_batch(&mut self, frames: Vec<Frame>) -> IngestBatch {
        let batch_id = format!("batch-{}", self.next_batch_no);
        self.next_batch_no += 1;

        IngestBatch {
            workspace_id: self.workspace_id.clone(),
            machine_id: self.machine_id.clone(),
            batch_id,
            frames,
        }
    }
}

impl LaneRuntime {
    fn new(lane: LaneConfig) -> Result<Self, AgentError> {
        let engine = LaneEngine::new(
            lane.clone(),
            ServiceHistoryStore::default(),
            PassthroughStageRunner,
        )
        .map_err(map_engine_error)?;

        Ok(Self { lane, engine })
    }
}

impl HistoryStore for ServiceHistoryStore {
    fn load_history(&self, request: HistoryRequest) -> Result<StageHistory, EngineError> {
        Ok(StageHistory {
            upstream_frames: tail(&self.upstream_frames, request.upstream_frames),
            metric_frames: tail(&self.metric_frames, request.metric_frames),
            event_frames: tail(&self.event_frames, request.event_frames),
        })
    }

    fn append_frame(&mut self, frame: Frame) -> Result<(), EngineError> {
        match frame.stage {
            StageKind::Raw => self.upstream_frames.push(frame),
            StageKind::Metric => self.metric_frames.push(frame),
            StageKind::Event => self.event_frames.push(frame),
        }

        Ok(())
    }
}

impl StageRunner for PassthroughStageRunner {
    fn run_stage(&self, _invocation: StageInvocation) -> Result<StageResult, EngineError> {
        Err(EngineError::Runner(
            "agent service draft only supports passthrough downstream stages".into(),
        ))
    }
}

fn validate_script_raw_stage(lane: &LaneConfig) -> Result<(), AgentError> {
    if lane.raw_stage.mode != StageMode::Script {
        return Err(AgentError::config(format!(
            "lane {} rawStage.mode must be script",
            lane.lane_id
        )));
    }

    let settings = &lane.raw_stage.settings;
    string_setting(settings, "command", &lane.lane_id)?;
    path_setting(settings, "cwd", &lane.lane_id)?;
    timeout_setting(settings, &lane.lane_id)?;

    Ok(())
}

fn collect_source_request(lane: &LaneConfig) -> Result<ScriptRunRequest, AgentError> {
    let settings = &lane.raw_stage.settings;

    Ok(ScriptRunRequest {
        purpose: ScriptPurpose::CollectSource,
        lane_id: lane.lane_id.clone(),
        command: string_setting(settings, "command", &lane.lane_id)?,
        cwd: path_setting(settings, "cwd", &lane.lane_id)?.into(),
        timeout: Duration::seconds(timeout_setting(settings, &lane.lane_id)?),
        capture_stdout: bool_setting(settings, "captureStdout", true, &lane.lane_id)?,
        capture_stderr: bool_setting(settings, "captureStderr", true, &lane.lane_id)?,
        side_effect_policy: ScriptSideEffectPolicy::LaneSourceReadBoundary,
    })
}

fn run_lane_pipeline(
    lane: &mut LaneRuntime,
    output: ScriptRunOutput,
    now: DateTime<Utc>,
) -> Result<Vec<EngineEffect>, AgentError> {
    let mut effects = Vec::new();

    for record in output.records {
        effects.extend(
            lane.engine
                .ingest_raw_record(record, now)
                .map_err(map_engine_error)?,
        );
    }

    effects.extend(lane.engine.tick(now).map_err(map_engine_error)?);
    Ok(effects)
}

fn frames_from_effects(effects: Vec<EngineEffect>) -> Vec<Frame> {
    effects
        .into_iter()
        .filter_map(|effect| match effect {
            EngineEffect::FrameClosed { frame } => Some(frame),
            EngineEffect::StageDiagnostic { .. } => None,
        })
        .collect()
}

fn string_setting(settings: &Value, key: &str, lane_id: &str) -> Result<String, AgentError> {
    settings
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            AgentError::config(format!(
                "lane {lane_id} rawStage.settings.{key} must be a string"
            ))
        })
}

fn path_setting(settings: &Value, key: &str, lane_id: &str) -> Result<PathBuf, AgentError> {
    Ok(PathBuf::from(string_setting(settings, key, lane_id)?))
}

fn timeout_setting(settings: &Value, lane_id: &str) -> Result<i64, AgentError> {
    let seconds = settings
        .get("timeoutSeconds")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            AgentError::config(format!(
                "lane {lane_id} rawStage.settings.timeoutSeconds must be an integer"
            ))
        })?;

    if seconds <= 0 {
        return Err(AgentError::config(format!(
            "lane {lane_id} rawStage.settings.timeoutSeconds must be positive"
        )));
    }

    Ok(seconds)
}

fn bool_setting(
    settings: &Value,
    key: &str,
    default: bool,
    lane_id: &str,
) -> Result<bool, AgentError> {
    match settings.get(key) {
        Some(Value::Bool(value)) => Ok(*value),
        None => Ok(default),
        Some(_) => Err(AgentError::config(format!(
            "lane {lane_id} rawStage.settings.{key} must be a boolean"
        ))),
    }
}

fn tail(frames: &[Frame], limit: usize) -> Vec<Frame> {
    frames
        .iter()
        .skip(frames.len().saturating_sub(limit))
        .cloned()
        .collect()
}

fn map_engine_error(error: EngineError) -> AgentError {
    AgentError::lane_engine(error.to_string())
}
