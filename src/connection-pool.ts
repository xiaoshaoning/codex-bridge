import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { setupAxiosRetry } from './retry-strategy';

export type PoolType = 'default' | 'streaming';

interface PoolConfig {
  maxSockets: number;
  maxFreeSockets: number;
  timeout: number;
  keepAlive: boolean;
}

const POOL_CONFIGS: Record<PoolType, PoolConfig> = {
  default: {
    maxSockets: parseInt(process.env.POOL_DEFAULT_MAX_SOCKETS || '100'),
    maxFreeSockets: parseInt(process.env.POOL_DEFAULT_MAX_FREE_SOCKETS || '10'),
    timeout: parseInt(process.env.POOL_DEFAULT_TIMEOUT || '60000'),
    keepAlive: true
  },
  streaming: {
    maxSockets: parseInt(process.env.POOL_STREAMING_MAX_SOCKETS || '50'),
    maxFreeSockets: parseInt(process.env.POOL_STREAMING_MAX_FREE_SOCKETS || '5'),
    timeout: parseInt(process.env.POOL_STREAMING_TIMEOUT || '120000'),
    keepAlive: true
  }
};

export class ConnectionPool {
  private static instance: ConnectionPool;
  private poolTypeClients: Map<string, Map<PoolType, AxiosInstance>> = new Map();

  static getInstance(): ConnectionPool {
    if (!ConnectionPool.instance) {
      ConnectionPool.instance = new ConnectionPool();
    }
    return ConnectionPool.instance;
  }

  getClient(baseURL: string): AxiosInstance {
    return this.getPooledClient(baseURL, 'default');
  }

  getStreamingClient(baseURL: string): AxiosInstance {
    return this.getPooledClient(baseURL, 'streaming');
  }

  private getPooledClient(baseURL: string, poolType: PoolType): AxiosInstance {
    let poolMap = this.poolTypeClients.get(baseURL);
    if (!poolMap) {
      poolMap = new Map();
      this.poolTypeClients.set(baseURL, poolMap);
    }

    const existing = poolMap.get(poolType);
    if (existing) {
      return existing;
    }

    const poolConfig = POOL_CONFIGS[poolType];
    const client = axios.create({
      timeout: poolConfig.timeout,
      maxRedirects: 5,
      maxContentLength: 50 * 1024 * 1024,
      httpAgent: new http.Agent({
        keepAlive: poolConfig.keepAlive,
        maxSockets: poolConfig.maxSockets,
        maxFreeSockets: poolConfig.maxFreeSockets,
        timeout: poolConfig.timeout
      }),
      httpsAgent: new https.Agent({
        keepAlive: poolConfig.keepAlive,
        maxSockets: poolConfig.maxSockets,
        maxFreeSockets: poolConfig.maxFreeSockets,
        timeout: poolConfig.timeout
      }),
      baseURL
    });

    this.configureClient(client);
    poolMap.set(poolType, client);
    return client;
  }

  removeClient(baseURL: string): void {
    this.poolTypeClients.delete(baseURL);
  }

  getClientCount(): number {
    let count = 0;
    for (const [, poolMap] of this.poolTypeClients) {
      count += poolMap.size;
    }
    return count;
  }

  getPoolStats(): Record<string, number> {
    const stats: Record<string, number> = { totalBaseURLs: this.poolTypeClients.size };
    for (const [baseURL, poolMap] of this.poolTypeClients) {
      for (const [poolType] of poolMap) {
        stats[`${poolType}:${baseURL}`] = 1;
      }
    }
    return stats;
  }

  clearAll(): void {
    this.poolTypeClients.clear();
  }

  private configureClient(client: AxiosInstance): void {
    setupAxiosRetry(client, {
      maxRetries: parseInt(process.env.AXIOS_RETRIES || '3'),
      baseDelay: parseInt(process.env.AXIOS_RETRY_BASE_DELAY || '100'),
      maxDelay: parseInt(process.env.AXIOS_RETRY_MAX_DELAY || '5000')
    });
  }
}
