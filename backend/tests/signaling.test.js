/**
 * End-to-end signaling tests: real Express app + real Socket.IO server +
 * real socket.io-client sockets (no mocks of the transport).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { io as ioc } from "socket.io-client";
import request from "supertest";

import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { MemoryStore } from "../src/store.js";
import { createModeration } from "../src/moderation.js";
import { createMatchmaker } from "../src/matchmaker.js";
import { attachSockets } from "../src/socket.js";
import { createApp } from "../src/app.js";

const log = createLogger("error");
const cfg = loadConfig({
  NODE_ENV: "test",
  PORT: "0",
  FRONTEND_URL: "http://localhost:5173",
  ADMIN_API_KEY: "test-admin-key",
  MATCH_FIND_COOLDOWN_MS: "0",
  HASH_SALT: "test-salt",
});

let app, server, io, base, store, moderation, matchmaker;

const connectClient = () =>
  new Promise((resolve, reject) => {
    const s = ioc(base, { transports: ["websocket"], forceNew: true, reconnection: false, timeout: 3000 });
    const t = setTimeout(() => reject(new Error("connect timeout")), 3000);
    s.on("connect", () => {
      clearTimeout(t);
      resolve(s);
    });
    s.on("connect_error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });

const waitFor = (socket, event, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (d) => {
      clearTimeout(t);
      resolve(d);
    });
  });

const emit = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

beforeAll(async () => {
  store = new MemoryStore();
  moderation = createModeration({ mongoUri: "", salt: cfg.hashSalt, log });
  await moderation.init();
  app = createApp({ cfg, store, moderation, log });
  server = http.createServer(app);
  io = new SocketIOServer(server, { cors: { origin: "http://localhost:5173", credentials: true } });
  matchmaker = createMatchmaker({ store, io, log, cfg });
  attachSockets(io, { matchmaker, moderation, store, cfg, log });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  io.close();
  await new Promise((res) => server.close(res));
  matchmaker.close();
  await store.close();
  await moderation.close();
});

describe("HTTP API", () => {
  it("GET /api/health returns ok with store modes", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.stores.state).toBe("memory");
    expect(res.body.stores.moderation).toBe("memory");
  });

  it("GET /api/stats returns real connection/queue numbers", async () => {
    const res = await request(app).get("/api/stats");
    expect(res.status).toBe(200);
    expect(typeof res.body.online).toBe("number");
    expect(res.body.waiting).toHaveProperty("video");
    expect(res.body.waiting).toHaveProperty("text");
    expect(typeof res.body.activeMatches).toBe("number");
  });

  it("GET /api/ice-servers includes STUN and never fails", async () => {
    const res = await request(app).get("/api/ice-servers");
    expect(res.status).toBe(200);
    expect(res.body.iceServers[0].urls.some((u) => u.startsWith("stun:"))).toBe(true);
  });

  it("POST /api/reports validates payloads and stores valid reports", async () => {
    const bad = await request(app).post("/api/reports").send({ reason: "x" });
    expect(bad.status).toBe(400);
    const good = await request(app).post("/api/reports").send({ reason: "Harassment", details: "kept insulting" });
    expect(good.status).toBe(201);
    const list = await request(app).get("/api/admin/reports").set("x-admin-key", "test-admin-key");
    expect(list.status).toBe(200);
    expect(list.body.count).toBeGreaterThanOrEqual(1);
    expect(list.body.reports[0].reason).toBe("Harassment");
  });

  it("admin endpoints require the admin key", async () => {
    const res = await request(app).get("/api/admin/reports");
    expect(res.status).toBe(401);
  });
});

describe("real-time signaling over real sockets", () => {
  it("matches two clients and relays offer/answer/ice in both directions", async () => {
    const a = await connectClient();
    const b = await connectClient();

    const aQueued = waitFor(a, "match:queued");
    await emit(a, "match:find", { mode: "video" });
    await aQueued;

    const bFoundP = waitFor(b, "match:found");
    const aFoundP = waitFor(a, "match:found");
    await emit(b, "match:find", { mode: "video" });
    const aFound = await aFoundP;
    const bFound = await bFoundP;
    expect(aFound.matchId).toBe(bFound.matchId);
    expect(aFound.role).toBe("offerer");
    expect(bFound.role).toBe("answerer");

    // offer: a -> b
    const gotOffer = waitFor(b, "webrtc:offer");
    await emit(a, "webrtc:offer", { matchId: aFound.matchId, sdp: "v=0\nfake-sdp-offer" });
    const offer = await gotOffer;
    expect(offer.sdp).toBe("v=0\nfake-sdp-offer");

    // answer: b -> a
    const gotAnswer = waitFor(a, "webrtc:answer");
    await emit(b, "webrtc:answer", { matchId: aFound.matchId, sdp: "v=0\nfake-sdp-answer" });
    expect((await gotAnswer).sdp).toBe("v=0\nfake-sdp-answer");

    // ice: a -> b
    const cand = { candidate: "candidate:1 1 udp 2122260223 10.0.0.1 54321 typ host", sdpMid: "0" };
    const gotIce = waitFor(b, "webrtc:ice-candidate");
    await emit(a, "webrtc:ice-candidate", { matchId: aFound.matchId, candidate: cand });
    expect((await gotIce).candidate).toEqual(cand);

    // chat: b -> a
    const gotMsg = waitFor(a, "chat:message");
    await emit(b, "chat:message", { matchId: aFound.matchId, text: "hello there" });
    expect((await gotMsg).text).toBe("hello there");

    a.disconnect();
    b.disconnect();
  });

  it("delivers each accepted chat message once to both participants with sender identity", async () => {
    const a = await connectClient();
    const b = await connectClient();
    const aQueued = waitFor(a, "match:queued");
    await emit(a, "match:find", { mode: "text" });
    await aQueued;
    const aFoundP = waitFor(a, "match:found");
    const bFoundP = waitFor(b, "match:found");
    await emit(b, "match:find", { mode: "text" });
    const [{ matchId }] = await Promise.all([aFoundP, bFoundP]);

    const receivedA = [];
    const receivedB = [];
    a.on("chat:message", (message) => receivedA.push(message));
    b.on("chat:message", (message) => receivedB.push(message));

    const accepted = [];
    const traffic = Array.from({ length: 20 }, (_, index) => [
      index % 2 === 0 ? a : b,
      `Message ${index} from ${index % 2 === 0 ? "A" : "B"}`,
    ]);
    for (const [sender, text] of traffic) {
      const ack = await emit(sender, "chat:message", { matchId, text });
      expect(ack.ok).toBe(true);
      accepted.push({ ...ack, from: sender.id, text });
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(receivedA).toHaveLength(accepted.length);
    expect(receivedB).toHaveLength(accepted.length);
    expect(receivedA).toEqual(receivedB);
    expect(new Set(receivedA.map((message) => message.messageId)).size).toBe(accepted.length);
    for (const [index, acceptedMessage] of accepted.entries()) {
      expect(receivedA[index]).toMatchObject({
        matchId,
        messageId: acceptedMessage.messageId,
        from: acceptedMessage.from,
        text: acceptedMessage.text,
        ts: acceptedMessage.ts,
      });
    }

    a.disconnect();
    b.disconnect();
  }, 15000);

  it("relays typing start and stop only to the matched peer", async () => {
    const a = await connectClient();
    const b = await connectClient();
    const c = await connectClient();
    const aQueued = waitFor(a, "match:queued");
    await emit(a, "match:find", { mode: "text" });
    await aQueued;
    const aFoundP = waitFor(a, "match:found");
    const bFoundP = waitFor(b, "match:found");
    await emit(b, "match:find", { mode: "text" });
    const [{ matchId }] = await Promise.all([aFoundP, bFoundP]);
    const unrelatedEvents = [];
    c.on("chat:typing", (event) => unrelatedEvents.push(event));

    const started = waitFor(b, "chat:typing");
    expect((await emit(a, "chat:typing", { matchId, typing: true })).ok).toBe(true);
    expect(await started).toMatchObject({ matchId, typing: true });

    const stopped = waitFor(b, "chat:typing");
    expect((await emit(a, "chat:typing", { matchId, typing: false })).ok).toBe(true);
    expect(await stopped).toMatchObject({ matchId, typing: false });

    const restarted = waitFor(b, "chat:typing");
    expect((await emit(a, "chat:typing", { matchId, typing: true })).ok).toBe(true);
    expect(await restarted).toMatchObject({ matchId, typing: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(unrelatedEvents).toHaveLength(0);

    a.disconnect();
    b.disconnect();
    c.disconnect();
  });

  it("blocks unauthorized signaling (non-member of the match)", async () => {
    const a = await connectClient();
    const b = await connectClient();
    const c = await connectClient();

    const aQueued = waitFor(a, "match:queued");
    await emit(a, "match:find", { mode: "video" });
    await aQueued;
    const aFoundP = waitFor(a, "match:found");
    const bFoundP = waitFor(b, "match:found");
    await emit(b, "match:find", { mode: "video" });
    const { matchId } = await bFoundP;
    await aFoundP;

    // c is not in this match
    const cErr = waitFor(c, "error");
    await emit(c, "chat:message", { matchId, text: "injected!" });
    const err = await cErr;
    expect(err.code).toBe("no-match");

    // b receives an error for unknown matchId too
    const bErr = waitFor(b, "error");
    await emit(b, "webrtc:offer", { matchId: "nonexistent", sdp: "v=0\nx" });
    expect((await bErr).code).toBe("no-match");

    a.disconnect();
    b.disconnect();
    c.disconnect();
  });

  it("rejects oversized / malformed payloads without crashing", async () => {
    const a = await connectClient();
    const b = await connectClient();
    const aFoundP = waitFor(a, "match:found");
    await emit(a, "match:find", { mode: "video" });
    const bFoundP = waitFor(b, "match:found");
    await emit(b, "match:find", { mode: "video" });
    const { matchId } = await aFoundP;
    await bFoundP;

    // validation errors are returned to the SENDING socket
    const bigErr = waitFor(a, "error");
    await emit(a, "webrtc:offer", { matchId, sdp: "x".repeat(70000) });
    expect((await bigErr).code).toBe("bad-sdp");

    const iceErr = waitFor(a, "error");
    await emit(a, "webrtc:ice-candidate", { matchId, candidate: "not-an-object" });
    expect((await iceErr).code).toBe("bad-ice");

    const msgErr = waitFor(a, "error");
    await emit(a, "chat:message", { matchId, text: "   " });
    expect((await msgErr).code).toBe("bad-message");

    // server still healthy
    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);

    a.disconnect();
    b.disconnect();
  });

  it("enforces chat rate limiting (burst protection)", async () => {
    const a = await connectClient();
    const b = await connectClient();
    const aFoundP = waitFor(a, "match:found");
    await emit(a, "match:find", { mode: "video" });
    const bFoundP = waitFor(b, "match:found");
    await emit(b, "match:find", { mode: "video" });
    const { matchId } = await aFoundP;
    await bFoundP;

    const received = [];
    a.on("chat:message", (m) => received.push(m.text));
    const limited = waitFor(b, "error");
    for (let i = 0; i < 9; i++) await emit(b, "chat:message", { matchId, text: `msg-${i}` });
    const err = await limited;
    expect(err.code).toBe("chat-limited");
    await new Promise((r) => setTimeout(r, 250));
    expect(received.length).toBeLessThanOrEqual(6);

    a.disconnect();
    b.disconnect();
  });

  it("Next: ends the match for both and allows immediate re-queue", async () => {
    const a = await connectClient();
    const b = await connectClient();
    const aFoundP = waitFor(a, "match:found");
    await emit(a, "match:find", { mode: "video" });
    const bFoundP = waitFor(b, "match:found");
    await emit(b, "match:find", { mode: "video" });
    const { matchId } = await aFoundP;
    await bFoundP;

    const bEnded = waitFor(b, "match:ended");
    await emit(a, "match:next", { matchId });
    const ended = await bEnded;
    expect(ended.reason).toBe("next");

    // a can immediately find again
    const aQueued = waitFor(a, "match:queued");
    await emit(a, "match:find", { mode: "video" });
    await aQueued;

    a.disconnect();
    b.disconnect();
  });

  it("disconnecting one side notifies the other with reason 'disconnected'", async () => {
    const a = await connectClient();
    const b = await connectClient();
    const aFoundP = waitFor(a, "match:found");
    await emit(a, "match:find", { mode: "video" });
    const bFoundP = waitFor(b, "match:found");
    await emit(b, "match:find", { mode: "video" });
    const { matchId } = await aFoundP;
    await bFoundP;

    const aEnded = waitFor(a, "match:ended");
    b.disconnect();
    const ended = await aEnded;
    expect(ended.reason).toBe("disconnected");
    expect(ended.matchId).toBe(matchId);

    // stale state is cleaned
    expect(await store.matchGet(matchId)).toBeNull();
    a.disconnect();
  });
});
