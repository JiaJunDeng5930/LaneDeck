use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Duration, Utc};
use lanedeck_lane_engine::{
    EngineEffect, EngineError, HistoryRequest, HistoryStore, LaneEngine, StageRunner,
};
use lanedeck_protocol::{
    Diagnostic, Frame, FrameRecord, IngestAck, IngestBatch, LaneConfig, StageHistory,
    StageInvocation, StageKind, StageMode, StageResult,
};
use serde_json::Value;

use crate::{
    AgentConfig, AgentError, AgentRunReport, CenterClient, ControlMessage, ControlReply,
    FlushReport, LocalSpool, RetryReason, ScriptPurpose, ScriptRunRequest, ScriptRunner,
    ScriptSideEffectPolicy,
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
    pending_source_records: VecDeque<FrameRecord>,
    history_store: ServiceHistoryStore,
    engine: LaneEngine<ServiceHistoryStore, ServiceStageRunner<R>>,
}

#[derive(Clone, Default)]
struct ServiceHistoryStore {
    inner: Arc<Mutex<ServiceHistoryState>>,
    limits: Arc<Mutex<HistoryLimits>>,
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
    pub fn new(
        config: AgentConfig,
        center: C,
        mut spool: P,
        runner: R,
    ) -> Result<Self, AgentError> {
        if config.flush.max_batch_size == 0 {
            return Err(AgentError::config("flush.maxBatchSize must be positive"));
        }

        let runner = Arc::new(runner);
        let mut lanes = Vec::with_capacity(config.lanes.len());
        let mut lane_ids = HashSet::with_capacity(config.lanes.len());

        for lane in config.lanes {
            let schedule_interval =
                lane_schedule_interval(&lane.lane_id, lane.schedule.interval_seconds)?;
            if lane.lane_id != lane.config.lane_id {
                return Err(AgentError::config(format!(
                    "lane {} wrapper laneId must match config.laneId {}",
                    lane.lane_id, lane.config.lane_id
                )));
            }
            let lane_config = lane.config;
            if !lane_ids.insert(lane_config.lane_id.clone()) {
                return Err(AgentError::config(format!(
                    "lane {} is configured more than once",
                    lane_config.lane_id
                )));
            }
            validate_lane_config(&lane_config)?;
            let next_frame_no = spool.load_lane_frame_cursor(&lane_config.lane_id)?;
            lanes.push(LaneRuntime::new(
                lane_config,
                schedule_interval,
                runner.clone(),
                next_frame_no,
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

            let pending_close_report = {
                let lane = &mut self.lanes[lane_index];
                retry_pending_close(lane)
            };
            if let Some(error) = pending_close_report.error {
                report
                    .diagnostics
                    .push(lane_error_diagnostic(&self.lanes[lane_index].lane, error));
                self.lanes[lane_index].mark_run(now);
                continue;
            }
            self.apply_pipeline_effects(pending_close_report.effects, &mut report)?;

            if self.lanes[lane_index].pending_source_records.is_empty() {
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
                self.lanes[lane_index]
                    .pending_source_records
                    .extend(output.records);
            }

            let opening_report = {
                let lane = &mut self.lanes[lane_index];
                open_lane_window(lane, now)
            };
            if let Some(error) = opening_report.error {
                report
                    .diagnostics
                    .push(lane_error_diagnostic(&self.lanes[lane_index].lane, error));
                self.lanes[lane_index].mark_run(now);
                continue;
            }
            self.apply_pipeline_effects(opening_report.effects, &mut report)?;

            let pipeline_report = {
                let lane = &mut self.lanes[lane_index];
                drain_pending_source_records(lane, now)
            };
            self.lanes[lane_index].mark_run(now);
            if let Some(error) = pipeline_report.error {
                report
                    .diagnostics
                    .push(lane_error_diagnostic(&self.lanes[lane_index].lane, error));
            }
            self.apply_pipeline_effects(pipeline_report.effects, &mut report)?;
        }

        Ok(report)
    }

    pub async fn flush_spool(&mut self) -> Result<FlushReport, AgentError> {
        let mut report = FlushReport::default();
        let entries = self.spool.pending_batch(self.flush_limit)?;

        for entry in entries {
            let id = entry.id.clone();
            match self.center.post_ingest_batch(entry.batch.clone()).await {
                Ok(ack) if ack.batch_id != entry.batch.batch_id => {
                    self.spool.mark_retry(
                        std::slice::from_ref(&id),
                        ack_identity_retry_reason(&ack, &entry.batch),
                    )?;
                    report.retry_entry_count += 1;
                }
                Ok(ack) if ack_accepted_count_exceeds_batch(&ack, &entry.batch) => {
                    self.spool.mark_retry(
                        std::slice::from_ref(&id),
                        ack_overcount_retry_reason(&ack, &entry.batch),
                    )?;
                    report.retry_entry_count += 1;
                }
                Ok(ack) if ack_is_fully_accepted(&ack, &entry.batch) => {
                    self.spool.mark_acked(std::slice::from_ref(&id))?;
                    report.uploaded_batch_count += 1;
                    report.acked_entry_count += 1;
                    report.diagnostics.extend(ack.diagnostics);
                }
                Ok(ack) if ack_is_partially_accepted(&ack, &entry.batch) => {
                    let diagnostics = ack_rejection_diagnostics(&ack, &entry.batch);
                    self.spool.mark_retry(
                        std::slice::from_ref(&id),
                        ack_partial_retry_reason(&ack, &entry.batch),
                    )?;
                    report.retry_entry_count += 1;
                    report.diagnostics.extend(diagnostics);
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
        validate_lane_config(&lane_config)?;
        let lane_id = lane_config.lane_id.clone();
        let existing = self
            .lanes
            .iter_mut()
            .find(|existing| existing.lane.lane_id == lane_id)
            .ok_or_else(|| AgentError::config(format!("lane {lane_id} is not active")))?;
        existing.replace_config(lane_config)?;

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

    fn apply_pipeline_effects(
        &mut self,
        effects: Vec<EngineEffect>,
        report: &mut AgentRunReport,
    ) -> Result<(), AgentError> {
        let (frames, diagnostics) = split_effects(effects);
        report.diagnostics.extend(diagnostics);
        report.produced_frame_count += frames.len();

        if frames.is_empty() {
            return Ok(());
        }

        let batch = self.next_batch(frames);
        self.enqueue_or_retain(batch)?;
        report.enqueued_batch_count += 1;

        Ok(())
    }
}

fn ack_is_fully_accepted(ack: &IngestAck, batch: &IngestBatch) -> bool {
    ack.batch_id == batch.batch_id && ack.accepted_frame_count as usize == batch.frames.len()
}

fn ack_accepted_count_exceeds_batch(ack: &IngestAck, batch: &IngestBatch) -> bool {
    ack.batch_id == batch.batch_id && ack.accepted_frame_count as usize > batch.frames.len()
}

fn ack_is_partially_accepted(ack: &IngestAck, batch: &IngestBatch) -> bool {
    ack.batch_id == batch.batch_id
        && ack.accepted_frame_count > 0
        && (ack.accepted_frame_count as usize) < batch.frames.len()
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

fn ack_identity_retry_reason(ack: &IngestAck, batch: &IngestBatch) -> RetryReason {
    RetryReason::network(format!(
        "center ack batch id {} did not match spool batch id {}",
        ack.batch_id, batch.batch_id
    ))
}

fn ack_overcount_retry_reason(ack: &IngestAck, batch: &IngestBatch) -> RetryReason {
    RetryReason::network(format!(
        "center accepted {}/{} frames for batch {}",
        ack.accepted_frame_count,
        batch.frames.len(),
        batch.batch_id
    ))
}

fn ack_partial_retry_reason(ack: &IngestAck, batch: &IngestBatch) -> RetryReason {
    RetryReason::network(format!(
        "center partially accepted {}/{} frames for batch {} without frame-level outcomes",
        ack.accepted_frame_count,
        batch.frames.len(),
        batch.batch_id
    ))
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
        next_frame_no: u64,
    ) -> Result<Self, AgentError> {
        let history_store = ServiceHistoryStore::with_limits(history_limits(&lane));
        let engine = LaneEngine::new_with_next_frame_no(
            lane.clone(),
            history_store.clone(),
            ServiceStageRunner { runner },
            next_frame_no,
        )
        .map_err(map_engine_error)?;

        Ok(Self {
            lane,
            schedule_interval,
            next_run_at: None,
            pending_source_records: VecDeque::new(),
            history_store,
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

    fn replace_config(&mut self, lane: LaneConfig) -> Result<(), AgentError> {
        self.engine
            .replace_config(lane.clone())
            .map_err(map_engine_error)?;
        self.history_store.replace_limits(history_limits(&lane))?;
        self.lane = lane;

        Ok(())
    }
}

impl ServiceHistoryStore {
    fn with_limits(limits: HistoryLimits) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ServiceHistoryState::default())),
            limits: Arc::new(Mutex::new(limits)),
        }
    }

    fn replace_limits(&self, limits: HistoryLimits) -> Result<(), AgentError> {
        *self
            .limits
            .lock()
            .map_err(|error| AgentError::lane_engine(error.to_string()))? = limits;
        Ok(())
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
        let limits = *self
            .limits
            .lock()
            .map_err(|error| EngineError::Store(error.to_string()))?;
        match frame.stage {
            StageKind::Raw => {
                inner.upstream_frames.push(frame);
                retain_tail(&mut inner.upstream_frames, limits.upstream_frames);
            }
            StageKind::Metric => {
                inner.metric_frames.push(frame);
                retain_tail(&mut inner.metric_frames, limits.metric_frames);
            }
            StageKind::Event => {
                inner.event_frames.push(frame);
                retain_tail(&mut inner.event_frames, limits.event_frames);
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

fn validate_lane_config(lane: &LaneConfig) -> Result<(), AgentError> {
    if lane.raw_stage.mode != StageMode::Script {
        return Err(AgentError::config(format!(
            "lane {} rawStage.mode must be script",
            lane.lane_id
        )));
    }

    validate_script_settings(&lane.raw_stage.settings, "rawStage", &lane.lane_id)?;
    validate_optional_script_stage(
        &lane.metric_stage.mode,
        &lane.metric_stage.settings,
        "metricStage",
        &lane.lane_id,
    )?;
    validate_optional_script_stage(
        &lane.event_stage.mode,
        &lane.event_stage.settings,
        "eventStage",
        &lane.lane_id,
    )?;

    Ok(())
}

fn validate_optional_script_stage(
    mode: &StageMode,
    settings: &Value,
    stage_path: &str,
    lane_id: &str,
) -> Result<(), AgentError> {
    match mode {
        StageMode::Script => validate_script_settings(settings, stage_path, lane_id)?,
        StageMode::Builtin => {
            return Err(AgentError::config(format!(
                "lane {lane_id} {stage_path}.mode builtin is not supported by agent-runtime"
            )));
        }
        StageMode::Passthrough | StageMode::Empty => {}
    }

    Ok(())
}

fn lane_schedule_interval(lane_id: &str, interval_seconds: u64) -> Result<Duration, AgentError> {
    if interval_seconds == 0 {
        return Err(AgentError::config(format!(
            "lane {lane_id} schedule.intervalSeconds must be positive"
        )));
    }

    let seconds = i64::try_from(interval_seconds).map_err(|_| {
        AgentError::config(format!(
            "lane {lane_id} schedule.intervalSeconds must fit signed duration seconds"
        ))
    })?;

    Ok(Duration::seconds(seconds))
}

fn validate_script_settings(
    settings: &Value,
    stage_path: &str,
    lane_id: &str,
) -> Result<(), AgentError> {
    string_setting(settings, "command", lane_id, stage_path)?;
    path_setting(settings, "cwd", lane_id, stage_path)?;
    timeout_setting(settings, lane_id, stage_path)?;
    bool_setting(settings, "captureStdout", true, lane_id, stage_path)?;
    bool_setting(settings, "captureStderr", true, lane_id, stage_path)?;

    Ok(())
}

fn collect_source_request(lane: &LaneConfig) -> Result<ScriptRunRequest, AgentError> {
    let settings = &lane.raw_stage.settings;

    Ok(ScriptRunRequest {
        purpose: ScriptPurpose::CollectSource,
        lane_id: lane.lane_id.clone(),
        command: string_setting(settings, "command", &lane.lane_id, "rawStage")?,
        cwd: path_setting(settings, "cwd", &lane.lane_id, "rawStage")?.into(),
        input: None,
        timeout: Duration::seconds(timeout_setting(settings, &lane.lane_id, "rawStage")?),
        capture_stdout: bool_setting(settings, "captureStdout", true, &lane.lane_id, "rawStage")?,
        capture_stderr: bool_setting(settings, "captureStderr", true, &lane.lane_id, "rawStage")?,
        side_effect_policy: ScriptSideEffectPolicy::LaneSourceReadBoundary,
    })
}

struct LanePipelineReport {
    effects: Vec<EngineEffect>,
    error: Option<AgentError>,
}

fn open_lane_window<R>(lane: &mut LaneRuntime<R>, now: DateTime<Utc>) -> LanePipelineReport
where
    R: ScriptRunner,
{
    match lane.engine.tick(now).map_err(map_engine_error) {
        Ok(effects) => LanePipelineReport {
            effects,
            error: None,
        },
        Err(error) => LanePipelineReport {
            effects: Vec::new(),
            error: Some(error),
        },
    }
}

fn retry_pending_close<R>(lane: &mut LaneRuntime<R>) -> LanePipelineReport
where
    R: ScriptRunner,
{
    if !lane.engine.has_pending_close() {
        return LanePipelineReport {
            effects: Vec::new(),
            error: None,
        };
    }

    match lane.engine.retry_pending_close().map_err(map_engine_error) {
        Ok(effects) => LanePipelineReport {
            effects,
            error: None,
        },
        Err(error) => LanePipelineReport {
            effects: Vec::new(),
            error: Some(error),
        },
    }
}

fn drain_pending_source_records<R>(
    lane: &mut LaneRuntime<R>,
    now: DateTime<Utc>,
) -> LanePipelineReport
where
    R: ScriptRunner,
{
    let mut effects = Vec::new();

    while let Some(record) = lane.pending_source_records.pop_front() {
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
    let (settings, stage_path) = match invocation.current_frame.stage {
        StageKind::Raw => (&invocation.lane.metric_stage.settings, "metricStage"),
        StageKind::Metric => (&invocation.lane.event_stage.settings, "eventStage"),
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
        command: string_setting(settings, "command", lane_id, stage_path)
            .map_err(|error| EngineError::Runner(error.to_string()))?,
        cwd: path_setting(settings, "cwd", lane_id, stage_path)
            .map_err(|error| EngineError::Runner(error.to_string()))?
            .into(),
        input: Some(
            serde_json::to_value(invocation)
                .map_err(|error| EngineError::Runner(error.to_string()))?,
        ),
        timeout: Duration::seconds(
            timeout_setting(settings, lane_id, stage_path)
                .map_err(|error| EngineError::Runner(error.to_string()))?,
        ),
        capture_stdout: bool_setting(settings, "captureStdout", true, lane_id, stage_path)
            .map_err(|error| EngineError::Runner(error.to_string()))?,
        capture_stderr: bool_setting(settings, "captureStderr", true, lane_id, stage_path)
            .map_err(|error| EngineError::Runner(error.to_string()))?,
        side_effect_policy: ScriptSideEffectPolicy::StageTransformBoundary,
    })
}

fn string_setting(
    settings: &Value,
    key: &str,
    lane_id: &str,
    stage_path: &str,
) -> Result<String, AgentError> {
    settings
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            AgentError::config(format!(
                "lane {lane_id} {stage_path}.settings.{key} must be a string"
            ))
        })
}

fn path_setting(
    settings: &Value,
    key: &str,
    lane_id: &str,
    stage_path: &str,
) -> Result<PathBuf, AgentError> {
    Ok(PathBuf::from(string_setting(
        settings, key, lane_id, stage_path,
    )?))
}

fn timeout_setting(settings: &Value, lane_id: &str, stage_path: &str) -> Result<i64, AgentError> {
    let seconds = settings
        .get("timeoutSeconds")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            AgentError::config(format!(
                "lane {lane_id} {stage_path}.settings.timeoutSeconds must be an integer"
            ))
        })?;

    if seconds <= 0 {
        return Err(AgentError::config(format!(
            "lane {lane_id} {stage_path}.settings.timeoutSeconds must be positive"
        )));
    }

    Ok(seconds)
}

fn bool_setting(
    settings: &Value,
    key: &str,
    default: bool,
    lane_id: &str,
    stage_path: &str,
) -> Result<bool, AgentError> {
    match settings.get(key) {
        Some(Value::Bool(value)) => Ok(*value),
        None => Ok(default),
        Some(_) => Err(AgentError::config(format!(
            "lane {lane_id} {stage_path}.settings.{key} must be a boolean"
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
