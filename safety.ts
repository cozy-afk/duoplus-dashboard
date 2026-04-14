/**
 * Safety net for account-level red flags. Detects logout / challenge /
 * rate-limit / action-blocked screens and raises AccountFlaggedError so the
 * session halts immediately and the runner marks the account suspended.
 *
 * Bot-detection escalation ladder: logout → challenge → shadowban → permaban.
 * NEVER keep acting on a flagged account — one more tap on a challenge
 * screen can be the difference between "recoverable" and "permanent".
 */

import type { Ctx } from "./human.ts";

export class AccountFlaggedError extends Error {
  constructor(public reasonLine: string) {
    super(`account flagged: ${reasonLine}`);
  }
}

/**
 * Subclass for "verification required" — distinct from a hard suspension
 * because the account ISN'T necessarily broken; the platform just wants a
 * human to prove it's real (SMS, email code, photo-tap test, etc.).
 *
 * The runner treats this differently from AccountFlaggedError:
 *   - account row → status='verification-required' (not 'suspended')
 *   - rotation triggers (claim a pool account onto this device)
 *   - the original account stays in DB so a human can verify and reactivate
 */
export class VerificationRequiredError extends AccountFlaggedError {
  constructor(reasonLine: string) {
    super(reasonLine);
    this.name = "VerificationRequiredError";
  }
}

/**
 * Raised when an app shows a sign-up / login-wall screen (e.g. TikTok's
 * "Sign up for TikTok"). The device has the app installed but nobody is
 * logged in. The runner treats this as a SKIP for this platform on this
 * device — it's not an account-level flag (there's no account to flag)
 * and retrying won't help until a human provides credentials.
 *
 * Upstream behavior: runner writes a row to `account_requests` so the
 * operator sees the device needs attention, marks any existing accounts row
 * for that (device, platform) as 'needs-manual-login', and continues with
 * the other platforms on the same device.
 */
export class LoginWallError extends Error {
  constructor(public platform: "instagram" | "threads" | "tiktok", public reasonLine: string) {
    super(`${platform} login-wall: ${reasonLine}`);
    this.name = "LoginWallError";
  }
}

/**
 * Hard-stop patterns: account is in real trouble. Match → AccountFlaggedError.
 */
export const LOGOUT_PATTERNS: readonly RegExp[] = [
  /Your account was logged out/i,
  /We detected suspicious activity/i,
  /Action Blocked/i,
  /Your account has been suspended/i,
  /Try Again Later/i,
  /We've limited your activity/i,
  /Challenge required/i,
  /This account is temporarily locked/i,
  /We disabled your account/i,
  /Account disabled/i,
];

/**
 * Verification-gate patterns: account needs a human to verify identity.
 * Match → VerificationRequiredError. Order matters slightly — these are
 * checked BEFORE LOGOUT_PATTERNS so "Please verify it's you" doesn't get
 * miscategorised as a hard flag.
 */
export const VERIFICATION_PATTERNS: readonly RegExp[] = [
  /Confirm it's you/i,
  /Confirm it's really you/i,
  /Please verify it's you/i,
  /Help us confirm it's you/i,
  /Verify your phone number/i,
  /Verify your account/i,
  /Enter the (?:6-digit )?code we sent/i,
  /We sent a code to/i,
  /Get a security code/i,
  /Tap the matching photo/i,
  /Tap a profile photo/i,
  /We need to confirm/i,
  /Two-factor authentication/i,
  /Add (?:your )?phone number/i,
];

/**
 * Dump the current UI and throw if any flag/verify pattern is visible. Call
 * periodically from inside long loops so we detect within a few actions
 * rather than after dozens. Verification check runs FIRST so a verify-gate
 * isn't mis-tagged as a suspension.
 */
export async function checkForFlagScreen(c: Ctx): Promise<void> {
  const xml = await c.driver.dumpUi();
  for (const re of VERIFICATION_PATTERNS) {
    const m = xml.match(re);
    if (m) throw new VerificationRequiredError(m[0]);
  }
  for (const re of LOGOUT_PATTERNS) {
    const m = xml.match(re);
    if (m) throw new AccountFlaggedError(m[0]);
  }
}

/**
 * Synchronous classifier — given an already-dumped XML, return what kind of
 * flag (if any) is visible. Used by the login flow which has the XML already
 * and doesn't want to re-dump just to check.
 */
export function classifyFlag(xml: string): "verify" | "flagged" | null {
  for (const re of VERIFICATION_PATTERNS) if (re.test(xml)) return "verify";
  for (const re of LOGOUT_PATTERNS) if (re.test(xml)) return "flagged";
  return null;
}
