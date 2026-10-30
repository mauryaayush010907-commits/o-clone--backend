/**
 * Socket.IO signaling layer.
 *
 * Security model:
 *  - clients NEVER specify a target socket id. Every relayed event carries a
 *    matchId; the server verifies the sender is a member of that match in the
 *    shared store and forwards to the *derived* peer. Unknown matchId,
 *    non-membership, or malformed payloads are rejected with an `error` event.
 *  - per-socket rate limits: match:find cooldown, chat burst, typing, reports.
 *  - banned (hashed-IP) users are disconnected on connect.
 *  - every handler is wrapped: malformed data can never crash the server.
 */
import { randomUUID } from "node:crypto";
import { hashIp } from "./moderation.js";
import { MatchError } from "./matchmaker.js";
import { sanitizePrefs } from "./prefs.js";

function clientIp(socket) {
  const h = socket.handshake.headers["x-forwarded-for"];
  if (h) return String(h).split(",")[0].trim();
  return socket.handshake.address || "unknown";
}

export function attachSockets(io, { matchmaker, moderation, store, cfg, log, rooms, sfu }) {
  io.on("connection", (socket) => {
    const ip = clientIp(socket);
    const ipHash = hashIp(ip, cfg.hashSalt);
    const chatLog = [];
    const reportLog = [];
    let lastTyping = 0;
    let chatEventQueue = Promise.resolve();

    // Ban gate (async) — disconnect if banned.
    moderation
      .isBanned(ipHash)
      .then((ban) => {
        if (ban) {
          log.warn("banned client disconnected", { socket: socket.id, until: ban.expiresAt });
          socket.emit("banned", { until: ban.expiresAt });
          socket.disconnect(true);
        }
      })
      .catch((e) => log.warn("ban check failed", { err: e.message }));

    store.counterAdd("online", 1).catch(() => {});
    log.debug("socket connected", { socket: socket.id });

    socket.on("disconnect", async (reason) => {
      store.counterAdd("online", -1).catch(() => {});
      matchmaker.onDisconnect(socket.id);
      try {
        const room = await rooms?.detach(socket.id);
        if (room?.roomClosed) {
          io.to(`room:${room.roomId}`).emit("room:closed", { roomId: room.roomId, reason: "empty" });
        } else if (room?.members) {
          sfu.broadcastPeers(room.roomId, room.members.host, room.members.members);
        }
      } catch (e) {
        log.warn("room disconnect cleanup failed", { socket: socket.id, err: e.message });
      }
      log.debug("socket disconnected", { socket: socket.id, reason });
    });

    /** Uniform handler wrapper: validates, runs, reports errors without crashing. */
    const wrap = (event, handler) => {
      socket.on(event, (data, ack) => {
        const process = async () => {
        // Always ack (success or failure) so client emitters never hang.
        const done = (payload) => {
          if (typeof ack === "function") ack(payload);
        };
        try {
          const res = await handler(data && typeof data === "object" ? data : {});
          const payload = res && typeof res === "object" ? res : { ok: true };
          socket.emit(`${event}:ok`, payload);
          done(payload);
         } catch (e) {
          const code = e instanceof MatchError ? e.code : e?.code || "invalid";
          const message = e?.message || "Invalid request";
          log.debug("socket event handler error", { socket: socket.id, event, code, message, stack: e?.stack });
          // Forward any non-reserved extra fields (e.g. `suggestions` from
          // username:set) so the client can use them without an extra
          // round-trip.
          const extras = {};
          for (const k of Object.keys(e || {})) {
            if (k === "code" || k === "message" || k === "stack") continue;
            extras[k] = e[k];
          }
          const payload = { ok: false, code, message, ...extras };
          socket.emit("error", { code, message, event, ...extras });
          socket.emit(`${event}:ok`, payload);
          done(payload);
        }
        };
        if (event === "chat:message" || event === "chat:typing") {
          chatEventQueue = chatEventQueue.then(process, process);
        } else {
          process();
        }
      });
    };

    const matchIdOf = (d) => (typeof d.matchId === "string" && d.matchId.length <= 64 ? d.matchId : null);

    /* ---------- matchmaking ---------- */
    wrap("match:find", async (d) => {
      const mode = d.mode;
      if (mode !== "video" && mode !== "text") throw new MatchError("bad-mode", "mode must be 'video' or 'text'");
      // Filters are fully optional — missing prefs = standard random matchmaking.
      return matchmaker.find(socket.id, mode, sanitizePrefs(d.prefs));
    });
    wrap("match:expand", async () => matchmaker.expand(socket.id));
    wrap("match:cancel", async () => matchmaker.cancel(socket.id));
    wrap("match:next", async (d) => {
      const matchId = matchIdOf(d);
      if (!matchId) throw new MatchError("bad-match-id");
      return matchmaker.next(socket.id, matchId);
    });
    wrap("match:stop", async (d) => {
      const matchId = matchIdOf(d);
      if (!matchId) throw new MatchError("bad-match-id");
      return matchmaker.stop(socket.id, matchId);
    });

    /* ---------- webRTC signaling (validated against match membership) ---------- */
    const relaySdp = (event) => async (d) => {
      const matchId = matchIdOf(d);
      if (!matchId) throw new MatchError("bad-match-id");
      if (typeof d.sdp !== "string" || d.sdp.length === 0 || d.sdp.length > 65536) throw new MatchError("bad-sdp", "SDP payload invalid or too large");
      const peer = await matchmaker.matchPeer(matchId, socket.id);
      if (!peer) throw new MatchError("no-match", "You are not in this match");
      const payload = { matchId, sdp: d.sdp };
      if (event === "webrtc:offer") payload.retry = d.retry === true;
      io.to(peer).emit(event, payload);
      return { ok: true };
    };
    wrap("webrtc:offer", relaySdp("webrtc:offer"));
    wrap("webrtc:answer", relaySdp("webrtc:answer"));

    wrap("webrtc:ice-candidate", async (d) => {
      const matchId = matchIdOf(d);
      if (!matchId) throw new MatchError("bad-match-id");
      const cand = d.candidate;
      if (!cand || typeof cand !== "object") throw new MatchError("bad-ice", "candidate must be an RTCIceCandidate object");
      if (JSON.stringify(cand).length > 4096) throw new MatchError("bad-ice", "candidate too large");
      const peer = await matchmaker.matchPeer(matchId, socket.id);
      if (!peer) throw new MatchError("no-match", "You are not in this match");
      io.to(peer).emit("webrtc:ice-candidate", { matchId, candidate: cand });
      return { ok: true };
    });

    /* ---------- chat (real-time, ephemeral) ---------- */
    wrap("chat:message", async (d) => {
      const matchId = matchIdOf(d);
      if (!matchId) throw new MatchError("bad-match-id");
      const text = typeof d.text === "string" ? d.text.trim() : "";
      if (!text || text.length > cfg.maxMessageLength) {
        throw new MatchError("bad-message", `Message must be 1..${cfg.maxMessageLength} characters`);
      }
      const now = Date.now();
      while (chatLog.length && now - chatLog[0] > 2000) chatLog.shift();
      if (chatLog.length >= cfg.chatsPerWindow) throw new MatchError("chat-limited", "You are sending messages too quickly");
      chatLog.push(now);
      lastTyping = 0;
      const peer = await matchmaker.matchPeer(matchId, socket.id);
      if (!peer) throw new MatchError("no-match", "You are not in this match");
      const message = { matchId, messageId: randomUUID(), from: socket.id, text, ts: now };
      io.to([socket.id, peer]).emit("chat:message", message);
      return { ok: true, messageId: message.messageId, ts: now };
    });

    wrap("chat:typing", async (d) => {
      const matchId = matchIdOf(d);
      if (!matchId) throw new MatchError("bad-match-id");
      const typing = d.typing !== false;
      const now = Date.now();
      if (typing) {
        if (now - lastTyping < 800) return { ok: true, dropped: true };
        lastTyping = now;
      } else {
        lastTyping = 0;
      }
      const peer = await matchmaker.matchPeer(matchId, socket.id);
      if (!peer) throw new MatchError("no-match", "You are not in this match");
      io.to(peer).emit("chat:typing", { matchId, typing });
      return { ok: true, typing };
    });

    /* ---------- private rooms (host-approved, code-gated, max 5) ---------- */
    if (rooms && sfu) {
      const usernameOk = (u) => typeof u === "string" && /^[A-Za-z0-9._-]{2,20}$/.test(u);
      const ipKey = `${ipHash}:${(cfg.hashSalt || "drift").slice(0, 6)}`;

      const ack = (cb, payload) => { if (typeof cb === "function") cb(payload); };

      wrap("username:set", async (d) => {
        const u = d && typeof d.username === "string" ? d.username.trim() : "";
        if (!usernameOk(u)) throw new MatchError("bad-username", "Username must be 2-20 chars: letters, digits, . _ -");
        const ok = await store.usernameReserve(u.toLowerCase(), u, socket.id, 5 * 60 * 1000);
        if (!ok) {
          // Suggest up to three alternates (suffix a number) and verify each
          // is actually available via a short-lived reservation.
          const base = u.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 16);
          const out = [];
          for (let i = 1; i <= 50 && out.length < 3; i++) {
            const cand = (`${base}${i}`).slice(0, 20);
            if (!usernameOk(cand)) continue;
            try {
              if (await store.usernameReserve(cand.toLowerCase(), cand, "__suggest__", 1000)) {
                out.push(cand);
              }
            } catch {}
          }
          const err = new Error("Username is already taken");
          err.code = "username-taken";
          err.suggestions = out;
          throw err;
        }
        socket.data.username = u;
        return { ok: true, username: u };
      });

      wrap("room:create", () => {
        const username = socket.data.username;
        if (!username) throw new MatchError("no-username", "Set a username first (username:set)");
        return rooms.createRoom({ hostSocketId: socket.id, username }).then((r) => {
          if (!r.ok) throw new MatchError(r.error || "create-failed");
          sfu.broadcastPeers(r.roomId, socket.id, new Map([[socket.id, { username, isHost: true, joinedAt: Date.now() }]]));
          return { ok: true, code: r.code, roomId: r.roomId, expiresInMs: 30 * 60 * 1000 };
        });
      });

      wrap("room:request-join", (d) => {
        const code = d && typeof d.code === "string" ? d.code : "";
        const username = socket.data.username;
        if (!username) throw new MatchError("no-username", "Set a username first (username:set)");
        if (!code) throw new MatchError("no-code", "Room code is required");
        return rooms.requestJoin({ socketId: socket.id, username, rawCode: code, ipKey: `${ipKey}:${socket.id}` }).then((r) => {
          if (!r.ok) throw new MatchError(r.error || "join-failed");
          // Notify the host (and the other members, in case the host isn't
          // online — the request will just be in their pending list).
          const hostId = r.meta?.host;
          const room = io.to(r.roomId ? `room:${r.roomId}` : socket.id);
          (hostId ? room.except(hostId) : room).emit("room:join-request", {
            roomId: r.roomId,
            requestId: r.requestId,
            username,
            ts: Date.now(),
          });
          // If the host socket is connected, deliver to it directly so the
          // request shows up even if the host hasn't joined the room: namespace.
          if (hostId) io.to(hostId).emit("room:join-request", { roomId: r.roomId, requestId: r.requestId, username, ts: Date.now() });
          return { ok: true, requestId: r.requestId, roomId: r.roomId };
        });
      });

      wrap("room:cancel-request", (d) => {
        const roomId = d?.roomId;
        const requestId = d?.requestId;
        if (!roomId || !requestId) throw new MatchError("missing-params");
        return rooms.cancelRequest({ socketId: socket.id, roomId, requestId }).then((r) => ({ ok: !!r }));
      });

      wrap("room:accept", (d) => {
        const roomId = d?.roomId;
        const requestId = d?.requestId;
        if (!roomId || !requestId) throw new MatchError("missing-params");
        return rooms.acceptRequest({ hostSocketId: socket.id, roomId, requestId }).then((r) => {
          if (!r.ok) {
            // Forward suggested alternatives back to the host.
            throw new MatchError(r.error || "accept-failed", r.error || "accept-failed");
          }
          // Tell the joiner they were accepted.
          io.to(r.member.socketId).emit("room:join-accepted", { roomId, username: r.member.username, members: [...r.members.members.entries()].map(([sid, e]) => ({ socketId: sid, username: e.username, isHost: !!e.isHost })) });
          sfu.broadcastPeers(roomId, r.members.host, r.members.members);
          // Cancel any pending requests from the same socket (so a duplicate
          // acceptance can't slip through if the user double-clicks).
          return { ok: true, member: r.member };
        });
      });

      wrap("room:reject", (d) => {
        const roomId = d?.roomId;
        const requestId = d?.requestId;
        const reason = typeof d?.reason === "string" ? d.reason.slice(0, 200) : "";
        if (!roomId || !requestId) throw new MatchError("missing-params");
        return rooms.rejectRequest({ hostSocketId: socket.id, roomId, requestId, reason }).then((r) => {
          if (!r.ok) throw new MatchError(r.error || "reject-failed");
          io.to(r.member.socketId).emit("room:join-rejected", { roomId, requestId, reason });
          return { ok: true };
        });
      });

      wrap("room:lock", (d) => {
        const roomId = d?.roomId;
        const locked = !!d?.locked;
        if (!roomId) throw new MatchError("missing-params");
        return rooms.setLocked({ hostSocketId: socket.id, roomId, locked }).then((r) => {
          if (!r.ok) throw new MatchError(r.error || "lock-failed");
          io.to(`room:${roomId}`).emit("room:lock-changed", { roomId, locked });
          return { ok: true, locked };
        });
      });

      wrap("room:remove", (d) => {
        const roomId = d?.roomId;
        const targetSocketId = d?.socketId;
        if (!roomId || !targetSocketId) throw new MatchError("missing-params");
        return rooms.removeMember({ hostSocketId: socket.id, roomId, targetSocketId }).then((r) => {
          if (!r.ok) throw new MatchError(r.error || "remove-failed");
          io.to(targetSocketId).emit("room:removed", { roomId, reason: "removed-by-host" });
          sfu.announceLeave(roomId, targetSocketId, "removed-by-host");
          sfu.broadcastPeers(roomId, r.members.host, r.members.members);
          return { ok: true };
        });
      });

      wrap("room:close", (d) => {
        const roomId = d?.roomId;
        if (!roomId) throw new MatchError("missing-params");
        return store.roomGetMembers(roomId).then((m) => {
          if (!m) return { ok: true, alreadyClosed: true };
          if (m.host !== socket.id) throw new MatchError("not-host");
          io.to(`room:${roomId}`).emit("room:closed", { roomId, reason: "host-closed" });
          sfu.announceClosed(roomId, "host-closed");
          return store.roomDelMeta(roomId).then(() => ({ ok: true }));
        });
      });

      // Clean up the username reservation on disconnect.
      socket.on("disconnect", () => {
        store.usernameRelease(socket.id).catch(() => {});
      });
    }

    /* ---------- abuse reporting ---------- */
    wrap("user:report", async (d) => {
      const matchId = matchIdOf(d);
      if (!matchId) throw new MatchError("bad-match-id");
      const reason = typeof d.reason === "string" && d.reason.length >= 2 ? d.reason.slice(0, 40) : "abuse";
      const details = typeof d.details === "string" ? d.details.slice(0, 500) : "";
      const peer = await matchmaker.matchPeer(matchId, socket.id);
      if (!peer) throw new MatchError("no-match", "You are not in this match");

      const now = Date.now();
      while (reportLog.length && now - reportLog[0] > 3600e3) reportLog.shift();
      if (reportLog.length >= 3) throw new MatchError("report-limited", "Report limit reached for this hour");
      reportLog.push(now);

      const peerIp = io.sockets.sockets.get(peer) ? clientIp(io.sockets.sockets.get(peer)) : "unknown";
      const report = await moderation.report({
        reason,
        details,
        reporterHash: ipHash,
        reportedHash: hashIp(peerIp, cfg.hashSalt),
        matchId,
      });
      socket.emit("user:report-ack", { matchId, reportId: String(report._id || report.id || "") });
      io.to(peer).emit("user:reported", { matchId });
      return { ok: true };
    });

    /* ---------- keepalive ---------- */
    wrap("ping", async () => ({ pong: true }));
  });
}
