use chrono::{DateTime, Duration, Utc};
use lanedeck_protocol::{
    Diagnostic, Frame, FrameRecord, LaneConfig, StageHistory, StageKind, StageMode, TriggerKind,
};
use thiserror::Error;

pub use lanedeck_protocol::{StageInvocation, StageResult};

pub const PACKAGE_NAME: &str = "lanedeck-lane-engine";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRequest {
    pub lane_id: String,
    pub stage: StageKind,
    pub upstream_frames: usize,
    pub metric_frames: usize,
    pub event_frames: usize,
}

pub trait HistoryStore {
    fn load_history(&self, request: HistoryRequest) -> Result<StageHistory, EngineError>;
    fn append_frame(&mut self, frame: Frame) -> Result<(), EngineError>;
}

pub trait StageRunner {
    fn run_stage(&self, invocation: StageInvocation) -> Result<StageResult, EngineError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StageDiagnosticStatus {
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EngineEffect {
    FrameClosed {
        frame: Frame,
    },
    StageDiagnostic {
        stage: StageKind,
        status: StageDiagnosticStatus,
        diagnostic: Diagnostic,
    },
}

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("invalid lane config: {0}")]
    InvalidConfig(String),
    #[error("history store failed: {0}")]
    Store(String),
    #[error("stage runner failed: {0}")]
    Runner(String),
}

pub struct LaneEngine<S, R> {
    config: LaneConfig,
    store: S,
    runner: R,
    raw_records: Vec<FrameRecord>,
    raw_opened_at: Option<DateTime<Utc>>,
    pending_raw_close: Option<PendingRawClose>,
    next_frame_no: u64,
    max_records: usize,
    max_duration: Duration,
    effects: Vec<EngineEffect>,
}

#[derive(Debug, Clone, PartialEq)]
struct PendingRawClose {
    config: LaneConfig,
    trigger_kind: TriggerKind,
    closed_at: DateTime<Utc>,
    raw_frame: Option<Frame>,
    raw_persisted: bool,
    metric_frame: Option<Frame>,
    metric_diagnostics: Vec<Diagnostic>,
    metric_persisted: bool,
    event_frame: Option<Frame>,
    event_diagnostics: Vec<Diagnostic>,
    event_persisted: bool,
}

impl PendingRawClose {
    fn new(config: LaneConfig, trigger_kind: TriggerKind, closed_at: DateTime<Utc>) -> Self {
        Self {
            config,
            trigger_kind,
            closed_at,
            raw_frame: None,
            raw_persisted: false,
            metric_frame: None,
            metric_diagnostics: Vec::new(),
            metric_persisted: false,
            event_frame: None,
            event_diagnostics: Vec::new(),
            event_persisted: false,
        }
    }
}

impl<S, R> LaneEngine<S, R>
where
    S: HistoryStore,
    R: StageRunner,
{
    pub fn new(config: LaneConfig, store: S, runner: R) -> Result<Self, EngineError> {
        Self::new_with_next_frame_no(config, store, runner, 1)
    }

    pub fn new_with_next_frame_no(
        config: LaneConfig,
        store: S,
        runner: R,
        next_frame_no: u64,
    ) -> Result<Self, EngineError> {
        let (max_records, max_duration) = frame_limits(&config)?;

        Ok(Self {
            config,
            store,
            runner,
            raw_records: Vec::new(),
            raw_opened_at: None,
            pending_raw_close: None,
            next_frame_no,
            max_records,
            max_duration,
            effects: Vec::new(),
        })
    }

    pub fn replace_config(&mut self, config: LaneConfig) -> Result<(), EngineError> {
        if config.lane_id != self.config.lane_id {
            return Err(EngineError::InvalidConfig(format!(
                "replacement laneId {} must match existing laneId {}",
                config.lane_id, self.config.lane_id
            )));
        }
        let (max_records, max_duration) = frame_limits(&config)?;

        self.config = config;
        self.max_records = max_records;
        self.max_duration = max_duration;

        Ok(())
    }

    pub fn has_pending_close(&self) -> bool {
        self.pending_raw_close.is_some()
    }

    pub fn retry_pending_close(&mut self) -> Result<Vec<EngineEffect>, EngineError> {
        self.retry_pending_raw_close()?;
        Ok(self.drain_effects())
    }
}

fn frame_limits(config: &LaneConfig) -> Result<(usize, Duration), EngineError> {
    let max_records = config.raw_stage.settings["frame"]["maxRecords"]
        .as_u64()
        .ok_or_else(|| EngineError::InvalidConfig("rawStage.settings.frame.maxRecords".into()))?
        as usize;
    let max_seconds = config.raw_stage.settings["frame"]["maxSeconds"]
        .as_i64()
        .ok_or_else(|| EngineError::InvalidConfig("rawStage.settings.frame.maxSeconds".into()))?;
    if max_records == 0 {
        return Err(EngineError::InvalidConfig(
            "rawStage.settings.frame.maxRecords must be positive".into(),
        ));
    }
    if max_seconds <= 0 {
        return Err(EngineError::InvalidConfig(
            "rawStage.settings.frame.maxSeconds must be positive".into(),
        ));
    }
    let max_duration = Duration::try_seconds(max_seconds).ok_or_else(|| {
        EngineError::InvalidConfig(
            "rawStage.settings.frame.maxSeconds is outside supported duration range".into(),
        )
    })?;

    Ok((max_records, max_duration))
}

impl<S, R> LaneEngine<S, R>
where
    S: HistoryStore,
    R: StageRunner,
{
    pub fn ingest_raw_record(
        &mut self,
        record: FrameRecord,
        now: DateTime<Utc>,
    ) -> Result<Vec<EngineEffect>, EngineError> {
        if self.pending_raw_close.is_some() {
            self.retry_pending_raw_close()?;
        } else if self.raw_records.len() >= self.max_records {
            self.request_raw_close(TriggerKind::Count, now)?;
        }

        if self.raw_opened_at.is_none() {
            self.raw_opened_at = Some(now);
        }
        self.raw_records.push(record);

        if self.raw_records.len() >= self.max_records {
            self.request_raw_close(TriggerKind::Count, now)?;
        }

        Ok(self.drain_effects())
    }

    pub fn tick(&mut self, now: DateTime<Utc>) -> Result<Vec<EngineEffect>, EngineError> {
        if self.pending_raw_close.is_some() {
            self.retry_pending_raw_close()?;
            return Ok(self.drain_effects());
        }

        let opened_at = match self.raw_opened_at {
            Some(opened_at) => opened_at,
            None => {
                self.raw_opened_at = Some(now);
                return Ok(Vec::new());
            }
        };

        if self.raw_records.len() >= self.max_records {
            self.request_raw_close(TriggerKind::Count, now)?;
            return Ok(self.drain_effects());
        }

        if now.signed_duration_since(opened_at) >= self.max_duration {
            self.request_raw_close(TriggerKind::Time, now)?;
        }

        Ok(self.drain_effects())
    }

    pub fn run_metric_stage(
        &mut self,
        raw_frame: Frame,
        now: DateTime<Utc>,
    ) -> Result<Frame, EngineError> {
        self.run_stage(raw_frame, StageKind::Metric, now)
    }

    pub fn run_event_stage(
        &mut self,
        metric_frame: Frame,
        now: DateTime<Utc>,
    ) -> Result<Frame, EngineError> {
        self.run_stage(metric_frame, StageKind::Event, now)
    }

    pub fn drain_effects(&mut self) -> Vec<EngineEffect> {
        std::mem::take(&mut self.effects)
    }

    fn request_raw_close(
        &mut self,
        trigger_kind: TriggerKind,
        closed_at: DateTime<Utc>,
    ) -> Result<(), EngineError> {
        if self.pending_raw_close.is_none() {
            self.pending_raw_close = Some(PendingRawClose::new(
                self.config.clone(),
                trigger_kind,
                closed_at,
            ));
        }
        self.retry_pending_raw_close()
    }

    fn retry_pending_raw_close(&mut self) -> Result<(), EngineError> {
        if self.pending_raw_close.is_none() {
            return Ok(());
        }
        let effects_start = self.effects.len();
        let result = self.advance_pending_raw_close();

        if result.is_err() {
            self.effects.truncate(effects_start);
        }

        result
    }

    fn advance_pending_raw_close(&mut self) -> Result<(), EngineError> {
        self.ensure_pending_raw_frame();

        let raw_frame = self
            .pending_raw_close
            .as_ref()
            .and_then(|pending| pending.raw_frame.clone())
            .expect("pending close has raw frame");
        let closed_at = raw_frame.closed_at;

        if self
            .pending_raw_close
            .as_ref()
            .is_some_and(|pending| pending.metric_frame.is_none())
        {
            let config = self
                .pending_raw_close
                .as_ref()
                .expect("pending close exists")
                .config
                .clone();
            let (metric_frame, diagnostics) =
                self.build_stage_frame(&config, raw_frame.clone(), StageKind::Metric, closed_at)?;
            let pending = self
                .pending_raw_close
                .as_mut()
                .expect("pending close exists");
            pending.metric_frame = Some(metric_frame);
            pending.metric_diagnostics = diagnostics;
        }

        if self
            .pending_raw_close
            .as_ref()
            .is_some_and(|pending| !pending.raw_persisted)
        {
            self.store.append_frame(raw_frame.clone())?;
            self.pending_raw_close
                .as_mut()
                .expect("pending close exists")
                .raw_persisted = true;
        }

        let metric_frame = self
            .pending_raw_close
            .as_ref()
            .and_then(|pending| pending.metric_frame.clone())
            .expect("pending close has metric frame");

        if self
            .pending_raw_close
            .as_ref()
            .is_some_and(|pending| !pending.metric_persisted)
        {
            self.store.append_frame(metric_frame.clone())?;
            self.pending_raw_close
                .as_mut()
                .expect("pending close exists")
                .metric_persisted = true;
        }

        if self
            .pending_raw_close
            .as_ref()
            .is_some_and(|pending| pending.event_frame.is_none())
        {
            let config = self
                .pending_raw_close
                .as_ref()
                .expect("pending close exists")
                .config
                .clone();
            let (event_frame, diagnostics) =
                self.build_stage_frame(&config, metric_frame.clone(), StageKind::Event, closed_at)?;
            let pending = self
                .pending_raw_close
                .as_mut()
                .expect("pending close exists");
            pending.event_frame = Some(event_frame);
            pending.event_diagnostics = diagnostics;
        }

        let event_frame = self
            .pending_raw_close
            .as_ref()
            .and_then(|pending| pending.event_frame.clone())
            .expect("pending close has event frame");

        if self
            .pending_raw_close
            .as_ref()
            .is_some_and(|pending| !pending.event_persisted)
        {
            self.store.append_frame(event_frame.clone())?;
            self.pending_raw_close
                .as_mut()
                .expect("pending close exists")
                .event_persisted = true;
        }

        let completed = self
            .pending_raw_close
            .take()
            .expect("completed pending close exists");
        self.push_success_diagnostics(&StageKind::Metric, &completed.metric_diagnostics);
        self.push_success_diagnostics(&StageKind::Event, &completed.event_diagnostics);
        self.effects
            .push(EngineEffect::FrameClosed { frame: raw_frame });
        self.effects.push(EngineEffect::FrameClosed {
            frame: metric_frame,
        });
        self.effects
            .push(EngineEffect::FrameClosed { frame: event_frame });
        self.raw_records.clear();
        self.next_frame_no += 1;
        self.raw_opened_at = None;

        Ok(())
    }

    fn ensure_pending_raw_frame(&mut self) {
        let pending = self
            .pending_raw_close
            .as_mut()
            .expect("pending close exists");
        if pending.raw_frame.is_some() {
            return;
        }

        let opened_at = self.raw_opened_at.unwrap_or(pending.closed_at);
        pending.raw_frame = Some(Frame {
            lane_id: pending.config.lane_id.clone(),
            stage: StageKind::Raw,
            frame_no: self.next_frame_no,
            opened_at,
            closed_at: pending.closed_at,
            trigger_kind: pending.trigger_kind.clone(),
            record_count: self.raw_records.len() as u32,
            records: self.raw_records.clone(),
            summary: serde_json::json!({}),
        });
    }

    fn run_stage(
        &mut self,
        upstream_frame: Frame,
        target_stage: StageKind,
        now: DateTime<Utc>,
    ) -> Result<Frame, EngineError> {
        let (frame, diagnostics) =
            self.build_stage_frame(&self.config, upstream_frame, target_stage.clone(), now)?;
        self.push_success_diagnostics(&target_stage, &diagnostics);
        Ok(frame)
    }

    fn build_stage_frame(
        &self,
        config: &LaneConfig,
        upstream_frame: Frame,
        target_stage: StageKind,
        now: DateTime<Utc>,
    ) -> Result<(Frame, Vec<Diagnostic>), EngineError> {
        let mode = match target_stage {
            StageKind::Raw => StageMode::Builtin,
            StageKind::Metric => config.metric_stage.mode.clone(),
            StageKind::Event => config.event_stage.mode.clone(),
        };

        let (records, diagnostics) = match mode {
            StageMode::Passthrough => (upstream_frame.records.clone(), Vec::new()),
            StageMode::Empty => (
                Vec::new(),
                vec![Diagnostic {
                    path: stage_path(&target_stage),
                    message: "empty stage produced zero records".into(),
                }],
            ),
            StageMode::Script | StageMode::Builtin => {
                let history = self.store.load_history(HistoryRequest {
                    lane_id: self.config.lane_id.clone(),
                    stage: target_stage.clone(),
                    upstream_frames: history_window(config, &target_stage, "upstreamFrames"),
                    metric_frames: history_window(config, &target_stage, "metricFrames"),
                    event_frames: history_window(config, &target_stage, "eventFrames"),
                })?;
                let result = self.runner.run_stage(StageInvocation {
                    current_frame: upstream_frame.clone(),
                    history,
                    lane: config.clone(),
                    now,
                })?;
                (result.records, result.diagnostics)
            }
        };

        Ok((
            Frame {
                lane_id: upstream_frame.lane_id,
                stage: target_stage,
                frame_no: upstream_frame.frame_no,
                opened_at: upstream_frame.opened_at,
                closed_at: now,
                trigger_kind: upstream_frame.trigger_kind,
                record_count: records.len() as u32,
                records,
                summary: serde_json::json!({}),
            },
            diagnostics,
        ))
    }

    fn push_success_diagnostics(&mut self, stage: &StageKind, diagnostics: &[Diagnostic]) {
        for diagnostic in diagnostics {
            self.effects.push(EngineEffect::StageDiagnostic {
                stage: stage.clone(),
                status: StageDiagnosticStatus::Succeeded,
                diagnostic: diagnostic.clone(),
            });
        }
    }
}

fn stage_path(stage: &StageKind) -> String {
    match stage {
        StageKind::Raw => "rawStage",
        StageKind::Metric => "metricStage",
        StageKind::Event => "eventStage",
    }
    .to_string()
}

fn history_window(config: &LaneConfig, stage: &StageKind, key: &str) -> usize {
    let stage_config = match stage {
        StageKind::Raw => &config.raw_stage,
        StageKind::Metric => &config.metric_stage,
        StageKind::Event => &config.event_stage,
    };
    stage_config.settings["history"][key].as_u64().unwrap_or(0) as usize
}
