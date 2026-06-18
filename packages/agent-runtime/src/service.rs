use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Duration, Utc};
use lanedeck_lane_engine::{
    EngineEffect, EngineError, HistoryRequest, HistoryStore, LaneEngine, StageRunner,
};
use lanedeck_protocol::{
    Diagnostic, Frame, IngestAck, IngestBatch, LaneConfig, StageHistory, StageInvocation,
    StageKind, StageMode, StageResult,
};
use serde_json::Value;

use crate::{
    AgentConfig, AgentError, AgentRunReport, CenterClient, ControlMessage, ControlReply,
    FlushReport, LocalSpool, RetryReason, ScriptPurpose, ScriptRunOutput, ScriptRunRequest,
    ScriptRunner, ScriptSideEffectPolicy,
};

const BUILD_CONTENT_TIMEOUT_SECONDS: i64 = 300;
static NEXT_RUNTIME_SEED: AtomicU64 = AtomicU64::new(1);

pub struct AgentService<C, P, R> {
    center: C,
    spool: P,
    runner: Arc<R>,
    workspace_id: String,
    machine_id: String,
    runtime_seed: String,
    flush_limit: usize,
    lanes: Vec<LaneRuntime<R>>,
    next_batch_no: u64,
    retained_batches: VecDeque<IngestBatch>,
}

struct LaneRuntime<R> {
    lane: LaneConfig,
    schedule_interval: Duration,
    next_run_at: Option<DateTime<Utc>>,
    engine: LaneEngine<ServiceHistoryStore, ServiceStageRunner<R>>,
}

#[derive(Clone, Default)]
struct ServiceHistoryStore {
    inner: Arc<Mutex<ServiceHistoryState>>,
    limits: HistoryLimits,
}

#[derive(Default)]
struct ServiceHistoryState {
    upstream_frames: Vec<Frame>,
    metric_frames: Vec<Frame>,
    event_frames: Vec<Frame>,
}

#[derive(Clone, Copy, Default)]
struct HistoryLimits {
    upstream_frames: usize,
    metric_frames: usize,
    event_frames: usize,
}

impl<C, P, R> AgentService<C, P, R>
where
    C: CenterClient,
    P: LocalSpool,
    R: ScriptRunner,
{
    pub fn new(config: AgentConfig, center: C, spool: P, runner: R) -> Result<Self, AgentError> {
        if config.flush.max_batch_size == 0 {
            return Err(AgentError::config("flush.maxBatchSize must be positive"));
        }

        let runner = Arc::new(runner);
        let mut lanes = Vec::with_capacity(config.lanes.len());

        for lane in config.lanes {
            let schedule_interval = Duration::seconds(lane.schedule.interval_seconds as i64);
            let lane_config = lane.config;
            validate_script_raw_stage(&lane_config)?;
            lanes.push(LaneRuntime::new(
                lane_config,
                schedule_interval,
                runner.clone(),
            )?);
        }

        Ok(Self {
            center,
            spool,
            runner,
            workspace_id: config.workspace_id,
            machine_id: config.machine_id,
            runtime_seed: new_runtime_seed(),
            flush_limit: config.flush.max_batch_size,
            lanes,
            next_batch_no: 1,
            retained_batches: VecDeque::new(),
        })
    }

    pub async fn run_once(&mut self, now: DateTime<Utc>) -> Result<AgentRunReport, AgentError> {
        let mut report = AgentRunReport::default();
        self.enqueue_retained_batches(&mut report)?;

        for lane_index in 0..self.lanes.len() {
            if !self.lanes[lane_index].is_due(now) {
                continue;
            }
            report.lane_execution_count += 1;

            let request = match collect_source_request(&self.lanes[lane_index].lane) {
                Ok(request) => request,
                Err(error) => {
                    report
                        .diagnostics
                        .push(lane_error_diagnostic(&self.lanes[lane_index].lane, error));
                    self.lanes[lane_index].mark_run(now);
                    continue;
                }
            };
            let output = match self.runner.run_script(request) {
                Ok(output) => output,
                Err(error) => {
                    report
                        .diagnostics
                        .push(lane_error_diagnostic(&self.lanes[lane_index].lane, error));
                    self.lanes[lane_index].mark_run(now);
                    continue;
                }
            };
            report.diagnostics.extend(output.diagnostics.clone());

            let pipeline_report = {
                let lane = &mut self.lanes[lane_index];
                run_lane_pipeline(lane, output, now)
            };
            self.lanes[lane_index].mark_run(now);
            if let Some(error) = pipeline_report.error {
                report
                    .diagnostics
                    .push(lane_error_diagnostic(&self.lanes[lane_index].lane, error));
            }
            let (frames, diagnostics) = split_effects(pipeline_report.effects);
            report.diagnostics.extend(diagnostics);
            report.produced_frame_count += frames.len();

            if frames.is_empty() {
                continue;
            }

            let batch = self.next_batch(frames);
            self.enqueue_or_retain(batch)?;
            report.enqueued_batch_count += 1;
        }

        Ok(report)
    }

    pub async fn flush_spool(&mut self) -> Result<FlushReport, AgentError> {
        let mut report = FlushReport::default();
        let entries = self.spool.pending_batch(self.flush_limit)?;

        for entry in entries {
            let id = entry.id.clone();
            match self.center.post_ingest_batch(entry.batch.clone()).await {
                Ok(ack) if ack_is_complete(&ack, &entry.batch) => {
                    self.spool.mark_acked(std::slice::from_ref(&id))?;
                    report.uploaded_batch_count += 1;
                    report.acked_entry_count += 1;
                }
                Ok(ack) => {
                    self.spool.mark_rejected(
                        std::slice::from_ref(&id),
                        ack_rejection_diagnostics(&ack, &entry.batch),
                    )?;
                    report.uploaded_batch_count += 1;
                    report.rejected_entry_count += 1;
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
                    input: None,
                    timeout: Duration::seconds(BUILD_CONTENT_TIMEOUT_SECONDS),
                    capture_stdout: true,
                    capture_stderr: true,
                    side_effect_policy: ScriptSideEffectPolicy::ContentBuildBoundary,
                };
                self.runner.run_script(request)?;
                Ok(ControlReply::accepted("build_content"))
            }
            ControlMessage::ApplyLocalChange { path, body } => {
                let cwd = path
                    .parent()
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("."));
                let command = serde_json::to_string(&serde_json::json!({
                    "type": "apply_local_change",
                    "path": path,
                    "body": body,
                }))
                .map_err(|error| AgentError::script(error.to_string()))?;
                let request = ScriptRunRequest {
                    purpose: ScriptPurpose::ApplyLocalChange,
                    lane_id: "content.local".to_string(),
                    command,
                    cwd: cwd.into(),
                    input: None,
                    timeout: Duration::seconds(BUILD_CONTENT_TIMEOUT_SECONDS),
                    capture_stdout: true,
                    capture_stderr: true,
                    side_effect_policy: ScriptSideEffectPolicy::LocalContentWriteBoundary,
                };
                self.runner.run_script(request)?;
                Ok(ControlReply::accepted("apply_local_change"))
            }
            ControlMessage::Heartbeat => Ok(ControlReply::accepted("heartbeat")),
            ControlMessage::Unknown { message_type } => Ok(ControlReply::unknown(message_type)),
        }
    }

    fn reload_lane_config(&mut self, lane_config: LaneConfig) -> Result<(), AgentError> {
        validate_script_raw_stage(&lane_config)?;
        let lane_id = lane_config.lane_id.clone();
        let existing = self
            .lanes
            .iter_mut()
            .find(|existing| existing.lane.lane_id == lane_id)
            .ok_or_else(|| AgentError::config(format!("lane {lane_id} is not active")))?;
        let mut runtime =
            LaneRuntime::new(lane_config, existing.schedule_interval, self.runner.clone())?;
        runtime.next_run_at = existing.next_run_at;
        *existing = runtime;

        Ok(())
    }

    fn next_batch(&mut self, frames: Vec<Frame>) -> IngestBatch {
        let batch_id = format!(
            "{}:{}:{}:{}",
            self.workspace_id, self.machine_id, self.runtime_seed, self.next_batch_no
        );
        self.next_batch_no += 1;

        IngestBatch {
            workspace_id: self.workspace_id.clone(),
            machine_id: self.machine_id.clone(),
            batch_id,
            frames,
        }
    }

    fn enqueue_retained_batches(&mut self, report: &mut AgentRunReport) -> Result<(), AgentError> {
        let retained_count = self.retained_batches.len();
        for _ in 0..retained_count {
            let batch = self
                .retained_batches
                .pop_front()
                .expect("retained batch count was captured");
            match self.spool.enqueue(batch.clone()) {
                Ok(_) => report.enqueued_batch_count += 1,
                Err(error) => {
                    let error = retained_enqueue_error(&batch, error);
                    self.retained_batches.push_front(batch);
                    return Err(error);
                }
            }
        }

        Ok(())
    }

    fn enqueue_or_retain(&mut self, batch: IngestBatch) -> Result<(), AgentError> {
        match self.spool.enqueue(batch.clone()) {
            Ok(_) => Ok(()),
            Err(error) => {
                let error = retained_enqueue_error(&batch, error);
                self.retained_batches.push_back(batch);
                Err(error)
            }
        }
    }
}

fn ack_is_complete(ack: &IngestAck, batch: &IngestBatch) -> bool {
    ack.batch_id == batch.batch_id
        && ack.accepted_frame_count as usize == batch.frames.len()
        && ack.diagnostics.is_empty()
}

fn ack_rejection_diagnostics(ack: &IngestAck, batch: &IngestBatch) -> Vec<Diagnostic> {
    if ack.diagnostics.is_empty() {
        return vec![Diagnostic {
            path: "ingestAck".to_string(),
            message: format!(
                "center accepted {}/{} frames for batch {}",
                ack.accepted_frame_count,
                batch.frames.len(),
                batch.batch_id
            ),
        }];
    }

    ack.diagnostics.clone()
}

fn lane_error_diagnostic(lane: &LaneConfig, error: AgentError) -> Diagnostic {
    Diagnostic {
        path: format!("lanes.{}", lane.lane_id),
        message: error.to_string(),
    }
}

impl<R> LaneRuntime<R>
where
    R: ScriptRunner,
{
    fn new(
        lane: LaneConfig,
        schedule_interval: Duration,
        runner: Arc<R>,
    ) -> Result<Self, AgentError> {
        let engine = LaneEngine::new(
            lane.clone(),
            ServiceHistoryStore::with_limits(history_limits(&lane)),
            ServiceStageRunner { runner },
        )
        .map_err(map_engine_error)?;

        Ok(Self {
            lane,
            schedule_interval,
            next_run_at: None,
            engine,
        })
    }

    fn is_due(&self, now: DateTime<Utc>) -> bool {
        self.next_run_at
            .is_none_or(|next_run_at| now >= next_run_at)
    }

    fn mark_run(&mut self, now: DateTime<Utc>) {
        self.next_run_at = Some(now + self.schedule_interval);
    }
}

impl ServiceHistoryStore {
    fn with_limits(limits: HistoryLimits) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ServiceHistoryState::default())),
            limits,
        }
    }
}

impl HistoryStore for ServiceHistoryStore {
    fn load_history(&self, request: HistoryRequest) -> Result<StageHistory, EngineError> {
        let inner = self
            .inner
            .lock()
            .map_err(|error| EngineError::Store(error.to_string()))?;
        Ok(StageHistory {
            upstream_frames: tail(&inner.upstream_frames, request.upstream_frames),
            metric_frames: tail(&inner.metric_frames, request.metric_frames),
            event_frames: tail(&inner.event_frames, request.event_frames),
        })
    }

    fn append_frame(&mut self, frame: Frame) -> Result<(), EngineError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|error| EngineError::Store(error.to_string()))?;
        match frame.stage {
            StageKind::Raw => {
                inner.upstream_frames.push(frame);
                retain_tail(&mut inner.upstream_frames, self.limits.upstream_frames);
            }
            StageKind::Metric => {
                inner.metric_frames.push(frame);
                retain_tail(&mut inner.metric_frames, self.limits.metric_frames);
            }
            StageKind::Event => {
                inner.event_frames.push(frame);
                retain_tail(&mut inner.event_frames, self.limits.event_frames);
            }
        }

        Ok(())
    }
}

struct ServiceStageRunner<R> {
    runner: Arc<R>,
}

impl<R> StageRunner for ServiceStageRunner<R>
where
    R: ScriptRunner,
{
    fn run_stage(&self, invocation: StageInvocation) -> Result<StageResult, EngineError> {
        let request = transform_stage_request(&invocation)?;
        let output = self
            .runner
            .run_script(request)
            .map_err(|error| EngineError::Runner(error.to_string()))?;
        Ok(StageResult {
            records: output.records,
            diagnostics: output.diagnostics,
        })
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
        input: None,
        timeout: Duration::seconds(timeout_setting(settings, &lane.lane_id)?),
        capture_stdout: bool_setting(settings, "captureStdout", true, &lane.lane_id)?,
        capture_stderr: bool_setting(settings, "captureStderr", true, &lane.lane_id)?,
        side_effect_policy: ScriptSideEffectPolicy::LaneSourceReadBoundary,
    })
}

struct LanePipelineReport {
    effects: Vec<EngineEffect>,
    error: Option<AgentError>,
}

fn run_lane_pipeline<R>(
    lane: &mut LaneRuntime<R>,
    output: ScriptRunOutput,
    now: DateTime<Utc>,
) -> LanePipelineReport
where
    R: ScriptRunner,
{
    let mut effects = Vec::new();

    match lane.engine.tick(now).map_err(map_engine_error) {
        Ok(opening_effects) => effects.extend(opening_effects),
        Err(error) => {
            return LanePipelineReport {
                effects,
                error: Some(error),
            };
        }
    }

    for record in output.records {
        match lane
            .engine
            .ingest_raw_record(record, now)
            .map_err(map_engine_error)
        {
            Ok(record_effects) => effects.extend(record_effects),
            Err(error) => {
                return LanePipelineReport {
                    effects,
                    error: Some(error),
                };
            }
        }
    }

    match lane.engine.tick(now).map_err(map_engine_error) {
        Ok(closing_effects) => effects.extend(closing_effects),
        Err(error) => {
            return LanePipelineReport {
                effects,
                error: Some(error),
            };
        }
    }

    LanePipelineReport {
        effects,
        error: None,
    }
}

fn split_effects(effects: Vec<EngineEffect>) -> (Vec<Frame>, Vec<Diagnostic>) {
    let mut frames = Vec::new();
    let mut diagnostics = Vec::new();

    for effect in effects {
        match effect {
            EngineEffect::FrameClosed { frame } => frames.push(frame),
            EngineEffect::StageDiagnostic { diagnostic, .. } => diagnostics.push(diagnostic),
        }
    }

    (frames, diagnostics)
}

fn transform_stage_request(invocation: &StageInvocation) -> Result<ScriptRunRequest, EngineError> {
    let settings = match invocation.current_frame.stage {
        StageKind::Raw => &invocation.lane.metric_stage.settings,
        StageKind::Metric => &invocation.lane.event_stage.settings,
        StageKind::Event => {
            return Err(EngineError::Runner(
                "event frames do not have downstream script stages".to_string(),
            ));
        }
    };
    let lane_id = &invocation.lane.lane_id;

    Ok(ScriptRunRequest {
        purpose: ScriptPurpose::TransformStage,
        lane_id: lane_id.clone(),
        command: string_setting(settings, "command", lane_id)
            .map_err(|error| EngineError::Runner(error.to_string()))?,
        cwd: path_setting(settings, "cwd", lane_id)
            .map_err(|error| EngineError::Runner(error.to_string()))?
            .into(),
        input: Some(
            serde_json::to_value(invocation)
                .map_err(|error| EngineError::Runner(error.to_string()))?,
        ),
        timeout: Duration::seconds(
            timeout_setting(settings, lane_id)
                .map_err(|error| EngineError::Runner(error.to_string()))?,
        ),
        capture_stdout: bool_setting(settings, "captureStdout", true, lane_id)
            .map_err(|error| EngineError::Runner(error.to_string()))?,
        capture_stderr: bool_setting(settings, "captureStderr", true, lane_id)
            .map_err(|error| EngineError::Runner(error.to_string()))?,
        side_effect_policy: ScriptSideEffectPolicy::StageTransformBoundary,
    })
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

fn retain_tail(frames: &mut Vec<Frame>, limit: usize) {
    let drop_count = frames.len().saturating_sub(limit);
    if drop_count > 0 {
        frames.drain(0..drop_count);
    }
}

fn history_limits(lane: &LaneConfig) -> HistoryLimits {
    HistoryLimits {
        upstream_frames: max_history_limit(lane, "upstreamFrames"),
        metric_frames: max_history_limit(lane, "metricFrames"),
        event_frames: max_history_limit(lane, "eventFrames"),
    }
}

fn max_history_limit(lane: &LaneConfig, key: &str) -> usize {
    [&lane.metric_stage.settings, &lane.event_stage.settings]
        .into_iter()
        .filter_map(|settings| settings["history"][key].as_u64())
        .filter_map(|value| usize::try_from(value).ok())
        .max()
        .unwrap_or(0)
}

fn new_runtime_seed() -> String {
    let sequence = NEXT_RUNTIME_SEED.fetch_add(1, Ordering::Relaxed);
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("runtime-{started_at}-{sequence}")
}

fn retained_enqueue_error(batch: &IngestBatch, error: AgentError) -> AgentError {
    AgentError::spool(format!(
        "local spool enqueue failed for ingest batch {}; agent-runtime retained ownership for next run retry: {error}",
        batch.batch_id
    ))
}

fn map_engine_error(error: EngineError) -> AgentError {
    AgentError::lane_engine(error.to_string())
}
