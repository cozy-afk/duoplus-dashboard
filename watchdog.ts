/**
 * Stall watchdog. Runs in parallel with a platform session, samples the UI
 * every N seconds, and triggers recovery if the screen hasn't changed for
 * `stallMs` (default 15s) — UNLESS the session has explicitly suppressed
 * the watchdog (e.g. during a video watch, where no UI change is normal).
 *
 * On stall: calls the provided onStall handler. If recovery fails, raises
 * `StalledError` from the handler via the signal which the awaiting
 * Promise.race picks up and bubbles to the runner. The runner then reports
 * the failure and moves on to the next device.
 */

import type { DeviceDriver } from "./device-driver.ts";
import { sleep } from "./device-driver.ts";
import { unknownScreensRepo } from "./db.ts";

export class StalledError extends Error {
  constructor(public focus: string, public durationSec: number, public snapshot: string) {
    super(`stalled ${durationSec}s on screen: ${focus || "(unknown)"}`);
  }
}

export interface WatchdogLogFn {
  (level: "info" | "warn" | "error" | "ok", msg: string): void;
}

export class Watchdog {
  private lastHash = "";
  private lastChange = Date.now();
  private suppressUntil = 0;
  private running = false;
  private stalled: StalledError | null = null;
  private sampleMs = 5000;
  private onStall: ((consecutive: number) => Promise<void>) | null = null;
  private recovering = false;
  private consecutiveStalls = 0;

  constructor(
    private driver: DeviceDriver,
    private stallMs: number = 15000,
    private log: WatchdogLogFn = () => {},
  ) {}

  /** Tell the watchdog this is fine for `ms` — resets the timer and ignores samples. */
  suppress(ms: number) {
    const until = Date.now() + ms;
    if (until > this.suppressUntil) this.suppressUntil = until;
    this.lastChange = Date.now();
  }

  /** Reset the stall timer without waiting a full sample. Call after any meaningful action. */
  beat() {
    this.lastChange = Date.now();
  }

  /**
   * Register a recovery handler invoked when a stall is detected. The handler
   * receives the count of consecutive stalls (stalls with no genuine UI change
   * between them) so it can escalate — e.g., first stall taps Home tab, third
   * stall force-closes and relaunches the app. Counter resets to 0 on any
   * real UI change seen by the sample loop.
   * When a handler is set, the watchdog does NOT raise StalledError — it just
   * fires recovery and keeps running.
   */
  setOnStall(handler: (consecutive: number) => Promise<void>) {
    this.onStall = handler;
  }

  /** If the watchdog has already raised a stall, throw it; otherwise no-op. */
  throwIfStalled() {
    if (this.stalled) throw this.stalled;
  }

  /** Long-running loop: samples UI, detects stalls, sets this.stalled on trigger. */
  async start(): Promise<void> {
    this.running = true;
    this.lastChange = Date.now();
    while (this.running) {
      await sleep(this.sampleMs);
      if (!this.running) break;
      if (Date.now() < this.suppressUntil) {
        this.lastChange = Date.now();
        continue;
      }
      let xml = "";
      let focus = "";
      try {
        xml = await this.driver.dumpUi();
        focus = await this.driver
          .shell("dumpsys window windows | grep mCurrentFocus | head -1")
          .catch(() => "");
      } catch {
        continue; // transient adb hiccup — don't count as stall sample
      }
      // Hash = focus line + a length-and-edges fingerprint of the XML
      // content (with volatile pixel coordinates stripped). Using only the
      // first 400 chars missed real changes in long dumps where the prefix
      // was identical but the body differed.
      const cleaned = xml.replace(/bounds="\[\d+,\d+\]\[\d+,\d+\]"/g, "");
      const hash = `${focus}|${cleaned.length}|${cleaned.slice(0, 400)}|${cleaned.slice(-400)}`;
      if (hash !== this.lastHash) {
        this.lastHash = hash;
        this.lastChange = Date.now();
        // Real UI change observed → recovery (or the session itself) made
        // progress. Reset the escalation counter.
        this.consecutiveStalls = 0;
        continue;
      }
      const stuckFor = Date.now() - this.lastChange;
      if (stuckFor >= this.stallMs && !this.stalled && !this.recovering) {
        const focusShort = focus
          .match(/mCurrentFocus=Window\{[^ ]+ u0 ([^}]+)\}/)?.[1] ?? focus.trim().slice(0, 80);
        this.log(
          "warn",
          `⏱ STALL DETECTED — screen unchanged for ${Math.round(stuckFor / 1000)}s  focus=${focusShort}`,
        );
        try {
          unknownScreensRepo.record({
            device_id: this.driver.deviceId,
            platform: null,
            context: "watchdog-stall",
            focus,
            xml_head: xml.slice(0, 8000),
            recovered: !!this.onStall,
            recovery_action: this.onStall ? "nav-to-app-home" : "stall",
          });
        } catch {}

        if (this.onStall) {
          // Recovery mode: invoke handler with consecutive-stall count so it
          // can escalate (tap home tab → force-close + relaunch). Never fall
          // back to the device home button — that exits the app and kills
          // the warmup.
          this.consecutiveStalls++;
          this.recovering = true;
          this.log(
            "info",
            `  [watchdog] recovering (stall #${this.consecutiveStalls} in a row) — invoking handler`,
          );
          const handler = this.onStall;
          const attempt = this.consecutiveStalls;
          // Await the handler inline so the next sample tick can't fire a
          // second recovery while this one is still running. Reset the
          // stall timer ONLY after success — a failed handler shouldn't
          // mask the next stall by pretending the screen just changed.
          try {
            await handler(attempt);
            this.log("ok", `  [watchdog] recovery attempt #${attempt} done`);
            this.lastChange = Date.now();
            this.lastHash = "";
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log("warn", `  [watchdog] recovery attempt #${attempt} threw: ${msg}`);
          } finally {
            this.recovering = false;
          }
        } else {
          this.stalled = new StalledError(focusShort, Math.round(stuckFor / 1000), xml);
        }
      }
    }
  }

  stop() {
    this.running = false;
  }
}
