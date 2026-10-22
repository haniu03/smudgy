//! Labels attached to rooms (format-3 §2.2), over the real client stack.
//! An attached label's `x` and `y` are its offset from the room's center
//! and it is drawn on the room's level, so the room moves it without
//! touching the label's source. Deleting the room, or the Secret holding
//! it, frees the label where it is drawn; a reader who cannot read the room
//! never sees the label; a copy keeps the labels on the rooms it carries.
//! After each write, the client's own state matches what the server
//! serves.

use super::*;
use serde_json::{Value, json};
use smudgy_cloud::cloud_api::CopyAreaRequest;
use smudgy_cloud::mapper::AreaMutationBatch;
use smudgy_cloud::{Label, LabelArgs, LabelId, LabelUpdates, MovedContent, RoomAddress, SourceId};
use support::TestUser;

/// One request with a bearer credential: status and parsed body.
async fn call(
    method: reqwest::Method,
    url: &str,
    token: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let client = reqwest::Client::new();
    let mut request = client
        .request(method, url)
        .header("authorization", format!("Bearer {token}"));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.expect("request sends");
    let status = response.status().as_u16();
    let text = response.text().await.expect("a body");
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

/// The map as `user` is served it: the projection's `data`.
async fn served(server: &support::MockHandle, user: &TestUser, area: AreaId) -> Value {
    let (status, body) = call(
        reqwest::Method::GET,
        &format!("{}/areas/{area}", server.base_url),
        &user.api_key,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    body["data"].clone()
}

/// The labels of the bundle for `source` (its wire id) in `projection`.
fn bundle_labels(projection: &Value, source: &str) -> Vec<Value> {
    projection["sources"]
        .as_array()
        .expect("sources")
        .iter()
        .find(|bundle| bundle["source"] == source)
        .map(|bundle| bundle["labels"].as_array().cloned().unwrap_or_default())
        .unwrap_or_default()
}

/// Label `id` in the bundle for `source`, as `user` is served it.
async fn served_label(
    server: &support::MockHandle,
    user: &TestUser,
    area: AreaId,
    source: &str,
    id: LabelId,
) -> Value {
    bundle_labels(&served(server, user, area).await, source)
        .into_iter()
        .find(|label| label["id"] == json!(id.0))
        .unwrap_or_else(|| panic!("label {id:?} in {source}"))
}

fn parsed(label: &Value) -> Label {
    serde_json::from_value(label.clone()).expect("a wire label")
}

/// Label `id` in the client's state for `source` of the map.
fn client_label(mapper: &Mapper, area: AreaId, source: SourceId, id: LabelId) -> Option<Label> {
    let atlas = mapper.get_current_atlas();
    let map = atlas.get_area(&area)?;
    if source.is_map() {
        return map
            .get_labels()
            .iter()
            .find(|label| label.id == id)
            .cloned();
    }
    map.meta()
        .sources
        .iter()
        .find(|bundle| bundle.source == source)?
        .labels
        .iter()
        .find(|label| label.id == id)
        .cloned()
}

/// Where the client draws label `id` of `source`: its corner and level.
fn drawn_at(mapper: &Mapper, area: AreaId, source: SourceId, id: LabelId) -> (f32, f32, i32) {
    let label = client_label(mapper, area, source, id).expect("the label is held");
    let atlas = mapper.get_current_atlas();
    let place = atlas
        .get_area(&area)
        .expect("the map is loaded")
        .label_place(&label)
        .expect("the label is drawn");
    (place.x, place.y, place.level)
}

/// A label drawn at `(x, y)`: map coordinates when free, its offset from
/// `room`'s center when attached.
fn drawn(id: LabelId, text: &str, room: Option<RoomAddress>, x: f32, y: f32) -> AreaMutation {
    let mut body = LabelArgs {
        id: Some(id),
        x,
        y,
        width: 4.0,
        height: 1.0,
        text: text.to_string(),
        color: "#c8c8c8".to_string(),
        background_color: Some("#202020".to_string()),
        font_size: 14,
        font_weight: 400,
        ..LabelArgs::default()
    };
    body.set_room(room);
    AreaMutation::CreateLabel { body }
}

/// Writes `operations` to `source` of the map and waits for the server to
/// take them; the operation's id.
async fn write(
    mapper: &Mapper,
    area: AreaId,
    source: SourceId,
    operations: Vec<AreaMutation>,
) -> Uuid {
    let operation = mapper
        .mutate_batches(vec![
            AreaMutationBatch::strict(area, operations, "Labels").in_source(source),
        ])
        .expect("queued")
        .pop()
        .expect("one submission")
        .operation_id()
        .expect("a cloud write");
    mapper
        .wait_for_mutation(operation)
        .await
        .expect("the server takes the write");
    operation
}

/// The `versions` the server answered operation `operation` of `user` with,
/// as `(source, rev)`.
fn answered_versions(
    server: &support::MockHandle,
    user: &TestUser,
    operation: Uuid,
) -> Vec<(String, i64)> {
    let st = server.state.lock();
    st.mutation_receipts[&(user.id, operation)].result["versions"]
        .as_array()
        .expect("versions")
        .iter()
        .map(|version| {
            (
                version["source"].as_str().expect("a source").to_string(),
                version["rev"].as_i64().expect("a revision"),
            )
        })
        .collect()
}

/// Puts map room `number` of `area` at `(x, y)` on `level`.
fn place(server: &support::MockHandle, area: AreaId, number: i32, x: f32, y: f32, level: i32) {
    server.add_room(area, number, &format!("Room {number}"));
    let mut st = server.state.lock();
    let room = st
        .areas
        .get_mut(&area.0)
        .expect("the map")
        .rooms
        .get_mut(&number)
        .expect("the room");
    room.x = x;
    room.y = y;
    room.level = level;
}

/// Creates the Secret's own room `number` at `(x, y)` on `level` through
/// the client.
async fn secret_room(
    mapper: &Mapper,
    area: AreaId,
    secret: SourceId,
    number: i32,
    (x, y, level): (f32, f32, i32),
) {
    write(
        mapper,
        area,
        secret,
        vec![AreaMutation::CreateRoom {
            room_number: RoomNumber(number),
            room_source: Some(secret),
            body: RoomUpdates {
                title: Some(format!("Hidden {number}")),
                x: Some(x),
                y: Some(y),
                level: Some(level),
                ..RoomUpdates::default()
            },
        }],
    )
    .await;
}

/// A loaded mapper for `user`, its cache kept alive beside it.
async fn session(
    server: &support::MockHandle,
    user: &TestUser,
    tag: &str,
    area: AreaId,
) -> (Mapper, TempCacheDir) {
    let cache = TempCacheDir::new(tag);
    let mapper = new_synced_mapper(&server.base_url, &user.api_key, cache.path()).await;
    tick(&mapper).await;
    wait_until(|| mapper.get_current_atlas().get_area(&area).is_some()).await;
    (mapper, cache)
}

fn room_on_map(number: i32) -> RoomAddress {
    RoomAddress::map(RoomNumber(number))
}

fn wire_id(source: SourceId) -> String {
    match source {
        SourceId::Secret(id) => id.to_string(),
        SourceId::Private => "private".to_string(),
        SourceId::Map => "map".to_string(),
    }
}

/// A map label attached to a room carries the room's number and its offset
/// from the room, stands on the room's level, and follows the room when it
/// moves or changes level.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_label_attached_to_a_map_room_follows_the_room() {
    let server = MockServer::spawn().await;
    let owner = server.create_user("follow@example.com", "follow", true);
    let area = server.create_area(&owner, "Square");
    place(&server, area, 1, 10.0, 20.0, 2);
    let (mapper, _cache) = session(&server, &owner, "label-follow", area).await;

    let label = LabelId(Uuid::new_v4());
    write(
        &mapper,
        area,
        SourceId::Map,
        vec![drawn(label, "Fountain", Some(room_on_map(1)), 0.5, -1.0)],
    )
    .await;
    let wire = served_label(&server, &owner, area, "map", label).await;
    assert_eq!(wire["room_number"], 1);
    assert!(wire.get("room_source").is_none(), "a map room: {wire}");
    assert_eq!(
        (wire["x"].as_f64(), wire["y"].as_f64()),
        (Some(0.5), Some(-1.0))
    );
    assert_eq!(wire["level"], 2, "the room's level");
    assert_eq!(
        client_label(&mapper, area, SourceId::Map, label),
        Some(parsed(&wire)),
        "the client holds what the server serves"
    );
    assert_eq!(
        drawn_at(&mapper, area, SourceId::Map, label),
        (10.5, 19.0, 2)
    );

    let moved = mapper
        .upsert_room(
            RoomKey::new(area, RoomNumber(1)),
            RoomUpdates {
                x: Some(30.0),
                y: Some(40.0),
                level: Some(3),
                ..RoomUpdates::default()
            },
        )
        .expect("queued");
    mapper
        .wait_for_mutation(moved.operation_id().expect("a cloud write"))
        .await
        .expect("the room moves");
    let wire = served_label(&server, &owner, area, "map", label).await;
    assert_eq!(
        (wire["x"].as_f64(), wire["y"].as_f64()),
        (Some(0.5), Some(-1.0))
    );
    assert_eq!(wire["level"], 3, "the room's new level");
    assert_eq!(
        drawn_at(&mapper, area, SourceId::Map, label),
        (30.5, 39.0, 3)
    );
    // The client draws an attached label on its room's level, whatever level
    // the label holds (see the ignored test below).
    let held = client_label(&mapper, area, SourceId::Map, label).expect("held");
    assert_eq!(Label { level: 3, ..held }, parsed(&wire));

    // Requests without room keys behave as before.
    let free = LabelId(Uuid::new_v4());
    write(
        &mapper,
        area,
        SourceId::Map,
        vec![drawn(free, "Free", None, 7.0, 8.0)],
    )
    .await;
    let wire = served_label(&server, &owner, area, "map", free).await;
    assert!(wire.get("room_number").is_none() && wire.get("room_source").is_none());
    assert_eq!(wire["level"], 0);
    assert_eq!(
        client_label(&mapper, area, SourceId::Map, free),
        Some(parsed(&wire))
    );
}

/// A Secret's note on a map room is the common case: the map room moving
/// changes nothing in the Secret, whose revision stays, and the note keeps
/// its offset.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_secrets_label_on_a_map_room_moves_with_it_and_moves_no_revision() {
    let server = MockServer::spawn().await;
    let owner = server.create_user("note@example.com", "note", true);
    let area = server.create_area(&owner, "Market");
    place(&server, area, 1, 4.0, 4.0, 0);
    let (mapper, _cache) = session(&server, &owner, "label-secret-note", area).await;
    let secret = mapper
        .create_secret(area, "Fence", None)
        .await
        .expect("create")
        .source;
    let SourceId::Secret(secret_id) = secret else {
        unreachable!("a Secret")
    };
    let wire_secret = wire_id(secret);

    let label = LabelId(Uuid::new_v4());
    write(
        &mapper,
        area,
        secret,
        vec![drawn(
            label,
            "Fence buys here",
            Some(room_on_map(1)),
            1.0,
            -2.0,
        )],
    )
    .await;
    let rev = server.secret_rev(area, secret_id);
    let wire = served_label(&server, &owner, area, &wire_secret, label).await;
    assert_eq!(wire["room_number"], 1);
    assert!(wire.get("room_source").is_none(), "{wire}");
    assert_eq!(
        client_label(&mapper, area, secret, label),
        Some(parsed(&wire))
    );

    let moved = mapper
        .upsert_room(
            RoomKey::new(area, RoomNumber(1)),
            RoomUpdates {
                x: Some(-6.0),
                y: Some(2.0),
                level: Some(-1),
                ..RoomUpdates::default()
            },
        )
        .expect("queued");
    mapper
        .wait_for_mutation(moved.operation_id().expect("a cloud write"))
        .await
        .expect("the room moves");
    assert_eq!(
        server.secret_rev(area, secret_id),
        rev,
        "the room's move changes nothing the Secret holds"
    );
    let wire = served_label(&server, &owner, area, &wire_secret, label).await;
    assert_eq!(
        (wire["x"].as_f64(), wire["y"].as_f64()),
        (Some(1.0), Some(-2.0))
    );
    assert_eq!(wire["level"], -1);
    assert_eq!(drawn_at(&mapper, area, secret, label), (-5.0, 0.0, -1));
}

/// An update without room keys keeps the label's room, a room number moves
/// it to that room and its level, and `"room_number": null` frees it at the
/// body's coordinates, on its old room's level unless the body names one.
/// A `room_source` without a room is refused from the request alone; a
/// missing room is the uniform 404.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_update_keeps_moves_or_frees_a_labels_room() {
    let server = MockServer::spawn().await;
    let owner = server.create_user("reattach@example.com", "reattach", true);
    let area = server.create_area(&owner, "Docks");
    place(&server, area, 1, 10.0, 20.0, 2);
    place(&server, area, 2, -5.0, 5.0, 1);
    let (mapper, _cache) = session(&server, &owner, "label-reattach", area).await;
    let label = LabelId(Uuid::new_v4());
    write(
        &mapper,
        area,
        SourceId::Map,
        vec![drawn(label, "Pier", Some(room_on_map(1)), 1.0, 1.0)],
    )
    .await;
    let update = |updates: LabelUpdates| {
        let mapper = &mapper;
        async move {
            let submitted = mapper.update_label(area, label, updates).expect("queued");
            mapper
                .wait_for_mutation(submitted.operation_id().expect("a cloud write"))
                .await
                .expect("the server takes the update");
        }
    };
    let check = |expected: Value| {
        let (server, owner, mapper) = (&server, &owner, &mapper);
        async move {
            let wire = served_label(server, owner, area, "map", label).await;
            for (key, value) in expected.as_object().expect("fields") {
                if value.is_null() {
                    assert!(wire.get(key).is_none(), "{key} in {wire}");
                } else {
                    assert_eq!(&wire[key], value, "{key} in {wire}");
                }
            }
            assert_eq!(
                client_label(mapper, area, SourceId::Map, label),
                Some(parsed(&wire)),
                "the client holds what the server serves"
            );
        }
    };

    update(LabelUpdates {
        text: Some("Old pier".to_string()),
        ..LabelUpdates::default()
    })
    .await;
    check(json!({"room_number": 1, "x": 1.0, "y": 1.0, "level": 2, "text": "Old pier"})).await;

    update(
        LabelUpdates {
            x: Some(-0.5),
            y: Some(0.5),
            ..LabelUpdates::default()
        }
        .with_room(Some(room_on_map(2))),
    )
    .await;
    check(json!({"room_number": 2, "x": -0.5, "y": 0.5, "level": 1})).await;

    update(
        LabelUpdates {
            x: Some(3.0),
            y: Some(4.0),
            ..LabelUpdates::default()
        }
        .with_room(None),
    )
    .await;
    check(json!({"room_number": null, "room_source": null, "x": 3.0, "y": 4.0, "level": 1})).await;

    update(LabelUpdates::default().with_room(Some(room_on_map(1)))).await;
    check(json!({"room_number": 1, "x": 3.0, "y": 4.0, "level": 2})).await;
    update(
        LabelUpdates {
            level: Some(7),
            ..LabelUpdates::default()
        }
        .with_room(None),
    )
    .await;
    check(json!({"room_number": null, "x": 3.0, "y": 4.0, "level": 7})).await;

    // Refused before the map is read, and for a room it does not hold.
    let rev = served(&server, &owner, area).await["sources"][0]["rev"].clone();
    let envelope = |op: Value| {
        json!({
            "operation_id": Uuid::new_v4(),
            "preconditions": [{ "resource": "source", "id": area, "source": "map", "expected_rev": rev }],
            "payload": [op],
        })
    };
    let url = format!("{}/areas/{area}/mutations", server.base_url);
    let new_label = |extra: Value| {
        let mut body = json!({
            "id": Uuid::new_v4(), "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0,
            "horizontal_alignment": "Center", "vertical_alignment": "Center", "text": "T",
        });
        for (key, value) in extra.as_object().expect("fields") {
            body[key] = value.clone();
        }
        json!({ "op": "create_label", "body": body })
    };
    let changes = |body: Value| json!({ "op": "update_label", "label_id": label.0, "body": body });
    for (op, status) in [
        (new_label(json!({ "room_source": "private" })), 400),
        (changes(json!({ "room_source": "private" })), 400),
        (
            changes(json!({ "room_number": null, "room_source": "private" })),
            400,
        ),
        (
            new_label(json!({ "room_number": 1, "room_source": "nowhere" })),
            400,
        ),
        (new_label(json!({ "room_number": 99 })), 404),
        (changes(json!({ "room_number": 99 })), 404),
        (
            new_label(json!({ "room_number": 1, "room_source": Uuid::new_v4() })),
            404,
        ),
    ] {
        let (answer, body) = call(
            reqwest::Method::POST,
            &url,
            &owner.api_key,
            Some(envelope(op.clone())),
        )
        .await;
        assert_eq!(answer, status, "{op}: {body}");
    }
    check(json!({"room_number": null, "x": 3.0, "y": 4.0, "level": 7})).await;
}

/// Deleting a map room frees every label attached to it, the map's, a
/// Secret's and Private's, where each is drawn, and each label's source
/// moves; the answer reports the written source first. Deleting a Secret's
/// own room frees the map's label on it the same way.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleting_a_room_frees_its_labels_in_every_source() {
    let server = MockServer::spawn().await;
    let owner = server.create_user("freed@example.com", "freed", true);
    let area = server.create_area(&owner, "Warehouse");
    place(&server, area, 1, 10.0, 20.0, 2);
    place(&server, area, 2, 0.0, 0.0, 0);
    let (mapper, _cache) = session(&server, &owner, "label-freed", area).await;
    let secret = mapper
        .create_secret(area, "Smugglers", None)
        .await
        .expect("create")
        .source;
    let SourceId::Secret(secret_id) = secret else {
        unreachable!("a Secret")
    };
    let (on_map, on_secret, on_private) = (
        LabelId(Uuid::new_v4()),
        LabelId(Uuid::new_v4()),
        LabelId(Uuid::new_v4()),
    );
    write(
        &mapper,
        area,
        SourceId::Map,
        vec![drawn(on_map, "Crates", Some(room_on_map(1)), 1.0, 2.0)],
    )
    .await;
    write(
        &mapper,
        area,
        secret,
        vec![drawn(on_secret, "Hatch", Some(room_on_map(1)), -1.0, 0.5)],
    )
    .await;
    write(
        &mapper,
        area,
        SourceId::Private,
        vec![drawn(on_private, "Mine", Some(room_on_map(1)), 0.0, -3.0)],
    )
    .await;
    let (secret_rev, private_rev) = {
        let st = server.state.lock();
        let map = &st.areas[&area.0];
        (map.secrets[0].rev, map.private_sources[&owner.id].rev)
    };

    let deleted = mapper
        .delete_room(RoomKey::new(area, RoomNumber(1)))
        .expect("queued");
    let operation = deleted.operation_id().expect("a cloud write");
    mapper
        .wait_for_mutation(operation)
        .await
        .expect("the room goes");
    let map_rev = server.area_rev(area);
    assert_eq!(
        answered_versions(&server, &owner, operation),
        vec![
            ("map".to_string(), map_rev),
            (secret_id.to_string(), secret_rev + 1),
            ("private".to_string(), private_rev + 1),
        ],
        "each freed label's source moves once, after the written one"
    );
    let projection = served(&server, &owner, area).await;
    for (source, label, x, y) in [
        (SourceId::Map, on_map, 11.0, 22.0),
        (secret, on_secret, 9.0, 20.5),
        (SourceId::Private, on_private, 10.0, 17.0),
    ] {
        let wire = bundle_labels(&projection, &wire_id(source))
            .into_iter()
            .find(|served| served["id"] == json!(label.0))
            .expect("the label stays");
        assert!(
            wire.get("room_number").is_none() && wire.get("room_source").is_none(),
            "freed: {wire}"
        );
        assert_eq!(
            (wire["x"].as_f64(), wire["y"].as_f64()),
            (Some(x), Some(y)),
            "{wire}"
        );
        assert_eq!(wire["level"], 2, "on the room's level: {wire}");
        assert_eq!(
            client_label(&mapper, area, source, label),
            Some(parsed(&wire)),
            "the client frees {source:?}'s label as the server does"
        );
    }

    // A Secret's own room going frees the map's label on it.
    secret_room(&mapper, area, secret, 1, (-4.0, 6.0, 5)).await;
    let on_hidden = LabelId(Uuid::new_v4());
    write(
        &mapper,
        area,
        SourceId::Map,
        vec![drawn(
            on_hidden,
            "Behind the crates",
            Some(RoomAddress::new(secret, RoomNumber(1))),
            2.0,
            2.0,
        )],
    )
    .await;
    let wire = served_label(&server, &owner, area, "map", on_hidden).await;
    assert_eq!(
        (wire["room_number"].clone(), wire["room_source"].clone()),
        (json!(1), json!(secret_id))
    );
    assert_eq!(wire["level"], 5);
    assert_eq!(
        client_label(&mapper, area, SourceId::Map, on_hidden),
        Some(parsed(&wire))
    );
    let map_rev = server.area_rev(area);
    let operation = write(
        &mapper,
        area,
        secret,
        vec![AreaMutation::DeleteRoom {
            room_number: RoomNumber(1),
            room_source: Some(secret),
        }],
    )
    .await;
    assert_eq!(
        server.area_rev(area),
        map_rev + 1,
        "the map's label changed"
    );
    assert_eq!(
        answered_versions(&server, &owner, operation),
        vec![
            (secret_id.to_string(), server.secret_rev(area, secret_id)),
            ("map".to_string(), map_rev + 1),
        ]
    );
    let wire = served_label(&server, &owner, area, "map", on_hidden).await;
    assert!(wire.get("room_number").is_none() && wire.get("room_source").is_none());
    assert_eq!(
        (
            wire["x"].as_f64(),
            wire["y"].as_f64(),
            wire["level"].as_i64()
        ),
        (Some(-2.0), Some(8.0), Some(5))
    );
    tick(&mapper).await;
    assert_eq!(
        client_label(&mapper, area, SourceId::Map, on_hidden),
        Some(parsed(&wire)),
        "the client reads the freed label once the map is read again"
    );
}

/// Deleting a Secret frees the map's labels on its rooms where they are
/// drawn, and moves the map's revision.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleting_a_secret_frees_the_maps_labels_on_its_rooms() {
    let server = MockServer::spawn().await;
    let owner = server.create_user("dropped@example.com", "dropped", true);
    let area = server.create_area(&owner, "Cellars");
    place(&server, area, 1, 0.0, 0.0, 0);
    let (mapper, _cache) = session(&server, &owner, "label-secret-gone", area).await;
    let secret = mapper
        .create_secret(area, "Vaults", None)
        .await
        .expect("create")
        .source;
    secret_room(&mapper, area, secret, 3, (12.0, -4.0, 1)).await;
    let label = LabelId(Uuid::new_v4());
    write(
        &mapper,
        area,
        SourceId::Map,
        vec![drawn(
            label,
            "Vault door",
            Some(RoomAddress::new(secret, RoomNumber(3))),
            -1.0,
            1.0,
        )],
    )
    .await;
    let map_rev = server.area_rev(area);

    mapper.delete_secret(area, &secret).await.expect("delete");
    assert_eq!(
        server.area_rev(area),
        map_rev + 1,
        "the map's label changed"
    );
    let wire = served_label(&server, &owner, area, "map", label).await;
    assert!(
        wire.get("room_number").is_none() && wire.get("room_source").is_none(),
        "{wire}"
    );
    assert_eq!(
        (
            wire["x"].as_f64(),
            wire["y"].as_f64(),
            wire["level"].as_i64()
        ),
        (Some(11.0), Some(-3.0), Some(1))
    );
    tick(&mapper).await;
    assert_eq!(
        client_label(&mapper, area, SourceId::Map, label),
        Some(parsed(&wire))
    );
}

/// A map label attached to a Secret's room shows only to the Secret's
/// readers. To anyone else it does not exist: it is not served, and
/// updating, deleting or moving it is the uniform 404, as is attaching a
/// label to a room of a Secret they cannot read.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_label_on_an_unreadable_room_does_not_exist_for_its_reader() {
    let server = MockServer::spawn().await;
    let owner = server.create_user("hider@example.com", "hider", true);
    let editor = server.create_user("seeker@example.com", "seeker", true);
    let area = server.create_area(&owner, "Manor");
    place(&server, area, 1, 0.0, 0.0, 0);
    server.befriend(&owner, &editor);
    server.grant(&owner, &editor, GrantScope::Area(area), GrantFlags::edit());
    let (mapper, _cache) = session(&server, &owner, "label-hidden-owner", area).await;
    let secret = mapper
        .create_secret(area, "Passages", None)
        .await
        .expect("create")
        .source;
    let SourceId::Secret(secret_id) = secret else {
        unreachable!("a Secret")
    };
    // A Secret the editor adds to, for the moves below.
    let notes = mapper
        .create_secret(area, "Notes", None)
        .await
        .expect("create")
        .source;
    let SourceId::Secret(notes_id) = notes else {
        unreachable!("a Secret")
    };
    server.grant_secret(area, notes_id, &owner, &editor, &["add"]);
    secret_room(&mapper, area, secret, 1, (3.0, 3.0, 0)).await;
    let (open, hidden) = (LabelId(Uuid::new_v4()), LabelId(Uuid::new_v4()));
    write(
        &mapper,
        area,
        SourceId::Map,
        vec![
            drawn(open, "Hall", Some(room_on_map(1)), 0.0, 1.0),
            drawn(
                hidden,
                "Lever",
                Some(RoomAddress::new(secret, RoomNumber(1))),
                0.0,
                1.0,
            ),
        ],
    )
    .await;

    let (status, raw) = call(
        reqwest::Method::GET,
        &format!("{}/areas/{area}", server.base_url),
        &editor.api_key,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let text = raw.to_string();
    assert!(
        !text.contains("Lever") && !text.contains(&hidden.0.to_string()),
        "{text}"
    );
    assert!(!text.contains(&secret_id.to_string()), "{text}");
    let labels: Vec<Value> = bundle_labels(&raw["data"], "map");
    assert_eq!(labels.len(), 1);
    assert_eq!(labels[0]["id"], json!(open.0));

    let (seeker, _seeker_cache) = session(&server, &editor, "label-hidden-editor", area).await;
    let held: Vec<LabelId> = seeker
        .get_current_atlas()
        .get_area(&area)
        .expect("loaded")
        .get_labels()
        .iter()
        .map(|label| label.id)
        .collect();
    assert_eq!(held, vec![open]);

    let rev = raw["data"]["sources"][0]["rev"].clone();
    let url = format!("{}/areas/{area}/mutations", server.base_url);
    let envelope = |op: Value| {
        json!({
            "operation_id": Uuid::new_v4(),
            "preconditions": [{ "resource": "source", "id": area, "source": "map", "expected_rev": rev }],
            "payload": [op],
        })
    };
    for op in [
        json!({ "op": "update_label", "label_id": hidden.0, "body": { "text": "Found it" } }),
        json!({ "op": "delete_label", "label_id": hidden.0 }),
        json!({ "op": "create_label", "body": {
            "id": Uuid::new_v4(), "room_number": 1, "room_source": secret_id,
            "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0,
            "horizontal_alignment": "Center", "vertical_alignment": "Center", "text": "T",
        } }),
    ] {
        let (status, body) = call(
            reqwest::Method::POST,
            &url,
            &editor.api_key,
            Some(envelope(op.clone())),
        )
        .await;
        assert_eq!(status, 404, "{op}: {body}");
    }
    // Moving content into the Notes changes who reads it, so the move is
    // reviewed first; the hidden label is not found already there.
    let only = |label: LabelId| MovedContent {
        labels: vec![label],
        ..MovedContent::default()
    };
    let refused = seeker
        .review_move_content(area, SourceId::map(), notes, only(hidden))
        .await;
    assert!(
        matches!(refused, Err(CloudError::NotFoundOrNoAccess)),
        "{refused:?}"
    );
    let review = seeker
        .review_move_content(area, SourceId::map(), notes, only(open))
        .await
        .expect("a label the editor reads is reviewed");
    seeker
        .commit_reviewed_move(review)
        .await
        .expect("a label the editor reads moves");
    let st = server.state.lock();
    let map = &st.areas[&area.0];
    assert!(
        map.labels
            .iter()
            .any(|label| label.id == hidden.0 && label.text == "Lever")
    );
    assert!(map.secrets[1].labels.iter().any(|label| label.id == open.0));
}

/// Moves keep attachments on the room itself: a room moved into a Secret
/// keeps the map's label on it, under the room's new address, and a label
/// moved into the Secret keeps its room.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn moves_keep_labels_on_their_rooms() {
    let server = MockServer::spawn().await;
    let owner = server.create_user("mover-labels@example.com", "moverlabels", true);
    let area = server.create_area(&owner, "Keep");
    place(&server, area, 1, 2.0, 3.0, 1);
    place(&server, area, 2, 0.0, 0.0, 0);
    let (mapper, _cache) = session(&server, &owner, "label-moves", area).await;
    let secret = mapper
        .create_secret(area, "Undercroft", None)
        .await
        .expect("create")
        .source;
    let SourceId::Secret(secret_id) = secret else {
        unreachable!("a Secret")
    };
    secret_room(&mapper, area, secret, 1, (9.0, 9.0, 4)).await;
    let label = LabelId(Uuid::new_v4());
    write(
        &mapper,
        area,
        SourceId::Map,
        vec![drawn(label, "Banner", Some(room_on_map(1)), 1.0, 1.0)],
    )
    .await;

    let moved = mapper
        .move_content(
            area,
            SourceId::map(),
            secret,
            MovedContent {
                rooms: vec![RoomNumber(1)],
                ..MovedContent::default()
            },
        )
        .await
        .expect("the room moves");
    assert_eq!(
        moved.renumbered,
        vec![smudgy_cloud::mutation::RoomRenumbering {
            from: RoomNumber(1),
            to: RoomNumber(2),
        }]
    );
    let wire = served_label(&server, &owner, area, "map", label).await;
    assert_eq!(
        (
            wire["room_number"].clone(),
            wire["room_source"].clone(),
            wire["level"].clone()
        ),
        (json!(2), json!(secret_id), json!(1)),
        "the label follows the room to its new address"
    );
    assert_eq!(
        (wire["x"].as_f64(), wire["y"].as_f64()),
        (Some(1.0), Some(1.0))
    );
    assert_eq!(
        client_label(&mapper, area, SourceId::Map, label),
        Some(parsed(&wire))
    );

    mapper
        .move_content(
            area,
            SourceId::map(),
            secret,
            MovedContent {
                labels: vec![label],
                ..MovedContent::default()
            },
        )
        .await
        .expect("the label moves");
    let wire = served_label(&server, &owner, area, &secret_id.to_string(), label).await;
    assert_eq!(
        (wire["room_number"].clone(), wire["room_source"].clone()),
        (json!(2), json!(secret_id))
    );
    assert_eq!(
        client_label(&mapper, area, secret, label),
        Some(parsed(&wire))
    );
    assert!(client_label(&mapper, area, SourceId::Map, label).is_none());
}

/// A copy keeps each label on the copied room it was attached to; a label
/// on a room the copy leaves out, here a room of a Secret the copier cannot
/// copy, stays behind with the original.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_copy_keeps_labels_on_the_rooms_it_carries() {
    let server = MockServer::spawn().await;
    let owner = server.create_user("copied@example.com", "copied", true);
    let friend = server.create_user("copier@example.com", "copier", true);
    let area = server.create_area(&owner, "Archive");
    place(&server, area, 1, 5.0, 5.0, 0);
    server.grant(
        &owner,
        &friend,
        GrantScope::Area(area),
        GrantFlags {
            can_copy: true,
            ..GrantFlags::VIEW_ONLY
        },
    );
    let (mapper, _cache) = session(&server, &owner, "label-copy", area).await;
    let secret = mapper
        .create_secret(area, "Stacks", None)
        .await
        .expect("create")
        .source;
    let SourceId::Secret(secret_id) = secret else {
        unreachable!("a Secret")
    };
    secret_room(&mapper, area, secret, 1, (8.0, 8.0, 2)).await;
    let (on_room, on_hidden, free, note) = (
        LabelId(Uuid::new_v4()),
        LabelId(Uuid::new_v4()),
        LabelId(Uuid::new_v4()),
        LabelId(Uuid::new_v4()),
    );
    write(
        &mapper,
        area,
        SourceId::Map,
        vec![
            drawn(on_room, "Index", Some(room_on_map(1)), 1.0, 0.0),
            drawn(
                on_hidden,
                "Restricted",
                Some(RoomAddress::new(secret, RoomNumber(1))),
                0.0,
                1.0,
            ),
            drawn(free, "Archive", None, 20.0, 20.0),
        ],
    )
    .await;
    write(
        &mapper,
        area,
        secret,
        vec![drawn(note, "Key under mat", Some(room_on_map(1)), 0.5, 0.5)],
    )
    .await;
    let texts = |labels: &[Value]| -> Vec<(String, Option<i64>, Option<String>)> {
        let mut texts: Vec<_> = labels
            .iter()
            .map(|label| {
                (
                    label["text"].as_str().expect("text").to_string(),
                    label["room_number"].as_i64(),
                    label["room_source"].as_str().map(str::to_string),
                )
            })
            .collect();
        texts.sort();
        texts
    };

    // The friend copies the map without the Secret.
    let copy = api_client(&server.base_url, &friend.api_key)
        .copy_area(area, &CopyAreaRequest::default())
        .await
        .expect("copy");
    let projection = served(&server, &friend, copy.id).await;
    assert_eq!(projection["sources"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        texts(&bundle_labels(&projection, "map")),
        vec![
            ("Archive".to_string(), None, None),
            ("Index".to_string(), Some(1), None),
        ],
        "the label on the Secret's room stays behind"
    );
    let original = served(&server, &owner, area).await;
    assert_eq!(
        bundle_labels(&original, "map").len(),
        3,
        "the original keeps all three"
    );

    // The owner's copy carries the Secret, and the labels on its room.
    let copy = api_client(&server.base_url, &owner.api_key)
        .copy_area(area, &CopyAreaRequest::default())
        .await
        .expect("copy");
    let projection = served(&server, &owner, copy.id).await;
    let copied_secret = projection["sources"][1]["source"]
        .as_str()
        .expect("the copied Secret")
        .to_string();
    assert_ne!(copied_secret, secret_id.to_string());
    assert_eq!(
        texts(&bundle_labels(&projection, "map")),
        vec![
            ("Archive".to_string(), None, None),
            ("Index".to_string(), Some(1), None),
            (
                "Restricted".to_string(),
                Some(1),
                Some(copied_secret.clone())
            ),
        ]
    );
    assert_eq!(
        texts(&bundle_labels(&projection, &copied_secret)),
        vec![("Key under mat".to_string(), Some(1), None)]
    );
    let restricted = bundle_labels(&projection, "map")
        .into_iter()
        .find(|label| label["text"] == "Restricted")
        .expect("copied");
    assert_eq!(restricted["level"], 2, "on the copied room's level");
}

/// After its room changes level, the client holds an attached label on the
/// room's new level, as the server serves it, without reading the map again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_client_holds_an_attached_label_on_its_rooms_new_level() {
    let server = MockServer::spawn().await;
    let owner = server.create_user("relevel@example.com", "relevel", true);
    let area = server.create_area(&owner, "Stairwell");
    place(&server, area, 1, 0.0, 0.0, 0);
    let (mapper, _cache) = session(&server, &owner, "label-relevel", area).await;
    let secret = mapper
        .create_secret(area, "Landing", None)
        .await
        .expect("create")
        .source;
    let (on_map, on_secret) = (LabelId(Uuid::new_v4()), LabelId(Uuid::new_v4()));
    write(
        &mapper,
        area,
        SourceId::Map,
        vec![drawn(on_map, "Up", Some(room_on_map(1)), 0.0, 1.0)],
    )
    .await;
    write(
        &mapper,
        area,
        secret,
        vec![drawn(
            on_secret,
            "Loose step",
            Some(room_on_map(1)),
            0.0,
            -1.0,
        )],
    )
    .await;

    let moved = mapper
        .upsert_room(
            RoomKey::new(area, RoomNumber(1)),
            RoomUpdates {
                level: Some(4),
                ..RoomUpdates::default()
            },
        )
        .expect("queued");
    mapper
        .wait_for_mutation(moved.operation_id().expect("a cloud write"))
        .await
        .expect("the room changes level");
    for (source, label) in [(SourceId::Map, on_map), (secret, on_secret)] {
        let wire = served_label(&server, &owner, area, &wire_id(source), label).await;
        assert_eq!(wire["level"], 4);
        assert_eq!(
            client_label(&mapper, area, source, label),
            Some(parsed(&wire))
        );
    }
}

/// Deleting a Secret's own room frees the map's label on it in the client's
/// state at once, where the server frees it, without reading the map again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_client_frees_the_maps_label_on_a_deleted_secret_room_at_once() {
    let server = MockServer::spawn().await;
    let owner = server.create_user("gone-room@example.com", "goneroom", true);
    let area = server.create_area(&owner, "Crypt");
    place(&server, area, 1, 0.0, 0.0, 0);
    let (mapper, _cache) = session(&server, &owner, "label-secret-room-gone", area).await;
    let secret = mapper
        .create_secret(area, "Ossuary", None)
        .await
        .expect("create")
        .source;
    secret_room(&mapper, area, secret, 1, (-4.0, 6.0, 5)).await;
    let label = LabelId(Uuid::new_v4());
    write(
        &mapper,
        area,
        SourceId::Map,
        vec![drawn(
            label,
            "Bones",
            Some(RoomAddress::new(secret, RoomNumber(1))),
            2.0,
            2.0,
        )],
    )
    .await;
    write(
        &mapper,
        area,
        secret,
        vec![AreaMutation::DeleteRoom {
            room_number: RoomNumber(1),
            room_source: Some(secret),
        }],
    )
    .await;
    let wire = served_label(&server, &owner, area, "map", label).await;
    assert_eq!(
        client_label(&mapper, area, SourceId::Map, label),
        Some(parsed(&wire))
    );
}
