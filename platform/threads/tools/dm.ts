/**
 * Threads — Direct Message Tool
 * Opens a DM conversation with the target user and sends a message.
 */

import { sleep, randint } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";
import { threadsGoToTab } from "../nav.ts";

export interface ThreadsDMConfig {
  targetUsername: string;
  message: string;
}

export async function dmTool(c: Ctx, config: ThreadsDMConfig): Promise<boolean> {
  c.log("info", `  [Threads:dm] sending DM to @${config.targetUsername}`);
  let sent = false;

  await safe(c, "threads dm", async () => {
    // Caller may be on any tab — go to Search first so findByDesc("Search")
    // actually resolves to the search bar instead of an unrelated icon.
    await threadsGoToTab(c, "search");
    await sleep(randint(1200, 2200));
    const searchBar = await c.driver.findByDesc("Search") ||
                      await c.driver.findByResourceId("com.instagram.barcelona:id/search_bar");
    if (!searchBar) {
      c.log("warn", "  [Threads:dm] search bar not found after nav to Search tab");
      return;
    }
    await c.driver.tap(searchBar.x, searchBar.y, 1, "deliberate");
    await sleep(randint(1000, 1800));
    await c.driver.typeHuman(config.targetUsername);
    await sleep(randint(2000, 3500));

    const userResult = await c.driver.findByText(config.targetUsername);
    if (!userResult) {
      c.log("warn", `  [Threads:dm] user @${config.targetUsername} not found`);
      await c.driver.pressBack();
      return;
    }
    await c.driver.tap(userResult.x, userResult.y, 1, "normal");
    await sleep(randint(2000, 3500));

    // Tap the message button on the profile.
    const msgBtn = await c.driver.findByText("Message") ||
                   await c.driver.findByDesc("Message");
    if (!msgBtn) {
      c.log("warn", "  [Threads:dm] Message button not found on profile");
      await c.driver.pressBack();
      return;
    }
    await c.driver.tap(msgBtn.x, msgBtn.y, 1, "deliberate");
    await sleep(randint(2000, 3500));

    const msgField = await c.driver.findByResourceId("com.instagram.barcelona:id/message_edittext") ||
                     await c.driver.findByDesc("Message");
    if (!msgField) return;
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
