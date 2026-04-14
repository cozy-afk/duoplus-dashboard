/**
 * TikTok — Scroll Feed Tool (For You / Home feed)
 *
 * Scrolls the TikTok For You feed with interest-based video watch times,
 * likes, saves, and comment reads. This is the primary TikTok engagement loop.
 */

import { sleep, randint, roll, humanReadMs } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe, dwell, humanIdle, notificationPeek, expired } from "../../../human.ts";
import { postInterest, type PostInterest, AD_MARKER_RE } from "../../../feed-patterns.ts";

export interface TikTokScrollFeedConfig {
  /** Number of videos to scroll through. Defaults to quota reels range. */
  count?: number;
  /** Enable likes/saves/comments during the loop. Default: true */
  withEngagement?: boolean;
}

export async function scrollFeedTool(c: Ctx, config: TikTokScrollFeedConfig = {}): Promise<void> {
  const count = config.count ?? randint(c.quota.reels_min, c.quota.reels_max);
  const withEngagement = config.withEngagement ?? true;
  c.log("info", `  [TikTok:scroll-feed] × ${count}`);

  await sleep(randint(2400, 5000));
  const size = await c.driver.screenSize();
  let skipBurstRun = 0;

  for (let i = 0; i < count; i++) {
    if (expired(c)) { c.stats.hit_deadline = true; return; }

    let interest: PostInterest = postInterest();
    // TikTok viewers skim harder than IG/Threads.
    if (interest === "glance" && roll(25)) interest = "skip";

    if (interest !== "skip" && i % 3 === 1) {
      try {
        const xml = await c.driver.dumpUi();
        if (AD_MARKER_RE.test(xml)) interest = "skip";
      } catch { /* non-fatal */ }
    }

    // TikTok watch-time buckets.
    let watchMs: number;
    switch (interest) {
      case "skip":   watchMs = randint(1800, 4500); break;
      case "glance": watchMs = randint(5500, 11000); break;
      case "look":   watchMs = randint(13000, 24000); break;
      case "read":   watchMs = randint(28000, 50000); break;
      case "paused": watchMs = randint(60000, 100000); break;
    }
    c.watchdog?.suppress(watchMs + 3000);
    await sleep(watchMs);
    c.stats.reels_watched++;

    if (withEngagement && interest !== "skip") {
      const likesLeft = c.quota.likes_per_session - c.stats.likes_given;
      const likeP =
        interest === "paused" ? 45 :
        interest === "read"   ? 28 :
        interest === "look"   ? 14 : 5;
      if (likesLeft > 0 && roll(likeP)) {
        await safe(c, "tiktok like", async () => {
          if (roll(55)) {
            await c.driver.doubleTap(Math.floor(size.width / 2), Math.floor(size.height * 0.5));
            c.stats.likes_given++;
            await sleep(randint(1100, 2400));
          } else if (await c.driver.tapByDesc("Like")) {
            c.stats.likes_given++;
            await sleep(randint(1000, 2200));
          }
        });
      }

      if ((interest === "read" || interest === "paused") && roll(10)) {
        await safe(c, "tiktok save", async () => {
          if ((await c.driver.tapByDesc("Save")) || (await c.driver.tapByDesc("Add to favorites"))) {
            c.stats.saves++;
            await sleep(randint(1000, 2000));
          }
        });
      }

      const commentP = interest === "read" || interest === "paused" ? 22 : 5;
      if (roll(commentP)) {
        await safe(c, "tiktok comments", async () => {
          if (await c.driver.tapByDesc("Comments")) {
            await sleep(randint(2000, 3800));
            const scrolls = randint(1, 5);
            for (let k = 0; k < scrolls; k++) {
              await c.driver.swipeUp(randint(40, 85) / 100);
              await dwell(c, humanReadMs());
            }
            c.stats.comments_read++;
            if (roll(60)) await c.driver.swipeDown();
            else await c.driver.pressBack();
            await sleep(randint(1300, 2500));
          }
        });
      }

      await humanIdle(c, interest === "paused" ? 12 : 3, 18000, 60000);
      await notificationPeek(c, 2);
    }

    if (interest === "skip") skipBurstRun++;
    else skipBurstRun = 0;

    const useFlick = interest === "skip" || roll(30);
    const startY = randint(1500, 1750);
    const endY = startY - randint(700, 1000);
    const xTikTok = Math.floor(size.width / 2) + randint(-60, 60);
    if (useFlick) {
      await c.driver.swipe(xTikTok, startY, xTikTok, endY, randint(110, 190));
    } else {
      await c.driver.swipe(xTikTok, startY, xTikTok, endY, randint(280, 440));
    }
    await sleep(interest === "skip" ? randint(120, 400) : randint(400, 1200));
  }
}
