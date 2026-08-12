# pi-opencode-go-usage

Pi extension that shows your **OpenCode Go** subscription usage with `/usage`,
using the key stored by `opencode auth login` — without polluting the LLM
context.

## Features

- `/usage` shows rolling (5h), weekly (7d), and monthly (30d) usage windows
  with progress bars, reset countdowns, and rate-limit state.
- Automatically picks up the OpenCode Go key from (in order):
  1. The pi model registry — the key saved by **`pi /login`**
     (`~/.pi/agent/auth.json`, or `$PI_AGENT_DIR`)
  2. The opencode CLI `auth.json` (`~/.local/share/opencode/auth.json` on
     Linux, `~/Library/Application Support/opencode/auth.json` on macOS,
     `%LOCALAPPDATA%\opencode\auth.json` on Windows)
  3. The `credential` table of `opencode.db` (v1.18+), read-only via
     `node:sqlite`
  4. `OPENCODE_API_KEY` environment variable
  5. A manually saved key (`/usage --set-key <key>`)
- **No LLM context pollution**: usage is rendered as a custom TUI entry
  (`registerEntryRenderer` + `appendEntry`), which does not participate in LLM
  context. Status line and error notifications are TUI-only as well; the
  extension never calls `sendMessage`.
- Every `/usage` invocation fetches fresh usage from the endpoint.

## Install

```bash
pi install @narumitw/pi-opencode-go-usage
```

## Usage

```
/usage [--refresh] [--set-key <key>] [--clear-key] [--timeout <seconds>]
```

- `/usage` — query the usage endpoint (`GET https://opencode.ai/zen/go/v1/usage`,
  added in sst/opencode #16513) with the login key and render the report. Every
  invocation fetches fresh data.
- `--refresh` — accepted for compatibility; usage is always fetched fresh.
- `--set-key <key>` — save an OpenCode Go API key manually (fallback when no
  login credentials exist; stored with mode `0600`).
- `--clear-key` — forget the manually saved key.
- `--timeout <seconds>` — query timeout (default 10s).

## Requirements

- An OpenCode Go subscription and `pi /login` (or `opencode auth login`,
  `OPENCODE_API_KEY`, or `/usage --set-key <key>`).
- pi 0.80+ (tested against 0.84.1). Node.js 22.5+ for the optional
  `opencode.db` credential lookup; if unavailable, the extension falls back
  to the other key sources.

## Development

```bash
npm --workspace @narumitw/pi-opencode-go-usage run typecheck
just try-opencode-go-usage   # run this extension in pi
npm test                     # run all extension tests
```

## License

MIT
