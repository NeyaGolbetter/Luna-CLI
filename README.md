# Luna CLI 🌙

A modular, **Termux-optimized** terminal AI assistant for Android & Linux.

Bring your own API key, let the model drive real tools over the **Model
Context Protocol (MCP)**, and remotely pilot a **Roblox executor** through a
**Cloudflare Tunnel** — all from a narrow phone terminal.

```
    ▄████▄  ▒█████   ▓█████▄ ▄▄▄█████▓
   ▒██▀ ▀█ ▒██▒  ██▒██▀ ██▓  ██▒ 
   ▒▓█    ▄▒██░  ██▒░██   █▒▸  ▐▒▒▓▄░
   ▒▓▓ ██▒██   ██░░▒█   ▓▒▄   ▒██ ░
   ▒ ▓███▀ ░ ████▓▒░░░▒   ▒▒ ▒██▒   ░
   ░ ░▒  ▒  ▒ ░▒  ▒    ░   ░ ▒░░  ░
```

## Features

- **BYOAK + dynamic model discovery** — OpenAI, OpenRouter, Google Gemini
  (OpenAI-compatible endpoint), or any custom OpenAI-compatible base URL
  (Ollama, LiteLLM, vLLM…). `GET /v1/models` drives an interactive picker.
- **Full MCP client** — stdio, SSE, and streamable-HTTP transports; MCP tools
  are translated into OpenAI function-calling schemas, intercepted, executed,
  and fed back into the conversation loop automatically.
- **Roblox Executor Bridge** — a local HTTP/WS server that forwards Luau
  scripts to an executor via (a) a WebSocket sidecar, (b) the executor's own
  HTTP listener, or (c) a Luau polling script you paste into the executor.
- **Cloudflare Tunnel routing** — `luna tunnel start` spawns
  `cloudflared tunnel --url http://localhost:8172`, captures the ephemeral
  `https://*.trycloudflare.com` URL, and injects it into Luna's config **and**
  the MCP configuration (`remote-tunnel`) so the same `run_luau_script` /
  `get_game_state` tools work from your phone.
- **Termux ergonomics** — narrow-terminal Markdown rendering (with a
  lightweight fallback path so low-end devices don't stall), graceful Ctrl+C
  (cancel generation / clear line / exit), tiny CPU footprint (global `fetch`,
  no watcher threads), clean shutdown with no leaked processes or sockets.

## Install

Requires **Node.js ≥ 18.17** (Termux: `pkg install nodejs-lts`).

```sh
git clone https://github.com/NeyaGolbetter/Luna-CLI.git && cd Luna-CLI
npm install
npm run build        # prebuilt dist/ is committed; rebuild only after changes
./bin/luna           # or: npm link  →  luna
```

The repo ships a prebuilt `dist/`, so `npm install --omit=dev && ./bin/luna`
works even without TypeScript.

## Quick start

```sh
luna chat
```

First boot runs the BYOAK wizard: pick a provider → paste your key →
(optional) base URL → pick a model from the live `GET /v1/models` list.
Everything persists in `~/.luna/config.json` (mode 0600).

## Command matrix

| Command | What it does |
|---|---|
| `luna chat` | Interactive REPL (streaming, slash commands, Ctrl+C to cancel) |
| `luna` | Same as `luna chat` (Termux-friendly default) |
| `luna config` | Interactive menu: provider, key, base URL, model, temperature… |
| `luna config set-key [key]` | Non-interactive key update |
| `luna config set-provider <p>` | `openai` \| `openrouter` \| `gemini` \| `custom` |
| `luna config set-model [m]` | Set directly, or interactive picker via live discovery |
| `luna config show` / `path` / `reset` | Inspect / locate / reset config |
| `luna models [--select]` | List the provider's models (`--select` makes one active) |
| `luna mcp list` | Connect to all configured MCP servers, show tools |
| `luna mcp add <name> <command\|url> [args…]` | Register stdio (`command`) or remote (`--transport sse\|http`) servers |
| `luna mcp remove <name>` | Remove a server |
| `luna tunnel start [--port 8172]` | Start bridge + cloudflared, capture & inject the tunnel URL |
| `luna tunnel stop` / `status` / `logs` | Manage the running tunnel |
| `luna bridge start` / `stop` / `status` | Run the local executor bridge in the foreground, or inspect a detached one |

Chat slash commands: `/help /clear /model [id] /models /tools /status /exit`.

## Module A — BYOAK & dynamic model discovery

- Config lives at `~/.luna/config.json` (override with `LUNA_HOME`):

  ```json
  {
    "provider": "openrouter",
    "apiKey": "sk-or-…",
    "baseUrl": "",
    "activeModel": "anthropic/claude-sonnet-4",
    "temperature": 0.7,
    "maxTokens": 4096,
    "systemPrompt": "You are Luna…",
    "stream": true,
    "tunnel": { "url": "https://abcd1234.trycloudflare.com", "…": "…" }
  }
  ```

- Providers (default base URLs):

  | Provider | Base URL |
  |---|---|
  | `openai` | `https://api.openai.com/v1` |
  | `openrouter` | `https://openrouter.ai/api/v1` |
  | `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` |
  | `custom` | yours (Ollama: `http://127.0.0.1:11434/v1`, vLLM, LiteLLM…) |

- `luna models` performs `GET /v1/models` with the stored key, renders a
  table, and `--select` (or the wizard) lets you pick the `activeModel`
  interactively. Providers without a `/models` endpoint fall back to manual
  entry. Retries with backoff on 429/5xx; friendly errors on 401/404.

## Module B — MCP integration

Servers are declared in `~/.luna/mcp_servers.json` (standard spec shape):

```json
{
  "mcpServers": {
    "roblox-executor": {
      "command": "node",
      "args": ["./mcp-servers/roblox_server.js"],
      "env": { "LUNA_BRIDGE_URL": "http://127.0.0.1:8172" }
    },
    "remote-tunnel": {
      "url": "https://<your-tunnel>.trycloudflare.com/sse",
      "transport": "sse"
    }
  }
}
```

- `luna mcp add fs node ./servers/fs.js --env A=B` (stdio)
- `luna mcp add remote https://host/sse` (SSE) or `--transport http`
  (streamable HTTP); `--header 'Authorization: Bearer …'` for auth.
- On `luna chat`, every configured server is connected via
  `StdioClientTransport` / `SSEClientTransport` /
  `StreamableHTTPClientTransport` (official `@modelcontextprotocol/sdk`).
  Failures are isolated — one dead server never breaks the session.
- Tool names are sanitized to OpenAI's `^[a-zA-Z0-9_-]{1,64}$`; collisions
  across servers get a `server__` prefix.
- When the model emits `tool_calls`, Luna resolves each call, executes it
  against the owning MCP server, appends the `tool` result, and re-queries
  the model (capped at 8 round-trips per turn; oversized results truncated).
  Tool errors are returned to the model as error text so it can react.

## Module C — Roblox executor & Cloudflare Tunnel bridge

### Topology

```
┌─────────────┐   MCP (stdio)    ┌───────────────┐  HTTP/WS   ┌────────────────────┐
│  Luna CLI   │ ───────────────▶ │ roblox_server │ ─────────▶ │   Roblox Bridge    │
│ (Termux/PC) │   over tunnel:   │  (MCP stdio)  │            │  (HTTP+WS+MCP-SSE) │
│  chat REPL  │ ◀── SSE ──────── │  or direct    │            │   :8172            │
└─────────────┘  remote-tunnel   └───────────────┘            └─────────┬──────────┘
                                                                        │
                     cloudflared tunnel (https://*.trycloudflare.com)   │
                                          ▲                             ▼
                                          │              ┌────────────────────────────┐
                                          └──────────── │ Executor backend (any of): │
                                                        │  a) WS sidecar (game PC)   │
                                                        │  b) executor HTTP listener │
                                                        │  c) Luau polling script    │
                                                        └────────────────────────────┘
```

### 1. Local bridge

```sh
luna bridge start --port 8172          # foreground
luna bridge start --executor-url http://127.0.0.1:9000/run   # direct HTTP executor
```

Endpoints: `GET /status`, `POST /execute`, `GET /execute/poll`,
`POST /execute/result`, `WS /ws`, plus a full **MCP SSE server** on
`GET /sse` (+`POST /message`) exposing `run_luau_script`, `get_game_state`,
`get_bridge_status`.

### 2. Attaching an executor (pick one)

- **WS sidecar** — on the game PC where the executor exposes a local HTTP
  listener:

  ```sh
  node mcp-servers/roblox_executor_client.js \
    --bridge ws://YOUR-LUNA-IP:8172/ws \
    --executor-url http://127.0.0.1:9000/run
  ```

- **Luau polling script** — paste into *any* executor (auto-detects
  `request`/`http_request`, `JSONEncode`/`json.encode`):

  ```lua
  -- mcp-servers/roblox_executor_client.luau
  local BRIDGE = "http://127.0.0.1:8172"  -- or the trycloudflare URL
  ```

- **Direct HTTP** — start the bridge with `--executor-url` pointing at the
  executor's listener.

### 3. Tunneling it

```sh
luna tunnel start --port 8172
# 🌙 tunnel is live:
#   https://abcd1234-efgh.trycloudflare.com
# registered as MCP server "remote-tunnel" (SSE)
```

`luna tunnel start` spawns the bridge (if `--bridge`, default) and
`cloudflared tunnel --url http://localhost:8172 --no-autoupdate`, waits for
the ephemeral URL, persists state in `~/.luna/tunnel.json`, injects the URL
into `config.tunnel`, and auto-registers the `remote-tunnel` MCP server
(`--no-mcp` to skip, `--mcp-name` to rename, `--token` for named tunnels).
`luna tunnel stop` tears everything down and removes stale MCP entries.

> **Termux note:** there is no Android build of `cloudflared`. Run the
> tunnel from a PC (`luna tunnel start` there, bridge reachable at the
> PC's LAN IP), or expose the PC bridge another way, and on the phone just
> add it: `luna mcp add remote-tunnel https://<pc-tunnel>.trycloudflare.com/sse`.

### 4. MCP tools exposed to the model

- `run_luau_script(script: string)` — execute Luau via the bridge; the
  script's return value is returned as text.
- `get_game_state()` — place id, local player, player count, character &
  camera positions (JSON).
- `get_bridge_status()` — attachment & backend diagnostics.

Ask your model things like:
*“run `print('hello')` on the Roblox client”* or *“what's my character
position and how many players are in the server?”*

## Module D — Termux ergonomics

- Text wrapping that understands ANSI codes; width from the terminal
  (fallback 80; override with `LUNA_WIDTH`).
- Markdown via `marked` + `marked-terminal`; very code-heavy answers use a
  lightweight fallback renderer so cli-highlight never stalls a low-end
  device. `NO_COLOR=1` disables all styling.
- Ctrl+C: during generation → cancels the in-flight request (abort signal
  through fetch + MCP); at the prompt → clears the line, second press within
  2 s exits. EOF (Ctrl+D) exits cleanly.
- Shutdown disconnects all MCP transports and closes the bridge — no leaked
  child processes or sockets (verified by tests).
- Debug: `LUNA_DEBUG=1` (debug lines), `LUNA_VERBOSE=1` (stack traces).

## Development

```sh
npm run build     # tsc → dist/ (committed for seamless Termux use)
npm run watch     # rebuild on change
npm test          # build + node --test (53 tests, no network needed)
```

Layout:

```
bin/luna                      bash entrypoint (chmod +x)
src/cli/                      commander wiring, REPL, config/models/mcp/tunnel/bridge
src/providers/                OpenAI-compatible client (fetch, SSE streaming, retries)
src/mcp/                      MCP client manager (stdio/SSE/HTTP) + tool-call orchestrator
src/bridge/                   roblox-bridge (HTTP/WS/MCP-SSE), tunnel-manager (cloudflared)
src/utils/                    config manager (~/.luna), mcp config, formatters, process helpers
mcp-servers/roblox_server.js          out-of-the-box stdio MCP server
mcp-servers/roblox_executor_client.js WS sidecar (game machine)
mcp-servers/roblox_executor_client.luau polling client (paste into executor)
test/                         node:test suite (unit + end-to-end with mock provider & MCP servers)
```

## Security notes

- API keys are stored 0600 in `~/.luna/config.json` and never printed in
  full (`luna config show` masks them).
- Ephemeral `trycloudflare.com` tunnels have **no built-in auth** — anyone
  who knows the URL can use the bridge. For real remote control prefer a
  named tunnel with access rules (`--token`), or keep the bridge bound to
  `127.0.0.1` and tunnel from a trusted machine.
- The bridge executes whatever the model sends to the executor. Keep the
  tunnel URL private and treat it as credentials.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `cloudflared was not found` | install per the hint (apt/brew/winget); no Termux build — run the tunnel on a PC |
| MCP server shows `timed out after 20s` | check the command/url in `~/.luna/mcp_servers.json`; run the command by hand |
| `No executor attached` | attach a backend (sidecar / polling script / `--executor-url`) and re-check `GET /status` |
| Provider `404` on `/models` | expected for some local servers — set the model id manually |
| Weird terminal rendering | try `NO_COLOR=1` or `LUNA_WIDTH=60 luna chat` |

## License

MIT
