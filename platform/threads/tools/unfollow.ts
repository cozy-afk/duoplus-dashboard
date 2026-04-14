/**
 * Threads — Unfollow Tool
 */

import { sleep, randint } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";
import { threadsGoToTab } from "../nav.ts";

export interface ThreadsUnfollowConfig {
  targetUsername?: string;
}

export async function unfollowTool(c: Ctx, config: ThreadsUnfollowConfig = {}): Promise<boolean> {
  let unfollowed = false;

  await safe(c, "threads unfollow", async () => {
    if (config.targetUsername) {
      await threadsGoToTab(c, "search");
      c.stats.tab_switches++;
      await sleep(randint(1800, 3200));

      const searchField = await c.driver.findByDesc("Search");
      if (!searchField) return;
      await c.driver.tap(searchField.x, searchField.y, 1, "deliberate");
      await sleep(randint(800, 1400));
      await c.driver.typeHuman(config.targetUsername);
      await sleep(randint(2000, 3500));

      const result = await c.driver.findByText(config.targetUsername);
      if (!result) {
        c.log("warn", `  [Threads:unfollow] @${config.targetUsername} not found`);
        await c.driver.pressBack();
        return;
      }
      await c.driver.tap(result.x, result.y, 1, "normal");
      await sleep(randint(2500, 4000));
    }

    const followingBtn = await c.driver.findByText("Following") || await c.driver.findByDesc("Following");
    if (!followingBtn) {
      c.log("warn", "  [Threads:unfollow] Following button not visible");
      if (config.targetUsername) await c.driver.pressBack();
      return;
    }
    await c.driver.tap(followingBtn.x, followingBtn.y, 1, "deliberate");
    await sleep(randint(1200, 2200));

    // Confirm unfollow dialog if shown.
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
