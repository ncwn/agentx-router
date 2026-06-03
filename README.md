# agentx-cc-router

> A tiny, zero-dependency local router that lets one Claude Code install switch between **9 model/effort "modes"** — native Claude, GPT-mapped, or hybrid — on the fly, with no client restart.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-built--ins%20only-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)](#service-install-optional)
[![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen.svg)](#how-it-works)

Stock Claude Code uses a single `ANTHROPIC_BASE_URL` + one key per session — there is no
per-model endpoint override, so the main loop, subagents, workflow agents, and the advisor
all inherit one endpoint. To send some roles to a native-Claude group and others to a
GPT-mapped group, you need a router in front. **This is that router.** It points Claude Code
at one fixed local port and picks the real upstream per request, based on a hot-swappable mode.

## Table of Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [The 9 modes](#the-9-modes)
- [Upstream topology](#upstream-topology)
- [Daily use](#daily-use)
- [Service install (optional)](#service-install-optional)
- [Context window (gpt-5.5 = 200K)](#context-window-gpt-55--200k)
- [Reference](#reference) — effort, gotchas, verification status
- [Repository layout](#repository-layout)
- [License](#license)

## How it works

```
                       ┌─────────────────────────────────────────────┐
Claude Code  ─────────▶│  router.js  (ONE fixed port, 8787)          │
ANTHROPIC_BASE_URL     │  active mode ← `active-mode` state file      │
= 127.0.0.1:8787       │  reads body.model → tier → mode route        │
(set ONCE, never edit) └────────┬──────────────┬──────────────┬──────┘
                          opus   │       sonnet │   background  │
                                 ▼              ▼               ▼
                           native / gpt55 / gpt54  (per the active mode's table)
                           = swap Bearer key, forward request BYTE-FOR-BYTE

   ./agentx-mode BB   ──writes──▶  active-mode  ──hot-swap, next request──▶ router
```

- **One fixed port; the mode lives in the proxy.** `ANTHROPIC_BASE_URL` is set once to
  `http://127.0.0.1:8787` and never changes. The active mode is read from the `active-mode`
  file **on every request**, so `./agentx-mode <MODE>` re-routes a running session
  **instantly — no client edit, no restart.**
- **Verbatim forwarding.** The router reads `model` read-only, then forwards the original
  bytes. The Claude Code fingerprint (the `system[]` blocks, `metadata.user_id`) and headers
  (`User-Agent: claude-cli`, `x-app`, `anthropic-beta`, `anthropic-version`) reach the
  upstream exactly as the real `claude` CLI sent them. The **only** per-request mutation is
  the `Host` header and the `Authorization` Bearer key.
- **Both legs speak `/v1/messages`.** No format translation — the upstream's OpenAI-mapped
  group maps the Claude model name → its GPT internally.
- **Why a mode selector.** The same model name routes differently per mode (`claude-sonnet`
  is native in NB but gpt-5.5 in HP), so the mode can't be inferred from the model alone. You
  set the mode proxy-side; inside Claude Code you just use `/model` and `/effort`.

## Quick start

**Prerequisites:** Node.js (built-ins only — no `npm install`), a Sub2API-style upstream that
serves a native Anthropic group and/or claude→gpt mapped groups, and Claude Code.

```bash
git clone https://github.com/ncwn/agentx-router.git
cd agentx-router
cp .env.example .env          # fill in the upstream base URLs + keys
chmod +x agentx-up agentx-mode agentx-claude agentx-service smoke.sh
./agentx-up                   # start the router (leave it running)
```

Point Claude Code at the router **once** in `~/.claude/settings.json` and never edit it again:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "router-managed"
  }
}
```

> `router-managed` is a placeholder — the router replaces it with the real per-group key.
> Do **not** put a real key here, and do not set `ANTHROPIC_API_KEY`.

Then launch and switch modes:

```bash
./agentx-claude BPU     # launch Claude Code in a mode (sets routing + context cap)
./agentx-mode BB        # hot-swap routing of a running session
./agentx-mode           # show the current mode + ranked mode table
```

`.env` keeps host roots (no `/v1` suffix — the router appends the client's `/v1/messages`
path itself) and the keys. It is gitignored.

## The 9 modes

| Mode | Main (`/model`) | Effort | opus→ | sonnet→ | bg→ | Keys | Ultracode |
|------|-----------------|--------|-------|---------|-----|------|-----------|
| **NPU** | claude-opus-4-8   | xhigh | native | native    | native | A             | ✅ |
| **NP**  | claude-opus-4-8   | max   | native | native    | native | A             | ❌ |
| **NB**  | claude-sonnet-4-6 | high  | native | native    | native | A             | ❌ |
| **HP**  | claude-sonnet-4-6 | max   | native | **gpt55** | gpt54  | A + B55 + B54 | ❌ |
| **HB**  | claude-sonnet-4-6 | high  | native | **gpt54** | gpt54  | A + B54       | ❌ |
| **BPU** | claude-opus-4-8   | xhigh | gpt55  | gpt55     | gpt54  | B55 + B54     | ✅ |
| **BP**  | claude-opus-4-8   | high  | gpt55  | gpt55     | gpt54  | B55 + B54     | ❌ |
| **BB**  | claude-sonnet-4-6 | high  | gpt55  | gpt54     | gpt54  | B55 + B54     | ❌ |
| **BBU** | claude-opus-4-8   | xhigh | gpt55  | gpt54     | gpt54  | B55 + B54     | ✅ |

- **Ultracode runs only at xhigh.** `/effort ultracode` = xhigh + workflow orchestration, so
  the three ultracode modes (NPU/BPU/BBU) are always xhigh. The router warns at startup, and
  `agentx-mode --list` flags, any ultracode mode whose effort isn't xhigh.
- **The advisor is an Opus-tier role:** in HP/HB it routes to `native` (stays real Claude); in
  BPU/BP/BB/BBU it routes to `gpt55`.
- **Backup modes split by sonnet routing:** BP/BPU route sonnet → gpt-5.5 (opus *and* sonnet on
  5.5); BB/BBU keep sonnet → gpt-5.4. Background is gpt-5.4 in all four. Within each pair the
  difference is CC-side: BPU = BP + xhigh + ultracode; BBU is Opus-main + xhigh + ultracode
  while BB is Sonnet-main + high. So BP/BPU share a route table, as do BB/BBU.

## Upstream topology

Three upstreams, selected by env (see `.env.example`). Each GPT group does its own per-tier
mapping on the upstream dashboard:

| name     | upstream group                  | dashboard mapping                                  |
|----------|---------------------------------|----------------------------------------------------|
| `native` | Anthropic group (key A)         | real Claude passthrough (`claude-opus` / `claude-sonnet`) |
| `gpt55`  | **Performance** group (key B55) | opus → **gpt-5.5**, sonnet → **gpt-5.5**, haiku → gpt-5.4 |
| `gpt54`  | **Balance** group (key B54)     | opus / sonnet / haiku **all → gpt-5.4**            |

The router picks the group by (mode, tier) and never rewrites the model name — in practice it
only sends opus/sonnet to Performance (→5.5) and sonnet/haiku to Balance (→5.4), so each
group's mapping is unambiguous for what it actually receives.

## Daily use

Start the router once and leave it running (terminal tab, tmux pane, or backgrounded) — or
[install it as a service](#service-install-optional). Then:

```bash
./agentx-claude BPU     # or NPU / NP / NB / HP / HB / BP / BB / BBU
```

`agentx-claude` sets the routing **and** the correct context window for the mode (see
[Context window](#context-window-gpt-55--200k)), then starts `claude`. Plain `claude` also
works — it's already pointed at the router — but it won't apply the per-mode 200K cap the
gpt-5.5 modes need, so use `agentx-claude` for those.

Switch routing on the fly, from anywhere — applies on the next request, no restart:

```bash
./agentx-mode BB        # hot-swap
./agentx-mode           # current mode + ranked list
```

> ⚠️ **Routing hot-swaps; context does NOT.** `agentx-mode` instantly re-routes a running
> session, but the context window is fixed at launch. Hot-swapping is safe *within the same
> context tier* (e.g. NPU↔NP↔NB, all 1M); to move between a **1M** mode and a **200K** mode,
> **relaunch** with `agentx-claude <MODE>`.

Inside Claude Code, set the model + effort to match the mode (`agentx-claude` already exports
the model; the `--list` `effort` column is the recommended `/effort`). Connectivity check
(router must be running): `./smoke.sh BB` switches to BB, then probes the opus + sonnet tiers.

**Keep the Mac awake for long unattended runs.** A long agentic task holds one HTTP stream
open for minutes; if the Mac sleeps (display-off idle sleep counts), the socket dies and
Claude Code reports *"The socket connection was closed unexpectedly."* — the sleep cut the
wire, not the router. Wrap the session in `caffeinate`:

```bash
caffeinate -dimu claude          # or: caffeinate -dimu ./agentx-claude BPU
```

`-d` display, `-i` idle, `-m` disk, `-u` assert user activity (holds even with the display
off); the assertion releases when `claude` exits. On **battery**, macOS still ignores `-s`
(system sleep) — keep the Mac on AC power for fully unattended runs. (If you hit the same
error *without* sleeping, on a long quiet stream, it's the router's idle timeout — raise
`AGENTX_IDLE_TIMEOUT_MS`.)

## Service install (optional)

Run the router as a user-level service so it starts at login and survives crashes:

```bash
./agentx-service install      # install + enable launch-at-login + start
./agentx-service status       # service-manager state + real port check
./agentx-service restart
./agentx-service logs
./agentx-service update       # regenerate after a repo update or path move
./agentx-service uninstall    # remove the service (keeps .env, logs, repo files)
```

`agentx-service` generates a macOS LaunchAgent
(`~/Library/LaunchAgents/com.agentx.cc-router.plist`) or a Linux `systemd --user` unit
(`~/.config/systemd/user/agentx-cc-router.service`). Both inject a runtime `PATH` that
includes the resolved `node` directory, then run this repo's `agentx-up` by absolute path —
so run `./agentx-service update` after pulling updates or moving the repo. A service is
considered healthy only if the router is actually listening on `127.0.0.1:${AGENTX_PORT:-8787}`;
`install`, `start`, `restart`, `update`, and `status` all verify the real listener rather than
trusting the service manager alone.

<details>
<summary><strong>Bootstrap a fresh Git remote with <code>publish</code></strong></summary>

If the directory is not yet git-tracked, `./agentx-service publish` checks `gh auth status`,
requires an interactive terminal, shows the target owner/repo before confirmation, stages only
allowlisted project files (excluding `.env`, `active-mode`, logs, and secret-like files), and
creates/pushes the repository — resuming cleanly if a previous attempt half-initialized the
local repo. If `origin` already exists, it reports root/remotes/status without overwriting.
</details>

## Context window (gpt-5.5 = 200K)

gpt-5.5 tops out at ~256K context, but Claude Code assumes its Claude models have 1M (Opus
auto-upgrades to 1M on Max/Team/Enterprise plans). If CC packs >256K and the request maps to
gpt-5.5, the upstream **hard-errors** — CC won't compact early because it thinks it has ~950K
of runway. CC's context window is hardcoded per model name and can't be changed by the router,
so it must be capped at launch.

`agentx-claude` does this automatically for the **gpt-5.5-main** modes (the `ctx = 200K` rows
in `--list`: **HP / BPU / BP / BBU**). It exports `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (forces
the 200K window, no 1M beta) plus `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` and
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=85` (auto-compact ~170K, safely under 256K). Native and
gpt-5.4-main modes keep 1M.

> `DISABLE_1M_CONTEXT` is the reliable lever; if the `AUTO_COMPACT_*` vars aren't honored on
> your CC version, it alone still caps at 200K. Edge case: **BB**'s main is gpt-5.4 (1M) but
> its *advisor* maps to gpt-5.5 — the advisor gets a bounded subset so it rarely exceeds 256K;
> if you hit it, launch BB via `agentx-claude` with a manual cap.

## Reference

<details>
<summary><strong>Effort semantics (native vs mapped legs)</strong></summary>

- **Native legs:** effort is Claude-side. Set the main model's effort via
  `~/.claude/settings.json` `effortLevel` (or `/effort`), and let subagents carry their own
  frontmatter `effort`. **Do not set `CLAUDE_CODE_EFFORT_LEVEL`** — it's global and overrides
  every subagent's effort, collapsing per-role effort (this silently flattens NB/HP/HB/BB,
  which want different effort for main vs advisor).
- **Mapped (GPT) legs:** the effort set in CC is *intended* to flow through (as the thinking
  budget) for the upstream to map to the GPT's reasoning effort. **This is assumed, not yet
  verified.** It matters because BP/BB/BBU share one route table (BPU differs — sonnet→gpt-5.5),
  so the router can't tell those three apart; what separates them is CC-side (main model +
  effort). The open question is whether high vs xhigh actually changes GPT behavior on a mapped
  leg. **Verify once:** on a mapped model, run `/effort high` then `/effort xhigh` and confirm
  the GPT's reasoning behavior changes. Until then, treat the effort distinction on mapped legs
  as unconfirmed.
</details>

<details>
<summary><strong>Gotchas / things to verify</strong></summary>

1. **Hybrid advisor identity (HP/HB).** These modes keep the advisor native *only if it emits
   a `claude-opus-*` model name* (so it routes to `native`). The router logs every request's
   `model` + chosen upstream to stderr — run one hybrid session, trigger the advisor, and
   confirm `model="claude-opus-..." tier=opus -> native`. A sonnet name means the advisor
   inherited the main model and can't stay native in hybrid.
2. **Keep the model name claude-tier (never a gpt name) in CC.** Ultracode/workflows gate on
   Opus-as-main, and CC's feature-gating keys on the model-name string. In BPU the name stays
   `claude-opus-4-8` (ultracode enables) while the router maps it to gpt-5.5 underneath.
3. **Background/haiku routing.** Native modes (NPU/NP/NB) send background to `native` (real
   Claude Haiku) — fully native, key A only. Every other mode sends background to `gpt54`
   (Balance/gpt-5.4), so those need the Balance key and its dashboard must map `claude-haiku-*`
   → a gpt. To change where haiku goes, edit `background` in `modes.json`.
4. **Plaintext HTTP** to the upstream is fine only inside a trusted tunnel (e.g. Tailscale).
   Don't expose the upstream off-tailnet. The router itself binds `127.0.0.1` only.
5. **Timeouts vs. high reasoning effort.** Defaults are 60s connect / 5 min idle
   (`AGENTX_CONNECT_TIMEOUT_MS` / `AGENTX_IDLE_TIMEOUT_MS`). If the upstream withholds response
   headers until the first token, a hard max/xhigh task can blow the 60s connect window → a
   spurious 502. For high-effort modes, bump `AGENTX_CONNECT_TIMEOUT_MS`
   (e.g. `export AGENTX_CONNECT_TIMEOUT_MS=180000`) rather than discover it mid-task.
</details>

<details>
<summary><strong>Verification status</strong></summary>

| Verified (no external dependency) | Needs one live check |
|-----------------------------------|----------------------|
| Routing for all 9 modes (per-tier key swap) | Effort distinction on **mapped** legs — does high vs xhigh change GPT behavior? Plus HP/HB effort. Does the upstream honor Claude's thinking budget? |
| Body forwarded byte-for-byte (fingerprint intact) | HP/HB **advisor** routes native — confirm the advisor emits `claude-opus-*` via the router's stderr on one hybrid run |
| Hop-by-hop headers stripped both ways; SSE streamed | |
| Hung upstream → 502, process survives mid-stream reset | |
| Native modes (NPU/NP/NB) fully usable; tool-use fidelity on mapped legs confirmed from prior use | |
</details>

## Repository layout

| File | Responsibility |
|------|----------------|
| `router.js`      | The verbatim router (Node built-ins only; no `npm install`). |
| `modes.json`     | The 9 modes — route tables, recommended model/effort, notes. |
| `agentx-up`      | Loads `.env`, seeds `active-mode`, starts the router on the fixed port. |
| `agentx-mode`    | Hot-swap the active mode; no arg = show the ranked list. |
| `agentx-claude`  | Launch CC for a mode — sets routing + per-mode context cap + model, then `claude`. |
| `agentx-service` | Install/manage the router as a macOS/Linux user-level service. |
| `smoke.sh`       | Switch to a mode + connectivity probe for the opus + sonnet tiers. |
| `active-mode`    | Runtime state: the current mode name (gitignored; created on first run). |
| `.env.example`   | Upstream bases + keys to copy to `.env`. |

## License

[MIT](LICENSE) © ncwn
