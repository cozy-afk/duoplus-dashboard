/**
 * Threads — Follow Tool
 */

import { sleep, randint } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";
import { threadsGoToTab } from "../nav.ts";

export interface ThreadsFollowConfig {
  /** Username to search and follow. If omitted, taps Follow on current profile. */
  targetUsername?: string;
}

export async function followTool(c: Ctx, config: ThreadsFollowConfig = {}): Promise<boolean> {
  let followed = false;

  await safe(c, "threads follow", async () => {
    if (config.targetUsername) {
      c.log("info", `  [Threads:follow] searching for @${config.targetUsername}`);
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
        c.log("warn", `  [Threads:follow] @${config.targetUsername} not found`);
        await c.driver.pressBack();
        return;
      }
      await c.driver.tap(result.x, result.y, 1, "normal");
      await sleep(randint(2500, 4000));
    }

    const followBtn = await c.driver.findByText("Follow") || await c.driver.findByDesc("Follow");
    if (!followBtn) {
      c.log("warn", "  [Threads:follow] Follow button not visible");
      if (config.targetUsername) await c.driver.pressBack();
      return;
    }
    await c.driver.tap(followBtn.x, followBtn.y, 1, "deliberate");
    followed = true;
    await sleep(randint(1500, 3000));
    c.log("info", `  [Threads:follow] followed${config.targetUsername ? ` @${config.targetUsername}` : ""}`);

    if (config.targetUsername) {
      await c.driver.pressBack();
      await sleep(randint(1000, 1800));
    }
  });

  return followed;
}
