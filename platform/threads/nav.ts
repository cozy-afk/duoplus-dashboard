/**
 * Threads navigation primitives.
 *
 * Bottom-nav layout (5 slots):
 *   0: Home / Feed (house)
 *   1: Search (paper airplane)
 *   2: Create (+)
 *   3: Activity (heart)
 *   4: Profile (person)
 */

import type { Ctx } from "../../human.ts";
import { goToTab, validateAndResetToHome, type NavConfig } from "../../bottom-nav.ts";
import { captureFailure } from "../../vision.ts";

export const THREADS_PKG = "com.instagram.barcelona";

export type ThreadsTab = "home" | "search" | "create" | "activity" | "profile";

export const THREADS_TAB_META: Record<ThreadsTab, { rid: string; descs: string[]; texts?: string[]; slot: number }> = {
  home:     { rid: "tab_feed",     descs: ["Feed", "Home", "For you"], slot: 0 },
  search:   { rid: "tab_search",   descs: ["Search"],                  slot: 1 },
  create:   { rid: "tab_create",   descs: ["Create", "New thread"],    slot: 2 },
  activity: { rid: "tab_activity", descs: ["Activity"],                slot: 3 },
  profile:  { rid: "tab_profile",  descs: ["Profile"],                 slot: 4 },
};

async function threadsCurrentTab(driver: { dumpUi(): Promise<string> }, xml?: string): Promise<ThreadsTab | null> {
  const x = xml ?? (await driver.dumpUi());
  for (const [name, meta] of Object.entries(THREADS_TAB_META) as [ThreadsTab, typeof THREADS_TAB_META[ThreadsTab]][]) {
    const re = new RegExp(
      `<node[^/]*?resource-id="[^"]*${meta.rid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^/]*?selected="true"`,
    );
    if (re.test(x)) return name;
  }
  if (/text="Edit profile"|content-desc="Edit profile"/i.test(x)) return "profile";
  if (/content-desc="[^"]*profile photo"[\s\S]{0,2000}text="Threads"[\s\S]{0,200}text="Replies"/i.test(x)) return "profile";
  if (/resource-id="[^"]*search_bar|text="Search"[\s\S]{0,200}resource-id="[^"]*search_field"/i.test(x)) return "search";
  if (/text="All"[\s\S]{0,600}text="Follows"[\s\S]{0,600}text="Replies"/i.test(x)) return "activity";
  if (/text="Activity"[\s\S]{0,200}text="All"/i.test(x)) return "activity";
  if (/text="For you"[\s\S]{0,600}text="Following"/i.test(x)) return "home";
  if (/text="What's new\?"|text="Start a thread"/i.test(x)) return "home";
  if (/resource-id="[^"]*barcelona_tab_feed/.test(x)
      && !/text="Search"|text="Activity"|text="Edit profile"/i.test(x)) {
    return "home";
  }
  return null;
}

const THREADS_NAV_CONFIG: NavConfig<ThreadsTab> = {
  platformName: "Threads",
  tabs: THREADS_TAB_META,
  currentTab: threadsCurrentTab,
};

export async function threadsGoToTab(c: Ctx, tab: ThreadsTab): Promise<boolean> {
  const ok = await goToTab(c, THREADS_NAV_CONFIG, tab);
  if (!ok) {
    try {
      let xmlHead: string | undefined;
      try { xmlHead = (await c.driver.dumpUi()).slice(0, 8000); } catch { /* dump may fail */ }
      await captureFailure(
        c.driver,
        {
          deviceId: c.driver.deviceId,
          platform: "threads",
          context: `goToTab-${tab}-all-failed`,
          xmlHead,
          recovered: false,
          recoveryAction: "none",
        },
        c.log,
      );
    } catch { /* best-effort */ }
  }
  return ok;
}

/** Re-entry guardrail — see igValidateHome for docs. */
export async function threadsValidateHome(c: Ctx): Promise<boolean> {
  return await validateAndResetToHome(c, THREADS_NAV_CONFIG, "home", THREADS_PKG);
}
