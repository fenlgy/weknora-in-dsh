/**
 * A dependency-free WeKnora stand-in for end-to-end checks.
 *
 * It implements the slice of the REST API this plugin talks to — knowledge
 * bases, documents (list/upload/manual/url/edit/delete/reparse), chunks,
 * retrieval, agents, sessions and the SSE chat stream — with in-memory state.
 * Responses follow the real envelopes (`{success, data}`) so the panel code
 * exercises the same branches it would against a real deployment.
 *
 * Usage: node test/e2e/mock-weknora.mjs [port]
 */
import http from 'node:http';

const port = Number(process.argv[2] ?? 19090);

/** In-memory deployment state. */
const state = {
  knowledgeBases: [
    {
      id: 'kb-1',
      name: '产品文档',
      description: '产品与退款流程',
      type: 'document',
      knowledge_count: 3,
      is_pinned: true,
      updated_at: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    },
    {
      id: 'kb-2',
      name: '售后 FAQ',
      description: '常见售后问题',
      type: 'faq',
      knowledge_count: 1,
      updated_at: new Date(Date.now() - 86_400_000).toISOString(),
    },
  ],
  documents: [
    {
      id: 'doc-1',
      knowledge_base_id: 'kb-1',
      title: '退款流程',
      file_name: '退款流程.md',
      file_type: 'md',
      type: 'manual',
      source: 'manual',
      parse_status: 'completed',
      file_size: 2048,
      folder_path: '',
      metadata: { content: '# 退款流程\n\n签收后 7 天内可申请退款。', status: 'publish' },
      updated_at: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    },
    {
      id: 'doc-2',
      knowledge_base_id: 'kb-1',
      title: '产品介绍',
      file_name: '产品介绍.pdf',
      file_type: 'pdf',
      type: 'file',
      source: 'file',
      parse_status: 'completed',
      file_size: 481_280,
      folder_path: 'docs',
      metadata: {},
      updated_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    },
    {
      id: 'doc-3',
      knowledge_base_id: 'kb-1',
      title: '常见问题',
      file_name: '常见问题.md',
      file_type: 'md',
      type: 'file',
      source: 'file',
      parse_status: 'processing',
      file_size: 1024,
      folder_path: '',
      metadata: {},
      updated_at: new Date(Date.now() - 3_600_000).toISOString(),
    },
    {
      id: 'doc-4',
      knowledge_base_id: 'kb-2',
      title: '售后政策',
      file_name: '售后政策.md',
      file_type: 'md',
      type: 'manual',
      source: 'manual',
      parse_status: 'completed',
      file_size: 900,
      folder_path: '',
      metadata: { content: '售后政策正文', status: 'publish' },
      updated_at: new Date().toISOString(),
    },
  ],
  agents: [
    {
      id: 'builtin-quick-answer',
      name: '快速问答',
      description: 'RAG 检索后直接回答',
      is_builtin: true,
      config: { agent_mode: 'quick-answer' },
    },
    {
      id: 'agent-1',
      name: '售后助手',
      description: '带工具调用与引用的 ReAct 智能体',
      is_builtin: false,
      config: { agent_mode: 'smart-reasoning' },
    },
  ],
  sessionSeq: 0,
  docSeq: 100,
  kbSeq: 10,
};

/**
 * Send one JSON reply.
 * @param res - Response.
 * @param status - Status code.
 * @param payload - Body.
 */
function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length) });
  res.end(body);
}

/**
 * Read a request body.
 * @param req - Request.
 * @returns Buffer.
 */
function bodyOf(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Documents of one knowledge base, honoring the pagination/keyword query.
 * @param kbId - Knowledge base id.
 * @param url - Request URL.
 * @returns `{total, data}`.
 */
function listDocuments(kbId, url) {
  const keyword = (url.searchParams.get('keyword') ?? '').trim();
  const rows = state.documents
    .filter((doc) => doc.knowledge_base_id === kbId)
    .filter((doc) => keyword === '' || doc.title.includes(keyword) || doc.file_name.includes(keyword));
  return { total: rows.length, data: rows };
}

/**
 * Find one document.
 * @param id - Document id.
 * @returns The row or undefined.
 */
function documentOf(id) {
  return state.documents.find((doc) => doc.id === id);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const body = await bodyOf(req);

  // Health probe used by the test harness.
  if (path === '/health') {
    json(res, 200, { ok: true });
    return;
  }

  // Knowledge bases.
  if (path === '/api/v1/knowledge-bases' && method === 'GET') {
    json(res, 200, { success: true, data: state.knowledgeBases });
    return;
  }
  if (path === '/api/v1/knowledge-bases' && method === 'POST') {
    const payload = JSON.parse(body.toString('utf8') || '{}');
    const kb = {
      id: `kb-${state.kbSeq += 1}`,
      name: String(payload.name ?? '未命名'),
      description: String(payload.description ?? ''),
      type: String(payload.type ?? 'document'),
      knowledge_count: 0,
      updated_at: new Date().toISOString(),
    };
    state.knowledgeBases.push(kb);
    json(res, 201, { success: true, data: kb });
    return;
  }
  const kbMatch = /^\/api\/v1\/knowledge-bases\/([^/]+)$/.exec(path);
  if (kbMatch !== null && method === 'DELETE') {
    state.knowledgeBases = state.knowledgeBases.filter((kb) => kb.id !== kbMatch[1]);
    state.documents = state.documents.filter((doc) => doc.knowledge_base_id !== kbMatch[1]);
    json(res, 200, { success: true });
    return;
  }

  // Documents of one knowledge base.
  const listMatch = /^\/api\/v1\/knowledge-bases\/([^/]+)\/knowledge$/.exec(path);
  if (listMatch !== null && method === 'GET') {
    json(res, 200, listDocuments(listMatch[1], url));
    return;
  }
  const uploadMatch = /^\/api\/v1\/knowledge-bases\/([^/]+)\/knowledge\/file$/.exec(path);
  if (uploadMatch !== null && method === 'POST') {
    const raw = body.toString('latin1');
    const text = body.toString('utf8');
    const name = /filename="([^"]+)"/.exec(raw)?.[1] ?? 'upload.bin';
    // Folder uploads send the relative path in the `fileName` form field, the
    // same contract WeKnora uses to derive folder_path + display name.
    const custom = /name="fileName"\r?\n\r?\n([^\r\n]*)/.exec(text)?.[1]?.trim() ?? '';
    const relative = custom === '' ? name : custom.replace(/\\/g, '/');
    const slash = relative.lastIndexOf('/');
    const folder = slash < 0 ? '' : relative.slice(0, slash);
    const base = slash < 0 ? relative : relative.slice(slash + 1);
    const doc = {
      id: `doc-${state.docSeq += 1}`,
      knowledge_base_id: uploadMatch[1],
      title: base.replace(/\.[^.]+$/, ''),
      file_name: base,
      file_type: base.split('.').pop() ?? 'bin',
      type: 'file',
      source: 'file',
      parse_status: 'pending',
      file_size: 1024,
      folder_path: folder,
      metadata: {},
      updated_at: new Date().toISOString(),
    };
    state.documents.push(doc);
    json(res, 200, { success: true, data: doc });
    return;
  }
  const manualMatch = /^\/api\/v1\/knowledge-bases\/([^/]+)\/knowledge\/manual$/.exec(path);
  if (manualMatch !== null && method === 'POST') {
    const payload = JSON.parse(body.toString('utf8') || '{}');
    const title = String(payload.title ?? '未命名文章');
    const doc = {
      id: `doc-${state.docSeq += 1}`,
      knowledge_base_id: manualMatch[1],
      title,
      file_name: `${title}.md`,
      file_type: 'md',
      type: 'manual',
      source: 'manual',
      parse_status: payload.status === 'publish' ? 'processing' : 'pending',
      file_size: Buffer.byteLength(String(payload.content ?? '')),
      folder_path: '',
      metadata: { content: String(payload.content ?? ''), status: payload.status === 'publish' ? 'publish' : 'draft' },
      updated_at: new Date().toISOString(),
    };
    state.documents.push(doc);
    json(res, 200, { success: true, data: doc });
    return;
  }
  const urlMatch = /^\/api\/v1\/knowledge-bases\/([^/]+)\/knowledge\/url$/.exec(path);
  if (urlMatch !== null && method === 'POST') {
    const payload = JSON.parse(body.toString('utf8') || '{}');
    const doc = {
      id: `doc-${state.docSeq += 1}`,
      knowledge_base_id: urlMatch[1],
      title: String(payload.title ?? payload.url ?? '网页导入'),
      file_name: 'page.html',
      file_type: 'html',
      type: 'file',
      source: 'url',
      parse_status: 'pending',
      file_size: 512,
      folder_path: '',
      metadata: {},
      updated_at: new Date().toISOString(),
    };
    state.documents.push(doc);
    json(res, 201, { success: true, data: doc });
    return;
  }

  // One document.
  const manualById = /^\/api\/v1\/knowledge\/manual\/([^/]+)$/.exec(path);
  if (manualById !== null && method === 'PUT') {
    const payload = JSON.parse(body.toString('utf8') || '{}');
    const doc = documentOf(manualById[1]);
    if (doc !== undefined) {
      doc.title = String(payload.title ?? doc.title);
      doc.metadata = { content: String(payload.content ?? ''), status: payload.status === 'publish' ? 'publish' : 'draft' };
      doc.updated_at = new Date().toISOString();
    }
    json(res, 200, { success: true, data: doc });
    return;
  }
  const reparseMatch = /^\/api\/v1\/knowledge\/([^/]+)\/reparse$/.exec(path);
  if (reparseMatch !== null && method === 'POST') {
    const doc = documentOf(reparseMatch[1]);
    if (doc !== undefined) doc.parse_status = 'processing';
    json(res, 200, { success: true });
    return;
  }
  const docMatch = /^\/api\/v1\/knowledge\/([^/]+)$/.exec(path);
  if (docMatch !== null && method === 'DELETE') {
    state.documents = state.documents.filter((doc) => doc.id !== docMatch[1]);
    json(res, 200, { success: true });
    return;
  }
  if (docMatch !== null && method === 'GET') {
    const doc = documentOf(docMatch[1]);
    json(res, 200, { success: true, data: doc ?? {} });
    return;
  }
  const previewMatch = /^\/api\/v1\/knowledge\/([^/]+)\/preview$/.exec(path);
  if (previewMatch !== null) {
    const doc = documentOf(previewMatch[1]);
    const text = doc?.metadata?.content ?? '# 原文\n\n这是原始文件内容。';
    const payload = Buffer.from(text);
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-length': String(payload.length) });
    res.end(payload);
    return;
  }

  // Chunks.
  const chunksMatch = /^\/api\/v1\/chunks\/([^/]+)$/.exec(path);
  if (chunksMatch !== null && method === 'GET') {
    const doc = documentOf(chunksMatch[1]);
    const content = doc?.metadata?.content ?? '这是文档的分块内容，用于展示解析结果。';
    const rows = [
      { id: `${chunksMatch[1]}-c1`, knowledge_id: chunksMatch[1], chunk_index: 1, content, type: 'text', enabled: true, revision: 1 },
      { id: `${chunksMatch[1]}-c2`, knowledge_id: chunksMatch[1], chunk_index: 2, content: '第二段：补充说明。', type: 'text', enabled: true, revision: 1 },
    ];
    json(res, 200, { success: true, data: rows, total: rows.length, page: 1, page_size: 50 });
    return;
  }
  const chunkMatch = /^\/api\/v1\/chunks\/([^/]+)\/([^/]+)$/.exec(path);
  if (chunkMatch !== null && method === 'PUT') {
    const payload = JSON.parse(body.toString('utf8') || '{}');
    json(res, 200, { success: true, data: { id: chunkMatch[2], content: payload.content, revision: 2 } });
    return;
  }

  // Retrieval + name search.
  if (path === '/api/v1/knowledge-search' && method === 'POST') {
    const payload = JSON.parse(body.toString('utf8') || '{}');
    json(res, 200, {
      success: true,
      data: [
        {
          id: 'chunk-1',
          knowledge_id: 'doc-1',
          knowledge_base_id: 'kb-1',
          knowledge_title: '退款流程',
          content: `与「${payload.query}」相关：签收后 7 天内可申请退款。`,
          score: 0.912,
        },
      ],
      meta: { rerank: { outcome: 'ok' } },
    });
    return;
  }
  if (path === '/api/v1/knowledge/search' && method === 'GET') {
    const keyword = (url.searchParams.get('keyword') ?? '').toLowerCase();
    const rows = state.documents.filter((doc) => doc.title.toLowerCase().includes(keyword));
    json(res, 200, { success: true, data: rows });
    return;
  }

  // Agents + chat.
  if (path === '/api/v1/agents' && method === 'GET') {
    json(res, 200, { success: true, data: state.agents, disabled_own_agent_ids: [] });
    return;
  }
  if (path === '/api/v1/sessions' && method === 'POST') {
    state.sessionSeq += 1;
    json(res, 200, { success: true, data: { id: `session-${state.sessionSeq}` } });
    return;
  }
  const chatMatch = /^\/api\/v1\/(agent|knowledge)-chat\/([^/]+)$/.exec(path);
  if (chatMatch !== null && method === 'POST') {
    const payload = JSON.parse(body.toString('utf8') || '{}');
    const agent = state.agents.find((entry) => entry.id === payload.agent_id);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frames = [
      { response_type: 'agent_query', content: '' },
      { response_type: 'thinking', content: '正在检索知识库…' },
      {
        response_type: 'answer',
        content: `${agent?.name ?? 'WeKnora'} 回答：「${payload.query}」`,
      },
      { response_type: 'answer', content: '——签收后 7 天内可申请退款。' },
      {
        response_type: 'references',
        knowledge_references: [
          { knowledge_id: 'doc-1', knowledge_title: '退款流程', content: '签收后 7 天内可申请退款。' },
        ],
      },
      { response_type: 'complete', done: true },
    ];
    let index = 0;
    const timer = setInterval(() => {
      if (index >= frames.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(`event:message\ndata:${JSON.stringify(frames[index])}\n\n`);
      index += 1;
    }, 30);
    return;
  }

  json(res, 404, { success: false, error: { code: 'not-found', message: `未实现的接口：${method} ${path}` } });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-weknora listening on http://127.0.0.1:${port}`);
});
