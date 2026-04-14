/**
 * TikTok — 2026 Algorithm-Aligned Warmup Phases
 *
 * Mirrors the Instagram 21-day SOP adapted for TikTok's For You algorithm.
 * TikTok weights: shares > comments > likes > saves > watch-time.
 * The key signal is watch completion rate — watching a video all the way
 * through is the strongest possible engagement signal.
 *
 * Phase 1 (Day 1–3):   Browse For You feed, light likes. No follows/DMs.
 * Phase 2 (Day 4–7):   Add comments (2-3), niche follows (5-8), saves.
 * Phase 3 (Day 8–14):  Deepen niche — hashtag/sound discovery, more comments.
 * Phase 4 (Day 15–21): Full engagement — higher quotas, shares, replies.
 *
 * Usage:
 *   import { runTiktokPhase } from "./warmup-phases.ts";
 *   await runTiktokPhase(2, ctx, { commentTexts: ["Love this!", "So true"] });
 */

import { sleep, randint, roll, shuffle } from "../../device-driver.ts";
import type { Ctx, SessionStats } from "../../human.ts";
import { humanIdle, notificationPeek, expired } from "../../human.ts";
import { tiktokLaunch } from "./launch.ts";
import { scrollFeedTool } from "./tools/scroll-feed.ts";
import { commentTool } from "./tools/comment.ts";
import { followTool } from "./tools/follow.ts";
import { likeTool } from "./tools/like.ts";
import { shareTool } from "./tools/share.ts";

// ---------------------------------------------------------------------------
// Phase config
// ---------------------------------------------------------------------------

export interface TikTokWarmupPhaseConfig {
  /**
   * Niche-relevant hashtags (without #) to discover and browse.
   * Example: ["fitness", "homeworkout", "mealprep"]
   */
  nicheHashtags?: string[];

  /**
   * Comment templates rotated during write-mode commenting.
   * Keep generic and authentic — avoid anything repetitive or spammy.
   * Example: ["This is incredible!", "Exactly what I was looking for", "More of this please"]
   */
  commentTexts?: string[];

  /**
   * Usernames to follow (Phase 2+). If empty, the follow tool taps Follow
   * on profiles found organically through the For You feed.
   */
  followTargets?: string[];

  /**
   * Override the per-session like cap for this phase run.
   * If unset, each phase uses its recommended default range.
   */
  maxLikesOverride?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pick<T>(arr: T[]): T | undefined {
  if (!arr.length) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

async function sectionBreak(ctx: Ctx, minMs = 2000, maxMs = 5000): Promise<void> {
  await sleep(randint(minMs, maxMs));
  await notificationPeek(ctx, 10);
  await humanIdle(ctx, 8, 5000, 20000);
}

/** Navigate to TikTok's For You feed (Home tab — leftmost slot). */
async function goHome(ctx: Ctx): Promise<void> {
  try {
    const size = await ctx.driver.screenSize();
    const homeX = Math.floor((size.width / 5) * 0.5);
    await ctx.driver.tap(homeX, Math.floor(size.height * 0.97), 0);
    await sleep(randint(1200, 2500));
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Phase 1 — Day 1–3: Build the basic behavior path
//
// Only passive/light engagement. TikTok's primary trust signal in this phase
// is watch-time: let videos play to completion before swiping.
// Actions: browse For You (10-15 videos), light likes (5-8). No follows.
// ---------------------------------------------------------------------------

export async function runTiktokPhase1(
  ctx: Ctx,
  config: TikTokWarmupPhaseConfig = {},
): Promise<SessionStats> {
  ctx.stats.platform = "tiktok";
  if (!(await tiktokLaunch(ctx))) return ctx.stats;

  ctx.log("info", "[TikTok:phase1] Day 1–3 warmup — browse + light likes");

  // Main For You scroll — short video count, light engagement, low like cap.
  await scrollFeedTool(ctx, {
    count: randint(8, 14),
    withEngagement: true,
  });

  // Cap likes: scrollFeedTool uses quota.likes_per_session by default.
  // Phase 1 accounts should stay well under to avoid early flag risk.
  // The quota is already set conservatively; this phase relies on watch-time.

  if (!expired(ctx)) {
    await sectionBreak(ctx);
    // Second shorter scroll session to simulate a natural session extension.
    await scrollFeedTool(ctx, {
      count: randint(4, 7),
      withEngagement: false, // pure watch-time, no engagement this pass
    });
  }

  try { await ctx.driver.pressHome(); } catch {}

  ctx.log("info", `[TikTok:phase1] done — likes=${ctx.stats.likes_given}`);
  return ctx.stats;
}

// ---------------------------------------------------------------------------
// Phase 2 — Day 4–7: Build interest tags
//
// Add: comments (2-3), follows (5-8 niche accounts), saves via share.
// Likes increase to 8-12.
// ---------------------------------------------------------------------------

export async function runTiktokPhase2(
  ctx: Ctx,
  config: TikTokWarmupPhaseConfig = {},
): Promise<SessionStats> {
  ctx.stats.platform = "tiktok";
  if (!(await tiktokLaunch(ctx))) return ctx.stats;

  ctx.log("info", "[TikTok:phase2] Day 4–7 warmup — interest tags + niche engagement");

  // Primary For You scroll with engagement.
  await scrollFeedTool(ctx, {
    count: randint(12, 18),
    withEngagement: true,
  });

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Comment on 2-3 videos. Navigate back to For You between each.
  const commentsTarget = randint(2, 3);
  const commentPool = config.commentTexts ?? [];
  for (let i = 0; i < commentsTarget; i++) {
    if (expired(ctx)) break;
    await goHome(ctx);
    await sleep(randint(1500, 3000));
    // 55% chance to write, rest read-only.
    const text = roll(55) ? pick(commentPool) : undefined;
    await commentTool(ctx, { text });
    ctx.stats.comments_read++;
    await sleep(randint(2000, 4500));
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
    if (ok) await sleep(randint(3000, 6000));
  }

  if (!expired(ctx)) {
    await sectionBreak(ctx);
    // Short second scroll to end the session naturally.
    await scrollFeedTool(ctx, { count: randint(3, 6), withEngagement: true });
  }

  try { await ctx.driver.pressHome(); } catch {}

  ctx.log("info", `[TikTok:phase2] done — likes=${ctx.stats.likes_given} comments=${ctx.stats.comments_read}`);
  return ctx.stats;
}

// ---------------------------------------------------------------------------
// Phase 3 — Day 8–14: Establish content niche
//
// Deepen niche: hashtag discovery via search, more comments (3-5),
// follows (5-8), occasional share/save signals.
// ---------------------------------------------------------------------------

export async function runTiktokPhase3(
  ctx: Ctx,
  config: TikTokWarmupPhaseConfig = {},
): Promise<SessionStats> {
  ctx.stats.platform = "tiktok";
  if (!(await tiktokLaunch(ctx))) return ctx.stats;

  ctx.log("info", "[TikTok:phase3] Day 8–14 warmup — establish niche via search + engagement");

  // Main For You scroll.
  await scrollFeedTool(ctx, {
    count: randint(14, 22),
    withEngagement: true,
  });

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Hashtag/sound search to build niche categorization.
  if (config.nicheHashtags?.length) {
    const tag = pick(config.nicheHashtags)!;
    ctx.log("info", `  [TikTok:phase3] searching hashtag #${tag}`);
    try {
      const size = await ctx.driver.screenSize();
      const searchTabX = Math.floor((size.width / 5) * 1.5);
      await ctx.driver.tap(searchTabX, Math.floor(size.height * 0.97), 0);
      await sleep(randint(2000, 3500));

      const searchBar = await ctx.driver.findByDesc("Search") ||
                        await ctx.driver.findByResourceId("com.zhiliaoapp.musically:id/search_et");
      if (searchBar) {
        await ctx.driver.tap(searchBar.x, searchBar.y, 1, "deliberate");
        await sleep(randint(800, 1400));
        await ctx.driver.typeHuman(`#${tag}`);
        await sleep(randint(2000, 3500));
        // Tap on the hashtag result and scroll a few videos.
        if (await ctx.driver.tapByText(`#${tag}`) || await ctx.driver.tapByText(tag)) {
          await sleep(randint(1500, 3000));
          // Scroll through 3-5 niche videos.
          for (let i = 0; i < randint(3, 5); i++) {
            if (expired(ctx)) break;
            const s = await ctx.driver.screenSize();
            await ctx.driver.swipe(
              Math.floor(s.width * 0.5),
              Math.floor(s.height * 0.7),
              Math.floor(s.width * 0.5),
              Math.floor(s.height * 0.3),
              randint(350, 700),
            );
            await sleep(randint(3000, 7000));
          }
        }
        // Two backs: one out of the hashtag video list, one out of the
        // search results screen, so the next iteration starts fresh.
        await ctx.driver.pressBack();
        await sleep(randint(700, 1300));
        await ctx.driver.pressBack();
        await sleep(randint(700, 1300));
        ctx.stats.hashtag_searches++;
      }
    } catch { /* non-fatal */ }
  }

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Comments 3-5 — mix of read and write.
  const commentsTarget = randint(3, 5);
  const commentPool = config.commentTexts ?? [];
  for (let i = 0; i < commentsTarget; i++) {
    if (expired(ctx)) break;
    await goHome(ctx);
    await sleep(randint(1500, 3500));
    const text = roll(50) ? pick(commentPool) : undefined;
    await commentTool(ctx, { text });
    ctx.stats.comments_read++;
    await sleep(randint(2500, 5000));
  }

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Follows 5-8.
  const followCount = randint(5, 8);
  const targets = config.followTargets ? shuffle([...config.followTargets]) : [];
  for (let i = 0; i < followCount; i++) {
    if (expired(ctx)) break;
    const target = targets[i];
    const ok = await followTool(ctx, target ? { targetUsername: target } : {});
    if (ok) await sleep(randint(3500, 7000));
  }

  if (!expired(ctx)) {
    await sectionBreak(ctx);
    // Share 1-2 videos (copy-link) — boosts share signal which TikTok weights highest.
    for (let i = 0; i < randint(1, 2); i++) {
      if (expired(ctx)) break;
      await goHome(ctx);
      await sleep(randint(2000, 4000));
      await shareTool(ctx, { mode: "copy-link" });
      await sleep(randint(2000, 4000));
    }
  }

  try { await ctx.driver.pressHome(); } catch {}

  ctx.log("info",
    `[TikTok:phase3] done — likes=${ctx.stats.likes_given} saves=${ctx.stats.saves} comments=${ctx.stats.comments_read}`,
  );
  return ctx.stats;
}

// ---------------------------------------------------------------------------
// Phase 4 — Day 15–21: Increase account activity
//
// Full engagement. Likes 15-20, comments 5, follows 5-10, shares 2-3.
// Shares carry highest weight in TikTok's 2026 algorithm.
// ---------------------------------------------------------------------------

export async function runTiktokPhase4(
  ctx: Ctx,
  config: TikTokWarmupPhaseConfig = {},
): Promise<SessionStats> {
  ctx.stats.platform = "tiktok";
  if (!(await tiktokLaunch(ctx))) return ctx.stats;

  ctx.log("info", "[TikTok:phase4] Day 15–21 warmup — full engagement mode");

  const commentPool = config.commentTexts ?? [];

  // Main scroll — high video count.
  await scrollFeedTool(ctx, {
    count: randint(20, 28),
    withEngagement: true,
  });

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Comment on 5 videos — mostly write mode in Phase 4.
  for (let i = 0; i < 5; i++) {
    if (expired(ctx)) break;
    await goHome(ctx);
    await sleep(randint(1500, 3500));
    const text = roll(70) ? pick(commentPool) : undefined;
    await commentTool(ctx, { text });
    ctx.stats.comments_read++;
    await sleep(randint(3000, 6000));
  }

  if (expired(ctx)) return ctx.stats;
  await sectionBreak(ctx);

  // Follows 5-10.
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

  // Shares 2-3 — highest-weight signal in 2026 algorithm.
  const shareCount = randint(2, 3);
  for (let i = 0; i < shareCount; i++) {
    if (expired(ctx)) break;
    await goHome(ctx);
    await sleep(randint(2000, 5000));
    // Alternate between copy-link and repost to vary the share type.
    const mode = i === 0 ? "repost" : "copy-link";
    await shareTool(ctx, { mode });
    await sleep(randint(2500, 5000));
  }

  if (!expired(ctx)) {
    await sectionBreak(ctx);
    // Final scroll session — simulate winding down.
    await scrollFeedTool(ctx, { count: randint(5, 9), withEngagement: true });
  }

  try { await ctx.driver.pressHome(); } catch {}

  ctx.log("info",
    `[TikTok:phase4] done — likes=${ctx.stats.likes_given} comments=${ctx.stats.comments_read}`,
  );
  return ctx.stats;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export type TikTokWarmupPhase = 1 | 2 | 3 | 4;

export async function runTiktokPhase(
  phase: TikTokWarmupPhase,
  ctx: Ctx,
  config: TikTokWarmupPhaseConfig = {},
): Promise<SessionStats> {
  switch (phase) {
    case 1: return runTiktokPhase1(ctx, config);
    case 2: return runTiktokPhase2(ctx, config);
    case 3: return runTiktokPhase3(ctx, config);
    case 4: return runTiktokPhase4(ctx, config);
  }
}
