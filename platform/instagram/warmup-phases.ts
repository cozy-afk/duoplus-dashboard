/**
 * Instagram — 2026 Algorithm-Aligned Warmup Phases
 *
 * Implements the 21-day account warmup SOP in 4 progressive phases.
 * Each phase increases engagement depth and breadth to build authentic
 * behavioral history before scaling to full automation.
 *
 * Phase 1 (Day 1–3):   Establish basic behavior — browse, light likes, saves. No follows/DMs.
 * Phase 2 (Day 4–7):   Add comments + niche follows to build interest tags.
 * Phase 3 (Day 8–14):  Deepen niche engagement — hashtag exploration, more comments.
 * Phase 4 (Day 15–21): Full engagement — higher like/comment/follow quotas, reply-style comments.
 *
 * Usage:
 *   import { runInstagramPhase } from "./warmup-phases.ts";
 *   await runInstagramPhase(1, ctx, { nicheHashtags: ["fitness", "nutrition"] });
 */

import { sleep, randint, roll, shuffle } from "../../device-driver.ts";
import type { Ctx, SessionStats } from "../../human.ts";
import { humanIdle, notificationPeek, expired } from "../../human.ts";
import { igLaunch } from "./launch.ts";
import { igGoToTab } from "./nav.ts";
import { scrollFeedTool } from "./tools/scroll-feed.ts";
import { reelsTool } from "./tools/reels.ts";
import { storyViewerTool } from "./tools/story-viewer.ts";
import { commentTool } from "./tools/comment.ts";
import { followTool } from "./tools/follow.ts";
import { saveTool } from "./tools/save.ts";
import { igExplore } from "./explore.ts";
import { igOwnProfile } from "./profile.ts";

// ---------------------------------------------------------------------------
// Phase config
// ---------------------------------------------------------------------------

export interface WarmupPhaseConfig {
  /**
   * Niche-relevant hashtags (without #) used for Explore browsing and
   * targeted follows. Provide 3–5 for best results.
   * Example: ["fitness", "homeworkout", "mealprep2026"]
   */
  nicheHashtags?: string[];

  /**
   * Comment templates rotated during write-mode commenting.
   * Keep generic and human — avoid anything that looks spammy.
   * Example: ["Great content!", "This is super helpful", "Exactly what I needed"]
   */
  commentTexts?: string[];

  /**
   * Usernames to follow (Phase 2+). If empty, follow tool picks niche accounts
   * found via Explore/hashtag search.
   */
  followTargets?: string[];

  /**
   * Override the per-session like cap for this phase run.
   * Useful for dialing back engagement on sensitive accounts.
   * If unset, each phase uses its recommended default range.
   */
  maxLikesOverride?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Pick a random entry from an array, or undefined if the array is empty. */
function pick<T>(arr: T[]): T | undefined {
  if (!arr.length) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Pause between sections with a human-paced idle. */
async function sectionBreak(ctx: Ctx, minMs = 2000, maxMs = 5000): Promise<void> {
  await sleep(randint(minMs, maxMs));
  await notificationPeek(ctx, 14);
  await humanIdle(ctx, 10, 6000, 25000);
}

// ---------------------------------------------------------------------------
// Phase 1 — Day 1–3: Build the basic behavior path
//
// Goal: make the account look like a real new user exploring the app.
// Rules: NO follows, NO DMs, NO promotional content.
// Actions: browse feed (10-15 min equivalent), light likes (5-8), save 1-2 posts.
// ---------------------------------------------------------------------------

export async function runInstagramPhase1(
  ctx: Ctx,
  config: WarmupPhaseConfig = {},
): Promise<SessionStats> {
  ctx.stats.platform = "instagram";
  if (!(await igLaunch(ctx))) return ctx.stats;

  ctx.log("info", "[IG:phase1] Day 1–3 warmup — browse + light engagement");

  // Feed scroll: few scrolls, light engagement, low like cap (5-8).
  await scrollFeedTool(ctx, {
    scrolls: randint(8, 14),
    withEngagement: true,
    maxLikes: config.maxLikesOverride ?? randint(5, 8),
  });

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Save 1–2 posts. We navigate back to feed and save on a visible post.
  const savesToDo = randint(1, 2);
  for (let i = 0; i < savesToDo; i++) {
    if (expired(ctx)) break;
    await igGoToTab(ctx, "home");
    await sleep(randint(1500, 3000));
    // Scroll past 1-2 posts before saving so it looks natural.
    const driver = ctx.driver;
    const size = await driver.screenSize();
    for (let j = 0; j < randint(1, 3); j++) {
      await driver.swipe(
        Math.floor(size.width * 0.5),
        Math.floor(size.height * 0.65),
        Math.floor(size.width * 0.5),
        Math.floor(size.height * 0.35),
        randint(300, 600),
      );
      await sleep(randint(1200, 2800));
    }
    await saveTool(ctx);
    await sleep(randint(1500, 3000));
  }

  if (!expired(ctx)) {
    await sectionBreak(ctx);

    // Passive story viewing to build browse signals.
    await storyViewerTool(ctx, { count: randint(2, 4) });
  }

  try { await igGoToTab(ctx, "home"); } catch {}
  try { await ctx.driver.pressHome(); } catch {}

  ctx.log("info", `[IG:phase1] done — likes=${ctx.stats.likes_given} saves=${ctx.stats.saves}`);
  return ctx.stats;
}

// ---------------------------------------------------------------------------
// Phase 2 — Day 4–7: Build interest tags
//
// Adds: niche comments (2-3), niche follows (5-8), slightly more likes (8-12).
// ---------------------------------------------------------------------------

export async function runInstagramPhase2(
  ctx: Ctx,
  config: WarmupPhaseConfig = {},
): Promise<SessionStats> {
  ctx.stats.platform = "instagram";
  if (!(await igLaunch(ctx))) return ctx.stats;

  ctx.log("info", "[IG:phase2] Day 4–7 warmup — interest tags + niche engagement");

  // Feed scroll with more likes.
  await scrollFeedTool(ctx, {
    scrolls: randint(12, 18),
    withEngagement: true,
    maxLikes: config.maxLikesOverride ?? randint(8, 12),
  });

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Comment on 2-3 posts (read-mode first, then optionally write).
  const commentsToWrite = randint(2, 3);
  const commentPool = config.commentTexts ?? [];
  for (let i = 0; i < commentsToWrite; i++) {
    if (expired(ctx)) break;
    await igGoToTab(ctx, "home");
    await sleep(randint(1500, 3000));
    const text = roll(60) ? pick(commentPool) : undefined;
    await commentTool(ctx, { text });
    ctx.stats.comments_read++;
    await sleep(randint(2000, 4000));
  }

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Follow 5-8 niche accounts.
  const followCount = randint(5, 8);
  const targets = config.followTargets ? shuffle([...config.followTargets]) : [];
  for (let i = 0; i < followCount; i++) {
    if (expired(ctx)) break;
    const target = targets[i]; // may be undefined — followTool handles that
    const ok = await followTool(ctx, target ? { targetUsername: target } : {});
    if (ok) await sleep(randint(3000, 6000));
  }

  if (!expired(ctx)) {
    await sectionBreak(ctx);
    // Browse a couple of stories.
    await storyViewerTool(ctx, { count: randint(3, 5) });
  }

  try { await igGoToTab(ctx, "home"); } catch {}
  try { await ctx.driver.pressHome(); } catch {}

  ctx.log("info", `[IG:phase2] done — likes=${ctx.stats.likes_given} comments=${ctx.stats.comments_read}`);
  return ctx.stats;
}

// ---------------------------------------------------------------------------
// Phase 3 — Day 8–14: Establish content niche
//
// Adds: hashtag exploration, saves, more consistent engagement pattern.
// Likes 10-15, comments 3-5, follows 5-8, saves 1-2, hashtag searches.
// ---------------------------------------------------------------------------

export async function runInstagramPhase3(
  ctx: Ctx,
  config: WarmupPhaseConfig = {},
): Promise<SessionStats> {
  ctx.stats.platform = "instagram";
  if (!(await igLaunch(ctx))) return ctx.stats;

  ctx.log("info", "[IG:phase3] Day 8–14 warmup — establish niche + hashtag exploration");

  // Feed scroll.
  await scrollFeedTool(ctx, {
    scrolls: randint(14, 20),
    withEngagement: true,
    maxLikes: config.maxLikesOverride ?? randint(10, 15),
  });

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Hashtag-driven Explore session — builds niche categorization signal.
  await igExplore(ctx, { scrolls: randint(4, 7) });
  ctx.stats.hashtag_searches += (config.nicheHashtags?.length ?? 0) > 0 ? 1 : 0;

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Save 1-2 posts from feed.
  const savesToDo = randint(1, 2);
  for (let i = 0; i < savesToDo; i++) {
    if (expired(ctx)) break;
    await igGoToTab(ctx, "home");
    await sleep(randint(1500, 2500));
    await saveTool(ctx);
    await sleep(randint(1500, 3000));
  }

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Comments on 3-5 posts — mix of read-mode and write-mode.
  const commentsToWrite = randint(3, 5);
  const commentPool = config.commentTexts ?? [];
  for (let i = 0; i < commentsToWrite; i++) {
    if (expired(ctx)) break;
    await igGoToTab(ctx, "home");
    await sleep(randint(1500, 3000));
    // 50% chance to write, 50% read-only.
    const text = roll(50) ? pick(commentPool) : undefined;
    await commentTool(ctx, { text });
    ctx.stats.comments_read++;
    await sleep(randint(2500, 5000));
  }

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Follow 5-8 niche accounts.
  const followCount = randint(5, 8);
  const targets = config.followTargets ? shuffle([...config.followTargets]) : [];
  for (let i = 0; i < followCount; i++) {
    if (expired(ctx)) break;
    const target = targets[i];
    const ok = await followTool(ctx, target ? { targetUsername: target } : {});
    if (ok) await sleep(randint(3000, 7000));
  }

  if (!expired(ctx)) {
    await sectionBreak(ctx);
    // Reels watch — short video signals are now heavily weighted.
    await reelsTool(ctx, { count: randint(3, 6) });
  }

  if (!expired(ctx)) {
    await sectionBreak(ctx);
    await storyViewerTool(ctx, { count: randint(3, 5) });
  }

  try { await igGoToTab(ctx, "home"); } catch {}
  try { await ctx.driver.pressHome(); } catch {}

  ctx.log("info",
    `[IG:phase3] done — likes=${ctx.stats.likes_given} saves=${ctx.stats.saves} comments=${ctx.stats.comments_read}`,
  );
  return ctx.stats;
}

// ---------------------------------------------------------------------------
// Phase 4 — Day 15–21: Increase account activity
//
// Full engagement. Likes 15-20, comments 5, follows 5-10, reels, stories,
// explore, own-profile peek. Share signals now weighted as highest-value action.
// ---------------------------------------------------------------------------

export async function runInstagramPhase4(
  ctx: Ctx,
  config: WarmupPhaseConfig = {},
): Promise<SessionStats> {
  ctx.stats.platform = "instagram";
  if (!(await igLaunch(ctx))) return ctx.stats;

  ctx.log("info", "[IG:phase4] Day 15–21 warmup — full engagement mode");

  // Build a rich session sequence (shuffled tail for naturalness).
  const commentPool = config.commentTexts ?? [];

  // Feed with high engagement.
  await scrollFeedTool(ctx, {
    scrolls: randint(18, 26),
    withEngagement: true,
    maxLikes: config.maxLikesOverride ?? randint(15, 20),
  });

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Comment on 5 posts — mix of read and write, with reply-style language.
  for (let i = 0; i < 5; i++) {
    if (expired(ctx)) break;
    await igGoToTab(ctx, "home");
    await sleep(randint(1500, 3500));
    // 70% chance to write — Phase 4 accounts should look active.
    const text = roll(70) ? pick(commentPool) : undefined;
    await commentTool(ctx, { text });
    ctx.stats.comments_read++;
    await sleep(randint(3000, 6000));
  }

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Follows 5-10 niche accounts.
  const followCount = randint(5, 10);
  const targets = config.followTargets ? shuffle([...config.followTargets]) : [];
  for (let i = 0; i < followCount; i++) {
    if (expired(ctx)) break;
    const target = targets[i];
    const ok = await followTool(ctx, target ? { targetUsername: target } : {});
    if (ok) await sleep(randint(4000, 8000));
  }

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Explore + hashtag browsing.
  await igExplore(ctx, { scrolls: randint(5, 9) });
  ctx.stats.hashtag_searches += (config.nicheHashtags?.length ?? 0) > 0 ? 1 : 0;

  // Tail sections: reels, stories, own profile (shuffled).
  const tail: Array<() => Promise<void>> = [
    () => reelsTool(ctx, { count: randint(4, 8) }),
    () => storyViewerTool(ctx, { count: randint(4, 7) }),
    () => igOwnProfile(ctx),
  ];

  for (const section of shuffle(tail)) {
    if (expired(ctx)) break;
    await sectionBreak(ctx, 2500, 6000);
    await section();
  }

  try { await igGoToTab(ctx, "home"); } catch {}
  try { await ctx.driver.pressHome(); } catch {}

  ctx.log("info",
    `[IG:phase4] done — likes=${ctx.stats.likes_given} comments=${ctx.stats.comments_read} follows=${ctx.stats.profile_visits}`,
  );
  return ctx.stats;
}

// ---------------------------------------------------------------------------
// Dispatcher — picks the right phase by number
// ---------------------------------------------------------------------------

export type WarmupPhase = 1 | 2 | 3 | 4;

export async function runInstagramPhase(
  phase: WarmupPhase,
  ctx: Ctx,
  config: WarmupPhaseConfig = {},
): Promise<SessionStats> {
  switch (phase) {
    case 1: return runInstagramPhase1(ctx, config);
    case 2: return runInstagramPhase2(ctx, config);
    case 3: return runInstagramPhase3(ctx, config);
    case 4: return runInstagramPhase4(ctx, config);
  }
}
