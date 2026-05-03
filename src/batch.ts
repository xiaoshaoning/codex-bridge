import { Request, Response } from 'express';
import { URL } from 'url';
import { ConverterPlugin, pluginRegistry } from './plugin-system';
import { ConnectionPool } from './connection-pool';
import { circuitBreaker } from './streaming';

const BATCH_CONCURRENCY = parseInt(process.env.BATCH_CONCURRENCY || '0');

async function call_upstream(converted: any, plugin: ConverterPlugin): Promise<any> {
  const targetUrl = `${plugin.getApiUrl()}/v1/chat/completions`;
  const baseURL = new URL(targetUrl).origin;
  const pathname = new URL(targetUrl).pathname;
  const client = ConnectionPool.getInstance().getClient(baseURL);
  const headers = {
    ...plugin.getAuthHeaders(),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const response = await circuitBreaker.execute(async () => {
    return client.post(pathname, converted, {
      headers,
      timeout: parseInt(process.env.NON_STREAM_TIMEOUT || '30000'),
    });
  });

  if (response.status >= 400) {
    const error_body = JSON.stringify(response.data).substring(0, 500);
    throw new Error(`DeepSeek API error ${response.status}: ${error_body}`);
  }

  return response.data;
}

async function process_single_request(
  request_data: any,
  logger: any,
  plugin: ConverterPlugin,
): Promise<{ id: string; status: string; response?: any; error?: any; elapsed_ms: number }> {
  const start_time = Date.now();
  const req_id = `batch_${start_time}_${Math.random().toString(36).slice(2, 6)}`;

  try {
    const converted = plugin.convertRequest(request_data, logger);
    const deepseek_response = await call_upstream(converted, plugin);
    const responses_response = plugin.convertResponse(deepseek_response, request_data, logger);

    if (!responses_response) {
      throw new Error('Failed to convert DeepSeek response');
    }

    return {
      id: req_id,
      status: 'ok',
      response: responses_response,
      elapsed_ms: Date.now() - start_time,
    };
  } catch (error: any) {
    return {
      id: req_id,
      status: 'error',
      error: { message: error.message || 'Internal error', type: 'upstream_error', code: 'upstream_error' },
      elapsed_ms: Date.now() - start_time,
    };
  }
}

export async function handle_batch_request(
  req: Request,
  res: Response,
  logger: any,
): Promise<void> {
  const { requests } = req.body;

  if (!Array.isArray(requests) || requests.length === 0) {
    res.status(400).json({
      error: {
        message: 'requests must be a non-empty array',
        type: 'invalid_request',
        code: 'bad_request',
      },
    });
    return;
  }

  if (requests.length > 50) {
    res.status(400).json({
      error: {
        message: 'Maximum 50 requests per batch',
        type: 'invalid_request',
        code: 'bad_request',
      },
    });
    return;
  }

  logger.info(`Batch request received: ${requests.length} items`);

  let results: any[];

  function resolvePlugin(reqData: any): ConverterPlugin {
    const plugin = pluginRegistry.getPluginForModel(reqData.model) || pluginRegistry.getPlugin('deepseek');
    if (!plugin) throw new Error(`No plugin for model: ${reqData.model}`);
    return plugin;
  }

  if (BATCH_CONCURRENCY > 0) {
    results = [];
    for (let i = 0; i < requests.length; i += BATCH_CONCURRENCY) {
      const chunk = requests.slice(i, i + BATCH_CONCURRENCY);
      const chunk_results = await Promise.all(
        chunk.map((r: any) => process_single_request(r, logger, resolvePlugin(r))),
      );
      results.push(...chunk_results);
    }
  } else {
    results = await Promise.all(
      requests.map((r: any) => process_single_request(r, logger, resolvePlugin(r))),
    );
  }

  const success_count = results.filter((r) => r.status === 'ok').length;
  const error_count = results.filter((r) => r.status === 'error').length;
  logger.info(`Batch completed: ${success_count} ok, ${error_count} errors`);

  res.json({ results });
}
