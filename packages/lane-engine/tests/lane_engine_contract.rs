mod contract_helpers;

use lanedeck_lane_engine::LaneEngine;
use lanedeck_protocol::{StageKind, TriggerKind};

use contract_helpers::{
    RunnerProbe, StoreProbe, assert_record_ids, assert_same_history, assert_trigger, closed_frame,
    closed_frames, empty_history, frame, instant, metric_empty_lane_config,
    metric_passthrough_lane_config, raw_record, script_lane_config, stage_history, stage_result,
    stage_result_with_diagnostics, successful_stage_diagnostics,
};
use lanedeck_protocol::Diagnostic;

#[test]
fn count_trigger_closes_raw_frame_exactly_when_record_count_reaches_limit() {
    let opened_at = instant(1_700_000_000);
    let second_record_at = instant(1_700_000_003);
    let history = empty_history();
    let store = StoreProbe::new(history);
    let runner = RunnerProbe::scripted(vec![
        stage_result(vec![raw_record("metric:r1+r2", second_record_at)]),
        stage_result(vec![raw_record("event:r1+r2", second_record_at)]),
    ]);
    let mut engine = LaneEngine::new(script_lane_config(2, 60), store, runner.clone()).unwrap();

    let first_effects = engine
        .ingest_raw_record(raw_record("r1", opened_at), opened_at)
        .unwrap();
    assert!(closed_frames(&first_effects).is_empty());
    assert!(runner.invocations().is_empty());

    let effects = engine
        .ingest_raw_record(raw_record("r2", second_record_at), second_record_at)
        .unwrap();
    let raw_frame = closed_frame(&effects, StageKind::Raw);

    assert_trigger(raw_frame, TriggerKind::Count);
    assert_eq!(raw_frame.record_count, 2);
    assert_record_ids(raw_frame, &["r1", "r2"]);

    let invocations = runner.invocations();
    assert_eq!(invocations.len(), 2);
    assert_eq!(invocations[0].current_frame.stage, StageKind::Raw);
    assert_eq!(invocations[1].current_frame.stage, StageKind::Metric);
}

#[test]
fn constructor_rejects_non_positive_frame_limits() {
    assert!(
        LaneEngine::new(
            script_lane_config(0, 60),
            StoreProbe::new(empty_history()),
            RunnerProbe::scripted(Vec::new()),
        )
        .is_err()
    );
    assert!(
        LaneEngine::new(
            script_lane_config(2, 0),
            StoreProbe::new(empty_history()),
            RunnerProbe::scripted(Vec::new()),
        )
        .is_err()
    );
}

#[test]
fn constructor_rejects_frame_seconds_outside_supported_duration_range() {
    let result = LaneEngine::new(
        script_lane_config(2, i64::MAX),
        StoreProbe::new(empty_history()),
        RunnerProbe::scripted(Vec::new()),
    );
    let error = match result {
        Ok(_) => panic!("expected invalid frame max seconds"),
        Err(error) => error,
    };
    let message = error.to_string();

    assert!(message.contains("rawStage.settings.frame.maxSeconds"));
    assert!(message.contains("supported duration"));
}

#[test]
fn time_trigger_closes_empty_raw_frame_and_runs_downstream_stages() {
    let opened_at = instant(1_700_001_000);
    let deadline = opened_at + contract_helpers::seconds(60);
    let store = StoreProbe::new(empty_history());
    let runner = RunnerProbe::scripted(vec![
        stage_result(vec![raw_record("metric:quiet", deadline)]),
        stage_result(vec![raw_record("event:quiet", deadline)]),
    ]);
    let mut engine = LaneEngine::new(script_lane_config(10, 60), store, runner.clone()).unwrap();

    let opening_tick = engine.tick(opened_at).unwrap();
    assert!(closed_frames(&opening_tick).is_empty());

    let effects = engine.tick(deadline).unwrap();
    let raw_frame = closed_frame(&effects, StageKind::Raw);

    assert_trigger(raw_frame, TriggerKind::Time);
    assert_eq!(raw_frame.record_count, 0);
    assert!(raw_frame.records.is_empty());

    let invocations = runner.invocations();
    assert_eq!(invocations.len(), 2);
    assert_eq!(invocations[0].current_frame.stage, StageKind::Raw);
    assert!(invocations[0].current_frame.records.is_empty());
    assert_eq!(invocations[1].current_frame.stage, StageKind::Metric);
}

#[test]
fn metric_stage_receives_current_raw_frame_configured_history_lane_config_and_time() {
    let now = instant(1_700_002_000);
    let raw_frame = frame("raw", "count", vec![raw_record("raw:1", now)], 7, now, now);
    let expected_history = stage_history(
        vec![frame("raw", "count", Vec::new(), 5, now, now)],
        vec![frame("metric", "count", Vec::new(), 5, now, now)],
        vec![frame("event", "count", Vec::new(), 5, now, now)],
    );
    let store = StoreProbe::new(expected_history.clone());
    let store_probe = store.clone();
    let runner = RunnerProbe::scripted(vec![stage_result(vec![raw_record("metric:1", now)])]);
    let mut engine = LaneEngine::new(script_lane_config(10, 60), store, runner.clone()).unwrap();

    let metric_frame = engine.run_metric_stage(raw_frame.clone(), now).unwrap();
    let invocations = runner.invocations();

    assert_eq!(metric_frame.stage, StageKind::Metric);
    assert_eq!(invocations.len(), 1);
    assert_eq!(invocations[0].current_frame, raw_frame);
    assert_same_history(&invocations[0].history, &expected_history);
    assert_eq!(invocations[0].lane.lane_id, "lane.cpu");
    assert_eq!(invocations[0].now, now);
    assert_eq!(store_probe.requests()[0].upstream_frames, 2);
    assert_eq!(store_probe.requests()[0].metric_frames, 2);
    assert_eq!(store_probe.requests()[0].event_frames, 1);
}

#[test]
fn event_stage_receives_current_metric_frame_configured_history_lane_config_and_time() {
    let now = instant(1_700_003_000);
    let metric_frame = frame(
        "metric",
        "count",
        vec![raw_record("metric:1", now)],
        8,
        now,
        now,
    );
    let expected_history = stage_history(
        vec![frame("raw", "time", Vec::new(), 6, now, now)],
        vec![frame("metric", "count", Vec::new(), 6, now, now)],
        vec![frame("event", "count", Vec::new(), 6, now, now)],
    );
    let store = StoreProbe::new(expected_history.clone());
    let store_probe = store.clone();
    let runner = RunnerProbe::scripted(vec![stage_result(vec![raw_record("event:1", now)])]);
    let mut engine = LaneEngine::new(script_lane_config(10, 60), store, runner.clone()).unwrap();

    let event_frame = engine.run_event_stage(metric_frame.clone(), now).unwrap();
    let invocations = runner.invocations();

    assert_eq!(event_frame.stage, StageKind::Event);
    assert_eq!(invocations.len(), 1);
    assert_eq!(invocations[0].current_frame, metric_frame);
    assert_same_history(&invocations[0].history, &expected_history);
    assert_eq!(invocations[0].lane.lane_id, "lane.cpu");
    assert_eq!(invocations[0].now, now);
    assert_eq!(store_probe.requests()[0].upstream_frames, 1);
    assert_eq!(store_probe.requests()[0].metric_frames, 2);
    assert_eq!(store_probe.requests()[0].event_frames, 2);
}

#[test]
fn passthrough_mode_copies_upstream_records_inside_the_engine() {
    let now = instant(1_700_004_000);
    let raw_frame = frame(
        "raw",
        "count",
        vec![raw_record("raw:1", now), raw_record("raw:2", now)],
        9,
        now,
        now,
    );
    let store = StoreProbe::new(empty_history());
    let runner = RunnerProbe::scripted(Vec::new());
    let mut engine =
        LaneEngine::new(metric_passthrough_lane_config(), store, runner.clone()).unwrap();

    let metric_frame = engine.run_metric_stage(raw_frame.clone(), now).unwrap();

    assert!(runner.invocations().is_empty());
    assert_eq!(metric_frame.stage, StageKind::Metric);
    assert_eq!(metric_frame.record_count, 2);
    assert_eq!(metric_frame.records, raw_frame.records);
}

#[test]
fn empty_mode_produces_zero_records_and_success_diagnostic() {
    let now = instant(1_700_005_000);
    let raw_frame = frame(
        "raw",
        "time",
        vec![raw_record("raw:quiet", now)],
        10,
        now,
        now,
    );
    let store = StoreProbe::new(empty_history());
    let runner = RunnerProbe::scripted(Vec::new());
    let mut engine = LaneEngine::new(metric_empty_lane_config(), store, runner.clone()).unwrap();

    let metric_frame = engine.run_metric_stage(raw_frame, now).unwrap();
    let effects = engine.drain_effects();

    assert!(runner.invocations().is_empty());
    assert_eq!(metric_frame.stage, StageKind::Metric);
    assert_eq!(metric_frame.record_count, 0);
    assert!(metric_frame.records.is_empty());
    assert_eq!(
        successful_stage_diagnostics(&effects, StageKind::Metric).len(),
        1
    );
}

#[test]
fn script_stage_diagnostics_are_emitted_as_engine_effects() {
    let now = instant(1_700_006_000);
    let raw_frame = frame("raw", "count", vec![raw_record("raw:1", now)], 11, now, now);
    let diagnostic = Diagnostic {
        path: "metricStage.script".to_string(),
        message: "slow metric stage".to_string(),
    };
    let store = StoreProbe::new(empty_history());
    let runner = RunnerProbe::scripted(vec![stage_result_with_diagnostics(
        vec![raw_record("metric:1", now)],
        vec![diagnostic.clone()],
    )]);
    let mut engine = LaneEngine::new(script_lane_config(10, 60), store, runner).unwrap();

    let metric_frame = engine.run_metric_stage(raw_frame, now).unwrap();
    let effects = engine.drain_effects();

    assert_eq!(metric_frame.record_count, 1);
    assert_eq!(
        successful_stage_diagnostics(&effects, StageKind::Metric),
        vec![&diagnostic]
    );
}

#[test]
fn failed_downstream_stage_does_not_leak_partial_effects() {
    let opened_at = instant(1_700_007_000);
    let second_record_at = instant(1_700_007_003);
    let store = StoreProbe::new(empty_history());
    let runner = RunnerProbe::scripted_results(vec![Err("metric exploded".to_string())]);
    let mut engine = LaneEngine::new(script_lane_config(2, 60), store, runner).unwrap();

    engine
        .ingest_raw_record(raw_record("r1", opened_at), opened_at)
        .unwrap();
    let result = engine.ingest_raw_record(raw_record("r2", second_record_at), second_record_at);

    assert!(result.is_err());
    assert!(engine.drain_effects().is_empty());
}

#[test]
fn metric_history_is_loaded_after_metric_frame_persistence() {
    let opened_at = instant(1_700_008_000);
    let second_record_at = instant(1_700_008_003);
    let store = StoreProbe::recording(empty_history());
    let runner = RunnerProbe::scripted(vec![
        stage_result(vec![raw_record("metric:r1+r2", second_record_at)]),
        stage_result(vec![raw_record("event:r1+r2", second_record_at)]),
    ]);
    let mut engine = LaneEngine::new(script_lane_config(2, 60), store, runner.clone()).unwrap();

    engine
        .ingest_raw_record(raw_record("r1", opened_at), opened_at)
        .unwrap();
    engine
        .ingest_raw_record(raw_record("r2", second_record_at), second_record_at)
        .unwrap();

    let invocations = runner.invocations();
    assert!(invocations[0].history.upstream_frames.is_empty());
    assert_eq!(invocations[1].history.metric_frames.len(), 1);
    assert_record_ids(&invocations[1].history.metric_frames[0], &["metric:r1+r2"]);
}

#[test]
fn failed_closure_keeps_raw_records_for_next_attempt() {
    let opened_at = instant(1_700_009_000);
    let second_record_at = instant(1_700_009_003);
    let retry_record_at = instant(1_700_009_006);
    let store = StoreProbe::new(empty_history());
    let runner = RunnerProbe::scripted_results(vec![
        Err("metric exploded".to_string()),
        Ok(stage_result(vec![raw_record(
            "metric:retry",
            retry_record_at,
        )])),
        Ok(stage_result(vec![raw_record(
            "event:retry",
            retry_record_at,
        )])),
    ]);
    let mut engine = LaneEngine::new(script_lane_config(2, 60), store, runner).unwrap();

    engine
        .ingest_raw_record(raw_record("r1", opened_at), opened_at)
        .unwrap();
    assert!(
        engine
            .ingest_raw_record(raw_record("r2", second_record_at), second_record_at)
            .is_err()
    );

    let effects = engine
        .ingest_raw_record(raw_record("r3", retry_record_at), retry_record_at)
        .unwrap();
    let raw_frame = closed_frame(&effects, StageKind::Raw);

    assert_eq!(raw_frame.frame_no, 1);
    assert_record_ids(raw_frame, &["r1", "r2"]);
    assert_trigger(raw_frame, TriggerKind::Count);
    assert_eq!(raw_frame.closed_at, second_record_at);
}

#[test]
fn failed_time_closure_is_retried_before_new_record_is_accepted() {
    let opened_at = instant(1_700_009_100);
    let deadline = opened_at + contract_helpers::seconds(60);
    let retry_record_at = instant(1_700_009_163);
    let second_new_record_at = instant(1_700_009_164);
    let store = StoreProbe::new(empty_history());
    let runner = RunnerProbe::scripted_results(vec![
        Err("metric exploded".to_string()),
        Ok(stage_result(vec![raw_record(
            "metric:retry-time",
            retry_record_at,
        )])),
        Ok(stage_result(vec![raw_record(
            "event:retry-time",
            retry_record_at,
        )])),
        Ok(stage_result(vec![raw_record(
            "metric:new-count",
            second_new_record_at,
        )])),
        Ok(stage_result(vec![raw_record(
            "event:new-count",
            second_new_record_at,
        )])),
    ]);
    let mut engine = LaneEngine::new(script_lane_config(2, 60), store, runner).unwrap();

    engine
        .ingest_raw_record(raw_record("r1", opened_at), opened_at)
        .unwrap();
    assert!(engine.tick(deadline).is_err());

    let retry_effects = engine
        .ingest_raw_record(raw_record("r2", retry_record_at), retry_record_at)
        .unwrap();
    let retried_frame = closed_frame(&retry_effects, StageKind::Raw);

    assert_record_ids(retried_frame, &["r1"]);
    assert_trigger(retried_frame, TriggerKind::Time);
    assert_eq!(retried_frame.closed_at, deadline);

    let next_effects = engine
        .ingest_raw_record(raw_record("r3", second_new_record_at), second_new_record_at)
        .unwrap();
    let next_frame = closed_frame(&next_effects, StageKind::Raw);

    assert_record_ids(next_frame, &["r2", "r3"]);
    assert_trigger(next_frame, TriggerKind::Count);
}

#[test]
fn failed_count_closure_is_retried_as_count_on_later_tick() {
    let opened_at = instant(1_700_009_200);
    let second_record_at = instant(1_700_009_203);
    let later_tick = instant(1_700_009_300);
    let store = StoreProbe::new(empty_history());
    let runner = RunnerProbe::scripted_results(vec![
        Err("metric exploded".to_string()),
        Ok(stage_result(vec![raw_record(
            "metric:retry-count",
            later_tick,
        )])),
        Ok(stage_result(vec![raw_record(
            "event:retry-count",
            later_tick,
        )])),
    ]);
    let mut engine = LaneEngine::new(script_lane_config(2, 60), store, runner).unwrap();

    engine
        .ingest_raw_record(raw_record("r1", opened_at), opened_at)
        .unwrap();
    assert!(
        engine
            .ingest_raw_record(raw_record("r2", second_record_at), second_record_at)
            .is_err()
    );

    let effects = engine.tick(later_tick).unwrap();
    let raw_frame = closed_frame(&effects, StageKind::Raw);

    assert_record_ids(raw_frame, &["r1", "r2"]);
    assert_trigger(raw_frame, TriggerKind::Count);
    assert_eq!(raw_frame.closed_at, second_record_at);
}

#[test]
fn replace_config_rejects_lane_identity_change_and_retains_existing_state() {
    let opened_at = instant(1_700_009_300);
    let second_record_at = instant(1_700_009_303);
    let store = StoreProbe::new(empty_history());
    let runner = RunnerProbe::scripted(vec![
        stage_result(vec![raw_record("metric:identity", second_record_at)]),
        stage_result(vec![raw_record("event:identity", second_record_at)]),
    ]);
    let mut engine = LaneEngine::new(script_lane_config(2, 60), store, runner).unwrap();

    engine
        .ingest_raw_record(raw_record("r1", opened_at), opened_at)
        .unwrap();
    let mut replacement = script_lane_config(2, 60);
    replacement.lane_id = "lane.mem".to_string();
    let error = match engine.replace_config(replacement) {
        Ok(_) => panic!("expected lane identity rejection"),
        Err(error) => error,
    };
    let effects = engine
        .ingest_raw_record(raw_record("r2", second_record_at), second_record_at)
        .unwrap();
    let raw_frame = closed_frame(&effects, StageKind::Raw);

    assert!(error.to_string().contains("laneId"));
    assert_eq!(raw_frame.lane_id, "lane.cpu");
    assert_eq!(raw_frame.frame_no, 1);
    assert_record_ids(raw_frame, &["r1", "r2"]);
}

#[test]
fn event_failure_preserves_persisted_raw_and_metric_for_event_retry() {
    let opened_at = instant(1_700_010_000);
    let second_record_at = instant(1_700_010_003);
    let retry_record_at = instant(1_700_010_006);
    let store = StoreProbe::recording(empty_history());
    let store_probe = store.clone();
    let runner = RunnerProbe::scripted_results(vec![
        Ok(stage_result(vec![raw_record(
            "metric:first",
            second_record_at,
        )])),
        Err("event exploded".to_string()),
        Ok(stage_result(vec![raw_record(
            "event:retry",
            retry_record_at,
        )])),
    ]);
    let mut engine = LaneEngine::new(script_lane_config(2, 60), store, runner.clone()).unwrap();

    engine
        .ingest_raw_record(raw_record("r1", opened_at), opened_at)
        .unwrap();
    assert!(
        engine
            .ingest_raw_record(raw_record("r2", second_record_at), second_record_at)
            .is_err()
    );
    assert!(engine.drain_effects().is_empty());
    let persisted_after_failure = store_probe.appended_frames();
    assert_eq!(persisted_after_failure.len(), 2);
    assert_eq!(persisted_after_failure[0].stage, StageKind::Raw);
    assert_eq!(persisted_after_failure[1].stage, StageKind::Metric);
    assert_record_ids(&persisted_after_failure[0], &["r1", "r2"]);
    assert_record_ids(&persisted_after_failure[1], &["metric:first"]);

    let effects = engine
        .ingest_raw_record(raw_record("r3", retry_record_at), retry_record_at)
        .unwrap();
    let raw_frame = closed_frame(&effects, StageKind::Raw);
    let invocations = runner.invocations();
    let persisted_after_retry = store_probe.appended_frames();

    assert_record_ids(raw_frame, &["r1", "r2"]);
    assert_eq!(invocations.len(), 3);
    assert_eq!(invocations[0].current_frame.stage, StageKind::Raw);
    assert_eq!(invocations[1].current_frame.stage, StageKind::Metric);
    assert_eq!(invocations[2].current_frame.stage, StageKind::Metric);
    assert_record_ids(&invocations[2].current_frame, &["metric:first"]);
    assert_record_ids(&invocations[2].history.metric_frames[0], &["metric:first"]);
    assert_eq!(persisted_after_retry.len(), 3);
    assert_eq!(persisted_after_retry[2].stage, StageKind::Event);
}

#[test]
fn metric_persist_failure_retries_metric_frame_without_rerunning_metric_stage() {
    let opened_at = instant(1_700_010_100);
    let second_record_at = instant(1_700_010_103);
    let retry_record_at = instant(1_700_010_106);
    let store = StoreProbe::with_append_results(
        empty_history(),
        vec![
            Ok(()),
            Err("metric write failed".to_string()),
            Ok(()),
            Ok(()),
        ],
    );
    let store_probe = store.clone();
    let runner = RunnerProbe::scripted_results(vec![
        Ok(stage_result(vec![raw_record(
            "metric:first",
            second_record_at,
        )])),
        Ok(stage_result(vec![raw_record(
            "event:retry",
            retry_record_at,
        )])),
    ]);
    let mut engine = LaneEngine::new(script_lane_config(2, 60), store, runner.clone()).unwrap();

    engine
        .ingest_raw_record(raw_record("r1", opened_at), opened_at)
        .unwrap();
    assert!(
        engine
            .ingest_raw_record(raw_record("r2", second_record_at), second_record_at)
            .is_err()
    );
    assert!(engine.drain_effects().is_empty());
    let persisted_after_failure = store_probe.appended_frames();
    assert_eq!(persisted_after_failure.len(), 1);
    assert_eq!(persisted_after_failure[0].stage, StageKind::Raw);

    let effects = engine
        .ingest_raw_record(raw_record("r3", retry_record_at), retry_record_at)
        .unwrap();
    let raw_frame = closed_frame(&effects, StageKind::Raw);
    let invocations = runner.invocations();
    let persisted_after_retry = store_probe.appended_frames();

    assert_record_ids(raw_frame, &["r1", "r2"]);
    assert_eq!(invocations.len(), 2);
    assert_eq!(invocations[0].current_frame.stage, StageKind::Raw);
    assert_eq!(invocations[1].current_frame.stage, StageKind::Metric);
    assert_record_ids(&invocations[1].current_frame, &["metric:first"]);
    assert_eq!(persisted_after_retry.len(), 3);
    assert_eq!(persisted_after_retry[1].stage, StageKind::Metric);
    assert_eq!(persisted_after_retry[2].stage, StageKind::Event);
}
