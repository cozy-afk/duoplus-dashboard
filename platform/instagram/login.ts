/**
 * Instagram — Login flow (credentials + 2FA).
 */

import { sleep, randint } from "../../device-driver.ts";
import { analyzeAndRecover } from "../../screen-analyzer.ts";
import { AccountFlaggedError, VerificationRequiredError, classifyFlag } from "../../safety.ts";
import type { Ctx, LoginCreds } from "../../human.ts";
import { totp } from "../../totp.ts";
import { IG_PKG } from "./nav.ts";

export async function runInstagramLogin(ctx: Ctx, creds: LoginCreds): Promise<string | null> {
  ctx.stats.platform = "instagram";
  await ctx.driver.launchApp(IG_PKG);
  ctx.stats.app_launches++;
  await sleep(randint(3000, 5000));

  const pre = await analyzeAndRecover(ctx.driver, {
    platform: "instagram",
    context: "ig-login-launch",
    pkg: IG_PKG,
    log: ctx.log,
  });
  if (pre.classification === "main-feed") {
    ctx.log("warn", "  [IG login] already logged in — capturing current username");
    return null;
  }

  let xml = await ctx.driver.dumpUi();
  let tapped = await ctx.driver.tapByText("Log in", xml);
  if (!tapped) tapped = await ctx.driver.tapByText("Log into", xml);
  if (!tapped) throw new Error("could not find Log in entry on landing screen");
  await sleep(randint(2500, 4000));

  xml = await ctx.driver.dumpUi();
  const usernameRe = /<node[^/]*?class="android\.widget\.EditText"[^/]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  const fields: { x: number; y: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = usernameRe.exec(xml)) !== null) {
    fields.push({
      x: Math.floor((+m[1] + +m[3]) / 2),
      y: Math.floor((+m[2] + +m[4]) / 2),
    });
  }
  if (fields.length < 1) throw new Error("no EditText fields on login screen");
  await ctx.driver.tap(fields[0].x, fields[0].y);
  await sleep(randint(700, 1200));
  await ctx.driver.typeText(creds.username);
  await sleep(randint(800, 1500));
  let passwordField = fields[1];
  if (!passwordField) {
    if (!(await ctx.driver.tapByText("Continue"))) {
      await ctx.driver.tapByText("Next");
    }
    await sleep(randint(2500, 4000));
    const xml2 = await ctx.driver.dumpUi();
    const re2 = /<node[^/]*?class="android\.widget\.EditText"[^/]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/;
    const m2 = xml2.match(re2);
    if (m2) passwordField = { x: Math.floor((+m2[1] + +m2[3]) / 2), y: Math.floor((+m2[2] + +m2[4]) / 2) };
  }
  if (!passwordField) throw new Error("password field not found");
  await ctx.driver.tap(passwordField.x, passwordField.y);
  await sleep(randint(700, 1200));
  await ctx.driver.typeText(creds.password);
  await sleep(randint(1000, 1800));
  if (!(await ctx.driver.tapByText("Log in"))) {
    await ctx.driver.tapByText("Log In");
  }
  await sleep(randint(5000, 9000));

  // 2FA gate.
  xml = await ctx.driver.dumpUi();
  if (
    /Enter the code/i.test(xml) ||
    /Verification code/i.test(xml) ||
    /two-factor/i.test(xml) ||
    /Two-Factor/i.test(xml) ||
    /authentication app/i.test(xml)
  ) {
    if (!creds.totp_secret) throw new Error("2FA required but no TOTP secret provided");
    const code = totp(creds.totp_secret);
    ctx.log("info", "  [IG login] 2FA gate detected, entered code");
    const codeField = xml.match(/<node[^/]*?class="android\.widget\.EditText"[^/]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (codeField) {
      const x = Math.floor((+codeField[1] + +codeField[3]) / 2);
      const y = Math.floor((+codeField[2] + +codeField[4]) / 2);
      await ctx.driver.tap(x, y);
      await sleep(randint(600, 1100));
    }
    await ctx.driver.typeText(code);
    await sleep(randint(1000, 1800));
    if (!(await ctx.driver.tapByText("Continue"))) {
      if (!(await ctx.driver.tapByText("Confirm"))) {
        await ctx.driver.tapByText("Next");
      }
    }
    await sleep(randint(5000, 9000));
  }

  await ctx.driver.clearOverlays(8);

  const home = await ctx.driver.waitForDesc(["Home"], 25000);
  if (!home) {
    // Check the screen first for an explicit verify gate — those are
    // recoverable with a human, NOT a flag. classifyFlag uses the patterns
    // in safety.ts so detection is consistent across login + warmup paths.
    const xmlAfter = await ctx.driver.dumpUi();
    const verdict = classifyFlag(xmlAfter);
    if (verdict === "verify") {
      throw new VerificationRequiredError("login: verification gate after credentials");
    }
    if (verdict === "flagged") {
      throw new AccountFlaggedError("login: account-flagged screen after credentials");
    }
    const post = await analyzeAndRecover(ctx.driver, {
      platform: "instagram",
      context: "ig-login-post",
      pkg: IG_PKG,
      log: ctx.log,
    });
    if (post.classification === "challenge") {
      throw new VerificationRequiredError(`login blocked: ${post.classification}`);
    }
    if (post.classification === "rate-limit") {
      throw new AccountFlaggedError(`login blocked: ${post.classification}`);
    }
    throw new Error(`login succeeded? no Home tab visible — focus: ${post.classification}`);
  }
  return creds.username;
}
