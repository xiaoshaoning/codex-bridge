import { CircuitBreaker } from '../circuit-breaker';

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;

  beforeEach(() => {
    jest.useFakeTimers();
    circuitBreaker = new CircuitBreaker();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      const stats = circuitBreaker.getStats();
      expect(stats.state).toBe('CLOSED');
      expect(stats.isClosed).toBe(true);
      expect(stats.isOpen).toBe(false);
      expect(stats.isHalfOpen).toBe(false);
    });
  });

  describe('successful operations', () => {
    it('should execute successful operations in CLOSED state', async () => {
      const operation = jest.fn().mockResolvedValue('success');

      const result = await circuitBreaker.execute(operation);

      expect(result).toBe('success');
      expect(circuitBreaker.getState()).toBe('CLOSED');
    });
  });

  describe('failure handling', () => {
    it('should open circuit after failure threshold', async () => {
      const failingOp = jest.fn().mockRejectedValue(new Error('error'));

      for (let i = 0; i < 5; i++) {
        await expect(circuitBreaker.execute(failingOp)).rejects.toThrow('error');
      }

      expect(circuitBreaker.getState()).toBe('OPEN');
    });

    it('should remain CLOSED if failures are below threshold', async () => {
      const failingOp = jest.fn().mockRejectedValue(new Error('error'));

      for (let i = 0; i < 4; i++) {
        await expect(circuitBreaker.execute(failingOp)).rejects.toThrow('error');
      }

      expect(circuitBreaker.getState()).toBe('CLOSED');
    });
  });

  describe('open state', () => {
    it('should reject requests when OPEN', async () => {
      // Trip the circuit
      const failingOp = jest.fn().mockRejectedValue(new Error('error'));
      for (let i = 0; i < 5; i++) {
        await expect(circuitBreaker.execute(failingOp)).rejects.toThrow('error');
      }
      expect(circuitBreaker.getState()).toBe('OPEN');

      const successOp = jest.fn().mockResolvedValue('should not reach');
      await expect(circuitBreaker.execute(successOp)).rejects.toThrow('Circuit breaker is OPEN');
      expect(successOp).not.toHaveBeenCalled();
    });

    it('should transition to HALF_OPEN after reset timeout', async () => {
      // Trip the circuit
      const failingOp = jest.fn().mockRejectedValue(new Error('error'));
      for (let i = 0; i < 5; i++) {
        await expect(circuitBreaker.execute(failingOp)).rejects.toThrow('error');
      }
      expect(circuitBreaker.getState()).toBe('OPEN');

      // Advance past the reset timeout (30s)
      jest.advanceTimersByTime(31000);

      // Next call should attempt and fail -> back to OPEN
      await expect(circuitBreaker.execute(failingOp)).rejects.toThrow('error');
      expect(circuitBreaker.getState()).toBe('OPEN');
    });

    it('should allow a successful request after reset timeout in HALF_OPEN', async () => {
      // Trip the circuit
      const failingOp = jest.fn().mockRejectedValue(new Error('error'));
      for (let i = 0; i < 5; i++) {
        await expect(circuitBreaker.execute(failingOp)).rejects.toThrow('error');
      }
      expect(circuitBreaker.getState()).toBe('OPEN');

      // Advance past the reset timeout
      jest.advanceTimersByTime(31000);

      // First call transitions to HALF_OPEN and succeeds
      const successOp = jest.fn().mockResolvedValue('recovered');
      const result = await circuitBreaker.execute(successOp);
      expect(result).toBe('recovered');
      expect(circuitBreaker.getState()).toBe('HALF_OPEN');
    });
  });

  describe('half-open state', () => {
    it('should close after successful requests in HALF_OPEN', async () => {
      // Trip the circuit
      const failingOp = jest.fn().mockRejectedValue(new Error('error'));
      for (let i = 0; i < 5; i++) {
        await expect(circuitBreaker.execute(failingOp)).rejects.toThrow('error');
      }

      // Advance timer to reach HALF_OPEN
      jest.advanceTimersByTime(31000);

      // First success -> HALF_OPEN
      const successOp = jest.fn().mockResolvedValue('ok');
      await circuitBreaker.execute(successOp);
      expect(circuitBreaker.getState()).toBe('HALF_OPEN');

      // Second success -> CLOSED
      await circuitBreaker.execute(successOp);
      expect(circuitBreaker.getState()).toBe('CLOSED');

      // Now circuit is closed, normal operation
      await circuitBreaker.execute(successOp);
      expect(circuitBreaker.getState()).toBe('CLOSED');
    });

    it('should re-open if a failure occurs in HALF_OPEN', async () => {
      // Trip the circuit with failingOp
      const failingOp = jest.fn().mockRejectedValue(new Error('error'));
      for (let i = 0; i < 5; i++) {
        await expect(circuitBreaker.execute(failingOp)).rejects.toThrow('error');
      }

      // Advance timer to reach HALF_OPEN
      jest.advanceTimersByTime(31000);

      // First success keeps HALF_OPEN
      const successOp = jest.fn().mockResolvedValue('ok');
      await circuitBreaker.execute(successOp);

      // Second call fails -> back to OPEN
      await expect(circuitBreaker.execute(failingOp)).rejects.toThrow('error');
      expect(circuitBreaker.getState()).toBe('OPEN');
    });
  });

  describe('reset', () => {
    it('should reset to CLOSED state', async () => {
      // Trip the circuit
      const failingOp = jest.fn().mockRejectedValue(new Error('error'));
      for (let i = 0; i < 5; i++) {
        await expect(circuitBreaker.execute(failingOp)).rejects.toThrow('error');
      }
      expect(circuitBreaker.getState()).toBe('OPEN');

      circuitBreaker.reset();
      expect(circuitBreaker.getState()).toBe('CLOSED');
      expect(circuitBreaker.getStats().failureCount).toBe(0);
      expect(circuitBreaker.getStats().successCount).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return accurate statistics', () => {
      const stats = circuitBreaker.getStats();
      expect(stats).toHaveProperty('state');
      expect(stats).toHaveProperty('failureCount');
      expect(stats).toHaveProperty('successCount');
      expect(stats).toHaveProperty('lastFailureTime');
      expect(stats).toHaveProperty('isClosed');
      expect(stats).toHaveProperty('isOpen');
      expect(stats).toHaveProperty('isHalfOpen');
    });
  });
});
