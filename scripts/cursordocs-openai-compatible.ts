import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

type JsonRecord = Record<string, unknown>;

type OpenAIMessage = {
  role?: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCallRequest[];
};

type OpenAIChatRequest = {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  tools?: OpenAIToolDefinition[];
  tool_choice?: OpenAIToolChoice;
  parallel_tool_calls?: boolean;
};

type OpenAIToolFunction = {
  name?: string;
  description?: string;
  parameters?: unknown;
};

type OpenAIToolDefinition = {
  type?: string;
  function?: OpenAIToolFunction;
};

type OpenAIToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | {
      type?: string;
      function?: {
        name?: string;
      };
    };

type OpenAIToolCallRequest = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type NormalizedToolDefinition = {
  name: string;
  description: string;
  parameters: unknown;
};

type NormalizedToolChoice =
  | { mode: 'none' }
  | { mode: 'auto' }
  | { mode: 'required' }
  | { mode: 'function'; name: string };

type NormalizedToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type ParsedAssistantResponse =
  | {
      mode: 'assistant';
      content: string;
    }
  | {
      mode: 'tool_calls';
      toolCalls: NormalizedToolCall[];
    };

type PromptMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCallRequest[];
};

type CursorChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: Array<{
    type: 'text';
    text: string;
  }>;
};

type CursorChatRequestBody = {
  id: string;
  model: string;
  messages: CursorChatMessage[];
  trigger: 'submit-message';
  context?: Array<{
    type: 'file';
    content: string;
    filePath: string;
  }>;
};

type CursorModelDescriptor = {
  id: string;
  displayName: string;
  provider: string;
  raw: JsonRecord;
};

type CursorParsedStream = {
  reasoningDeltas: string[];
  reasoningText: string;
  answerDeltas: string[];
  assistantText: string;
  usage?: JsonRecord;
  upstreamModel: string | null;
  created: number | null;
};

type CursorStreamEvent = {
  phase: 'reasoning' | 'answer' | 'other' | 'done';
  deltaContent: string;
  content: string;
  usage?: JsonRecord;
  done: boolean;
};

const HOST = process.env.CURSORDOCS_OPENAI_HOST?.trim() || '127.0.0.1';
const PORT = parseInt(process.env.CURSORDOCS_OPENAI_PORT?.trim() || '8790', 10);
const API_KEY = process.env.CURSORDOCS_OPENAI_API_KEY?.trim() || '';
const STARTUP_URL = process.env.CURSORDOCS_UPSTREAM_BASE_URL?.trim() || 'https://cursor.com';
const DEFAULT_MODEL =
  process.env.CURSORDOCS_DEFAULT_MODEL?.trim() || 'anthropic/claude-sonnet-4.6';
const MODELS_DISCOVERY_PATH = process.env.CURSORDOCS_MODELS_DISCOVERY_PATH?.trim() || '/cn/docs';
const REQUEST_TIMEOUT_MS = parseInt(
  process.env.CURSORDOCS_REQUEST_TIMEOUT_MS?.trim() || '120000',
  10
);
const MODELS_CACHE_TTL_MS = parseInt(
  process.env.CURSORDOCS_MODELS_CACHE_TTL_MS?.trim() || '300000',
  10
);
const FETCH_DYNAMIC_MODELS = parseBoolean(
  process.env.CURSORDOCS_FETCH_DYNAMIC_MODELS,
  true
);
const INCLUDE_DEFAULT_CONTEXT = parseBoolean(
  process.env.CURSORDOCS_INCLUDE_DEFAULT_CONTEXT,
  true
);
const DEFAULT_CONTEXT_PATHS = (process.env.CURSORDOCS_DEFAULT_CONTEXT_PATHS?.trim() || '/docs/')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const EXPOSED_MODELS = parseExposedModels(
  process.env.CURSORDOCS_EXPOSED_MODELS?.trim() ||
    'Sonnet 4.6=anthropic/claude-sonnet-4.6,GPT-5.1 Codex Mini=openai/gpt-5.1-codex-mini,Gemini 3 Flash=google/gemini-3-flash'
);
const MIRROR_REASONING_TO_CONTENT = parseBoolean(
  process.env.CURSORDOCS_MIRROR_REASONING_TO_CONTENT,
  false
);

function resolveBuildVersion(): string {
  const envValue = process.env.CURSORDOCS_BUILD_VERSION?.trim();
  if (envValue) return envValue;

  try {
    return execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .trim();
  } catch {
    return 'unknown';
  }
}

const BUILD_VERSION = resolveBuildVersion();

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function approximateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const record = item as JsonRecord;
      const type = typeof record.type === 'string' ? record.type : '';
      if ((type === 'text' || type === 'input_text' || type === 'output_text') && typeof record.text === 'string') {
        parts.push(record.text);
        continue;
      }
      if (typeof record.content === 'string') parts.push(record.content);
      if (typeof record.text === 'string') parts.push(record.text);
    }
    return parts.join('\n');
  }

  if (content && typeof content === 'object') {
    const record = content as JsonRecord;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }

  return '';
}

function buildAbortSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function writeSseLine(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
  const flush = (res as ServerResponse & { flush?: () => void }).flush;
  if (typeof flush === 'function') flush.call(res);
}

function unauthorized(res: ServerResponse): void {
  writeJson(res, 401, {
    error: {
      message: 'Unauthorized',
      type: 'invalid_request_error',
      code: 'unauthorized',
    },
  });
}

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!API_KEY) return true;
  const authorization = req.headers.authorization || '';
  if (authorization === `Bearer ${API_KEY}`) return true;
  unauthorized(res);
  return false;
}

function parseExposedModels(text: string): CursorModelDescriptor[] {
  const models: CursorModelDescriptor[] = [];
  const seen = new Set<string>();

  for (const rawItem of text.split(',')) {
    const item = rawItem.trim();
    if (!item) continue;

    const eqIndex = item.indexOf('=');
    const displayName = eqIndex >= 0 ? item.slice(0, eqIndex).trim() : item;
    const id = eqIndex >= 0 ? item.slice(eqIndex + 1).trim() : item;
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const provider = id.includes('/') ? id.split('/')[0] || 'cursor.com' : 'cursor.com';
    models.push({
      id,
      displayName: displayName || id,
      provider,
      raw: {
        source: 'cursor-docs-chat-widget',
        configured: true,
      },
    });
  }

  return models;
}

function collectModelDescriptorsFromText(
  text: string,
  source: string,
  sourceUrl?: string
): CursorModelDescriptor[] {
  const models: CursorModelDescriptor[] = [];
  const seen = new Set<string>();
  const pattern =
    /"([^"\n]{1,80})":"((?:openai|anthropic|google|xai|deepseek|mistral|meta|groq|perplexity|cohere|qwen|alibaba|moonshot|fireworks|together|bedrock|vertexai)\/[a-z0-9._:-]{1,160})"/g;

  for (const match of text.matchAll(pattern)) {
    const displayName = match[1]?.trim() || '';
    const id = match[2]?.trim() || '';
    if (!displayName || !id || seen.has(id)) continue;
    if (!/[A-Za-z]/.test(displayName)) continue;
    seen.add(id);

    const provider = id.includes('/') ? id.split('/')[0] || 'cursor.com' : 'cursor.com';
    models.push({
      id,
      displayName,
      provider,
      raw: {
        source,
        source_url: sourceUrl || null,
        discovered: true,
      },
    });
  }

  return models;
}

function mergeModelDescriptors(groups: CursorModelDescriptor[][]): CursorModelDescriptor[] {
  const merged: CursorModelDescriptor[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const model of group) {
      if (!model.id || seen.has(model.id)) continue;
      seen.add(model.id);
      merged.push(model);
    }
  }

  return merged;
}

function extractChunkUrlsFromHtml(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const pattern = /(?:src|href)=["']([^"']*\/_next\/static\/chunks\/[^"']+\.js[^"']*)["']/g;

  for (const match of html.matchAll(pattern)) {
    const rawUrl = match[1]?.trim();
    if (!rawUrl) continue;
    const resolved = new URL(rawUrl, STARTUP_URL).toString();
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    urls.push(resolved);
  }

  return urls;
}

function extractNestedChunkUrlsFromText(text: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const pattern = /"(static\/chunks\/[^"\s]+\.js)"/g;
  const assetBaseUrl = new URL('/docs-static/_next/', STARTUP_URL).toString();

  for (const match of text.matchAll(pattern)) {
    const rawUrl = match[1]?.trim();
    if (!rawUrl) continue;
    const resolved = new URL(rawUrl, assetBaseUrl).toString();
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    urls.push(resolved);
  }

  return urls;
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/javascript,text/javascript,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0',
    },
    signal: buildAbortSignal(signal),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }

  return response.text();
}

async function discoverModelsFromUpstream(signal?: AbortSignal): Promise<CursorModelDescriptor[]> {
  if (!FETCH_DYNAMIC_MODELS) return [];

  const discoveryUrl = new URL(MODELS_DISCOVERY_PATH, STARTUP_URL).toString();
  const html = await fetchText(discoveryUrl, signal);
  const modelsFromHtml = collectModelDescriptorsFromText(html, 'cursor-docs-html-scan', discoveryUrl);
  if (modelsFromHtml.length > 0) return modelsFromHtml;

  const chunkUrls = extractChunkUrlsFromHtml(html);
  if (chunkUrls.length === 0) return [];

  const scripts = await Promise.all(
    chunkUrls.map(async (chunkUrl) => {
      try {
        return {
          chunkUrl,
          text: await fetchText(chunkUrl, signal),
        };
      } catch {
        return null;
      }
    })
  );

  const validScripts = scripts.filter((item): item is { chunkUrl: string; text: string } => item != null);
  const discoveredFromInitialScripts = mergeModelDescriptors(
    validScripts
      .map((item) => collectModelDescriptorsFromText(item.text, 'cursor-docs-chunk-scan', item.chunkUrl))
      .filter((models) => models.length > 0)
  );
  if (discoveredFromInitialScripts.length > 0) return discoveredFromInitialScripts;

  const nestedChunkUrls = Array.from(
    new Set(
      validScripts.flatMap((item) => extractNestedChunkUrlsFromText(item.text, item.chunkUrl))
    )
  ).filter((url) => !chunkUrls.includes(url));

  if (nestedChunkUrls.length === 0) return [];

  const nestedScripts = await Promise.all(
    nestedChunkUrls.map(async (chunkUrl) => {
      try {
        return {
          chunkUrl,
          text: await fetchText(chunkUrl, signal),
        };
      } catch {
        return null;
      }
    })
  );

  const discovered = mergeModelDescriptors(
    nestedScripts
      .filter((item): item is { chunkUrl: string; text: string } => item != null)
      .map((item) =>
        collectModelDescriptorsFromText(item.text, 'cursor-docs-nested-chunk-scan', item.chunkUrl)
      )
      .filter((models) => models.length > 0)
  );

  return discovered;
}

function createEmptyParsedStream(): CursorParsedStream {
  return {
    reasoningDeltas: [],
    reasoningText: '',
    answerDeltas: [],
    assistantText: '',
    usage: undefined,
    upstreamModel: null,
    created: null,
  };
}

function finalizeParsedStream(parsed: CursorParsedStream): CursorParsedStream {
  const reasoningText =
    parsed.reasoningDeltas.length > 0 ? parsed.reasoningDeltas.join('') : parsed.reasoningText;
  const assistantText =
    parsed.answerDeltas.length > 0 ? parsed.answerDeltas.join('') : parsed.assistantText;

  return {
    ...parsed,
    reasoningDeltas:
      parsed.reasoningDeltas.length > 0 ? parsed.reasoningDeltas : reasoningText ? [reasoningText] : [],
    reasoningText,
    answerDeltas:
      parsed.answerDeltas.length > 0 ? parsed.answerDeltas : assistantText ? [assistantText] : [],
    assistantText,
  };
}

function drainSseBlocks(buffer: string): { blocks: string[]; rest: string } {
  let normalized = buffer.replace(/\r\n/g, '\n');
  const blocks: string[] = [];

  while (true) {
    const separatorIndex = normalized.indexOf('\n\n');
    if (separatorIndex === -1) break;
    blocks.push(normalized.slice(0, separatorIndex));
    normalized = normalized.slice(separatorIndex + 2);
  }

  return {
    blocks,
    rest: normalized,
  };
}

function applyCursorSsePayload(target: CursorParsedStream, payload: string): CursorStreamEvent | null {
  if (!payload || payload === '[DONE]') {
    return {
      phase: 'done',
      deltaContent: '',
      content: '',
      done: true,
    };
  }

  const parsed = JSON.parse(payload) as JsonRecord;
  const type = typeof parsed.type === 'string' ? parsed.type : 'other';

  if (type === 'error') {
    throw new Error(String(parsed.errorText || parsed.message || 'Unknown upstream error'));
  }

  if (type === 'finish') {
    const metadata =
      parsed.messageMetadata && typeof parsed.messageMetadata === 'object'
        ? (parsed.messageMetadata as JsonRecord)
        : null;
    const usage = metadata?.usage && typeof metadata.usage === 'object' ? (metadata.usage as JsonRecord) : undefined;
    if (usage) target.usage = usage;
    return {
      phase: 'done',
      deltaContent: '',
      content: '',
      usage,
      done: true,
    };
  }

  if (type === 'text-delta') {
    const delta = typeof parsed.delta === 'string' ? parsed.delta : '';
    if (delta) target.answerDeltas.push(delta);
    return {
      phase: 'answer',
      deltaContent: delta,
      content: delta,
      done: false,
    };
  }

  if (type === 'reasoning-delta') {
    const delta =
      typeof parsed.delta === 'string'
        ? parsed.delta
        : typeof parsed.textDelta === 'string'
          ? parsed.textDelta
          : '';
    if (delta) target.reasoningDeltas.push(delta);
    return {
      phase: 'reasoning',
      deltaContent: delta,
      content: delta,
      done: false,
    };
  }

  if (type === 'reasoning-part-finish' || type === 'reasoning-end' || type === 'reasoning-start') {
    return {
      phase: 'reasoning',
      deltaContent: '',
      content: '',
      done: false,
    };
  }

  return {
    phase: 'other',
    deltaContent: '',
    content: '',
    done: false,
  };
}

function applyCursorSseBlock(target: CursorParsedStream, block: string): CursorStreamEvent[] {
  const events: CursorStreamEvent[] = [];
  const lines = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'));

  for (const line of lines) {
    const payload = line.slice(5).trim();
    if (!payload) continue;
    const event = applyCursorSsePayload(target, payload);
    if (event) events.push(event);
  }

  return events;
}

function parseCursorEventStream(text: string): CursorParsedStream {
  const parsed = createEmptyParsedStream();
  const { blocks, rest } = drainSseBlocks(text);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    applyCursorSseBlock(parsed, trimmed);
  }

  const remaining = rest.trim();
  if (remaining) {
    applyCursorSseBlock(parsed, remaining);
  }

  return finalizeParsedStream(parsed);
}

function normalizeTools(tools: OpenAIToolDefinition[] | undefined): NormalizedToolDefinition[] {
  if (!Array.isArray(tools)) return [];

  const normalizedTools: NormalizedToolDefinition[] = [];
  for (const tool of tools) {
    if (!tool || tool.type !== 'function' || !tool.function?.name) continue;
    normalizedTools.push({
      name: normalizeWhitespace(tool.function.name),
      description: normalizeWhitespace(tool.function.description || ''),
      parameters:
        tool.function.parameters && typeof tool.function.parameters === 'object'
          ? tool.function.parameters
          : { type: 'object', properties: {} },
    });
  }

  return normalizedTools;
}

function normalizeToolChoice(
  toolChoice: OpenAIToolChoice | undefined,
  tools: NormalizedToolDefinition[]
): NormalizedToolChoice {
  if (toolChoice == null || toolChoice === 'auto') return { mode: 'auto' };
  if (toolChoice === 'none') return { mode: 'none' };
  if (toolChoice === 'required') return { mode: 'required' };

  if (
    typeof toolChoice === 'object' &&
    toolChoice.type === 'function' &&
    typeof toolChoice.function?.name === 'string'
  ) {
    const name = normalizeWhitespace(toolChoice.function.name);
    const exists = tools.some((tool) => tool.name === name);
    if (exists) return { mode: 'function', name };
  }

  return { mode: 'auto' };
}

function getRequestedFunctionToolName(toolChoice: OpenAIToolChoice | undefined): string | null {
  if (
    toolChoice &&
    typeof toolChoice === 'object' &&
    toolChoice.type === 'function' &&
    typeof toolChoice.function?.name === 'string'
  ) {
    return normalizeWhitespace(toolChoice.function.name);
  }
  return null;
}

function hasToolResults(messages: OpenAIMessage[]): boolean {
  return messages.some((message) => (message.role || '').toLowerCase() === 'tool');
}

function buildToolInstructionMessage(
  tools: NormalizedToolDefinition[],
  toolChoice: NormalizedToolChoice,
  allowParallelToolCalls: boolean,
  conversationHasToolResults: boolean
): string {
  const choiceInstruction =
    toolChoice.mode === 'required'
      ? '你必须返回 tool_calls，不能直接给最终答案。'
      : toolChoice.mode === 'function'
        ? `你必须且只能调用这个函数：${toolChoice.name}。`
        : toolChoice.mode === 'none'
          ? '不要调用任何函数，直接回答。'
          : '如果需要外部信息或执行动作，就返回 tool_calls；否则直接回答。';

  const resultInstruction = conversationHasToolResults
    ? '当前对话里已经包含 tool 结果。优先利用这些结果给出最终答案，除非确实还需要继续调用函数。'
    : '当前对话里还没有 tool 结果。';

  return [
    '你正在一个 OpenAI Compatible tools 适配器后面工作。',
    '你必须严格按照下面格式输出，且只能输出一个 XML 风格包裹块，不要输出任何额外文字，不要用 Markdown 代码块。',
    '',
    '<openai_tool_response>{"mode":"final","content":"最终回复文本"}</openai_tool_response>',
    '或',
    '<openai_tool_response>{"mode":"tool_calls","tool_calls":[{"name":"函数名","arguments":{"key":"value"}}]}</openai_tool_response>',
    '如果你实在无法输出上面的 XML 包裹块，至少输出纯 JSON 数组，例如：[{"name":"函数名","arguments":{"key":"value"}}]，不要再加任何解释。',
    '',
    '规则：',
    '1. mode 只能是 final 或 tool_calls。',
    '2. 如果输出 tool_calls，arguments 必须是 JSON 对象，不要把 arguments 写成字符串。',
    '3. 只能调用下方列出的函数。',
    '4. 如果没有必要调用函数，就输出 final。',
    `5. ${choiceInstruction}`,
    `6. ${resultInstruction}`,
    `7. ${allowParallelToolCalls ? '允许一次返回多个 tool_calls。' : '最多只能返回一个 tool_call。'}`,
    '',
    '可用函数列表（JSON）：',
    JSON.stringify(tools),
  ].join('\n');
}

function buildAssistantToolCallSummary(message: OpenAIMessage | PromptMessage): string {
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (toolCalls.length === 0) return '';

  const normalized = toolCalls.map((toolCall) => ({
    id: normalizeWhitespace(toolCall.id || ''),
    type: toolCall.type || 'function',
    name: normalizeWhitespace(toolCall.function?.name || ''),
    arguments: toolCall.function?.arguments || '{}',
  }));

  return `[assistant_tool_calls]\n${JSON.stringify(normalized)}`;
}

function buildToolFinalizationMessages(messages: OpenAIMessage[]): PromptMessage[] {
  const systemInstructions = messages
    .filter((message) => {
      const role = (message.role || '').toLowerCase();
      return role === 'system' || role === 'developer';
    })
    .map((message) => flattenContent(message.content).trim())
    .filter(Boolean);

  const lastUserMessage =
    [...messages]
      .reverse()
      .find((message) => (message.role || '').toLowerCase() === 'user' && flattenContent(message.content).trim())
      ?.content ?? '';

  const toolResults = messages
    .filter((message) => (message.role || '').toLowerCase() === 'tool')
    .map((message) => flattenContent(message.content).trim() || '{}')
    .filter(Boolean);

  const rawUserQuestion = flattenContent(lastUserMessage).trim();
  const sanitizedUserQuestion =
    rawUserQuestion
      .replace(/请使用[^。！？\n]*?工具/g, '')
      .replace(/请调用[^。！？\n]*?工具/g, '')
      .replace(/不要直接回答[。！？]?/g, '')
      .replace(/直接回答[。！？]?/g, '')
      .trim() || rawUserQuestion;

  const sections = [
    systemInstructions.length > 0 ? `额外系统要求：\n${systemInstructions.join('\n\n')}` : '',
    sanitizedUserQuestion ? `用户真正想知道的问题：\n${sanitizedUserQuestion}` : '',
    toolResults.length > 0 ? `你已经拿到的事实数据：\n${JSON.stringify(toolResults, null, 2)}` : '',
  ].filter(Boolean);

  return [
    {
      role: 'system',
      content:
        '[instruction]\n你已经收到工具执行结果。现在只能直接回答用户问题，禁止再次调用任何函数，禁止输出 tool_calls、Tool call、工具调用、工具调用参数、函数名、arguments 等中间过程。',
    },
    {
      role: 'user',
      content: `请直接基于下面事实回答用户，不要重复描述调用工具的过程：\n\n${sections.join('\n\n')}`,
    },
  ];
}

function buildToolRepairMessages(
  messages: OpenAIMessage[],
  tools: NormalizedToolDefinition[],
  assistantDraft: string
): OpenAIMessage[] {
  const originalUserPrompt =
    [...messages]
      .reverse()
      .find((message) => (message.role || '').toLowerCase() === 'user' && flattenContent(message.content).trim())
      ?.content ?? '';

  return [
    {
      role: 'system',
      content: [
        '你现在处于函数调用修复模式。',
        '不要声称“没有工具”或“当前环境没有该工具”。这里给你的工具列表就是唯一真实可用工具。',
        '你的任务不是回答用户，而是把用户意图转换成函数调用。',
        '如果需要调用函数，只能从给定 tools 中选择。',
        '严格输出一个 XML 包裹块或纯 JSON 数组，不要输出解释。',
        '<openai_tool_response>{"mode":"tool_calls","tool_calls":[{"name":"函数名","arguments":{"key":"value"}}]}</openai_tool_response>',
        `可用 tools: ${JSON.stringify(tools)}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `用户原始问题：${flattenContent(originalUserPrompt).trim()}`,
        assistantDraft ? `你上一次错误草稿：${assistantDraft}` : '',
        '请重新输出正确的 tool_calls。',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
}

function normalizeMessages(
  messages: OpenAIMessage[],
  options?: {
    tools?: NormalizedToolDefinition[];
    toolChoice?: NormalizedToolChoice;
    allowParallelToolCalls?: boolean;
  }
): PromptMessage[] {
  const normalized: PromptMessage[] = [];
  const normalizedTools = options?.tools || [];
  const toolChoice = options?.toolChoice || { mode: 'auto' as const };
  const conversationHasToolResults = hasToolResults(messages);

  if (conversationHasToolResults && toolChoice.mode !== 'required') {
    return buildToolFinalizationMessages(messages);
  }

  if (
    normalizedTools.length > 0 &&
    toolChoice.mode !== 'none' &&
    (!conversationHasToolResults || toolChoice.mode === 'required')
  ) {
    normalized.push({
      role: 'system',
      content: buildToolInstructionMessage(
        normalizedTools,
        toolChoice,
        options?.allowParallelToolCalls !== false,
        conversationHasToolResults
      ),
    });
  }

  for (const message of messages) {
    const role = (message.role || 'user').toLowerCase();
    const content = flattenContent(message.content).trim();

    if (role === 'assistant') {
      const assistantParts: string[] = [];
      if (content) assistantParts.push(content);
      const toolCallSummary = buildAssistantToolCallSummary(message);
      if (toolCallSummary) assistantParts.push(toolCallSummary);
      if (assistantParts.length > 0) {
        normalized.push({ role: 'assistant', content: assistantParts.join('\n\n') });
      }
      continue;
    }

    if (role === 'user') {
      if (!content) continue;
      normalized.push({ role: 'user', content });
      continue;
    }

    if (role === 'system' || role === 'developer') {
      if (!content) continue;
      normalized.push({ role: 'system', content: `[instruction]\n${content}` });
      continue;
    }

    if (role === 'tool') {
      const toolName = normalizeWhitespace(message.name || '') || 'tool';
      const toolResult = content || '{}';
      normalized.push({
        role: 'tool',
        name: toolName,
        content: `[tool:${toolName}]\n${toolResult}`,
      });
      continue;
    }

    if (!content) continue;
    normalized.push({ role: 'user', content });
  }

  return normalized;
}

function convertPromptMessagesToCursorMessages(messages: PromptMessage[]): CursorChatMessage[] {
  const output: CursorChatMessage[] = [];
  let pendingSystemTexts: string[] = [];

  const pushUserText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    output.push({
      id: `msg_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      role: 'user',
      parts: [{ type: 'text', text: trimmed }],
    });
  };

  const pushAssistantText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    output.push({
      id: `msg_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      role: 'assistant',
      parts: [{ type: 'text', text: trimmed }],
    });
  };

  const flushPendingSystemTexts = () => {
    if (pendingSystemTexts.length === 0) return;
    pushUserText(pendingSystemTexts.join('\n\n'));
    pendingSystemTexts = [];
  };

  for (const message of messages) {
    const content = (message.content || '').trim();
    if (!content && message.role !== 'assistant') continue;

    if (message.role === 'system') {
      if (content) pendingSystemTexts.push(content);
      continue;
    }

    if (message.role === 'user') {
      const merged = pendingSystemTexts.length > 0 ? `${pendingSystemTexts.join('\n\n')}\n\n${content}` : content;
      pendingSystemTexts = [];
      pushUserText(merged);
      continue;
    }

    if (message.role === 'assistant') {
      flushPendingSystemTexts();
      const assistantParts: string[] = [];
      if (content) assistantParts.push(content);
      const toolSummary = buildAssistantToolCallSummary(message);
      if (toolSummary) assistantParts.push(toolSummary);
      pushAssistantText(assistantParts.join('\n\n'));
      continue;
    }

    if (message.role === 'tool') {
      const merged = pendingSystemTexts.length > 0 ? `${pendingSystemTexts.join('\n\n')}\n\n${content}` : content;
      pendingSystemTexts = [];
      pushUserText(merged);
    }
  }

  flushPendingSystemTexts();
  return output;
}

function extractTaggedToolResponse(text: string): string | null {
  const match = text.match(/<openai_tool_response>([\s\S]*?)<\/openai_tool_response>/i);
  if (!match) return null;
  return match[1]?.trim() || null;
}

function extractFirstJsonStructure(text: string): string | null {
  let start = -1;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!char) continue;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{' || char === '[') {
      if (stack.length === 0) start = index;
      stack.push(char);
      continue;
    }

    if (char === '}' || char === ']') {
      const expectedOpeningChar = char === '}' ? '{' : '[';
      const currentOpeningChar = stack[stack.length - 1];
      if (currentOpeningChar !== expectedOpeningChar) continue;
      stack.pop();
      if (stack.length === 0 && start >= 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

function parseToolAdapterPayload(text: string): unknown {
  const candidates = [
    text.trim(),
    text
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim(),
    extractTaggedToolResponse(text),
    extractFirstJsonStructure(text),
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim()));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // continue
    }
  }

  return undefined;
}

function extractHeuristicToolCalls(text: string): Array<{ name: string; arguments: unknown }> {
  const calls: Array<{ name: string; arguments: unknown }> = [];
  const pattern = /Tool call:\s*([A-Za-z_][\w-]*)\s*([^\n]*)/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const name = normalizeWhitespace(match[1] || '');
    const rest = normalizeWhitespace(match[2] || '');
    const args: Record<string, string> = {};
    const argPattern = /([A-Za-z_][\w-]*)\s*:\s*([^,，;；]+)/g;
    let argMatch: RegExpExecArray | null;
    while ((argMatch = argPattern.exec(rest)) !== null) {
      args[argMatch[1]] = normalizeWhitespace(argMatch[2] || '');
    }

    calls.push({
      name,
      arguments: Object.keys(args).length > 0 ? args : {},
    });
  }

  const chineseMatch = text.match(/(工具调用|调用工具)[:：]\s*([A-Za-z_][\w-]*)[\s\S]*?参数[:：]\s*([\s\S]*)/i);
  if (chineseMatch) {
    const name = normalizeWhitespace(chineseMatch[2] || '');
    const rawArguments = normalizeWhitespace(chineseMatch[3] || '');
    const jsonCandidate = extractFirstJsonStructure(rawArguments);
    if (name) {
      if (jsonCandidate) {
        try {
          calls.push({ name, arguments: JSON.parse(jsonCandidate) as unknown });
        } catch {
          calls.push({ name, arguments: {} });
        }
      } else {
        calls.push({ name, arguments: {} });
      }
    }
  }

  return calls;
}

function normalizeToolArguments(argumentsValue: unknown): string {
  if (typeof argumentsValue === 'string') {
    try {
      const parsed = JSON.parse(argumentsValue);
      if (parsed && typeof parsed === 'object') return JSON.stringify(parsed);
    } catch {
      // keep raw
    }
    return argumentsValue.trim() || '{}';
  }

  if (argumentsValue && typeof argumentsValue === 'object') {
    return JSON.stringify(argumentsValue);
  }

  return '{}';
}

function interpretAssistantResponse(
  request: OpenAIChatRequest,
  parsed: CursorParsedStream,
  tools: NormalizedToolDefinition[]
): ParsedAssistantResponse {
  if (tools.length === 0) {
    return {
      mode: 'assistant',
      content: parsed.assistantText,
    };
  }

  const payload = parseToolAdapterPayload(parsed.assistantText);
  const rawToolCalls =
    Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as JsonRecord).name === 'string'
        ? [payload]
        : payload && typeof payload === 'object' && Array.isArray((payload as JsonRecord).tool_calls)
          ? ((payload as JsonRecord).tool_calls as unknown[])
          : payload && typeof payload === 'object' && Array.isArray((payload as JsonRecord).calls)
            ? ((payload as JsonRecord).calls as unknown[])
            : extractHeuristicToolCalls(parsed.assistantText);

  if (rawToolCalls.length > 0) {
    const allowedToolNames = new Set(tools.map((tool) => tool.name));
    const allowParallelToolCalls = request.parallel_tool_calls !== false;
    const dedupeMap = new Map<string, NormalizedToolCall>();

    const rankArguments = (argumentsText: string): number => {
      if (!argumentsText || argumentsText === '{}') return 0;
      try {
        const parsedArguments = JSON.parse(argumentsText) as JsonRecord;
        if (!parsedArguments || typeof parsedArguments !== 'object') return 0;
        return Object.keys(parsedArguments).length;
      } catch {
        return argumentsText.trim().length > 2 ? 1 : 0;
      }
    };

    for (const rawToolCall of rawToolCalls) {
      if (!rawToolCall || typeof rawToolCall !== 'object') continue;
      const record = rawToolCall as JsonRecord;
      const functionName = normalizeWhitespace(String(record.name || ''));
      if (!functionName || !allowedToolNames.has(functionName)) continue;

      const normalizedToolCall = {
        id: `call_${randomUUID().replace(/-/g, '')}`,
        type: 'function',
        function: {
          name: functionName,
          arguments: normalizeToolArguments(record.arguments),
        },
      } satisfies NormalizedToolCall;

      const existing = dedupeMap.get(functionName);
      if (!existing) {
        dedupeMap.set(functionName, normalizedToolCall);
      } else if (
        rankArguments(normalizedToolCall.function.arguments) > rankArguments(existing.function.arguments)
      ) {
        dedupeMap.set(functionName, normalizedToolCall);
      }

      if (!allowParallelToolCalls) break;
    }

    const normalizedToolCalls = [...dedupeMap.values()];
    if (normalizedToolCalls.length > 0) {
      return {
        mode: 'tool_calls',
        toolCalls: normalizedToolCalls,
      };
    }
  }

  if (
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    (payload as JsonRecord).mode === 'final' &&
    typeof (payload as JsonRecord).content === 'string'
  ) {
    return {
      mode: 'assistant',
      content: String((payload as JsonRecord).content),
    };
  }

  return {
    mode: 'assistant',
    content: parsed.assistantText,
  };
}

function buildModelListPayload(models: CursorModelDescriptor[]) {
  return {
    object: 'list',
    data: models.map((model) => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: model.provider,
      display_name: model.displayName,
      proxied_by: 'cursor.com/docs',
      raw: model.raw,
    })),
  };
}

function buildUsagePayload(parsed: CursorParsedStream, promptText: string, completionText: string) {
  const usage = parsed.usage || {};
  const promptTokens =
    typeof usage.inputTokens === 'number'
      ? usage.inputTokens
      : typeof usage.prompt_tokens === 'number'
        ? usage.prompt_tokens
        : approximateTokens(promptText);
  const completionTokens =
    typeof usage.outputTokens === 'number'
      ? usage.outputTokens
      : typeof usage.completion_tokens === 'number'
        ? usage.completion_tokens
        : approximateTokens(completionText);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      typeof usage.totalTokens === 'number'
        ? usage.totalTokens
        : typeof usage.total_tokens === 'number'
          ? usage.total_tokens
          : promptTokens + completionTokens,
  };
}

function buildChatCompletionResponse(
  request: OpenAIChatRequest,
  parsed: CursorParsedStream,
  assistantResponse: ParsedAssistantResponse
) {
  const created = parsed.created ?? Math.floor(Date.now() / 1000);
  const responseModel = request.model || parsed.upstreamModel || DEFAULT_MODEL;
  const promptText = (request.messages || []).map((item) => flattenContent(item.content)).join('\n');
  const completionText =
    assistantResponse.mode === 'assistant'
      ? [parsed.reasoningText, assistantResponse.content].filter(Boolean).join('\n')
      : parsed.reasoningText;
  const finishReason = assistantResponse.mode === 'tool_calls' ? 'tool_calls' : 'stop';
  const message =
    assistantResponse.mode === 'tool_calls'
      ? {
          role: 'assistant',
          content: null,
          phase: 'commentary',
          reasoning_content: parsed.reasoningText || undefined,
          reasoning: parsed.reasoningText || undefined,
          tool_calls: assistantResponse.toolCalls,
        }
      : {
          role: 'assistant',
          content: assistantResponse.content,
          phase: 'final_answer',
          reasoning_content: parsed.reasoningText || undefined,
          reasoning: parsed.reasoningText || undefined,
        };

  return {
    id: `chatcmpl_${randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created,
    model: responseModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: buildUsagePayload(parsed, promptText, completionText),
    system_fingerprint: 'cursor-docs-http-bridge',
  };
}

function buildStreamChunkEnvelope(
  id: string,
  created: number,
  model: string,
  delta: JsonRecord,
  finishReason: string | null
) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

function buildRoleStreamChunk(id: string, created: number, model: string) {
  return buildStreamChunkEnvelope(id, created, model, { role: 'assistant' }, null);
}

function buildReasoningStreamChunk(id: string, created: number, model: string, reasoningDelta: string) {
  return buildStreamChunkEnvelope(
    id,
    created,
    model,
    {
      phase: 'commentary',
      reasoning_content: reasoningDelta,
      reasoning: reasoningDelta,
      ...(MIRROR_REASONING_TO_CONTENT ? { content: reasoningDelta } : {}),
    },
    null
  );
}

function buildContentStreamChunk(id: string, created: number, model: string, contentDelta: string) {
  return buildStreamChunkEnvelope(id, created, model, { phase: 'final_answer', content: contentDelta }, null);
}

function buildToolCallStreamChunks(
  id: string,
  created: number,
  model: string,
  toolCalls: NormalizedToolCall[]
) {
  return toolCalls.map((toolCall, index) =>
    buildStreamChunkEnvelope(
      id,
      created,
      model,
      {
        tool_calls: [
          {
            index,
            id: toolCall.id,
            type: 'function',
            function: {
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          },
        ],
      },
      null
    )
  );
}

function buildFinishStreamChunk(
  id: string,
  created: number,
  model: string,
  finishReason: 'stop' | 'tool_calls'
) {
  return buildStreamChunkEnvelope(id, created, model, {}, finishReason);
}

async function readResponseText(response: Response): Promise<string> {
  return response.text();
}

async function buildResponseError(response: Response): Promise<Error> {
  const text = await readResponseText(response);
  try {
    const parsed = JSON.parse(text) as JsonRecord;
    const errorRecord =
      parsed.error && typeof parsed.error === 'object' ? (parsed.error as JsonRecord) : parsed;
    return new Error(String(errorRecord.detail || errorRecord.message || text || response.status));
  } catch {
    return new Error(text || `HTTP ${response.status}`);
  }
}

async function relayUpstreamSseToOpenAI(params: {
  res: ServerResponse;
  upstreamResponse: Response;
  allowIncrementalAnswer: boolean;
  streamId: string;
  created: number;
  model: string;
}): Promise<{ parsed: CursorParsedStream; streamedReasoningCount: number; streamedAnswerCount: number }> {
  const { res, upstreamResponse, allowIncrementalAnswer, streamId, created, model } = params;
  const parsed = createEmptyParsedStream();
  const reader = upstreamResponse.body?.getReader();
  if (!reader) throw new Error('上游流响应缺少 body');

  const decoder = new TextDecoder();
  let buffer = '';
  let streamedReasoningCount = 0;
  let streamedAnswerCount = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const drained = drainSseBlocks(buffer);
    buffer = drained.rest;

    for (const block of drained.blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      const events = applyCursorSseBlock(parsed, trimmed);
      for (const event of events) {
        if (event.phase === 'reasoning' && event.deltaContent) {
          writeSseLine(res, buildReasoningStreamChunk(streamId, created, model, event.deltaContent));
          streamedReasoningCount += 1;
          continue;
        }

        if (event.phase === 'answer' && event.deltaContent && allowIncrementalAnswer) {
          writeSseLine(res, buildContentStreamChunk(streamId, created, model, event.deltaContent));
          streamedAnswerCount += 1;
        }
      }
    }
  }

  buffer += decoder.decode();
  const remaining = buffer.trim();
  if (remaining) {
    const events = applyCursorSseBlock(parsed, remaining);
    for (const event of events) {
      if (event.phase === 'reasoning' && event.deltaContent) {
        writeSseLine(res, buildReasoningStreamChunk(streamId, created, model, event.deltaContent));
        streamedReasoningCount += 1;
        continue;
      }

      if (event.phase === 'answer' && event.deltaContent && allowIncrementalAnswer) {
        writeSseLine(res, buildContentStreamChunk(streamId, created, model, event.deltaContent));
        streamedAnswerCount += 1;
      }
    }
  }

  return {
    parsed: finalizeParsedStream(parsed),
    streamedReasoningCount,
    streamedAnswerCount,
  };
}

class CursorHttpBridge {
  private modelsCache?: { fetchedAt: number; models: CursorModelDescriptor[] };

  async listModels(): Promise<CursorModelDescriptor[]> {
    const cached = this.modelsCache;
    const now = Date.now();
    if (cached && now - cached.fetchedAt < MODELS_CACHE_TTL_MS) {
      return cached.models;
    }

    let models: CursorModelDescriptor[] = [];

    try {
      models = await discoverModelsFromUpstream();
    } catch (error) {
      console.warn(
        '[cursordocs-openai-compatible] failed to discover live model list, falling back to configured models:',
        error instanceof Error ? error.message : String(error)
      );
    }

    if (models.length === 0) {
      models =
        EXPOSED_MODELS.length > 0
          ? EXPOSED_MODELS
          : [
              {
                id: DEFAULT_MODEL,
                displayName: DEFAULT_MODEL,
                provider: DEFAULT_MODEL.split('/')[0] || 'cursor.com',
                raw: { source: 'fallback-default-model' },
              },
            ];
    }

    this.modelsCache = {
      fetchedAt: now,
      models,
    };
    return models;
  }

  private buildContext() {
    if (!INCLUDE_DEFAULT_CONTEXT || DEFAULT_CONTEXT_PATHS.length === 0) return undefined;
    return DEFAULT_CONTEXT_PATHS.map((filePath) => ({
      type: 'file' as const,
      content: '',
      filePath,
    }));
  }

  private buildChatRequestBody(
    request: OpenAIChatRequest,
    messages: PromptMessage[]
  ): CursorChatRequestBody {
    const cursorMessages = convertPromptMessagesToCursorMessages(messages);
    if (cursorMessages.length === 0) {
      throw new Error('转换后的上游 messages 为空');
    }

    return {
      id: randomUUID().replace(/-/g, '').slice(0, 16),
      model: request.model || DEFAULT_MODEL,
      messages: cursorMessages,
      trigger: 'submit-message',
      context: this.buildContext(),
    };
  }

  async completeStream(
    request: OpenAIChatRequest,
    messages: PromptMessage[],
    signal?: AbortSignal
  ): Promise<Response> {
    const requestBody = this.buildChatRequestBody(request, messages);

    const response = await fetch(new URL('/api/chat', STARTUP_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(requestBody),
      signal: buildAbortSignal(signal),
    });

    if (!response.ok) throw await buildResponseError(response);
    return response;
  }

  async complete(
    request: OpenAIChatRequest,
    messages: PromptMessage[],
    signal?: AbortSignal
  ): Promise<CursorParsedStream> {
    const response = await this.completeStream(request, messages, signal);
    const text = await response.text();
    return parseCursorEventStream(text);
  }
}

const bridge = new CursorHttpBridge();

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);

    if (requestUrl.pathname === '/health' && req.method === 'GET') {
      writeJson(res, 200, {
        status: 'ok',
        service: 'cursordocs-openai-compatible',
        buildVersion: BUILD_VERSION,
        upstream: STARTUP_URL,
        defaultModel: DEFAULT_MODEL,
      });
      return;
    }

    if (!checkAuth(req, res)) return;

    if (requestUrl.pathname === '/v1/models' && req.method === 'GET') {
      const models = await bridge.listModels();
      writeJson(res, 200, buildModelListPayload(models));
      return;
    }

    if (requestUrl.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const body = (await readJsonBody(req)) as OpenAIChatRequest;
      const normalizedTools = normalizeTools(body.tools);
      if (Array.isArray(body.tools) && body.tools.length > 0 && normalizedTools.length === 0) {
        writeJson(res, 400, {
          error: {
            message: '当前只支持 type=function 的 tools',
            type: 'invalid_request_error',
            code: 'unsupported_tools',
          },
        });
        return;
      }

      const requestedFunctionToolName = getRequestedFunctionToolName(body.tool_choice);
      if (requestedFunctionToolName && !normalizedTools.some((tool) => tool.name === requestedFunctionToolName)) {
        writeJson(res, 400, {
          error: {
            message: `tool_choice 指定的函数不存在：${requestedFunctionToolName}`,
            type: 'invalid_request_error',
            code: 'tool_choice_invalid',
          },
        });
        return;
      }

      const originalMessages = Array.isArray(body.messages) ? body.messages : [];
      const toolChoice = normalizeToolChoice(body.tool_choice, normalizedTools);
      const normalizedMessages = normalizeMessages(originalMessages, {
        tools: normalizedTools,
        toolChoice,
        allowParallelToolCalls: body.parallel_tool_calls !== false,
      });

      if (normalizedMessages.length === 0) {
        writeJson(res, 400, {
          error: {
            message: 'messages 不能为空',
            type: 'invalid_request_error',
            code: 'messages_required',
          },
        });
        return;
      }

      const conversationHasToolResults = hasToolResults(originalMessages);
      const mayRequireDeferredToolDecision =
        normalizedTools.length > 0 && toolChoice.mode !== 'none' && !conversationHasToolResults;

      if (body.stream) {
        const abortController = new AbortController();
        const abortUpstream = () => abortController.abort();
        req.once('close', abortUpstream);

        try {
          const upstreamResponse = await bridge.completeStream(body, normalizedMessages, abortController.signal);
          const created = Math.floor(Date.now() / 1000);
          const responseModel = body.model || DEFAULT_MODEL;
          const streamId = `chatcmpl_${randomUUID().replace(/-/g, '')}`;
          const allowIncrementalAnswer = !mayRequireDeferredToolDecision;

          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.socket?.setNoDelay(true);
          res.flushHeaders();
          writeSseLine(res, buildRoleStreamChunk(streamId, created, responseModel));

          const relayed = await relayUpstreamSseToOpenAI({
            res,
            upstreamResponse,
            allowIncrementalAnswer,
            streamId,
            created,
            model: responseModel,
          });

          let parsed = relayed.parsed;
          let assistantResponse = interpretAssistantResponse(body, parsed, normalizedTools);

          if (
            normalizedTools.length > 0 &&
            toolChoice.mode !== 'none' &&
            !conversationHasToolResults &&
            assistantResponse.mode === 'assistant'
          ) {
            const repairMessages = buildToolRepairMessages(originalMessages, normalizedTools, parsed.assistantText);
            const repairedRequest: OpenAIChatRequest = {
              ...body,
              messages: repairMessages,
              stream: false,
            };
            const repairedNormalizedMessages = normalizeMessages(repairMessages, {
              tools: normalizedTools,
              toolChoice,
              allowParallelToolCalls: body.parallel_tool_calls !== false,
            });
            const repairedParsed = await bridge.complete(repairedRequest, repairedNormalizedMessages);
            const repairedAssistantResponse = interpretAssistantResponse(repairedRequest, repairedParsed, normalizedTools);
            if (repairedAssistantResponse.mode === 'tool_calls') {
              parsed = repairedParsed;
              assistantResponse = repairedAssistantResponse;
            }
          }

          if (relayed.streamedReasoningCount === 0 && parsed.reasoningText) {
            writeSseLine(res, buildReasoningStreamChunk(streamId, created, responseModel, parsed.reasoningText));
          }

          if (assistantResponse.mode === 'tool_calls') {
            for (const chunk of buildToolCallStreamChunks(streamId, created, responseModel, assistantResponse.toolCalls)) {
              writeSseLine(res, chunk);
            }
          } else if (!allowIncrementalAnswer) {
            const answerDeltas =
              parsed.answerDeltas.length > 0 ? parsed.answerDeltas : parsed.assistantText ? [parsed.assistantText] : [];
            if (relayed.streamedAnswerCount === 0) {
              for (const delta of answerDeltas) {
                writeSseLine(res, buildContentStreamChunk(streamId, created, responseModel, delta));
              }
            }
          } else if (relayed.streamedAnswerCount === 0 && assistantResponse.content) {
            writeSseLine(res, buildContentStreamChunk(streamId, created, responseModel, assistantResponse.content));
          }

          writeSseLine(
            res,
            buildFinishStreamChunk(
              streamId,
              created,
              responseModel,
              assistantResponse.mode === 'tool_calls' ? 'tool_calls' : 'stop'
            )
          );
          writeSseLine(res, '[DONE]');
          res.end();
          return;
        } catch (error) {
          if (res.headersSent) {
            writeSseLine(res, {
              error: {
                message: error instanceof Error ? error.message : String(error),
                type: 'server_error',
                code: 'stream_error',
              },
            });
            writeSseLine(res, '[DONE]');
            res.end();
            return;
          }
          throw error;
        } finally {
          req.off('close', abortUpstream);
        }
      }

      let parsed = await bridge.complete(body, normalizedMessages);
      let assistantResponse = interpretAssistantResponse(body, parsed, normalizedTools);

      if (
        normalizedTools.length > 0 &&
        toolChoice.mode !== 'none' &&
        !conversationHasToolResults &&
        assistantResponse.mode === 'assistant'
      ) {
        const repairMessages = buildToolRepairMessages(originalMessages, normalizedTools, parsed.assistantText);
        const repairedRequest: OpenAIChatRequest = {
          ...body,
          messages: repairMessages,
          stream: false,
        };
        const repairedNormalizedMessages = normalizeMessages(repairMessages, {
          tools: normalizedTools,
          toolChoice,
          allowParallelToolCalls: body.parallel_tool_calls !== false,
        });
        const repairedParsed = await bridge.complete(repairedRequest, repairedNormalizedMessages);
        const repairedAssistantResponse = interpretAssistantResponse(repairedRequest, repairedParsed, normalizedTools);
        if (repairedAssistantResponse.mode === 'tool_calls') {
          parsed = repairedParsed;
          assistantResponse = repairedAssistantResponse;
        }
      }

      writeJson(res, 200, buildChatCompletionResponse(body, parsed, assistantResponse));
      return;
    }

    writeJson(res, 404, {
      error: {
        message: 'Not Found',
        type: 'invalid_request_error',
        code: 'not_found',
      },
    });
  } catch (error) {
    writeJson(res, 500, {
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: 'server_error',
        code: 'internal_error',
      },
    });
  }
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[cursordocs-openai-compatible] received ${signal}, shutting down...`);
  server.close();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

server.listen(PORT, HOST, () => {
  console.log(`[cursordocs-openai-compatible] listening on http://${HOST}:${PORT}`);
  console.log(`[cursordocs-openai-compatible] buildVersion=${BUILD_VERSION}`);
  console.log('[cursordocs-openai-compatible] endpoints: GET /health, GET /v1/models, POST /v1/chat/completions');
});
