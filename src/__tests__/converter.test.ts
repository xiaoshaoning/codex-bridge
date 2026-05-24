import {
  convert_responses_to_chat_completions,
  convert_chat_completions_to_responses,
  convert_regular_response,
  convert_tool_calls_response,
  convert_stream_chunk,
  parse_xml_function_calls,
  parse_deepseek_stream_chunk,
  strip_markdown_fences,
  escape_non_ascii_to_unicode,
  escape_json_string_values,
  DeepSeekChatResponse,
  OpenAiResponsesRequest,
  StreamChunk
} from '../converter';

function createMockLogger(): any {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn()
  };
}

describe('convert_responses_to_chat_completions', () => {
  let logger: any;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('should convert a simple chat request', () => {
    const req: OpenAiResponsesRequest = {
      model: 'deepseek-chat',
      input: ['Hello, how are you?'],
      stream: false
    };

    const result = convert_responses_to_chat_completions(req, logger);

    expect(result.model).toBe('deepseek-v4-pro');
    expect(result.stream).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: 'Hello, how are you?'
    });
  });

  it('should convert string input to array', () => {
    const req: OpenAiResponsesRequest = {
      model: 'deepseek-chat',
      input: 'Hello' as any,
      stream: false
    };

    const result = convert_responses_to_chat_completions(req, logger);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe('Hello');
  });

  it('should add instructions as system message', () => {
    const req: OpenAiResponsesRequest = {
      model: 'deepseek-chat',
      input: ['Hello'],
      instructions: 'You are a helpful assistant.',
      stream: false
    };

    const result = convert_responses_to_chat_completions(req, logger);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({
      role: 'system',
      content: 'You are a helpful assistant.'
    });
    expect(result.messages[1]).toEqual({
      role: 'user',
      content: 'Hello'
    });
  });

  it('should map model names correctly', () => {
    const model_tests: [string, string][] = [
      ['gpt-5.1-codex-max', 'deepseek-v4-pro'],
      ['gpt-5.1-codex-mini', 'deepseek-v4-flash'],
      ['gpt-5.1-codex', 'deepseek-v4-pro'],
      ['gpt-5.1', 'deepseek-v4-pro'],
      ['gpt-4', 'deepseek-v4-pro'],
      ['gpt-3.5-turbo', 'deepseek-v4-flash'],
      ['unknown-model', 'deepseek-v4-pro'],
    ];

    for (const [input_model, expected_model] of model_tests) {
      const req: OpenAiResponsesRequest = { model: input_model, input: ['hi'], stream: false };
      const result = convert_responses_to_chat_completions(req, logger);
      expect(result.model).toBe(expected_model);
    }
  });

  it('should default to deepseek-v4-pro when model is not provided', () => {
    const req: OpenAiResponsesRequest = { input: ['hi'], stream: false };
    const result = convert_responses_to_chat_completions(req, logger);
    expect(result.model).toBe('deepseek-v4-pro');
  });

  it('should convert tool calls array', () => {
    const req: OpenAiResponsesRequest = {
      model: 'deepseek-chat',
      input: ['Get the weather in London'],
      stream: false,
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get weather for a location',
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location']
          }
        }
      ]
    };

    const result = convert_responses_to_chat_completions(req, logger);

    expect(result.tools).toBeDefined();
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].function.name).toBe('get_weather');
    expect(result.tool_choice).toBe('auto');
  });

  it('should force tool_choice=none for unsupported tools', () => {
    const req: OpenAiResponsesRequest = {
      model: 'deepseek-chat',
      input: ['hello'],
      stream: false,
      tools: [{ type: 'computer_use' } as any]
    };

    const result = convert_responses_to_chat_completions(req, logger);

    expect(result.tools).toBeUndefined();
    expect(result.tool_choice).toBe('none');
  });

  it('should convert input items with type=message', () => {
    const req: OpenAiResponsesRequest = {
      model: 'deepseek-chat',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello' }]
      }],
      stream: false
    };

    const result = convert_responses_to_chat_completions(req, logger);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: 'Hello'
    });
  });

  it('should convert developer role to system', () => {
    const req: OpenAiResponsesRequest = {
      model: 'deepseek-chat',
      input: [{
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Be helpful' }]
      }],
      stream: false
    };

    const result = convert_responses_to_chat_completions(req, logger);

    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toBe('Be helpful');
  });

  it('should convert function_call input items', () => {
    const req: OpenAiResponsesRequest = {
      model: 'deepseek-chat',
      input: [{
        type: 'function_call',
        call_id: 'call_123',
        name: 'get_weather',
        arguments: '{"location":"London"}'
      }],
      stream: false
    };

    const result = convert_responses_to_chat_completions(req, logger);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].content).toBeNull();
    expect(result.messages[0].tool_calls).toBeDefined();
    expect(result.messages[0].tool_calls[0].function.name).toBe('get_weather');
  });

  it('should convert function_call_output input items', () => {
    const req: OpenAiResponsesRequest = {
      model: 'deepseek-chat',
      input: [{
        type: 'function_call_output',
        call_id: 'call_123',
        output: '{"temperature": 22}'
      }],
      stream: false
    };

    const result = convert_responses_to_chat_completions(req, logger);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('tool');
    expect(result.messages[0].content).toBe('{"temperature": 22}');
    expect(result.messages[0].tool_call_id).toBe('call_123');
  });

  it('should use messages field when input is not present', () => {
    const req: any = {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Hello' }
      ],
      stream: false
    };

    const result = convert_responses_to_chat_completions(req, logger);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toBe('Be helpful');
    expect(result.messages[1].content).toBe('Hello');
  });

  it('should add default message when no input/messages provided', () => {
    const req: OpenAiResponsesRequest = { stream: false };
    const result = convert_responses_to_chat_completions(req, logger);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe('Hello');
  });

  it('should truncate long instructions', () => {
    process.env.MAX_INSTRUCTION_LENGTH = '500';
    const longInstructions = 'A'.repeat(1000);
    const req: OpenAiResponsesRequest = {
      model: 'deepseek-chat',
      input: ['hi'],
      instructions: longInstructions,
      stream: false
    };

    const result = convert_responses_to_chat_completions(req, logger);

    expect(result.messages[0].content!.length).toBeLessThanOrEqual(600);
    expect(result.messages[0].content).toContain('[truncated]');
    delete process.env.MAX_INSTRUCTION_LENGTH;
  });

  it('should enhance instructions for tool call keywords', () => {
    const req: OpenAiResponsesRequest = {
      model: 'deepseek-chat',
      input: ['Run a command'],
      instructions: 'Emit function calls when needed',
      stream: false,
      tools: [{ type: 'function', name: 'run_command', description: 'Run a shell command', parameters: {} }]
    };

    const result = convert_responses_to_chat_completions(req, logger);

    expect(result.messages[0].content).toContain('IMPORTANT');
    expect(result.tools).toBeDefined();
  });

  it('should skip web_search tools', () => {
    const req: OpenAiResponsesRequest = {
      model: 'deepseek-chat',
      input: ['search something'],
      stream: false,
      tools: [
        { type: 'web_search' },
        { type: 'function', name: 'my_func', description: 'a func', parameters: {} }
      ]
    };

    const result = convert_responses_to_chat_completions(req, logger);

    expect(result.tools).toBeDefined();
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].function.name).toBe('my_func');
  });
});

describe('convert_chat_completions_to_responses', () => {
  let logger: any;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('should convert a regular text response', () => {
    const deepseekResp: DeepSeekChatResponse = {
      id: 'test_id',
      object: 'chat.completion',
      created: 1234567890,
      model: 'deepseek-chat',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    };

    const result = convert_chat_completions_to_responses(
      deepseekResp,
      { model: 'deepseek-chat', stream: false },
      logger
    );

    expect(result).not.toBeNull();
    expect(result!.choices[0].message.content).toBe('Hello!');
    expect(result!.choices[0].finish_reason).toBe('stop');
  });

  it('should return null for empty choices', () => {
    const deepseekResp: DeepSeekChatResponse = {
      id: 'test_id',
      object: 'chat.completion',
      created: 0,
      model: 'deepseek-chat',
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    const result = convert_chat_completions_to_responses(
      deepseekResp,
      { model: 'deepseek-chat', stream: false },
      logger
    );

    expect(result).toBeNull();
  });

  it('should detect and convert tool calls response', () => {
    const deepseekResp: DeepSeekChatResponse = {
      id: 'test_id',
      object: 'chat.completion',
      created: 1234567890,
      model: 'deepseek-chat',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"location":"London"}'
            }
          }]
        },
        finish_reason: 'tool_calls'
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    const result = convert_chat_completions_to_responses(
      deepseekResp,
      { model: 'deepseek-chat', stream: false },
      logger
    );

    expect(result).not.toBeNull();
    expect(result!.choices[0].message.tool_calls).toBeDefined();
    expect(result!.choices[0].message.tool_calls).toHaveLength(1);
    expect(result!.choices[0].message.tool_calls![0].function.name).toBe('get_weather');
  });
});

describe('convert_regular_response', () => {
  let logger: any;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('should handle XML function calls in content', () => {
    const deepseekResp: DeepSeekChatResponse = {
      id: 'test_id',
      object: 'chat.completion',
      created: 1234567890,
      model: 'deepseek-chat',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '<function_call><invoke name="get_weather"><parameter name="location">London</parameter></invoke></function_call>'
        },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    const result = convert_regular_response(deepseekResp, { model: 'deepseek-chat', stream: false }, logger);

    expect(result).not.toBeNull();
    expect(result!.choices[0].message.tool_calls).toBeDefined();
    expect(result!.choices[0].finish_reason).toBe('tool_calls');
  });

  it('should parse markdown-wrapped content', () => {
    const deepseekResp: DeepSeekChatResponse = {
      id: 'test_id',
      object: 'chat.completion',
      created: 1234567890,
      model: 'deepseek-chat',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '```\nHello\n```' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    const result = convert_regular_response(deepseekResp, { model: 'deepseek-chat', stream: false }, logger);

    expect(result).not.toBeNull();
    expect(result!.choices[0].message.content).toBe('Hello');
  });
});

describe('convert_tool_calls_response', () => {
  let logger: any;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('should convert tool calls with proper format', () => {
    const deepseekResp: DeepSeekChatResponse = {
      id: 'test_id',
      object: 'chat.completion',
      created: 1234567890,
      model: 'deepseek-chat',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_abc',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"location":"London"}'
            }
          }]
        },
        finish_reason: 'tool_calls'
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    const result = convert_tool_calls_response(deepseekResp, { model: 'deepseek-chat', stream: false }, logger);

    expect(result).not.toBeNull();
    expect(result!.object).toBe('response');
    expect(result!.choices[0].message.content).toBe('');
    expect(result!.choices[0].message.tool_calls).toHaveLength(1);
    expect(result!.choices[0].message.tool_calls![0].id).toBe('call_abc');
  });
});

describe('convert_stream_chunk', () => {
  it('should convert text chunk', () => {
    const chunk = {
      id: 'chunk_1',
      object: 'chat.completion.chunk',
      created: 1234567890,
      model: 'deepseek-chat',
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }]
    };

    const result = convert_stream_chunk(chunk, { model: 'deepseek-chat', stream: true });

    expect(result).not.toBeNull();
    expect(result!.choices[0].delta.content).toBe('Hello');
    expect(result!.object).toBe('response');
    expect(result!.system_fingerprint).toBe('fp_deepseek_proxy');
  });

  it('should convert tool call chunk', () => {
    const chunk = {
      id: 'chunk_2',
      object: 'chat.completion.chunk',
      created: 1234567890,
      model: 'deepseek-chat',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"loc' }
          }]
        },
        finish_reason: null
      }]
    };

    const result = convert_stream_chunk(chunk, { model: 'deepseek-chat', stream: true });

    expect(result).not.toBeNull();
    expect(result!.choices[0].delta.tool_calls).toBeDefined();
    expect(result!.choices[0].delta.tool_calls![0].function.name).toBe('get_weather');
  });

  it('should handle finish_reason chunk', () => {
    const chunk = {
      id: 'chunk_3',
      object: 'chat.completion.chunk',
      created: 1234567890,
      model: 'deepseek-chat',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    };

    const result = convert_stream_chunk(chunk, { model: 'deepseek-chat', stream: true });

    expect(result).not.toBeNull();
    expect(result!.choices[0].finish_reason).toBe('stop');
  });

  it('should return null for empty choices', () => {
    const chunk = {
      id: 'chunk_4',
      object: 'chat.completion.chunk',
      created: 1234567890,
      model: 'deepseek-chat',
      choices: []
    };

    const result = convert_stream_chunk(chunk, { model: 'deepseek-chat', stream: true });
    expect(result).toBeNull();
  });
});

describe('parse_deepseek_stream_chunk', () => {
  it('should parse a valid chunk', () => {
    const buffer = Buffer.from('data: {"choices":[{"delta":{"content":"Hello"}}]}');
    const result = parse_deepseek_stream_chunk(buffer);
    expect(result).not.toBeNull();
    expect(result.choices[0].delta.content).toBe('Hello');
  });

  it('should return null for non-data lines', () => {
    const buffer = Buffer.from('some random text');
    const result = parse_deepseek_stream_chunk(buffer);
    expect(result).toBeNull();
  });

  it('should return null for [DONE] signal', () => {
    const buffer = Buffer.from('data: [DONE]');
    const result = parse_deepseek_stream_chunk(buffer);
    expect(result).toBeNull();
  });

  it('should return null for invalid JSON', () => {
    const buffer = Buffer.from('data: {invalid json}');
    const result = parse_deepseek_stream_chunk(buffer);
    expect(result).toBeNull();
  });
});

describe('parse_xml_function_calls', () => {
  let logger: any;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('should return clean content with no tool calls when no XML', () => {
    const result = parse_xml_function_calls('Hello, this is a response', logger);
    expect(result.clean_content).toBe('Hello, this is a response');
    expect(result.tool_calls).toHaveLength(0);
  });

  it('should parse XML function calls', () => {
    const content = 'Some text <function_call><invoke name="get_weather"><parameter name="location">London</parameter></invoke></function_call> more text';
    const result = parse_xml_function_calls(content, logger);

    expect(result.clean_content).toBe('Some text  more text');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].function.name).toBe('get_weather');
  });

  it('should handle null/empty content', () => {
    const result = parse_xml_function_calls('', logger);
    expect(result.clean_content).toBe('');
    expect(result.tool_calls).toHaveLength(0);
  });
});

describe('strip_markdown_fences', () => {
  it('should remove code fences', () => {
    expect(strip_markdown_fences('```json\n{"key": "value"}\n```')).toBe('{"key": "value"}');
  });

  it('should not modify text without fences', () => {
    expect(strip_markdown_fences('normal text')).toBe('normal text');
  });
});

describe('escape_non_ascii_to_unicode', () => {
  it('should keep ASCII text unchanged', () => {
    expect(escape_non_ascii_to_unicode('Hello')).toBe('Hello');
  });

  it('should escape non-ASCII characters', () => {
    const result = escape_non_ascii_to_unicode('Hello 世界');
    expect(result).toContain('Hello');
    expect(result).not.toContain('世界');
    expect(result).toContain('\\u');
  });

  it('should handle surrogate pairs', () => {
    const result = escape_non_ascii_to_unicode('Hello 😀');
    expect(result).toContain('Hello');
    expect(result).toContain('\\U');
  });
});

describe('escape_json_string_values', () => {
  it('should escape string values', () => {
    const result = escape_json_string_values({ text: 'Hello 世界' });
    expect(result.text).not.toContain('世界');
    expect(result.text).toContain('\\u');
  });

  it('should handle arrays', () => {
    const result = escape_json_string_values(['Hello 世界', 'plain']);
    expect(typeof result[0]).toBe('string');
    expect(result[1]).toBe('plain');
  });

  it('should handle non-string primitives', () => {
    expect(escape_json_string_values(42)).toBe(42);
    expect(escape_json_string_values(null)).toBe(null);
    expect(escape_json_string_values(true)).toBe(true);
  });
});
