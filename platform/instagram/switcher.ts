/**
 * Instagram — multi-account switcher.
 *
 * IG exposes the account list via TWO routes:
 *   (a) Long-press the Profile tab in the bottom nav → bottom-sheet appears
 *       with all logged-in usernames + an "Add account" row.
 *   (b) Open the Profile tab, then tap the username header at the top
 *       (which has a chevron `▾`) → same bottom-sheet.
 *
 * (a) is faster and works on every IG build I've seen, so we try it first.
 * (b) is the fallback for builds that disable long-press on the bottom nav.
 *
 * The sheet rows look like:
 *     <node text="username1" .../>
 *     <node text="username2" content-desc="Add account ..." .../>  ← this is the
 *                                                                    "Add account"
 *                                                                    row, NOT a
 *                                                                    real handle.
 *
 * Caller responsibilities:
 *   - Pass a logger child with platform="instagram" already bound — we emit
 *     switcher.* events through it so triage shows context for free.
 *   - Be prepared for a 3–6 s pause after switchAccount() returns: IG
 *     re-renders the home feed and re-hydrates the account header.
 */

import { sleep, randint } from "../../device-driver.ts";
import type { Ctx } from "../../human.ts";
import type { StructuredLogger } from "../../logger.ts";
import { igGoToTab, IG_TAB_META } from "./nav.ts";

/** Names that appear in the sheet but aren't real accounts — never tap. */
const NOT_AN_ACCOUNT = /^(Add account|Log into existing account|Create new account|Log out)/i;
const HANDLE_RE = /^[a-zA-Z0-9._]{1,30}$/;

function isPlausibleHandle(s: string | undefined | null): s is string {
  if (!s) return false;
  if (NOT_AN_ACCOUNT.test(s)) return false;
  return HANDLE_RE.test(s.trim());
}

/**
 * Find the bottom-nav profile-tab bounds so we know where to long-press.
 * Returns null if the profile tab isn't visible (e.g., we're inside a story
 * viewer with the nav hidden).
 */
async function findProfileTabBounds(c: Ctx): Promise<{ x: number; y: number } | null> {
  const xml = await c.driver.dumpUi();
  const re = new RegExp(
    `<node[^/]*?resource-id="${IG_TAB_META.profile.rid.replace(/[.:]/g, "\\$&")}"[^/]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
  );
  const m = xml.match(re);
  if (!m) return null;
  return {
    x: Math.floor((+m[1] + +m[3]) / 2),
    y: Math.floor((+m[2] + +m[4]) / 2),
  };
}

/**
 * Try to open the account-switcher sheet. Returns the XML dump of the open
 * sheet on success, or null if neither route worked. Logs every step so a
 * failed switcher is debuggable from the event log.
 */
async function openSwitcherSheet(c: Ctx, log: StructuredLogger): Promise<string | null> {
  // Route (a): long-press the bottom-nav profile tab.
  const tabPos = await findProfileTabBounds(c);
  if (tabPos) {
    log.event("info", "switcher.attempt", "long-press profile tab", { route: "long-press" });
    await c.driver.longPress(tabPos.x, tabPos.y, randint(620, 850));
    await sleep(randint(1100, 1900));
    const xml = await c.driver.dumpUi();
    if (sheetIsOpen(xml)) {
      log.event("ok", "switcher.opened", "switcher sheet open via long-press");
      return xml;
    }
    log.event("info", "switcher.fallback", "long-press did not open sheet, trying header tap");
  }

  // Route (b): nav to profile, then tap the username chevron at the top.
  if (!(await igGoToTab(c, "profile"))) {
    log.event("warn", "switcher.failed", "could not nav to profile tab");
    return null;
  }
  await sleep(randint(1500, 2400));
  const xml1 = await c.driver.dumpUi();
  // Username header sits in the action bar with a chevron drawable. Common
  // resource ids vary by build; match either the title autosize or the
  // chevron icon directly.
  const headerRe = /<node[^/]*?resource-id="com\.instagram\.android:id\/action_bar(?:_title_auto_size|_large_title_auto_size|_textview_title|_title)"[^/]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/;
  const mh = xml1.match(headerRe);
  if (mh) {
    const x = Math.floor((+mh[1] + +mh[3]) / 2);
    const y = Math.floor((+mh[2] + +mh[4]) / 2);
    await c.driver.tap(x, y);
    await sleep(randint(1200, 2000));
    const xml2 = await c.driver.dumpUi();
    if (sheetIsOpen(xml2)) {
      log.event("ok", "switcher.opened", "switcher sheet open via header tap");
      return xml2;
    }
  }

  log.event("warn", "switcher.failed", "neither long-press nor header tap opened the sheet");
  return null;
}

/**
 * Heuristic: the switcher sheet is open if we see EITHER an "Add account" row
 * OR a "Log out" row OR multiple stacked usernames in the bottom half of the
 * screen. Any one is enough — IG renders this bottom-sheet differently on
 * different builds.
 */
function sheetIsOpen(xml: string): boolean {
  if (/text="Add account"/i.test(xml)) return true;
  if (/text="Log out"/i.test(xml)) return true;
  if (/content-desc="Add account/i.test(xml)) return true;
  return false;
}

/**
 * Parse the open sheet for handle rows. Returns each handle exactly once,
 * preserving DOM order so the FIRST entry is typically the active account.
 */
function parseSheetHandles(xml: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  // Pull every <node text="..."/> in the sheet, then filter to handle-shaped
  // strings that aren't the "Add account"/"Log out" labels.
  const re = /<node[^>]*?text="([^"]+)"[^>]*?\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const candidate = m[1].trim();
    if (!isPlausibleHandle(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    found.push(candidate);
  }
  return found;
}

/** Close the sheet without switching. */
async function dismissSheet(c: Ctx): Promise<void> {
  await c.driver.pressBack();
  await sleep(randint(700, 1300));
}

/**
 * Public API: open the switcher and return all logged-in handles. Returns []
 * if the sheet won't open (single-account builds, or app in a state where the
 * switcher is hidden). Always closes the sheet before returning.
 */
export async function igEnumerateAccounts(c: Ctx, log: StructuredLogger): Promise<string[]> {
  const xml = await openSwitcherSheet(c, log);
  if (!xml) return [];
  const handles = parseSheetHandles(xml);
  log.event("info", "switcher.enumerated", `found ${handles.length} account(s)`, { handles });
  await dismissSheet(c);
  return handles;
}

/**
 * Public API: switch to `username`. Returns true if the tap fired AND IG
 * appears to have switched (post-switch screen contains the target handle).
 *
 * Idempotent: if the active account is already `username`, returns true
 * without opening the sheet.
 */
export async function igSwitchAccount(
  c: Ctx,
  username: string,
  log: StructuredLogger,
): Promise<boolean> {
  // Guard rail: don't fire for handles that look invalid — calling code
  // should have validated upstream, but defending here means a bad value
  // can't accidentally tap "Add account".
  if (!isPlausibleHandle(username)) {
    log.event("error", "switcher.bad-input", `refusing to switch to "${username}"`);
    return false;
  }

  // Cheap idempotence check: if the profile header already shows this user,
  // we're done. Avoids opening the sheet on the common case.
  const beforeXml = await c.driver.dumpUi();
  if (new RegExp(`text="${username}"`).test(beforeXml) &&
      /resource-id="com\.instagram\.android:id\/profile_/i.test(beforeXml)) {
    log.event("ok", "switcher.already-active", `already on @${username}`);
    return true;
  }

  const sheetXml = await openSwitcherSheet(c, log);
  if (!sheetXml) return false;

  // Find the bounds of the row whose text matches the target. We need the
  // bounds of the actual row — tapByText would do a substring match and
  // could pick the wrong one if "username" is a prefix of another handle.
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rowRe = new RegExp(
    `<node[^/]*?text="${escaped}"[^/]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
  );
  const m = sheetXml.match(rowRe);
  if (!m) {
    log.event("warn", "switcher.target-missing", `@${username} not in switcher sheet`);
    await dismissSheet(c);
    return false;
  }
  const x = Math.floor((+m[1] + +m[3]) / 2);
  const y = Math.floor((+m[2] + +m[4]) / 2);
  await c.driver.tap(x, y, 1, "deliberate");
  log.event("info", "switcher.tapped", `tapped @${username} row`);

  // IG re-renders the feed after a switch — give it 4–7 s.
  await sleep(randint(4000, 7000));

  // Verify: nav to profile and check the header for our target handle.
  await igGoToTab(c, "profile");
  await sleep(randint(1500, 2500));
  const afterXml = await c.driver.dumpUi();
  if (new RegExp(`text="${escaped}"`).test(afterXml)) {
    log.event("ok", "switcher.verified", `now active: @${username}`);
    return true;
  }
  log.event("warn", "switcher.unverified", `tap fired but profile header doesn't show @${username}`);
  return false;
}
