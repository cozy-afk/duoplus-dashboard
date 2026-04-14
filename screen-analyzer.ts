/**
 * Screen classifier + recovery. When the automation hits a screen it
 * doesn't understand, we:
 *   1. Try a sequence of generic recovery strategies (dismiss/back/relaunch)
 *   2. Log the raw state (activity + XML head) to the `unknown_screens` table
 *      so we can iteratively add specific handling for recurring cases
 *   3. Report whether recovery succeeded
 *
 * This keeps automation resilient to novel popups/interstitials without
 * silently ignoring them — every unknown screen leaves a diagnostic trail
 * for the operator to review.
 */

import type { DeviceDriver } from "./device-driver.ts";
import { sleep, randint } from "./device-driver.ts";
import {
  unknownScreensRepo,
  screenPatternsRepo,
  type ScreenPattern,
  type SignatureRule,
} from "./db.ts";

export type ScreenClass =
  | "main-feed"        // the app is in the intended logged-in state
  | "login-wall"       // user needs to log in
  | "challenge"        // CAPTCHA / verify-it's-you / suspicious activity
  | "rate-limit"       // "Try Again Later" / "action blocked"
  | "popup"            // dismissible dialog (permissions, save-login, etc.)
  | "ad-interstitial"  // promotional or fullscreen ad
  | "onboarding"       // new-account flow
  | "birthday-gate"    // TikTok/IG asking for date of birth
  | "error"            // crashed / something went wrong
  | "unknown";

/** Case-insensitive substring checks against the XML dump text. */
const CLASSIFIERS: Array<{ cls: ScreenClass; patterns: RegExp[] }> = [
  {
    cls: "challenge",
    patterns: [
      /suspicious activity/i,
      /verify it's you/i,
      /challenge required/i,
      /please help us confirm/i,
      /we noticed unusual activity/i,
      /are you a real person/i,
      /Confirm your identity/i,
      /Two-step verification/i,
    ],
  },
  {
    cls: "rate-limit",
    patterns: [
      /Try Again Later/i,
      /action was blocked/i,
      /action is blocked/i,
      /We limit how often/i,
      /We've limited your activity/i,
      /You've been temporarily blocked/i,
    ],
  },
  {
    cls: "login-wall",
    patterns: [
      /text="Log in"[^>]*class="android\.widget\.Button/,
      /text="Create new account"/,
      /text="Get a free account"/,
      /Your account was logged out/i,
      /Try logging in again/i,
      // TikTok signup screen — "Sign up for TikTok" headline + phone/email CTA.
      // This fires when the device has TikTok installed but nobody is logged in;
      // the runner treats login-wall as "skip platform, flag for operator."
      /text="Sign up for TikTok"/i,
      /Sign up for TikTok/,
      /text="Use phone or email"/i,
      // IG/Threads analogues — kept generic so a logged-out state on either
      // platform also trips this bucket.
      /text="Continue as guest"/i,
      /text="Sign up with email"/i,
    ],
  },
  {
    cls: "onboarding",
    patterns: [
      /Follow your Instagram connections/i,
      /Set up your profile/i,
      /Welcome to Instagram/i,
      /Let's get started/i,
    ],
  },
  {
    cls: "birthday-gate",
    patterns: [
      /When.*s your birthday/i,
      /When.*s your birthdate/i,      // TikTok uses 'birthdate' (one word)
      /Enter your birthday/i,
      /Enter your birthdate/i,
      /What.*s your date of birth/i,
      /Add your birthday/i,
      /Add your birthdate/i,
      /date of birth/i,
      /birthdate/i,
      /Date of Birth/,
      /text="Birthday"/,
    ],
  },
  {
    cls: "popup",
    patterns: [
      /text="Not now"/,
      /text="Not Now"/,
      /text="Skip"/,
      /text="Got it"/,
      /text="Maybe later"/,
      /text="Allow"/,
      /text="Turn on"/,
      /Save login info/i,
      /Turn on notifications/i,
    ],
  },
  {
    cls: "ad-interstitial",
    patterns: [/content-desc="Close ad"/i, /class="android\.webkit\.WebView"/],
  },
  {
    cls: "error",
    patterns: [/has stopped/i, /isn't responding/i, /keeps stopping/i, /has crashed/i],
  },
];

export function classifyScreen(xml: string, focus: string): ScreenClass {
  for (const { cls, patterns } of CLASSIFIERS) {
    for (const p of patterns) {
      if (p.test(xml) || p.test(focus)) return cls;
    }
  }
  // If we see a bottom tab bar structure, assume main-feed as fallback.
  if (/bottom.*tab|main_tab_root|tabs_bottom_bar/i.test(xml)) return "main-feed";
  return "unknown";
}

/** Recovery strategies, tried in order. Each returns whether it made progress. */
async function tryDismissByText(driver: DeviceDriver, xml: string): Promise<boolean> {
  const LABELS = [
    "Not now", "Not Now", "Skip", "Maybe later", "Later",
    "Got it", "OK", "Okay", "Dismiss", "Close", "Cancel",
    "Continue", "No thanks", "No, thanks", "Decline", "Ignore",
  ];
  for (const label of LABELS) {
    const re = new RegExp(
      `<node[^/]*?text="${label}"[^/]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
    );
    const m = xml.match(re);
    if (m) {
      const x = Math.floor((+m[1] + +m[3]) / 2);
      const y = Math.floor((+m[2] + +m[4]) / 2);
      await driver.tap(x, y);
      await sleep(randint(1200, 2200));
      return true;
    }
  }
  return false;
}

async function tryDismissByCloseIcon(driver: DeviceDriver, xml: string): Promise<boolean> {
  // Top-right X button is the canonical close affordance. Look for common descs.
  for (const desc of ["Close", "Dismiss", "Cancel"]) {
    const re = new RegExp(
      `<node[^/]*?content-desc="${desc}"[^/]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
    );
    const m = xml.match(re);
    if (m) {
      const x = Math.floor((+m[1] + +m[3]) / 2);
      const y = Math.floor((+m[2] + +m[4]) / 2);
      await driver.tap(x, y);
      await sleep(randint(1200, 2200));
      return true;
    }
  }
  return false;
}

async function tryBack(driver: DeviceDriver): Promise<boolean> {
  await driver.pressBack();
  await sleep(randint(1200, 2200));
  return true;
}

async function tryRelaunch(driver: DeviceDriver, pkg: string | null): Promise<boolean> {
  if (!pkg) return false;
  await driver.pressHome();
  await sleep(randint(1500, 2500));
  await driver.launchApp(pkg);
  return true;
}

// ---------------------------------------------------------------------------
// Learned-pattern classifier (operator-curated screen recoveries).
//
// Patterns live in the `screen_patterns` table. We hot-cache the enabled
// rows for 60s so we don't issue a SELECT on every analyzeAndRecover call —
// hits are common (every unknown screen) and the table is small.
//
// Cache invalidation: the API endpoints that mutate patterns call
// invalidatePatternCache() so a freshly-approved pattern starts firing
// immediately without a server restart.
// ---------------------------------------------------------------------------

let patternCache: ScreenPattern[] | null = null;
let patternCacheLoadedAt = 0;
const PATTERN_CACHE_TTL_MS = 60_000;

export function invalidatePatternCache(): void {
  patternCache = null;
}

async function loadPatterns(platform: string | null | undefined): Promise<ScreenPattern[]> {
  const now = Date.now();
  if (!patternCache || now - patternCacheLoadedAt > PATTERN_CACHE_TTL_MS) {
    try {
      patternCache = await screenPatternsRepo.list({ enabledOnly: true });
      patternCacheLoadedAt = now;
    } catch {
      patternCache = patternCache ?? [];   // keep stale cache on error
    }
  }
  // Per-platform filter is cheap to do client-side rather than re-querying.
  if (!platform) return patternCache;
  return patternCache.filter((p) => p.platform == null || p.platform === platform);
}

/** Does this pattern's signature match the current xml + focus? AND-joined. */
function signatureMatches(pattern: ScreenPattern, xml: string, focus: string): boolean {
  let rules: SignatureRule[];
  try {
    rules = JSON.parse(pattern.signature_json);
  } catch {
    return false;   // corrupt row — skip
  }
  if (!Array.isArray(rules) || rules.length === 0) return false;
  for (const rule of rules) {
    const needle = rule.contains;
    if (!needle) return false;
    if (rule.type === "focus") {
      if (!focus.includes(needle)) return false;
    } else if (rule.type === "text") {
      if (!new RegExp(`text="[^"]*${escapeRe(needle)}[^"]*"`).test(xml)) return false;
    } else if (rule.type === "desc") {
      if (!new RegExp(`content-desc="[^"]*${escapeRe(needle)}[^"]*"`).test(xml)) return false;
    } else if (rule.type === "resource-id") {
      if (!new RegExp(`resource-id="[^"]*${escapeRe(needle)}[^"]*"`).test(xml)) return false;
    }
  }
  return true;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Execute a pattern's recovery action. Returns true if the action fired. */
async function applyRecovery(
  driver: DeviceDriver,
  pattern: ScreenPattern,
  xml: string,
  pkg: string | null,
): Promise<boolean> {
  switch (pattern.recovery_action) {
    case "press_back":
      await driver.pressBack();
      await sleep(randint(1200, 2200));
      return true;
    case "swipe_down":
      await driver.swipeDown();
      await sleep(randint(900, 1600));
      return true;
    case "relaunch":
      return await tryRelaunch(driver, pkg);
    case "tap_text":
    case "tap_desc":
    case "tap_resource_id": {
      const arg = pattern.recovery_arg;
      if (!arg) return false;
      const attr =
        pattern.recovery_action === "tap_text" ? "text" :
        pattern.recovery_action === "tap_desc" ? "content-desc" :
        "resource-id";
      const re = new RegExp(
        `<node[^/]*?${attr}="[^"]*${escapeRe(arg)}[^"]*"[^/]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
      );
      const m = xml.match(re);
      if (!m) return false;
      const x = Math.floor((+m[1] + +m[3]) / 2);
      const y = Math.floor((+m[2] + +m[4]) / 2);
      await driver.tap(x, y);
      await sleep(randint(1200, 2200));
      return true;
    }
  }
}

/**
 * Try every enabled learned pattern. On the first match, fire its recovery
 * action and update counters. Returns the matched pattern (if any) so the
 * caller can include it in the analyze result for triage logs.
 */
async function tryLearnedPatterns(
  driver: DeviceDriver,
  xml: string,
  focus: string,
  platform: string | null | undefined,
  pkg: string | null,
): Promise<{ pattern: ScreenPattern; recovered: boolean } | null> {
  const patterns = await loadPatterns(platform);
  for (const pattern of patterns) {
    if (!signatureMatches(pattern, xml, focus)) continue;
    // Fire-and-forget the matched counter — we don't want a slow DB write
    // to delay the recovery action that's about to run.
    screenPatternsRepo.incrementMatched(pattern.id).catch(() => {});
    let recovered = false;
    try {
      recovered = await applyRecovery(driver, pattern, xml, pkg);
    } catch { /* fall through — let the generic ladder try */ }
    if (recovered) {
      screenPatternsRepo.incrementRecovered(pattern.id).catch(() => {});
    }
    return { pattern, recovered };
  }
  return null;
}

/**
 * Handle a birthday prompt. Targets an age of 19-22 years old.
 *
 * Strategy: wheel pickers use NumberPicker or custom Compose wheels.
 * We find the 3 number-ish regions at the top half of the screen, then:
 *   - Year wheel (rightmost): swipe down ~(currentYear - targetYear) times
 *     to scroll from default (current year) backwards to 2003-2007.
 *   - Month/Day: leave default or pick randomly with small swipes.
 * Then tap "Next" / "Continue" / "Done" / "Submit".
 *
 * TikTok's default year is usually the current year, so we need to go BACK
 * in time — which means swiping DOWN on the year wheel (scrolls content up
 * visually, showing older numbers).
 */
async function handleBirthdayGate(
  driver: DeviceDriver,
  log?: (level: "info" | "warn" | "error" | "ok", msg: string) => void,
): Promise<boolean> {
  const now = new Date().getFullYear();
  const ageTarget = randint(19, 22);
  const targetYear = now - ageTarget;
  const birthMonth = randint(1, 12);
  const birthDay = randint(1, 28);
  log?.("info", `  birthday: target year=${targetYear} (age ${ageTarget}), month=${birthMonth}, day=${birthDay}`);

  const xml = await driver.dumpUi();
  // Strategy 1: find nodes with `scrollable="true"` (works on classic widgets).
  // Strategy 2 (fallback for Compose): find 3 text nodes with 4-digit numbers
  // (year values like 2024/2025/2026 visible on the wheel).
  let wheels: Array<{ x: number; y: number; h: number }> = [];
  const reScrollable = /<node[^/]*?scrollable="true"[^/]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  let m: RegExpExecArray | null;
  while ((m = reScrollable.exec(xml)) !== null) {
    const x1 = +m[1], y1 = +m[2], x2 = +m[3], y2 = +m[4];
    const w = x2 - x1, h = y2 - y1;
    if (h >= 200 && h <= 900 && w <= 600) {
      wheels.push({ x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2), h });
    }
  }

  if (wheels.length === 0) {
    log?.("info", "  birthday: no scrollable wheels; falling back to bounds of year text");
    // Look for a visible 4-digit year (e.g. "2024" or "2025") text node — its
    // bounds reveal where the year wheel is rendered.
    const yearRe = /text="(20[12]\d)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
    const yearNodes: Array<{ x: number; y: number; h: number; year: number }> = [];
    let ym: RegExpExecArray | null;
    while ((ym = yearRe.exec(xml)) !== null) {
      yearNodes.push({
        year: +ym[1],
        x: Math.floor((+ym[2] + +ym[4]) / 2),
        y: Math.floor((+ym[3] + +ym[5]) / 2),
        h: +ym[5] - +ym[3],
      });
    }
    if (yearNodes.length) {
      // Pick the largest year (center row is bolder/taller typically).
      yearNodes.sort((a, b) => b.h - a.h);
      const y = yearNodes[0];
      wheels.push({ x: y.x, y: y.y, h: Math.max(200, y.h * 5) });
      log?.("info", `  birthday: inferred year-wheel at (${y.x},${y.y}) from year text ${y.year}`);
    }
  }

  if (wheels.length === 0) {
    // Final fallback: screen-relative guess. Assume 3 wheels fill the middle
    // 40% of a 1080-wide screen; year wheel is rightmost third.
    log?.("warn", "  birthday: no wheels detected; using screen-relative guess (rightmost third, vertical middle)");
    wheels.push({ x: 870, y: 1100, h: 400 });
  }

  {
    // Sort by x (left → right). Expect [month, day, year] OR [year, month, day].
    wheels.sort((a, b) => a.x - b.x);
    const yearWheel = wheels[wheels.length - 1]; // rightmost = year (typical US layout)
    // Swipe the year wheel DOWNWARD many times to move backwards in years.
    // One swipe scrolls ~5-8 positions usually. Aim for ~(now - targetYear) positions.
    const yearsBack = Math.max(1, Math.min(40, now - targetYear));
    const swipes = Math.ceil(yearsBack / 6); // ~6 years per swipe
    log?.("info", `  birthday: scrolling year wheel ${swipes}x to go ~${yearsBack} years back`);
    for (let i = 0; i < swipes; i++) {
      // Swipe down within the wheel's bounds — start at middle-top, end at middle-bottom.
      await driver.swipe(
        yearWheel.x,
        yearWheel.y - Math.floor(yearWheel.h * 0.3),
        yearWheel.x,
        yearWheel.y + Math.floor(yearWheel.h * 0.3),
        randint(300, 500),
      );
      await sleep(randint(400, 700));
    }
    // Optional: nudge month wheel to a random position if >= 3 wheels exist.
    if (wheels.length >= 3) {
      const monthWheel = wheels[0];
      for (let i = 0; i < randint(0, birthMonth - 1); i++) {
        await driver.swipe(
          monthWheel.x,
          monthWheel.y - 60,
          monthWheel.x,
          monthWheel.y + 60,
          350,
        );
        await sleep(300);
      }
    }
  }
  await sleep(randint(800, 1500));
  // Tap Next / Continue / Done.
  for (const label of ["Next", "Continue", "Done", "Submit", "Confirm", "OK"]) {
    if (await driver.tapByText(label)) {
      log?.("info", `  birthday: tapped "${label}"`);
      await sleep(randint(2000, 4000));
      return true;
    }
  }
  log?.("warn", "  birthday: no Next/Continue button found");
  return false;
}

export interface AnalyzeAndRecoverResult {
  classification: ScreenClass;
  recovered: boolean;
  action: string;
}

/**
 * Main entry: classify current screen, attempt recovery for non-main-feed states
 * that are safe to recover from, and log unknowns for review.
 *
 * Never tries to recover from `challenge`/`rate-limit` — those are hard stops
 * that must bubble up to the caller so the account can be flagged.
 */
export async function analyzeAndRecover(
  driver: DeviceDriver,
  opts: {
    platform?: "instagram" | "threads" | "tiktok" | null;
    context: string;
    pkg?: string | null;
    log?: (level: "info" | "warn" | "error" | "ok", msg: string) => void;
  },
): Promise<AnalyzeAndRecoverResult> {
  const xml = await driver.dumpUi();
  const focus = await driver.shell("dumpsys window windows | grep mCurrentFocus | head -1").catch(() => "");
  const cls = classifyScreen(xml, focus);

  // Hard stops — do NOT try to recover, bubble up.
  if (cls === "challenge" || cls === "rate-limit" || cls === "login-wall") {
    unknownScreensRepo.record({
      device_id: driver.deviceId,
      platform: opts.platform ?? null,
      context: opts.context,
      focus,
      xml_head: xml.slice(0, 8000),
      recovered: false,
      recovery_action: `hard-stop:${cls}`,
    });
    return { classification: cls, recovered: false, action: `hard-stop:${cls}` };
  }

  // Auto-recoverable: popups, onboarding screens, ads.
  if (cls === "popup" || cls === "onboarding" || cls === "ad-interstitial") {
    if (await tryDismissByText(driver, xml)) {
      return { classification: cls, recovered: true, action: "dismiss-text" };
    }
    if (await tryDismissByCloseIcon(driver, xml)) {
      return { classification: cls, recovered: true, action: "dismiss-icon" };
    }
    await tryBack(driver);
    return { classification: cls, recovered: true, action: "back" };
  }

  if (cls === "birthday-gate") {
    const ok = await handleBirthdayGate(driver, opts.log);
    unknownScreensRepo.record({
      device_id: driver.deviceId,
      platform: opts.platform ?? null,
      context: opts.context,
      focus,
      xml_head: xml.slice(0, 8000),
      recovered: ok,
      recovery_action: ok ? "birthday-filled" : "birthday-failed",
    });
    return { classification: cls, recovered: ok, action: ok ? "birthday-filled" : "birthday-failed" };
  }

  if (cls === "error") {
    await tryRelaunch(driver, opts.pkg ?? null);
    return { classification: cls, recovered: true, action: "relaunch" };
  }

  // main-feed: nothing to do.
  if (cls === "main-feed") {
    return { classification: cls, recovered: true, action: "-" };
  }

  // UNKNOWN: try learned (operator-curated) patterns first — they're more
  // specific than the generic ladder and were promoted from prior unknowns.
  // Only fall through to the generic dismiss → back → relaunch ladder if no
  // learned pattern matched OR the matched pattern's recovery didn't fire.
  let action = "log-only";
  let recovered = false;
  const learned = await tryLearnedPatterns(driver, xml, focus, opts.platform, opts.pkg ?? null);
  if (learned?.recovered) {
    recovered = true;
    action = `learned:${learned.pattern.name}`;
  } else if (await tryDismissByText(driver, xml)) { recovered = true; action = "dismiss-text"; }
  else if (await tryDismissByCloseIcon(driver, xml)) { recovered = true; action = "dismiss-icon"; }
  else {
    await tryBack(driver);
    // Re-check after back — if we're still in the app and the screen changed, call it recovered.
    const after = await driver.shell("dumpsys window windows | grep mCurrentFocus | head -1").catch(() => "");
    if (after !== focus) { recovered = true; action = "back"; }
    else if (opts.pkg) {
      await tryRelaunch(driver, opts.pkg);
      recovered = true;
      action = "relaunch";
    }
  }
  unknownScreensRepo.record({
    device_id: driver.deviceId,
    platform: opts.platform ?? null,
    context: opts.context,
    focus,
    xml_head: xml.slice(0, 8000),
    recovered,
    recovery_action: action,
  });
  return { classification: "unknown", recovered, action };
}
