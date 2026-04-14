/**
 * DeviceDriver — thin ADB helper that abstracts over cloud (Duoplus) vs
 * local (USB / Wi-Fi debug) devices. Every automation action flows through
 * these primitives so individual platform flows stay readable and retries
 * / logging are centralized.
 */

import type { DuoplusClient } from "./duoplus.ts";
import { localAdbShell } from "./local-adb.ts";

export type LogFn = (level: "info" | "warn" | "error" | "ok", msg: string) => void;

export interface BoundsCenter {
  x: number;
  y: number;
}

const PARSE_NODE = (tag: string): BoundsCenter | null => {
  const m = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!m) return null;
  const x1 = +m[1], y1 = +m[2], x2 = +m[3], y2 = +m[4];
  return { x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2) };
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
export const randint = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;
/** Roll N%. Returns true with probability n/100. */
export const roll = (n: number) => Math.random() * 100 < n;
/** Pick a random element. */
export const pick = <T>(arr: readonly T[]): T => arr[randint(0, arr.length - 1)];
/** Shuffle in place. */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randint(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Human-like delay distributions. Real users aren't uniformly distributed on
 * `randint(a, b)` — they're bimodal: mostly fast reactions with a long tail
 * of "paused and thinking" moments. Buckets approximate that.
 */
export function humanPostTapMs(): number {
  const r = Math.random();
  if (r < 0.70) return randint(140, 380);   // quick next-action
  if (r < 0.92) return randint(420, 900);   // settle + glance
  return randint(1200, 2800);               // paused / noticed something
}
export function humanReadMs(): number {
  const r = Math.random();
  if (r < 0.55) return randint(2500, 5500);   // quick skim
  if (r < 0.85) return randint(6000, 12000);  // normal scan
  if (r < 0.96) return randint(14000, 26000); // real read
  return randint(30000, 55000);               // got distracted / comment chain
}
export function humanBetweenScrollsMs(): number {
  const r = Math.random();
  if (r < 0.55) return randint(1800, 4500);  // most posts get ~a few seconds
  if (r < 0.88) return randint(5000, 10000); // some get a proper look
  return randint(13000, 26000);              // occasional stop-to-read
}

// Feed-scroll heuristics (postInterest, dwellForInterest) live in
// feed-patterns.ts — import from there instead.

export type DeviceSource = "cloud" | "local";

export class DeviceDriver {
  public readonly source: DeviceSource;
  constructor(
    /** Duoplus client (used only for cloud devices). */
    private client: DuoplusClient | null,
    public readonly deviceId: string,
    private log: LogFn = () => {},
    source: DeviceSource = "cloud",
  ) {
    this.source = source;
  }

  /** Raw shell command with retry. Returns stdout (may be empty). */
  async shell(cmd: string, retries = 2): Promise<string> {
    let lastErr = "";
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (this.source === "local") {
          return await localAdbShell(this.deviceId, cmd);
        }
        if (!this.client) throw new Error("no Duoplus client for cloud device");
        const r = await this.client.adbCommand([this.deviceId], cmd);
        const rec = r[this.deviceId];
        if (rec?.success) return rec.content ?? "";
        lastErr = rec?.message || "unknown";
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      if (attempt < retries) await sleep(1200);
    }
    throw new Error(`adb failed (${cmd.slice(0, 40)}…): ${lastErr}`);
  }

  // -- input --
  /**
   * Tap at (x, y) with human-like jitter and variable post-tap settle.
   * `jitter` scales the ±16–28px noise; pass 0 for surgical taps (tab bar).
   * `style` controls the flavor: 'normal' = quick press, 'deliberate' = small
   * extra hover as if thinking, 'lazy' = wider jitter + longer settle.
   */
  async tap(
    x: number,
    y: number,
    jitter = 1,
    style: "normal" | "deliberate" | "lazy" = "normal",
  ): Promise<void> {
    const jitterRange = style === "lazy" ? 40 : 22;
    const dx = jitter === 0 ? 0 : randint(-jitterRange, jitterRange) * jitter;
    const dy = jitter === 0 ? 0 : randint(-jitterRange, jitterRange) * jitter;
    const rx = Math.max(1, Math.round(x + dx));
    const ry = Math.max(1, Math.round(y + dy));
    await this.shell(`input tap ${rx} ${ry}`);
    // Variable post-tap settle. Real users don't unlock the next action with
    // millisecond consistency — sometimes they're already moving, sometimes
    // they pause to see the response.
    const settle =
      style === "deliberate" ? randint(350, 900) :
      style === "lazy"       ? randint(420, 1200) :
                               humanPostTapMs();
    await sleep(settle);
  }

  /**
   * A low-level swipe. Prefer swipeUp/swipeDown/swipeLeft/swipeRight for
   * natural feed scrolls — they break the gesture into multiple segments
   * with varied velocity to avoid the constant-speed signature of a single
   * `input swipe` call.
   */
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number) {
    await this.shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`);
  }

  /**
   * Multi-segment gesture: performs N short swipes end-to-end, each with
   * slightly varied velocity and a small curve, to approximate a real
   * finger drag whose speed is not constant. `mode`:
   *   - 'read'  : slow, with an imperceptible pause at top of stroke
   *   - 'normal': typical scroll (default)
   *   - 'flick' : fast, short dwell — "keep moving" mode
   */
  private async _naturalDrag(
    x1: number, y1: number, x2: number, y2: number,
    mode: "read" | "normal" | "flick" = "normal",
  ): Promise<void> {
    const segs = mode === "flick" ? 1 : randint(2, 3);
    const dx = x2 - x1, dy = y2 - y1;
    // Inject a slight arc — pick a control-ish point perpendicular to the path.
    const curve = randint(-40, 40);
    const perpX = -dy === 0 ? 0 : curve * (-dy / Math.max(1, Math.abs(dy)));
    const perpY = dx === 0 ? 0 : curve * (dx / Math.max(1, Math.abs(dx)));
    let lastX = x1, lastY = y1;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      // Ease-out velocity curve — start faster, slow toward end (natural for reads).
      const eased = mode === "flick" ? t : 1 - Math.pow(1 - t, 2);
      const sx = Math.round(x1 + dx * eased + perpX * Math.sin(Math.PI * t));
      const sy = Math.round(y1 + dy * eased + perpY * Math.sin(Math.PI * t));
      const segDur =
        mode === "flick" ? randint(120, 180) :
        mode === "read"  ? randint(220, 360) :
                           randint(150, 240);
      await this.shell(`input swipe ${lastX} ${lastY} ${sx} ${sy} ${segDur}`);
      lastX = sx; lastY = sy;
      // Tiny inter-segment pause — happens naturally when a real finger is re-planting.
      if (i < segs) await sleep(randint(20, 80));
    }
  }

  /** Natural feed scroll upward. 8% chance of a flick, 14% of a peek (short read scroll). */
  async swipeUp(amplitude = 1): Promise<void> {
    const startY = randint(1400, 1700);
    const ampFactor = roll(14) ? 0.45 : amplitude; // occasional peek-scroll
    const endY = startY - Math.floor(randint(600, 900) * ampFactor);
    const startX = randint(350, 550);
    const endX = startX + randint(-80, 80);
    const mode: "read" | "normal" | "flick" =
      roll(8) ? "flick" : roll(22) ? "read" : "normal";
    await this._naturalDrag(startX, startY, endX, endY, mode);
  }
  async swipeDown(): Promise<void> {
    const startY = randint(400, 600);
    const endY = startY + randint(700, 1000);
    const x = randint(380, 560);
    await this._naturalDrag(x, startY, x + randint(-60, 60), endY, "normal");
  }
  async swipeLeft(): Promise<void> {
    const y = randint(900, 1400);
    await this._naturalDrag(randint(800, 950), y, randint(80, 200), y, "normal");
  }
  async swipeRight(): Promise<void> {
    const y = randint(900, 1400);
    await this._naturalDrag(randint(80, 200), y, randint(800, 950), y, "normal");
  }
  /** Double-tap at (x, y) — used for IG feed post likes. */
  async doubleTap(x: number, y: number): Promise<void> {
    const dx = randint(-16, 16), dy = randint(-16, 16);
    await this.shell(`input tap ${x + dx} ${y + dy}`);
    await sleep(randint(90, 180));
    await this.shell(`input tap ${x + randint(-8, 8)} ${y + randint(-8, 8)}`);
    await sleep(randint(200, 450));
  }
  /** Long-press at (x, y) — simulated via a zero-distance swipe with duration. */
  async longPress(x: number, y: number, durationMs = 650): Promise<void> {
    const dx = randint(-14, 14), dy = randint(-14, 14);
    await this.shell(`input swipe ${x + dx} ${y + dy} ${x + dx + randint(-4, 4)} ${y + dy + randint(-4, 4)} ${durationMs}`);
    await sleep(randint(200, 500));
  }
  /**
   * Pull the notification shade down a bit and push it back up — simulates
   * a user glancing for notifications. No taps, so notifications aren't
   * opened. Safe filler gesture for natural idle time.
   */
  async peekNotifications(): Promise<void> {
    const x = randint(300, 700);
    await this.shell(`input swipe ${x} 0 ${x + randint(-40, 40)} ${randint(500, 800)} ${randint(300, 500)}`);
    await sleep(randint(900, 2200));
    await this.shell(`input swipe ${x} ${randint(600, 800)} ${x + randint(-40, 40)} 0 ${randint(240, 380)}`);
    await sleep(randint(400, 900));
  }
  key(code: string) {
    return this.shell(`input keyevent ${code}`);
  }
  pressHome() { return this.key("KEYCODE_HOME"); }
  pressBack() { return this.key("KEYCODE_BACK"); }
  async typeText(text: string) {
    // `input text` arg goes through the adb shell, then through Android's
    // shell-tokenizer. Backslash + double-quote survive both and produce a
    // literal `"` in the final keystroke. Whitespace must be %s for the
    // tokenizer to leave it intact.
    const safe = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s/g, "%s");
    await this.shell(`input text "${safe}"`);
  }
  /**
   * Type `text` one character at a time with per-char delay + occasional
   * "typos" that get backspaced. Feels way more human than a single
   * `input text` burst that lands instantly.
   */
  async typeHuman(text: string, opts?: { typoRate?: number }): Promise<void> {
    const typoRate = opts?.typoRate ?? 6; // percent
    const QWERTY: Record<string, string> = {
      q:"wa",w:"qe",e:"wr",r:"et",t:"ry",y:"tu",u:"yi",i:"uo",o:"ip",p:"o",
      a:"qs",s:"ad",d:"sf",f:"dg",g:"fh",h:"gj",j:"hk",k:"jl",l:"k",
      z:"x",x:"zc",c:"xv",v:"cb",b:"vn",n:"bm",m:"n",
    };
    for (const ch of text) {
      if (/[a-z]/i.test(ch) && roll(typoRate)) {
        const neighbors = QWERTY[ch.toLowerCase()];
        if (neighbors) {
          const wrong = neighbors[randint(0, neighbors.length - 1)];
          await this.shell(`input text "${wrong}"`);
          await sleep(randint(160, 420));
          await this.key("KEYCODE_DEL");
          await sleep(randint(140, 340));
        }
      }
      const safe = ch.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/ /g, "%s");
      await this.shell(`input text "${safe}"`);
      await sleep(randint(90, 260));
    }
  }

  // -- screenshots --
  /**
   * Capture the current screen as a PNG. For local ADB devices we use
   * `adb exec-out screencap -p` which streams raw bytes. For cloud devices
   * (Duoplus) we write to /data/local/tmp, base64 through the shell, then
   * decode here. Returns the PNG buffer or null on failure.
   */
  async screenshot(): Promise<Buffer | null> {
    try {
      if (this.source === "local") {
        const { localAdbExecOut } = await import("./local-adb.ts");
        return await localAdbExecOut(this.deviceId, "screencap -p");
      }
      // Cloud path — base64 through the adb shell. Always clean up the tmp
      // file even if the base64 step throws, otherwise long sessions fill
      // /data/local/tmp.
      const tmp = "/data/local/tmp/_shot.png";
      try {
        await this.shell(`screencap -p ${tmp}`, 1);
        const b64 = await this.shell(`base64 ${tmp} 2>/dev/null`, 1);
        const cleaned = b64.replace(/\s+/g, "");
        if (!cleaned) return null;
        return Buffer.from(cleaned, "base64");
      } finally {
        try { await this.shell(`rm -f ${tmp}`, 0); } catch {}
      }
    } catch {
      return null;
    }
  }

  // -- UI querying --
  /**
   * Dump the current UI hierarchy. Writes to /data/local/tmp (tmpfs, always
   * writable, no scoped-storage semantics) and streams the XML back in a
   * single shell invocation so we halve the Duoplus API cost and avoid the
   * race where two concurrent dumps on /sdcard/_ui.xml corrupt each other.
   * Strips the "UI hierchary dumped to..." tool message.
   */
  async dumpUi(): Promise<string> {
    const out = await this.shell(
      "uiautomator dump /data/local/tmp/_ui.xml >/dev/null 2>&1; cat /data/local/tmp/_ui.xml 2>/dev/null",
      2,
    );
    // Some Android builds emit the "UI hierchary dumped to: ..." banner even
    // with stdout/stderr redirected — strip anything before the XML prolog.
    const xmlStart = out.indexOf("<?xml");
    return xmlStart > 0 ? out.slice(xmlStart) : out;
  }
  async packageInstalled(pkg: string): Promise<boolean> {
    const out = await this.shell(`pm list packages ${pkg}`, 1);
    return out.includes(`package:${pkg}`);
  }
  /**
   * Return the package of the app currently in the foreground, or null if it
   * can't be parsed. Used by launchApp to skip the home-screen ceremony when
   * we're already in the target app.
   */
  async foregroundPackage(): Promise<string | null> {
    try {
      const out = await this.shell(
        "dumpsys activity activities | grep -E 'ResumedActivity|mResumedActivity' | head -n 1",
        1,
      );
      const m = out.match(/([a-zA-Z0-9_.]+)\/[a-zA-Z0-9_.$]+/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  async launchApp(pkg: string): Promise<void> {
    // If we're already in the target app, don't do the home-screen dance —
    // just give it a natural settle and return.
    const currentFg = await this.foregroundPackage();
    if (currentFg === pkg) {
      this.log("info", `  already in ${pkg}, skipping home-screen launch`);
      await sleep(randint(1200, 2800));
      return;
    }

    // HUMAN APP LAUNCH: a real person presses home, glances at the home
    // screen for a moment, sometimes opens the app drawer to find the icon,
    // then taps it. Instant `monkey` launches from deep inside another app's
    // task stack is one of the clearest bot-like signatures on Android.
    try {
      await this.key("KEYCODE_HOME");
    } catch {
      // If home key fails (rare), fall through — we'll still launch.
    }
    // Glance at the home screen — reading widgets / noticing notifications.
    await sleep(randint(1200, 2800));

    // ~55% of the time, open the app drawer with a swipe-up gesture and
    // pause as if scanning for the icon. This is the most common way users
    // find apps that aren't on the first home page.
    if (roll(55)) {
      try {
        const startX = randint(420, 640);
        const startY = randint(1700, 1820);
        const endY = randint(600, 900);
        await this.swipe(startX, startY, startX + randint(-30, 30), endY, randint(280, 420));
        // Look at the drawer — scan for the icon. On a big drawer, a user
        // might also do a small vertical scroll; we just pause here.
        await sleep(randint(900, 2200));
        // Sometimes swipe within the drawer (simulate looking for icon further down).
        if (roll(30)) {
          const x = randint(380, 600);
          await this.swipe(x, randint(1200, 1500), x, randint(600, 900), randint(240, 380));
          await sleep(randint(700, 1500));
        }
      } catch {
        // Swiping failed — no problem, we'll still launch via monkey.
      }
    }

    // Brief "reaching for icon" pause before the tap lands.
    await sleep(randint(380, 1200));

    try {
      await this.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, 1);
    } catch {
      const out = await this.shell(
        `cmd package resolve-activity --brief ${pkg} | tail -n 1`,
        1,
      );
      const activity = out.trim();
      if (activity && activity.includes("/")) {
        await this.shell(`am start -n ${activity}`);
      } else {
        throw new Error(`could not launch ${pkg}`);
      }
    }
    // Long human settle. Real users don't start interacting within 5s —
    // splash, feed prefetch, animations, reading the first post take ~15–25s.
    await sleep(randint(15000, 25000));
  }

  // -- screen dimensions --
  private _size: { width: number; height: number } | null = null;
  /**
   * Physical screen dimensions (cached). Prefers `wm size` (reports override
   * size if set) with an XML-root-bounds fallback. Used to build proportional
   * coordinates — hardcoded 1080×1920 breaks on 1080×2340 Duoplus phones.
   */
  async screenSize(): Promise<{ width: number; height: number }> {
    if (this._size) return this._size;
    try {
      const out = await this.shell("wm size", 1);
      const m = out.match(/(?:Override size|Physical size):\s*(\d+)x(\d+)/i);
      if (m) {
        this._size = { width: +m[1], height: +m[2] };
        return this._size;
      }
    } catch { /* fall through to XML parse */ }
    try {
      const xml = await this.dumpUi();
      const m = xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
      if (m) {
        this._size = { width: +m[1], height: +m[2] };
        return this._size;
      }
    } catch { /* fall through */ }
    // Last-resort default.
    this._size = { width: 1080, height: 1920 };
    return this._size;
  }

  // -- selector helpers --

  /** Find first node whose content-desc contains substr. Returns center coords or null. */
  async findByDesc(substr: string, xml?: string): Promise<BoundsCenter | null> {
    const x = xml ?? (await this.dumpUi());
    const re = new RegExp(
      `<node[^/]*?content-desc="([^"]*${escapeRegex(substr)}[^"]*)"[^/]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
      "i",
    );
    const m = x.match(re);
    if (!m) return null;
    return {
      x: Math.floor((+m[2] + +m[4]) / 2),
      y: Math.floor((+m[3] + +m[5]) / 2),
    };
  }

  /**
   * Android system permission dialog handler. Android's dialogs use specific
   * resource-ids independent of button text, and sometimes render "DON'T
   * ALLOW" with a curly apostrophe (U+2019) which bypasses ASCII text match.
   *
   * Strategy (in order):
   *   1. Resource-id: permission_deny_button / button2 (Android's "no" slot)
   *   2. Any button whose text contains 'DENY' or 'DON' (case-insensitive,
   *      no apostrophe dependency)
   *   3. Lowest button in a stacked Material dialog (deny is typically below)
   */
  async dismissPermissionDialog(xml?: string): Promise<boolean> {
    const x = xml ?? (await this.dumpUi());
    // 1. By resource-id.
    for (const rid of [
      "com.android.permissioncontroller:id/permission_deny_button",
      "com.android.packageinstaller:id/permission_deny_button",
      "android:id/button2",
    ]) {
      const p = await this.findByResourceId(rid, x);
      if (p) {
        await this.tap(p.x, p.y);
        await sleep(1400);
        return true;
      }
    }
    // 2. Partial-text match (catches 'DON'T', 'DON'T', 'Don't', 'DENY', etc.)
    for (const needle of ["DENY", "DON", "NO THANKS", "Decline"]) {
      const p = await this.findByText(needle, x);
      if (p) {
        await this.tap(p.x, p.y);
        await sleep(1400);
        return true;
      }
    }
    // 3. Pattern-based: if XML says "Allow X to...", find all <Button> nodes
    //    and tap the LOWER one (Material stacked dialogs put deny below).
    if (/Allow .+ to/i.test(x)) {
      const btnRe = /<node[^/]*?class="android\.widget\.Button"[^/]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
      const buttons: Array<{ x: number; y: number }> = [];
      let m: RegExpExecArray | null;
      while ((m = btnRe.exec(x)) !== null) {
        buttons.push({
          x: Math.floor((+m[1] + +m[3]) / 2),
          y: Math.floor((+m[2] + +m[4]) / 2),
        });
      }
      if (buttons.length >= 2) {
        buttons.sort((a, b) => a.y - b.y);
        const deny = buttons[buttons.length - 1];
        await this.tap(deny.x, deny.y);
        await sleep(1400);
        return true;
      }
    }
    return false;
  }

  /**
   * Aggressive "clear anything on screen" — dump, try each dismissal
   * strategy in order, repeat up to `maxRounds` times. Targets Android
   * permission dialogs, app popups, and interstitials.
   */
  async clearOverlays(maxRounds = 6): Promise<number> {
    let totalDismissed = 0;
    for (let i = 0; i < maxRounds; i++) {
      // Try permission-dialog-specific handler first (resource-id / button-index).
      if (await this.dismissPermissionDialog()) {
        totalDismissed++;
        continue;
      }
      // Fall back to text-label scan.
      const d = await this.dismissPopups();
      if (!d) break;
      totalDismissed += d;
    }
    return totalDismissed;
  }
  async findByResourceId(rid: string, xml?: string): Promise<BoundsCenter | null> {
    const x = xml ?? (await this.dumpUi());
    const re = new RegExp(
      `<node[^/]*?resource-id="${escapeRegex(rid)}"[^/]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
    );
    const m = x.match(re);
    if (!m) return null;
    return {
      x: Math.floor((+m[1] + +m[3]) / 2),
      y: Math.floor((+m[2] + +m[4]) / 2),
    };
  }
  async findByText(text: string, xml?: string): Promise<BoundsCenter | null> {
    const x = xml ?? (await this.dumpUi());
    // Case-insensitive so 'Don't allow' matches Android's 'DON'T ALLOW' etc.
    const re = new RegExp(
      `<node[^/]*?text="([^"]*${escapeRegex(text)}[^"]*)"[^/]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
      "i",
    );
    const m = x.match(re);
    if (!m) return null;
    return {
      x: Math.floor((+m[2] + +m[4]) / 2),
      y: Math.floor((+m[3] + +m[5]) / 2),
    };
  }
  async tapByDesc(substr: string, xml?: string): Promise<boolean> {
    const p = await this.findByDesc(substr, xml);
    if (!p) return false;
    await this.tap(p.x, p.y);
    return true;
  }
  async tapByResourceId(rid: string, xml?: string): Promise<boolean> {
    const p = await this.findByResourceId(rid, xml);
    if (!p) return false;
    await this.tap(p.x, p.y);
    return true;
  }
  async tapByText(text: string, xml?: string): Promise<boolean> {
    const p = await this.findByText(text, xml);
    if (!p) return false;
    await this.tap(p.x, p.y);
    return true;
  }

  /** Wait up to `timeoutMs` for any of the desc substrings to appear. */
  async waitForDesc(substrs: string[], timeoutMs = 15000): Promise<BoundsCenter | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const xml = await this.dumpUi();
      for (const s of substrs) {
        const p = await this.findByDesc(s, xml);
        if (p) return p;
      }
      await sleep(1500);
    }
    return null;
  }
  /**
   * Dismiss popups with sensible-default choices. When multiple buttons
   * are present, prefers the "less engaged" option (Decline > Later > Skip).
   * Safe no-op if absent.
   */
  async dismissPopups(xml?: string): Promise<number> {
    const x = xml ?? (await this.dumpUi());
    // Order matters: try most-negative / least-engagement first, so when both
    // "Allow" and "Deny" are on-screen we pick Deny.
    const LABELS = [
      "Don't allow", "Don't Allow", "Deny", "Decline", "No thanks", "No, thanks",
      "Not now", "Not Now", "Not right now",
      "Skip", "Skip for now",
      "Maybe later", "Later", "Ask me later", "Remind me later",
      "Ignore", "Cancel",
      "Got it", "Got It", "OK", "Okay", "I understand",
      "Dismiss", "Close", "No",
    ];
    let dismissed = 0;
    for (const label of LABELS) {
      const p = await this.findByText(label, x);
      if (p) {
        await this.tap(p.x, p.y);
        dismissed++;
        await sleep(1200);
        break; // one popup at a time — caller re-invokes
      }
    }
    return dismissed;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
