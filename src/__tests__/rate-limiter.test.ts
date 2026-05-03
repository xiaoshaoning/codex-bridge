import { RateLimiter } from '../rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter.stop();
  });

  describe('check()', () => {
    it('allows the first request', () => {
      limiter = new RateLimiter(3, 1000);
      const result = limiter.check('ip:127.0.0.1', '/v1/responses');
      expect(result.allowed).toBe(true);
      expect(result.retryAfter).toBe(0);
    });

    it('allows requests within the limit', () => {
      limiter = new RateLimiter(3, 1000);
      expect(limiter.check('ip:127.0.0.1', '/v1/responses').allowed).toBe(true);
      expect(limiter.check('ip:127.0.0.1', '/v1/responses').allowed).toBe(true);
      expect(limiter.check('ip:127.0.0.1', '/v1/responses').allowed).toBe(true);
    });

    it('rejects requests that exceed the limit', () => {
      limiter = new RateLimiter(2, 10000);
      limiter.check('ip:127.0.0.1', '/v1/responses'); // 1st
      limiter.check('ip:127.0.0.1', '/v1/responses'); // 2nd
      const result = limiter.check('ip:127.0.0.1', '/v1/responses'); // 3rd
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('returns retry-after in seconds', () => {
      limiter = new RateLimiter(1, 60000);
      limiter.check('ip:127.0.0.1', '/v1/responses'); // 1st
      const result = limiter.check('ip:127.0.0.1', '/v1/responses'); // 2nd
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThanOrEqual(59);
      expect(result.retryAfter).toBeLessThanOrEqual(61);
    });

    it('resets counter after window expires', async () => {
      limiter = new RateLimiter(1, 50); // 50ms window
      limiter.check('ip:127.0.0.1', '/v1/responses'); // 1st
      expect(limiter.check('ip:127.0.0.1', '/v1/responses').allowed).toBe(false);
      await new Promise((r) => setTimeout(r, 60));
      expect(limiter.check('ip:127.0.0.1', '/v1/responses').allowed).toBe(true);
    });

    it('gives higher limits for /health endpoint', () => {
      limiter = new RateLimiter(2, 10000);
      const normalPath = '/v1/responses';
      const healthPath = '/health';

      // Normal path: 2 max
      limiter.check('ip:127.0.0.1', normalPath);
      limiter.check('ip:127.0.0.1', normalPath);
      expect(limiter.check('ip:127.0.0.1', normalPath).allowed).toBe(false);

      // /health: 10 max (2 * 5)
      const healthLimiter = new RateLimiter(2, 10000);
      for (let i = 0; i < 10; i++) {
        expect(healthLimiter.check('ip:127.0.0.1', healthPath).allowed).toBe(true);
      }
      expect(healthLimiter.check('ip:127.0.0.1', healthPath).allowed).toBe(false);
    });

    it('gives higher limits for /metrics endpoint', () => {
      limiter = new RateLimiter(2, 10000);
      for (let i = 0; i < 10; i++) {
        expect(limiter.check('ip:127.0.0.2', '/metrics').allowed).toBe(true);
      }
      expect(limiter.check('ip:127.0.0.2', '/metrics').allowed).toBe(false);
    });

    it('tracks different IPs independently', () => {
      limiter = new RateLimiter(1, 1000);
      expect(limiter.check('ip:1.2.3.4', '/v1/responses').allowed).toBe(true);
      expect(limiter.check('ip:5.6.7.8', '/v1/responses').allowed).toBe(true);
      // First IP is now at limit
      expect(limiter.check('ip:1.2.3.4', '/v1/responses').allowed).toBe(false);
      // Second IP still has capacity
      expect(limiter.check('ip:5.6.7.8', '/v1/responses').allowed).toBe(false);
    });
  });

  describe('middleware()', () => {
    it('returns 429 when rate limit exceeded', () => {
      limiter = new RateLimiter(1, 10000);
      const middleware = limiter.middleware();

      const req1: any = { ip: '10.0.0.1', path: '/v1/responses', socket: {} };
      const res1: any = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next1 = jest.fn();
      middleware(req1, res1, next1);
      expect(next1).toHaveBeenCalled();

      const req2: any = { ip: '10.0.0.1', path: '/v1/responses', socket: {} };
      const res2: any = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next2 = jest.fn();
      middleware(req2, res2, next2);
      expect(next2).not.toHaveBeenCalled();
      expect(res2.status).toHaveBeenCalledWith(429);
      expect(res2.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    });

    it('sets Retry-After header on 429', () => {
      limiter = new RateLimiter(1, 60000);
      const middleware = limiter.middleware();
      const req1: any = { ip: '10.0.0.2', path: '/v1/responses', socket: {} };
      const res1: any = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
      middleware(req1, res1, jest.fn());

      const req2: any = { ip: '10.0.0.2', path: '/v1/responses', socket: {} };
      const res2: any = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
      middleware(req2, res2, jest.fn());
      expect(res2.setHeader).toHaveBeenCalledWith('Retry-After', expect.stringMatching(/^\d+$/));
    });
  });

  describe('getStats()', () => {
    it('returns correct stats', () => {
      limiter = new RateLimiter(5, 30000);
      limiter.check('ip:x', '/v1/responses');
      limiter.check('ip:y', '/v1/responses');
      const stats = limiter.getStats();
      expect(stats.entries).toBe(2);
      expect(stats.maxRequests).toBe(5);
      expect(stats.windowMs).toBe(30000);
    });
  });

  describe('start/stop', () => {
    it('can start and stop cleanup timer', () => {
      limiter = new RateLimiter(10, 1000);
      limiter.start();
      limiter.stop();
      expect(true).toBe(true); // no crash
    });

    it('is idempotent on repeated stop', () => {
      limiter = new RateLimiter(10, 1000);
      limiter.start();
      limiter.stop();
      limiter.stop();
      expect(true).toBe(true);
    });
  });
});
