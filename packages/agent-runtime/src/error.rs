use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AgentError {
    #[error("agent config failed: {0}")]
    Config(String),
    #[error("center communication failed: {0}")]
    Network(String),
    #[error("spool failed: {0}")]
    Spool(String),
    #[error("script failed: {0}")]
    Script(String),
    #[error("lane engine failed: {0}")]
    LaneEngine(String),
}

impl AgentError {
    pub fn config(message: impl Into<String>) -> Self {
        Self::Config(message.into())
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::Network(message.into())
    }

    pub fn spool(message: impl Into<String>) -> Self {
        Self::Spool(message.into())
    }

    pub fn script(message: impl Into<String>) -> Self {
        Self::Script(message.into())
    }

    pub fn lane_engine(message: impl Into<String>) -> Self {
        Self::LaneEngine(message.into())
    }
}
