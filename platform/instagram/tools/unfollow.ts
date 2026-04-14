/**
 * Instagram — Unfollow Tool
 *
 * Two modes:
 *   1. targetUsername provided: navigate to their profile and unfollow.
 *   2. No target: unfollow from the currently viewed profile.
 *
 * Handles the confirmation dialog that IG shows ("Unfollow @username?").
 */

import { sleep, randint } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";
import { igGoToTab } from "../nav.ts";

export interface UnfollowConfig {
  /**
   * Username to navigate to and unfollow. If omitted, taps Unfollow on the
   * currently visible profile.
   */
  targetUsername?: string;
}

/**
 * Unfollow an Instagram account. Returns true if the unfollow was confirmed.
 */
export async function unfollowTool(c: Ctx, config: UnfollowConfig = {}): Promise<boolean> {
  let unfollowed = false;

  await safe(c, "unfollow", async () => {
    if (config.targetUsername) {
      c.log("info", `  [IG:unfollow] navigating to @${config.targetUsername}`);
      await igGoToTab(c, "explore");
      c.stats.tab_switches++;
      await sleep(randint(2000, 3500));

      const bar = await c.driver.findByResourceId("com.instagram.android:id/action_bar_search_edit_text");
      if (!bar) return;
      await c.driver.tap(bar.x, bar.y, 1, "deliberate");
      await sleep(randint(1200, 2200));
      await c.driver.typeText(config.targetUsername);
      await sleep(randint(2500, 4000));

      if (!(await c.driver.tapByText(config.targetUsername))) {
        c.log("warn", `  [IG:unfollow] profile for @${config.targetUsername} not found`);
        await c.driver.pressBack();
        return;
      }
      await sleep(randint(2500, 4500));
    }

    // The button reads "Following" when already following.
    const followingBtn = await c.driver.findByText("Following") ||
                         await c.driver.findByDesc("Following");
    if (!followingBtn) {
      c.log("warn", "  [IG:unfollow] Following button not visible — not following this account?");
      if (config.targetUsername) await c.driver.pressBack();
      return;
    }
    await c.driver.tap(followingBtn.x, followingBtn.y, 1, "deliberate");
    await sleep(randint(1200, 2200));

    // Confirm the "Unfollow @username?" dialog.
    const confirmUnfollow = await c.driver.findByText("Unfollow") ||
                            await c.driver.findByDesc("Unfollow");
    if (confirmUnfollow) {
      await c.driver.tap(confirmUnfollow.x, confirmUnfollow.y, 1, "deliberate");
      unfollowed = true;
      await sleep(randint(1500, 2800));
      c.log("info", `  [IG:unfollow] unfollowed${config.targetUsername ? ` @${config.targetUsername}` : ""}`);
    }

    if (config.targetUsername) {
      await c.driver.pressBack();
      await sleep(randint(1000, 1800));
    }
  });

  return unfollowed;
}
