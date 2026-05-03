import {
  OpenAiResponsesRequest,
  DeepSeekChatRequest,
  OpenAiResponsesResponse,
  StreamChunk,
  convert_responses_to_chat_completions,
  convert_chat_completions_to_responses,
  parse_deepseek_stream_chunk,
  convert_stream_chunk,
} from '../converter';
import { ConverterPlugin, pluginRegistry } from '../plugin-system';

export class DeepSeekPlugin implements ConverterPlugin {
  readonly name = 'deepseek';

  matchesModel(model: string): boolean {
    const m = model.toLowerCase();
    return m.includes('deepseek') || m === 'deepseek-chat'
      || m === 'deepseek-v4-pro' || m === 'deepseek-v4-flash';
  }

  convertRequest(req: OpenAiResponsesRequest, logger: any): DeepSeekChatRequest {
    return convert_responses_to_chat_completions(req, logger);
  }

  convertResponse(
    resp: any,
    originalReq: OpenAiResponsesRequest,
    logger: any,
  ): OpenAiResponsesResponse | null {
    return convert_chat_completions_to_responses(resp, originalReq, logger);
  }

  parseStreamChunk(chunkLine: Buffer): any {
    return parse_deepseek_stream_chunk(chunkLine);
  }

  convertStreamChunk(chunk: any, originalReq: OpenAiResponsesRequest): StreamChunk | null {
    return convert_stream_chunk(chunk, originalReq);
  }

  getApiUrl(): string {
    const baseUrl = process.env.DEEPSEEK_BASE_URL
      || process.env.ANTHROPIC_BASE_URL?.replace(/\/anthropic$/, '')
      || 'https://api.deepseek.com';
    return baseUrl;
  }

  getAuthHeaders(): Record<string, string> {
    const apiKey = process.env.DEEPSEEK_API_KEY
      || process.env.ANTHROPIC_AUTH_TOKEN
      || process.env.OPENAI_API_KEY
      || '';
    return { Authorization: `Bearer ${apiKey}` };
  }
}

// Auto-register on import
pluginRegistry.register(new DeepSeekPlugin());
