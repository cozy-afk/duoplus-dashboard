/**
 * TikTok — Follow Tool
 */

import { sleep, randint } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";

export interface TikTokFollowConfig {
  /** Username to search for and follow. If omitted, taps Follow on current profile. */
  targetUsername?: string;
}

function matchExact(xml: string, attr: "text" | "content-desc", value: string): { x: number; y: number } | null {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<node[^/]*?${attr}="${escaped}"[^/]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
    "i",
  );
  const m = xml.match(re);
  if (!m) return null;
  return {
    x: Math.floor((+m[1] + +m[3]) / 2),
    y: Math.floor((+m[2] + +m[4]) / 2),
  };
}

export async function followTool(c: Ctx, config: TikTokFollowConfig = {}): Promise<boolean> {
  let followed = false;

  await safe(c, "tiktok follow", async () => {
    if (config.targetUsername) {
      c.log("info", `  [TikTok:follow] searching @${config.targetUsername}`);
      // Navigate to Discover/Search tab (slot 1 in TikTok bottom nav).
      const size = await c.driver.screenSize();
      const searchTabX = Math.floor((size.width / 5) * 1.5);
      const searchTabY = Math.floor(size.height * 0.97);
      await c.driver.tap(searchTabX, searchTabY, 0);
      await sleep(randint(1800, 3200));

      const searchBar = await c.driver.findByDesc("Search") ||
                        await c.driver.findByResourceId("com.zhiliaoapp.musically:id/search_et");
      if (!searchBar) return;
      await c.driver.tap(searchBar.x, searchBar.y, 1, "deliberate");
      await sleep(randint(800, 1400));
      await c.driver.typeHuman(config.targetUsername);
      await sleep(randint(2000, 3500));

      // Tap Users tab if shown, then first result.
      await c.driver.tapByText("Users");
      await sleep(randint(800, 1400));

      const result = await c.driver.findByText(config.targetUsername);
      if (!result) {
        c.log("warn", `  [TikTok:follow] @${config.targetUsername} not found`);
        await c.driver.pressBack();
        return;
      }
      await c.driver.tap(result.x, result.y, 1, "normal");
      await sleep(randint(2500, 4000));
    }

    // findByText/findByDesc do substring matching, so "Follow" matches
    // "Following" — tapping it would unfollow an account we already follow.
    // Walk the dump with anchored regexes so we only fire on exact "Follow".
    const xmlNow = await c.driver.dumpUi();
    const followBtn = matchExact(xmlNow, "text", "Follow") ||
                      matchExact(xmlNow, "content-desc", "Follow");
    if (!followBtn) {
      c.log("warn", "  [TikTok:follow] no exact 'Follow' button visible (already following?)");
      if (config.targetUsername) await c.driver.pressBack();
      return;
    }
    await c.driver.tap(followBtn.x, followBtn.y, 1, "deliberate");
    followed = true;
    await sleep(randint(1500, 3000));

    if (config.targetUsername) {
      await c.driver.pressBack();
      await sleep(randint(1000, 1800));
    }
  });

  return followed;
}
