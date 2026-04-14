/**
 * TikTok — Warmup session orchestrator.
 */

import type { Ctx, SessionStats } from "../../human.ts";
import { tiktokLaunch } from "./launch.ts";
import { tiktokValidateHome } from "./nav.ts";
import { scrollFeedTool } from "./tools/scroll-feed.ts";

export async function runTiktok(ctx: Ctx): Promise<SessionStats> {
  ctx.stats.platform = "tiktok";
  if (!(await tiktokLaunch(ctx))) return ctx.stats;
  // Re-entry guardrail — recover from whatever state the last session
  // ended on (profile, search, DM, deep-link video) before scrolling.
  if (!(await tiktokValidateHome(ctx))) {
    ctx.log("warn", "[TikTok] could not validate For You feed — aborting warmup this session");
    return ctx.stats;
  }
  await scrollFeedTool(ctx);
  try { await ctx.driver.pressHome(); } catch {}
  return ctx.stats;
}
