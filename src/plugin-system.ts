import {
  OpenAiResponsesRequest,
  DeepSeekChatRequest,
  OpenAiResponsesResponse,
  StreamChunk,
} from './converter';

export interface ConverterPlugin {
  /** Unique provider name (e.g. 'deepseek', 'openai') */
  name: string;
  /** Return true if this plugin handles the given model string */
  matchesModel(model: string): boolean;
  /** Convert an OpenAI Responses API request to this provider's chat format */
  convertRequest(req: OpenAiResponsesRequest, logger: any): DeepSeekChatRequest;
  /** Convert this provider's response back to OpenAI Responses API format */
  convertResponse(resp: any, originalReq: OpenAiResponsesRequest, logger: any): OpenAiResponsesResponse | null;
  /** Parse a single streaming chunk line from this provider */
  parseStreamChunk(chunkLine: Buffer): any;
  /** Convert a parsed stream chunk to the common StreamChunk format */
  convertStreamChunk(chunk: any, originalReq: OpenAiResponsesRequest): StreamChunk | null;
  /** Base API URL for this provider (e.g. https://api.deepseek.com) */
  getApiUrl(): string;
  /** Auth headers to include in every request to this provider */
  getAuthHeaders(): Record<string, string>;
}

export class PluginRegistry {
  private plugins: Map<string, ConverterPlugin> = new Map();
  private orderedNames: string[] = [];

  register(plugin: ConverterPlugin): void {
    if (!this.plugins.has(plugin.name)) {
      this.orderedNames.push(plugin.name);
    }
    this.plugins.set(plugin.name, plugin);
  }

  getPluginForModel(model: string): ConverterPlugin | undefined {
    for (const name of this.orderedNames) {
      const plugin = this.plugins.get(name)!;
      if (plugin.matchesModel(model)) return plugin;
    }
    return undefined;
  }

  getPlugin(name: string): ConverterPlugin | undefined {
    return this.plugins.get(name);
  }

  hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }

  getAllPlugins(): ConverterPlugin[] {
    return this.orderedNames.map(name => this.plugins.get(name)!);
  }
}

export const pluginRegistry = new PluginRegistry();
