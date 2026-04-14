/**
 * Session dispatcher. Thin top-level module that:
 *   - Wires up the stall-recovery handler across all platforms
 *   - Picks the right per-platform runner for warmup / login / follow / post
 *   - Re-exports the public API that runner.ts / server.ts consume
 *
 * All platform-specific logic lives in platform/{instagram,threads,tiktok}.ts.
 * Shared primitives live in human.ts, safety.ts, feed-patterns.ts, bottom-nav.ts.
 */

import type { Quota } from "./db.ts";
import type { DeviceDriver } from "./device-driver.ts";
import { sleep, randint } from "./device-driver.ts";
import { Watchdog } from "./watchdog.ts";
import { captureFailure } from "./vision.ts";
import type { Ctx, LogFn, LoginCreds, SessionStats } from "./human.ts";
import { newStats } from "./human.ts";
import {
  IG_PKG, igGoToTab, runInstagram, runInstagramLogin,
  runInstagramFollowCampaign, runInstagramPostPublish,
  type FollowCampaignConfig,
} from "./platform/instagram/index.ts";
import { THREADS_PKG, threadsGoToTab, runThreads, runThreadsLogin } from "./platform/threads/index.ts";
import { TIKTOK_PKG, runTiktok } from "./platform/tiktok/index.ts";

// Re-exports — keeps the public API that runner.ts / server.ts import stable.
export { StalledError } from "./watchdog.ts";
export { AccountFlaggedError } from "./safety.ts";
export type { SessionStats, LoginCreds } from "./human.ts";
export { newStats } from "./human.ts";
export {
  runInstagram, runInstagramLogin,
  runInstagramFollowCampaign, runInstagramPostPublish,
  type FollowCampaignConfig,
} from "./platform/instagram/index.ts";
export { runThreads, runThreadsLogin } from "./platform/threads/index.ts";
export { runTiktok } from "./platform/tiktok/index.ts";

// ===========================================================================
// Dispatcher
// ===========================================================================

export type AutomationType = "warmup" | "follow" | "post" | "login";

const WARMUP_RUNNERS: Record<
  "instagram" | "threads" | "tiktok",
  (ctx: Ctx) => Promise<SessionStats>
> = {
  instagram: runInstagram,
  threads: runThreads,
  tiktok: runTiktok,
};

const PKG_BY_PLATFORM = {
  instagram: IG_PKG,
  threads: THREADS_PKG,
  tiktok: TIKTOK_PKG,
} as const;

/**
 * Run a single platform session (warmup / follow / post / login). Manages the
 * Watchdog lifecycle + platform-aware stall recovery, then delegates to the
 * appropriate per-platform runner for the actual automation.
 */
export async function runPlatformSession(
  platform: "instagram" | "threads" | "tiktok",
  driver: DeviceDriver,
  quota: Quota,
  log: LogFn,
  deadline: number,
  automation: AutomationType = "warmup",
  extras?: {
    followConfig?: FollowCampaignConfig;
    post?: Parameters<typeof runInstagramPostPublish>[1];
  },
): Promise<SessionStats> {
  const stats = newStats(platform);
  const watchdog = new Watchdog(driver, 15000, log);
  const ctx: Ctx = { driver, quota, log, stats, deadline, watchdog };

  if (automation === "warmup") {
    watchdog.setOnStall(async (consecutive) => {
      // 3+ consecutive stalls → capture + force-stop + relaunch.
      if (consecutive >= 3) {
        const pkg = PKG_BY_PLATFORM[platform];
        log("warn", `  [${platform}] stall #${consecutive} — capturing screen + force-closing ${pkg} before relaunch`);
        try {
          await captureFailure(
            driver,
            {
              deviceId: driver.deviceId,
              platform,
              context: `stall-escalation-${consecutive}`,
              recovered: false,
              recoveryAction: "force-stop-relaunch",
            },
            log,
          );
        } catch (e) {
          log("warn", `  [${platform}] capture failed: ${e instanceof Error ? e.message : e}`);
        }
        try { await driver.shell(`am force-stop ${pkg}`); } catch {}
        await sleep(randint(1500, 2500));
        try {
          await driver.launchApp(pkg);
        } catch (e) {
          log("warn", `  [${platform}] relaunch failed: ${e instanceof Error ? e.message : e}`);
        }
        return;
      }

      // 2nd consecutive stall → press Back a few times before re-nav'ing home.
      if (consecutive === 2) {
        log("info", `  [${platform}] stall #${consecutive} — pressing Back 3x then home tab`);
        for (let i = 0; i < 3; i++) {
          try { await driver.pressBack(); } catch {}
          await sleep(randint(400, 800));
        }
      }

      // 1st stall (or after back-press) — navigate to app home.
      if (platform === "instagram") {
        await igGoToTab(ctx, "home");
      } else if (platform === "threads") {
        await threadsGoToTab(ctx, "home");
      } else {
        const size = await driver.screenSize();
        const slotX = Math.floor((size.width / 5) * 0.5);
        const slotY = Math.floor(size.height * 0.97);
        log("info", `  [TikTok] stall recovery → Home tap at (${slotX}, ${slotY})`);
        await driver.tap(slotX, slotY, 0);
      }
    });
  }

  const watchdogLoop = watchdog.start().catch(() => {});

  // Single try/finally wraps EVERY automation type so the watchdog and its
  // loop are always cleaned up — previously only the warmup branch was
  // protected and follow/post ran without watchdog teardown.
  try {
    if (automation === "warmup") {
      return await WARMUP_RUNNERS[platform](ctx);
    }
    if (automation === "follow") {
      if (platform !== "instagram") {
        log("warn", `Follow automation currently only supported on Instagram. Skipping ${platform}.`);
        return stats;
      }
      if (!extras?.followConfig) {
        log("warn", "Follow automation requires followConfig. Skipping.");
        return stats;
      }
      return await runInstagramFollowCampaign(ctx, extras.followConfig);
    }
    if (automation === "post") {
      if (platform !== "instagram") {
        log("warn", `Post automation currently only supported on Instagram. Skipping ${platform}.`);
        return stats;
      }
      if (!extras?.post) {
        log("warn", "Post automation requires a post to publish. Skipping.");
        return stats;
      }
      return await runInstagramPostPublish(ctx, extras.post);
    }
    return stats;
  } finally {
    watchdog.stop();
    await watchdogLoop;
  }
}

