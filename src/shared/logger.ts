export type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function threshold(): Level {
  const v = (process.env.LIFELINE_LOG ?? "info").toLowerCase();
  return (["debug", "info", "warn", "error"] as Level[]).includes(v as Level) ? (v as Level) : "info";
}

export function makeLogger(scope: string) {
  const min = order[threshold()];
  function emit(level: Level, msg: string, extra?: unknown) {
    if (order[level] < min) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(extra === undefined ? line + "\n" : `${line} ${safe(extra)}\n`);
  }
  return {
    debug: (m: string, e?: unknown) => emit("debug", m, e),
    info: (m: string, e?: unknown) => emit("info", m, e),
    warn: (m: string, e?: unknown) => emit("warn", m, e),
    error: (m: string, e?: unknown) => emit("error", m, e),
  };
}

function safe(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
