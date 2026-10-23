//! One budget for mail, calendar and streaming setup, including token refreshes.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Default)]
struct Backoff {
    until: Option<Instant>,
    failures: u32,
}

pub(super) struct Budget {
    slots: Arc<Semaphore>,
    backoff: Mutex<Backoff>,
}

fn account_key(token: &str) -> u64 {
    // Claims are only a scheduling hint, never an authorization decision.
    let claims = token
        .split('.')
        .nth(1)
        .and_then(|payload| URL_SAFE_NO_PAD.decode(payload).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let identity = claims.as_ref().and_then(|claims| {
        let tenant = claims.get("tid")?.as_str()?;
        let user = claims.get("oid").or_else(|| claims.get("sub"))?.as_str()?;
        Some(format!("{tenant}:{user}"))
    });
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    identity.as_deref().unwrap_or(token).hash(&mut hash);
    hash.finish()
}

pub(super) fn budget(token: &str) -> Arc<Budget> {
    static BUDGETS: OnceLock<Mutex<HashMap<u64, Arc<Budget>>>> = OnceLock::new();
    let mut budgets = BUDGETS.get_or_init(Default::default).lock().unwrap();
    // Retain active requests and cooldowns, without keeping old accounts forever.
    budgets.retain(|_, budget| {
        Arc::strong_count(budget) > 1
            || budget.backoff.lock().unwrap().until.is_some_and(|until| {
                until
                    .checked_add(Duration::from_secs(900))
                    .is_some_and(|expiry| expiry > Instant::now())
            })
    });
    budgets
        .entry(account_key(token))
        .or_insert_with(|| {
            Arc::new(Budget {
                slots: Arc::new(Semaphore::new(2)),
                backoff: Mutex::new(Backoff::default()),
            })
        })
        .clone()
}

impl Budget {
    pub(super) fn check(&self) -> Result<(), String> {
        let state = self.backoff.lock().unwrap();
        if let Some(remaining) = state
            .until
            .and_then(|until| until.checked_duration_since(Instant::now()))
        {
            return Err(backoff_error(remaining));
        }
        Ok(())
    }

    pub(super) async fn acquire(&self) -> Result<OwnedSemaphorePermit, String> {
        self.check()?;
        let permit = self
            .slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        // Requests queued before a rejection must respect the new cooldown too.
        self.check()?;
        Ok(permit)
    }

    pub(super) fn response(
        &self,
        status: u16,
        xml: &str,
        retry_after: Option<Duration>,
    ) -> Result<(), String> {
        let busy = xml.split('<').any(|element| {
            let Some((tag, value)) = element.split_once('>') else {
                return false;
            };
            let name = tag
                .split_whitespace()
                .next()
                .unwrap_or("")
                .rsplit(':')
                .next()
                .unwrap_or("");
            matches!(
                name,
                "ResponseCode" | "faultcode" | "InnerErrorResponseCode"
            ) && value.trim().rsplit(':').next() == Some("ErrorServerBusy")
        }) || matches!(status, 429 | 503);
        if !busy {
            // An already in-flight success must not cancel another request's pause.
            let mut state = self.backoff.lock().unwrap();
            if status < 400 && state.until.is_none_or(|until| until <= Instant::now()) {
                state.failures = 0;
            }
            return Ok(());
        }
        let mut state = self.backoff.lock().unwrap();
        let fallback = Duration::from_secs(30 * 2u64.pow(state.failures.min(4)));
        state.failures = state.failures.saturating_add(1);
        let delay = backoff_hint(xml)
            .into_iter()
            .chain(retry_after)
            .filter(|delay| !delay.is_zero())
            .max()
            .unwrap_or(fallback);
        let now = Instant::now();
        let until = now
            .checked_add(delay)
            .unwrap_or(now + Duration::from_secs(300));
        state.until = Some(state.until.map_or(until, |previous| previous.max(until)));
        Err(backoff_error(
            state.until.unwrap().saturating_duration_since(now),
        ))
    }
}

fn backoff_error(delay: Duration) -> String {
    let retry_at = chrono::Utc::now()
        .timestamp_millis()
        .saturating_add(delay.as_millis().min(i64::MAX as u128) as i64);
    format!("ews_server_busy:{retry_at}")
}

pub(super) fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let date = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    (date.with_timezone(&chrono::Utc) - chrono::Utc::now())
        .to_std()
        .ok()
}

fn backoff_hint(xml: &str) -> Option<Duration> {
    // Namespace prefixes vary between SOAP Faults (t/e) and HTTP 200 errors (m).
    xml.split('<').find_map(|element| {
        let (tag, value) = element.split_once('>')?;
        let name = tag.split_whitespace().next()?.rsplit(':').next()?;
        if name != "Value"
            || !(tag.contains("Name=\"BackOffMilliseconds\"")
                || tag.contains("Name='BackOffMilliseconds'"))
        {
            return None;
        }
        let millis = value.trim().parse::<u64>().ok()?;
        (millis > 0).then(|| Duration::from_millis(millis))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fresh() -> Budget {
        Budget {
            slots: Arc::new(Semaphore::new(2)),
            backoff: Mutex::new(Backoff::default()),
        }
    }

    #[test]
    fn soap_fault_and_http_200_hints_are_respected() {
        for status in [200, 500] {
            let budget = fresh();
            let error = budget.response(status, "<e:ResponseCode>ErrorServerBusy</e:ResponseCode><t:Value Name=\"BackOffMilliseconds\">299321</t:Value>", None).unwrap_err();
            assert!(error.starts_with("ews_server_busy:"));
            assert!(
                budget
                    .backoff
                    .lock()
                    .unwrap()
                    .until
                    .unwrap()
                    .duration_since(Instant::now())
                    > Duration::from_secs(299)
            );
            assert!(budget.check().is_err());
            budget
                .response(200, "<ResponseCode>NoError</ResponseCode>", None)
                .unwrap();
            assert!(budget.check().is_err());
        }
    }

    #[test]
    fn fallback_increases_and_never_shortens_an_existing_pause() {
        let budget = fresh();
        budget.response(503, "", None).unwrap_err();
        let first = budget.backoff.lock().unwrap().until.unwrap();
        budget.response(429, "", None).unwrap_err();
        assert!(budget.backoff.lock().unwrap().until.unwrap() > first + Duration::from_secs(29));
        budget
            .response(
                500,
                "<ResponseCode>ErrorServerBusy</ResponseCode>",
                Some(Duration::from_secs(1)),
            )
            .unwrap_err();
        assert!(budget.backoff.lock().unwrap().until.unwrap() > first + Duration::from_secs(29));
        assert!(fresh().response(500, "ErrorAccessDenied", None).is_ok());
    }

    #[tokio::test]
    async fn queued_requests_stop_before_network_and_other_accounts_are_independent() {
        let budget = Arc::new(fresh());
        let first = budget.acquire().await.unwrap();
        let second = budget.acquire().await.unwrap();
        assert!(budget.slots.clone().try_acquire_owned().is_err());
        let queued_budget = budget.clone();
        let queued = tokio::spawn(async move { queued_budget.acquire().await });
        tokio::task::yield_now().await;
        budget
            .response(500, "<ResponseCode>ErrorServerBusy</ResponseCode>", None)
            .unwrap_err();
        drop(first);
        assert!(queued.await.unwrap().is_err());
        drop(second);
        assert!(fresh().acquire().await.is_ok());
        budget.backoff.lock().unwrap().until = Some(Instant::now() - Duration::from_secs(1));
        assert!(budget.acquire().await.is_ok());
    }

    #[test]
    fn retry_after_and_fault_codes_do_not_confuse_message_content() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER, "120".parse().unwrap());
        assert_eq!(retry_after(&headers), Some(Duration::from_secs(120)));
        let date = (chrono::Utc::now() + chrono::Duration::seconds(120)).to_rfc2822();
        headers.insert(reqwest::header::RETRY_AFTER, date.parse().unwrap());
        assert!(retry_after(&headers).unwrap() > Duration::from_secs(118));
        assert!(fresh()
            .response(200, "<t:Body>ErrorServerBusy</t:Body>", None)
            .is_ok());
        assert!(fresh()
            .response(500, "<faultcode>a:ErrorServerBusy</faultcode>", None)
            .is_err());
        let account = budget("test-account-retained-cooldown");
        account.response(503, "", None).unwrap_err();
        let original = Arc::as_ptr(&account);
        drop(account);
        assert_eq!(
            Arc::as_ptr(&budget("test-account-retained-cooldown")),
            original
        );
    }

    #[test]
    fn refresh_keeps_the_same_account_budget_without_retaining_tokens() {
        fn token(oid: &str, nonce: u8) -> String {
            format!(
                "header.{}.sig{nonce}",
                URL_SAFE_NO_PAD.encode(format!(
                    r#"{{"tid":"tenant","oid":"{oid}","nonce":{nonce}}}"#
                ))
            )
        }
        assert_eq!(account_key(&token("one", 1)), account_key(&token("one", 2)));
        assert_ne!(account_key(&token("one", 1)), account_key(&token("two", 1)));
        assert_eq!(
            backoff_hint("<Value Name='BackOffMilliseconds'> 50 </Value>"),
            Some(Duration::from_millis(50))
        );
        assert_eq!(
            backoff_hint("<Value Name=\"BackOffMilliseconds\">-1</Value>"),
            None
        );
    }
}
