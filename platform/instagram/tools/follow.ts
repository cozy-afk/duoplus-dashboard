/**
 * Instagram — Follow Tool
 *
 * Two modes:
 *   1. targetUsername provided: search for and follow that specific account.
 *   2. No target: follow the currently viewed profile (assumes you're already
 *      on a profile page).
 */

import { sleep, randint } from "../../../device-driver.ts";
import type { Ctx } from "../../../human.ts";
import { safe } from "../../../human.ts";
import { igGoToTab } from "../nav.ts";

export interface FollowConfig {
  /**
   * Username to search for and follow. If omitted, taps the Follow button
   * on whatever profile is currently on screen.
   */
  targetUsername?: string;
}

/**
 * Anchored matcher: returns the center of the FIRST node whose `attr` value
 * is exactly `value` (not a substring), bounds-parsed. Avoids the classic
 * "Follow" matches "Following" bug that toggles an unfollow.
 */
function matchExact(xml: string, attr: "text" | "content-desc", value: string): { x: number; y: number } | null {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<node[^/]*?${attr}="${escaped}"[^/]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
    "i",
  );
  const m = xml.match(re);
  if (!m) return null;
  return {
    x: Math.floor((+m[1] + +m[3]) / 2),
    y: Math.floor((+m[2] + +m[4]) / 2),
  };
}

/**
 * Find ALL exact "Follow" buttons in the dump. Used by the follower-list
 * campaign path that wants to tap one row at a time.
 */
function matchAllExact(xml: string, attr: "text" | "content-desc", value: string): Array<{ x: number; y: number }> {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<node[^/]*?${attr}="${escaped}"[^/]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
    "gi",
  );
  const out: Array<{ x: number; y: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    out.push({
      x: Math.floor((+m[1] + +m[3]) / 2),
      y: Math.floor((+m[2] + +m[4]) / 2),
    });
  }
  return out;
}

/**
 * Tap the next visible "Follow" row in a list (e.g., follower or suggested
 * list). Returns true if a follow happened.
 */
export async function followNextVisibleRow(c: Ctx): Promise<boolean> {
  const xml = await c.driver.dumpUi();
  const buttons = matchAllExact(xml, "text", "Follow");
  if (buttons.length === 0) return false;
  // Pick a random row rather than always the topmost — feels less robotic.
  const pick = buttons[randint(0, buttons.length - 1)];
  await c.driver.tap(pick.x, pick.y, 1, "deliberate");
  await sleep(randint(900, 1800));
  return true;
}

/**
 * Follow an Instagram account. Returns true if a follow action was performed.
 */
export async function followTool(c: Ctx, config: FollowConfig = {}): Promise<boolean> {
  let followed = false;

  await safe(c, "follow", async () => {
    if (config.targetUsername) {
      // Navigate to Explore / Search and find the user.
      c.log("info", `  [IG:follow] searching for @${config.targetUsername}`);
      await igGoToTab(c, "explore");
      c.stats.tab_switches++;
      await sleep(randint(2000, 3500));

      const bar = await c.driver.findByResourceId("com.instagram.android:id/action_bar_search_edit_text");
      if (!bar) return;
      await c.driver.tap(bar.x, bar.y, 1, "deliberate");
      await sleep(randint(1200, 2200));
      await c.driver.typeText(config.targetUsername);
      await sleep(randint(2500, 4000));

      // Tap the exact username row.
      if (!(await c.driver.tapByText(config.targetUsername))) {
        c.log("warn", `  [IG:follow] account row for @${config.targetUsername} not found`);
        await c.driver.pressBack();
        return;
      }
      await sleep(randint(2500, 4500));
    }

    // Tap a Follow button — must match the exact label "Follow" so we don't
    // tap "Following"/"Follow back"/"Followed" and accidentally toggle an
    // unfollow on a profile we've already followed. findByText is a
    // substring match, so we walk the dump ourselves with anchored regexes.
    const xmlNow = await c.driver.dumpUi();
    const followBtn = matchExact(xmlNow, "text", "Follow") ||
                      matchExact(xmlNow, "content-desc", "Follow");
    if (!followBtn) {
      c.log("warn", "  [IG:follow] no exact 'Follow' button visible — already following?");
      if (config.targetUsername) await c.driver.pressBack();
      return;
    }
    await c.driver.tap(followBtn.x, followBtn.y, 1, "deliberate");
    followed = true;
    await sleep(randint(1500, 3000));
    c.log("info", `  [IG:follow] followed${config.targetUsername ? ` @${config.targetUsername}` : ""}`);

    if (config.targetUsername) {
      await c.driver.pressBack();
      await sleep(randint(1000, 1800));
    }
  });

  return followed;
}
