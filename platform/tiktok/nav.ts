/**
 * TikTok navigation helpers. TikTok's bottom-nav strips accessibility info
 * off tab buttons on most builds (every slot is just an empty FrameLayout
 * with obfuscated resource-ids), so we can't reuse the shared bottom-nav
 * NavConfig system that works for IG/Threads. Everything here falls back
 * to coordinate taps, keyed off screen size.
 */

import { sleep, randint } from "../../device-driver.ts";
import type { Ctx } from "../../human.ts";
import { TIKTOK_PKG } from "./constants.ts";

/** Slot index → screen-relative (x, y) for a 5-column bottom nav. */
async function tiktokBottomSlot(c: Ctx, slotIdx: number): Promise<{ x: number; y: number }> {
  const size = await c.driver.screenSize();
  return {
    x: Math.floor((size.width / 5) * (slotIdx + 0.5)),
    y: Math.floor(size.height * 0.97),
  };
}

/** Tap the Home (slot 0) tab. */
export async function tiktokTapHome(c: Ctx): Promise<void> {
  const { x, y } = await tiktokBottomSlot(c, 0);
  await c.driver.tap(x, y, 0);
  await sleep(randint(1800, 3200));
}

/** Heuristic: are we on the For You / Home feed right now? */
async function isOnHome(c: Ctx): Promise<boolean> {
  // Strongest signal: "For You" content-desc in the top tab row. Present
  // almost every build. "Home" is the fallback for older builds.
  const feedDesc = await c.driver.waitForDesc(["For You", "Home"], 1500).catch(() => null);
  return feedDesc != null;
}

/**
 * Re-entry guardrail for TikTok. Called at warmup start to recover from
 * previous-session state (profile, search, DM, video player deep-link).
 *
 * Strategy:
 *   1. Already on home? done.
 *   2. Tap the Home slot by coordinates, re-check.
 *   3. Press Back up to 4×, re-check after each.
 *   4. Force-stop + relaunch; re-check.
 *
 * Returns true if we ended up on the For You feed.
 */
export async function tiktokValidateHome(c: Ctx, maxBacks = 4): Promise<boolean> {
  c.watchdog?.suppress(45000);

  if (await isOnHome(c)) {
    c.log("info", "  [TikTok] re-entry: already on For You");
    return true;
  }

  // Step 1: tap Home slot directly — cheapest recovery.
  await tiktokTapHome(c);
  if (await isOnHome(c)) {
    c.log("info", "  [TikTok] re-entry: Home tap landed on For You");
    return true;
  }

  // Step 2: Back-press ladder for modals / deep pages.
  c.log("warn", `  [TikTok] re-entry: unknown state — pressing Back up to ${maxBacks}×`);
  for (let i = 0; i < maxBacks; i++) {
    await c.driver.pressBack();
    await sleep(randint(900, 1700));
    if (await isOnHome(c)) {
      c.log("info", `  [TikTok] re-entry: recovered to For You after ${i + 1} back(s)`);
      return true;
    }
  }

  // Step 3: force-stop + relaunch.
  c.log("warn", `  [TikTok] re-entry: force-close + relaunch ${TIKTOK_PKG}`);
  try { await c.driver.shell(`am force-stop ${TIKTOK_PKG}`); } catch { /* best-effort */ }
  await sleep(randint(1500, 2500));
  try { await c.driver.launchApp(TIKTOK_PKG); } catch (err) {
    c.log("error", `  [TikTok] relaunch failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  // TikTok is slow to hydrate — give it ~14s (same budget the scanner uses).
  await sleep(randint(12000, 16000));
  return await isOnHome(c);
}
