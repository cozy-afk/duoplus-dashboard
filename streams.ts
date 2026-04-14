/**
 * Live device streams orchestration.
 *
 * Coordinates the prerequisites for ws-scrcpy to see a device:
 *   - LOCAL devices (USB / wifi-debug) are already in `adb devices` —
 *     nothing to do; their udid IS the deviceId.
 *   - CLOUD (Duoplus) devices need their TCP-ADB endpoint enabled and
 *     whitelisted, then a local `adb connect host:port`. The udid that
 *     ws-scrcpy keys off of is "host:port".
 *
 * This module DOES NOT manage the ws-scrcpy process itself — that runs
 * externally. We just make sure devices show up in the local adb daemon
 * so ws-scrcpy can list and stream them.
 *
 * Connection state is held in-memory (a Set of connected udids) — restarting
 * the dashboard server will lose that state, but `adb devices` is the source
 * of truth and we re-detect on each connect call.
 */

import { spawn } from "node:child_process";
import type { DuoplusClient, Device } from "./duoplus.ts";
import { eventLogsRepo } from "./db.ts";

/** Path to the host adb binary. Override via env if not on $PATH. */
const ADB_BIN = process.env.ADB_BIN || "adb";

/** Cache of cloud udids we've successfully `adb connect`-ed this process. */
const connectedUdids = new Set<string>();

export interface StreamConnectResult {
  /** udid as it appears in `adb devices` — what ws-scrcpy uses to identify the device. */
  udid: string;
  /** True if this call established a NEW connection; false if it was already open. */
  newConnection: boolean;
  /** Source of the device — informs the caller whether any teardown is needed on disconnect. */
  source: "local" | "cloud";
}

/** Run `adb` and return stdout (or throw on non-zero exit). */
function runAdb(args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ADB_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill("SIGKILL"); } catch { /* already exited */ }
      reject(new Error(`adb ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (killed) return;
      reject(new Error(`adb spawn failed (${err.message}). Set ADB_BIN env if adb isn't on PATH.`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) resolve(stdout);
      else reject(new Error(`adb ${args.join(" ")} exit ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

/** Parse `adb devices -l` output → set of udids that are 'device' state (online). */
function parseAdbDevices(output: string): Set<string> {
  const udids = new Set<string>();
  const lines = output.split("\n").slice(1); // skip "List of devices attached"
  for (const line of lines) {
    const m = line.match(/^(\S+)\s+(device|offline|unauthorized)\b/);
    if (m && m[2] === "device") udids.add(m[1]);
  }
  return udids;
}

/** Return the udids currently visible to the local adb daemon. */
export async function listAdbDevices(): Promise<string[]> {
  try {
    const out = await runAdb(["devices", "-l"]);
    return [...parseAdbDevices(out)];
  } catch {
    return [];
  }
}

/**
 * Resolve our current public IP for the Duoplus ADB whitelist. Override via
 * env if you want to pin a specific source IP (e.g. when behind a fixed
 * outbound NAT / VPN).
 */
async function fetchPublicIp(): Promise<string | null> {
  const override = process.env.WHITELIST_IP;
  if (override) return override.trim();
  try {
    const res = await fetch("https://api.ipify.org?format=text", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const ip = (await res.text()).trim();
    // Crude validation — reject anything that doesn't look like an IPv4/IPv6.
    if (!/^[0-9a-fA-F:.]+$/.test(ip)) return null;
    return ip;
  } catch {
    return null;
  }
}

/**
 * Enable + connect a Duoplus cloud device for direct ADB access. Returns the
 * "host:port" udid the local adb daemon will list it under. Idempotent —
 * safe to call repeatedly.
 *
 * Steps (each step is logged as a separate event so you can pinpoint where
 * the connection failed):
 *   1. Duoplus batchEnableAdb — turns on the TCP-ADB endpoint server-side.
 *   2. Fetch device details to read the `adb` (host:port) field.
 *   3. Push our public IP onto the whitelist so the endpoint will accept us.
 *   4. `adb connect host:port` — local daemon picks it up.
 *   5. Verify it shows up in `adb devices`.
 */
async function connectCloudDevice(
  client: DuoplusClient,
  deviceId: string,
): Promise<string> {
  await eventLogsRepo.record({
    level: "info", code: "stream.enabling-adb", msg: "enabling cloud-side ADB",
    device_id: deviceId, phase: "connect",
  });

  // 1. Server-side enable. Idempotent on Duoplus's side.
  try {
    await client.enableAdb([deviceId]);
  } catch (err) {
    await eventLogsRepo.record({
      level: "warn", code: "stream.enable-failed",
      msg: `batchEnableAdb threw (continuing — may already be enabled): ${err instanceof Error ? err.message : err}`,
      device_id: deviceId, phase: "connect",
    });
  }

  // 2. Read the adb endpoint. Details may need a beat after enable.
  let dev: Device | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      dev = await client.details(deviceId);
      if (dev?.adb && /:\d+/.test(dev.adb)) break;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!dev?.adb) {
    throw new Error(`Duoplus did not return an adb endpoint for ${deviceId} after enabling. Check that adb is supported on this device tier.`);
  }
  const endpoint = dev.adb.trim(); // "1.2.3.4:5555"

  // 3. Whitelist our IP so the endpoint will accept the connect.
  const ip = await fetchPublicIp();
  if (ip) {
    try {
      await client.setAdbWhitelist(deviceId, [ip]);
      await eventLogsRepo.record({
        level: "info", code: "stream.whitelisted",
        msg: `whitelisted ${ip} for ${endpoint}`,
        device_id: deviceId, phase: "connect", json: { endpoint, ip },
      });
    } catch (err) {
      // Don't hard-fail — the IP might already be whitelisted.
      await eventLogsRepo.record({
        level: "warn", code: "stream.whitelist-failed",
        msg: `setAdbWhitelist threw (continuing): ${err instanceof Error ? err.message : err}`,
        device_id: deviceId, phase: "connect",
      });
    }
  } else {
    await eventLogsRepo.record({
      level: "warn", code: "stream.no-public-ip",
      msg: "could not detect public IP — adb connect may be rejected",
      device_id: deviceId, phase: "connect",
    });
  }

  // 4. Local `adb connect`. Retry once because the endpoint sometimes needs
  //    a moment after the whitelist push.
  let connected = false;
  let lastErr: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await runAdb(["connect", endpoint], 12000);
      if (/^connected to|already connected/i.test(out.trim())) {
        connected = true;
        break;
      }
      lastErr = out.trim();
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!connected) {
    throw new Error(`adb connect ${endpoint} failed: ${lastErr ?? "unknown"}`);
  }

  // 5. Verify presence in `adb devices`. ws-scrcpy lists from the same source
  //    so if we don't see it here, the stream tile won't see it either.
  const present = (await listAdbDevices()).includes(endpoint);
  if (!present) {
    throw new Error(`adb connect succeeded but ${endpoint} not visible in 'adb devices' — check that the daemon is running on this host`);
  }

  connectedUdids.add(endpoint);
  await eventLogsRepo.record({
    level: "ok", code: "stream.connected",
    msg: `cloud device adb-connected as ${endpoint}`,
    device_id: deviceId, phase: "connect", json: { udid: endpoint },
  });
  return endpoint;
}

/**
 * Public API: ensure a device is reachable via the local adb daemon and
 * return the udid ws-scrcpy should be pointed at. `isLocal` callers pass the
 * device's own id back unchanged (no work needed). Cloud callers go through
 * the full enable+connect path.
 */
export async function ensureStreamReady(
  client: DuoplusClient,
  deviceId: string,
  isLocal: boolean,
): Promise<StreamConnectResult> {
  if (isLocal) {
    // Local devices' udid IS the deviceId — confirm the daemon sees it.
    const present = (await listAdbDevices()).includes(deviceId);
    if (!present) {
      throw new Error(`local device ${deviceId} not visible to the local adb daemon — plug in / re-authorize and retry`);
    }
    return { udid: deviceId, newConnection: false, source: "local" };
  }

  if (connectedUdids.has(deviceId)) {
    return { udid: deviceId, newConnection: false, source: "cloud" };
  }

  // Did we already connect this device under a different udid (its host:port)?
  // Walk the cache by Duoplus deviceId mapping isn't kept here, so just
  // attempt the full connect flow — it's idempotent on the Duoplus side and
  // adb's side ('already connected to ...').
  const udid = await connectCloudDevice(client, deviceId);
  return { udid, newConnection: true, source: "cloud" };
}

/**
 * Tear down a cloud device's adb connection. Local devices are no-ops — we
 * never managed their connection in the first place. Idempotent.
 */
export async function teardownStream(udid: string, isLocal: boolean): Promise<void> {
  if (isLocal) return;
  try {
    await runAdb(["disconnect", udid], 8000);
  } catch {
    // Already disconnected or daemon down — nothing to do.
  }
  connectedUdids.delete(udid);
  await eventLogsRepo.record({
    level: "info", code: "stream.disconnected",
    msg: `adb disconnected ${udid}`,
    device_id: udid, phase: "disconnect",
  });
}

/**
 * Build the URL the iframe should load. ws-scrcpy reads the udid from the
 * query string and the player from the same. We pin tinyh264 (CPU decoder,
 * works in every browser) — change to mse or broadway for hardware decode if
 * you've configured ws-scrcpy with those players.
 */
export function buildStreamUrl(baseUrl: string, udid: string): string {
  const u = new URL(baseUrl.replace(/\/$/, "") + "/");
  u.searchParams.set("action", "stream");
  u.searchParams.set("udid", udid);
  u.searchParams.set("player", "tinyh264");
  return u.toString();
}

/** Streams configuration the UI needs to render the Live Streams tab. */
export interface StreamsConfig {
  enabled: boolean;
  baseUrl: string;
}

export function getStreamsConfig(): StreamsConfig {
  return {
    enabled: process.env.STREAMS_ENABLED === "true",
    baseUrl: process.env.WS_SCRCPY_URL || "http://localhost:8000",
  };
}
