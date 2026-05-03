import { Request, Response, NextFunction } from 'express';

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim());

function is_origin_allowed(origin: string): boolean {
  if (CORS_ORIGINS.includes('*')) {
    return true;
  }
  return CORS_ORIGINS.some(
    (allowed) =>
      allowed === origin ||
      (allowed.startsWith('*.') && origin.endsWith(allowed.slice(1))),
  );
}

export function cors_middleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers['origin'] as string | undefined;

  if (origin && is_origin_allowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else if (CORS_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Request-Id');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
    return;
  }

  next();
}
