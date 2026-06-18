use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use lanedeck_agent_runtime::{
    AgentConfig, AgentError, CenterClient, ControlConnectRequest, ControlMessageId,
    ControlMessageRecord, ControlSession, LocalSpool, RetryReason, ScriptRunOutput,
    ScriptRunRequest, ScriptRunner, SpoolEntry, SpoolEntryId,
};
use lanedeck_protocol::{Diagnostic, Frame, FrameRecord, IngestAck, IngestBatch, LaneConfig};
use serde_json::{Value, json};

pub fn instant(seconds: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(seconds, 0).expect("valid contract test timestamp")
}

pub fn script_lane_agent_config() -> AgentConfig {
    agent_config_with_lane(script_lane_config(
        "lane.cpu",
        "/var/lib/lanedeck/sources/cpu",
        5,
    ))
}

pub fn script_lane_agent_config_with_interval(interval_seconds: u64) -> AgentConfig {
    let mut config = script_lane_agent_config();
    config.lanes[0].schedule.interval_seconds = interval_seconds;
    config
}

pub fn scripted_metric_agent_config() -> AgentConfig {
    let mut lane = script_lane_config("lane.cpu", "/var/lib/lanedeck/sources/cpu", 5);
    lane.metric_stage.mode = from_json(json!("script"));
    lane.metric_stage.settings = json!({
        "command": "metric-cpu",
        "cwd": "/var/lib/lanedeck/stages/metric",
        "timeoutSeconds": 7,
        "captureStdout": true,
        "captureStderr": true
    });
    agent_config_with_lane(lane)
}

pub fn scripted_metric_agent_config_with_upstream_history_limit(limit: u64) -> AgentConfig {
    let mut config = scripted_metric_agent_config();
    config.lanes[0].config.metric_stage.settings["history"] = json!({
        "upstreamFrames": limit
    });
    config
}

pub fn duplicate_nested_lane_identity_agent_config() -> AgentConfig {
    let first = script_lane_config("lane.cpu", "/var/lib/lanedeck/sources/cpu-a", 5);
    let second = script_lane_config("lane.cpu", "/var/lib/lanedeck/sources/cpu-b", 5);
    from_json(json!({
        "workspaceId": "workspace.local",
        "machineId": "machine.local",
        "spool": {
            "path": ":memory:"
        },
        "flush": {
            "maxBatchSize": 16
        },
        "control": {
            "url": "wss://center.local/agent/control"
        },
        "lanes": [
            {
                "laneId": "lane.cpu",
                "schedule": {
                    "intervalSeconds": 60
                },
                "config": first
            },
            {
                "laneId": "lane.cpu",
                "schedule": {
                    "intervalSeconds": 60
                },
                "config": second
            }
        ]
    }))
}

pub fn mismatched_lane_identity_agent_config() -> AgentConfig {
    let lane = script_lane_config("lane.cpu", "/var/lib/lanedeck/sources/cpu", 5);
    from_json(json!({
        "workspaceId": "workspace.local",
        "machineId": "machine.local",
        "spool": {
            "path": ":memory:"
        },
        "flush": {
            "maxBatchSize": 16
        },
        "control": {
            "url": "wss://center.local/agent/control"
        },
        "lanes": [
            {
                "laneId": "lane.wrapper",
                "schedule": {
                    "intervalSeconds": 60
                },
                "config": lane
            }
        ]
    }))
}

pub fn agent_config_with_lane_config(lane: LaneConfig) -> AgentConfig {
    agent_config_with_lane(lane)
}

pub fn downstream_script_stage_missing_setting_cases()
-> Vec<(&'static str, LaneConfig, &'static str, &'static str)> {
    vec![
        (
            "metric stage missing command",
            downstream_script_stage_missing_setting("metricStage", "command"),
            "metricStage",
            "command",
        ),
        (
            "metric stage missing cwd",
            downstream_script_stage_missing_setting("metricStage", "cwd"),
            "metricStage",
            "cwd",
        ),
        (
            "metric stage missing timeout",
            downstream_script_stage_missing_setting("metricStage", "timeoutSeconds"),
            "metricStage",
            "timeoutSeconds",
        ),
        (
            "event stage missing command",
            downstream_script_stage_missing_setting("eventStage", "command"),
            "eventStage",
            "command",
        ),
        (
            "event stage missing cwd",
            downstream_script_stage_missing_setting("eventStage", "cwd"),
            "eventStage",
            "cwd",
        ),
        (
            "event stage missing timeout",
            downstream_script_stage_missing_setting("eventStage", "timeoutSeconds"),
            "eventStage",
            "timeoutSeconds",
        ),
    ]
}

pub fn script_stage_non_bool_capture_setting_cases()
-> Vec<(&'static str, LaneConfig, &'static str, &'static str)> {
    vec![
        (
            "raw stage captureStdout string",
            script_stage_non_bool_capture_setting("rawStage", "captureStdout"),
            "rawStage",
            "captureStdout",
        ),
        (
            "raw stage captureStderr string",
            script_stage_non_bool_capture_setting("rawStage", "captureStderr"),
            "rawStage",
            "captureStderr",
        ),
        (
            "metric stage captureStdout string",
            script_stage_non_bool_capture_setting("metricStage", "captureStdout"),
            "metricStage",
            "captureStdout",
        ),
        (
            "metric stage captureStderr string",
            script_stage_non_bool_capture_setting("metricStage", "captureStderr"),
            "metricStage",
            "captureStderr",
        ),
        (
            "event stage captureStdout string",
            script_stage_non_bool_capture_setting("eventStage", "captureStdout"),
            "eventStage",
            "captureStdout",
        ),
        (
            "event stage captureStderr string",
            script_stage_non_bool_capture_setting("eventStage", "captureStderr"),
            "eventStage",
            "captureStderr",
        ),
    ]
}

pub fn downstream_builtin_stage_cases() -> Vec<(&'static str, LaneConfig, &'static str)> {
    vec![
        (
            "metric stage builtin mode",
            downstream_builtin_stage("metricStage"),
            "metricStage",
        ),
        (
            "event stage builtin mode",
            downstream_builtin_stage("eventStage"),
            "eventStage",
        ),
    ]
}

pub fn two_record_frame_agent_config() -> AgentConfig {
    let mut lane = script_lane_config("lane.cpu", "/var/lib/lanedeck/sources/cpu", 5);
    lane.raw_stage.settings["frame"]["maxRecords"] = json!(2);
    let mut config = agent_config_with_lane(lane);
    config.lanes[0].schedule.interval_seconds = 1;
    config
}

pub fn two_lane_agent_config() -> AgentConfig {
    let cpu = script_lane_config("lane.cpu", "/var/lib/lanedeck/sources/cpu", 5);
    let mem = script_lane_config("lane.mem", "/var/lib/lanedeck/sources/mem", 5);
    from_json(json!({
        "workspaceId": "workspace.local",
        "machineId": "machine.local",
        "spool": {
            "path": ":memory:"
        },
        "flush": {
            "maxBatchSize": 16
        },
        "control": {
            "url": "wss://center.local/agent/control"
        },
        "lanes": [
            {
                "laneId": "lane.cpu",
                "schedule": {
                    "intervalSeconds": 60
                },
                "config": cpu
            },
            {
                "laneId": "lane.mem",
                "schedule": {
                    "intervalSeconds": 60
                },
                "config": mem
            }
        ]
    }))
}

pub fn empty_metric_agent_config() -> AgentConfig {
    let mut lane = script_lane_config("lane.cpu", "/var/lib/lanedeck/sources/cpu", 5);
    lane.metric_stage.mode = from_json(json!("empty"));
    agent_config_with_lane(lane)
}

pub fn reloaded_script_lane_config() -> LaneConfig {
    script_lane_config("lane.cpu", "/var/lib/lanedeck/sources/cpu-reloaded", 9)
}

pub fn reloaded_scripted_metric_lane_config() -> LaneConfig {
    let mut config = scripted_metric_agent_config();
    config.lanes.remove(0).config
}

pub fn unknown_script_lane_config() -> LaneConfig {
    script_lane_config("lane.unknown", "/var/lib/lanedeck/sources/unknown", 5)
}

fn agent_config_with_lane(lane: LaneConfig) -> AgentConfig {
    from_json(json!({
        "workspaceId": "workspace.local",
        "machineId": "machine.local",
        "spool": {
            "path": ":memory:"
        },
        "flush": {
            "maxBatchSize": 16
        },
        "control": {
            "url": "wss://center.local/agent/control"
        },
        "lanes": [
            {
                "laneId": "lane.cpu",
                "schedule": {
                    "intervalSeconds": 60
                },
                "config": lane
            }
        ]
    }))
}

fn script_lane_config(lane_id: &str, cwd: &str, timeout_seconds: i64) -> LaneConfig {
    from_json(json!({
        "laneId": lane_id,
        "displayName": "CPU lane",
        "rawStage": {
            "mode": "script",
            "settings": {
                "command": "collect-cpu",
                "cwd": cwd,
                "timeoutSeconds": timeout_seconds,
                "captureStdout": true,
                "captureStderr": true,
                "frame": {
                    "maxRecords": 1,
                    "maxSeconds": 60
                }
            }
        },
        "metricStage": {
            "mode": "passthrough",
            "settings": {}
        },
        "eventStage": {
            "mode": "passthrough",
            "settings": {}
        }
    }))
}

fn downstream_script_stage_missing_setting(
    stage_path: &'static str,
    missing_key: &str,
) -> LaneConfig {
    let mut lane = script_lane_config("lane.cpu", "/var/lib/lanedeck/sources/cpu", 5);
    let settings = script_stage_settings_without(missing_key);

    match stage_path {
        "metricStage" => {
            lane.metric_stage.mode = from_json(json!("script"));
            lane.metric_stage.settings = settings;
        }
        "eventStage" => {
            lane.event_stage.mode = from_json(json!("script"));
            lane.event_stage.settings = settings;
        }
        _ => unreachable!("known downstream stage path"),
    }

    lane
}

fn script_stage_non_bool_capture_setting(
    stage_path: &'static str,
    capture_key: &str,
) -> LaneConfig {
    let mut lane = script_lane_config("lane.cpu", "/var/lib/lanedeck/sources/cpu", 5);

    match stage_path {
        "rawStage" => lane.raw_stage.settings[capture_key] = json!("yes"),
        "metricStage" => {
            lane.metric_stage.mode = from_json(json!("script"));
            lane.metric_stage.settings = script_stage_settings();
            lane.metric_stage.settings[capture_key] = json!("yes");
        }
        "eventStage" => {
            lane.event_stage.mode = from_json(json!("script"));
            lane.event_stage.settings = script_stage_settings();
            lane.event_stage.settings[capture_key] = json!("yes");
        }
        _ => unreachable!("known script stage path"),
    }

    lane
}

fn downstream_builtin_stage(stage_path: &'static str) -> LaneConfig {
    let mut lane = script_lane_config("lane.cpu", "/var/lib/lanedeck/sources/cpu", 5);

    match stage_path {
        "metricStage" => lane.metric_stage.mode = from_json(json!("builtin")),
        "eventStage" => lane.event_stage.mode = from_json(json!("builtin")),
        _ => unreachable!("known downstream stage path"),
    }

    lane
}

fn script_stage_settings() -> Value {
    json!({
        "command": "transform-cpu",
        "cwd": "/var/lib/lanedeck/stages/downstream",
        "timeoutSeconds": 7,
        "captureStdout": true,
        "captureStderr": true
    })
}

fn script_stage_settings_without(missing_key: &str) -> Value {
    let mut settings = script_stage_settings();
    settings
        .as_object_mut()
        .expect("script stage settings object")
        .remove(missing_key);
    settings
}

pub fn raw_record(id: &str, observed_at: DateTime<Utc>) -> FrameRecord {
    from_json(json!({
        "id": id,
        "observedAt": observed_at.to_rfc3339(),
        "body": {
            "value": id
        }
    }))
}

pub fn event_frame(id: &str, now: DateTime<Utc>) -> Frame {
    from_json(json!({
        "laneId": "lane.cpu",
        "stage": "event",
        "frameNo": 1,
        "openedAt": now.to_rfc3339(),
        "closedAt": now.to_rfc3339(),
        "triggerKind": "count",
        "recordCount": 1,
        "records": [raw_record(id, now)],
        "summary": {}
    }))
}

pub fn ingest_batch(batch_id: &str, now: DateTime<Utc>) -> IngestBatch {
    from_json(json!({
        "workspaceId": "workspace.local",
        "machineId": "machine.local",
        "batchId": batch_id,
        "frames": [event_frame("event:1", now)]
    }))
}

pub fn two_frame_ingest_batch(batch_id: &str, now: DateTime<Utc>) -> IngestBatch {
    from_json(json!({
        "workspaceId": "workspace.local",
        "machineId": "machine.local",
        "batchId": batch_id,
        "frames": [
            event_frame("event:1", now),
            event_frame("event:2", now)
        ]
    }))
}

pub fn pending_spool_entry(id: &str, batch: IngestBatch) -> SpoolEntry {
    SpoolEntry::pending(SpoolEntryId::from(id), batch)
}

pub fn successful_script_output(now: DateTime<Utc>) -> ScriptRunOutput {
    ScriptRunOutput::from_json_records(vec![raw_record("raw:1", now)])
}

pub fn script_output_with_record(id: &str, now: DateTime<Utc>) -> ScriptRunOutput {
    ScriptRunOutput::from_json_records(vec![raw_record(id, now)])
}

pub fn script_output_with_records(ids: &[&str], now: DateTime<Utc>) -> ScriptRunOutput {
    ScriptRunOutput::from_json_records(ids.iter().map(|id| raw_record(id, now)).collect())
}

pub fn diagnostic_script_output(now: DateTime<Utc>) -> ScriptRunOutput {
    from_json(json!({
        "records": [raw_record("raw:1", now)],
        "diagnostics": [
            {
                "path": "rawStage.script",
                "message": "source script warning"
            }
        ]
    }))
}

#[derive(Clone)]
pub struct CenterProbe {
    inner: Arc<Mutex<CenterProbeState>>,
}

#[derive(Clone)]
struct CenterProbeState {
    outcome: CenterPostOutcome,
    posted_batches: Vec<IngestBatch>,
}

#[derive(Clone)]
enum CenterPostOutcome {
    Ack,
    AckWithBatchId(String),
    AckWithDiagnostics,
    AckWithAcceptedFrameCount(usize),
    RejectValidation,
    NetworkFailure,
}

impl CenterProbe {
    pub fn accepting() -> Self {
        Self::with_outcome(CenterPostOutcome::Ack)
    }

    pub fn acknowledging_batch_id(batch_id: &str) -> Self {
        Self::with_outcome(CenterPostOutcome::AckWithBatchId(batch_id.to_string()))
    }

    pub fn accepting_with_diagnostics() -> Self {
        Self::with_outcome(CenterPostOutcome::AckWithDiagnostics)
    }

    pub fn acknowledging_frame_count(accepted_frame_count: usize) -> Self {
        Self::with_outcome(CenterPostOutcome::AckWithAcceptedFrameCount(
            accepted_frame_count,
        ))
    }

    pub fn failing_network() -> Self {
        Self::with_outcome(CenterPostOutcome::NetworkFailure)
    }

    pub fn rejecting_validation() -> Self {
        Self::with_outcome(CenterPostOutcome::RejectValidation)
    }

    fn with_outcome(outcome: CenterPostOutcome) -> Self {
        Self {
            inner: Arc::new(Mutex::new(CenterProbeState {
                outcome,
                posted_batches: Vec::new(),
            })),
        }
    }

    pub fn posted_batches(&self) -> Vec<IngestBatch> {
        self.inner.lock().unwrap().posted_batches.clone()
    }
}

#[async_trait]
impl CenterClient for CenterProbe {
    async fn post_ingest_batch(&self, batch: IngestBatch) -> Result<IngestAck, AgentError> {
        let mut inner = self.inner.lock().unwrap();
        inner.posted_batches.push(batch.clone());

        match &inner.outcome {
            CenterPostOutcome::Ack => Ok(from_json(json!({
                "batchId": batch.batch_id,
                "acceptedFrameCount": batch.frames.len(),
                "diagnostics": []
            }))),
            CenterPostOutcome::AckWithBatchId(batch_id) => Ok(from_json(json!({
                "batchId": batch_id,
                "acceptedFrameCount": batch.frames.len(),
                "diagnostics": []
            }))),
            CenterPostOutcome::AckWithDiagnostics => Ok(from_json(json!({
                "batchId": batch.batch_id,
                "acceptedFrameCount": batch.frames.len(),
                "diagnostics": [
                    {
                        "path": "broadcast",
                        "message": "broadcast delayed"
                    }
                ]
            }))),
            CenterPostOutcome::AckWithAcceptedFrameCount(accepted_frame_count) => {
                Ok(from_json(json!({
                    "batchId": batch.batch_id,
                    "acceptedFrameCount": accepted_frame_count,
                    "diagnostics": []
                })))
            }
            CenterPostOutcome::RejectValidation => Ok(from_json(json!({
                "batchId": batch.batch_id,
                "acceptedFrameCount": 0,
                "diagnostics": [
                    {
                        "path": "frames[0]",
                        "message": "rejected frame"
                    }
                ]
            }))),
            CenterPostOutcome::NetworkFailure => Err(AgentError::network("center unreachable")),
        }
    }

    async fn connect_control(
        &self,
        _request: ControlConnectRequest,
    ) -> Result<ControlSession, AgentError> {
        unimplemented!("control session transport sits outside these contracts")
    }
}

#[derive(Clone, Default)]
pub struct SpoolProbe {
    inner: Arc<Mutex<SpoolProbeState>>,
}

#[derive(Clone, Default)]
struct SpoolProbeState {
    enqueued_batches: Vec<IngestBatch>,
    pending_entries: Vec<SpoolEntry>,
    lane_frame_cursors: HashMap<String, u64>,
    control_messages: HashMap<ControlMessageId, ControlMessageRecord>,
    acked_ids: Vec<SpoolEntryId>,
    retry_ids: Vec<SpoolEntryId>,
    rejected_ids: Vec<SpoolEntryId>,
    rejected_diagnostics: Vec<Diagnostic>,
    enqueue_failures_remaining: usize,
}

impl SpoolProbe {
    pub fn with_pending(entries: Vec<SpoolEntry>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(SpoolProbeState {
                pending_entries: entries,
                ..SpoolProbeState::default()
            })),
        }
    }

    pub fn fail_next_enqueue() -> Self {
        Self {
            inner: Arc::new(Mutex::new(SpoolProbeState {
                enqueue_failures_remaining: 1,
                ..SpoolProbeState::default()
            })),
        }
    }

    pub fn with_control_message(
        message_id: impl Into<ControlMessageId>,
        record: ControlMessageRecord,
    ) -> Self {
        let mut control_messages = HashMap::new();
        control_messages.insert(message_id.into(), record);
        Self {
            inner: Arc::new(Mutex::new(SpoolProbeState {
                control_messages,
                ..SpoolProbeState::default()
            })),
        }
    }

    pub fn control_message_record(
        &self,
        message_id: impl Into<ControlMessageId>,
    ) -> Option<ControlMessageRecord> {
        self.inner
            .lock()
            .unwrap()
            .control_messages
            .get(&message_id.into())
            .cloned()
    }

    pub fn enqueued_batches(&self) -> Vec<IngestBatch> {
        self.inner.lock().unwrap().enqueued_batches.clone()
    }

    pub fn pending_entries(&self) -> Vec<SpoolEntry> {
        self.inner.lock().unwrap().pending_entries.clone()
    }

    pub fn acked_ids(&self) -> Vec<SpoolEntryId> {
        self.inner.lock().unwrap().acked_ids.clone()
    }

    pub fn retry_ids(&self) -> Vec<SpoolEntryId> {
        self.inner.lock().unwrap().retry_ids.clone()
    }

    pub fn rejected_ids(&self) -> Vec<SpoolEntryId> {
        self.inner.lock().unwrap().rejected_ids.clone()
    }

    pub fn rejected_diagnostics(&self) -> Vec<Diagnostic> {
        self.inner.lock().unwrap().rejected_diagnostics.clone()
    }
}

impl LocalSpool for SpoolProbe {
    fn load_lane_frame_cursor(&mut self, lane_id: &str) -> Result<u64, AgentError> {
        Ok(self
            .inner
            .lock()
            .unwrap()
            .lane_frame_cursors
            .get(lane_id)
            .copied()
            .unwrap_or(1))
    }

    fn load_control_message(
        &mut self,
        message_id: &ControlMessageId,
    ) -> Result<Option<ControlMessageRecord>, AgentError> {
        Ok(self
            .inner
            .lock()
            .unwrap()
            .control_messages
            .get(message_id)
            .cloned())
    }

    fn mark_control_message_in_progress(
        &mut self,
        message_id: ControlMessageId,
    ) -> Result<(), AgentError> {
        self.inner
            .lock()
            .unwrap()
            .control_messages
            .insert(message_id, ControlMessageRecord::InProgress);
        Ok(())
    }

    fn mark_control_message_completed(
        &mut self,
        message_id: ControlMessageId,
        result: Result<lanedeck_agent_runtime::ControlReply, AgentError>,
    ) -> Result<(), AgentError> {
        self.inner
            .lock()
            .unwrap()
            .control_messages
            .insert(message_id, ControlMessageRecord::Completed(result));
        Ok(())
    }

    fn enqueue(&mut self, batch: IngestBatch) -> Result<SpoolEntryId, AgentError> {
        let mut inner = self.inner.lock().unwrap();
        if inner.enqueue_failures_remaining > 0 {
            inner.enqueue_failures_remaining -= 1;
            return Err(AgentError::spool("enqueue failed"));
        }

        let id = SpoolEntryId::from(format!("spool-{}", inner.enqueued_batches.len() + 1));
        for frame in &batch.frames {
            let next_cursor = frame.frame_no + 1;
            inner
                .lane_frame_cursors
                .entry(frame.lane_id.clone())
                .and_modify(|cursor| *cursor = (*cursor).max(next_cursor))
                .or_insert(next_cursor);
        }
        inner.enqueued_batches.push(batch.clone());
        inner
            .pending_entries
            .push(SpoolEntry::pending(id.clone(), batch));
        Ok(id)
    }

    fn pending_batch(&mut self, limit: usize) -> Result<Vec<SpoolEntry>, AgentError> {
        Ok(self
            .inner
            .lock()
            .unwrap()
            .pending_entries
            .iter()
            .take(limit)
            .cloned()
            .collect())
    }

    fn mark_acked(&mut self, ids: &[SpoolEntryId]) -> Result<(), AgentError> {
        let mut inner = self.inner.lock().unwrap();
        inner.acked_ids.extend_from_slice(ids);
        inner
            .pending_entries
            .retain(|entry| !ids.contains(&entry.id));
        Ok(())
    }

    fn mark_retry(&mut self, ids: &[SpoolEntryId], _reason: RetryReason) -> Result<(), AgentError> {
        self.inner.lock().unwrap().retry_ids.extend_from_slice(ids);
        Ok(())
    }

    fn mark_rejected(
        &mut self,
        ids: &[SpoolEntryId],
        diagnostics: Vec<Diagnostic>,
    ) -> Result<(), AgentError> {
        let mut inner = self.inner.lock().unwrap();
        inner.rejected_ids.extend_from_slice(ids);
        inner.rejected_diagnostics.extend(diagnostics);
        inner
            .pending_entries
            .retain(|entry| !ids.contains(&entry.id));
        Ok(())
    }
}

#[derive(Clone)]
pub struct ScriptRunnerProbe {
    inner: Arc<Mutex<ScriptRunnerProbeState>>,
}

#[derive(Clone, Default)]
struct ScriptRunnerProbeState {
    requests: Vec<ScriptRunRequest>,
    outputs: VecDeque<Result<ScriptRunOutput, String>>,
}

impl ScriptRunnerProbe {
    pub fn with_outputs(outputs: Vec<ScriptRunOutput>) -> Self {
        Self::with_results(outputs.into_iter().map(Ok).collect())
    }

    pub fn with_results(outputs: Vec<Result<ScriptRunOutput, String>>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ScriptRunnerProbeState {
                requests: Vec::new(),
                outputs: outputs.into(),
            })),
        }
    }

    pub fn requests(&self) -> Vec<ScriptRunRequest> {
        self.inner.lock().unwrap().requests.clone()
    }
}

impl ScriptRunner for ScriptRunnerProbe {
    fn run_script(&self, request: ScriptRunRequest) -> Result<ScriptRunOutput, AgentError> {
        let mut inner = self.inner.lock().unwrap();
        inner.requests.push(request);
        inner
            .outputs
            .pop_front()
            .unwrap_or_else(|| Ok(ScriptRunOutput::from_json_records(Vec::new())))
            .map_err(AgentError::script)
    }
}

pub fn content_root() -> PathBuf {
    PathBuf::from("/var/lib/lanedeck/content")
}

pub fn duration(seconds: i64) -> Duration {
    Duration::seconds(seconds)
}

fn from_json<T>(value: Value) -> T
where
    T: serde::de::DeserializeOwned,
{
    serde_json::from_value(value).expect("valid contract fixture")
}
