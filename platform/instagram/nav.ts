/**
 * Instagram navigation primitives.
 *
 * Bottom-nav layout (1080-wide):
 *   slot 0: Home (house)
 *   slot 1: Reels (play triangle)
 *   slot 2: Create (+)
 *   slot 3: Explore (search/compass)
 *   slot 4: Profile (avatar)
 */

import type { Ctx } from "../../human.ts";
import { goToTab, validateAndResetToHome, type NavConfig } from "../../bottom-nav.ts";
import { captureFailure } from "../../vision.ts";

export const IG_PKG = "com.instagram.android";

export type IgTab = "home" | "reels" | "create" | "explore" | "profile";

export const IG_TAB_META: Record<IgTab, { rid: string; descs: string[]; texts?: string[]; slot: number }> = {
  // IG renames resource-ids between builds — the resolver matches any that
  // CONTAIN the fragment, so we store just the distinctive part.
  home:    { rid: "feed_tab",    descs: ["Home"],                           slot: 0 },
  reels:   { rid: "clips_tab",   descs: ["Reels", "Reels, tab"],            slot: 1 },
  create:  { rid: "camera_tab",  descs: ["Create"],                         slot: 2 },
  explore: { rid: "search_tab",  descs: ["Search and explore", "Explore"],  slot: 3 },
  profile: { rid: "profile_tab", descs: ["Profile"],                        slot: 4 },
};

async function igCurrentTab(driver: { dumpUi(): Promise<string> }, xml?: string): Promise<IgTab | null> {
  const x = xml ?? (await driver.dumpUi());
  // 1. Strongest signal: a tab button with selected="true". Covers every
  //    IG build that hasn't stripped the attribute.
  for (const [name, meta] of Object.entries(IG_TAB_META) as [IgTab, typeof IG_TAB_META[IgTab]][]) {
    const re = new RegExp(
      `<node[^/]*?resource-id="${meta.rid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^/]*?selected="true"`,
    );
    if (re.test(x)) return name;
  }
  // 2. Content fallbacks — order is important because IG embeds elements
  //    from multiple tabs in the same dump (e.g. inline Reels previews in
  //    the Home feed). Check the most SPECIFIC signals first.
  //
  //    Profile is unambiguous — "Edit profile" only renders when viewing
  //    your own profile. Check first.
  if (/text="Edit profile"|content-desc="Edit profile"/i.test(x)) return "profile";
  //    Home: stories tray is the canonical home signal — it doesn't render
  //    anywhere else. If present, we're definitively on Home even if
  //    inline Reels previews are also in the dump.
  if (/content-desc="Stories tray"/i.test(x)) return "home";
  if (/resource-id="com\.instagram\.android:id\/row_feed_view_group"/i.test(x)) return "home";
  //    Explore: the search edit text is only in the nav bar on the Explore tab.
  if (/resource-id="com\.instagram\.android:id\/action_bar_search_edit_text"/i.test(x)) return "explore";
  //    Reels: require the TAB signal (Reels, tab) — NOT just clips_viewer,
  //    which also appears as inline reels on Home feed. Alternatively the
  //    full-screen reels player has a 'Like' content-desc at screen-left
  //    with a specific reels container — but content-desc="Reels, tab" is
  //    the tightest and matches the selected tab icon's accessibility label.
  if (/content-desc="Reels, tab"/i.test(x)) return "reels";
  //    Looser Reels fallback: clips_viewer visible AND no home/explore
  //    signals — implies we're in the Reels player viewport. Checked LAST
  //    so it can't override Home.
  if (/resource-id="com\.instagram\.android:id\/clips_viewer"/i.test(x)) return "reels";
  return null;
}

export const IG_NAV_CONFIG: NavConfig<IgTab> = {
  platformName: "IG",
  tabs: IG_TAB_META,
  currentTab: igCurrentTab,
};

export async function igGoToTab(c: Ctx, tab: IgTab): Promise<boolean> {
  const ok = await goToTab(c, IG_NAV_CONFIG, tab);
  if (!ok) {
    try {
      // Capture the CURRENT XML so the unknown_screens row is actually
      // useful for pattern learning. Previously xmlHead was omitted, which
      // left every goToTab-*-all-failed row empty-XMLed and unlearnable.
      let xmlHead: string | undefined;
      try {
        xmlHead = (await c.driver.dumpUi()).slice(0, 8000);
      } catch { /* dump may itself be failing — row still has the screenshot */ }
      await captureFailure(
        c.driver,
        {
          deviceId: c.driver.deviceId,
          platform: "instagram",
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

/**
 * Re-entry guardrail. Call at the very start of a warmup session (and
 * anywhere IG is freshly launched) to ensure we're on Home before tools
 * start firing. Covers: previous session died on a profile/modal/settings
 * page, IG cold-started into a deep-link, A/B experiment opened Reels
 * first, etc.
 */
export async function igValidateHome(c: Ctx): Promise<boolean> {
  return await validateAndResetToHome(c, IG_NAV_CONFIG, "home", IG_PKG);
}
