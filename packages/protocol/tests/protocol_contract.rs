use lanedeck_protocol::{
    ProtocolError, StageMode, TriggerKind, parse_frame_json, parse_ingest_batch_json,
    parse_lane_config,
};
use serde_json::json;

fn valid_count_frame() -> serde_json::Value {
    json!({
        "laneId": "lane.test-runtime",
        "stage": "raw",
        "frameNo": 1,
        "openedAt": "2026-06-10T10:00:00.000Z",
        "closedAt": "2026-06-10T10:00:05.000Z",
        "triggerKind": "count",
        "recordCount": 1,
        "records": [
            {
                "id": "record-1",
                "observedAt": "2026-06-10T10:00:01.000Z",
                "body": { "line": "ok" }
            }
        ],
        "summary": {}
    })
}

fn valid_lane_config() -> serde_json::Value {
    json!({
        "laneId": "lane.test-runtime",
        "displayName": "Test Runtime",
        "rawStage": { "mode": "builtin", "settings": {} },
        "metricStage": { "mode": "passthrough", "settings": {} },
        "eventStage": { "mode": "empty", "settings": {} }
    })
}

#[test]
fn accepts_minimal_count_triggered_frame() {
    let frame = parse_frame_json(valid_count_frame()).expect("valid frame");

    assert_eq!(frame.lane_id, "lane.test-runtime");
    assert_eq!(frame.trigger_kind, TriggerKind::Count);
    assert_eq!(frame.record_count, 1);
}

#[test]
fn accepts_time_triggered_empty_frame() {
    let mut value = valid_count_frame();
    value["frameNo"] = json!(2);
    value["triggerKind"] = json!("time");
    value["recordCount"] = json!(0);
    value["records"] = json!([]);

    let frame = parse_frame_json(value).expect("time frame");

    assert_eq!(frame.trigger_kind, TriggerKind::Time);
    assert_eq!(frame.record_count, 0);
    assert!(frame.records.is_empty());
}

#[test]
fn parses_typed_lane_config() {
    let bytes = serde_json::to_vec(&valid_lane_config()).unwrap();

    let config = parse_lane_config(&bytes).expect("valid lane config");

    assert_eq!(config.lane_id, "lane.test-runtime");
    assert_eq!(config.metric_stage.mode, StageMode::Passthrough);
}

#[test]
fn rejects_invalid_lane_config_with_field_diagnostic() {
    let error = parse_lane_config(b"null").expect_err("lane config object required");

    match error {
        ProtocolError::Validation { diagnostics } => {
            assert!(diagnostics.iter().any(|diagnostic| diagnostic.path == "$"));
        }
    }
}

#[test]
fn parses_typed_ingest_batch() {
    let batch = parse_ingest_batch_json(json!({
        "workspaceId": "workspace.local",
        "machineId": "machine.devbox",
        "batchId": "batch-1",
        "frames": [
            valid_count_frame()
        ]
    }))
    .expect("valid ingest batch");

    assert_eq!(batch.workspace_id, "workspace.local");
    assert_eq!(batch.frames.len(), 1);
}

#[test]
fn rejects_invalid_ingest_batch_with_field_diagnostic() {
    let error = parse_ingest_batch_json(json!({
        "workspaceId": "workspace.local",
        "machineId": "machine.devbox",
        "batchId": "batch-1"
    }))
    .expect_err("frames required");

    match error {
        ProtocolError::Validation { diagnostics } => {
            assert!(
                diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.path == "frames")
            );
        }
    }
}

#[test]
fn rejects_missing_required_field_with_field_diagnostic() {
    let mut value = valid_count_frame();
    value.as_object_mut().unwrap().remove("triggerKind");

    let error = parse_frame_json(value).expect_err("missing triggerKind should fail");

    match error {
        ProtocolError::Validation { diagnostics } => {
            assert!(
                diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.path == "triggerKind")
            );
        }
    }
}

#[test]
fn rejects_timestamp_outside_shared_strict_shape() {
    for timestamp in [
        "2026-06-10t10:00:00z",
        "2026-06-10 10:00:00Z",
        "2026-06-10T10:00:60Z",
    ] {
        let mut value = valid_count_frame();
        value["openedAt"] = json!(timestamp);

        let error = parse_frame_json(value).expect_err("timestamp should fail");

        match error {
            ProtocolError::Validation { diagnostics } => {
                assert!(
                    diagnostics
                        .iter()
                        .any(|diagnostic| diagnostic.path == "openedAt")
                );
            }
        }
    }
}

#[test]
fn rejects_record_count_that_differs_from_records_length() {
    let mut value = valid_count_frame();
    value["recordCount"] = json!(0);

    let error = parse_frame_json(value).expect_err("recordCount should match records length");

    match error {
        ProtocolError::Validation { diagnostics } => {
            assert!(
                diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.path == "recordCount")
            );
        }
    }
}
