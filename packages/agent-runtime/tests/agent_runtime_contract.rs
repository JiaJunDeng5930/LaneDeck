mod contract_helpers;

use std::path::PathBuf;

use lanedeck_agent_runtime::{
    AgentConfig, AgentError, AgentService, ControlMessage, ControlMessageRecord, ControlReply,
    ScriptPurpose, ScriptRunOutput, ScriptSideEffectPolicy, SpoolEntryId,
};
use lanedeck_protocol::{LaneConfig, StageMode};
use serde_json::json;

use contract_helpers::{
    CenterProbe, ScriptRunnerProbe, SpoolProbe, agent_config_with_lane_config, content_root,
    diagnostic_script_output, downstream_builtin_stage_cases,
    downstream_script_stage_missing_setting_cases, duplicate_nested_lane_identity_agent_config,
    duration, empty_metric_agent_config, ingest_batch, instant,
    mismatched_lane_identity_agent_config, pending_spool_entry, reloaded_script_lane_config,
    reloaded_scripted_metric_lane_config, script_lane_agent_config,
    script_lane_agent_config_with_interval, script_output_with_record, script_output_with_records,
    script_stage_non_bool_capture_setting_cases, scripted_metric_agent_config,
    scripted_metric_agent_config_with_upstream_history_limit, successful_script_output,
    two_frame_ingest_batch, two_lane_agent_config, two_record_frame_agent_config,
    unknown_script_lane_config,
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
async fn connect_control_uses_configured_control_url() {
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(Vec::new());
    let service =
        AgentService::new(script_lane_agent_config(), center.clone(), spool, runner).unwrap();

    let session = service.connect_control().await.unwrap();
    let requests = center.control_connect_requests();

    assert_eq!(session.connected_at, instant(1_700_000_000));
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].workspace_id, "workspace.local");
    assert_eq!(requests[0].machine_id, "machine.local");
    assert_eq!(requests[0].url, "wss://center.local/agent/control");
}

#[tokio::test]
async fn spool_enqueue_failure_retains_closed_frames_for_next_run() {
    let first = instant(1_700_010_500);
    let second = instant(1_700_010_501);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::fail_next_enqueue();
    let runner =
        ScriptRunnerProbe::with_outputs(vec![script_output_with_record("raw:first", first)]);
    let mut service = AgentService::new(
        script_lane_agent_config_with_interval(1),
        center,
        spool.clone(),
        runner,
    )
    .unwrap();

    let first_error = service.run_once(first).await.unwrap_err();

    match first_error {
        AgentError::Spool(message) => assert!(message.contains("enqueue failed")),
        other => panic!("unexpected error: {other:?}"),
    }
    assert!(spool.enqueued_batches().is_empty());

    let second_report = service.run_once(second).await.unwrap();
    let enqueued = spool.enqueued_batches();

    assert_eq!(second_report.enqueued_batch_count, 1);
    assert_eq!(enqueued.len(), 1);
    let raw_frame = enqueued[0]
        .frames
        .iter()
        .find(|frame| frame.stage == lanedeck_protocol::StageKind::Raw)
        .unwrap();
    assert_eq!(raw_frame.records[0].id, "raw:first");
}

#[tokio::test]
async fn batch_ids_include_restart_safe_runtime_prefix() {
    let now = instant(1_700_010_800);
    let spool = SpoolProbe::default();
    let first_runner =
        ScriptRunnerProbe::with_outputs(vec![script_output_with_record("raw:first", now)]);
    let second_runner =
        ScriptRunnerProbe::with_outputs(vec![script_output_with_record("raw:second", now)]);
    let mut first_service = AgentService::new(
        script_lane_agent_config(),
        CenterProbe::accepting(),
        spool.clone(),
        first_runner,
    )
    .unwrap();
    let mut second_service = AgentService::new(
        script_lane_agent_config(),
        CenterProbe::accepting(),
        spool.clone(),
        second_runner,
    )
    .unwrap();

    first_service.run_once(now).await.unwrap();
    second_service.run_once(now).await.unwrap();

    let batches = spool.enqueued_batches();
    let first_batch_id = batches[0].batch_id.clone();
    let second_batch_id = batches[1].batch_id.clone();
    let first_prefix = restart_prefix(&first_batch_id);
    let second_prefix = restart_prefix(&second_batch_id);

    assert_ne!(first_batch_id, "batch-1");
    assert_ne!(second_batch_id, "batch-1");
    assert_ne!(first_prefix, second_prefix);
}

#[tokio::test]
async fn frame_numbers_resume_from_spool_cursor_across_service_restart() {
    let first = instant(1_700_010_810);
    let second = instant(1_700_010_820);
    let spool = SpoolProbe::default();
    let first_runner =
        ScriptRunnerProbe::with_outputs(vec![script_output_with_record("raw:first", first)]);
    let mut first_service = AgentService::new(
        script_lane_agent_config(),
        CenterProbe::accepting(),
        spool.clone(),
        first_runner,
    )
    .unwrap();

    first_service.run_once(first).await.unwrap();
    drop(first_service);

    let second_runner =
        ScriptRunnerProbe::with_outputs(vec![script_output_with_record("raw:second", second)]);
    let mut second_service = AgentService::new(
        script_lane_agent_config(),
        CenterProbe::accepting(),
        spool.clone(),
        second_runner,
    )
    .unwrap();

    second_service.run_once(second).await.unwrap();

    let batches = spool.enqueued_batches();
    assert_eq!(batches[0].frames[0].frame_no, 1);
    assert_eq!(batches[1].frames[0].frame_no, 2);
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
async fn ack_batch_id_mismatch_marks_entry_retry_pending() {
    let now = instant(1_700_011_500);
    let batch = ingest_batch("batch-original", now);
    let center = CenterProbe::acknowledging_batch_id("batch-other");
    let spool = SpoolProbe::with_pending(vec![pending_spool_entry("spool-4", batch.clone())]);
    let runner = ScriptRunnerProbe::with_outputs(Vec::new());
    let mut service = AgentService::new(
        script_lane_agent_config(),
        center.clone(),
        spool.clone(),
        runner,
    )
    .unwrap();

    let report = service.flush_spool().await.unwrap();
    let pending_entries = spool.pending_entries();

    assert_eq!(center.posted_batches(), vec![batch]);
    assert!(spool.acked_ids().is_empty());
    assert_eq!(spool.retry_ids(), vec![SpoolEntryId::from("spool-4")]);
    assert!(spool.rejected_ids().is_empty());
    assert_eq!(pending_entries.len(), 1);
    assert_eq!(pending_entries[0].id, SpoolEntryId::from("spool-4"));
    assert_eq!(pending_entries[0].batch.batch_id, "batch-original");
    assert_eq!(report.retry_entry_count, 1);
    assert_eq!(report.diagnostics[0].path, "ingestAck");
    assert!(report.diagnostics[0].message.contains("batch-other"));
    assert!(report.diagnostics[0].message.contains("batch-original"));
}

#[tokio::test]
async fn accepted_ack_with_diagnostics_marks_entry_acked_and_reports_diagnostics() {
    let now = instant(1_700_011_600);
    let batch = ingest_batch("batch-diagnostic", now);
    let center = CenterProbe::accepting_with_diagnostics();
    let spool = SpoolProbe::with_pending(vec![pending_spool_entry("spool-5", batch.clone())]);
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
    assert_eq!(spool.acked_ids(), vec![SpoolEntryId::from("spool-5")]);
    assert!(spool.retry_ids().is_empty());
    assert!(spool.rejected_ids().is_empty());
    assert!(spool.pending_entries().is_empty());
    assert_eq!(report.uploaded_batch_count, 1);
    assert_eq!(report.acked_entry_count, 1);
    assert_eq!(report.diagnostics[0].path, "broadcast");
}

#[tokio::test]
async fn ack_accepted_count_above_batch_size_marks_entry_retry_pending() {
    let now = instant(1_700_011_700);
    let batch = ingest_batch("batch-overcount", now);
    let center = CenterProbe::acknowledging_frame_count(2);
    let spool = SpoolProbe::with_pending(vec![pending_spool_entry("spool-6", batch.clone())]);
    let runner = ScriptRunnerProbe::with_outputs(Vec::new());
    let mut service = AgentService::new(
        script_lane_agent_config(),
        center.clone(),
        spool.clone(),
        runner,
    )
    .unwrap();

    let report = service.flush_spool().await.unwrap();
    let pending_entries = spool.pending_entries();

    assert_eq!(center.posted_batches(), vec![batch]);
    assert!(spool.acked_ids().is_empty());
    assert_eq!(spool.retry_ids(), vec![SpoolEntryId::from("spool-6")]);
    assert!(spool.rejected_ids().is_empty());
    assert_eq!(pending_entries.len(), 1);
    assert_eq!(pending_entries[0].batch.batch_id, "batch-overcount");
    assert_eq!(report.retry_entry_count, 1);
    assert_eq!(report.diagnostics[0].path, "ingestAck");
    assert!(report.diagnostics[0].message.contains("2/1"));
}

#[tokio::test]
async fn partial_accepted_ack_keeps_entry_retry_pending_and_reports_diagnostics() {
    let now = instant(1_700_011_800);
    let batch = two_frame_ingest_batch("batch-partial", now);
    let center = CenterProbe::acknowledging_frame_count(1);
    let spool = SpoolProbe::with_pending(vec![pending_spool_entry("spool-7", batch.clone())]);
    let runner = ScriptRunnerProbe::with_outputs(Vec::new());
    let mut service = AgentService::new(
        script_lane_agent_config(),
        center.clone(),
        spool.clone(),
        runner,
    )
    .unwrap();

    let report = service.flush_spool().await.unwrap();
    let pending_entries = spool.pending_entries();

    assert_eq!(center.posted_batches(), vec![batch]);
    assert!(spool.acked_ids().is_empty());
    assert_eq!(spool.retry_ids(), vec![SpoolEntryId::from("spool-7")]);
    assert!(spool.rejected_ids().is_empty());
    assert_eq!(pending_entries.len(), 1);
    assert_eq!(pending_entries[0].batch.batch_id, "batch-partial");
    assert_eq!(report.retry_entry_count, 1);
    assert_eq!(report.diagnostics[0].path, "ingestAck");
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
    assert_eq!(report.diagnostics[0].path, "ingestAck");
    assert!(report.diagnostics[0].message.contains("center unreachable"));
}

#[tokio::test]
async fn validation_ack_marks_entries_rejected_and_removed() {
    let now = instant(1_700_012_500);
    let batch = ingest_batch("batch-3", now);
    let center = CenterProbe::rejecting_validation();
    let spool = SpoolProbe::with_pending(vec![pending_spool_entry("spool-3", batch)]);
    let runner = ScriptRunnerProbe::with_outputs(Vec::new());
    let mut service =
        AgentService::new(script_lane_agent_config(), center, spool.clone(), runner).unwrap();

    let report = service.flush_spool().await.unwrap();

    assert!(spool.acked_ids().is_empty());
    assert!(spool.retry_ids().is_empty());
    assert_eq!(spool.rejected_ids(), vec![SpoolEntryId::from("spool-3")]);
    assert_eq!(spool.rejected_diagnostics()[0].path, "frames[0]");
    assert!(spool.pending_entries().is_empty());
    assert_eq!(report.uploaded_batch_count, 1);
    assert_eq!(report.rejected_entry_count, 1);
    assert_eq!(report.diagnostics[0].path, "frames[0]");
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
            "control-reload-refresh",
            reloaded_script_lane_config(),
        ))
        .await
        .unwrap();
    service.run_once(now).await.unwrap();

    assert_eq!(
        reply,
        ControlReply::accepted("control-reload-refresh", "reload_lane_config")
    );
    let request = runner.requests().remove(0);
    assert_eq!(request.lane_id, "lane.cpu");
    assert_eq!(request.cwd, "/var/lib/lanedeck/sources/cpu-reloaded");
    assert_eq!(request.timeout, duration(9));
}

#[tokio::test]
async fn reload_lane_config_preserves_existing_schedule_cadence() {
    let first = instant(1_700_013_500);
    let early = instant(1_700_013_560);
    let due = instant(1_700_013_620);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![
        successful_script_output(first),
        successful_script_output(due),
    ]);
    let mut service = AgentService::new(
        script_lane_agent_config_with_interval(120),
        center,
        spool,
        runner.clone(),
    )
    .unwrap();

    service.run_once(first).await.unwrap();
    service
        .handle_control_message(ControlMessage::reload_lane_config(
            "control-reload-cadence",
            reloaded_script_lane_config(),
        ))
        .await
        .unwrap();
    let early_report = service.run_once(early).await.unwrap();
    let due_report = service.run_once(due).await.unwrap();

    assert_eq!(early_report.lane_execution_count, 0);
    assert_eq!(due_report.lane_execution_count, 1);
    assert_eq!(runner.requests().len(), 2);
    assert_eq!(
        runner.requests()[1].cwd,
        "/var/lib/lanedeck/sources/cpu-reloaded"
    );
}

#[tokio::test]
async fn reload_lane_config_preserves_frame_sequence() {
    let first = instant(1_700_013_650);
    let second = instant(1_700_013_651);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![
        script_output_with_record("raw:first", first),
        script_output_with_record("raw:second", second),
    ]);
    let mut service = AgentService::new(
        script_lane_agent_config_with_interval(1),
        center,
        spool.clone(),
        runner,
    )
    .unwrap();

    service.run_once(first).await.unwrap();
    service
        .handle_control_message(ControlMessage::reload_lane_config(
            "control-reload-sequence",
            reloaded_script_lane_config(),
        ))
        .await
        .unwrap();
    service.run_once(second).await.unwrap();

    let batches = spool.enqueued_batches();
    assert_eq!(batches[0].frames[0].frame_no, 1);
    assert_eq!(batches[1].frames[0].frame_no, 2);
}

#[tokio::test]
async fn pending_close_retry_uses_close_time_lane_config_after_reload() {
    let first = instant(1_700_013_700);
    let second = instant(1_700_013_701);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_results(vec![
        Ok(script_output_with_record("raw:first", first)),
        Err("metric failed first".to_string()),
        Ok(script_output_with_record("metric:first", second)),
        Ok(script_output_with_record("raw:second", second)),
        Ok(script_output_with_record("metric:second", second)),
    ]);
    let mut config = scripted_metric_agent_config();
    config.lanes[0].schedule.interval_seconds = 1;
    let mut service = AgentService::new(config, center, spool, runner.clone()).unwrap();

    service.run_once(first).await.unwrap();
    let mut reloaded = reloaded_scripted_metric_lane_config();
    reloaded.metric_stage.settings["cwd"] = json!("/var/lib/lanedeck/stages/metric-reloaded");
    service
        .handle_control_message(ControlMessage::reload_lane_config(
            "control-reload-pending-close",
            reloaded,
        ))
        .await
        .unwrap();
    service.run_once(second).await.unwrap();

    let requests = runner.requests();
    assert_eq!(requests[2].purpose, ScriptPurpose::TransformStage);
    assert_eq!(requests[2].cwd, "/var/lib/lanedeck/stages/metric");
}

#[tokio::test]
async fn pending_close_retry_defers_history_limit_reload_until_close_finishes() {
    let first = instant(1_700_013_750);
    let second = instant(1_700_013_751);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_results(vec![
        Ok(script_output_with_record("raw:first", first)),
        Err("metric failed first".to_string()),
        Ok(script_output_with_record("metric:first", second)),
        Ok(script_output_with_record("event:first", second)),
        Ok(script_output_with_record("raw:second", second)),
        Ok(script_output_with_record("metric:second", second)),
        Ok(script_output_with_record("event:second", second)),
    ]);
    let mut config = scripted_metric_agent_config();
    config.lanes[0].schedule.interval_seconds = 1;
    config.lanes[0].config.event_stage.mode = StageMode::Script;
    config.lanes[0].config.event_stage.settings = json!({
        "command": "event-cpu",
        "cwd": "/var/lib/lanedeck/stages/event",
        "timeoutSeconds": 7,
        "captureStdout": true,
        "captureStderr": true,
        "history": {
            "metricFrames": 1
        }
    });
    let mut service = AgentService::new(config, center, spool, runner.clone()).unwrap();

    service.run_once(first).await.unwrap();
    let mut reloaded = reloaded_scripted_metric_lane_config();
    reloaded.event_stage.mode = StageMode::Script;
    reloaded.event_stage.settings = json!({
        "command": "event-cpu-reloaded",
        "cwd": "/var/lib/lanedeck/stages/event-reloaded",
        "timeoutSeconds": 7,
        "captureStdout": true,
        "captureStderr": true,
        "history": {
            "metricFrames": 0
        }
    });
    service
        .handle_control_message(ControlMessage::reload_lane_config(
            "control-reload-pending-history",
            reloaded,
        ))
        .await
        .unwrap();
    service.run_once(second).await.unwrap();

    let event_inputs = event_stage_inputs(&runner);

    assert_eq!(event_inputs.len(), 2);
    assert_eq!(
        event_inputs[0]["history"]["metricFrames"][0]["records"][0]["id"],
        "metric:first"
    );
    assert_eq!(
        event_inputs[1]["lane"]["eventStage"]["settings"]["history"]["metricFrames"],
        0
    );
}

#[tokio::test]
async fn reload_lane_config_rejects_unknown_lane_and_keeps_existing_schedule() {
    let now = instant(1_700_013_800);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![successful_script_output(now)]);
    let mut service = AgentService::new(
        script_lane_agent_config(),
        center,
        spool.clone(),
        runner.clone(),
    )
    .unwrap();

    let error = service
        .handle_control_message(ControlMessage::reload_lane_config(
            "control-reload-unknown",
            unknown_script_lane_config(),
        ))
        .await
        .unwrap_err();
    let report = service.run_once(now).await.unwrap();
    let requests = runner.requests();

    match error {
        AgentError::Config(message) => assert!(message.contains("lane.unknown")),
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(report.lane_execution_count, 1);
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].lane_id, "lane.cpu");
    assert_eq!(spool.enqueued_batches()[0].frames[0].lane_id, "lane.cpu");
}

#[tokio::test]
async fn reload_unknown_lane_checks_active_resource_before_payload_shape() {
    let now = instant(1_700_013_850);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![successful_script_output(now)]);
    let mut service =
        AgentService::new(script_lane_agent_config(), center, spool, runner.clone()).unwrap();
    let mut bad_lane = unknown_script_lane_config();
    bad_lane.raw_stage.settings["timeoutSeconds"] = json!(0);

    let first_error = service
        .handle_control_message(ControlMessage::reload_lane_config(
            "control-reload-unknown-invalid",
            bad_lane.clone(),
        ))
        .await
        .unwrap_err();
    let replay_error = service
        .handle_control_message(ControlMessage::reload_lane_config(
            "control-reload-unknown-invalid",
            bad_lane,
        ))
        .await
        .unwrap_err();
    service.run_once(now).await.unwrap();

    match first_error {
        AgentError::Config(message) => {
            assert!(message.contains("lane.unknown"));
            assert!(message.contains("not active"));
            assert!(!message.contains("timeoutSeconds"));
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(
        replay_error,
        AgentError::config("lane lane.unknown is not active")
    );
    assert_eq!(runner.requests().len(), 1);
}

#[tokio::test]
async fn reload_invalid_frame_settings_are_config_errors_and_keep_active_lane() {
    let now = instant(1_700_013_900);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![successful_script_output(now)]);
    let mut service =
        AgentService::new(script_lane_agent_config(), center, spool, runner.clone()).unwrap();
    let mut bad_lane = reloaded_script_lane_config();
    bad_lane.raw_stage.settings["frame"]["maxSeconds"] = json!(0);

    let error = service
        .handle_control_message(ControlMessage::reload_lane_config(
            "control-reload-invalid-frame",
            bad_lane,
        ))
        .await
        .unwrap_err();
    service.run_once(now).await.unwrap();
    let requests = runner.requests();

    match error {
        AgentError::Config(message) => {
            assert!(message.contains("rawStage.settings.frame.maxSeconds"))
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].cwd, "/var/lib/lanedeck/sources/cpu");
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
            "control-build-main",
            "machine.local",
            "dashboard-main",
            "revision-1",
            content_root(),
            "corepack pnpm --filter @lanedeck/content build",
        ))
        .await
        .unwrap();

    assert_eq!(
        reply,
        ControlReply::accepted("control-build-main", "build_content")
    );
    let request = runner.requests().remove(0);
    assert_eq!(request.purpose, ScriptPurpose::BuildContent);
    assert_eq!(request.cwd, content_root());
    assert_eq!(
        request.command,
        "corepack pnpm --filter @lanedeck/content build"
    );
}

#[tokio::test]
async fn build_content_control_message_rejects_other_machine() {
    let now = instant(1_700_014_010);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![successful_script_output(now)]);
    let mut service =
        AgentService::new(script_lane_agent_config(), center, spool, runner.clone()).unwrap();

    let error = service
        .handle_control_message(ControlMessage::build_content(
            "control-build-wrong-machine",
            "machine.other",
            "dashboard-main",
            "revision-1",
            content_root(),
            "corepack pnpm --filter @lanedeck/content build",
        ))
        .await
        .unwrap_err();

    match error {
        AgentError::Config(message) => assert!(message.contains("machineId")),
        other => panic!("unexpected error: {other:?}"),
    }
    assert!(runner.requests().is_empty());
}

#[tokio::test]
async fn build_content_control_message_rejects_empty_identity_fields() {
    let cases = [
        (
            "machineId",
            ControlMessage::build_content(
                "control-build-empty-machine",
                "",
                "dashboard-main",
                "revision-1",
                content_root(),
                "corepack pnpm --filter @lanedeck/content build",
            ),
        ),
        (
            "contentId",
            ControlMessage::build_content(
                "control-build-empty-content",
                "machine.local",
                "",
                "revision-1",
                content_root(),
                "corepack pnpm --filter @lanedeck/content build",
            ),
        ),
        (
            "contentRevision",
            ControlMessage::build_content(
                "control-build-empty-revision",
                "machine.local",
                "dashboard-main",
                "",
                content_root(),
                "corepack pnpm --filter @lanedeck/content build",
            ),
        ),
        (
            "cwd",
            ControlMessage::build_content(
                "control-build-empty-cwd",
                "machine.local",
                "dashboard-main",
                "revision-1",
                PathBuf::new(),
                "corepack pnpm --filter @lanedeck/content build",
            ),
        ),
        (
            "command",
            ControlMessage::build_content(
                "control-build-empty-command",
                "machine.local",
                "dashboard-main",
                "revision-1",
                content_root(),
                "",
            ),
        ),
    ];

    for (field, message) in cases {
        let center = CenterProbe::accepting();
        let spool = SpoolProbe::default();
        let runner =
            ScriptRunnerProbe::with_outputs(vec![successful_script_output(instant(1_700_014_020))]);
        let mut service =
            AgentService::new(script_lane_agent_config(), center, spool, runner.clone()).unwrap();

        let error = service.handle_control_message(message).await.unwrap_err();

        match error {
            AgentError::Config(message) => assert!(message.contains(field)),
            other => panic!("unexpected error: {other:?}"),
        }
        assert!(runner.requests().is_empty());
    }
}

#[tokio::test]
async fn duplicate_side_effecting_control_messages_replay_recorded_reply() {
    let now = instant(1_700_014_100);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![
        successful_script_output(now),
        successful_script_output(now),
    ]);
    let mut service = AgentService::new(
        script_lane_agent_config(),
        center,
        spool.clone(),
        runner.clone(),
    )
    .unwrap();

    let first_build = service
        .handle_control_message(ControlMessage::build_content(
            "control-build-duplicate",
            "machine.local",
            "dashboard-main",
            "revision-1",
            content_root(),
            "corepack pnpm --filter @lanedeck/content build",
        ))
        .await
        .unwrap();
    let second_build = service
        .handle_control_message(ControlMessage::build_content(
            "control-build-duplicate",
            "machine.local",
            "dashboard-main",
            "revision-1",
            content_root(),
            "corepack pnpm --filter @lanedeck/content build",
        ))
        .await
        .unwrap();
    let first_apply = service
        .handle_control_message(ControlMessage::apply_local_change(
            "control-apply-duplicate",
            "dashboard.json".into(),
            json!({"title": "once"}),
        ))
        .await
        .unwrap();
    let second_apply = service
        .handle_control_message(ControlMessage::apply_local_change(
            "control-apply-duplicate",
            "dashboard.json".into(),
            json!({"title": "twice"}),
        ))
        .await
        .unwrap();

    let requests = runner.requests();
    assert_eq!(first_build, second_build);
    assert_eq!(first_apply, second_apply);
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].purpose, ScriptPurpose::BuildContent);
    assert_eq!(requests[1].purpose, ScriptPurpose::ApplyLocalChange);
    assert!(requests[1].command.contains("once"));
    assert_eq!(
        spool.control_message_record("control-build-duplicate"),
        Some(ControlMessageRecord::Completed(Ok(first_build)))
    );
    assert_eq!(
        spool.control_message_record("control-apply-duplicate"),
        Some(ControlMessageRecord::Completed(Ok(first_apply)))
    );
}

#[tokio::test]
async fn control_completion_persist_failure_keeps_replay_path() {
    let now = instant(1_700_014_150);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::fail_next_control_completion();
    let runner = ScriptRunnerProbe::with_outputs(vec![successful_script_output(now)]);
    let mut service = AgentService::new(
        script_lane_agent_config(),
        center,
        spool.clone(),
        runner.clone(),
    )
    .unwrap();

    let first_error = service
        .handle_control_message(ControlMessage::build_content(
            "control-build-completion-failure",
            "machine.local",
            "dashboard-main",
            "revision-1",
            content_root(),
            "corepack pnpm --filter @lanedeck/content build",
        ))
        .await
        .unwrap_err();
    let replay = service
        .handle_control_message(ControlMessage::build_content(
            "control-build-completion-failure",
            "machine.local",
            "dashboard-main",
            "revision-1",
            content_root(),
            "corepack pnpm --filter @lanedeck/content build",
        ))
        .await
        .unwrap();

    match first_error {
        AgentError::Spool(message) => assert!(message.contains("control completion failed")),
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(
        replay,
        ControlReply::accepted("control-build-completion-failure", "build_content")
    );
    assert_eq!(
        spool.control_message_record("control-build-completion-failure"),
        Some(ControlMessageRecord::Completed(Ok(replay)))
    );
    assert_eq!(runner.requests().len(), 1);
}

#[tokio::test]
async fn duplicate_rejected_control_message_replays_recorded_error() {
    let now = instant(1_700_014_200);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![successful_script_output(now)]);
    let mut service =
        AgentService::new(script_lane_agent_config(), center, spool, runner.clone()).unwrap();

    let first_error = service
        .handle_control_message(ControlMessage::reload_lane_config(
            "control-reload-rejected-duplicate",
            unknown_script_lane_config(),
        ))
        .await
        .unwrap_err();
    let second_error = service
        .handle_control_message(ControlMessage::reload_lane_config(
            "control-reload-rejected-duplicate",
            reloaded_script_lane_config(),
        ))
        .await
        .unwrap_err();
    let report = service.run_once(now).await.unwrap();
    let requests = runner.requests();

    assert_eq!(first_error, second_error);
    assert_eq!(report.lane_execution_count, 1);
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].cwd, "/var/lib/lanedeck/sources/cpu");
}

#[tokio::test]
async fn in_progress_control_message_blocks_duplicate_side_effect_execution() {
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::with_control_message(
        "control-build-in-progress",
        ControlMessageRecord::InProgress,
    );
    let runner =
        ScriptRunnerProbe::with_outputs(vec![successful_script_output(instant(1_700_014_300))]);
    let mut service =
        AgentService::new(script_lane_agent_config(), center, spool, runner.clone()).unwrap();

    let error = service
        .handle_control_message(ControlMessage::build_content(
            "control-build-in-progress",
            "machine.local",
            "dashboard-main",
            "revision-1",
            content_root(),
            "corepack pnpm --filter @lanedeck/content build",
        ))
        .await
        .unwrap_err();

    match error {
        AgentError::Spool(message) => assert!(message.contains("already in progress")),
        other => panic!("unexpected error: {other:?}"),
    }
    assert!(runner.requests().is_empty());
}

#[test]
fn control_messages_accept_camel_case_protocol_fields() {
    let message: ControlMessage = serde_json::from_value(json!({
        "type": "build_content",
        "messageId": "control-build-json",
        "machineId": "machine.local",
        "contentId": "dashboard-main",
        "contentRevision": "revision-1",
        "cwd": "/var/lib/lanedeck/content",
        "command": "build-content"
    }))
    .unwrap();

    match message {
        ControlMessage::BuildContent {
            message_id,
            machine_id,
            content_id,
            content_revision,
            cwd,
            command,
        } => {
            assert_eq!(message_id.as_str(), "control-build-json");
            assert_eq!(machine_id, "machine.local");
            assert_eq!(content_id, "dashboard-main");
            assert_eq!(content_revision, "revision-1");
            assert_eq!(cwd, content_root());
            assert_eq!(command, "build-content");
        }
        other => panic!("unexpected control message: {other:?}"),
    }
}

#[test]
fn unknown_control_message_tags_decode_to_unknown_variant() {
    let message: ControlMessage = serde_json::from_value(json!({
        "type": "future_command",
        "messageId": "control-future",
        "contentId": "dashboard-main"
    }))
    .unwrap();

    assert_eq!(
        message,
        ControlMessage::unknown("control-future", "future_command")
    );
}

#[test]
fn malformed_apply_local_change_requires_body() {
    let result = serde_json::from_value::<ControlMessage>(json!({
        "type": "apply_local_change",
        "messageId": "control-apply-malformed",
        "path": "/var/lib/lanedeck/content/pages/dashboard.json"
    }));

    assert!(result.is_err());
}

#[test]
fn malformed_control_message_requires_message_id() {
    let result = serde_json::from_value::<ControlMessage>(json!({
        "type": "heartbeat"
    }));

    assert!(result.is_err());
}

#[test]
fn flush_max_batch_size_zero_is_rejected_as_config_error() {
    let mut config = script_lane_agent_config();
    config.flush.max_batch_size = 0;

    let error = match AgentService::new(
        config,
        CenterProbe::accepting(),
        SpoolProbe::default(),
        ScriptRunnerProbe::with_outputs(Vec::new()),
    ) {
        Ok(_) => panic!("expected config error"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        AgentError::Config("flush.maxBatchSize must be positive".to_string())
    );
}

#[test]
fn startup_rejects_duplicate_lane_identities() {
    let duplicate_message =
        new_service_config_message(duplicate_nested_lane_identity_agent_config());
    let mismatch_message = new_service_config_message(mismatched_lane_identity_agent_config());

    assert!(duplicate_message.contains("lane.cpu"));
    assert!(duplicate_message.contains("configured more than once"));
    assert!(mismatch_message.contains("lane.wrapper"));
    assert!(mismatch_message.contains("lane.cpu"));
    assert!(mismatch_message.contains("laneId"));
}

#[test]
fn startup_rejects_schedule_interval_seconds_above_signed_duration_limit() {
    let mut config = script_lane_agent_config();
    let schedule: lanedeck_agent_runtime::LaneSchedule = lanedeck_agent_runtime::LaneSchedule {
        interval_seconds: i64::MAX as u64 + 1,
    };
    config.lanes[0].schedule = schedule;

    let message = new_service_config_message(config);

    assert!(message.contains("lane.cpu"));
    assert!(message.contains("schedule.intervalSeconds"));
}

#[test]
fn startup_rejects_schedule_interval_seconds_outside_supported_duration_range() {
    let mut config = script_lane_agent_config();
    config.lanes[0].schedule = lanedeck_agent_runtime::LaneSchedule {
        interval_seconds: i64::MAX as u64,
    };

    let message = new_service_config_message(config);

    assert!(message.contains("lane.cpu"));
    assert!(message.contains("schedule.intervalSeconds"));
    assert!(message.contains("supported duration"));
}

#[test]
fn startup_rejects_zero_schedule_interval_seconds() {
    let message = new_service_config_message(script_lane_agent_config_with_interval(0));

    assert!(message.contains("lane.cpu"));
    assert!(message.contains("schedule.intervalSeconds"));
}

#[test]
fn startup_invalid_frame_settings_are_config_errors() {
    let mut config = script_lane_agent_config();
    config.lanes[0].config.raw_stage.settings["frame"]["maxSeconds"] = json!(0);
    let spool = SpoolProbe::default();

    let error = match AgentService::new(
        config,
        CenterProbe::accepting(),
        spool.clone(),
        ScriptRunnerProbe::with_outputs(Vec::new()),
    ) {
        Ok(_) => panic!("expected config error"),
        Err(error) => error,
    };

    match error {
        AgentError::Config(message) => {
            assert!(message.contains("rawStage.settings.frame.maxSeconds"))
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(spool.runtime_seed_allocations(), 0);
}

#[test]
fn crate_root_exports_public_field_types_for_config_and_spool_api() {
    let schedule: lanedeck_agent_runtime::LaneSchedule = lanedeck_agent_runtime::LaneSchedule {
        interval_seconds: 15,
    };
    let mut config = script_lane_agent_config();
    config.lanes[0].schedule = schedule;
    let entry = pending_spool_entry(
        "spool-public",
        ingest_batch("batch-public", instant(1_700_014_100)),
    );
    let state: lanedeck_agent_runtime::SpoolEntryState = entry.state;

    assert_eq!(config.lanes[0].schedule.interval_seconds, 15);
    match state {
        lanedeck_agent_runtime::SpoolEntryState::Pending => {}
        other => panic!("unexpected spool entry state: {other:?}"),
    }
}

#[tokio::test]
async fn apply_local_change_control_message_calls_local_content_write_handler() {
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner =
        ScriptRunnerProbe::with_outputs(vec![successful_script_output(instant(1_700_014_500))]);
    let mut service =
        AgentService::new(script_lane_agent_config(), center, spool, runner.clone()).unwrap();
    let path = content_root().join("pages/dashboard.json");

    let reply = service
        .handle_control_message(ControlMessage::apply_local_change(
            "control-apply-dashboard",
            path.clone(),
            json!({"title": "updated dashboard"}),
        ))
        .await
        .unwrap();

    assert_eq!(
        reply,
        ControlReply::accepted("control-apply-dashboard", "apply_local_change")
    );
    let request = runner.requests().remove(0);
    assert_eq!(request.purpose, ScriptPurpose::ApplyLocalChange);
    assert_eq!(request.cwd, content_root().join("pages"));
    assert!(request.command.contains("apply_local_change"));
    assert!(request.command.contains("dashboard.json"));
    assert!(request.command.contains("updated dashboard"));
    assert_eq!(
        request.side_effect_policy,
        ScriptSideEffectPolicy::LocalContentWriteBoundary
    );
}

#[tokio::test]
async fn apply_local_change_relative_single_file_uses_dot_cwd() {
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner =
        ScriptRunnerProbe::with_outputs(vec![successful_script_output(instant(1_700_014_600))]);
    let mut service =
        AgentService::new(script_lane_agent_config(), center, spool, runner.clone()).unwrap();

    let reply = service
        .handle_control_message(ControlMessage::apply_local_change(
            "control-apply-relative",
            "dashboard.json".into(),
            json!({"title": "local dashboard"}),
        ))
        .await
        .unwrap();

    assert_eq!(
        reply,
        ControlReply::accepted("control-apply-relative", "apply_local_change")
    );
    let request = runner.requests().remove(0);
    assert_eq!(request.purpose, ScriptPurpose::ApplyLocalChange);
    assert_eq!(request.cwd, ".");
    assert!(request.command.contains("dashboard.json"));
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

#[tokio::test]
async fn scripted_downstream_stage_runs_through_script_runner() {
    let now = instant(1_700_016_000);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![
        successful_script_output(now),
        successful_script_output(now),
    ]);
    let mut service = AgentService::new(
        scripted_metric_agent_config(),
        center,
        spool.clone(),
        runner.clone(),
    )
    .unwrap();

    let report = service.run_once(now).await.unwrap();
    let requests = runner.requests();

    assert_eq!(report.enqueued_batch_count, 1);
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].purpose, ScriptPurpose::TransformStage);
    assert_eq!(requests[1].command, "metric-cpu");
    assert_eq!(requests[1].cwd, "/var/lib/lanedeck/stages/metric");
    let input = requests[1].input.as_ref().unwrap();
    assert_eq!(input["currentFrame"]["stage"], "raw");
    assert_eq!(input["currentFrame"]["records"][0]["id"], "raw:1");
    assert_eq!(input["lane"]["laneId"], "lane.cpu");
    assert!(input["history"].is_object());
    assert_eq!(requests[1].timeout, duration(7));
    assert_eq!(
        requests[1].side_effect_policy,
        ScriptSideEffectPolicy::StageTransformBoundary
    );
}

#[tokio::test]
async fn per_lane_history_keeps_latest_configured_upstream_frame() {
    let first = instant(1_700_016_100);
    let second = instant(1_700_016_101);
    let third = instant(1_700_016_102);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![
        script_output_with_record("raw:first", first),
        script_output_with_record("metric:first", first),
        script_output_with_record("raw:second", second),
        script_output_with_record("metric:second", second),
        script_output_with_record("raw:third", third),
        script_output_with_record("metric:third", third),
    ]);
    let mut config = scripted_metric_agent_config_with_upstream_history_limit(1);
    config.lanes[0].schedule.interval_seconds = 1;
    let mut service = AgentService::new(config, center, spool, runner.clone()).unwrap();

    service.run_once(first).await.unwrap();
    service.run_once(second).await.unwrap();
    service.run_once(third).await.unwrap();

    let metric_inputs: Vec<_> = runner
        .requests()
        .into_iter()
        .filter(|request| request.purpose == ScriptPurpose::TransformStage)
        .map(|request| request.input.unwrap())
        .collect();

    assert_eq!(metric_inputs.len(), 3);
    for input in &metric_inputs {
        assert!(input["history"]["upstreamFrames"].as_array().unwrap().len() <= 1);
    }
    assert!(
        metric_inputs[0]["history"]["upstreamFrames"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        metric_inputs[1]["history"]["upstreamFrames"][0]["records"][0]["id"],
        "raw:first"
    );
    assert_eq!(
        metric_inputs[2]["history"]["upstreamFrames"][0]["records"][0]["id"],
        "raw:second"
    );
}

#[tokio::test]
async fn reload_refreshes_history_retention_limits() {
    let first = instant(1_700_016_200);
    let second = instant(1_700_016_201);
    let third = instant(1_700_016_202);
    let fourth = instant(1_700_016_203);
    let fifth = instant(1_700_016_204);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![
        script_output_with_record("raw:first", first),
        script_output_with_record("metric:first", first),
        script_output_with_record("raw:second", second),
        script_output_with_record("metric:second", second),
        script_output_with_record("raw:third", third),
        script_output_with_record("metric:third", third),
        script_output_with_record("raw:fourth", fourth),
        script_output_with_record("metric:fourth", fourth),
        script_output_with_record("raw:fifth", fifth),
        script_output_with_record("metric:fifth", fifth),
    ]);
    let mut config = scripted_metric_agent_config_with_upstream_history_limit(1);
    config.lanes[0].schedule.interval_seconds = 1;
    let mut service = AgentService::new(config, center, spool, runner.clone()).unwrap();

    service.run_once(first).await.unwrap();
    service.run_once(second).await.unwrap();
    service.run_once(third).await.unwrap();

    let mut reloaded_config = scripted_metric_agent_config_with_upstream_history_limit(2);
    let reload_reply = service
        .handle_control_message(ControlMessage::reload_lane_config(
            "control-reload-history-limits",
            reloaded_config.lanes.remove(0).config,
        ))
        .await
        .unwrap();

    service.run_once(fourth).await.unwrap();
    service.run_once(fifth).await.unwrap();

    let metric_inputs = metric_stage_inputs(&runner);
    let before_reload_history = metric_inputs[2]["history"]["upstreamFrames"]
        .as_array()
        .unwrap();
    let after_reload_history = metric_inputs[4]["history"]["upstreamFrames"]
        .as_array()
        .unwrap();

    assert_eq!(
        reload_reply,
        ControlReply::accepted("control-reload-history-limits", "reload_lane_config")
    );
    assert_eq!(metric_inputs.len(), 5);
    assert_eq!(before_reload_history.len(), 1);
    assert_eq!(before_reload_history[0]["records"][0]["id"], "raw:second");
    assert_eq!(after_reload_history.len(), 2);
    assert_eq!(after_reload_history[0]["records"][0]["id"], "raw:third");
    assert_eq!(after_reload_history[1]["records"][0]["id"], "raw:fourth");
}

#[tokio::test]
async fn lane_collection_state_survives_between_runs() {
    let first = instant(1_700_016_500);
    let second = instant(1_700_016_501);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![
        script_output_with_record("raw:first", first),
        script_output_with_record("raw:second", second),
    ]);
    let mut service = AgentService::new(
        two_record_frame_agent_config(),
        center,
        spool.clone(),
        runner,
    )
    .unwrap();

    let first_report = service.run_once(first).await.unwrap();
    let second_report = service.run_once(second).await.unwrap();
    let enqueued = spool.enqueued_batches();

    assert_eq!(first_report.enqueued_batch_count, 0);
    assert_eq!(second_report.enqueued_batch_count, 1);
    assert_eq!(enqueued.len(), 1);
    let raw_frame = enqueued[0]
        .frames
        .iter()
        .find(|frame| frame.stage == lanedeck_protocol::StageKind::Raw)
        .unwrap();
    assert_eq!(raw_frame.frame_no, 1);
    assert_eq!(raw_frame.record_count, 2);
    assert_eq!(raw_frame.records[0].id, "raw:first");
    assert_eq!(raw_frame.records[1].id, "raw:second");
}

#[tokio::test]
async fn expired_time_window_closes_before_new_records_are_ingested() {
    let first = instant(1_700_016_580);
    let second = instant(1_700_016_640);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![
        script_output_with_record("raw:first", first),
        script_output_with_record("raw:second", second),
    ]);
    let mut service = AgentService::new(
        two_record_frame_agent_config(),
        center,
        spool.clone(),
        runner,
    )
    .unwrap();

    service.run_once(first).await.unwrap();
    let report = service.run_once(second).await.unwrap();
    let enqueued = spool.enqueued_batches();

    assert_eq!(report.enqueued_batch_count, 1);
    let raw_frame = enqueued[0]
        .frames
        .iter()
        .find(|frame| frame.stage == lanedeck_protocol::StageKind::Raw)
        .unwrap();
    assert_eq!(raw_frame.record_count, 1);
    assert_eq!(raw_frame.records[0].id, "raw:first");
    assert_eq!(raw_frame.trigger_kind, lanedeck_protocol::TriggerKind::Time);
}

#[tokio::test]
async fn closed_frames_are_enqueued_when_later_record_fails() {
    let now = instant(1_700_016_590);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_results(vec![
        Ok(script_output_with_records(
            &["raw:first", "raw:second"],
            now,
        )),
        Ok(successful_script_output(now)),
        Err("metric failed on second record".to_string()),
    ]);
    let mut service = AgentService::new(
        scripted_metric_agent_config(),
        center,
        spool.clone(),
        runner,
    )
    .unwrap();

    let report = service.run_once(now).await.unwrap();
    let enqueued = spool.enqueued_batches();

    assert_eq!(report.enqueued_batch_count, 1);
    assert_eq!(report.diagnostics.len(), 1);
    assert!(report.diagnostics[0].message.contains("metric failed"));
    assert_eq!(enqueued.len(), 1);
    let raw_frame = enqueued[0]
        .frames
        .iter()
        .find(|frame| frame.stage == lanedeck_protocol::StageKind::Raw)
        .unwrap();
    assert_eq!(raw_frame.records[0].id, "raw:first");
}

#[tokio::test]
async fn pending_close_retry_runs_before_next_source_collection() {
    let first = instant(1_700_016_595);
    let second = instant(1_700_016_596);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_results(vec![
        Ok(script_output_with_record("raw:first", first)),
        Err("metric failed first".to_string()),
        Err("metric failed again".to_string()),
    ]);
    let mut config = scripted_metric_agent_config();
    config.lanes[0].schedule.interval_seconds = 1;
    let mut service = AgentService::new(config, center, spool, runner.clone()).unwrap();

    let first_report = service.run_once(first).await.unwrap();
    let second_report = service.run_once(second).await.unwrap();
    let requests = runner.requests();

    assert_eq!(first_report.diagnostics.len(), 1);
    assert_eq!(second_report.diagnostics.len(), 1);
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0].purpose, ScriptPurpose::CollectSource);
    assert_eq!(requests[1].purpose, ScriptPurpose::TransformStage);
    assert_eq!(requests[2].purpose, ScriptPurpose::TransformStage);
}

#[tokio::test]
async fn pending_close_retry_success_collects_and_enqueues_new_source_output() {
    let first = instant(1_700_016_596);
    let second = instant(1_700_016_597);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_results(vec![
        Ok(script_output_with_record("raw:first", first)),
        Err("metric failed first".to_string()),
        Ok(script_output_with_record("metric:first", second)),
        Ok(script_output_with_record("raw:second", second)),
        Ok(script_output_with_record("metric:second", second)),
    ]);
    let mut config = scripted_metric_agent_config();
    config.lanes[0].schedule.interval_seconds = 1;
    let mut service = AgentService::new(config, center, spool.clone(), runner.clone()).unwrap();

    service.run_once(first).await.unwrap();
    let second_report = service.run_once(second).await.unwrap();
    let enqueued = spool.enqueued_batches();
    let requests = runner.requests();

    assert_eq!(second_report.enqueued_batch_count, 2);
    assert_eq!(enqueued.len(), 2);
    assert_eq!(requests[0].purpose, ScriptPurpose::CollectSource);
    assert_eq!(requests[1].purpose, ScriptPurpose::TransformStage);
    assert_eq!(requests[2].purpose, ScriptPurpose::TransformStage);
    assert_eq!(requests[3].purpose, ScriptPurpose::CollectSource);
    assert_eq!(requests[4].purpose, ScriptPurpose::TransformStage);
    let second_raw_frame = enqueued[1]
        .frames
        .iter()
        .find(|frame| frame.stage == lanedeck_protocol::StageKind::Raw)
        .unwrap();
    assert_eq!(second_raw_frame.records[0].id, "raw:second");
}

#[tokio::test]
async fn expired_window_close_failure_retains_collected_source_output() {
    let first = instant(1_700_016_598);
    let second = instant(1_700_016_659);
    let third = instant(1_700_016_660);
    let fourth = instant(1_700_016_661);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_results(vec![
        Ok(script_output_with_record("raw:first", first)),
        Ok(script_output_with_record("raw:second", second)),
        Err("metric failed on expired window".to_string()),
        Ok(script_output_with_record("metric:first", third)),
        Ok(script_output_with_record("raw:third", fourth)),
        Ok(script_output_with_record("metric:second-third", fourth)),
    ]);
    let mut config = scripted_metric_agent_config();
    config.lanes[0].schedule.interval_seconds = 1;
    config.lanes[0].config.raw_stage.settings["frame"]["maxRecords"] = json!(2);
    let mut service = AgentService::new(config, center, spool.clone(), runner.clone()).unwrap();

    service.run_once(first).await.unwrap();
    service.run_once(second).await.unwrap();
    service.run_once(third).await.unwrap();
    service.run_once(fourth).await.unwrap();

    let enqueued = spool.enqueued_batches();
    assert_eq!(enqueued.len(), 2);
    let second_raw_frame = enqueued[1]
        .frames
        .iter()
        .find(|frame| frame.stage == lanedeck_protocol::StageKind::Raw)
        .unwrap();
    assert_eq!(second_raw_frame.records[0].id, "raw:second");
    assert_eq!(second_raw_frame.records[1].id, "raw:third");
}

#[tokio::test]
async fn mid_batch_stage_failure_retains_unaccepted_source_records() {
    let first = instant(1_700_016_599);
    let second = instant(1_700_016_600);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_results(vec![
        Ok(script_output_with_records(
            &["raw:first", "raw:second", "raw:third"],
            first,
        )),
        Ok(script_output_with_record("metric:first", first)),
        Err("metric failed second".to_string()),
        Ok(script_output_with_record("metric:second", second)),
        Ok(script_output_with_record("metric:third", second)),
    ]);
    let mut config = scripted_metric_agent_config();
    config.lanes[0].schedule.interval_seconds = 1;
    let mut service = AgentService::new(config, center, spool.clone(), runner.clone()).unwrap();

    service.run_once(first).await.unwrap();
    let second_report = service.run_once(second).await.unwrap();

    let requests = runner.requests();
    let enqueued = spool.enqueued_batches();
    assert_eq!(second_report.enqueued_batch_count, 2);
    assert_eq!(requests.len(), 5);
    assert_eq!(requests[0].purpose, ScriptPurpose::CollectSource);
    assert_eq!(requests[1].purpose, ScriptPurpose::TransformStage);
    assert_eq!(requests[2].purpose, ScriptPurpose::TransformStage);
    assert_eq!(requests[3].purpose, ScriptPurpose::TransformStage);
    assert_eq!(requests[4].purpose, ScriptPurpose::TransformStage);
    let third_raw_frame = enqueued
        .iter()
        .flat_map(|batch| &batch.frames)
        .find(|frame| {
            frame.stage == lanedeck_protocol::StageKind::Raw
                && frame.records.iter().any(|record| record.id == "raw:third")
        })
        .unwrap();
    assert_eq!(third_raw_frame.records[0].id, "raw:third");
}

#[tokio::test]
async fn successful_empty_source_runs_can_emit_time_triggered_quiet_frame() {
    let first = instant(1_700_016_601);
    let second = instant(1_700_016_662);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![
        ScriptRunOutput::from_json_records(Vec::new()),
        ScriptRunOutput::from_json_records(Vec::new()),
    ]);
    let mut service = AgentService::new(
        script_lane_agent_config_with_interval(1),
        center,
        spool.clone(),
        runner,
    )
    .unwrap();

    let first_report = service.run_once(first).await.unwrap();
    let second_report = service.run_once(second).await.unwrap();
    let enqueued = spool.enqueued_batches();

    assert_eq!(first_report.enqueued_batch_count, 0);
    assert_eq!(second_report.enqueued_batch_count, 1);
    let raw_frame = enqueued[0]
        .frames
        .iter()
        .find(|frame| frame.stage == lanedeck_protocol::StageKind::Raw)
        .unwrap();
    assert_eq!(raw_frame.trigger_kind, lanedeck_protocol::TriggerKind::Time);
    assert_eq!(raw_frame.record_count, 0);
}

#[tokio::test]
async fn source_failures_do_not_advance_raw_window_or_emit_quiet_frame() {
    let first = instant(1_700_016_597);
    let second = instant(1_700_016_658);
    let third = instant(1_700_016_659);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_results(vec![
        Err("source failed first".to_string()),
        Err("source failed second".to_string()),
        Ok(script_output_with_record("raw:after-failure", third)),
    ]);
    let mut service = AgentService::new(
        script_lane_agent_config_with_interval(1),
        center,
        spool.clone(),
        runner.clone(),
    )
    .unwrap();

    let first_report = service.run_once(first).await.unwrap();
    let second_report = service.run_once(second).await.unwrap();
    let batches_after_failures = spool.enqueued_batches();
    let third_report = service.run_once(third).await.unwrap();
    let enqueued = spool.enqueued_batches();

    assert_eq!(first_report.diagnostics.len(), 1);
    assert_eq!(second_report.diagnostics.len(), 1);
    assert!(batches_after_failures.is_empty());
    assert_eq!(third_report.enqueued_batch_count, 1);
    assert_eq!(enqueued.len(), 1);
    let raw_frame = enqueued[0]
        .frames
        .iter()
        .find(|frame| frame.stage == lanedeck_protocol::StageKind::Raw)
        .unwrap();
    assert_eq!(raw_frame.records[0].id, "raw:after-failure");
    assert_eq!(raw_frame.frame_no, 1);
    assert_eq!(runner.requests().len(), 3);
}

#[tokio::test]
async fn lane_schedule_skips_until_interval_elapsed() {
    let first = instant(1_700_016_600);
    let early = instant(1_700_016_630);
    let due = instant(1_700_016_660);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![
        successful_script_output(first),
        successful_script_output(due),
    ]);
    let mut service =
        AgentService::new(script_lane_agent_config(), center, spool, runner.clone()).unwrap();

    let first_report = service.run_once(first).await.unwrap();
    let early_report = service.run_once(early).await.unwrap();
    let due_report = service.run_once(due).await.unwrap();

    assert_eq!(first_report.lane_execution_count, 1);
    assert_eq!(early_report.lane_execution_count, 0);
    assert_eq!(due_report.lane_execution_count, 1);
    assert_eq!(runner.requests().len(), 2);
}

#[tokio::test]
async fn lane_failure_is_reported_and_later_lanes_continue() {
    let now = instant(1_700_016_700);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_results(vec![
        Err("cpu source failed".to_string()),
        Ok(successful_script_output(now)),
    ]);
    let mut service = AgentService::new(
        two_lane_agent_config(),
        center,
        spool.clone(),
        runner.clone(),
    )
    .unwrap();

    let report = service.run_once(now).await.unwrap();

    assert_eq!(report.lane_execution_count, 2);
    assert_eq!(report.enqueued_batch_count, 1);
    assert_eq!(spool.enqueued_batches().len(), 1);
    assert_eq!(runner.requests().len(), 2);
    assert_eq!(report.diagnostics.len(), 1);
    assert_eq!(report.diagnostics[0].path, "lanes.lane.cpu");
    assert!(report.diagnostics[0].message.contains("cpu source failed"));
}

#[tokio::test]
async fn run_report_carries_source_and_stage_diagnostics() {
    let now = instant(1_700_017_000);
    let center = CenterProbe::accepting();
    let spool = SpoolProbe::default();
    let runner = ScriptRunnerProbe::with_outputs(vec![diagnostic_script_output(now)]);
    let mut service =
        AgentService::new(empty_metric_agent_config(), center, spool, runner).unwrap();

    let report = service.run_once(now).await.unwrap();

    assert_eq!(report.diagnostics.len(), 2);
    assert_eq!(report.diagnostics[0].path, "rawStage.script");
    assert_eq!(report.diagnostics[1].path, "metricStage");
}

#[tokio::test]
async fn downstream_script_stage_settings_validated_at_update_boundary() {
    for (case_name, bad_lane, stage_path, missing_key) in
        downstream_script_stage_missing_setting_cases()
    {
        let new_message =
            new_service_config_message(agent_config_with_lane_config(bad_lane.clone()));
        assert_downstream_config_message(&new_message, stage_path, missing_key, case_name);

        let now = instant(1_700_017_500);
        let spool = SpoolProbe::default();
        let runner = ScriptRunnerProbe::with_outputs(vec![successful_script_output(now)]);
        let mut service = AgentService::new(
            script_lane_agent_config(),
            CenterProbe::accepting(),
            spool.clone(),
            runner.clone(),
        )
        .unwrap();

        let reload_error = service
            .handle_control_message(ControlMessage::reload_lane_config(
                format!("control-missing-setting-{case_name}"),
                bad_lane,
            ))
            .await
            .unwrap_err();
        let reload_message = config_message(reload_error);
        assert_downstream_config_message(&reload_message, stage_path, missing_key, case_name);

        let report = service.run_once(now).await.unwrap();
        let requests = runner.requests();

        assert_eq!(report.lane_execution_count, 1, "{case_name}");
        assert_eq!(requests.len(), 1, "{case_name}");
        assert_eq!(requests[0].purpose, ScriptPurpose::CollectSource);
        assert_eq!(spool.enqueued_batches()[0].frames[0].lane_id, "lane.cpu");
    }
}

#[tokio::test]
async fn script_stage_capture_settings_require_boolean_at_update_boundary() {
    for (case_name, bad_lane, stage_path, capture_key) in
        script_stage_non_bool_capture_setting_cases()
    {
        let new_message =
            new_service_config_message(agent_config_with_lane_config(bad_lane.clone()));
        assert_stage_setting_config_message(&new_message, stage_path, capture_key, case_name);

        let now = instant(1_700_017_600);
        let spool = SpoolProbe::default();
        let runner = ScriptRunnerProbe::with_outputs(vec![successful_script_output(now)]);
        let mut service = AgentService::new(
            script_lane_agent_config(),
            CenterProbe::accepting(),
            spool.clone(),
            runner.clone(),
        )
        .unwrap();

        let reload_error = service
            .handle_control_message(ControlMessage::reload_lane_config(
                format!("control-capture-setting-{case_name}"),
                bad_lane,
            ))
            .await
            .unwrap_err();
        let reload_message = config_message(reload_error);
        assert_stage_setting_config_message(&reload_message, stage_path, capture_key, case_name);

        let report = service.run_once(now).await.unwrap();
        let requests = runner.requests();

        assert_eq!(report.lane_execution_count, 1, "{case_name}");
        assert_eq!(requests.len(), 1, "{case_name}");
        assert_eq!(requests[0].purpose, ScriptPurpose::CollectSource);
        assert_eq!(spool.enqueued_batches()[0].frames[0].lane_id, "lane.cpu");
    }
}

#[tokio::test]
async fn script_stage_timeout_seconds_outside_duration_range_rejected_at_update_boundary() {
    for stage_path in ["rawStage", "metricStage", "eventStage"] {
        let bad_lane = lane_with_script_timeout(stage_path, i64::MAX);
        let new_message =
            new_service_config_message(agent_config_with_lane_config(bad_lane.clone()));
        assert_duration_config_message(&new_message, stage_path);

        let now = instant(1_700_017_650);
        let spool = SpoolProbe::default();
        let runner = ScriptRunnerProbe::with_outputs(vec![successful_script_output(now)]);
        let mut service = AgentService::new(
            script_lane_agent_config(),
            CenterProbe::accepting(),
            spool.clone(),
            runner.clone(),
        )
        .unwrap();

        let reload_error = service
            .handle_control_message(ControlMessage::reload_lane_config(
                format!("control-duration-{stage_path}"),
                bad_lane,
            ))
            .await
            .unwrap_err();
        let reload_message = config_message(reload_error);
        assert_duration_config_message(&reload_message, stage_path);

        let report = service.run_once(now).await.unwrap();
        let requests = runner.requests();

        assert_eq!(report.lane_execution_count, 1, "{stage_path}");
        assert_eq!(requests.len(), 1, "{stage_path}");
        assert_eq!(requests[0].purpose, ScriptPurpose::CollectSource);
        assert_eq!(spool.enqueued_batches()[0].frames[0].lane_id, "lane.cpu");
    }
}

#[tokio::test]
async fn downstream_builtin_stages_are_rejected_at_update_boundary() {
    for (case_name, bad_lane, stage_path) in downstream_builtin_stage_cases() {
        let new_message =
            new_service_config_message(agent_config_with_lane_config(bad_lane.clone()));
        assert_builtin_stage_config_message(&new_message, stage_path, case_name);

        let now = instant(1_700_017_700);
        let spool = SpoolProbe::default();
        let runner = ScriptRunnerProbe::with_outputs(vec![successful_script_output(now)]);
        let mut service = AgentService::new(
            script_lane_agent_config(),
            CenterProbe::accepting(),
            spool.clone(),
            runner.clone(),
        )
        .unwrap();

        let reload_error = service
            .handle_control_message(ControlMessage::reload_lane_config(
                format!("control-builtin-{case_name}"),
                bad_lane,
            ))
            .await
            .unwrap_err();
        let reload_message = config_message(reload_error);
        assert_builtin_stage_config_message(&reload_message, stage_path, case_name);

        let report = service.run_once(now).await.unwrap();
        let requests = runner.requests();

        assert_eq!(report.lane_execution_count, 1, "{case_name}");
        assert_eq!(requests.len(), 1, "{case_name}");
        assert_eq!(requests[0].purpose, ScriptPurpose::CollectSource);
        assert_eq!(spool.enqueued_batches()[0].frames[0].lane_id, "lane.cpu");
    }
}

fn new_service_config_message(config: AgentConfig) -> String {
    let result = AgentService::new(
        config,
        CenterProbe::accepting(),
        SpoolProbe::default(),
        ScriptRunnerProbe::with_outputs(Vec::new()),
    );

    match result {
        Ok(_) => panic!("expected config error"),
        Err(error) => config_message(error),
    }
}

fn config_message(error: AgentError) -> String {
    match error {
        AgentError::Config(message) => message,
        other => panic!("unexpected error: {other:?}"),
    }
}

fn assert_downstream_config_message(
    message: &str,
    stage_path: &str,
    missing_key: &str,
    case_name: &str,
) {
    assert!(message.contains("lane.cpu"), "{case_name}: {message}");
    assert!(message.contains(stage_path), "{case_name}: {message}");
    assert!(message.contains(missing_key), "{case_name}: {message}");
}

fn assert_builtin_stage_config_message(message: &str, stage_path: &str, case_name: &str) {
    assert!(message.contains("lane.cpu"), "{case_name}: {message}");
    assert!(message.contains(stage_path), "{case_name}: {message}");
    assert!(message.contains("builtin"), "{case_name}: {message}");
}

fn assert_stage_setting_config_message(
    message: &str,
    stage_path: &str,
    setting_key: &str,
    case_name: &str,
) {
    assert!(message.contains("lane.cpu"), "{case_name}: {message}");
    assert!(message.contains(stage_path), "{case_name}: {message}");
    assert!(message.contains(setting_key), "{case_name}: {message}");
}

fn assert_duration_config_message(message: &str, stage_path: &str) {
    assert!(message.contains("lane.cpu"), "{stage_path}: {message}");
    assert!(message.contains(stage_path), "{stage_path}: {message}");
    assert!(
        message.contains("timeoutSeconds"),
        "{stage_path}: {message}"
    );
    assert!(
        message.contains("supported duration"),
        "{stage_path}: {message}"
    );
}

fn lane_with_script_timeout(stage_path: &str, timeout_seconds: i64) -> LaneConfig {
    let mut config = scripted_metric_agent_config();
    let lane = &mut config.lanes[0].config;

    match stage_path {
        "rawStage" => {
            lane.raw_stage.settings["timeoutSeconds"] = json!(timeout_seconds);
        }
        "metricStage" => {
            lane.metric_stage.settings["timeoutSeconds"] = json!(timeout_seconds);
        }
        "eventStage" => {
            lane.event_stage.mode = StageMode::Script;
            lane.event_stage.settings = json!({
                "command": "event-cpu",
                "cwd": "/var/lib/lanedeck/stages/event",
                "timeoutSeconds": timeout_seconds,
                "captureStdout": true,
                "captureStderr": true
            });
        }
        _ => unreachable!("known script stage path"),
    }

    config.lanes.remove(0).config
}

fn metric_stage_inputs(runner: &ScriptRunnerProbe) -> Vec<serde_json::Value> {
    runner
        .requests()
        .into_iter()
        .filter(|request| request.purpose == ScriptPurpose::TransformStage)
        .map(|request| request.input.unwrap())
        .collect()
}

fn event_stage_inputs(runner: &ScriptRunnerProbe) -> Vec<serde_json::Value> {
    runner
        .requests()
        .into_iter()
        .filter(|request| request.purpose == ScriptPurpose::TransformStage)
        .filter_map(|request| request.input)
        .filter(|input| input["currentFrame"]["stage"] == "metric")
        .collect()
}

fn restart_prefix(batch_id: &str) -> &str {
    let (prefix, sequence) = batch_id
        .rsplit_once(':')
        .expect("batch id carries restart prefix and sequence");
    assert!(prefix.contains(":runtime-"));
    assert_eq!(sequence, "1");
    prefix
}
