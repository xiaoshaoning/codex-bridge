# Codex Bridge - DeepSeek Proxy

A TypeScript proxy server that converts OpenAI Responses API requests to DeepSeek Chat Completions API.

## Overview

Codex Bridge acts as a translation layer between OpenAI's Responses API format and DeepSeek's Chat Completions API. It lets OpenAI-compatible clients (such as [OpenAI Codex CLI](https://github.com/openai/codex)) use DeepSeek models without client-side changes.

## Features

- **Protocol conversion** — OpenAI Responses API ↔ DeepSeek Chat Completions format
- **Streaming SSE** — Real-time streaming with tool call delta events matching the Responses API spec
- **WebSocket** — Real-time communication via `/ws` with JSON message protocol
- **Batch processing** — `POST /v1/responses:batch` with configurable concurrency (up to 50 items)
- **Webhook callbacks** — Async processing with POST delivery to a callback URL
- **Plugin system** — Extensible converter interface for adding other API providers
- **Caching** — 5-second TTL for non-streaming responses with request deduplication
- **Circuit breaker** — Prevents cascading failures when upstream is degraded
- **Connection pooling** — Separate pools for streaming and non-streaming requests
- **Codex CLI 0.133.0+ support** — Handles namespace tool types, model response mapping, message reordering for tool call sequences, parameter schema simplification for DeepSeek compatibility, and empty argument fallback to XML/text
- **Context window management** — Conservative token estimation (2.0 chars/token) with auto-truncation of oldest history when approaching model's token limit (configurable via `CONTEXT_LIMIT` / `COMPLETION_HEADROOM`)
- **Tool call deduplication** — Collapses consecutive identical tool call blocks to prevent DeepSeek from looping on repeated function calls
- **Rate limiting** — Per-IP sliding window (configurable via `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`)
- **API key auth** — Optional `CODEX_API_KEY` for client authentication
- **CORS** — Configurable origin allowlist (default `*`)
- **Prometheus metrics** — `/metrics` endpoint with HTTP, upstream, cache, and circuit breaker metrics
- **Enhanced health check** — `/health` with cache, circuit breaker, and connection pool stats
- **Memory monitoring** — Periodic heap checks with leak detection

## Quick Start

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Set your DeepSeek API key
export DEEPSEEK_API_KEY=sk-your-key-here

# Or use ANTHROPIC_AUTH_TOKEN if that's what you have configured
# export ANTHROPIC_AUTH_TOKEN=sk-your-key-here

# Start the server
npm start
```

### Windows PowerShell

```powershell
# Install dependencies & build
npm install
npm run build

# Set your DeepSeek API key
$env:DEEPSEEK_API_KEY="sk-your-key-here"
$env:MAX_TOKENS="16384"
$env:MAX_INSTRUCTION_LENGTH="8000"

# Start the server
npm start
```

### Windows CMD

```cmd
:: Install dependencies & build
npm install
npm run build

:: Set your DeepSeek API key and start
set DEEPSEEK_API_KEY=sk-your-key-here
set MAX_TOKENS=16384
set MAX_INSTRUCTION_LENGTH=8000
npm start
```

Or use the setup script that reads from `.env` and prompts interactively if the key is missing:

```cmd
set-env.bat && npm start
```

The server starts on port 8098 by default (configurable via `PORT` env var).

Auth key resolution order: `DEEPSEEK_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `OPENAI_API_KEY`

## Codex CLI Configuration

Connect [OpenAI Codex CLI](https://github.com/openai/codex) to the bridge by editing `~/.codex/config.toml`:

```toml
model_provider = "deepseek"
model = "deepseek-v4-pro"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "http://localhost:8098/v1"
requires_openai_auth = false
wire_api = "responses"
supports_websockets = false
```

| Key | Value | Why |
|-----|-------|-----|
| `base_url` | `http://localhost:8098/v1` | Routes requests through the bridge instead of api.openai.com |
| `requires_openai_auth` | `false` | Bridge handles the DeepSeek API key server-side — Codex CLI skips OAuth |
| `wire_api` | `responses` | Uses OpenAI Responses API format (the format the bridge translates) |
| `supports_websockets` | `false` | Disables WebSocket transport (simpler SSE-only path) |

The top-level `model_provider` and `model` make deepseek the default — no `-p` flag needed. Available models: `deepseek-v4-pro` (heavy coding), `deepseek-v4-flash` (quick edits).

Add profiles to switch models by task:

```toml
[profiles.pro]
model_provider = "deepseek"
model = "deepseek-v4-pro"

[profiles.fast]
model_provider = "deepseek"
model = "deepseek-v4-flash"
```

```bash
codex exec -p pro "implement a pipelined multiplier in Verilog"   # complex work
codex exec -p fast "fix the wire declaration on line 42"          # quick edits
```

### Verify

```bash
codex exec -m deepseek-v4-pro "hello world"
```

The startup banner must show `provider: deepseek` (not `openai`). If it says `openai`, Codex CLI is ignoring the config — check that `model_provider` is set at the top level.

### Windows Shell Recommendation

DeepSeek models have limited PowerShell training data and often generate malformed commands on Windows, causing loops (e.g. retrying broken `Set-Acl` syntax on stale `.git` lock files). For best results, set `SHELL` to Git Bash before starting Codex CLI:

```powershell
# PowerShell
$env:SHELL = "C:\Program Files\Git\bin\bash.exe"
```

```cmd
REM Command Prompt
set SHELL=C:\Program Files\Git\bin\bash.exe
```

To set permanently in CMD: `setx SHELL "C:\Program Files\Git\bin\bash.exe"`

For a detailed walkthrough, see [docs/usage.md](docs/usage.md).

### WSL2 Setup

Running Codex CLI natively under WSL2 while the bridge stays on the Windows host gives you full Linux sandboxing without a separate VM. WSL2 has its own network namespace — the bridge on Windows `localhost` is **not** reachable from WSL's `localhost`. Communication goes through the Hyper-V virtual switch gateway instead.

For a complete walkthrough covering networking, PATH fixes, shell wrapper, profiles, and troubleshooting, see **[docs/wsl-setup.md](docs/wsl-setup.md)**.

Quick architecture:

```
┌──────────── WSL2 ───────────┐
│  Codex CLI ──HTTP──► Windows Host (vSwitch gateway) :8098
└──────────────────────────────┘
                              │
              ┌───────────────▼──────────────┐
              │  Codex Bridge (Windows) :8098│
              └───────────────┬──────────────┘
                              │
              ┌───────────────▼──────────────┐
              │  DeepSeek API                │
              └──────────────────────────────┘
```

The guide covers:

- Installing Codex CLI under WSL (Linux binary via WSL's npm — Windows npm ships the wrong platform binary)
- Fixing PATH so WSL's Codex isn't shadowed by the Windows npm installation
- Resolving the Windows host IP dynamically via `ip route show default`
- Shell wrapper function to auto-resolve the IP on every invocation
- Profile configuration as separate files (required by Codex v0.135.0+)
- Troubleshooting: stream disconnects, `chat_completions` errors, legacy profile conflicts

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/responses` | Main proxy endpoint |
| `POST` | `/responses` | Alternative endpoint |
| `GET` | `/health` | Health check with component stats |
| `GET` | `/metrics` | Prometheus metrics |
| `POST` | `/v1/responses:batch` | Batch processing (up to 50 items) |
| `POST` | `/shutdown` | Graceful shutdown (requires `SHUTDOWN_SECRET`) |
| WebSocket | `/ws` | Real-time streaming via JSON messages |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | DeepSeek API key (primary) |
| `ANTHROPIC_AUTH_TOKEN` | — | Alternative key source (from Claude Code env config) |
| `ANTHROPIC_BASE_URL` | — | Base URL with `/anthropic` suffix (auto-stripped) |
| `OPENAI_API_KEY` | — | OpenAI API key (fallback) |
| `PORT` | `8098` | HTTP server port |
| `SHUTDOWN_SECRET` | — | Secret for `POST /shutdown` endpoint |
| `CORS_ORIGINS` | `*` | Allowed CORS origins (comma-separated) |
| `CODEX_API_KEY` | — | API key for client authentication (optional) |
| `MAX_TOKENS` | `4096` | Max tokens per response |
| `MAX_INSTRUCTION_LENGTH` | `4000` | Max chars for instructions/system prompt truncation |
| `CONTEXT_LIMIT` | `1048576` | DeepSeek context window in tokens (auto-truncates older messages to fit) |
| `COMPLETION_HEADROOM` | `8192` | Tokens reserved for the completion response |
| `RATE_LIMIT_MAX` | `100` | Max requests per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in ms |

## Project Structure

```
codex_bridge/
├── src/
│   ├── server.ts              # Express server setup and routes
│   ├── converter.ts           # API format conversion (OpenAI ↔ DeepSeek), namespace tool handling, message sequence reordering, tool call deduplication, model response mapping, conservative token estimation, context truncation
│   ├── streaming.ts           # SSE streaming handlers
│   ├── auth.ts                # API key validation middleware
│   ├── rate-limiter.ts        # Sliding window rate limiter
│   ├── cors.ts                # CORS middleware
│   ├── cache-manager.ts       # Response cache with TTL + dedup
│   ├── circuit-breaker.ts     # Circuit breaker for upstream calls
│   ├── connection-pool.ts     # HTTP/HTTPS connection pooling
│   ├── plugin-system.ts       # Converter plugin interface
│   ├── websocket.ts           # WebSocket real-time handler
│   ├── batch.ts               # Batch request processing
│   ├── webhook.ts             # Webhook callback delivery
│   ├── memory-monitor.ts      # Heap monitoring and leak detection
│   ├── metrics.ts             # Prometheus metrics export
│   └── input-validation.ts    # Request body validation
│   └── plugins/
│       └── deepseek-plugin.ts # DeepSeek converter plugin
├── scripts/
│   └── codex-regression.sh   # Bridge API regression tests
├── dist/                      # Compiled JavaScript output
└── output/                    # Generated output files (optional)
```

## Development

```bash
# Run with auto-reload
npm run dev

# Run tests
npm test

# Type check
npx tsc --noEmit
```

### Code Style

- TypeScript with strict typing
- Snake case naming for variables and functions
- No Chinese comments
- Error handling with proper HTTP status codes

## Docker

```bash
# Build and run with Docker Compose
docker compose up --build
```

Includes multi-stage Dockerfile with health check and non-root user.

## CI

GitHub Actions workflow runs build + tests on Node 20 and 22 for every PR.

## License

Apache License 2.0

Copyright 2026 萧少宁 (Xiao Shaoning)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
