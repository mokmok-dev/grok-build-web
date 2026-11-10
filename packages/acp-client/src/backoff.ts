export interface BackoffOptions {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly factor: number;
  readonly jitter: number;
  readonly random: () => number;
}

export const defaultBackoff: BackoffOptions = {
  baseMs: 250,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.2,
  random: Math.random,
};

export const nextDelay = (attempt: number, options: BackoffOptions): number => {
  const exponential = options.baseMs * Math.pow(options.factor, attempt);
  const capped = Math.min(exponential, options.maxMs);
  const spread = capped * options.jitter;
  const offset = (options.random() * 2 - 1) * spread;
  return Math.round(Math.max(0, capped + offset));
};
