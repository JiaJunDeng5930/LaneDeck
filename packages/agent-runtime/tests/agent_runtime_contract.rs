mod contract_helpers;

use lanedeck_agent_runtime::{
    AgentError, AgentService, ControlMessage, ControlReply, ScriptPurpose, ScriptSideEffectPolicy,
    SpoolEntryId,
};
use serde_json::json;

use contract_helpers::{
    CenterProbe, ScriptRunnerProbe, SpoolProbe, content_root, diagnostic_script_output, duration,
    empty_metric_agent_config, ingest_batch, instant, pending_spool_entry,
    reloaded_script_lane_config, script_lane_agent_config, script_lane_agent_config_with_interval,
    script_output_with_record, script_output_with_records, scripted_metric_agent_config,
    scripted_metric_agent_config_with_upstream_history_limit, successful_script_output,
    two_lane_agent_config, two_record_frame_agent_config, unknown_script_lane_config,
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
    let first_spool = SpoolProbe::default();
    let second_spool = SpoolProbe::default();
    let first_runner =
        ScriptRunnerProbe::with_outputs(vec![script_output_with_record("raw:first", now)]);
    let second_runner =
        ScriptRunnerProbe::with_outputs(vec![script_output_with_record("raw:second", now)]);
    let mut first_service = AgentService::new(
        script_lane_agent_config(),
        CenterProbe::accepting(),
        first_spool.clone(),
        first_runner,
    )
    .unwrap();
    let mut second_service = AgentService::new(
        script_lane_agent_config(),
        CenterProbe::accepting(),
        second_spool.clone(),
        second_runner,
    )
    .unwrap();

    first_service.run_once(now).await.unwrap();
    second_service.run_once(now).await.unwrap();

    let first_batch_id = first_spool.enqueued_batches()[0].batch_id.clone();
    let second_batch_id = second_spool.enqueued_batches()[0].batch_id.clone();
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

fn restart_prefix(batch_id: &str) -> &str {
    let (prefix, sequence) = batch_id
        .rsplit_once(':')
        .expect("batch id carries restart prefix and sequence");
    assert!(prefix.contains(":runtime-"));
    assert_eq!(sequence, "1");
    prefix
}
