# CLAUDE.md

## Commands

```bash
./agentx-up
./agentx-mode --list
./agentx-service status
./smoke.sh PERFORMANCE
node --test
node --check router.js src/*.js agentx-mode
bash -n agentx-up agentx-service smoke.sh lib/service/*.sh
```

There are no package dependencies or install step.

## Structure

- `router.js`: process entrypoint.
- `src/config.js`: route validation, environment configuration, and active-mode state.
- `src/routing.js`: pure model classification and route resolution.
- `src/proxy.js`: request forwarding and response streaming.
- `config/routes.json`: routing source of truth.
- `agentx-mode`: mode CLI.
- `agentx-service` and `lib/service/`: user-service management.
- `test/`: built-in `node:test` coverage.

## Invariants

- Keep model names and request bytes unchanged.
- Route only by the model tier and active mode.
- Upstream names are `native`, `performance`, and `balance`; concrete model versions belong to the server.
- Active-mode changes hot-reload. Route and environment changes require restart.
- Unused upstream credentials may be absent; fail only when a request selects one.
- Keep the router bound to `127.0.0.1`.
- Keep `.env`, `var/`, keys, and logs uncommitted.
