/**
 * Instagram — Explore tab browsing with optional hashtag search.
 */

import { sleep, randint, roll, pick, humanBetweenScrollsMs, humanReadMs } from "../../device-driver.ts";
import type { Ctx } from "../../human.ts";
import { safe, dwell, microGlance, expired } from "../../human.ts";
import { igGoToTab } from "./nav.ts";

const HASHTAGS = [
  "travel", "food", "fitness", "nature", "photography", "coffee",
  "music", "art", "sunset", "fashion",
];

export interface ExploreConfig {
  /** Number of explore scrolls. Defaults to quota range. */
  scrolls?: number;
}

export async function igExplore(c: Ctx, config: ExploreConfig = {}): Promise<void> {
  const count = config.scrolls ?? randint(c.quota.explore_scrolls_min, c.quota.explore_scrolls_max);
  if (count <= 0) return;
  c.log("info", `  [IG] explore × ${count}`);

  await safe(c, "explore", async () => {
    await igGoToTab(c, "explore");
    c.stats.tab_switches++;
    await sleep(randint(2800, 5200));

    if (roll(32)) {
      await safe(c, "hashtag search", async () => {
        const bar = await c.driver.findByResourceId(
          "com.instagram.android:id/action_bar_search_edit_text",
        );
        if (bar) {
          await c.driver.tap(bar.x, bar.y, 1, "deliberate");
          await sleep(randint(1200, 2400));
          const tag = pick(HASHTAGS);
          await c.driver.typeHuman("#" + tag);
          await sleep(randint(2400, 5000));
          c.stats.hashtag_searches++;
          if (roll(30)) {
            const size = await c.driver.screenSize();
            await c.driver.tap(
              Math.floor(size.width * 0.5),
              Math.floor(size.height * randint(22, 36) / 100),
              1,
              "normal",
            );
            await sleep(randint(2800, 5500));
            await c.driver.pressBack();
            await sleep(randint(1200, 2400));
          }
          await c.driver.pressBack();
          await sleep(randint(1400, 2800));
        }
      });
    }

    for (let i = 0; i < count; i++) {
      if (expired(c)) { c.stats.hit_deadline = true; return; }
      await c.driver.swipeUp();
      c.stats.explore_scrolls++;
      await sleep(humanBetweenScrollsMs());
      if (roll(9)) {
        const size = await c.driver.screenSize();
        await c.driver.tap(
          Math.floor(size.width * randint(16, 84) / 100),
          Math.floor(size.height * randint(30, 70) / 100),
          1,
          "normal",
        );
        await dwell(c, humanReadMs());
        await c.driver.pressBack();
        await sleep(randint(1400, 2600));
      }
      await microGlance(c, 14);
    }
  });
}
