import { createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';

type JsonRecord = Record<string, unknown>;

type ProbeModelDescriptor = {
  displayName: string;
  id: string;
};

type ParsedStreamResult = {
  text: string;
  finishReason: string | null;
  reasoningTokens: string[];
  usage?: JsonRecord;
};

const UPSTREAM_BASE_URL = process.env.CURSORDOCS_PROBE_BASE_URL?.trim() || 'https://cursor.com';
const DISCOVERY_PATH = process.env.CURSORDOCS_PROBE_DISCOVERY_PATH?.trim() || '/cn/docs';
const REASONING_MODEL =
  process.env.CURSORDOCS_PROBE_REASONING_MODEL?.trim() || 'openai/gpt-5.1-codex-mini';
const REQUEST_TIMEOUT_MS = parseInt(
  process.env.CURSORDOCS_PROBE_REQUEST_TIMEOUT_MS?.trim() || '120000',
  10
);
const RETRY_COUNT = Math.max(0, parseInt(process.env.CURSORDOCS_PROBE_RETRY_COUNT?.trim() || '2', 10));
const OPTIONAL_REASONING_FERNET_KEY =
  process.env.CURSORDOCS_REASONING_FERNET_KEY?.trim() || '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(normalized + padding, 'base64');
}

function collectModelsFromText(text: string): ProbeModelDescriptor[] {
  const models: ProbeModelDescriptor[] = [];
  const seen = new Set<string>();
  const pattern =
    /"([^"\n]{1,80})":"((?:openai|anthropic|google|xai|deepseek|mistral|meta|groq|perplexity|cohere|qwen|alibaba|moonshot|fireworks|together|bedrock|vertexai)\/[a-z0-9._:-]{1,160})"/g;

  for (const match of text.matchAll(pattern)) {
    const displayName = match[1]?.trim() || '';
    const id = match[2]?.trim() || '';
    if (!displayName || !id || seen.has(id)) continue;
    if (!/[A-Za-z]/.test(displayName)) continue;
    seen.add(id);
    models.push({ displayName, id });
  }

  return models;
}

function extractChunkUrlsFromHtml(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const pattern = /(?:src|href)=["']([^"']*\/_next\/static\/chunks\/[^"']+\.js[^"']*)["']/g;

  for (const match of html.matchAll(pattern)) {
    const rawUrl = match[1]?.trim();
    if (!rawUrl) continue;
    const resolved = new URL(rawUrl, UPSTREAM_BASE_URL).toString();
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
  const assetBaseUrl = new URL('/docs-static/_next/', UPSTREAM_BASE_URL).toString();

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

async function fetchText(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'text/html,application/javascript,text/javascript,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while fetching ${url}`);
      }

      return response.text();
    } catch (error) {
      lastError = error;
      if (attempt < RETRY_COUNT) {
        await sleep(500 * (attempt + 1));
        continue;
      }
    }
  }

  throw new Error(lastError instanceof Error ? lastError.message : String(lastError));
}

async function discoverModels(): Promise<ProbeModelDescriptor[]> {
  const discoveryUrl = new URL(DISCOVERY_PATH, UPSTREAM_BASE_URL).toString();
  const html = await fetchText(discoveryUrl);
  const modelsFromHtml = collectModelsFromText(html);
  if (modelsFromHtml.length > 0) return modelsFromHtml;

  const chunkUrls = extractChunkUrlsFromHtml(html);
  const chunks = await Promise.all(
    chunkUrls.map(async (chunkUrl) => {
      try {
        return {
          chunkUrl,
          text: await fetchText(chunkUrl),
        };
      } catch {
        return null;
      }
    })
  );

  const firstLevelScripts = chunks.filter((item): item is { chunkUrl: string; text: string } => item != null);
  const merged: ProbeModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const chunk of firstLevelScripts) {
    for (const model of collectModelsFromText(chunk.text)) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      merged.push(model);
    }
  }
  if (merged.length > 0) return merged;

  const nestedChunkUrls = Array.from(
    new Set(firstLevelScripts.flatMap((item) => extractNestedChunkUrlsFromText(item.text, item.chunkUrl)))
  ).filter((url) => !chunkUrls.includes(url));

  const nestedChunks = await Promise.all(
    nestedChunkUrls.map(async (chunkUrl) => {
      try {
        return await fetchText(chunkUrl);
      } catch {
        return '';
      }
    })
  );

  for (const chunkText of nestedChunks) {
    for (const model of collectModelsFromText(chunkText)) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      merged.push(model);
    }
  }

  return merged;
}

async function callUpstream(model: string, prompt: string): Promise<string> {
  const payload = {
    model,
    id: `probe-${Math.random().toString(16).slice(2, 14)}`,
    messages: [
      {
        id: 'msg1',
        role: 'user',
        parts: [{ type: 'text', text: prompt }],
      },
    ],
    trigger: 'submit-message',
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt += 1) {
    try {
      const response = await fetch(new URL('/api/chat', UPSTREAM_BASE_URL), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Upstream returned HTTP ${response.status}`);
      }

      return response.text();
    } catch (error) {
      lastError = error;
      if (attempt < RETRY_COUNT) {
        await sleep(500 * (attempt + 1));
        continue;
      }
    }
  }

  throw new Error(lastError instanceof Error ? lastError.message : String(lastError));
}

function parseEventStream(raw: string): ParsedStreamResult {
  const result: ParsedStreamResult = {
    text: '',
    finishReason: null,
    reasoningTokens: [],
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;
    const payload = trimmed.slice(6);
    if (!payload || payload === '[DONE]') continue;

    const parsed = JSON.parse(payload) as JsonRecord;
    const type = typeof parsed.type === 'string' ? parsed.type : '';

    if (type === 'text-delta') {
      result.text += typeof parsed.delta === 'string' ? parsed.delta : '';
      continue;
    }

    if (type === 'finish') {
      result.finishReason =
        typeof parsed.finishReason === 'string' ? parsed.finishReason : result.finishReason;
      const messageMetadata =
        parsed.messageMetadata && typeof parsed.messageMetadata === 'object'
          ? (parsed.messageMetadata as JsonRecord)
          : null;
      if (messageMetadata?.usage && typeof messageMetadata.usage === 'object') {
        result.usage = messageMetadata.usage as JsonRecord;
      }
      continue;
    }

    if (type === 'reasoning-start' || type === 'reasoning-end' || type === 'reasoning-delta') {
      const providerMetadata =
        parsed.providerMetadata && typeof parsed.providerMetadata === 'object'
          ? (parsed.providerMetadata as JsonRecord)
          : null;
      const openaiMetadata =
        providerMetadata?.openai && typeof providerMetadata.openai === 'object'
          ? (providerMetadata.openai as JsonRecord)
          : null;
      const token =
        openaiMetadata && typeof openaiMetadata.reasoningEncryptedContent === 'string'
          ? openaiMetadata.reasoningEncryptedContent
          : '';
      if (token) result.reasoningTokens.push(token);
    }
  }

  return result;
}

function inspectFernetToken(token: string) {
  const decoded = decodeBase64Url(token);
  const versionByte = decoded[0] ?? 0;
  const timestampSeconds = Number(decoded.readBigUInt64BE(1));

  return {
    prefix: token.slice(0, 32),
    tokenLength: token.length,
    decodedLength: decoded.length,
    versionByteHex: `0x${versionByte.toString(16).padStart(2, '0')}`,
    looksLikeFernet: versionByte === 0x80,
    timestampIsoUtc: new Date(timestampSeconds * 1000).toISOString(),
  };
}

function removePkcs7Padding(buffer: Buffer): Buffer {
  const padLength = buffer[buffer.length - 1] ?? 0;
  if (padLength <= 0 || padLength > 16) {
    throw new Error(`Invalid PKCS7 padding length: ${padLength}`);
  }

  for (let index = buffer.length - padLength; index < buffer.length; index += 1) {
    if (buffer[index] !== padLength) {
      throw new Error('Invalid PKCS7 padding bytes');
    }
  }

  return buffer.subarray(0, buffer.length - padLength);
}

function tryDecryptFernet(token: string, key: string): string {
  const tokenBytes = decodeBase64Url(token);
  const keyBytes = decodeBase64Url(key);
  if (keyBytes.length !== 32) {
    throw new Error(`Invalid Fernet key length: expected 32 bytes, got ${keyBytes.length}`);
  }
  if (tokenBytes.length < 57) {
    throw new Error('Token too short to be a valid Fernet payload');
  }

  const signingKey = keyBytes.subarray(0, 16);
  const encryptionKey = keyBytes.subarray(16);
  const message = tokenBytes.subarray(0, tokenBytes.length - 32);
  const actualMac = tokenBytes.subarray(tokenBytes.length - 32);
  const expectedMac = createHmac('sha256', signingKey).update(message).digest();

  if (!timingSafeEqual(actualMac, expectedMac)) {
    throw new Error('Fernet HMAC verification failed');
  }

  const iv = tokenBytes.subarray(9, 25);
  const ciphertext = tokenBytes.subarray(25, tokenBytes.length - 32);
  const decipher = createDecipheriv('aes-128-cbc', encryptionKey, iv);
  decipher.setAutoPadding(false);
  const paddedPlaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const plaintext = removePkcs7Padding(paddedPlaintext);
  return plaintext.toString('utf8');
}

async function main(): Promise<void> {
  console.log('=== Cursor Docs dynamic model discovery ===');
  const models = await discoverModels();
  console.log(JSON.stringify(models, null, 2));

  console.log('\n=== Upstream model smoke tests ===');
  const smokeReports = [];
  for (const model of models) {
    try {
      const raw = await callUpstream(model.id, 'Reply with exactly OK');
      const parsed = parseEventStream(raw);
      smokeReports.push({
        model: model.id,
        displayName: model.displayName,
        ok: parsed.text.trim() === 'OK' && parsed.finishReason === 'stop',
        answer: parsed.text,
        finishReason: parsed.finishReason,
        reasoningTokenCount: parsed.reasoningTokens.length,
      });
    } catch (error) {
      smokeReports.push({
        model: model.id,
        displayName: model.displayName,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  console.log(JSON.stringify(smokeReports, null, 2));

  console.log('\n=== Reasoning metadata probe ===');
  const reasoningRaw = await callUpstream(
    REASONING_MODEL,
    'Please think step by step and then answer with exactly the number 2.'
  );
  const reasoningParsed = parseEventStream(reasoningRaw);
  const firstToken = reasoningParsed.reasoningTokens[0];
  console.log(
    JSON.stringify(
      {
        model: REASONING_MODEL,
        finishReason: reasoningParsed.finishReason,
        answer: reasoningParsed.text,
        reasoningTokenCount: reasoningParsed.reasoningTokens.length,
        tokenInspection: firstToken ? inspectFernetToken(firstToken) : null,
        usage: reasoningParsed.usage || null,
      },
      null,
      2
    )
  );

  if (!firstToken) {
    console.log('\nNo reasoning token observed from upstream.');
    return;
  }

  if (!OPTIONAL_REASONING_FERNET_KEY) {
    console.log(
      '\nNo CURSORDOCS_REASONING_FERNET_KEY provided. Token structure was inspected only; plaintext decryption was skipped.'
    );
    return;
  }

  console.log('\n=== Fernet decrypt attempt ===');
  try {
    const plaintext = tryDecryptFernet(firstToken, OPTIONAL_REASONING_FERNET_KEY);
    console.log(plaintext);
  } catch (error) {
    console.error(
      '[cursordocs-upstream-probe] decrypt failed:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[cursordocs-upstream-probe] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
