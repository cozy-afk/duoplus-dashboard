/**
 * Instagram — Warmup session orchestrator.
 *
 * Sequences feed → reels → stories (shuffled tail) with optional explore and
 * own-profile peek. Delegates to tool modules for each section.
 */

import { sleep, randint, roll, shuffle } from "../../device-driver.ts";
import type { Ctx, SessionStats } from "../../human.ts";
import { humanIdle, notificationPeek, expired } from "../../human.ts";
import { igGoToTab, igValidateHome } from "./nav.ts";
import { igLaunch } from "./launch.ts";
import { scrollFeedTool } from "./tools/scroll-feed.ts";
import { reelsTool } from "./tools/reels.ts";
import { storyViewerTool } from "./tools/story-viewer.ts";
import { igExplore } from "./explore.ts";
import { igOwnProfile } from "./profile.ts";

export async function runInstagram(ctx: Ctx): Promise<SessionStats> {
  ctx.stats.platform = "instagram";
  if (!(await igLaunch(ctx))) return ctx.stats;
  // Re-entry guardrail: previous session may have died on a profile page,
  // inside a modal, deep in settings, or the app A/B-tested a cold-start
  // onto Reels. Back-press / force-restart until we're on Home before
  // any warmup tool fires — otherwise feed scrolls land on Reels, story
  // tray lookups fail, etc.
  if (!(await igValidateHome(ctx))) {
    ctx.log("warn", "[IG] could not validate Home after launch — aborting warmup this session");
    return ctx.stats;
  }

  // Feed always runs first. Remaining sections are shuffled.
  const core: Array<{ name: string; run: () => Promise<void> }> = [
    { name: "feed",    run: () => scrollFeedTool(ctx) },
    { name: "reels",   run: () => reelsTool(ctx) },
    { name: "stories", run: () => storyViewerTool(ctx) },
  ];
  const tail = shuffle(core.slice(1));
  const sections = [core[0], ...tail];
  if (roll(70)) sections.push({ name: "explore",     run: () => igExplore(ctx) });
  if (roll(30)) sections.push({ name: "own-profile", run: () => igOwnProfile(ctx) });

  for (let i = 0; i < sections.length; i++) {
    if (expired(ctx)) { ctx.stats.hit_deadline = true; break; }
    const s = sections[i];
    if (i > 0) {
      await sleep(randint(1800, 4500));
      // Sweep interstitials that appear mid-session (Save-login, Turn-on-
      // notifications, "Get Meta app", "Rate this app") BEFORE we try to
      // nav. Otherwise they block the nav tap and stall the watchdog.
      try { await ctx.driver.dismissPopups(); } catch { /* non-fatal */ }
      await notificationPeek(ctx, 14);
      if (s.name !== "own-profile" && s.name !== "explore") {
        await igGoToTab(ctx, "home");
        await sleep(randint(1600, 3500));
      }
      await humanIdle(ctx, 12, 8000, 35000);
    }
    await s.run();
  }

  try { await igGoToTab(ctx, "home"); } catch {}
  try { await ctx.driver.pressHome(); } catch {}
  return ctx.stats;
}
