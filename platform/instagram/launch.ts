/**
 * Instagram app launch + Create-screen detector.
 * igIsOnCreateScreen is shared by stories.ts and other tools that need to bail
 * when accidentally landing on the camera/create flow.
 */

import { sleep, randint } from "../../device-driver.ts";
import { analyzeAndRecover } from "../../screen-analyzer.ts";
import type { Ctx } from "../../human.ts";
import { expired } from "../../human.ts";
import { AccountFlaggedError, checkForFlagScreen } from "../../safety.ts";
import { IG_PKG, igGoToTab, IG_NAV_CONFIG } from "./nav.ts";
import { waitForAppReady } from "../../bottom-nav.ts";

/**
 * Returns true when the current screen is the IG story/reel/post CREATE flow.
 * Used to detect accidental taps on "Your story" and bail before content posts.
 */
export async function igIsOnCreateScreen(driver: { dumpUi(): Promise<string> }, xml?: string): Promise<boolean> {
  const x = xml ?? (await driver.dumpUi());
  if (/resource-id="com\.instagram\.android:id\/(creation_camera_viewfinder|camera_capture_button|creation_shutter_button|camera_view_placeholder)"/i.test(x)) {
    return true;
  }
  if (/text="POST"[\s\S]{0,400}text="STORY"[\s\S]{0,400}text="REELS?"/i.test(x)) return true;
  if (/content-desc="(Flip camera|Add music|Story camera|Create story|Shutter button)"/i.test(x)) return true;
  return false;
}

/**
 * Launch Instagram and navigate to the home feed.
 * Returns false if the session should be aborted (account flagged or home tab
 * never appeared after recovery attempts).
 */
export async function igLaunch(c: Ctx): Promise<boolean> {
  await c.driver.launchApp(IG_PKG);
  c.stats.app_launches++;
  await sleep(randint(3000, 6000));
  for (let i = 0; i < 3; i++) {
    if (expired(c)) return false;
    if (!(await c.driver.dismissPopups())) break;
  }
  await checkForFlagScreen(c);
  const pre = await analyzeAndRecover(c.driver, {
    platform: "instagram",
    context: "ig-launch",
    pkg: IG_PKG,
    log: c.log,
  });
  if (pre.classification === "challenge" || pre.classification === "rate-limit") {
    throw new AccountFlaggedError(pre.classification);
  }
  if (pre.classification === "birthday-gate") {
    c.log("info", `  [IG] birthday gate handled (${pre.action})`);
    await sleep(randint(2000, 3500));
  }
  // Wait for the bottom-nav to actually render. Without this, any taps
  // during hydration land on whatever the splash shows. The resolver needs
  // at least 3 tabs resolvable to consider the app "ready."
  const ready = await waitForAppReady(c, IG_NAV_CONFIG, 3, 20000);
  if (!ready) {
    c.log("warn", "  [IG] bottom-nav didn't render — running screen analyzer");
    const res = await analyzeAndRecover(c.driver, {
      platform: "instagram",
      context: "ig-launch-home-missing",
      pkg: IG_PKG,
    });
    c.log("info", `  analyzer: ${res.classification} → ${res.action} (${res.recovered ? "ok" : "failed"})`);
    if (res.classification === "challenge" || res.classification === "rate-limit") {
      throw new AccountFlaggedError(res.classification);
    }
    // One more chance after the analyzer tried to recover.
    if (!(await waitForAppReady(c, IG_NAV_CONFIG, 3, 12000)) && res.classification !== "main-feed") {
      c.log("warn", "  [IG] bottom-nav still not rendered and not on main-feed; aborting session");
      return false;
    }
  }
  await sleep(randint(2500, 5000));
  await igGoToTab(c, "home");
  return true;
}
