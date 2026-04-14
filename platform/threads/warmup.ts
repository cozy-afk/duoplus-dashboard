/**
 * Threads — Warmup session orchestrator.
 * Launches app, runs feed scroll, and optionally peeks at the Activity tab.
 */

import { sleep, randint, roll } from "../../device-driver.ts";
import { analyzeAndRecover } from "../../screen-analyzer.ts";
import type { Ctx, SessionStats } from "../../human.ts";
import { expired } from "../../human.ts";
import { AccountFlaggedError } from "../../safety.ts";
import { THREADS_PKG, threadsGoToTab, threadsValidateHome } from "./nav.ts";
import { scrollFeedTool } from "./tools/scroll-feed.ts";

async function threadsActivityPeek(ctx: Ctx): Promise<void> {
  await threadsGoToTab(ctx, "activity");
  ctx.stats.tab_switches++;
  await sleep(randint(2200, 4800));
  const scrolls = randint(2, 5);
  for (let k = 0; k < scrolls; k++) {
    await ctx.driver.swipeUp(randint(50, 85) / 100);
    await sleep(randint(2000, 4500));
  }
  await threadsGoToTab(ctx, "home");
  await sleep(randint(1600, 3000));
}

export async function runThreads(ctx: Ctx): Promise<SessionStats> {
  ctx.stats.platform = "threads";
  try {
    await ctx.driver.launchApp(THREADS_PKG);
    ctx.stats.app_launches++;
  } catch (e) {
    ctx.log("warn", `[Threads] launch failed: ${e instanceof Error ? e.message : e}`);
    ctx.stats.errors++;
    return ctx.stats;
  }
  await sleep(randint(3000, 5000));

  const pre = await analyzeAndRecover(ctx.driver, {
    platform: "threads",
    context: "threads-launch",
    pkg: THREADS_PKG,
    log: ctx.log,
  });
  if (pre.classification === "challenge" || pre.classification === "rate-limit") {
    throw new AccountFlaggedError(pre.classification);
  }

  // Re-entry guardrail — ensure we're on Home, not stuck on a profile
  // page / modal / DM view from a previous session.
  if (!(await threadsValidateHome(ctx))) {
    ctx.log("warn", "[Threads] could not validate Home — aborting warmup this session");
    return ctx.stats;
  }
  await sleep(randint(2400, 5200));

  await scrollFeedTool(ctx);

  if (roll(45) && !expired(ctx)) {
    await threadsActivityPeek(ctx).catch(() => {});
  }

  try { await threadsGoToTab(ctx, "home"); } catch {}
  try { await ctx.driver.pressHome(); } catch {}
  return ctx.stats;
}
