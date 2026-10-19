//! Fetches cloud maps one at a time per Library and from a few Libraries at
//! once. A Library runs one call at a time, so a second request to a busy
//! one only queues behind the first on the server; spreading across
//! Libraries keeps one slow Library from holding up the rest.

use std::{collections::HashMap, sync::Arc};

use parking_lot::Mutex;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::{Area, AreaId, AreaWithDetails, CloudResult, backends::MapperBackend};

/// How many Libraries are fetched from at once.
pub(super) const LIBRARIES_AT_ONCE: usize = 6;

/// The Library that serves a cloud map: its clan's, or its owner's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum Library {
    Clan(Uuid),
    User(Uuid),
    /// A map no list has named yet. It has no lane: nothing says which
    /// Library to queue it behind, so only the slots limit it.
    Unknown,
}

impl Library {
    #[must_use]
    pub(super) fn of(clan_id: Option<Uuid>, user_id: Option<Uuid>) -> Self {
        match (clan_id, user_id) {
            (Some(clan), _) => Self::Clan(clan),
            (None, Some(user)) => Self::User(user),
            (None, None) => Self::Unknown,
        }
    }

    #[must_use]
    pub(super) fn of_area(area: &Area) -> Self {
        Self::of(area.clan_id, area.user_id)
    }
}

pub(super) struct Fetcher {
    /// Each Library's lane; holding a lane's lock is that Library's one
    /// request in flight.
    lanes: Mutex<HashMap<Library, Arc<tokio::sync::Mutex<()>>>>,
    /// Lanes allowed to send at once.
    slots: Semaphore,
    /// The Library of each map a list has named.
    libraries: Mutex<HashMap<AreaId, Library>>,
}

impl Fetcher {
    pub(super) fn new() -> Self {
        Self::with_slots(LIBRARIES_AT_ONCE)
    }

    pub(super) fn with_slots(slots: usize) -> Self {
        Self {
            lanes: Mutex::new(HashMap::new()),
            slots: Semaphore::new(slots),
            libraries: Mutex::new(HashMap::new()),
        }
    }

    /// Records the Library each listed map lives in.
    pub(super) fn note_libraries(&self, maps: impl IntoIterator<Item = (AreaId, Library)>) {
        self.libraries.lock().extend(maps);
    }

    fn library_of(&self, area_id: AreaId) -> Library {
        self.libraries
            .lock()
            .get(&area_id)
            .copied()
            .unwrap_or(Library::Unknown)
    }

    fn lane(&self, library: Library) -> Arc<tokio::sync::Mutex<()>> {
        self.lanes.lock().entry(library).or_default().clone()
    }

    /// Fetches `area_id` under credential generation `auth_generation`,
    /// waiting first for its Library's lane and then for a free slot.
    pub(super) async fn get(
        &self,
        backend: &dyn MapperBackend,
        area_id: AreaId,
        auth_generation: u64,
    ) -> CloudResult<AreaWithDetails> {
        let library = self.library_of(area_id);
        let lane = (library != Library::Unknown).then(|| self.lane(library));
        let _lane = match &lane {
            Some(lane) => Some(lane.lock().await),
            None => None,
        };
        let _slot = self
            .slots
            .acquire()
            .await
            .expect("the fetch slots are never closed");
        backend
            .get_area_at_generation(&area_id, auth_generation)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AreaUpdates, CloudError, CreateAreaRequest};
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// Records how many fetches run at once, overall and per Library.
    #[derive(Default)]
    struct Counting {
        running: AtomicUsize,
        most: AtomicUsize,
        per_library: Mutex<HashMap<Library, usize>>,
        most_per_library: AtomicUsize,
        library_of: Mutex<HashMap<AreaId, Library>>,
    }

    #[async_trait]
    impl MapperBackend for Counting {
        async fn create_area(&self, _: CreateAreaRequest) -> CloudResult<Area> {
            Err(CloudError::InvalidInput("unused".into()))
        }
        async fn list_areas(&self) -> CloudResult<Vec<Area>> {
            Ok(Vec::new())
        }
        async fn get_area(&self, area_id: &AreaId) -> CloudResult<AreaWithDetails> {
            let library = self.library_of.lock()[area_id];
            let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
            self.most.fetch_max(now, Ordering::SeqCst);
            let in_library = {
                let mut per = self.per_library.lock();
                let count = per.entry(library).or_default();
                *count += 1;
                *count
            };
            self.most_per_library
                .fetch_max(in_library, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            *self.per_library.lock().get_mut(&library).unwrap() -= 1;
            self.running.fetch_sub(1, Ordering::SeqCst);
            Err(CloudError::NotFoundOrNoAccess)
        }
        async fn update_area(&self, _: &AreaId, _: AreaUpdates) -> CloudResult<()> {
            Ok(())
        }
        async fn delete_area(&self, _: &AreaId) -> CloudResult<()> {
            Ok(())
        }
        async fn execute_mutation(
            &self,
            _: &AreaId,
            _: &crate::mutation::MutationEnvelope,
        ) -> CloudResult<crate::mutation::MutationResult> {
            Err(CloudError::InvalidInput("unused".into()))
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn one_request_per_library_and_a_few_libraries_at_once() {
        let backend = Arc::new(Counting::default());
        let fetcher = Arc::new(Fetcher::with_slots(3));
        let mut maps = Vec::new();
        for _ in 0..5 {
            let library = Library::User(Uuid::new_v4());
            for _ in 0..4 {
                let id = AreaId(Uuid::new_v4());
                backend.library_of.lock().insert(id, library);
                maps.push((id, library));
            }
        }
        fetcher.note_libraries(maps.iter().copied());

        let mut tasks = tokio::task::JoinSet::new();
        for (id, _) in maps {
            let (backend, fetcher) = (backend.clone(), fetcher.clone());
            tasks.spawn(async move {
                let _ = fetcher.get(&*backend, id, 0).await;
            });
        }
        while tasks.join_next().await.is_some() {}

        assert_eq!(backend.most_per_library.load(Ordering::SeqCst), 1);
        assert_eq!(backend.most.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_clan_map_lives_in_its_clans_library() {
        let (clan, user) = (Uuid::new_v4(), Uuid::new_v4());
        assert_eq!(Library::of(Some(clan), None), Library::Clan(clan));
        assert_eq!(Library::of(Some(clan), Some(user)), Library::Clan(clan));
        assert_eq!(Library::of(None, Some(user)), Library::User(user));
        assert_eq!(Library::of(None, None), Library::Unknown);
    }
}
