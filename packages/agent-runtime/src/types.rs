use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use lanedeck_protocol::{Diagnostic, FrameRecord, IngestBatch, LaneConfig};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SpoolEntryId(String);

impl From<&str> for SpoolEntryId {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl From<String> for SpoolEntryId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl SpoolEntryId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolEntry {
    pub id: SpoolEntryId,
    pub batch: IngestBatch,
    pub state: SpoolEntryState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpoolEntryState {
    Pending,
    RetryPending,
    Acked,
    Rejected,
}

impl SpoolEntry {
    pub fn pending(id: SpoolEntryId, batch: IngestBatch) -> Self {
        Self {
            id,
            batch,
            state: SpoolEntryState::Pending,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryReason {
    pub message: String,
}

impl RetryReason {
    pub fn network(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn from_error(error: crate::AgentError) -> Self {
        Self::network(error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScriptPurpose {
    CollectSource,
    BuildContent,
    ApplyLocalChange,
    TransformStage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScriptSideEffectPolicy {
    LaneSourceReadBoundary,
    ContentBuildBoundary,
    LocalContentWriteBoundary,
    StageTransformBoundary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WorkingDirectory(PathBuf);

impl From<PathBuf> for WorkingDirectory {
    fn from(value: PathBuf) -> Self {
        Self(value)
    }
}

impl From<String> for WorkingDirectory {
    fn from(value: String) -> Self {
        Self(PathBuf::from(value))
    }
}

impl From<&str> for WorkingDirectory {
    fn from(value: &str) -> Self {
        Self(PathBuf::from(value))
    }
}

impl PartialEq<&str> for WorkingDirectory {
    fn eq(&self, other: &&str) -> bool {
        self.0 == Path::new(other)
    }
}

impl PartialEq<PathBuf> for WorkingDirectory {
    fn eq(&self, other: &PathBuf) -> bool {
        self.0 == *other
    }
}

impl WorkingDirectory {
    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRunRequest {
    pub purpose: ScriptPurpose,
    pub lane_id: String,
    pub command: String,
    pub cwd: WorkingDirectory,
    #[serde(default)]
    pub input: Option<Value>,
    #[serde(rename = "timeoutSeconds", with = "duration_seconds")]
    pub timeout: Duration,
    pub capture_stdout: bool,
    pub capture_stderr: bool,
    pub side_effect_policy: ScriptSideEffectPolicy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRunOutput {
    #[serde(default)]
    pub records: Vec<FrameRecord>,
    #[serde(default)]
    pub diagnostics: Vec<Diagnostic>,
}

impl ScriptRunOutput {
    pub fn from_json_records(records: Vec<FrameRecord>) -> Self {
        Self {
            records,
            diagnostics: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunReport {
    pub lane_execution_count: usize,
    pub produced_frame_count: usize,
    pub enqueued_batch_count: usize,
    #[serde(default)]
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushReport {
    pub uploaded_batch_count: usize,
    pub acked_entry_count: usize,
    pub retry_entry_count: usize,
    pub rejected_entry_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ControlMessage {
    ReloadLaneConfig {
        config: LaneConfig,
    },
    BuildContent {
        content_id: String,
        cwd: PathBuf,
        command: String,
    },
    ApplyLocalChange {
        path: PathBuf,
        body: Value,
    },
    Heartbeat,
    Unknown {
        message_type: String,
    },
}

impl<'de> Deserialize<'de> for ControlMessage {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let mut value = Value::deserialize(deserializer)?;
        let object = value
            .as_object_mut()
            .ok_or_else(|| de::Error::custom("control message must be an object"))?;
        let message_type = object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();

        match message_type.as_str() {
            "reload_lane_config" => Ok(Self::ReloadLaneConfig {
                config: take_control_field(object, "config")?,
            }),
            "build_content" => Ok(Self::BuildContent {
                content_id: take_control_field(object, "contentId")?,
                cwd: take_control_field(object, "cwd")?,
                command: take_control_field(object, "command")?,
            }),
            "apply_local_change" => Ok(Self::ApplyLocalChange {
                path: take_control_field(object, "path")?,
                body: object.remove("body").unwrap_or(Value::Null),
            }),
            "heartbeat" => Ok(Self::Heartbeat),
            other => Ok(Self::Unknown {
                message_type: other.to_string(),
            }),
        }
    }
}

fn take_control_field<T, E>(
    object: &mut serde_json::Map<String, Value>,
    key: &'static str,
) -> Result<T, E>
where
    T: serde::de::DeserializeOwned,
    E: de::Error,
{
    let value = object
        .remove(key)
        .ok_or_else(|| E::custom(format!("missing control message field {key}")))?;
    serde_json::from_value(value).map_err(E::custom)
}

impl ControlMessage {
    pub fn reload_lane_config(config: LaneConfig) -> Self {
        Self::ReloadLaneConfig { config }
    }

    pub fn build_content(
        content_id: impl Into<String>,
        cwd: PathBuf,
        command: impl Into<String>,
    ) -> Self {
        Self::BuildContent {
            content_id: content_id.into(),
            cwd,
            command: command.into(),
        }
    }

    pub fn apply_local_change(path: PathBuf, body: Value) -> Self {
        Self::ApplyLocalChange { path, body }
    }

    pub fn heartbeat() -> Self {
        Self::Heartbeat
    }

    pub fn unknown(message_type: impl Into<String>) -> Self {
        Self::Unknown {
            message_type: message_type.into(),
        }
    }

    pub fn message_type(&self) -> &str {
        match self {
            Self::ReloadLaneConfig { .. } => "reload_lane_config",
            Self::BuildContent { .. } => "build_content",
            Self::ApplyLocalChange { .. } => "apply_local_change",
            Self::Heartbeat => "heartbeat",
            Self::Unknown { message_type, .. } => message_type,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlReply {
    pub accepted: bool,
    pub message_type: String,
}

impl ControlReply {
    pub fn accepted(message_type: impl Into<String>) -> Self {
        Self {
            accepted: true,
            message_type: message_type.into(),
        }
    }

    pub fn unknown(message_type: impl Into<String>) -> Self {
        Self {
            accepted: false,
            message_type: message_type.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlConnectRequest {
    pub workspace_id: String,
    pub machine_id: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlSession {
    pub connected_at: DateTime<Utc>,
}

pub mod duration_seconds {
    use super::*;

    pub fn serialize<S>(duration: &Duration, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_i64(duration.num_seconds())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Duration, D::Error>
    where
        D: Deserializer<'de>,
    {
        let seconds = i64::deserialize(deserializer)?;
        Ok(Duration::seconds(seconds))
    }
}
