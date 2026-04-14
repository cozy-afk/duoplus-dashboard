/**
 * Instagram — Reels Watching Tool
 *
 * Opens the Reels tab and watches videos with interest-based watch times,
 * probabilistic likes, and occasional comment reads.
 */

import { sleep, randint, roll } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe, expired } from "../../../human.ts";
import { igGoToTab } from "../nav.ts";

export interface ReelsConfig {
  /** Number of reels to watch. Defaults to quota range. */
  count?: number;
}

export async function reelsTool(c: Ctx, config: ReelsConfig = {}): Promise<void> {
  const count = config.count ?? randint(c.quota.reels_min, c.quota.reels_max);
  if (count <= 0) return;
  c.log("info", `  [IG:reels] × ${count}`);

  await safe(c, "reels tab", async () => {
    await igGoToTab(c, "reels");
    c.stats.tab_switches++;
    await sleep(randint(2800, 5200));
    const size = await c.driver.screenSize();

    for (let i = 0; i < count; i++) {
      if (expired(c)) { c.stats.hit_deadline = true; return; }

      const r = Math.random();
      const watchMs =
        r < 0.30 ? randint(2500, 5500) :
        r < 0.80 ? randint(9000, 18000) :
                   randint(22000, 40000);
      // Buffer covers post-watch like/comment/swipe paths which can take
      // several seconds before the next sample of the watchdog.
      c.watchdog?.suppress(watchMs + 8000);
      await sleep(watchMs);
      c.stats.reels_watched++;

      if (roll(24)) {
        if (await c.driver.tapByDesc("Turn sound on")) c.stats.unmutes++;
      }

      if (c.stats.likes_given < c.quota.likes_per_session && roll(14)) {
        if (roll(55)) {
          await c.driver.doubleTap(
            Math.floor(size.width / 2),
            Math.floor(size.height * 0.45),
          );
          c.stats.likes_given++;
        } else if (await c.driver.tapByDesc("Like")) {
          c.stats.likes_given++;
        }
        await sleep(randint(1200, 2800));
      }

      if (roll(8)) {
        if (await c.driver.tapByDesc("Comment")) {
          await sleep(randint(2500, 5500));
          if (roll(60)) await c.driver.swipeUp(0.4);
          await sleep(randint(2000, 4000));
          await c.driver.pressBack();
          await sleep(randint(1200, 2200));
        }
      }

      const reelMode = roll(25) ? "flick" : "normal";
      const startY = randint(1500, 1750);
      const endY = startY - randint(700, 1000);
      const xReel = Math.floor(size.width / 2) + randint(-60, 60);
      if (reelMode === "flick") {
        await c.driver.swipe(xReel, startY, xReel, endY, randint(120, 200));
      } else {
        await c.driver.swipe(xReel, startY, xReel, endY, randint(260, 420));
      }
      await sleep(randint(400, 1200));
    }
  });
}
