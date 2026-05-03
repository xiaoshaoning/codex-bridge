import NodeCache from 'node-cache';
import crypto from 'crypto';

export class CacheManager {
  private cache: NodeCache;
  private requestCache: NodeCache;

  constructor() {
    // 短期缓存：5秒TTL，1000个条目
    this.cache = new NodeCache({
      stdTTL: 5,
      checkperiod: 60,
      maxKeys: 1000
    });

    // 请求缓存：30秒TTL，检查重复请求
    this.requestCache = new NodeCache({
      stdTTL: 30,
      checkperiod: 30,
      maxKeys: 5000
    });
  }

  generateCacheKey(req: any): string {
    const { method, url, body, headers } = req;
    const keyData = {
      method,
      url,
      body: typeof body === 'object' ? JSON.stringify(body) : body,
      auth: headers?.authorization?.substring(0, 20)
    };
    return crypto.createHash('md5').update(JSON.stringify(keyData)).digest('hex');
  }

  async getOrSet<T>(key: string, fetchFn: () => Promise<T>, ttl?: number): Promise<T> {
    const cached = this.cache.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    const result = await fetchFn();
    this.cache.set(key, result, ttl || 5);
    return result;
  }

  // 请求去重：防止相同请求并发执行
  async deduplicateRequest<T>(key: string, requestFn: () => Promise<T>): Promise<T> {
    const existingPromise = this.requestCache.get<Promise<T>>(key);
    if (existingPromise !== undefined) {
      return existingPromise;
    }

    const promise = requestFn();
    this.requestCache.set(key, promise);

    try {
      const result = await promise;
      return result;
    } finally {
      // 请求完成后移除缓存，但保留结果在短期缓存中
      this.requestCache.del(key);
    }
  }

  // 清除缓存
  clearCache(): void {
    this.cache.flushAll();
    this.requestCache.flushAll();
  }

  // 获取缓存统计
  getStats(): any {
    return {
      cache: {
        keys: this.cache.keys().length,
        hits: this.cache.getStats().hits,
        misses: this.cache.getStats().misses,
        ksize: this.cache.getStats().ksize,
        vsize: this.cache.getStats().vsize
      },
      requestCache: {
        keys: this.requestCache.keys().length,
        hits: this.requestCache.getStats().hits,
        misses: this.requestCache.getStats().misses,
        ksize: this.requestCache.getStats().ksize,
        vsize: this.requestCache.getStats().vsize
      }
    };
  }
}