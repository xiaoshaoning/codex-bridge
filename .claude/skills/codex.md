---
name: codex
description: Generate code using OpenAI Codex CLI routed through the Codex Bridge proxy to DeepSeek models
---

## Overview

OpenAI Codex CLI is an agentic coding tool that generates projects from natural language descriptions. When routed through Codex Bridge, it uses DeepSeek as the backend model.

## Prerequisites

- Codex Bridge proxy running (`npm start`)
- Codex CLI installed (see https://github.com/openai/codex)
- DeepSeek API key set on the bridge (`export DEEPSEEK_API_KEY=sk-...` before `npm start`)

## Configuration

Codex CLI must be configured to use the bridge. Edit `~/.codex/config.toml`:

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
| `requires_openai_auth` | `false` | Proxy handles auth via `DEEPSEEK_API_KEY` |
| `wire_api` | `responses` | Uses OpenAI Responses API format |

Available models: `deepseek-v4-pro`, `deepseek-v4-flash`

## Usage

Generate code with a natural language prompt:

```bash
codex exec "Write a Python script that does X"
```

Specify the model explicitly:

```bash
codex exec -m deepseek-v4-pro "Build a CLI tool that..."
codex exec -m deepseek-v4-flash "Quick script to..."
```

## What Happens

1. Codex CLI sends `POST /v1/responses` to the bridge
2. Bridge converts the request to DeepSeek Chat Completions format
3. DeepSeek generates the response
4. Bridge converts back to OpenAI Responses API format
5. Codex CLI agent writes files and verifies them

## Tips

- The bridge must be running before invoking `codex exec`
- Generated files appear in the project directory
- Start with small prompts to validate the pipeline
