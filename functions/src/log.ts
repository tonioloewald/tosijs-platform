/**
 * The logger port (SOVEREIGN-PLAN.md Phase 1).
 *
 * Kernel code logs through `log`; where the lines go is the host's choice. The
 * default is `console`, which is what a single-box host and the tests want. The
 * deployed functions install Cloud Logging's structured logger at startup
 * (`index.ts`, via `adapters/firebase/logger.ts`), so nothing changes there.
 *
 * `log` forwards on every call rather than holding the sink, so a module that
 * captured it at import time still logs to the sink installed afterwards.
 */
export interface Logger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

let sink: Logger = console

export const setLogSink = (logger: Logger): void => {
  sink = logger
}

export const log: Logger = {
  info: (...args) => sink.info(...args),
  warn: (...args) => sink.warn(...args),
  error: (...args) => sink.error(...args),
}
