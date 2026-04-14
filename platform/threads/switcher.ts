/**
 * Threads — multi-account switcher.
 *
 * Threads piggybacks on the Instagram account system: the same accounts
 * logged into IG show up in the Threads switcher (and vice versa for
 * IG-linked Threads accounts). The UI pattern mirrors IG:
 *
 *   1. Tap the Profile tab.
 *   2. Tap the username header at the top — chevron `▾` indicates expand.
 *   3. Bottom-sheet appears with all accounts.
 *
 * Long-press on the Profile tab does NOT open the switcher in current
 * Threads builds, so we always go through the header tap.
 *
 * Important: switching accounts in Threads ALSO switches the active IG
 * account (they share session state). The runner needs to be aware of
 * this if it's iterating IG and Threads in the same wake — order matters.
 */

import { sleep, randint } from "../../device-driver.ts";
import type { Ctx } from "../../human.ts";
import type { StructuredLogger } from "../../logger.ts";
import { threadsGoToTab } from "./nav.ts";

const NOT_AN_ACCOUNT = /^(Add account|Log into existing account|Create new account|Log out|Manage accounts|Sign in)/i;
const HANDLE_RE = /^[a-zA-Z0-9._]{1,30}$/;

function isPlausibleHandle(s: string | undefined | null): s is string {
  if (!s) return false;
  if (NOT_AN_ACCOUNT.test(s)) return false;
  return HANDLE_RE.test(s.trim().replace(/^@/, ""));
}

async function tapHeader(c: Ctx, log: StructuredLogger): Promise<boolean> {
  if (!(await threadsGoToTab(c, "profile"))) {
    log.event("warn", "switcher.failed", "could not nav to Threads profile tab");
    return false;
  }
  await sleep(randint(1500, 2500));
  const xml = await c.driver.dumpUi();
  const screenSize = await c.driver.screenSize();
  const topQuarter = Math.floor(screenSize.height * 0.25);

  // Threads profile-header username sits in the top quarter, often as a
  // text node next to a "v" chevron or directly clickable. Find the
  // top-most handle-shaped text and tap.
  const candidates: Array<{ x: number; y: number; text: string }> = [];
  const re = /<node[^>]*?text="([^"]+)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const text = m[1];
    const yTop = +m[3];
    if (yTop > topQuarter) continue;
    if (!isPlausibleHandle(text)) continue;
    candidates.push({
      x: Math.floor((+m[2] + +m[4]) / 2),
      y: Math.floor((+m[3] + +m[5]) / 2),
      text,
    });
  }
  if (candidates.length === 0) {
    log.event("warn", "switcher.no-header", "Threads: no handle-shaped header text found");
    return false;
  }
  candidates.sort((a, b) => a.y - b.y);
  const header = candidates[0];
  await c.driver.tap(header.x, header.y);
  log.event("info", "switcher.tapped-header", `tapped Threads header @${header.text}`);
  await sleep(randint(1300, 2300));
  return true;
}

function sheetIsOpen(xml: string): boolean {
  if (/text="Add account"/i.test(xml)) return true;
  if (/text="Log out"/i.test(xml)) return true;
  if (/text="Manage accounts"/i.test(xml)) return true;
  return false;
}

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

export async function threadsEnumerateAccounts(c: Ctx, log: StructuredLogger): Promise<string[]> {
  if (!(await tapHeader(c, log))) return [];
  const xml = await c.driver.dumpUi();
  if (!sheetIsOpen(xml)) {
    log.event("warn", "switcher.failed", "Threads sheet did not open after header tap");
    return [];
  }
  const handles = parseSheetHandles(xml);
  log.event("info", "switcher.enumerated", `found ${handles.length} Threads account(s)`, { handles });
  await dismissSheet(c);
  return handles;
}

export async function threadsSwitchAccount(
  c: Ctx,
  username: string,
  log: StructuredLogger,
): Promise<boolean> {
  if (!isPlausibleHandle(username)) {
    log.event("error", "switcher.bad-input", `refusing to switch to "${username}"`);
    return false;
  }

  // Idempotence check on the profile tab.
  if (!(await threadsGoToTab(c, "profile"))) return false;
  await sleep(randint(1200, 2200));
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const beforeXml = await c.driver.dumpUi();
  if (new RegExp(`text="@?${escaped}"`).test(beforeXml)) {
    log.event("ok", "switcher.already-active", `already on Threads @${username}`);
    return true;
  }

  if (!(await tapHeader(c, log))) return false;
  const sheetXml = await c.driver.dumpUi();
  if (!sheetIsOpen(sheetXml)) {
    log.event("warn", "switcher.failed", "Threads sheet did not open");
    return false;
  }
  const rowRe = new RegExp(
    `<node[^/]*?text="@?${escaped}"[^/]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
  );
  const m = sheetXml.match(rowRe);
  if (!m) {
    log.event("warn", "switcher.target-missing", `Threads @${username} not in switcher sheet`);
    await dismissSheet(c);
    return false;
  }
  const x = Math.floor((+m[1] + +m[3]) / 2);
  const y = Math.floor((+m[2] + +m[4]) / 2);
  await c.driver.tap(x, y, 1, "deliberate");
  log.event("info", "switcher.tapped", `tapped Threads @${username} row`);
  await sleep(randint(4000, 7000));

  await threadsGoToTab(c, "profile");
  await sleep(randint(1500, 2500));
  const afterXml = await c.driver.dumpUi();
  if (new RegExp(`text="@?${escaped}"`).test(afterXml)) {
    log.event("ok", "switcher.verified", `now active Threads: @${username}`);
    return true;
  }
  log.event("warn", "switcher.unverified", `tap fired but Threads profile doesn't show @${username}`);
  return false;
}
