/**
 * Threads — Share Tool
 * Shares the currently visible thread via the share/repost menu.
 */

import { sleep, randint } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";

export interface ThreadsShareConfig {
  /** Username to share to via DM. If omitted, uses repost/copy-link. */
  targetUsername?: string;
  /** "repost" | "dm" | "copy-link". Default: "repost" */
  mode?: "repost" | "dm" | "copy-link";
}

export async function shareTool(c: Ctx, config: ThreadsShareConfig = {}): Promise<boolean> {
  const mode = config.mode ?? "repost";
  c.log("info", `  [Threads:share] mode=${mode}`);
  let shared = false;

  await safe(c, "threads share", async () => {
    const shareBtn = await c.driver.findByDesc("Share") ||
                     await c.driver.findByDesc("Repost") ||
                     await c.driver.findByDesc("More options");
    if (!shareBtn) {
      c.log("warn", "  [Threads:share] share/repost button not found");
      return;
    }
    await c.driver.tap(shareBtn.x, shareBtn.y, 1, "deliberate");
    await sleep(randint(1500, 2800));

    if (mode === "repost") {
      if (await c.driver.tapByText("Repost") || await c.driver.tapByDesc("Repost")) {
        shared = true;
        await sleep(randint(1500, 2500));
      }
    } else if (mode === "copy-link") {
      if (await c.driver.tapByText("Copy link")) {
        shared = true;
        await sleep(randint(800, 1400));
      }
    } else if (mode === "dm" && config.targetUsername) {
      if (await c.driver.tapByText("Send via Direct")) {
        await sleep(randint(2000, 3500));
        const searchField = await c.driver.findByDesc("Search");
        if (searchField) {
          await c.driver.tap(searchField.x, searchField.y, 1, "deliberate");
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
    }

    if (!shared) await c.driver.pressBack();
    await sleep(randint(1000, 1800));
  });

  return shared;
}
