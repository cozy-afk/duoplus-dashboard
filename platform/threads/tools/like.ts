/**
 * Threads — Like Tool
 * Taps the Like (heart) button on the currently visible thread.
 */

import { sleep, randint } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";

export interface ThreadsLikeConfig {
  /** Override the session like quota. */
  maxLikes?: number;
}

export async function likeTool(c: Ctx, config: ThreadsLikeConfig = {}): Promise<boolean> {
  const maxLikes = config.maxLikes ?? c.quota.likes_per_session;
  if (c.stats.likes_given >= maxLikes) return false;

  let liked = false;
  await safe(c, "thread like", async () => {
    if (await c.driver.tapByDesc("Like")) {
      c.stats.likes_given++;
      liked = true;
      await sleep(randint(1500, 2800));
    }
  });
  return liked;
}
