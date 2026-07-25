//! An RFC-9111-subset disk cache for remote `<Image>` sources (plan D5/D10).
//!
//! Layout under `<smudgy_home>/cache/images/`:
//! - `meta/<server>/<sha256(url)>.json` — freshness + validators, namespaced per server so
//!   a server's cache can be cleared/counted independently (PR4).
//! - `blobs/<h0:2>/<h2:4>/<sha256(body)>` — encoded bytes, content-addressed and **shared**
//!   across servers (two servers caching the same URL store one body).
//!
//! Semantics implemented: `Cache-Control: max-age` > `Expires` > a Last-Modified heuristic
//! (10% of age, capped 24h); `no-store` never persists; stale entries revalidate with
//! `If-None-Match`/`If-Modified-Since` (304 refreshes metadata); **stale-if-error** serves a
//! stale copy when the network fails. Redirects are followed manually so each hop's host is
//! re-validated against a sandboxed package's `net` grants.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use smudgy_cloud::image_source::NetGrants;
use smudgy_widgets::FetchError;
use url::Url;

use super::MAX_BODY_BYTES;

/// Max redirect hops before giving up (matches the plan's cap).
const MAX_REDIRECTS: usize = 10;
/// Heuristic-freshness ceiling when only `Last-Modified` is available.
const HEURISTIC_MAX: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone)]
pub struct HttpImageCache {
    root: PathBuf,
}

/// Per-URL cache metadata (one file per `(server, url)`).
#[derive(Debug, Serialize, Deserialize)]
struct Meta {
    url: String,
    /// SHA-256 hex of the stored body (the blob filename).
    content_hash: String,
    /// Seconds since the Unix epoch when the response was stored.
    fetched_at: u64,
    /// Freshness lifetime in seconds (from max-age/Expires/heuristic); `None` = must
    /// revalidate every use.
    fresh_for: Option<u64>,
    etag: Option<String>,
    last_modified: Option<String>,
}

impl HttpImageCache {
    #[must_use]
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn meta_path(&self, server: &str, url: &Url) -> PathBuf {
        self.root
            .join("meta")
            .join(sanitize_segment(server))
            .join(format!("{}.json", hex(url.as_str().as_bytes())))
    }

    fn blob_path(&self, content_hash: &str) -> PathBuf {
        let (a, b) = (&content_hash[0..2], &content_hash[2..4]);
        self.root.join("blobs").join(a).join(b).join(content_hash)
    }

    fn read_meta(&self, server: &str, url: &Url) -> Option<Meta> {
        let raw = std::fs::read(self.meta_path(server, url)).ok()?;
        serde_json::from_slice(&raw).ok()
    }

    fn read_blob(&self, content_hash: &str) -> Option<Vec<u8>> {
        std::fs::read(self.blob_path(content_hash)).ok()
    }

    fn write_entry(&self, server: &str, url: &Url, meta: &Meta, body: &[u8]) {
        let blob = self.blob_path(&meta.content_hash);
        if let Some(parent) = blob.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Atomic-ish: temp + rename, so a concurrent reader never sees a half-written blob.
        // Content-addressed: an existing blob IS the bytes — skip the rewrite. And never
        // write the meta unless its blob landed (a meta pointing at nothing would steer
        // later requests into conditional GETs they can't satisfy).
        let blob_ok = blob.exists() || write_atomic(&blob, body);
        if !blob_ok {
            return;
        }
        let meta_path = self.meta_path(server, url);
        if let Some(parent) = meta_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_vec(meta) {
            let _ = write_atomic(&meta_path, &json);
        }
    }

    /// Fetch `url` for `server`, honoring the disk cache. `grants` is `Some` for sandboxed
    /// isolates (each redirect hop's host is re-validated against it); `None` for trusted.
    pub async fn fetch(
        &self,
        client: &reqwest::Client,
        url: &Url,
        server: &str,
        grants: Option<&NetGrants>,
    ) -> Result<Vec<u8>, FetchError> {
        // Read meta AND blob up front: a meta whose blob is gone (partial write, external
        // cleanup) must not steer this request — a conditional GET would 304 into a state
        // with no body to serve, unrecoverably. Dropping the orphaned meta makes the
        // request unconditional, and the 200 rewrites both files (self-heals).
        let (cached, cached_body) = match self.read_meta(server, url) {
            Some(meta) => match self.read_blob(&meta.content_hash) {
                Some(body) => (Some(meta), Some(body)),
                None => {
                    let _ = std::fs::remove_file(self.meta_path(server, url));
                    (None, None)
                }
            },
            None => (None, None),
        };

        // Fresh hit: serve the blob without touching the network.
        if let (Some(meta), Some(body)) = (&cached, &cached_body)
            && is_fresh(meta)
        {
            return Ok(body.clone());
        }

        // Stale or absent: (conditionally) fetch. Validators are only sent when the body
        // they validate is in hand.
        let conditional = match (&cached, &cached_body) {
            (Some(meta), Some(_)) => Some(Conditional {
                etag: meta.etag.clone(),
                last_modified: meta.last_modified.clone(),
            }),
            _ => None,
        };
        match fetch_following_redirects(client, url, grants, conditional).await {
            Ok(Outcome::NotModified { freshness }) => {
                // 304: reuse the stored blob; refresh the metadata from now, adopting any
                // new lifetime/validators the 304 carried (RFC 9111 §4.3.4).
                if let (Some(mut meta), Some(bytes)) = (cached, cached_body) {
                    meta.fetched_at = now_secs();
                    if freshness.fresh_for.is_some() {
                        meta.fresh_for = freshness.fresh_for;
                    }
                    if freshness.etag.is_some() {
                        meta.etag = freshness.etag;
                    }
                    if freshness.last_modified.is_some() {
                        meta.last_modified = freshness.last_modified;
                    }
                    self.write_entry(server, url, &meta, &bytes);
                    return Ok(bytes);
                }
                // Unreachable by construction (no conditionals without a body) — but a
                // broken origin can 304 an unconditional request; treat as transient.
                Err(FetchError::transient(
                    "server said 304 to an unconditional request",
                ))
            }
            Ok(Outcome::Fetched {
                body,
                store,
                freshness,
            }) => {
                if store {
                    let meta = Meta {
                        url: url.to_string(),
                        content_hash: hex(&Sha256::digest(&body)),
                        fetched_at: now_secs(),
                        fresh_for: freshness.fresh_for,
                        etag: freshness.etag,
                        last_modified: freshness.last_modified,
                    };
                    self.write_entry(server, url, &meta, &body);
                }
                Ok(body)
            }
            Err(err) => {
                // stale-if-error, for *transient* failures only (network gone, 5xx): a
                // client that plays offline should keep showing the image. Permanent
                // failures (policy denial, 4xx) must not resurrect a stale copy.
                if err.transient && let Some(bytes) = cached_body {
                    log::warn!(
                        "smudgy images: {url} fetch failed ({}); serving stale copy",
                        err.reason
                    );
                    return Ok(bytes);
                }
                Err(err)
            }
        }
    }
}

/// Fetch with no disk cache (home dir unavailable): still policy-checks redirect hops.
pub async fn fetch_uncached(
    client: &reqwest::Client,
    url: &Url,
    grants: Option<&NetGrants>,
) -> Result<Vec<u8>, FetchError> {
    match fetch_following_redirects(client, url, grants, None).await? {
        Outcome::Fetched { body, .. } => Ok(body),
        Outcome::NotModified { .. } => Err(FetchError::transient(
            "unexpected 304 without a conditional request",
        )),
    }
}

struct Conditional {
    etag: Option<String>,
    last_modified: Option<String>,
}

struct Freshness {
    fresh_for: Option<u64>,
    etag: Option<String>,
    last_modified: Option<String>,
    /// `false` when `Cache-Control: no-store` forbids persisting.
    store: bool,
}

enum Outcome {
    /// A 304, with whatever freshness/validators its headers carried (RFC 9111 §4.3.4:
    /// stored metadata is refreshed from them).
    NotModified { freshness: Freshness },
    Fetched {
        body: Vec<u8>,
        store: bool,
        freshness: Freshness,
    },
}

/// Follow redirects manually, re-validating each hop's host against `grants` (a shared
/// reqwest redirect policy can't carry per-package state). Returns the terminal response's
/// body + freshness, or `NotModified` on a 304.
///
/// Error kinds: transport failures and 5xx/408/429 are transient (a retry could succeed);
/// permission denials, other 4xx, malformed redirects, and the size cap are permanent.
async fn fetch_following_redirects(
    client: &reqwest::Client,
    url: &Url,
    grants: Option<&NetGrants>,
    conditional: Option<Conditional>,
) -> Result<Outcome, FetchError> {
    let mut current = url.clone();
    for _hop in 0..=MAX_REDIRECTS {
        if let Some(grants) = grants
            && !grants.allows_url(&current)
        {
            return Err(FetchError::permanent(format!(
                "{} is not covered by this package's net permission",
                current.host_str().unwrap_or("?")
            )));
        }
        let mut req = client.get(current.clone());
        // Validators belong to the stored resource — the *original* URL. A redirect
        // target is a different resource: sending it our ETag both leaks cache state
        // cross-host and invites a bogus 304.
        if current == *url && let Some(cond) = &conditional {
            if let Some(etag) = &cond.etag {
                req = req.header(reqwest::header::IF_NONE_MATCH, etag);
            }
            if let Some(lm) = &cond.last_modified {
                req = req.header(reqwest::header::IF_MODIFIED_SINCE, lm);
            }
        }
        let resp = req
            .send()
            .await
            .map_err(|e| FetchError::transient(format!("{current}: {e}")))?;
        let status = resp.status();

        if status == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(Outcome::NotModified {
                freshness: freshness_from(&resp),
            });
        }
        if status.is_redirection() {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| {
                    FetchError::permanent(format!("{current}: redirect without a Location"))
                })?;
            current = current.join(location).map_err(|e| {
                FetchError::permanent(format!("bad redirect target {location}: {e}"))
            })?;
            continue;
        }
        if !status.is_success() {
            let transient = status.is_server_error()
                || status == reqwest::StatusCode::REQUEST_TIMEOUT
                || status == reqwest::StatusCode::TOO_MANY_REQUESTS;
            let err = FetchError {
                reason: format!("{current}: HTTP {status}"),
                transient,
            };
            return Err(err);
        }

        // Enforce the size cap up front when the server declares a length, and *while
        // streaming* regardless — a chunked response has no Content-Length, and buffering
        // it whole before checking would hand a hostile server an OOM lever.
        if let Some(len) = resp.content_length()
            && len > MAX_BODY_BYTES
        {
            return Err(FetchError::permanent(format!(
                "{current}: {len} bytes exceeds the {MAX_BODY_BYTES} cap"
            )));
        }
        let freshness = freshness_from(&resp);
        let mut resp = resp;
        let mut body: Vec<u8> = Vec::new();
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| FetchError::transient(format!("{current}: {e}")))?
        {
            if (body.len() + chunk.len()) as u64 > MAX_BODY_BYTES {
                return Err(FetchError::permanent(format!(
                    "{current}: body exceeds the {MAX_BODY_BYTES} cap"
                )));
            }
            body.extend_from_slice(&chunk);
        }
        let store = freshness.store;
        return Ok(Outcome::Fetched {
            body,
            store,
            freshness,
        });
    }
    Err(FetchError::permanent(format!("{url}: too many redirects")))
}

/// Parse freshness + validators from a response's headers.
fn freshness_from(resp: &reqwest::Response) -> Freshness {
    let headers = resp.headers();
    let get = |name: reqwest::header::HeaderName| {
        headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
    };
    freshness_from_parts(
        &get(reqwest::header::CACHE_CONTROL).unwrap_or_default(),
        get(reqwest::header::EXPIRES).as_deref(),
        get(reqwest::header::DATE).as_deref(),
        get(reqwest::header::LAST_MODIFIED),
        get(reqwest::header::ETAG),
    )
}

/// The header-parsing core of [`freshness_from`], factored for tests.
///
/// This is a **private** cache: `s-maxage` (a shared-cache directive) is deliberately not
/// honored — `s-maxage=604800, max-age=0` means revalidate-every-use here.
fn freshness_from_parts(
    cache_control: &str,
    expires: Option<&str>,
    date: Option<&str>,
    last_modified: Option<String>,
    etag: Option<String>,
) -> Freshness {
    let directives: Vec<&str> = cache_control.split(',').map(str::trim).collect();
    let no_store = directives.iter().any(|d| d.eq_ignore_ascii_case("no-store"));
    let no_cache = directives.iter().any(|d| d.eq_ignore_ascii_case("no-cache"));

    // Directive names are case-insensitive tokens.
    let max_age = directives.iter().find_map(|d| {
        let (name, value) = d.split_once('=')?;
        name.trim()
            .eq_ignore_ascii_case("max-age")
            .then(|| value.trim().parse::<u64>().ok())
            .flatten()
    });

    // Freshness lifetime: max-age > Expires > Last-Modified heuristic. `no-cache` forces
    // revalidation every use (fresh_for = 0) but still allows storing the validators.
    let fresh_for = if no_cache {
        Some(0)
    } else if let Some(max_age) = max_age {
        Some(max_age)
    } else if let Some(expires) = expires {
        match parse_http_date(expires) {
            Some(expires) => {
                let date = date
                    .and_then(parse_http_date)
                    .unwrap_or_else(SystemTime::now);
                Some(expires.duration_since(date).map(|d| d.as_secs()).unwrap_or(0))
            }
            // An unparseable Expires ("0" is the classic) means already expired
            // (RFC 9111 §5.3), not "no opinion".
            None => Some(0),
        }
    } else {
        last_modified.as_deref().and_then(parse_http_date).map(|lm| {
            let age = SystemTime::now().duration_since(lm).unwrap_or_default();
            (age / 10).min(HEURISTIC_MAX).as_secs()
        })
    };

    Freshness {
        fresh_for,
        etag,
        last_modified,
        store: !no_store,
    }
}

fn is_fresh(meta: &Meta) -> bool {
    match meta.fresh_for {
        Some(fresh_for) => now_secs().saturating_sub(meta.fetched_at) < fresh_for,
        None => false,
    }
}

fn parse_http_date(raw: &str) -> Option<SystemTime> {
    httpdate::parse_http_date(raw).ok()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    // For a URL key we hash the string; for a body the caller passes the digest bytes.
    if bytes.len() == 32 {
        let mut out = String::with_capacity(64);
        for b in bytes {
            out.push_str(&format!("{b:02x}"));
        }
        out
    } else {
        let digest = Sha256::digest(bytes);
        let mut out = String::with_capacity(64);
        for b in digest {
            out.push_str(&format!("{b:02x}"));
        }
        out
    }
}

/// A filesystem-safe server segment (server names are user-facing and could contain path
/// separators or dots); hash if it isn't a simple token.
fn sanitize_segment(server: &str) -> String {
    if !server.is_empty()
        && server
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        server.to_string()
    } else {
        hex(server.as_bytes())
    }
}

/// Temp-file + rename. The temp name is unique per process *and* call: multiple smudgy
/// processes share this cache dir, and a fixed suffix would let two writers interleave
/// bytes into one temp file and publish the corruption.
fn write_atomic(path: &Path, bytes: &[u8]) -> bool {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    if std::fs::write(&tmp, bytes).is_ok() && std::fs::rename(&tmp, path).is_ok() {
        true
    } else {
        let _ = std::fs::remove_file(&tmp);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freshness_expiry() {
        let fresh = Meta {
            url: "x".into(),
            content_hash: "h".into(),
            fetched_at: now_secs(),
            fresh_for: Some(3600),
            etag: None,
            last_modified: None,
        };
        assert!(is_fresh(&fresh));
        let stale = Meta {
            fetched_at: now_secs() - 7200,
            ..fresh
        };
        assert!(!is_fresh(&stale));
        let must_revalidate = Meta {
            fresh_for: None,
            ..stale
        };
        assert!(!is_fresh(&must_revalidate));
    }

    #[test]
    fn server_segment_is_filesystem_safe() {
        assert_eq!(sanitize_segment("Aardwolf"), "Aardwolf");
        assert_eq!(sanitize_segment("my_server-1"), "my_server-1");
        // A name with a separator hashes to a flat hex token (no nested dirs).
        let hashed = sanitize_segment("a/../b");
        assert_eq!(hashed.len(), 64);
        assert!(hashed.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn url_key_and_blob_paths_are_shaped() {
        let cache = HttpImageCache::new(PathBuf::from("/tmp/imgcache"));
        let url = Url::parse("https://example.com/a.png").unwrap();
        let meta = cache.meta_path("srv", &url);
        assert!(meta.ends_with(Path::new("meta/srv").join(format!("{}.json", hex(url.as_str().as_bytes())))));
        let blob = cache.blob_path(&"ab".repeat(32));
        // Component-wise (Path::ends_with), so the assertion is separator-agnostic.
        assert!(blob.ends_with(Path::new("blobs").join("ab").join("ab").join("ab".repeat(32))));
    }

    #[test]
    fn s_maxage_is_ignored_by_this_private_cache() {
        // s-maxage is a shared-cache directive: with max-age=0 alongside, the entry must
        // revalidate every use regardless of directive order.
        let f = freshness_from_parts("s-maxage=604800, max-age=0", None, None, None, None);
        assert_eq!(f.fresh_for, Some(0));
        let f = freshness_from_parts("max-age=0, s-maxage=604800", None, None, None, None);
        assert_eq!(f.fresh_for, Some(0));
        // Standalone s-maxage contributes nothing (falls through to no-lifetime).
        let f = freshness_from_parts("s-maxage=604800", None, None, None, None);
        assert_eq!(f.fresh_for, None);
        // Directive names are case-insensitive.
        let f = freshness_from_parts("Max-Age=60", None, None, None, None);
        assert_eq!(f.fresh_for, Some(60));
    }

    #[test]
    fn invalid_expires_means_expired_not_heuristic() {
        // "Expires: 0" is the canonical already-expired spelling; falling through to the
        // Last-Modified heuristic would grant it hours of freshness.
        let f = freshness_from_parts(
            "",
            Some("0"),
            None,
            Some("Mon, 01 Jan 2024 00:00:00 GMT".to_string()),
            None,
        );
        assert_eq!(f.fresh_for, Some(0));
    }

    #[test]
    fn no_store_and_no_cache_semantics() {
        let f = freshness_from_parts("no-store", None, None, None, None);
        assert!(!f.store);
        let f = freshness_from_parts("no-cache, max-age=300", None, None, None, None);
        assert_eq!(f.fresh_for, Some(0), "no-cache forces revalidation");
        assert!(f.store);
    }

    #[test]
    fn write_atomic_reports_failure_and_unique_tmps() {
        assert!(!write_atomic(Path::new("/nonexistent-dir/x/y"), b"z"));
        let dir = std::env::temp_dir().join(format!("smudgy-imgcache-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("out.bin");
        assert!(write_atomic(&target, b"hello"));
        assert_eq!(std::fs::read(&target).unwrap(), b"hello");
        // No temp litter left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains("tmp-"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A hostile chunked response with no Content-Length must be cut off at the cap while
    /// streaming — not buffered whole and checked after.
    #[test]
    fn chunked_body_is_capped_while_streaming() {
        use std::io::Write;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // Never block forever: the client abandons the connection at the cap, and its
            // unread tail can wedge an untimed write once kernel buffers fill.
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
            // Read the request head, then stream a bounded overage: one chunk past the cap
            // is all the client should ever consume.
            let mut buf = [0u8; 4096];
            use std::io::Read;
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nTransfer-Encoding: chunked\r\n\r\n",
            );
            let chunk = vec![b'x'; 1024 * 1024];
            let header = format!("{:x}\r\n", chunk.len());
            let chunks_past_cap = (MAX_BODY_BYTES / chunk.len() as u64) + 2;
            for _ in 0..chunks_past_cap {
                if stream.write_all(header.as_bytes()).is_err()
                    || stream.write_all(&chunk).is_err()
                    || stream.write_all(b"\r\n").is_err()
                {
                    return; // client cut us off — expected
                }
            }
            let _ = stream.write_all(b"0\r\n\r\n");
        });

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt
            .block_on(async {
                let client = reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(Duration::from_secs(5))
                    .timeout(Duration::from_secs(60))
                    .build()
                    .unwrap();
                let url = Url::parse(&format!("http://{addr}/big.png")).unwrap();
                fetch_uncached(&client, &url, None).await
            })
            .expect_err("an over-cap chunked body must error");
        assert!(err.reason.contains("cap"), "unexpected error: {}", err.reason);
        assert!(!err.transient, "size-cap violations are permanent");
        let _ = server.join();
    }
}
