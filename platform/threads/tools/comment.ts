/**
 * Threads — Comment Tool
 *
 * Read mode (no text): opens a thread and scrolls the replies.
 * Write mode (text): opens the reply composer and submits a reply.
 */

import { sleep, randint, roll, humanReadMs } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe, dwell } from "../../../human.ts";

export interface ThreadsCommentConfig {
  /** Reply text to post. If omitted, reads replies without posting. */
  text?: string;
}

export async function commentTool(c: Ctx, config: ThreadsCommentConfig = {}): Promise<boolean> {
  let acted = false;

  if (config.text) {
    c.log("info", `  [Threads:comment] replying (${config.text.length} chars)`);
    await safe(c, "thread reply", async () => {
      const replyBtn = await c.driver.findByDesc("Reply") || await c.driver.findByText("Reply");
      if (!replyBtn) return;
      await c.driver.tap(replyBtn.x, replyBtn.y, 1, "deliberate");
      await sleep(randint(1500, 2800));

      const inputField = await c.driver.findByResourceId("com.instagram.barcelona:id/reply_edittext") ||
                         await c.driver.findByDesc("Reply to this thread");
      if (inputField) {
        await c.driver.tap(inputField.x, inputField.y, 1, "deliberate");
        await sleep(randint(800, 1400));
      }
      await c.driver.typeHuman(config.text!);
      await sleep(randint(1000, 2000));

      if (await c.driver.tapByText("Post") || await c.driver.tapByDesc("Send")) {
        acted = true;
        await sleep(randint(2000, 3500));
      }
      await c.driver.pressBack();
      await sleep(randint(1200, 2000));
    });
  } else {
    c.log("info", "  [Threads:comment] reading replies");
    await safe(c, "thread read replies", async () => {
      const size = await c.driver.screenSize();
      await c.driver.tap(
        Math.floor(size.width / 2) + randint(-120, 120),
        Math.floor(size.height * randint(35, 55) / 100),
        1,
        "normal",
      );
      await sleep(randint(2400, 4800));
      const scrolls = randint(1, 4);
      for (let k = 0; k < scrolls; k++) {
        await c.driver.swipeUp(randint(40, 70) / 100);
        await dwell(c, humanReadMs());
        if (roll(15)) break;
      }
      c.stats.comments_read++;
      acted = true;
      await c.driver.pressBack();
      await sleep(randint(1400, 2600));
    });
  }

  return acted;
}
