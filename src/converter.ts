import { randomBytes } from 'crypto';
// Test tool call support

export function strip_markdown_fences(text: string): string {
  // Remove markdown code fences like ```c ... ```
  return text.replace(/^```[a-zA-Z]*\n?/g, '').replace(/\n?```$/g, '').trim();
}

export function escape_non_ascii_to_unicode(text: string): string {
  // Replace non-ASCII characters with \uXXXX or \UXXXXXXXX escapes
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const codePoint = text.codePointAt(i);
    if (codePoint === undefined) break;

    if (codePoint <= 0x7F) {
      // ASCII character - keep as is
      result += char;
      // i will increment by 1 in loop
    } else {
      // Non-ASCII character
      if (codePoint <= 0xFFFF) {
        // Basic Multilingual Plane: \uXXXX
        result += '\\u' + codePoint.toString(16).padStart(4, '0').toUpperCase();
      } else {
        // Supplementary Plane: \UXXXXXXXX (8 hex digits)
        result += '\\U' + codePoint.toString(16).padStart(8, '0').toUpperCase();
      }
      // Skip the next UTF-16 code unit if this is a surrogate pair (code point > 0xFFFF)
      if (codePoint > 0xFFFF) {
        i++; // Increment i because the character uses two UTF-16 code units
      }
    }
  }
  return result;
}

export function escape_json_string_values(obj: any): any {
  if (typeof obj === 'string') {
    return escape_non_ascii_to_unicode(obj);
  } else if (Array.isArray(obj)) {
    return obj.map(item => escape_json_string_values(item));
  } else if (obj !== null && typeof obj === 'object') {
    const result: any = {};
    for (const key of Object.keys(obj)) {
      result[key] = escape_json_string_values(obj[key]);
    }
    return result;
  } else {
    return obj;
  }
}

const VERILOG_SYSTEM_TASKS = [
  'display', 'finish', 'dumpfile', 'dumpvars', 'monitor', 'stop',
  'fopen', 'fwrite', 'fclose', 'fscanf', 'fdisplay', 'strobe',
  'time', 'realtime', 'readmemh', 'readmemb', 'writememh', 'writememb',
  'random', 'urandom', 'dumpall', 'dumpoff', 'dumpon', 'dumplimit'
];

export function looks_like_verilog(text: string): boolean {
  if (!text || text.length < 10) return false;
  const lower = text.toLowerCase();
  const keywords = [
    'module ', 'endmodule', 'always ', 'initial ', 'posedge ', 'negedge ',
    'input ', 'output ', 'inout ', 'reg ', 'wire ', 'assign ', 'begin', 'end '
  ];
  let matches = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) {
      matches++;
      if (matches >= 2) return true;
    }
  }
  return false;
}

export function fix_verilog_system_tasks(text: string): string {
  if (!text || !looks_like_verilog(text)) return text;
  const task_pattern = VERILOG_SYSTEM_TASKS.join('|');
  // Match system task names not already preceded by $, followed by ( or ; or whitespace+(
  const regex = new RegExp(`(?<!\\\$)\\b(${task_pattern})(\\s*[;(])`, 'gi');
  return text.replace(regex, '$$$1$2');
}

function fix_verilog_in_args(args: any): any {
  if (typeof args === 'string') {
    return fix_verilog_system_tasks(args);
  } else if (Array.isArray(args)) {
    return args.map(fix_verilog_in_args);
  } else if (args !== null && typeof args === 'object') {
    const result: any = {};
    for (const key of Object.keys(args)) {
      result[key] = fix_verilog_in_args(args[key]);
    }
    return result;
  }
  return args;
}

// Map Codex model names to DeepSeek model names (forward) and back (reverse)
const model_mapping: { [key: string]: string } = {
  "gpt-5.1-codex-max": "deepseek-v4-pro",
  "gpt-5.1-codex-mini": "deepseek-v4-flash",
  "gpt-5.1-codex": "deepseek-v4-pro",
  "gpt-5.1": "deepseek-v4-pro",
  "gpt-4": "deepseek-v4-pro",
  "gpt-3.5-turbo": "deepseek-v4-flash",
  "deepseek-chat": "deepseek-v4-pro",
  "deepseek-v4-pro": "deepseek-v4-pro",
  "deepseek-v4-flash": "deepseek-v4-flash"
};

// Return a model name Codex recognizes for metadata lookup
function get_response_model(original_model: string | undefined): string {
  const reverse_mapping: { [key: string]: string } = {
    "deepseek-v4-pro": "gpt-5.1-codex",
    "deepseek-v4-flash": "gpt-5.1-codex-mini"
  };
  const mapped = model_mapping[original_model || ""];
  return reverse_mapping[mapped || ""] || original_model || "gpt-5.1-codex";
}

// DeepSeek Chat Completions requires tool messages to immediately follow the
// assistant message with tool_calls. Codex CLI may insert system messages
// (e.g. approval notes) between them. This function moves such system messages
// to before the corresponding assistant message.
function fix_message_sequence(messages: any[]): any[] {
  const result: any[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // Collect tool messages and any system messages that precede them
      const system_msgs: any[] = [];
      const tool_msgs: any[] = [];
      let j = i + 1;
      while (j < messages.length) {
        if (messages[j].role === 'tool') {
          tool_msgs.push(messages[j]);
          j++;
        } else if (messages[j].role === 'system' && j + 1 < messages.length && messages[j + 1].role === 'tool') {
          // System message that breaks the tool_calls → tool sequence — move it before the assistant
          system_msgs.push(messages[j]);
          j++;
        } else {
          break;
        }
      }
      result.push(...system_msgs);
      result.push(msg);
      result.push(...tool_msgs);
      i = j;
    } else {
      result.push(msg);
      i++;
    }
  }
  return result;
}

// Collapse consecutive identical tool call + result blocks to break DeepSeek
// looping. DeepSeek sometimes repeats the same function call (same name+args,
// different call_id) multiple times. Removing the redundant history prevents
// the model from seeing its own repetition and reinforcing the loop.
function deduplicate_tool_calls(messages: any[]): any[] {
  const result: any[] = [];
  let i = 0;

  while (i < messages.length) {
    if (messages[i].role === 'assistant' && messages[i].tool_calls?.length > 0) {
      // Find end of tool result messages following this assistant
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        j++;
      }

      // Look ahead for consecutive assistant blocks with identical tool calls
      let next = j;
      let has_duplicate = false;
      while (next < messages.length) {
        if (messages[next].role !== 'assistant' || !messages[next].tool_calls) break;

        const is_repeat = messages[i].tool_calls.length === messages[next].tool_calls.length &&
          messages[i].tool_calls.every((tc: any, idx: number) =>
            tc.function?.name === messages[next].tool_calls[idx]?.function?.name &&
            tc.function?.arguments === messages[next].tool_calls[idx]?.function?.arguments
          );

        if (!is_repeat) break;

        has_duplicate = true;
        next++;
        while (next < messages.length && messages[next].role === 'tool') {
          next++;
        }
      }

      // Keep the first occurrence only
      for (let k = i; k < j; k++) {
        result.push(messages[k]);
      }
      i = has_duplicate ? next : j;
    } else {
      result.push(messages[i]);
      i++;
    }
  }

  return result;
}

// Rough token estimate: 1 token ≈ 4 chars for most text, fewer for dense text
function estimate_tokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// Drop oldest non-system messages when total tokens approach the model context limit.
// DeepSeek reports a 1,048,576 token limit (1M tokens). Keep system messages and
// the most recent user/assistant exchanges.
const DEEPSEEK_CONTEXT_LIMIT = parseInt(process.env.CONTEXT_LIMIT || '1048576', 10);
const COMPLETION_HEADROOM = parseInt(process.env.COMPLETION_HEADROOM || '8192', 10);
// Log context budget at module load for debugging
console.log(`[converter] CONTEXT_LIMIT=${DEEPSEEK_CONTEXT_LIMIT}, COMPLETION_HEADROOM=${COMPLETION_HEADROOM}, budget=${DEEPSEEK_CONTEXT_LIMIT - COMPLETION_HEADROOM}`);
function truncate_messages(messages: any[], logger: any): any[] {
  // Count tokens for all messages
  let total_tokens = 0;
  const system_msgs: any[] = [];
  const history_msgs: any[] = [];
  let in_system_block = true;

  for (const msg of messages) {
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
    const tokens = estimate_tokens(text);
    msg._tokens = tokens;

    if (in_system_block && msg.role === 'system') {
      system_msgs.push(msg);
      total_tokens += tokens;
      continue;
    }
    in_system_block = false;
    history_msgs.push(msg);
    total_tokens += tokens;
  }

  const budget = DEEPSEEK_CONTEXT_LIMIT - COMPLETION_HEADROOM;
  if (total_tokens <= budget) {
    // Clean up temp property and return as-is
    for (const m of messages) delete m._tokens;
    return messages;
  }

  // Drop oldest history messages from the front until within budget
  logger.warn(`Total messages exceed context budget: ${total_tokens} > ${budget}, truncating history`);
  while (history_msgs.length > 1 && total_tokens > budget) {
    const oldest = history_msgs.shift();
    if (oldest) {
      total_tokens -= oldest._tokens || 0;
      delete oldest._tokens;
    }
  }

  // Clean up temp properties
  for (const m of system_msgs) delete m._tokens;
  for (const m of history_msgs) delete m._tokens;

  const result = [...system_msgs, ...history_msgs];
  logger.info(`Truncated messages: ${messages.length} → ${result.length}, estimated tokens: ${total_tokens}`);
  return result;
}

// DeepSeek's function calling struggles with complex parameter schemas containing
// many optional fields, often producing empty `{}` arguments. Strip non-required
// properties and convert complex types to simple strings so the model reliably
// generates valid arguments.
function simplify_tool_parameters(params: any): any {
  if (!params || params.type !== 'object') return params;
  if (!Array.isArray(params.required) || params.required.length === 0) {
    return { type: 'object', properties: {}, required: [] };
  }
  const simplified_properties: any = {};
  for (const key of params.required) {
    if (params.properties && params.properties[key]) {
      const prop = params.properties[key];
      // Convert all required fields to simple strings — DeepSeek handles
      // strings reliably but fails on arrays, objects, and enums
      simplified_properties[key] = { type: 'string', description: prop.description || '' };
    }
  }
  return { type: 'object', properties: simplified_properties, required: [...params.required] };
}

export interface OpenAiResponsesRequest {
  model?: string;
  stream?: boolean;
  instructions?: string;
  input?: string | any[];
  messages?: any[];
  tools?: any[];
  tool_choice?: string;
  [key: string]: any;
}

export interface DeepSeekChatRequest {
  model: string;
  messages: any[];
  stream: boolean;
  max_tokens?: number;
  temperature?: number;
  tools?: any[];
  tool_choice?: string;
  thinking?: { type: string };
}

export interface DeepSeekChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
      tool_calls?: any[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  system_fingerprint?: string;
}

export interface OpenAiResponsesResponse {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
      tool_calls?: any[];
    };
    finish_reason: string;
  }>;
  usage: any;
  created: number;
  system_fingerprint?: string;
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: any;
    finish_reason: string | null;
  }>;
  usage?: any;
  system_fingerprint?: string;
}

export function convert_responses_to_chat_completions(responses_request: OpenAiResponsesRequest, logger: any): DeepSeekChatRequest {
  logger.debug(`DEBUG convert_responses_to_chat_completions called, keys: ${Object.keys(responses_request)}`);
  logger.debug(`Full request: ${JSON.stringify(responses_request, null, 2)}`);
  // Use client's stream setting
  const stream = responses_request.stream || false;
  logger.info(`Using streaming mode: ${stream}`);

  // Extract model
  const model = responses_request.model || 'deepseek-v4-pro';

  // Extract instructions as system message
  const messages: any[] = [];

  // Add instructions as system message if present
  if (responses_request.instructions && responses_request.instructions) {
    let instructions = responses_request.instructions;

    // Check if instructions contain Codex CLI tool descriptions
    // Keep original instructions to allow tool calls
    logger.debug(`Original instructions: ${instructions}`);

    // Enhanced detection for tool call scenarios
    const toolCallKeywords = [
      'Emit function calls',
      'Codex CLI',
      'function calls',
      'execute',
      'run command',
      'call function',
      'use tool',
      'tool call',
      'write file',
      'create file',
      'save file',
      'write to',
      'open(',
      'print('
    ];

    let needsToolCallEnhancement = false;
    for (const keyword of toolCallKeywords) {
      if (instructions.toLowerCase().includes(keyword.toLowerCase())) {
        needsToolCallEnhancement = true;
        logger.info(`Detected tool call keyword in instructions: "${keyword}"`);
        break;
      }
    }

    // Also check for patterns that indicate tool usage is expected
    if (instructions.toLowerCase().includes('emit') && instructions.toLowerCase().includes('call')) {
      needsToolCallEnhancement = true;
      logger.info('Detected emit/call pattern in instructions');
    }
    // Truncate instructions if too long to avoid token limits
    const max_instr_len = parseInt(process.env.MAX_INSTRUCTION_LENGTH || '4000', 10);
    if (instructions.length > max_instr_len) {
      logger.warn(`Truncating instructions from ${instructions.length} to ${max_instr_len} chars`);
      // Keep the end of instructions (tool definitions, permissions, skills) rather
      // than the beginning (agent identity boilerplate) which is less useful to DeepSeek
      instructions = instructions.substring(instructions.length - max_instr_len);
      // Add a marker so the model knows content was truncated
      instructions = "[truncated] " + instructions;
    }

    // Enhance instructions for tool call scenarios
    let final_instructions = instructions;
    if (needsToolCallEnhancement) {
      // Add explicit instruction to use available tools
      final_instructions = instructions + "\n\nIMPORTANT: When the user requests an action that matches an available tool function, you MUST use that tool. Do not ask for clarification unless absolutely necessary. Emit the appropriate function call with the best available parameters based on the user's request.";
      // Windows-specific hint: DeepSeek often generates broken python -c with inline
      // multi-line strings on Windows, causing SyntaxError. Steer it toward PowerShell.
      final_instructions += "\n\nOn Windows: prefer PowerShell for file operations (Out-File, Set-Content, Add-Content). Avoid python -c with inline string literals containing newlines — escaping does not work reliably on Windows cmd.";
      logger.info('Enhanced instructions for tool call scenarios');
    }

    // Verilog context hint: DeepSeek often drops $ prefix on system tasks ($display, $finish, etc.)
    const verilog_keywords = ['module ', 'endmodule', 'always ', 'initial ', 'iverilog', '.v '];
    const has_verilog_context = verilog_keywords.some(kw => instructions.toLowerCase().includes(kw));
    if (has_verilog_context) {
      final_instructions += "\n\nWhen generating Verilog code, always prefix system tasks with $ (e.g. $display, $finish, $dumpfile, $dumpvars). Never omit the $ prefix on system tasks.";
      logger.info('Enhanced instructions for Verilog context');
    }

    // Windows PowerShell path hint: backslashes in paths need single quotes to prevent escape interpretation
    const windows_path_patterns = ['D:\\', 'C:\\', 'powershell', 'PowerShell', '.exe', 'iverilog'];
    const has_windows_path_context = windows_path_patterns.some(p => instructions.includes(p));
    if (has_windows_path_context) {
      final_instructions += "\n\nOn Windows in PowerShell: always use single quotes for file paths (e.g. $src = 'D:\\codes\\file.v'). Double quotes interpret \\r, \\n, \\t as escape sequences and will corrupt paths containing those substrings (e.g. \"_v\\rtl\\\" becomes \"_vrtl\\\" because \\r is consumed as carriage return). Single quotes treat backslashes literally.";
      logger.info('Enhanced instructions for Windows PowerShell path escaping');
    }

    messages.push({
      role: "system",
      content: final_instructions
    });
  }

  // Process input array (OpenAI Responses API format)
  if (responses_request.input !== undefined) {
    let input_data = responses_request.input;
    // Ensure input is a list (could be a string)
    if (typeof input_data === 'string') {
      input_data = [input_data];
      logger.info(`Converted string input to list: ${input_data}`);
    }
    if (Array.isArray(input_data)) {
      // Buffer for batching consecutive function_call items into a single assistant message
      let function_call_buffer: any[] = [];

      function flush_function_call_buffer() {
        if (function_call_buffer.length === 0) return;
        const tool_calls = function_call_buffer.map(item => ({
          id: item.call_id,
          type: 'function',
          function: {
            name: item.name,
            arguments: item.arguments
          }
        }));
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.tool_calls) {
          lastMsg.tool_calls = tool_calls;
          logger.debug(`Merged ${function_call_buffer.length} function_calls into previous assistant message`);
        } else {
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: tool_calls
          });
          logger.debug(`Flushed ${function_call_buffer.length} function_calls into new assistant message`);
        }
        function_call_buffer = [];
      }

      for (const item of input_data) {
        if (typeof item === 'string') {
          flush_function_call_buffer();
          // Treat string as user message
          messages.push({
            role: "user",
            content: item
          });
        } else if (typeof item === 'object' && item !== null) {
          const item_type = item.type;
          let role = item.role || 'user';

          if (item_type === 'message' || (!item_type && item.role)) {
            flush_function_call_buffer();
            let content = item.content || [];
            let text = '';
            let text_parts: string[] = [];

            // Extract text from content array
            if (Array.isArray(content)) {
              for (const content_item of content) {
                if (typeof content_item === 'object' && content_item !== null) {
                  if (content_item.type === 'input_text') {
                    text_parts.push(content_item.text || '');
                  } else if ('text' in content_item) {
                    text_parts.push(content_item.text);
                  }
                } else if (typeof content_item === 'string') {
                  text_parts.push(content_item);
                }
              }
              text = text_parts.length > 0 ? text_parts.join('\n') : '';
            } else if (typeof content === 'string') {
              text = content;
            } else {
              text = String(content);
            }

            if (text.trim()) {
              // Convert role to standard roles
              if (role === 'developer') {
                role = 'system';  // developer messages are like system
              }

              messages.push({
                role: role,
                content: text
              });
            }
          } else if (item_type === 'function_call') {
            // Buffer function_call items to batch consecutive calls into one assistant message
            logger.debug(`Buffering function_call item: ${JSON.stringify(item)}`);
            const call_id = item.call_id;
            const name = item.name;
            const args = item.arguments;
            if (call_id && name && args !== undefined) {
              function_call_buffer.push(item);
            } else {
              logger.warn(`Invalid function_call item missing required fields: ${JSON.stringify(item)}`);
            }
          } else if (item_type === 'function_call_output') {
            flush_function_call_buffer();
            // Handle function call output items
            // item structure: { type: "function_call_output", call_id: string, output: string }
            logger.debug(`Processing function_call_output item: ${JSON.stringify(item)}`);
            const call_id = item.call_id;
            const output = item.output;
            if (call_id && output !== undefined) {
              messages.push({
                role: 'tool',
                content: output,
                tool_call_id: call_id
              });
              logger.debug(`Converted function_call_output item: call_id=${call_id}`);
            } else {
              logger.warn(`Invalid function_call_output item missing required fields: ${JSON.stringify(item)}`);
            }
          } else {
            flush_function_call_buffer();
            // For other non-message items (tool calls, etc.)
            // Convert to descriptive text
            logger.warn(`Skipping non-message item type: ${item_type}, item: ${JSON.stringify(item)}`);
          }
        } else {
          flush_function_call_buffer();
          logger.warn(`Skipping unsupported input item type: ${typeof item}`);
        }
      }
      // Flush any remaining function calls at end of input
      flush_function_call_buffer();
    } else {
      logger.warn(`Input field is not a list or string: ${typeof input_data}`);
    }
  } else if (responses_request.messages !== undefined) {
    logger.info(`Using messages field with ${responses_request.messages.length} messages`);
    for (const msg of responses_request.messages) {
      let role = msg.role || 'user';
      const content = msg.content || '';
      if (role === 'developer') {
        role = 'system';
      }
      messages.push({
        role: role,
        content: content
      });
    }
  }

  // If no messages were extracted, create a default user message
  if (messages.length === 0) {
    messages.push({
      role: "user",
      content: "Hello"
    });
  }

  // Map Codex model names to DeepSeek model names (uses module-level model_mapping)
  const deepseek_model = model_mapping[model] || "deepseek-v4-pro";

  // Fix message ordering: DeepSeek requires tool messages to immediately follow
  // the assistant message with tool_calls. System messages (e.g. approval notes from
  // Codex CLI) inserted between tool_calls and tool results break this sequence.
  const fixed_messages = fix_message_sequence(messages);

  // Collapse consecutive identical tool call blocks to break DeepSeek
  // repetition loops (same function name+args repeated with different call_ids).
  const deduped_messages = deduplicate_tool_calls(fixed_messages);

  // Truncate oldest messages when approaching the model's context limit (~1M tokens)
  // to avoid DeepSeek's token limit errors on long conversations.
  const truncated_messages = truncate_messages(deduped_messages, logger);

  // Build chat completions request
  const chat_request: DeepSeekChatRequest = {
    model: deepseek_model,
    messages: truncated_messages,
    stream: stream,
    max_tokens: parseInt(process.env.MAX_TOKENS || '4096', 10),
    temperature: 0.7,
    thinking: { type: "disabled" }
  };

  // Convert tools array if present
  if (responses_request.tools !== undefined) {
    const tools: any[] = [];
    let has_unsupported_tools = false;
    for (const tool of responses_request.tools) {
      logger.debug(`Processing tool: ${JSON.stringify(tool)}`);
      const tool_type = tool.type;
      if (tool_type === 'function') {
        // Convert OpenAI function tool format to DeepSeek format
        // OpenAI Responses API: tool.function.name; Chat Completions: tool.function.name
        const func = tool.function || tool;
        const func_name = func.name || tool.name || 'unknown';
        logger.info(`Including function tool '${func_name}' in request`);
        // Simplify parameters: keep only the required fields to help DeepSeek
        // generate valid arguments (it often produces `{}` with complex schemas)
        const simplified_params = simplify_tool_parameters(func.parameters || {});
        const deepseek_tool = {
          type: "function",
          function: {
            name: func_name,
            description: func.description || '',
            parameters: simplified_params
          }
        };
        tools.push(deepseek_tool);
        continue;
      } else if (tool_type === 'web_search') {
        // Web search tool - DeepSeek may not support this directly
        logger.info(`Skipping web_search tool as DeepSeek may not support it`);
        // Don't treat web_search as unsupported - just skip it
        continue;
      } else if (tool_type === 'namespace') {
        // Codex 0.133.0+ sends namespace tools (e.g. multi_agent_v1) that contain sub-tools
        // DeepSeek does not support nested namespaces, so skip without flagging as unsupported
        logger.info(`Skipping namespace tool '${tool.name || 'unknown'}' as DeepSeek does not support nested tool namespaces`);
        continue;
      } else {
        if (tool_type === undefined) {
          logger.warn(`Tool missing 'type' field: ${JSON.stringify(tool)}`);
        } else {
          logger.warn(`Unsupported tool type: ${tool_type}, tool: ${JSON.stringify(tool)}`);
        }
        has_unsupported_tools = true;
      }
    }

    logger.info(`Tool conversion: ${tools.length} valid tools, has_unsupported_tools=${has_unsupported_tools}`);
    // If there are valid tools and no unsupported tool types, include them
    // Otherwise force text-only response to avoid DeepSeek API errors
    if (tools.length > 0 && !has_unsupported_tools) {
      chat_request.tools = tools;
      // Set tool_choice (always include it when tools are present)
      const tool_choice = responses_request.tool_choice || 'auto';
      chat_request.tool_choice = tool_choice;
      logger.info(`Included ${tools.length} function tools in request, tool_choice=${tool_choice}`);
    } else {
      // Force text-only response when there are unsupported tools or no valid tools
      if (has_unsupported_tools) {
        logger.info("Forcing text-only response due to unsupported tool types");
      } else if (tools.length === 0) {
        logger.info("Forcing text-only response due to no valid tools after filtering");
      }
      chat_request.tool_choice = 'none';
    }
  }

  // Log conversion for debugging
  logger.info(`Converted request: original_model=${model}, deepseek_model=${deepseek_model}, messages_count=${messages.length}, stream=${stream}`);
  if (chat_request.tools !== undefined) {
    logger.info(`Tools count: ${chat_request.tools.length}`);
  }
  logger.debug(`Messages: ${JSON.stringify(messages, null, 2)}`);

  return chat_request;
}

export function convert_chat_completions_to_responses(deepseek_response: DeepSeekChatResponse, original_request: OpenAiResponsesRequest, logger: any): OpenAiResponsesResponse | null {
  // Check for tool calls in the response
  const choices = deepseek_response.choices || [];
  if (choices.length === 0) {
    logger.error("No choices in DeepSeek response");
    return null;
  }

  const message = choices[0].message || {};
  const tool_calls = message.tool_calls;

  if (tool_calls && tool_calls.length > 0) {
    // Convert tool calls response
    logger.info(`Converting ${tool_calls.length} tool calls from DeepSeek`);
    return convert_tool_calls_response(deepseek_response, original_request, logger);
  }
  // Handle regular text response (may contain XML function calls)
  return convert_regular_response(deepseek_response, original_request, logger);
}

export function convert_tool_calls_response(deepseek_response: DeepSeekChatResponse, original_request: OpenAiResponsesRequest, logger: any): OpenAiResponsesResponse | null {
  const choices = deepseek_response.choices || [];
  if (choices.length === 0) {
    return null;
  }

  const message = choices[0].message || {};
  const tool_calls = message.tool_calls || [];

  // Process each tool call, filtering out empty-argument calls
  const processed_tool_calls = [];
  // Build a lookup of valid parameter names from the original tool definitions
  // so we can strip extra fields DeepSeek generates from context (e.g. sandbox_permissions)
  const original_tools = original_request.tools || [];

  for (const tool_call of tool_calls) {
    const func = tool_call.function || {};
    let arguments_str = func.arguments || '{}';

    // Parse arguments to check if they are empty and to filter extra fields
    try {
      const parsed = JSON.parse(arguments_str);
      if (typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length === 0) {
        logger.warn(`Skipping tool call '${func.name || 'unknown'}' with empty arguments {}`);
        continue;
      }
      // Strip fields that are not in the original tool's required list
      // (DeepSeek often generates context-derived fields like sandbox_permissions)
      const tool_def = original_tools.find(t =>
        (t.function?.name === func.name) || (t.name === func.name)
      );
      const valid_keys: Set<string> = new Set();
      const required_params = tool_def?.function?.parameters?.required || tool_def?.parameters?.required || [];
      for (const k of required_params) valid_keys.add(k);
      if (valid_keys.size > 0) {
        for (const key of Object.keys(parsed)) {
          if (!valid_keys.has(key)) {
            logger.debug(`Stripping extra field '${key}' from tool call '${func.name}' arguments`);
            delete parsed[key];
          }
        }
      }
      const escaped = escape_json_string_values(fix_verilog_in_args(parsed));
      arguments_str = JSON.stringify(escaped);
      logger.debug(`Escaped non-ASCII characters in tool call arguments`);
    } catch (e) {
      logger.warn(`Tool call arguments not valid JSON, keeping as-is: ${e}`);
      arguments_str = escape_non_ascii_to_unicode(arguments_str);
    }
    processed_tool_calls.push({
      id: tool_call.id || `call_${randomBytes(4).toString('hex')}`,
      name: func.name || '',
      arguments: arguments_str
    });
  }

  // If all tool calls had empty arguments, try XML parsing or text fallback
  if (processed_tool_calls.length === 0) {
    logger.info("All tool calls have empty arguments, trying XML parsing fallback");
    const content = message.content || '';
    if (content) {
      const { clean_content, tool_calls: xml_tool_calls } = parse_xml_function_calls(content, logger);
      if (xml_tool_calls && xml_tool_calls.length > 0) {
        return convert_tool_calls_from_xml(deepseek_response, original_request, xml_tool_calls, clean_content, logger);
      }
      return convert_regular_response(deepseek_response, original_request, logger);
    }
    // No content and no valid tool calls — return empty text response to avoid hanging
    logger.info("No content or valid tool calls, returning empty text response");
    return {
      id: deepseek_response.id || `resp_${randomBytes(8).toString('hex')}`,
      object: "response",
      model: get_response_model(original_request.model),
      choices: [{
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "stop"
      }],
      usage: deepseek_response.usage || {},
      created: deepseek_response.created || 0
    };
  }

  // Convert tool calls to Responses API format
  const output_items = [];
  for (const proc of processed_tool_calls) {
    output_items.push({
      type: "function_call",
      call_id: proc.id,
      name: proc.name,
      arguments: proc.arguments
    });
  }

  // Create response
  const responses_response: OpenAiResponsesResponse = {
    id: deepseek_response.id || `resp_${randomBytes(8).toString('hex')}`,
    object: "response",
    model: get_response_model(original_request.model),
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",  // Changed to empty string instead of null, to make Codex happier
          tool_calls: processed_tool_calls.map((proc) => ({
            id: proc.id,
            type: "function",
            function: {
              name: proc.name,
              arguments: proc.arguments
            }
          }))
        },
        finish_reason: choices[0].finish_reason || "tool_calls"
      }
    ],
    usage: deepseek_response.usage || {},
    created: deepseek_response.created || 0
  };

  logger.info(`Converted tool calls response: ${processed_tool_calls.length} tool calls (filtered from ${tool_calls.length})`);
  return responses_response;
}

export function convert_regular_response(deepseek_response: DeepSeekChatResponse, original_request: OpenAiResponsesRequest, logger: any): OpenAiResponsesResponse | null {
  const choices = deepseek_response.choices || [];
  if (choices.length === 0) {
    return null;
  }

  const message = choices[0].message || {};
  let content = message.content || '';

  // Check for XML function calls in content
  const { clean_content, tool_calls } = parse_xml_function_calls(content, logger);

  if (tool_calls && tool_calls.length > 0) {
    // Convert to tool calls response
    return convert_tool_calls_from_xml(deepseek_response, original_request, tool_calls, clean_content, logger);
  }

  // Fix missing $ on Verilog system tasks (e.g. display( → $display()
  const fixed_content = fix_verilog_system_tasks(clean_content);

  // Create regular text response
  const responses_response: OpenAiResponsesResponse = {
    id: deepseek_response.id || `resp_${randomBytes(8).toString('hex')}`,
    object: "response",
    model: get_response_model(original_request.model),
    choices: [
      {
        index: 0,
        message: {
          role: message.role || "assistant",
          content: fixed_content
        },
        finish_reason: choices[0].finish_reason || "stop"
      }
    ],
    usage: deepseek_response.usage || {},
    created: deepseek_response.created || 0
  };

  logger.info(`Converted regular response: content length=${fixed_content.length}`);
  return responses_response;
}

export function convert_tool_calls_from_xml(deepseek_response: DeepSeekChatResponse, original_request: OpenAiResponsesRequest, tool_calls: any[], clean_content: string, logger: any): OpenAiResponsesResponse | null {
  const choices = deepseek_response.choices || [];
  if (choices.length === 0) {
    return null;
  }

  // Build tool_calls array in OpenAI format
  const openai_tool_calls = [];
  for (const tool_call of tool_calls) {
    let arguments_str = tool_call.function.arguments;
    // Try to parse arguments as JSON and escape non-ASCII characters in string values
    try {
      const parsed = JSON.parse(arguments_str);
      const escaped = escape_json_string_values(fix_verilog_in_args(parsed));
      arguments_str = JSON.stringify(escaped);
      logger.debug(`Escaped non-ASCII characters in XML tool call arguments`);
    } catch (e) {
      // If not valid JSON, fall back to escaping the whole string as a string
      logger.warn(`XML tool call arguments not valid JSON, escaping as plain string: ${e}`);
      arguments_str = escape_non_ascii_to_unicode(arguments_str);
    }
    openai_tool_calls.push({
      id: tool_call.id,
      type: "function",
      function: {
        name: tool_call.function.name,
        arguments: arguments_str
      }
    });
  }

  const responses_response: OpenAiResponsesResponse = {
    id: deepseek_response.id || `resp_${randomBytes(8).toString('hex')}`,
    object: "response",
    model: get_response_model(original_request.model),
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: clean_content,
          tool_calls: openai_tool_calls
        },
        finish_reason: "tool_calls"
      }
    ],
    usage: deepseek_response.usage || {},
    created: deepseek_response.created || 0
  };

  logger.info(`Converted XML tool calls response: ${tool_calls.length} tool calls`);
  return responses_response;
}

export function parse_xml_function_calls(content: string, logger: any): { clean_content: string, tool_calls: any[] } {
  if (!content || !content.includes('<function_call>')) {
    return { clean_content: strip_markdown_fences(content || ''), tool_calls: [] };
  }

  try {
    logger.info('Parsing XML function calls from DeepSeek response');

    // Remove function_call tags from content to get clean text
    const clean_content = content.replace(/<function_call>.*?<\/function_call>/gs, '').trim();
    const final_content = strip_markdown_fences(clean_content);

    // Extract tool calls from XML
    const tool_calls: any[] = [];
    const function_call_match = content.match(/<function_call>.*?<\/function_call>/gs);
    if (function_call_match) {
      for (const func_call_str of function_call_match) {
        // Find invoke tags
        const invoke_regex = /<invoke\s+name="([^"]*)"[^>]*>(.*?)<\/invoke>/gs;
        let match;
        while ((match = invoke_regex.exec(func_call_str)) !== null) {
          const name = match[1];
          let arguments_str = match[2] || '{}';
          // Arguments may be empty or contain child elements; for simplicity, treat as empty object
          // If arguments contain inner XML, we could parse further, but for now use empty object
          if (!arguments_str.trim() || arguments_str.includes('<')) {
            arguments_str = '{}';
          }
          tool_calls.push({
            id: `call_${randomBytes(4).toString('hex')}`,
            type: 'function',
            function: {
              name: name,
              arguments: arguments_str
            }
          });
          logger.info(`Parsed tool call: ${name}`);
        }
      }
    }

    logger.info(`Found ${tool_calls.length} tool calls in XML`);
    return { clean_content: final_content, tool_calls };
  } catch (e) {
    logger.warn(`Failed to parse XML function calls: ${e}`);
    return { clean_content: content, tool_calls: [] };
  }
}

export function parse_deepseek_stream_chunk(chunk_line: Buffer): any {
  try {
    if (chunk_line.toString().startsWith('data: ')) {
      const chunk_data = chunk_line.toString().substring(6);  // Remove 'data: ' prefix
      if (chunk_data.trim() === '[DONE]') {
        return null;
      }
      return JSON.parse(chunk_data);
    }
    return null;
  } catch (e) {
    // logger.warn(`Failed to parse chunk: ${e}`);
    return null;
  }
}

export function convert_stream_chunk(chunk: any, original_request: OpenAiResponsesRequest): StreamChunk | null {
  const choices = chunk.choices || [];
  if (choices.length === 0) {
    return null;
  }

  const delta = choices[0].delta || {};
  const finish_reason = choices[0].finish_reason;

  // Check for tool calls in delta
  const tool_calls = delta.tool_calls;

  if (tool_calls) {
    // Handle tool call chunk
    // Build delta dynamically
    const new_delta: any = {};
    if (delta.role !== undefined) {
      new_delta.role = delta.role;
    } else {
      new_delta.role = 'assistant';  // Tool call chunks should have role
    }
    new_delta.tool_calls = tool_calls;

    const response_chunk: StreamChunk = {
      id: chunk.id || `resp_${randomBytes(8).toString('hex')}`,
      object: "response",
      created: chunk.created || Math.floor(Date.now() / 1000),
      model: get_response_model(original_request.model),
      choices: [
        {
          index: 0,
          delta: new_delta,
          finish_reason: finish_reason || null
        }
      ]
    };
    // Add system_fingerprint if present, otherwise add default
    if (chunk.system_fingerprint !== undefined) {
      response_chunk.system_fingerprint = chunk.system_fingerprint;
    } else {
      response_chunk.system_fingerprint = "fp_deepseek_proxy";
    }
    return response_chunk;
  } else {
    // Handle text chunk
    const content = delta.content || '';
    // Build delta dynamically based on what's present in the original delta
    const new_delta: any = {};
    if (delta.role !== undefined) {
      new_delta.role = delta.role;
    }
    if (content !== undefined) {  // Always include content, even if empty string
      new_delta.content = content;
    }

    const response_chunk: StreamChunk = {
      id: chunk.id || `resp_${randomBytes(8).toString('hex')}`,
      object: "response",
      created: chunk.created || Math.floor(Date.now() / 1000),
      model: get_response_model(original_request.model),
      choices: [
        {
          index: 0,
          delta: new_delta,
          finish_reason: finish_reason || null
        }
      ]
    };
    // Add system_fingerprint if present, otherwise add default
    if (chunk.system_fingerprint !== undefined) {
      response_chunk.system_fingerprint = chunk.system_fingerprint;
    } else {
      response_chunk.system_fingerprint = "fp_deepseek_proxy";
    }
    return response_chunk;
  }
}

export function wrap_chunk_as_event(chunk: any): { event_type: string | null, event_data: any | null } {
  const choices = chunk.choices || [];
  if (choices.length === 0) {
    return { event_type: null, event_data: null };
  }

  const delta = choices[0].delta || {};
  const finish_reason = choices[0].finish_reason;

  // Check for tool calls
  const tool_calls = delta.tool_calls;
  const content = delta.content || '';

  // Prioritize tool_calls - special delta type
  if (tool_calls) {
    // For tool calls, create a FunctionCall ResponseItem.
    // Assume tool calls are complete (not streaming).
    const tool_call = tool_calls[0] || {};
    const func = tool_call.function || {};
    const item = {
      type: "function_call",
      call_id: tool_call.id || '',
      name: func.name || '',
      arguments: func.arguments || '{}'
    };
    const event_type = "response.output_item.done";
    const event_data = {
      type: event_type,
      item: item
    };
    return { event_type, event_data };
  } else if (finish_reason) {
    // This is a final chunk with finish_reason
    // We'll treat it as a response.completed event
    const event_type = "response.completed";
    const event_data = {
      type: event_type,
      response: {
        id: chunk.id || '',
        usage: chunk.usage || {}
      }
    };
    return { event_type, event_data };
  } else if (content !== undefined) {
    // Text delta (content may be empty string)
    const event_type = "response.output_text.delta";
    const event_data = {
      type: event_type,
      delta: content
    };
    return { event_type, event_data };
  } else {
    // Unknown delta (maybe role only)
    return { event_type: null, event_data: null };
  }
}