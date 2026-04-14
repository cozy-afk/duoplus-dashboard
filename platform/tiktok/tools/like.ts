/**
 * TikTok — Like Tool
 * Double-tap or tap the Like button on the current video.
 */

import { sleep, randint, roll } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";

export interface TikTokLikeConfig {
  preferDoubleTap?: boolean;
}

export async function likeTool(c: Ctx, config: TikTokLikeConfig = {}): Promise<boolean> {
  if (c.stats.likes_given >= c.quota.likes_per_session) return false;
  let liked = false;
  await safe(c, "tiktok like", async () => {
    // Prefer the labelled Like button: TikTok flips its content-desc between
    // "Like" and "Unlike" based on state, so tapByDesc("Like") is a safe
    // toggle ON. Double-tap, by contrast, will UNLIKE if we already liked
    // the video. Only fall back to double-tap if the desc isn't present.
    const xml = await c.driver.dumpUi();
    const likeVisible = /content-desc="Like"/.test(xml);
    const unlikeVisible = /content-desc="Unlike"/.test(xml);
    if (unlikeVisible) {
      // Already liked — don't toggle off.
      return;
    }
    if (likeVisible && await c.driver.tapByDesc("Like", xml)) {
      c.stats.likes_given++;
      liked = true;
      await sleep(randint(1000, 2200));
      return;
    }
    // Last resort: double-tap. Skip when preferDoubleTap===false.
    if (config.preferDoubleTap !== false && roll(55)) {
      const size = await c.driver.screenSize();
      await c.driver.doubleTap(Math.floor(size.width / 2), Math.floor(size.height * 0.5));
      c.stats.likes_given++;
      liked = true;
      await sleep(randint(1100, 2400));
    }
  });
  return liked;
}
