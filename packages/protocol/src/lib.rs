use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const PACKAGE_NAME: &str = "lanedeck-protocol";
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageKind {
    Raw,
    Metric,
    Event,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerKind {
    Count,
    Time,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageMode {
    Script,
    Passthrough,
    Empty,
    Builtin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRecord {
    pub id: String,
    pub observed_at: DateTime<Utc>,
    pub body: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub lane_id: String,
    pub stage: StageKind,
    pub frame_no: u64,
    pub opened_at: DateTime<Utc>,
    pub closed_at: DateTime<Utc>,
    pub trigger_kind: TriggerKind,
    pub record_count: u32,
    pub records: Vec<FrameRecord>,
    pub summary: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageConfig {
    pub mode: StageMode,
    pub settings: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneConfig {
    pub lane_id: String,
    pub display_name: String,
    pub raw_stage: StageConfig,
    pub metric_stage: StageConfig,
    pub event_stage: StageConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestBatch {
    pub workspace_id: String,
    pub machine_id: String,
    pub batch_id: String,
    pub frames: Vec<Frame>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolDiagnostic {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("protocol validation failed")]
    Validation {
        diagnostics: Vec<ProtocolDiagnostic>,
    },
}

pub fn parse_lane_config(bytes: &[u8]) -> Result<LaneConfig, ProtocolError> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| validation_error("$", format!("expected JSON lane config: {error}")))?;
    ProtocolParser::new().parse_lane_config(value)
}

pub fn parse_frame_json(value: serde_json::Value) -> Result<Frame, ProtocolError> {
    ProtocolParser::new().parse_frame(value)
}

pub fn parse_ingest_batch_json(value: serde_json::Value) -> Result<IngestBatch, ProtocolError> {
    ProtocolParser::new().parse_ingest_batch(value)
}

fn validation_error(path: impl Into<String>, message: impl Into<String>) -> ProtocolError {
    ProtocolError::Validation {
        diagnostics: vec![ProtocolDiagnostic {
            path: path.into(),
            message: message.into(),
        }],
    }
}

struct ProtocolParser {
    diagnostics: Vec<ProtocolDiagnostic>,
}

impl ProtocolParser {
    fn new() -> Self {
        Self {
            diagnostics: Vec::new(),
        }
    }

    fn parse_lane_config(mut self, value: serde_json::Value) -> Result<LaneConfig, ProtocolError> {
        let object = self.object(&value, "$");
        let config = LaneConfig {
            lane_id: self.string(object.get("laneId"), "laneId"),
            display_name: self.string(object.get("displayName"), "displayName"),
            raw_stage: self.stage_config(object.get("rawStage"), "rawStage"),
            metric_stage: self.stage_config(object.get("metricStage"), "metricStage"),
            event_stage: self.stage_config(object.get("eventStage"), "eventStage"),
        };

        self.finish(config)
    }

    fn parse_frame(mut self, value: serde_json::Value) -> Result<Frame, ProtocolError> {
        let frame = self.frame(&value, "$");
        self.finish(frame)
    }

    fn parse_ingest_batch(
        mut self,
        value: serde_json::Value,
    ) -> Result<IngestBatch, ProtocolError> {
        let object = self.object(&value, "$");
        let batch = IngestBatch {
            workspace_id: self.string(object.get("workspaceId"), "workspaceId"),
            machine_id: self.string(object.get("machineId"), "machineId"),
            batch_id: self.string(object.get("batchId"), "batchId"),
            frames: self.frames(object.get("frames"), "frames"),
        };

        self.finish(batch)
    }

    fn finish<T>(self, value: T) -> Result<T, ProtocolError> {
        if self.diagnostics.is_empty() {
            Ok(value)
        } else {
            Err(ProtocolError::Validation {
                diagnostics: self.diagnostics,
            })
        }
    }

    fn stage_config(&mut self, value: Option<&serde_json::Value>, path: &str) -> StageConfig {
        let object = match value {
            Some(value) => self.object(value, path),
            None => {
                self.add(path, "expected object");
                &EMPTY
            }
        };

        StageConfig {
            mode: self.stage_mode(object.get("mode"), &format!("{path}.mode")),
            settings: self.json_object(object.get("settings"), &format!("{path}.settings")),
        }
    }

    fn frames(&mut self, value: Option<&serde_json::Value>, path: &str) -> Vec<Frame> {
        match value {
            Some(serde_json::Value::Array(frames)) => frames
                .iter()
                .enumerate()
                .map(|(index, frame)| self.frame(frame, &format!("{path}.{index}")))
                .collect(),
            _ => {
                self.add(path, "expected array");
                Vec::new()
            }
        }
    }

    fn frame(&mut self, value: &serde_json::Value, path: &str) -> Frame {
        let object = self.object(value, path);
        let records_path = path_child(path, "records");
        let records = self.records(object.get("records"), &records_path);
        let record_count_path = path_child(path, "recordCount");
        let record_count = self.u32(object.get("recordCount"), &record_count_path);
        if record_count as usize != records.len() {
            self.add(record_count_path.clone(), "expected records length");
        }
        Frame {
            lane_id: self.string(object.get("laneId"), &path_child(path, "laneId")),
            stage: self.stage_kind(object.get("stage"), &path_child(path, "stage")),
            frame_no: self.u64(object.get("frameNo"), &path_child(path, "frameNo")),
            opened_at: self.timestamp(object.get("openedAt"), &path_child(path, "openedAt")),
            closed_at: self.timestamp(object.get("closedAt"), &path_child(path, "closedAt")),
            trigger_kind: self
                .trigger_kind(object.get("triggerKind"), &path_child(path, "triggerKind")),
            record_count,
            records,
            summary: self.json_object(object.get("summary"), &path_child(path, "summary")),
        }
    }

    fn records(&mut self, value: Option<&serde_json::Value>, path: &str) -> Vec<FrameRecord> {
        match value {
            Some(serde_json::Value::Array(records)) => records
                .iter()
                .enumerate()
                .map(|(index, record)| self.record(record, &format!("{path}.{index}")))
                .collect(),
            _ => {
                self.add(path, "expected array");
                Vec::new()
            }
        }
    }

    fn record(&mut self, value: &serde_json::Value, path: &str) -> FrameRecord {
        let object = self.object(value, path);
        FrameRecord {
            id: self.string(object.get("id"), &format!("{path}.id")),
            observed_at: self.timestamp(object.get("observedAt"), &format!("{path}.observedAt")),
            body: object.get("body").cloned().unwrap_or_else(|| {
                self.add(format!("{path}.body"), "expected JSON value");
                serde_json::Value::Null
            }),
        }
    }

    fn object<'a>(
        &mut self,
        value: &'a serde_json::Value,
        path: &str,
    ) -> &'a serde_json::Map<String, serde_json::Value> {
        match value {
            serde_json::Value::Object(object) => object,
            _ => {
                self.add(path, "expected object");
                &EMPTY
            }
        }
    }

    fn json_object(&mut self, value: Option<&serde_json::Value>, path: &str) -> serde_json::Value {
        match value {
            Some(serde_json::Value::Object(_)) => value.cloned().unwrap(),
            _ => {
                self.add(path, "expected object");
                serde_json::Value::Object(serde_json::Map::new())
            }
        }
    }

    fn string(&mut self, value: Option<&serde_json::Value>, path: &str) -> String {
        match value {
            Some(serde_json::Value::String(value)) => value.clone(),
            _ => {
                self.add(path, "expected string");
                String::new()
            }
        }
    }

    fn u64(&mut self, value: Option<&serde_json::Value>, path: &str) -> u64 {
        match value.and_then(serde_json::Value::as_u64) {
            Some(value) if value <= JS_MAX_SAFE_INTEGER => value,
            None => {
                self.add(path, "expected unsigned integer");
                0
            }
            Some(_) => {
                self.add(path, "expected JavaScript safe unsigned integer");
                0
            }
        }
    }

    fn u32(&mut self, value: Option<&serde_json::Value>, path: &str) -> u32 {
        match value.and_then(serde_json::Value::as_u64) {
            Some(value) if value <= u32::MAX as u64 => value as u32,
            _ => {
                self.add(path, "expected unsigned 32-bit integer");
                0
            }
        }
    }

    fn timestamp(&mut self, value: Option<&serde_json::Value>, path: &str) -> DateTime<Utc> {
        let value = self.string(value, path);
        if !is_strict_rfc3339_date_time(&value) {
            self.add(path, "expected RFC 3339 timestamp");
            return DateTime::<Utc>::UNIX_EPOCH;
        }
        match DateTime::parse_from_rfc3339(&value) {
            Ok(value) => value.with_timezone(&Utc),
            Err(_) => {
                self.add(path, "expected RFC 3339 timestamp");
                DateTime::<Utc>::UNIX_EPOCH
            }
        }
    }

    fn stage_kind(&mut self, value: Option<&serde_json::Value>, path: &str) -> StageKind {
        match value.and_then(serde_json::Value::as_str) {
            Some("raw") => StageKind::Raw,
            Some("metric") => StageKind::Metric,
            Some("event") => StageKind::Event,
            _ => {
                self.add(path, "expected raw, metric, or event");
                StageKind::Raw
            }
        }
    }

    fn stage_mode(&mut self, value: Option<&serde_json::Value>, path: &str) -> StageMode {
        match value.and_then(serde_json::Value::as_str) {
            Some("script") => StageMode::Script,
            Some("passthrough") => StageMode::Passthrough,
            Some("empty") => StageMode::Empty,
            Some("builtin") => StageMode::Builtin,
            _ => {
                self.add(path, "expected script, passthrough, empty, or builtin");
                StageMode::Empty
            }
        }
    }

    fn trigger_kind(&mut self, value: Option<&serde_json::Value>, path: &str) -> TriggerKind {
        match value.and_then(serde_json::Value::as_str) {
            Some("count") => TriggerKind::Count,
            Some("time") => TriggerKind::Time,
            _ => {
                self.add(path, "expected count or time");
                TriggerKind::Count
            }
        }
    }

    fn add(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.diagnostics.push(ProtocolDiagnostic {
            path: path.into(),
            message: message.into(),
        });
    }
}

static EMPTY: std::sync::LazyLock<serde_json::Map<String, serde_json::Value>> =
    std::sync::LazyLock::new(serde_json::Map::new);

fn path_child(parent: &str, child: &str) -> String {
    if parent == "$" {
        child.to_string()
    } else {
        format!("{parent}.{child}")
    }
}

fn is_strict_rfc3339_date_time(value: &str) -> bool {
    if !value.is_ascii() {
        return false;
    }
    let Some((date, rest)) = value.split_once('T') else {
        return false;
    };
    let Some((time, offset)) = split_time_and_offset(rest) else {
        return false;
    };
    let Some((year, month, day)) = parse_date(date) else {
        return false;
    };
    let Some((hour, minute, second)) = parse_time(time) else {
        return false;
    };

    if !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return false;
    }

    if day == 0 || day > days_in_month(year, month) {
        return false;
    }

    match offset {
        "Z" => true,
        _ => parse_offset(offset).is_some(),
    }
}

fn split_time_and_offset(value: &str) -> Option<(&str, &str)> {
    if let Some(time) = value.strip_suffix('Z') {
        return Some((time, "Z"));
    }
    let plus = value.rfind('+');
    let minus = value.rfind('-');
    let index = plus.or(minus)?;
    Some((&value[..index], &value[index..]))
}

fn parse_date(value: &str) -> Option<(i32, u32, u32)> {
    if value.len() != 10 || &value[4..5] != "-" || &value[7..8] != "-" {
        return None;
    }
    Some((
        value[0..4].parse().ok()?,
        value[5..7].parse().ok()?,
        value[8..10].parse().ok()?,
    ))
}

fn parse_time(value: &str) -> Option<(u32, u32, u32)> {
    if value.len() < 8 || &value[2..3] != ":" || &value[5..6] != ":" {
        return None;
    }
    let second_end = if value.len() == 8 {
        8
    } else {
        if &value[8..9] != "."
            || value[9..].is_empty()
            || !value[9..].bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        8
    };
    Some((
        value[0..2].parse().ok()?,
        value[3..5].parse().ok()?,
        value[6..second_end].parse().ok()?,
    ))
}

fn parse_offset(value: &str) -> Option<(u32, u32)> {
    if value.len() != 6 || (&value[0..1] != "+" && &value[0..1] != "-") || &value[3..4] != ":" {
        return None;
    }
    let hour: u32 = value[1..3].parse().ok()?;
    let minute: u32 = value[4..6].parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some((hour, minute))
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}
