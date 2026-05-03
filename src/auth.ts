import { Request, Response, NextFunction } from 'express';

const CODEX_API_KEY = process.env.CODEX_API_KEY || '';

// Endpoints that don't require authentication
const PUBLIC_PATH_PREFIXES = ['/health', '/metrics'];

function is_public_path(path: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

export function api_key_middleware(req: Request, res: Response, next: NextFunction): void {
  // Auth is optional — skip if no key configured
  if (!CODEX_API_KEY) {
    next();
    return;
  }

  // Public endpoints don't need auth
  if (is_public_path(req.path)) {
    next();
    return;
  }

  const auth_header = req.headers['authorization'] as string | undefined;
  const x_api_key = req.headers['x-api-key'] as string | undefined;

  let token: string | undefined;
  if (auth_header && auth_header.startsWith('Bearer ')) {
    token = auth_header.slice(7);
  } else if (x_api_key) {
    token = x_api_key;
  }

  if (token && token === CODEX_API_KEY) {
    next();
    return;
  }

  res.status(401).json({
    error: {
      message: 'Invalid or missing API key. Provide via Authorization: Bearer <key> or X-API-Key header.',
      type: 'auth_error',
      code: 'unauthorized',
    },
  });
}

// Validate WebSocket connection token from query param
export function validate_ws_token(url: string): boolean {
  if (!CODEX_API_KEY) {
    return true;
  }
  try {
    const parsed = new URL(url, 'http://localhost');
    const token = parsed.searchParams.get('token') || parsed.searchParams.get('api_key');
    return token === CODEX_API_KEY;
  } catch {
    return false;
  }
}

export function is_auth_enabled(): boolean {
  return !!CODEX_API_KEY;
}
