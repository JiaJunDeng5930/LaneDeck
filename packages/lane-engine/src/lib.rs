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
    fn append_frames(&mut self, frames: Vec<Frame>) -> Result<(), EngineError>;
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
    next_frame_no: u64,
    max_records: usize,
    max_seconds: i64,
    effects: Vec<EngineEffect>,
}

impl<S, R> LaneEngine<S, R>
where
    S: HistoryStore,
    R: StageRunner,
{
    pub fn new(config: LaneConfig, store: S, runner: R) -> Result<Self, EngineError> {
        let max_records = config.raw_stage.settings["frame"]["maxRecords"]
            .as_u64()
            .ok_or_else(|| {
                EngineError::InvalidConfig("rawStage.settings.frame.maxRecords".into())
            })? as usize;
        let max_seconds = config.raw_stage.settings["frame"]["maxSeconds"]
            .as_i64()
            .ok_or_else(|| {
                EngineError::InvalidConfig("rawStage.settings.frame.maxSeconds".into())
            })?;
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

        Ok(Self {
            config,
            store,
            runner,
            raw_records: Vec::new(),
            raw_opened_at: None,
            next_frame_no: 1,
            max_records,
            max_seconds,
            effects: Vec::new(),
        })
    }

    pub fn ingest_raw_record(
        &mut self,
        record: FrameRecord,
        now: DateTime<Utc>,
    ) -> Result<Vec<EngineEffect>, EngineError> {
        if self.raw_records.len() >= self.max_records {
            self.close_raw_frame(TriggerKind::Count, now)?;
        }

        if self.raw_opened_at.is_none() {
            self.raw_opened_at = Some(now);
        }
        self.raw_records.push(record);

        if self.raw_records.len() >= self.max_records {
            self.close_raw_frame(TriggerKind::Count, now)?;
        }

        Ok(self.drain_effects())
    }

    pub fn tick(&mut self, now: DateTime<Utc>) -> Result<Vec<EngineEffect>, EngineError> {
        let opened_at = match self.raw_opened_at {
            Some(opened_at) => opened_at,
            None => {
                self.raw_opened_at = Some(now);
                return Ok(Vec::new());
            }
        };

        if now.signed_duration_since(opened_at) >= Duration::seconds(self.max_seconds) {
            self.close_raw_frame(TriggerKind::Time, now)?;
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

    fn close_raw_frame(
        &mut self,
        trigger_kind: TriggerKind,
        closed_at: DateTime<Utc>,
    ) -> Result<(), EngineError> {
        let effects_start = self.effects.len();
        let opened_at = self.raw_opened_at.unwrap_or(closed_at);
        let raw_frame = Frame {
            lane_id: self.config.lane_id.clone(),
            stage: StageKind::Raw,
            frame_no: self.next_frame_no,
            opened_at,
            closed_at,
            trigger_kind,
            record_count: self.raw_records.len() as u32,
            records: self.raw_records.clone(),
            summary: serde_json::json!({}),
        };

        let result = (|| {
            let metric_frame = self.run_metric_stage(raw_frame.clone(), closed_at)?;
            let event_frame = self.run_event_stage(metric_frame.clone(), closed_at)?;
            self.store.append_frames(vec![
                raw_frame.clone(),
                metric_frame.clone(),
                event_frame.clone(),
            ])?;
            self.effects
                .push(EngineEffect::FrameClosed { frame: raw_frame });
            self.effects.push(EngineEffect::FrameClosed {
                frame: metric_frame,
            });
            self.effects
                .push(EngineEffect::FrameClosed { frame: event_frame });
            Ok(())
        })();

        if result.is_err() {
            self.effects.truncate(effects_start);
        } else {
            self.raw_records.clear();
            self.next_frame_no += 1;
            self.raw_opened_at = None;
        }

        result
    }

    fn run_stage(
        &mut self,
        upstream_frame: Frame,
        target_stage: StageKind,
        now: DateTime<Utc>,
    ) -> Result<Frame, EngineError> {
        let mode = match target_stage {
            StageKind::Raw => StageMode::Builtin,
            StageKind::Metric => self.config.metric_stage.mode.clone(),
            StageKind::Event => self.config.event_stage.mode.clone(),
        };

        let records = match mode {
            StageMode::Passthrough => upstream_frame.records.clone(),
            StageMode::Empty => {
                self.effects.push(EngineEffect::StageDiagnostic {
                    stage: target_stage.clone(),
                    status: StageDiagnosticStatus::Succeeded,
                    diagnostic: Diagnostic {
                        path: stage_path(&target_stage),
                        message: "empty stage produced zero records".into(),
                    },
                });
                Vec::new()
            }
            StageMode::Script | StageMode::Builtin => {
                let history = self.store.load_history(HistoryRequest {
                    lane_id: self.config.lane_id.clone(),
                    stage: target_stage.clone(),
                    upstream_frames: history_window(&self.config, &target_stage, "upstreamFrames"),
                    metric_frames: history_window(&self.config, &target_stage, "metricFrames"),
                    event_frames: history_window(&self.config, &target_stage, "eventFrames"),
                })?;
                let result = self.runner.run_stage(StageInvocation {
                    current_frame: upstream_frame.clone(),
                    history,
                    lane: self.config.clone(),
                    now,
                })?;
                for diagnostic in &result.diagnostics {
                    self.effects.push(EngineEffect::StageDiagnostic {
                        stage: target_stage.clone(),
                        status: StageDiagnosticStatus::Succeeded,
                        diagnostic: diagnostic.clone(),
                    });
                }
                result.records
            }
        };

        Ok(Frame {
            lane_id: upstream_frame.lane_id,
            stage: target_stage,
            frame_no: upstream_frame.frame_no,
            opened_at: upstream_frame.opened_at,
            closed_at: now,
            trigger_kind: upstream_frame.trigger_kind,
            record_count: records.len() as u32,
            records,
            summary: serde_json::json!({}),
        })
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
