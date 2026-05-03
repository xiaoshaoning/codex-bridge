import express, { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import util from 'util';
import { randomBytes } from 'crypto';

// Configure logging
import { createLogger, format, transports } from 'winston';
import { promises as fs } from 'fs';
import path from 'path';
import { CacheManager } from './cache-manager';
import { MemoryMonitor } from './memory-monitor';
import { ConnectionPool } from './connection-pool';
import {
  handle_streaming_response,
  handle_non_streaming_response,
  circuitBreaker
} from './streaming';
import { setup_websocket_server } from './websocket';
import { cors_middleware } from './cors';
import { api_key_middleware } from './auth';
import { rateLimiter } from './rate-limiter';
import { handle_batch_request } from './batch';
import { handle_webhook_request } from './webhook';
import { pluginRegistry } from './plugin-system';
import './plugins/deepseek-plugin'; // registers DeepSeek plugin on load
import {
  activeRequests,
  httpRequestTotal,
  httpRequestDuration,
  updateHeapUsage,
  getMetricsResponse,
  getMetricsContentType
} from './metrics';
const { combine, timestamp, printf } = format;

// Extended log format that includes request ID when available
const log_format = printf(({ level, message, timestamp, ...metadata }) => {
  const reqId = metadata.reqId || '';
  const reqIdStr = reqId ? `[${reqId}] ` : '';
  // Include additional metadata if present
  const metaStr = Object.keys(metadata)
    .filter(key => key !== 'reqId' && metadata[key] !== undefined)
    .map(key => `${key}=${metadata[key]}`)
    .join(' ');
  return `${timestamp} - ${level}: ${reqIdStr}${message}${metaStr ? ' ' + metaStr : ''}`;
});

// Generate a unique request ID
function generate_request_id(): string {
  return `req_${randomBytes(4).toString('hex')}`;
}

// Create a logger wrapper that automatically adds request ID to all log entries
function create_logger_with_request_id(base_logger: any, request_id: string): any {
  return {
    debug: (message: string, meta?: any) => base_logger.debug(message, { ...meta, reqId: request_id }),
    info: (message: string, meta?: any) => base_logger.info(message, { ...meta, reqId: request_id }),
    warn: (message: string, meta?: any) => base_logger.warn(message, { ...meta, reqId: request_id }),
    error: (message: string, meta?: any) => base_logger.error(message, { ...meta, reqId: request_id }),
    // Pass through other properties if needed
    log: (level: string, message: string, meta?: any) => base_logger.log(level, message, { ...meta, reqId: request_id }),
  };
}

// Create log directory if it doesn't exist
const log_dir = 'log';
(async () => {
  try {
    await fs.mkdir(log_dir, { recursive: true });
  } catch (error) {
    console.error(`Failed to create log directory: ${error}`);
  }
})();

const logger = createLogger({
  level: 'debug',
  format: combine(
    timestamp(),
    log_format
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: path.join(log_dir, 'proxy.log') })
  ]
});

const app = express();
app.use(express.json({ limit: '50mb' }));

// CORS middleware — must be first to handle preflight
app.use(cors_middleware);

// Initialize memory monitor
const memoryMonitor = new MemoryMonitor({
  checkInterval: 60000,           // Check every minute
  highMemoryThreshold: 90,        // Warn when memory > 90%
  logInterval: 300000,            // Log every 5 minutes
  enableLeakDetection: true,
  leakDetectionWindow: 600000,    // 10 minute window
  maxHeapUsageIncrease: 30        // Max 30% increase in 10 minutes
}, logger);

// Helper to safely extract serializable error data from upstream response
function extract_safe_error_data(data: any): any {
  if (!data || typeof data !== 'object') {
    // Pass through simple string/number errors
    return { error: { message: String(data || 'Unknown upstream error'), type: 'api_error', code: 'bad_gateway' } };
  }
  // If data has error field, return that (OpenAI-compatible format)
  if (data.error && typeof data.error === 'object') {
    return { error: data.error };
  }
  // If data has message field, return simple error
  if (data.message) {
    return { error: { message: data.message, type: data.type || 'api_error', code: data.code || 'unknown' } };
  }
  // Serialize whatever we got so the client can see the actual upstream response
  const data_str = JSON.stringify(data).substring(0, 500);
  return {
    error: {
      message: data_str,
      type: "api_error",
      code: "bad_gateway"
    }
  };
}

// Request ID middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  // Generate or extract request ID from header
  const request_id_header = req.headers['x-request-id'] || req.headers['x-correlation-id'];
  const request_id = typeof request_id_header === 'string' ? request_id_header : generate_request_id();

  // Attach to request and response
  (req as any).requestId = request_id;
  res.setHeader('X-Request-Id', request_id);

  next();
});

// API key authentication middleware
app.use(api_key_middleware);

// Rate limiter middleware
rateLimiter.start();
app.use(rateLimiter.middleware());

// Log all requests
app.use((req: Request, _res: Response, next: NextFunction) => {
  const request_id = (req as any).requestId;
  logger.info(`Incoming ${req.method} request to ${req.path}`, { reqId: request_id });
  logger.info(`Headers: ${JSON.stringify(req.headers)}`, { reqId: request_id });
  logger.info(`Content-Type: ${req.get('Content-Type')}`, { reqId: request_id });
  if (req.get('Content-Length')) {
    logger.info(`Content-Length: ${req.get('Content-Length')}`, { reqId: request_id });
  }
  if (req.method === 'POST') {
    try {
      const body_data = JSON.stringify(req.body);
      if (body_data) {
        logger.info(`Body preview (first 500 chars): ${body_data.substring(0, 500)}`, { reqId: request_id });
      }
    } catch (e) {
      logger.info(`Could not read body: ${e}`, { reqId: request_id });
    }
  }
  next();
});

// Metrics middleware — track HTTP request metrics
app.use((req: Request, res: Response, next: NextFunction) => {
  activeRequests.inc();
  const startEpoch = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startEpoch;
    const path = req.path || 'unknown';
    const method = req.method || 'UNKNOWN';
    const status = res.statusCode?.toString() || '000';

    httpRequestTotal.labels(method, path, status).inc();
    httpRequestDuration.labels(method, path).observe(duration);
    activeRequests.dec();
  });

  next();
});

// Cache manager singleton
const cacheManager = new CacheManager();

function validate_responses_body(req: Request, res: Response, next: NextFunction): void {
  const data = req.body;
  if (!data || !data.input) {
    res.status(400).json({
      error: {
        message: 'Missing required field: input',
        type: 'validation_error',
        code: 'bad_request',
      },
    });
    return;
  }
  if (data.model !== undefined && typeof data.model !== 'string') {
    res.status(400).json({
      error: {
        message: 'Field "model" must be a string',
        type: 'validation_error',
        code: 'bad_request',
      },
    });
    return;
  }
  if (data.tools !== undefined && !Array.isArray(data.tools)) {
    res.status(400).json({
      error: {
        message: 'Field "tools" must be an array',
        type: 'validation_error',
        code: 'bad_request',
      },
    });
    return;
  }
  next();
}

app.post('/v1/responses', validate_responses_body, responses_proxy);
app.post('/responses', validate_responses_body, responses_proxy);

app.post('/v1/responses:batch', async (req: Request, res: Response) => {
  const request_id = (req as any).requestId || generate_request_id();
  const loggerWithReqId = create_logger_with_request_id(logger, request_id);
  res.setHeader('X-Request-Id', request_id);
  try {
    await handle_batch_request(req, res, loggerWithReqId);
  } catch (error) {
    handle_error(error, res, loggerWithReqId, request_id);
  }
});

async function responses_proxy(req: Request, res: Response) {
  const start_time = Date.now();
  const request_id = (req as any).requestId;
  const loggerWithReqId = create_logger_with_request_id(logger, request_id);

  // Handle webhook callback — return 202 immediately, deliver async
  if (req.body.webhook) {
    await handle_webhook_request(req, res, loggerWithReqId, request_id);
    return;
  }

  try {
    const data = req.body;
    loggerWithReqId.info(`Received request, model: ${data.model || 'unknown'}, stream: ${data.stream || false}`);
    loggerWithReqId.info(`DEBUG data keys: ${Object.keys(data)}`);
    loggerWithReqId.info(`DEBUG stream value: ${data.stream}, type: ${typeof data.stream}`);
    console.log(`PROXY: Received request, model: ${data.model || 'unknown'}`);

    // Write request to file for debugging
    const fs = await import('fs');
    fs.writeFileSync(path.join(log_dir, 'request_debug_new.json'), JSON.stringify(data, null, 2), 'utf-8');

    // Resolve converter plugin for the requested model
    const modelName = data.model || 'deepseek-v4-pro';
    const plugin = pluginRegistry.getPluginForModel(modelName) || pluginRegistry.getPlugin('deepseek');
    if (!plugin) {
      res.status(400).json({
        error: { message: `No converter plugin found for model: ${modelName}`, type: 'invalid_request', code: 'bad_request' }
      });
      return;
    }

    const converted_data = plugin.convertRequest(data, loggerWithReqId);
    const stream = converted_data.stream || false;

    // Use plugin's auth headers and API URL
    const headers: any = {
      ...plugin.getAuthHeaders(),
      'Content-Type': 'application/json',
      'Accept': stream ? 'text/event-stream' : 'application/json',
      'Accept-Encoding': 'gzip, deflate'
    };

    const target_url = `${plugin.getApiUrl()}/v1/chat/completions`;
    logger.info(`Forwarding to ${target_url}, stream=${stream}`, { reqId: request_id });
    res.setHeader('X-Codex-Bridge', 'test');
    // Also set X-Request-Id header if not already set
    if (!res.hasHeader('X-Request-Id')) {
      res.setHeader('X-Request-Id', request_id);
    }

    if (stream) {
      await handle_streaming_response(target_url, converted_data, headers, data, res, loggerWithReqId, start_time, plugin);
    } else {
      // Generate cache key for non-streaming requests
      const cacheKey = cacheManager.generateCacheKey(req);
      loggerWithReqId.info(`Cache key: ${cacheKey}`);

      // Try to get from cache or execute request
      const cachedResponse = await cacheManager.getOrSet(cacheKey, async () => {
        loggerWithReqId.info(`Cache miss, calling DeepSeek API`);
        const response = await handle_non_streaming_response(target_url, converted_data, headers, data, res, loggerWithReqId, start_time, plugin);
        // handle_non_streaming_response returns null if response already sent (streaming simulated)
        // or returns response data for non-streaming
        return response;
      }, 5); // 5 second TTL

      // If cachedResponse is not null and not already sent, send it
      if (cachedResponse !== null && cachedResponse !== undefined) {
        loggerWithReqId.info(`Sending cached response`);
        res.status(200).json(cachedResponse);
      } else if (cachedResponse === null) {
        loggerWithReqId.info(`Response already sent as simulated SSE`);
        // Response already sent by handle_non_streaming_response
      }
    }
  } catch (error) {
    handle_error(error, res, loggerWithReqId, request_id);
  }
}

function handle_error(error: any, res: Response, logger: any, request_id?: string): void {
  const logMeta = request_id ? { reqId: request_id } : {};

  // Upstream API returned an error status (thrown by streaming.ts with statusCode + upstreamData)
  if (error && error.statusCode && error.upstreamData !== undefined) {
    const upstream_summary = typeof error.upstreamData === 'object'
      ? JSON.stringify(error.upstreamData).substring(0, 500)
      : String(error.upstreamData).substring(0, 500);
    logger.error(`Upstream API error ${error.statusCode}: ${upstream_summary}`, logMeta);
    const safe_data = extract_safe_error_data(error.upstreamData);
    res.status(error.statusCode).json(safe_data);
    return;
  }

  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED') {
      logger.error(`Request timeout: ${error.message || error}`, logMeta);
      const error_response = {
        error: {
          message: "Request to DeepSeek API timed out",
          type: "timeout_error",
          code: "gateway_timeout"
        }
      };
      res.status(504).json(error_response);
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      logger.error(`Connection error: ${error.message || error}`, logMeta);
      const error_response = {
        error: {
          message: "Cannot connect to DeepSeek API",
          type: "connection_error",
          code: "bad_gateway"
        }
      };
      res.status(502).json(error_response);
    } else {
      const status = error.response?.status || 500;
      const error_body = error.response?.data ? util.inspect(error.response.data, {depth: 2, maxArrayLength: 5}).substring(0, 1000) : '';
      logger.error(`DeepSeek API error ${status}: ${error_body}`, logMeta);
      const safe_data = extract_safe_error_data(error.response?.data);
      res.status(status).json(safe_data);
    }
  } else if (error instanceof SyntaxError) {
    logger.error(`JSON decode error: ${error.message || error}`, logMeta);
    const error_response = {
      error: {
        message: "Invalid JSON in request or response",
        type: "invalid_json",
        code: "bad_request"
      }
    };
    res.status(400).json(error_response);
  } else if (error instanceof TypeError || error instanceof RangeError) {
    logger.error(`Invalid data format: ${error.message || error}`, logMeta);
    const error_response = {
      error: {
        message: `Invalid request data: ${error.message}`,
        type: "invalid_request",
        code: "bad_request"
      }
    };
    res.status(400).json(error_response);
  } else {
    logger.error(`Unexpected error processing request: ${error.message || error}`, logMeta);
    const error_response = {
      error: {
        message: "Internal server error",
        type: "internal_error",
        code: "internal_server_error"
      }
    };
    res.status(500).json(error_response);
  }
}



app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const metrics = await getMetricsResponse();
    res.setHeader('Content-Type', getMetricsContentType());
    res.send(metrics);
  } catch (error) {
    logger.error(`Failed to generate metrics: ${error}`);
    res.status(500).json({ error: 'Failed to generate metrics' });
  }
});

app.get('/health', (_req: Request, res: Response) => {
  const memoryStats = MemoryMonitor.getQuickStats();
  const cacheStats = cacheManager.getStats();
  const cbStats = circuitBreaker.getStats();
  const poolClientCount = ConnectionPool.getInstance().getClientCount();
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    memory: memoryStats,
    cache: cacheStats,
    circuitBreaker: cbStats,
    connectionPool: {
      clientCount: poolClientCount
    },
    uptime: process.uptime(),
    version: "1.0.0"
  });
});

// Graceful shutdown functionality
let server: any = null;
const shutdown_secret = process.env.SHUTDOWN_SECRET || '';
let is_shutting_down = false;
let force_shutdown_timeout: NodeJS.Timeout | null = null;

function graceful_shutdown(signal: string) {
  return () => {
    if (is_shutting_down) {
      logger.info(`Shutdown already in progress, ignoring ${signal}`);
      return;
    }
    is_shutting_down = true;
    logger.info(`Received ${signal}, initiating graceful shutdown...`);

    // Stop memory monitor
    if (memoryMonitor) {
      memoryMonitor.stop();
      logger.info('Memory monitor stopped');
    }

    if (server) {
      server.close(() => {
        logger.info('HTTP server closed');
        if (force_shutdown_timeout) {
          clearTimeout(force_shutdown_timeout);
          force_shutdown_timeout = null;
        }
        // Wait for logs to flush before exiting
        logger.on('finish', () => {
          process.exit(0);
        });
        logger.end();
      });
      // Force close after 10 seconds
      force_shutdown_timeout = setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 10000);
    } else {
      process.exit(0);
    }
  };
}

// Handle termination signals
process.on('SIGTERM', graceful_shutdown('SIGTERM'));
process.on('SIGINT', graceful_shutdown('SIGINT'));

// Optional shutdown endpoint (requires SHUTDOWN_SECRET environment variable)
if (shutdown_secret) {
  app.post('/shutdown', (req: Request, res: Response) => {
    const provided_secret = req.headers['x-shutdown-secret'];
    if (provided_secret === shutdown_secret) {
      if (is_shutting_down) {
        logger.info('Shutdown already in progress, ignoring duplicate request');
        res.json({ status: 'shutdown already in progress' });
        return;
      }
      logger.info('Shutdown requested via HTTP endpoint');
      res.json({ status: 'shutting down' });
      setTimeout(() => {
        graceful_shutdown('HTTP')();
      }, 100);
    } else {
      logger.warn('Unauthorized shutdown attempt');
      res.status(403).json({ error: 'Forbidden' });
    }
  });
  logger.info('Shutdown endpoint enabled at POST /shutdown (requires X-Shutdown-Secret header)');
}

const port = parseInt(process.env.PORT || '8098');
server = app.listen(port, () => {
  logger.info(`=== Starting DeepSeek proxy server (TypeScript version) ===`);
  logger.info(`Starting DeepSeek proxy server on port ${port}`);

  // Start memory monitoring
  memoryMonitor.start();
  logger.info('Memory monitor started');

  // Periodic Prometheus heap metric update
  setInterval(() => {
    updateHeapUsage();
  }, 30000);
});

// Setup WebSocket server
setup_websocket_server(server, logger);
logger.info('WebSocket server enabled at /ws');

export default app;
export { server };