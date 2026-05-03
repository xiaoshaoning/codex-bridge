import request from 'supertest';
import express from 'express';
import http from 'http';

// Mock axios before importing modules that use it
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

describe('Server API', () => {
  let app: express.Application;
  let httpServer: http.Server;

  beforeAll(() => {
    process.env.PORT = '0'; // use random port

    jest.isolateModules(() => {
      const serverModule = require('../server');
      app = serverModule.default;
      httpServer = serverModule.server;
    });
  });

  afterAll(() => {
    delete process.env.PORT;
    // Force close server to stop jest from hanging
    if (httpServer) {
      httpServer.close();
    }
  });

  describe('GET /health', () => {
    it('should return 200 with status ok', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body).toHaveProperty('memory');
      expect(res.body).toHaveProperty('uptime');
      expect(res.body).toHaveProperty('version', '1.0.0');
    });

    it('should include memory statistics', async () => {
      const res = await request(app).get('/health');

      expect(res.body.memory).toHaveProperty('rss');
      expect(res.body.memory).toHaveProperty('heapTotal');
      expect(res.body.memory).toHaveProperty('heapUsed');
      expect(res.body.memory).toHaveProperty('heapUsagePercent');
    });

    it('should have valid timestamp', async () => {
      const res = await request(app).get('/health');

      expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
    });
  });

  describe('POST /v1/responses', () => {
    it('should return 400 for invalid JSON body', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .set('Content-Type', 'application/json')
        .send('not json');

      expect(res.status).toBe(400);
    });
  });

  describe('POST /responses', () => {
    it('should accept requests at the /responses alias', async () => {
      const res = await request(app)
        .post('/responses')
        .send({ model: 'deepseek-chat', input: ['test'] });

      expect(res.status).not.toBe(404);
    });
  });

  describe('X-Request-Id header', () => {
    it('should propagate client request ID', async () => {
      const res = await request(app)
        .get('/health')
        .set('X-Request-Id', 'my-custom-id');

      expect(res.headers['x-request-id']).toBe('my-custom-id');
    });

    it('should generate request ID if not provided', async () => {
      const res = await request(app).get('/health');

      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.headers['x-request-id']).toMatch(/^req_/);
    });
  });
});
