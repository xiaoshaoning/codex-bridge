import { IncomingMessage } from 'http';
import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { randomBytes } from 'crypto';
import { ConverterPlugin, pluginRegistry } from './plugin-system';
import { ConnectionPool } from './connection-pool';
import { circuitBreaker } from './streaming';
import { validate_ws_token } from './auth';

export function setup_websocket_server(server: HTTPServer, logger: any): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname === '/ws') {
      if (!validate_ws_token(request.url || '')) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    const ws_id = `ws_${randomBytes(3).toString('hex')}`;
    logger.info(`WebSocket client connected: ${ws_id}`);

    ws.on('message', async (raw: Buffer) => {
      let data: any;
      try {
        data = JSON.parse(raw.toString());
      } catch (e) {
        ws.send(JSON.stringify({
          type: 'error',
          data: { message: 'Invalid JSON', type: 'parse_error', code: 'bad_request' },
        }));
        return;
      }

      const msg_id = data.id || `msg_${randomBytes(4).toString('hex')}`;

      const plugin = pluginRegistry.getPluginForModel(data.model) || pluginRegistry.getPlugin('deepseek');
      if (!plugin) {
        ws.send(JSON.stringify({
          id: msg_id,
          type: 'error',
          data: { message: `No converter plugin for model: ${data.model}`, type: 'config_error', code: 'unavailable' },
        }));
        return;
      }

      const headers: any = {
        ...plugin.getAuthHeaders(),
        'Content-Type': 'application/json',
      };

      try {
        const converted = plugin.convertRequest(data, logger);
        const is_streaming = converted.stream || false;
        headers.Accept = is_streaming ? 'text/event-stream' : 'application/json';

        if (is_streaming) {
          await handle_ws_stream(ws, msg_id, data, converted, headers, plugin);
        } else {
          await handle_ws_non_stream(ws, msg_id, data, converted, headers, logger, plugin);
        }
      } catch (error: any) {
        ws.send(JSON.stringify({
          id: msg_id,
          type: 'error',
          data: { message: error.message || 'Internal error', type: 'internal_error', code: 'internal_error' },
        }));
      }
    });

    ws.on('error', () => {});
  });

  return wss;
}

async function handle_ws_stream(
  ws: WebSocket,
  msg_id: string,
  original_request: any,
  converted: any,
  headers: any,
  plugin: ConverterPlugin,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let stream_ended = false;
    const target_url = `${plugin.getApiUrl()}/v1/chat/completions`;
    const baseURL = new URL(target_url).origin;
    const pathname = new URL(target_url).pathname;

    function safe_send(data: any): void {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(data));
        }
      } catch (_) {
        /* ignore */
      }
    }

    circuitBreaker
      .execute(async () => {
        const client = ConnectionPool.getInstance().getStreamingClient(baseURL);
        return client.post(pathname, converted, {
          headers,
          responseType: 'stream',
          timeout: parseInt(process.env.STREAM_CONNECTION_TIMEOUT || '15000'),
        });
      })
      .then((response: any) => {
        if (response.status >= 400) {
          safe_send({
            id: msg_id,
            type: 'error',
            data: { message: `Upstream API error ${response.status}`, type: 'api_error', code: 'upstream_error' },
          });
          stream_ended = true;
          resolve();
          return;
        }

        const stream = response.data;

        stream.on('data', (chunk: Buffer) => {
          if (stream_ended) return;
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            const parsed = plugin.parseStreamChunk(Buffer.from(line));
            if (!parsed) continue;
            const converted_chunk = plugin.convertStreamChunk(parsed, original_request);
            if (converted_chunk) {
              safe_send({ id: msg_id, type: 'delta', data: converted_chunk });
            }
          }
        });

        stream.on('end', () => {
          if (stream_ended) return;
          stream_ended = true;
          safe_send({ id: msg_id, type: 'done', data: { reason: 'stop' } });
          resolve();
        });

        stream.on('error', (err: Error) => {
          if (stream_ended) return;
          stream_ended = true;
          safe_send({
            id: msg_id,
            type: 'error',
            data: { message: err.message, type: 'stream_error', code: 'stream_error' },
          });
          resolve();
        });
      })
      .catch((err: Error) => {
        if (stream_ended) return;
        stream_ended = true;
        safe_send({
          id: msg_id,
          type: 'error',
          data: { message: err.message, type: 'upstream_error', code: 'upstream_error' },
        });
        resolve();
      });
  });
}

async function handle_ws_non_stream(
  ws: WebSocket,
  msg_id: string,
  original_request: any,
  converted: any,
  headers: any,
  logger: any,
  plugin: ConverterPlugin,
): Promise<void> {
  const target_url = `${plugin.getApiUrl()}/v1/chat/completions`;
  const baseURL = new URL(target_url).origin;
  const pathname = new URL(target_url).pathname;

  try {
    const client = ConnectionPool.getInstance().getClient(baseURL);
    const response = await circuitBreaker.execute(async () => {
      return client.post(pathname, converted, {
        headers,
        timeout: parseInt(process.env.NON_STREAM_TIMEOUT || '30000'),
      });
    });

    if (response.status >= 400) {
      ws.send(JSON.stringify({
        id: msg_id,
        type: 'error',
        data: { message: `Upstream API error ${response.status}`, type: 'api_error', code: 'upstream_error' },
      }));
      return;
    }

    const deepseek_response = response.data;
    const responses_response = plugin.convertResponse(deepseek_response, original_request, logger);

    if (responses_response) {
      ws.send(JSON.stringify({ id: msg_id, type: 'response', data: responses_response }));
    } else {
      ws.send(JSON.stringify({
        id: msg_id,
        type: 'error',
        data: { message: 'Failed to convert response', type: 'conversion_error', code: 'conversion_error' },
      }));
    }
  } catch (error: any) {
    ws.send(JSON.stringify({
      id: msg_id,
      type: 'error',
      data: { message: error.message || 'Internal error', type: 'internal_error', code: 'internal_error' },
    }));
  }
}
