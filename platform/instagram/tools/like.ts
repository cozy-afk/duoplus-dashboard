/**
 * Instagram — Like Tool
 *
 * Likes the currently visible post. Can double-tap or tap the Like button.
 * Designed to be called from within a feed/reels loop or standalone.
 */

import { sleep, randint, roll } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";

export interface LikeConfig {
  /** Prefer double-tap gesture over tapping the heart button. Default: random (40% double-tap) */
  preferDoubleTap?: boolean;
}

/**
 * Like the currently visible post/reel. Returns true if a like was given.
 */
export async function likeTool(c: Ctx, config: LikeConfig = {}): Promise<boolean> {
  if (c.stats.likes_given >= c.quota.likes_per_session) return false;

  let liked = false;
  await safe(c, "like", async () => {
    const useDoubleTap = config.preferDoubleTap ?? roll(40);
    if (useDoubleTap) {
      const size = await c.driver.screenSize();
      await c.driver.doubleTap(
        Math.floor(size.width / 2),
        Math.floor(size.height * randint(40, 58) / 100),
      );
      c.stats.likes_given++;
      liked = true;
      await sleep(randint(1400, 3000));
    } else if (await c.driver.tapByDesc("Like")) {
      c.stats.likes_given++;
      liked = true;
      await sleep(randint(1500, 3500));
    }
  });
  return liked;
}
