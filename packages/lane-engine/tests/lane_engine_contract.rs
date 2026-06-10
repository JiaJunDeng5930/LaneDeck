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
fn current_frames_are_not_loaded_into_their_own_stage_history() {
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
    assert!(invocations[1].history.metric_frames.is_empty());
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
    assert_record_ids(raw_frame, &["r1", "r2", "r3"]);
}
