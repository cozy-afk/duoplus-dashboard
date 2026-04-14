/**
 * TikTok — multi-account switcher.
 *
 * Flow on current TikTok builds:
 *   1. Tap Profile tab (bottom-right of nav, slot 4 of 5).
 *   2. Tap the username header at the top of the profile (it has a chevron
 *      `▾` next to it indicating it's expandable).
 *   3. A bottom-sheet / modal slides up listing all logged-in accounts +
 *      a "Manage accounts" / "Add account" row.
 *   4. Tap the target row → TikTok refreshes the For You feed for the
 *      newly-active account.
 *
 * TikTok routinely strips accessibility info off its bottom-nav tabs
 * (every tab is just an empty FrameLayout with an obfuscated resource-id),
 * so we use the same coordinate-based fallback the scanner already uses
 * for tapping the Profile tab when resource-id matching fails.
 *
 * Switcher detection signal: the open sheet contains either "Manage accounts"
 * or "Add account" text — IG/TT diverge here on phrasing, so we accept either.
 */

import { sleep, randint } from "../../device-driver.ts";
import type { Ctx } from "../../human.ts";
import type { StructuredLogger } from "../../logger.ts";

const TIKTOK_NOT_AN_ACCOUNT = /^(Add account|Manage accounts|Add existing account|Sign up|Log out|Settings)/i;
const HANDLE_RE = /^[a-zA-Z0-9._]{1,30}$/;

function isPlausibleHandle(s: string | undefined | null): s is string {
  if (!s) return false;
  if (TIKTOK_NOT_AN_ACCOUNT.test(s)) return false;
  return HANDLE_RE.test(s.trim().replace(/^@/, ""));
}

/** Coordinate-based Profile-tab tap. TikTok's nav has 5 slots; Profile is slot 4. */
async function tapProfileTab(c: Ctx): Promise<void> {
  const size = await c.driver.screenSize();
  const slotX = Math.floor((size.width / 5) * 4.5);
  const slotY = Math.floor(size.height * 0.97);
  await c.driver.tap(slotX, slotY, 0);
  // TikTok takes longer than IG to render the profile after a tab tap.
  await sleep(randint(2400, 4200));
}

/**
 * Open the switcher sheet from anywhere in the app. Returns the open-sheet
 * XML on success, null otherwise.
 */
async function openSwitcherSheet(c: Ctx, log: StructuredLogger): Promise<string | null> {
  log.event("info", "switcher.attempt", "tap profile tab + header for switcher");
  await tapProfileTab(c);

  // Find the username header — it's an autosize TextView in the action bar
  // with the chevron drawable next to it. Resource-id varies by build, so we
  // anchor on either the unique_id row OR a clickable header that contains
  // a TextView with handle-shaped text in the top quarter of the screen.
  let xml = await c.driver.dumpUi();
  const screenSize = await c.driver.screenSize();
  const topQuarter = Math.floor(screenSize.height * 0.25);

  const headerCandidates: Array<{ x: number; y: number; text: string }> = [];
  const re = /<node[^>]*?text="([^"]+)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const text = m[1];
    const yTop = +m[3];
    if (yTop > topQuarter) continue;
    if (!isPlausibleHandle(text)) continue;
    headerCandidates.push({
      x: Math.floor((+m[2] + +m[4]) / 2),
      y: Math.floor((+m[3] + +m[5]) / 2),
      text,
    });
  }
  if (headerCandidates.length === 0) {
    log.event("warn", "switcher.no-header", "no handle-shaped header text found in top quarter");
    return null;
  }
  // Pick the topmost candidate — the username sits above any other handle
  // text (reposts, etc) on the profile page.
  headerCandidates.sort((a, b) => a.y - b.y);
  const header = headerCandidates[0];
  await c.driver.tap(header.x, header.y);
  log.event("info", "switcher.tapped-header", `tapped header @${header.text}`);
  await sleep(randint(1300, 2300));

  xml = await c.driver.dumpUi();
  if (sheetIsOpen(xml)) {
    log.event("ok", "switcher.opened", "TikTok switcher sheet open");
    return xml;
  }
  log.event("warn", "switcher.failed", "header tap did not open switcher sheet");
  return null;
}

function sheetIsOpen(xml: string): boolean {
  if (/text="Manage accounts"/i.test(xml)) return true;
  if (/text="Add account"/i.test(xml)) return true;
  if (/text="Add existing account"/i.test(xml)) return true;
  if (/content-desc="Switch to"/i.test(xml)) return true;
  return false;
}

/** Same parser logic as IG — pick out handle-shaped <node text=…/> rows. */
function parseSheetHandles(xml: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const re = /<node[^>]*?text="([^"]+)"[^>]*?\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const candidate = m[1].trim().replace(/^@/, "");
    if (!isPlausibleHandle(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    found.push(candidate);
  }
  return found;
}

async function dismissSheet(c: Ctx): Promise<void> {
  await c.driver.pressBack();
  await sleep(randint(700, 1300));
}

export async function tiktokEnumerateAccounts(c: Ctx, log: StructuredLogger): Promise<string[]> {
  const xml = await openSwitcherSheet(c, log);
  if (!xml) return [];
  const handles = parseSheetHandles(xml);
  log.event("info", "switcher.enumerated", `found ${handles.length} TikTok account(s)`, { handles });
  await dismissSheet(c);
  return handles;
}

export async function tiktokSwitchAccount(
  c: Ctx,
  username: string,
  log: StructuredLogger,
): Promise<boolean> {
  if (!isPlausibleHandle(username)) {
    log.event("error", "switcher.bad-input", `refusing to switch to "${username}"`);
    return false;
  }

  // Idempotence: tap profile, check active handle in header.
  await tapProfileTab(c);
  const beforeXml = await c.driver.dumpUi();
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`text="@?${escaped}"`).test(beforeXml)) {
    log.event("ok", "switcher.already-active", `already on @${username}`);
    return true;
  }

  const sheetXml = await openSwitcherSheet(c, log);
  if (!sheetXml) return false;

  // Find the row bounds — accept "@username" OR "username" since TikTok's
  // sheet rendering toggles the @ prefix between builds.
  const rowRe = new RegExp(
    `<node[^/]*?text="@?${escaped}"[^/]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
  );
  const m = sheetXml.match(rowRe);
  if (!m) {
    log.event("warn", "switcher.target-missing", `@${username} not in TikTok switcher sheet`);
    await dismissSheet(c);
    return false;
  }
  const x = Math.floor((+m[1] + +m[3]) / 2);
  const y = Math.floor((+m[2] + +m[4]) / 2);
  await c.driver.tap(x, y, 1, "deliberate");
  log.event("info", "switcher.tapped", `tapped TikTok @${username} row`);

  // Feed re-hydrate after switch is slower on TikTok than IG.
  await sleep(randint(5500, 9000));

  // Verify by re-tapping profile and looking for our handle in the header.
  await tapProfileTab(c);
  const afterXml = await c.driver.dumpUi();
  if (new RegExp(`text="@?${escaped}"`).test(afterXml)) {
    log.event("ok", "switcher.verified", `now active TikTok: @${username}`);
    return true;
  }
  log.event("warn", "switcher.unverified", `tap fired but profile doesn't show @${username}`);
  return false;
}
