---
name: verify
description: Exercise the router CLI and installed user service end to end.
---

# Verify

1. Save the current value of `var/active-mode` and restore it with a shell trap.
2. Run `./agentx-mode --list`; confirm it shows the configured logical groups and no concrete model versions.
3. Run `./agentx-service restart` and `./agentx-service status`; confirm the router listens on `127.0.0.1:8787`.
4. Run `./smoke.sh <temporary-mode>` to send Fable, Opus, Sonnet, Haiku, and unknown-model requests through the live router.
5. Inspect recent `var/router.err.log` entries to confirm each tier selected the group declared in `config/routes.json`.
6. Probe an obsolete mode such as `PERF`; confirm it fails without changing the active-mode file.
7. Restore the saved mode before exiting, including on failure.

Never print `.env` or upstream keys. Treat upstream HTTP errors separately from routing failures when the router log proves the intended group was selected.
