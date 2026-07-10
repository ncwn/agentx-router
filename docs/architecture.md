# Architecture

## Components

- `router.js` loads runtime configuration and starts the local server.
- `src/config.js` validates routes, resolves environment-backed upstreams, and reads active-mode state.
- `src/routing.js` classifies the request model and selects a route.
- `src/proxy.js` forwards HTTP requests and streams responses.
- `agentx-mode` atomically changes `var/active-mode`.

The router listens only on `127.0.0.1:${AGENTX_PORT:-8787}`.

## Routing

For every request, the router buffers the request body and reads `body.model` without
changing the original bytes. Classification is case-insensitive:

| Model contains | Tier |
|---|---|
| `fable` | `fable` |
| `opus` | `opus` |
| `sonnet` | `sonnet` |
| `haiku` | `haiku` |
| anything else | `default` |

Malformed JSON also uses `default`. The selected mode maps that tier to `native`,
`performance`, or `balance`. These are server groups, not concrete model names.

`config/routes.json` is loaded and validated at process startup. Every mode must
define exactly `fable`, `opus`, `sonnet`, `haiku`, and `default`, and every value must
name a known upstream.

The active mode file's modification time and inode are checked on every request so
atomic replacements take effect immediately. An invalid value logs a warning and
leaves the last valid mode active.

## Forwarding

The selected upstream supplies the base URL and Bearer key. The router:

1. Preserves the HTTP method, request path, query, body bytes, and end-to-end headers.
2. Removes hop-by-hop headers and the client's placeholder `x-api-key`.
3. Replaces `Host` and `Authorization` for the selected upstream.
4. Forwards the response status and end-to-end headers.
5. Pipes the response body directly, including SSE streams.

The base URL must be a host root. The client's path, such as `/v1/messages`, is used
unchanged.

## Runtime configuration

Environment variables are read once at startup. Missing upstream configuration does
not prevent startup because a mode may not use that group. If a request selects a
missing group, it receives `502` with the missing variable names.

The connect timeout applies until response activity begins. The idle timeout applies
after the upstream response starts. Upstream connection errors and pre-response
timeouts return `502`. Errors after response headers close the downstream stream.

There is no retry, fallback, load balancing, request translation, model rewriting, or
context-window management.

## Runtime files

- `var/active-mode`: current mode.
- `var/router.out.log`: macOS service stdout.
- `var/router.err.log`: macOS service stderr and routing decisions.

`AGENTX_STATE_FILE` can override the mode-state path. The entire `var/` directory is
ignored by Git.
