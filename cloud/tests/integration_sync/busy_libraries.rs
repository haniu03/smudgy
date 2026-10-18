//! A busy Library answers 503 with `Retry-After`: the client waits that
//! long, keeps the maps on this device usable, and never reads the cloud's
//! silence as maps gone.

use super::*;
use smudgy_cloud::mapper::{AreaSaveStatus, MapperEvent};
use smudgy_cloud::{CompositeBackend, LocalBackend};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_busy_library_holds_an_edit_for_its_retry_after() {
    let server = MockServer::spawn().await;
    let user = server.create_user("busy-edit@example.com", "busy-edit", true);
    let area = server.create_area(&user, "Crowded Hall");
    server.add_room(area, 1, "Door");

    let cache_dir = TempCacheDir::new("busy-edit");
    let mapper = new_synced_mapper(&server.base_url, &user.api_key, cache_dir.path()).await;
    let mut events = mapper.subscribe_mapper_events();
    let path = format!("/areas/{area}/mutations");
    server.busy_next("POST", &path, 1, 1);

    mapper
        .upsert_room(
            RoomKey::new(area, RoomNumber(2)),
            RoomUpdates {
                title: Some("Waited".to_string()),
                ..RoomUpdates::default()
            },
        )
        .expect("enqueue room");
    wait_until(|| server.requests_to("POST", &path) == 1).await;
    let refused = std::time::Instant::now();
    assert!(
        matches!(
            mapper.area_save_status(area),
            AreaSaveStatus::Held(1) | AreaSaveStatus::Saving(1)
        ),
        "kept and waiting: {:?}",
        mapper.area_save_status(area)
    );

    assert!(
        mapper
            .wait_for_sync_completion(30)
            .await
            .expect("the retry lands"),
        "the queue drains once the Library answers"
    );
    assert!(
        refused.elapsed() >= Duration::from_millis(900),
        "the retry waited for the Retry-After: {:?}",
        refused.elapsed()
    );
    assert_eq!(server.requests_to("POST", &path), 2, "one retry");
    assert_eq!(server.mutation_requests().len(), 1, "applied once");
    while let Ok(event) = events.try_recv() {
        assert!(
            !matches!(event, MapperEvent::MutationFailed { .. }),
            "no failure is reported for a busy Library: {event:?}"
        );
    }
    assert_eq!(mapper.area_save_status(area), AreaSaveStatus::Saved);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_busy_map_list_loads_local_maps_and_the_cloud_maps_follow() {
    let server = MockServer::spawn().await;
    let owner = server.create_user("busy-list@example.com", "busy-list", true);
    let cloud_map = server.create_area(&owner, "Far Tower");
    server.add_room(cloud_map, 1, "Stair");
    // The map list, and the engine's first two row fetches, find their
    // Library busy.
    server.busy_next("GET", "/areas", 1, 1);
    server.busy_next("GET", "/sync", 2, 1);

    let cache = TempCacheDir::new("busy-list");
    let local = Arc::new(LocalBackend::new(cache.path().join("local")));
    let local_map = local
        .create_area(smudgy_cloud::CreateAreaRequest {
            name: "Home".into(),
            atlas_id: None,
            clan_id: None,
            ownership: None,
            ephemeral: false,
            properties: BTreeMap::new(),
        })
        .await
        .unwrap()
        .id;
    let cloud = Arc::new(CachedCloudMapper::new(
        CloudMapper::new(server.base_url.clone(), owner.api_key.clone()),
        cache.path().join("cloud"),
    ));
    let mapper = Mapper::new(
        Arc::new(CompositeBackend::new(local, cloud)),
        cache.path().join("mapper"),
    );

    let summary = mapper.load_initial_areas().await.expect("local maps load");
    assert!(
        matches!(
            summary.cloud_unavailable,
            Some(CloudError::ServiceUnavailable {
                retry_after: Some(retry_after),
                ..
            }) if retry_after == Duration::from_secs(1)
        ),
        "{:?}",
        summary.cloud_unavailable
    );
    assert!(mapper.get_current_atlas().get_area(&local_map).is_some());
    assert!(
        matches!(
            mapper.import_areas_if_absent(Vec::new()).await,
            Err(CloudError::ServiceUnavailable { .. })
        ),
        "no seeding against a list that left out the cloud maps"
    );

    // No sync request: the engine retries on its own, a second or two
    // after each busy answer.
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while mapper.get_current_atlas().get_area(&cloud_map).is_none() {
        assert!(
            std::time::Instant::now() < deadline,
            "the cloud map arrives without a sync request: {:?}",
            mapper.sync_status()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(server.requests_to("GET", "/sync") >= 3);
    assert!(mapper.get_current_atlas().get_area(&local_map).is_some());
}
