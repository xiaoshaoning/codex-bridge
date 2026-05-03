import { Request, Response, NextFunction } from 'express';

const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '100', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const CLEANUP_INTERVAL = 60000; // Clean stale entries every 60s

// Higher limits for public /health and /metrics endpoints
const PUBLIC_LIMIT_MULTIPLIER = 5;

interface RateLimitEntry {
  timestamps: number[];
}

export class RateLimiter {
  private windows: Map<string, RateLimitEntry> = new Map();
  private maxRequests: number;
  private windowMs: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(maxRequests = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  start(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
    this.cleanupTimer.unref();
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private getLimit(path: string): number {
    if (path === '/health' || path === '/metrics' || path.startsWith('/health') || path.startsWith('/metrics')) {
      return this.maxRequests * PUBLIC_LIMIT_MULTIPLIER;
    }
    return this.maxRequests;
  }

  check(key: string, path: string): { allowed: boolean; retryAfter: number } {
    const now = Date.now();
    const entry = this.windows.get(key) || { timestamps: [] };
    const cutoff = now - this.windowMs;

    // Remove expired timestamps
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    entry.timestamps.push(now);
    this.windows.set(key, entry);

    const limit = this.getLimit(path);
    const allowed = entry.timestamps.length <= limit;

    let retryAfter = 0;
    if (!allowed && entry.timestamps.length > 0) {
      retryAfter = Math.ceil((this.windowMs - (now - entry.timestamps[0])) / 1000);
    }

    return { allowed, retryAfter };
  }

  middleware(): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction) => {
      const key = `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
      const { allowed, retryAfter } = this.check(key, req.path);

      if (!allowed) {
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({
          error: {
            message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
            type: 'rate_limit_error',
            code: 'too_many_requests',
          },
        });
        return;
      }

      next();
    };
  }

  getStats(): { entries: number; maxRequests: number; windowMs: number } {
    return {
      entries: this.windows.size,
      maxRequests: this.maxRequests,
      windowMs: this.windowMs,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [key, entry] of this.windows) {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
      if (entry.timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
  }
}

export const rateLimiter = new RateLimiter();
