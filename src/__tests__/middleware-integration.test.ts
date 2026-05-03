import request from 'supertest';
import express from 'express';
import http from 'http';

// Mock axios for all tests
jest.mock('axios', () => {
  const mockAxiosInstance = {
    post: jest.fn().mockResolvedValue({ status: 200, data: {} }),
    get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
    defaults: { headers: { common: {} } }
  };
  const mockAxios = Object.assign(
    jest.fn().mockResolvedValue({ status: 200, data: {} }),
    {
      create: jest.fn().mockReturnValue(mockAxiosInstance),
      isAxiosError: jest.fn().mockReturnValue(false),
      interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
      defaults: { headers: { common: {} } }
    }
  );
  return mockAxios;
});

describe('Middleware Chain', () => {
  describe('CORS', () => {
    let app: express.Application;
    let server: http.Server;

    beforeAll(() => {
      process.env.CORS_ORIGINS = 'http://trusted-origin.com';
      process.env.PORT = '0';
      jest.isolateModules(() => {
        const mod = require('../server');
        app = mod.default;
        server = mod.server;
      });
    });

    afterAll(() => {
      delete process.env.CORS_ORIGINS;
      delete process.env.PORT;
      if (server) server.close();
    });

    it('responds to OPTIONS preflight with 204', async () => {
      const res = await request(app)
        .options('/v1/responses')
        .set('Origin', 'http://trusted-origin.com')
        .set('Access-Control-Request-Method', 'POST');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://trusted-origin.com');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers['access-control-allow-headers']).toContain('Content-Type');
      expect(res.headers['access-control-max-age']).toBeDefined();
    });

    it('rejects OPTIONS from untrusted origin', async () => {
      const res = await request(app)
        .options('/v1/responses')
        .set('Origin', 'http://evil-site.com');

      expect(res.status).toBe(204);
      // Should NOT set CORS headers for untrusted origin
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('Input Validation', () => {
    let app: express.Application;
    let server: http.Server;

    beforeAll(() => {
      process.env.PORT = '0';
      jest.isolateModules(() => {
        const mod = require('../server');
        app = mod.default;
        server = mod.server;
      });
    });

    afterAll(() => {
      delete process.env.PORT;
      if (server) server.close();
    });

    it('returns 400 when input field is missing', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .send({ model: 'deepseek-chat' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('bad_request');
      expect(res.body.error.message).toContain('input');
    });

    it('returns 400 when input field is null', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .send({ model: 'deepseek-chat', input: null });

      expect(res.status).toBe(400);
    });

    it('returns 400 when model is not a string', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .send({ model: 123, input: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('model');
    });

    it('returns 400 when tools is not an array', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .send({ model: 'deepseek-chat', input: 'test', tools: 'not-an-array' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('tools');
    });

    it('returns 400 for malformed JSON body', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .set('Content-Type', 'application/json')
        .send('not json');

      expect(res.status).toBe(400);
    });

    it('accepts valid request body', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .send({ model: 'deepseek-chat', input: 'hello' });

      expect(res.status).not.toBe(400);
    });
  });

  describe('Authentication', () => {
    let app: express.Application;
    let server: http.Server;

    beforeAll(() => {
      process.env.CODEX_API_KEY = 'test-secret-key';
      process.env.PORT = '0';
      jest.isolateModules(() => {
        const mod = require('../server');
        app = mod.default;
        server = mod.server;
      });
    });

    afterAll(() => {
      delete process.env.CODEX_API_KEY;
      delete process.env.PORT;
      if (server) server.close();
    });

    it('returns 401 when no auth header is provided', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .send({ model: 'deepseek-chat', input: 'hello' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    });

    it('returns 401 with invalid Bearer token', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .set('Authorization', 'Bearer wrong-key')
        .send({ model: 'deepseek-chat', input: 'hello' });

      expect(res.status).toBe(401);
    });

    it('accepts request with valid Bearer token', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .set('Authorization', 'Bearer test-secret-key')
        .send({ model: 'deepseek-chat', input: 'hello' });

      expect(res.status).not.toBe(401);
    });

    it('accepts request with valid X-API-Key header', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .set('X-API-Key', 'test-secret-key')
        .send({ model: 'deepseek-chat', input: 'hello' });

      expect(res.status).not.toBe(401);
    });

    it('allows unauthenticated access to /health', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    });

    it('allows unauthenticated access to /metrics', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
    });
  });

  describe('Rate Limiting', () => {
    let app: express.Application;
    let server: http.Server;

    beforeAll(() => {
      process.env.CODEX_API_KEY = 'test-secret-key';
      process.env.RATE_LIMIT_MAX = '2';
      process.env.RATE_LIMIT_WINDOW_MS = '10000';
      process.env.PORT = '0';
      jest.isolateModules(() => {
        const mod = require('../server');
        app = mod.default;
        server = mod.server;
      });
    });

    afterAll(() => {
      delete process.env.CODEX_API_KEY;
      delete process.env.RATE_LIMIT_MAX;
      delete process.env.RATE_LIMIT_WINDOW_MS;
      delete process.env.PORT;
      if (server) server.close();
    });

    it('allows requests within the rate limit', async () => {
      const res1 = await request(app)
        .post('/v1/responses')
        .set('Authorization', 'Bearer test-secret-key')
        .send({ model: 'deepseek-chat', input: 'ok-1' });
      expect(res1.status).not.toBe(429);

      const res2 = await request(app)
        .post('/v1/responses')
        .set('Authorization', 'Bearer test-secret-key')
        .send({ model: 'deepseek-chat', input: 'ok-2' });
      expect(res2.status).not.toBe(429);
    });

    it('returns 429 when rate limit exceeded', async () => {
      // Per-IP global window already has 2 entries, so this 3rd should be 429
      const res = await request(app)
        .post('/v1/responses')
        .set('Authorization', 'Bearer test-secret-key')
        .send({ model: 'deepseek-chat', input: 'too-many' });

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('too_many_requests');
      expect(res.headers['retry-after']).toBeDefined();
    });
  });

  describe('Webhook', () => {
    let app: express.Application;
    let server: http.Server;

    beforeAll(() => {
      process.env.PORT = '0';
      jest.isolateModules(() => {
        const mod = require('../server');
        app = mod.default;
        server = mod.server;
      });
    });

    afterAll(() => {
      delete process.env.PORT;
      if (server) server.close();
    });

    it('returns 202 when webhook is provided', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .send({
          model: 'deepseek-chat',
          input: 'hello',
          webhook: 'https://hooks.example.com/cb',
        });

      expect(res.status).toBe(202);
      expect(res.body.status).toBe('processing');
      expect(res.body.id).toBeDefined();
    });

    it('returns 400 for invalid webhook URL', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .send({
          model: 'deepseek-chat',
          input: 'hello',
          webhook: 'not-a-url',
        });

      expect(res.status).toBe(400);
    });
  });

  describe('Batch', () => {
    let app: express.Application;
    let server: http.Server;

    beforeAll(() => {
      process.env.PORT = '0';
      jest.isolateModules(() => {
        const mod = require('../server');
        app = mod.default;
        server = mod.server;
      });
    });

    afterAll(() => {
      delete process.env.PORT;
      if (server) server.close();
    });

    it('returns results for batch requests', async () => {
      const res = await request(app)
        .post('/v1/responses:batch')
        .send({ requests: [{ model: 'deepseek-chat', input: 'a' }, { model: 'deepseek-chat', input: 'b' }] });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(2);
    });

    it('returns 400 for empty batch', async () => {
      const res = await request(app)
        .post('/v1/responses:batch')
        .send({ requests: [] });

      expect(res.status).toBe(400);
    });

    it('returns 400 for batch exceeding 50 items', async () => {
      const res = await request(app)
        .post('/v1/responses:batch')
        .send({ requests: new Array(51).fill({ input: 'test' }) });

      expect(res.status).toBe(400);
    });
  });

  describe('Request ID', () => {
    let app: express.Application;
    let server: http.Server;

    beforeAll(() => {
      process.env.PORT = '0';
      jest.isolateModules(() => {
        const mod = require('../server');
        app = mod.default;
        server = mod.server;
      });
    });

    afterAll(() => {
      delete process.env.PORT;
      if (server) server.close();
    });

    it('preserves client-provided X-Request-Id', async () => {
      const res = await request(app)
        .get('/health')
        .set('X-Request-Id', 'client-id-123');

      expect(res.headers['x-request-id']).toBe('client-id-123');
    });

    it('generates request ID starting with req_ when not provided', async () => {
      const res = await request(app).get('/health');

      expect(res.headers['x-request-id']).toMatch(/^req_/);
    });
  });
});
