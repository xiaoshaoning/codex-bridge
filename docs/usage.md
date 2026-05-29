# Codex Bridge — Usage Guide

How to install, configure, and use the Codex Bridge proxy with OpenAI Codex CLI.

## Architecture

```
Codex CLI  →  Codex Bridge (localhost:8098)  →  DeepSeek API
                   │
           Converts between
           OpenAI Responses API
           and DeepSeek Chat API
```

## Prerequisites

- Node.js 20+
- DeepSeek API key

## Starting the Bridge

The bridge runs on `localhost:8098` and handles auth to DeepSeek server-side. Codex CLI never sees the API key.

**Windows PowerShell:**

```powershell
$env:DEEPSEEK_API_KEY = "sk-your-deepseek-key-here"
$env:MAX_TOKENS = "16384"
$env:MAX_INSTRUCTION_LENGTH = "8000"
npm start
```

**macOS / Linux / Git Bash:**

```bash
export DEEPSEEK_API_KEY=sk-your-deepseek-key-here
export MAX_TOKENS=16384
export MAX_INSTRUCTION_LENGTH=8000
npm start
```

Confirm the server is up:

```
Starting DeepSeek proxy server on port 8098
Memory monitor started
WebSocket server enabled at /ws
```

## Stopping the Bridge

```bash
# Foreground: press Ctrl+C (triggers graceful shutdown)

# Background:
kill $(lsof -ti:8098)        # macOS / Linux
```

Windows (PowerShell):

```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 8098).OwningProcess -Force
```

Or via HTTP (requires `SHUTDOWN_SECRET` env var):

```bash
curl -X POST http://localhost:8098/shutdown -H "X-Shutdown-Secret: your-secret"
```

## Codex CLI Configuration

Edit `~/.codex/config.toml` (create it if it doesn't exist):

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
| `requires_openai_auth` | `false` | Bridge handles the DeepSeek API key server-side |
| `wire_api` | `responses` | Uses OpenAI Responses API format |
| `supports_websockets` | `false` | Disables WebSocket transport (simpler SSE-only path) |

The top-level `model_provider` and `model` make deepseek the default — no `-p` flag needed.

### Pro / Fast Profiles

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

The startup banner must show `provider: deepseek` (not `openai`):

```
model: deepseek-v4-pro
provider: deepseek              ← must say "deepseek"
```

The bridge logs should show:

```
Forwarding to https://api.deepseek.com/v1/chat/completions, stream=true
DeepSeek API streaming connection established in 317ms
Streaming request processed in 2591ms
```

## Using curl (Direct API Access)

```bash
# Health check
curl http://localhost:8098/health

# Generate code
curl -s -X POST http://localhost:8098/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-pro",
    "input": "Write a Python script. Output only the code.",
    "stream": false
  }'
```

## Request Format

The proxy accepts OpenAI Responses API format:

```json
{
  "model": "deepseek-v4-pro",
  "input": "Write code for X",
  "stream": false
}
```

It converts this to DeepSeek Chat Completions format internally.

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

## What Happens Inside the Proxy

1. **Codex CLI** sends `POST /v1/responses` with `{ model: "deepseek-v4-pro", input: "..." }`
2. **CORS middleware** checks origin
3. **Auth middleware** validates API key (only if `CODEX_API_KEY` is set)
4. **Rate limiter** checks per-IP limits (100 req/min by default)
5. **Input validation** ensures `input` field is present
6. **Converter** translates OpenAI Responses format → DeepSeek Chat Completions format
7. **Connection pool** picks a reusable HTTP/HTTPS connection
8. **Circuit breaker** tracks upstream failures and prevents cascading
9. **DeepSeek API** receives the request and generates a response
10. **Converter** translates the DeepSeek response back to OpenAI format
11. **Codex CLI** receives the standard OpenAI-format response
12. **Codex CLI agent** writes code and verifies it

## Troubleshooting

**Provider shows `openai` instead of `deepseek`:** Codex CLI is ignoring config. Either set `model_provider = "deepseek"` at the top level, or use `-p <profile>` to select a profile explicitly.

**`tokens used: 0` and no response:** The bridge is not running. Start it in a separate terminal. Check with `curl http://localhost:8098/health`.

**Bridge fails to start:** Make sure `DEEPSEEK_API_KEY` is set in the environment where `npm start` runs.

## Environment Variables

Variables set for the bridge process (not Codex CLI):

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | DeepSeek API key (required) |
| `ANTHROPIC_AUTH_TOKEN` | — | Alternative key source |
| `OPENAI_API_KEY` | — | Fallback key (lowest priority) |
| `PORT` | `8098` | Bridge server port |
| `SHUTDOWN_SECRET` | — | Enables `POST /shutdown` endpoint |
| `CORS_ORIGINS` | `*` | Allowed CORS origins (comma-separated) |
| `CODEX_API_KEY` | — | API key for client auth (optional) |
| `MAX_TOKENS` | `4096` | Max tokens per response |
| `MAX_INSTRUCTION_LENGTH` | `4000` | Max chars for system prompt before truncation |
| `CONTEXT_LIMIT` | `1048576` | Token budget for automatic message truncation |
| `COMPLETION_HEADROOM` | `8192` | Tokens reserved for the completion response |
| `RATE_LIMIT_MAX` | `100` | Max requests per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in ms |

Auth key resolution order: `DEEPSEEK_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `OPENAI_API_KEY`

## Architecture Notes

- **Middleware order**: CORS → Request ID → Auth → Rate Limiter → Logging → Metrics → Routes
- **Connection pooling**: Separate pools for streaming and non-streaming requests
- **Caching**: 5-second TTL for non-streaming responses with request deduplication
- **Circuit breaker**: Prevents cascading failures when DeepSeek is degraded
- **Memory monitoring**: Periodic heap checks with leak detection
