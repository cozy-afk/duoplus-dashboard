/**
 * Batch runner — ADB-driven automation.
 *
 * Flow per device:
 *   1. Power on via Duoplus API.
 *   2. Wait for status=online (1).
 *   3. Per-device random pre-flight jitter (0–N seconds).
 *   4. Scan which social accounts are currently logged in.
 *   5. For each detected account, run that platform's ADB-driven warmup
 *      (no Duoplus template / loopTaskCreate needed — we drive the phone
 *      ourselves via adb shell commands, so we get exact per-action counts).
 *   6. Hard 30-min cap from power-on. When reached, all action loops exit
 *      on their next iteration, device is powered off, summary emitted.
 *   7. Power off + per-device summary with full action stats.
 */

import type { DuoplusClient } from "./duoplus.ts";
import { isOnline, statusLabel } from "./duoplus.ts";
import { DeviceDriver } from "./device-driver.ts";
import { scanDevice, type ScanResult } from "./account-scanner.ts";
import {
  runPlatformSession,
  AccountFlaggedError,
  StalledError,
  type SessionStats,
  type AutomationType,
} from "./automation.ts";
import { VerificationRequiredError, LoginWallError } from "./safety.ts";
import {
  accountsRepo,
  sessionsRepo,
  quotasRepo,
  followTargetsRepo,
  scheduledPostsRepo,
  loginQueueRepo,
  poolRepo,
  accountRequestsRepo,
  type Account,
} from "./db.ts";
import { runInstagramLogin, runThreadsLogin } from "./automation.ts";
import { DeviceDriver as DD } from "./device-driver.ts";
import { igSwitchAccount } from "./platform/instagram/index.ts";
import { tiktokSwitchAccount } from "./platform/tiktok/index.ts";
import { threadsSwitchAccount } from "./platform/threads/index.ts";
import { newStats } from "./human.ts";
import { makeLogger } from "./logger.ts";

export type LogFn = (level: "info" | "warn" | "error" | "ok", msg: string) => void;

export interface BatchRunOptions {
  deviceIds: string[];
  scanAccounts?: boolean;
  log: LogFn;
  maxMinutesPerDevice?: number;
  concurrency?: number;
  startJitterSec?: number;
  /** Which automation to run per account. */
  automation?: AutomationType;
  /** Subset of deviceIds that are LOCAL ADB (physical / USB / wifi-debug).
   * These skip Duoplus powerOn/Off (already on) and use local adb shell. */
  localIds?: Set<string>;
}

interface DeviceSummary {
  deviceId: string;
  cameOnlineAt: number | null;
  accountsScanned: ScanResult[];
  perAccountStats: Array<{ accountId: number | null; username: string | null; platform: string | null; stats: SessionStats }>;
  timedOut: boolean;
  endedAt: number;
  durationSec: number;
  finalError?: string;
}

async function waitOnline(
  client: DuoplusClient,
  deviceId: string,
  log: LogFn,
  deadlineMs: number,
): Promise<boolean> {
  // Allow a longer window — Duoplus phones can take 1-2 min to fully boot.
  // If status stays at 2 (offline) for several polls, retry power-on up to 3x.
  let lastStatus = -1;
  let offlineStreak = 0;
  let retries = 0;
  const MAX_RETRIES = 3;
  while (Date.now() < deadlineMs) {
    try {
      const r = await client.status([deviceId]);
      const st = r.list?.[0]?.status;
      if (st !== undefined) {
        if (st !== lastStatus) log("info", `  ${deviceId}: ${statusLabel(st)}`);
        lastStatus = st;
        if (isOnline(st)) return true;
        if (st === 2) {
          offlineStreak++;
          // After ~30s stuck at offline (5 polls × 6s), retry power-on.
          if (offlineStreak >= 5 && retries < MAX_RETRIES) {
            retries++;
            log("info", `  ${deviceId}: stuck offline — re-issuing power-on (${retries}/${MAX_RETRIES})`);
            try {
              await client.powerOn([deviceId]);
            } catch (e) {
              log("warn", `  ${deviceId}: retry powerOn threw: ${e instanceof Error ? e.message : e}`);
            }
            offlineStreak = 0;
          }
        } else {
          offlineStreak = 0;
        }
      }
    } catch {
      log("warn", `  ${deviceId}: status check failed, retrying`);
    }
    if (Date.now() + 6000 >= deadlineMs) return false;
    await new Promise((r) => setTimeout(r, 6000));
  }
  return false;
}

function formatSummary(s: DeviceSummary): string[] {
  const m = Math.floor(s.durationSec / 60);
  const sec = s.durationSec % 60;
  const lines = [
    `── [${s.deviceId}] summary ${m}m${sec}s ──`,
    `  online: ${s.cameOnlineAt ? "yes" : "no"}${s.timedOut ? " (HIT 30-MIN CAP)" : ""}`,
  ];
  // Only show scan line if scanning actually ran.
  if (s.accountsScanned.length > 0) {
    lines.push(`  accounts scanned: ${s.accountsScanned.filter((a) => a.status === "found").length}/3`);
    for (const acct of s.accountsScanned) {
      if (acct.status === "found") lines.push(`    ${acct.platform}: @${acct.username}`);
      else if (acct.status === "not-logged-in") lines.push(`    ${acct.platform}: not logged in`);
      else if (acct.status === "not-installed") lines.push(`    ${acct.platform}: not installed`);
      else lines.push(`    ${acct.platform}: scan failed (${acct.error})`);
    }
  }
  if (s.perAccountStats.length) {
    lines.push("  actions:");
    for (const a of s.perAccountStats) {
      const st = a.stats;
      const parts: string[] = [];
      if (st.feed_scrolls) parts.push(`${st.feed_scrolls} feed scrolls`);
      if (st.reels_watched) parts.push(`${st.reels_watched} reels`);
      if (st.stories_viewed) parts.push(`${st.stories_viewed} stories`);
      if (st.likes_given) parts.push(`${st.likes_given} likes`);
      if (st.comments_read) parts.push(`${st.comments_read} comment threads`);
      if (st.profile_visits) parts.push(`${st.profile_visits} profile visits`);
      if (st.hashtag_searches) parts.push(`${st.hashtag_searches} hashtag searches`);
      if (st.explore_scrolls) parts.push(`${st.explore_scrolls} explore scrolls`);
      if (st.saves) parts.push(`${st.saves} saves`);
      if (st.own_profile_views) parts.push(`${st.own_profile_views} own-profile peeks`);
      if (st.errors) parts.push(`${st.errors} errors`);
      lines.push(`    ${a.platform} @${a.username}: ${parts.join(", ") || "(no actions)"}`);
    }
  }
  if (s.finalError) lines.push(`  error: ${s.finalError}`);
  return lines;
}

export async function batchRun(
  client: DuoplusClient,
  opts: BatchRunOptions,
): Promise<DeviceSummary[]> {
  const {
    deviceIds,
    scanAccounts = true,
    log,
    maxMinutesPerDevice = 30,
    concurrency: rawConcurrency = 10,
    startJitterSec = 30,
    automation = "warmup",
    localIds = new Set<string>(),
  } = opts;
  const concurrency = Math.max(1, Math.min(deviceIds.length, rawConcurrency));

  if (deviceIds.length === 0) {
    log("warn", "No devices selected.");
    return [];
  }

  log(
    "info",
    `Batch ${automation} run: ${deviceIds.length} device(s), ${concurrency} parallel, ${maxMinutesPerDevice}m cap, up to ${startJitterSec}s jitter`,
  );

  // 1. Power on — ONLY cloud devices. Local (USB / adb-over-network) are
  //    assumed to be already reachable.
  const cloudIds = deviceIds.filter((id) => !localIds.has(id));
  const powerOnAt = Date.now();
  if (cloudIds.length) {
    log("info", `Powering on cloud devices: ${cloudIds.join(", ")}`);
    try {
      const res = await client.powerOn(cloudIds);
      for (const id of res.success || []) log("ok", `  ${id}: power-on accepted`);
      for (const id of res.fail || []) {
        const reason = res.fail_reason?.[id] || "unknown";
        log("error", `  ${id}: power-on failed — ${reason}`);
      }
    } catch (err) {
      log("error", `powerOn failed: ${err instanceof Error ? err.message : err}`);
      // Abort only if the run has NO local devices — otherwise proceed with
      // the locals, which are already reachable and don't need powerOn.
      if (localIds.size === 0) return [];
      log("warn", `continuing with ${localIds.size} local device(s) only`);
    }
  }
  if (localIds.size) {
    log("info", `Local devices (already online): ${[...localIds].join(", ")}`);
  }

  const summaries: DeviceSummary[] = [];
  const summariesByDevice = new Map<string, DeviceSummary>();
  for (const id of deviceIds) {
    const s: DeviceSummary = {
      deviceId: id,
      cameOnlineAt: null,
      accountsScanned: [],
      perAccountStats: [],
      timedOut: false,
      endedAt: 0,
      durationSec: 0,
    };
    summaries.push(s);
    summariesByDevice.set(id, s);
  }

  // Single-reader queue: each worker pulls the next device atomically.
  // JavaScript coroutines are cooperatively scheduled, so `const my = idx++`
  // executes without suspension — but capturing into a const before any
  // `await` still makes the ownership explicit and prevents accidental
  // re-use of a stale `idx` if the loop body is later refactored.
  let idx = 0;
  const worker = async () => {
    while (true) {
      const my = idx++;
      if (my >= deviceIds.length) return;
      const deviceId = deviceIds[my];
      const summary = summariesByDevice.get(deviceId)!;
      const deadlineMs = powerOnAt + maxMinutesPerDevice * 60 * 1000;

      try {
        const isLocal = localIds.has(deviceId);

        // Jitter per device.
        if (startJitterSec > 0) {
          const jitter = Math.floor(Math.random() * startJitterSec * 1000);
          log("info", `[${deviceId}] jitter ${Math.floor(jitter / 1000)}s before starting`);
          await new Promise((r) => setTimeout(r, jitter));
        }

        // Cloud devices need to come online. Locals are already ready.
        let ok = true;
        if (!isLocal) {
          log("info", `[${deviceId}] waiting for online`);
          ok = await waitOnline(client, deviceId, log, deadlineMs);
        } else {
          log("info", `[${deviceId}] local device — skipping power-on wait`);
        }
        if (!ok) {
          summary.finalError = "did not come online within cap";
          summary.timedOut = Date.now() >= deadlineMs;
          log("warn", `[${deviceId}] ${summary.finalError} — powering off`);
          try { await client.powerOff([deviceId]); } catch {}
          summary.endedAt = Date.now();
          summary.durationSec = Math.floor((summary.endedAt - powerOnAt) / 1000);
          continue;
        }
        summary.cameOnlineAt = Date.now();
        log(
          "ok",
          `[${deviceId}] ${isLocal ? "ready (local)" : `online (${Math.floor((summary.cameOnlineAt - powerOnAt) / 1000)}s to boot)`}`,
        );

        const driver = new DeviceDriver(client, deviceId, log, isLocal ? "local" : "cloud");

        // LOGIN automation: different flow. Pull a pending login from the queue,
        // run the login UI flow, on success register the new account. No scan.
        if (automation === "login") {
          const pending = await loginQueueRepo.pending();
          const pick = pending[0];
          if (!pick) {
            log("warn", `[${deviceId}] no pending logins in queue — powering off`);
            if (!isLocal) {
              try { await client.powerOff([deviceId]); } catch {}
            }
            summary.endedAt = Date.now();
            summary.durationSec = Math.floor((summary.endedAt - powerOnAt) / 1000);
            continue;
          }
          if (!(await loginQueueRepo.claimFor(pick.id, deviceId))) {
            log("warn", `[${deviceId}] login ${pick.id} claimed by another worker`);
            continue;
          }
          await loginQueueRepo.markStarted(pick.id);
          log("info", `[${deviceId}] logging in @${pick.username} (${pick.platform}) from queue`);
          try {
            const stats = {
              platform: pick.platform, app_launches: 0, feed_scrolls: 0, reels_watched: 0,
              stories_viewed: 0, likes_given: 0, comments_read: 0, profile_visits: 0,
              hashtag_searches: 0, saves: 0, explore_scrolls: 0, tab_switches: 0,
              own_profile_views: 0, unmutes: 0, errors: 0, hit_deadline: false,
            };
            const ctx = { driver, quota: await quotasRepo.get(pick.platform), log, stats, deadline: deadlineMs };
            let username: string | null = null;
            if (pick.platform === "instagram") {
              username = await runInstagramLogin(ctx, {
                platform: "instagram",
                username: pick.username,
                password: pick.password,
                totp_secret: pick.totp_secret,
              });
            } else if (pick.platform === "threads") {
              username = await runThreadsLogin(ctx, {
                platform: "threads",
                username: pick.username,
                password: pick.password,
                totp_secret: pick.totp_secret,
              });
            } else {
              throw new Error(`login flow not implemented for platform=${pick.platform} yet`);
            }
            const acctId = await accountsRepo.create({
              device_id: deviceId,
              platform: pick.platform,
              username: username ?? pick.username,
              notes: "auto-logged-in",
            });
            await loginQueueRepo.markSuccess(pick.id, acctId);
            log("ok", `[${deviceId}] logged in @${pick.username} (${pick.platform}); accounts row ${acctId}`);

            // CHAIN: after IG login, Threads piggybacks on the IG session.
            // Automatically open Threads and tap 'Continue as @username' so
            // the user doesn't need a separate Threads row in the queue.
            if (pick.platform === "instagram") {
              try {
                log("info", `[${deviceId}] chaining Threads linked-login for @${pick.username}...`);
                const threadsUsername = await runThreadsLogin(ctx, {
                  platform: "threads",
                  username: pick.username,
                  password: pick.password,
                  totp_secret: pick.totp_secret,
                });
                if (threadsUsername) {
                  const tId = await accountsRepo.create({
                    device_id: deviceId,
                    platform: "threads",
                    username: threadsUsername,
                    notes: "auto-linked-from-IG",
                  });
                  log("ok", `[${deviceId}] Threads linked-login succeeded; accounts row ${tId}`);
                }
              } catch (e) {
                // Don't fail the whole login if Threads linking hiccups —
                // the IG account is already saved and usable.
                log(
                  "warn",
                  `[${deviceId}] Threads linked-login skipped: ${e instanceof Error ? e.message : e}`,
                );
              }
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log("error", `[${deviceId}] login failed: ${msg}`);
            await loginQueueRepo.markFailed(pick.id, msg);
          }
          if (!isLocal) {
            log("info", `[${deviceId}] powering off`);
            try { await client.powerOff([deviceId]); } catch {}
          }
          summary.endedAt = Date.now();
          summary.durationSec = Math.floor((summary.endedAt - powerOnAt) / 1000);
          continue;
        }

        // Scan-then-warmup pipeline — but skip the scan if this device already
        // has runnable accounts in the DB. The scan is expensive (opens all 3
        // apps → taps Profile tab → parses handle) and its only purpose is to
        // populate `accounts`. Once that's done, subsequent runs can go
        // straight to warmup, which is less bot-like and saves ~90s.
        const prescan = await accountsRepo.byDevice(deviceId);
        const runnablePreScan = prescan.filter(
          (a) => a.status !== "suspended" && a.status !== "challenge" && a.status !== "needs-manual-login",
        );
        let detectedPlatforms: Set<string>;
        if (runnablePreScan.length > 0) {
          detectedPlatforms = new Set(runnablePreScan.map((a) => a.platform));
          log(
            "info",
            `[${deviceId}] ${runnablePreScan.length} account(s) already identified (${[...detectedPlatforms].join(", ")}) — skipping scan`,
          );
        } else {
          log("info", `[${deviceId}] no known accounts — scanning logged-in accounts across IG/Threads/TikTok...`);
          try {
            summary.accountsScanned = await scanDevice(client, deviceId, log);
          } catch (e) {
            log("warn", `[${deviceId}] scan threw: ${e instanceof Error ? e.message : e}`);
          }
          detectedPlatforms = new Set(
            summary.accountsScanned
              .filter((r) => r.status === "found")
              .map((r) => r.platform),
          );
          // Flag any platform where the scanner explicitly reported NO
          // logged-in account (distinct from "not-installed"). Operator
          // sees these in the Needs-Account panel. Idempotent — repeated
          // scans just bump hit_count on the existing pending row.
          for (const scanRow of summary.accountsScanned) {
            if (scanRow.status !== "not-logged-in") continue;
            try {
              await accountRequestsRepo.flag({
                device_id: deviceId,
                platform: scanRow.platform,
                reason: `scan: no ${scanRow.platform} account logged in on this device`,
              });
            } catch { /* non-fatal */ }
          }
        }
        if (detectedPlatforms.size === 0) {
          log(
            "warn",
            `[${deviceId}] no logged-in accounts detected on any platform — powering off.`,
          );
          log(
            "warn",
            `  Log into IG/Threads/TikTok manually on this device, then re-run.`,
          );
          if (!isLocal) {
            try { await client.powerOff([deviceId]); } catch {}
          }
          summary.endedAt = Date.now();
          summary.durationSec = Math.floor((summary.endedAt - powerOnAt) / 1000);
          continue;
        }
        log("ok", `[${deviceId}] ${detectedPlatforms.size} platform(s) logged in: ${[...detectedPlatforms].join(", ")}`);

        const allAccounts = await accountsRepo.byDevice(deviceId);
        // Multi-account model: a device may have several accounts per
        // platform. We pick ONE per platform per wake — the most-rested
        // (oldest last_run_at, null = highest priority). Across repeated
        // batch runs, every account eventually gets touched. The natural
        // gap between batch wakes IS the per-account cooldown — no need
        // to sleep mid-session.
        const eligible = allAccounts.filter((a) => {
          if (!detectedPlatforms.has(a.platform as "instagram" | "threads" | "tiktok")) return false;
          if (
            a.status === "suspended" ||
            a.status === "challenge" ||
            a.status === "needs-manual-login" ||
            a.status === "verification-required"
          ) {
            log("warn", `  skipping @${a.username} (${a.platform}) — status=${a.status}`);
            return false;
          }
          return true;
        });

        // Per-platform: pick most-rested. last_run_at null sorts FIRST so
        // freshly-logged-in accounts are touched before they go cold.
        const byPlatform = new Map<string, Account[]>();
        for (const a of eligible) {
          const arr = byPlatform.get(a.platform) ?? [];
          arr.push(a);
          byPlatform.set(a.platform, arr);
        }
        const candidateAccounts: Account[] = [];
        for (const [, arr] of byPlatform) {
          arr.sort((x, y) => {
            const xt = x.last_run_at ?? 0;
            const yt = y.last_run_at ?? 0;
            return xt - yt;
          });
          candidateAccounts.push(arr[0]);
          if (arr.length > 1) {
            log(
              "info",
              `  [${deviceId}] ${arr[0].platform}: picked @${arr[0].username} (rested longest of ${arr.length} on device)`,
            );
          }
        }
        // Run ALL detected platforms and cycle through them like a real user
        // hopping between apps. Keep cycling until either the 20-min session
        // floor is reached (minimum activity time) or the 30-min deadline hits.
        // Stalls fall back to another platform instead of powering off.
        const SESSION_FLOOR_MS = 20 * 60 * 1000;
        const sessionStart = Date.now();
        const activeAccountIds = new Set(candidateAccounts.map((a) => a.id));
        let deviceFlagged = false;
        let round = 0;

        if (candidateAccounts.length > 0) {
          log(
            "info",
            `[${deviceId}] running ${candidateAccounts.length} platform(s) this session, cycling until 20-min floor`,
          );
        }

        while (
          !deviceFlagged &&
          activeAccountIds.size > 0 &&
          Date.now() < deadlineMs
        ) {
          round++;
          const elapsedSec = Math.floor((Date.now() - sessionStart) / 1000);
          if (round > 1) {
            log(
              "info",
              `[${deviceId}] round ${round}: ${elapsedSec}s in session, ${activeAccountIds.size} active platform(s) — cycling again until 20-min floor`,
            );
          }
          // Shuffle account order each round so we don't always hit IG → Threads → TikTok.
          const order = candidateAccounts
            .filter((a) => activeAccountIds.has(a.id))
            .sort(() => Math.random() - 0.5);

          for (const acct of order) {
            if (Date.now() >= deadlineMs) { summary.timedOut = true; break; }
            if (deviceFlagged) break;
            const quota = await quotasRepo.get(acct.platform as "instagram" | "threads" | "tiktok");
            const runId = await sessionsRepo.create(acct.id, { templateId: null, quota });
            const acctLog = makeLogger(log, {
              run_id: String(runId),
              device_id: deviceId,
              platform: acct.platform,
              username: acct.username,
              account_id: acct.id,
              phase: "warmup",
            });
            log("info", `[${deviceId}] round ${round}: running ${acct.platform} warmup for @${acct.username}`);
            // If multiple accounts exist on this device for this platform,
            // ensure the right one is active before the warmup begins.
            // Switcher is idempotent, so calling it when there's only one
            // account is safe but wasteful — skip it.
            const sameDevicePlatformCount = await accountsRepo
              .byDevicePlatform(deviceId, acct.platform as "instagram" | "threads" | "tiktok")
              .then((a) => a.length);
            if (sameDevicePlatformCount > 1) {
              const switchCtx = {
                driver,
                quota,
                log,
                stats: newStats(acct.platform as "instagram" | "threads" | "tiktok"),
                deadline: deadlineMs,
              };
              acctLog.event("info", "switcher.invoking", `switching to @${acct.username} before warmup`);
              let switched = false;
              try {
                if (acct.platform === "instagram") {
                  switched = await igSwitchAccount(switchCtx, acct.username, acctLog);
                } else if (acct.platform === "tiktok") {
                  switched = await tiktokSwitchAccount(switchCtx, acct.username, acctLog);
                } else if (acct.platform === "threads") {
                  switched = await threadsSwitchAccount(switchCtx, acct.username, acctLog);
                }
              } catch (err) {
                acctLog.fail("switcher.threw", "switcher raised", err);
              }
              if (!switched) {
                acctLog.event(
                  "warn",
                  "switcher.skipped-warmup",
                  "switcher could not confirm target account — skipping this account this wake",
                );
                await sessionsRepo.finish(runId, "failed", "switcher could not switch to target account");
                continue;
              }
            }
            try {
              // Build automation-specific extras.
              const extras: NonNullable<Parameters<typeof runPlatformSession>[6]> = {};
              if (automation === "follow") {
                const targets = await followTargetsRepo.byPlatform(acct.platform);
                const seeds = targets.map((t) => ({
                  handle: t.handle,
                  min_followers: t.min_followers,
                  max_followers: t.max_followers ?? undefined,
                }));
                extras.followConfig = {
                  seeds,
                  maxFollowsThisSession: quota.follows_per_session,
                };
              } else if (automation === "post") {
                const due = await scheduledPostsRepo.due(acct.platform);
                if (due.length) {
                  const p = due[0];
                  await scheduledPostsRepo.updateStatus(p.id, "posting");
                  extras.post = {
                    id: p.id,
                    caption: p.caption,
                    media_urls: p.media_urls_json ? JSON.parse(p.media_urls_json) : undefined,
                  };
                } else {
                  log("info", `[${deviceId}] no posts queued for ${acct.platform}; skipping`);
                  await sessionsRepo.finish(runId, "completed", "no posts queued");
                  activeAccountIds.delete(acct.id);
                  continue;
                }
              }
              const stats = await runPlatformSession(
                acct.platform as "instagram" | "threads" | "tiktok",
                driver,
                quota,
                log,
                deadlineMs,
                automation,
                extras,
              );
              // For post automation, update post status after the run.
              if (automation === "post" && extras.post) {
                if (stats.errors > 0) {
                  await scheduledPostsRepo.updateStatus(extras.post.id, "failed", `${stats.errors} errors during run`);
                } else {
                  await scheduledPostsRepo.updateStatus(extras.post.id, "posted");
                }
              }
              summary.perAccountStats.push({
                accountId: acct.id,
                username: acct.username,
                platform: acct.platform,
                stats,
              });
              await sessionsRepo.recordActions(runId, stats);
              await sessionsRepo.finish(runId, stats.hit_deadline ? "canceled-timeout" : "completed");
              if (stats.hit_deadline) summary.timedOut = true;
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              // StalledError is now non-fatal — the watchdog is log-only inside
              // the platform runner, but keep this catch defensively. Log and
              // fall through to the next platform in this round.
              if (e instanceof StalledError) {
                log(
                  "warn",
                  `[${deviceId}] ⏱ stall (${e.durationSec}s) on ${acct.platform} @${acct.username}: ${e.focus || "unknown screen"} — falling back to next platform`,
                );
                await sessionsRepo.finish(runId, "failed", `stalled ${e.durationSec}s on ${e.focus}`);
                await accountsRepo.touchLastRun(acct.id);
                continue;
              }
              // Transient Duoplus ADB proxy errors — log and skip to next account.
              if (/Please do not repeat|not been mounted|Request too frequent|\b\[512\]|\b\[160004\]/i.test(msg)) {
                log("warn", `[${deviceId}] transient ADB error for ${acct.platform}: ${msg.slice(0, 120)}`);
                log("warn", `  Skipping this account this round; will retry next cycle.`);
                await sessionsRepo.finish(runId, "failed", `transient: ${msg}`);
                await accountsRepo.touchLastRun(acct.id);
                continue;
              }
              // Session couldn't locate the main feed → treat as "not logged in"
              // and leave a note. Drop it from this device's active set.
              if (/Home tab not found|no Home tab|not detected|no Feed tab/i.test(msg)) {
                log(
                  "warn",
                  `[${deviceId}] ⚠ ${acct.platform} @${acct.username} appears NOT logged in — flagging for manual login`,
                );
                await accountsRepo.update(acct.id, {
                  status: "needs-manual-login",
                  notes: `Auto-flagged ${new Date().toISOString()}: session couldn't find main feed`,
                });
                await sessionsRepo.finish(runId, "needs-manual-login", msg);
                activeAccountIds.delete(acct.id);
                await accountsRepo.touchLastRun(acct.id);
                continue;
              }
              // Login-wall: the app is installed but nobody is logged in.
              // No retry will fix this — mark the slot as needing operator
              // attention, mark any existing account row as
              // needs-manual-login so it's skipped next wake, and fall
              // through so other platforms on this device still run.
              if (e instanceof LoginWallError) {
                acctLog.event(
                  "warn",
                  "account.login-wall",
                  `${e.platform} not logged in — slot needs operator attention`,
                  { reason: e.reasonLine },
                );
                try {
                  await accountRequestsRepo.flag({
                    device_id: deviceId,
                    platform: e.platform,
                    reason: e.reasonLine,
                  });
                } catch (flagErr) {
                  acctLog.fail("account.flag-failed", "could not record account_request", flagErr);
                }
                await accountsRepo.update(acct.id, {
                  status: "needs-manual-login",
                  notes: `Login-wall ${new Date().toISOString()}: ${e.reasonLine}`,
                });
                await sessionsRepo.finish(runId, "needs-manual-login", e.reasonLine);
                activeAccountIds.delete(acct.id);
                await accountsRepo.touchLastRun(acct.id);
                // NOT deviceFlagged — other platforms on this device keep running.
                continue;
              }
              // Verification required is a SOFT flag — account isn't broken,
              // platform just wants a human. Check this BEFORE the generic
              // AccountFlaggedError catch (it's a subclass).
              if (e instanceof VerificationRequiredError) {
                acctLog.event(
                  "warn",
                  "account.verify-required",
                  `verification gate hit: ${e.reasonLine}`,
                  { reason: e.reasonLine },
                );
                await accountsRepo.update(acct.id, {
                  status: "verification-required",
                  notes: `Verify gate ${new Date().toISOString()}: ${e.reasonLine}`,
                });
                await sessionsRepo.finish(runId, "verification-required", e.reasonLine);

                // Try to rotate in a fresh pool account so this device isn't
                // dark on this platform until a human verifies. Best-effort —
                // if the pool is empty, just log and continue.
                const claimed = await poolRepo.claimForRotation(
                  deviceId,
                  acct.platform as "instagram" | "threads" | "tiktok",
                );
                if (claimed != null) {
                  acctLog.event(
                    "ok",
                    "pool.claimed",
                    `claimed pool login #${claimed} for ${acct.platform} on this device — login flow runs next wake`,
                    { loginId: claimed },
                  );
                } else {
                  acctLog.event(
                    "warn",
                    "pool.empty",
                    `no ${acct.platform} accounts in pool to rotate in`,
                  );
                }
                activeAccountIds.delete(acct.id);
                await accountsRepo.touchLastRun(acct.id);
                // NOT deviceFlagged — other platforms on this device can still run.
                continue;
              }
              if (e instanceof AccountFlaggedError) {
                acctLog.event(
                  "error",
                  "account.suspended",
                  `account flagged: ${e.reasonLine}`,
                  { reason: e.reasonLine },
                );
                log("error", `  marking account suspended. It will be skipped until you manually flip status back to 'active'.`);
                await accountsRepo.update(acct.id, {
                  status: "suspended",
                  notes: `Auto-flagged ${new Date().toISOString()}: ${e.reasonLine}`,
                });
                await sessionsRepo.finish(runId, "account-suspended", e.reasonLine);

                // Auto-rotate from pool — same as verification path.
                const claimed = await poolRepo.claimForRotation(
                  deviceId,
                  acct.platform as "instagram" | "threads" | "tiktok",
                );
                if (claimed != null) {
                  acctLog.event(
                    "ok",
                    "pool.claimed",
                    `claimed pool login #${claimed} to replace suspended @${acct.username}`,
                    { loginId: claimed },
                  );
                } else {
                  acctLog.event("warn", "pool.empty", `no ${acct.platform} accounts in pool`);
                }

                // A SUSPENSION (vs verification) suggests heavier platform
                // attention — power off the device for THIS platform's
                // remaining cycles, but let other platforms still run if
                // their accounts are different. To keep the previous
                // behavior of "stop the device entirely on suspension"
                // backwards-compatible, set deviceFlagged.
                summary.finalError = `account flagged: ${e.reasonLine}`;
                deviceFlagged = true;
                activeAccountIds.delete(acct.id);
                await accountsRepo.touchLastRun(acct.id);
                break;
              }
              log("error", `[${deviceId}] ${acct.platform} run error: ${msg}`);
              await sessionsRepo.finish(runId, "failed", msg);
            }
            await accountsRepo.touchLastRun(acct.id);
          }

          if (deviceFlagged) break;
          const sessionElapsedMs = Date.now() - sessionStart;
          if (sessionElapsedMs >= SESSION_FLOOR_MS) {
            log(
              "ok",
              `[${deviceId}] 20-min session floor reached (${Math.floor(sessionElapsedMs / 1000)}s); wrapping up`,
            );
            break;
          }
          if (activeAccountIds.size === 0) {
            log(
              "warn",
              `[${deviceId}] no active platforms remaining after round ${round} — ending early`,
            );
            break;
          }
          if (Date.now() >= deadlineMs) break;
          // Cooldown between rounds — real users don't immediately re-launch
          // another app after closing one. Bimodal: short pause most of the
          // time, occasional longer "got distracted" gap.
          const cooldownMs = Math.random() < 0.7
            ? 15000 + Math.floor(Math.random() * 45000)   // 15–60s usual
            : 75000 + Math.floor(Math.random() * 120000); // 75s–3.25min rarely
          log(
            "info",
            `[${deviceId}] round ${round} done (${Math.floor(sessionElapsedMs / 1000)}s session); ${Math.floor(cooldownMs / 1000)}s cooldown before next cycle`,
          );
          await new Promise((r) => setTimeout(r, cooldownMs));
        }

        // Power off — cloud only. Locals stay as they are.
        if (!isLocal) {
          log("info", `[${deviceId}] powering off`);
          try {
            await client.powerOff([deviceId]);
            log("ok", `[${deviceId}] powered off`);
          } catch (e) {
            log("warn", `[${deviceId}] power-off failed: ${e instanceof Error ? e.message : e}`);
          }
        } else {
          log("ok", `[${deviceId}] local device left in current state`);
        }
        summary.endedAt = Date.now();
        summary.durationSec = Math.floor((summary.endedAt - powerOnAt) / 1000);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log("error", `[${deviceId}] fatal: ${msg}`);
        summary.finalError = msg;
        if (!localIds.has(deviceId)) {
          try { await client.powerOff([deviceId]); } catch {}
        }
        summary.endedAt = Date.now();
        summary.durationSec = Math.floor((summary.endedAt - powerOnAt) / 1000);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  log("info", "");
  log("info", "═══ Batch complete — per-device summary ═══");
  for (const s of summaries) {
    for (const line of formatSummary(s)) log(s.timedOut ? "warn" : "ok", line);
  }
  return summaries;
}
