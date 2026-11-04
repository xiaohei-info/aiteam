//! Static server for plain sites and single HTML pages (workbench plan §4.2). It serves one
//! folder on a loopback port: GET/HEAD only, no hidden paths, no symlinks, no credential-like
//! files, and only to requests addressed to the loopback host, which keeps DNS-rebinding pages
//! from reading the project.
use crate::agent_projects::is_sensitive_file;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const MAX_HEADER_BYTES: u64 = 32 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(15);

/// Stops serving and frees the port when dropped.
pub struct StaticServer {
    root: PathBuf,
    port: u16,
    stop: Arc<AtomicBool>,
}

impl StaticServer {
    pub fn start(root: &Path) -> Result<Self, String> {
        let root = root.canonicalize().map_err(|_| "project_not_found")?;
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "server_failed")?;
        let port = listener.local_addr().map_err(|_| "server_failed")?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let (flag, served) = (stop.clone(), root.clone());
        std::thread::Builder::new()
            .name("aifred-project-static".into())
            .spawn(move || {
                for stream in listener.incoming() {
                    if flag.load(Ordering::SeqCst) {
                        break;
                    }
                    if let Ok(stream) = stream {
                        let root = served.clone();
                        std::thread::spawn(move || handle(stream, &root, port));
                    }
                }
            })
            .map_err(|_| "server_failed")?;
        Ok(Self { root, port, stop })
    }

    /// The served folder, canonicalized.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for StaticServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the blocking accept so the thread sees the flag and closes the port.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Response {
    File(PathBuf),
    Redirect(String),
    Status(u16, &'static str),
}

const NOT_FOUND: Response = Response::Status(404, "Not Found");

fn handle(stream: TcpStream, root: &Path, port: u16) {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let Ok(input) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(input.take(MAX_HEADER_BYTES));
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let mut host = None;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("host") {
                host = Some(value.trim().to_ascii_lowercase());
            }
        }
    }
    let mut parts = request_line.split_whitespace();
    let (method, response) = match (parts.next(), parts.next()) {
        (Some(method), Some(target)) => {
            (method, route(method, target, host.as_deref(), root, port))
        }
        _ => ("GET", Response::Status(400, "Bad Request")),
    };
    respond(stream, method, response);
}

fn route(method: &str, target: &str, host: Option<&str>, root: &Path, port: u16) -> Response {
    let allowed = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    if !host.is_some_and(|host| allowed.iter().any(|name| name == host)) {
        return Response::Status(421, "Misdirected Request");
    }
    if method != "GET" && method != "HEAD" {
        return Response::Status(405, "Method Not Allowed");
    }
    let path = target.split(['?', '#']).next().unwrap_or_default();
    match path.strip_prefix('/').and_then(percent_decode) {
        Some(path) => resolve(root, &path),
        None => Response::Status(400, "Bad Request"),
    }
}

/// The file for a decoded request path; folders serve their `index.html`.
fn resolve(root: &Path, path: &str) -> Response {
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    let mut current = root.to_path_buf();
    for segment in &segments {
        // `.` and `..` start with a dot; `\` and `:` could name another folder on Windows.
        if segment.starts_with('.') || segment.contains(['\\', ':', '\0']) {
            return NOT_FOUND;
        }
        current.push(segment);
        let plain = std::fs::symlink_metadata(&current).is_ok_and(|meta| !meta.is_symlink());
        if !plain {
            return NOT_FOUND;
        }
    }
    if std::fs::symlink_metadata(&current).is_ok_and(|meta| meta.is_dir()) {
        // Relative links in the page resolve against the folder only with a trailing slash.
        if !segments.is_empty() && !path.ends_with('/') {
            return Response::Redirect(format!("/{}/", encode_path(path)));
        }
        current.push("index.html");
    }
    let is_file = std::fs::symlink_metadata(&current).is_ok_and(|meta| meta.is_file());
    let name = current
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !is_file || is_sensitive_file(name) || !current.starts_with(root) {
        return NOT_FOUND;
    }
    Response::File(current)
}

fn header(
    status: u16,
    reason: &str,
    content_type: &str,
    length: u64,
    extra: &[(&str, &str)],
) -> String {
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n"
    );
    for (name, value) in extra {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    head
}

fn respond(mut stream: TcpStream, method: &str, response: Response) {
    const TEXT: &str = "text/plain; charset=utf-8";
    let with_body = method != "HEAD";
    let (head, body): (String, &[u8]) = match response {
        Response::File(path) => {
            let opened = File::open(&path).and_then(|file| Ok((file.metadata()?.len(), file)));
            let Ok((length, mut file)) = opened else {
                return respond(stream, method, NOT_FOUND);
            };
            let head = header(200, "OK", content_type(&path), length, &[]);
            if stream.write_all(head.as_bytes()).is_ok() && with_body {
                let _ = std::io::copy(&mut file, &mut stream);
            }
            let _ = stream.flush();
            return;
        }
        Response::Redirect(location) => (
            header(
                301,
                "Moved Permanently",
                TEXT,
                0,
                &[("Location", &location)],
            ),
            b"",
        ),
        Response::Status(status, reason) => {
            let allow: &[(&str, &str)] = if status == 405 {
                &[("Allow", "GET, HEAD")]
            } else {
                &[]
            };
            (
                header(status, reason, TEXT, reason.len() as u64, allow),
                reason.as_bytes(),
            )
        }
    };
    let _ = stream.write_all(head.as_bytes());
    if with_body {
        let _ = stream.write_all(body);
    }
    let _ = stream.flush();
}

fn content_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Strict percent decoding to UTF-8; malformed escapes are rejected.
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .filter(|hex| hex.iter().all(u8::is_ascii_hexdigit))?;
            output.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

/// A relative path as a URL path, each segment percent-encoded; empty segments are dropped.
pub(super) fn encode_path(path: &str) -> String {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            segment
                .bytes()
                .map(|byte| {
                    if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                        (byte as char).to_string()
                    } else {
                        format!("%{byte:02X}")
                    }
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site(tag: &str, files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "aiteam-static-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for (name, text) in files {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn raw(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn request(port: u16, method: &str, target: &str) -> String {
        raw(
            port,
            &format!("{method} {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
        )
    }

    fn status(response: &str) -> &str {
        response.lines().next().unwrap_or_default()
    }

    #[test]
    fn serves_the_site_with_types_index_pages_and_folder_redirects() {
        let parent = site("parent", &[("secret.txt", "outside")]);
        let root = parent.join("site");
        for (name, text) in [
            ("index.html", "<h1>home</h1>"),
            ("js/app.js", "start()"),
            ("中文.html", "<p>zh</p>"),
            ("evil.com/index.html", "<p>nested</p>"),
        ] {
            std::fs::create_dir_all(root.join(name).parent().unwrap()).unwrap();
            std::fs::write(root.join(name), text).unwrap();
        }
        let server = StaticServer::start(&root).unwrap();
        let port = server.port();

        let home = request(port, "GET", "/?v=1");
        assert_eq!(status(&home), "HTTP/1.1 200 OK");
        assert!(home.contains("Content-Type: text/html; charset=utf-8"));
        assert!(home.contains("Cache-Control: no-store"));
        assert!(home.ends_with("<h1>home</h1>"));
        assert!(request(port, "GET", "/js/app.js").contains("text/javascript"));
        assert!(
            request(port, "GET", &format!("/{}", encode_path("中文.html"))).ends_with("<p>zh</p>")
        );
        let head = request(port, "HEAD", "/");
        assert!(head.contains("Content-Length: 13") && head.ends_with("\r\n\r\n"));

        let folder = request(port, "GET", "/js");
        assert_eq!(status(&folder), "HTTP/1.1 301 Moved Permanently");
        assert!(folder.contains("Location: /js/\r\n"));
        // A doubled slash must not become a protocol-relative redirect to another host.
        assert!(request(port, "GET", "//evil.com").contains("Location: /evil.com/\r\n"));
        assert_eq!(
            status(&request(port, "GET", "/js/")),
            "HTTP/1.1 404 Not Found"
        );
        drop(server);
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn refuses_traversal_hidden_sensitive_and_linked_paths() {
        let parent = site("refuse-parent", &[("secret.txt", "outside")]);
        let root = parent.join("site");
        for (name, text) in [
            ("index.html", "x"),
            (".env", "TOKEN=1"),
            (".git/config", "[core]"),
            ("secrets.json", "{}"),
            ("server.pem", "key"),
        ] {
            std::fs::create_dir_all(root.join(name).parent().unwrap()).unwrap();
            std::fs::write(root.join(name), text).unwrap();
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(parent.join("secret.txt"), root.join("link.txt")).unwrap();
            std::os::unix::fs::symlink(&parent, root.join("linked")).unwrap();
        }
        let server = StaticServer::start(&root).unwrap();
        let port = server.port();
        for target in [
            "/../secret.txt",
            "/%2e%2e/secret.txt",
            "/%2E%2E%2Fsecret.txt",
            "/.env",
            "/.git/config",
            "/secrets.json",
            "/server.pem",
            "/link.txt",
            "/linked/secret.txt",
            "/missing.html",
            "/a%5C..%5Csecret.txt",
        ] {
            assert_eq!(
                status(&request(port, "GET", target)),
                "HTTP/1.1 404 Not Found",
                "{target}"
            );
        }
        assert_eq!(
            status(&request(port, "GET", "/%zz")),
            "HTTP/1.1 400 Bad Request"
        );
        let post = request(port, "POST", "/");
        assert_eq!(status(&post), "HTTP/1.1 405 Method Not Allowed");
        assert!(post.contains("Allow: GET, HEAD"));
        // DNS rebinding: a page on another host name must not read the project.
        for host in ["evil.example", "127.0.0.1:1", ""] {
            let response = raw(port, &format!("GET / HTTP/1.1\r\nHost: {host}\r\n\r\n"));
            assert_eq!(status(&response), "HTTP/1.1 421 Misdirected Request");
        }
        assert_eq!(
            status(&raw(
                port,
                &format!("GET / HTTP/1.1\r\nHost: LOCALHOST:{port}\r\n\r\n")
            )),
            "HTTP/1.1 200 OK"
        );
        drop(server);
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn dropping_the_server_frees_its_port() {
        let root = site("drop", &[("index.html", "x")]);
        let server = StaticServer::start(&root).unwrap();
        let port = server.port();
        assert_eq!(status(&request(port, "GET", "/")), "HTTP/1.1 200 OK");
        drop(server);
        let closed = (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            TcpStream::connect(("127.0.0.1", port)).is_err()
        });
        assert!(closed, "the port should close after the server is dropped");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
