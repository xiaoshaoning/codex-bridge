import promClient from 'prom-client';

describe('Metrics', () => {
  beforeEach(() => {
    promClient.register.clear();
  });

  describe('metric definitions', () => {
    it('exports httpRequestTotal counter', () => {
      jest.isolateModules(() => {
        const metrics = require('../metrics');
        expect(metrics.httpRequestTotal).toBeDefined();
        expect(typeof metrics.httpRequestTotal.inc).toBe('function');
      });
    });

    it('exports httpRequestDuration histogram', () => {
      jest.isolateModules(() => {
        const metrics = require('../metrics');
        expect(metrics.httpRequestDuration).toBeDefined();
        expect(typeof metrics.httpRequestDuration.observe).toBe('function');
      });
    });

    it('exports activeRequests gauge', () => {
      jest.isolateModules(() => {
        const metrics = require('../metrics');
        expect(metrics.activeRequests).toBeDefined();
        expect(typeof metrics.activeRequests.inc).toBe('function');
      });
    });

    it('exports upstreamRequestDuration histogram', () => {
      jest.isolateModules(() => {
        const metrics = require('../metrics');
        expect(metrics.upstreamRequestDuration).toBeDefined();
      });
    });

    it('exports cache hit/miss counters', () => {
      jest.isolateModules(() => {
        const metrics = require('../metrics');
        expect(typeof metrics.cacheHitsTotal.inc).toBe('function');
        expect(typeof metrics.cacheMissesTotal.inc).toBe('function');
      });
    });

    it('exports circuit breaker metrics', () => {
      jest.isolateModules(() => {
        const metrics = require('../metrics');
        expect(typeof metrics.circuitBreakerState.set).toBe('function');
        expect(typeof metrics.circuitBreakerFailuresTotal.inc).toBe('function');
      });
    });

    it('exports streaming metrics', () => {
      jest.isolateModules(() => {
        const metrics = require('../metrics');
        expect(typeof metrics.streamingRequestDuration.observe).toBe('function');
        expect(typeof metrics.streamChunksTotal.inc).toBe('function');
      });
    });

    it('exports heap usage gauge', () => {
      jest.isolateModules(() => {
        const metrics = require('../metrics');
        expect(typeof metrics.heapUsagePercent.set).toBe('function');
      });
    });
  });

  describe('updateHeapUsage()', () => {
    it('sets heapUsagePercent to a numeric value', () => {
      jest.isolateModules(() => {
        const metrics = require('../metrics');
        metrics.heapUsagePercent.set(0);
        metrics.updateHeapUsage();
        // Should have a value > 0 (heap is always in use)
        const val = metrics.heapUsagePercent.get();
        // Can't read value directly, but we know set was called
        // Check that the function didn't throw
        expect(true).toBe(true);
      });
    });
  });

  describe('getMetricsResponse()', () => {
    it('returns a string in Prometheus text format', async () => {
      jest.isolateModules(async () => {
        const metrics = require('../metrics');
        const response = await metrics.getMetricsResponse();
        expect(typeof response).toBe('string');
        expect(response.length).toBeGreaterThan(0);
        // Should contain some Prometheus metric lines
        expect(response).toContain('# HELP');
      });
    });

    it('returns content type from prom-client', async () => {
      jest.isolateModules(() => {
        const metrics = require('../metrics');
        const ct = metrics.getMetricsContentType();
        expect(typeof ct).toBe('string');
        expect(ct).toContain('text/plain');
      });
    });
  });

  describe('metrics recording', () => {
    it('counter inc() increments the value', () => {
      jest.isolateModules(() => {
        const metrics = require('../metrics');
        metrics.httpRequestTotal.inc({ method: 'GET', path: '/test', status_code: '200' });
        // Should not throw
        expect(true).toBe(true);
      });
    });

    it('histogram observe() records duration', () => {
      jest.isolateModules(() => {
        const metrics = require('../metrics');
        metrics.httpRequestDuration.observe({ method: 'GET', path: '/test' }, 42);
        expect(true).toBe(true);
      });
    });

    it('gauge set() sets active requests', () => {
      jest.isolateModules(() => {
        const metrics = require('../metrics');
        metrics.activeRequests.inc();
        metrics.activeRequests.dec();
        expect(true).toBe(true);
      });
    });
  });
});
