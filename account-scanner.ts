/**
 * Auto-populate accounts by opening each app's Profile tab and reading the
 * username. Replaces the old login-state-detection approach (slow + often
 * wrong). Flow per platform:
 *
 *   1. Launch app (fallback am start if monkey fails)
 *   2. Dismiss common popups (notifications, save-login, etc)
 *   3. Tap Profile tab — by content-desc "Profile", falling back to
 *      per-platform resource-ids
 *   4. Dump UI + run a series of username parsers, first-match wins
 *   5. Upsert into accounts table
 *
 * If we can't find the username, report `not-logged-in` (could also mean
 * scan-failed; user's recourse is the same — log in and re-scan).
 */

import type { DuoplusClient } from "./duoplus.ts";
import { accountsRepo, unknownScreensRepo } from "./db.ts";
import { DeviceDriver } from "./device-driver.ts";
import { newStats } from "./human.ts";
import type { Ctx } from "./human.ts";
import { makeLogger, type SinkFn } from "./logger.ts";
import { igEnumerateAccounts } from "./platform/instagram/index.ts";
import { tiktokEnumerateAccounts } from "./platform/tiktok/index.ts";
import { threadsEnumerateAccounts } from "./platform/threads/index.ts";
import { quotasRepo } from "./db.ts";

export interface ScanResult {
  platform: "instagram" | "threads" | "tiktok";
  status: "found" | "not-logged-in" | "not-installed" | "scan-failed";
  username?: string;
  error?: string;
  focus?: string;
}

export type ScanLogFn = (level: "info" | "warn" | "error" | "ok", msg: string) => void;

const PKG = {
  instagram: "com.instagram.android",
  threads: "com.instagram.barcelona",
  tiktok: "com.zhiliaoapp.musically",
};

async function adb(
  client: DuoplusClient,
  deviceId: string,
  cmd: string,
  retries = 2,
): Promise<string> {
  let lastErr = "";
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await client.adbCommand([deviceId], cmd);
      const rec = r[deviceId];
      if (rec?.success) return rec.content ?? "";
      lastErr = rec?.message || JSON.stringify(rec).slice(0, 120);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    if (i < retries) await new Promise((r) => setTimeout(r, 1200));
  }
  // Include the actual command in the thrown error so we can debug.
  throw new Error(`adb [${cmd.slice(0, 60)}] failed: ${lastErr || "no response"}`);
}

async function launchApp(client: DuoplusClient, deviceId: string, pkg: string): Promise<void> {
  // Human-style launch: press home, glance at the home screen, ~half the
  // time swipe up to "find the icon" in the app drawer, then open. Avoids
  // the dead-giveaway pattern of firing `monkey` from inside another app's
  // task stack three times in a row.
  try {
    await adb(client, deviceId, `input keyevent KEYCODE_HOME`, 1);
  } catch { /* fall through — we'll still attempt launch */ }
  await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 1600)));
  if (Math.random() < 0.55) {
    try {
      const startX = 420 + Math.floor(Math.random() * 220);
      const startY = 1700 + Math.floor(Math.random() * 120);
      const endY = 600 + Math.floor(Math.random() * 300);
      const dur = 280 + Math.floor(Math.random() * 140);
      await adb(client, deviceId, `input swipe ${startX} ${startY} ${startX} ${endY} ${dur}`, 1);
      await new Promise((r) => setTimeout(r, 900 + Math.floor(Math.random() * 1300)));
    } catch { /* drawer swipe is optional */ }
  }
  await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 800)));

  try {
    await adb(client, deviceId, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, 1);
  } catch {
    const res = await adb(
      client,
      deviceId,
      `cmd package resolve-activity --brief ${pkg} | tail -n 1`,
      1,
    );
    const activity = res.trim();
    if (!activity.includes("/")) throw new Error(`no launcher activity for ${pkg}`);
    await adb(client, deviceId, `am start -n ${activity}`);
  }
  // TikTok takes longer than IG/Threads to hydrate its feed; other apps
  // finish in ~8s. Give everyone the slower budget to be safe.
  await new Promise((r) => setTimeout(r, pkg.includes("musically") ? 14000 : 8000));
}

/**
 * Wait until the UI dump shows something other than empty FrameLayouts —
 * i.e., the app has actually rendered its feed. Polls up to ~20s. Returns
 * the last XML dump we saw (which may still be mostly-empty if timeout fires).
 */
async function waitForHydratedUi(
  client: DuoplusClient,
  deviceId: string,
  timeoutMs = 20000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      await adb(client, deviceId, "uiautomator dump /sdcard/_wait.xml", 1);
      last = await adb(client, deviceId, "cat /sdcard/_wait.xml", 1);
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    // "Hydrated" signal: at least one non-empty content-desc OR text OR
    // a known feed/tab resource-id.
    const hasText = /text="[^"]{2,}"/.test(last);
    const hasDesc = /content-desc="[^"]{2,}"/.test(last);
    if (hasText || hasDesc) return last;
    await new Promise((r) => setTimeout(r, 2500));
  }
  return last;
}

/** Light dismiss — try common buttons for a few rounds then move on. */
async function quickDismissPopups(client: DuoplusClient, deviceId: string): Promise<void> {
  const LABELS = [
    "Not now", "Not Now", "Skip", "Maybe later", "Later",
    "Got it", "OK", "Close", "DONT ALLOW", "DON'T ALLOW",
    "Don't allow", "Deny", "Decline",
  ];
  for (let round = 0; round < 3; round++) {
    let xml = "";
    try {
      await adb(client, deviceId, "uiautomator dump /sdcard/_p.xml", 1);
      xml = await adb(client, deviceId, "cat /sdcard/_p.xml", 1);
    } catch { break; }
    let clicked = false;
    for (const label of LABELS) {
      const re = new RegExp(
        `<node[^/]*?text="${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^/]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
        "i",
      );
      const m = xml.match(re);
      if (m) {
        const x = Math.floor((+m[1] + +m[3]) / 2);
        const y = Math.floor((+m[2] + +m[4]) / 2);
        await adb(client, deviceId, `input tap ${x} ${y}`, 0);
        await new Promise((r) => setTimeout(r, 1200));
        clicked = true;
        break;
      }
    }
    if (!clicked) break;
  }
}

async function dumpUi(client: DuoplusClient, deviceId: string): Promise<string> {
  await adb(client, deviceId, "uiautomator dump /sdcard/_u.xml", 1);
  return await adb(client, deviceId, "cat /sdcard/_u.xml", 1);
}

async function currentActivity(client: DuoplusClient, deviceId: string): Promise<string> {
  try {
    return await adb(
      client,
      deviceId,
      "dumpsys window windows | grep mCurrentFocus | head -1",
      0,
    );
  } catch { return ""; }
}

/** Tap the Profile tab. Returns true if a tap fired.
 *  Strategy order: per-platform resource-id → EXACT content-desc="Profile"
 *  → platform-specific fallbacks. TikTok strips accessibility info off its
 *  bottom-nav tabs in newer builds (every tab is just an empty FrameLayout
 *  with an obfuscated resource-id), so we fall back to a coordinate tap at
 *  the bottom-right of the screen where the Profile tab always lives.
 */
async function tapProfileTab(
  client: DuoplusClient,
  deviceId: string,
  platform: keyof typeof PKG,
  xml: string,
): Promise<boolean> {
  const rids: Record<string, RegExp> = {
    instagram: /<node[^/]*?resource-id="com\.instagram\.android:id\/profile_tab"[^/]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/,
    threads: /<node[^/]*?resource-id="barcelona_tab_profile"[^/]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/,
    tiktok: /<node[^/]*?resource-id="com\.zhiliaoapp\.musically:id\/[a-z_0-9]*profile[a-z_0-9]*"[^/]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i,
  };

  const tryTap = async (m: RegExpMatchArray): Promise<boolean> => {
    const x = Math.floor((+m[1] + +m[3]) / 2);
    const y = Math.floor((+m[2] + +m[4]) / 2);
    await adb(client, deviceId, `input tap ${x} ${y}`, 0);
    await new Promise((r) => setTimeout(r, 3000));
    return true;
  };

  // 1. Per-platform resource-id (unambiguous tab bar id).
  const ridRe = rids[platform];
  const mId = xml.match(ridRe);
  if (mId) return tryTap(mId as unknown as RegExpMatchArray);

  // 2. EXACT content-desc="Profile" — not "Profile picture of X".
  const mExact = xml.match(
    /<node[^/]*?content-desc="Profile"[^/]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/,
  );
  if (mExact) return tryTap(mExact);

  if (platform === "tiktok") {
    // 3a. text="Profile" bottom-tab button.
    const mText = xml.match(
      /<node[^/]*?text="Profile"[^/]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/,
    );
    if (mText) return tryTap(mText);
    // 3b. Coordinate fallback — read screen size from root frame bounds and
    //     tap the bottom-right corner where Profile tab ALWAYS lives on TikTok.
    //     5 tabs across: Home / Friends / + / Inbox / Profile. Profile is at
    //     roughly 90% x, 97% y.
    const sizeM = xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
    const w = sizeM ? +sizeM[1] : 1080;
    const h = sizeM ? +sizeM[2] : 1920;
    const x = Math.floor(w * 0.9);
    const y = Math.floor(h * 0.97);
    await adb(client, deviceId, `input tap ${x} ${y}`, 0);
    await new Promise((r) => setTimeout(r, 3000));
    return true;
  }

  return false;
}

/** Looks like an IG/TT/Threads handle?
 *  Rules: 3–30 chars, letters/numbers/dots/underscores, NOT a common UI-label
 *  pattern. The 3-char floor rejects "@1" / "@hi" page-markers. The
 *  anti-label heuristic rejects pure-title-case single words (e.g. "Calendar",
 *  "Settings") — real handles rarely have that shape, while Android nav
 *  labels almost always do.
 *
 *  Known-bad cases caught (from live observation):
 *    "@1"         — hit as IG handle, actually a page number
 *    "@Calendar"  — hit as TikTok handle, actually a tab label
 *    "@Settings", "@Home", "@Profile" — similar
 *  Known-good cases still accepted:
 *    "m.y.name", "some_user", "alex123", "u.s_er"
 */
const ANDROID_LABEL_WORDS: ReadonlySet<string> = new Set([
  "Home", "Search", "Profile", "Settings", "Calendar", "Messages", "Inbox",
  "Activity", "Create", "Camera", "Gallery", "Videos", "Photos", "Feed",
  "Following", "Followers", "Explore", "Reels", "Shorts", "Stories",
  "Notifications", "Discover", "Shopping", "Marketplace", "Live",
]);

function looksLikeHandle(s: string): boolean {
  const t = s.trim().replace(/^@/, "");
  if (t.length < 3 || t.length > 30) return false;
  if (!/^[a-zA-Z0-9._]+$/.test(t)) return false;
  if (ANDROID_LABEL_WORDS.has(t)) return false;
  // Pure title-case single word is almost always a UI label, not a handle.
  // Real handles overwhelmingly use lowercase + digits/separators.
  if (/^[A-Z][a-z]+$/.test(t)) return false;
  return true;
}

/**
 * Top-of-screen handle search — iterate every <node text="..."> whose bounds
 * place it in the top half of the screen, return the best handle-shaped match.
 *
 * Ranking: prefer strings with a '.', '_', or digit (handles are usually
 * stylized — display names like "lokiii" are pure letters). When equal, take
 * the topmost. Catches IG's action-bar title AND Threads's handle-under-
 * display-name pattern regardless of resource-id.
 */
function findTopHandle(xml: string): string | null {
  const nodeRe = /<node[^>]*?text="([^"]+)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*?\/?>/g;
  let m: RegExpExecArray | null;
  const candidates: Array<{ text: string; y: number; stylized: boolean }> = [];
  while ((m = nodeRe.exec(xml)) !== null) {
    const text = m[1];
    const yTop = +m[3];
    // Top half of a typical 2340-tall screen ≈ 1170; cap at 900 to stay
    // well above the main content area.
    if (yTop > 900) continue;
    if (!looksLikeHandle(text)) continue;
    const stylized = /[._0-9]/.test(text); // handles usually have one
    candidates.push({ text, y: yTop, stylized });
  }
  // Sort: stylized first, then topmost within each group.
  candidates.sort((a, b) => {
    if (a.stylized !== b.stylized) return a.stylized ? -1 : 1;
    return a.y - b.y;
  });
  return candidates.length ? candidates[0].text.trim() : null;
}

/** Extract username from a profile-page UI dump. */
function parseUsername(xml: string, platform: keyof typeof PKG): string | null {
  if (platform === "instagram") {
    // Known-good sources (in descending reliability).
    const mOpt = xml.match(/content-desc="Options for ([^"']+)"/);
    if (mOpt && looksLikeHandle(mOpt[1])) return mOpt[1].trim();

    const ids = [
      "action_bar_title_auto_size",
      "action_bar_large_title_auto_size",
      "action_bar_textview_title",
      "action_bar_title",
      "profile_header_title_username",
      "profile_header_username",
      "username",
      "title",
    ];
    for (const id of ids) {
      const re = new RegExp(
        `resource-id="com\\.instagram\\.android:id\\/${id}"[^>]*?text="([^"]+)"`,
      );
      const m = xml.match(re);
      if (m && looksLikeHandle(m[1])) return m[1].trim();
    }
    const mPic = xml.match(/content-desc="([^"']+)'s profile picture"/);
    if (mPic && looksLikeHandle(mPic[1])) return mPic[1].trim();

    // Last resort: any handle-shaped text in the top third of screen.
    const top = findTopHandle(xml);
    if (top) return top;
  }
  if (platform === "threads") {
    const mSet = xml.match(/content-desc="Open Settings for ([^"]+)"/);
    if (mSet && looksLikeHandle(mSet[1])) return mSet[1].trim();
    const mAt = xml.match(/text="@([a-zA-Z0-9._]{1,30})"/);
    if (mAt) return mAt[1].trim();
    const mRid = xml.match(/resource-id="[^"]*profile_header_username[^"]*"[^>]*?text="([^"]+)"/i);
    if (mRid && looksLikeHandle(mRid[1])) return mRid[1].trim();
    const top = findTopHandle(xml);
    if (top) return top;
  }
  if (platform === "tiktok") {
    const ridRes = [
      xml.match(/resource-id="com\.zhiliaoapp\.musically:id\/[a-z_0-9]*unique_id[a-z_0-9]*"[^>]*?text="([^"]+)"/i),
      xml.match(/resource-id="com\.zhiliaoapp\.musically:id\/[a-z_0-9]*user_name[a-z_0-9]*"[^>]*?text="([^"]+)"/i),
    ];
    for (const m of ridRes) {
      if (m && looksLikeHandle(m[1])) return m[1].trim();
    }
    const mAt = xml.match(/text="@([a-zA-Z0-9._]{1,30})"/);
    if (mAt) return mAt[1].trim();
    const top = findTopHandle(xml);
    if (top) return top;
  }
  return null;
}

async function scanPlatform(
  client: DuoplusClient,
  deviceId: string,
  platform: keyof typeof PKG,
  log: ScanLogFn,
): Promise<ScanResult> {
  try {
    log("info", `  [${platform}] launching ${PKG[platform]}...`);
    try {
      await launchApp(client, deviceId, PKG[platform]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no launcher activity|NameNotFound|does not exist|No activities found/i.test(msg)) {
        log("info", `  [${platform}] not installed`);
        return { platform, status: "not-installed" };
      }
      return { platform, status: "scan-failed", error: msg };
    }
    await quickDismissPopups(client, deviceId);
    const focus = await currentActivity(client, deviceId);

    // Wait for the app to actually hydrate before tapping anything. TikTok
    // in particular can sit on empty FrameLayouts for 10+s before the feed
    // renders — tapping during that window hits nothing.
    let xml = await waitForHydratedUi(client, deviceId);
    // Tap Profile tab — 3 attempts (button sometimes needs another beat).
    let tapped = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await tapProfileTab(client, deviceId, platform, xml)) {
        tapped = true;
        break;
      }
      await quickDismissPopups(client, deviceId);
      await new Promise((r) => setTimeout(r, 2500));
      xml = await dumpUi(client, deviceId);
    }
    if (!tapped) {
      log("warn", `  [${platform}] couldn't find Profile tab — likely not logged in`);
      unknownScreensRepo.record({
        device_id: deviceId, platform, context: "scan-no-profile-tab",
        focus, xml_head: xml, recovered: false, recovery_action: "-",
      });
      return { platform, status: "not-logged-in", focus };
    }

    // Parse username from the opened profile page.
    xml = await dumpUi(client, deviceId);
    let username = parseUsername(xml, platform);
    if (!username) {
      // One more beat in case the page is still loading.
      await new Promise((r) => setTimeout(r, 2500));
      xml = await dumpUi(client, deviceId);
      username = parseUsername(xml, platform);
    }
    if (!username) {
      log("warn", `  [${platform}] Profile opened but couldn't parse username`);
      unknownScreensRepo.record({
        device_id: deviceId, platform, context: "scan-no-username",
        focus, xml_head: xml, recovered: false, recovery_action: "-",
      });
      return { platform, status: "not-logged-in", focus };
    }
    log("ok", `  [${platform}] @${username}`);
    return { platform, status: "found", username, focus };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("warn", `  [${platform}] scan error: ${msg}`);
    return { platform, status: "scan-failed", error: msg };
  }
}

function shuffle<T>(input: readonly T[]): T[] {
  // Operate on a copy — never mutate the caller's array.
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Scan all three platforms, upsert found accounts into DB, return results.
 */
export async function scanDevice(
  client: DuoplusClient,
  deviceId: string,
  log: ScanLogFn = () => {},
): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  const platforms = shuffle(["instagram", "threads", "tiktok"] as const).slice();
  for (const platform of platforms) {
    const res = await scanPlatform(client, deviceId, platform, log);
    results.push(res);
    if (res.status === "found" && res.username) {
      const all = await accountsRepo.list();
      const existing = all.find((a) => a.device_id === deviceId && a.platform === platform);
      if (existing) {
        if (existing.username !== res.username) {
          await accountsRepo.update(existing.id, { username: res.username, status: "active" });
        }
      } else {
        await accountsRepo.create({
          device_id: deviceId,
          platform,
          username: res.username,
          notes: "auto-scanned from device",
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Multi-account scanner — uses the per-platform account switchers so we
// discover every logged-in handle on the device, not just the active one.
// ---------------------------------------------------------------------------

export interface MultiScanResult {
  platform: "instagram" | "threads" | "tiktok";
  /** Empty array means "no accounts" — could be not-installed or genuinely no logins. */
  usernames: string[];
  /** Indicates why usernames is empty when it is. */
  status: "found" | "not-logged-in" | "not-installed" | "scan-failed";
  error?: string;
}

/** Build a minimal Ctx around a DeviceDriver so we can call switcher helpers. */
async function ctxFor(
  driver: DeviceDriver,
  platform: "instagram" | "threads" | "tiktok",
  log: SinkFn,
): Promise<Ctx> {
  // Quotas are only needed to satisfy the type — the scanner doesn't actually
  // consume any quota field. Pull the row defensively in case some downstream
  // helper does read it; if the read fails we synthesize a stub.
  let quota;
  try {
    quota = await quotasRepo.get(platform);
  } catch {
    quota = {
      platform,
      session_min_min: 10, session_max_min: 15,
      feed_scrolls_min: 0, feed_scrolls_max: 0,
      reels_min: 0, reels_max: 0,
      stories_min: 0, stories_max: 0,
      explore_scrolls_min: 0, explore_scrolls_max: 0,
      likes_per_session: 0, comments_per_session: 0, follows_per_session: 0,
      unfollows_per_session: 0, dms_per_session: 0, shares_per_session: 0,
      profile_visits_per_session: 0, daily_follow_cap: 0, daily_action_cap: 0,
      updated_at: 0,
    };
  }
  return {
    driver,
    quota,
    log,
    stats: newStats(platform),
    deadline: Date.now() + 5 * 60 * 1000,  // 5-min budget per platform scan
  };
}

/**
 * Scan ONE platform on a device using the switcher to enumerate every
 * logged-in handle. The active account is whichever the app boots into;
 * the switcher reveals the rest.
 *
 * Calls the platform's launch flow + popup dismissal first so the switcher
 * has a clean state to work with. Returns at-most-one row even on errors so
 * the caller can show a per-platform status.
 */
async function multiScanPlatform(
  client: DuoplusClient,
  deviceId: string,
  platform: "instagram" | "threads" | "tiktok",
  isLocal: boolean,
  log: SinkFn,
): Promise<MultiScanResult> {
  const driver = new DeviceDriver(client, deviceId, log, isLocal ? "local" : "cloud");
  const slog = makeLogger(log, { device_id: deviceId, platform, phase: "scan" });

  try {
    slog.event("info", "scan.started", `launching ${PKG[platform]}`);
    try {
      await launchApp(client, deviceId, PKG[platform]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no launcher activity|NameNotFound|does not exist|No activities found/i.test(msg)) {
        slog.event("info", "scan.not-installed", `${platform} not installed`);
        return { platform, status: "not-installed", usernames: [] };
      }
      slog.fail("scan.launch-failed", `launch ${platform}`, err);
      return { platform, status: "scan-failed", usernames: [], error: msg };
    }
    await quickDismissPopups(client, deviceId);
    await waitForHydratedUi(client, deviceId);

    const ctx = await ctxFor(driver, platform, log);
    let usernames: string[] = [];
    try {
      if (platform === "instagram") {
        usernames = await igEnumerateAccounts(ctx, slog);
      } else if (platform === "tiktok") {
        usernames = await tiktokEnumerateAccounts(ctx, slog);
      } else {
        usernames = await threadsEnumerateAccounts(ctx, slog);
      }
    } catch (err) {
      slog.fail("scan.enumerate-failed", `enumerate ${platform}`, err);
      return { platform, status: "scan-failed", usernames: [], error: String(err) };
    }

    if (usernames.length === 0) {
      slog.event("warn", "scan.no-accounts", `${platform}: switcher returned no accounts`);
      return { platform, status: "not-logged-in", usernames: [] };
    }

    slog.event("ok", "scan.found", `${platform}: ${usernames.length} account(s)`, { usernames });
    return { platform, status: "found", usernames };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    slog.fail("scan.error", `${platform} scan`, err);
    return { platform, status: "scan-failed", usernames: [], error: msg };
  }
}

/**
 * Multi-account scan across all three platforms. Upserts every discovered
 * handle into `accounts`. Existing rows are LEFT ALONE (we don't flip status
 * during a scan — that's the runner's job). New rows are created with
 * status='active' and notes indicating the scan provenance.
 *
 * `isLocal` — true if this device is local ADB, false for Duoplus cloud.
 * The DeviceDriver routing depends on this; the launch helper is the same
 * in both cases.
 */
export async function multiScanDevice(
  client: DuoplusClient,
  deviceId: string,
  isLocal: boolean,
  log: SinkFn = () => {},
): Promise<MultiScanResult[]> {
  const slog = makeLogger(log, { device_id: deviceId, phase: "multi-scan" });
  slog.event("info", "scan.started", `multi-account scan of ${deviceId}`);
  const results: MultiScanResult[] = [];

  // Randomize platform order so we don't fingerprint as "always IG first."
  const platforms = shuffle(["instagram", "threads", "tiktok"] as const);

  for (const platform of platforms) {
    const res = await multiScanPlatform(client, deviceId, platform, isLocal, log);
    results.push(res);

    // Upsert each discovered handle. We rely on the (device_id, platform,
    // username) UNIQUE constraint to make this idempotent.
    for (const username of res.usernames) {
      const existing = await accountsRepo.findByUsername(platform, username);
      if (!existing) {
        await accountsRepo.create({
          device_id: deviceId,
          platform,
          username,
          notes: `auto-scanned ${new Date().toISOString().slice(0, 10)}`,
        });
        slog.event("ok", "account.added", `+ @${username}`, { platform });
      } else if (existing.device_id !== deviceId) {
        // The handle exists in DB but bound to a different device. Don't
        // silently re-bind — log it so a human can decide whether the
        // account moved (rare — usually a sign of a bad scan or a deleted
        // device row). Could also indicate a collision the scanner can't
        // resolve.
        slog.event("warn", "account.cross-device", `@${username} already bound to ${existing.device_id}`, {
          platform,
          existingDeviceId: existing.device_id,
        });
      }
    }
  }

  slog.event("ok", "scan.completed", `scan done: ${results.map(r => `${r.platform}=${r.usernames.length}`).join(" ")}`);
  return results;
}
