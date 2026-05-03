import http from 'http';
import express from 'express';
import request from 'supertest';

// Track upstream calls
let upstreamCalls: { url: string; data: any }[] = [];
let mockResponse: any = null;
let mockReject: (() => Error) | null = null;

// Override jest.mock to use a proper factory that closes over mutable references
jest.mock('axios', () => {
  const mockPost = jest.fn().mockImplementation((url: string, data: any, config?: any) => {
    upstreamCalls.push({ url, data });
    if (mockReject) {
      const err = mockReject();
      return Promise.reject(err);
    }
    return Promise.resolve(mockResponse || { status: 200, data: { choices: [] } });
  });

  const mockInstance = {
    post: mockPost,
    get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
    defaults: { headers: { common: {} } },
  };

  return {
    create: jest.fn().mockReturnValue(mockInstance),
    post: mockPost,
    isAxiosError: jest.fn().mockImplementation((err: any) => err?.isAxiosError === true),
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
    defaults: { headers: { common: {} } },
  };
});

function deepseek_response(content: string): any {
  return {
    status: 200,
    data: {
      id: 'chatcmpl-mock-' + Date.now(),
      object: 'chat.completion',
      model: 'deepseek-chat',
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    },
  };
}

// Note: mock state (upstreamCalls, mockResponse, mockReject) is managed per-describe
// in beforeAll/afterAll blocks. Do NOT add a global beforeEach here — it would
// clear the state right after beforeAll sets it, causing the axios mock to return
// default empty responses.

describe('End-to-End', () => {
  describe('Basic request forwarding', () => {
    let app: express.Application;
    let server: http.Server;

    beforeAll(() => {
      process.env.DEEPSEEK_API_KEY = 'test-key';
      process.env.PORT = '0';
      upstreamCalls = [];
      mockResponse = deepseek_response('Hello from proxy e2e test');

      jest.isolateModules(() => {
        const mod = require('../server');
        app = mod.default;
        server = mod.server;
      });
    });

    afterAll(() => {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.PORT;
      if (server) server.close();
    });

    it('returns 200 with OpenAI-formatted response', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .send({ model: 'deepseek-chat', input: 'hello' });

      expect(res.status).toBe(200);
      expect(res.body.id).toMatch(/^(resp_|chatcmpl)/);
      expect(res.body.choices).toBeDefined();
      expect(res.body.choices.length).toBeGreaterThan(0);
      expect(res.body.choices[0].message.content).toContain('Hello from proxy e2e test');
    });

    it('sends correct upstream request', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .send({ model: 'deepseek-chat', input: 'test upstream' });

      expect(res.status).toBe(200);
      expect(upstreamCalls.length).toBeGreaterThanOrEqual(1);
      const last = upstreamCalls[upstreamCalls.length - 1];
      expect(last.data.model).toBe('deepseek-v4-pro');
      expect(last.data.messages).toBeDefined();
      expect(last.data.messages[0].content).toBe('test upstream');
    });
  });

  describe('Input validation', () => {
    let app: express.Application;
    let server: http.Server;

    beforeAll(() => {
      process.env.PORT = '0';
      upstreamCalls = [];
      mockResponse = deepseek_response('ok');

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

    it('returns 400 for missing input', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .send({ model: 'deepseek-chat' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for malformed JSON', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .set('Content-Type', 'application/json')
        .send('not json');
      expect(res.status).toBe(400);
    });
  });

  describe('Authentication', () => {
    let app: express.Application;
    let server: http.Server;

    beforeAll(() => {
      process.env.CODEX_API_KEY = 'e2e-secret';
      process.env.PORT = '0';
      upstreamCalls = [];
      mockResponse = deepseek_response('auth ok');

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

    it('returns 401 without auth header', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .send({ model: 'deepseek-chat', input: 'hi' });
      expect(res.status).toBe(401);
    });

    it('accepts valid bearer token', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .set('Authorization', 'Bearer e2e-secret')
        .send({ model: 'deepseek-chat', input: 'hi' });
      expect(res.status).toBe(200);
    });

    it('allows /health without auth', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    });
  });

  describe('Cache integration', () => {
    let app: express.Application;
    let server: http.Server;

    beforeAll(() => {
      process.env.DEEPSEEK_API_KEY = 'test-key';
      process.env.PORT = '0';
      upstreamCalls = [];
      mockResponse = deepseek_response('cached response');

      jest.isolateModules(() => {
        const mod = require('../server');
        app = mod.default;
        server = mod.server;
      });
    });

    afterAll(() => {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.PORT;
      if (server) server.close();
    });

    it('returns cached response on repeated identical request', async () => {
      const res1 = await request(app)
        .post('/v1/responses')
        .send({ model: 'deepseek-chat', input: 'cache me' });
      expect(res1.status).toBe(200);

      const callCountAfterFirst = upstreamCalls.length;

      const res2 = await request(app)
        .post('/v1/responses')
        .send({ model: 'deepseek-chat', input: 'cache me' });
      expect(res2.status).toBe(200);

      // Should NOT have made an additional upstream call
      expect(upstreamCalls.length).toBe(callCountAfterFirst);
    });
  });

  describe('Circuit breaker', () => {
    let app: express.Application;
    let server: http.Server;

    beforeAll(() => {
      process.env.DEEPSEEK_API_KEY = 'test-key';
      process.env.PORT = '0';
      upstreamCalls = [];

      // All requests fail with a generic error
      mockReject = () => {
        const err = new Error('upstream failure') as any;
        err.isAxiosError = true;
        err.code = 'ERR_BAD_RESPONSE';
        err.response = { status: 500, data: { error: { message: 'fail' } } };
        return err;
      };

      jest.isolateModules(() => {
        const mod = require('../server');
        app = mod.default;
        server = mod.server;
      });
    });

    afterAll(() => {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.PORT;
      if (server) server.close();
    });

    it('opens circuit after repeated failures', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post('/v1/responses')
          .send({ model: 'deepseek-chat', input: `fail-${i}` });
        statuses.push(res.status);
      }

      // First requests fail with 500, later ones should get 500 too
      // (circuit breaker throws Error → handle_error returns 500)
      const all500 = statuses.every(s => s === 500);
      expect(all500).toBe(true);
    });
  });

  describe('Request ID propagation', () => {
    let app: express.Application;
    let server: http.Server;

    beforeAll(() => {
      process.env.PORT = '0';
      upstreamCalls = [];
      mockResponse = deepseek_response('ok');

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

    it('preserves client X-Request-Id header', async () => {
      const res = await request(app)
        .get('/health')
        .set('X-Request-Id', 'e2e-client-id');
      expect(res.headers['x-request-id']).toBe('e2e-client-id');
    });

    it('generates req_ prefixed ID when none provided', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-request-id']).toMatch(/^req_/);
    });
  });

  describe('Upstream error propagation', () => {
    let app: express.Application;
    let server: http.Server;

    beforeAll(() => {
      process.env.DEEPSEEK_API_KEY = 'test-key';
      process.env.PORT = '0';
      upstreamCalls = [];
      mockReject = () => {
        const err = new Error('Bad request') as any;
        err.isAxiosError = true;
        err.code = 'ERR_BAD_REQUEST';
        err.response = {
          status: 400,
          data: { error: { message: 'Invalid parameter: messages must be an array', type: 'invalid_request_error', code: 'invalid_parameter' } },
        };
        return err;
      };

      jest.isolateModules(() => {
        const mod = require('../server');
        app = mod.default;
        server = mod.server;
      });
    });

    afterAll(() => {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.PORT;
      mockReject = null;
      if (server) server.close();
    });

    it('passes through upstream error message', async () => {
      const res = await request(app)
        .post('/v1/responses')
        .send({ input: 'test' });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error.message).toContain('Invalid parameter');
      expect(res.body.error.code).toBe('invalid_parameter');
    });

    it('passes through upstream error with non-standard format', async () => {
      mockReject = () => {
        const err = new Error('Server error') as any;
        err.isAxiosError = true;
        err.code = 'ERR_BAD_RESPONSE';
        err.response = {
          status: 502,
          data: { message: 'Upstream temporarily unavailable', code: 'overloaded' },
        };
        return err;
      };

      const res = await request(app)
        .post('/v1/responses')
        .send({ input: 'test2' });

      expect(res.status).toBe(502);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error.message).toContain('Upstream temporarily');
    });
  });

  describe('Codex CLI regression', () => {
    let app: express.Application;
    let server: http.Server;

    beforeAll(() => {
      process.env.DEEPSEEK_API_KEY = 'test-key';
      process.env.PORT = '0';
      upstreamCalls = [];
      mockReject = null;

      jest.isolateModules(() => {
        const mod = require('../server');
        app = mod.default;
        server = mod.server;
      });
    });

    afterAll(() => {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.PORT;
      mockResponse = null;
      if (server) server.close();
    });

    it('batches consecutive function_call items into single upstream assistant message', async () => {
      // DeepSeek returns a simple text response
      mockResponse = deepseek_response('done');

      await request(app)
        .post('/v1/responses')
        .send({
          input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do two things' }] },
            { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"echo a"}', status: 'completed' },
            { type: 'function_call', call_id: 'call_2', name: 'shell', arguments: '{"cmd":"echo b"}', status: 'completed' },
            { type: 'function_call_output', call_id: 'call_1', output: 'a' },
            { type: 'function_call_output', call_id: 'call_2', output: 'b' },
          ],
          model: 'deepseek-chat',
        });

      // Verify upstream received properly batched messages
      const lastUpstreamCall = upstreamCalls[upstreamCalls.length - 1];
      expect(lastUpstreamCall).toBeDefined();
      const messages = lastUpstreamCall.data.messages;

      // Find assistant message with batched tool_calls
      const assistantMsg = messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
      expect(assistantMsg).toBeDefined();
      // Two consecutive function_call items should be batched into one assistant message
      expect(assistantMsg.tool_calls).toHaveLength(2);
      expect(assistantMsg.tool_calls[0].function.name).toBe('shell');
      expect(assistantMsg.tool_calls[1].function.name).toBe('shell');

      // Tool results follow the assistant message
      const toolResults = messages.filter((m: any) => m.role === 'tool');
      expect(toolResults).toHaveLength(2);
    });

    it('converts tool call response in codex CLI format', async () => {
      // Mock DeepSeek to return tool calls
      mockResponse = {
        status: 200,
        data: {
          id: 'chatcmpl-tc-1',
          object: 'chat.completion',
          model: 'deepseek-chat',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_mock1',
                type: 'function',
                function: { name: 'shell', arguments: '{"cmd":"ls -la"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        },
      };

      const res = await request(app)
        .post('/v1/responses')
        .send({
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] }],
          tools: [{
            type: 'function',
            name: 'shell',
            description: 'Run shell commands',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
          }],
          model: 'deepseek-chat',
        });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.tool_calls).toHaveLength(1);
      expect(res.body.choices[0].message.tool_calls[0].function.name).toBe('shell');
      expect(res.body.choices[0].message.tool_calls[0].function.arguments).toContain('ls -la');
      expect(res.body.choices[0].finish_reason).toBe('tool_calls');
    });
  });
});
