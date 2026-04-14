/**
 * Talks to a locally-installed `adb` binary for physical / locally-attached
 * Android devices (USB, Wi-Fi debug, local emulators). Mirrors the subset
 * of DuoplusClient's ADB surface the rest of the app uses.
 *
 * Requires `adb` in PATH (from Android Platform Tools — `brew install
 * --cask android-platform-tools` on macOS, install from developer.android.com
 * on Windows, `apt install adb` on Linux).
 */

import { spawn } from "node:child_process";

/** Run `adb ...args` and collect stdout. Rejects on non-zero exit. */
async function adb(args: string[], timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("adb", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`adb timeout after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`adb spawn failed: ${e.message}. Is adb installed?`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`adb exited ${code}: ${(stderr || stdout).slice(0, 200)}`));
    });
  });
}

export interface LocalDevice {
  id: string;               // the serial (emulator-5554, R58M..., 192.168.1.10:5555)
  state: string;            // 'device', 'offline', 'unauthorized', etc.
  product?: string;
  model?: string;
  transport_id?: string;
  source: "local";
}

/** Parse `adb devices -l` output into structured rows. */
export async function listLocalDevices(): Promise<LocalDevice[]> {
  let raw = "";
  try {
    raw = await adb(["devices", "-l"], 5000);
  } catch {
    return [];
  }
  const lines = raw.split("\n").slice(1); // skip "List of devices attached" header
  const devices: LocalDevice[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, state, ...rest] = trimmed.split(/\s+/);
    if (!id) continue;
    const kv: Record<string, string> = {};
    for (const pair of rest) {
      const eq = pair.indexOf(":");
      if (eq > 0) kv[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    devices.push({
      id,
      state,
      product: kv.product,
      model: kv.model,
      transport_id: kv.transport_id,
      source: "local",
    });
  }
  return devices;
}

/**
 * Run `adb -s <id> shell <cmd>` and return stdout. Matches the shape of
 * DuoplusClient.adbCommand's return for a single device.
 */
export async function localAdbShell(deviceId: string, cmd: string): Promise<string> {
  return await adb(["-s", deviceId, "shell", cmd], 30000);
}

/** Pull a file from the device to a local path. */
export async function localAdbPull(deviceId: string, remote: string, local: string): Promise<void> {
  await adb(["-s", deviceId, "pull", remote, local], 20000);
}

/**
 * Run `adb -s <id> exec-out <cmd>` and return the raw stdout as a Buffer.
 * Used for binary streams like `screencap -p` (PNG bytes). The `exec-out`
 * variant avoids the shell's TTY line-conversion that would corrupt binary.
 */
export async function localAdbExecOut(deviceId: string, cmd: string, timeoutMs = 15000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const proc = spawn("adb", ["-s", deviceId, "exec-out", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve(null); }, timeoutMs);
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.on("error", () => { clearTimeout(timer); resolve(null); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null);
    });
  });
}

/** Check if adb is installed. */
export async function adbAvailable(): Promise<boolean> {
  try {
    await adb(["version"], 3000);
    return true;
  } catch {
    return false;
  }
}
