/**
 * Threads — Login (IG-linked login: tap "Continue as @username").
 */

import { sleep, randint } from "../../device-driver.ts";
import { analyzeAndRecover } from "../../screen-analyzer.ts";
import type { Ctx, LoginCreds } from "../../human.ts";
import { THREADS_PKG } from "./nav.ts";

export async function runThreadsLogin(ctx: Ctx, creds: LoginCreds): Promise<string | null> {
  ctx.stats.platform = "threads";
  await ctx.driver.launchApp(THREADS_PKG);
  ctx.stats.app_launches++;
  await sleep(randint(3500, 5500));

  const pre = await analyzeAndRecover(ctx.driver, {
    platform: "threads",
    context: "threads-login-launch",
    pkg: THREADS_PKG,
    log: ctx.log,
  });
  if (pre.classification === "main-feed") {
    ctx.log("info", "  [Threads login] already logged in");
    return creds.username;
  }

  let xml = await ctx.driver.dumpUi();
  const candidates = [
    `Log in with @${creds.username}`,
    `Continue as @${creds.username}`,
    `Continue as ${creds.username}`,
    `Log in with ${creds.username}`,
    creds.username,
  ];
  let tapped = false;
  for (const candidate of candidates) {
    if (await ctx.driver.tapByText(candidate, xml)) {
      ctx.log("info", `  [Threads login] tapped "${candidate}"`);
      tapped = true;
      break;
    }
  }
  if (!tapped) {
    if (await ctx.driver.tapByText("Log in", xml)) {
      ctx.log("info", "  [Threads login] tapped generic 'Log in' entry");
      tapped = true;
      await sleep(randint(2500, 4500));
      xml = await ctx.driver.dumpUi();
      for (const candidate of candidates) {
        if (await ctx.driver.tapByText(candidate, xml)) {
          ctx.log("info", `  [Threads login] then tapped "${candidate}"`);
          break;
        }
      }
    }
  }
  if (!tapped) {
    throw new Error(
      `no IG-linked entry for @${creds.username} — is IG logged in as that account on this device?`,
    );
  }
  await sleep(randint(4000, 7000));
  await ctx.driver.clearOverlays(8);

  const feed = await ctx.driver.waitForDesc(["Feed"], 20000);
  if (!feed) {
    throw new Error("Threads login: Feed tab not visible after tapping login entry");
  }
  return creds.username;
}
