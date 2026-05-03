import axios from 'axios';

// Mock plugin-system, connection-pool, streaming before importing webhook
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
        post: jest.fn().mockResolvedValue({ status: 200, data: { choices: [{ message: { content: 'hello' } }] } }),
      }),
      getStreamingClient: jest.fn(),
    }),
  },
}));

jest.mock('../streaming', () => ({
  circuitBreaker: {
    execute: jest.fn().mockImplementation(async (fn: any) => fn()),
  },
}));

jest.mock('axios');

describe('Webhook', () => {
  let handle_webhook_request: any;
  let req: any;
  let res: any;
  let json: jest.Mock;
  let status: jest.Mock;
  let logger: any;

  function load() {
    jest.isolateModules(() => {
      const webhook = require('../webhook');
      handle_webhook_request = webhook.handle_webhook_request;
    });
  }

  beforeEach(() => {
    json = jest.fn();
    status = jest.fn().mockReturnValue({ json });
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  });

  describe('URL validation', () => {
    it('returns 400 when webhook is a string but empty', async () => {
      load();
      req = { body: { webhook: '' } };
      res = { status, json };
      await handle_webhook_request(req, res, logger, 'req_001');
      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({
        error: expect.objectContaining({ code: 'bad_request' }),
      });
    });

    it('accepts string webhook URL and returns 202', async () => {
      load();
      req = { body: { webhook: 'https://hooks.example.com/callback', input: 'test' } };
      res = { status, json };
      await handle_webhook_request(req, res, logger, 'req_001');
      expect(status).toHaveBeenCalledWith(202);
      expect(json).toHaveBeenCalledWith({ id: 'req_001', status: 'processing' });
    });

    it('accepts object webhook with url field', async () => {
      load();
      req = { body: { webhook: { url: 'https://hooks.example.com/callback' }, input: 'test' } };
      res = { status, json };
      await handle_webhook_request(req, res, logger, 'req_001');
      expect(status).toHaveBeenCalledWith(202);
    });

    it('returns 400 for invalid webhook URL (not http/https)', async () => {
      load();
      req = { body: { webhook: 'ftp://files.example.com' } };
      res = { status, json };
      await handle_webhook_request(req, res, logger, 'req_001');
      expect(status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for missing webhook on object', async () => {
      load();
      req = { body: { webhook: { } } };
      res = { status, json };
      await handle_webhook_request(req, res, logger, 'req_001');
      expect(status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for non-string webhook value', async () => {
      load();
      req = { body: { webhook: 123 } };
      res = { status, json };
      await handle_webhook_request(req, res, logger, 'req_001');
      expect(status).toHaveBeenCalledWith(400);
    });

    it('warns about localhost webhook URLs', async () => {
      load();
      req = { body: { webhook: 'http://localhost:9000/hook', input: 'test' } };
      res = { status, json };
      await handle_webhook_request(req, res, logger, 'req_001');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('localhost'));
      expect(status).toHaveBeenCalledWith(202);
    });
  });

  describe('async delivery', () => {
    it('triggers process_and_deliver after returning 202', async () => {
      load();
      req = { body: { webhook: 'https://hooks.example.com/cb', input: 'generate code' } };
      res = { status, json };
      await handle_webhook_request(req, res, logger, 'req_002');
      expect(status).toHaveBeenCalledWith(202);
    });

    it('delivers error to webhook on upstream failure', async () => {
      // Simulate conversion failure
      const { __mockPlugin } = require('../plugin-system');
      __mockPlugin.convertResponse.mockReturnValue(null);

      load();
      req = { body: { webhook: 'https://hooks.example.com/cb', input: 'test' } };
      res = { status, json };
      await handle_webhook_request(req, res, logger, 'req_003');
      expect(status).toHaveBeenCalledWith(202);

      // Restore
      __mockPlugin.convertResponse.mockReturnValue({ id: 'resp_123', choices: [] });
    });

    it('logs unhandled errors from async delivery', async () => {
      const { __mockPlugin } = require('../plugin-system');
      __mockPlugin.convertRequest.mockImplementation(() => {
        throw new Error('Unexpected crash');
      });

      load();
      req = { body: { webhook: 'https://hooks.example.com/cb', input: 'test' } };
      res = { status, json };
      await handle_webhook_request(req, res, logger, 'req_004');
      // Wait for the async catch
      await new Promise((r) => setTimeout(r, 10));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Unexpected crash'));

      // Restore
      __mockPlugin.convertRequest.mockReturnValue({ stream: false, model: 'test' });
    });
  });
});
