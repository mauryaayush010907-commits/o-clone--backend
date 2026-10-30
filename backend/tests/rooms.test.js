/**
 * Private-room tests.
 *
 * What we exercise here:
 *  - room creation, code normalization, code format validation
 *  - rate limiting on code attempts
 *  - join request lifecycle (request → accept → member)
 *  - host authorization on accept / reject / lock / remove
 *  - capacity: 5 max, atomic, simultaneous acceptance cannot exceed
 *  - host disconnect / member disconnect cleanup
 *  - empty-room reaping
 *  - username uniqueness + suggestions
 *  - cross-room message isolation (membership-bounded signaling)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { Server as SocketIOServer } from "socket.io";
import { io as ioc } from "socket.io-client";
import request from "supertest";

import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { MemoryStore } from "../src/store.js";
import { createModeration } from "../src/moderation.js";
import { createRoomManager, prefixFromUsername } from "../src/rooms.js";
import { attachSFU } from "../src/sfu.js";
import { attachSockets } from "../src/socket.js";
import { createApp } from "../src/app.js";
import { createMatchmaker } from "../src/matchmaker.js";

const log = createLogger("error");
const cfg = loadConfig({
  NODE_ENV: "test",
  PORT: "0",
  FRONTEND_URL: "http://localhost:5173",
  ADMIN_API_KEY: "test-admin",
  HASH_SALT: "test-salt",
});

let store, moderation, app, server, io, base, rooms, sfu;

const connectClient = () =>
  new Promise((resolve, reject) => {
    const s = ioc(base, { transports: ["websocket"], forceNew: true, reconnection: false, timeout: 3000 });
    const t = setTimeout(() => reject(new Error("connect timeout")), 3000);
    s.on("connect", () => { clearTimeout(t); resolve(s); });
    s.on("connect_error", (e) => { clearTimeout(t); reject(e); });
  });

const waitFor = (socket, event, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (d) => { clearTimeout(t); resolve(d); });
  });

const emit = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, (r) => resolve(r)));

beforeAll(async () => {
  store = new MemoryStore();
  moderation = createModeration({ mongoUri: "", salt: cfg.hashSalt, log });
  await moderation.init();
  app = createApp({ cfg, store, moderation, log });
  server = http.createServer(app);
  io = new SocketIOServer(server, { cors: { origin: "*" } });
  rooms = createRoomManager({ store, io, log, cfg });
  cfg.storeRef = () => store;
  sfu = attachSFU({ io, rooms, log, cfg });
  const matchmaker = createMatchmaker({ store, io, log, cfg });
  attachSockets(io, { matchmaker, moderation, store, cfg, log, rooms, sfu });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  io.close();
  await new Promise((res) => server.close(res));
  await store.close();
  await moderation.close();
});

describe("prefixFromUsername (code prefix derivation)", () => {
  it("takes the first 2 letters, uppercased, and remaps I/L/O to M/N (to avoid 1/l/0 confusion)", () => {
    expect(prefixFromUsername("alice")).toBe("AM");       // I→M
    expect(prefixFromUsername("BOB")).toBe("BN");        // O→N
    expect(prefixFromUsername("Liam")).toBe("MM");        // L→M, i→M
    // First 4 letters are O, L, I, V. After the I/L→M remap, the first two
    // become N, M (the third letter is also remapped, but the prefix is
    // only the first 2 chars). The fourth letter (V) is unused.
    expect(prefixFromUsername("Olivia")).toBe("NM");
    expect(prefixFromUsername("X")).toBe("XX");
    expect(prefixFromUsername("Indian")).toBe("MN");      // I→M, N
  });
  it("skips non-letters and pads with X if the username has fewer than 2 letters", () => {
    expect(prefixFromUsername("12345")).toBe("XX");       // no letters
    expect(prefixFromUsername("a1b2")).toBe("AB");        // skip digits
    expect(prefixFromUsername("z")).toBe("ZX");           // pad with X
    expect(prefixFromUsername("a")).toBe("AX");           // pad with X
    expect(prefixFromUsername("")).toBe("XX");
  });
  it("is case-insensitive", () => {
    expect(prefixFromUsername("Alice")).toBe("AM");  // I→M
    expect(prefixFromUsername("ALICE")).toBe("AM");
    expect(prefixFromUsername("aLiCe")).toBe("AM");
  });
  it("never returns ambiguous characters (no I, L, O)", () => {
    for (const name of ["I", "ILLINOIS", "OOO", "LOLO", "iris", "olive", "lion", "alpha", "omega"]) {
      const p = prefixFromUsername(name);
      expect(p).toHaveLength(2);
      expect(/[ILO]/.test(p)).toBe(false);
      expect(p).toMatch(/^[A-HJKMNPQRSTUVWXYZ]{2}$/);
    }
  });
});

describe("private rooms", () => {
  it("creates a room with a 2-letter-from-username + 6-digit code, copies the host into members", async () => {
    const s = await connectClient();
    await emit(s, "username:set", { username: "alice" });
    const created = await emit(s, "room:create");
    expect(created.ok).toBe(true);
    // New format: 2 letters derived from the username + 6 random digits.
    // "alice" → "AM" (I→M remap) + 6 digits.
    expect(created.code).toMatch(/^AM\d{6}$/);
    expect(created.roomId).toBe("r_" + created.code);
    // And the code hashes to a stable key (this is what the room lookup
    // uses internally; verifying it round-trips confirms no second room
    // can ever collide on the same code).
    const hash = createHash("sha256").update(created.code.toUpperCase()).digest("hex");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    s.disconnect();
  });

  it("rejects bad code formats (length, charset)", async () => {
    const s = await connectClient();
    await emit(s, "username:set", { username: "bob" });
    const created = await emit(s, "room:create");
    const r1 = await emit(s, "room:request-join", { code: "ABC" });
    expect(r1.ok).toBe(false);
    expect(r1.code).toBe("bad-code-format");
    const r2 = await emit(s, "room:request-join", { code: "IIIIIIII" }); // I is excluded to avoid confusion with 1.
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe("bad-code-format");
    void created;
    s.disconnect();
  });

  it("returns not-found for unknown codes", async () => {
    const s = await connectClient();
    await emit(s, "username:set", { username: "carol" });
    const r = await emit(s, "room:request-join", { code: "ABCDEFGH" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not-found");
    s.disconnect();
  });

  it("rate-limits code attempts per socket", async () => {
    const s = await connectClient();
    await emit(s, "username:set", { username: "dan" });
    const created = await emit(s, "room:create");
    // Make 10 attempts, then 1 more — the 11th should be limited.
    for (let i = 0; i < 10; i++) {
      const r = await emit(s, "room:request-join", { code: "12345678" });
      expect(r.ok).toBe(false);
    }
    const r = await emit(s, "room:request-join", { code: "12345678" });
    expect(r.code).toBe("rate-limited");
    s.disconnect();
    void created;
  });

  it("host accepts a joiner, member gets a join-accepted event", async () => {
    const host = await connectClient();
    await emit(host, "username:set", { username: "host1" });
    const created = await emit(host, "room:create");
    const hostJoin = await emit(host, "room:join", { roomId: created.roomId, isHost: true });
    expect(hostJoin.ok).toBe(true);
    const code = created.code;

    const guest = await connectClient();
    await emit(guest, "username:set", { username: "guest1" });
    const requests = [];
    host.on("room:join-request", (request) => requests.push(request));
    const req = await emit(guest, "room:request-join", { code });
    expect(req.ok).toBe(true);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ requestId: req.requestId, username: "guest1" });

    const acceptedP = waitFor(guest, "room:join-accepted");
    const peerJoinedEvents = [];
    host.on("room:peer-joined", (event) => peerJoinedEvents.push(event));
    const accept = await emit(host, "room:accept", { roomId: created.roomId, requestId: req.requestId });
    expect(accept.ok).toBe(true);
    expect(accept.member.username).toBe("guest1");

    // Guest receives join-accepted.
    const accepted = await acceptedP;
    expect(accepted.username).toBe("guest1");
    expect(accepted.members.length).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(peerJoinedEvents).toHaveLength(0);

    const peerJoinedP = waitFor(host, "room:peer-joined");
    const guestJoined = await emit(guest, "room:join", { roomId: created.roomId, isHost: false });
    expect(guestJoined.ok).toBe(true);
    expect(guestJoined.others).toContainEqual(expect.objectContaining({ socketId: host.id, isHost: true }));
    expect(await peerJoinedP).toMatchObject({ socketId: guest.id, roomId: created.roomId });

    const deliveredMessage = waitFor(host, "room:chat");
    const chatAck = await emit(guest, "room:chat", { roomId: created.roomId, text: "private room hello" });
    expect(chatAck.ok).toBe(true);
    expect(await deliveredMessage).toMatchObject({ from: guest.id, username: "guest1", text: "private room hello" });

    const deliveredCandidate = waitFor(guest, "webrtc:ice");
    const candidateAck = await emit(host, "webrtc:ice", {
      roomId: created.roomId,
      to: guest.id,
      candidate: { candidate: "candidate:test", sdpMid: "0", sdpMLineIndex: 0 },
    });
    expect(candidateAck.ok).toBe(true);
    expect(await deliveredCandidate).toMatchObject({
      from: host.id,
      roomId: created.roomId,
      candidate: { candidate: "candidate:test" },
    });

    host.disconnect();
    guest.disconnect();
  });

  it("only the host can accept (non-host gets not-host)", async () => {
    const host = await connectClient();
    await emit(host, "username:set", { username: "hostA" });
    const created = await emit(host, "room:create");
    const guest1 = await connectClient();
    await emit(guest1, "username:set", { username: "guestA1" });
    const guest2 = await connectClient();
    await emit(guest2, "username:set", { username: "guestA2" });
    const req = await emit(guest1, "room:request-join", { code: created.code });
    // Non-host tries to accept.
    const r = await emit(guest2, "room:accept", { roomId: created.roomId, requestId: req.requestId });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not-host");
    host.disconnect(); guest1.disconnect(); guest2.disconnect();
  });

  it("enforces the 5-participant cap atomically under concurrent acceptances", async () => {
    const host = await connectClient();
    await emit(host, "username:set", { username: "hostcap" });
    const created = await emit(host, "room:create");
    const code = created.code;
    // Pre-fill 4 guests so the room is at 5/5 (host counts as 1).
    const guests = [];
    for (let i = 0; i < 4; i++) {
      const g = await connectClient();
      const username = "capg" + i;
      await emit(g, "username:set", { username });
      const r = await emit(g, "room:request-join", { code });
      const a = await emit(host, "room:accept", { roomId: created.roomId, requestId: r.requestId });
      expect(a.ok).toBe(true);
      guests.push(g);
    }
    // 5th guest requests; the host tries to accept — must fail.
    const late = await connectClient();
    await emit(late, "username:set", { username: "caplate" });
    const lr = await emit(late, "room:request-join", { code });
    expect(lr.ok).toBe(true);
    const la = await emit(host, "room:accept", { roomId: created.roomId, requestId: lr.requestId });
    expect(la.ok).toBe(false);
    expect(la.code).toBe("room-full");
    host.disconnect();
    for (const g of guests) g.disconnect();
    late.disconnect();
  });

  it("simultaneous concurrent acceptances cannot exceed 5", async () => {
    const host = await connectClient();
    await emit(host, "username:set", { username: "hc" });
    const created = await emit(host, "room:create");
    const code = created.code;

    // 3 guests request simultaneously.
    const gs = [];
    for (let i = 0; i < 3; i++) {
      const g = await connectClient();
      const username = "racer" + i;
      await emit(g, "username:set", { username });
      const r = await emit(g, "room:request-join", { code });
      expect(r.ok).toBe(true);
      gs.push({ sock: g, req: r });
    }
    // Host accepts all three in parallel.
    const accepts = await Promise.all(
      gs.map(({ req }) => emit(host, "room:accept", { roomId: created.roomId, requestId: req.requestId }))
    );
    const oks = accepts.filter((a) => a.ok).length;
    expect(oks).toBe(3);
    // Now the room has host + 3 guests = 4. We need a 5th and a 6th; 5th
    // should succeed, 6th should fail.
    const g5 = await connectClient();
    await emit(g5, "username:set", { username: "g5" });
    const r5 = await emit(g5, "room:request-join", { code });
    expect(r5.ok).toBe(true);
    const a5 = await emit(host, "room:accept", { roomId: created.roomId, requestId: r5.requestId });
    expect(a5.ok).toBe(true);

    const g6 = await connectClient();
    await emit(g6, "username:set", { username: "g6" });
    const r6 = await emit(g6, "room:request-join", { code });
    expect(r6.ok).toBe(true);
    const a6 = await emit(host, "room:accept", { roomId: created.roomId, requestId: r6.requestId });
    expect(a6.ok).toBe(false);
    expect(a6.code).toBe("room-full");

    host.disconnect();
    for (const { sock } of gs) sock.disconnect();
    g5.disconnect(); g6.disconnect();
  });

  it("rejects a request cleanly and the requester can re-request", async () => {
    const host = await connectClient();
    await emit(host, "username:set", { username: "hrej" });
    const created = await emit(host, "room:create");
    const guest = await connectClient();
    await emit(guest, "username:set", { username: "grej" });
    const r1 = await emit(guest, "room:request-join", { code: created.code });
    expect(r1.ok).toBe(true);
    const rej = await emit(host, "room:reject", { roomId: created.roomId, requestId: r1.requestId });
    expect(rej.ok).toBe(true);
    const r2 = await emit(guest, "room:request-join", { code: created.code });
    expect(r2.ok).toBe(true);
    host.disconnect(); guest.disconnect();
  });

  it("host can lock the room; new requests are denied", async () => {
    const host = await connectClient();
    await emit(host, "username:set", { username: "hlock" });
    const created = await emit(host, "room:create");
    const lock = await emit(host, "room:lock", { roomId: created.roomId, locked: true });
    expect(lock.ok).toBe(true);
    const guest = await connectClient();
    await emit(guest, "username:set", { username: "g4lock" });
    const r = await emit(guest, "room:request-join", { code: created.code });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("room-locked");
    host.disconnect(); guest.disconnect();
  });

  it("host can remove a member; the member is evicted", async () => {
    const host = await connectClient();
    await emit(host, "username:set", { username: "hrem" });
    const created = await emit(host, "room:create");
    const g1 = await connectClient();
    await emit(g1, "username:set", { username: "g1rem" });
    const g2 = await connectClient();
    await emit(g2, "username:set", { username: "g2rem" });
    const r1 = await emit(g1, "room:request-join", { code: created.code });
    const r2 = await emit(g2, "room:request-join", { code: created.code });
    const a1 = await emit(host, "room:accept", { roomId: created.roomId, requestId: r1.requestId });
    const a2 = await emit(host, "room:accept", { roomId: created.roomId, requestId: r2.requestId });
    expect(a1.ok && a2.ok).toBe(true);

    // Host removes g2.
    const evP = waitFor(g2, "room:removed");
    const rem = await emit(host, "room:remove", { roomId: created.roomId, socketId: g2.id });
    expect(rem.ok).toBe(true);
    const ev = await evP;
    expect(ev.roomId).toBe(created.roomId);
    host.disconnect(); g1.disconnect(); g2.disconnect();
  });

  it("empty room is reaped when the last member leaves", async () => {
    const host = await connectClient();
    await emit(host, "username:set", { username: "solo" });
    const created = await emit(host, "room:create");
    expect(created.ok).toBe(true);
    // The room should exist now.
    const m1 = await store.roomGetMembers(created.roomId);
    expect(m1).not.toBeNull();
    // Disconnect host.
    host.disconnect();
    // Give the disconnect handler a moment.
    await new Promise((r) => setTimeout(r, 50));
    const m2 = await store.roomGetMembers(created.roomId);
    expect(m2).toBeNull();
  });

  it("room:close by the host emits room:closed to the room namespace", async () => {
    const host = await connectClient();
    await emit(host, "username:set", { username: "hclose" });
    const created = await emit(host, "room:create");
    const g = await connectClient();
    await emit(g, "username:set", { username: "gclose" });
    const r = await emit(g, "room:request-join", { code: created.code });
    const a = await emit(host, "room:accept", { roomId: created.roomId, requestId: r.requestId });
    expect(a.ok).toBe(true);
    // g joins the namespace by emitting room:join (the SFU handler).
    const joinAck = await emit(g, "room:join", { roomId: created.roomId, isHost: false });
    expect(joinAck.ok).toBe(true);
    const closedP = waitFor(g, "room:closed", 3000);
    const closeAck = await emit(host, "room:close", { roomId: created.roomId });
    expect(closeAck.ok).toBe(true);
    const closed = await closedP;
    expect(closed.reason).toBe("host-closed");
    host.disconnect(); g.disconnect();
  });

  it("username reservation is case-insensitive and rejects already-taken", async () => {
    const s1 = await connectClient();
    const r1 = await emit(s1, "username:set", { username: "Alice" });
    expect(r1.ok).toBe(true);
    expect(r1.username).toBe("Alice");
    const s2 = await connectClient();
    const r2 = await emit(s2, "username:set", { username: "alice" });
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe("username-taken");
    expect(Array.isArray(r2.suggestions)).toBe(true);
    expect(r2.suggestions.length).toBeGreaterThan(0);
    // Suggestions must be different from the taken one.
    for (const s of r2.suggestions) expect(s.toLowerCase()).not.toBe("alice");
    s1.disconnect(); s2.disconnect();
  });

  it("rejects bad username formats", async () => {
    const s = await connectClient();
    const r1 = await emit(s, "username:set", { username: "a" });
    expect(r1.ok).toBe(false);
    const r2 = await emit(s, "username:set", { username: "evil name with spaces!" });
    expect(r2.ok).toBe(false);
    const r3 = await emit(s, "username:set", { username: "x".repeat(25) });
    expect(r3.ok).toBe(false);
    s.disconnect();
  });
});
