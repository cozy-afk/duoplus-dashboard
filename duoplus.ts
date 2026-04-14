/**
 * Typed client for the Duoplus OpenAPI.
 * Docs: https://help.duoplus.net/docs/api-reference
 *
 * VERIFIED VIA LIVE PROBING:
 *   - Base URL: https://openapi.duoplus.net
 *   - Path prefix: /api/v1/
 *   - Casing: camelCase (cloudPhone, not cloudphone)
 *   - Auth header: DuoPlus-API-Key
 *   - Body field for device IDs: image_ids (array) or image_id (single)
 *     (per /api/v1/cloudPhone/command docs)
 *
 * The docs index publishes shorter paths like /cloudphone/list; those appear
 * deprecated and return 160002 regardless of key scope. Always use /api/v1/.
 */

const BASE = "https://openapi.duoplus.net";

export interface DuoplusResponse<T> {
  code: number;
  message: string;
  data: T;
}

/**
 * Device row as returned by /api/v1/cloudPhone/list.
 * status values (from live responses): 2 = offline/stopped; other numeric codes
 * presumably mean starting/running (not documented — inferred by observation).
 */
export interface Device {
  id: string;
  name: string;
  status: number;
  os: string;
  size?: string;
  created_at?: string;
  expired_at?: string;
  ip?: string;
  area?: string;
  remark?: string;
  adb?: string;
  adb_password?: string;
  group?: unknown[];
}

export interface Proxy {
  id: string;
  name?: string;
  host: string;
  port: string | number;
  user?: string;
  password?: string;
  area?: string;
}

export class DuoplusError extends Error {
  constructor(public code: number, message: string) {
    super(`[${code}] ${message}`);
  }
}

export class DuoplusClient {
  constructor(private apiKey: string) {
    if (!apiKey) throw new Error("DUOPLUS_API_KEY is not set");
  }

  private async call<T>(path: string, body: unknown = {}): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Lang: "en",
        "DuoPlus-API-Key": this.apiKey,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as DuoplusResponse<T>;
    if (json.code !== 200) throw new DuoplusError(json.code, json.message);
    return json.data;
  }

  // --- Read ops (verified working) ---

  listDevices(page = 1, pagesize = 50) {
    return this.call<{ list: Device[]; total?: number }>("/api/v1/cloudPhone/list", {
      page,
      pagesize,
    });
  }

  /** Status returns a list matching the image_ids passed in. */
  status(image_ids: string[]) {
    return this.call<{ list: Array<{ id: string; name: string; status: number }> }>(
      "/api/v1/cloudPhone/status",
      { image_ids },
    );
  }

  // --- Write ops (require write scope on your API key) ---

  details(image_id: string) {
    return this.call<Device>("/api/v1/cloudPhone/details", { image_id });
  }

  powerOn(image_ids: string[]) {
    return this.call<{ success: string[]; fail: string[]; fail_reason?: Record<string, string> }>(
      "/api/v1/cloudPhone/powerOn",
      { image_ids },
    );
  }

  powerOff(image_ids: string[]) {
    return this.call<{ success: string[]; fail: string[]; fail_reason?: Record<string, string> }>(
      "/api/v1/cloudPhone/powerOff",
      { image_ids },
    );
  }

  restart(image_ids: string[]) {
    return this.call<{ success: string[]; fail: string[]; fail_reason?: Record<string, string> }>(
      "/api/v1/cloudPhone/restart",
      { image_ids },
    );
  }

  setAdbWhitelist(image_id: string, whitelist_ips: string[]) {
    return this.call<unknown>("/api/v1/cloudPhone/adbWhiteList", {
      image_id,
      whitelist_ips,
    });
  }

  enableAdb(image_ids: string[]) {
    return this.call<unknown>("/api/v1/cloudPhone/batchEnableAdb", { image_ids });
  }

  // --- ADB command throttling + retry ---
  // Duoplus caps every interface at 1 QPS (returns HTTP 200 with code 512
  // "Please do not repeat the operation" on violation). We serialize all
  // adbCommand calls through an async queue with a minimum 1100ms gap, and
  // retry 512/160004 responses with backoff so callers never see them.
  private _adbLastCallAt = 0;
  private _adbQueue: Promise<unknown> = Promise.resolve();
  private readonly ADB_MIN_GAP_MS = 1100;

  adbCommand(
    image_ids: string[],
    command: string,
  ): Promise<Record<string, { success: boolean; content: string; message: string }>> {
    // Chain onto the queue so only one adbCommand fires at a time.
    const run = async (): Promise<
      Record<string, { success: boolean; content: string; message: string }>
    > => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const sinceLast = Date.now() - this._adbLastCallAt;
        const waitMs = Math.max(0, this.ADB_MIN_GAP_MS - sinceLast);
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        this._adbLastCallAt = Date.now();
        try {
          return await this.call<Record<string, { success: boolean; content: string; message: string }>>(
            "/api/v1/cloudPhone/command",
            { image_ids, command },
          );
        } catch (e) {
          const err = e as DuoplusError;
          // 512 = per-endpoint QPS; 160004 = global throttle.
          if (err.code === 512 || err.code === 160004) {
            const backoff = 1500 * Math.pow(2, attempt);
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          throw e;
        }
      }
      throw new Error("adbCommand exhausted 512/throttle retries");
    };
    const next = this._adbQueue.then(run, run);
    this._adbQueue = next.catch(() => {}); // don't let a rejected chain poison the next
    return next;
  }

  /** Dump UI hierarchy via uiautomator. Useful for follower-count scraping. */
  uiautomatorDump(image_id: string) {
    return this.call<{ xml: string }>(
      "/api/v1/cloudPhone/advanced/uiautomatorDump",
      { image_id },
    );
  }

  // --- Proxy management ---

  listProxies(page = 1, pagesize = 100) {
    return this.call<{ list: Proxy[]; total?: number }>("/api/v1/proxy/list", {
      page,
      pagesize,
    });
  }

  /** Add one or more proxies to the user's proxy pool. Duoplus tests each on add. */
  addProxies(
    proxy_list: Array<{
      host: string;
      port: number;
      user?: string;
      password?: string;
      protocol: "socks5" | "http";
      name?: string;
    }>,
  ) {
    return this.call<{
      success: unknown[];
      fail: Array<{ index: number; message: string }>;
    }>("/api/v1/proxy/add", { proxy_list });
  }

  deleteProxies(ids: string[]) {
    return this.call<unknown>("/api/v1/proxy/delete", { ids });
  }

  /** Modify an existing proxy (host/port/credentials). */
  updateProxy(
    id: string,
    patch: { host?: string; port?: number; user?: string; password?: string; name?: string },
  ) {
    return this.call<unknown>("/api/v1/proxy/update", { id, ...patch });
  }

  /**
   * Initialize / set the proxy on one or more cloud phones. Proxy may be
   * referenced by its Duoplus ID (from listProxies) OR supplied inline
   * with host/port/user/password.
   */
  initProxy(
    images: Array<{
      image_id: string;
      proxy: { id?: string; host?: string; port?: number; user?: string; password?: string };
      ip_scan_channel?: "ip2location" | "ipapi";
      name?: string;
    }>,
  ) {
    return this.call<{ message: string }>("/api/v1/cloudPhone/initProxy", {
      images: images.map((i) => ({ ip_scan_channel: "ip2location", ...i })),
    });
  }

  // Automation/template endpoints removed — all automation now runs locally
  // over ADB via /api/v1/cloudPhone/command. Duoplus's template system
  // required a scope this API key doesn't have and added no value since we
  // drive each step ourselves anyway.
}

/** Decode the numeric status field into a human label. Per Duoplus docs. */
export function statusLabel(n: number): string {
  return (
    {
      0: "not configured",
      1: "online",
      2: "offline",
      3: "expired",
      4: "renewal needed",
      10: "powering on",
      11: "configuring",
      12: "config failed",
    }[n] || `unknown(${n})`
  );
}

/** True when the device is fully online + ready for ADB. */
export function isOnline(n: number): boolean {
  return n === 1;
}
