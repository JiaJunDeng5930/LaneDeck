use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const PACKAGE_NAME: &str = "lanedeck-protocol";

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

pub fn parse_lane_config(_bytes: &[u8]) -> Result<serde_json::Value, ProtocolError> {
    let value: serde_json::Value = serde_json::from_slice(_bytes)
        .map_err(|error| validation_error("$", format!("expected JSON lane config: {error}")))?;
    Ok(value)
}

pub fn parse_frame_json(value: serde_json::Value) -> Result<Frame, ProtocolError> {
    FrameParser::new().parse_frame(value)
}

pub fn parse_ingest_batch_json(
    value: serde_json::Value,
) -> Result<serde_json::Value, ProtocolError> {
    Ok(value)
}

fn validation_error(path: impl Into<String>, message: impl Into<String>) -> ProtocolError {
    ProtocolError::Validation {
        diagnostics: vec![ProtocolDiagnostic {
            path: path.into(),
            message: message.into(),
        }],
    }
}

struct FrameParser {
    diagnostics: Vec<ProtocolDiagnostic>,
}

impl FrameParser {
    fn new() -> Self {
        Self {
            diagnostics: Vec::new(),
        }
    }

    fn parse_frame(mut self, value: serde_json::Value) -> Result<Frame, ProtocolError> {
        let object = self.object(&value, "$");
        let records = self.records(object.get("records"), "records");
        let frame = Frame {
            lane_id: self.string(object.get("laneId"), "laneId"),
            stage: self.stage_kind(object.get("stage"), "stage"),
            frame_no: self.u64(object.get("frameNo"), "frameNo"),
            opened_at: self.timestamp(object.get("openedAt"), "openedAt"),
            closed_at: self.timestamp(object.get("closedAt"), "closedAt"),
            trigger_kind: self.trigger_kind(object.get("triggerKind"), "triggerKind"),
            record_count: self.u32(object.get("recordCount"), "recordCount"),
            records,
            summary: self.json_object(object.get("summary"), "summary"),
        };

        if self.diagnostics.is_empty() {
            Ok(frame)
        } else {
            Err(ProtocolError::Validation {
                diagnostics: self.diagnostics,
            })
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
                static EMPTY: std::sync::LazyLock<serde_json::Map<String, serde_json::Value>> =
                    std::sync::LazyLock::new(serde_json::Map::new);
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
            Some(value) => value,
            None => {
                self.add(path, "expected unsigned integer");
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
