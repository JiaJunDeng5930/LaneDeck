mod config;
mod error;
mod interfaces;
mod service;
mod types;

pub use config::{AgentConfig, ControlConfig, FlushConfig, LaneRuntimeConfig, SpoolConfig};
pub use error::AgentError;
pub use interfaces::{CenterClient, LocalSpool, ScriptRunner};
pub use service::AgentService;
pub use types::{
    AgentRunReport, ControlConnectRequest, ControlMessage, ControlReply, ControlSession,
    FlushReport, RetryReason, ScriptPurpose, ScriptRunOutput, ScriptRunRequest,
    ScriptSideEffectPolicy, SpoolEntry, SpoolEntryId, WorkingDirectory,
};

pub const PACKAGE_NAME: &str = "lanedeck-agent-runtime";
