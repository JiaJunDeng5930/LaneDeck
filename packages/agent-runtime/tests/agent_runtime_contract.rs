mod contract_helpers;

use lanedeck_agent_runtime::{
    AgentService, ControlMessage, ControlReply, ScriptPurpose, ScriptSideEffectPolicy, SpoolEntryId,
};

use contract_helpers::{
    CenterProbe, ScriptRunnerProbe, SpoolProbe, content_root, duration, ingest_batch, instant,
    pending_spool_entry, reloaded_script_lane_config, script_lane_agent_config,
    successful_script_output,
};

#[tokio::test]
async fn produced_lane_batch_is_enqueued_before_upload() {
    let now = instant(1_700_010_000);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![successful_script_output(now)]);
    let mut service = AgentService::new(
        script_lane_agent_config(),
        center.clone(),
        spool.clone(),
        runner,
    )
    .unwrap();

    let report = service.run_once(now).await.unwrap();

    assert_eq!(report.lane_execution_count, 1);
    assert_eq!(report.enqueued_batch_count, 1);
    assert_eq!(spool.enqueued_batches().len(), 1);
    assert!(center.posted_batches().is_empty());
}

#[tokio::test]
async fn acked_upload_removes_spool_entries() {
    let now = instant(1_700_011_000);
    let batch = ingest_batch("batch-1", now);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::with_pending(vec![pending_spool_entry("spool-1", batch.clone())]);
    let runner = ScriptRunnerProbe::with_outputs(Vec::new());
    let mut service = AgentService::new(
        script_lane_agent_config(),
        center.clone(),
        spool.clone(),
        runner,
    )
    .unwrap();

    let report = service.flush_spool().await.unwrap();

    assert_eq!(center.posted_batches(), vec![batch]);
    assert_eq!(spool.acked_ids(), vec![SpoolEntryId::from("spool-1")]);
    assert!(spool.pending_entries().is_empty());
    assert_eq!(report.uploaded_batch_count, 1);
    assert_eq!(report.acked_entry_count, 1);
}

#[tokio::test]
async fn network_failure_marks_entries_retry_pending() {
    let now = instant(1_700_012_000);
    let batch = ingest_batch("batch-2", now);
    let center = CenterProbe::failing_network();
    let spool = SpoolProbe::with_pending(vec![pending_spool_entry("spool-2", batch)]);
    let runner = ScriptRunnerProbe::with_outputs(Vec::new());
    let mut service =
        AgentService::new(script_lane_agent_config(), center, spool.clone(), runner).unwrap();

    let report = service.flush_spool().await.unwrap();

    assert_eq!(spool.retry_ids(), vec![SpoolEntryId::from("spool-2")]);
    assert_eq!(spool.pending_entries().len(), 1);
    assert_eq!(report.retry_entry_count, 1);
}

#[tokio::test]
async fn reload_lane_config_control_message_refreshes_lane_config() {
    let now = instant(1_700_013_000);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![
        successful_script_output(now),
        successful_script_output(now),
    ]);
    let mut service =
        AgentService::new(script_lane_agent_config(), center, spool, runner.clone()).unwrap();

    let reply = service
        .handle_control_message(ControlMessage::reload_lane_config(
            reloaded_script_lane_config(),
        ))
        .await
        .unwrap();
    service.run_once(now).await.unwrap();

    assert_eq!(reply, ControlReply::accepted("reload_lane_config"));
    let request = runner.requests().remove(0);
    assert_eq!(request.lane_id, "lane.cpu");
    assert_eq!(request.cwd, "/var/lib/lanedeck/sources/cpu-reloaded");
    assert_eq!(request.timeout, duration(9));
}

#[tokio::test]
async fn build_content_control_message_calls_content_build_handler() {
    let now = instant(1_700_014_000);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![successful_script_output(now)]);
    let mut service =
        AgentService::new(script_lane_agent_config(), center, spool, runner.clone()).unwrap();

    let reply = service
        .handle_control_message(ControlMessage::build_content(
            "dashboard-main",
            content_root(),
            "corepack pnpm --filter @lanedeck/content build",
        ))
        .await
        .unwrap();

    assert_eq!(reply, ControlReply::accepted("build_content"));
    let request = runner.requests().remove(0);
    assert_eq!(request.purpose, ScriptPurpose::BuildContent);
    assert_eq!(request.cwd, content_root());
    assert_eq!(
        request.command,
        "corepack pnpm --filter @lanedeck/content build"
    );
}

#[tokio::test]
async fn script_runner_receives_fixed_cwd_timeout_capture_and_side_effect_policy() {
    let now = instant(1_700_015_000);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![successful_script_output(now)]);
    let mut service =
        AgentService::new(script_lane_agent_config(), center, spool, runner.clone()).unwrap();

    service.run_once(now).await.unwrap();

    let request = runner.requests().remove(0);
    assert_eq!(request.purpose, ScriptPurpose::CollectSource);
    assert_eq!(request.lane_id, "lane.cpu");
    assert_eq!(request.command, "collect-cpu");
    assert_eq!(request.cwd, "/var/lib/lanedeck/sources/cpu");
    assert_eq!(request.timeout, duration(5));
    assert!(request.capture_stdout);
    assert!(request.capture_stderr);
    assert_eq!(
        request.side_effect_policy,
        ScriptSideEffectPolicy::LaneSourceReadBoundary
    );
}
