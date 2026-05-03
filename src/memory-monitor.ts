export interface MemoryStats {
  rss: number;           // Resident Set Size
  heapTotal: number;     // Total heap size
  heapUsed: number;      // Used heap size
  external: number;      // External memory
  arrayBuffers: number;  // ArrayBuffer memory
  timestamp: number;     // When stats were collected
}

export interface MemoryMonitorConfig {
  checkInterval: number;     // How often to check memory (ms)
  highMemoryThreshold: number; // Percentage threshold for warning (0-100)
  logInterval: number;       // How often to log stats (ms)
  enableLeakDetection: boolean; // Enable memory leak detection
  leakDetectionWindow: number;  // Time window for leak detection (ms)
  maxHeapUsageIncrease: number; // Max allowed heap increase in window (%)
}

export class MemoryMonitor {
  private config: MemoryMonitorConfig;
  private statsHistory: MemoryStats[] = [];
  private checkIntervalId: NodeJS.Timeout | null = null;
  private logIntervalId: NodeJS.Timeout | null = null;
  private isMonitoring = false;
  private logger: any;

  constructor(config?: Partial<MemoryMonitorConfig>, logger?: any) {
    this.config = {
      checkInterval: 30000,           // Check every 30 seconds
      highMemoryThreshold: 85,        // Warn when memory > 85%
      logInterval: 300000,            // Log every 5 minutes
      enableLeakDetection: true,
      leakDetectionWindow: 600000,    // 10 minute window for leak detection
      maxHeapUsageIncrease: 20,       // Max 20% increase in 10 minutes
      ...config
    };
    this.logger = logger || console;
  }

  start(): void {
    if (this.isMonitoring) {
      this.logger.warn('MemoryMonitor is already running');
      return;
    }

    this.isMonitoring = true;
    this.logger.info('Starting memory monitor');

    // Initial memory check
    this.checkMemory();

    // Setup periodic checks
    this.checkIntervalId = setInterval(() => {
      this.checkMemory();
    }, this.config.checkInterval);

    // Setup periodic logging
    this.logIntervalId = setInterval(() => {
      this.logMemoryStats();
    }, this.config.logInterval);

    // Also log on process exit
    process.on('beforeExit', () => {
      this.logger.info('Process exiting - final memory report:');
      this.logMemoryStats();
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.logger.error(`Uncaught exception: ${error.message}`);
      this.logMemoryStats();
    });

    // Handle unhandled rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error(`Unhandled rejection at: ${promise}, reason: ${reason}`);
      this.logMemoryStats();
    });
  }

  stop(): void {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;

    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }

    if (this.logIntervalId) {
      clearInterval(this.logIntervalId);
      this.logIntervalId = null;
    }

    this.logger.info('Memory monitor stopped');
  }

  private checkMemory(): void {
    try {
      const stats = this.collectMemoryStats();
      this.statsHistory.push(stats);

      // Keep only recent history (last 1 hour)
      const cutoffTime = Date.now() - 3600000; // 1 hour
      this.statsHistory = this.statsHistory.filter(s => s.timestamp > cutoffTime);

      // Check for high memory usage
      this.checkHighMemoryUsage(stats);

      // Check for memory leaks
      if (this.config.enableLeakDetection) {
        this.checkForMemoryLeaks();
      }
    } catch (error) {
      this.logger.error(`Error checking memory: ${error}`);
    }
  }

  private collectMemoryStats(): MemoryStats {
    const memoryUsage = process.memoryUsage();
    const timestamp = Date.now();

    return {
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: memoryUsage.heapUsed,
      external: memoryUsage.external,
      arrayBuffers: memoryUsage.arrayBuffers,
      timestamp
    };
  }

  private checkHighMemoryUsage(currentStats: MemoryStats): void {
    const heapUsagePercent = (currentStats.heapUsed / currentStats.heapTotal) * 100;
    const minHeapBytes = 100 * 1024 * 1024; // 100 MB — only warn above this size

    if (heapUsagePercent > this.config.highMemoryThreshold && currentStats.heapTotal > minHeapBytes) {
      const message = `High memory usage detected: ${heapUsagePercent.toFixed(2)}% (threshold: ${this.config.highMemoryThreshold}%)`;
      this.logger.warn(message, {
        rss: this.formatBytes(currentStats.rss),
        heapTotal: this.formatBytes(currentStats.heapTotal),
        heapUsed: this.formatBytes(currentStats.heapUsed),
        heapUsagePercent: heapUsagePercent.toFixed(2)
      });
    }
  }

  private checkForMemoryLeaks(): void {
    if (this.statsHistory.length < 2) {
      return;
    }

    const cutoffTime = Date.now() - this.config.leakDetectionWindow;
    const recentStats = this.statsHistory.filter(s => s.timestamp > cutoffTime);

    if (recentStats.length < 2) {
      return;
    }

    const oldest = recentStats[0];
    const newest = recentStats[recentStats.length - 1];

    const heapIncrease = newest.heapUsed - oldest.heapUsed;
    const heapIncreasePercent = (heapIncrease / oldest.heapUsed) * 100;
    const minLeakBytes = 50 * 1024 * 1024; // 50 MB — ignore small heap increases

    if (heapIncreasePercent > this.config.maxHeapUsageIncrease && newest.heapTotal > minLeakBytes) {
      const message = `Possible memory leak detected: heap usage increased by ${heapIncreasePercent.toFixed(2)}% over ${this.config.leakDetectionWindow / 60000} minutes`;
      this.logger.warn(message, {
        oldHeapUsed: this.formatBytes(oldest.heapUsed),
        newHeapUsed: this.formatBytes(newest.heapUsed),
        increase: this.formatBytes(heapIncrease),
        increasePercent: heapIncreasePercent.toFixed(2),
        timeWindow: `${this.config.leakDetectionWindow / 60000} minutes`
      });
    }
  }

  private logMemoryStats(): void {
    if (this.statsHistory.length === 0) {
      return;
    }

    const latest = this.statsHistory[this.statsHistory.length - 1];
    const heapUsagePercent = (latest.heapUsed / latest.heapTotal) * 100;

    this.logger.info('Memory usage report:', {
      rss: this.formatBytes(latest.rss),
      heapTotal: this.formatBytes(latest.heapTotal),
      heapUsed: this.formatBytes(latest.heapUsed),
      heapUsagePercent: heapUsagePercent.toFixed(2) + '%',
      external: this.formatBytes(latest.external),
      arrayBuffers: this.formatBytes(latest.arrayBuffers),
      statsHistoryCount: this.statsHistory.length,
      uptime: this.formatUptime(process.uptime())
    });

    // Also log to console for immediate visibility
    console.log(`[MemoryMonitor] Heap: ${this.formatBytes(latest.heapUsed)}/${this.formatBytes(latest.heapTotal)} (${heapUsagePercent.toFixed(2)}%)`);
  }

  getCurrentStats(): MemoryStats {
    return this.collectMemoryStats();
  }

  getStatsHistory(): MemoryStats[] {
    return [...this.statsHistory];
  }

  clearStatsHistory(): void {
    this.statsHistory = [];
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  private formatUptime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  // Static method for quick one-off memory checks
  static getQuickStats(): {
    rss: string;
    heapTotal: string;
    heapUsed: string;
    heapUsagePercent: number;
  } {
    const memoryUsage = process.memoryUsage();
    const heapUsagePercent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;

    const format = (bytes: number) => {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    return {
      rss: format(memoryUsage.rss),
      heapTotal: format(memoryUsage.heapTotal),
      heapUsed: format(memoryUsage.heapUsed),
      heapUsagePercent: parseFloat(heapUsagePercent.toFixed(2))
    };
  }
}