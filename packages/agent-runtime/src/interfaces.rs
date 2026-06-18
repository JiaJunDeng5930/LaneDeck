use async_trait::async_trait;
use lanedeck_protocol::{Diagnostic, IngestAck, IngestBatch};

use crate::{
    AgentError, ControlConnectRequest, ControlMessageId, ControlMessageRecord, ControlSession,
    RetryReason, ScriptRunOutput, ScriptRunRequest, SpoolEntry, SpoolEntryId,
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
    fn load_lane_frame_cursor(&mut self, lane_id: &str) -> Result<u64, AgentError>;

    fn allocate_runtime_seed(
        &mut self,
        workspace_id: &str,
        machine_id: &str,
    ) -> Result<String, AgentError>;

    fn load_control_message(
        &mut self,
        message_id: &ControlMessageId,
    ) -> Result<Option<ControlMessageRecord>, AgentError>;

    fn mark_control_message_in_progress(
        &mut self,
        message_id: ControlMessageId,
    ) -> Result<(), AgentError>;

    fn mark_control_message_completed(
        &mut self,
        message_id: ControlMessageId,
        result: Result<crate::ControlReply, AgentError>,
    ) -> Result<(), AgentError>;

    fn enqueue(&mut self, batch: IngestBatch) -> Result<SpoolEntryId, AgentError>;

    fn pending_batch(&mut self, limit: usize) -> Result<Vec<SpoolEntry>, AgentError>;

    fn mark_acked(&mut self, ids: &[SpoolEntryId]) -> Result<(), AgentError>;

    fn mark_retry(&mut self, ids: &[SpoolEntryId], reason: RetryReason) -> Result<(), AgentError>;

    fn mark_rejected(
        &mut self,
        ids: &[SpoolEntryId],
        diagnostics: Vec<Diagnostic>,
    ) -> Result<(), AgentError>;
}

pub trait ScriptRunner {
    fn run_script(&self, request: ScriptRunRequest) -> Result<ScriptRunOutput, AgentError>;
}
