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
$env:DEEPSEEK_API_KEY="sk-your-key-here"
$env:MAX_TOKENS="16384"
$env:MAX_INSTRUCTION_LENGTH="8000"
npm start
```

### Windows CMD

```cmd
set DEEPSEEK_API_KEY=sk-your-key-here
set MAX_TOKENS=16384
set MAX_INSTRUCTION_LENGTH=8000
npm start
```

The server starts on port 8098 by default (configurable via `PORT` env var).

Auth key resolution order: `DEEPSEEK_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `OPENAI_API_KEY`

### Windows Shell Recommendation

DeepSeek models have limited training data for PowerShell syntax and often generate malformed commands on Windows. For best results, set `SHELL` to Git Bash before starting Codex CLI:

```powershell
$env:SHELL = "C:\Program Files\Git\bin\bash.exe"
```

```cmd
set SHELL=C:\Program Files\Git\bin\bash.exe
```

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
