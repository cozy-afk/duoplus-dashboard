/**
 * Bun HTTP server for the Duoplus dashboard.
 * Serves the static HTML frontend + JSON API endpoints that proxy to Duoplus.
 *
 * Run: bun run dev  (from this directory)
 */

import { DuoplusClient, DuoplusError, statusLabel } from "./duoplus.ts";
import { batchRun, type LogFn } from "./runner.ts";
import { listLocalDevices } from "./local-adb.ts";
import { DeviceDriver } from "./device-driver.ts";
import { analyzeScreenshot } from "./vision.ts";
import { scanDevice, multiScanDevice } from "./account-scanner.ts";
import {
  ensureStreamReady,
  teardownStream,
  buildStreamUrl,
  getStreamsConfig,
  listAdbDevices,
} from "./streams.ts";
import {
  initDb,
  accountsRepo,
  quotasRepo,
  sessionsRepo,
  growthRepo,
  followTargetsRepo,
  scheduledPostsRepo,
  unknownScreensRepo,
  loginQueueRepo,
  poolRepo,
  batchRunsRepo,
  batchRunLogsRepo,
  eventLogsRepo,
  screenPatternsRepo,
  accountRequestsRepo,
  type RecoveryAction,
  type SignatureRule,
} from "./db.ts";
import { invalidatePatternCache } from "./screen-analyzer.ts";
import {
  runInstagramPhase,
  type WarmupPhase,
  type WarmupPhaseConfig,
} from "./platform/instagram/index.ts";
import {
  runTiktokPhase,
  type TikTokWarmupPhase,
  type TikTokWarmupPhaseConfig,
} from "./platform/tiktok/index.ts";
import { DeviceDriver as PhaseDriver } from "./device-driver.ts";
import { newStats } from "./automation.ts";
import { Watchdog } from "./watchdog.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3030);
const API_KEY = process.env.DUOPLUS_API_KEY;

// HTTP Basic Auth (required in cloud deploys; optional locally).
// Set DASHBOARD_USER + DASHBOARD_PASSWORD to enable.
const AUTH_USER = process.env.DASHBOARD_USER;
const AUTH_PASSWORD = process.env.DASHBOARD_PASSWORD;
const AUTH_ENABLED = Boolean(AUTH_USER && AUTH_PASSWORD);

if (!API_KEY) {
  console.error("ERROR: DUOPLUS_API_KEY not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

if (AUTH_ENABLED) {
  console.log(`Basic Auth enabled for user '${AUTH_USER}'.`);
} else {
  console.log("Basic Auth DISABLED — ok for localhost, not for public deploys.");
}

function checkAuth(req: Request): boolean {
  if (!AUTH_ENABLED) return true;
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length).trim());
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return user === AUTH_USER && pass === AUTH_PASSWORD;
}

function authChallenge(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Duoplus Dashboard"' },
  });
}

// Initialise database schema + seeds before the server accepts connections.
await initDb();

const client = new DuoplusClient(API_KEY);
const indexHtml = readFileSync(join(__dirname, "index.html"), "utf8");

// Track live orchestration streams so the UI can follow progress.
const runs = new Map<string, { logs: { ts: number; level: string; msg: string }[]; done: boolean }>();

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errResponse(err: unknown, status = 500) {
  if (err instanceof DuoplusError) {
    return jsonResponse({ code: err.code, message: err.message }, 400);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return jsonResponse({ error: msg }, status);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0", // required on Render / Docker
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    // Unauthenticated health check (used by Render + load balancers).
    if (path === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }
    if (!checkAuth(req)) return authChallenge();
    try {
      // --- UI ---
      if (path === "/" || path === "/index.html") {
        return new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      // --- Device APIs ---
      if (path === "/api/devices" && req.method === "GET") {
        // Cloud devices from Duoplus.
        let cloudList: Array<Record<string, unknown>> = [];
        try {
          const data = await client.listDevices(1, 200);
          cloudList = (data.list || []).map((d) => ({
            ...d,
            status_label: statusLabel(d.status),
            source: "cloud",
          }));
        } catch (e) {
          console.error("cloud listDevices failed:", e);
        }
        // Local devices via `adb devices -l` on the server host.
        const localRaw = await listLocalDevices();
        const localList = localRaw.map((d) => ({
          id: d.id,
          name: d.model || d.product || d.id,
          status: d.state === "device" ? 1 : 2,
          status_label: d.state,
          os: d.product || "",
          area: "local",
          ip: "",
          adb: d.id, // the serial itself IS the adb address
          source: "local",
          transport_id: d.transport_id,
        }));
        const list = [...cloudList, ...localList];
        return jsonResponse({ list, total: list.length });
      }

      if (path === "/api/status" && req.method === "POST") {
        const body = await readBody(req);
        const ids = (body.ids ?? body.image_ids ?? []) as string[];
        return jsonResponse(await client.status(ids));
      }

      if (path === "/api/details" && req.method === "POST") {
        const body = await readBody(req);
        const id = (body.id ?? body.image_id) as string;
        return jsonResponse(await client.details(id));
      }

      if (path === "/api/power-on" && req.method === "POST") {
        const body = await readBody(req);
        const ids = (body.ids ?? body.image_ids ?? []) as string[];
        return jsonResponse(await client.powerOn(ids));
      }

      if (path === "/api/power-off" && req.method === "POST") {
        const body = await readBody(req);
        const ids = (body.ids ?? body.image_ids ?? []) as string[];
        return jsonResponse(await client.powerOff(ids));
      }

      if (path === "/api/restart" && req.method === "POST") {
        const body = await readBody(req);
        const ids = (body.ids ?? body.image_ids ?? []) as string[];
        return jsonResponse(await client.restart(ids));
      }

      if (path.startsWith("/api/run/") && path.endsWith("/logs") && req.method === "GET") {
        const runId = path.slice("/api/run/".length, -"/logs".length);
        const run = runs.get(runId);
        if (run) return jsonResponse({ logs: run.logs, done: run.done });
        // Fall through to persisted logs — useful after a server restart.
        const meta = await batchRunsRepo.get(runId);
        if (!meta) return jsonResponse({ error: "run not found" }, 404);
        const dbLogs = await batchRunLogsRepo.since(runId, 0);
        return jsonResponse({
          logs: dbLogs.map((l) => ({ ts: l.ts, level: l.level, msg: l.msg })),
          done: meta.status !== "running",
          status: meta.status,
        });
      }
      if (path === "/api/runs" && req.method === "GET") {
        return jsonResponse(await batchRunsRepo.recent(50));
      }

      // --- Accounts ---
      if (path === "/api/accounts" && req.method === "GET") {
        const accounts = await accountsRepo.list();
        const rows = await Promise.all(
          accounts.map(async (a) => {
            const [summary, latest] = await Promise.all([
              sessionsRepo.dailySummary(a.id),
              growthRepo.latest(a.id),
            ]);
            return {
              ...a,
              runs_today: summary.runs,
              followers_delta_today: summary.followers_delta,
              followers: latest?.followers ?? null,
              following: latest?.following ?? null,
              posts: latest?.posts ?? null,
              last_snapshot_ts: latest?.ts ?? null,
            };
          }),
        );
        return jsonResponse(rows);
      }
      if (path === "/api/accounts" && req.method === "POST") {
        const body = await readBody(req);
        const id = await accountsRepo.create({
          device_id: body.device_id as string,
          platform: body.platform as "instagram" | "threads" | "tiktok",
          username: body.username as string,
          notes: (body.notes as string) ?? null,
        });
        return jsonResponse({ id });
      }
      if (path.startsWith("/api/accounts/") && req.method === "PATCH") {
        const id = Number(path.split("/")[3]);
        const body = await readBody(req);
        await accountsRepo.update(id, body as Parameters<typeof accountsRepo.update>[1]);
        return jsonResponse({ ok: true });
      }
      if (path.startsWith("/api/accounts/") && req.method === "DELETE") {
        const id = Number(path.split("/")[3]);
        await accountsRepo.delete(id);
        return jsonResponse({ ok: true });
      }
      if (/^\/api\/accounts\/\d+\/sessions$/.test(path) && req.method === "GET") {
        const id = Number(path.split("/")[3]);
        return jsonResponse(await sessionsRepo.recentForAccount(id, 30));
      }
      if (/^\/api\/accounts\/\d+\/growth$/.test(path) && req.method === "GET") {
        const id = Number(path.split("/")[3]);
        return jsonResponse(await growthRepo.series(id, 30));
      }
      if (/^\/api\/accounts\/\d+\/snapshot$/.test(path) && req.method === "POST") {
        const id = Number(path.split("/")[3]);
        const body = await readBody(req);
        await growthRepo.record(
          id,
          body.followers as number | null,
          body.following as number | null,
          body.posts as number | null,
        );
        return jsonResponse({ ok: true });
      }

      // --- Proxies ---
      if (path === "/api/proxies" && req.method === "GET") {
        return jsonResponse(await client.listProxies(1, 200));
      }
      if (path === "/api/proxies" && req.method === "POST") {
        const body = await readBody(req);
        const proxies = (body.proxies ?? []) as Array<{
          host: string;
          port: number;
          user?: string;
          password?: string;
          protocol?: "socks5" | "http";
          name?: string;
        }>;
        if (!proxies.length) return jsonResponse({ error: "proxies required" }, 400);
        const payload = proxies.map((p) => ({ protocol: "socks5" as const, ...p }));
        return jsonResponse(await client.addProxies(payload));
      }
      if (path === "/api/proxies" && req.method === "DELETE") {
        const body = await readBody(req);
        const ids = (body.ids ?? []) as string[];
        if (!ids.length) return jsonResponse({ error: "ids required" }, 400);
        return jsonResponse(await client.deleteProxies(ids));
      }
      if (path.startsWith("/api/proxies/") && req.method === "PATCH") {
        const id = path.split("/")[3];
        const body = await readBody(req);
        return jsonResponse(await client.updateProxy(id, body as Parameters<typeof client.updateProxy>[1]));
      }
      if (path === "/api/set-proxy" && req.method === "POST") {
        const body = await readBody(req);
        const deviceId = body.device_id as string;
        const proxyId = body.proxy_id as string | undefined;
        const host = body.host as string | undefined;
        const port = body.port as number | undefined;
        const user = body.user as string | undefined;
        const password = body.password as string | undefined;
        if (!deviceId) return jsonResponse({ error: "device_id required" }, 400);
        if (!proxyId && !host) {
          return jsonResponse({ error: "Either proxy_id or (host, port) required" }, 400);
        }
        const images = [
          {
            image_id: deviceId,
            proxy: proxyId ? { id: proxyId } : { host, port, user, password },
          },
        ];
        return jsonResponse(await client.initProxy(images));
      }

      // --- Follow Targets ---
      if (path === "/api/follow-targets" && req.method === "GET") {
        return jsonResponse(await followTargetsRepo.list());
      }
      if (path === "/api/follow-targets" && req.method === "POST") {
        const body = await readBody(req);
        const id = await followTargetsRepo.create({
          platform: body.platform as "instagram" | "threads" | "tiktok",
          handle: body.handle as string,
          min_followers: body.min_followers as number | undefined,
          max_followers: body.max_followers as number | null | undefined,
          min_posts: body.min_posts as number | undefined,
          max_following: body.max_following as number | null | undefined,
          require_avatar: body.require_avatar as number | undefined,
          skip_private: body.skip_private as number | undefined,
          notes: body.notes as string | null | undefined,
        });
        return jsonResponse({ id });
      }
      if (path.startsWith("/api/follow-targets/") && req.method === "PATCH") {
        const id = Number(path.split("/")[3]);
        const body = await readBody(req);
        await followTargetsRepo.update(id, body as Parameters<typeof followTargetsRepo.update>[1]);
        return jsonResponse({ ok: true });
      }
      if (path.startsWith("/api/follow-targets/") && req.method === "DELETE") {
        const id = Number(path.split("/")[3]);
        await followTargetsRepo.delete(id);
        return jsonResponse({ ok: true });
      }

      // --- Scheduled Posts ---
      if (path === "/api/posts" && req.method === "GET") {
        return jsonResponse(await scheduledPostsRepo.list());
      }
      if (path === "/api/posts" && req.method === "POST") {
        const body = await readBody(req);
        const id = await scheduledPostsRepo.create({
          account_id: body.account_id as number | null | undefined,
          platform: body.platform as "instagram" | "threads" | "tiktok",
          caption: body.caption as string | undefined,
          media_urls: body.media_urls as string[] | undefined,
          scheduled_at: body.scheduled_at as number | null | undefined,
        });
        return jsonResponse({ id });
      }
      if (path.startsWith("/api/posts/") && req.method === "DELETE") {
        const id = Number(path.split("/")[3]);
        await scheduledPostsRepo.delete(id);
        return jsonResponse({ ok: true });
      }

      // --- Login queue ---
      if (path === "/api/login-queue" && req.method === "GET") {
        return jsonResponse(await loginQueueRepo.list());
      }
      if (path === "/api/login-queue" && req.method === "POST") {
        const body = await readBody(req);
        const platform = body.platform as "instagram" | "threads" | "tiktok";
        const lines = ((body.lines as string) ?? "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!platform || !lines.length) {
          return jsonResponse({ error: "platform + lines required" }, 400);
        }
        const created: number[] = [];
        const skipped: { line: string; reason: string }[] = [];
        for (const line of lines) {
          const parts = line.split(":");
          if (parts.length < 2 || parts.length > 3) {
            skipped.push({ line, reason: "need username:password or username:password:2fa" });
            continue;
          }
          const [username, password, totp_secret] = parts;
          if (!username || !password) {
            skipped.push({ line, reason: "empty username or password" });
            continue;
          }
          created.push(
            await loginQueueRepo.create({
              platform,
              username: username.trim(),
              password: password.trim(),
              totp_secret: (totp_secret || "").trim() || null,
            }),
          );
        }
        return jsonResponse({ added: created.length, skipped });
      }
      if (path.startsWith("/api/login-queue/") && req.method === "DELETE") {
        const id = Number(path.split("/")[3]);
        await loginQueueRepo.delete(id);
        return jsonResponse({ ok: true });
      }

      // --- Account pool ---
      // GET /api/pool[?platform=instagram] → unassigned login_queue rows
      // (credentials waiting to be slotted onto a device). No passwords.
      if (path === "/api/pool" && req.method === "GET") {
        const platform = url.searchParams.get("platform") ?? undefined;
        return jsonResponse(await poolRepo.list(platform));
      }
      // POST /api/pool/:loginId/assign  body: {device_id}
      // Bind a pool row to a device. Login flow runs on the device's next wake.
      if (req.method === "POST") {
        const m = path.match(/^\/api\/pool\/(\d+)\/assign$/);
        if (m) {
          const loginId = Number(m[1]);
          const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
          const device_id = (body.device_id as string | undefined)?.trim();
          if (!device_id) return jsonResponse({ error: "device_id required" }, 400);
          const ok = await poolRepo.assign(loginId, device_id);
          if (!ok) return jsonResponse({ error: "row already claimed or not in pool" }, 409);
          return jsonResponse({ ok: true, loginId, device_id });
        }
      }

      // --- Multi-account device scan ---
      // POST /api/devices/:id/scan-accounts → run multiScanDevice, returns
      // { results: [{platform, status, usernames: [...]}] }. Discovered
      // handles are upserted into accounts table as a side effect.
      if (req.method === "POST") {
        const m = path.match(/^\/api\/devices\/([^/]+)\/scan-accounts$/);
        if (m) {
          const deviceId = decodeURIComponent(m[1]);
          const locals = await listLocalDevices().catch(() => []);
          const isLocal = locals.some((d) => d.id === deviceId);
          try {
            const results = await multiScanDevice(client, deviceId, isLocal, () => {});
            return jsonResponse({ results });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return jsonResponse({ error: msg }, 500);
          }
        }
      }

      // --- Event logs (structured) ---
      // GET /api/events?code=&device_id=&username=&level=&since=&limit=
      if (path === "/api/events" && req.method === "GET") {
        const code = url.searchParams.get("code") ?? undefined;
        const device_id = url.searchParams.get("device_id") ?? undefined;
        const username = url.searchParams.get("username") ?? undefined;
        const level = (url.searchParams.get("level") ?? undefined) as
          | "debug" | "info" | "warn" | "error" | "ok" | undefined;
        const since = url.searchParams.get("since");
        const limit = url.searchParams.get("limit");
        const events = await eventLogsRepo.filter({
          code,
          device_id,
          username,
          level,
          sinceTs: since ? Number(since) : undefined,
          limit: limit ? Math.min(Number(limit), 1000) : undefined,
        });
        return jsonResponse(events);
      }

      // --- Account requests (slots needing operator attention) ---
      // GET /api/account-requests[?all=1] → pending by default
      if (path === "/api/account-requests" && req.method === "GET") {
        const all = url.searchParams.get("all") === "1";
        return jsonResponse(
          all ? await accountRequestsRepo.listAll() : await accountRequestsRepo.listPending(),
        );
      }
      // POST /api/account-requests/:id/resolve — operator clicked "resolved"
      if (req.method === "POST") {
        const m = path.match(/^\/api\/account-requests\/(\d+)\/resolve$/);
        if (m) {
          await accountRequestsRepo.resolve(Number(m[1]));
          return jsonResponse({ ok: true });
        }
      }
      if (req.method === "DELETE") {
        const m = path.match(/^\/api\/account-requests\/(\d+)$/);
        if (m) {
          await accountRequestsRepo.delete(Number(m[1]));
          return jsonResponse({ ok: true });
        }
      }

      // --- Screen rescue patterns (operator-curated learned recoveries) ---
      // GET /api/screen-patterns[?platform=…&enabled=1]
      if (path === "/api/screen-patterns" && req.method === "GET") {
        const platform = url.searchParams.get("platform") ?? undefined;
        const enabledOnly = url.searchParams.get("enabled") === "1";
        return jsonResponse(await screenPatternsRepo.list({ platform, enabledOnly }));
      }
      // POST /api/screen-patterns — create from approval form
      // body: { name, platform?, signature: [{type, contains}], recovery_action,
      //          recovery_arg?, source_unknown_id?, notes? }
      if (path === "/api/screen-patterns" && req.method === "POST") {
        const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
        try {
          const id = await screenPatternsRepo.create({
            name: String(body.name ?? ""),
            platform: (body.platform as string | null | undefined) ?? null,
            signature: body.signature as SignatureRule[],
            recovery_action: body.recovery_action as RecoveryAction,
            recovery_arg: (body.recovery_arg as string | null | undefined) ?? null,
            source_unknown_id: (body.source_unknown_id as number | null | undefined) ?? null,
            notes: (body.notes as string | null | undefined) ?? null,
          });
          invalidatePatternCache();
          return jsonResponse({ id });
        } catch (err) {
          return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }
      // PATCH /api/screen-patterns/:id — body { enabled: bool }
      if (req.method === "PATCH") {
        const m = path.match(/^\/api\/screen-patterns\/(\d+)$/);
        if (m) {
          const id = Number(m[1]);
          const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
          if (typeof body.enabled !== "boolean") {
            return jsonResponse({ error: "body.enabled (bool) required" }, 400);
          }
          await screenPatternsRepo.setEnabled(id, body.enabled);
          invalidatePatternCache();
          return jsonResponse({ ok: true });
        }
      }
      // DELETE /api/screen-patterns/:id
      if (req.method === "DELETE") {
        const m = path.match(/^\/api\/screen-patterns\/(\d+)$/);
        if (m) {
          await screenPatternsRepo.delete(Number(m[1]));
          invalidatePatternCache();
          return jsonResponse({ ok: true });
        }
      }

      // --- Live Streams (ws-scrcpy sidecar) ---
      // GET /api/streams/config → { enabled, baseUrl }
      if (path === "/api/streams/config" && req.method === "GET") {
        return jsonResponse(getStreamsConfig());
      }
      // GET /api/streams/devices → udids visible to the local adb daemon
      // (so the UI can show a "ws-scrcpy will see this" indicator).
      if (path === "/api/streams/devices" && req.method === "GET") {
        return jsonResponse({ udids: await listAdbDevices() });
      }
      // POST /api/streams/:deviceId/connect → returns { udid, streamUrl, source }
      // Idempotent — calling on an already-connected device returns the same udid.
      if (req.method === "POST") {
        const m = path.match(/^\/api\/streams\/([^/]+)\/connect$/);
        if (m) {
          const cfg = getStreamsConfig();
          if (!cfg.enabled) {
            return jsonResponse({ error: "streams disabled — set STREAMS_ENABLED=true" }, 409);
          }
          const deviceId = decodeURIComponent(m[1]);
          const locals = await listLocalDevices().catch(() => []);
          const isLocal = locals.some((d) => d.id === deviceId);
          try {
            const result = await ensureStreamReady(client, deviceId, isLocal);
            return jsonResponse({
              ...result,
              streamUrl: buildStreamUrl(cfg.baseUrl, result.udid),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return jsonResponse({ error: msg }, 500);
          }
        }
      }
      // POST /api/streams/:udid/disconnect → tears down adb-over-tcp connection.
      // The :udid here is the udid returned by /connect (host:port for cloud
      // devices), NOT the Duoplus deviceId.
      if (req.method === "POST") {
        const m = path.match(/^\/api\/streams\/([^/]+)\/disconnect$/);
        if (m) {
          const udid = decodeURIComponent(m[1]);
          const locals = await listLocalDevices().catch(() => []);
          const isLocal = locals.some((d) => d.id === udid);
          try {
            await teardownStream(udid, isLocal);
            return jsonResponse({ ok: true });
          } catch (err) {
            return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
          }
        }
      }

      // --- Live View: on-demand screenshot of any reachable device ---
      // GET /api/device/:id/screenshot.png → fresh PNG (or 503 if capture fails).
      // Detects local vs cloud by checking the local adb device list.
      {
        const liveShot = path.match(/^\/api\/device\/([^/]+)\/screenshot\.png$/);
        if (liveShot && req.method === "GET") {
          const deviceId = decodeURIComponent(liveShot[1]);
          const locals = await listLocalDevices().catch(() => []);
          const isLocal = locals.some((d) => d.id === deviceId);
          const driver = new DeviceDriver(client, deviceId, () => {}, isLocal ? "local" : "cloud");
          const png = await driver.screenshot();
          if (!png || png.length === 0) {
            return new Response("capture failed", { status: 503 });
          }
          return new Response(png, {
            headers: { "content-type": "image/png", "cache-control": "no-store" },
          });
        }
      }
      // POST /api/device/:id/analyze  { context?: string } → Claude vision
      // analysis of the current screen. Returns { analysis: string | null }.
      {
        const liveAnalyze = path.match(/^\/api\/device\/([^/]+)\/analyze$/);
        if (liveAnalyze && req.method === "POST") {
          const deviceId = decodeURIComponent(liveAnalyze[1]);
          const body = await readBody(req).catch(() => ({}));
          const ctx = (body.context as string | undefined) || "live-view";
          const locals = await listLocalDevices().catch(() => []);
          const isLocal = locals.some((d) => d.id === deviceId);
          const driver = new DeviceDriver(client, deviceId, () => {}, isLocal ? "local" : "cloud");
          const png = await driver.screenshot();
          if (!png) return jsonResponse({ error: "capture failed" }, 503);
          // Save alongside existing failure captures so the Screen Log keeps
          // a record of live-analyzed frames too.
          const { mkdirSync, writeFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          const dir = join(process.cwd(), "data", "screenshots");
          try { mkdirSync(dir, { recursive: true }); } catch {}
          const safe = deviceId.replace(/[^a-zA-Z0-9._-]/g, "_");
          const filename = `${safe}-live-${Date.now()}.png`;
          const abs = join(dir, filename);
          writeFileSync(abs, png);
          const analysis = await analyzeScreenshot(abs, ctx).catch(() => null);
          return jsonResponse({ analysis, screenshot: `/screenshots/${filename}` });
        }
      }

      // --- Unknown screens diagnostic ---
      if (path === "/api/unknown-screens" && req.method === "GET") {
        return jsonResponse(await unknownScreensRepo.list(200));
      }
      // Serve saved screenshots (only from the dashboard's data/screenshots dir).
      if (path.startsWith("/screenshots/") && req.method === "GET") {
        const name = path.slice("/screenshots/".length);
        // Reject traversal attempts — only allow basename characters.
        if (!/^[a-zA-Z0-9._-]+\.png$/.test(name)) {
          return new Response("bad name", { status: 400 });
        }
        const { existsSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const abs = join(process.cwd(), "data", "screenshots", name);
        if (!existsSync(abs)) return new Response("not found", { status: 404 });
        return new Response(readFileSync(abs), {
          headers: { "content-type": "image/png", "cache-control": "max-age=3600" },
        });
      }
      if (path.startsWith("/api/unknown-screens/") && req.method === "DELETE") {
        const id = Number(path.split("/")[3]);
        await unknownScreensRepo.delete(id);
        return jsonResponse({ ok: true });
      }
      if (path === "/api/unknown-screens/clear" && req.method === "POST") {
        await unknownScreensRepo.clearOlderThan(0);
        return jsonResponse({ ok: true });
      }
      // GET /api/unknown-screens/:id — single row WITH xml_head (for the
      // approve-as-pattern modal which needs the full dump to extract
      // signature suggestions).
      if (req.method === "GET") {
        const m = path.match(/^\/api\/unknown-screens\/(\d+)$/);
        if (m) {
          const id = Number(m[1]);
          const all = await unknownScreensRepo.list(500);
          const row = all.find((r) => r.id === id);
          if (!row) return jsonResponse({ error: "not found" }, 404);
          return jsonResponse(row);
        }
      }

      // --- Scan device (auto-populate accounts) ---
      // Fire-and-forget variant: returns a run_id the UI polls for live logs.
      if (path === "/api/scan-device" && req.method === "POST") {
        const body = await readBody(req);
        const deviceId = body.device_id as string;
        if (!deviceId) return jsonResponse({ error: "device_id required" }, 400);
        const runId = `scan-${deviceId}-${Date.now()}`;
        runs.set(runId, { logs: [], done: false });
        await batchRunsRepo.create({ run_id: runId, automation: "scan", device_ids: [deviceId] });
        const scanLog: Parameters<typeof scanDevice>[2] = (level, msg) => {
          const entry = { ts: Date.now(), level, msg };
          runs.get(runId)?.logs.push(entry);
          batchRunLogsRepo.append(runId, level, msg).catch(() => {});
          console.log(`[${runId}] ${level.toUpperCase()}: ${msg}`);
        };
        scanLog("info", `Starting account scan on ${deviceId}...`);
        scanLog("info", "Device must be POWERED ON first — turn it on from Devices tab if not already online.");
        scanDevice(client, deviceId, scanLog)
          .then((results) => {
            const found = results.filter((r) => r.status === "found").length;
            scanLog("ok", `Scan complete — ${found}/${results.length} accounts detected + upserted to DB`);
          })
          .catch((e) => scanLog("error", `Scan crashed: ${e instanceof Error ? e.message : e}`))
          .finally(() => {
            const r = runs.get(runId);
            if (r) r.done = true;
            batchRunsRepo.finish(runId, "completed").catch(() => {});
          });
        return jsonResponse({ run_id: runId });
      }

      // --- Batch run (select N devices, power on, scan, run, power off) ---
      if (path === "/api/batch-run" && req.method === "POST") {
        const body = await readBody(req);
        const deviceIds = (body.device_ids ?? []) as string[];
        const scanAccounts = body.scan_accounts !== false;
        const concurrency = body.concurrency ? Number(body.concurrency) : undefined;
        const startJitterSec = body.start_jitter_sec !== undefined ? Number(body.start_jitter_sec) : undefined;
        const maxMinutesPerDevice = body.max_minutes !== undefined ? Number(body.max_minutes) : undefined;
        const automation = (body.automation as "warmup" | "follow" | "post" | undefined) ?? "warmup";
        if (!deviceIds.length) return jsonResponse({ error: "device_ids required" }, 400);
        const runId = `batch-${Date.now()}`;
        runs.set(runId, { logs: [], done: false });
        await batchRunsRepo.create({ run_id: runId, automation, device_ids: deviceIds });
        const log: LogFn = (level, msg) => {
          runs.get(runId)?.logs.push({ ts: Date.now(), level, msg });
          batchRunLogsRepo.append(runId, level, msg).catch(() => {});
          console.log(`[${runId}] ${level.toUpperCase()}: ${msg}`);
        };
        // Figure out which of the selected devices are local ADB — those
        // skip powerOn/Off and talk to adb directly.
        const localSerials = new Set((await listLocalDevices()).map((d) => d.id));
        const localIds = new Set(deviceIds.filter((id) => localSerials.has(id)));

        batchRun(client, {
          deviceIds,
          scanAccounts,
          log,
          concurrency,
          startJitterSec,
          maxMinutesPerDevice,
          automation,
          localIds,
        })
          .catch((e) => log("error", e instanceof Error ? e.message : String(e)))
          .finally(() => {
            const r = runs.get(runId);
            if (r) r.done = true;
            batchRunsRepo.finish(runId, "completed").catch(() => {});
          });
        return jsonResponse({ run_id: runId });
      }

      // --- Phase warmup run — per-device, per-platform, per-phase ---
      // POST /api/phase-run
      // Body: {
      //   device_ids: string[],
      //   platform: "instagram" | "tiktok",
      //   phase: 1 | 2 | 3 | 4,
      //   phase_config?: {
      //     niche_hashtags?: string[],
      //     comment_texts?: string[],
      //     follow_targets?: string[],
      //     max_likes?: number,
      //   },
      //   max_minutes?: number,
      // }
      if (path === "/api/phase-run" && req.method === "POST") {
        const body = await readBody(req);
        const deviceIds = (body.device_ids ?? []) as string[];
        const platform = body.platform as "instagram" | "tiktok";
        const phase = Number(body.phase) as 1 | 2 | 3 | 4;
        const maxMinutes = body.max_minutes ? Number(body.max_minutes) : 20;
        const rawCfg = (body.phase_config ?? {}) as Record<string, unknown>;

        if (!deviceIds.length) return jsonResponse({ error: "device_ids required" }, 400);
        if (!["instagram", "tiktok"].includes(platform)) {
          return jsonResponse({ error: "platform must be instagram or tiktok" }, 400);
        }
        if (![1, 2, 3, 4].includes(phase)) {
          return jsonResponse({ error: "phase must be 1, 2, 3, or 4" }, 400);
        }

        const runId = `phase-${platform}-${phase}-${Date.now()}`;
        runs.set(runId, { logs: [], done: false });
        await batchRunsRepo.create({ run_id: runId, automation: `phase-${phase}`, device_ids: deviceIds });

        const log: LogFn = (level, msg) => {
          runs.get(runId)?.logs.push({ ts: Date.now(), level, msg });
          batchRunLogsRepo.append(runId, level, msg).catch(() => {});
          console.log(`[${runId}] ${level.toUpperCase()}: ${msg}`);
        };

        const phaseConfig = {
          nicheHashtags: (rawCfg.niche_hashtags as string[] | undefined) ?? [],
          commentTexts: (rawCfg.comment_texts as string[] | undefined) ?? [],
          followTargets: (rawCfg.follow_targets as string[] | undefined) ?? [],
          maxLikesOverride: rawCfg.max_likes != null ? Number(rawCfg.max_likes) : undefined,
        };

        const localSerials = new Set((await listLocalDevices()).map((d) => d.id));

        (async () => {
          log("info", `Phase ${phase} ${platform} run on ${deviceIds.length} device(s)`);
          try {
            const quota = await quotasRepo.get(platform === "instagram" ? "instagram" : "tiktok");
            const deadline = Date.now() + maxMinutes * 60_000;

            await Promise.all(
              deviceIds.map(async (deviceId) => {
                const isLocal = localSerials.has(deviceId);
                if (!isLocal) {
                  try { await client.powerOn([deviceId]); } catch {}
                  // Wait up to 3 min for device to come online.
                  const onlineDeadline = Date.now() + 3 * 60_000;
                  while (Date.now() < onlineDeadline) {
                    try {
                      const st = await client.status([deviceId]);
                      if (st.list?.[0]?.status === 1) break;
                    } catch {}
                    await new Promise((r) => setTimeout(r, 6000));
                  }
                }

                const driver = new PhaseDriver(client, deviceId, log, isLocal ? "local" : "cloud");
                const watchdog = new Watchdog(driver, 15000, log);
                const stats = newStats(platform);
                const ctx = { driver, quota, log, stats, deadline, watchdog };
                const watchdogLoop = watchdog.start().catch(() => {});

                try {
                  if (platform === "instagram") {
                    await runInstagramPhase(phase as WarmupPhase, ctx, phaseConfig as WarmupPhaseConfig);
                  } else {
                    await runTiktokPhase(phase as TikTokWarmupPhase, ctx, phaseConfig as TikTokWarmupPhaseConfig);
                  }
                  log("ok", `[${deviceId}] phase ${phase} ${platform} complete — likes=${stats.likes_given}`);
                } catch (e) {
                  log("error", `[${deviceId}] ${e instanceof Error ? e.message : String(e)}`);
                } finally {
                  watchdog.stop();
                  await watchdogLoop;
                }

                if (!isLocal) {
                  try { await client.powerOff([deviceId]); } catch {}
                }
              }),
            );
          } catch (e) {
            log("error", e instanceof Error ? e.message : String(e));
          } finally {
            const r = runs.get(runId);
            if (r) r.done = true;
            await batchRunsRepo.finish(runId, "completed");
            log("ok", "Phase run complete.");
          }
        })().catch(() => {});

        return jsonResponse({ run_id: runId });
      }

      // --- Quotas ---
      if (path === "/api/quotas" && req.method === "GET") {
        return jsonResponse(await quotasRepo.all());
      }
      if (path.startsWith("/api/quotas/") && req.method === "PATCH") {
        const platform = path.split("/")[3] as "instagram" | "threads" | "tiktok";
        const body = await readBody(req);
        await quotasRepo.update(platform, body as Parameters<typeof quotasRepo.update>[1]);
        return jsonResponse(await quotasRepo.get(platform));
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      return errResponse(err);
    }
  },
});

console.log(`Duoplus dashboard running at http://localhost:${server.port}`);
