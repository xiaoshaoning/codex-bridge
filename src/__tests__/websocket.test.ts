import http from 'http';
import { WebSocket } from 'ws';
import { URL } from 'url';

// Mock dependencies
jest.mock('../auth', () => ({
  validate_ws_token: jest.fn(),
}));

jest.mock('../plugin-system', () => {
  const mockPlugin = {
    name: 'test',
    matchesModel: jest.fn().mockReturnValue(true),
    convertRequest: jest.fn().mockReturnValue({ stream: false, model: 'test' }),
    convertResponse: jest.fn().mockReturnValue({ id: 'resp_123', choices: [] }),
    parseStreamChunk: jest.fn(),
    convertStreamChunk: jest.fn(),
    getApiUrl: jest.fn().mockReturnValue('https://api.test.com'),
    getAuthHeaders: jest.fn().mockReturnValue({ Authorization: 'Bearer test-key' }),
  };

  return {
    ConverterPlugin: {},
    pluginRegistry: {
      register: jest.fn(),
      getPluginForModel: jest.fn().mockReturnValue(mockPlugin),
      getPlugin: jest.fn().mockReturnValue(mockPlugin),
      hasPlugin: jest.fn().mockReturnValue(true),
      getAllPlugins: jest.fn().mockReturnValue([mockPlugin]),
    },
    __mockPlugin: mockPlugin,
  };
});

jest.mock('../connection-pool', () => ({
  ConnectionPool: {
    getInstance: jest.fn().mockReturnValue({
      getClient: jest.fn().mockReturnValue({
        post: jest.fn().mockResolvedValue({ status: 200, data: { choices: [{ message: { content: 'ok' } }] } }),
      }),
      getStreamingClient: jest.fn().mockReturnValue({
        post: jest.fn().mockResolvedValue({ status: 200, data: { on: jest.fn() } }),
      }),
    }),
  },
}));

jest.mock('../streaming', () => ({
  circuitBreaker: {
    execute: jest.fn().mockImplementation(async (fn: any) => fn()),
  },
}));

describe('WebSocket', () => {
  let server: http.Server;
  let wsUrl: string;
  let validate_ws_token: jest.Mock;

  beforeAll(async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';

    const { validate_ws_token: vwt } = require('../auth');
    validate_ws_token = vwt;

    const { setup_websocket_server } = require('../websocket');

    server = http.createServer();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    setup_websocket_server(server, logger);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      wsUrl = `http://127.0.0.1:${addr.port}`;
    }
  });

  afterAll(() => {
    delete process.env.DEEPSEEK_API_KEY;
    server.close();
  });

  function ws_connect(path: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const url = wsUrl.replace(/^http/, 'ws') + path;
      const ws = new WebSocket(url);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Connection timeout')), 2000);
    });
  }

  describe('connection validation', () => {
    it('accepts connection at /ws with valid token', async () => {
      validate_ws_token.mockReturnValue(true);
      const ws = await ws_connect('/ws?token=valid-key');
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('rejects connection at /ws with invalid token', async () => {
      validate_ws_token.mockReturnValue(false);
      await expect(ws_connect('/ws?token=wrong-key')).rejects.toThrow();
    });

    it('destroys connection at non-/ws path', async () => {
      validate_ws_token.mockReturnValue(true);
      await expect(ws_connect('/other')).rejects.toThrow();
    });
  });

  describe('message handling', () => {
    it('sends error for invalid JSON message', async () => {
      validate_ws_token.mockReturnValue(true);
      const ws = await ws_connect('/ws?token=valid-key');

      const result = new Promise<any>((resolve) => {
        ws.on('message', (raw: Buffer) => resolve(JSON.parse(raw.toString())));
      });

      ws.send('not json');
      const msg = await result;
      expect(msg.type).toBe('error');
      expect(msg.data.code).toBe('bad_request');
      ws.close();
    });

    it('processes valid non-streaming request', async () => {
      validate_ws_token.mockReturnValue(true);
      const ws = await ws_connect('/ws?token=valid-key');

      const result = new Promise<any>((resolve) => {
        ws.on('message', (raw: Buffer) => resolve(JSON.parse(raw.toString())));
      });

      ws.send(JSON.stringify({ id: 'msg_1', model: 'deepseek-chat', input: 'test' }));
      const msg = await result;
      expect(msg.type).toBe('response');
      ws.close();
    });

    it('includes provided message id in response', async () => {
      validate_ws_token.mockReturnValue(true);
      const ws = await ws_connect('/ws?token=valid-key');

      const result = new Promise<any>((resolve) => {
        ws.on('message', (raw: Buffer) => resolve(JSON.parse(raw.toString())));
      });

      ws.send(JSON.stringify({ id: 'custom-id-123', input: 'test' }));
      const msg = await result;
      expect(msg.id).toBe('custom-id-123');
      ws.close();
    });

    it('processes request even when env keys are unset (plugin-managed auth)', async () => {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.OPENAI_API_KEY;

      validate_ws_token.mockReturnValue(true);
      const ws = await ws_connect('/ws?token=valid-key');

      const result = new Promise<any>((resolve) => {
        ws.on('message', (raw: Buffer) => resolve(JSON.parse(raw.toString())));
      });

      ws.send(JSON.stringify({ id: 'msg_1', input: 'test' }));
      const msg = await result;
      // Plugin returns auth headers internally, so request succeeds
      expect(msg.type).toBe('response');

      process.env.DEEPSEEK_API_KEY = 'test-key';
      ws.close();
    });
  });
});
