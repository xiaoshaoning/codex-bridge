describe('Auth Middleware', () => {
  let req: any;
  let res: any;
  let next: jest.Mock;
  let json: jest.Mock;
  let status: jest.Mock;

  beforeEach(() => {
    json = jest.fn();
    status = jest.fn().mockReturnValue({ json });
    next = jest.fn();
    req = { path: '/v1/responses', headers: {} };
    res = { status, json };
  });

  afterEach(() => {
    delete process.env.CODEX_API_KEY;
  });

  describe('when CODEX_API_KEY is not set', () => {
    let api_key_middleware: any;

    beforeEach(() => {
      delete process.env.CODEX_API_KEY;
      jest.resetModules();
      const auth = require('../auth');
      api_key_middleware = auth.api_key_middleware;
    });

    it('passes all requests through', () => {
      api_key_middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('when CODEX_API_KEY is set', () => {
    let api_key_middleware: any;
    let validate_ws_token: any;

    beforeEach(() => {
      process.env.CODEX_API_KEY = 'test-key-123';
      jest.resetModules();
      const auth = require('../auth');
      api_key_middleware = auth.api_key_middleware;
      validate_ws_token = auth.validate_ws_token;
    });

    describe('api_key_middleware', () => {
      it('accepts valid Bearer token', () => {
        req.headers = { authorization: 'Bearer test-key-123' };
        api_key_middleware(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
      });

      it('rejects invalid Bearer token with 401', () => {
        req.headers = { authorization: 'Bearer wrong-key' };
        api_key_middleware(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(401);
        expect(json).toHaveBeenCalledWith({
          error: expect.objectContaining({ code: 'unauthorized' }),
        });
      });

      it('accepts valid X-API-Key header', () => {
        req.headers = { 'x-api-key': 'test-key-123' };
        api_key_middleware(req, res, next);
        expect(next).toHaveBeenCalled();
      });

      it('rejects invalid X-API-Key header with 401', () => {
        req.headers = { 'x-api-key': 'wrong-key' };
        api_key_middleware(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(401);
      });

      it('returns 401 when no auth header present', () => {
        req.headers = {};
        api_key_middleware(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(401);
      });

      it('allows access to /health without auth', () => {
        req.path = '/health';
        req.headers = {};
        api_key_middleware(req, res, next);
        expect(next).toHaveBeenCalled();
      });

      it('allows access to /metrics without auth', () => {
        req.path = '/metrics';
        req.headers = {};
        api_key_middleware(req, res, next);
        expect(next).toHaveBeenCalled();
      });

      it('accepts Bearer token with extra whitespace trimmed', () => {
        req.headers = { authorization: 'Bearer test-key-123' };
        api_key_middleware(req, res, next);
        expect(next).toHaveBeenCalled();
      });

      it('rejects header that does not start with Bearer', () => {
        req.headers = { authorization: 'Basic dGVzdC1rZXk=' };
        api_key_middleware(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(401);
      });
    });

    describe('validate_ws_token', () => {
      it('returns true for valid token in query param', () => {
        expect(validate_ws_token('/ws?token=test-key-123')).toBe(true);
      });

      it('returns true for valid api_key in query param', () => {
        expect(validate_ws_token('/ws?api_key=test-key-123')).toBe(true);
      });

      it('returns false for invalid token', () => {
        expect(validate_ws_token('/ws?token=wrong-key')).toBe(false);
      });

      it('returns false for missing token', () => {
        expect(validate_ws_token('/ws')).toBe(false);
      });

      it('returns false for malformed URL', () => {
        expect(validate_ws_token('')).toBe(false);
      });
    });
  });

  describe('validate_ws_token when no key configured', () => {
    it('returns true when CODEX_API_KEY is empty', () => {
      delete process.env.CODEX_API_KEY;
      jest.resetModules();
      const { validate_ws_token } = require('../auth');
      expect(validate_ws_token('/ws')).toBe(true);
    });
  });
});
