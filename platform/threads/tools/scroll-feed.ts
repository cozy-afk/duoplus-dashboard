/**
 * Threads — Scroll Feed Tool
 *
 * Scrolls the Threads home feed with interest-based dwell times, ad
 * detection, and optional engagement (likes, thread reads, profile visits).
 */

import { sleep, randint, roll, humanReadMs } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe, dwell, humanIdle, microGlance, notificationPeek, expired } from "../../../human.ts";
import { postInterest, dwellForInterest, type PostInterest, AD_MARKER_RE } from "../../../feed-patterns.ts";
import { threadsGoToTab } from "../nav.ts";

export interface ThreadsScrollFeedConfig {
  /** Number of feed scrolls. Defaults to quota range. */
  scrolls?: number;
  /** Enable like/thread-read/profile engagement during scroll. Default: true */
  withEngagement?: boolean;
  /** Max likes to give. Default: quota.likes_per_session */
  maxLikes?: number;
}

export async function scrollFeedTool(c: Ctx, config: ThreadsScrollFeedConfig = {}): Promise<void> {
  const totalScrolls = config.scrolls ?? randint(c.quota.feed_scrolls_min, c.quota.feed_scrolls_max);
  const withEngagement = config.withEngagement ?? true;
  const maxLikes = config.maxLikes ?? c.quota.likes_per_session;

  c.log("info", `  [Threads:scroll-feed] × ${totalScrolls}`);
  await threadsGoToTab(c, "home");
  await sleep(randint(2400, 5200));

  let skipBurstRun = 0;
  for (let i = 0; i < totalScrolls; i++) {
    if (expired(c)) { c.stats.hit_deadline = true; return; }

    let interest: PostInterest = postInterest();
    if (interest !== "skip" && i % 3 === 1) {
      try {
        const xml = await c.driver.dumpUi();
        if (AD_MARKER_RE.test(xml)) interest = "skip";
      } catch { /* non-fatal */ }
    }

    await safe(c, "thread scroll", async () => {
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
    if ((interest === "look" || interest === "read") && roll(7)) {
      await c.driver.swipeDown();
      await sleep(randint(3000, 7500));
      await c.driver.swipeUp();
    }
    await notificationPeek(c, 2);
    await humanIdle(c, interest === "read" || interest === "paused" ? 9 : 3);

    if (!withEngagement) continue;

    if (interest === "look" || interest === "read" || interest === "paused") {
      // Like.
      const remaining = totalScrolls - i;
      const likesLeft = maxLikes - c.stats.likes_given;
      if (likesLeft > 0 && remaining > 0) {
        const engagedRemaining = Math.max(1, Math.floor(remaining * 0.45));
        const p = Math.min(32, Math.ceil((likesLeft / engagedRemaining) * 70));
        if (roll(p)) {
          await safe(c, "thread like", async () => {
            if (await c.driver.tapByDesc("Like")) {
              c.stats.likes_given++;
              await sleep(randint(1500, 2800));
            }
          });
        }
      }

      // Read thread.
      const threadP = interest === "read" || interest === "paused" ? 28 : 5;
      if (roll(threadP)) {
        await safe(c, "thread read", async () => {
          const size = await c.driver.screenSize();
          await c.driver.tap(
            Math.floor(size.width / 2) + randint(-120, 120),
            Math.floor(size.height * randint(35, 55) / 100),
            1,
            "normal",
          );
          await sleep(randint(2400, 4800));
          const scrolls = randint(1, 4);
          for (let k = 0; k < scrolls; k++) {
            await c.driver.swipeUp(randint(40, 70) / 100);
            await dwell(c, humanReadMs());
          }
          await c.driver.pressBack();
          await sleep(randint(1400, 2600));
        });
      }

      // Profile visit.
      const profileP = interest === "read" || interest === "paused" ? 14 : 4;
      if (roll(profileP)) {
        await safe(c, "thread profile visit", async () => {
          if (await c.driver.tapByDesc("profile photo")) {
            c.stats.profile_visits++;
            await sleep(randint(3200, 6500));
            if (roll(55)) {
              await c.driver.swipeUp(0.6);
              await sleep(randint(2400, 5000));
            }
            await c.driver.pressBack();
            await sleep(randint(1400, 2800));
          }
        });
      }
    }
  }
}
