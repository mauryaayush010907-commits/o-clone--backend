import { describe, it, expect } from "vitest";
import { MemoryStore } from "../src/store.js";
import { createMatchmaker, MatchError } from "../src/matchmaker.js";

const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const CFG = { findCooldownMs: 0, sessionTtlMs: 600000, queueMaxAgeMs: 120000 };

function fakeIo() {
  // mirrors the real socket.io shape: io.sockets.sockets is a Map<socketId, Socket>
  const socketsMap = new Map();
  const out = new Map();
  return {
    sockets: { sockets: socketsMap },
    out,
    add(id) {
      if (!socketsMap.has(id)) {
        socketsMap.set(id, {});
        out.set(id, []);
      }
    },
    to(id) {
      return { emit: (ev, d) => out.get(id)?.push([ev, d]) };
    },
  };
}

function setup(cfg = CFG) {
  const store = new MemoryStore();
  const io = fakeIo();
  const mm = createMatchmaker({ store, io, log: LOG, cfg });
  const found = (id) => io.out.get(id)?.filter(([e]) => e === "match:found") ?? [];
  return { store, io, mm, found };
}

describe("matchmaking engine", () => {
  it("keeps a lone user waiting in the queue", async () => {
    const { store, io, mm } = setup();
    io.add("a");
    const res = await mm.find("a", "video");
    expect(res.queued).toBe(true);
    expect(await store.queueLength("video")).toBe(1);
    expect(io.out.get("a")).toContainEqual(["match:queued", expect.objectContaining({ mode: "video" })]);
    mm.close();
  });

  it("matches two users and assigns deterministic roles (waiter = offerer)", async () => {
    const { store, io, mm } = setup();
    io.add("a");
    io.add("b");
    await mm.find("a", "video");
    const res = await mm.find("b", "video");
    expect(res.matched).toBeTruthy();
    const fa = foundFor(io.out, "a")[0];
    const fb = foundFor(io.out, "b")[0];
    expect(fa.matchId).toBe(fb.matchId);
    expect(fa.role).toBe("offerer");
    expect(fb.role).toBe("answerer");
    expect(await store.queueLength("video")).toBe(0);
    expect(await store.matchGet(fa.matchId)).toMatchObject({ a: "a", b: "b", mode: "video" });
    mm.close();
  });

  it("queues multiple simultaneous entrants and pairs them FIFO as new users arrive", async () => {
    const { store, io, mm } = setup();
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) io.add(id);
    // Same-tick burst: nobody can pop a peer yet, all four are queued FIFO.
    await Promise.all(["a", "b", "c", "d"].map((id) => mm.find(id, "text")));
    expect(await store.queueLength("text")).toBe(4);
    // New arrivals pair FIFO: e↔a, f↔b, g↔c; d keeps waiting.
    const rE = await mm.find("e", "text");
    const rF = await mm.find("f", "text");
    const rG = await mm.find("g", "text");
    expect([rE, rF, rG].every((r) => r.matched)).toBe(true);
    const pairs = new Set([rE.matched, rF.matched, rG.matched]);
    expect(pairs.size).toBe(3); // three distinct matches, no double-booking
    const mE = await store.matchGet(rE.matched);
    expect([mE.a, mE.b].sort()).toEqual(["a", "e"]);
    const mG = await store.matchGet(rG.matched);
    expect([mG.a, mG.b].sort()).toEqual(["c", "g"]);
    expect(await store.queueLength("text")).toBe(1);
    mm.close();
  });

  it("dedupes duplicate match:find requests", async () => {
    const { store, io, mm } = setup();
    io.add("a");
    await mm.find("a", "video");
    const res = await mm.find("a", "video");
    expect(res.queued).toBe(true);
    expect(await store.queueLength("video")).toBe(1);
    expect(foundFor(io.out, "a").length).toBe(0);
    mm.close();
  });

  it("rejects match:find while already matched", async () => {
    const { io, mm } = setup();
    io.add("a");
    io.add("b");
    await mm.find("a", "video");
    await mm.find("b", "video");
    await expect(mm.find("a", "video")).rejects.toMatchObject({ code: "already-matched" });
    mm.close();
  });

  it("enforces the matchmaking cooldown to prevent spam", async () => {
    const { io, mm } = setup({ findCooldownMs: 60000, sessionTtlMs: 600000, queueMaxAgeMs: 120000 });
    io.add("a");
    await mm.find("a", "video"); // queued
    await mm.cancel("a"); // back to idle
    await expect(mm.find("a", "video")).rejects.toMatchObject({ code: "too-fast" });
    mm.close();
  });

  it("removes a disconnected waiter from the queue", async () => {
    const { store, io, mm } = setup();
    io.add("a");
    io.add("b");
    await mm.find("a", "video");
    mm.onDisconnect("a");
    expect(await store.queueLength("video")).toBe(0);
    await mm.find("b", "video");
    expect(await store.queueLength("video")).toBe(1); // b just waits, does not match the ghost
    mm.close();
  });

  it("notifies the peer and cleans state when a user disconnects mid-session", async () => {
    const { store, io, mm } = setup();
    io.add("a");
    io.add("b");
    await mm.find("a", "video");
    const r = await mm.find("b", "video");
    const matchId = r.matched;
    io.sockets.sockets.delete("a"); // simulate abrupt disconnect
    mm.onDisconnect("a");
    await new Promise((r) => setTimeout(r, 20)); // let the async endMatch flush
    expect(io.out.get("b")).toContainEqual(["match:ended", { matchId, reason: "disconnected" }]);
    expect(await store.matchGet(matchId)).toBeNull();
    mm.close();
  });

  it("handles both users clicking Next simultaneously (idempotent end)", async () => {
    const { store, io, mm } = setup();
    io.add("a");
    io.add("b");
    await mm.find("a", "video");
    const r = await mm.find("b", "video");
    const matchId = r.matched;
    const resA = mm.next("a", matchId);
    const resB = mm.next("b", matchId);
    const [ra, rb] = await Promise.allSettled([resA, resB]);
    expect(ra.status).toBe("fulfilled");
    // whichever ran second sees the match already ended → controlled error, not a crash
    expect(rb.status === "rejected" ? (rb.reason instanceof MatchError && rb.reason.code === "no-match") : true).toBe(true);
    expect(io.out.get("a")).toContainEqual(["match:ended", { matchId, reason: "next" }]);
    expect(io.out.get("b")).toContainEqual(["match:ended", { matchId, reason: "next" }]);
    expect(await store.matchCount()).toBe(0);
    // both can re-enter matchmaking immediately
    expect((await mm.find("a", "video")).queued).toBe(true);
    mm.close();
  });

  it("skips stale queue entries (dead socket ids) instead of matching them", async () => {
    const { store, io, mm } = setup();
    io.add("a");
    await store.queuePush("video", "ghost", Date.now());
    const res = await mm.find("a", "video");
    expect(res.queued).toBe(true); // 'a' waited instead of matching a ghost
    expect(foundFor(io.out, "a").length).toBe(0);
    // the pairing scan skips dead entries (they remain in the queue and are
    // removed by the TTL sweeper / disconnect hook — never matched)
    expect(await store.queueLength("video")).toBe(2);
    mm.close();
  });

  it("never matches a user with themselves", async () => {
    const { store, io, mm } = setup();
    io.add("a");
    await store.queuePush("video", "a", Date.now()); // artificially duplicate
    const res = await mm.find("a", "video");
    expect(res.queued).toBe(true);
    expect(foundFor(io.out, "a").length).toBe(0);
    mm.close();
  });

  it("prunes stale queue entries by age", async () => {
    const { store } = setup();
    await store.queuePush("video", "old", Date.now() - 10 * 60e3);
    await store.queuePush("video", "new", Date.now());
    const removed = await store.queuePrune("video", 60e3);
    expect(removed).toBe(1);
    expect(await store.queueLength("video")).toBe(1);
  });
});

function foundFor(out, id) {
  return out.get(id)?.filter(([e]) => e === "match:found").map(([, d]) => d) ?? [];
}
function found(out, id) {
  return out.get(id) ?? [];
}
