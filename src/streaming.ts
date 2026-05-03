import { Response } from 'express';
import { URL } from 'url';
import { ConnectionPool } from './connection-pool';
import { CircuitBreaker } from './circuit-breaker';
import { strip_markdown_fences, escape_non_ascii_to_unicode, parse_xml_function_calls } from './converter';
import { ConverterPlugin } from './plugin-system';
import { upstreamRequestDuration, streamingRequestDuration, streamChunksTotal } from './metrics';
import { randomBytes } from 'crypto';

export const circuitBreaker = new CircuitBreaker();

// Streaming configuration from env vars with sensible defaults
const STREAM_CONFIG = {
  connectionTimeout: parseInt(process.env.STREAM_CONNECTION_TIMEOUT || '15000'),   // 15s to establish connection
  idleTimeout: parseInt(process.env.STREAM_IDLE_TIMEOUT || '60000'),               // 60s between data chunks
  maxDuration: parseInt(process.env.STREAM_MAX_DURATION || '300000'),              // 5min total stream duration
  maxBufferSize: parseInt(process.env.STREAM_MAX_BUFFER_SIZE || '1048576'),        // 1MB backpressure buffer
  highWaterMark: parseInt(process.env.STREAM_HIGH_WATER_MARK || '16384'),          // 16KB write buffer
};

function escape_json_string_values(obj: any): any {
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

// Backpressure-aware write helper
function backpressure_write(res: Response, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = res.write(data);
    if (ok) {
      // Buffer not full, resolve immediately
      resolve();
    } else {
      // Buffer full, wait for drain
      res.once('drain', resolve);
      res.once('error', reject);
      // Safety timeout to prevent hanging
      const timeout = setTimeout(() => {
        res.removeListener('drain', resolve);
        res.removeListener('error', reject);
        resolve(); // resolve anyway to avoid hanging
      }, 5000);
      res.once('drain', () => clearTimeout(timeout));
    }
  });
}

// Track stream timeouts with cleanup
function create_stream_timers(maxDuration: number, idleTimeout: number, onIdleTimeout: () => void, onMaxDuration: () => void) {
  const maxDurationTimer = setTimeout(onMaxDuration, maxDuration);
  let idleTimer: NodeJS.Timeout | null = setInterval(() => {}, 2147483647); // dummy
  clearInterval(idleTimer!);
  idleTimer = null;

  function reset_idle_timer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(onIdleTimeout, idleTimeout);
  }

  function clear_all() {
    clearTimeout(maxDurationTimer);
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  return { reset_idle_timer, clear_all };
}

export async function handle_streaming_response(
  target_url: string,
  converted_data: any,
  headers: any,
  original_request: any,
  res: Response,
  logger: any,
  start_time: number,
  plugin: ConverterPlugin
) {
  // Abort controller for timeout management
  const abortController = new AbortController();
  let stream_ended = false;

  function safe_end() {
    if (stream_ended) return;
    stream_ended = true;
    try {
      res.end();
    } catch (_) { /* ignore */ }
  }

  function safe_destroy_stream(stream: any) {
    try {
      if (stream && typeof stream.destroy === 'function' && !stream.destroyed) {
        stream.destroy();
      }
    } catch (_) { /* ignore */ }
  }

  try {
    logger.info("handle_streaming_response called");
    const baseURL = new URL(target_url).origin;
    const pathname = new URL(target_url).pathname;
    const client = ConnectionPool.getInstance().getStreamingClient(baseURL);

    const response = await circuitBreaker.execute(async () => {
      return client.post(pathname, converted_data, {
        headers: headers,
        responseType: 'stream',
        timeout: STREAM_CONFIG.connectionTimeout,
        signal: abortController.signal
      });
    });

    const deepseek_connect_time = Date.now() - start_time;
    logger.info(`DeepSeek API streaming connection established in ${deepseek_connect_time}ms`);
    upstreamRequestDuration.labels('streaming').observe(deepseek_connect_time);

    if (response.status >= 400) {
      const error_body = response.data ? (await stream_to_string(response.data)).substring(0, 1000) : '';
      logger.error(`DeepSeek API error ${response.status}: ${error_body}`);
      const err: any = new Error(`Upstream API returned status ${response.status}`);
      err.statusCode = response.status;
      err.upstreamData = error_body;
      throw err;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Enable response buffering with high water mark
    (res as any).highWaterMark = STREAM_CONFIG.highWaterMark;

    // Stream timers
    const timers = create_stream_timers(
      STREAM_CONFIG.maxDuration,
      STREAM_CONFIG.idleTimeout,
      () => {
        logger.warn('Stream idle timeout reached');
        safe_end();
        safe_destroy_stream(stream);
      },
      () => {
        logger.warn('Stream max duration reached');
        safe_end();
        safe_destroy_stream(stream);
      }
    );
    timers.reset_idle_timer();

    // State tracking
    let initial_item_sent = false;
    let content_buffer = "";
    let response_id: string | null = null;
    let response_usage: any = {};
    let in_fence = false;
    let fence_ignore_content = false;
    const tool_call_accumulators: { [index: number]: { id: string, name: string, arguments: string } } = {};
    let total_bytes_written = 0;
    const has_tools = !!(original_request.tools && Array.isArray(original_request.tools) && original_request.tools.length > 0);

    const stream = response.data;

    stream.on('data', async (chunk: Buffer) => {
      if (stream_ended) return;
      timers.reset_idle_timer();
      streamChunksTotal.inc();

      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.trim() === '') continue;
        if (line.trim() === 'data: [DONE]') {
          logger.info("Received DeepSeek DONE marker");
          break;
        }

        const deepseek_chunk = plugin.parseStreamChunk(Buffer.from(line));
        if (!deepseek_chunk) continue;

        const converted_chunk = plugin.convertStreamChunk(deepseek_chunk, original_request);
        if (!converted_chunk) continue;

        const choices = converted_chunk.choices || [];
        if (choices.length === 0) continue;

        const delta = choices[0].delta || {};
        const finish_reason = choices[0].finish_reason;

        if (response_id === null) {
          response_id = converted_chunk.id;
        }
        if (converted_chunk.usage) {
          response_usage = converted_chunk.usage;
        }

        // Tool calls — emit events progressively
        const tool_calls = delta.tool_calls;
        if (tool_calls) {
          for (const tool_call of tool_calls) {
            const index = tool_call.index || 0;
            const func = tool_call.function || {};
            if (!tool_call_accumulators[index]) {
              // First chunk for this tool call — emit response.output_item.added
              const tool_id = tool_call.id || `call_${randomBytes(4).toString('hex')}`;
              const tool_name = func.name || '';
              tool_call_accumulators[index] = {
                id: tool_id,
                name: tool_name,
                arguments: ''
              };
              const added_item = { type: "function_call", call_id: tool_id, name: tool_name, arguments: "" };
              const added_event = { type: "response.output_item.added", item: added_item };
              await backpressure_write(res, `event: response.output_item.added\ndata: ${JSON.stringify(added_event)}\n\n`);
              total_bytes_written += Buffer.byteLength(JSON.stringify(added_event));
            }
            const partial_args = func.arguments || '';
            if (partial_args) {
              tool_call_accumulators[index].arguments += partial_args;
              // Emit partial arguments as delta
              const delta_event = { type: "response.output_text.delta", delta: partial_args };
              await backpressure_write(res, `event: response.output_text.delta\ndata: ${JSON.stringify(delta_event)}\n\n`);
              total_bytes_written += Buffer.byteLength(JSON.stringify(delta_event));
            }
          }
          // Fall through — let finish_reason handler run for the final chunk
        }

        // Content deltas
        const content = delta.content;
        // Only process content if we are not currently processing tool call chunks
        if (content !== undefined && Object.keys(tool_call_accumulators).length === 0) {
          content_buffer += content;

          if (!has_tools) {
            // No tools in request — emit text deltas immediately (current behavior)
            if (!initial_item_sent) {
              const initial_item = {
                type: "message",
                role: delta.role || 'assistant',
                content: []
              };
              const added_event = { type: "response.output_item.added", item: initial_item };
              await backpressure_write(res, `event: response.output_item.added\ndata: ${JSON.stringify(added_event)}\n\n`);
              total_bytes_written += Buffer.byteLength(JSON.stringify(added_event));
              if (total_bytes_written > STREAM_CONFIG.maxBufferSize) {
                logger.warn(`Stream buffer exceeded ${STREAM_CONFIG.maxBufferSize} bytes, throttling`);
              }
              initial_item_sent = true;
            }

            if (content === '```') {
              in_fence = true;
              fence_ignore_content = true;
            }
            if (in_fence && content === '\n') {
              in_fence = false;
              fence_ignore_content = false;
            }

            if (!fence_ignore_content) {
              const delta_event = { type: "response.output_text.delta", delta: content };
              await backpressure_write(res, `event: response.output_text.delta\ndata: ${JSON.stringify(delta_event)}\n\n`);
              total_bytes_written += Buffer.byteLength(JSON.stringify(delta_event));
            }
          }
          // If has_tools, content accumulates in buffer without text delta emissions
        }

        // Finish reason
        if (finish_reason) {
          if (Object.keys(tool_call_accumulators).length > 0) {
            const indices = Object.keys(tool_call_accumulators).map(Number).sort();
            for (const idx of indices) {
              const acc = tool_call_accumulators[idx];
              let arguments_str = acc.arguments.trim() || '{}';
              try {
                const parsed = JSON.parse(arguments_str);
                const escaped = escape_json_string_values(parsed);
                arguments_str = JSON.stringify(escaped);
              } catch (e) {
                // Keep original text if JSON parsing fails
              }
              const item = { type: "function_call", call_id: acc.id, name: acc.name, arguments: arguments_str };
              const done_event = { type: "response.output_item.done", item };
              await backpressure_write(res, `event: response.output_item.done\ndata: ${JSON.stringify(done_event)}\n\n`);
            }
          } else if (content_buffer) {
            if (has_tools) {
              // Tools present — check for XML function calls in buffered content
              const { tool_calls: xml_tool_calls } = parse_xml_function_calls(content_buffer, logger);
              if (xml_tool_calls && xml_tool_calls.length > 0) {
                logger.info(`Emitting ${xml_tool_calls.length} tool call(s) from XML in streaming finish`);
                for (const tc of xml_tool_calls) {
                  const tc_id = tc.id;
                  const tc_name = tc.function.name;
                  let arguments_str = tc.function.arguments || '{}';
                  try {
                    const parsed = JSON.parse(arguments_str);
                    const escaped = escape_json_string_values(parsed);
                    arguments_str = JSON.stringify(escaped);
                  } catch (e) {
                    // Keep original arguments if JSON parsing fails
                  }
                  const added_item = { type: "function_call", call_id: tc_id, name: tc_name, arguments: "" };
                  const added_event = { type: "response.output_item.added", item: added_item };
                  await backpressure_write(res, `event: response.output_item.added\ndata: ${JSON.stringify(added_event)}\n\n`);
                  const delta_event = { type: "response.output_text.delta", delta: arguments_str };
                  await backpressure_write(res, `event: response.output_text.delta\ndata: ${JSON.stringify(delta_event)}\n\n`);
                  const done_item = { type: "function_call", call_id: tc_id, name: tc_name, arguments: arguments_str };
                  const done_event = { type: "response.output_item.done", item: done_item };
                  await backpressure_write(res, `event: response.output_item.done\ndata: ${JSON.stringify(done_event)}\n\n`);
                }
              } else {
                // No XML — emit buffered content as text
                logger.info("No XML function calls found, emitting buffered content as text");
                if (!initial_item_sent) {
                  const initial_item = { type: "message", role: "assistant", content: [] };
                  const added_event = { type: "response.output_item.added", item: initial_item };
                  await backpressure_write(res, `event: response.output_item.added\ndata: ${JSON.stringify(added_event)}\n\n`);
                }
                const stripped_content = strip_markdown_fences(content_buffer);
                if (stripped_content) {
                  const delta_event = { type: "response.output_text.delta", delta: stripped_content };
                  await backpressure_write(res, `event: response.output_text.delta\ndata: ${JSON.stringify(delta_event)}\n\n`);
                }
                const done_item = {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "text", text: stripped_content }]
                };
                const done_event = { type: "response.output_item.done", item: done_item };
                await backpressure_write(res, `event: response.output_item.done\ndata: ${JSON.stringify(done_event)}\n\n`);
              }
            } else {
              // No tools — current behavior: emit text events
              if (!initial_item_sent) {
                const initial_item = { type: "message", role: "assistant", content: [] };
                const added_event = { type: "response.output_item.added", item: initial_item };
                await backpressure_write(res, `event: response.output_item.added\ndata: ${JSON.stringify(added_event)}\n\n`);
              }
              const stripped_content = strip_markdown_fences(content_buffer);
              const done_item = {
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: stripped_content }]
              };
              const done_event = { type: "response.output_item.done", item: done_item };
              await backpressure_write(res, `event: response.output_item.done\ndata: ${JSON.stringify(done_event)}\n\n`);
            }
          }

          // Send response.completed
          const codex_usage: any = {};
          if (response_usage) {
            if (response_usage.prompt_tokens !== undefined) codex_usage.input_tokens = response_usage.prompt_tokens;
            if (response_usage.completion_tokens !== undefined) codex_usage.output_tokens = response_usage.completion_tokens;
            if (response_usage.total_tokens !== undefined) codex_usage.total_tokens = response_usage.total_tokens;
          }
          codex_usage.input_tokens = codex_usage.input_tokens ?? 0;
          codex_usage.output_tokens = codex_usage.output_tokens ?? 0;
          codex_usage.total_tokens = codex_usage.total_tokens ?? 0;

          const completed_event = {
            type: "response.completed",
            response: {
              id: response_id || `resp_${randomBytes(8).toString('hex')}`,
              usage: codex_usage
            }
          };
          await backpressure_write(res, `event: response.completed\ndata: ${JSON.stringify(completed_event)}\n\n`);
        }
      }
    });

    stream.on('end', () => {
      if (stream_ended) return;
      timers.clear_all();
      logger.info("Yielding final DONE marker");
      try {
        res.write("data: [DONE]\n\n");
      } catch (_) { /* ignore */ }
      safe_end();
      const elapsed = Date.now() - start_time;
      logger.info(`Streaming request processed in ${elapsed}ms`);
      streamingRequestDuration.observe(elapsed);
    });

    stream.on('error', (err: Error) => {
      if (stream_ended) return;
      timers.clear_all();
      logger.error(`Stream error: ${err.message}`);
      const elapsed = Date.now() - start_time;
      streamingRequestDuration.observe(elapsed);
      safe_end();
    });

    // Client disconnect handling
    res.on('close', () => {
      if (stream_ended) return;
      logger.info('Client disconnected during stream');
      timers.clear_all();
      abortController.abort();
      safe_destroy_stream(stream);
      safe_end();
    });

  } catch (error: any) {
    // If the upstream returned an error with a stream body, try to extract the error message
    if (error.response?.status >= 400 && error.response?.data && typeof error.response.data?.on === 'function') {
      try {
        const error_body = await stream_to_string(error.response.data);
        error.statusCode = error.response.status;
        error.upstreamData = error_body;
        error.message = `Upstream API error ${error.response.status}: ${error_body.substring(0, 200)}`;
      } catch (_) { /* ignore */ }
    }
    throw error;
  }
}

export async function handle_non_streaming_response(
  target_url: string,
  converted_data: any,
  headers: any,
  original_request: any,
  res: Response,
  logger: any,
  start_time: number,
  plugin: ConverterPlugin
): Promise<any> {
  try {
    logger.info(`Sending to DeepSeek (truncated): ${JSON.stringify(converted_data).substring(0, 1000)}`);
    const deepseek_start_time = Date.now();

    const baseURL = new URL(target_url).origin;
    const pathname = new URL(target_url).pathname;
    const client = ConnectionPool.getInstance().getClient(baseURL);

    const response = await circuitBreaker.execute(async () => {
      return client.post(pathname, converted_data, {
        headers: headers,
        timeout: parseInt(process.env.NON_STREAM_TIMEOUT || '30000')
      });
    });

    if (response.status >= 400) {
      const error_body = response.data ? JSON.stringify(response.data).substring(0, 1000) : '';
      logger.error(`DeepSeek API error ${response.status}: ${error_body}`);
      const err: any = new Error(`Upstream API returned status ${response.status}`);
      err.statusCode = response.status;
      err.upstreamData = response.data;
      throw err;
    }

    const deepseek_elapsed = Date.now() - deepseek_start_time;
    logger.info(`DeepSeek API response time: ${deepseek_elapsed}ms`);
    upstreamRequestDuration.labels('non-streaming').observe(deepseek_elapsed);

    let deepseek_response;
    try {
      deepseek_response = response.data;
    } catch (e) {
      logger.error(`Failed to parse DeepSeek API response as JSON. Status: ${response.status}, Text: ${response.data?.substring(0, 500)}`);
      throw e;
    }
    logger.info(`DeepSeek response received, choices: ${deepseek_response.choices?.length || 0}`);

    const responses_response = plugin.convertResponse(deepseek_response, original_request, logger);

    if (!responses_response) {
      throw new Error("Failed to convert DeepSeek response");
    }

    const original_stream_requested = original_request.stream || false;
    if (original_stream_requested) {
      logger.info("Client requested streaming, wrapping non-streaming response as simulated SSE");

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      (res as any).highWaterMark = STREAM_CONFIG.highWaterMark;

      const sse_generator = generate_simulated_sse(responses_response, logger);
      for (const chunk of sse_generator) {
        await backpressure_write(res, chunk);
      }
      safe_end();
      return null;
    } else {
      const elapsed = Date.now() - start_time;
      logger.info(`Non-streaming request processed in ${elapsed}ms`);
      return responses_response;
    }
  } catch (error: any) {
    // Carry upstream error data if available
    if (error.response?.status >= 400 && error.response?.data) {
      error.statusCode = error.response.status;
      error.upstreamData = error.response.data;
    }
    throw error;
  }
}

// Fix: ensure non-streaming path also has safe_end
function safe_end() {
  // no-op, res.end() handled by caller
}

// Build a response.completed SSE event string from a response_id and usage object
function build_completed_event(response_id: string, usage: any): string {
  const codex_usage: any = {};
  if (usage) {
    if (usage.prompt_tokens !== undefined) codex_usage.input_tokens = usage.prompt_tokens;
    if (usage.completion_tokens !== undefined) codex_usage.output_tokens = usage.completion_tokens;
    if (usage.total_tokens !== undefined) codex_usage.total_tokens = usage.total_tokens;
  }
  codex_usage.input_tokens = codex_usage.input_tokens ?? 0;
  codex_usage.output_tokens = codex_usage.output_tokens ?? 0;
  codex_usage.total_tokens = codex_usage.total_tokens ?? 0;
  const completed_event = {
    type: "response.completed",
    response: { id: response_id, usage: codex_usage }
  };
  return `event: response.completed\ndata: ${JSON.stringify(completed_event)}\n\n`;
}

export function* generate_simulated_sse(responses_response: any, logger: any): Generator<string> {
  logger.info("SSE generator: Starting to generate SSE events");
  try {
    const choices = responses_response.choices || [];
    if (choices.length > 0) {
      const message = choices[0].message || {};
      const content = message.content || '';
      const tool_calls = message.tool_calls;

      if (tool_calls) {
        logger.info(`Sending ${tool_calls.length} tool call(s) as SSE events`);
        const response_id = responses_response.id || `resp_${randomBytes(8).toString('hex')}`;
        const total_usage = responses_response.usage || {};

        for (const tc of tool_calls) {
          const func = tc.function || {};
          const call_id = tc.id || `call_${randomBytes(4).toString('hex')}`;
          const name = func.name || '';

          // Emit response.output_item.added
          const added_item = { type: "function_call", call_id, name, arguments: "" };
          const added_event = { type: "response.output_item.added", item: added_item };
          yield `event: response.output_item.added\ndata: ${JSON.stringify(added_event)}\n\n`;

          // Emit arguments in chunks (simulate streaming)
          let args_str = typeof func.arguments === 'string' ? func.arguments : JSON.stringify(func.arguments || '{}');
          const chunk_size = 50;
          let i = 0;
          while (i < args_str.length) {
            const end = Math.min(i + chunk_size, args_str.length);
            const partial = args_str.substring(i, end);
            const delta_event = { type: "response.output_text.delta", delta: partial };
            yield `event: response.output_text.delta\ndata: ${JSON.stringify(delta_event)}\n\n`;
            i = end;
          }

          // Emit response.output_item.done with complete arguments
          const done_item = { type: "function_call", call_id, name, arguments: args_str };
          const done_event = { type: "response.output_item.done", item: done_item };
          yield `event: response.output_item.done\ndata: ${JSON.stringify(done_event)}\n\n`;
        }

        // Emit response.completed
        yield build_completed_event(response_id, total_usage);
      } else if (content) {
        logger.info(`Splitting text into chunks (length: ${content.length})`);
        const response_id = responses_response.id || `resp_${randomBytes(8).toString('hex')}`;
        const total_usage = responses_response.usage || {};

        // Emit response.output_item.added with message item
        const message_item = { type: "message", role: "assistant", content: [] };
        const added_event = { type: "response.output_item.added", item: message_item };
        yield `event: response.output_item.added\ndata: ${JSON.stringify(added_event)}\n\n`;

        // Emit content in word-boundary chunks as response.output_text.delta
        const chunk_size = 50;
        let i = 0;
        while (i < content.length) {
          let end = Math.min(i + chunk_size, content.length);
          if (end < content.length) {
            for (let lookahead = end; lookahead < Math.min(end + 20, content.length); lookahead++) {
              if (' \n\t.,;!?。，；！？'.includes(content[lookahead])) {
                end = lookahead + 1;
                break;
              }
            }
          }
          const chunk_text = content.substring(i, end);
          if (chunk_text) {
            const delta_event = { type: "response.output_text.delta", delta: chunk_text };
            yield `event: response.output_text.delta\ndata: ${JSON.stringify(delta_event)}\n\n`;
            i = end;
          }
        }

        // Emit response.output_item.done with stripped content
        const stripped_content = strip_markdown_fences(content);
        const done_item = {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: stripped_content }]
        };
        const done_event = { type: "response.output_item.done", item: done_item };
        yield `event: response.output_item.done\ndata: ${JSON.stringify(done_event)}\n\n`;

        // Emit response.completed
        yield build_completed_event(response_id, total_usage);
      } else {
        logger.info("SSE generator: Yielding completed event (no content)");
        const response_id = responses_response.id || `resp_${randomBytes(8).toString('hex')}`;
        const total_usage = responses_response.usage || {};
        // Emit response.completed directly (no content to stream)
        yield build_completed_event(response_id, total_usage);
      }
    }
    logger.info("SSE generator: Yielding [DONE]");
    yield "data: [DONE]\n\n";
    logger.info("SSE generator: Completed successfully");
  } catch (e) {
    logger.error(`SSE generator error: ${e}`);
    const error_chunk = { error: { message: `SSE generation failed: ${e}`, type: "sse_error" } };
    yield `data: ${JSON.stringify(error_chunk)}\n\n`;
    yield "data: [DONE]\n\n";
  }
}

async function stream_to_string(stream: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}
