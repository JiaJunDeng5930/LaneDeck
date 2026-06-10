use lanedeck_protocol::LaneConfig;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub workspace_id: String,
    pub machine_id: String,
    pub spool: SpoolConfig,
    pub flush: FlushConfig,
    pub control: ControlConfig,
    pub lanes: Vec<LaneRuntimeConfig>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolConfig {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushConfig {
    pub max_batch_size: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlConfig {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneRuntimeConfig {
    pub lane_id: String,
    pub schedule: LaneSchedule,
    pub config: LaneConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneSchedule {
    pub interval_seconds: u64,
}
