/**
 * TikTok — Share Tool
 * Shares the currently playing video via the share sheet.
 */

import { sleep, randint } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";

export interface TikTokShareConfig {
  /** Username to send via DM. If omitted, copies link or shares to first suggested. */
  targetUsername?: string;
  /** "dm" | "copy-link" | "repost". Default: "copy-link" */
  mode?: "dm" | "copy-link" | "repost";
}

export async function shareTool(c: Ctx, config: TikTokShareConfig = {}): Promise<boolean> {
  const mode = config.mode ?? "copy-link";
  c.log("info", `  [TikTok:share] mode=${mode}`);
  let shared = false;

  await safe(c, "tiktok share", async () => {
    const shareBtn = await c.driver.findByDesc("Share") ||
                     await c.driver.findByDesc("Share video");
    if (!shareBtn) {
      c.log("warn", "  [TikTok:share] Share button not found");
      return;
    }
    await c.driver.tap(shareBtn.x, shareBtn.y, 1, "deliberate");
    await sleep(randint(1500, 2800));

    if (mode === "copy-link") {
      if (await c.driver.tapByText("Copy link") || await c.driver.tapByDesc("Copy link")) {
        shared = true;
        await sleep(randint(800, 1400));
      }
    } else if (mode === "repost") {
      if (await c.driver.tapByText("Repost") || await c.driver.tapByDesc("Repost")) {
        shared = true;
        await sleep(randint(1500, 2500));
      }
    } else if (mode === "dm" && config.targetUsername) {
      const searchField = await c.driver.findByDesc("Search") || await c.driver.findByText("Search");
      if (searchField) {
        await c.driver.tap(searchField.x, searchField.y, 1, "deliberate");
        await sleep(randint(800, 1400));
        await c.driver.typeHuman(config.targetUsername);
        await sleep(randint(2000, 3500));
        const result = await c.driver.findByText(config.targetUsername);
        if (result) {
          await c.driver.tap(result.x, result.y, 1, "normal");
          await sleep(randint(800, 1400));
          if (await c.driver.tapByText("Send") || await c.driver.tapByDesc("Send")) {
            shared = true;
            await sleep(randint(1500, 2800));
          }
        }
      }
    }

    if (!shared) await c.driver.pressBack();
    await sleep(randint(1000, 1800));
  });

  return shared;
}
