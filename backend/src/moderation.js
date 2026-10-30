/**
 * Moderation & safety persistence: abuse reports, ban records, admin audit.
 *
 *  - MongoDB mode (production): reports/bans/audit are durable.
 *  - Memory mode (local dev / tests): identical API, non-durable.
 *
 * Only safety metadata is ever stored: salted IP hashes, reason, short
 * optional detail, match id, timestamps. No chat content, no media, no names.
 */
import { createHash } from "crypto";
import mongoose from "mongoose";

export function hashIp(ip, salt) {
  return createHash("sha256").update(`${ip || "unknown"}|${salt}`).digest("hex");
}

function mkSchemas() {
  const Report = mongoose.model(
    "Report",
    new mongoose.Schema(
      {
        reason: { type: String, required: true, maxlength: 40 },
        details: { type: String, maxlength: 500 },
        reporterHash: { type: String, required: true, index: true },
        reportedHash: { type: String, required: true, index: true },
        matchId: String,
        status: { type: String, default: "pending", index: true }, // pending | resolved | dismissed
        adminNote: String,
        resolvedAt: Date,
      },
      { timestamps: true }
    )
  );
  const Ban = mongoose.model(
    "Ban",
    new mongoose.Schema(
      {
        ipHash: { type: String, required: true, unique: true },
        reason: String,
        reportId: String,
        createdAt: { type: Date, default: Date.now },
        expiresAt: { type: Date, required: true },
        lifted: { type: Boolean, default: false },
      },
      { timestamps: true }
    )
  );
  const Audit = mongoose.model(
    "Audit",
    new mongoose.Schema(
      {
        action: { type: String, required: true },
        targetHash: String,
        note: String,
        at: { type: Date, default: Date.now },
      },
      { timestamps: true }
    )
  );
  return { Report, Ban, Audit };
}

export function createModeration({ mongoUri, salt, log }) {
  const memory = { reports: [], bans: [], audits: [] };
  let seq = 0;
  const mid = (p) => `${p}${++seq}-${Date.now().toString(36)}`;

  /* ---------------- memory mode ---------------- */
  if (!mongoUri) {
    log.warn("MONGODB_URI not set — moderation store is in-memory (local dev only). Reports will NOT survive a restart.");
    return {
      mode: "memory",
      async init() {},
      async close() {},

      async report({ reason, details, reporterHash, reportedHash, matchId }) {
        const id = mid("r");
        const r = {
          _id: id,
          id,
          reason,
          details: details || null,
          reporterHash,
          reportedHash,
          matchId: matchId || null,
          status: "pending",
          adminNote: null,
          resolvedAt: null,
          createdAt: new Date(),
        };
        memory.reports.unshift(r);
        log.info("report stored (memory)", { id: r.id, reason });
        return r;
      },

      async isBanned(ipHash) {
        const now = new Date();
        const b = memory.bans.find((x) => x.ipHash === ipHash && !x.lifted && new Date(x.expiresAt) > now);
        return b || null;
      },

      async ban(ipHash, reason, minutes) {
        const existing = memory.bans.find((x) => x.ipHash === ipHash && !x.lifted);
        if (existing) {
          existing.expiresAt = new Date(Date.now() + minutes * 60e3);
          return existing;
        }
        const b = { _id: mid("b"), id: mid("b"), ipHash, reason, createdAt: new Date(), expiresAt: new Date(Date.now() + minutes * 60e3), lifted: false };
        memory.bans.push(b);
        return b;
      },

      async listReports(status = "pending") {
        return status ? memory.reports.filter((r) => r.status === status).slice(0, 100) : memory.reports.slice(0, 100);
      },

      async resolveReport(id, status, note) {
        const r = memory.reports.find((x) => x.id === id);
        if (!r) return null;
        r.status = status;
        r.adminNote = note || null;
        r.resolvedAt = new Date();
        return r;
      },

      async audit(action, meta = {}) {
        const a = { id: mid("a"), action, ...meta, at: new Date() };
        memory.audits.unshift(a);
        return a;
      },

      async counts() {
        const c = { pending: 0, resolved: 0, dismissed: 0, activeBans: 0 };
        for (const r of memory.reports) if (c[r.status] !== undefined) c[r.status]++;
        const now = new Date();
        c.activeBans = memory.bans.filter((b) => !b.lifted && new Date(b.expiresAt) > now).length;
        return c;
      },
    };
  }

  /* ---------------- mongodb mode ---------------- */
  let Report, Ban, Audit;
  return {
    mode: "mongo",
    async init() {
      mongoose.connection.on("disconnected", () => log.warn("mongo disconnected — attempting automatic re-connect"));
      mongoose.connection.on("reconnected", () => log.info("mongo reconnected"));
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 });
      const s = mkSchemas();
      Report = s.Report;
      Ban = s.Ban;
      Audit = s.Audit;
      log.info("mongodb connected", { db: mongoose.connection.name });
    },
    async close() {
      await mongoose.disconnect();
    },

    async report({ reason, details, reporterHash, reportedHash, matchId }) {
      const r = await Report.create({
        reason,
        details: details || undefined,
        reporterHash,
        reportedHash,
        matchId: matchId || undefined,
        status: "pending",
      });
      log.info("report stored (mongo)", { id: String(r._id), reason });
      return r;
    },

    async isBanned(ipHash) {
      const now = new Date();
      return Ban.findOne({ ipHash, lifted: false, expiresAt: { $gt: now } });
    },

    async ban(ipHash, reason, minutes) {
      const expiresAt = new Date(Date.now() + minutes * 60e3);
      const existing = await Ban.findOne({ ipHash, lifted: false });
      if (existing) {
        existing.expiresAt = expiresAt;
        existing.reason = reason;
        await existing.save();
        return existing;
      }
      return Ban.create({ ipHash, reason, expiresAt });
    },

    async listReports(status = "pending") {
      const q = status ? { status } : {};
      return Report.find(q).sort({ createdAt: -1 }).limit(100);
    },

    async resolveReport(id, status, note) {
      return Report.findByIdAndUpdate(
        id,
        { status, adminNote: note || undefined, resolvedAt: new Date() },
        { new: true }
      );
    },

    async audit(action, meta = {}) {
      return Audit.create({ action, targetHash: meta.targetHash, note: meta.note });
    },

    async counts() {
      const now = new Date();
      const [pending, resolved, dismissed, activeBans] = await Promise.all([
        Report.countDocuments({ status: "pending" }),
        Report.countDocuments({ status: "resolved" }),
        Report.countDocuments({ status: "dismissed" }),
        Ban.countDocuments({ lifted: false, expiresAt: { $gt: now } }),
      ]);
      return { pending, resolved, dismissed, activeBans };
    },
  };
}
