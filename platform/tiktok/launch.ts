/**
 * TikTok — App launch + feed-gate detection.
 * Returns true if the For You / Home feed is ready, false if not detected.
 * Throws AccountFlaggedError for challenge/rate-limit screens.
 */

import { sleep, randint } from "../../device-driver.ts";
import { analyzeAndRecover } from "../../screen-analyzer.ts";
import type { Ctx } from "../../human.ts";
import { AccountFlaggedError, LoginWallError } from "../../safety.ts";
import { TIKTOK_PKG } from "./constants.ts";

export async function tiktokLaunch(ctx: Ctx): Promise<boolean> {
  try {
    await ctx.driver.launchApp(TIKTOK_PKG);
    ctx.stats.app_launches++;
  } catch (e) {
    ctx.log("warn", `[TikTok] launch failed: ${e instanceof Error ? e.message : e}`);
    ctx.stats.errors++;
    return false;
  }
  await sleep(randint(4000, 6000));

  const pre = await analyzeAndRecover(ctx.driver, {
    platform: "tiktok",
    context: "tiktok-launch",
    pkg: TIKTOK_PKG,
    log: ctx.log,
  });
  if (pre.classification === "challenge" || pre.classification === "rate-limit") {
    throw new AccountFlaggedError(pre.classification);
  }
  if (pre.classification === "login-wall") {
    throw new LoginWallError("tiktok", "TikTok signup/login screen visible on launch");
  }
  if (pre.classification === "birthday-gate") {
    ctx.log("info", `  [TikTok] birthday gate handled (${pre.action})`);
    await sleep(randint(2500, 4500));
  }

  // Dismiss any leftover popups.
  for (let i = 0; i < 3; i++) await ctx.driver.dismissPopups();

  const gate = await ctx.driver.waitForDesc(["For You", "Home"], 12000);
  if (!gate) {
    const retry = await analyzeAndRecover(ctx.driver, {
      platform: "tiktok",
      context: "tiktok-no-feed-gate",
      pkg: TIKTOK_PKG,
      log: ctx.log,
    });
    if (retry.classification === "challenge" || retry.classification === "rate-limit") {
      throw new AccountFlaggedError(retry.classification);
    }
    if (retry.classification === "login-wall") {
      throw new LoginWallError("tiktok", "TikTok signup screen after feed-gate retry");
    }
    const gate2 = await ctx.driver.waitForDesc(["For You", "Home"], 8000);
    if (!gate2) {
      ctx.log("warn", "[TikTok] feed gate not detected after retry — skipping");
      return false;
    }
  }
  return true;
}
