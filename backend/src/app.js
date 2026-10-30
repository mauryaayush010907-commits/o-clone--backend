/** Express application factory (kept separate from server bootstrap for tests). */
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { apiRoutes } from "./routes.js";

export function createApp({ cfg, store, moderation, log }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // allow same-origin (no Origin header) + explicitly configured origins
        if (!origin || cfg.frontendUrls.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS blocked origin: ${origin}`));
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: "64kb" }));

  // blanket API rate limit (per IP)
  app.use(
    "/api",
    rateLimit({
      windowMs: 15 * 60e3,
      limit: 600,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.path === "/api/health",
    })
  );

  app.use("/api", apiRoutes({ cfg, store, moderation, log }));

  // 404 + JSON errors for non-API paths
  app.use((req, res) => {
    if (req.path.startsWith("/api")) return res.status(404).json({ ok: false, error: "not-found" });
    res.status(404).type("text/plain").send("drift-backend: API only. See /api/health.");
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err && err.message && err.message.startsWith("CORS blocked")) {
      return res.status(403).json({ ok: false, error: "cors" });
    }
    log.error("request error", { err: err?.message, path: req.path });
    res.status(500).json({ ok: false, error: "internal error" });
  });

  return app;
}
