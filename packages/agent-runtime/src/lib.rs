mod config;
mod error;
mod interfaces;
mod service;
mod types;

pub use config::{
    AgentConfig, ControlConfig, FlushConfig, LaneRuntimeConfig, LaneSchedule, SpoolConfig,
};
pub use error::AgentError;
pub use interfaces::{CenterClient, LocalSpool, ScriptRunner};
pub use service::AgentService;
pub use types::{
    AgentRunReport, BuildContentControl, ControlConnectRequest, ControlMessage, ControlMessageId,
    ControlMessageRecord, ControlReply, ControlSession, FlushReport, RetryReason, ScriptPurpose,
    ScriptRunOutput, ScriptRunRequest, ScriptSideEffectPolicy, SpoolEntry, SpoolEntryId,
    SpoolEntryState, WorkingDirectory,
};

pub const PACKAGE_NAME: &str = "lanedeck-agent-runtime";
