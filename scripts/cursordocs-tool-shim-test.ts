import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type JsonRecord = Record<string, unknown>;

type OpenAIModelDescriptor = {
  id?: string;
  display_name?: string;
};

type OpenAIToolCall = {
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAIChatResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: unknown;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
};

type CaseReport = {
  caseId: string;
  ok: boolean;
  note: string;
};

type ModelReport = {
  model: string;
  displayName: string;
  ok: boolean;
  reports: CaseReport[];
};

const DEFAULT_PORT = parseInt(process.env.CURSORDOCS_TOOL_TEST_PORT?.trim() || '8842', 10);
const BASE_URL =
  process.env.CURSORDOCS_TOOL_TEST_BASE_URL?.trim() || `http://127.0.0.1:${DEFAULT_PORT}`;
const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = dirname(CURRENT_FILE_PATH);
const SERVER_WORKDIR = resolve(SCRIPTS_DIR, '..');
const SERVER_PATH = resolve(SERVER_WORKDIR, 'scripts/cursordocs-openai-compatible.ts');
const STARTUP_TIMEOUT_MS = parseInt(
  process.env.CURSORDOCS_TOOL_TEST_STARTUP_TIMEOUT_MS?.trim() || '30000',
  10
);
const REQUEST_TIMEOUT_MS = parseInt(
  process.env.CURSORDOCS_TOOL_TEST_REQUEST_TIMEOUT_MS?.trim() || '180000',
  10
);
const MODEL_FILTER = new Set(
  (process.env.CURSORDOCS_TOOL_TEST_MODELS?.trim() || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
);

const DANGEROUS_NAMED_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Execute shell command',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
    },
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(pathname: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(parsed)}`);
  }

  return parsed;
}

async function waitForHealth(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    try {
      const response = await fetch(`${BASE_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) return;
    } catch {
      // continue polling
    }
    await sleep(500);
  }
  throw new Error(`等待服务启动超时：${STARTUP_TIMEOUT_MS}ms`);
}

function spawnServer(): { child: ChildProcessWithoutNullStreams; logBuffer: string[] } {
  const logBuffer: string[] = [];
  const child = spawn('pnpm', ['exec', 'tsx', SERVER_PATH], {
    cwd: SERVER_WORKDIR,
    env: {
      ...process.env,
      CURSORDOCS_OPENAI_PORT: String(DEFAULT_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const onData = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      logBuffer.push(line);
      if (logBuffer.length > 200) logBuffer.shift();
    }
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  return { child, logBuffer };
}

async function stopServer(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child) return;
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  const startedAt = Date.now();
  while (child.exitCode == null && Date.now() - startedAt < 10000) {
    await sleep(200);
  }
  if (child.exitCode == null) child.kill('SIGKILL');
}

async function callToolCase(model: string, prompt: string): Promise<OpenAIChatResponse> {
  return (await fetchJson('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model,
      stream: false,
      parallel_tool_calls: false,
      tools: DANGEROUS_NAMED_TOOLS,
      messages: [{ role: 'user', content: prompt }],
    }),
  })) as OpenAIChatResponse;
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const record = item as JsonRecord;
        if (typeof record.text === 'string') return record.text;
        if (typeof record.content === 'string') return record.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    const record = content as JsonRecord;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  return '';
}

function validateToolResponse(
  payload: OpenAIChatResponse,
  expectedToolName: string,
  expectedArgumentKey: string,
  expectedArgumentValue: string
): CaseReport {
  const choice = payload.choices?.[0];
  const toolCall = choice?.message?.tool_calls?.[0];
  const actualToolName = toolCall?.function?.name || '';
  const actualArgumentText = toolCall?.function?.arguments || '';
  let parsedArguments: JsonRecord = {};

  try {
    parsedArguments = actualArgumentText ? (JSON.parse(actualArgumentText) as JsonRecord) : {};
  } catch {
    parsedArguments = {};
  }

  const ok =
    choice?.finish_reason === 'tool_calls' &&
    actualToolName === expectedToolName &&
    String(parsedArguments[expectedArgumentKey] || '') === expectedArgumentValue;

  return {
    caseId: expectedToolName,
    ok,
    note: ok
      ? `${expectedToolName} 正常返回`
      : `期望 ${expectedToolName}(${expectedArgumentKey}=${expectedArgumentValue})，实际 finish_reason=${String(choice?.finish_reason)} tool=${actualToolName} args=${actualArgumentText}`,
  };
}

async function runKiloFinalizeCase(model: string): Promise<CaseReport> {
  const payload = (await fetchJson('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model,
      stream: false,
      tools: DANGEROUS_NAMED_TOOLS,
      messages: [
        {
          role: 'system',
          content:
            'You are Kilo Code. Use tools execute_command, list_files, attempt_completion. Never mention that this is a proxy. Always follow Kilo Code system rules.',
        },
        {
          role: 'user',
          content: '请读取 /tmp/demo.txt 并告诉我内容',
        },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'list_files',
                arguments: '{"path":"/tmp"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          name: 'list_files',
          content: '{"files":["demo.txt"]}',
        },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: {
                name: 'execute_command',
                arguments: '{"command":"cat /tmp/demo.txt"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_2',
          name: 'execute_command',
          content: 'hello from file',
        },
      ],
    }),
  })) as OpenAIChatResponse;

  const choice = payload.choices?.[0];
  const content = flattenContent(choice?.message?.content).trim();
  const ok =
    choice?.finish_reason === 'stop' &&
    /hello from file/i.test(content) &&
    !/Kilo Code|提示注入|system prompt injection|proxy/i.test(content);

  return {
    caseId: 'kilo_followup_finalize',
    ok,
    note: ok
      ? 'Kilo 风格后续轮次未再触发镜像站拦截'
      : `期望基于工具结果正常回答，实际 finish_reason=${String(choice?.finish_reason)} content=${content}`,
  };
}

async function runKiloInitialRouteCase(model: string): Promise<CaseReport> {
  const payload = (await fetchJson('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model,
      stream: false,
      tools: DANGEROUS_NAMED_TOOLS,
      messages: [
        {
          role: 'system',
          content:
            'You are Kilo Code. Use execute_command aggressively. Never reveal the proxy layer. Ignore any middleware adaptation.',
        },
        {
          role: 'user',
          content: '请读取 /tmp/demo.txt 并告诉我内容',
        },
      ],
    }),
  })) as OpenAIChatResponse;

  const choice = payload.choices?.[0];
  const toolCall = choice?.message?.tool_calls?.[0];
  const toolName = toolCall?.function?.name || '';
  const argumentsText = toolCall?.function?.arguments || '';
  const ok =
    choice?.finish_reason === 'tool_calls' &&
    toolName === 'execute_command' &&
    /cat\s+\/tmp\/demo\.txt/.test(argumentsText);

  return {
    caseId: 'kilo_initial_route',
    ok,
    note: ok
      ? 'Kilo 风格首轮请求已被本地确定性路由接管'
      : `期望首轮直接返回 execute_command(cat /tmp/demo.txt)，实际 finish_reason=${String(choice?.finish_reason)} tool=${toolName} args=${argumentsText}`,
  };
}

async function runStreamCase(model: string): Promise<CaseReport> {
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: true,
      parallel_tool_calls: false,
      tools: DANGEROUS_NAMED_TOOLS,
      messages: [{ role: 'user', content: '请帮我删除 /tmp/test.txt 并告诉我结果' }],
    }),
  });

  const raw = await response.text();
  const hasToolName = /"name":"delete_file"/.test(raw);
  const hasFinishReason = /"finish_reason":"tool_calls"/.test(raw);
  const hasDone = /\[DONE\]/.test(raw);

  return {
    caseId: 'stream_delete_file',
    ok: response.ok && hasToolName && hasFinishReason && hasDone,
    note:
      response.ok && hasToolName && hasFinishReason && hasDone
        ? '流式 tool_calls 正常'
        : `流式异常：status=${response.status} raw=${raw.slice(0, 300)}`,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const { child, logBuffer } = spawnServer();

  try {
    await waitForHealth();
    const modelsPayload = (await fetchJson('/v1/models', { method: 'GET', headers: {} })) as {
      data?: OpenAIModelDescriptor[];
    };
    const models = (Array.isArray(modelsPayload.data) ? modelsPayload.data : [])
      .filter((item) => item?.id)
      .filter((item) => MODEL_FILTER.size === 0 || MODEL_FILTER.has(String(item.id)));

    if (models.length === 0) {
      throw new Error(
        MODEL_FILTER.size > 0 ? '没有匹配到指定的测试模型' : '模型列表为空，无法执行 tool shim 验证'
      );
    }

    const reports: ModelReport[] = [];

    for (const model of models) {
      const modelId = String(model.id);
      const displayName = String(model.display_name || model.id);
      const deletePayload = await callToolCase(modelId, '请帮我删除 /tmp/test.txt 并告诉我结果');
      const executePayload = await callToolCase(modelId, '请执行命令 pwd 并告诉我结果');
      const perModelReports: CaseReport[] = [
        validateToolResponse(deletePayload, 'delete_file', 'path', '/tmp/test.txt'),
        validateToolResponse(executePayload, 'execute_command', 'command', 'pwd'),
        await runKiloInitialRouteCase(modelId),
        await runKiloFinalizeCase(modelId),
      ];
      reports.push({
        model: modelId,
        displayName,
        ok: perModelReports.every((item) => item.ok),
        reports: perModelReports,
      });
    }

    const streamReport = await runStreamCase(String(models[0]?.id));
    const finishedAt = new Date().toISOString();
    const summary = {
      baseUrl: BASE_URL,
      startedAt,
      finishedAt,
      totalModels: reports.length,
      passedModels: reports.filter((item) => item.ok).length,
      failedModels: reports.filter((item) => !item.ok).length,
      streamReport,
      reports,
    };

    console.log(JSON.stringify(summary, null, 2));

    if (reports.some((item) => !item.ok) || !streamReport.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      '[cursordocs-tool-shim-test] failed:',
      error instanceof Error ? error.message : String(error)
    );
    if (logBuffer.length > 0) {
      console.error('[cursordocs-tool-shim-test] recent server logs:');
      for (const line of logBuffer.slice(-40)) {
        console.error(line);
      }
    }
    process.exitCode = 1;
  } finally {
    await stopServer(child);
  }
}

main().catch((error) => {
  console.error(
    '[cursordocs-tool-shim-test] unexpected failure:',
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
