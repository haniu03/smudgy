//! What waits on the signed-in user's answer: clan invitations, Secret and
//! map ownership offers, friend requests, and transfer offers. Settings
//! counts each tab's share beside its nav item and the main toolbar counts
//! their sum beside Settings, from one `GET /me/pending` read at launch, once
//! an hour, and when Settings or the map editor opens. A Settings tab that
//! has loaded its own lists counts those instead.

use smudgy_cloud::Uuid;
use smudgy_cloud::clan_secrets::OwnershipOffer;
use smudgy_cloud::cloud_api::{CloudApiClient, FriendRequestView, TransferView};

use crate::cloud_account::AccountSnapshot;
use crate::components::clan_map_offers::MapOffers;

/// How often the counts are read again while nothing else asks.
pub const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3600);

/// How many answers each Settings tab waits on; `None` while unknown.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Pending {
    pub clans: Option<usize>,
    pub friends: Option<usize>,
}

impl Pending {
    /// Takes every count `newer` knows, keeping the rest.
    pub fn absorb(&mut self, newer: Pending) {
        if newer.clans.is_some() {
            self.clans = newer.clans;
        }
        if newer.friends.is_some() {
            self.friends = newer.friends;
        }
    }

    /// Every known count together.
    #[must_use]
    pub fn total(self) -> usize {
        self.clans.unwrap_or(0) + self.friends.unwrap_or(0)
    }
}

/// Clan invitations, and the Secret and map ownership offers `me` has not
/// accepted yet.
#[must_use]
pub fn clans_waiting(
    invitations: usize,
    secret_offers: &[OwnershipOffer],
    map_offers: &MapOffers,
    me: Option<Uuid>,
) -> usize {
    invitations
        + map_offers.waiting(me)
        + secret_offers
            .iter()
            .filter(|offer| !me.is_some_and(|me| offer.accepted_by(me)))
            .count()
}

/// Incoming friend requests, and the transfer offers made to the caller.
#[must_use]
pub fn friends_waiting(incoming: &[FriendRequestView], received: &[TransferView]) -> usize {
    incoming.len() + received.len()
}

/// Whose answers the counts wait on: the verified account signed in, by
/// credential generation. A credential change is a new account even when
/// the user is the same.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Account(u64);

impl Account {
    #[must_use]
    pub fn of(snapshot: &AccountSnapshot, generation: u64) -> Option<Self> {
        (snapshot.signed_in && snapshot.email_verified).then_some(Self(generation))
    }
}

/// The counts, for the account they were read under.
#[derive(Debug, Default)]
pub struct Watch {
    account: Option<Account>,
    counts: Pending,
}

impl Watch {
    /// The account the counts belong to.
    #[must_use]
    pub fn account(&self) -> Option<Account> {
        self.account
    }

    /// Follows `account`; the counts start over when it changes. Returns
    /// whether it did.
    pub fn follow(&mut self, account: Option<Account>) -> bool {
        if self.account == account {
            return false;
        }
        self.account = account;
        self.counts = Pending::default();
        true
    }

    /// Takes the counts read under `account`, unless another is followed
    /// by now.
    pub fn absorb(&mut self, account: Option<Account>, counts: Pending) {
        if account.is_some() && account == self.account {
            self.counts.absorb(counts);
        }
    }

    /// Each tab's count, as last read.
    #[must_use]
    pub fn counts(&self) -> Pending {
        self.counts
    }

    /// Everything waiting, for the toolbar.
    #[must_use]
    pub fn total(&self) -> usize {
        self.counts.total()
    }
}

/// Reads the counts in one call. A failure leaves both unknown, so the last
/// ones read stand.
pub async fn fetch(client: CloudApiClient) -> Pending {
    match client.pending_counts().await {
        Ok(counts) => Pending {
            clans: Some(counts.clans()),
            friends: Some(counts.friends()),
        },
        Err(err) => {
            log::debug!("pending counts unavailable: {err}");
            Pending::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_read_keeps_the_counts_it_does_not_know() {
        let mut pending = Pending {
            clans: Some(2),
            friends: Some(1),
        };
        pending.absorb(Pending {
            clans: None,
            friends: Some(3),
        });
        assert_eq!(pending.clans, Some(2));
        assert_eq!(pending.friends, Some(3));
        assert_eq!(pending.total(), 5);
    }

    #[test]
    fn counts_start_over_for_another_account() {
        let mut watch = Watch::default();
        assert!(watch.follow(Some(Account(1))));
        watch.absorb(
            Some(Account(1)),
            Pending {
                clans: Some(1),
                friends: Some(2),
            },
        );
        assert_eq!(watch.total(), 3);

        assert!(!watch.follow(Some(Account(1))));
        assert_eq!(watch.total(), 3);

        assert!(watch.follow(Some(Account(2))));
        assert_eq!(watch.total(), 0);
        assert_eq!(watch.counts(), Pending::default());
    }

    #[test]
    fn a_read_for_an_account_no_longer_followed_is_dropped() {
        let four_clans = Pending {
            clans: Some(4),
            friends: None,
        };
        let mut watch = Watch::default();
        watch.follow(Some(Account(2)));
        watch.absorb(Some(Account(1)), four_clans);
        assert_eq!(watch.total(), 0);

        watch.follow(None);
        watch.absorb(None, four_clans);
        assert_eq!(watch.total(), 0);
    }

    #[test]
    fn only_a_verified_account_signed_in_is_watched() {
        let verified = AccountSnapshot {
            signed_in: true,
            email_verified: true,
            ..AccountSnapshot::default()
        };
        assert_eq!(Account::of(&verified, 7), Some(Account(7)));
        let unverified = AccountSnapshot {
            email_verified: false,
            ..verified.clone()
        };
        assert_eq!(Account::of(&unverified, 7), None);
        let signed_out = AccountSnapshot {
            signed_in: false,
            ..verified
        };
        assert_eq!(Account::of(&signed_out, 7), None);
    }
}
