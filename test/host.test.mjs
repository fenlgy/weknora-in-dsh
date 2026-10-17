/**
 * Integration test for the host half of `dsh-weknora`.
 *
 * Boots a fake WeKnora deployment, mounts the plugin on throwaway harness
 * contexts (webServer + tools), and drives the real routes/tools over HTTP.
 *
 * Run: node --test test/host.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { once } from 'node:events';
import test from 'node:test';

const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weknora-test-'));
process.env.DSH_HOME = DSH_HOME;
// Ensure no ambient deployment leaks into the test's settings store.
for (const name of [
  'WEKNORA_BASE_URL',
  'WEKNORA_API_KEY',
  'WEKNORA_TOKEN',
  'WEKNORA_TENANT_ID',
  'WEKNORA_AGENT_ID',
  'WEKNORA_KNOWLEDGE_BASE_IDS',
]) {
  delete process.env[name];
}

const plugin = await import('../index.js');
const { apply, __internals } = plugin;

/** Requests the fake WeKnora deployment saw. */
const seen = [];

/**
 * Start an HTTP server on an ephemeral loopback port.
 * @param handler - Request listener.
 * @returns `{server, origin}`.
 */
async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/**
 * Fake WeKnora deployment covering the routes the plugin uses.
 * @param req - Request.
 * @param res - Response.
 */
const upstream = await listen(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  seen.push({
    method: req.method,
    url: req.url,
    apiKey: req.headers['x-api-key'],
    bearer: req.headers.authorization,
    tenant: req.headers['x-tenant-id'],
    contentType: req.headers['content-type'],
    body,
  });
  const pathname = new URL(req.url, 'http://upstream').pathname;
  if (pathname === '/api/v1/agent-chat/session-1') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event:message\ndata:{"response_type":"answer","content":"退款需在"}\n\n');
    setTimeout(() => {
      res.write(
        'event:message\ndata:'
        + JSON.stringify({
          response_type: 'references',
          knowledge_references: [{ knowledge_id: 'doc-1', knowledge_title: '退款流程', content: '签收后 7 天内' }],
        })
        + '\n\n',
      );
      res.write('event:message\ndata:{"response_type":"complete","done":true}\n\n');
      res.end();
    }, 10);
    return;
  }
  if (pathname === '/api/v1/sessions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { id: 'session-1' } }));
    return;
  }
  if (pathname === '/api/v1/chunks/doc-1') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: [{ content: '第一段' }, { content: '第二段' }], total: 2 }));
    return;
  }
  if (pathname === '/api/v1/knowledge/doc-1') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { id: 'doc-1', title: '退款流程' } }));
    return;
  }
  if (pathname === '/api/v1/gzip-check') {
    const zipped = gzipSync(Buffer.from(JSON.stringify({ success: true, data: { compressed: true } })));
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': String(zipped.length),
    });
    res.end(zipped);
    return;
  }
  if (pathname === '/api/v1/knowledge-search') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        data: [{ id: 'chunk-1', knowledge_id: 'doc-1', knowledge_title: '退款流程', content: '签收后 7 天内可退。' }],
      }),
    );
    return;
  }
  if (pathname === '/api/v1/knowledge-bases') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        data: [{ id: 'kb-1', name: '产品文档', description: '售后', knowledge_count: 3 }],
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true, data: [] }));
});

/**
 * Mount the plugin on a stand-in Cordis context.
 * @param config - Plugin config row.
 * @returns `{route, tools}`.
 */
function mount(config) {
  const routes = [];
  const tools = [];
  const webCtx = {
    effect: (factory) => factory(),
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
    },
  };
  const toolCtx = {
    effect: (factory) => factory(),
    logger: { info: () => {} },
    tools: {
      register: (definition) => {
        tools.push(definition);
        return () => {};
      },
    },
  };
  apply(
    {
      inject: (_deps, callback) => callback(depsIsWeb(_deps) ? webCtx : toolCtx),
    },
    config,
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, '/weknora');
  return { route: routes[0], tools };
}

/**
 * Whether the requested dependencies include the web carrier.
 * @param deps - Injected service names.
 * @returns True for the webServer injection.
 */
function depsIsWeb(deps) {
  return deps.includes('webServer');
}

/**
 * Serve one harness request against the mounted prefix route.
 * @param route - Mounted route.
 * @param url - Harness URL.
 * @param init - fetch init.
 * @returns The response.
 */
async function callRoute(route, url, init) {
  const target = new URL(url, `http://127.0.0.1:${harnessPort}/`);
  const response = await fetch(target, init);
  return response;
}

/** Harness origin the route handler runs behind. */
let harnessPort = 0;
const harness = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  if (pathname === '/weknora' || pathname.startsWith('/weknora/')) {
    void routeRef.handler(req, res);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
harness.listen(0, '127.0.0.1');
await once(harness, 'listening');
harnessPort = harness.address().port;
/** Latest mounted route; tests remount and the server dispatches to it. */
let routeRef = mount(undefined).route;

test('settings round-trip through the local config route', async () => {
  const response = await callRoute(routeRef, '/weknora/__config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: `${upstream.origin}/api/v1`,
      apiKey: 'sk-test',
      tenantId: '7',
      agentId: 'builtin-smart-reasoning',
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.config.baseUrl, upstream.origin);
  assert.equal(body.config.hasApiKey, true);
  assert.equal(body.config.agentId, 'builtin-smart-reasoning');
  assert.equal(body.config.apiKey, undefined, 'the API key must not be echoed into the page');

  const read = await (await callRoute(routeRef, '/weknora/__config')).json();
  assert.equal(read.config.baseUrl, upstream.origin);
  assert.equal(read.config.hasApiKey, true);

  const stored = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'weknora', 'config.json'), 'utf8'));
  assert.equal(stored.apiKey, 'sk-test');
  assert.equal(fs.statSync(path.join(DSH_HOME, 'weknora', 'config.json')).mode & 0o777, 0o600);
});

test('rejects invalid settings instead of storing them', async () => {
  for (const patch of [
    { baseUrl: 'ftp://example.com' },
    { tenantId: 'weknora-space' },
    { toolPrefix: 'WeKnora' },
  ]) {
    const response = await callRoute(routeRef, '/weknora/__config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    assert.equal(response.status, 400, JSON.stringify(patch));
  }
});

test('proxies REST calls with the stored credential', async () => {
  seen.length = 0;
  const response = await callRoute(routeRef, '/weknora/api/v1/knowledge-bases');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data[0].name, '产品文档');
  const forwarded = seen.at(-1);
  assert.equal(forwarded.url, '/api/v1/knowledge-bases');
  assert.equal(forwarded.apiKey, 'sk-test');
  assert.equal(forwarded.tenant, '7');
});

test('forwards multipart uploads byte for byte', async () => {
  seen.length = 0;
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'a.txt');
  const response = await callRoute(routeRef, '/weknora/api/v1/knowledge-bases/kb-1/knowledge/file', {
    method: 'POST',
    body: form,
  });
  assert.equal(response.status, 200);
  const forwarded = seen.at(-1);
  assert.match(forwarded.contentType, /^multipart\/form-data; boundary=/);
  assert.match(forwarded.body.toString('utf8'), /name="file"; filename="a\.txt"/);
});

test('streams SSE replies instead of buffering them', async () => {
  const response = await callRoute(routeRef, '/weknora/api/v1/agent-chat/session-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ query: '退款多久' }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /"response_type":"answer"/);
  assert.match(text, /"response_type":"complete"/);
});

test('never relays a stale content-encoding header', async () => {
  const response = await callRoute(routeRef, '/weknora/api/v1/gzip-check');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), null);
  const body = await response.json();
  assert.equal(body.data.compressed, true);
});

test('reports an unconfigured deployment with an actionable error', async () => {
  __internals.writeStore({ baseUrl: '', apiKey: null, tenantId: null });
  const response = await callRoute(routeRef, '/weknora/api/v1/knowledge-bases');
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'weknora-base-missing');
  // Restore for the tool tests below.
  __internals.writeStore({ baseUrl: upstream.origin, apiKey: 'sk-test', tenantId: '7' });
});

test('registers the four agent-facing tools', () => {
  const remounted = mount(undefined);
  const names = remounted.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'weknora_list_knowledge_bases',
    'weknora_search',
    'weknora_read_document',
    'weknora_ask',
  ]);
  for (const tool of remounted.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.execute, 'function');
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.output.schema.type, 'object');
  }
});

test('the search tool returns verbatim passages', async () => {
  const tools = mount(undefined).tools;
  const tool = tools.find((entry) => entry.name === 'weknora_search');
  const value = await tool.execute({ query: '退款' }, {});
  assert.equal(value.count, 1);
  assert.equal(value.results[0].document, '退款流程');
  assert.equal(value.results[0].knowledge_id, 'doc-1');
  const rendered = tool.output.render({}, value);
  assert.match(rendered[0].text, /签收后 7 天内可退/);
});

test('the read tool reassembles a document', async () => {
  const tools = mount(undefined).tools;
  const tool = tools.find((entry) => entry.name === 'weknora_read_document');
  const value = await tool.execute({ knowledge_id: 'doc-1', page: 1, page_size: 20 }, {});
  assert.equal(value.title, '退款流程');
  assert.equal(value.total_chunks, 2);
  assert.match(value.content, /第一段[\s\S]*第二段/);
});

test('the ask tool uses the configured WeKnora agent and keeps citations', async () => {
  const tools = mount(undefined).tools;
  const tool = tools.find((entry) => entry.name === 'weknora_ask');
  const value = await tool.execute({ query: '退款多久' }, {});
  assert.equal(value.answer, '退款需在');
  assert.equal(value.session_id, 'session-1');
  assert.equal(value.references[0].title, '退款流程');
  const rendered = tool.output.render({}, value).map((block) => block.text).join('\n');
  assert.match(rendered, /退款需在/);
  assert.match(rendered, /引用来源/);
});

test('normalizes base URLs and clips oversized passages', () => {
  assert.equal(__internals.normalizeBase('http://host:8080/api/v1/'), 'http://host:8080');
  assert.equal(__internals.normalizeBase('https://host/kb/api/v1'), 'https://host/kb');
  assert.equal(__internals.normalizeBase('host:8080'), 'http://host:8080', 'a bare host:port defaults to http');
  assert.equal(__internals.normalizeBase('192.168.1.20:8080/kb'), 'http://192.168.1.20:8080/kb');
  assert.equal(__internals.normalizeBase('ftp://host'), undefined);
  const clipped = __internals.clip('知识库内容', 3);
  assert.equal(clipped.text, '知识库…');
  assert.equal(clipped.truncated, true);
});

test('sanitizes a settings patch', () => {
  const ok = __internals.sanitizePatch({ baseUrl: 'http://host:8080', tenantId: '7', maxResults: 5 });
  assert.equal(ok.values.baseUrl, 'http://host:8080');
  assert.equal(ok.values.maxResults, 5);
  assert.equal(__internals.sanitizePatch({ tenantId: 'abc' }).error !== undefined, true);
  assert.equal(__internals.sanitizePatch({ resourceUrls: 'nope' }).error !== undefined, true);
  assert.equal(__internals.sanitizePatch({ apiKey: '' }).values.apiKey, undefined, 'blank secret keeps the stored one');
});

test.after(async () => {
  await new Promise((resolve) => harness.close(resolve));
  upstream.server.close();
  fs.rmSync(DSH_HOME, { recursive: true, force: true });
});
