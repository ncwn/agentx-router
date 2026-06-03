# agentx-cc-router

A local router that lets one Claude Code install switch between nine model/effort modes (native Claude, GPT-mapped, or hybrid) without restarting the client. Zero dependencies; Node built-ins only.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-built--ins%20only-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)](#service-install-optional)
[![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen.svg)](#how-it-works)

Claude Code uses a single `ANTHROPIC_BASE_URL` and one key per session. There is no per-model endpoint override, so the main loop, subagents, workflow agents, and the advisor all share one endpoint. Routing some roles to a native-Claude group and others to a GPT-mapped group therefore requires a proxy in front. This router fills that gap: Claude Code points at one fixed local port, and the router selects the real upstream per request according to a hot-swappable mode.

## Table of contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Routing modes](#routing-modes)
- [Upstream topology](#upstream-topology)
- [Daily use](#daily-use)
- [Service install (optional)](#service-install-optional)
- [Context window (gpt-5.5 = 200K)](#context-window-gpt-55--200k)
- [Reference](#reference)
- [Repository layout](#repository-layout)
- [License](#license)

## How it works

```
                       ┌─────────────────────────────────────────────┐
Claude Code  ─────────▶│  router.js  (ONE fixed port, 8787)          │
ANTHROPIC_BASE_URL     │  active mode ← `active-mode` state file     │
= 127.0.0.1:8787       │  reads body.model → tier → mode route       │
(set ONCE, never edit) └────────┬──────────────┬──────────────┬──────┘
                         opus   │       sonnet │   background  │
                                ▼              ▼               ▼
                           native / gpt55 / gpt54  (per the active mode's table)
                           = swap Bearer key, forward request BYTE-FOR-BYTE

   ./agentx-mode BAL  ──writes──▶  active-mode  ──hot-swap, next request──▶ router
```

- **One fixed port.** `ANTHROPIC_BASE_URL` is set once to `http://127.0.0.1:8787` and never changes. The router reads the active mode from the `active-mode` file on every request, so `./agentx-mode <MODE>` re-routes a running session on the next request. No client edit, no restart.
- **Verbatim forwarding.** The router reads `model` read-only and forwards the original bytes. The Claude Code fingerprint (the `system[]` blocks, `metadata.user_id`) and headers (`User-Agent: claude-cli`, `x-app`, `anthropic-beta`, `anthropic-version`) reach the upstream unchanged. The only per-request mutation is the `Host` header and the `Authorization` Bearer key.
- **Both legs speak `/v1/messages`.** There is no format translation. The upstream's OpenAI-mapped group maps the Claude model name to its GPT internally.
- **Why a mode selector.** The same model name routes differently per mode. `claude-sonnet` is native in `NATIVE` but maps to gpt-5.5 in `PERF`, so the mode cannot be inferred from the model alone. Set the mode proxy-side; inside Claude Code, use `/model` and `/effort` as usual.

## Quick start

Prerequisites: Node.js (built-ins only, no `npm install`), a Sub2API-style upstream that serves a native Anthropic group and/or claude→gpt mapped groups, and Claude Code.

```bash
git clone https://github.com/ncwn/agentx-router.git
cd agentx-router
cp .env.example .env          # fill in the upstream base URLs + keys
chmod +x agentx-up agentx-mode agentx-claude agentx-service smoke.sh
./agentx-up                   # start the router (leave it running)
```

Point Claude Code at the router once in `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "router-managed"
  }
}
```

`router-managed` is a placeholder; the router replaces it with the real per-group key. Do not put a real key here, and do not set `ANTHROPIC_API_KEY`.

Then launch and switch modes:

```bash
./agentx-claude PERF opus   # launch Claude Code in a mode (model sets the 200K cap)
./agentx-mode BAL           # hot-swap routing of a running session
./agentx-mode               # show the current mode + the mode table
```

Host roots in `.env` take no `/v1` suffix; the router appends the client's `/v1/messages` path itself. `.env` is gitignored.

## Routing modes

A mode is a routing table: it maps each request tier (opus, sonnet, background) to an upstream group. Modes live in `modes.json` and are meant to be edited; the five below are examples covering the common combinations. The router reads `routes` and `default` only.

| Mode       | opus→  | sonnet→ | background→ | Keys          | Description |
|------------|--------|---------|-------------|---------------|-------------|
| `NATIVE`   | native | native  | native      | A             | All native Claude. |
| `HYBRID-P` | native | gpt-5.5 | gpt-5.4     | A + B55 + B54 | Native opus, Performance sonnet. |
| `HYBRID-B` | native | gpt-5.4 | gpt-5.4     | A + B54       | Native opus, Balance sonnet. |
| `PERF`     | gpt-5.5| gpt-5.5 | gpt-5.4     | B55 + B54     | All-mapped performance. |
| `BAL`      | gpt-5.5| gpt-5.4 | gpt-5.4     | B55 + B54     | Mapped balance. |

The opus tier carries the advisor and Opus-tier workflow members; the sonnet tier carries Sonnet members. So in `HYBRID-P` and `HYBRID-B` the advisor stays native (real Claude), while in `PERF` and `BAL` it maps to gpt-5.5. To add or change a mode, edit `modes.json` and pick any upstream (`native`, `gpt55`, `gpt54`) per tier.

### Model and effort are yours to set

The mode controls routing only. You choose the main model and reasoning effort inside Claude Code:

- `/model claude-opus-4-8` or `/model claude-sonnet-4-6` — the router maps whichever you pick through the active mode's table.
- `/effort high` (or `max`, `xhigh`) — reasoning effort.
- `/effort ultracode` — xhigh plus workflow orchestration. It is a keyword available in any Opus-main session, independent of routing; there is no separate "ultracode mode."

Keep the model name claude-tier (never a gpt name) in Claude Code: ultracode and workflows gate on Opus-as-main, and Claude Code's feature gating keys on the model-name string. The router maps the claude name to a GPT underneath without changing it.

## Upstream topology

Three upstreams are selected by env (see `.env.example`). Each GPT group does its own per-tier mapping on the upstream dashboard:

| name     | upstream group              | dashboard mapping                                  |
|----------|-----------------------------|----------------------------------------------------|
| `native` | Anthropic group (key A)     | real Claude passthrough (`claude-opus` / `claude-sonnet`) |
| `gpt55`  | Performance group (key B55) | opus → gpt-5.5, sonnet → gpt-5.5, haiku → gpt-5.4  |
| `gpt54`  | Balance group (key B54)     | opus / sonnet / haiku all → gpt-5.4                |

The router selects the group by (mode, tier) and never rewrites the model name. In practice it sends only opus/sonnet to Performance (→5.5) and sonnet/haiku to Balance (→5.4), so each group's mapping is unambiguous for what it receives.

## Daily use

Start the router once and leave it running in a terminal tab, tmux pane, or the background, or [install it as a service](#service-install-optional). Then:

```bash
./agentx-claude PERF opus   # MODE then the main model
```

`agentx-claude` sets the routing and the context window, then starts `claude`. It takes the main model as a second argument and caps the context to 200K when that model's tier maps to gpt-5.5 (see [Context window](#context-window-gpt-55--200k)); otherwise it keeps 1M. The model is required for modes that route any tier to gpt-5.5 (`HYBRID-P`, `PERF`, `BAL`) and optional for `NATIVE` and `HYBRID-B`. Plain `claude` also works, since it already points at the router, but it does not apply the 200K cap.

Switch routing on the fly. The change applies on the next request, with no restart:

```bash
./agentx-mode BAL       # hot-swap
./agentx-mode           # current mode + table
```

> **Routing hot-swaps; context does not.** `agentx-mode` re-routes a running session, but the context window is fixed at launch. Hot-swapping is safe as long as the main model's tier keeps the same window (both 1M, or both 200K). To cross between a 1M run and a 200K run, relaunch with `agentx-claude <MODE> <model>`.

To check connectivity while the router runs, `./smoke.sh PERF` switches to PERF and probes the opus and sonnet tiers.

### Keep the Mac awake for long unattended runs

A long agentic task holds one HTTP stream open for minutes. If the Mac sleeps (display-off idle sleep counts), the socket closes and Claude Code reports `The socket connection was closed unexpectedly`. The sleep cut the connection, not the router. Wrap the session in `caffeinate`:

```bash
caffeinate -dimu claude          # or: caffeinate -dimu ./agentx-claude PERF opus
```

The flags prevent display (`-d`), idle (`-i`), and disk (`-m`) sleep and assert user activity (`-u`), which holds even with the display off. The assertion releases when `claude` exits. On battery, macOS ignores `-s` (system sleep), so keep the Mac on AC power for fully unattended runs. If the same error appears without sleeping, on a long quiet stream, it is the router's idle timeout; raise `AGENTX_IDLE_TIMEOUT_MS`.

## Service install (optional)

Run the router as a user-level service so it starts at login and survives crashes:

```bash
./agentx-service install      # install, enable launch-at-login, start
./agentx-service status       # service-manager state + real port check
./agentx-service restart
./agentx-service logs
./agentx-service update       # regenerate after a repo update or path move
./agentx-service uninstall    # remove the service (keeps .env, logs, repo files)
```

`agentx-service` generates a macOS LaunchAgent at `~/Library/LaunchAgents/com.agentx.cc-router.plist` or a Linux `systemd --user` unit at `~/.config/systemd/user/agentx-cc-router.service`. Both inject a runtime `PATH` that includes the resolved `node` directory, then run this repo's `agentx-up` by absolute path. Run `./agentx-service update` after pulling updates or moving the repo. A service counts as healthy only when the router is listening on `127.0.0.1:${AGENTX_PORT:-8787}`; `install`, `start`, `restart`, `update`, and `status` verify the real listener rather than trusting the service manager.

<details>
<summary><strong>Bootstrap a fresh Git remote with <code>publish</code></strong></summary>

When the directory is not yet git-tracked, `./agentx-service publish` checks `gh auth status`, requires an interactive terminal, and shows the target owner/repo before confirmation. It stages only allowlisted project files (excluding `.env`, `active-mode`, logs, and secret-like files), then creates and pushes the repository, resuming cleanly if a previous attempt half-initialized the local repo. When `origin` already exists, it reports root, remotes, and status without overwriting.
</details>

## Context window (gpt-5.5 = 200K)

gpt-5.5 tops out near 256K context, but Claude Code assumes its Claude models have 1M (Opus auto-upgrades to 1M on Max, Team, and Enterprise plans). When Claude Code packs more than 256K and the request maps to gpt-5.5, the upstream returns a hard error, because Claude Code does not compact early; it thinks it has roughly 950K of runway. The context window is hardcoded per model name and the router cannot change it, so it must be capped at launch.

`agentx-claude` caps it automatically. It looks at the main model you pass and the active mode's route table: if that model's tier maps to gpt-5.5, it exports `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` to force the 200K window with no 1M beta, plus `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=85` to auto-compact near 170K, safely under 256K. Otherwise it keeps 1M. For example `agentx-claude PERF opus` caps (opus maps to gpt-5.5), while `agentx-claude HYBRID-P opus` does not (opus is native there).

> `DISABLE_1M_CONTEXT` is the reliable lever; if the `AUTO_COMPACT_*` vars are not honored on your Claude Code version, it alone still caps at 200K. Watch the advisor in hybrid and balance modes: it is an opus-tier role, so in `BAL` it maps to gpt-5.5 even when your main model is native or gpt-5.4. It receives a bounded subset and rarely exceeds 256K.

## Reference

<details>
<summary><strong>Effort semantics (native vs mapped legs)</strong></summary>

- **Native legs.** Effort is set on the Claude side. Set the main model's effort via `effortLevel` in `~/.claude/settings.json` (or `/effort`), and let subagents carry their own frontmatter `effort`. Do not set `CLAUDE_CODE_EFFORT_LEVEL`: it is global and overrides every subagent's effort, which flattens per-role effort (for example a Sonnet main at high with an Opus advisor at xhigh).
- **Mapped (GPT) legs.** The effort set in Claude Code is intended to flow through as the thinking budget for the upstream to map to the GPT's reasoning effort. This is assumed, not yet verified. The open question is whether high versus xhigh actually changes GPT behavior on a mapped leg. To verify, run `/effort high` then `/effort xhigh` on a mapped model and confirm the reasoning behavior changes. Until then, treat the effort distinction on mapped legs as unconfirmed.
</details>

<details>
<summary><strong>Gotchas and things to verify</strong></summary>

1. **Hybrid advisor identity (HYBRID-P, HYBRID-B).** These modes keep the advisor native only when it emits a `claude-opus-*` model name, which routes to `native`. The router logs each request's `model` and chosen upstream to stderr. Run one hybrid session, trigger the advisor, and confirm `model="claude-opus-..." tier=opus -> native`. A sonnet name means the advisor inherited the main model and cannot stay native in hybrid.
2. **Keep the model name claude-tier (never a gpt name) in Claude Code.** Ultracode and workflows gate on Opus-as-main, and Claude Code's feature gating keys on the model-name string. The name stays `claude-opus-4-8` (so ultracode enables) while the router maps it to a GPT underneath.
3. **Background and haiku routing.** `NATIVE` sends background to `native` (real Claude Haiku) and needs only key A. The other modes send background to `gpt54` (Balance, gpt-5.4), so those need the Balance key, and its dashboard must map `claude-haiku-*` to a gpt. To change where haiku goes, edit `background` in `modes.json`.
4. **Plaintext HTTP** to the upstream is acceptable only inside a trusted tunnel such as Tailscale. Do not expose the upstream off-tailnet. The router itself binds `127.0.0.1` only.
5. **Timeouts versus high reasoning effort.** Defaults are 60s connect and 5 min idle (`AGENTX_CONNECT_TIMEOUT_MS`, `AGENTX_IDLE_TIMEOUT_MS`). If the upstream withholds response headers until the first token, a hard max or xhigh task can exceed the 60s connect window and return a spurious 502. For high-effort modes, raise `AGENTX_CONNECT_TIMEOUT_MS` (for example `export AGENTX_CONNECT_TIMEOUT_MS=180000`) before starting.
</details>

<details>
<summary><strong>Verification status</strong></summary>

| Verified (no external dependency) | Needs one live check |
|-----------------------------------|----------------------|
| Routing for all five modes (per-tier key swap) | Effort distinction on mapped legs: does high versus xhigh change GPT behavior? Does the upstream honor Claude's thinking budget? |
| Body forwarded byte-for-byte (fingerprint intact) | Hybrid advisor routes native: confirm the advisor emits `claude-opus-*` via the router's stderr on one hybrid run |
| Hop-by-hop headers stripped both ways; SSE streamed | |
| Hung upstream returns 502; process survives a mid-stream reset | |
| `NATIVE` fully usable; tool-use fidelity on mapped legs confirmed from prior use | |
</details>

## Repository layout

| File | Responsibility |
|------|----------------|
| `router.js`      | The verbatim router. Node built-ins only; no `npm install`. |
| `modes.json`     | The nine modes: route tables, recommended model/effort, notes. |
| `agentx-up`      | Loads `.env`, seeds `active-mode`, starts the router on the fixed port. |
| `agentx-mode`    | Hot-swaps the active mode; no argument shows the ranked list. |
| `agentx-claude`  | Launches Claude Code for a mode: sets routing, the per-mode context cap, and the model, then runs `claude`. |
| `agentx-service` | Installs and manages the router as a macOS/Linux user-level service. |
| `smoke.sh`       | Switches to a mode and probes the opus and sonnet tiers. |
| `active-mode`    | Runtime state: the current mode name. Gitignored; created on first run. |
| `.env.example`   | Upstream bases and keys to copy to `.env`. |

## License

[MIT](LICENSE) © ncwn
