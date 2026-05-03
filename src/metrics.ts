import promClient from 'prom-client';

// Register default metrics (CPU, memory, event loop lag, etc.)
promClient.collectDefaultMetrics({
  prefix: 'codex_bridge_',
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 5],
});

// HTTP request counter
export const httpRequestTotal = new promClient.Counter({
  name: 'codex_bridge_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status_code'],
});

// HTTP request duration histogram
export const httpRequestDuration = new promClient.Histogram({
  name: 'codex_bridge_http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'path'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

// Active requests gauge
export const activeRequests = new promClient.Gauge({
  name: 'codex_bridge_http_active_requests',
  help: 'Number of currently active HTTP requests',
});

// DeepSeek upstream request duration histogram
export const upstreamRequestDuration = new promClient.Histogram({
  name: 'codex_bridge_upstream_request_duration_ms',
  help: 'Upstream DeepSeek API request duration in milliseconds',
  labelNames: ['type'], // streaming or non-streaming
  buckets: [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000],
});

// Cache metrics
export const cacheHitsTotal = new promClient.Counter({
  name: 'codex_bridge_cache_hits_total',
  help: 'Total number of cache hits',
});

export const cacheMissesTotal = new promClient.Counter({
  name: 'codex_bridge_cache_misses_total',
  help: 'Total number of cache misses',
});

export const cacheSize = new promClient.Gauge({
  name: 'codex_bridge_cache_size',
  help: 'Current number of entries in cache',
  labelNames: ['cache_name'],
});

// Circuit breaker metrics
export const circuitBreakerState = new promClient.Gauge({
  name: 'codex_bridge_circuit_breaker_state',
  help: 'Current state of the circuit breaker (0=closed, 1=half-open, 2=open)',
});

export const circuitBreakerFailuresTotal = new promClient.Counter({
  name: 'codex_bridge_circuit_breaker_failures_total',
  help: 'Total number of circuit breaker failures',
});

// Connection pool metrics
export const connectionPoolSize = new promClient.Gauge({
  name: 'codex_bridge_connection_pool_size',
  help: 'Number of active connection pools',
});

export const streamingRequestDuration = new promClient.Histogram({
  name: 'codex_bridge_streaming_duration_ms',
  help: 'Total duration of streaming requests in milliseconds',
  buckets: [500, 1000, 2000, 5000, 10000, 30000, 60000, 120000],
});

export const streamChunksTotal = new promClient.Counter({
  name: 'codex_bridge_stream_chunks_total',
  help: 'Total number of stream chunks processed',
});

// Memory metrics (supplement default metrics with heap usage ratio)
export const heapUsagePercent = new promClient.Gauge({
  name: 'codex_bridge_heap_usage_percent',
  help: 'Current heap usage percentage',
});

// Function to update heap usage periodically
export function updateHeapUsage(): void {
  const memoryUsage = process.memoryUsage();
  const percent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;
  heapUsagePercent.set(percent);
}

// Generate metrics response
export async function getMetricsResponse(): Promise<string> {
  updateHeapUsage();
  return promClient.register.metrics();
}

// Return Content-Type for metrics response
export function getMetricsContentType(): string {
  return promClient.register.contentType;
}
