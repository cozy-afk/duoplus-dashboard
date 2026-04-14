/**
 * Shared feed-scrolling heuristics. Nothing platform-specific — just the
 * distribution of what a real user does on a generic social feed.
 *
 *   - Interest-based dwell: most posts are skipped/glanced, a few get
 *     real engagement.
 *   - Ad detection: regex for "Sponsored" / "Ad" markers across IG, Threads,
 *     TikTok, and any future platform that uses the same English labels.
 *
 * Kept out of device-driver.ts (which owns input primitives + timing) and
 * out of the platform modules (which consume these rules but don't own them).
 */

import { randint } from "./device-driver.ts";

/**
 * Classifies what the user would do with the next post in the feed. Real
 * scrolling is NOT "dwell on every post" — it's mostly skip uninteresting
 * posts and ads with tiny gaps, punctuated by the occasional post that
 * catches the eye.
 */
export type PostInterest = "skip" | "glance" | "look" | "read" | "paused";

export function postInterest(): PostInterest {
  const r = Math.random();
  if (r < 0.34) return "skip";     // ad / uninteresting → fast past
  if (r < 0.70) return "glance";   // quick look
  if (r < 0.90) return "look";     // actually read the post
  if (r < 0.98) return "read";     // deep dwell
  return "paused";                 // really stopped
}

export function dwellForInterest(interest: PostInterest): number {
  switch (interest) {
    case "skip":   return randint(180, 750);
    case "glance": return randint(1400, 3800);
    case "look":   return randint(4800, 9500);
    case "read":   return randint(13000, 24000);
    case "paused": return randint(28000, 55000);
  }
}

/**
 * Regex that matches the "Sponsored" / "Ad" / "Promoted" labels most English
 * social apps use for paid slots. Caller dumps the UI XML and passes it here.
 */
export const AD_MARKER_RE = /text="(Sponsored|Ad|Promoted)"|content-desc="[^"]*Sponsored/i;

export function xmlContainsAdMarker(xml: string): boolean {
  return AD_MARKER_RE.test(xml);
}
