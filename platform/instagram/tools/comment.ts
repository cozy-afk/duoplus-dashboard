/**
 * Instagram — Comment Tool
 *
 * Two modes:
 *   1. Read mode (no text): opens the comment section and scrolls through it.
 *   2. Write mode (text provided): opens comments, types the message, submits.
 *
 * Both modes work on the currently visible post/reel.
 */

import { sleep, randint, roll, humanReadMs } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe, dwell } from "../../../human.ts";

export interface CommentConfig {
  /**
   * Text to post as a comment. If omitted, the tool reads/scrolls comments
   * without posting anything.
   */
  text?: string;
}

/**
 * Read comments on the currently visible post (no text posted).
 * Returns true if the comment sheet was opened successfully.
 */
async function readComments(c: Ctx): Promise<boolean> {
  let opened = false;
  await safe(c, "read comments", async () => {
    const cmt = await c.driver.findByDesc("Comment");
    if (!cmt) return;
    await c.driver.tap(cmt.x, cmt.y, 1, "deliberate");
    await sleep(randint(2200, 4500));
    const scrolls = randint(2, 6);
    for (let k = 0; k < scrolls; k++) {
      await c.driver.swipeUp(randint(40, 80) / 100);
      await dwell(c, humanReadMs());
      if (roll(12)) break;
    }
    c.stats.comments_read++;
    opened = true;
    if (roll(50)) await c.driver.swipeDown();
    else await c.driver.pressBack();
    await sleep(randint(1300, 2600));
  });
  return opened;
}

/**
 * Post a comment on the currently visible post.
 * Returns true if the comment was submitted successfully.
 */
async function postComment(c: Ctx, text: string): Promise<boolean> {
  let posted = false;
  await safe(c, "post comment", async () => {
    const cmt = await c.driver.findByDesc("Comment");
    if (!cmt) return;
    await c.driver.tap(cmt.x, cmt.y, 1, "deliberate");
    await sleep(randint(2000, 3500));

    // Find the comment input field.
    const inputField = await c.driver.findByResourceId("com.instagram.android:id/layout_comment_thread_edittext");
    if (!inputField) {
      // Fallback: tap bottom area where comment box typically appears.
      const size = await c.driver.screenSize();
      await c.driver.tap(
        Math.floor(size.width * 0.5),
        Math.floor(size.height * 0.92),
        1,
        "deliberate",
      );
      await sleep(randint(1200, 2000));
    } else {
      await c.driver.tap(inputField.x, inputField.y, 1, "deliberate");
      await sleep(randint(800, 1500));
    }

    await c.driver.typeHuman(text);
    await sleep(randint(1000, 2000));

    // Tap "Post" / send button.
    const posted_ = await c.driver.tapByText("Post") || await c.driver.tapByDesc("Send");
    if (posted_) {
      posted = true;
      await sleep(randint(2000, 3500));
    }

    await c.driver.pressBack();
    await sleep(randint(1200, 2000));
  });
  return posted;
}

export async function commentTool(c: Ctx, config: CommentConfig = {}): Promise<boolean> {
  if (config.text) {
    c.log("info", `  [IG:comment] posting comment (${config.text.length} chars)`);
    return postComment(c, config.text);
  }
  c.log("info", "  [IG:comment] reading comments");
  return readComments(c);
}
