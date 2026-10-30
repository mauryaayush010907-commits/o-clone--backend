/**
 * Matchmaking engine + active-session registry.
 *
 * Guarantees enforced here:
 *  - a user never matches with themselves (explicit check + atomic claim)
 *  - a user already matched never enters the queue again
 *  - duplicate match:find requests are deduped
 *  - disconnected users are removed from queues (disconnect hook + TTL sweeper)
 *  - stale queue entries (dead socket ids / state drift) are skipped, never matched
 *  - rapid Next clicks cannot double-match: membership verified against the
 *    shared store on every transition; waiter claims are atomic (Lua)
 *
 * Optional filters (country, language, gender, age group, interests):
 *  - NO filters  → standard random matchmaking (pair with oldest waiter, instantly).
 *  - WITH filters → "refined" pairing: a waiter is paired only when BOTH users'
 *    explicit filters are satisfied by the other's self-reported profile.
 *    Users with unset profile fields are never excluded from the pool; they
 *    simply wait for the filtering side to expand.
 *  - Filters are never silently ignored: after PREFS_PATIENCE_MS the user is
 *    VISIBLEY expanded (match:expanding) — automatically, or immediately via
 *    match:expand — and only then can they pair with anyone.
 *  - Expansion only relaxes the user's own filters; safety (mode separation,
 *    bans, validation) is untouched.
 */
import { randomBytes } from "crypto";
import { emptyPrefs, sanitizePrefs, activeCount, pairCompatible, profileOf, filtersOf } from "./prefs.js";

const MODES = ["video", "text"];
const genId = () => "m" + Date.now().toString(36) + randomBytes(4).toString("hex");
const EMPTY_FILTERS = { countries: [], gender: null, interests: [] };
const SCAN_LIMIT = 200;

export class MatchError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export function createMatchmaker({ store, io, log, cfg }) {
  /**
   * Per-socket convenience state, kept on the instance that owns the socket.
   * Cross-instance authority for match membership is the shared store
   * (Redis hash with TTL) — local recs are only an optimization.
   */
  const recs = new Map(); // socketId -> rec
  const rec = (socketId, create = false) => {
    let r = recs.get(socketId);
    if (!r && create) {
      r = { state: "idle", mode: null, matchId: null, queueTs: 0, lastFind: 0, prefs: emptyPrefs(), expanded: false, expandTimer: null };
      recs.set(socketId, r);
    }
    return r;
  };

  const alive = (socketId) => io.sockets.sockets.has(socketId);
  const effFilters = (prefs, expanded) => (expanded ? EMPTY_FILTERS : filtersOf(prefs));

  function clearExpandTimer(r) {
    if (r && r.expandTimer) {
      clearTimeout(r.expandTimer);
      r.expandTimer = null;
    }
  }

  /**
   * Scan the mode queue (oldest first) for the first waiter compatible with
   * this user, claim them atomically, and create the match.
   * Compatibility = both users' effective (non-expanded) filters satisfied by
   * the other's self-reported profile. Returns the matchId or null.
   */
  async function findPair(socketId, mode) {
    const s = rec(socketId);
    const meF = effFilters(s.prefs, s.expanded);
    const meP = profileOf(s.prefs);
    const ids = await store.queuePeek(mode, SCAN_LIMIT);
    for (const id of ids) {
      if (id === socketId) continue;
      if (!alive(id)) continue; // stale: already disconnected
      const orec = rec(id);
      if (!orec || orec.state !== "queued") continue; // state drift
      const w = (await store.prefsGet(id)) || { prefs: emptyPrefs(), expanded: false };
      const wF = effFilters(w.prefs, w.expanded);
      const wP = profileOf(w.prefs);
      if (!pairCompatible(meF, meP, wF, wP)) continue; // explicit filters not (mutually) satisfied yet

      const claimed = await store.queueClaim(mode, id);
      if (!claimed || claimed.id !== id) continue; // lost the race — try the next waiter

      const matchId = genId();
      await store.matchSet(matchId, { a: id, b: socketId, mode, ts: Date.now() }, cfg.sessionTtlMs);
      clearExpandTimer(orec);
      orec.state = "matched";
      orec.matchId = matchId;
      const s = rec(socketId);
      if (s) {
        clearExpandTimer(s);
        s.state = "matched";
        s.matchId = matchId;
      }
      store.prefsDel(id).catch(() => {});
      store.prefsDel(socketId).catch(() => {});

      // The longest-waiting user becomes the offerer (deterministic → no offer glare).
      io.to(id).emit("match:found", { matchId, role: "offerer", mode });
      io.to(socketId).emit("match:found", { matchId, role: "answerer", mode });
      log.info("match made", { matchId, mode, refined: activeCount(w.prefs) > 0 || (s && activeCount(s.prefs) > 0) });
      return matchId;
    }
    return null;
  }

  async function find(socketId, mode, rawPrefs) {
    if (!MODES.includes(mode)) throw new MatchError("bad-mode", "mode must be 'video' or 'text'");
    const s = rec(socketId, true);
    if (s.state === "matched") throw new MatchError("already-matched", "You are already in a conversation. Use Next first.");
    if (s.state === "queued") return { queued: true }; // duplicate request — deduped
    const now = Date.now();
    if (now - s.lastFind < cfg.findCooldownMs) throw new MatchError("too-fast", "Slow down — you are requesting matches too quickly.");

    const prefs = sanitizePrefs(rawPrefs); // defense in depth: never trust raw payloads
    s.lastFind = now;
    s.state = "queued";
    s.mode = mode;
    s.prefs = prefs;
    s.expanded = false;
    clearExpandTimer(s);
    await store.prefsSet(socketId, { prefs, expanded: false }, cfg.sessionTtlMs);

    // Unfiltered users keep legacy behavior: pair with the oldest waiter instantly.
    // Filtered users pair only when mutually compatible.
    const matchId = await findPair(socketId, mode);
    if (matchId) return { matched: matchId };

    await store.queuePush(mode, socketId, now);
    s.queueTs = now;
    const refined = activeCount(prefs) > 0;
    const position = await store.queueLength(mode);
    io.to(socketId).emit("match:queued", { mode, position, refined });

    if (refined) {
      // Visible auto-expansion after patience — never a silent fallback.
      s.expandTimer = setTimeout(() => {
        if (s.state === "queued" && !s.expanded) {
          expand(socketId).catch((e) => log.warn("auto-expand failed", { err: e.message }));
        }
      }, cfg.prefsPatienceMs);
      s.expandTimer.unref?.();
    }
    return { queued: true, refined };
  }

  /**
   * Expand this user's search to everyone (manual `match:expand` or the
   * automatic patience timer). Notifies the client, then immediately retries
   * pairing with relaxed own-filters (the other side's filters still apply).
   */
  async function expand(socketId) {
    const s = rec(socketId);
    if (!s || s.state !== "queued" || !s.mode) return { ok: true, expanded: false };
    if (s.expanded) return { ok: true, expanded: true };
    s.expanded = true;
    clearExpandTimer(s);
    const stored = (await store.prefsGet(socketId)) || { prefs: s.prefs || emptyPrefs(), expanded: false };
    await store.prefsSet(socketId, { prefs: stored.prefs, expanded: true }, cfg.sessionTtlMs);
    io.to(socketId).emit("match:expanding", { mode: s.mode });
    const matchId = await findPair(socketId, s.mode);
    if (matchId) return { ok: true, expanded: true, matched: matchId };
    return { ok: true, expanded: true, queued: true };
  }

  async function cancel(socketId) {
    const s = rec(socketId);
    if (!s || s.state !== "queued" || !s.mode) return { ok: true };
    clearExpandTimer(s);
    await store.queueRemove(s.mode, socketId);
    store.prefsDel(socketId).catch(() => {});
    s.state = "idle";
    s.mode = null;
    s.expanded = false;
    io.to(socketId).emit("match:cancelled", {});
    return { ok: true };
  }

  async function endMatch(matchId, reason) {
    const m = await store.matchGet(matchId);
    if (!m) return;
    await store.matchDel(matchId);
    for (const id of [m.a, m.b]) {
      const r = recs.get(id);
      if (r) {
        clearExpandTimer(r);
        if (r.matchId === matchId) {
          r.state = "idle";
          r.matchId = null;
          r.expanded = false;
          r.lastFind = 0; // allow immediate re-queue after Next
        }
      }
      if (alive(id)) io.to(id).emit("match:ended", { matchId, reason });
    }
    store.prefsDel(m.a).catch(() => {});
    store.prefsDel(m.b).catch(() => {});
    log.info("match ended", { matchId, reason });
  }

  async function next(socketId, matchId) {
    if (!matchId || typeof matchId !== "string") throw new MatchError("bad-match-id");
    const m = await store.matchGet(matchId);
    if (!m || (m.a !== socketId && m.b !== socketId)) throw new MatchError("no-match", "You are not in this match.");
    await endMatch(matchId, "next");
    return { ok: true };
  }

  async function stop(socketId, matchId) {
    if (!matchId || typeof matchId !== "string") throw new MatchError("bad-match-id");
    const m = await store.matchGet(matchId);
    if (!m || (m.a !== socketId && m.b !== socketId)) throw new MatchError("no-match", "You are not in this match.");
    await endMatch(matchId, "stopped");
    return { ok: true };
  }

  /** True peer of socketId within matchId (used by the signaling router). */
  async function matchPeer(matchId, socketId) {
    const m = await store.matchGet(matchId);
    if (!m) return null;
    if (m.a === socketId) return m.b;
    if (m.b === socketId) return m.a;
    return null; // not a member → unauthorized
  }

  function onDisconnect(socketId) {
    const s = recs.get(socketId);
    recs.delete(socketId);
    if (!s) return;
    clearExpandTimer(s);
    if (s.state === "queued" && s.mode) {
      store.queueRemove(s.mode, socketId).catch((e) => log.warn("queueRemove on disconnect failed", { err: e.message }));
    }
    store.prefsDel(socketId).catch(() => {});
    if (s.state === "matched" && s.matchId) {
      endMatch(s.matchId, "disconnected").catch((e) => log.warn("endMatch on disconnect failed", { err: e.message }));
    }
  }

  /** Periodic cleanup: stale queue entries, orphaned matches, dead recs. */
  const sweeper = setInterval(() => {
    (async () => {
      const qv = await store.queuePrune("video", cfg.queueMaxAgeMs);
      const qt = await store.queuePrune("text", cfg.queueMaxAgeMs);
      const mp = await store.matchPrune(cfg.sessionTtlMs);
      if (qv || qt || mp) log.info("sweeper cleanup", { videoQueued: qv, textQueued: qt, matches: mp });
      for (const [id, r] of recs) {
        if (!alive(id)) {
          if (r.state === "queued" && r.mode) await store.queueRemove(r.mode, id);
          store.prefsDel(id).catch(() => {});
          recs.delete(id);
        }
      }
    })().catch((e) => log.warn("sweeper error", { err: e.message }));
  }, 30000);
  sweeper.unref?.();

  return {
    find,
    expand,
    cancel,
    next,
    stop,
    endMatch,
    matchPeer,
    onDisconnect,
    rec,
    alive,
    close: () => clearInterval(sweeper),
  };
}
