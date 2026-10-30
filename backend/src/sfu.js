/**
 * SFU signaling relay for private rooms.
 *
 * Scope: this module ONLY carries the WebRTC control-plane (SDP offers,
 * SDP answers, ICE candidates) between authorized members of a private
 * room. It does NOT carry any audio or video bytes — those flow directly
 * between the participants' browsers via STUN/TURN.
 *
 * Why a relay at all?
 *   For 5 participants, a true SFU (e.g. mediasoup, LiveKit) is the
 *   production-grade choice. We don't ship one here because doing so
 *   would require an additional C++ build + a separate service to deploy.
 *   Instead, this server:
 *     - authorizes every signaling message against room membership,
 *     - forwards offers/answers/ice between members,
 *     - emits a "peer-joined" event so existing participants renegotiate
 *       with the new member.
 *
 *   This works for 2-person rooms without any change (the existing
 *   random-video flow already does this directly through Socket.IO).
 *   For 3–5 members, the client does a "full mesh" — every member
 *   sends an offer to every other member, which costs O(N²) connections
 *   per client. For N=5 that's 4 peer connections per client, which is
 *   acceptable on modern networks.
 *
 * Upgrade path:
 *   When traffic warrants, replace this file with a real SFU:
 *     1. Run a LiveKit / mediasoup process alongside the Node backend.
 *     2. The server mints short-lived JWTs for each approved member
 *        (using a signing key from the SFU, not the frontend) and
 *        returns them via the "room:join-token" event.
 *     3. The client connects directly to the SFU; the Node backend
 *        stops relaying SDP/ICE entirely. Application events (chat,
 *        host controls) continue to flow through this Socket.IO server.
 *
 * Threat model (server-enforced):
 *   - Every event carries a `roomId` and `to` (or `to:null` for fan-out).
 *   - Membership is looked up server-side; forged events are dropped.
 *   - ICE/SDP payloads are size-capped.
 */
import { randomBytes } from "crypto";

const SDP_MAX = 64 * 1024;     // 64 KB per SDP payload
const ICE_MAX = 4 * 1024;      // 4 KB per ICE candidate
const ROOM_NAMESPACE_PREFIX = "room:"; // Socket.IO room name = "room:<code>"

export function attachSFU({ io, rooms, log, cfg }) {
  // ----- Authorization cache: socketId -> { roomId, isHost } -----
  // We mirror the room membership on the server side so a single lookup
  // tells us whether a socket is in a room and what role it has.
  const sessionBySocket = new Map();
  const sessionByRoom = new Map(); // roomId -> Set<socketId>

  function joinSession(socketId, roomId, isHost) {
    sessionBySocket.set(socketId, { roomId, isHost });
    if (!sessionByRoom.has(roomId)) sessionByRoom.set(roomId, new Set());
    sessionByRoom.get(roomId).add(socketId);
  }
  function leaveSession(socketId) {
    const s = sessionBySocket.get(socketId);
    if (!s) return null;
    sessionBySocket.delete(socketId);
    sessionByRoom.get(s.roomId)?.delete(socketId);
    return s;
  }
  function getSession(socketId) {
    return sessionBySocket.get(socketId) || null;
  }
  function roomMembers(roomId) {
    return [...(sessionByRoom.get(roomId) || [])];
  }

  // ----- Join a private room (Socket.IO) -----
  // Called from socket.js after the room manager has authorized the socket
  // (i.e. the host created the room, or the request was accepted).
  io.on("connection", (socket) => {
    socket.on("room:join", async ({ roomId, isHost }, ack) => {
      try {
        const m = await (cfg.storeRef ? cfg.storeRef() : null)?.roomGetMembers?.(roomId);
        if (!m) return ack?.({ ok: false, error: "not-found" });
        if (isHost && m.host !== socket.id) return ack?.({ ok: false, error: "not-host" });
        if (!isHost && !m.members.has(socket.id)) {
          return ack?.({ ok: false, error: "not-a-member" });
        }
        // Add to the per-room namespace so signaling is scoped.
        socket.join(ROOM_NAMESPACE_PREFIX + roomId);
        joinSession(socket.id, roomId, isHost);
        // Tell the joiner who else is in the room.
        const others = [];
        for (const [sid, entry] of m.members) {
          if (sid === socket.id) continue;
          others.push({ socketId: sid, username: entry.username, isHost: !!entry.isHost });
        }
        // Tell the others about the new joiner.
        socket.to(ROOM_NAMESPACE_PREFIX + roomId).emit("room:peer-joined", {
          roomId,
          socketId: socket.id,
          username: socket.data?.username || null,
          isHost,
        });
        ack?.({ ok: true, self: { socketId: socket.id, isHost }, others, host: m.host });
      } catch (e) {
        log.warn("room:join failed", { err: e.message });
        ack?.({ ok: false, error: "internal" });
      }
    });

    // ----- Signaling relay (mesh) -----
    socket.on("webrtc:offer", ({ to, sdp, roomId }, ack) => {
      const s = getSession(socket.id);
      if (!s || s.roomId !== roomId) return ack?.({ ok: false, error: "not-in-room" });
      if (typeof sdp !== "string" || sdp.length === 0 || sdp.length > SDP_MAX) {
        return ack?.({ ok: false, error: "bad-sdp" });
      }
      const peer = (sessionByRoom.get(roomId) || new Set()).has(to);
      if (!peer) return ack?.({ ok: false, error: "peer-not-in-room" });
      io.to(to).emit("webrtc:offer", { from: socket.id, roomId, sdp });
      ack?.({ ok: true });
    });
    socket.on("webrtc:answer", ({ to, sdp, roomId }, ack) => {
      const s = getSession(socket.id);
      if (!s || s.roomId !== roomId) return ack?.({ ok: false, error: "not-in-room" });
      if (typeof sdp !== "string" || sdp.length === 0 || sdp.length > SDP_MAX) {
        return ack?.({ ok: false, error: "bad-sdp" });
      }
      const peer = (sessionByRoom.get(roomId) || new Set()).has(to);
      if (!peer) return ack?.({ ok: false, error: "peer-not-in-room" });
      io.to(to).emit("webrtc:answer", { from: socket.id, roomId, sdp });
      ack?.({ ok: true });
    });
    socket.on("webrtc:ice", ({ to, candidate, roomId }, ack) => {
      const s = getSession(socket.id);
      if (!s || s.roomId !== roomId) return ack?.({ ok: false, error: "not-in-room" });
      if (!candidate || typeof candidate !== "object" || JSON.stringify(candidate).length > ICE_MAX) {
        return ack?.({ ok: false, error: "bad-ice" });
      }
      const peer = (sessionByRoom.get(roomId) || new Set()).has(to);
      if (!peer) return ack?.({ ok: false, error: "peer-not-in-room" });
      io.to(to).emit("webrtc:ice", { from: socket.id, roomId, candidate });
      ack?.({ ok: true });
    });

    // ----- In-room chat -----
    socket.on("room:chat", ({ roomId, text }, ack) => {
      const s = getSession(socket.id);
      if (!s || s.roomId !== roomId) return ack?.({ ok: false, error: "not-in-room" });
      const t = String(text || "").trim();
      if (!t || t.length > 500) return ack?.({ ok: false, error: "bad-message" });
      const username = socket.data?.username || "anon";
      io.to(ROOM_NAMESPACE_PREFIX + roomId).emit("room:chat", {
        from: socket.id,
        username,
        text: t,
        ts: Date.now(),
      });
      ack?.({ ok: true });
    });

    // ----- Status: mic / cam toggles (broadcast to peers) -----
    socket.on("room:status", ({ roomId, mic, cam }, ack) => {
      const s = getSession(socket.id);
      if (!s || s.roomId !== roomId) return ack?.({ ok: false, error: "not-in-room" });
      socket.to(ROOM_NAMESPACE_PREFIX + roomId).emit("room:status", {
        from: socket.id,
        mic: !!mic,
        cam: !!cam,
        ts: Date.now(),
      });
      ack?.({ ok: true });
    });

    // ----- Explicit leave (also called automatically on disconnect) -----
    socket.on("room:leave", (_, ack) => {
      const s = leaveSession(socket.id);
      if (s) {
        socket.leave(ROOM_NAMESPACE_PREFIX + s.roomId);
        socket.to(ROOM_NAMESPACE_PREFIX + s.roomId).emit("room:peer-left", {
          roomId: s.roomId,
          socketId: socket.id,
        });
      }
      ack?.({ ok: true });
    });

    // ----- Disconnect: clear the signaling session -----
    socket.on("disconnect", () => {
      const s = leaveSession(socket.id);
      if (s) socket.to(ROOM_NAMESPACE_PREFIX + s.roomId).emit("room:peer-left", {
        roomId: s.roomId,
        socketId: socket.id,
        reason: "disconnected",
      });
    });
  });

  // ----- Helpers used by the room manager when membership changes -----
  function broadcastPeers(roomId, host, members) {
    io.to(ROOM_NAMESPACE_PREFIX + roomId).emit("room:peers", {
      roomId,
      host,
      members: [...members.entries()].map(([sid, e]) => ({
        socketId: sid,
        username: e.username,
        isHost: !!e.isHost,
      })),
    });
  }
  function announceLeave(roomId, socketId, reason) {
    io.to(ROOM_NAMESPACE_PREFIX + roomId).emit("room:peer-left", {
      roomId,
      socketId,
      reason,
    });
  }
  function announceClosed(roomId, reason) {
    io.to(ROOM_NAMESPACE_PREFIX + roomId).emit("room:closed", { roomId, reason });
  }

  return { broadcastPeers, announceLeave, announceClosed, getSession, roomMembers, ROOM_NAMESPACE_PREFIX };
}

// (Normalization helpers live in rooms.js; tests import them from there.)
