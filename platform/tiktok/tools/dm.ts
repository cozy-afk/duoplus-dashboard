/**
 * TikTok — Direct Message Tool
 * Navigates to the inbox and sends a message to a target user.
 */

import { sleep, randint } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";

export interface TikTokDMConfig {
  targetUsername: string;
  message: string;
}

export async function dmTool(c: Ctx, config: TikTokDMConfig): Promise<boolean> {
  c.log("info", `  [TikTok:dm] messaging @${config.targetUsername}`);
  let sent = false;

  await safe(c, "tiktok dm", async () => {
    // Tap the Inbox tab (bottom nav, typically slot 3).
    const inboxBtn = await c.driver.findByDesc("Inbox") || await c.driver.findByText("Inbox");
    if (!inboxBtn) {
      c.log("warn", "  [TikTok:dm] Inbox tab not found");
      return;
    }
    await c.driver.tap(inboxBtn.x, inboxBtn.y, 1, "deliberate");
    await sleep(randint(2000, 3500));

    // Open the Direct Messages section.
    const directBtn = await c.driver.findByText("Direct messages") ||
                      await c.driver.findByDesc("Direct messages");
    if (directBtn) {
      await c.driver.tap(directBtn.x, directBtn.y, 1, "deliberate");
      await sleep(randint(1500, 2800));
    }

    // Search for the user.
    const searchBtn = await c.driver.findByDesc("Search") || await c.driver.findByText("Search");
    if (searchBtn) {
      await c.driver.tap(searchBtn.x, searchBtn.y, 1, "deliberate");
      await sleep(randint(800, 1400));
      await c.driver.typeHuman(config.targetUsername);
      await sleep(randint(2000, 3500));

      const userResult = await c.driver.findByText(config.targetUsername);
      if (!userResult) {
        c.log("warn", `  [TikTok:dm] @${config.targetUsername} not found`);
        await c.driver.pressBack();
        return;
      }
      await c.driver.tap(userResult.x, userResult.y, 1, "normal");
      await sleep(randint(2000, 3500));
    }

    // Type and send the message.
    const msgField = await c.driver.findByDesc("Send a message") ||
                     await c.driver.findByResourceId("com.zhiliaoapp.musically:id/chat_input");
    if (!msgField) {
      c.log("warn", "  [TikTok:dm] message input not found");
      await c.driver.pressBack();
      return;
    }
    await c.driver.tap(msgField.x, msgField.y, 1, "deliberate");
    await sleep(randint(800, 1400));
    await c.driver.typeHuman(config.message);
    await sleep(randint(1000, 2000));

    if (await c.driver.tapByDesc("Send") || await c.driver.tapByText("Send")) {
      sent = true;
      await sleep(randint(1500, 2800));
    }

    await c.driver.pressBack();
    await sleep(randint(1000, 1800));
  });

  return sent;
}
