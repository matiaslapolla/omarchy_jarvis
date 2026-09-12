export const DEFAULT_LIMITS = {
  maxSteps: 12,
  maxDurationMs: 60000,
  maxToolCalls: 8,
  maxRetries: 2,
} as const;

export type Limits = {
  maxSteps: number;
  maxDurationMs: number;
  maxToolCalls: number;
  maxRetries: number;
};

export function assertLimits(limits: Limits = { ...DEFAULT_LIMITS }): void {
  for (const [k, v] of Object.entries(limits)) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`Invalid limit ${k}: ${v}`);
  }
}
