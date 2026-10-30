/** Centralized, typed-ish configuration. Every value has a sane default for local dev. */
export function loadConfig(env = process.env) {
  const list = (v, dflt = []) =>
    (v || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .concat(dflt);

  const cfg = {
    env: env.NODE_ENV || "development",
    port: parseInt(env.PORT || "10000", 10),
    host: env.HOST || "0.0.0.0",
    frontendUrls: list(env.FRONTEND_URL, ["http://localhost:5173", "http://localhost:4173"]),
    redisUrl: env.REDIS_URL || "",
    mongoUri: env.MONGODB_URI || "",

    stunUrls: list(env.STUN_URLS, ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]),
    turnUrl: (env.TURN_URL || "").trim(),
    turnUsername: (env.TURN_USERNAME || "").trim(),
    turnPassword: (env.TURN_PASSWORD || "").trim(),
    turnUseConfig: env.TURN_USE_CONFIG === "true",
    turnStaticSecret: (env.TURN_STATIC_SECRET || "").trim(),
    turnInstance: (env.TURN_INSTANCE || "drift").trim(),

    hashSalt: env.HASH_SALT || "dev-salt-do-not-use-in-prod",
    adminApiKey: (env.ADMIN_API_KEY || "").trim(),

    findCooldownMs: parseInt(env.MATCH_FIND_COOLDOWN_MS || "1500", 10),
    sessionTtlMs: parseInt(env.SESSION_TTL_MS || "600000", 10),
    queueMaxAgeMs: parseInt(env.QUEUE_MAX_AGE_MS || "120000", 10),
    prefsPatienceMs: parseInt(env.PREFS_PATIENCE_MS || "25000", 10),
    maxMessageLength: parseInt(env.MAX_MESSAGE_LENGTH || "500", 10),
    chatsPerWindow: parseInt(env.CHATS_PER_2S || "6", 10),

    isProd: (env.NODE_ENV || "development") === "production",
  };

  if (cfg.isProd) {
    const problems = [];
    if (!cfg.redisUrl) problems.push("REDIS_URL");
    if (!cfg.mongoUri) problems.push("MONGODB_URI");
    if (cfg.frontendUrls.includes("*") || !cfg.frontendUrls.length) problems.push("FRONTEND_URL");
    // In production, the localhost defaults are dangerous: an attacker who can
    // make a browser request with a localhost Origin (e.g. via a malicious
    // extension, a leaked tunnel, or a same-network setup) would bypass CORS.
    // Require an explicit non-localhost origin in production.
    if (cfg.frontendUrls.every((u) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(u))) {
      problems.push("FRONTEND_URL (must be a non-localhost origin in production, e.g. https://my-app.vercel.app)");
    }
    if (problems.length) {
      throw new Error(`Refusing to start in production without: ${problems.join(", ")}`);
    }
  }
  return cfg;
}
