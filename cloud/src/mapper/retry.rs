//! When a failed request to the map service is tried again: a 503 after its
//! `Retry-After` for as long as the service answers 503, any other transport
//! failure with exponential backoff until its run of failures has lasted
//! [`RETRY_WINDOW`]. Verdicts and sign-outs are never retried on their own.

use std::time::Duration;

use tokio::time::Instant;

use crate::CloudError;

/// First wait of an automatic retry.
pub(super) const RETRY_BASE: Duration = Duration::from_secs(2);
/// Longest wait between automatic retries.
pub(super) const RETRY_CAP: Duration = Duration::from_mins(2);
/// How long a run of failures keeps retrying on its own, unless the service
/// answers 503: a 503 retries for as long as it lasts.
pub(super) const RETRY_WINDOW: Duration = Duration::from_mins(10);

/// A run of consecutive failures.
#[derive(Debug, Clone, Copy)]
pub(super) struct Failures {
    pub(super) since: Instant,
    pub(super) count: u32,
}

impl Failures {
    /// The run `run` becomes with one more failure at `now`, or a new run.
    pub(super) fn after(run: Option<Self>, now: Instant) -> Self {
        run.map_or(
            Self {
                since: now,
                count: 1,
            },
            |run| Self {
                since: run.since,
                count: run.count.saturating_add(1),
            },
        )
    }
}

/// When to retry after `err` ends `failures`, if at all, giving up on a run
/// of failures other than 503s once it has lasted `window`.
pub(super) fn next_retry(
    err: &CloudError,
    failures: Failures,
    now: Instant,
    window: Duration,
) -> Option<Instant> {
    if !err.is_transport_error() {
        return None;
    }
    let backoff = RETRY_BASE
        .saturating_mul(2u32.saturating_pow(failures.count.saturating_sub(1).min(16)))
        .min(RETRY_CAP);
    let jitter = Duration::from_millis(u64::from(super::pending::fastrand_ms() % 1_000));
    let wait = match err {
        CloudError::ServiceUnavailable { retry_after, .. } => retry_after.unwrap_or(backoff),
        _ if now.duration_since(failures.since) >= window => return None,
        _ => backoff,
    };
    Some(now + wait + jitter)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_retries_on_the_services_terms() {
        let since = Instant::now();
        // How long after `err` a retry waits, `count` failures into a run
        // that has lasted `lasted`.
        let wait = |err: &CloudError, count, lasted| {
            let now = since + lasted;
            next_retry(err, Failures { since, count }, now, RETRY_WINDOW).map(|at| at - now)
        };
        let about = |wait: Option<Duration>, low: Duration| {
            wait.is_some_and(|wait| wait >= low && wait < low + Duration::from_secs(1))
        };
        let busy = |retry_after| CloudError::ServiceUnavailable {
            message: "Service temporarily unavailable".to_string(),
            retry_after,
        };

        // A 503 waits its Retry-After, however long the run has lasted.
        let five = Duration::from_secs(5);
        assert!(about(wait(&busy(Some(five)), 1, Duration::ZERO), five));
        assert!(about(
            wait(&busy(Some(five)), 40, Duration::from_hours(3)),
            five
        ));
        // Without one it backs off, still without end.
        assert!(about(
            wait(&busy(None), 3, Duration::from_hours(3)),
            Duration::from_secs(8)
        ));

        // Any other transport failure backs off to the cap, for the window.
        let offline = CloudError::NetworkError("offline".to_string());
        assert!(about(wait(&offline, 1, Duration::ZERO), RETRY_BASE));
        assert!(about(
            wait(&offline, 2, Duration::ZERO),
            Duration::from_secs(4)
        ));
        assert!(about(wait(&offline, 30, Duration::from_mins(9)), RETRY_CAP));
        assert_eq!(wait(&offline, 31, RETRY_WINDOW), None);

        // A verdict or a sign-out waits for the user.
        let refused = CloudError::Unauthorized("Invalid session".to_string());
        assert_eq!(wait(&refused, 1, Duration::ZERO), None);
        assert_eq!(wait(&CloudError::UpgradeRequired, 1, Duration::ZERO), None);
    }

    #[test]
    fn a_run_counts_its_failures_from_its_first() {
        let start = Instant::now();
        let first = Failures::after(None, start);
        assert_eq!(first.count, 1);
        let second = Failures::after(Some(first), start + Duration::from_secs(3));
        assert_eq!(second.count, 2);
        assert_eq!(second.since, start);
    }
}
