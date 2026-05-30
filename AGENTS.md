# Codex Bridge - DeepSeek Proxy

A TypeScript proxy server that converts OpenAI Responses API requests to DeepSeek Chat Completions API.

## Project Overview

This is a translation of the Python proxy server (`deepseek_proxy.py`) to TypeScript. The server acts as a bridge between OpenAI's Responses API format and DeepSeek's Chat Completions API.

## Key Features

- Converts OpenAI Responses API requests to DeepSeek Chat Completions format
- Supports both streaming and non-streaming responses
- Handles tool/function call conversions
- Parses XML function calls from DeepSeek responses
- Maps model names between OpenAI and DeepSeek
- Provides health check endpoint
- Graceful shutdown with signal handling (SIGTERM, SIGINT) and optional HTTP shutdown endpoint

## API Endpoints

- `POST /v1/responses` - Main proxy endpoint
- `POST /responses` - Alternative endpoint  
- `GET /health` - Health check
- `POST /shutdown` - Graceful shutdown endpoint (requires SHUTDOWN_SECRET environment variable and X-Shutdown-Secret header)

## Environment Variables

- `DEEPSEEK_API_KEY` - DeepSeek API key (primary)
- `OPENAI_API_KEY` - OpenAI API key (fallback)
- `SHUTDOWN_SECRET` - Optional secret for HTTP shutdown endpoint (if set, enables POST /shutdown)

## Development

The project uses TypeScript with Express.js. Key files:

- `src/server.ts` - Main server file
- `src/converter.ts` - Request/response conversion logic
- `src/streaming.ts` - Streaming response handling

## Code Style

- TypeScript with strict typing
- Snake case naming for variables and functions
- No Chinese comments
- Error handling with proper HTTP status codes

## Running the Server

```bash
npm start
```

For development:
```bash
npm run dev
```