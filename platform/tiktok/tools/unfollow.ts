/**
 * TikTok — Unfollow Tool
 */

import { sleep, randint } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";

export interface TikTokUnfollowConfig {
  targetUsername?: string;
}

export async function unfollowTool(c: Ctx, config: TikTokUnfollowConfig = {}): Promise<boolean> {
  let unfollowed = false;

  await safe(c, "tiktok unfollow", async () => {
    if (config.targetUsername) {
      c.log("info", `  [TikTok:unfollow] navigating to @${config.targetUsername}`);
      const size = await c.driver.screenSize();
      const searchTabX = Math.floor((size.width / 5) * 1.5);
      await c.driver.tap(searchTabX, Math.floor(size.height * 0.97), 0);
      await sleep(randint(1800, 3200));

      const searchBar = await c.driver.findByDesc("Search") ||
                        await c.driver.findByResourceId("com.zhiliaoapp.musically:id/search_et");
      if (!searchBar) return;
      await c.driver.tap(searchBar.x, searchBar.y, 1, "deliberate");
      await sleep(randint(800, 1400));
      await c.driver.typeHuman(config.targetUsername);
      await sleep(randint(2000, 3500));
      await c.driver.tapByText("Users");
      await sleep(randint(800, 1400));

      const result = await c.driver.findByText(config.targetUsername);
      if (!result) {
        await c.driver.pressBack();
        return;
      }
      await c.driver.tap(result.x, result.y, 1, "normal");
      await sleep(randint(2500, 4000));
    }

    // "Following" button indicates we're already following.
    const followingBtn = await c.driver.findByText("Following") ||
                         await c.driver.findByDesc("Following");
    if (!followingBtn) {
      if (config.targetUsername) await c.driver.pressBack();
      return;
    }
    await c.driver.tap(followingBtn.x, followingBtn.y, 1, "deliberate");
    await sleep(randint(1200, 2200));

    // Confirm unfollow dialog.
    const confirmBtn = await c.driver.findByText("Unfollow") || await c.driver.findByDesc("Unfollow");
    if (confirmBtn) {
      await c.driver.tap(confirmBtn.x, confirmBtn.y, 1, "deliberate");
      unfollowed = true;
      await sleep(randint(1500, 2800));
    }

    if (config.targetUsername) {
      await c.driver.pressBack();
      await sleep(randint(1000, 1800));
    }
  });

  return unfollowed;
}
