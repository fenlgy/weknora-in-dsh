/**
 * Host half of `dsh-weknora`.
 *
 * Three jobs, all on the Node side of the harness:
 *
 *   1. A settings store under `$DSH_HOME/weknora/config.json` — the panel, the
 *      proxy and the model-facing tools all read the same record, so a user
 *      configures the deployment exactly once.
 *   2. A prefix route on the harness web server: `/weknora/<path>` is forwarded
 *      to the configured WeKnora deployment with the credential added server
 *      side. Browser code therefore stays same-origin and never sees the key in
 *      a cross-origin request; streaming (SSE) replies are passed through
 *      unbuffered so agent answers can be rendered token by token.
 *   3. Four tools registered on `ctx.tools`, so the DSH agent can ground its
 *      answers in the same knowledge base and delegate questions to the agent
 *      configured in WeKnora.
 *
 * Local helper routes (never forwarded):
 *   GET  /weknora/__config   read the effective connection settings
 *   PUT  /weknora/__config   merge and persist settings
 *   POST /weknora/__test     probe the deployment through `/knowledge-bases`
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Prefix route claimed on the harness web server. */
const ROUTE_PATH = '/weknora';
/** Local helper route for the settings store. */
const CONFIG_PATH = '/__config';
/** Local helper route that probes the deployment. */
const TEST_PATH = '/__test';
/** Default request budget for ordinary REST calls. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Default request budget for agent/RAG chat calls (a server-side model runs). */
const DEFAULT_CHAT_TIMEOUT_MS = 300_000;
/** Character budget for one retrieved passage handed to the model. */
const DEFAULT_MAX_CHUNK_CHARS = 1_200;
/** Default number of passages a search returns. */
const DEFAULT_MAX_RESULTS = 8;
/** Tools a deployment can switch off; all are on unless configured otherwise. */
const TOOL_KEYS = ['listKnowledgeBases', 'search', 'readDocument', 'ask'];
/** Environment names that seed the store when the profile has no config row. */
const ENV_KEYS = {
  baseUrl: 'WEKNORA_BASE_URL',
  apiKey: 'WEKNORA_API_KEY',
  token: 'WEKNORA_TOKEN',
  tenantId: 'WEKNORA_TENANT_ID',
  agentId: 'WEKNORA_AGENT_ID',
  knowledgeBaseIds: 'WEKNORA_KNOWLEDGE_BASE_IDS',
  toolPrefix: 'WEKNORA_TOOL_PREFIX',
};

/** Response headers shared by every reply this plugin owns. */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers':
    'content-type, accept, x-weknora-base, x-weknora-key, x-weknora-token, x-weknora-tenant',
  'access-control-expose-headers': 'content-type, content-disposition, content-length',
  'access-control-max-age': '600',
};

//#region settings store

/**
 * Directory that owns the persisted settings file.
 * @returns Absolute directory path.
 */
function dshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  return path.join(os.homedir(), '.dsh');
}

/**
 * Absolute path of the persisted settings file.
 * @returns File path.
 */
export function settingsFile() {
  return path.join(dshHome(), 'weknora', 'config.json');
}

/**
 * Read the persisted settings record; a missing or corrupt file reads as `{}`.
 * @returns A plain record.
 */
export function readStore() {
  try {
    const text = fs.readFileSync(settingsFile(), 'utf8');
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge a patch into the persisted settings file, creating it with owner-only
 * permissions. Writes are rename-atomic so a crash cannot leave half a JSON
 * document behind.
 * @param patch - Fields to set; `undefined` leaves a field untouched, `null`
 *   deletes it.
 * @returns The store after the merge.
 */
export function writeStore(patch) {
  const next = { ...readStore() };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const file = settingsFile();
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  return next;
}

/**
 * Trim a value into a non-empty string.
 * @param value - Candidate.
 * @returns Trimmed text, or undefined.
 */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * First defined value in a precedence list.
 * @param values - Candidates in order.
 * @returns The first non-undefined one.
 */
function first(...values) {
  return values.find((value) => value !== undefined);
}

/**
 * Normalize a user-supplied base URL: `http(s)` only, no trailing slash, and
 * `/api/v1` stripped because routes already carry it.
 * @param value - Raw text.
 * @returns Normalized origin + optional mount prefix, or undefined.
 */
export function normalizeBase(value) {
  let raw = text(value);
  if (raw === undefined) return undefined;
  // A host:port or host/path without a scheme is the most common typo in this
  // form; assume plain HTTP for it instead of rejecting the whole save.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname.toLowerCase().endsWith('/api/v1')) pathname = pathname.slice(0, -'/api/v1'.length);
  return `${parsed.origin}${pathname}`;
}

/**
 * Read the plugin config row into plain defaults.
 * @param config - Raw loader config.
 * @returns Normalized defaults.
 */
export function readDefaults(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const positive = (value, fallback) =>
    Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  const tools = {};
  for (const key of TOOL_KEYS) {
    tools[key] = raw.tools === null || typeof raw.tools !== 'object' ? true : raw.tools[key] !== false;
  }
  return {
    baseUrl: normalizeBase(raw.baseUrl),
    apiKey: text(raw.apiKey),
    token: text(raw.token),
    tenantId: text(raw.tenantId),
    agentId: text(raw.agentId),
    knowledgeBaseIds: Array.isArray(raw.knowledgeBaseIds)
      ? raw.knowledgeBaseIds.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
      : [],
    toolPrefix:
      typeof raw.toolPrefix === 'string' && /^[a-z][a-z0-9_]*$/.test(raw.toolPrefix)
        ? raw.toolPrefix
        : 'weknora',
    maxResults: positive(raw.maxResults, DEFAULT_MAX_RESULTS),
    maxChunkChars: positive(raw.maxChunkChars, DEFAULT_MAX_CHUNK_CHARS),
    requestTimeoutMs: positive(raw.requestTimeoutMs, DEFAULT_TIMEOUT_MS),
    chatTimeoutMs: positive(raw.chatTimeoutMs, DEFAULT_CHAT_TIMEOUT_MS),
    resourceUrls: raw.resourceUrls === 'public' ? 'public' : 'handle',
    tools,
  };
}

/**
 * Compose the effective configuration: persisted panel settings first, then
 * environment seeds, then the profile's static config row.
 * @param config - Raw plugin config row.
 * @returns Effective configuration.
 */
export function effectiveConfig(config) {
  const defaults = readDefaults(config);
  const store = readStore();
  const env = {};
  for (const [field, name] of Object.entries(ENV_KEYS)) env[field] = text(process.env[name]);
  const knowledgeBaseIds = first(
    Array.isArray(store.knowledgeBaseIds) ? store.knowledgeBaseIds.map((id) => text(id)).filter(Boolean) : undefined,
    typeof process.env[ENV_KEYS.knowledgeBaseIds] === 'string'
      ? process.env[ENV_KEYS.knowledgeBaseIds].split(',').map((id) => id.trim()).filter(Boolean)
      : undefined,
    defaults.knowledgeBaseIds,
  );
  return {
    baseUrl: normalizeBase(first(text(store.baseUrl), env.baseUrl, defaults.baseUrl)),
    apiKey: first(text(store.apiKey), env.apiKey, defaults.apiKey),
    token: first(text(store.token), env.token, defaults.token),
    tenantId: first(text(store.tenantId), env.tenantId, defaults.tenantId),
    agentId: first(text(store.agentId), env.agentId, defaults.agentId),
    knowledgeBaseIds: knowledgeBaseIds ?? [],
    toolPrefix: first(toolPrefixOf(store.toolPrefix), defaults.toolPrefix) ?? 'weknora',
    maxResults: positiveOr(store.maxResults, defaults.maxResults),
    maxChunkChars: positiveOr(store.maxChunkChars, defaults.maxChunkChars),
    requestTimeoutMs: positiveOr(store.requestTimeoutMs, defaults.requestTimeoutMs),
    chatTimeoutMs: positiveOr(store.chatTimeoutMs, defaults.chatTimeoutMs),
    resourceUrls: store.resourceUrls === 'public' || (!store.resourceUrls && defaults.resourceUrls === 'public')
      ? 'public'
      : 'handle',
    tools: defaults.tools,
  };
}

/**
 * Validate an optional tool prefix.
 * @param value - Raw text.
 * @returns Normalized prefix, or undefined.
 */
function toolPrefixOf(value) {
  const raw = text(value);
  return raw !== undefined && /^[a-z][a-z0-9_]*$/.test(raw) ? raw : undefined;
}

/**
 * Keep a positive integer override, else the default.
 * @param value - Raw stored value.
 * @param fallback - Default.
 * @returns The chosen number.
 */
function positiveOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Project the effective configuration into what the panel may see: secrets are
 * reduced to presence flags, never echoed back into the page.
 * @param effective - Effective configuration.
 * @returns Public projection.
 */
export function publicConfig(effective) {
  return {
    baseUrl: effective.baseUrl ?? '',
    tenantId: effective.tenantId ?? '',
    agentId: effective.agentId ?? '',
    knowledgeBaseIds: effective.knowledgeBaseIds,
    toolPrefix: effective.toolPrefix,
    maxResults: effective.maxResults,
    maxChunkChars: effective.maxChunkChars,
    requestTimeoutMs: effective.requestTimeoutMs,
    chatTimeoutMs: effective.chatTimeoutMs,
    resourceUrls: effective.resourceUrls,
    hasApiKey: effective.apiKey !== undefined,
    hasToken: effective.token !== undefined,
    configured: effective.baseUrl !== undefined,
  };
}

//#endregion

//#region http helpers

/**
 * Write one JSON reply.
 * @param res - Response to own.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, {
    ...CORS_HEADERS,
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
  });
  res.end(body);
}

/**
 * Collect a request body into one buffer.
 * @param req - Incoming request.
 * @returns The full body.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Normalize one inbound header value into trimmed text.
 * @param value - Raw node header.
 * @returns Trimmed text, or undefined.
 */
function headerText(value) {
  const single = Array.isArray(value) ? value[0] : value;
  if (typeof single !== 'string') return undefined;
  const trimmed = single.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Render an internal error envelope into a message the panel can show.
 * @param payload - Parsed JSON body.
 * @param status - HTTP status.
 * @returns Message text, or undefined when the body carries none.
 */
function upstreamMessage(payload, status) {
  if (payload !== null && typeof payload === 'object') {
    const nested = payload.error;
    if (typeof nested === 'string' && nested !== '') return nested;
    if (nested !== null && typeof nested === 'object' && typeof nested.message === 'string') {
      return nested.message;
    }
    if (typeof payload.message === 'string' && payload.message !== '') return payload.message;
  }
  if (typeof payload === 'string' && payload.trim() !== '') {
    const collapsed = payload.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return collapsed.slice(0, 300);
  }
  return status >= 500 ? `WeKnora 返回 HTTP ${status}` : undefined;
}

/**
 * Attach the credential headers this configuration asks for.
 * @param headers - Mutable header record.
 * @param config - Effective configuration.
 */
function addCredentialHeaders(headers, config) {
  if (config.apiKey !== undefined) headers['x-api-key'] = config.apiKey;
  if (config.token !== undefined) headers.authorization = `Bearer ${config.token}`;
  if (config.tenantId !== undefined) {
    if (!/^\d+$/.test(config.tenantId) || /^0+$/.test(config.tenantId)) {
      throw Object.assign(new Error(`租户 ID 必须是数字空间 ID，当前是「${config.tenantId}」`), {
        code: 'weknora-tenant-invalid',
        status: 400,
      });
    }
    headers['x-tenant-id'] = config.tenantId;
  }
}

/**
 * Absolute upstream URL for one WeKnora path.
 * @param config - Effective configuration.
 * @param requestPath - Path beginning with `/api/v1` (or empty).
 * @param search - Query string including the leading `?`, when present.
 * @returns Absolute URL string.
 */
function upstreamUrl(config, requestPath, search = '') {
  if (config.baseUrl === undefined) {
    throw Object.assign(new Error('未配置 WeKnora 服务地址：请在「知识库 → 设置」中填写'), {
      code: 'weknora-base-missing',
      status: 400,
    });
  }
  const suffix = requestPath.replace(/^\/+/, '');
  const url = new URL(`${suffix}${search}`, `${config.baseUrl}/`);
  if (config.resourceUrls === 'public') url.searchParams.set('resource_urls', 'public');
  return url;
}

/**
 * Call one WeKnora JSON endpoint.
 * @param config - Effective configuration.
 * @param requestPath - Path beginning with `/api/v1`.
 * @param options - Method, query, body, signal, timeout override.
 * @returns Parsed JSON payload.
 */
export async function requestJson(config, requestPath, options = {}) {
  const headers = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  addCredentialHeaders(headers, config);
  const url = upstreamUrl(config, requestPath);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const signal = fuseSignal(options.signal, options.timeoutMs ?? config.requestTimeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    });
  } catch (error) {
    throw transportError(error, url);
  }
  const body = await response.text();
  let payload;
  try {
    payload = body === '' ? null : JSON.parse(body);
  } catch {
    payload = body;
  }
  if (!response.ok) {
    const message = upstreamMessage(payload, response.status) ?? `WeKnora 返回 HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status, payload });
  }
  return payload;
}

/**
 * Combine a caller signal with a deadline.
 * @param signal - Caller cancellation (optional).
 * @param timeoutMs - Deadline in milliseconds.
 * @returns A fused signal.
 */
function fuseSignal(signal, timeoutMs) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
}

/**
 * Turn a fetch rejection into a message naming the target.
 * @param error - Thrown value.
 * @param url - Upstream URL.
 * @returns An Error with a `code`.
 */
function transportError(error, url) {
  const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
  return Object.assign(
    new Error(
      aborted
        ? `WeKnora 请求超时：${url.origin}${url.pathname}`
        : `无法连接 WeKnora（${url.origin}）：${error instanceof Error ? error.message : String(error)}`,
    ),
    { code: aborted ? 'weknora-timeout' : 'weknora-unreachable' },
  );
}

/**
 * Parse an SSE body and return the collected chat result.
 * @param response - Upstream fetch response.
 * @param onEvent - Optional per-event callback.
 * @returns `{text, references, sessionId, error, toolCalls}`.
 */
async function collectStream(response, onEvent) {
  const result = { text: '', references: [], sessionId: '', error: undefined, toolCalls: 0 };
  if (response.body === null) return result;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (block) => {
    let event = 'message';
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (payload === null || typeof payload !== 'object') return;
    onEvent?.(event, payload);
    const type = payload.response_type;
    if (type === 'answer' && typeof payload.content === 'string') result.text += payload.content;
    if (type === 'references') {
      const references = payload.knowledge_references ?? payload.data?.knowledge_references;
      if (Array.isArray(references)) result.references = references;
    }
    if (type === 'tool_call') result.toolCalls += 1;
    if (typeof payload.session_id === 'string' && payload.session_id !== '') result.sessionId = payload.session_id;
    if (type === 'error') result.error = typeof payload.content === 'string' ? payload.content : 'WeKnora 返回错误';
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== '') consume(buffer);
  return result;
}

/**
 * Run one streaming chat turn.
 * @param config - Effective configuration.
 * @param requestPath - `/api/v1/agent-chat/<id>` or `/api/v1/knowledge-chat/<id>`.
 * @param body - JSON request body.
 * @param options - Signal and per-event callback.
 * @returns Collected chat result.
 */
async function chatOnce(config, requestPath, body, options = {}) {
  const headers = { accept: 'text/event-stream', 'content-type': 'application/json' };
  addCredentialHeaders(headers, config);
  const url = upstreamUrl(config, requestPath);
  const signal = fuseSignal(options.signal, config.chatTimeoutMs);
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (error) {
    throw transportError(error, url);
  }
  if (!response.ok) {
    const raw = await response.text();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
    throw Object.assign(
      new Error(upstreamMessage(payload, response.status) ?? `WeKnora 返回 HTTP ${response.status}`),
      { status: response.status, payload },
    );
  }
  return collectStream(response, options.onEvent);
}

//#endregion

//#region panel-facing routes

/**
 * Serve the settings helper routes.
 * @param req - Incoming request.
 * @param res - Response to own.
 * @param sub - Path after the `/weknora` prefix.
 * @param config - Plugin config row.
 * @returns True when the request was handled locally.
 */
async function handleLocal(req, res, sub, config) {
  if (sub === CONFIG_PATH) {
    if (req.method === 'GET') {
      sendJson(res, 200, { config: publicConfig(effectiveConfig(config)) });
      return true;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req)).toString('utf8'));
      } catch {
        sendJson(res, 400, { error: '请求体必须是 JSON' });
        return true;
      }
      const patch = sanitizePatch(body);
      if (patch.error !== undefined) {
        sendJson(res, 400, { error: patch.error });
        return true;
      }
      writeStore(patch.values);
      sendJson(res, 200, { config: publicConfig(effectiveConfig(config)) });
      return true;
    }
    sendJson(res, 405, { error: '只支持 GET / PUT' });
    return true;
  }
  if (sub === TEST_PATH) {
    const effective = effectiveConfig(config);
    if (effective.baseUrl === undefined) {
      sendJson(res, 400, { ok: false, error: '尚未填写服务地址' });
      return true;
    }
    try {
      const payload = await requestJson(effective, '/api/v1/knowledge-bases', {
        signal: AbortSignal.timeout(15_000),
        timeoutMs: 15_000,
      });
      const count = Array.isArray(payload?.data) ? payload.data.length : 0;
      sendJson(res, 200, { ok: true, knowledgeBases: count });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        status: error?.status,
      });
    }
    return true;
  }
  return false;
}

/**
 * Validate and normalize a settings patch from the panel.
 * @param body - Parsed JSON body.
 * @returns Either `{values}` or `{error}`.
 */
function sanitizePatch(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '设置必须是 JSON 对象' };
  }
  const values = {};
  if (body.baseUrl !== undefined) {
    if (typeof body.baseUrl !== 'string') return { error: 'baseUrl 必须是字符串' };
    const normalized = body.baseUrl.trim() === '' ? '' : normalizeBase(body.baseUrl);
    if (body.baseUrl.trim() !== '' && normalized === undefined) {
      return { error: 'baseUrl 必须是 http(s) 地址' };
    }
    values.baseUrl = normalized ?? '';
  }
  if (body.tenantId !== undefined) {
    if (typeof body.tenantId !== 'string') return { error: 'tenantId 必须是字符串' };
    const tenant = body.tenantId.trim();
    if (tenant !== '' && (!/^\d+$/.test(tenant) || /^0+$/.test(tenant))) {
      return { error: 'tenantId 必须是数字空间 ID（例如 7）；空间级 Key 请留空' };
    }
    values.tenantId = tenant;
  }
  if (body.agentId !== undefined) {
    if (typeof body.agentId !== 'string') return { error: 'agentId 必须是字符串' };
    values.agentId = body.agentId.trim();
  }
  for (const field of ['apiKey', 'token']) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== 'string') return { error: `${field} 必须是字符串` };
      const value = body[field].trim();
      // An empty secret field means "keep the stored one"; clearing is an
      // explicit flag so a form that never received the secret cannot wipe it.
      if (value !== '') values[field] = value;
    }
  }
  if (body.clearApiKey === true) values.apiKey = null;
  if (body.clearToken === true) values.token = null;
  if (body.knowledgeBaseIds !== undefined) {
    if (!Array.isArray(body.knowledgeBaseIds)) return { error: 'knowledgeBaseIds 必须是数组' };
    values.knowledgeBaseIds = body.knowledgeBaseIds
      .filter((id) => typeof id === 'string' && id.trim() !== '')
      .map((id) => id.trim());
  }
  if (body.toolPrefix !== undefined) {
    if (typeof body.toolPrefix !== 'string') return { error: 'toolPrefix 必须是字符串' };
    const prefix = body.toolPrefix.trim();
    if (prefix !== '' && !/^[a-z][a-z0-9_]*$/.test(prefix)) {
      return { error: 'toolPrefix 只能由小写字母、数字与下划线组成，且以字母开头' };
    }
    if (prefix !== '') values.toolPrefix = prefix;
  }
  for (const field of ['maxResults', 'maxChunkChars', 'requestTimeoutMs', 'chatTimeoutMs']) {
    if (body[field] !== undefined) {
      const value = Number(body[field]);
      if (!Number.isFinite(value) || value <= 0) return { error: `${field} 必须是正数` };
      values[field] = Math.floor(value);
    }
  }
  if (body.resourceUrls !== undefined) {
    if (body.resourceUrls !== 'handle' && body.resourceUrls !== 'public') {
      return { error: 'resourceUrls 只能是 handle 或 public' };
    }
    values.resourceUrls = body.resourceUrls;
  }
  return { values };
}

//#endregion

//#region proxy

/**
 * Forward one proxied request to WeKnora and relay its reply, streaming SSE
 * replies chunk by chunk.
 * @param req - Incoming harness-side request.
 * @param res - Response to own.
 * @param config - Plugin config row.
 */
async function handleProxy(req, res, config) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  const effective = effectiveConfig(config);
  const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
  const rest = requestUrl.pathname.slice(ROUTE_PATH.length) || '/';
  const perRequest = {};
  const headerBase = headerText(req.headers['x-weknora-base']);
  if (headerBase !== undefined) perRequest.baseUrl = normalizeBase(headerBase);
  const headerKey = headerText(req.headers['x-weknora-key']);
  if (headerKey !== undefined) perRequest.apiKey = headerKey;
  const headerToken = headerText(req.headers['x-weknora-token']);
  if (headerToken !== undefined) perRequest.token = headerToken;
  const headerTenant = headerText(req.headers['x-weknora-tenant']);
  if (headerTenant !== undefined) perRequest.tenantId = headerTenant;
  const merged = { ...effective, ...perRequest };
  let target;
  try {
    target = upstreamUrl(merged, rest, requestUrl.search);
  } catch (error) {
    sendJson(res, 400, { error: error.code ?? 'weknora-base-missing', message: error.message });
    return;
  }

  const headers = { accept: req.headers.accept ?? 'application/json' };
  try {
    addCredentialHeaders(headers, merged);
  } catch (error) {
    sendJson(res, 400, { error: error.code ?? 'weknora-tenant-invalid', message: error.message });
    return;
  }
  if (typeof req.headers['content-type'] === 'string') headers['content-type'] = req.headers['content-type'];
  if (typeof req.headers['content-disposition'] === 'string') {
    headers['content-disposition'] = req.headers['content-disposition'];
  }

  const isChat = /-chat\//.test(requestUrl.pathname) || /agent-chat|knowledge-chat/.test(requestUrl.pathname);
  const timeoutMs = isChat ? merged.chatTimeoutMs : merged.requestTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const body = hasBody ? await readBody(req) : undefined;
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: body !== undefined && body.byteLength > 0 ? body : undefined,
      signal: controller.signal,
      redirect: 'follow',
    });
    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    const disposition = upstream.headers.get('content-disposition');
    const contentEncoding = upstream.headers.get('content-encoding');
    const streaming = /text\/event-stream/i.test(contentType) || isChat;
    if (streaming && upstream.body !== null) {
      if (!res.headersSent) {
        res.writeHead(upstream.status, {
          ...CORS_HEADERS,
          'cache-control': 'no-cache, no-transform',
          'content-type': contentType,
          connection: 'keep-alive',
          ...(contentEncoding === null ? {} : { 'content-encoding': contentEncoding }),
        });
      }
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
      return;
    }
    const payload = Buffer.from(await upstream.arrayBuffer());
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(upstream.status, {
      ...CORS_HEADERS,
      'content-type': contentType,
      'content-length': String(payload.byteLength),
      ...(disposition === null ? {} : { 'content-disposition': disposition }),
      ...(contentEncoding === null ? {} : { 'content-encoding': contentEncoding }),
    });
    res.end(payload);
  } catch (error) {
    if (res.headersSent) {
      // A stream already started: end it rather than injecting JSON into SSE.
      res.end();
      return;
    }
    const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    sendJson(res, aborted ? 504 : 502, {
      error: aborted ? 'weknora-timeout' : 'weknora-unreachable',
      message: aborted
        ? `WeKnora 请求超时（${timeoutMs} ms）：${target}`
        : `无法连接 WeKnora（${target}）：${error instanceof Error ? error.message : String(error)}`,
      target: String(target),
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mount the prefix route; the web carrier is optional so headless profiles
 * still load the tools half.
 * @param ctx - Cordis context.
 * @param config - Plugin config row.
 */
export function apply(ctx, config) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PATH,
          handler: async (req, res) => {
            const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
            const sub = requestUrl.pathname.slice(ROUTE_PATH.length) || '/';
            if (sub === CONFIG_PATH || sub === TEST_PATH) {
              await handleLocal(req, res, sub, config);
              return;
            }
            await handleProxy(req, res, config);
          },
        }),
      'weknora: proxy route',
    );
  });
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      const definitions = createTools(() => effectiveConfig(config));
      const disposers = definitions.map((definition) => toolCtx.tools.register(definition));
      toolCtx.logger?.info?.(`weknora: 已注册工具 ${definitions.map((tool) => tool.name).join(', ')}`);
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'weknora: tools');
  });
}

//#endregion

//#region tools

/**
 * Clip text to a character budget on a code-point boundary.
 * @param value - Text.
 * @param limit - Maximum characters.
 * @returns `{text, truncated}`.
 */
export function clip(value, limit) {
  const characters = [...value];
  if (characters.length <= limit) return { text: value, truncated: false };
  return { text: `${characters.slice(0, limit).join('')}…`, truncated: true };
}

/**
 * Read a string argument without trusting its shape.
 * @param args - Model arguments.
 * @param field - Property name.
 * @returns Trimmed text, or undefined.
 */
function argString(args, field) {
  const value = args?.[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Read a string-array argument without trusting its shape.
 * @param args - Model arguments.
 * @param field - Property name.
 * @returns Array of trimmed strings.
 */
function argStringArray(args, field) {
  const value = args?.[field];
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim());
}

/**
 * Read a bounded positive integer argument.
 * @param args - Model arguments.
 * @param field - Property name.
 * @param fallback - Value to use when absent or invalid.
 * @param max - Upper bound.
 * @returns The chosen integer.
 */
function argInt(args, field, fallback, max) {
  const value = args?.[field];
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

/**
 * Human label for a document row.
 * @param row - Raw WeKnora row.
 * @returns A non-empty label.
 */
function documentLabel(row) {
  const title = typeof row?.knowledge_title === 'string' ? row.knowledge_title.trim() : '';
  if (title !== '') return title;
  const filename = typeof row?.knowledge_filename === 'string' ? row.knowledge_filename.trim() : '';
  if (filename !== '') return filename;
  return typeof row?.knowledge_id === 'string' && row.knowledge_id !== '' ? row.knowledge_id : '(未命名)';
}

/**
 * List every knowledge base the credential can see.
 * @param config - Effective configuration.
 * @param signal - Cancellation.
 * @returns `{count, knowledge_bases}`.
 */
async function listKnowledgeBases(config, signal) {
  const payload = await requestJson(config, '/api/v1/knowledge-bases', { signal });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return {
    count: rows.length,
    knowledge_bases: rows.map((row) => ({
      id: typeof row?.id === 'string' ? row.id : '',
      name: typeof row?.name === 'string' ? row.name : '',
      description: typeof row?.description === 'string' ? row.description : '',
      type: typeof row?.type === 'string' ? row.type : 'document',
      count: Number.isFinite(row?.knowledge_count)
        ? row.knowledge_count
        : Number.isFinite(row?.file_count)
          ? row.file_count
          : 0,
    })),
  };
}

/**
 * Resolve the knowledge-base scope of a call: explicit ids, then the configured
 * defaults, then every visible knowledge base.
 * @param config - Effective configuration.
 * @param requested - Ids the caller named.
 * @param signal - Cancellation.
 * @returns Ids to search.
 */
async function resolveScope(config, requested, signal) {
  if (requested.length > 0) return requested;
  if (config.knowledgeBaseIds.length > 0) return config.knowledgeBaseIds;
  const listed = await listKnowledgeBases(config, signal);
  return listed.knowledge_bases.map((kb) => kb.id).filter((id) => id !== '');
}

/**
 * Assemble tool definitions against a live configuration source.
 * @param getConfig - Reads the current effective configuration.
 * @returns Tool definitions ready for `ctx.tools.register`.
 */
export function createTools(getConfig) {
  const definitions = [];
  const config = getConfig();
  const name = (suffix) => `${config.toolPrefix}_${suffix}`;
  const text = (value) => [{ type: 'text', text: value }];

  if (config.tools.listKnowledgeBases) {
    definitions.push({
      name: name('list_knowledge_bases'),
      description:
        'List the WeKnora knowledge bases this deployment can read, with their ids, names and document counts. '
        + `Use it to report what is available or to narrow ${name('search')}.`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['count', 'knowledge_bases'],
          properties: {
            count: { type: 'integer' },
            knowledge_bases: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'name', 'description', 'type', 'count'],
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  type: { type: 'string' },
                  count: { type: 'integer' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.count === 0) return text('没有可见的 WeKnora 知识库。');
          return text(
            `${value.count} 个知识库：\n`
            + value.knowledge_bases.map((kb) => `- ${kb.name}（id: ${kb.id}，${kb.count} 篇）${kb.description ? ` — ${kb.description}` : ''}`).join('\n'),
          );
        },
      },
      async execute(args, exec) {
        const live = getConfig();
        return listKnowledgeBases(live, exec?.signal);
      },
    });
  }

  if (config.tools.search) {
    definitions.push({
      name: name('search'),
      description:
        'Search the configured WeKnora knowledge bases and return matching passages verbatim (hybrid vector + keyword retrieval). '
        + 'Use it to ground answers in the organization\'s own documents. Every hit carries a knowledge_id that '
        + `${name('read_document')} accepts.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Natural-language question or keywords.' },
          knowledge_base_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Restrict the search to these knowledge base ids.',
          },
          max_results: { type: 'integer', description: 'Maximum passages to return.' },
        },
      },
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['query', 'knowledge_base_ids', 'count', 'results'],
          properties: {
            query: { type: 'string' },
            knowledge_base_ids: { type: 'array', items: { type: 'string' } },
            count: { type: 'integer' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['rank', 'chunk_id', 'knowledge_id', 'document', 'content', 'truncated'],
                properties: {
                  rank: { type: 'integer' },
                  chunk_id: { type: 'string' },
                  knowledge_id: { type: 'string' },
                  document: { type: 'string' },
                  content: { type: 'string' },
                  truncated: { type: 'boolean' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.count === 0) {
            return text(`WeKnora 没有检索到「${value.query}」相关的内容（范围：${value.knowledge_base_ids.join(', ') || '全部'}）。`);
          }
          return text(
            `「${value.query}」命中 ${value.count} 条：\n\n`
            + value.results.map(
              (hit) => `[${hit.rank}] ${hit.document} · knowledge_id: ${hit.knowledge_id}\n${hit.content}${hit.truncated ? '\n（内容已截断）' : ''}`,
            ).join('\n\n'),
          );
        },
      },
      async execute(args, exec) {
        const live = getConfig();
        const query = argString(args, 'query');
        if (query === undefined) throw new Error(`${name('search')}: query 不能为空`);
        const knowledgeBaseIds = await resolveScope(live, argStringArray(args, 'knowledge_base_ids'), exec?.signal);
        if (knowledgeBaseIds.length === 0) throw new Error('当前凭据看不到任何知识库，请检查 API Key 权限。');
        const limit = Math.min(
          argInt(args, 'max_results', live.maxResults, live.maxResults),
          50,
        );
        const payload = await requestJson(live, '/api/v1/knowledge-search', {
          method: 'POST',
          body: { query, knowledge_base_ids: knowledgeBaseIds, match_count: limit },
          signal: exec?.signal,
        });
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        return {
          query,
          knowledge_base_ids: knowledgeBaseIds,
          count: rows.length,
          results: rows.slice(0, limit).map((row, index) => {
            const clipped = clip(typeof row?.content === 'string' ? row.content : '', live.maxChunkChars);
            return {
              rank: index + 1,
              chunk_id: typeof row?.id === 'string' ? row.id : '',
              knowledge_id: typeof row?.knowledge_id === 'string' ? row.knowledge_id : '',
              document: documentLabel(row),
              content: clipped.text,
              truncated: clipped.truncated,
            };
          }),
        };
      },
    });
  }

  if (config.tools.readDocument) {
    definitions.push({
      name: name('read_document'),
      description:
        'Read one WeKnora document\'s stored passages in order, reassembled into text. '
        + `Use it after ${name('search')} when a passage is not enough context; page through long documents.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['knowledge_id'],
        properties: {
          knowledge_id: { type: 'string', description: 'Document id from a search hit.' },
          page: { type: 'integer', description: 'Passage page, starting at 1.' },
          page_size: { type: 'integer', description: 'Passages per page (max 100).' },
        },
      },
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['knowledge_id', 'title', 'page', 'page_size', 'total_chunks', 'returned_chunks', 'has_more', 'content'],
          properties: {
            knowledge_id: { type: 'string' },
            title: { type: 'string' },
            page: { type: 'integer' },
            page_size: { type: 'integer' },
            total_chunks: { type: 'integer' },
            returned_chunks: { type: 'integer' },
            has_more: { type: 'boolean' },
            content: { type: 'string' },
          },
        },
        render: (_args, value) => text(
          `${value.title || value.knowledge_id}（第 ${value.page} 页，共 ${value.total_chunks} 个分块，本页 ${value.returned_chunks}）\n\n${value.content}`
          + (value.has_more ? '\n\n（还有更多分块，翻页继续）' : ''),
        ),
      },
      async execute(args, exec) {
        const live = getConfig();
        const knowledgeId = argString(args, 'knowledge_id');
        if (knowledgeId === undefined) throw new Error(`${name('read_document')}: knowledge_id 不能为空`);
        const page = argInt(args, 'page', 1, 10_000);
        const pageSize = argInt(args, 'page_size', 20, 100);
        const [chunks, detail] = await Promise.all([
          requestJson(live, `/api/v1/chunks/${encodeURIComponent(knowledgeId)}`, {
            query: { page, page_size: pageSize },
            signal: exec?.signal,
          }),
          requestJson(live, `/api/v1/knowledge/${encodeURIComponent(knowledgeId)}`, { signal: exec?.signal }).catch(() => null),
        ]);
        const rows = Array.isArray(chunks?.data) ? chunks.data : [];
        const total = Number.isFinite(chunks?.total) ? chunks.total : rows.length;
        const content = rows
          .map((chunk) => (typeof chunk?.content === 'string' ? chunk.content : ''))
          .join('\n\n');
        return {
          knowledge_id: knowledgeId,
          title: typeof detail?.data?.title === 'string' ? detail.data.title : '',
          page,
          page_size: pageSize,
          total_chunks: total,
          returned_chunks: rows.length,
          has_more: page * pageSize < total,
          content,
        };
      },
    });
  }

  if (config.tools.ask) {
    definitions.push({
      name: name('ask'),
      description:
        'Ask WeKnora a question and return the answer produced by the agent configured in WeKnora, with its citations. '
        + 'Use it for broad questions that span several documents, or when the user wants the WeKnora-side agent\'s judgement. '
        + 'Unlike search, a model runs on the server, so it is slower and returns a conclusion rather than raw evidence.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'The question to ask.' },
          agent_id: { type: 'string', description: 'WeKnora agent id; defaults to the configured agent.' },
          knowledge_base_ids: { type: 'array', items: { type: 'string' }, description: 'Optional knowledge base scope.' },
          session_id: { type: 'string', description: 'Continue an existing WeKnora session instead of starting a new one.' },
        },
      },
      timeoutMs: 300_000,
      isConcurrencySafe: () => false,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['answer', 'session_id', 'agent_id', 'references', 'tool_calls'],
          properties: {
            answer: { type: 'string' },
            session_id: { type: 'string' },
            agent_id: { type: 'string' },
            tool_calls: { type: 'integer' },
            references: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['knowledge_id', 'title', 'content'],
                properties: {
                  knowledge_id: { type: 'string' },
                  title: { type: 'string' },
                  content: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const citations = value.references.length === 0
            ? ''
            : `\n\n引用来源：\n${value.references.map((reference, index) => `${index + 1}. ${reference.title || reference.knowledge_id}`).join('\n')}`;
          return text(`${value.answer}${citations}`);
        },
      },
      async execute(args, exec) {
        const live = getConfig();
        const query = argString(args, 'query');
        if (query === undefined) throw new Error(`${name('ask')}: query 不能为空`);
        const agentId = argString(args, 'agent_id') ?? live.agentId;
        let sessionId = argString(args, 'session_id');
        if (sessionId === undefined) {
          const created = await requestJson(live, '/api/v1/sessions', {
            method: 'POST',
            body: { title: query.slice(0, 40) },
            signal: exec?.signal,
          });
          sessionId = typeof created?.data?.id === 'string' ? created.data.id : '';
          if (sessionId === '') throw new Error('WeKnora 创建会话失败：响应中没有 session id');
        }
        const body = {
          query,
          agent_enabled: true,
          ...(agentId === undefined ? {} : { agent_id: agentId }),
          ...(argStringArray(args, 'knowledge_base_ids').length === 0
            ? {}
            : { knowledge_base_ids: argStringArray(args, 'knowledge_base_ids') }),
        };
        const result = await chatOnce(
          live,
          `/api/v1/agent-chat/${encodeURIComponent(sessionId)}`,
          body,
          { signal: exec?.signal },
        );
        if (result.error !== undefined && result.text === '') throw new Error(`WeKnora 智能体返回错误：${result.error}`);
        const references = (Array.isArray(result.references) ? result.references : []).slice(0, 20).map((reference) => {
          const clipped = clip(typeof reference?.content === 'string' ? reference.content : '', live.maxChunkChars);
          return {
            knowledge_id: typeof reference?.knowledge_id === 'string' ? reference.knowledge_id : '',
            title: typeof reference?.knowledge_title === 'string'
              ? reference.knowledge_title
              : typeof reference?.knowledge_filename === 'string'
                ? reference.knowledge_filename
                : '',
            content: clipped.text,
          };
        });
        return {
          answer: result.text,
          session_id: result.sessionId === '' ? sessionId : result.sessionId,
          agent_id: agentId ?? '',
          tool_calls: result.toolCalls,
          references,
        };
      },
    });
  }

  return definitions;
}

//#endregion

/** Test seam: pure helpers the offline tests drive directly. */
export const __internals = {
  normalizeBase,
  readDefaults,
  effectiveConfig,
  publicConfig,
  sanitizePatch,
  readStore,
  writeStore,
  settingsFile,
  clip,
};
