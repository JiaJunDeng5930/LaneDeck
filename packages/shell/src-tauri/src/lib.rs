use std::{
    env, fs,
    path::{Path, PathBuf},
};

use tauri::http::{Response, StatusCode, header};

pub fn run() {
    register_content_protocol(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("failed to run LaneDeck shell");
}

pub fn register_content_protocol(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.register_uri_scheme_protocol("lanedeck", |_app, request| {
        content_protocol_response(&content_root(), request.uri().path())
    })
}

fn content_root() -> PathBuf {
    env::var_os("LANEDECK_CONTENT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../content/dist"))
}

fn content_protocol_response(root: &Path, request_path: &str) -> Response<Vec<u8>> {
    let candidates = match content_candidates(root, request_path) {
        Ok(candidates) => candidates,
        Err(status) => return plain_response(status, "invalid content path"),
    };

    for path in candidates {
        if let Ok(body) = fs::read(&path) {
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type(&path))
                .body(body)
                .expect("content protocol response is valid");
        }
    }

    plain_response(StatusCode::NOT_FOUND, "content asset not found")
}

fn content_candidates(root: &Path, request_path: &str) -> Result<Vec<PathBuf>, StatusCode> {
    let mut segments = request_path
        .trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty());

    let workspace = safe_segment(segments.next())?;
    let revision = safe_segment(segments.next())?;
    let rest = safe_relative_path(segments)?;

    Ok(vec![
        root.join(&workspace).join(&revision).join(&rest),
        root.join(rest),
    ])
}

fn safe_segment(segment: Option<&str>) -> Result<String, StatusCode> {
    let segment = percent_decode_segment(segment.ok_or(StatusCode::BAD_REQUEST)?)?;
    if segment.is_empty()
        || segment == "."
        || segment == ".."
        || segment.contains('/')
        || segment.contains('\\')
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(segment)
}

fn safe_relative_path<'a>(segments: impl Iterator<Item = &'a str>) -> Result<PathBuf, StatusCode> {
    let mut path = PathBuf::new();
    let mut has_segment = false;
    for segment in segments {
        let safe = safe_segment(Some(segment))?;
        path.push(safe);
        has_segment = true;
    }
    if has_segment {
        Ok(path)
    } else {
        Ok(PathBuf::from("index.html"))
    }
}

fn percent_decode_segment(segment: &str) -> Result<String, StatusCode> {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(StatusCode::BAD_REQUEST);
            }
            let high = hex_value(bytes[index + 1])?;
            let low = hex_value(bytes[index + 2])?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }

    String::from_utf8(decoded).map_err(|_| StatusCode::BAD_REQUEST)
}

fn hex_value(value: u8) -> Result<u8, StatusCode> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err(StatusCode::BAD_REQUEST),
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("css") => "text/css; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn plain_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .expect("content protocol response is valid")
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{content_candidates, content_type};

    #[test]
    fn resolves_workspace_revision_content_and_dist_entry() {
        let root = Path::new("/content-root");

        assert_eq!(
            content_candidates(root, "/workspace.local/rev-1/index.html").unwrap(),
            vec![
                PathBuf::from("/content-root/workspace.local/rev-1/index.html"),
                PathBuf::from("/content-root/index.html"),
            ],
        );
    }

    #[test]
    fn rejects_parent_segments() {
        assert!(content_candidates(Path::new("/content-root"), "/w/r/../x").is_err());
        assert!(content_candidates(Path::new("/content-root"), "/w/r/%2e%2e/x").is_err());
    }

    #[test]
    fn rejects_decoded_separators_and_bad_percent_encoding() {
        assert!(content_candidates(Path::new("/content-root"), "/w/r/assets%2Fapp.js").is_err());
        assert!(content_candidates(Path::new("/content-root"), "/w/r/assets%5Capp.js").is_err());
        assert!(content_candidates(Path::new("/content-root"), "/w/r/assets%zzapp.js").is_err());
    }

    #[test]
    fn maps_common_asset_content_types() {
        assert_eq!(
            content_type(Path::new("assets/app.js")),
            "text/javascript; charset=utf-8",
        );
        assert_eq!(content_type(Path::new("icon.png")), "image/png");
    }
}
