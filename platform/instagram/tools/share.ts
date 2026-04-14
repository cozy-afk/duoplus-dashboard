/**
 * Instagram — Share Tool
 *
 * Shares the currently visible post/reel via the share sheet.
 * Two modes:
 *   1. targetUsername provided: share to that user's DM thread.
 *   2. No target: shares to the first suggested user / contact in the sheet.
 */

import { sleep, randint } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";

export interface ShareConfig {
  /**
   * Username to share to via DM. If omitted, taps the first suggested
   * contact in the share sheet.
   */
  targetUsername?: string;
}

/**
 * Share the currently visible post. Returns true if the share was sent.
 */
export async function shareTool(c: Ctx, config: ShareConfig = {}): Promise<boolean> {
  c.log("info", `  [IG:share] sharing post${config.targetUsername ? ` to @${config.targetUsername}` : ""}`);
  let shared = false;

  await safe(c, "share", async () => {
    // Tap the share/paper-plane icon on the current post.
    const shareBtn = await c.driver.findByDesc("Share") ||
                     await c.driver.findByDesc("Send post");
    if (!shareBtn) {
      c.log("warn", "  [IG:share] Share button not found on current post");
      return;
    }
    await c.driver.tap(shareBtn.x, shareBtn.y, 1, "deliberate");
    await sleep(randint(2000, 3500));

    if (config.targetUsername) {
      // Search for the target user in the share sheet.
      const searchField = await c.driver.findByResourceId("com.instagram.android:id/search_bar_input") ||
                          await c.driver.findByDesc("Search");
      if (searchField) {
        await c.driver.tap(searchField.x, searchField.y, 1, "deliberate");
        await sleep(randint(800, 1400));
        await c.driver.typeHuman(config.targetUsername);
        await sleep(randint(2000, 3500));
      }

      const userRow = await c.driver.findByText(config.targetUsername);
      if (userRow) {
        await c.driver.tap(userRow.x, userRow.y, 1, "deliberate");
        await sleep(randint(800, 1400));
      }
    }

    // Tap Send.
    const sendBtn = await c.driver.findByText("Send") ||
                    await c.driver.findByDesc("Send");
    if (sendBtn) {
      await c.driver.tap(sendBtn.x, sendBtn.y, 1, "deliberate");
      shared = true;
      await sleep(randint(1500, 2800));
      c.log("info", "  [IG:share] shared");
    }

    // Dismiss share sheet if still open.
    if (!shared) await c.driver.pressBack();
    await sleep(randint(1000, 1800));
  });

  return shared;
}
