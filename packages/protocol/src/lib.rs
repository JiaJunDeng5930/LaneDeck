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
    Err(unimplemented_protocol_parser())
}

pub fn parse_frame_json(_value: serde_json::Value) -> Result<Frame, ProtocolError> {
    Err(unimplemented_protocol_parser())
}

pub fn parse_ingest_batch_json(
    _value: serde_json::Value,
) -> Result<serde_json::Value, ProtocolError> {
    Err(unimplemented_protocol_parser())
}

fn unimplemented_protocol_parser() -> ProtocolError {
    ProtocolError::Validation {
        diagnostics: vec![ProtocolDiagnostic {
            path: "$".to_string(),
            message: "protocol parser is not implemented".to_string(),
        }],
    }
}
