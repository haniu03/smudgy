//! Receiving-session registries for directed state consumers.
//!
//! Callback ids and widget cells stay on the receiving session thread. Source
//! sessions publish immutable roots and send only data-only flush notices.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use smudgy_cloud::{Node, StoreBindingCell, StoreBindings};

use super::script_engine::FunctionId;
use super::store::{ProducerKey, PublishedStore, PublishedWrite, StorePath, WatchCadence};
use super::trigger::MatchCapture;
use super::{IsolateId, MAX_EVENT_DEPTH, RuntimeAction};
use crate::session::SessionId;

pub(crate) type SharedRemoteStateRegistry = Rc<RefCell<RemoteStateRegistry>>;

#[derive(Clone)]
struct RemoteWatcher {
    source: SessionId,
    producer: ProducerKey,
    path: StorePath,
    isolate: IsolateId,
    function_id: FunctionId,
    cadence: WatchCadence,
}

struct RemoteBinding {
    source: SessionId,
    producer: ProducerKey,
    path: StorePath,
    cell: Arc<StoreBindingCell>,
}

#[derive(Default)]
pub(crate) struct RemoteStateRegistry {
    watchers: Vec<Option<RemoteWatcher>>,
    bindings: HashMap<u32, RemoteBinding>,
    binding_ids: HashMap<(SessionId, ProducerKey, Vec<String>), u32>,
    shared_bindings: StoreBindings,
}

impl RemoteStateRegistry {
    #[must_use]
    pub fn new(shared_bindings: StoreBindings) -> Self {
        Self {
            shared_bindings,
            ..Self::default()
        }
    }

    pub fn watch(
        &mut self,
        source: SessionId,
        producer: ProducerKey,
        path: StorePath,
        isolate: IsolateId,
        function_id: FunctionId,
        cadence: WatchCadence,
    ) -> u32 {
        self.watchers.push(Some(RemoteWatcher {
            source,
            producer,
            path,
            isolate,
            function_id,
            cadence,
        }));
        u32::try_from(self.watchers.len() - 1).unwrap_or(u32::MAX)
    }

    pub fn unwatch(&mut self, token: u32, isolate: &IsolateId) {
        let Ok(index) = usize::try_from(token) else {
            return;
        };
        if let Some(slot) = self.watchers.get_mut(index)
            && slot
                .as_ref()
                .is_some_and(|watcher| watcher.isolate == *isolate)
        {
            *slot = None;
        }
    }

    pub fn bind(
        &mut self,
        source: SessionId,
        producer: ProducerKey,
        path: StorePath,
        published: Option<&PublishedStore>,
    ) -> u32 {
        let folded = path
            .segments()
            .iter()
            .map(|segment| segment.to_ascii_lowercase())
            .collect::<Vec<_>>();
        let key = (source, producer.clone(), folded);
        if let Some(id) = self.binding_ids.get(&key) {
            return *id;
        }
        let seed = published
            .and_then(|store| store.node(&producer, &path))
            .unwrap_or(Node::Null);
        let cell = Arc::new(StoreBindingCell::new(seed));
        let id = self.shared_bindings.allocate(Arc::clone(&cell));
        self.bindings.insert(
            id,
            RemoteBinding {
                source,
                producer,
                path,
                cell,
            },
        );
        self.binding_ids.insert(key, id);
        id
    }

    /// Resolve this receiving engine's callbacks and cells for one source
    /// flush. Returns callback actions plus whether any binding cell changed.
    pub fn deliver(
        &mut self,
        source: SessionId,
        published: &PublishedStore,
        writes: &[PublishedWrite],
    ) -> (Vec<RuntimeAction>, bool) {
        let mut actions = Vec::new();
        for watcher in self.watchers.iter().flatten() {
            if watcher.source != source {
                continue;
            }
            match watcher.cadence {
                WatchCadence::PerWrite => {
                    for write in writes {
                        if write.producer != watcher.producer
                            || !paths_comparable(write.path.segments(), watcher.path.segments())
                            || write.depth >= MAX_EVENT_DEPTH
                        {
                            continue;
                        }
                        actions.push(RuntimeAction::CallJavascriptFunction {
                            isolate: watcher.isolate.clone(),
                            id: watcher.function_id,
                            matches: Arc::new(vec![
                                MatchCapture {
                                    name: Some(std::borrow::Cow::Borrowed("path")),
                                    value: write.path.to_string(),
                                },
                                MatchCapture {
                                    name: Some(std::borrow::Cow::Borrowed("snapshot")),
                                    value: write.value.to_json(),
                                },
                            ]),
                            depth: write.depth + 1,
                            is_captured: None,
                        });
                    }
                }
                WatchCadence::Coalesced => {
                    let depth = writes
                        .iter()
                        .filter(|write| {
                            write.producer == watcher.producer
                                && paths_comparable(write.path.segments(), watcher.path.segments())
                        })
                        .map(|write| write.depth)
                        .min();
                    let Some(depth) = depth else { continue };
                    if depth >= MAX_EVENT_DEPTH {
                        continue;
                    }
                    let snapshot = published.get_json(&watcher.producer, &watcher.path, false);
                    actions.push(RuntimeAction::CallJavascriptFunction {
                        isolate: watcher.isolate.clone(),
                        id: watcher.function_id,
                        matches: Arc::new(vec![
                            MatchCapture {
                                name: Some(std::borrow::Cow::Borrowed("snapshot")),
                                value: snapshot.clone().unwrap_or_else(|| "null".to_string()),
                            },
                            MatchCapture {
                                name: Some(std::borrow::Cow::Borrowed("present")),
                                value: snapshot.is_some().to_string(),
                            },
                        ]),
                        depth: depth + 1,
                        is_captured: None,
                    });
                }
            }
        }

        let mut bindings_changed = false;
        for binding in self.bindings.values() {
            if binding.source != source
                || !writes.iter().any(|write| {
                    write.producer == binding.producer
                        && paths_comparable(write.path.segments(), binding.path.segments())
                })
            {
                continue;
            }
            binding.cell.set(
                published
                    .node(&binding.producer, &binding.path)
                    .unwrap_or(Node::Null),
            );
            bindings_changed = true;
        }
        (actions, bindings_changed)
    }

    /// Invalidate directed views after their source session leaves the
    /// registry. Coalesced watchers observe the now-absent snapshot once;
    /// per-write watchers do not fire because destruction is not a write.
    pub fn source_destroyed(&mut self, source: SessionId) -> (Vec<RuntimeAction>, bool) {
        let actions = self
            .watchers
            .iter()
            .flatten()
            .filter(|watcher| {
                watcher.source == source && watcher.cadence == WatchCadence::Coalesced
            })
            .map(|watcher| RuntimeAction::CallJavascriptFunction {
                isolate: watcher.isolate.clone(),
                id: watcher.function_id,
                matches: Arc::new(vec![
                    MatchCapture {
                        name: Some(std::borrow::Cow::Borrowed("snapshot")),
                        value: "null".to_string(),
                    },
                    MatchCapture {
                        name: Some(std::borrow::Cow::Borrowed("present")),
                        value: "false".to_string(),
                    },
                ]),
                depth: 1,
                is_captured: None,
            })
            .collect();

        let mut bindings_changed = false;
        for binding in self
            .bindings
            .values()
            .filter(|binding| binding.source == source)
        {
            binding.cell.set(Node::Null);
            bindings_changed = true;
        }
        (actions, bindings_changed)
    }
}

fn paths_comparable(left: &[String], right: &[String]) -> bool {
    let common = left.len().min(right.len());
    left[..common]
        .iter()
        .zip(&right[..common])
        .all(|(a, b)| a.eq_ignore_ascii_case(b))
}

#[cfg(test)]
mod tests {
    use super::super::store::SessionStore;
    use super::*;
    use serde_json::json;

    fn path(value: &str) -> StorePath {
        StorePath::parse(value).expect("valid test path")
    }

    fn capture<'a>(action: &'a RuntimeAction, name: &str) -> &'a str {
        let RuntimeAction::CallJavascriptFunction { matches, .. } = action else {
            panic!("expected a callback action")
        };
        matches
            .iter()
            .find(|capture| capture.name.as_deref() == Some(name))
            .map(|capture| capture.value.as_str())
            .expect("named capture")
    }

    #[test]
    fn directed_watch_and_binding_follow_only_the_named_source() {
        let source = SessionId::from(7);
        let other = SessionId::from(8);
        let producer = ProducerKey::User;
        let watched = path("vitals.hp");
        let mut store = SessionStore::new();
        store
            .set(
                producer.clone(),
                path("vitals"),
                json!({ "hp": 10, "maxhp": 20 }),
                IsolateId::Main,
                0,
            )
            .unwrap();
        store.flush();

        let local_binding = store.bind(producer.clone(), path("vitals.maxhp"));
        let shared = store.bindings();
        let mut registry = RemoteStateRegistry::new(shared.clone());
        registry.watch(
            source,
            producer.clone(),
            watched.clone(),
            IsolateId::Main,
            FunctionId(3),
            WatchCadence::Coalesced,
        );
        let remote_binding = registry.bind(
            source,
            producer.clone(),
            watched.clone(),
            Some(&store.published()),
        );
        assert_ne!(
            local_binding, remote_binding,
            "binding token namespaces are shared"
        );
        assert_eq!(shared.cell(remote_binding).unwrap().load().to_json(), "10");

        store
            .set(producer, watched, json!(11), IsolateId::Main, 4)
            .unwrap();
        store.flush();
        let published = store.published();
        let writes = store.last_published_writes();

        let (wrong_actions, wrong_binding) = registry.deliver(other, &published, &writes);
        assert!(wrong_actions.is_empty());
        assert!(!wrong_binding);

        let (actions, binding_changed) = registry.deliver(source, &published, &writes);
        assert!(binding_changed);
        assert_eq!(actions.len(), 1);
        assert_eq!(capture(&actions[0], "snapshot"), "11");
        assert_eq!(capture(&actions[0], "present"), "true");
        assert_eq!(shared.cell(remote_binding).unwrap().load().to_json(), "11");
    }

    #[test]
    fn destroying_a_source_invalidates_coalesced_views_but_is_not_a_write() {
        let source = SessionId::from(7);
        let producer = ProducerKey::User;
        let watched = path("vitals");
        let shared = StoreBindings::new();
        let mut registry = RemoteStateRegistry::new(shared.clone());
        registry.watch(
            source,
            producer.clone(),
            watched.clone(),
            IsolateId::Main,
            FunctionId(1),
            WatchCadence::Coalesced,
        );
        registry.watch(
            source,
            producer.clone(),
            watched.clone(),
            IsolateId::Main,
            FunctionId(2),
            WatchCadence::PerWrite,
        );
        let binding = registry.bind(source, producer, watched, None);

        let (actions, binding_changed) = registry.source_destroyed(source);
        assert!(binding_changed);
        assert_eq!(
            actions.len(),
            1,
            "destruction does not synthesize an onWrite call"
        );
        assert_eq!(capture(&actions[0], "present"), "false");
        assert_eq!(shared.cell(binding).unwrap().load().to_json(), "null");
    }

    #[test]
    fn path_comparison_is_case_insensitive_and_ancestor_aware() {
        assert!(paths_comparable(
            path("Vitals.HP").segments(),
            path("vitals").segments()
        ));
        assert!(paths_comparable(
            path("vitals").segments(),
            path("VITALS.hp").segments()
        ));
        assert!(!paths_comparable(
            path("vitals.hp").segments(),
            path("vitals.mana").segments()
        ));
    }
}
