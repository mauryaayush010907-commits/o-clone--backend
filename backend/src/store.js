/**
 * State store abstraction used by matchmaking.
 *
 *  - RedisStore: production. Queues are Redis lists (LPOP/RPUSH are atomic,
 *    so concurrent instances can never pop the same waiter). Session state
 *    lives in hashes with TTL. This is what makes multi-instance deployments
 *    consistent.
 *  - MemoryStore: local development and automated tests (identical API).
 */
import Redis from "ioredis";

export class MemoryStore {
  constructor() {
    this.mode = "memory";
    this.queues = { video: new Map(), text: new Map() }; // id -> ts, insertion order = FIFO
    this.queuesTs = { video: new Map(), text: new Map() };
    this.matches = new Map(); // matchId -> { a, b, mode, ts }
    this.counters = new Map();
    this.prefs = new Map(); // socketId -> { prefs, expanded, expiresAt }
    // Private-room state (mirrors Redis: roomMeta + roomMembers + token table).
    this.rooms = new Map(); // roomId -> meta
    this.roomMembers = new Map(); // roomId -> { host, members: Set, pending: Map, locked: bool, ts }
    this.usernameIndex = new Map(); // lowercased username -> { username, socketId, expiresAt }
    this.codeAttempts = new Map(); // ipKey -> { count, resetAt }
  }
  async init() {}
  async close() {}

  async queuePush(mode, id, ts) {
    this.queues[mode].set(id, ts);
  }
  async queuePop(mode) {
    const q = this.queues[mode];
    for (const [id, ts] of q) {
      q.delete(id);
      return { id, ts };
    }
    return null;
  }
  async queueRemove(mode, id) {
    this.queues[mode].delete(id);
  }
  async queueLength(mode) {
    return this.queues[mode].size;
  }
  /** Read the queue (oldest first) without removing — used by the preference-aware pairing scan. */
  async queuePeek(mode, limit = 200) {
    return [...this.queues[mode].keys()].slice(0, Math.max(1, limit));
  }
  /** Atomically claim one specific waiter (synchronous here → race-free within the process). */
  async queueClaim(mode, id) {
    const q = this.queues[mode];
    if (!q.has(id)) return null;
    const ts = q.get(id);
    q.delete(id);
    return { id, ts };
  }
  async queuePrune(mode, maxAgeMs) {
    const now = Date.now();
    let removed = 0;
    for (const [id, ts] of this.queues[mode]) {
      if (now - ts > maxAgeMs) {
        this.queues[mode].delete(id);
        removed++;
      }
    }
    return removed;
  }

  async matchSet(matchId, data, ttlMs) {
    this.matches.set(matchId, { ...data, expiresAt: Date.now() + ttlMs });
  }
  async matchGet(matchId) {
    const m = this.matches.get(matchId);
    if (!m) return null;
    if (m.expiresAt && m.expiresAt < Date.now()) {
      this.matches.delete(matchId);
      return null;
    }
    return m;
  }
  async matchDel(matchId) {
    this.matches.delete(matchId);
  }
  async matchCount() {
    const now = Date.now();
    let n = 0;
    for (const m of this.matches.values()) if (!m.expiresAt || m.expiresAt > now) n++;
    return n;
  }
  async matchPrune(maxAgeMs) {
    const now = Date.now();
    let removed = 0;
    for (const [id, m] of this.matches) {
      if (now - (m.ts || 0) > maxAgeMs) {
        this.matches.delete(id);
        removed++;
      }
    }
    return removed;
  }

  async counterAdd(key, delta) {
    this.counters.set(key, (this.counters.get(key) || 0) + delta);
    return this.counters.get(key);
  }
  async counterGet(key) {
    return this.counters.get(key) || 0;
  }

  async prefsSet(id, data, ttlMs) {
    this.prefs.set(id, { prefs: data.prefs, expanded: !!data.expanded, expiresAt: Date.now() + ttlMs });
  }
  async prefsGet(id) {
    const p = this.prefs.get(id);
    if (!p) return null;
    if (p.expiresAt < Date.now()) {
      this.prefs.delete(id);
      return null;
    }
    return { prefs: p.prefs, expanded: p.expanded };
  }
  async prefsDel(id) {
    this.prefs.delete(id);
  }

  async roomSetMeta(id, meta, ttlMs) {
    this.rooms.set(id, { ...meta, expiresAt: Date.now() + ttlMs });
  }
  async roomGetMeta(id) {
    const meta = this.rooms.get(id);
    if (!meta) return null;
    if (meta.expiresAt && meta.expiresAt < Date.now()) {
      this.rooms.delete(id);
      this.roomMembers.delete(id);
      return null;
    }
    return meta;
  }
  async roomDelMeta(id) {
    this.rooms.delete(id);
    this.roomMembers.delete(id);
  }
  async roomCreate(id, hostSocketId, ttlMs) {
    this.roomMembers.set(id, {
      host: hostSocketId,
      members: new Map([[hostSocketId, { username: null, isHost: true, joinedAt: Date.now() }]]),
      pending: new Map(),
      locked: false,
      ts: Date.now(),
      expiresAt: Date.now() + ttlMs,
    });
  }
  async roomGetMembers(id) {
    const members = this.roomMembers.get(id);
    if (!members) return null;
    if (members.expiresAt && members.expiresAt < Date.now()) {
      this.roomMembers.delete(id);
      this.rooms.delete(id);
      return null;
    }
    return members;
  }
  async roomAddMemberIfRoom(id, socketId, entry, max = 5) {
    const members = await this.roomGetMembers(id);
    if (!members) return null;
    if (members.members.has(socketId)) return members;
    if (members.members.size >= max) return null;
    members.members.set(socketId, entry);
    return members;
  }
  async roomRemoveMember(id, socketId) {
    const members = await this.roomGetMembers(id);
    if (!members) return null;
    members.members.delete(socketId);
    if (members.members.size === 0) {
      this.roomMembers.delete(id);
      this.rooms.delete(id);
      return { empty: true, m: null };
    }
    return { empty: false, m: members };
  }
  async roomSetLocked(id, locked) {
    const members = await this.roomGetMembers(id);
    if (!members) return null;
    members.locked = !!locked;
    return members;
  }
  async roomAddPending(id, requestId, info) {
    const members = await this.roomGetMembers(id);
    if (!members) return null;
    members.pending.set(requestId, info);
    return members;
  }
  async roomRemovePending(id, requestId) {
    const members = await this.roomGetMembers(id);
    if (!members) return null;
    return members.pending.delete(requestId);
  }
  async roomPendingGet(id, requestId) {
    const members = await this.roomGetMembers(id);
    return members?.pending.get(requestId) || null;
  }

  // ----- Username reservation (MemoryStore) -----
  async usernameReserve(lower, username, socketId, ttlMs) {
    const existing = this.usernameIndex.get(lower);
    if (existing && existing.expiresAt > Date.now() && existing.socketId !== socketId) return false;
    this.usernameIndex.set(lower, { username, socketId, expiresAt: Date.now() + ttlMs });
    return true;
  }
  async usernameGet(lower) {
    const r = this.usernameIndex.get(lower);
    if (!r) return null;
    if (r.expiresAt < Date.now()) {
      this.usernameIndex.delete(lower);
      return null;
    }
    return r;
  }
  async usernameRelease(socketId) {
    for (const [k, v] of this.usernameIndex) {
      if (v.socketId === socketId) this.usernameIndex.delete(k);
    }
  }

  // ----- Code-attempt rate limit (MemoryStore) -----
  async codeAttemptHit(ipKey, windowMs, max) {
    const now = Date.now();
    const e = this.codeAttempts.get(ipKey);
    if (!e || e.resetAt < now) {
      this.codeAttempts.set(ipKey, { count: 1, resetAt: now + windowMs });
      return { count: 1, limited: false, ttlMs: windowMs };
    }
    e.count += 1;
    return { count: e.count, limited: e.count > max, ttlMs: e.resetAt - now };
  }
}

export class RedisStore {
  constructor(url) {
    this.mode = "redis";
    this.redis = new Redis(url, {
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    });
    this.redis.on("error", (e) => console.error("[redis] error", e.message));
  }
  async init() {
    // wait for first ready
    if (this.redis.status !== "ready") {
      await new Promise((res, rej) => {
        this.redis.once("ready", res);
        this.redis.once("error", (e) => rej(e));
        setTimeout(() => rej(new Error("redis connect timeout")), 10000).unref?.();
      });
    }
  }
  async close() {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  async queuePush(mode, id, ts) {
    const pipe = this.redis.pipeline();
    pipe.rpush(`queue:${mode}`, id);
    pipe.hset(`queue-ts:${mode}`, id, String(ts));
    pipe.pexpire(`queue-ts:${mode}`, 3600e3);
    await pipe.exec();
  }
  async queuePop(mode) {
    // LPOP is atomic — exactly one instance ever receives a given waiter.
    const id = await this.redis.lpop(`queue:${mode}`);
    if (!id) return null;
    const tsRaw = await this.redis.hget(`queue-ts:${mode}`, id);
    await this.redis.hdel(`queue-ts:${mode}`, id);
    return { id, ts: tsRaw ? parseInt(tsRaw, 10) : Date.now() };
  }
  async queueRemove(mode, id) {
    const pipe = this.redis.pipeline();
    pipe.lrem(`queue:${mode}`, 0, id);
    pipe.hdel(`queue-ts:${mode}`, id);
    await pipe.exec();
  }
  async queueLength(mode) {
    return this.redis.llen(`queue:${mode}`);
  }
  async queuePeek(mode, limit = 200) {
    return this.redis.lrange(`queue:${mode}`, 0, Math.max(1, limit) - 1);
  }
  /**
   * Atomically claim a specific waiter: LPOP entries until `id` is found
   * (re-pushing the non-matching ones), all inside one Lua script, so two
   * backend instances can never claim the same waiter.
   */
  async queueClaim(mode, id) {
    const res = await this.redis.eval(
      `
      local len = tonumber(redis.call('LLEN', KEYS[1]))
      local i = 0
      while i < len do
        i = i + 1
        local v = redis.call('LPOP', KEYS[1])
        if v == ARGV[1] then
          local ts = redis.call('HGET', KEYS[2], ARGV[1])
          redis.call('HDEL', KEYS[2], ARGV[1])
          return { ARGV[1], ts or '0' }
        end
        redis.call('RPUSH', KEYS[1], v)
      end
      return nil`,
      2,
      `queue:${mode}`,
      `queue-ts:${mode}`,
      id
    );
    if (!res) return null;
    return { id: res[0], ts: parseInt(res[1], 10) || Date.now() };
  }
  async queuePrune(mode, maxAgeMs) {
    const now = Date.now();
    const ids = await this.redis.lrange(`queue:${mode}`, 0, -1);
    let removed = 0;
    for (const id of ids) {
      const tsRaw = await this.redis.hget(`queue-ts:${mode}`, id);
      if (!tsRaw || now - parseInt(tsRaw, 10) > maxAgeMs) {
        await this.redis.lrem(`queue:${mode}`, 0, id);
        await this.redis.hdel(`queue-ts:${mode}`, id);
        removed++;
      }
    }
    return removed;
  }

  async matchSet(matchId, data, ttlMs) {
    const pipe = this.redis.pipeline();
    pipe.hset(
      `match:${matchId}`,
      "a",
      data.a,
      "b",
      data.b,
      "mode",
      data.mode,
      "ts",
      String(data.ts || Date.now())
    );
    pipe.pexpire(`match:${matchId}`, ttlMs);
    pipe.incr("matchcount");
    await pipe.exec();
  }
  async matchGet(matchId) {
    const h = await this.redis.hgetall(`match:${matchId}`);
    if (!h || !h.a || !h.b) return null;
    return { a: h.a, b: h.b, mode: h.mode, ts: h.ts ? parseInt(h.ts, 10) : 0 };
  }
  async matchDel(matchId) {
    const pipe = this.redis.pipeline();
    pipe.del(`match:${matchId}`);
    pipe.decr("matchcount");
    await pipe.exec();
  }
  async matchCount() {
    const n = await this.redis.get("matchcount");
    return Math.max(0, n ? parseInt(n, 10) : 0);
  }
  async matchPrune(maxAgeMs) {
    // Matches carry a TTL anyway; the prune is a safety net for the counter.
    void maxAgeMs;
    return 0;
  }

  async counterAdd(key, delta) {
    return this.redis.incrby(key, delta);
  }
  async counterGet(key) {
    const n = await this.redis.get(key);
    return n ? parseInt(n, 10) : 0;
  }

  async prefsSet(id, data, ttlMs) {
    await this.redis.set(`prefs:${id}`, JSON.stringify({ prefs: data.prefs, expanded: !!data.expanded }), "PX", ttlMs);
  }
  async prefsGet(id) {
    const raw = await this.redis.get(`prefs:${id}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  async prefsDel(id) {
    await this.redis.del(`prefs:${id}`);
  }

  // ----- Code-attempt rate limit (atomic, Redis) -----
  async codeAttemptHit(ipKey, windowMs, max) {
    const lua = [
      "local n = redis.call('INCR', KEYS[1])",
      "if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end",
      "local ttl = redis.call('PTTL', KEYS[1])",
      "if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end",
      "if n > tonumber(ARGV[2]) then return { n, 1, ttl } end",
      "return { n, 0, ttl }"
    ].join("\n");
    const [count, limited, ttlMs] = await this.redis.eval(
      lua, 1, `code-attempt:${ipKey}`, windowMs, max
    );
    return { count: Number(count), limited: Number(limited) === 1, ttlMs: Number(ttlMs) };
  }

  // ---------------------------------------------------------------------
  // Private room primitives
  // ---------------------------------------------------------------------

  async roomSetMeta(id, meta, ttlMs) {
    this.rooms.set(id, { ...meta, expiresAt: Date.now() + ttlMs });
  }
  async roomGetMeta(id) {
    const m = this.rooms.get(id);
    if (!m) return null;
    if (m.expiresAt && m.expiresAt < Date.now()) {
      this.rooms.delete(id);
      this.roomMembers.delete(id);
      return null;
    }
    return m;
  }
  async roomDelMeta(id) {
    this.rooms.delete(id);
    this.roomMembers.delete(id);
  }

  async roomCreate(id, hostSocketId, ttlMs) {
    // Members: keyed Set<socketId, { username, isHost, joinedAt }>.
    // Pending: Map<requestId, { socketId, username, ts }>.
    this.roomMembers.set(id, {
      host: hostSocketId,
      members: new Map([[hostSocketId, { username: null, isHost: true, joinedAt: Date.now() }]]),
      pending: new Map(),
      locked: false,
      ts: Date.now(),
      expiresAt: Date.now() + ttlMs,
    });
  }
  async roomGetMembers(id) {
    const m = this.roomMembers.get(id);
    if (!m) return null;
    if (m.expiresAt && m.expiresAt < Date.now()) {
      this.roomMembers.delete(id);
      this.rooms.delete(id);
      return null;
    }
    return m;
  }
  /**
   * Atomic "add a member if there's room". Returns the updated members map
   * on success, or null if the room is full / missing. This is the only
   * path that ever mutates room capacity, so it's the only place the
   * five-person cap is enforced.
   */
  async roomAddMemberIfRoom(id, socketId, entry, max = 5) {
    const m = this.roomMembers.get(id);
    if (!m) return null;
    if (m.members.has(socketId)) return m; // already in the room — no-op
    if (m.members.size >= max) return null; // full
    m.members.set(socketId, entry);
    return m;
  }
  async roomRemoveMember(id, socketId) {
    const m = this.roomMembers.get(id);
    if (!m) return null;
    m.members.delete(socketId);
    // Auto-cleanup: an empty room is reaped immediately.
    if (m.members.size === 0) {
      this.roomMembers.delete(id);
      this.rooms.delete(id);
      return { empty: true, m: null };
    }
    return { empty: false, m };
  }
  async roomSetLocked(id, locked) {
    const m = this.roomMembers.get(id);
    if (!m) return null;
    m.locked = !!locked;
    return m;
  }

  async roomAddPending(id, requestId, info) {
    const m = this.roomMembers.get(id);
    if (!m) return null;
    m.pending.set(requestId, info);
    return m;
  }
  async roomRemovePending(id, requestId) {
    const m = this.roomMembers.get(id);
    if (!m) return null;
    return m.pending.delete(requestId);
  }
  async roomPendingGet(id, requestId) {
    const m = this.roomMembers.get(id);
    if (!m) return null;
    return m.pending.get(requestId) || null;
  }

  // ----- Username reservation (case-insensitive, TTL'd) -----
  async usernameReserve(lower, username, socketId, ttlMs) {
    const existing = this.usernameIndex.get(lower);
    if (existing && existing.expiresAt > Date.now() && existing.socketId !== socketId) return false;
    this.usernameIndex.set(lower, { username, socketId, expiresAt: Date.now() + ttlMs });
    return true;
  }
  async usernameGet(lower) {
    const r = this.usernameIndex.get(lower);
    if (!r) return null;
    if (r.expiresAt < Date.now()) {
      this.usernameIndex.delete(lower);
      return null;
    }
    return r;
  }
  async usernameRelease(socketId) {
    for (const [k, v] of this.usernameIndex) {
      if (v.socketId === socketId) this.usernameIndex.delete(k);
    }
  }

  // ----- Code-attempt rate limit -----
  async codeAttemptHit(ipKey, windowMs, max) {
    const now = Date.now();
    const e = this.codeAttempts.get(ipKey);
    if (!e || e.resetAt < now) {
      this.codeAttempts.set(ipKey, { count: 1, resetAt: now + windowMs });
      return 1;
    }
    e.count += 1;
    return e.count;
  }
}


export function createStore({ redisUrl, log }) {
  if (redisUrl) {
    log.info("Using Redis-backed state store (distributed matchmaking enabled)", { redisUrl: "[hidden]" });
    return new RedisStore(redisUrl);
  }
  log.warn("REDIS_URL not set — using in-memory state store (single instance, state lost on restart). Fine for local dev, NOT for production.");
  return new MemoryStore();
}
