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
    }),
  },
}));

jest.mock('../streaming', () => ({
  circuitBreaker: {
    execute: jest.fn().mockImplementation(async (fn: any) => fn()),
  },
}));

describe('Batch', () => {
  let handle_batch_request: any;
  let req: any;
  let res: any;
  let json: jest.Mock;
  let status: jest.Mock;
  let logger: any;

  function load() {
    jest.isolateModules(() => {
      const batch = require('../batch');
      handle_batch_request = batch.handle_batch_request;
    });
  }

  beforeEach(() => {
    json = jest.fn();
    status = jest.fn().mockReturnValue({ json });
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  });

  describe('input validation', () => {
    it('returns 400 for missing requests field', async () => {
      load();
      req = { body: {} };
      res = { status, json };
      await handle_batch_request(req, res, logger);
      expect(status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for empty requests array', async () => {
      load();
      req = { body: { requests: [] } };
      res = { status, json };
      await handle_batch_request(req, res, logger);
      expect(status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for more than 50 requests', async () => {
      load();
      req = { body: { requests: new Array(51).fill({ input: 'test' }) } };
      res = { status, json };
      await handle_batch_request(req, res, logger);
      expect(status).toHaveBeenCalledWith(400);
    });

    it('accepts valid batch of requests', async () => {
      load();
      req = { body: { requests: [{ input: 'test1' }, { input: 'test2' }] } };
      res = { status, json };
      await handle_batch_request(req, res, logger);
      expect(status).not.toHaveBeenCalledWith(400);
    });
  });

  describe('processing', () => {
    it('returns results for each request', async () => {
      load();
      req = { body: { requests: [{ input: 'a' }, { input: 'b' }] } };
      res = { status, json };
      await handle_batch_request(req, res, logger);
      expect(json).toHaveBeenCalled();
      const body = json.mock.calls[0][0];
      expect(body.results).toHaveLength(2);
    });

    it('each result has status ok', async () => {
      load();
      req = { body: { requests: [{ input: 'a' }] } };
      res = { status, json };
      await handle_batch_request(req, res, logger);
      const body = json.mock.calls[0][0];
      expect(body.results[0].status).toBe('ok');
    });

    it('each result has elapsed_ms', async () => {
      load();
      req = { body: { requests: [{ input: 'a' }] } };
      res = { status, json };
      await handle_batch_request(req, res, logger);
      const body = json.mock.calls[0][0];
      expect(body.results[0].elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it('isolates failures: one bad request does not affect others', async () => {
      const { __mockPlugin } = require('../plugin-system');
      __mockPlugin.convertRequest
        .mockReturnValueOnce({ stream: false, model: 'test' })  // first call: ok
        .mockImplementationOnce(() => { throw new Error('conversion error'); })  // second: fail
        .mockReturnValue({ stream: false, model: 'test' }); // remaining: ok

      load();
      req = { body: { requests: [{ input: 'good' }, { input: 'bad' }, { input: 'good2' }] } };
      res = { status, json };
      await handle_batch_request(req, res, logger);
      const body = json.mock.calls[0][0];
      expect(body.results[0].status).toBe('ok');
      expect(body.results[1].status).toBe('error');
      expect(body.results[2].status).toBe('ok');

      // Restore
      __mockPlugin.convertRequest.mockReturnValue({ stream: false, model: 'test' });
    });
  });
});
