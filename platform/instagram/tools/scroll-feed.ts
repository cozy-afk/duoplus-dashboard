/**
 * Instagram — Scroll Feed Tool
 *
 * Scrolls the home feed with interest-based dwell times, ad detection,
 * and optional inline engagement (likes, comment reads, profile visits).
 */

import { sleep, randint, roll, humanReadMs } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe, dwell, humanIdle, microGlance, notificationPeek, maybeScrollBack, expired } from "../../../human.ts";
import { checkForFlagScreen } from "../../../safety.ts";
import { postInterest, dwellForInterest, type PostInterest, AD_MARKER_RE } from "../../../feed-patterns.ts";
import { igGoToTab } from "../nav.ts";

export interface ScrollFeedConfig {
  /** Number of feed scrolls. Defaults to quota range. */
  scrolls?: number;
  /** Enable like/comment/profile-visit engagement during scroll. Default: true */
  withEngagement?: boolean;
  /** Max likes to give during this scroll session. Default: quota.likes_per_session */
  maxLikes?: number;
}

export async function scrollFeedTool(c: Ctx, config: ScrollFeedConfig = {}): Promise<void> {
  const totalScrolls = config.scrolls ?? randint(c.quota.feed_scrolls_min, c.quota.feed_scrolls_max);
  const withEngagement = config.withEngagement ?? true;
  const maxLikes = config.maxLikes ?? c.quota.likes_per_session;

  c.log("info", `  [IG:scroll-feed] × ${totalScrolls}${withEngagement ? "" : " (no engagement)"}`);
  await igGoToTab(c, "home");
  await sleep(randint(2800, 6500));

  let skipBurstRun = 0;
  for (let i = 0; i < totalScrolls; i++) {
    if (expired(c)) { c.stats.hit_deadline = true; return; }
    if (i > 0 && i % 4 === 0) await checkForFlagScreen(c);

    let interest: PostInterest = postInterest();
    if (interest !== "skip" && i % 3 === 1) {
      try {
        const xml = await c.driver.dumpUi();
        if (AD_MARKER_RE.test(xml)) interest = "skip";
      } catch { /* non-fatal */ }
    }

    await safe(c, "feed scroll", async () => {
      if (interest === "skip") await c.driver.swipeUp(1.05);
      else await c.driver.swipeUp();
      c.stats.feed_scrolls++;
      const dwellMs = dwellForInterest(interest);
      if (interest !== "skip") c.watchdog?.suppress(dwellMs + 3000);
      await sleep(dwellMs);
    });

    if (interest === "skip") {
      skipBurstRun++;
      if (skipBurstRun >= 3) skipBurstRun = 0;
      continue;
    }
    skipBurstRun = 0;

    await microGlance(c, 12);
    if (interest === "look" || interest === "read" || interest === "paused") {
      await maybeScrollBack(c);
    }
    await notificationPeek(c, 2);
    await humanIdle(c, interest === "read" || interest === "paused" ? 10 : 4);

    if (!withEngagement) continue;

    if (interest === "look" || interest === "read" || interest === "paused") {
      // Probabilistic like.
      const remaining = totalScrolls - i;
      const likesLeft = maxLikes - c.stats.likes_given;
      if (likesLeft > 0 && remaining > 0) {
        const engagedRemaining = Math.max(1, Math.floor(remaining * 0.45));
        const p = Math.min(55, Math.ceil((likesLeft / engagedRemaining) * 100));
        if (roll(p)) {
          await safe(c, "feed like", async () => {
            const size = await c.driver.screenSize();
            if (roll(40)) {
              await c.driver.doubleTap(
                Math.floor(size.width / 2),
                Math.floor(size.height * randint(40, 58) / 100),
              );
              c.stats.likes_given++;
              await sleep(randint(1400, 3000));
            } else if (await c.driver.tapByDesc("Like")) {
              c.stats.likes_given++;
              await sleep(randint(1500, 3500));
            }
          });
        }
      }

      // Probabilistic comment read.
      const commentP = interest === "read" || interest === "paused" ? 35 : 9;
      if (c.stats.comments_read < Math.max(1, c.quota.comments_per_session * 3) && roll(commentP)) {
        await safe(c, "read comments", async () => {
          const cmt = await c.driver.findByDesc("Comment");
          if (!cmt) return;
          await c.driver.tap(cmt.x, cmt.y, 1, "deliberate");
          await sleep(randint(2200, 4500));
          const scrolls = randint(2, 6);
          for (let k = 0; k < scrolls; k++) {
            await c.driver.swipeUp(randint(40, 80) / 100);
            await dwell(c, humanReadMs());
            if (roll(12)) break;
          }
          c.stats.comments_read++;
          if (roll(50)) await c.driver.swipeDown();
          else await c.driver.pressBack();
          await sleep(randint(1300, 2600));
        });
      }

      // Probabilistic profile visit.
      const profileP = interest === "read" || interest === "paused" ? 18 : 5;
      if (roll(profileP)) {
        await safe(c, "profile visit", async () => {
          const pic = await c.driver.findByDesc("profile picture");
          if (!pic) return;
          await c.driver.tap(pic.x, pic.y, 1, "deliberate");
          c.stats.profile_visits++;
          await sleep(randint(2500, 5500));
          const exploreStyle = Math.random();
          if (exploreStyle < 0.6) {
            const scrolls = randint(2, 4);
            for (let k = 0; k < scrolls; k++) {
              await c.driver.swipeUp(0.6);
              await sleep(randint(2600, 6500));
            }
          } else if (exploreStyle < 0.85) {
            const size = await c.driver.screenSize();
            await c.driver.tap(
              Math.floor(size.width * randint(16, 84) / 100),
              Math.floor(size.height * randint(45, 70) / 100),
              1,
              "normal",
            );
            await sleep(randint(3000, 7000));
            if (roll(40)) {
              await c.driver.swipeUp(0.5);
              await sleep(randint(2500, 5000));
            }
            await c.driver.pressBack();
            await sleep(randint(1500, 2800));
          }
          await c.driver.pressBack();
          await sleep(randint(1200, 2800));
        });
      }
    }
  }
}
