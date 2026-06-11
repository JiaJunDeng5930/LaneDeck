mod contract_helpers;

use lanedeck_agent_runtime::{
    AgentService, ControlMessage, ControlReply, ScriptPurpose, ScriptSideEffectPolicy, SpoolEntryId,
};
use serde_json::json;

use contract_helpers::{
    CenterProbe, ScriptRunnerProbe, SpoolProbe, content_root, diagnostic_script_output, duration,
    empty_metric_agent_config, ingest_batch, instant, pending_spool_entry,
    reloaded_script_lane_config, script_lane_agent_config, script_lane_agent_config_with_interval,
    script_output_with_record, script_output_with_records, scripted_metric_agent_config,
    successful_script_output, two_lane_agent_config, two_record_frame_agent_config,
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

#[test]
fn control_messages_accept_camel_case_protocol_fields() {
    let message: ControlMessage = serde_json::from_value(json!({
        "type": "build_content",
        "contentId": "dashboard-main",
        "cwd": "/var/lib/lanedeck/content",
        "command": "build-content"
    }))
    .unwrap();

    match message {
        ControlMessage::BuildContent {
            content_id,
            cwd,
            command,
        } => {
            assert_eq!(content_id, "dashboard-main");
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
        "contentId": "dashboard-main"
    }))
    .unwrap();

    assert_eq!(message, ControlMessage::unknown("future_command"));
}

#[test]
fn malformed_apply_local_change_requires_body() {
    let result = serde_json::from_value::<ControlMessage>(json!({
        "type": "apply_local_change",
        "path": "/var/lib/lanedeck/content/pages/dashboard.json"
    }));

    assert!(result.is_err());
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
            path.clone(),
            json!({"title": "updated dashboard"}),
        ))
        .await
        .unwrap();

    assert_eq!(reply, ControlReply::accepted("apply_local_change"));
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
