use lanedeck_protocol::{ProtocolError, TriggerKind, parse_frame_json};
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
