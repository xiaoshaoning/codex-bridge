import { Response } from 'express';

// Mock converter functions (only utility functions still imported directly)
jest.mock('../converter', () => ({
  strip_markdown_fences: jest.fn((s: string) => s),
  escape_non_ascii_to_unicode: jest.fn((s: string) => s),
  parse_xml_function_calls: jest.fn((content: string) => {
    // Simplified XML parser for testing — handles basic function_call XML
    const tool_calls: any[] = [];
    const fcMatch = content.match(/<function_call>.*?<\/function_call>/gs);
    if (fcMatch) {
      for (const fc of fcMatch) {
        const invokeMatch = fc.match(/<invoke\s+name="([^"]*)"[^>]*>/);
        if (invokeMatch) {
          const name = invokeMatch[1];
          const argsMatch = fc.match(/<parameter\s+name="([^"]*)">([^<]*)<\/parameter>/g);
          const args: any = {};
          if (argsMatch) {
            for (const p of argsMatch) {
              const pm = p.match(/<parameter\s+name="([^"]*)">([^<]*)<\/parameter>/);
              if (pm) args[pm[1]] = pm[2];
            }
          }
          tool_calls.push({
            id: `call_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) }
          });
        }
      }
    }
    return { clean_content: '', tool_calls };
  }),
  fix_verilog_system_tasks: jest.fn((s: string) => s),
}));

// Mock connection-pool
jest.mock('../connection-pool', () => ({
  ConnectionPool: {
    getInstance: jest.fn().mockReturnValue({
      getStreamingClient: jest.fn().mockReturnValue({
        post: jest.fn(),
      }),
      getClient: jest.fn().mockReturnValue({
        post: jest.fn(),
      }),
    }),
  },
}));

// Mock circuit-breaker
jest.mock('../circuit-breaker', () => ({
  CircuitBreaker: jest.fn().mockImplementation(() => ({
    execute: jest.fn().mockImplementation(async (fn: any) => fn()),
  })),
}));

// Mock metrics
jest.mock('../metrics', () => ({
  upstreamRequestDuration: { labels: jest.fn().mockReturnValue({ observe: jest.fn() }) },
  streamingRequestDuration: { observe: jest.fn() },
  streamChunksTotal: { inc: jest.fn() },
}));

describe('Streaming', () => {
  let mockRes: any;
  let mockLogger: any;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockRes = {
      setHeader: jest.fn(),
      write: jest.fn().mockReturnValue(true),
      end: jest.fn(),
      on: jest.fn(),
      once: jest.fn(),
      removeListener: jest.fn(),
      emit: jest.fn(),
    };

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    mockPlugin = {
      name: 'test',
      matchesModel: jest.fn(),
      convertRequest: jest.fn(),
      convertResponse: jest.fn(),
      parseStreamChunk: jest.fn(),
      convertStreamChunk: jest.fn(),
      getApiUrl: jest.fn(),
      getAuthHeaders: jest.fn(),
    };
  });

  describe('generate_simulated_sse()', () => {
    it('yields initial chunk with correct SSE format', () => {
      const { generate_simulated_sse } = require('../streaming');
      const response = {
        id: 'resp_123',
        object: 'response',
        model: 'deepseek-chat',
        created: 1234567890,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello world' },
          finish_reason: 'stop'
        }]
      };

      const gen = generate_simulated_sse(response, mockLogger);
      const chunks = Array.from(gen) as string[];

      // First chunk should be response.output_item.added with message item
      const first = chunks[0];
      expect(first).toContain('event: response.output_item.added');
      const firstData = JSON.parse(first.split('\n')[1].replace(/^data: /, ''));
      expect(firstData.item.type).toBe('message');
      expect(firstData.item.role).toBe('assistant');
      expect(firstData.item.content).toEqual([]);

      // Last chunk should be [DONE]
      expect(chunks[chunks.length - 1]).toBe('data: [DONE]\n\n');
    });

    it('splits content into chunks at word boundaries', () => {
      const { generate_simulated_sse } = require('../streaming');
      const longText = 'A'.repeat(200);
      const response = {
        id: 'resp_1',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: longText },
          finish_reason: 'stop'
        }]
      };

      const gen = generate_simulated_sse(response, mockLogger);
      const chunks = Array.from(gen) as string[];

      // Should have: added + multiple content deltas + done + completed + [DONE]
      expect(chunks.length).toBeGreaterThan(4);

      // Content chunks should be response.output_text.delta events
      const deltaChunks = chunks
        .filter(c => c.includes('response.output_text.delta'))
        .map(c => JSON.parse(c.split('\n')[1].replace(/^data: /, '')));
      const allContent = deltaChunks.map((c: any) => c.delta || '').join('');
      expect(allContent).toContain(longText);
    });

    it('yields final chunk with finish_reason', () => {
      const { generate_simulated_sse } = require('../streaming');
      const response = {
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hi' },
          finish_reason: 'stop'
        }]
      };

      const gen = generate_simulated_sse(response, mockLogger);
      const chunks = Array.from(gen) as string[];

      // Should have response.completed event before [DONE]
      const completedChunk = chunks.find(c => c.includes('response.completed'));
      expect(completedChunk).toBeDefined();

      // Last chunk should be [DONE]
      expect(chunks[chunks.length - 1]).toBe('data: [DONE]\n\n');
    });

    it('emits progressive SSE events for tool calls', () => {
      const { generate_simulated_sse } = require('../streaming');
      const response = {
        id: 'resp_1',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"London"}' } }]
          },
          finish_reason: 'tool_calls'
        }]
      };

      const gen = generate_simulated_sse(response, mockLogger);
      const chunks = Array.from(gen) as string[];
      const sseChunks = chunks.filter(c => c.startsWith('event:') && !c.includes('[DONE]'));

      // Should have: added + delta(s) + done + completed
      const eventTypes = sseChunks
        .filter(c => c.startsWith('event: response'))
        .map(c => c.split('\n')[0].replace('event: ', ''));
      expect(eventTypes).toContain('response.output_item.added');
      expect(eventTypes).toContain('response.output_text.delta');
      expect(eventTypes).toContain('response.output_item.done');
      expect(eventTypes).toContain('response.completed');

      // Verify added event contains call_id and name
      const addedChunk = sseChunks.find(c => c.includes('response.output_item.added'))!;
      const addedData = JSON.parse(addedChunk.split('\n')[1].replace(/^data: /, ''));
      expect(addedData.item.type).toBe('function_call');
      expect(addedData.item.call_id).toBe('call_1');
      expect(addedData.item.name).toBe('get_weather');

      // Verify done event contains complete arguments
      const doneChunk = sseChunks.find(c => c.includes('response.output_item.done'))!;
      const doneData = JSON.parse(doneChunk.split('\n')[1].replace(/^data: /, ''));
      expect(doneData.item.arguments).toBe('{"city":"London"}');
    });

    it('yields just [DONE] when response has no choices', () => {
      const { generate_simulated_sse } = require('../streaming');
      const response = { id: 'resp_1', choices: [] };

      const gen = generate_simulated_sse(response, mockLogger);
      const chunks = Array.from(gen) as string[];

      expect(chunks[chunks.length - 1]).toBe('data: [DONE]\n\n');
      expect(chunks.length).toBeLessThanOrEqual(2);
    });

    it('handles SSE generation error gracefully', () => {
      const { generate_simulated_sse } = require('../streaming');

      // Pass null to trigger error in the generator
      const gen = generate_simulated_sse(null, mockLogger);
      const chunks = Array.from(gen) as string[];

      // Should still yield an error chunk and [DONE]
      expect(chunks.some(c => c.includes('error'))).toBe(true);
      expect(chunks[chunks.length - 1]).toBe('data: [DONE]\n\n');
    });
  });

  describe('handle_streaming_response()', () => {
    let mockStream: any;
    let mockClient: any;

    beforeEach(() => {
      mockStream = {
        on: jest.fn(),
        destroy: jest.fn(),
        destroyed: false,
      };

      mockClient = {
        post: jest.fn().mockResolvedValue({
          status: 200,
          data: mockStream,
        }),
      };

      const pool = require('../connection-pool').ConnectionPool;
      pool.getInstance.mockReturnValue({
        getStreamingClient: jest.fn().mockReturnValue(mockClient),
        getClient: jest.fn().mockReturnValue(mockClient),
      });
    });

    it('sends SSE headers on successful connection', async () => {
      const { handle_streaming_response } = require('../streaming');

      const promise = handle_streaming_response(
        'https://api.deepseek.com/chat/completions',
        { stream: true, model: 'deepseek-chat', messages: [] },
        { Authorization: 'Bearer test-key' },
        { stream: true },
        mockRes,
        mockLogger,
        Date.now(),
        mockPlugin
      );

      // Wait for microtasks so stream.on handlers are registered
      await new Promise(resolve => setImmediate(resolve));

      // Simulate stream 'data' and 'end' events
      const dataHandler = mockStream.on.mock.calls.find((c: any[]) => c[0] === 'data')[1];
      const endHandler = mockStream.on.mock.calls.find((c: any[]) => c[0] === 'end')[1];

      mockPlugin.parseStreamChunk.mockReturnValue({
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }]
      });
      mockPlugin.convertStreamChunk.mockReturnValue({
        id: 'resp_1',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }]
      });

      await dataHandler(Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}'));
      await endHandler();

      await promise;

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream; charset=utf-8');
      expect(mockRes.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(mockRes.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    });

    it('handles error status from upstream', async () => {
      mockClient.post.mockRejectedValue(new Error('DeepSeek API error 500'));

      const { handle_streaming_response } = require('../streaming');

      await expect(handle_streaming_response(
        'https://api.deepseek.com/chat/completions',
        { stream: true },
        {},
        { stream: true },
        mockRes,
        mockLogger,
        Date.now()
      )).rejects.toThrow();
    });

    it('carries upstream error data on HTTP error response', async () => {
      const mockErrorStream = {
        on: jest.fn().mockImplementation((event: string, handler: Function) => {
          if (event === 'data') {
            handler(Buffer.from('{"error":{"message":"Invalid API key","type":"authentication_error","code":"invalid_api_key"}}'));
          }
          if (event === 'end') handler();
        }),
        destroy: jest.fn(),
        destroyed: false,
      };
      mockClient.post.mockResolvedValue({
        status: 401,
        data: mockErrorStream,
      });

      const { handle_streaming_response } = require('../streaming');

      try {
        await handle_streaming_response(
          'https://api.deepseek.com/chat/completions',
          { stream: true, model: 'deepseek-chat', messages: [] },
          { Authorization: 'Bearer bad-key' },
          { stream: true },
          mockRes,
          mockLogger,
          Date.now()
        );
        fail('Expected error to be thrown');
      } catch (err: any) {
        expect(err.statusCode).toBe(401);
        expect(err.upstreamData).toContain('Invalid API key');
        expect(err.upstreamData).toContain('authentication_error');
      }
    });

    it('handles client disconnect mid-stream', async () => {
      const { handle_streaming_response } = require('../streaming');

      const promise = handle_streaming_response(
        'https://api.deepseek.com/chat/completions',
        { stream: true, model: 'deepseek-chat', messages: [] },
        { Authorization: 'Bearer test-key' },
        { stream: true },
        mockRes,
        mockLogger,
        Date.now(),
        mockPlugin
      );

      // Give microtasks a chance to register the close handler
      await new Promise(resolve => setImmediate(resolve));

      // Simulate client close
      const closeCalls = mockRes.on.mock.calls;
      const closeHandler = closeCalls.find((c: any[]) => c[0] === 'close');
      if (closeHandler) {
        closeHandler[1]();
      }

      await promise;

      expect(mockLogger.info).toHaveBeenCalledWith('Client disconnected during stream');
      expect(mockStream.destroy).toHaveBeenCalled();
      expect(mockRes.end).toHaveBeenCalled();
    });

    it('handles stream data event and yields SSE events', async () => {
      const { handle_streaming_response } = require('../streaming');

      const promise = handle_streaming_response(
        'https://api.deepseek.com/chat/completions',
        { stream: true, model: 'deepseek-chat', messages: [] },
        { Authorization: 'Bearer test-key' },
        { stream: true },
        mockRes,
        mockLogger,
        Date.now(),
        mockPlugin
      );

      // Wait for microtasks so stream.on handlers are registered
      await new Promise(resolve => setImmediate(resolve));

      // Get stream event handlers
      const dataHandler = mockStream.on.mock.calls.find((c: any[]) => c[0] === 'data')[1];
      const endHandler = mockStream.on.mock.calls.find((c: any[]) => c[0] === 'end')[1];

      // Simulate incoming chunk from DeepSeek
      mockPlugin.parseStreamChunk.mockReturnValue({
        choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }]
      });
      mockPlugin.convertStreamChunk.mockReturnValue({
        id: 'resp_1',
        choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }]
      });

      await dataHandler(Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}'));

      // Simulate finishing chunk
      mockPlugin.parseStreamChunk.mockReturnValue({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      });
      mockPlugin.convertStreamChunk.mockReturnValue({
        id: 'resp_1',
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      });

      await dataHandler(Buffer.from('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'));

      // End stream
      await endHandler();
      await promise;

      // Should write SSE events to response
      expect(mockRes.write).toHaveBeenCalled();
      const writeCalls = mockRes.write.mock.calls.map((c: any[]) => c[0]);
      const sseEvents = writeCalls.filter((w: string) => w.startsWith('event:'));
      expect(sseEvents.length).toBeGreaterThan(0);
    });

    it('emits progressive events during tool call streaming', async () => {
      const { handle_streaming_response } = require('../streaming');

      const promise = handle_streaming_response(
        'https://api.deepseek.com/chat/completions',
        { stream: true, model: 'deepseek-chat', messages: [] },
        { Authorization: 'Bearer test-key' },
        { stream: true },
        mockRes,
        mockLogger,
        Date.now(),
        mockPlugin
      );

      await new Promise(resolve => setImmediate(resolve));

      const dataHandler = mockStream.on.mock.calls.find((c: any[]) => c[0] === 'data')[1];
      const endHandler = mockStream.on.mock.calls.find((c: any[]) => c[0] === 'end')[1];

      // Simulate first tool call chunk — sets id and name
      mockPlugin.parseStreamChunk.mockReturnValue({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }]
      });
      mockPlugin.convertStreamChunk.mockReturnValue({
        id: 'resp_1',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }]
      });

      await dataHandler(Buffer.from('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}'));

      // Verify response.output_item.added was emitted
      const addedCall = mockRes.write.mock.calls.find((c: any[]) => c[0].includes('response.output_item.added'));
      expect(addedCall).toBeDefined();
      if (addedCall) {
        const data = JSON.parse(addedCall[0].split('data: ')[1].trim());
        expect(data.item.type).toBe('function_call');
        expect(data.item.call_id).toBe('call_abc');
        expect(data.item.name).toBe('get_weather');
      }

      mockRes.write.mockClear();

      // Simulate second tool call chunk — partial arguments
      mockPlugin.parseStreamChunk.mockReturnValue({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] }, finish_reason: null }]
      });
      mockPlugin.convertStreamChunk.mockReturnValue({
        id: 'resp_1',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] }, finish_reason: null }]
      });

      await dataHandler(Buffer.from('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\""}}]}}]}'));

      // Verify response.output_text.delta was emitted for partial args
      const deltaCall = mockRes.write.mock.calls.find((c: any[]) => c[0].includes('response.output_text.delta'));
      expect(deltaCall).toBeDefined();
      if (deltaCall) {
        const data = JSON.parse(deltaCall[0].split('data: ')[1].trim());
        expect(data.delta).toBe('{"city"');
      }

      mockRes.write.mockClear();

      // Simulate third tool call chunk — more partial args
      mockPlugin.parseStreamChunk.mockReturnValue({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"London"}' } }] }, finish_reason: null }]
      });
      mockPlugin.convertStreamChunk.mockReturnValue({
        id: 'resp_1',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"London"}' } }] }, finish_reason: null }]
      });

      await dataHandler(Buffer.from('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"London\\"}"}}]}}]}'));

      // Verify second delta emitted
      const deltaCall2 = mockRes.write.mock.calls.find((c: any[]) => c[0].includes('response.output_text.delta'));
      expect(deltaCall2).toBeDefined();

      mockRes.write.mockClear();

      // Simulate finish chunk
      mockPlugin.parseStreamChunk.mockReturnValue({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
      });
      mockPlugin.convertStreamChunk.mockReturnValue({
        id: 'resp_1',
        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
      });

      await dataHandler(Buffer.from('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}'));

      // Verify response.output_item.done was emitted with complete arguments
      const doneCall = mockRes.write.mock.calls.find((c: any[]) => c[0].includes('response.output_item.done'));
      expect(doneCall).toBeDefined();
      if (doneCall) {
        const data = JSON.parse(doneCall[0].split('data: ')[1].trim());
        expect(data.item.type).toBe('function_call');
        expect(data.item.call_id).toBe('call_abc');
        expect(data.item.name).toBe('get_weather');
        expect(data.item.arguments).toContain('"city"');
        expect(data.item.arguments).toContain('London');
      }

      // Verify response.completed was emitted
      const completedCall = mockRes.write.mock.calls.find((c: any[]) => c[0].includes('response.completed'));
      expect(completedCall).toBeDefined();

      await endHandler();
      await promise;
    });

    it('parses XML function calls from buffered content when tools are present', async () => {
      const { handle_streaming_response } = require('../streaming');

      // Original request has tools defined — triggers has_tools = true
      const originalRequest = {
        stream: true,
        tools: [{ type: 'function', function: { name: 'write_file', description: 'Write file', parameters: { type: 'object', properties: { filepath: { type: 'string' }, content: { type: 'string' } } } } }]
      };

      const promise = handle_streaming_response(
        'https://api.deepseek.com/chat/completions',
        { stream: true, model: 'deepseek-chat', messages: [] },
        { Authorization: 'Bearer test-key' },
        originalRequest,
        mockRes,
        mockLogger,
        Date.now(),
        mockPlugin
      );

      await new Promise(resolve => setImmediate(resolve));

      const dataHandler = mockStream.on.mock.calls.find((c: any[]) => c[0] === 'data')[1];
      const endHandler = mockStream.on.mock.calls.find((c: any[]) => c[0] === 'end')[1];

      // Simulate content that contains XML function calls
      mockPlugin.parseStreamChunk.mockReturnValue({
        choices: [{ index: 0, delta: { content: '<function_call>\n<invoke name="write_file">\n<parameter name="filepath">test.py</parameter>\n<parameter name="content">print("hello")</parameter>\n</invoke>\n</function_call>' }, finish_reason: null }]
      });
      mockPlugin.convertStreamChunk.mockReturnValue({
        id: 'resp_1',
        choices: [{ index: 0, delta: { content: '<function_call>\n<invoke name="write_file">\n<parameter name="filepath">test.py</parameter>\n<parameter name="content">print("hello")</parameter>\n</invoke>\n</function_call>' }, finish_reason: null }]
      });

      await dataHandler(Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"<function_call>"}}]}'));

      // Content should be buffered, not emitted as text deltas (because has_tools = true)
      expect(mockRes.write).not.toHaveBeenCalled();

      // Simulate finish chunk
      mockPlugin.parseStreamChunk.mockReturnValue({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      });
      mockPlugin.convertStreamChunk.mockReturnValue({
        id: 'resp_1',
        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      });

      await dataHandler(Buffer.from('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'));

      // Now verify tool call events were emitted
      const writeCalls = mockRes.write.mock.calls.map((c: any[]) => c[0]);
      const addedCalls = writeCalls.filter((w: string) => w.includes('response.output_item.added'));
      const doneCalls = writeCalls.filter((w: string) => w.includes('response.output_item.done'));

      // Should have tool call added/done events (not text message events)
      expect(addedCalls.length).toBeGreaterThan(0);
      const addedData = JSON.parse(addedCalls[0].split('data: ')[1].trim());
      expect(addedData.item.type).toBe('function_call');
      expect(addedData.item.name).toBe('write_file');

      expect(doneCalls.length).toBeGreaterThan(0);
      const doneData = JSON.parse(doneCalls[0].split('data: ')[1].trim());
      expect(doneData.item.type).toBe('function_call');

      // Should have response.completed
      const completedCalls = writeCalls.filter((w: string) => w.includes('response.completed'));
      expect(completedCalls.length).toBe(1);

      await endHandler();
      await promise;
    });
  });
});
