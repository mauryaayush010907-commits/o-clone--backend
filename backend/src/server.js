/**
 * Drift backend entrypoint.
 * Wires: config → logger → state store → moderation → express app → http server
 * → Socket.IO (with Redis adapter for multi-instance) → graceful shutdown.
 */
import "dotenv/config";
import http from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "socket.io-redis-adapter";

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createStore } from "./store.js";
import { createModeration } from "./moderation.js";
import { createMatchmaker } from "./matchmaker.js";
import { attachSockets } from "./socket.js";
import { createRoomManager } from "./rooms.js";
import { attachSFU } from "./sfu.js";
import { createApp } from "./app.js";

const cfg = loadConfig();
const log = createLogger(cfg.isProd ? "info" : "debug");
const instanceId = `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function main() {
  log.info("starting drift-backend", { instance: instanceId, env: cfg.env, port: cfg.port });

  const store = createStore({ redisUrl: cfg.redisUrl, log });
  await store.init();

  const moderation = createModeration({ mongoUri: cfg.mongoUri, salt: cfg.hashSalt, log });
  await moderation.init();

  const app = createApp({ cfg, store, moderation, log });
  const server = http.createServer(app);

  const io = new SocketIOServer(server, {
    cors: {
      origin: (origin, cb) => {
        if (!origin || cfg.frontendUrls.includes(origin)) return cb(null, true);
        return cb(new Error("CORS blocked"));
      },
      credentials: true,
    },
    pingTimeout: 20000,
    pingInterval: 25000,
    maxHttpBufferSize: 128e3, // 128kb — SDP payloads fit well under this
  });

  // Multi-instance: broadcast socket events across instances via Redis.
  if (store.mode === "redis") {
    const [pub, sub] = [store.redis.duplicate(), store.redis.duplicate()];
    io.adapter(createAdapter(pub, sub));
    log.info("socket.io redis adapter attached — horizontal scaling enabled");
  }

  const matchmaker = createMatchmaker({ store, io, log, cfg });

  // Private-room subsystem (host-approved, code-gated, max 5 participants).
  // Created BEFORE attachSockets so the connection handler can wire private
  // event handlers into the same socket layer.
  const rooms = createRoomManager({ store, io, log, cfg });
  cfg.storeRef = () => store;
  const sfu = attachSFU({ io, rooms, log, cfg });

  attachSockets(io, { matchmaker, moderation, store, cfg, log, rooms, sfu });

  server.listen(cfg.port, cfg.host, () => {
    log.info("listening", {
      url: `http://${cfg.host}:${cfg.port}`,
      state: store.mode,
      moderation: moderation.mode,
      turn: cfg.turnUrl ? "configured" : "STUN-only (set TURN_URL for NAT-traversal safety)",
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn("shutdown signal received", { signal });
    try {
      io.close();
      await new Promise((res) => server.close(res));
      matchmaker.close();
      await store.close();
      await moderation.close();
      log.info("clean shutdown complete");
      process.exit(0);
    } catch (e) {
      log.error("shutdown error", { err: e.message });
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("fatal startup error:", e);
  process.exit(1);
});
