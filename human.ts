/**
 * Human-behavior primitives shared by all platform automations.
 *
 * Nothing in here is IG/Threads/TikTok-specific. Any future automation
 * (YouTube, Snap, X) can use the same Ctx shape + dwell/humanIdle/etc.
 *
 * The central idea is that a warmup session is a sequence of intentional
 * pauses — reading a post, watching a video, glancing at notifications —
 * interleaved with bursts of action. These helpers capture the pause
 * patterns in a way that the watchdog understands (so intentional stillness
 * isn't mistaken for a stall).
 */

import type { DeviceDriver, LogFn } from "./device-driver.ts";
import { sleep, randint, roll } from "./device-driver.ts";
import type { Watchdog } from "./watchdog.ts";
import type { Quota } from "./db.ts";

export type { LogFn } from "./device-driver.ts";

/** The running session stats object. */
export interface SessionStats {
  platform: "instagram" | "threads" | "tiktok";
  app_launches: number;
  feed_scrolls: number;
  reels_watched: number;
  stories_viewed: number;
  likes_given: number;
  comments_read: number;
  profile_visits: number;
  hashtag_searches: number;
  saves: number;
  explore_scrolls: number;
  tab_switches: number;
  own_profile_views: number;
  unmutes: number;
  errors: number;
  hit_deadline: boolean;
}

export function newStats(platform: SessionStats["platform"]): SessionStats {
  return {
    platform,
    app_launches: 0,
    feed_scrolls: 0,
    reels_watched: 0,
    stories_viewed: 0,
    likes_given: 0,
    comments_read: 0,
    profile_visits: 0,
    hashtag_searches: 0,
    saves: 0,
    explore_scrolls: 0,
    tab_switches: 0,
    own_profile_views: 0,
    unmutes: 0,
    errors: 0,
    hit_deadline: false,
  };
}

/** Shared execution context for every platform automation. */
export interface Ctx {
  driver: DeviceDriver;
  quota: Quota;
  log: LogFn;
  stats: SessionStats;
  /** Epoch ms after which the session must stop taking new actions. */
  deadline: number;
  /** Watchdog for stall detection / recovery. Optional for non-warmup flows. */
  watchdog?: Watchdog;
}

/** Credentials passed into a platform's login flow. Shared across IG/Threads. */
export interface LoginCreds {
  platform: "instagram" | "threads" | "tiktok";
  username: string;
  password: string;
  totp_secret?: string | null;
}

export const timeLeft = (c: Ctx) => Math.max(0, c.deadline - Date.now());
export const expired = (c: Ctx) => timeLeft(c) <= 0;

/** Safely run `fn`, bump stats.errors on failure, never throw. */
export async function safe(c: Ctx, name: string, fn: () => Promise<void>): Promise<void> {
  if (expired(c)) return;
  try {
    await fn();
  } catch (e) {
    c.stats.errors++;
    c.log("warn", `  ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Sleep that also tells the watchdog "this stillness is intentional, don't
 * fire recovery". Use for any read/viewing pause — comment scrolling, profile
 * viewing, story watching. Keeps the watchdog available for REAL freezes
 * (>5s AFTER the planned dwell ends).
 */
export async function dwell(c: Ctx, ms: number): Promise<void> {
  if (ms > 3000) c.watchdog?.suppress(ms + 2000);
  await sleep(ms);
}

/**
 * Rare long idle — "got distracted" — that stops ALL activity for 15-75s.
 * Critical for not looking like a bot that scrolls non-stop for 10+ minutes.
 */
export async function humanIdle(
  c: Ctx,
  pct = 10,
  minMs = 15000,
  maxMs = 75000,
): Promise<void> {
  if (!roll(pct)) return;
  const ms = randint(minMs, Math.min(maxMs, timeLeft(c) - 5000));
  if (ms <= 0) return;
  c.log("info", `  💤 idle pause ${Math.floor(ms / 1000)}s`);
  c.watchdog?.suppress(ms + 2000);
  await sleep(ms);
}

/**
 * Micro-pause between actions. Fires often (15% of the time) but stays short
 * (0.5–2.5s). These add the "hmm, let me look at this" moments that break up
 * the rhythmic pattern bots leave behind.
 */
export async function microGlance(c: Ctx, pct = 15): Promise<void> {
  if (!roll(pct)) return;
  await sleep(randint(500, 2500));
}

/**
 * Pull the notification shade down and push it back up — glance for new
 * messages without opening anything. Safe filler gesture that varies the UI
 * fingerprint between scrolls.
 */
export async function notificationPeek(c: Ctx, pct = 4): Promise<void> {
  if (!roll(pct)) return;
  c.log("info", `  👀 glancing at notifications`);
  c.watchdog?.suppress(8000);
  await safe(c, "notification peek", async () => {
    await c.driver.peekNotifications();
  });
}

/**
 * Scroll-back: ~10% chance, varied flavors. Simulates re-reading / comparing
 * posts — a very common behavior rare in bots.
 */
export async function maybeScrollBack(c: Ctx): Promise<void> {
  if (!roll(10)) return;
  const flavor = Math.random();
  if (flavor < 0.5) {
    await c.driver.swipeDown();
    await sleep(randint(2800, 7000));
    await c.driver.swipeUp();
  } else if (flavor < 0.8) {
    await c.driver.swipeDown();
    await sleep(randint(4000, 11000));
  } else {
    await c.driver.swipeDown();
    await sleep(randint(2000, 4500));
    await c.driver.swipeDown();
    await sleep(randint(3000, 7000));
    await c.driver.swipeUp();
    await sleep(randint(1500, 3500));
    await c.driver.swipeUp();
  }
}
