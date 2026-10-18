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

/// A mapper over a local tier holding "Home" and the mock's cloud tier.
async fn composite_mapper(
    server: &super::support::MockHandle,
    api_key: &str,
    cache: &TempCacheDir,
) -> (Mapper, AreaId) {
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
        CloudMapper::new(server.base_url.clone(), api_key.to_string()),
        cache.path().join("cloud"),
    ));
    let mapper = Mapper::new(
        Arc::new(CompositeBackend::new(local, cloud)),
        cache.path().join("mapper"),
    );
    (mapper, local_map)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_busy_map_list_is_retried_and_its_maps_follow() {
    let server = MockServer::spawn().await;
    let owner = server.create_user("busy-list@example.com", "busy-list", true);
    let cloud_map = server.create_area(&owner, "Far Tower");
    server.add_room(cloud_map, 1, "Stair");
    // The map list finds its Library busy twice; the sync engine's rows
    // stay busy throughout, so only the load brings the cloud map.
    server.busy_next("GET", "/areas", 2, 1);
    server.busy_next("GET", "/sync", 1_000, 1);
    let cache = TempCacheDir::new("busy-list");
    let (mapper, local_map) = composite_mapper(&server, &owner.api_key, &cache).await;

    let mut progress = mapper.load_progress();
    let session = tokio::spawn({
        let mapper = mapper.clone();
        async move { mapper.load_initial_areas().await }
    });
    progress
        .wait_for(|summary| summary.first_pass)
        .await
        .expect("a first pass");
    let first = progress.borrow().clone();
    assert!(
        matches!(
            first.cloud_unavailable,
            Some(CloudError::ServiceUnavailable {
                retry_after: Some(retry_after),
                ..
            }) if retry_after == Duration::from_secs(1)
        ),
        "{:?}",
        first.cloud_unavailable
    );
    assert!(mapper.get_current_atlas().get_area(&local_map).is_some());
    assert!(mapper.get_current_atlas().get_area(&cloud_map).is_none());
    assert!(
        matches!(
            mapper.import_areas_if_absent(Vec::new()).await,
            Err(CloudError::ServiceUnavailable { .. })
        ),
        "no seeding against a list that left out the cloud maps"
    );

    // The session's wait covers the retries: it starts with every map.
    let summary = session.await.unwrap().expect("the session starts");
    assert!(summary.settled, "{summary:?}");
    assert_eq!(summary.total, Some(2));
    assert_eq!(summary.areas.len(), 2);
    assert!(summary.cloud_unavailable.is_none());
    assert!(mapper.get_current_atlas().get_area(&cloud_map).is_some());
    assert_eq!(server.requests_to("GET", "/areas"), 3);
    mapper
        .import_areas_if_absent(Vec::new())
        .await
        .expect("seeding checks against the listed maps");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_map_its_library_cannot_serve_yet_follows_the_rest() {
    let server = MockServer::spawn().await;
    let owner = server.create_user("busy-map@example.com", "busy-map", true);
    let quick = server.create_area(&owner, "Quick");
    let slow = server.create_area(&owner, "Slow");
    server.busy_next("GET", &format!("/areas/{slow}"), 2, 1);
    server.busy_next("GET", "/sync", 1_000, 1);
    let cache = TempCacheDir::new("busy-map");
    let (mapper, _) = composite_mapper(&server, &owner.api_key, &cache).await;

    let mut progress = mapper.load_progress();
    let session = tokio::spawn({
        let mapper = mapper.clone();
        async move { mapper.load_initial_areas().await }
    });
    progress
        .wait_for(|summary| summary.first_pass)
        .await
        .expect("a first pass");
    {
        let first = progress.borrow();
        assert_eq!(first.total, Some(3));
        assert_eq!(first.areas.len(), 2, "{first:?}");
        assert!(matches!(
            first.failure,
            Some(CloudError::ServiceUnavailable { .. })
        ));
    }
    assert!(mapper.get_current_atlas().get_area(&quick).is_some());
    assert!(mapper.get_current_atlas().get_area(&slow).is_none());

    let summary = session.await.unwrap().expect("the session starts");
    assert!(summary.settled, "{summary:?}");
    assert_eq!(summary.areas.len(), 3);
    assert!(summary.failure.is_none());
    assert!(mapper.get_current_atlas().get_area(&slow).is_some());
    assert_eq!(server.requests_to("GET", &format!("/areas/{slow}")), 3);
}
