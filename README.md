# agentx-cc-router

A local HTTP router for sending Claude Code model tiers to different server groups.
Claude Code keeps one `ANTHROPIC_BASE_URL`; this router selects the upstream group
for each request. The upstream server chooses the concrete model.

The project uses Node.js built-ins and Bash. It has no package installation step.

## Request flow

```text
Claude Code
    -> 127.0.0.1:8787
    -> read body.model
    -> classify Fable / Opus / Sonnet / Haiku / default
    -> apply the active routing mode
    -> select native / performance / balance credentials
    -> forward the original request to the server
```

The router does not rename models, translate request formats, manage context, or
choose a concrete GPT version. Those decisions belong to Claude Code and the
upstream server.

## Setup

Requirements: Node.js 18+, Bash, Claude Code, and an Anthropic-compatible server.

```bash
cp .env.example .env
# Fill in the server groups you use.
./agentx-up
```

Configure Claude Code once:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "router-managed"
  }
}
```

Do not put a real upstream key in Claude Code. The router replaces the placeholder
with the selected group key.

## Routing modes

Routes live in `config/routes.json`.

| Mode | Fable | Opus | Sonnet | Haiku | Unknown/default |
|---|---|---|---|---|---|
| `NATIVE` | native | native | native | native | native |
| `HYBRID-PERFORMANCE` | native | native | performance | balance | native |
| `HYBRID-BALANCE` | native | native | balance | balance | native |
| `PERFORMANCE` | performance | performance | performance | balance | performance |
| `BALANCE` | balance | performance | balance | balance | balance |

Model classification is a case-insensitive substring check. For example,
`claude-fable-5` is Fable and `claude-haiku-4-5` is Haiku. Missing, malformed, and
unrecognized model names use the `default` route.

Show or change the active mode:

```bash
./agentx-mode --list
./agentx-mode PERFORMANCE
```

The mode change applies to the next request. Editing `config/routes.json` or `.env`
requires a router restart.

## Configuration

Each upstream is a server base URL and group key:

```text
AGENTX_NATIVE_BASE / AGENTX_NATIVE_KEY
AGENTX_PERFORMANCE_BASE / AGENTX_PERFORMANCE_KEY
AGENTX_BALANCE_BASE / AGENTX_BALANCE_KEY
```

Only groups selected by the active mode need to be configured. A request selecting
an unconfigured group receives a clear `502` response.

Optional settings:

```text
AGENTX_PORT                 default 8787
AGENTX_STATE_FILE           default var/active-mode
AGENTX_CONNECT_TIMEOUT_MS   default 60000
AGENTX_IDLE_TIMEOUT_MS      default 300000
AGENTX_MODE                 startup default when no state file exists
```

## Commands

```bash
./agentx-up                  # foreground router
./agentx-mode --list         # current mode and route table
./agentx-mode BALANCE        # hot-swap mode
./smoke.sh PERFORMANCE       # live probes for all route tiers
```

The smoke command sends Fable, Opus, Sonnet, Haiku, and unknown model names. Check
router logs to confirm each selected group. The unknown probe may receive an upstream
`4xx`; that still proves it reached the configured default group.

## User service

`agentx-service` installs a macOS LaunchAgent or Linux `systemd --user` service:

```bash
./agentx-service install
./agentx-service status
./agentx-service restart
./agentx-service logs
./agentx-service update
./agentx-service uninstall
```

Run `update` after moving or updating the repository. Runtime state and macOS logs
are stored under the ignored `var/` directory.

## Tests

```bash
node --test
node --check router.js src/*.js agentx-mode
bash -n agentx-up agentx-service smoke.sh lib/service/*.sh
```

See [docs/architecture.md](docs/architecture.md) for the exact forwarding and
failure behavior.

## Migration from versioned names

This release is a clean break:

```text
PERF                 -> PERFORMANCE
BAL                  -> BALANCE
HYBRID-P             -> HYBRID-PERFORMANCE
HYBRID-B             -> HYBRID-BALANCE
AGENTX_GPT55_*       -> AGENTX_PERFORMANCE_*
AGENTX_GPT54_*       -> AGENTX_BALANCE_*
```

Rename the `.env` variables before restarting the service, then select the new mode
name and run `./agentx-service update`.

## License

MIT
