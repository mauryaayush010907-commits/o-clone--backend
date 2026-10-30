/** HTTP API: health, live stats, ICE servers, abuse reports, admin review. */
import { createHmac } from "crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { hashIp } from "./moderation.js";
import { COUNTRIES, GENDER_VALUES, LANGUAGES } from "./prefs.js";

/**
 * Short-lived TURN credentials (Coturn temp-auth / REST API style):
 * username = "<expiry-epoch>:<instance>", credential = HMAC-SHA1(secret, username).
 * Only enabled when TURN_USE_CONFIG=true and a static secret is configured.
 */
export function buildIceServers(cfg) {
  const servers = [{ urls: [...cfg.stunUrls] }];
  if (cfg.turnUrl) {
    const urls = [cfg.turnUrl];
    if (cfg.turnUrl.startsWith("turn:")) urls.push(`${cfg.turnUrl}?transport=tcp`);
    const entry = { urls };
    if (cfg.turnUseConfig && cfg.turnStaticSecret) {
      const expiry = Math.floor((Date.now() + 3600e3) / 1000);
      const username = `${expiry}:${cfg.turnInstance}`;
      const credential = createHmac("sha1", cfg.turnStaticSecret).update(username).digest("hex");
      entry.username = username;
      entry.credential = credential;
      entry.ttlSeconds = 3600;
    } else if (cfg.turnUsername && cfg.turnPassword) {
      entry.username = cfg.turnUsername;
      entry.credential = cfg.turnPassword;
    }
    servers.push(entry);
  }
  return servers;
}

export function apiRoutes({ cfg, store, moderation, log }) {
  const r = Router();

  r.get("/health", async (_req, res) => {
    res.json({
      ok: true,
      service: "drift-backend",
      version: "1.0.0",
      uptimeSec: Math.round(process.uptime()),
      stores: { state: store.mode, moderation: moderation.mode },
    });
  });

  r.get("/stats", async (_req, res) => {
    const [online, videoQ, textQ, matches] = await Promise.all([
      store.counterGet("online"),
      store.queueLength("video"),
      store.queueLength("text"),
      store.matchCount(),
    ]);
    res.json({ ok: true, online, waiting: { video: videoQ, text: textQ }, activeMatches: matches, uptimeSec: Math.round(process.uptime()) });
  });

  r.get("/ice-servers", (_req, res) => {
    res.json({ ok: true, iceServers: buildIceServers(cfg) });
  });

  /** Single source of truth for the optional filter vocabulary. */
  r.get("/meta", (_req, res) => {
    res.json({
      ok: true,
      countries: COUNTRIES,
      languages: LANGUAGES,
      genders: GENDER_VALUES,
    });
  });

  /* ---------- public abuse reporting (also usable without an active match) ---------- */
  r.post(
    "/reports",
    rateLimit({ windowMs: 60e3, limit: 5, standardHeaders: true, legacyHeaders: false }),
    async (req, res) => {
      const ip = req.ip || "unknown";
      const { reason, details } = req.body || {};
      if (typeof reason !== "string" || reason.length < 2 || reason.length > 40) {
        return res.status(400).json({ ok: false, error: "reason must be 2..40 characters" });
      }
      if (details !== undefined && (typeof details !== "string" || details.length > 500)) {
        return res.status(400).json({ ok: false, error: "details must be a string <= 500 characters" });
      }
      const iph = hashIp(ip, cfg.hashSalt);
      const report = await moderation.report({
        reason: reason.trim(),
        details: typeof details === "string" ? details.trim() : "",
        reporterHash: iph,
        reportedHash: iph, // without a match, reporter and reported are the same client
      });
      res.status(201).json({ ok: true, id: String(report._id || report.id) });
    }
  );

  /* ---------- admin moderation API ---------- */
  const adminAuth = (req, res, next) => {
    if (!cfg.adminApiKey) return res.status(503).json({ ok: false, error: "admin API disabled (ADMIN_API_KEY not set)" });
    if (req.header("x-admin-key") !== cfg.adminApiKey) return res.status(401).json({ ok: false, error: "unauthorized" });
    next();
  };
  const admin = Router();
  admin.use(adminAuth);

  admin.get("/reports", async (req, res) => {
    const status = req.query.status === "resolved" || req.query.status === "dismissed" || req.query.status === "pending" ? req.query.status : "pending";
    const reports = await moderation.listReports(status);
    res.json({ ok: true, status, count: reports.length, reports });
  });

  admin.post("/reports/:id", async (req, res) => {
    const { status, note, banMinutes } = req.body || {};
    if (!["resolved", "dismissed"].includes(status)) return res.status(400).json({ ok: false, error: "status must be 'resolved' or 'dismissed'" });
    const report = await moderation.resolveReport(req.params.id, status, note);
    if (!report) return res.status(404).json({ ok: false, error: "report not found" });
    if (status === "resolved" && banMinutes && Number(banMinutes) > 0 && report.reportedHash) {
      const ban = await moderation.ban(report.reportedHash, req.params.id, Math.min(Number(banMinutes), 30 * 24 * 60));
      await moderation.audit("ban", { targetHash: report.reportedHash, note: `report ${req.params.id}; ${banMinutes}min` });
      res.json({ ok: true, report, ban: { id: String(ban._id || ban.id), expiresAt: ban.expiresAt } });
    } else {
      await moderation.audit(`report-${status}`, { note: `report ${req.params.id}${note ? "; " + note : ""}` });
      res.json({ ok: true, report });
    }
  });

  admin.post("/ban", async (req, res) => {
    const { hash, reason, minutes } = req.body || {};
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return res.status(400).json({ ok: false, error: "hash must be a 64-char sha256 hex" });
    const mins = Math.min(Math.max(parseInt(minutes || "60", 10), 5), 30 * 24 * 60);
    const ban = await moderation.ban(hash, typeof reason === "string" ? reason.slice(0, 200) : "policy", mins);
    await moderation.audit("ban-manual", { targetHash: hash, note: `${mins}min` });
    res.status(201).json({ ok: true, ban: { id: String(ban._id || ban.id), expiresAt: ban.expiresAt } });
  });

  admin.get("/stats", async (_req, res) => {
    res.json({ ok: true, ...(await moderation.counts()) });
  });

  r.use("/admin", admin);

  r.use((_req, res) => res.status(404).json({ ok: false, error: "not-found" }));

  // Central error handler — never leak stack traces to clients.
  // eslint-disable-next-line no-unused-vars
  r.use((err, _req, res, _next) => {
    log.error("api error", { err: err.message });
    res.status(500).json({ ok: false, error: "internal error" });
  });

  return r;
}
