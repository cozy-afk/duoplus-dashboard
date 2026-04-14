/**
 * Structured logger.
 *
 * Backwards-compatible with the existing `LogFn` shape — every old call site
 * `log("info", "message")` keeps working unchanged. New code paths should
 * call `log.event(code, ctx, msg, json?)` to emit a structured record that
 * also lands in the `event_logs` table for queryable triage.
 *
 * Why a wrapper instead of replacing LogFn:
 *   - There are ~120 existing call sites; touching all of them in one PR is
 *     a recipe for regressions.
 *   - Some logs (per-run progress lines) shouldn't go to event_logs at all —
 *     they belong in batch_run_logs, which the existing LogFn already feeds.
 *   - Forwarding to the underlying LogFn means stdout output stays identical
 *     so existing operator muscle memory keeps working.
 *
 * Code taxonomy (use a stable code per event so the UI can filter):
 *   stall.detected, stall.recovered, stall.gave-up
 *   nav.failed, nav.recovered
 *   account.flagged, account.suspended, account.verify-required
 *   login.started, login.success, login.failed
 *   pool.claimed, pool.assigned, pool.empty
 *   switcher.opened, switcher.tapped, switcher.failed
 *   warmup.started, warmup.completed, warmup.skipped
 *   device.online, device.offline, device.power-fail
 *
 * Codes are dotted lowercase. Keep them short and stable — UIs/dashboards
 * will hard-code them.
 */

import { eventLogsRepo } from "./db.ts";

export type Level = "debug" | "info" | "warn" | "error" | "ok";

/** Per-call context that auto-attaches to every event from this logger. */
export interface LogContext {
  run_id?: string | null;
  device_id?: string | null;
  platform?: string | null;
  username?: string | null;
  account_id?: number | null;
  phase?: string | null;
  attempt?: number | null;
}

/**
 * Underlying sink — writes to stdout (via the original LogFn) and optionally
 * persists to batch_run_logs. Matches the existing call signature exactly.
 */
export type SinkFn = (level: Level, msg: string) => void;

export interface StructuredLogger {
  /** Legacy call: forwards to sink, no DB write. */
  (level: Level, msg: string): void;
  /**
   * Structured event: forwards a human-readable line to sink AND persists a
   * row to event_logs. `code` is required and should come from the taxonomy.
   * `json` is any extra context (e.g. error details, switcher candidates).
   */
  event(level: Level, code: string, msg: string, json?: unknown): void;
  /**
   * Same as event() but also captures Error.stack on level==="error". Use
   * this in catch blocks so the stack survives in DB instead of being
   * truncated to e.message in stdout.
   */
  fail(code: string, msg: string, err: unknown, json?: unknown): void;
  /** Return a child logger with merged context. Cheap — just a new closure. */
  child(extraCtx: LogContext): StructuredLogger;
  /** Inspect the current context — useful for tests / introspection. */
  ctx: Readonly<LogContext>;
}

/** Render a context into a compact human-readable suffix for stdout. */
function renderCtx(ctx: LogContext): string {
  const parts: string[] = [];
  if (ctx.device_id) parts.push(`dev=${ctx.device_id}`);
  if (ctx.platform) parts.push(ctx.platform);
  if (ctx.username) parts.push(`@${ctx.username}`);
  if (ctx.phase) parts.push(`phase=${ctx.phase}`);
  if (ctx.attempt != null) parts.push(`att=${ctx.attempt}`);
  return parts.length ? ` [${parts.join(" ")}]` : "";
}

function errToStack(err: unknown): { msg: string; stack: string | null } {
  if (err instanceof Error) {
    return { msg: err.message, stack: err.stack ?? null };
  }
  return { msg: String(err), stack: null };
}

/**
 * Create a structured logger. `sink` is the original `(level, msg) => void`
 * shape — typically the LogFn the caller already has from runner.ts /
 * server.ts. The returned object is itself callable as `(level, msg)` so it
 * can be passed as `LogFn` to anything that doesn't yet know about events.
 */
export function makeLogger(sink: SinkFn, baseCtx: LogContext = {}): StructuredLogger {
  const ctx: LogContext = { ...baseCtx };

  const fn = ((level: Level, msg: string) => {
    sink(level === "debug" ? "info" : level, msg);
  }) as StructuredLogger;

  fn.ctx = ctx;

  fn.event = (level, code, msg, json) => {
    const suffix = renderCtx(ctx);
    sink(level === "debug" ? "info" : level, `${msg}${suffix} <${code}>`);
    // Best-effort persist; never throw out of a log call.
    eventLogsRepo
      .record({
        level,
        code,
        msg,
        run_id: ctx.run_id ?? null,
        device_id: ctx.device_id ?? null,
        platform: ctx.platform ?? null,
        username: ctx.username ?? null,
        account_id: ctx.account_id ?? null,
        phase: ctx.phase ?? null,
        attempt: ctx.attempt ?? null,
        json,
      })
      .catch(() => { /* swallow — logging must never break the caller */ });
  };

  fn.fail = (code, msg, err, json) => {
    const { msg: errMsg, stack } = errToStack(err);
    const fullMsg = `${msg}: ${errMsg}`;
    const suffix = renderCtx(ctx);
    sink("error", `${fullMsg}${suffix} <${code}>`);
    eventLogsRepo
      .record({
        level: "error",
        code,
        msg: fullMsg,
        run_id: ctx.run_id ?? null,
        device_id: ctx.device_id ?? null,
        platform: ctx.platform ?? null,
        username: ctx.username ?? null,
        account_id: ctx.account_id ?? null,
        phase: ctx.phase ?? null,
        attempt: ctx.attempt ?? null,
        json,
        stack,
      })
      .catch(() => { /* swallow */ });
  };

  fn.child = (extraCtx) => makeLogger(sink, { ...ctx, ...extraCtx });

  return fn;
}

/**
 * Convenience for adapting a StructuredLogger back into a plain LogFn the way
 * older modules expect it. Identity, since StructuredLogger IS callable as
 * (level, msg).
 */
export function asPlainLogFn(log: StructuredLogger): SinkFn {
  return log;
}
