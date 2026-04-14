/**
 * TikTok — Comment Tool
 * Read mode: opens comments section and scrolls. Write mode: posts a comment.
 */

import { sleep, randint, roll, humanReadMs } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe, dwell } from "../../../human.ts";

export interface TikTokCommentConfig {
  text?: string;
}

export async function commentTool(c: Ctx, config: TikTokCommentConfig = {}): Promise<boolean> {
  let acted = false;

  if (config.text) {
    c.log("info", `  [TikTok:comment] posting comment`);
    await safe(c, "tiktok post comment", async () => {
      if (!(await c.driver.tapByDesc("Comments"))) return;
      await sleep(randint(2000, 3500));

      const inputField = await c.driver.findByResourceId("com.zhiliaoapp.musically:id/aoa") ||
                         await c.driver.findByDesc("Add comment");
      if (inputField) {
        await c.driver.tap(inputField.x, inputField.y, 1, "deliberate");
        await sleep(randint(800, 1400));
      } else {
        const size = await c.driver.screenSize();
        await c.driver.tap(Math.floor(size.width * 0.5), Math.floor(size.height * 0.92), 1, "deliberate");
        await sleep(randint(800, 1400));
      }

      await c.driver.typeHuman(config.text!);
      await sleep(randint(1000, 2000));

      if (await c.driver.tapByDesc("Send") || await c.driver.tapByText("Post")) {
        acted = true;
        await sleep(randint(2000, 3500));
      }
      if (roll(60)) await c.driver.swipeDown();
      else await c.driver.pressBack();
      await sleep(randint(1300, 2500));
    });
  } else {
    c.log("info", "  [TikTok:comment] reading comments");
    await safe(c, "tiktok read comments", async () => {
      if (!(await c.driver.tapByDesc("Comments"))) return;
      await sleep(randint(2000, 3800));
      const scrolls = randint(1, 5);
      for (let k = 0; k < scrolls; k++) {
        await c.driver.swipeUp(randint(40, 85) / 100);
        await dwell(c, humanReadMs());
      }
      c.stats.comments_read++;
      acted = true;
      if (roll(60)) await c.driver.swipeDown();
      else await c.driver.pressBack();
      await sleep(randint(1300, 2500));
    });
  }

  return acted;
}
