import { Request, Response } from 'express';
import axios from 'axios';
import { URL } from 'url';
import { pluginRegistry } from './plugin-system';
import { ConnectionPool } from './connection-pool';
import { circuitBreaker } from './streaming';

async function process_and_deliver(
  data: any,
  webhook_url: string,
  logger: any,
): Promise<void> {
  try {
    const plugin = pluginRegistry.getPluginForModel(data.model) || pluginRegistry.getPlugin('deepseek');
    if (!plugin) {
      throw new Error(`No converter plugin for model: ${data.model}`);
    }

    const converted = plugin.convertRequest(data, logger);
    converted.stream = false;

    const apiUrl = plugin.getApiUrl();
    const targetUrl = `${apiUrl}/v1/chat/completions`;
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
      throw new Error(`DeepSeek API error ${response.status}`);
    }

    const deepseek_response = response.data;
    const responses_response = plugin.convertResponse(deepseek_response, data, logger);

    if (!responses_response) {
      throw new Error('Failed to convert DeepSeek response');
    }

    logger.info(`Webhook delivery: status=completed, id=${responses_response.id}`);
    await deliver_webhook(webhook_url, {
      status: 'completed',
      response: responses_response,
    }, logger);
  } catch (error: any) {
    logger.error(`Webhook processing failed: ${error.message}`);
    try {
      await deliver_webhook(webhook_url, {
        status: 'failed',
        error: { message: error.message, type: 'processing_error', code: 'upstream_error' },
      }, logger);
    } catch (delivery_error: any) {
      logger.error(`Webhook delivery failed: ${delivery_error.message}`);
    }
  }
}

async function deliver_webhook(url: string, payload: any, logger: any): Promise<void> {
  logger.info(`Delivering webhook result to ${url}`);
  await axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });
}

export async function handle_webhook_request(
  req: Request,
  res: Response,
  logger: any,
  request_id: string,
): Promise<void> {
  const data = req.body;
  const webhook_url = typeof data.webhook === 'string'
    ? data.webhook
    : data.webhook?.url;

  if (!webhook_url || typeof webhook_url !== 'string') {
    res.status(400).json({
      error: {
        message: 'webhook must be a URL string or an object with a url field',
        type: 'validation_error',
        code: 'bad_request',
      },
    });
    return;
  }

  try {
    const parsed = new URL(webhook_url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Invalid protocol');
    }
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '0.0.0.0') {
      logger.warn(`Webhook URL targets localhost: ${webhook_url}`);
      // Allow it but warn
    }
  } catch {
    res.status(400).json({
      error: {
        message: 'Invalid webhook URL',
        type: 'validation_error',
        code: 'bad_request',
      },
    });
    return;
  }

  logger.info(`Webhook request received, target: ${webhook_url}`);

  // Return 202 Accepted immediately
  res.status(202).json({
    id: request_id,
    status: 'processing',
  });

  // Process and deliver asynchronously
  process_and_deliver(data, webhook_url, logger).catch((err) => {
    logger.error(`Unhandled webhook error: ${err.message}`);
  });
}
