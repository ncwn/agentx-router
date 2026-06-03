# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This project has no package manager metadata and uses only Node.js built-ins plus Bash scripts; there is no `npm install` step.

- Initial local setup: `cp .env.example .env` then fill in upstream bases/keys; run `chmod +x agentx-up agentx-mode agentx-claude agentx-service smoke.sh` if needed.
- Start the router in the foreground: `./agentx-up`.
- Install/start the router as a user-level service: `./agentx-service install`.
- Show service and local port status: `./agentx-service status`.
- Restart the service after repo updates or path moves: `./agentx-service update` or `./agentx-service restart`.
- Stream service logs: `./agentx-service logs`.
- Remove the generated user service without deleting repo files: `./agentx-service uninstall`.
- Initialize and publish the project as a GitHub repo when untracked: `./agentx-service publish`.
- Show the active mode and the mode table: `./agentx-mode` or `./agentx-mode --list`.
- Switch routing mode without restarting the router: `./agentx-mode BAL`.
- Launch Claude Code with routing plus the context cap for the chosen model: `./agentx-claude PERF opus`.
- Connectivity smoke test, with router already running: `./smoke.sh PERF`.
- Run the router directly for local debugging: `node router.js`.
- Syntax-check JavaScript without starting the server: `node --check router.js`.
- Syntax-check Bash scripts: `bash -n agentx-up agentx-mode agentx-claude agentx-service smoke.sh`.

There is no automated unit test suite. `smoke.sh` is the live connectivity check and requires a running router plus configured `.env` upstreams.

## Architecture

`router.js` is a single-port local HTTP proxy bound to `127.0.0.1:${AGENTX_PORT:-8787}`. Claude Code should point `ANTHROPIC_BASE_URL` at that fixed port once; the router chooses the real upstream per request.

The routing source of truth is `modes.json`. Each mode is a routing table only: a `desc`, a `routes` map for the `opus`, `sonnet`, and `background` tiers, and a `default` upstream. Modes carry no model, effort, or ultracode fields; those are Claude Code-side choices. `router.js` classifies requests by reading `body.model` (`opus`, `sonnet`, or `haiku`/background), then maps that tier through the active mode to one of the configured upstream groups: `native`, `gpt55`, or `gpt54`.

Runtime mode state lives in the `active-mode` file. `agentx-mode` validates a requested mode against `modes.json` and atomically writes this state file; `router.js` checks the file mtime on every request, so mode changes take effect on the next request with no router restart.

Request forwarding is intentionally minimal: `router.js` parses the body only to inspect `model`, then forwards the original request bytes. It strips hop-by-hop headers, drops the client placeholder `x-api-key`, replaces `Host` and `Authorization` with the selected upstream’s Bearer key, and streams responses back without reserializing SSE.

The shell scripts are operational wrappers:

- `agentx-up` loads `.env`, seeds `active-mode` if missing, and execs `node router.js`.
- `agentx-mode` lists modes or hot-swaps the active mode.
- `agentx-claude` switches mode, then takes the main model as a second argument and derives the context cap from the active mode's route table: if the model's tier maps to `gpt55`, it exports the 200K context-window variables, otherwise it keeps 1M. The model argument is required for modes that route any tier to `gpt55`. Then it execs `claude`.
- `smoke.sh` switches to a mode if provided, then probes `/v1/messages` through the router for Opus and Sonnet model names.
- `agentx-service` installs, updates, and inspects the user-level service wrapper around `agentx-up`.

`agentx-service` manages this router as a user-level service. On macOS it generates `~/Library/LaunchAgents/com.agentx.cc-router.plist`; on Linux it generates `~/.config/systemd/user/agentx-cc-router.service`. Both service definitions execute this repo's `agentx-up` by absolute path and inject a runtime `PATH` that includes the resolved Node.js binary directory, so `./agentx-service update` should be run after repo updates or path moves to regenerate, reload, and restart the service definition.

## Important constraints

- Keep `.env` uncommitted; `.env.example` documents required upstream variables and optional timeout/port variables.
- Do not put real Anthropic keys in Claude Code settings for this router. The intended Claude Code token is the placeholder `router-managed`; the router supplies per-upstream credentials.
- Do not rewrite Claude model names to GPT model names in requests. Sub2API mappings depend on receiving Claude-tier model names, and Claude Code feature gates also key off those names.
- If changing mode semantics, update `modes.json` first, then keep `README.md` and script output in sync with it.
- `agentx-claude` is required when the main model's tier maps to gpt-5.5, because Claude Code's context window is fixed at launch and must be capped to 200K; `agentx-mode` only hot-swaps routing. The cap is derived from the model argument and the active mode's route table.
