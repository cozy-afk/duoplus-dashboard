/**
 * Capture + analyze screen failures. When the automation gives up on a screen
 * (all nav strategies fail, 3rd consecutive stall, etc.), we grab a PNG and
 * optionally send it to Claude to explain what's on screen and what a real
 * user would do — so the operator gets a diagnostic instead of a 5-minute
 * stuck session.
 *
 * Screenshots always save to disk (./data/screenshots). Analysis is best-effort:
 * if ANTHROPIC_API_KEY is missing we skip the API call and just log the path.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceDriver } from "./device-driver.ts";
import { unknownScreensRepo } from "./db.ts";

const SCREENSHOT_DIR = join(process.cwd(), "data", "screenshots");
try { mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch { /* exists */ }

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.VISION_MODEL || "claude-opus-4-6";

export interface CaptureOptions {
  deviceId: string;
  platform?: string | null;
  context: string;                            // e.g. 'stall-escalation-3', 'goToTab-all-failed'
  focus?: string;
  xmlHead?: string;
  recovered?: boolean;
  recoveryAction?: string;
  analyze?: boolean;                          // default: true
}

export interface CaptureResult {
  unknownScreenId: number | null;
  screenshotPath: string | null;
  analysis: string | null;
}

/**
 * Capture a PNG, persist it to disk, record a diagnostic row, and kick off
 * Claude analysis in the background (never blocks the caller).
 *
 * Returns the DB id + path immediately; analysis text is written to the row
 * asynchronously when the API call completes.
 */
export async function captureFailure(
  driver: DeviceDriver,
  opts: CaptureOptions,
  log: (level: "info" | "warn" | "error" | "ok", msg: string) => void,
): Promise<CaptureResult> {
  const ts = Date.now();
  const safeDevice = opts.deviceId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filename = `${safeDevice}-${opts.context}-${ts}.png`;
  const absPath = join(SCREENSHOT_DIR, filename);

  let savedPath: string | null = null;
  try {
    const png = await driver.screenshot();
    if (png && png.length > 0) {
      writeFileSync(absPath, png);
      savedPath = absPath;
      log("info", `  [vision] screenshot saved → ${filename} (${Math.round(png.length / 1024)} KB)`);
    } else {
      log("warn", `  [vision] screencap returned no bytes`);
    }
  } catch (e) {
    log("warn", `  [vision] screenshot failed: ${e instanceof Error ? e.message : e}`);
  }

  // Persist the diagnostic row up-front — if analysis succeeds later, we'll
  // UPDATE this row rather than inserting a duplicate.
  let rowId: number | null = null;
  try {
    rowId = await unknownScreensRepo.record({
      device_id: opts.deviceId,
      platform: opts.platform ?? null,
      context: opts.context,
      focus: opts.focus,
      xml_head: opts.xmlHead,
      recovered: opts.recovered,
      recovery_action: opts.recoveryAction,
      screenshot_path: savedPath,
      analysis: null,
    });
  } catch (e) {
    log("warn", `  [vision] DB record failed: ${e instanceof Error ? e.message : e}`);
  }

  // Fire analysis in the background — don't block the session.
  let analysisPromise: Promise<string | null> = Promise.resolve(null);
  if (savedPath && opts.analyze !== false && API_KEY) {
    analysisPromise = analyzeScreenshot(savedPath, opts.context, opts.platform ?? undefined)
      .then((text) => {
        if (text && rowId != null) {
          unknownScreensRepo.updateAnalysis(rowId, text);
          log("info", `  [vision] analysis: ${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`);
        }
        return text;
      })
      .catch((e) => {
        log("warn", `  [vision] analysis failed: ${e instanceof Error ? e.message : e}`);
        return null;
      });
  } else if (!API_KEY && opts.analyze !== false) {
    log("info", `  [vision] ANTHROPIC_API_KEY not set — screenshot saved but not analyzed`);
  }

  // Wait briefly so the call site gets analysis if it was fast; otherwise return null.
  const analysis = await Promise.race([
    analysisPromise,
    new Promise<null>((r) => setTimeout(() => r(null), 50)),
  ]);

  return { unknownScreenId: rowId, screenshotPath: savedPath, analysis };
}

/**
 * Ask Claude what's on the screen and what a real user would do.
 * Returns null if the API call fails or no key is configured.
 */
// Allowlist of platform/context tokens that can be interpolated into the
// prompt. Anything else is replaced with "unknown" so operator/device-sourced
// strings can't inject instructions into the LLM call.
const ALLOWED_PLATFORMS = new Set(["instagram", "threads", "tiktok"]);
const SAFE_TOKEN_RE = /^[a-z0-9._:-]{1,64}$/i;
const MAX_SCREENSHOT_BYTES = 5_000_000; // ~5 MB raw PNG
const ANTHROPIC_TIMEOUT_MS = 30_000;

function sanitizeToken(value: string | undefined, allow?: Set<string>): string {
  if (!value) return "unknown";
  if (allow && !allow.has(value)) return "unknown";
  if (!allow && !SAFE_TOKEN_RE.test(value)) return "unknown";
  return value;
}

export async function analyzeScreenshot(
  pngPath: string,
  context: string,
  platform?: string,
): Promise<string | null> {
  if (!API_KEY) return null;
  const { readFileSync, statSync } = await import("node:fs");
  let size = 0;
  try { size = statSync(pngPath).size; } catch { return null; }
  if (size === 0 || size > MAX_SCREENSHOT_BYTES) return null;
  const buf = readFileSync(pngPath);
  const base64 = buf.toString("base64");

  const safeContext = sanitizeToken(context);
  const safePlatform = platform ? sanitizeToken(platform, ALLOWED_PLATFORMS) : null;
  const prompt = `You are helping diagnose an Android UI automation that got stuck.

Context: ${safeContext}
${safePlatform ? `Platform: ${safePlatform}` : ""}

Look at this screenshot and answer concisely:
1. What screen is this? (main feed, profile, modal, rate-limit, etc.)
2. What UI element (if any) is blocking automation from proceeding?
3. What single action (tap coordinates relative to screen %, swipe, or key press) would a real user take next to reach the main feed?

Respond in 3-4 short sentences. Be specific about coordinates and element names if visible.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: base64 },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    // Body may contain account identifiers or key hashes — don't propagate.
    throw new Error(`anthropic API ${res.status}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((c) => c.type === "text")?.text;
  return text ?? null;
}
