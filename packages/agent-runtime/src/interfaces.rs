use async_trait::async_trait;
use lanedeck_protocol::{IngestAck, IngestBatch};

use crate::{
    AgentError, ControlConnectRequest, ControlSession, RetryReason, ScriptRunOutput,
    ScriptRunRequest, SpoolEntry, SpoolEntryId,
};

#[async_trait]
pub trait CenterClient {
    async fn post_ingest_batch(&self, batch: IngestBatch) -> Result<IngestAck, AgentError>;

    async fn connect_control(
        &self,
        request: ControlConnectRequest,
    ) -> Result<ControlSession, AgentError>;
}

pub trait LocalSpool {
    fn enqueue(&mut self, batch: IngestBatch) -> Result<SpoolEntryId, AgentError>;

    fn pending_batch(&mut self, limit: usize) -> Result<Vec<SpoolEntry>, AgentError>;

    fn mark_acked(&mut self, ids: &[SpoolEntryId]) -> Result<(), AgentError>;

    fn mark_retry(&mut self, ids: &[SpoolEntryId], reason: RetryReason) -> Result<(), AgentError>;
}

pub trait ScriptRunner {
    fn run_script(&self, request: ScriptRunRequest) -> Result<ScriptRunOutput, AgentError>;
}
