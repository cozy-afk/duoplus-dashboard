/**
 * Instagram — Direct Message Tool
 *
 * Navigates to DMs, finds or opens a conversation with the target username,
 * and sends the provided message text.
 */

import { sleep, randint } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";

export interface DMConfig {
  /** Username to send the DM to (without @). */
  targetUsername: string;
  /** Message text to send. */
  message: string;
}

/**
 * Send a direct message to a specific user on Instagram.
 * Returns true if the message was sent successfully.
 */
export async function dmTool(c: Ctx, config: DMConfig): Promise<boolean> {
  c.log("info", `  [IG:dm] sending DM to @${config.targetUsername}`);
  let sent = false;

  await safe(c, "dm", async () => {
    // Open DM inbox via the paper-plane icon in the top-right of the feed.
    const dmIcon = await c.driver.findByDesc("Direct") ||
                   await c.driver.findByDesc("Messenger") ||
                   await c.driver.findByDesc("Direct messaging");
    if (!dmIcon) {
      c.log("warn", "  [IG:dm] DM icon not found — is IG on the home tab?");
      return;
    }
    await c.driver.tap(dmIcon.x, dmIcon.y, 1, "deliberate");
    await sleep(randint(2500, 4000));

    // Search for the target user in the DM search bar.
    const searchBar = await c.driver.findByResourceId("com.instagram.android:id/search_edit_text") ||
                      await c.driver.findByDesc("Search");
    if (searchBar) {
      await c.driver.tap(searchBar.x, searchBar.y, 1, "deliberate");
      await sleep(randint(800, 1400));
      await c.driver.typeHuman(config.targetUsername);
      await sleep(randint(2000, 3500));

      // Tap the first result matching the username.
      const result = await c.driver.findByText(config.targetUsername);
      if (result) {
        await c.driver.tap(result.x, result.y, 1, "normal");
        await sleep(randint(2000, 3500));
      }
    }

    // Find the message input field and type the message.
    const msgField = await c.driver.findByResourceId("com.instagram.android:id/row_thread_composer_edittext");
    if (!msgField) {
      c.log("warn", "  [IG:dm] message input field not found");
      await c.driver.pressBack();
      return;
    }
    await c.driver.tap(msgField.x, msgField.y, 1, "deliberate");
    await sleep(randint(800, 1400));
    await c.driver.typeHuman(config.message);
    await sleep(randint(1000, 2000));

    // Send.
    const sendBtn = await c.driver.findByDesc("Send") || await c.driver.findByText("Send");
    if (sendBtn) {
      await c.driver.tap(sendBtn.x, sendBtn.y, 1, "deliberate");
      sent = true;
      await sleep(randint(1500, 2800));
      c.log("info", "  [IG:dm] message sent");
    }

    await c.driver.pressBack();
    await sleep(randint(1000, 1800));
  });

  return sent;
}
