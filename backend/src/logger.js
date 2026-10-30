/** Minimal structured JSON logger (no dependencies). */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = "info") {
  const min = LEVELS[level] || LEVELS.info;
  const write = (lvl, msg, meta) => {
    if (LEVELS[lvl] < min) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      lvl,
      msg,
      ...(meta && typeof meta === "object" ? meta : meta ? { meta } : {}),
    });
    if (lvl === "error") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    debug: (msg, meta) => write("debug", msg, meta),
    info: (msg, meta) => write("info", msg, meta),
    warn: (msg, meta) => write("warn", msg, meta),
    error: (msg, meta) => write("error", msg, meta),
  };
}
