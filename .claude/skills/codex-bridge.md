---
name: codex-bridge
description: Start, manage, and interact with the Codex Bridge proxy server (OpenAI Responses API ↔ DeepSeek Chat Completions)
---

## Overview

Codex Bridge is a TypeScript proxy server that converts OpenAI Responses API requests to DeepSeek Chat Completions API. It allows OpenAI-compatible clients like Codex CLI to use DeepSeek models.

## Quick Start

**The API key must be set before starting the bridge.** There is no hard-coded fallback.

```bash
# Set your DeepSeek API key first
export DEEPSEEK_API_KEY=sk-your-key-here

# Then start the server
npm start

# Development mode with auto-reload
npm run dev
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | DeepSeek API key (**required** — no fallback) |
| `ANTHROPIC_AUTH_TOKEN` | — | Alternative key source (from Claude Code env config) |
| `ANTHROPIC_BASE_URL` | — | Base URL with `/anthropic` suffix (auto-stripped) |
| `OPENAI_API_KEY` | — | Fallback API key (used if above are unset) |
| `PORT` | `8098` | Server port |

The bridge checks keys in this order: `DEEPSEEK_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `OPENAI_API_KEY`

## Stopping the Server

```bash
# In the foreground terminal: press Ctrl+C
# The server shuts down gracefully (drains connections, flushes logs)

# If running in the background, find and kill the process:
kill $(lsof -ti:8098)        # macOS/Linux
# or via the HTTP shutdown endpoint (requires SHUTDOWN_SECRET):
# curl -X POST http://localhost:8098/shutdown -H "X-Shutdown-Secret: your-secret"
```

## Health Check

```bash
curl http://localhost:8098/health
```

## Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check with component stats |
| `GET` | `/metrics` | Prometheus metrics |
| `POST` | `/v1/responses` | Main proxy endpoint |
| WebSocket | `/ws` | Real-time streaming |

## Common Tasks

- **Run tests**: `npm test`
- **Type check**: `npx tsc --noEmit`
- **Build**: `npm run build`
- **Docker**: `docker compose up --build`
- **Regression test**: `bash scripts/codex-regression.sh`

## Middleware Stack

CORS → Request ID → Auth → Rate Limiter → Logging → Metrics → Routes

## Converting Requests

The bridge accepts OpenAI Responses API format and converts internally to DeepSeek Chat Completions format, then translates the response back.
