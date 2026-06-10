use tauri::http::{Response, StatusCode};

pub fn run() {
    register_content_protocol(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("failed to run LaneDeck shell");
}

pub fn register_content_protocol(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.register_uri_scheme_protocol("lanedeck", |_app, request| {
        let path = request.uri().path().trim_start_matches('/');
        let escaped_path = escape_attribute(path);
        let body = format!(
            r#"<!doctype html><meta charset="utf-8"><div id="lanedeck-content-root" data-content-path="{escaped_path}"></div>"#
        );

        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/html; charset=utf-8")
            .body(body.into_bytes())
            .expect("content protocol response is valid")
    })
}

fn escape_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
