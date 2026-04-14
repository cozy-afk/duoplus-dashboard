/**
 * UI-first bottom-nav navigation.
 *
 * Android apps drift their resource-ids between builds (especially IG —
 * `feed_tab` → `home_tab_pill` → whatever's next). Hardcoding IDs means
 * every new build breaks the nav; coordinate fallbacks make it worse by
 * tapping the wrong slot when the bar layout shifts. This resolver looks
 * at the ACTUAL RENDERED UI instead:
 *
 *   1. Dump UI
 *   2. Find every clickable node in the bottom ~12% of the screen
 *   3. For each, aggregate EVERY identifying attribute from its subtree
 *      (content-desc, text, resource-id, self + descendants)
 *   4. Match the aggregate against a platform-specific ALIAS dictionary
 *      per tab. Score matches by specificity:
 *        content-desc exact match    = 100
 *        resource-id contains alias  = 70
 *        text contains alias         = 60
 *        content-desc contains alias = 50
 *   5. Pick the highest-scoring clickable per tab, tap it, verify.
 *
 * This approach survives resource-id renames, content-desc stripping, A/B
 * layout changes, and screen-size drift — because it doesn't depend on
 * any single attribute or position. If ANY identifying piece of the tab
 * is still in the dump, we find it.
 *
 * Fallback: if no clickable scores high enough (unknown layout or
 * obfuscated-everything like TikTok's late builds), the caller's
 * `currentTab` function still works for verification, but navigation
 * itself falls back to the platform's own coordinate heuristics — a
 * last-resort patch specific to that platform, not the default path.
 */

import { randint, sleep } from "./device-driver.ts";
import type { DeviceDriver } from "./device-driver.ts";
import type { Ctx, LogFn } from "./human.ts";

export interface TabMeta {
  /** Known resource-id fragments for this tab (substring match across builds). */
  rid: string;
  /** content-desc aliases (exact or substring) — "Home", "Profile", "Reels, tab", etc. */
  descs: string[];
  /** Visible text aliases — optional; tabs with labels use these. */
  texts?: string[];
  /** 0-based slot index — used ONLY for the last-resort coordinate fallback. */
  slot: number;
}

export interface NavConfig<T extends string> {
  /** Short label used in logs — "IG", "Threads", etc. */
  platformName: string;
  /** Tab → locator metadata map. */
  tabs: Record<T, TabMeta>;
  /** Returns which tab is currently selected, or null if inconclusive. */
  currentTab: (driver: DeviceDriver, xml?: string) => Promise<T | null>;
}

// ---------------------------------------------------------------------------
// XML tree parser — extracts bounded node records we can walk.
// uiautomator dumps are well-formed enough that a simple tag-walker works;
// we don't need a real XML parser (which Bun doesn't ship anyway).
// ---------------------------------------------------------------------------

interface UiNode {
  bounds: [number, number, number, number];  // [x1,y1,x2,y2]
  clickable: boolean;
  text: string;
  desc: string;     // content-desc
  rid: string;      // resource-id
  className: string;
}

/**
 * Parse every <node ...> tag (open or self-close) out of the XML, one per
 * regex match. Returns nodes in document order. Bounds is mandatory; nodes
 * without bounds are skipped.
 */
function parseNodes(xml: string): UiNode[] {
  // Match each <node ... /> or <node ...> opening. We don't need to pair
  // with closing tags — the parent/child relation is derived from bounds
  // containment, which is how uiautomator lays them out anyway.
  const re = /<node([^>]*)\/?>/g;
  const nodes: UiNode[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(attrs);
    if (!bounds) continue;
    nodes.push({
      bounds: [+bounds[1], +bounds[2], +bounds[3], +bounds[4]],
      clickable: /clickable="true"/.test(attrs),
      text: /text="([^"]*)"/.exec(attrs)?.[1] ?? "",
      desc: /content-desc="([^"]*)"/.exec(attrs)?.[1] ?? "",
      rid: /resource-id="([^"]*)"/.exec(attrs)?.[1] ?? "",
      className: /class="([^"]*)"/.exec(attrs)?.[1] ?? "",
    });
  }
  return nodes;
}

/** Is `child`'s bounding box fully inside `parent`'s? */
function contains(parent: UiNode, child: UiNode): boolean {
  return (
    child.bounds[0] >= parent.bounds[0] &&
    child.bounds[1] >= parent.bounds[1] &&
    child.bounds[2] <= parent.bounds[2] &&
    child.bounds[3] <= parent.bounds[3] &&
    // Proper subset — a node doesn't contain itself.
    (child.bounds[0] !== parent.bounds[0] ||
     child.bounds[1] !== parent.bounds[1] ||
     child.bounds[2] !== parent.bounds[2] ||
     child.bounds[3] !== parent.bounds[3])
  );
}

/** All ids/text/descs present in `root` OR any node bounded inside it. */
function subtreeAttrs(root: UiNode, allNodes: UiNode[]): {
  texts: string[]; descs: string[]; rids: string[];
} {
  const texts = new Set<string>();
  const descs = new Set<string>();
  const rids = new Set<string>();
  const collect = (n: UiNode) => {
    if (n.text) texts.add(n.text);
    if (n.desc) descs.add(n.desc);
    if (n.rid) rids.add(n.rid);
  };
  collect(root);
  for (const n of allNodes) {
    if (contains(root, n)) collect(n);
  }
  return { texts: [...texts], descs: [...descs], rids: [...rids] };
}

/**
 * Score how well a tab's aliases match a clickable node's subtree attrs.
 * Higher is better; 0 means no match. Tuned so that exact content-desc
 * matches beat every other signal — that's the single most reliable Android
 * accessibility marker.
 */
function scoreTabMatch(
  tab: TabMeta,
  attrs: { texts: string[]; descs: string[]; rids: string[] },
): number {
  let score = 0;
  for (const d of tab.descs) {
    // Exact match on any desc is a very strong signal.
    if (attrs.descs.some((x) => x === d || x === `${d}, tab`)) score = Math.max(score, 100);
    // Substring contains — weaker.
    if (attrs.descs.some((x) => x.includes(d))) score = Math.max(score, 50);
  }
  if (tab.rid) {
    if (attrs.rids.some((x) => x.endsWith(`/${tab.rid}`) || x === tab.rid)) {
      score = Math.max(score, 85);
    }
    if (attrs.rids.some((x) => x.includes(tab.rid))) score = Math.max(score, 70);
  }
  for (const t of tab.texts ?? []) {
    if (attrs.texts.some((x) => x === t)) score = Math.max(score, 80);
    if (attrs.texts.some((x) => x.includes(t))) score = Math.max(score, 60);
  }
  return score;
}

/**
 * UI-first tab resolver: return the center of the best-matching clickable
 * for each tab, keyed by tab name. Any tab with no match is omitted.
 */
function resolveTabs<T extends string>(
  xml: string,
  screenSize: { width: number; height: number },
  config: NavConfig<T>,
): Partial<Record<T, { x: number; y: number; score: number; rootRid: string }>> {
  const nodes = parseNodes(xml);
  const navBandTop = Math.floor(screenSize.height * 0.85);
  const roots = nodes.filter(
    (n) => n.clickable && n.bounds[1] >= navBandTop && n.bounds[3] > n.bounds[1],
  );
  const out: Partial<Record<T, { x: number; y: number; score: number; rootRid: string }>> = {};
  for (const [tabName, meta] of Object.entries(config.tabs) as [T, TabMeta][]) {
    let best: { x: number; y: number; score: number; rootRid: string } | null = null;
    for (const root of roots) {
      const attrs = subtreeAttrs(root, nodes);
      const score = scoreTabMatch(meta, attrs);
      if (score > 0 && (!best || score > best.score)) {
        best = {
          x: Math.floor((root.bounds[0] + root.bounds[2]) / 2),
          y: Math.floor((root.bounds[1] + root.bounds[3]) / 2),
          score,
          rootRid: root.rid,
        };
      }
    }
    if (best) out[tabName] = best;
  }
  return out;
}

/**
 * Legacy helper kept for callers that just want a list of nav slots left
 * to right. New nav code should use `resolveTabs` + the NavConfig instead —
 * that matches by attribute, not by index-in-band.
 */
export async function findBottomNavSlots(driver: DeviceDriver, xml?: string): Promise<Array<{ x: number; y: number }>> {
  const x = xml ?? (await driver.dumpUi());
  const size = await driver.screenSize();
  const minTop = Math.floor(size.height * 0.85);
  const slots: Array<{ x: number; y: number }> = [];
  const re = /<node[^/]*?clickable="true"[^/]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(x))) {
    const y1 = +m[2], y2 = +m[4];
    if (y1 < minTop) continue;
    const cx = Math.floor((+m[1] + +m[3]) / 2);
    const cy = Math.floor((y1 + y2) / 2);
    if (slots.some((s) => Math.abs(s.x - cx) < 20)) continue;
    slots.push({ x: cx, y: cy });
  }
  return slots.sort((a, b) => a.x - b.x);
}

/**
 * Navigate to a bottom-nav tab using the UI-first resolver.
 *
 * Flow:
 *   1. Already on target tab (per currentTab)? Return immediately.
 *   2. Dump UI, resolve all tabs by attribute matching.
 *   3. If target tab resolved, tap it + verify.
 *   4. If verification says we're on a DIFFERENT resolved tab, try again
 *      by tapping the target's resolved coords (rare — indicates a tap
 *      landed adjacent due to a half-rendered bar; a second tap hits
 *      the now-stable layout).
 *   5. Last-resort coordinate fallback by slot index. Verified — no
 *      "trust if unknown" here since coordinates are exactly what
 *      caused the "home tap landed on reels" class of bug.
 */
export async function goToTab<T extends string>(
  c: Ctx,
  config: NavConfig<T>,
  tab: T,
): Promise<boolean> {
  const meta = config.tabs[tab];
  const plat = config.platformName;
  const log: LogFn = c.log;

  c.watchdog?.suppress(30000);

  // Already there?
  const initial = await config.currentTab(c.driver);
  if (initial === tab) {
    log("info", `  [${plat}] already on ${tab} tab`);
    return true;
  }

  const xml = await c.driver.dumpUi();
  const size = await c.driver.screenSize();
  const resolved = resolveTabs(xml, size, config);
  const target = resolved[tab];

  const verifyAfter = async (): Promise<T | null> => {
    await sleep(randint(1400, 2400));
    return await config.currentTab(c.driver);
  };

  if (target) {
    log(
      "info",
      `  [${plat}] ${tab} tab resolved (score=${target.score}${target.rootRid ? ` rid=${target.rootRid}` : ""}) → tap (${target.x}, ${target.y})`,
    );
    await c.driver.tap(target.x, target.y, 0);
    const after1 = await verifyAfter();
    if (after1 === tab) return true;
    // One retry — some builds need a beat for the tab content to render.
    if (after1 !== tab && after1 != null) {
      log("warn", `  [${plat}] landed on ${after1}, retrying ${tab}`);
      await c.driver.tap(target.x, target.y, 0);
      const after2 = await verifyAfter();
      if (after2 === tab) return true;
    } else if (after1 === null) {
      // Inconclusive — trust, because the resolver was confident.
      log("info", `  [${plat}] ${tab} tapped; verification inconclusive, trusting (score=${target.score})`);
      return true;
    }
  } else {
    log("warn", `  [${plat}] resolver found no ${tab} tab in the current UI (known tabs: ${Object.keys(resolved).join(", ") || "none"})`);
  }

  // Coordinate fallback. Only runs when the resolver couldn't find the tab
  // at all OR the resolved tap repeatedly missed — either way, something
  // about this build is truly unusual. We take ONE shot and require hard
  // verification; no trust-if-unknown here.
  const slotWidth = size.width / 5;
  const slotX = Math.floor(slotWidth * (meta.slot + 0.5));
  const slotY = Math.floor(size.height * 0.95);
  log("warn", `  [${plat}] coord fallback → (${slotX}, ${slotY}) slot ${meta.slot}`);
  await c.driver.tap(slotX, slotY, 0);
  const afterCoord = await verifyAfter();
  if (afterCoord === tab) return true;

  log("warn", `  [${plat}] all strategies failed to reach ${tab} tab — proceeding anyway (current=${afterCoord ?? "unknown"})`);
  return false;
}

/**
 * Wait for the app's bottom-nav to render. Use this right after launch /
 * relaunch before doing any taps — prevents the class of bug where we tap
 * at a coordinate during the splash screen or mid-hydration and hit
 * whatever happens to be under the cursor.
 */
export async function waitForAppReady<T extends string>(
  c: Ctx,
  config: NavConfig<T>,
  expectedTabs = 3,
  maxWaitMs = 18000,
): Promise<boolean> {
  const plat = config.platformName;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const xml = await c.driver.dumpUi();
      const size = await c.driver.screenSize();
      const resolved = resolveTabs(xml, size, config);
      const count = Object.keys(resolved).length;
      if (count >= expectedTabs) {
        c.log("info", `  [${plat}] app ready — ${count}/${Object.keys(config.tabs).length} tabs resolvable`);
        return true;
      }
    } catch { /* transient — retry */ }
    await sleep(randint(900, 1500));
  }
  c.log("warn", `  [${plat}] app-ready wait timed out — proceeding anyway`);
  return false;
}

/**
 * Re-entry validator: confirms we're on a known top-level tab, and if not,
 * presses Back / force-closes until we are. Called at the start of every
 * warmup session because a previous session may have died deep in the app
 * (on a profile, in Settings, mid-story-viewer, etc.) and app re-launch
 * resumes that state instead of the Home feed.
 *
 * Strategy:
 *   1. dumpUi → currentTab(). If already on `homeTab`, done.
 *   2. If on another known tab (profile / explore / etc), just nav to home.
 *   3. If currentTab returns null (unknown state — modal, profile, DM, etc):
 *      press Back up to `maxBacks` times, re-checking after each press.
 *   4. Still unknown? Force-stop + relaunch the app (caller-provided pkg),
 *      then one more currentTab check.
 *
 * Returns true if we ended up on homeTab, false otherwise (caller decides
 * whether to proceed or bail).
 */
export async function validateAndResetToHome<T extends string>(
  c: Ctx,
  config: NavConfig<T>,
  homeTab: T,
  pkg: string,
  maxBacks = 4,
): Promise<boolean> {
  const log = c.log;
  const plat = config.platformName;
  c.watchdog?.suppress(45000);

  // Step 1: are we already on a known tab?
  let current = await config.currentTab(c.driver);
  if (current === homeTab) {
    log("info", `  [${plat}] re-entry: already on ${homeTab}`);
    return true;
  }
  if (current != null) {
    log("info", `  [${plat}] re-entry: on ${current}, nav'ing to ${homeTab}`);
    return await goToTab(c, config, homeTab);
  }

  // Step 2: unknown state — press Back repeatedly. Each press might
  // dismiss a modal, exit a story-viewer, pop a profile page, etc. After
  // each, re-check. Most "stuck-deep" sessions recover within 2-3 presses.
  log("warn", `  [${plat}] re-entry: unknown state — pressing Back up to ${maxBacks}×`);
  for (let i = 0; i < maxBacks; i++) {
    await c.driver.pressBack();
    await sleep(randint(900, 1700));
    current = await config.currentTab(c.driver);
    if (current === homeTab) {
      log("info", `  [${plat}] re-entry: recovered to ${homeTab} after ${i + 1} back(s)`);
      return true;
    }
    if (current != null) {
      log("info", `  [${plat}] re-entry: landed on ${current} after ${i + 1} back(s); nav to ${homeTab}`);
      return await goToTab(c, config, homeTab);
    }
  }

  // Step 3: nuclear option — force-stop + relaunch. Previous session
  // state is now definitely gone; the app will cold-start on whatever
  // its default activity is, which is usually (not always) Home.
  log("warn", `  [${plat}] re-entry: force-close + relaunch ${pkg}`);
  try {
    await c.driver.shell(`am force-stop ${pkg}`);
  } catch { /* best-effort */ }
  await sleep(randint(1500, 2500));
  try {
    await c.driver.launchApp(pkg);
  } catch (err) {
    log("error", `  [${plat}] relaunch failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  await sleep(randint(4500, 7000));
  current = await config.currentTab(c.driver);
  if (current === homeTab) {
    log("info", `  [${plat}] re-entry: cold-start landed on ${homeTab}`);
    return true;
  }
  if (current != null) {
    log("info", `  [${plat}] re-entry: cold-start landed on ${current}; nav to ${homeTab}`);
    return await goToTab(c, config, homeTab);
  }
  log("error", `  [${plat}] re-entry: cold-start still unknown — giving up`);
  return false;
}
