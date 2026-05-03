export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  retryableStatusCodes: number[];
  retryableErrors: string[];
}

export class RetryStrategy {
  private config: RetryConfig = {
    maxRetries: 3,
    baseDelay: 100,
    maxDelay: 5000,
    retryableStatusCodes: [429, 500, 502, 503, 504],
    retryableErrors: ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED']
  };

  constructor(config?: Partial<RetryConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  async executeWithRetry<T>(
    operation: () => Promise<T>,
    context: string = 'unknown'
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        if (attempt === this.config.maxRetries) {
          break;
        }

        if (!this.shouldRetry(error)) {
          throw error;
        }

        const delay = this.calculateDelay(attempt);
        console.log(`Retry attempt ${attempt + 1}/${this.config.maxRetries} for ${context} after ${delay}ms`);

        await this.delay(delay);
      }
    }

    throw lastError!;
  }

  private shouldRetry(error: any): boolean {
    if (error.response?.status) {
      return this.config.retryableStatusCodes.includes(error.response.status);
    }

    if (error.code) {
      return this.config.retryableErrors.includes(error.code);
    }

    // Check for network errors
    if (error.message?.includes('network') || error.message?.includes('timeout')) {
      return true;
    }

    return false;
  }

  private calculateDelay(attempt: number): number {
    const delay = this.config.baseDelay * Math.pow(2, attempt);
    return Math.min(delay, this.config.maxDelay);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Factory method for Axios interceptor
  static createAxiosRetryInterceptor(config?: Partial<RetryConfig>) {
    const retryStrategy = new RetryStrategy(config);
    return async (error: any) => {
      const config = error.config;

      // Don't retry if retry disabled
      if (config?.retry === false) {
        return Promise.reject(error);
      }

      // Initialize retry count
      config._retryCount = config._retryCount || 0;

      // Check if we should retry
      if (config._retryCount >= retryStrategy.config.maxRetries) {
        return Promise.reject(error);
      }

      if (!retryStrategy.shouldRetry(error)) {
        return Promise.reject(error);
      }

      // Increment retry count
      config._retryCount++;

      // Calculate delay and wait
      const delay = retryStrategy.calculateDelay(config._retryCount - 1);
      console.log(`Axios retry ${config._retryCount}/${retryStrategy.config.maxRetries} after ${delay}ms`);

      await retryStrategy.delay(delay);

      // Retry the request
      return axios.request(config);
    };
  }
}

// For use with axios-retry library (alternative approach)
import axios from 'axios';
import axiosRetry from 'axios-retry';

export function setupAxiosRetry(client: any, config?: Partial<RetryConfig>) {
  const retryConfig = {
    retries: config?.maxRetries || 3,
    retryDelay: (retryCount: number) => {
      const baseDelay = config?.baseDelay || 100;
      const maxDelay = config?.maxDelay || 5000;
      const delay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
      return delay;
    },
    retryCondition: (error: any) => {
      const retryableStatusCodes = config?.retryableStatusCodes || [429, 500, 502, 503, 504];
      const retryableErrors = config?.retryableErrors || ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED'];

      if (error.response?.status && retryableStatusCodes.includes(error.response.status)) {
        return true;
      }
      if (error.code && retryableErrors.includes(error.code)) {
        return true;
      }
      return false;
    }
  };

  axiosRetry(client, retryConfig);
}