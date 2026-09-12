const SECRET_PATTERN = /key|token|secret|password/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_PATTERN.test(k) ? "[REDACTED]" : redact(v),
      ]),
    );
  }
  return value;
}

export function newTraceId(): string {
  return globalThis.crypto.randomUUID();
}

export type LogFn = (event: string, data?: Record<string, unknown>) => void;

export function createLogger(traceId: string): { info: LogFn; warn: LogFn; error: LogFn } {
  const write = (level: string, event: string, data: Record<string, unknown> = {}) => {
    console.log(JSON.stringify({ traceId, level, event, ...redact(data) as Record<string, unknown> }));
  };
  return {
    info: (event, data) => write("info", event, data),
    warn: (event, data) => write("warn", event, data),
    error: (event, data) => write("error", event, data),
  };
}

export async function measure<T>(name: string, fn: () => T | Promise<T>): Promise<{ value: T; durationMs: number }> {
  const start = Date.now();
  const value = await fn();
  const durationMs = Date.now() - start;
  inc(`span.${name}.count`);
  return { value, durationMs };
}

const counters = new Map<string, number>();

export function inc(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function snapshot(): Record<string, number> {
  return Object.fromEntries(counters);
}
