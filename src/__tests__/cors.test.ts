describe('CORS Middleware', () => {
  let cors_middleware: any;
  let req: any;
  let res: any;
  let next: jest.Mock;
  let json: jest.Mock;
  let end: jest.Mock;

  function load_middleware(): any {
    jest.resetModules();
    const cors = require('../cors');
    return cors.cors_middleware;
  }

  function make_res(): any {
    json = jest.fn();
    end = jest.fn();
    return {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json,
      end,
    };
  }

  afterEach(() => {
    delete process.env.CORS_ORIGINS;
  });

  it('allows origin when CORS_ORIGINS is *', () => {
    process.env.CORS_ORIGINS = '*';
    cors_middleware = load_middleware();
    req = { headers: { origin: 'http://example.com' }, method: 'GET' };
    res = make_res();
    next = jest.fn();

    cors_middleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://example.com');
    expect(next).toHaveBeenCalled();
  });

  it('sets specific origin when origin is in allowed list', () => {
    process.env.CORS_ORIGINS = 'http://allowed.com, http://trusted.com';
    cors_middleware = load_middleware();
    req = { headers: { origin: 'http://allowed.com' }, method: 'GET' };
    res = make_res();
    next = jest.fn();

    cors_middleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://allowed.com');
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Credentials', 'true');
    expect(next).toHaveBeenCalled();
  });

  it('does not set origin header when origin is not in allowed list', () => {
    process.env.CORS_ORIGINS = 'http://allowed.com';
    cors_middleware = load_middleware();
    req = { headers: { origin: 'http://evil.com' }, method: 'GET' };
    res = make_res();
    next = jest.fn();

    cors_middleware(req, res, next);
    expect(res.setHeader).not.toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://evil.com');
    expect(next).toHaveBeenCalled();
  });

  it('handles OPTIONS preflight with 204', () => {
    process.env.CORS_ORIGINS = 'http://allowed.com';
    cors_middleware = load_middleware();
    req = { headers: { origin: 'http://allowed.com' }, method: 'OPTIONS' };
    res = make_res();
    next = jest.fn();

    cors_middleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://allowed.com');
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Methods', expect.any(String));
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Headers', expect.any(String));
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Max-Age', expect.any(String));
    expect(res.status).toHaveBeenCalledWith(204);
    expect(end).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('sets Allow-Methods on OPTIONS', () => {
    process.env.CORS_ORIGINS = 'http://allowed.com';
    cors_middleware = load_middleware();
    req = { headers: { origin: 'http://allowed.com' }, method: 'OPTIONS' };
    res = make_res();
    next = jest.fn();

    cors_middleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Methods', expect.stringContaining('GET'));
  });

  it('sets Allow-Headers on OPTIONS', () => {
    process.env.CORS_ORIGINS = 'http://allowed.com';
    cors_middleware = load_middleware();
    req = { headers: { origin: 'http://allowed.com' }, method: 'OPTIONS' };
    res = make_res();
    next = jest.fn();

    cors_middleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Headers', expect.stringContaining('Content-Type'));
  });

  it('sets Max-Age on OPTIONS', () => {
    process.env.CORS_ORIGINS = 'http://allowed.com';
    cors_middleware = load_middleware();
    req = { headers: { origin: 'http://allowed.com' }, method: 'OPTIONS' };
    res = make_res();
    next = jest.fn();

    cors_middleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Max-Age', expect.any(String));
  });

  it('matches wildcard domains like *.example.com', () => {
    process.env.CORS_ORIGINS = '*.example.com';
    cors_middleware = load_middleware();
    req = { headers: { origin: 'http://app.example.com' }, method: 'GET' };
    res = make_res();
    next = jest.fn();

    cors_middleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://app.example.com');
  });

  it('does not match wildcard for unrelated domain', () => {
    process.env.CORS_ORIGINS = '*.example.com';
    cors_middleware = load_middleware();
    req = { headers: { origin: 'http://evil.org' }, method: 'GET' };
    res = make_res();
    next = jest.fn();

    cors_middleware(req, res, next);
    expect(res.setHeader).not.toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://evil.org');
  });

  it('falls back to wildcard when no origin header present and CORS_ORIGINS is *', () => {
    process.env.CORS_ORIGINS = '*';
    cors_middleware = load_middleware();
    req = { headers: {}, method: 'GET' };
    res = make_res();
    next = jest.fn();

    cors_middleware(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
    expect(next).toHaveBeenCalled();
  });

  it('sets no origin header when no origin and specific CORS_ORIGINS', () => {
    process.env.CORS_ORIGINS = 'http://allowed.com';
    cors_middleware = load_middleware();
    req = { headers: {}, method: 'GET' };
    res = make_res();
    next = jest.fn();

    cors_middleware(req, res, next);
    expect(res.setHeader).not.toHaveBeenCalledWith('Access-Control-Allow-Origin', expect.any(String));
    expect(next).toHaveBeenCalled();
  });
});
