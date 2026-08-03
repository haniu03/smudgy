//! The binding engine: mapping live sessions onto template slots.
//!
//! One pure function serves every consumer — user-initiated template
//! restore (named layouts and last-session snapshots alike), and session
//! open/close vacancy maintenance:
//!
//! - **Exact first**: same server, same profile. Duplicates tie-break
//!   deterministically, lowest live ordinal to lowest stored ordinal.
//! - **Fallback**: remaining sessions match remaining unpaired slots of the
//!   same server, lowest ordinal to lowest ordinal. Never across servers.
//! - Unmatched slots stay vacant; unmatched sessions keep their current
//!   arrangement (they simply do not appear in the result).
//!
//! Ordinals are list positions — a slot's position in the template's slot
//! list, a session's position in the caller-ordered live list (session-id
//! order, which is open order) — never raw runtime ids.
//!
//! Server and profile comparisons are deliberately case-exact (byte
//! equality). The descriptors on both sides are the models' stored names —
//! snapshots write them back verbatim, and live sessions carry the same
//! strings — so the two spellings of a name can only meet here when they
//! are genuinely two distinct profiles on disk, and folding would conflate
//! them.

/// One template slot's descriptors, in stored-ordinal order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotDescriptor<'a> {
    pub server: &'a str,
    /// The profile *preference* — an exact match claims it first, but a
    /// same-server session can still fall back onto the slot.
    pub profile: &'a str,
}

/// One live session, in live-ordinal order. `I` is whatever identity the
/// caller wants back (a `SessionId`, a test integer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveSession<'a, I> {
    pub id: I,
    pub server: &'a str,
    pub profile: &'a str,
}

/// Bind `live` sessions onto `slots`. The result has one entry per slot, in
/// slot order: the bound session's id, or `None` for a vacancy. Every
/// session appears at most once; sessions the template cannot place are
/// simply absent. Server/profile matching is case-exact by design (see the
/// module docs).
#[must_use]
pub fn bind<I: Copy>(slots: &[SlotDescriptor<'_>], live: &[LiveSession<'_, I>]) -> Vec<Option<I>> {
    let mut bound: Vec<Option<I>> = vec![None; slots.len()];
    let mut taken = vec![false; live.len()];

    // Exact pass: walking slots in stored order and taking the lowest
    // untaken live index is precisely the lowest-live↔lowest-stored
    // tie-break for duplicate profiles.
    for (slot_index, slot) in slots.iter().enumerate() {
        if let Some(live_index) = live.iter().enumerate().position(|(i, session)| {
            !taken[i] && session.server == slot.server && session.profile == slot.profile
        }) {
            taken[live_index] = true;
            bound[slot_index] = Some(live[live_index].id);
        }
    }

    // Fallback pass: same server only — a session never crosses servers,
    // whatever is vacant.
    for (slot_index, slot) in slots.iter().enumerate() {
        if bound[slot_index].is_some() {
            continue;
        }
        if let Some(live_index) = live
            .iter()
            .enumerate()
            .position(|(i, session)| !taken[i] && session.server == slot.server)
        {
            taken[live_index] = true;
            bound[slot_index] = Some(live[live_index].id);
        }
    }

    bound
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot<'a>(server: &'a str, profile: &'a str) -> SlotDescriptor<'a> {
        SlotDescriptor { server, profile }
    }

    fn session<'a>(id: u32, server: &'a str, profile: &'a str) -> LiveSession<'a, u32> {
        LiveSession {
            id,
            server,
            profile,
        }
    }

    #[test]
    fn exact_match_beats_ordinal_position() {
        // The imm session appears later in live order, but the imm slot
        // takes it exactly; the earlier alt session falls back onto the
        // remaining same-server slot.
        let slots = [slot("Arctic", "imm"), slot("Arctic", "alt")];
        let live = [session(1, "Arctic", "alt"), session(2, "Arctic", "imm")];
        assert_eq!(bind(&slots, &live), vec![Some(2), Some(1)]);
    }

    #[test]
    fn duplicate_profiles_tie_break_lowest_to_lowest() {
        // Two identical slots, two identical sessions: pairwise by ordinal,
        // deterministically.
        let slots = [slot("Arctic", "imm"), slot("Arctic", "imm")];
        let live = [session(7, "Arctic", "imm"), session(9, "Arctic", "imm")];
        assert_eq!(bind(&slots, &live), vec![Some(7), Some(9)]);
    }

    #[test]
    fn same_server_fallback_matches_lowest_to_lowest() {
        // No exact profile anywhere: remaining sessions fill remaining
        // same-server slots in ordinal order.
        let slots = [slot("Arctic", "one"), slot("Arctic", "two")];
        let live = [session(1, "Arctic", "x"), session(2, "Arctic", "y")];
        assert_eq!(bind(&slots, &live), vec![Some(1), Some(2)]);
    }

    #[test]
    fn never_binds_across_servers() {
        // The only live session is on another server: the slot must stay
        // vacant even though it is otherwise free.
        let slots = [slot("Arctic", "imm")];
        let live = [session(1, "Elsewhere", "imm")];
        assert_eq!(bind(&slots, &live), vec![None]);
    }

    #[test]
    fn unmatched_slots_stay_vacant_and_extra_sessions_are_untouched() {
        let slots = [
            slot("Arctic", "imm"),
            slot("Arctic", "alt"),
            slot("Quiet", "solo"),
        ];
        let live = [
            session(1, "Arctic", "imm"),
            session(2, "Arctic", "spare"), // takes the alt slot by fallback
            session(3, "Arctic", "extra"), // no slot left: untouched
        ];
        let bound = bind(&slots, &live);
        assert_eq!(bound, vec![Some(1), Some(2), None]);
        // Session 3 appears nowhere — the caller leaves its arrangement be.
        assert!(!bound.contains(&Some(3)));
    }

    #[test]
    fn exact_claims_win_before_any_fallback_runs() {
        // The fallback must not consume a session another slot matches
        // exactly: slot 0 (fallback-only) takes the SECOND session because
        // the first is exactly claimed by slot 1.
        let slots = [slot("Arctic", "nomatch"), slot("Arctic", "imm")];
        let live = [session(1, "Arctic", "imm"), session(2, "Arctic", "other")];
        assert_eq!(bind(&slots, &live), vec![Some(2), Some(1)]);
    }

    #[test]
    fn launch_restore_shape_is_trivially_exact() {
        // Restore spawns one session per slot with identical descriptors:
        // the engine binds them index to index.
        let slots = [
            slot("Arctic", "imm"),
            slot("Arctic", "imm"),
            slot("Quiet", "solo"),
        ];
        let live = [
            session(10, "Arctic", "imm"),
            session(11, "Arctic", "imm"),
            session(12, "Quiet", "solo"),
        ];
        assert_eq!(bind(&slots, &live), vec![Some(10), Some(11), Some(12)]);
    }

    #[test]
    fn empty_inputs_are_clean() {
        assert_eq!(bind::<u32>(&[], &[]), Vec::<Option<u32>>::new());
        assert_eq!(
            bind(&[slot("A", "p")], &[] as &[LiveSession<'_, u32>]),
            vec![None]
        );
        assert!(bind::<u32>(&[], &[session(1, "A", "p")]).is_empty());
    }
}
