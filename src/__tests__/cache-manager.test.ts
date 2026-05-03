import { CacheManager } from '../cache-manager';

describe('CacheManager', () => {
  let cacheManager: CacheManager;

  beforeEach(() => {
    cacheManager = new CacheManager();
  });

  describe('generateCacheKey', () => {
    it('should generate consistent keys for identical requests', () => {
      const req1 = {
        method: 'POST',
        url: '/v1/responses',
        body: { model: 'deepseek-chat', input: ['Hello'] },
        headers: { authorization: 'Bearer test-key-12345' }
      };
      const req2 = {
        method: 'POST',
        url: '/v1/responses',
        body: { model: 'deepseek-chat', input: ['Hello'] },
        headers: { authorization: 'Bearer test-key-12345' }
      };

      expect(cacheManager.generateCacheKey(req1)).toBe(cacheManager.generateCacheKey(req2));
    });

    it('should generate different keys for different requests', () => {
      const req1 = {
        method: 'POST',
        url: '/v1/responses',
        body: { model: 'deepseek-chat', input: ['Hello'] },
        headers: { authorization: 'Bearer key-a' }
      };
      const req2 = {
        method: 'POST',
        url: '/v1/responses',
        body: { model: 'deepseek-chat', input: ['World'] },
        headers: { authorization: 'Bearer key-b' }
      };

      expect(cacheManager.generateCacheKey(req1)).not.toBe(cacheManager.generateCacheKey(req2));
    });

    it('should handle requests without body', () => {
      const req = {
        method: 'GET',
        url: '/health',
        body: undefined,
        headers: {}
      };

      const key = cacheManager.generateCacheKey(req);
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    });
  });

  describe('getOrSet', () => {
    it('should return cached value on subsequent calls', async () => {
      const fetchFn = jest.fn().mockResolvedValue('result');

      const result1 = await cacheManager.getOrSet('key1', fetchFn);
      const result2 = await cacheManager.getOrSet('key1', fetchFn);

      expect(result1).toBe('result');
      expect(result2).toBe('result');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('should call fetchFn on cache miss', async () => {
      const fetchFn = jest.fn().mockResolvedValue('fresh');

      const result = await cacheManager.getOrSet('key2', fetchFn);

      expect(result).toBe('fresh');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('should handle async fetch errors', async () => {
      const fetchFn = jest.fn().mockRejectedValue(new Error('API error'));

      await expect(cacheManager.getOrSet('key3', fetchFn)).rejects.toThrow('API error');
    });
  });

  describe('deduplicateRequest', () => {
    it('should deduplicate concurrent requests with same key', async () => {
      let callCount = 0;
      const requestFn = jest.fn().mockImplementation(async () => {
        callCount++;
        await new Promise(resolve => setTimeout(resolve, 50));
        return 'result';
      });

      const [result1, result2] = await Promise.all([
        cacheManager.deduplicateRequest('dedup-key', requestFn),
        cacheManager.deduplicateRequest('dedup-key', requestFn)
      ]);

      expect(result1).toBe('result');
      expect(result2).toBe('result');
      expect(callCount).toBe(1);
    });

    it('should not deduplicate requests with different keys', async () => {
      const requestFn = jest.fn().mockResolvedValue('result');

      await Promise.all([
        cacheManager.deduplicateRequest('key-a', requestFn),
        cacheManager.deduplicateRequest('key-b', requestFn)
      ]);

      expect(requestFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearCache', () => {
    it('should clear all caches', async () => {
      await cacheManager.getOrSet('key', async () => 'value');

      cacheManager.clearCache();

      // Should call fetchFn again
      const fetchFn = jest.fn().mockResolvedValue('new-value');
      const result = await cacheManager.getOrSet('key', fetchFn);
      expect(result).toBe('new-value');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStats', () => {
    it('should return cache statistics', () => {
      const stats = cacheManager.getStats();

      expect(stats).toHaveProperty('cache');
      expect(stats).toHaveProperty('requestCache');
      expect(stats.cache).toHaveProperty('keys');
      expect(stats.cache).toHaveProperty('hits');
      expect(stats.cache).toHaveProperty('misses');
    });
  });
});
