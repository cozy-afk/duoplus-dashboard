# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Duoplus Dashboard — Bun/TypeScript HTTP server + static HTML frontend that drives cloud phones via the Duoplus OpenAPI, runs local ADB-backed automation against social apps (Instagram, Threads, TikTok), and optionally ships as a Tauri desktop app. Data persists to Turso (libSQL) in cloud or a local SQLite file.

## Commands

Runtime is **Bun**, not Node. Do not use npm/yarn scripts.

```bash
bun install                  # install deps (also run by `bun run setup`)
bun run dev                  # watch-mode server on PORT (default 3030)
bun run start                # one-shot server
bun run build:server         # compile server.ts → src-tauri/binaries/server-bin
bun run tauri:dev            # build server binary + run Tauri shell
bun run tauri:build          # production Tauri bundle
```

There is **no test runner configured** and **no lint/format script**. If tests are requested, set up `bun test` before writing them — don't assume a harness exists.

Required env (see `.env.example`): `DUOPLUS_API_KEY`, `ANTHROPIC_API_KEY`, and either `TURSO_DATABASE_URL`+`TURSO_AUTH_TOKEN` or a local `DB_PATH`. The server exits on startup if `DUOPLUS_API_KEY` is missing. Set `DASHBOARD_USER`+`DASHBOARD_PASSWORD` to turn on Basic Auth (required for any non-localhost deploy).

## Architecture

Three distinct layers sit inside one Bun process. Understand which layer you're in before editing:

### 1. Duoplus cloud-phone control (`duoplus.ts`, `runner.ts`, `server.ts`)
`DuoplusClient` wraps the Duoplus OpenAPI (1 QPS per endpoint — the client and UI both serialize). `runner.ts` owns the orchestrated "power on → run template → power off" flow with safety power-off on error. `server.ts` is the sole HTTP entrypoint and exposes `/api/*` routes that proxy to Duoplus plus routes that drive the local automation stack. All state for batch runs/logs/accounts flows through `db.ts` (libSQL/SQLite repos: `accountsRepo`, `quotasRepo`, `sessionsRepo`, `growthRepo`, etc.).

### 2. Local ADB device automation (`device-driver.ts`, `local-adb.ts`, `watchdog.ts`, `human.ts`, `safety.ts`)
`DeviceDriver` is the shared abstraction every platform runner builds on — it owns tap/swipe/input, screenshots, and a `Watchdog` that detects stalls without flapping during legitimate reads (see `trust-if-unknown tap verification` in recent commits). `human.ts` provides `Ctx`, `SessionStats`, and human-ish pacing primitives. `safety.ts` defines `AccountFlaggedError`. `bottom-nav.ts` and `feed-patterns.ts` are cross-platform UI heuristics.

### 3. Platform runners (`platform/{instagram,threads,tiktok}/`)
Each platform is a self-contained module with a stable public API exported through `index.ts`. **The top-level `automation.ts` is a thin dispatcher** — it imports each platform's `index.ts` and re-exports the public session API. When adding platform behavior, put it inside the platform's own subdirectory (e.g. `platform/instagram/tools/like.ts`) and re-export from its `index.ts`; do not add logic to `automation.ts`.

Instagram and TikTok use a **phased warmup** model (`warmup-phases.ts` + `runInstagramPhase` / `runTiktokPhase`) — phases are configured via `WarmupPhaseConfig` / `TikTokWarmupPhaseConfig` and orchestrated from `server.ts`.

### Vision/self-healing (`vision.ts`, `screen-analyzer.ts`, `account-scanner.ts`)
Anthropic API is used for screenshot analysis and failure capture (`captureFailure`, `analyzeScreenshot`). The Live View tab (index.html + server routes) exposes live screenshots and on-demand Claude analysis. `account-scanner.ts` introspects logged-in accounts on a device.

### Desktop packaging (`src-tauri/`)
`build:server` compiles the Bun server into a single binary that Tauri ships as a sidecar. The frontend (`index.html`) is served either by the Bun server directly (dev / cloud) or bundled into Tauri. Nothing under `src-tauri/` needs changes for normal feature work.

## Conventions specific to this repo

- **File size**: root modules are deliberately long (`server.ts` ~700, `db.ts` ~800, `runner.ts` ~630, `device-driver.ts` ~620). Do not split them reflexively — they are cohesive single-responsibility modules. Platform code is where new files belong.
- **No mutation of shared state**; immutable updates only (see `human.ts`, `newStats`).
- **Duoplus rate limit is hard (1 QPS/endpoint)** — any new proxy route must go through `DuoplusClient`, not direct fetch.
- **Watchdog behavior matters**: avoid changes that make `Watchdog` flap on legit reads. Prefer `trust-if-unknown` semantics like the existing tap verification.
- **All imports use explicit `.ts` extensions** (Bun resolver). Keep that style.
- **ADB device interactions** go through `DeviceDriver`; don't shell out to `adb` from platform code.
