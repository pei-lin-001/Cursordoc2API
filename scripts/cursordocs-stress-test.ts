import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type JsonRecord = Record<string, unknown>;

type OpenAIToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAIChatChoice = {
  finish_reason?: string | null;
  message?: {
    role?: string;
    content?: unknown;
    tool_calls?: OpenAIToolCall[];
  };
};

type OpenAIChatResponse = {
  choices?: OpenAIChatChoice[];
  data?: unknown[];
};

type RoundResult = {
  ok: boolean;
  latencyMs: number;
  detail: string;
};

type PhaseReport = {
  name: string;
  rounds: number;
  successes: number;
  failures: number;
  successRate: number;
  minLatencyMs: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p90LatencyMs: number;
  maxLatencyMs: number;
  failureSamples: string[];
};

type StressSummary = {
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  config: JsonRecord;
  phases: PhaseReport[];
};

const DEFAULT_PORT = parseInt(process.env.CURSORDOCS_STRESS_PORT?.trim() || '8830', 10);
const BASE_URL =
  process.env.CURSORDOCS_STRESS_BASE_URL?.trim() || `http://127.0.0.1:${DEFAULT_PORT}`;
const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = dirname(CURRENT_FILE_PATH);
const SERVER_WORKDIR = resolve(SCRIPTS_DIR, '..');
const SERVER_PATH = resolve(SERVER_WORKDIR, 'scripts/cursordocs-openai-compatible.ts');
const MODELS_ROUNDS = parseInt(process.env.CURSORDOCS_STRESS_MODELS_ROUNDS?.trim() || '6', 10);
const BASIC_ROUNDS = parseInt(process.env.CURSORDOCS_STRESS_BASIC_ROUNDS?.trim() || '6', 10);
const TOOL_ROUNDS = parseInt(process.env.CURSORDOCS_STRESS_TOOL_ROUNDS?.trim() || '4', 10);
const STREAM_ROUNDS = parseInt(process.env.CURSORDOCS_STRESS_STREAM_ROUNDS?.trim() || '3', 10);
const BURST_WAVES = parseInt(process.env.CURSORDOCS_STRESS_BURST_WAVES?.trim() || '2', 10);
const BURST_CONCURRENCY = parseInt(
  process.env.CURSORDOCS_STRESS_BURST_CONCURRENCY?.trim() || '3',
  10
);
const STARTUP_TIMEOUT_MS = parseInt(
  process.env.CURSORDOCS_STRESS_STARTUP_TIMEOUT_MS?.trim() || '30000',
  10
);
const REQUEST_TIMEOUT_MS = parseInt(
  process.env.CURSORDOCS_STRESS_REQUEST_TIMEOUT_MS?.trim() || '180000',
  10
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
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

async function runRound(executor: () => Promise<string>): Promise<RoundResult> {
  const startedAt = Date.now();
  try {
    const detail = await executor();
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      detail,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function toPhaseReport(name: string, results: RoundResult[]): PhaseReport {
  const latencies = results.map((item) => item.latencyMs);
  const successes = results.filter((item) => item.ok).length;
  const failures = results.length - successes;
  const failureSamples = results
    .filter((item) => !item.ok)
    .slice(0, 5)
    .map((item) => item.detail);
  return {
    name,
    rounds: results.length,
    successes,
    failures,
    successRate: results.length === 0 ? 0 : successes / results.length,
    minLatencyMs: latencies.length > 0 ? Math.min(...latencies) : 0,
    avgLatencyMs:
      latencies.length > 0 ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0,
    p50LatencyMs: percentile(latencies, 0.5),
    p90LatencyMs: percentile(latencies, 0.9),
    maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : 0,
    failureSamples,
  };
}

async function runModelsRound(): Promise<string> {
  const payload = (await fetchJson('/v1/models', { method: 'GET', headers: {} })) as JsonRecord;
  const models = Array.isArray(payload.data) ? payload.data : [];
  if (models.length === 0) throw new Error('模型列表为空');
  return `models=${models.length}`;
}

async function runBasicRound(): Promise<string> {
  const payload = (await fetchJson('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4.6',
      stream: false,
      messages: [{ role: 'user', content: 'Reply with exactly OK' }],
    }),
  })) as OpenAIChatResponse;
  const choice = payload.choices?.[0];
  const finishReason = choice?.finish_reason;
  const content = flattenContent(choice?.message?.content).trim();
  if (finishReason !== 'stop') throw new Error(`finish_reason=${String(finishReason)}`);
  if (content !== 'OK') throw new Error(`unexpected content=${content}`);
  return content;
}

async function runToolRound(): Promise<string> {
  const payload = (await fetchJson('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4.6',
      stream: false,
      tool_choice: 'required',
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '根据城市名称查询天气',
            parameters: {
              type: 'object',
              properties: {
                city: { type: 'string' },
              },
              required: ['city'],
            },
          },
        },
      ],
      messages: [{ role: 'user', content: '请调用 get_weather 查询杭州天气，不要直接回答。' }],
    }),
  })) as OpenAIChatResponse;
  const choice = payload.choices?.[0];
  if (choice?.finish_reason !== 'tool_calls') {
    throw new Error(`finish_reason=${String(choice?.finish_reason)}`);
  }
  const toolCalls = choice.message?.tool_calls || [];
  if (toolCalls.length === 0) throw new Error('没有返回 tool_calls');
  const firstTool = toolCalls[0]?.function?.name || '';
  if (firstTool !== 'get_weather') throw new Error(`unexpected tool=${firstTool}`);
  return firstTool;
}

async function runStreamRound(): Promise<string> {
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4.6',
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly OK' }],
    }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const text = await response.text();
  if (!text.includes('"delta":{"content":"OK"}')) {
    throw new Error('流式输出中没有 OK 分片');
  }
  if (!text.includes('[DONE]')) {
    throw new Error('流式输出缺少 [DONE]');
  }
  return 'stream-ok';
}

async function runBurstWave(wave: number): Promise<RoundResult[]> {
  const tasks = Array.from({ length: BURST_CONCURRENCY }, (_, index) =>
    runRound(async () => {
      const payload = (await fetchJson('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4.6',
          stream: false,
          messages: [{ role: 'user', content: `Reply with exactly OK (${wave}-${index})` }],
        }),
      })) as OpenAIChatResponse;
      const content = flattenContent(payload.choices?.[0]?.message?.content).trim();
      if (!content.includes('OK')) throw new Error(`unexpected content=${content}`);
      return content;
    })
  );
  return Promise.all(tasks);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const phases: PhaseReport[] = [];
  let child: ChildProcessWithoutNullStreams | undefined;
  let logBuffer: string[] = [];

  try {
    const spawned = spawnServer();
    child = spawned.child;
    logBuffer = spawned.logBuffer;
    await waitForHealth();

    const modelsResults = await Promise.all(Array.from({ length: MODELS_ROUNDS }, () => runRound(runModelsRound)));
    phases.push(toPhaseReport('models', modelsResults));

    const basicResults = await Promise.all(Array.from({ length: BASIC_ROUNDS }, () => runRound(runBasicRound)));
    phases.push(toPhaseReport('basic', basicResults));

    const toolResults = await Promise.all(Array.from({ length: TOOL_ROUNDS }, () => runRound(runToolRound)));
    phases.push(toPhaseReport('tools', toolResults));

    const streamResults = await Promise.all(Array.from({ length: STREAM_ROUNDS }, () => runRound(runStreamRound)));
    phases.push(toPhaseReport('stream', streamResults));

    const burstResults: RoundResult[] = [];
    for (let wave = 0; wave < BURST_WAVES; wave += 1) {
      burstResults.push(...(await runBurstWave(wave)));
    }
    phases.push(toPhaseReport('burst', burstResults));

    const finishedAt = Date.now();
    const summary: StressSummary = {
      baseUrl: BASE_URL,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      config: {
        modelsRounds: MODELS_ROUNDS,
        basicRounds: BASIC_ROUNDS,
        toolRounds: TOOL_ROUNDS,
        streamRounds: STREAM_ROUNDS,
        burstWaves: BURST_WAVES,
        burstConcurrency: BURST_CONCURRENCY,
      },
      phases,
    };

    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('[cursordocs-stress-test] failed');
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    if (logBuffer.length > 0) {
      console.error('\n--- recent server logs ---');
      console.error(logBuffer.join('\n'));
    }
    process.exitCode = 1;
  } finally {
    await stopServer(child);
  }
}

void main();
