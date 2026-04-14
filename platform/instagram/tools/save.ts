/**
 * Instagram — Save Tool
 *
 * Taps the bookmark icon on the currently visible post to save it.
 * Works on feed posts and reels.
 */

import { sleep, randint } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";

export interface SaveConfig {
  /** If true, unsave the post (tap bookmark again). Default: false */
  unsave?: boolean;
}

export async function saveTool(c: Ctx, config: SaveConfig = {}): Promise<boolean> {
  let saved = false;

  await safe(c, "ig save", async () => {
    // Instagram's bookmark button is described as "Save" when unsaved, "Remove" when saved.
    const label = config.unsave ? "Remove" : "Save";
    const btn = await c.driver.findByDesc(label) ||
                await c.driver.findByDesc(`${label} post`) ||
                await c.driver.findByDesc("Bookmark");

    if (!btn) {
      c.log("warn", "  [IG:save] bookmark button not found");
      return;
    }

    await c.driver.tap(btn.x, btn.y, 1, "deliberate");
    await sleep(randint(600, 1200));
    saved = true;
    c.stats.saves++;
    c.log("info", `  [IG:save] ${config.unsave ? "unsaved" : "saved"} post`);
  });

  return saved;
}
