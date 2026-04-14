# Duoplus Dashboard

Local web UI that talks to the Duoplus OpenAPI to list cloud phones, power
them on/off, and orchestrate warmup runs (power on → run imported workflow →
power off).

## Setup

```bash
cd dashboard
cp .env.example .env
# edit .env and paste your API key into DUOPLUS_API_KEY
bun install
bun run dev
```

Open http://localhost:3030

## Enabling the API key

If every request fails with **`code: 160002`** (permission denied), API access
is disabled on your key. Fix:

1. Log into the Duoplus console.
2. Go to **Team Management → API** (or equivalent).
3. Enable API access on the key, or scope it to the operations the dashboard
   uses:
   - `/cloudphone/list`, `/cloudphone/status`, `/cloudphone/details`
   - `/cloudphone/batch-power-on`, `/cloudphone/batch-power-off`
   - `/cloudphone/batch-restart`
   - `/cloudphone/adb-whitelist`, `/cloudphone/batch-enable-adb`
   - `/automation/custom-templates`, `/automation/loop-task-create`,
     `/automation/loop-task-list`

The error message from the UI will include the Duoplus `code` — anything
that's not `200` is an API-side error. `160002` specifically = API disabled
on your team/key.

## Endpoints the UI exposes

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Serves the HTML frontend |
| GET | `/api/devices` | Proxies `/cloudphone/list` |
| POST | `/api/status` | Proxies `/cloudphone/status`; body `{ids: []}` |
| POST | `/api/power-on` | Proxies `/cloudphone/batch-power-on` |
| POST | `/api/power-off` | Proxies `/cloudphone/batch-power-off` |
| POST | `/api/restart` | Proxies `/cloudphone/batch-restart` |
| POST | `/api/run-warmup` | Starts an orchestrated run; body `{device_id, template_name?, template_id?}` |
| GET | `/api/run/:id/logs` | Poll progress of a running orchestration |
| GET | `/api/templates` | List the imported custom templates |

## Orchestrator flow

When you click **Run Warmup** on a device, the server:

1. `batch-power-on` for that device ID
2. Polls `/cloudphone/status` every 5s until status includes `online` / `running` / `active` (max 3 min)
3. If a template name is configured, resolves it to an ID via `/automation/custom-templates`
4. `/automation/loop-task-create` → returns task ID
5. Polls `/automation/loop-task-list` every 15s until the task status is `finished` / `completed` / `done` / `stopped`, or 20 min cap
6. `batch-power-off`

If any step errors mid-flight, the orchestrator still attempts a safety
power-off so the device doesn't sit on indefinitely.

## Security

- `.env` is **not** committed — keep the key out of git.
- Never paste the key into shared chats (rotate it if you do).
- The dashboard has no auth — bind to `localhost` only. If you expose it
  remotely, put it behind a reverse proxy with auth (Caddy basic auth,
  Tailscale, etc.).
- Duoplus caps each endpoint to **1 QPS**. The UI respects this by debouncing
  clicks; if you trigger a bulk action on many devices, the server serializes
  them one second apart.

## Live Streams (ws-scrcpy)

The dashboard has a **Live Streams** tab that shows real H.264 video of every
device — like Duoplus's Synchronizer view, but in your browser.

**ws-scrcpy is not bundled** (the npm package was unpublished in 2023). You
run it as a separate sidecar service. Each tile is **off by default**;
starting one mounts an iframe, and stopping it unloads the WebSocket +
decoder so memory frees immediately. A running tile costs ~50–100 MB of
browser memory.

### Prerequisites

- `adb` on the host's PATH (or set `ADB_BIN` env var).
- The dashboard's outbound public IP — needed to whitelist for cloud devices.
  Auto-detected via `api.ipify.org`; pin manually with `WHITELIST_IP=` if you're
  behind a fixed NAT/VPN.
- The Duoplus API key needs scopes for `/cloudphone/batch-enable-adb` and
  `/cloudphone/adb-whitelist`.

### Setup

```bash
# 1. Clone + run ws-scrcpy somewhere alongside the dashboard
git clone https://github.com/NetrisTV/ws-scrcpy.git
cd ws-scrcpy && npm install && npm start    # listens on :8000 by default

# 2. In the dashboard's .env, point at it and turn streams on
STREAMS_ENABLED=true
WS_SCRCPY_URL=http://localhost:8000

# 3. Restart the dashboard
bun run dev
```

Open the dashboard, go to **Live Streams**, click **Start** on any device.

### What happens on Start

| Source | Steps |
|---|---|
| **Local** (USB / wifi-debug) | Just confirms the device is in `adb devices`; mounts the iframe pointing at ws-scrcpy. |
| **Cloud** (Duoplus) | Calls `batchEnableAdb` → fetches the device's TCP-ADB endpoint (`host:port`) → whitelists your public IP → runs `adb connect host:port` locally → mounts the iframe. Idempotent — re-clicking Start on an already-streaming device is a no-op. |

Failures (Duoplus rejected the enable, IP not whitelisted, adb daemon down,
ws-scrcpy unreachable) surface in an alert with the underlying error and as
an `event_logs` row with `code` like `stream.enable-failed`,
`stream.no-public-ip`, etc. Query `/api/events?code=stream.*` to triage.

### Memory

Each active tile holds an H.264 decoder in the browser. The "Stop all" button
in the toolbar tears down every active tile in one shot. Closing the browser
tab also frees everything — the dashboard server itself doesn't hold any
stream resources.

## Next steps

- Wire an **IP-whitelist** form (calls `/cloudphone/adb-whitelist`) so you
  can update whitelists for the fleet in bulk when your residential IP
  rotates.
- Add a **Schedule Warmup** button that creates a `scheduled-task` via
  `/automation/scheduled-task-create` for a recurring nightly run.
- Fleet-wide template management: sync the generated workflow JSON into
  Duoplus as a custom template via their import endpoint (docs don't
  publish this — may need manual import via Duoplus web console).
