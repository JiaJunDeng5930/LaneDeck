use std::cell::RefCell;
use std::rc::Rc;

use chrono::{DateTime, Duration, Utc};
use lanedeck_lane_engine::{
    EngineEffect, EngineError, HistoryRequest, HistoryStore, StageDiagnosticStatus,
    StageInvocation, StageResult, StageRunner,
};
use lanedeck_protocol::{
    Diagnostic, Frame, FrameRecord, LaneConfig, StageHistory, StageKind, TriggerKind,
};
use serde_json::{Value, json};

pub fn instant(seconds: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(seconds, 0).expect("valid contract test timestamp")
}

pub fn script_lane_config(max_records: usize, max_seconds: i64) -> LaneConfig {
    lane_config(max_records, max_seconds, "script", "script")
}

pub fn metric_passthrough_lane_config() -> LaneConfig {
    lane_config(10, 60, "passthrough", "script")
}

pub fn metric_empty_lane_config() -> LaneConfig {
    lane_config(10, 60, "empty", "script")
}

fn lane_config(
    max_records: usize,
    max_seconds: i64,
    metric_mode: &str,
    event_mode: &str,
) -> LaneConfig {
    from_json(json!({
        "laneId": "lane.cpu",
        "displayName": "CPU lane",
        "rawStage": {
            "mode": "builtin",
            "settings": {
                "frame": {
                    "maxRecords": max_records,
                    "maxSeconds": max_seconds
                }
            }
        },
        "metricStage": {
            "mode": metric_mode,
            "settings": {
                "script": "metric-stage",
                "history": {
                    "upstreamFrames": 2,
                    "metricFrames": 2,
                    "eventFrames": 1
                }
            }
        },
        "eventStage": {
            "mode": event_mode,
            "settings": {
                "script": "event-stage",
                "history": {
                    "upstreamFrames": 1,
                    "metricFrames": 2,
                    "eventFrames": 2
                }
            }
        }
    }))
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

pub fn frame(
    stage: &str,
    trigger_kind: &str,
    records: Vec<FrameRecord>,
    frame_no: u64,
    opened_at: DateTime<Utc>,
    closed_at: DateTime<Utc>,
) -> Frame {
    from_json(json!({
        "laneId": "lane.cpu",
        "stage": stage,
        "frameNo": frame_no,
        "openedAt": opened_at.to_rfc3339(),
        "closedAt": closed_at.to_rfc3339(),
        "triggerKind": trigger_kind,
        "recordCount": records.len(),
        "records": records,
        "summary": {}
    }))
}

pub fn stage_history(
    upstream_frames: Vec<Frame>,
    metric_frames: Vec<Frame>,
    event_frames: Vec<Frame>,
) -> StageHistory {
    from_json(json!({
        "upstreamFrames": upstream_frames,
        "metricFrames": metric_frames,
        "eventFrames": event_frames
    }))
}

pub fn empty_history() -> StageHistory {
    stage_history(Vec::new(), Vec::new(), Vec::new())
}

pub fn stage_result(records: Vec<FrameRecord>) -> StageResult {
    from_json(json!({
        "records": records,
        "diagnostics": []
    }))
}

pub fn stage_result_with_diagnostics(
    records: Vec<FrameRecord>,
    diagnostics: Vec<Diagnostic>,
) -> StageResult {
    from_json(json!({
        "records": records,
        "diagnostics": diagnostics
    }))
}

#[derive(Clone)]
pub struct StoreProbe {
    inner: Rc<RefCell<StoreProbeState>>,
}

#[derive(Clone)]
struct StoreProbeState {
    history: StageHistory,
    requests: Vec<HistoryRequest>,
    record_appends: bool,
    append_results: Vec<Result<(), String>>,
    append_attempts: usize,
    appended_frames: Vec<Frame>,
}

impl StoreProbe {
    pub fn new(history: StageHistory) -> Self {
        Self {
            inner: Rc::new(RefCell::new(StoreProbeState {
                history,
                requests: Vec::new(),
                record_appends: false,
                append_results: Vec::new(),
                append_attempts: 0,
                appended_frames: Vec::new(),
            })),
        }
    }

    pub fn recording(history: StageHistory) -> Self {
        Self {
            inner: Rc::new(RefCell::new(StoreProbeState {
                history,
                requests: Vec::new(),
                record_appends: true,
                append_results: Vec::new(),
                append_attempts: 0,
                appended_frames: Vec::new(),
            })),
        }
    }

    pub fn with_append_results(
        history: StageHistory,
        append_results: Vec<Result<(), String>>,
    ) -> Self {
        Self {
            inner: Rc::new(RefCell::new(StoreProbeState {
                history,
                requests: Vec::new(),
                record_appends: true,
                append_results,
                append_attempts: 0,
                appended_frames: Vec::new(),
            })),
        }
    }

    pub fn appended_frames(&self) -> Vec<Frame> {
        self.inner.borrow().appended_frames.clone()
    }

    pub fn requests(&self) -> Vec<HistoryRequest> {
        self.inner.borrow().requests.clone()
    }
}

impl HistoryStore for StoreProbe {
    fn load_history(&self, request: HistoryRequest) -> Result<StageHistory, EngineError> {
        let mut inner = self.inner.borrow_mut();
        inner.requests.push(request);
        Ok(inner.history.clone())
    }

    fn append_frame(&mut self, frame: Frame) -> Result<(), EngineError> {
        let mut inner = self.inner.borrow_mut();
        let append_index = inner.append_attempts;
        inner.append_attempts += 1;
        if let Some(Err(message)) = inner.append_results.get(append_index) {
            return Err(EngineError::Store(message.clone()));
        }
        if inner.record_appends {
            match frame.stage {
                StageKind::Raw => inner.history.upstream_frames.push(frame.clone()),
                StageKind::Metric => inner.history.metric_frames.push(frame.clone()),
                StageKind::Event => inner.history.event_frames.push(frame.clone()),
            }
        }
        inner.appended_frames.push(frame);
        Ok(())
    }
}

#[derive(Clone)]
pub struct RunnerProbe {
    inner: Rc<RefCell<RunnerProbeState>>,
}

#[derive(Clone)]
struct RunnerProbeState {
    invocations: Vec<StageInvocation>,
    scripted_results: Vec<Result<StageResult, String>>,
}

impl RunnerProbe {
    pub fn scripted(scripted_results: Vec<StageResult>) -> Self {
        Self::scripted_results(
            scripted_results
                .into_iter()
                .map(Ok)
                .collect::<Vec<Result<StageResult, String>>>(),
        )
    }

    pub fn scripted_results(scripted_results: Vec<Result<StageResult, String>>) -> Self {
        Self {
            inner: Rc::new(RefCell::new(RunnerProbeState {
                invocations: Vec::new(),
                scripted_results,
            })),
        }
    }

    pub fn invocations(&self) -> Vec<StageInvocation> {
        self.inner.borrow().invocations.clone()
    }
}

impl StageRunner for RunnerProbe {
    fn run_stage(&self, invocation: StageInvocation) -> Result<StageResult, EngineError> {
        let mut inner = self.inner.borrow_mut();
        inner.invocations.push(invocation.clone());

        let result = inner
            .scripted_results
            .get(inner.invocations.len() - 1)
            .cloned()
            .unwrap_or_else(|| Ok(stage_result(invocation.current_frame.records.clone())));

        result.map_err(EngineError::Runner)
    }
}

pub fn closed_frames(effects: &[EngineEffect]) -> Vec<&Frame> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            EngineEffect::FrameClosed { frame } => Some(frame),
            _ => None,
        })
        .collect()
}

pub fn closed_frame(effects: &[EngineEffect], stage: StageKind) -> &Frame {
    closed_frames(effects)
        .into_iter()
        .find(|frame| frame.stage == stage)
        .expect("closed frame for requested stage")
}

pub fn successful_stage_diagnostics(
    effects: &[EngineEffect],
    stage: StageKind,
) -> Vec<&Diagnostic> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            EngineEffect::StageDiagnostic {
                stage: effect_stage,
                status: StageDiagnosticStatus::Succeeded,
                diagnostic,
            } if *effect_stage == stage => Some(diagnostic),
            _ => None,
        })
        .collect()
}

pub fn assert_trigger(frame: &Frame, trigger_kind: TriggerKind) {
    assert_eq!(frame.trigger_kind, trigger_kind);
}

pub fn assert_record_ids(frame: &Frame, expected_ids: &[&str]) {
    let actual_ids = frame
        .records
        .iter()
        .map(|record| record.id.as_str())
        .collect::<Vec<_>>();

    assert_eq!(actual_ids, expected_ids);
}

pub fn assert_same_history(actual: &StageHistory, expected: &StageHistory) {
    assert_eq!(actual.upstream_frames, expected.upstream_frames);
    assert_eq!(actual.metric_frames, expected.metric_frames);
    assert_eq!(actual.event_frames, expected.event_frames);
}

pub fn seconds(value: i64) -> Duration {
    Duration::seconds(value)
}

fn from_json<T>(value: Value) -> T
where
    T: serde::de::DeserializeOwned,
{
    serde_json::from_value(value).expect("valid contract fixture")
}
