/**
 * Instagram — Follow Campaign
 *
 * Visits seed accounts, browses their follower lists, and uses followTool
 * to follow targets that meet the filter criteria.
 */

import { sleep, randint } from "../../device-driver.ts";
import type { Ctx, SessionStats } from "../../human.ts";
import { safe, expired } from "../../human.ts";
import { igLaunch } from "./launch.ts";
import { followNextVisibleRow } from "./tools/follow.ts";

export interface FollowCampaignConfig {
  seeds: Array<{ handle: string; min_followers?: number; max_followers?: number }>;
  maxFollowsThisSession: number;
}

export async function runInstagramFollowCampaign(
  ctx: Ctx,
  config: FollowCampaignConfig,
): Promise<SessionStats> {
  ctx.stats.platform = "instagram";
  if (!(await igLaunch(ctx))) return ctx.stats;

  const sr = await ctx.driver.findByDesc("Search and explore");
  if (!sr) return ctx.stats;
  await ctx.driver.tap(sr.x, sr.y);
  ctx.stats.tab_switches++;
  await sleep(randint(2000, 3500));

  // Track follows separately from profile_visits so the cap actually counts
  // follows, not seed-profile visits. Previously the same counter was used
  // for both, which made the cap exit before any rows were followed.
  let followsThisSession = 0;

  for (const seed of config.seeds) {
    if (expired(ctx)) { ctx.stats.hit_deadline = true; break; }
    if (followsThisSession >= config.maxFollowsThisSession) break;

    await safe(ctx, `seed ${seed.handle}`, async () => {
      const bar = await ctx.driver.findByResourceId(
        "com.instagram.android:id/action_bar_search_edit_text",
      );
      if (!bar) return;
      await ctx.driver.tap(bar.x, bar.y);
      await sleep(randint(1200, 2200));
      await ctx.driver.typeText(seed.handle);
      await sleep(randint(2500, 4000));

      if (!(await ctx.driver.tapByText(seed.handle))) {
        ctx.log("warn", `  couldn't find account row for @${seed.handle}`);
        return;
      }
      await sleep(randint(2500, 4500));
      ctx.stats.profile_visits++;

      const fol = await ctx.driver.findByText("followers");
      if (!fol) return;
      await ctx.driver.tap(fol.x, fol.y);
      await sleep(randint(2500, 4000));

      // Browse follower list and follow visible rows. We iterate
      // scroll → follow-one-row, with a probabilistic skip so we don't tap
      // every single visible Follow button (which would look botlike).
      for (let k = 0; k < 8; k++) {
        if (expired(ctx)) { ctx.stats.hit_deadline = true; break; }
        if (followsThisSession >= config.maxFollowsThisSession) break;

        // 65% chance to actually follow on each scroll — the rest is "just
        // browsing". Random per-iteration; deterministic over a long run
        // gives ~5/8 follows per seed.
        if (Math.random() < 0.65) {
          const ok = await followNextVisibleRow(ctx);
          if (ok) {
            followsThisSession++;
            ctx.log("info", `  follow-campaign: ${followsThisSession}/${config.maxFollowsThisSession}`);
          }
        }
        await ctx.driver.swipeUp(0.7);
        await sleep(randint(2500, 5000));
      }

      await ctx.driver.pressBack();
      await sleep(randint(1000, 1800));
      await ctx.driver.pressBack();
      await sleep(randint(1200, 2200));
    });
  }

  try { await ctx.driver.pressHome(); } catch {}
  return ctx.stats;
}
