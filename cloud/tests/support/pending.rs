//! `GET /me/pending`: how many answers wait on the caller, by kind. The
//! service counts each kind as its list counts it, so the mock counts the
//! lists themselves. Fidelity reference: smudgy-cloudflare
//! `src/pending/routes.ts`.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use parking_lot::Mutex;
use serde_json::{Value, json};
use uuid::Uuid;

use super::http::{authenticate, ok};
use super::state::MockState;
use super::{clan_maps, clan_secrets, clans, social, transfers};

pub type Shared = Arc<Mutex<MockState>>;

pub async fn pending(State(state): State<Shared>, headers: HeaderMap) -> Response {
    counts(state, headers)
        .await
        .unwrap_or_else(|refused| refused)
}

async fn counts(state: Shared, headers: HeaderMap) -> Result<Response, Response> {
    let (caller, _) = authenticate(&state.lock(), &headers)?;
    let invitations =
        data(clans::received_invitations(State(state.clone()), headers.clone()).await).await?;
    let secret_offers =
        data(clan_secrets::received(State(state.clone()), headers.clone()).await).await?;
    let map_offers =
        data(clan_maps::my_offers(State(state.clone()), headers.clone()).await).await?;
    let requests = data(social::list_requests(State(state.clone()), headers.clone()).await).await?;
    let received = Query(HashMap::from([(
        "direction".to_string(),
        "received".to_string(),
    )]));
    let transfer_offers =
        data(transfers::list_transfers(State(state), received, headers).await).await?;
    Ok(ok(json!({
        "clan_invitations": length(&invitations),
        "secret_offers": unaccepted(&secret_offers, caller),
        "map_offers": unaccepted(&map_offers, caller),
        "friend_requests": length(&requests["incoming"]),
        "transfer_offers": length(&transfer_offers),
    })))
}

/// A list handler's `data`, or its refusal as is.
async fn data(response: Response) -> Result<Value, Response> {
    if !response.status().is_success() {
        return Err(response);
    }
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("mock answers are in memory");
    let envelope: Value = serde_json::from_slice(&body).expect("mock answers are JSON");
    Ok(envelope["data"].clone())
}

fn length(list: &Value) -> usize {
    list.as_array().map_or(0, Vec::len)
}

/// The offers in `list` that `caller` has not accepted.
fn unaccepted(list: &Value, caller: Uuid) -> usize {
    let me = json!(caller);
    list.as_array().map_or(0, |offers| {
        offers
            .iter()
            .filter(|offer| {
                !offer["recipients"].as_array().is_some_and(|recipients| {
                    recipients.iter().any(|recipient| {
                        recipient["user_id"] == me && recipient["accepted"] == true
                    })
                })
            })
            .count()
    })
}
