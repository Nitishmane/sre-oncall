type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured single-line JSON logs. Values are never interpolated into a
 * message string, so alert text can't smuggle newlines into the log stream.
 */
export function createLogger(level: Level) {
  const threshold = order[level];
  function emit(at: Level, message: string, fields: Record<string, unknown>) {
    if (order[at] < threshold) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: at, message, ...fields });
    if (at === "error" || at === "warn") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
  return {
    debug: (message: string, fields: Record<string, unknown> = {}) => emit("debug", message, fields),
    info: (message: string, fields: Record<string, unknown> = {}) => emit("info", message, fields),
    warn: (message: string, fields: Record<string, unknown> = {}) => emit("warn", message, fields),
    error: (message: string, fields: Record<string, unknown> = {}) => emit("error", message, fields),
  };
}

export type Logger = ReturnType<typeof createLogger>;
