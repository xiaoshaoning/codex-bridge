# Codex Bridge — Usage Guide

> How to use the codex bridge proxy to generate code via DeepSeek

## Overview

Codex Bridge is a proxy server that translates OpenAI Responses API requests into DeepSeek Chat Completions API calls. This allows OpenAI-compatible clients (such as [OpenAI Codex CLI](https://github.com/openai/codex)) to access DeepSeek's models.

## Architecture

```
OpenAI Codex CLI  →  Codex Bridge (localhost:8098)  →  DeepSeek API
                              │
                      Converts Requests &
                      Responses between
                      OpenAI ↔ DeepSeek format
```

## Prerequisites

- Node.js 20+
- DeepSeek API key

## Setup

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Set your API key
export DEEPSEEK_API_KEY=sk-your-key-here
```

## Start the Server

```bash
npm start
```

The server starts on port 8098 by default (configurable via `PORT` env var).

```
WebSocket server enabled at /ws
Starting DeepSeek proxy server on port 8098
Starting memory monitor
```

## Stop the Server

```bash
# In the foreground terminal: press Ctrl+C
# The server shuts down gracefully (drains connections, flushes logs)

# If running in the background, find and kill the process:
kill $(lsof -ti:8098)        # macOS/Linux
```

Windows (PowerShell):
```powershell
# Find the process by port and stop it
Stop-Process -Id (Get-NetTCPConnection -LocalPort 8098).OwningProcess -Force
```

Or via the HTTP shutdown endpoint (requires `SHUTDOWN_SECRET`):
```bash
curl -X POST http://localhost:8098/shutdown -H "X-Shutdown-Secret: your-secret"
```

## Using with OpenAI Codex CLI

The primary use case is routing [OpenAI Codex CLI](https://github.com/openai/codex) through the proxy to use DeepSeek as the backend model.

### 1. Configure Codex CLI

Edit `~/.codex/config.toml`:

```toml
model = "deepseek-v4-pro"
model_provider = "deepseek-proxy"

[model_providers.deepseek-proxy]
name = "DeepSeek Proxy"
base_url = "http://localhost:8098/v1"
requires_openai_auth = false
wire_api = "responses"
supports_websockets = false
```

| Key | Value | Description |
|-----|-------|-------------|
| `base_url` | `http://localhost:8098/v1` | Codex Bridge endpoint |
| `requires_openai_auth` | `false` | Proxy handles auth via `DEEPSEEK_API_KEY` or `ANTHROPIC_AUTH_TOKEN` |
| `wire_api` | `responses` | Uses OpenAI Responses API format |
| `supports_websockets` | `false` | Disables WebSocket (not needed) |

Available models: `deepseek-v4-pro` (default), `deepseek-v4-flash` (lightweight)

### 2. Generate Code

With the proxy running, use `codex exec`:

```bash
codex exec -m deepseek-v4-pro "Write a Python simulation of LTE OFDM \
modulation and demodulation. Include: QPSK modulation, OFDM symbol \
generation with cyclic prefix, channel estimation, and demodulation."
```

The CLI prints the model and provider being used:

```
model: deepseek-v4-pro
provider: deepseek-proxy
```

Codex CLI's agent generates the code, writes it to a file, and verifies it.

### Real Test — Generate LTE OFDM Simulation

Terminal 1 — Start the proxy:

```bash
npm start
```

Terminal 2 — Generate code via Codex CLI:

```bash
codex exec -m deepseek-v4-pro "Write a complete Python simulation of \
LTE OFDM modulation and demodulation. Include: QPSK modulation, \
OFDM symbol generation with cyclic prefix, channel estimation, \
and demodulation. Output only the code."
```

Codex CLI output:

```
model: deepseek-v4-pro
provider: deepseek-proxy
```

Result: Codex CLI agent writes the file, then verifies it by running the script.

```
$ ls output/
lte_ofdm_simulation.py    (176 lines)

$ python output/lte_ofdm_simulation.py
LTE OFDM Downlink Simulation
==================================================
FFT size: 64
CP length: 16
Data subcarriers: 48
OFDM symbols: 14
SNR: 20 dB
Bit errors: 0 / 1344
BER: 0.000000e+00
```

### What Happens Inside the Proxy

1. **Codex CLI** sends `POST /v1/responses` with `{ model: "deepseek-v4-pro", input: "..." }`
2. **CORS middleware** checks origin (first in stack)
3. **Auth middleware** validates API key (optional, only if `CODEX_API_KEY` is set)
4. **Rate limiter** checks per-IP limits (100 req/min by default)
5. **Input validation** ensures `input` field is present
6. **Converter** translates OpenAI Responses format to DeepSeek Chat Completions format
7. **Connection pool** picks a reusable HTTP/HTTPS connection
8. **Circuit breaker** tracks upstream failures and prevents cascading
9. **DeepSeek API** receives the request and generates code
10. **Converter** translates the DeepSeek response back to OpenAI format
11. **Codex CLI** receives the standard OpenAI-format response
12. **Codex CLI agent** writes the code to a file and verifies it

## Using curl (Direct API Access)

For quick tests or scripting:

```bash
# Health check
curl http://localhost:8098/health

# Generate code (raw JSON response)
curl -s -X POST http://localhost:8098/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-pro",
    "input": "Write a Python script. Output only the code.",
    "stream": false
  }'
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/responses` | Main proxy endpoint |
| `POST` | `/responses` | Alternative (same handler) |
| `GET` | `/health` | Health check with component stats |
| `GET` | `/metrics` | Prometheus metrics |
| `POST` | `/v1/responses:batch` | Batch processing (up to 50 items) |
| WebSocket | `/ws` | Real-time streaming via JSON messages |

## Request Format (OpenAI Responses API)

```json
{
  "model": "deepseek-v4-pro",
  "input": "Write code for X",
  "stream": false
}
```

The proxy converts this to DeepSeek's Chat Completions format internally.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | DeepSeek API key (priority 1) |
| `ANTHROPIC_AUTH_TOKEN` | — | Alternative key source (priority 2, from Claude Code env config) |
| `ANTHROPIC_BASE_URL` | — | Base URL with `/anthropic` suffix (auto-stripped) |
| `OPENAI_API_KEY` | — | OpenAI API key fallback (priority 3) |
| `PORT` | `8098` | HTTP server port |
| `CORS_ORIGINS` | `*` | Allowed CORS origins (comma-separated) |
| `CODEX_API_KEY` | — | API key for client auth (optional) |
| `RATE_LIMIT_MAX` | `100` | Max requests per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in ms |

## Verification

```bash
# 1. Start the proxy
npm start

# 2. Health check
curl http://localhost:8098/health

# 3. Generate code via Codex CLI
codex exec -m deepseek-v4-pro "Python hello world"

# 4. Run the generated code
python hello_world.py
```

## Architecture Notes

- **Middleware order**: CORS → Request ID → Auth → Rate Limiter → Logging → Metrics → Routes
- **Connection pooling**: Separate pools for streaming and non-streaming requests
- **Caching**: 5-second TTL for non-streaming responses (deduplicates concurrent requests)
- **Circuit breaker**: Prevents cascading failures when DeepSeek is degraded
- **Memory monitoring**: Periodic heap checks with leak detection
