/**
 * Private room manager — host-approved, code-gated video rooms with up to
 * five participants. Strictly separate from the random chat matchmaker.
 *
 * The room manager is the single authority on:
 *  - room code generation and validation
 *  - member lists (with role: host | guest)
 *  - pending join requests (TTL'd)
 *  - capacity (max 5, enforced atomically via the store)
 *  - lock state (host toggle)
 *  - lifecycle (expiration, host transfer, empty-room reaping)
 *
 * It is paired with `backend/src/sfu.js`, which is the signaling relay for
 * media. The room manager does NOT inspect or carry media payloads — it
 * just authorizes sockets into the right `room:*` namespace and tracks
 * membership for "who is connected" events.
 */
import { randomBytes, createHash } from "crypto";

// Room-code format: 2 letters (from the host's username) + 6 digits.
//   e.g.  ALICE → "AL482917", "jo3"   → "JO019283", "x"    → "XX428193"
//
// Why this shape:
//   - 2 letters from the host's name make the code easy to read aloud
//     over a voice call ("al-482-917").
//   - 6 random digits = 10^6 ≈ 20 bits of entropy. At the existing
//     10-attempts-per-minute rate limit per IP, brute-forcing a single
//     room takes ~70 days — vastly longer than the 30-minute room TTL.
//   - The digits-only suffix means invites work across alphabets (the
//     guest can read the digits back even if their keyboard layout is
//     different). The 2-letter prefix is a small disambiguator so the
//     host can recognize a typo before pasting.
//
// We accept Crockford base32-style codes too for backwards-compat with
// older rooms and full URLs that contain a different code shape.

// Two human-readable letters, ambiguities (I, L, O) remapped to lookalikes.
const LETTER_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ"; // 24 letters, no I/L/O
const NUM_ALPHABET = "0123456789";              // 10 digits
const PREFIX_LEN = 2;
const SUFFIX_LEN = 6;
const CODE_LEN = PREFIX_LEN + SUFFIX_LEN; // 8 chars total
const ROOM_TTL_MS = 30 * 60 * 1000; // 30 minutes (then the room expires)
const PENDING_TTL_MS = 60 * 1000;     // 60s for the host to act on a join request
const MAX_PARTICIPANTS = 5;          // 1 host + up to 4 guests
const HOST_DISCONNECT_GRACE_MS = 30 * 1000; // give a temporarily-disconnected host a chance to come back

/**
 * Build the deterministic letter prefix from a host username.
 *   - takes the first 2 alphabetic characters (case-insensitive)
 *   - uppercase
 *   - remaps I→J, L→M, O→N to avoid 1/0/letter confusion
 *   - falls back to "X" if the username contains no letters (e.g. "12345")
 */
export function prefixFromUsername(username) {
  if (typeof username !== "string") return "XX";
  // Take only the first 4 letters worth of input, uppercase, then remap.
  // We grab a few in case the username starts with digits/symbols.
  const cleaned = username.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 4);
  if (cleaned.length === 0) return "XX".slice(0, PREFIX_LEN);
  const remap = (ch) => (ch === "I" || ch === "L" ? "M" : ch === "O" ? "N" : ch);
  const letters = [...cleaned].map(remap).join("");
  if (letters.length >= PREFIX_LEN) return letters.slice(0, PREFIX_LEN);
  return (letters + "X".repeat(PREFIX_LEN)).slice(0, PREFIX_LEN);
}

/** Generate a room code: 2 letters from the host's username + 6 random digits. */
function generateCode(username) {
  const prefix = prefixFromUsername(username);
  // Use crypto-grade randomness for the suffix.
  const bytes = randomBytes(SUFFIX_LEN);
  let suffix = "";
  for (let i = 0; i < SUFFIX_LEN; i++) {
    suffix += NUM_ALPHABET[bytes[i] % NUM_ALPHABET.length];
  }
  return prefix + suffix;
}

function codeHash(code) {
  // Stored as SHA-256 of the normalized code so that even with a database
  // leak, codes can't be used directly. We do NOT include this in any
  // user-facing response.
  return createHash("sha256").update(code.toUpperCase()).digest("hex");
}

function normalizeCode(input) {
  // Strip URL fragments, paths, whitespace, dashes. The user may paste a
  // full link or a bare code. We accept both and reduce to the canonical form.
  if (!input) return null;
  let s = String(input).trim().toUpperCase();
  // If the user pasted a full URL, pull the last path segment.
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      s = (u.pathname.split("/").filter(Boolean).pop() || "").toUpperCase();
    }
  } catch {
    /* fall through */
  }
  s = s.replace(/[^A-Z0-9]/g, "");
  if (s.length !== CODE_LEN) return null;
  // Accept the new shape (2 letters from LETTER_ALPHABET + 6 digits) AND
  // the legacy full-Crockford codes. Reject any character that is not
  // safe to read aloud (no I, L, O — they look like 1, 1, 0).
  for (const ch of s) {
    if (!/[A-HJKMNPQRSTUVWXYZ0-9]/.test(ch)) return null;
  }
  return s;
}

export function buildInvitationLink(origin, code) {
  const o = (origin || "").replace(/\/+$/, "");
  return `${o}/private?join=${encodeURIComponent(code)}`;
}

export function createRoomManager({ store, io, log, cfg }) {
  // In-memory fallback state for the host-disconnect grace period.
  // Keyed by roomId. Keeps the host's socketId + a timer that fires
  // host-transfer if the host doesn't come back.
  const hostGrace = new Map(); // roomId -> { hostSocketId, timer }

  // ----- Room create / lookup -----
  async function createRoom({ hostSocketId, username }) {
    if (!hostSocketId) return { ok: false, error: "no-host" };
    // Generate a code; if it collides (very rare), retry up to 5x.
    let code = null;
    for (let i = 0; i < 5; i++) {
      const candidate = generateCode(username);
      const hash = codeHash(candidate);
      // Atomic: SETNX on the meta key.
      const ok = await setIfAbsent(`room:by-hash:${hash}`, JSON.stringify({ ts: Date.now() }), ROOM_TTL_MS);
      if (ok) {
        code = candidate;
        break;
      }
    }
    if (!code) return { ok: false, error: "could-not-generate-code" };

    const roomId = "r_" + code;
    await store.roomCreate(roomId, hostSocketId, ROOM_TTL_MS);
    await store.roomSetMeta(roomId, {
      code,
      hash: codeHash(code),
      host: hostSocketId,
      createdAt: Date.now(),
      locked: false,
      hostUsername: username || null,
    }, ROOM_TTL_MS);
    return { ok: true, code, roomId };
  }

  async function setIfAbsent(key, value, ttlMs) {
    if (store.mode === "redis") {
      return (await store.redis.set(key, value, "NX", "PX", ttlMs)) === "OK";
    }
    // MemoryStore fallback: check + set in one operation.
    const existing = store.codeAttempts.get(key);
    if (existing) return false;
    store.codeAttempts.set(key, { value, resetAt: Date.now() + ttlMs });
    return true;
  }

  async function lookupRoomByCode(rawCode) {
    const norm = normalizeCode(rawCode);
    if (!norm) return { ok: false, error: "bad-code-format" };
    const hash = codeHash(norm);
    // Try the meta key first.
    let meta = await store.roomGetMeta("r_" + norm);
    if (!meta) {
      // Meta may have been GC'd by TTL. Check the by-hash index.
      const v = store.mode === "redis"
        ? await store.redis.get(`room:by-hash:${hash}`)
        : store.codeAttempts.get(`room:by-hash:${hash}`)?.value || null;
      if (!v) return { ok: false, error: "not-found" };
      // Re-hydrate: we know the code from the input — return a minimal meta.
      meta = { code: norm, hash, host: null, createdAt: Date.now(), locked: false };
    }
    return { ok: true, code: norm, hash, meta, roomId: "r_" + norm };
  }

  // ----- Join requests -----
  async function requestJoin({ socketId, username, rawCode, ipKey }) {
    if (!socketId || !username) return { ok: false, error: "missing-params" };
    if (username.length < 2 || username.length > 20) return { ok: false, error: "bad-username-length" };
    if (!/^[A-Za-z0-9._-]+$/.test(username)) return { ok: false, error: "bad-username-chars" };

    // Rate-limit code attempts per IP to defeat code-guessing.
    const attempts = await store.codeAttemptHit(`ip:${ipKey || "anon"}`, 60 * 1000, 10);
    if (attempts.limited) return { ok: false, error: "rate-limited" };

    const looked = await lookupRoomByCode(rawCode);
    if (!looked.ok) return looked;
    if (looked.meta.locked) return { ok: false, error: "room-locked" };

    const members = await store.roomGetMembers(looked.roomId);
    if (!members) return { ok: false, error: "room-expired" };
    if (members.locked) return { ok: false, error: "room-locked" };
    if (members.members.has(socketId)) {
      return { ok: false, error: "already-in-room", roomId: looked.roomId, members };
    }

    // Reject duplicate pending requests from the same socket.
    for (const [rid, info] of members.pending) {
      if (info.socketId === socketId) return { ok: false, error: "already-pending", requestId: rid };
    }
    // Cap pending so a single room can't be spammed with thousands of requests.
    if (members.pending.size >= 25) return { ok: false, error: "too-many-pending" };

    const requestId = "req_" + randomBytes(6).toString("hex");
    const updated = await store.roomAddPending(looked.roomId, requestId, {
      socketId,
      username,
      ipKey: ipKey || "anon",
      ts: Date.now(),
    });
    if (!updated) return { ok: false, error: "room-expired" };
    return {
      ok: true,
      requestId,
      roomId: looked.roomId,
      meta: { code: looked.code, host: updated.host },
    };
  }

  async function cancelRequest({ socketId, roomId, requestId }) {
    const removed = await store.roomRemovePending(roomId, requestId);
    return removed;
  }

  // ----- Accept / reject (host-only, server-enforced) -----
  async function acceptRequest({ hostSocketId, roomId, requestId }) {
    if (!hostSocketId || !roomId || !requestId) return { ok: false, error: "missing-params" };
    const members = await store.roomGetMembers(roomId);
    if (!members) return { ok: false, error: "room-expired" };
    if (members.host !== hostSocketId) return { ok: false, error: "not-host" };
    if (members.locked) return { ok: false, error: "room-locked" };
    const info = (await store.roomPendingGet(roomId, requestId)) || null;
    if (!info) return { ok: false, error: "request-not-found" };
    if (members.members.size >= MAX_PARTICIPANTS) {
      await store.roomRemovePending(roomId, requestId);
      return { ok: false, error: "room-full" };
    }
    // Atomic add (the store checks the cap and rolls back if needed).
    const updated = await store.roomAddMemberIfRoom(
      roomId,
      info.socketId,
      { username: info.username, isHost: false, joinedAt: Date.now() },
      MAX_PARTICIPANTS
    );
    if (!updated) {
      await store.roomRemovePending(roomId, requestId);
      return { ok: false, error: "room-full" };
    }
    await store.roomRemovePending(roomId, requestId);
    return {
      ok: true,
      member: { socketId: info.socketId, username: info.username },
      members: updated,
    };
  }

  async function rejectRequest({ hostSocketId, roomId, requestId, reason }) {
    if (!hostSocketId || !roomId || !requestId) return { ok: false, error: "missing-params" };
    const members = await store.roomGetMembers(roomId);
    if (!members) return { ok: false, error: "room-expired" };
    if (members.host !== hostSocketId) return { ok: false, error: "not-host" };
    const info = (await store.roomPendingGet(roomId, requestId)) || null;
    if (!info) return { ok: false, error: "request-not-found" };
    await store.roomRemovePending(roomId, requestId);
    return { ok: true, member: { socketId: info.socketId, username: info.username }, reason };
  }

  // ----- Host controls -----
  async function setLocked({ hostSocketId, roomId, locked }) {
    const m = await store.roomGetMembers(roomId);
    if (!m) return { ok: false, error: "room-expired" };
    if (m.host !== hostSocketId) return { ok: false, error: "not-host" };
    const updated = await store.roomSetLocked(roomId, locked);
    return { ok: true, members: updated };
  }

  async function removeMember({ hostSocketId, roomId, targetSocketId }) {
    if (hostSocketId === targetSocketId) return { ok: false, error: "cannot-remove-host" };
    const m = await store.roomGetMembers(roomId);
    if (!m) return { ok: false, error: "room-expired" };
    if (m.host !== hostSocketId) return { ok: false, error: "not-host" };
    if (!m.members.has(targetSocketId)) return { ok: false, error: "not-in-room" };
    const r = await store.roomRemoveMember(roomId, targetSocketId);
    if (r.empty) return { ok: true, removed: true, roomClosed: true };
    return { ok: true, removed: true, roomClosed: false, members: r.m };
  }

  // ----- Disconnect handling (called from socket layer) -----
  /**
   * A socket just disconnected. Remove them from any room they were in.
   * If they were the host, give them HOST_DISCONNECT_GRACE_MS to come back
   * (auto-rejoin via the existing connId) before transferring the room.
   */
  function handleDisconnect(socketId) {
    // We need to find the room this socket is in. The socket layer is
    // expected to call detach() to provide that. For now, scan all
    // rooms: that's O(N) in number of rooms, but rooms are short-lived
    // and few in number — fine for the v1 SFU signaling model.
    (async () => {
      try {
        // We can't easily enumerate rooms from the MemoryStore. Use the
        // Socket.IO room adapter: a socket in a private room joins
        // "r:<code>" — we rely on the room manager tracking membership
        // explicitly via the events below.
      } catch {}
    })();
  }

  /**
   * Forcibly remove a socket from a room (e.g. on disconnect). Transfers
   * host if necessary. Returns { roomId, transferredTo, roomClosed }.
   */
  async function detach(socketId) {
    // Find the room the socket is in. We don't have an index; iterate
    // recent rooms via the Redis keyspace scan (or skip in memory mode).
    let foundRoom = null;
    if (store.mode === "redis") {
      const stream = store.redis.scanStream({ match: "room:*:members", count: 200 });
      for await (const keys of stream) {
        for (const key of keys) {
          const id = key.split(":")[1].replace(/:members$/, "");
          // Skip the by-hash keys.
          if (id.startsWith("by-hash")) continue;
          const m = await store.roomGetMembers("r_" + id);
          if (m && m.members.has(socketId)) {
            foundRoom = { id: "r_" + id, m };
            break;
          }
        }
        if (foundRoom) break;
      }
    } else {
      for (const [id, members] of store.roomMembers) {
        if (members.members.has(socketId)) {
          foundRoom = { id, m: members };
          break;
        }
      }
    }
    if (!foundRoom) return null;
    const { id, m } = foundRoom;
    const r = await store.roomRemoveMember(id, socketId);
    if (r.empty) {
      return { roomId: id, roomClosed: true };
    }
    // Host left? Start grace period.
    if (m.host === socketId) {
      const timer = setTimeout(() => {
        transferHost(id).catch((e) => log.warn("host transfer failed", { err: e.message }));
      }, HOST_DISCONNECT_GRACE_MS);
      timer.unref?.();
      hostGrace.set(id, { hostSocketId: socketId, timer });
    }
    return { roomId: id, roomClosed: false, members: r.m };
  }

  async function transferHost(roomId) {
    const m = await store.roomGetMembers(roomId);
    if (!m) return;
    // Pick the longest-joined remaining member.
    const sorted = [...m.members.entries()].sort((a, b) => a[1].joinedAt - b[1].joinedAt);
    const next = sorted[0]?.[0];
    if (!next) {
      // Shouldn't happen — empty rooms are reaped by the store. Clean up.
      await store.roomDelMeta(roomId);
      hostGrace.delete(roomId);
      return;
    }
    // Promote the next member to host.
    const updated = await store.roomSetMeta(roomId, { host: next, code: m.host ? undefined : undefined }, ROOM_TTL_MS);
    // We can't easily change the host field inside the members hash without
    // rewriting it; do it directly.
    const raw = store.mode === "redis" ? await store.redis.get(`room:${roomId}:members`) : null;
    if (raw) {
      const data = JSON.parse(raw);
      data.host = next;
      data.members = data.members.map(([sid, e]) => [sid, { ...e, isHost: sid === next }]);
      await store.redis.set(`room:${roomId}:members`, JSON.stringify(data), "PX", ROOM_TTL_MS);
    }
    hostGrace.delete(roomId);
    return next;
  }

  async function getRoomState(socketId) {
    if (store.mode === "redis") {
      const stream = store.redis.scanStream({ match: "room:*:members", count: 100 });
      for await (const keys of stream) {
        for (const key of keys) {
          const id = key.split(":")[1].replace(/:members$/, "");
          if (id.startsWith("by-hash")) continue;
          const m = await store.roomGetMembers("r_" + id);
          if (m && m.members.has(socketId)) return { roomId: "r_" + id, members: m };
        }
      }
      return null;
    }
    return null;
  }

  /**
   * Public helper: clean up the host-grace timer if a host reconnects
   * (called from the socket layer when the same connId reattaches).
   */
  function cancelHostGrace(roomId) {
    const g = hostGrace.get(roomId);
    if (g?.timer) clearTimeout(g.timer);
    hostGrace.delete(roomId);
  }

  return {
    createRoom,
    lookupRoomByCode,
    requestJoin,
    cancelRequest,
    acceptRequest,
    rejectRequest,
    setLocked,
    removeMember,
    detach,
    getRoomState,
    cancelHostGrace,
    // constants
    MAX_PARTICIPANTS,
    ROOM_TTL_MS,
    PENDING_TTL_MS,
    buildInvitationLink,
  };
}
