/**
 * Browser half of `dsh-weknora`.
 *
 * Contributes two things to the harness GUI:
 *   - an entry in the left panel list (`sidebar.panellist`), and
 *   - the page it selects (`main`, keyed by the same id).
 *
 * Every network call goes to the harness-origin `/weknora` prefix registered by
 * this package's host half, which forwards to the configured WeKnora deployment.
 * The page therefore never needs cross-origin access and the API key never has
 * to travel in a preflight.
 */
window.__ModuleLoader__.load({
  id: 'dsh-weknora',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    /** Locale namespace this panel registers its dictionaries under. */
    const NS = 'weknora-kb';
    /** Sidebar entry id; also the `main` keyed-slot key that renders the page. */
    const PANEL_ID = 'weknora-kb';
    /** Prefix route claimed by the host half. */
    const PROXY_SEGMENT = '/weknora';
    /** Settings helper routes the host half owns (never forwarded upstream). */
    const CONFIG_PATH = '/__config';
    const TEST_PATH = '/__test';
    /** Page size for the document list. */
    const DOC_PAGE_SIZE = 20;
    /** Knowledge-base kinds WeKnora accepts when creating one. */
    const KB_TYPES = [
      { value: 'document', labelKey: 'kbTypeDocument' },
      { value: 'faq', labelKey: 'kbTypeFaq' },
      { value: 'wiki', labelKey: 'kbTypeWiki' },
    ];
    /** Parse states that mean "the pipeline is done". */
    const PARSE_DONE = new Set(['completed', 'failed']);

    //#region transport

    /**
     * Absolute URL of the host proxy, derived exactly like the harness's own
     * client code does: the injected transport when present, else the document.
     * @returns The proxy prefix without a trailing slash.
     */
    function proxyBase() {
      const transport = globalThis.__DSH_TRANSPORT__;
      const anchor =
        (transport && typeof transport.streamBaseUrl === 'string' && transport.streamBaseUrl) ||
        (typeof document !== 'undefined' && document.baseURI) ||
        (typeof location !== 'undefined' && location.href) ||
        'http://127.0.0.1/';
      try {
        return new URL(PROXY_SEGMENT, anchor).href.replace(/\/$/, '');
      } catch {
        return PROXY_SEGMENT;
      }
    }

    /**
     * Build the proxy headers for one request.
     *
     * The credential lives host-side now (the panel only ever stores presence
     * flags), so page requests carry no secret. The host merges the stored
     * settings with the `x-weknora-*` overrides for callers that do have one.
     * @returns Header record.
     */
    function proxyHeaders() {
      return { accept: 'application/json' };
    }

    /**
     * Turn one HTTP reply into parsed JSON or a thrown error with status.
     * @param response - Fetch response.
     * @param context - `{method, path}` for the error message.
     * @returns Parsed payload.
     */
    async function readReply(response, context) {
      const text = await response.text();
      let payload;
      try {
        payload = text === '' ? null : JSON.parse(text);
      } catch {
        payload = text;
      }
      if (!response.ok) {
        const contentType = response.headers.get('content-type') ?? '';
        const error = new Error(errorMessage(payload, response.status, { ...context, contentType }));
        error.status = response.status;
        error.payload = payload;
        error.contentType = contentType;
        throw error;
      }
      return payload;
    }

    /**
     * Read the effective host-side settings. The key itself never comes back —
     * only `hasApiKey` / `hasToken` presence flags.
     * @returns Settings record.
     */
    async function loadConfig() {
      const response = await fetch(`${proxyBase()}${CONFIG_PATH}`, { headers: { accept: 'application/json' } });
      const payload = await readReply(response, { method: 'GET', path: CONFIG_PATH });
      return payload?.config ?? {};
    }

    /**
     * Persist a settings patch host-side.
     * @param patch - Fields to change; empty secret fields keep the stored ones.
     * @returns The settings record after the merge.
     */
    async function saveConfig(patch) {
      const response = await fetch(`${proxyBase()}${CONFIG_PATH}`, {
        method: 'PUT',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const payload = await readReply(response, { method: 'PUT', path: CONFIG_PATH });
      return payload?.config ?? {};
    }

    /**
     * Probe the configured deployment through the host (`GET /knowledge-bases`).
     * @returns `{ok, knowledgeBases}` or `{ok:false, error}`.
     */
    async function testConfig() {
      const response = await fetch(`${proxyBase()}${TEST_PATH}`, {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
      return (await readReply(response, { method: 'POST', path: TEST_PATH })) ?? { ok: false, error: '无响应' };
    }

    /**
     * Pull a human-readable message out of a failed reply.
     *
     * WeKnora answers business failures with `{"success":false,"error":{"code",
     * "message"}}` and middleware failures with `{"error":"…"}`. Anything else —
     * an empty body, or an HTML page from a gateway in front of the deployment —
     * carries no message at all, and reporting only the status code left the
     * operator with nothing to act on. So the request and a body excerpt are
     * appended in that case.
     *
     * @param payload - Parsed body, raw text, or null.
     * @param status - HTTP status.
     * @param context - Optional `{ method, path, contentType }` of the request.
     * @returns The message to show.
     */
    function errorMessage(payload, status, context) {
      const body = payload ?? {};
      const where = context === undefined ? '' : `，${context.method} ${context.path}`;
      if (typeof body === 'object') {
        const nested = body.error;
        if (typeof nested === 'string' && nested !== '') return nested;
        if (nested !== null && typeof nested === 'object' && typeof nested.message === 'string') return nested.message;
        if (typeof body.message === 'string' && body.message !== '') return body.message;
      }
      const raw =
        typeof payload === 'string'
          ? payload
              .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
              .replace(/<[^>]*>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
          : '';
      const detail = raw === '' ? '响应体为空' : `响应体：${raw.slice(0, 200)}`;
      const type = context?.contentType ? `，content-type: ${context.contentType}` : '';
      return `请求失败（HTTP ${status}${where}${type}）—— ${detail}`;
    }

    /**
     * Call one WeKnora REST path through the host proxy.
     * @param path - WeKnora path including `/api/v1`, optionally with a query string.
     * @param options - Method, JSON body, settings.
     * @returns Parsed JSON payload, or raw text when the reply is not JSON.
     */
    async function call(path, options) {
      const opts = options ?? {};
      const method = opts.method ?? 'GET';
      const headers = proxyHeaders();
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${proxyBase()}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
      return readReply(response, { method, path });
    }

    /**
     * Upload one multipart form through the proxy. The browser sets the
     * multipart boundary itself, so no content-type header is passed here.
     * @param path - WeKnora path.
     * @param form - FormData carrying the file and any metadata fields.
     * @param signal - Cancellation.
     * @returns Parsed reply.
     */
    async function callForm(path, form, signal) {
      const response = await fetch(`${proxyBase()}${path}`, {
        method: 'POST',
        headers: { accept: 'application/json' },
        body: form,
        signal,
      });
      return readReply(response, { method: 'POST', path });
    }

    /**
     * POST one chat turn and consume its SSE reply.
     *
     * WeKnora streams `event: message` frames whose data is a `StreamResponse`.
     * Answer frames append text; a references frame replaces citations; error
     * frames surface a message. The caller gets both the live callback and the
     * assembled result.
     *
     * @param path - `/api/v1/agent-chat/<session>` or `/api/v1/knowledge-chat/<session>`.
     * @param body - JSON request body.
     * @param onEvent - Callback per parsed frame.
     * @param signal - Cancellation.
     * @returns `{text, references, sessionId, error, toolCalls}`.
     */
    async function streamChat(path, body, onEvent, signal) {
      const response = await fetch(`${proxyBase()}${path}`, {
        method: 'POST',
        headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        await readReply(response, { method: 'POST', path });
        throw new Error(`请求失败（HTTP ${response.status}）`);
      }
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
        let payload;
        try {
          payload = JSON.parse(dataLines.join('\n'));
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
     * Fetch one WeKnora path as raw bytes.
     *
     * `GET /knowledge/:id/preview` streams the **original file**, not parsed
     * text: a PDF, a DOCX (a ZIP), an image, or a text file in whatever
     * encoding it was uploaded in. The reply therefore has to be handled as
     * bytes plus a media type, never as `response.text()`.
     *
     * @param path - WeKnora path.
     * @param settings - Connection settings.
     * @returns Bytes plus the media type and file name the upstream declared.
     */
    async function callBlob(path, settings) {
      const response = await fetch(`${proxyBase()}${path}`, { headers: proxyHeaders() });
      if (!response.ok) {
        const text = await response.text();
        let payload = null;
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
        throw new Error(errorMessage(payload, response.status, { method: 'GET', path }));
      }
      return {
        buffer: await response.arrayBuffer(),
        contentType: response.headers.get('content-type') ?? '',
        disposition: response.headers.get('content-disposition') ?? '',
      };
    }

    //#endregion
    //#region content decoding

    /** File extensions the panel is willing to decode as text. */
    const TEXT_EXTENSIONS =
      /\.(txt|text|md|markdown|mdx|json|jsonl|csv|tsv|log|yml|yaml|xml|html?|xhtml|sql|ini|cfg|conf|toml|rst|tex|srt|vtt|go|py|js|mjs|ts|tsx|java|c|h|cpp|cs|rb|php|sh|css|scss)$/i;

    /** Media types the panel renders as text. */
    const TEXTUAL_TYPE = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|ecmascript|sql|x-sh)$)/i;

    /** File names the panel treats as a PDF when the media type says nothing. */
    const PDF_EXTENSION = /\.pdf$/i;

    /** File names the panel treats as an image when the media type says nothing. */
    const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?)$/i;

    /** Charset labels that mean "already UTF-8", so no transcoding is attempted. */
    const UTF8_LABELS = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii']);

    /**
     * Read the charset a media type declares.
     * @param contentType - Raw `Content-Type` value.
     * @returns Lower-case charset label, or undefined when absent.
     */
    function charsetOf(contentType) {
      const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? '');
      return match === null ? undefined : match[1].toLowerCase();
    }

    /**
     * Decode bytes as text, honouring the declared charset and surviving a
     * wrong one.
     *
     * WeKnora labels the original file from its extension, so a GBK-encoded
     * `.txt` arrives as `text/plain; charset=utf-8`. Trusting that declaration
     * shows mojibake — the bug this function exists to fix — and because the
     * declaration is derived from the extension it carries almost no
     * information for text files. The order is therefore: a strict UTF-8 read
     * (unambiguous when it succeeds), then the declared charset, then GBK,
     * then a lossy UTF-8 last resort.
     *
     * @param buffer - Raw bytes.
     * @param contentType - Declared media type.
     * @returns Decoded text.
     */
    function decodeText(buffer, contentType) {
      const decode = (label, fatal) => {
        try {
          return new TextDecoder(label, { fatal }).decode(buffer);
        } catch {
          return undefined;
        }
      };
      const strictUtf8 = decode('utf-8', true);
      if (strictUtf8 !== undefined) return strictUtf8;
      const declared = charsetOf(contentType);
      if (declared !== undefined && !UTF8_LABELS.has(declared)) {
        const honoured = decode(declared, true);
        if (honoured !== undefined) return honoured;
      }
      const strictGbk = decode('gbk', true);
      if (strictGbk !== undefined) return strictGbk;
      return decode('utf-8', false) ?? '';
    }

    /**
     * Classify a reply into the rendering strategy it needs.
     * @param contentType - Declared media type.
     * @param fileName - Declared or known file name.
     * @returns `'text'`, `'image'`, `'pdf'`, or `'binary'`.
     */
    function classifyContent(contentType, fileName) {
      const type = (contentType ?? '').toLowerCase().split(';')[0].trim();
      const name = fileName ?? '';
      if (type.startsWith('image/')) return 'image';
      if (type.startsWith('application/pdf')) return 'pdf';
      if (TEXTUAL_TYPE.test(type)) return 'text';
      if (type === '' || type === 'application/octet-stream') {
        if (PDF_EXTENSION.test(name)) return 'pdf';
        if (IMAGE_EXTENSION.test(name)) return 'image';
        return TEXT_EXTENSIONS.test(name) ? 'text' : 'binary';
      }
      return 'binary';
    }

    /**
     * Pull the file name out of a `Content-Disposition` header.
     * @param disposition - Raw header value.
     * @param fallback - Name to use when the header carries none.
     * @returns The file name.
     */
    function fileNameFrom(disposition, fallback) {
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '');
      if (encoded !== null) {
        try {
          return decodeURIComponent(encoded[1]);
        } catch {
          /* fall through to the plain parameter */
        }
      }
      const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition ?? '');
      return plain === null ? fallback : plain[1];
    }

    //#endregion
    //#region settings

    /**
     * Whether a tenant id is one WeKnora will accept (a positive uint64 space id).
     * @param value - Candidate value.
     * @returns True when the value is a non-zero run of digits.
     */
    function isTenantId(value) {
      return /^\d+$/.test(value) && !/^0+$/.test(value);
    }

    /**
     * Build the editable form draft from the host settings record. Secrets are
     * absent from that record on purpose, so their draft fields start empty and
     * a blank field means "keep the stored secret".
     * @param config - Host settings record.
     * @returns Draft record.
     */
    function draftFrom(config) {
      const record = config ?? {};
      return {
        baseUrl: String(record.baseUrl ?? ''),
        tenantId: String(record.tenantId ?? ''),
        agentId: String(record.agentId ?? ''),
        apiKey: '',
        token: '',
      };
    }

    /**
     * Turn one draft into the settings patch the host accepts.
     * @param draft - Form draft.
     * @returns Patch record.
     */
    function patchFromDraft(draft) {
      let baseUrl = String(draft.baseUrl ?? '').trim();
      // Accept a bare host:port typed into the form; the address is normalized
      // host-side as well, but doing it here lets an old host bundle agree.
      if (baseUrl !== '' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl)) baseUrl = `http://${baseUrl}`;
      const patch = {
        baseUrl,
        tenantId: String(draft.tenantId ?? '').trim(),
        agentId: String(draft.agentId ?? '').trim(),
      };
      const apiKey = String(draft.apiKey ?? '').trim();
      const token = String(draft.token ?? '').trim();
      if (apiKey !== '') patch.apiKey = apiKey;
      if (token !== '') patch.token = token;
      return patch;
    }

    //#endregion
    //#region data shaping

    /** Parse-state badge text, matching the wording the WeKnora table uses. */
    const PARSE_LABELS = {
      pending: '待解析',
      processing: '解析中',
      finalizing: '解析中',
      completed: '解析完成',
      failed: '解析失败',
    };

    /** Dictionary keys for the document `source` column, by upstream value. */
    const SOURCE_KEYS = {
      file: 'sourceFile',
      upload: 'sourceFile',
      url: 'sourceUrl',
      web: 'sourceUrl',
      manual: 'sourceManual',
    };

    /**
     * Normalize `GET /knowledge-bases` into the cards the list renders.
     *
     * Field names beside `id`/`name` are read through fallbacks: the counts and
     * the built-in marker have moved between WeKnora versions, and a card that
     * omits a number is better than one that renders `undefined`.
     *
     * @param payload - Parsed reply.
     * @returns Knowledge base records.
     */
    function readKnowledgeBases(payload) {
      const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
      return list.map((item) => {
        const count = [
          item?.knowledge_count,
          item?.file_count,
          item?.document_count,
          item?.knowledge_total,
          item?.article_count,
        ].find((value) => Number.isFinite(value));
        return {
          id: String(item?.id ?? ''),
          name: String(item?.name ?? item?.id ?? '未命名知识库'),
          description: typeof item?.description === 'string' ? item.description : '',
          type: typeof item?.type === 'string' ? item.type : 'document',
          count,
          pinned: item?.is_pinned === true || item?.pinned === true,
          isSystem: item?.is_system === true || item?.is_builtin === true || item?.type === 'system',
          updatedAt: String(item?.updated_at ?? item?.created_at ?? ''),
        };
      });
    }

    /**
     * Normalize one retrieval hit. WeKnora returns `SearchResult` rows whose
     * optional display fields vary by deployment version, so every field falls
     * back through the names seen in the API reference.
     * @param hit - Raw result row.
     * @returns Renderable result.
     */
    function readSearchResult(hit) {
      const metadata = hit?.metadata ?? {};
      const score =
        typeof hit?.score === 'number'
          ? hit.score
          : typeof metadata.model_score === 'number'
            ? metadata.model_score
            : typeof metadata.base_score === 'number'
              ? metadata.base_score
              : undefined;
      const locators = Array.isArray(hit?.source_locators) ? hit.source_locators : [];
      const quote = locators.map((entry) => entry?.quote).find((value) => typeof value === 'string' && value !== '');
      return {
        id: String(hit?.id ?? ''),
        knowledgeId: String(hit?.knowledge_id ?? ''),
        title: String(hit?.knowledge_title ?? hit?.title ?? hit?.knowledge_filename ?? '未命名文档'),
        kbId: String(hit?.knowledge_base_id ?? ''),
        content: String(hit?.content ?? hit?.text ?? quote ?? ''),
        score,
      };
    }

    /**
     * Read the manual Markdown and draft flag out of a knowledge row's metadata.
     *
     * WeKnora stores manual knowledge as `metadata.content` + `metadata.status`.
     * The column has been returned both as an object and as a JSON string across
     * versions, so both are accepted; anything unparseable reads as null.
     * @param metadata - Raw metadata value.
     * @returns `{content, status}` or null.
     */
    function parseManualMetadata(metadata) {
      if (metadata === null || metadata === undefined) return null;
      try {
        const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
        if (parsed === null || typeof parsed !== 'object') return null;
        return {
          content: typeof parsed.content === 'string' ? parsed.content : '',
          status: parsed.status === 'publish' ? 'publish' : 'draft',
        };
      } catch {
        return null;
      }
    }

    /**
     * Basename of a host path, tolerating both separators.
     * @param value - Absolute path.
     * @returns Last path segment.
     */
    function basenameOf(value) {
      const parts = String(value ?? '').split(/[\\/]/).filter((part) => part !== '');
      return parts.length === 0 ? 'workspace-file' : parts[parts.length - 1];
    }

    /**
     * Path of a workspace file relative to the session working directory, so the
     * uploaded document keeps its directory inside WeKnora. Outside the cwd it
     * falls back to the bare basename (the absolute path never leaves the client).
     * @param cwd - Session working directory, when known.
     * @param absolutePath - Verified file path from the preview slot.
     * @returns Relative path with forward slashes, or the basename.
     */
    function workspaceRelativePath(cwd, absolutePath) {
      const base = basenameOf(absolutePath);
      if (typeof cwd !== 'string' || cwd.trim() === '' || typeof absolutePath !== 'string') return base;
      const slash = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '');
      const root = slash(cwd);
      const target = slash(absolutePath);
      if (target === root) return base;
      const prefixes = [root];
      if (/^[a-zA-Z]:/.test(root)) prefixes.push(root.toLowerCase());
      for (const prefix of prefixes) {
        const comparable = prefix === root ? target : target.toLowerCase();
        if (comparable.startsWith(`${prefix}/`)) {
          const relative = comparable.slice(prefix.length + 1);
          return relative === '' ? base : relative;
        }
      }
      return base;
    }

    /**
     * Human-readable explanation for a failed `/api/file` read.
     * @param status - HTTP status from the harness file route.
     * @param t - Locale translator.
     * @returns Message for the menu.
     */
    function workspaceReadError(status, t) {
      if (status === 413) return t('workspaceTooLarge');
      if (status === 403) return t('workspaceForbidden');
      if (status === 404) return t('workspaceMissing');
      return t('workspaceReadFailed', { status });
    }

    /** Hard ceiling for one drop, so a huge folder cannot queue forever. */
    const MAX_DROP_FILES = 500;
    /** OS bookkeeping files that should never become knowledge. */
    const IGNORED_UPLOAD_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

    /**
     * Flatten a dropped DataTransfer into upload entries, walking directories.
     *
     * `webkitGetAsEntry()` must be read synchronously inside the drop handler;
     * the caller passes the captured entries in. Files keep their path relative
     * to the drop (folder/sub/file.md), which WeKnora stores as folder_path +
     * file name via the multipart `fileName` field.
     *
     * @param entries - Captured FileSystemEntry values (may be empty).
     * @param files - Fallback FileList for browsers without the entries API.
     * @returns `{items, truncated}` where items are `{file, path}`.
     */
    async function collectDropEntries(entries, files) {
      if (entries.length === 0) {
        const items = Array.from(files ?? [])
          .filter((file) => !IGNORED_UPLOAD_NAMES.has(file.name))
          .map((file) => ({ file, path: file.name }));
        return { items, truncated: false };
      }
      const items = [];
      let truncated = false;
      const walk = async (entry, prefix) => {
        if (items.length >= MAX_DROP_FILES) {
          truncated = true;
          return;
        }
        if (entry.isFile === true) {
          try {
            const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
            if (IGNORED_UPLOAD_NAMES.has(file.name)) return;
            items.push({ file, path: `${prefix}${file.name}` });
          } catch {
            /* unreadable entry: skip it */
          }
          return;
        }
        if (entry.isDirectory === true) {
          const reader = entry.createReader();
          while (items.length < MAX_DROP_FILES) {
            let batch;
            try {
              batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
            } catch {
              return;
            }
            if (batch.length === 0) return;
            for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
          }
          truncated = true;
        }
      };
      for (const entry of entries) await walk(entry, '');
      items.sort((left, right) => left.path.localeCompare(right.path));
      return { items, truncated };
    }

    /**
     * Whether a drag carries OS files (not text or an internal element drag).
     * @param event - Drag event.
     * @returns True when the transfer has a Files entry.
     */
    function hasFileDrag(event) {
      const types = event?.dataTransfer?.types;
      if (types === undefined || types === null) return false;
      return Array.from(types).includes('Files');
    }

    /**
     * Normalize `GET /agents` rows into the picker's records.
     * @param payload - Parsed reply.
     * @returns Agent records.
     */
    function readAgents(payload) {
      const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
      return list.map((item) => ({
        id: String(item?.id ?? ''),
        name: String(item?.name ?? item?.id ?? '未命名智能体'),
        description: typeof item?.description === 'string' ? item.description : '',
        avatar: typeof item?.avatar === 'string' ? item.avatar : '',
        builtin: item?.is_builtin === true,
        mode: typeof item?.config?.agent_mode === 'string' ? item.config.agent_mode : 'quick-answer',
      }));
    }

    /**
     * Normalize one citation from a chat turn.
     * @param reference - Raw `knowledge_references` row.
     * @returns `{title, content, knowledgeId}`.
     */
    function readReference(reference) {
      return {
        title: String(reference?.knowledge_title ?? reference?.knowledge_filename ?? reference?.title ?? '未命名文档'),
        content: String(reference?.content ?? reference?.text ?? ''),
        knowledgeId: String(reference?.knowledge_id ?? ''),
      };
    }

    /**
     * Normalize `GET /knowledge-bases/:id/knowledge`.
     * @param payload - Parsed reply.
     * @returns Document rows plus paging facts.
     */
    function readKnowledgeList(payload) {
      const list = Array.isArray(payload?.data) ? payload.data : [];
      return {
        total: Number.isFinite(payload?.total) ? payload.total : list.length,
        documents: list.map(readKnowledge),
      };
    }

    /**
     * Normalize one `Knowledge` document row for the table.
     * @param item - Raw row.
     * @returns Renderable document.
     */
    function readKnowledge(item) {
      const size = [item?.file_size, item?.size, item?.fileSize].find((value) => Number.isFinite(value));
      const source = item?.source ?? item?.channel ?? item?.file_source;
      return {
        id: String(item?.id ?? ''),
        title: String(item?.file_name ?? item?.title ?? '未命名文档'),
        description: typeof item?.description === 'string' ? item.description : '',
        fileType: String(item?.file_type ?? item?.type ?? ''),
        type: String(item?.type ?? ''),
        folder: typeof item?.folder_path === 'string' ? item.folder_path : '',
        status: String(item?.parse_status ?? ''),
        size,
        source: typeof source === 'string' ? source : '',
        updatedAt: String(item?.updated_at ?? item?.created_at ?? ''),
      };
    }

    /**
     * Human-readable file size, matching the WeKnora table's units.
     * @param bytes - Size in bytes.
     * @returns Text such as `18.9KB`, or empty when unknown.
     */
    function formatSize(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return '';
      if (bytes < 1024) return `${bytes}B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let value = bytes / 1024;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      // One decimal, matching the knowledge base cards (`444.8KB`), with a
      // trailing `.0` dropped so round values read `10GB` rather than `10.0GB`.
      return `${value.toFixed(1).replace(/\.0$/, '')}${units[unit]}`;
    }

    /**
     * Relative age in the shape the WeKnora lists use ("5天前").
     * @param value - Raw timestamp.
     * @returns Relative text, or empty when unparsable.
     */
    function relativeTime(value) {
      if (!value) return '';
      const then = new Date(value).getTime();
      if (Number.isNaN(then)) return '';
      const seconds = Math.max(0, (Date.now() - then) / 1000);
      const table = [
        [60, 1, '秒'],
        [3600, 60, '分钟'],
        [86400, 3600, '小时'],
        [2592000, 86400, '天'],
        [31536000, 2592000, '个月'],
        [Number.POSITIVE_INFINITY, 31536000, '年'],
      ];
      for (const [limit, divisor, label] of table) {
        if (seconds < limit) {
          const count = Math.floor(seconds / divisor);
          if (label === '秒' && count < 30) return '刚刚';
          return `${Math.max(1, count)}${label}前`;
        }
      }
      return '';
    }

    /**
     * Human label for a knowledge base's kind badge.
     * @param kb - Normalized knowledge base.
     * @returns Badge text, or empty when the kind is the default.
     */
    function kbKindLabel(kb) {
      if (kb.isSystem) return '系统';
      if (kb.type === 'wiki') return 'Wiki';
      if (kb.type === 'faq') return 'FAQ';
      return '';
    }

    /**
     * Format an ISO timestamp for the document list.
     * @param value - Raw timestamp.
     * @returns Short local date text, or empty when unparsable.
     */
    function shortDate(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /**
     * Reduce upstream markup to readable text. Only the raw-file view of an
     * HTML document reaches this, but the panel never injects upstream markup
     * into the harness document either way.
     * @param raw - Decoded body.
     * @returns Text safe to render inside a `<pre>`.
     */
    function stripMarkup(raw) {
      const value = typeof raw === 'string' ? raw : '';
      if (!/<[a-z!/][\s\S]*>/i.test(value)) return value;
      return value
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    //#endregion
    //#region icons

    /**
     * Left-panel glyph: a knowledge-base cylinder.
     * @param props - Owner-controlled `size` and read-only `active`.
     * @returns SVG element.
     */
    function PanelIcon({ size }) {
      const dimension = typeof size === 'number' ? size : 16;
      return h(
        'svg',
        {
          width: dimension,
          height: dimension,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('ellipse', { cx: 8, cy: 3.6, rx: 4.6, ry: 1.9 }),
        h('path', { d: 'M3.4 3.6v8.8c0 1.05 2.06 1.9 4.6 1.9s4.6-.85 4.6-1.9V3.6' }),
        h('path', { d: 'M3.4 8c0 1.05 2.06 1.9 4.6 1.9s4.6-.85 4.6-1.9' }),
      );
    }

    /**
     * Small inline glyph used inside the page.
     * @param props - `path` drawing data, optional `size`.
     * @returns SVG element.
     */
    function Glyph({ path, size }) {
      const dimension = typeof size === 'number' ? size : 14;
      return h(
        'svg',
        {
          width: dimension,
          height: dimension,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', { d: path }),
      );
    }

    //#endregion
    //#region styles

    /** Component-local stylesheet; React removal on unmount disposes it. */
    const STYLES = `
      /* Values follow the DSH design tokens/primitives: 13px body, 20px page
         title, 12px control radius, near-black primary buttons, 28px modal. */
      .wkn-root{position:relative;height:100%;display:flex;flex-direction:column;min-height:0;
        background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
        font-size:13px;line-height:20px}
      .wkn-head{display:flex;align-items:center;gap:12px;flex:0 0 auto;
        padding:calc(24px + var(--dsh-frame-top-clearance,0px)) 24px 0}
      .wkn-title{margin:0;font-size:20px;line-height:28px;font-weight:500;letter-spacing:normal}
      .wkn-sub{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
      .wkn-spacer{flex:1 1 auto}
      .wkn-tabs{display:flex;gap:4px;flex:0 0 auto;padding:16px 24px 0}
      .wkn-tab{height:32px;padding:0 12px;border:none;border-radius:12px;background:transparent;
        color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
      .wkn-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .wkn-tab[data-on="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}
      .wkn-body{flex:1 1 auto;min-height:0;overflow:auto;padding:16px 24px 32px}
      .wkn-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .wkn-input,.wkn-select{height:36px;padding:0 12px;border-radius:12px;
        border:1px solid var(--dsw-alias-border-l3);background:transparent;color:inherit;
        font:inherit;font-size:13px;line-height:20px;outline:none;min-width:0}
      .wkn-input:focus,.wkn-select:focus{border-color:#4176e6;
        box-shadow:0 0 0 .5px #4176e6 inset}
      .wkn-input::placeholder{color:var(--dsw-alias-label-tertiary)}
      .wkn-grow{flex:1 1 240px}
      .wkn-btn{height:32px;padding:0 12px;border-radius:12px;font:inherit;font-size:13px;
        line-height:20px;cursor:pointer;border:none;background:transparent;
        color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .wkn-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .wkn-btn:disabled{opacity:.45;cursor:default}
      .wkn-btn[data-variant="primary"]{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}
      .wkn-btn[data-variant="primary"]:hover:not(:disabled){background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);filter:none;opacity:.9}
      .wkn-chips{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 4px}
      .wkn-chip{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:999px;
        border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);
        font:inherit;font-size:13px;line-height:20px;cursor:pointer;max-width:100%}
      .wkn-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .wkn-chip[data-on="true"]{border-color:transparent;background:var(--dsw-alias-interactive-bg-hover);
        color:var(--dsw-alias-label-primary);font-weight:500}
      .wkn-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .wkn-card{border:1px solid var(--dsw-alias-border-l2);border-radius:20px;padding:16px;margin-top:12px;
        background:transparent}
      .wkn-card-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
      .wkn-card-title{font-weight:500;font-size:14px;line-height:20px;overflow-wrap:anywhere}
      .wkn-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
      .wkn-score{color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:20px;font-variant-numeric:tabular-nums}
      .wkn-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);
        font-size:13px;line-height:20px;max-height:220px;overflow:auto}
      .wkn-actions{display:flex;gap:6px;margin-top:12px}
      .wkn-note{margin:14px 0 0;padding:10px 12px;border-radius:12px;font-size:13px;line-height:20px;
        white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--dsw-alias-border-l2);
        color:var(--dsw-alias-label-secondary)}
      .wkn-note[data-kind="error"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
      .wkn-note[data-kind="ok"]{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
      .wkn-list{margin:6px 0 0;padding:0;list-style:none}
      .wkn-doc{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:12px;cursor:pointer;border:none;
        background:transparent;color:inherit;font:inherit;text-align:left;width:100%}
      .wkn-doc:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .wkn-doc-main{min-width:0;flex:1 1 auto}
      .wkn-doc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .wkn-badge{flex:0 0 auto;font-size:10px;line-height:18px;height:18px;padding:0 7px;border-radius:999px;
        border:none;color:var(--dsw-alias-label-secondary);
        background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
      .wkn-badge[data-state="completed"]{color:var(--dsw-alias-state-success-primary);
        background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
      .wkn-badge[data-state="failed"]{color:var(--dsw-alias-state-error-primary);
        background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
      .wkn-form{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px 16px;align-items:center;margin-top:12px}
      .wkn-form label{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;white-space:nowrap}
      .wkn-pager{display:flex;align-items:center;gap:8px;margin-top:14px}
      .wkn-chunk{border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0}
      .wkn-meta + .wkn-chunk{border-top:none;padding-top:0}
      .wkn-md{font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
      .wkn-md > *:first-child{margin-top:0}
      .wkn-md > *:last-child{margin-bottom:0}
      .wkn-md h1,.wkn-md h2,.wkn-md h3,.wkn-md h4,.wkn-md h5,.wkn-md h6{
        margin:.9em 0 .4em;font-weight:600;line-height:1.4}
      .wkn-md h1{font-size:1.32em}
      .wkn-md h2{font-size:1.18em}
      .wkn-md h3{font-size:1.06em}
      .wkn-md h4,.wkn-md h5,.wkn-md h6{font-size:1em;color:var(--dsw-alias-label-secondary)}
      .wkn-md p{margin:.55em 0}
      .wkn-md ul,.wkn-md ol{margin:.55em 0;padding-left:1.5em}
      .wkn-md li{margin:.22em 0}
      .wkn-md code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;
        padding:.1em .34em;border-radius:6px;background:var(--dsw-alias-bg-layer-1)}
      .wkn-md pre{margin:.6em 0;padding:10px 12px;border-radius:12px;overflow:auto;
        background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2)}
      .wkn-md pre code{padding:0;background:transparent;font-size:12px}
      .wkn-md blockquote{margin:.6em 0;padding:.1em .9em;color:var(--dsw-alias-label-secondary);
        border-left:2px solid var(--dsw-alias-border-l4)}
      .wkn-md table{border-collapse:collapse;margin:.6em 0;font-size:13px}
      .wkn-md th,.wkn-md td{border:1px solid var(--dsw-alias-border-l2);padding:6px 9px;text-align:left}
      .wkn-md th{font-weight:500;background:var(--dsw-alias-bg-layer-1)}
      .wkn-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l2);margin:1em 0}
      .wkn-md a{color:var(--dsw-alias-state-business-primary);text-decoration:none}
      .wkn-md a:hover{text-decoration:underline}
      .wkn-md del{color:var(--dsw-alias-label-tertiary)}
      .wkn-md-image{display:inline-block;padding:.05em .4em;border-radius:6px;font-size:.92em;
        border:1px dashed var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}
      .wkn-editor{display:block;width:100%;min-height:220px;padding:10px 12px;border-radius:12px;
        border:1px solid var(--dsw-alias-border-l3);background:transparent;color:inherit;outline:none;
        resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.65}
      .wkn-editor:focus{border-color:#4176e6;box-shadow:0 0 0 .5px #4176e6 inset}
      .wkn-editor:disabled{opacity:.6}
      .wkn-chunk-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
      .wkn-frame{width:100%;height:520px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;
        background:var(--dsw-alias-bg-layer-1)}
      .wkn-img{display:block;max-width:100%;max-height:520px;border-radius:12px;
        border:1px solid var(--dsw-alias-border-l2)}
      .wkn-link{display:inline-flex;align-items:center;height:32px;padding:0 12px;border-radius:12px;font-size:13px;
        border:none;color:var(--dsw-alias-label-secondary);text-decoration:none;white-space:nowrap}
      .wkn-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .wkn-stats{display:flex;gap:16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;align-items:center}
      .wkn-section-title{display:flex;align-items:center;gap:6px;margin-top:20px;margin-bottom:4px;
        font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
      .wkn-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin-top:10px}
      .wkn-kb{display:flex;flex-direction:column;gap:6px;min-height:112px;padding:16px;border-radius:20px;
        cursor:pointer;text-align:left;color:inherit;font:inherit;
        border:1px solid var(--dsw-alias-border-l2);background:transparent}
      .wkn-kb:hover{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-interactive-bg-hover)}
      .wkn-kb-name{display:flex;align-items:center;gap:8px;font-size:14px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
      .wkn-kb-desc{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow:hidden;
        display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
      .wkn-kb-foot{display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:8px;
        color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
      .wkn-table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px;table-layout:auto}
      .wkn-table th{text-align:left;font-weight:400;white-space:nowrap;padding:10px 12px;
        color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;
        border-bottom:1px solid var(--dsw-alias-border-l2)}
      .wkn-table td{padding:12px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle;font-size:13px;line-height:20px}
      .wkn-table tbody tr{cursor:pointer}
      .wkn-table tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}
      .wkn-nowrap{white-space:nowrap;color:var(--dsw-alias-label-secondary)}
      .wkn-cell-name{display:flex;align-items:center;gap:9px;min-width:0}
      .wkn-cell-name > span:last-child{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .wkn-filetype{flex:0 0 auto;width:34px;height:22px;border-radius:6px;font-size:10px;font-weight:600;
        display:inline-flex;align-items:center;justify-content:center;letter-spacing:.02em;
        border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary)}
      .wkn-empty{color:var(--dsw-alias-label-tertiary);margin:16px 0;font-size:13px;line-height:20px}
      .wkn-crumbs{display:flex;align-items:center;gap:8px;margin-bottom:8px}
      .wkn-drop-overlay{position:absolute;inset:0;z-index:70;pointer-events:none;display:flex;
        align-items:center;justify-content:center;padding:24px;
        background:color-mix(in srgb,var(--dsw-alias-bg-base) 80%,transparent)}
      .wkn-drop-card{display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;
        width:100%;height:100%;border:2px dashed #4176e6;border-radius:20px;
        background:color-mix(in srgb,#4176e6 4%,transparent);color:var(--dsw-alias-label-primary)}
      .wkn-drop-title{font-size:16px;line-height:24px;font-weight:500}
      .wkn-drop-inline{white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
      .wkn-modal-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;
        padding:24px;background:var(--dsw-alias-bg-mask-2,#0003)}
      .wkn-modal{width:min(720px,94vw);max-height:86vh;display:flex;flex-direction:column;border-radius:28px;
        border:none;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
        box-shadow:0 0 0 .5px rgba(0,0,0,.16),0 3px 8px rgba(0,0,0,.04),0 0 20px rgba(0,0,0,.05);overflow:hidden}
      .wkn-modal-head{display:flex;align-items:center;gap:10px;padding:20px 24px 0}
      .wkn-modal-title{font-size:16px;line-height:24px;font-weight:500}
      .wkn-modal-body{padding:16px 24px;overflow:auto;display:flex;flex-direction:column;gap:12px}
      .wkn-modal-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:16px 24px 24px}
      .wkn-modal .wkn-input,.wkn-modal .wkn-select{height:36px}
      .wkn-field{display:flex;flex-direction:column;gap:6px}
      .wkn-field > label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
      .wkn-textarea{width:100%;min-height:240px;padding:10px 12px;border-radius:12px;resize:vertical;
        border:1px solid var(--dsw-alias-border-l3);background:transparent;color:inherit;outline:none;
        font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.65}
      .wkn-textarea:focus{border-color:#4176e6;box-shadow:0 0 0 .5px #4176e6 inset}
      .wkn-hint{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
      .wkn-actions-cell{display:flex;gap:4px;justify-content:flex-end;white-space:nowrap}
      .wkn-danger{color:var(--dsw-alias-state-error-primary)}
      .wkn-agent-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-top:10px}
      .wkn-agent{display:flex;flex-direction:column;gap:4px;padding:12px 14px;border-radius:20px;text-align:left;
        border:1px solid var(--dsw-alias-border-l2);background:transparent;
        color:inherit;font:inherit;cursor:pointer}
      .wkn-agent:hover{border-color:var(--dsw-alias-border-l4)}
      .wkn-agent[data-on="true"]{border-color:var(--dsw-alias-label-primary);
        box-shadow:0 0 0 1px var(--dsw-alias-label-primary) inset}
      .wkn-agent-name{display:flex;align-items:center;gap:7px;font-weight:500;font-size:14px;line-height:20px}
      .wkn-agent-desc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow:hidden;
        display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
      .wkn-chat{display:flex;flex-direction:column;gap:14px;margin-top:14px}
      .wkn-msg{display:flex;flex-direction:column;gap:6px;max-width:100%}
      .wkn-msg[data-role="user"]{align-self:flex-end;max-width:78%;padding:9px 13px;border-radius:12px;
        background:var(--dsw-alias-interactive-bg-hover);white-space:pre-wrap;overflow-wrap:anywhere}
      .wkn-msg[data-role="assistant"]{align-self:stretch;padding:14px 16px;border-radius:20px;
        border:1px solid var(--dsw-alias-border-l2);background:transparent}
      .wkn-msg-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
      .wkn-cite{display:flex;flex-direction:column;gap:3px;margin-top:8px;padding-top:8px;
        border-top:1px dashed var(--dsw-alias-border-l2)}
      .wkn-cite-title{font-size:13px;line-height:20px;font-weight:500}
      .wkn-modal-wide{width:min(860px,95vw)}
      .wkn-drop{display:flex;align-items:center;justify-content:center;gap:8px;min-height:88px;border-radius:12px;
        border:1px dashed var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);font-size:13px;
        cursor:pointer;text-align:center;padding:14px}
      .wkn-drop:hover{background:var(--dsw-alias-interactive-bg-hover)}
    `;

    /**
     * Styles for the workspace-file upload shortcut. It renders outside the
     * knowledge panel, so it carries its own small stylesheet and uses the same
     * DSH tokens the panel uses.
     */
    const HEADER_STYLES = `
      .wkn-up-root{position:relative;display:inline-flex;align-items:center}
      .wkn-up-btn{height:24px;min-width:24px;padding:0 4px;border:none;border-radius:9px;
        background:transparent;color:var(--dsw-alias-label-secondary);display:inline-flex;
        align-items:center;justify-content:center;gap:4px;font:inherit;font-size:12px;
        line-height:20px;cursor:pointer}
      .wkn-up-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .wkn-up-btn:disabled{opacity:.5;cursor:default}
      .wkn-up-btn[data-variant="empty"]{height:32px;padding:0 12px;border-radius:12px;
        font-size:14px;line-height:22px;border:1px solid var(--dsw-alias-border-l3)}
      .wkn-up-btn[data-variant="empty"]:hover{border-color:var(--dsw-alias-border-l4)}
      .wkn-up-menu{position:fixed;z-index:120;width:268px;max-height:340px;overflow:auto;
        padding:6px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);
        background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
        box-shadow:rgba(0,0,0,.16) 0 0 0 .5px,rgba(0,0,0,.04) 0 3px 8px,rgba(0,0,0,.05) 0 0 20px;
        font-size:13px;line-height:20px}
      .wkn-up-label{padding:6px 8px 4px;font-size:12px;line-height:20px;
        color:var(--dsw-alias-label-tertiary)}
      .wkn-up-item{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 8px;
        border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);
        font:inherit;font-size:13px;line-height:20px;cursor:pointer;text-align:left}
      .wkn-up-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .wkn-up-item:disabled{opacity:.55;cursor:default}
      .wkn-up-item-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .wkn-up-item-meta{flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-tertiary)}
      .wkn-up-state{padding:8px;color:var(--dsw-alias-label-tertiary);font-size:13px;
        line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}
      .wkn-up-state[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}
      .wkn-up-state[data-kind="ok"]{color:var(--dsw-alias-label-secondary)}
      .wkn-up-foot{display:flex;gap:6px;margin-top:4px;padding-top:6px;
        border-top:1px solid var(--dsw-alias-border-l1)}
      .wkn-up-foot button{flex:1 1 auto;height:32px;border:none;border-radius:12px;
        background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;
        font-size:12px;cursor:pointer}
      .wkn-up-foot button:hover{background:var(--dsw-alias-interactive-bg-hover);
        color:var(--dsw-alias-label-primary)}
    `;


    //#endregion
    //#region page

    /**
     * One knowledge-base selector chip.
     * @param props - Chip props.
     * @returns Button element.
     */
    function KbChip({ kb, on, onToggle }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'wkn-chip',
          'data-on': on ? 'true' : 'false',
          title: kb.description || kb.name,
          onClick: () => onToggle(kb.id),
        },
        h('span', null, kb.name),
      );
    }

    /**
     * One retrieval hit.
     * @param props - Result, handlers, and translated labels.
     * @returns Card element.
     */
    function ResultCard({ result, onCopy, onAsk, labels }) {
      const score = typeof result.score === 'number' ? result.score.toFixed(3) : undefined;
      return h(
        'div',
        { className: 'wkn-card' },
        h(
          'div',
          { className: 'wkn-card-head' },
          h('span', { className: 'wkn-card-title' }, result.title),
          score !== undefined ? h('span', { className: 'wkn-score' }, `score ${score}`) : null,
        ),
        result.kbId ? h('div', { className: 'wkn-meta' }, result.kbId) : null,
        h('pre', { className: 'wkn-text' }, result.content || '（无正文）'),
        h(
          'div',
          { className: 'wkn-actions' },
          h(
            'button',
            { type: 'button', className: 'wkn-btn', onClick: () => onCopy(result) },
            labels.copy,
          ),
          onAsk
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'wkn-btn',
                  'data-variant': 'primary',
                  onClick: () => onAsk(result),
                },
                labels.ask,
              )
            : null,
        ),
      );
    }

    /**
     * One knowledge base card, mirroring the WeKnora list card: name, optional
     * kind badge, description, and a footer of file count and last update.
     * @param props - Knowledge base, open handler, and translated labels.
     * @returns Card element.
     */
    function KnowledgeCard({ kb, onOpen, labels }) {
      const kind = kbKindLabel(kb);
      return h(
        'button',
        { type: 'button', className: 'wkn-kb', onClick: () => onOpen(kb) },
        h('span', { className: 'wkn-kb-name' }, kb.name, kind === '' ? null : h('span', { className: 'wkn-badge' }, kind)),
        kb.description === '' ? null : h('span', { className: 'wkn-kb-desc' }, kb.description),
        h(
          'span',
          { className: 'wkn-kb-foot' },
          kb.count === undefined ? null : h('span', null, labels.fileCount(kb.count)),
          h('span', { className: 'wkn-spacer' }),
          kb.updatedAt === '' ? null : h('span', null, relativeTime(kb.updatedAt)),
        ),
      );
    }

    /**
     * One document row of the knowledge base table.
     * @param props - Document, open handler, and translated labels.
     * @returns Table row element.
     */
    function DocumentRow({ doc, onOpen, labels, actions }) {
      const status = PARSE_LABELS[doc.status] ?? doc.status;
      const stop = (handler) => (event) => {
        event.stopPropagation();
        handler(doc);
      };
      return h(
        'tr',
        { onClick: () => onOpen(doc) },
        h(
          'td',
          null,
          h(
            'span',
            { className: 'wkn-cell-name' },
            h('span', { className: 'wkn-filetype' }, (doc.fileType || '?').slice(0, 4).toUpperCase()),
            h('span', { title: doc.folder === '' ? doc.title : `${doc.folder}/${doc.title}` }, doc.title),
          ),
        ),
        h('td', null, status === '' ? null : h('span', { className: 'wkn-badge', 'data-state': doc.status }, status)),
        h('td', { className: 'wkn-nowrap' }, formatSize(doc.size)),
        h('td', null, doc.fileType === '' ? null : h('span', { className: 'wkn-badge' }, doc.fileType.toLowerCase())),
        h('td', { className: 'wkn-nowrap' }, labels.source(doc.source)),
        h('td', { className: 'wkn-nowrap' }, relativeTime(doc.updatedAt) || shortDate(doc.updatedAt)),
        h(
          'td',
          null,
          actions === undefined
            ? null
            : h(
                'span',
                { className: 'wkn-actions-cell' },
                actions.edit !== undefined && (doc.source === 'manual' || doc.type === 'manual')
                  ? h(
                      'button',
                      { type: 'button', className: 'wkn-btn', onClick: stop(actions.edit) },
                      labels.edit,
                    )
                  : null,
                h(
                  'button',
                  { type: 'button', className: 'wkn-btn', onClick: stop(actions.reparse) },
                  labels.reparse,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'wkn-btn wkn-danger',
                    onClick: stop(actions.remove),
                  },
                  labels.remove,
                ),
              ),
        ),
      );
    }

    /**
     * Normalize one parsed chunk for display.
     * @param chunk - Raw `Chunk` row.
     * @returns Renderable chunk.
     */
    function readChunk(chunk) {
      return {
        id: String(chunk?.id ?? ''),
        index: Number.isFinite(chunk?.chunk_index) ? chunk.chunk_index : undefined,
        type: typeof chunk?.chunk_type === 'string' ? chunk.chunk_type : 'text',
        enabled: chunk?.is_enabled !== false,
        content: String(chunk?.content ?? ''),
        // Optimistic-concurrency token: the save is rejected with 409 when the
        // stored revision moved on, so it has to travel with every edit.
        revision: Number.isFinite(chunk?.content_revision) ? chunk.content_revision : undefined,
      };
    }

    /**
     * Build the optimistic-concurrency save for one chunk.
     *
     * `PUT /api/v1/chunks/:knowledge_id/:id`. The panel sends `expected_revision`
     * whenever the row carried one, so a concurrent edit fails loudly instead of
     * silently overwriting somebody else's text.
     *
     * @param knowledgeId - Parent knowledge item id.
     * @param chunk - Chunk being edited.
     * @param content - New Markdown content.
     * @returns Path, method, and request body.
     */
    function chunkSaveRequest(knowledgeId, chunk, content) {
      return {
        path: `/api/v1/chunks/${encodeURIComponent(knowledgeId)}/${encodeURIComponent(chunk.id)}`,
        method: 'PUT',
        body: {
          content,
          ...(chunk.revision === undefined ? {} : { expected_revision: chunk.revision }),
        },
      };
    }

    /** Only `text` chunks are editable; every other type answers 400. */
    function isEditableChunk(chunk) {
      return chunk.type === 'text';
    }

    //#endregion
    //#region markdown

    /** URL schemes a link in upstream content may use. */
    const SAFE_URL = /^(https?:\/\/|mailto:)/i;

    /**
     * Accept a link target only when it cannot execute script.
     * @param url - Raw target.
     * @returns The URL, or undefined when it is not allowed.
     */
    function safeUrl(url) {
      return SAFE_URL.test(url) ? url : undefined;
    }

    /**
     * Split one line of Markdown into React nodes.
     *
     * Nothing here is ever handed to `dangerouslySetInnerHTML`, so upstream
     * text (including raw HTML) arrives as text nodes and is escaped by React.
     * The subset is deliberately small: code, bold, italic, strikethrough and
     * links.
     *
     * @param text - Raw line.
     * @param keyPrefix - Stable key prefix for the produced nodes.
     * @returns Array of strings and elements.
     */
    function renderInline(text, keyPrefix) {
      const nodes = [];
      const pattern =
        /(!\[[^\]]*\]\([^)\s]+\))|(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))/g;
      let cursor = 0;
      let index = 0;
      let match = pattern.exec(text);
      while (match !== null) {
        if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
        const token = match[0];
        const key = `${keyPrefix}-${index}`;
        index += 1;
        if (token.startsWith('![')) {
          // An image is never turned into a `<img>`: it would load an upstream
          // src, and WeKnora rejects edits that introduce new image URLs. The
          // alt text is shown instead.
          const alt = /^!\[([^\]]*)\]/.exec(token);
          nodes.push(h('span', { className: 'wkn-md-image', key }, alt[1] === '' ? '[image]' : alt[1]));
        } else if (token.startsWith('`')) {
          nodes.push(h('code', { className: 'wkn-md-code', key }, token.slice(1, -1)));
        } else if (token.startsWith('**') || token.startsWith('__')) {
          nodes.push(h('strong', { key }, token.slice(2, -2)));
        } else if (token.startsWith('~~')) {
          nodes.push(h('del', { key }, token.slice(2, -2)));
        } else if (token.startsWith('*') || token.startsWith('_')) {
          nodes.push(h('em', { key }, token.slice(1, -1)));
        } else {
          const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
          const target = link === null ? undefined : safeUrl(link[2]);
          nodes.push(
            target === undefined
              ? h('span', { key }, link === null ? token : link[1])
              : h('a', { className: 'wkn-md-link', key, href: target, target: '_blank', rel: 'noreferrer' }, link[1]),
          );
        }
        cursor = match.index + token.length;
        match = pattern.exec(text);
      }
      if (cursor < text.length) nodes.push(text.slice(cursor));
      return nodes;
    }

    /**
     * Group Markdown source into block-level records.
     * @param source - Raw Markdown.
     * @returns Block records.
     */
    function parseMarkdown(source) {
      const lines = String(source ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n');
      const blocks = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        const fence = /^\s*(```|~~~)\s*(\S*)\s*$/.exec(line);
        if (fence !== null) {
          const marker = fence[1];
          const body = [];
          i += 1;
          while (i < lines.length && !new RegExp(`^\\s*${marker}`).test(lines[i])) {
            body.push(lines[i]);
            i += 1;
          }
          i += 1;
          blocks.push({ kind: 'code', lang: fence[2], text: body.join('\n') });
          continue;
        }
        if (/^\s*$/.test(line)) {
          i += 1;
          continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading !== null) {
          blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
          i += 1;
          continue;
        }
        if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
          blocks.push({ kind: 'rule' });
          i += 1;
          continue;
        }
        const splitRow = (row) =>
          row
            .trim()
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((cell) => cell.trim());
        if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
          const header = splitRow(line);
          i += 2;
          const rows = [];
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
            rows.push(splitRow(lines[i]));
            i += 1;
          }
          blocks.push({ kind: 'table', header, rows });
          continue;
        }
        if (/^\s*>\s?/.test(line)) {
          const quoted = [];
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            quoted.push(lines[i].replace(/^\s*>\s?/, ''));
            i += 1;
          }
          blocks.push({ kind: 'quote', text: quoted.join('\n') });
          continue;
        }
        const bullets = /^\s*[-*+]\s+(.*)$/;
        if (bullets.test(line)) {
          const items = [];
          while (i < lines.length && bullets.test(lines[i])) {
            items.push(bullets.exec(lines[i])[1]);
            i += 1;
          }
          blocks.push({ kind: 'list', ordered: false, items });
          continue;
        }
        const numbers = /^\s*\d+[.)]\s+(.*)$/;
        if (numbers.test(line)) {
          const items = [];
          while (i < lines.length && numbers.test(lines[i])) {
            items.push(numbers.exec(lines[i])[1]);
            i += 1;
          }
          blocks.push({ kind: 'list', ordered: true, items });
          continue;
        }
        const paragraph = [line];
        i += 1;
        while (
          i < lines.length &&
          !/^\s*$/.test(lines[i]) &&
          !/^\s*(#{1,6}\s|>|```|~~~|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])
        ) {
          paragraph.push(lines[i]);
          i += 1;
        }
        blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
      }
      return blocks;
    }

    /**
     * Render Markdown as React elements.
     *
     * A hand-written subset, because the harness forbids a client plugin from
     * importing another harness client package (whose markdown component would
     * otherwise be the obvious choice). Raw HTML in the source is shown as text.
     *
     * @param props - `text` holding the Markdown source.
     * @returns Container element.
     */
    function Markdown({ text }) {
      const blocks = parseMarkdown(text);
      return h(
        'div',
        { className: 'wkn-md' },
        blocks.map((block, position) => {
          const key = `b${position}`;
          if (block.kind === 'code') {
            return h('pre', { key }, h('code', null, block.text));
          }
          if (block.kind === 'heading') {
            return h(`h${block.level}`, { key }, renderInline(block.text, key));
          }
          if (block.kind === 'rule') {
            return h('hr', { key });
          }
          if (block.kind === 'quote') {
            return h('blockquote', { key }, renderInline(block.text, key));
          }
          if (block.kind === 'list') {
            return h(
              block.ordered ? 'ol' : 'ul',
              { key },
              block.items.map((item, itemIndex) => h('li', { key: `${key}-${itemIndex}` }, renderInline(item, `${key}-${itemIndex}`))),
            );
          }
          if (block.kind === 'table') {
            return h(
              'table',
              { key },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  block.header.map((cell, cellIndex) =>
                    h('th', { key: `${key}-h${cellIndex}` }, renderInline(cell, `${key}-h${cellIndex}`)),
                  ),
                ),
              ),
              h(
                'tbody',
                null,
                block.rows.map((row, rowIndex) =>
                  h(
                    'tr',
                    { key: `${key}-r${rowIndex}` },
                    row.map((cell, cellIndex) =>
                      h('td', { key: `${key}-r${rowIndex}c${cellIndex}` }, renderInline(cell, `${key}-r${rowIndex}c${cellIndex}`)),
                    ),
                  ),
                ),
              ),
            );
          }
          // A paragraph keeps its soft line breaks, which matters for the
          // line-oriented text most documents are parsed into.
          const pieces = block.text.split('\n');
          return h(
            'p',
            { key },
            pieces.flatMap((piece, pieceIndex) =>
              pieceIndex === 0 ? renderInline(piece, `${key}-${pieceIndex}`) : [h('br', { key: `${key}-br${pieceIndex}` }), ...renderInline(piece, `${key}-${pieceIndex}`)],
            ),
          );
        }),
      );
    }

    //#endregion

    /**
     * Document detail: the parsed content that retrieval actually indexes, plus
     * the original file rendered according to its real media type.
     * @param props - Document, settings, environment, notice sink, close handler.
     * @returns Card element.
     */
    function DocumentPanel(props) {
      const { doc, settings, env, notify, onClose } = props;
      const t = env.text;
      const [mode, setMode] = useState('chunks');
      const [chunks, setChunks] = useState(null);
      const [file, setFile] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      /** Chunk being edited: `{ id, text }`, or null when nothing is open. */
      const [editing, setEditing] = useState(null);
      const [saving, setSaving] = useState(false);
      /** Object URL of the currently displayed original file, released on swap. */
      const asset = useRef(null);

      const release = useCallback(() => {
        if (asset.current !== null) {
          globalThis.URL?.revokeObjectURL(asset.current);
          asset.current = null;
        }
      }, []);

      useEffect(() => release, [release]);

      const loadChunks = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const payload = await call(`/api/v1/chunks/${encodeURIComponent(doc.id)}?page=1&page_size=50`, { settings });
          const rows = Array.isArray(payload?.data) ? payload.data.map(readChunk) : [];
          setChunks({ rows, total: Number.isFinite(payload?.total) ? payload.total : rows.length });
        } catch (failure) {
          setChunks(null);
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      }, [doc.id, settings]);

      const loadFile = useCallback(async () => {
        setBusy(true);
        setError(null);
        release();
        try {
          const reply = await callBlob(`/api/v1/knowledge/${encodeURIComponent(doc.id)}/preview`, settings);
          const name = fileNameFrom(reply.disposition, doc.title);
          const kind = classifyContent(reply.contentType, name);
          if (kind === 'text') {
            const decoded = decodeText(reply.buffer, reply.contentType);
            // Only an HTML document gets its markup stripped; a Markdown or
            // source file may legitimately contain tag-like text in a sample.
            const html = /html/i.test(reply.contentType) || /\.x?html?$/i.test(name);
            setFile({ kind, name, contentType: reply.contentType, text: html ? stripMarkup(decoded) : decoded });
            return;
          }
          const url = globalThis.URL.createObjectURL(
            new Blob([reply.buffer], { type: reply.contentType || 'application/octet-stream' }),
          );
          asset.current = url;
          setFile({ kind, name, contentType: reply.contentType, url });
        } catch (failure) {
          setFile(null);
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      }, [doc.id, doc.title, release, settings]);

      useEffect(() => {
        setChunks(null);
        setFile(null);
        setError(null);
        setEditing(null);
        release();
        if (mode === 'chunks') void loadChunks();
        else void loadFile();
      }, [mode, loadChunks, loadFile, release]);

      const copyChunk = useCallback(
        async (chunk) => {
          try {
            await globalThis.navigator?.clipboard?.writeText(chunk.content);
            notify({ kind: 'ok', text: t('copied') });
          } catch {
            notify({ kind: 'error', text: t('copyFailed') });
          }
        },
        [notify, t],
      );

      const askWithChunk = useCallback(
        async (chunk) => {
          try {
            await env.sendToConversation(
              t('askChunkTemplate', { title: doc.title, content: chunk.content.slice(0, 4000) }),
            );
            notify({ kind: 'ok', text: t('sent') });
          } catch (failure) {
            notify({ kind: 'error', text: failure instanceof Error ? failure.message : String(failure) });
          }
        },
        [doc.title, env, notify, t],
      );

      /** Commit one edited chunk back to WeKnora. */
      const saveChunk = useCallback(
        async (chunk, content) => {
          const request = chunkSaveRequest(doc.id, chunk, content);
          setSaving(true);
          try {
            const payload = await call(request.path, { method: request.method, settings, body: request.body });
            const updated = readChunk(payload?.data ?? {});
            setChunks((current) =>
              current === null
                ? current
                : {
                    ...current,
                    rows: current.rows.map((row) =>
                      row.id === chunk.id
                        ? {
                            ...row,
                            content: updated.content === '' ? content : updated.content,
                            revision: updated.revision ?? row.revision,
                          }
                        : row,
                    ),
                  },
            );
            setEditing(null);
            notify({
              kind: 'ok',
              text: payload?.summary_status === undefined ? t('saved') : t('savedSummary', { status: payload.summary_status }),
            });
          } catch (failure) {
            const status = failure?.status;
            if (status === 409) notify({ kind: 'error', text: t('saveConflict') });
            else if (status === 403) notify({ kind: 'error', text: t('saveForbidden') });
            else if (status === 503) {
              // The hint alone hid the evidence, which made this impossible to
              // diagnose; the raw request/body detail travels with it now.
              notify({ kind: 'error', text: `${t('saveUnavailable')}\n\n${failure.message}` });
            } else notify({ kind: 'error', text: failure instanceof Error ? failure.message : String(failure) });
          } finally {
            setSaving(false);
          }
        },
        [doc.id, notify, settings, t],
      );

      const body = () => {
        if (busy) return h('div', { className: 'wkn-empty' }, t('loading'));
        if (error !== null) return h('div', { className: 'wkn-note', 'data-kind': 'error' }, error);
        if (mode === 'chunks') {
          if (chunks === null) return null;
          if (chunks.rows.length === 0) return h('div', { className: 'wkn-empty' }, t('noChunks'));
          return h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'wkn-row', style: { marginBottom: '8px' } },
              h('span', { className: 'wkn-meta' }, t('chunkCount', { count: chunks.total })),
              h('div', { className: 'wkn-spacer' }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wkn-btn',
                  disabled: busy || saving,
                  onClick: () => {
                    setEditing(null);
                    void loadChunks();
                  },
                },
                t('reload'),
              ),
            ),
            chunks.rows.map((chunk, position) => {
              const editingThis = editing !== null && editing.id === chunk.id;
              return h(
                'div',
                { className: 'wkn-chunk', key: chunk.id === '' ? String(position) : chunk.id },
                h(
                  'div',
                  { className: 'wkn-chunk-head' },
                  h('span', { className: 'wkn-meta' }, t('chunkIndex', { index: chunk.index ?? position + 1 })),
                  h('span', { className: 'wkn-badge' }, chunk.type),
                  chunk.enabled ? null : h('span', { className: 'wkn-badge', 'data-state': 'failed' }, t('chunkDisabled')),
                  chunk.revision === undefined ? null : h('span', { className: 'wkn-meta' }, t('revision', { value: chunk.revision })),
                  h('div', { className: 'wkn-spacer' }),
                  editingThis
                    ? h(
                        React.Fragment,
                        null,
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'wkn-btn',
                            'data-variant': 'primary',
                            disabled: saving || editing.text.trim() === '',
                            onClick: () => void saveChunk(chunk, editing.text),
                          },
                          saving ? t('saving') : t('saveEdit'),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'wkn-btn',
                            disabled: saving,
                            onClick: () => setEditing(null),
                          },
                          t('cancel'),
                        ),
                      )
                    : h(
                        React.Fragment,
                        null,
                        h(
                          'button',
                          { type: 'button', className: 'wkn-btn', onClick: () => void copyChunk(chunk) },
                          t('copy'),
                        ),
                        isEditableChunk(chunk)
                          ? h(
                              'button',
                              {
                                type: 'button',
                                className: 'wkn-btn',
                                onClick: () => {
                                  notify(null);
                                  setEditing({ id: chunk.id, text: chunk.content });
                                },
                              },
                              t('edit'),
                            )
                          : h('span', { className: 'wkn-meta', title: t('notEditable') }, t('notEditable')),
                        env.canSend()
                          ? h(
                              'button',
                              {
                                type: 'button',
                                className: 'wkn-btn',
                                'data-variant': 'primary',
                                onClick: () => void askWithChunk(chunk),
                              },
                              t('ask'),
                            )
                          : null,
                      ),
                ),
                editingThis
                  ? h('textarea', {
                      className: 'wkn-editor',
                      value: editing.text,
                      spellCheck: false,
                      disabled: saving,
                      onChange: (event) => setEditing({ id: chunk.id, text: event.target.value }),
                    })
                  : chunk.content === ''
                    ? h('div', { className: 'wkn-empty' }, t('emptyChunk'))
                    : h(Markdown, { text: chunk.content }),
              );
            }),
          );
        }
        if (file === null) return null;
        if (file.kind === 'text') {
          return h('pre', { className: 'wkn-text' }, file.text === '' ? t('emptyFile') : file.text);
        }
        if (file.kind === 'image') {
          return h(
            React.Fragment,
            null,
            h('img', { className: 'wkn-img', src: file.url, alt: file.name }),
            h(
              'div',
              { className: 'wkn-actions' },
              h('a', { className: 'wkn-link', href: file.url, download: file.name }, t('download')),
              h('a', { className: 'wkn-link', href: file.url, target: '_blank', rel: 'noreferrer' }, t('openExternal')),
            ),
          );
        }
        if (file.kind === 'pdf') {
          return h(
            React.Fragment,
            null,
            h('iframe', { className: 'wkn-frame', src: file.url, title: file.name }),
            h(
              'div',
              { className: 'wkn-actions' },
              h('a', { className: 'wkn-link', href: file.url, target: '_blank', rel: 'noreferrer' }, t('openExternal')),
              h('a', { className: 'wkn-link', href: file.url, download: file.name }, t('download')),
            ),
          );
        }
        return h(
          React.Fragment,
          null,
          h('div', { className: 'wkn-note' }, t('binaryNotice', { type: file.contentType || t('unknownType') })),
          h(
            'div',
            { className: 'wkn-actions' },
            h('a', { className: 'wkn-link', href: file.url, download: file.name }, t('download')),
            h('a', { className: 'wkn-link', href: file.url, target: '_blank', rel: 'noreferrer' }, t('openExternal')),
          ),
        );
      };

      return h(
        'div',
        { className: 'wkn-card' },
        h(
          'div',
          { className: 'wkn-card-head' },
          h('span', { className: 'wkn-card-title' }, doc.title),
          h('div', { className: 'wkn-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'wkn-tab',
              'data-on': mode === 'chunks' ? 'true' : 'false',
              onClick: () => setMode('chunks'),
            },
            t('tabChunks'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'wkn-tab',
              'data-on': mode === 'file' ? 'true' : 'false',
              onClick: () => setMode('file'),
            },
            t('tabFile'),
          ),
          h('button', { type: 'button', className: 'wkn-btn', onClick: onClose }, t('back')),
        ),
        body(),
      );
    }

    /**
     * One modal shell used by the dialogs below.
     * @param props - `{title, onClose, children, footer, wide}`.
     * @returns Dialog element.
     */
    function Modal({ title, onClose, children, footer, wide }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        globalThis.addEventListener?.('keydown', onKey);
        return () => globalThis.removeEventListener?.('keydown', onKey);
      }, [onClose]);
      return h(
        'div',
        {
          className: 'wkn-modal-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          { className: `wkn-modal${wide ? ' wkn-modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
          h(
            'div',
            { className: 'wkn-modal-head' },
            h('span', { className: 'wkn-modal-title' }, title),
            h('div', { className: 'wkn-spacer' }),
            h('button', { type: 'button', className: 'wkn-btn', onClick: onClose }, '✕'),
          ),
          h('div', { className: 'wkn-modal-body' }, children),
          footer === undefined ? null : h('div', { className: 'wkn-modal-foot' }, footer),
        ),
      );
    }

    /**
     * Create-knowledge-base dialog.
     * @param props - `{t, busy, onClose, onSubmit}`.
     * @returns Dialog element.
     */
    function KnowledgeBaseDialog({ t, busy, onClose, onSubmit }) {
      const [name, setName] = useState('');
      const [description, setDescription] = useState('');
      const [type, setType] = useState('document');
      const submit = () => {
        if (name.trim() === '') return;
        onSubmit({ name: name.trim(), description: description.trim(), type });
      };
      return h(
        Modal,
        {
          title: t('kbCreateTitle'),
          onClose,
          footer: h(
            React.Fragment,
            null,
            h('button', { type: 'button', className: 'wkn-btn', onClick: onClose }, t('cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'wkn-btn',
                'data-variant': 'primary',
                disabled: busy || name.trim() === '',
                onClick: submit,
              },
              t('create'),
            ),
          ),
        },
        h(
          'div',
          { className: 'wkn-field' },
          h('label', null, t('fieldName')),
          h('input', {
            className: 'wkn-input',
            value: name,
            spellCheck: false,
            autoFocus: true,
            onChange: (event) => setName(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit();
            },
          }),
        ),
        h(
          'div',
          { className: 'wkn-field' },
          h('label', null, t('fieldDescription')),
          h('textarea', {
            className: 'wkn-textarea',
            style: { minHeight: '72px', fontFamily: 'inherit' },
            value: description,
            onChange: (event) => setDescription(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'wkn-field' },
          h('label', null, t('fieldType')),
          h(
            'select',
            { className: 'wkn-select', value: type, onChange: (event) => setType(event.target.value) },
            KB_TYPES.map((kind) => h('option', { key: kind.value, value: kind.value }, t(kind.labelKey))),
          ),
        ),
        h('div', { className: 'wkn-hint' }, t('kbCreateHint')),
      );
    }

    /**
     * Manual-article editor (create or edit). WeKnora stores manual knowledge as
     * Markdown with a draft/publish status; a draft stays out of retrieval.
     * @param props - `{t, busy, initial, onClose, onSubmit}`.
     * @returns Dialog element.
     */
    function ArticleEditor({ t, busy, initial, onClose, onSubmit }) {
      const [title, setTitle] = useState(String(initial?.title ?? ''));
      const [content, setContent] = useState(String(initial?.content ?? ''));
      const [status, setStatus] = useState(initial?.status === 'publish' ? 'publish' : 'draft');
      const submit = () => {
        if (title.trim() === '' || content.trim() === '') return;
        onSubmit({ title: title.trim(), content, status });
      };
      const dirty = title.trim() !== '' && content.trim() !== '';
      return h(
        Modal,
        {
          title: initial?.mode === 'edit' ? t('articleEditTitle') : t('articleCreateTitle'),
          onClose,
          wide: true,
          footer: h(
            React.Fragment,
            null,
            h(
              'select',
              { className: 'wkn-select', value: status, onChange: (event) => setStatus(event.target.value) },
              h('option', { value: 'draft' }, t('statusDraft')),
              h('option', { value: 'publish' }, t('statusPublish')),
            ),
            h('div', { className: 'wkn-spacer' }),
            h('button', { type: 'button', className: 'wkn-btn', onClick: onClose }, t('cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'wkn-btn',
                'data-variant': 'primary',
                disabled: busy || !dirty,
                onClick: submit,
              },
              busy ? t('saving') : t('saveArticle'),
            ),
          ),
        },
        h(
          'div',
          { className: 'wkn-field' },
          h('label', null, t('fieldTitle')),
          h('input', {
            className: 'wkn-input',
            value: title,
            spellCheck: false,
            autoFocus: true,
            onChange: (event) => setTitle(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'wkn-field' },
          h('label', null, t('fieldContent')),
          h('textarea', {
            className: 'wkn-textarea',
            value: content,
            spellCheck: false,
            onChange: (event) => setContent(event.target.value),
          }),
        ),
        h('div', { className: 'wkn-hint' }, t('articleHint')),
      );
    }

    /**
     * Import-from-URL dialog.
     * @param props - `{t, busy, onClose, onSubmit}`.
     * @returns Dialog element.
     */
    function UrlImportDialog({ t, busy, onClose, onSubmit }) {
      const [url, setUrl] = useState('');
      const [title, setTitle] = useState('');
      const submit = () => {
        if (url.trim() === '') return;
        onSubmit({ url: url.trim(), title: title.trim() });
      };
      return h(
        Modal,
        {
          title: t('urlImportTitle'),
          onClose,
          footer: h(
            React.Fragment,
            null,
            h('button', { type: 'button', className: 'wkn-btn', onClick: onClose }, t('cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'wkn-btn',
                'data-variant': 'primary',
                disabled: busy || url.trim() === '',
                onClick: submit,
              },
              t('import'),
            ),
          ),
        },
        h(
          'div',
          { className: 'wkn-field' },
          h('label', null, t('fieldUrl')),
          h('input', {
            className: 'wkn-input',
            value: url,
            spellCheck: false,
            autoFocus: true,
            placeholder: 'https://…',
            onChange: (event) => setUrl(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit();
            },
          }),
        ),
        h(
          'div',
          { className: 'wkn-field' },
          h('label', null, t('fieldTitleOptional')),
          h('input', {
            className: 'wkn-input',
            value: title,
            spellCheck: false,
            onChange: (event) => setTitle(event.target.value),
          }),
        ),
        h('div', { className: 'wkn-hint' }, t('urlImportHint')),
      );
    }

    /**
     * Chat against the agent configured in WeKnora.
     *
     * The agent list comes from `GET /agents`; a smart-reasoning agent answers
     * through `POST /agent-chat` (server-side tools and citations), while a
     * quick-answer agent uses the RAG pipeline through `POST /knowledge-chat`.
     * The session id is kept so follow-up questions stay in one conversation.
     *
     * @param props - `{settings, kbs, checked, toggleKb, env, notify}`.
     * @returns Tab body element.
     */
    function AgentPanel({ settings, kbs, checked, toggleKb, env, notify }) {
      const t = env.text;
      const [agents, setAgents] = useState(null);
      const [agentId, setAgentId] = useState(String(settings.agentId ?? ''));
      const [query, setQuery] = useState('');
      const [messages, setMessages] = useState([]);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [sessionId, setSessionId] = useState('');
      const controller = useRef(null);
      const replyIndex = useRef(-1);

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const payload = await call('/api/v1/agents');
            if (!alive) return;
            const list = readAgents(payload);
            setAgents(list);
            setAgentId((previous) => {
              if (previous !== '' && list.some((agent) => agent.id === previous)) return previous;
              return list[0]?.id ?? '';
            });
          } catch (failure) {
            if (!alive) return;
            setAgents([]);
            notify({ kind: 'error', text: t('agentsUnavailable', { error: failure instanceof Error ? failure.message : String(failure) }) });
          }
        })();
        return () => {
          alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const selected = agents === null ? undefined : agents.find((agent) => agent.id === agentId);
      const smart = selected !== undefined && selected.mode !== 'quick-answer' && selected.mode !== '';
      const speakable = agents !== null;

      const updateReply = useCallback((patch) => {
        setMessages((previous) => {
          const index = replyIndex.current;
          if (index < 0 || index >= previous.length) return previous;
          const next = previous.slice();
          next[index] = { ...next[index], ...patch };
          return next;
        });
      }, []);

      const ask = useCallback(async () => {
        const question = query.trim();
        if (question === '' || busy) return;
        setBusy(true);
        setError(null);
        setQuery('');
        const abort = new AbortController();
        controller.current = abort;
        setMessages((previous) => {
          const next = [
            ...previous,
            { role: 'user', text: question },
            { role: 'assistant', text: '', references: [], status: 'streaming', toolCalls: 0 },
          ];
          replyIndex.current = next.length - 1;
          return next;
        });
        let session = sessionId;
        try {
          if (session === '') {
            const created = await call('/api/v1/sessions', {
              method: 'POST',
              body: { title: question.slice(0, 40) },
            });
            session = typeof created?.data?.id === 'string' ? created.data.id : '';
            if (session === '') throw new Error(t('sessionFailed'));
            setSessionId(session);
          }
          const endpoint = smart ? '/api/v1/agent-chat' : '/api/v1/knowledge-chat';
          const body = {
            query: question,
            agent_enabled: smart,
            ...(agentId === '' ? {} : { agent_id: agentId }),
            ...(checked.length === 0 ? {} : { knowledge_base_ids: checked }),
          };
          const result = await streamChat(
            `${endpoint}/${encodeURIComponent(session)}`,
            body,
            (_event, payload) => {
              const type = payload.response_type;
              if (type === 'answer' && typeof payload.content === 'string') {
                setMessages((previous) => {
                  const index = replyIndex.current;
                  if (index < 0 || index >= previous.length) return previous;
                  const next = previous.slice();
                  next[index] = { ...next[index], text: next[index].text + payload.content };
                  return next;
                });
              } else if (type === 'references') {
                const references = payload.knowledge_references ?? payload.data?.knowledge_references;
                if (Array.isArray(references)) updateReply({ references: references.map(readReference) });
              } else if (type === 'tool_call') {
                setMessages((previous) => {
                  const index = replyIndex.current;
                  if (index < 0 || index >= previous.length) return previous;
                  const next = previous.slice();
                  next[index] = { ...next[index], toolCalls: next[index].toolCalls + 1 };
                  return next;
                });
              } else if (type === 'error') {
                updateReply({ status: 'error' });
                setError(typeof payload.content === 'string' ? payload.content : t('chatError'));
              } else if (type === 'complete') {
                updateReply({ status: 'done' });
              }
            },
            abort.signal,
          );
          updateReply({
            text: result.text,
            references: result.references.map(readReference),
            status: result.error === undefined ? 'done' : 'error',
          });
          if (result.error !== undefined) setError(result.error);
        } catch (failure) {
          if ((failure instanceof DOMException || failure instanceof Error) && failure.name === 'AbortError') {
            updateReply({ status: 'done' });
          } else {
            setError(failure instanceof Error ? failure.message : String(failure));
            updateReply({ status: 'error' });
          }
        } finally {
          controller.current = null;
          setBusy(false);
        }
      }, [agentId, busy, checked, messages, query, sessionId, smart, t, updateReply]);

      const cancel = useCallback(() => {
        controller.current?.abort();
      }, []);

      const reset = useCallback(() => {
        if (busy) controller.current?.abort();
        setMessages([]);
        setSessionId('');
        setError(null);
      }, [busy]);

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'wkn-row' },
          h('span', { className: 'wkn-meta' }, t('agentHint')),
          h('div', { className: 'wkn-spacer' }),
          messages.length === 0
            ? null
            : h('button', { type: 'button', className: 'wkn-btn', onClick: reset }, t('newChat')),
        ),
        agents === null
          ? h('div', { className: 'wkn-empty' }, t('loading'))
          : agents.length === 0
            ? h('div', { className: 'wkn-empty' }, t('agentsEmpty'))
            : h(
                'div',
                { className: 'wkn-agent-grid' },
                agents.map((agent) =>
                  h(
                    'button',
                    {
                      key: agent.id,
                      type: 'button',
                      className: 'wkn-agent',
                      'data-on': agent.id === agentId ? 'true' : 'false',
                      onClick: () => setAgentId(agent.id),
                    },
                    h(
                      'span',
                      { className: 'wkn-agent-name' },
                      agent.avatar === '' ? null : h('span', null, agent.avatar),
                      h('span', null, agent.name),
                      agent.builtin ? h('span', { className: 'wkn-badge' }, t('builtin')) : null,
                    ),
                    h('span', { className: 'wkn-agent-desc' }, agent.description || t('agentNoDescription')),
                    h('span', { className: 'wkn-meta' }, agent.mode === 'quick-answer' ? t('agentModeRag') : t('agentModeReAct')),
                  ),
                ),
              ),
        kbs.length === 0
          ? null
          : h(
              'div',
              { className: 'wkn-chips' },
              kbs.map((kb) => h(KbChip, { key: kb.id, kb, on: checked.includes(kb.id), onToggle: toggleKb })),
            ),
        h(
          'div',
          { className: 'wkn-row', style: { marginTop: '12px' } },
          h('input', {
            className: 'wkn-input wkn-grow',
            placeholder: t('agentPlaceholder'),
            value: query,
            spellCheck: false,
            disabled: !speakable,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void ask();
              }
            },
          }),
          busy
            ? h('button', { type: 'button', className: 'wkn-btn', onClick: cancel }, t('stop'))
            : h(
                'button',
                {
                  type: 'button',
                  className: 'wkn-btn',
                  'data-variant': 'primary',
                  disabled: query.trim() === '' || !speakable,
                  onClick: () => void ask(),
                },
                t('send'),
              ),
        ),
        error === null ? null : h('div', { className: 'wkn-note', 'data-kind': 'error' }, error),
        h(
          'div',
          { className: 'wkn-chat' },
          messages.map((message, index) =>
            message.role === 'user'
              ? h('div', { className: 'wkn-msg', 'data-role': 'user', key: index }, message.text)
              : h(
                  'div',
                  { className: 'wkn-msg', 'data-role': 'assistant', key: index },
                  h(
                    'div',
                    { className: 'wkn-msg-head' },
                    h('span', null, selected?.name ?? t('weknoraAgent')),
                    message.status === 'streaming' ? h('span', null, t('thinking')) : null,
                    message.toolCalls > 0 ? h('span', null, t('toolCalls', { count: message.toolCalls })) : null,
                  ),
                  message.text === ''
                    ? h('div', { className: 'wkn-empty' }, message.status === 'streaming' ? t('thinking') : t('emptyAnswer'))
                    : h(Markdown, { text: message.text }),
                  message.references.length === 0
                    ? null
                    : h(
                        'div',
                        { className: 'wkn-cite' },
                        h('div', { className: 'wkn-meta' }, t('references')),
                        message.references.map((reference, citeIndex) =>
                          h(
                            'div',
                            { key: citeIndex },
                            h('div', { className: 'wkn-cite-title' }, `${citeIndex + 1}. ${reference.title}`),
                            reference.content === ''
                              ? null
                              : h('div', { className: 'wkn-text', style: { maxHeight: '120px' } }, reference.content),
                          ),
                        ),
                      ),
                  message.status === 'done' && message.text !== ''
                    ? h(
                        'div',
                        { className: 'wkn-actions' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'wkn-btn',
                            onClick: async () => {
                              try {
                                await globalThis.navigator?.clipboard?.writeText(message.text);
                                notify({ kind: 'ok', text: t('copied') });
                              } catch {
                                notify({ kind: 'error', text: t('copyFailed') });
                              }
                            },
                          },
                          t('copy'),
                        ),
                        env.canSend()
                          ? h(
                              'button',
                              {
                                type: 'button',
                                className: 'wkn-btn',
                                'data-variant': 'primary',
                                onClick: async () => {
                                  try {
                                    await env.sendToConversation(message.text);
                                    notify({ kind: 'ok', text: t('sent') });
                                  } catch (failure) {
                                    notify({ kind: 'error', text: failure instanceof Error ? failure.message : String(failure) });
                                  }
                                },
                              },
                              t('ask'),
                            )
                          : null,
                      )
                    : null,
                ),
          ),
        ),
      );
    }

    /** Canonical prefix the host parser and the @ menu share. */
    const KB_MENTION_PREFIX = 'weknora:kb/';
    /** User-text rule matching a canonical WeKnora mention in sent messages. */
    const KB_USER_TEXT_RULE = {
      id: 'weknora-kb',
      order: 25,
      match(text, from) {
        const pattern = /@\[([^\]\n]+)\]\(weknora:kb\/([^)\s]+)\)/gu;
        pattern.lastIndex = from;
        const match = pattern.exec(text);
        if (match === null) return undefined;
        let id = match[2];
        try {
          id = decodeURIComponent(id);
        } catch {
          /* keep the literal segment */
        }
        return {
          id: 'weknora-kb',
          start: match.index,
          end: match.index + match[0].length,
          data: { label: match[1], id },
        };
      },
    };

    /**
     * Canonical mention text inserted by the @ menu and read back by the host.
     * @param id - Knowledge-base id.
     * @param label - Display name (brackets/newlines are not representable).
     * @returns `@[name](weknora:kb/<encoded id>)`.
     */
    function formatKnowledgeBaseMention(id, label) {
      const safe = String(label ?? '')
        .replace(/[\]\[\r\n]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return `@[${safe === '' ? '知识库' : safe}](${KB_MENTION_PREFIX}${encodeURIComponent(String(id))})`;
    }

    /**
     * Project knowledge bases into trigger-menu rows for the current query.
     * @param items - Knowledge bases from the host.
     * @param query - Text after the `@` trigger.
     * @param t - Locale translator.
     * @returns Trigger menu rows.
     */
    function knowledgeBaseCandidates(items, query, t) {
      const needle = String(query ?? '').trim().toLowerCase();
      return items
        .filter((kb) => {
          if (needle === '') return true;
          return (
            kb.name.toLowerCase().includes(needle) ||
            String(kb.id).toLowerCase().includes(needle) ||
            (kb.description ?? '').toLowerCase().includes(needle)
          );
        })
        .slice(0, 12)
        .map((kb) => ({
          name: kb.name,
          description: t('mentionCount', { count: kb.count ?? 0 }),
          icon: PanelIcon,
          section: t('mentionSection'),
          value: JSON.stringify({ id: kb.id, name: kb.name }),
        }));
    }

    /**
     * Non-interactive chip for a WeKnora mention in a sent user message.
     * @param props - `{node, raw}` from the user-text renderer.
     * @returns Chip element.
     */
    function KnowledgeBaseMentionChip({ node, raw }) {
      return h(
        'span',
        { className: 'wkn-kb-mention', title: raw },
        h('style', null, KB_MENTION_STYLES),
        h(Glyph, { size: 12, path: 'M3.4 3.6c0-1.05 2.06-1.9 4.6-1.9s4.6.85 4.6 1.9v8.8c0 1.05-2.06 1.9-4.6 1.9s-4.6-.85-4.6-1.9z' }),
        h('span', { className: 'wkn-kb-mention-label' }, node?.data?.label ?? ''),
      );
    }

    /** Chip styling for a sent WeKnora mention (rendered outside the panel). */
    const KB_MENTION_STYLES = `
      .wkn-kb-mention{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 6px;
        border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);
        color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;vertical-align:baseline}
      .wkn-kb-mention svg{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
      .wkn-kb-mention-label{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    `;

    /** Upload glyph used by the workspace-file shortcut. */
    const UPLOAD_ICON =
      'M8 10.5V2.75M8 2.75 5.25 5.5M8 2.75l2.75 2.75M2.75 10.5v1.75c0 .55.45 1 1 1h8.5c.55 0 1-.45 1-1V10.5';

    /**
     * Workspace-file shortcut: a small header button that only expands a
     * knowledge-base picker; choosing a library uploads the previewed file
     * through the same proxy the panel uses.
     *
     * Bytes come from the harness's authenticated `/api/file` route, so the
     * plugin never reads a host path itself and the absolute path is not sent to
     * WeKnora. Inside the session cwd the relative path rides along as
     * `fileName`; outside it only the basename is used.
     *
     * @param props - Slot props (`absolutePath`, session props) + `env`/`variant`.
     * @returns Shortcut element.
     */
    function WorkspaceUploadAction(props) {
      const { absolutePath, sessionId, useSessions, env, variant } = props;
      const t = env.text;
      const [open, setOpen] = useState(false);
      const [kbs, setKbs] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);
      const [busyKb, setBusyKb] = useState(null);
      const [notice, setNotice] = useState(null);
      const [pos, setPos] = useState(null);
      const rootRef = useRef(null);
      const buttonRef = useRef(null);
      // Session-scoped slots receive `useSessions`; fall back to the basename
      // path when a deployment does not provide it.
      const cwd = typeof useSessions === 'function'
        ? useSessions((state) => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd))
        : undefined;

      const position = useCallback(() => {
        const button = buttonRef.current;
        if (button === null || typeof window === 'undefined') return;
        const rect = button.getBoundingClientRect();
        const width = 268;
        setPos({
          top: Math.round(rect.bottom + 6),
          left: Math.round(Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))),
        });
      }, []);

      const loadKbs = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
          const payload = await call('/api/v1/knowledge-bases');
          setKbs(readKnowledgeBases(payload));
        } catch (failure) {
          setKbs(null);
          setError(failure instanceof Error ? failure : new Error(String(failure)));
        } finally {
          setLoading(false);
        }
      }, []);

      const close = useCallback(() => setOpen(false), []);

      const toggle = useCallback(() => {
        if (open) {
          close();
          return;
        }
        setOpen(true);
        setNotice(null);
        setError(null);
        position();
        if (kbs === null && !loading) void loadKbs();
      }, [close, kbs, loading, loadKbs, open, position]);

      useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
          }
        };
        const onPointerDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) close();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKey, true);
        globalThis.addEventListener?.('resize', position);
        globalThis.addEventListener?.('scroll', position, true);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKey, true);
          globalThis.removeEventListener?.('resize', position);
          globalThis.removeEventListener?.('scroll', position, true);
        };
      }, [close, open, position]);

      const upload = useCallback(
        async (kb) => {
          if (busyKb !== null || typeof absolutePath !== 'string') return;
          setBusyKb(kb.id);
          setNotice(null);
          setError(null);
          try {
            // Resolve against document.baseURI so a deployment mounted under a
            // path prefix still reaches the harness file route.
            const fileUrl = new URL(`api/file?path=${encodeURIComponent(absolutePath)}`, document.baseURI);
            const response = await fetch(fileUrl.href, { credentials: 'same-origin' });
            if (!response.ok) {
              throw Object.assign(new Error(workspaceReadError(response.status, t)), { status: response.status });
            }
            const blob = await response.blob();
            const name = basenameOf(absolutePath);
            const relative = workspaceRelativePath(cwd, absolutePath);
            const form = new FormData();
            form.append('file', new File([blob], name, { type: blob.type || 'application/octet-stream' }), name);
            if (relative !== name) form.append('fileName', relative);
            await callForm(`/api/v1/knowledge-bases/${encodeURIComponent(kb.id)}/knowledge/file`, form);
            setNotice({ kind: 'ok', text: t('workspaceUploaded', { name: kb.name }) });
            env.notifyUploaded?.({ kbId: kb.id, fileName: relative });
            if (typeof setTimeout === 'function') setTimeout(() => setOpen(false), 1200);
          } catch (failure) {
            const status = failure?.status;
            if (status === 409) setError(new Error(t('workspaceDuplicate')));
            else if (status === 403) setError(new Error(t('workspaceNoIngest')));
            else setError(failure instanceof Error ? failure : new Error(String(failure)));
          } finally {
            setBusyKb(null);
          }
        },
        [absolutePath, busyKb, cwd, env, t],
      );

      if (typeof absolutePath !== 'string' || absolutePath === '') return null;

      const loadingLine = h('div', { key: 'loading', className: 'wkn-up-state' }, t('uploadLoading'));
      const errorLine = (failure) =>
        h('div', { key: 'error', className: 'wkn-up-state', 'data-kind': 'error' }, failure.message);
      const configFoot = h(
        'div',
        { key: 'config-foot', className: 'wkn-up-foot' },
        h('button', { type: 'button', onClick: () => void loadKbs() }, t('uploadRetry')),
        h(
          'button',
          {
            type: 'button',
            onClick: () => {
              close();
              env.openPanel?.();
            },
          },
          t('uploadOpenPanel'),
        ),
      );

      const items = [h('div', { key: 'title', className: 'wkn-up-label' }, t('uploadMenuTitle'))];
      if (loading) items.push(loadingLine);
      else if (error !== null && kbs === null) items.push(errorLine(error), configFoot);
      else if (kbs !== null && kbs.length === 0) {
        items.push(
          h('div', { key: 'empty', className: 'wkn-up-state' }, t('uploadNoKbs')),
          h(
            'div',
            { key: 'empty-foot', className: 'wkn-up-foot' },
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  close();
                  env.openPanel?.();
                },
              },
              t('uploadOpenPanel'),
            ),
          ),
        );
      } else if (kbs !== null) {
        items.push(
          ...kbs.map((kb) =>
            h(
              'button',
              {
                key: kb.id,
                type: 'button',
                role: 'menuitem',
                className: 'wkn-up-item',
                disabled: busyKb !== null,
                onClick: () => void upload(kb),
              },
              h('span', { className: 'wkn-up-item-name' }, kb.name),
              h(
                'span',
                { className: 'wkn-up-item-meta' },
                busyKb === kb.id ? t('uploadBusy') : t('uploadCount', { count: kb.count ?? 0 }),
              ),
            ),
          ),
        );
      }
      if (notice !== null) {
        items.push(
          h('div', { key: 'notice', className: 'wkn-up-state', 'data-kind': notice.kind }, notice.text),
        );
      }
      if (error !== null && kbs !== null) items.push(errorLine(error));

      return h(
        'div',
        { className: 'wkn-up-root', ref: rootRef },
        h('style', null, HEADER_STYLES),
        h(
          'button',
          {
            type: 'button',
            ref: buttonRef,
            className: 'wkn-up-btn',
            'data-variant': variant === 'empty' ? 'empty' : undefined,
            title: t('uploadToKb'),
            'aria-label': t('uploadToKb'),
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            disabled: busyKb !== null,
            onClick: toggle,
          },
          h(Glyph, { size: 16, path: UPLOAD_ICON }),
          variant === 'empty' ? h('span', null, t('uploadToKb')) : null,
        ),
        open
          ? h(
              'div',
              {
                className: 'wkn-up-menu',
                role: 'menu',
                style: pos === null ? { top: 0, left: 0 } : { top: `${pos.top}px`, left: `${pos.left}px` },
              },
              items,
            )
          : null,
      );
    }

    /**
     * The knowledge-base page rendered in the main area.
     * @param props - Slot props plus the injected environment.
     * @returns Page element.
     */
    function WeKnoraPage(props) {
      const env = props.env;
      const t = env.text;
      const [settings, setSettings] = useState({});
      const [draft, setDraft] = useState(() => draftFrom({}));
      const [configReady, setConfigReady] = useState(false);
      const [showSettings, setShowSettings] = useState(false);
      const [testing, setTesting] = useState(false);
      const [tab, setTab] = useState('kbs');

      const [kbs, setKbs] = useState([]);
      const [checked, setChecked] = useState([]);
      /** Knowledge base whose document table is open; null shows the list. */
      const [openKb, setOpenKb] = useState(null);

      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState(null);

      const [query, setQuery] = useState('');
      const [matchCount, setMatchCount] = useState(6);
      const [results, setResults] = useState(null);

      /** List-page search over knowledge bases and documents. */
      const [kbQuery, setKbQuery] = useState('');
      const [kbSearch, setKbSearch] = useState(null);

      const [docs, setDocs] = useState(null);
      const [docKeyword, setDocKeyword] = useState('');
      const [docPage, setDocPage] = useState(1);
      const [preview, setPreview] = useState(null);

      /** Knowledge-base creation dialog. */
      const [showCreateKb, setShowCreateKb] = useState(false);
      /** `{mode:'create'|'edit', kbId, doc?}` manual-article editor, or null. */
      const [articleEditor, setArticleEditor] = useState(null);
      /** URL import dialog open flag. */
      const [showUrlImport, setShowUrlImport] = useState(false);
      /** Human-readable progress while files upload. */
      const [uploading, setUploading] = useState(null);
      const uploadInput = useRef(null);
      /** Hidden directory picker; same path as dragging a folder. */
      const folderInput = useRef(null);
      /** True while files are dragged over the open knowledge base. */
      const [dragging, setDragging] = useState(false);
      /** enter/leave nesting depth, so child boundaries do not flicker the overlay. */
      const dragDepth = useRef(0);

      const generation = useRef(0);
      const configured = Boolean(settings.baseUrl);

      /** Success notices are transient; errors stay until the next action. */
      useEffect(() => {
        if (note === null || note.kind !== 'ok') return undefined;
        const timer = setTimeout(() => {
          setNote((current) => (current !== null && current.kind === 'ok' ? null : current));
        }, 4000);
        return () => clearTimeout(timer);
      }, [note]);

      /** Report a failure through the shared banner. */
      const fail = useCallback((error) => {
        setNote({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
      }, []);

      const loadKnowledgeBases = useCallback(
        async (ticket) => {
          const payload = await call('/api/v1/knowledge-bases');
          // A stale reply (settings changed while this was in flight) is dropped.
          if (ticket !== undefined && ticket !== generation.current) return [];
          const list = readKnowledgeBases(payload);
          setKbs(list);
          setChecked((previous) => {
            const kept = previous.filter((id) => list.some((kb) => kb.id === id));
            return kept.length > 0 ? kept : list.slice(0, 1).map((kb) => kb.id);
          });
          // Keep an open detail view pointed at a knowledge base that still exists.
          setOpenKb((previous) => (previous === null ? null : (list.find((kb) => kb.id === previous.id) ?? null)));
          return list;
        },
        [t],
      );

      /** Reload knowledge bases from the configured deployment. */
      const refresh = useCallback(
        async (active) => {
          const target = active ?? settings;
          if (!target.baseUrl) {
            setShowSettings(true);
            return { ok: false, error: new Error(t('baseMissing')) };
          }
          const ticket = generation.current + 1;
          generation.current = ticket;
          setBusy(true);
          setNote(null);
          try {
            const list = await loadKnowledgeBases(ticket);
            return { ok: true, count: list.length };
          } catch (error) {
            const reason = error instanceof Error ? error : new Error(String(error));
            if (ticket === generation.current) {
              setKbs([]);
              fail(reason);
            }
            return { ok: false, error: reason };
          } finally {
            if (ticket === generation.current) setBusy(false);
          }
        },
        [fail, loadKnowledgeBases, settings, t],
      );

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const config = await loadConfig();
            if (!alive) return;
            setSettings(config);
            setDraft(draftFrom(config));
            setConfigReady(true);
            setShowSettings(!config.baseUrl);
            if (config.baseUrl) void refresh(config);
          } catch (error) {
            if (!alive) return;
            setConfigReady(true);
            setShowSettings(true);
            fail(error);
          }
        })();
        return () => {
          alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const loadDocs = useCallback(
        async (kbId, page, keyword) => {
          if (!kbId) {
            setDocs(null);
            return;
          }
          setBusy(true);
          try {
            const search = new URLSearchParams({ page: String(page), page_size: String(DOC_PAGE_SIZE) });
            if (keyword.trim() !== '') search.set('keyword', keyword.trim());
            const payload = await call(`/api/v1/knowledge-bases/${encodeURIComponent(kbId)}/knowledge?${search}`);
            setDocs(readKnowledgeList(payload));
          } catch (error) {
            setDocs(null);
            fail(error);
          } finally {
            setBusy(false);
          }
        },
        [fail],
      );

      useEffect(() => {
        if (openKb !== null) void loadDocs(openKb.id, docPage, docKeyword);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [openKb, docPage]);

      /** Reload the open document table without bouncing the whole page. */
      const reloadDocs = useCallback(async () => {
        if (openKb !== null) await loadDocs(openKb.id, docPage, docKeyword);
      }, [docKeyword, docPage, loadDocs, openKb]);

      // A file uploaded from the workspace shortcut should be visible without a
      // manual refresh when the panel is already mounted.
      useEffect(() => {
        if (typeof globalThis.addEventListener !== 'function') return undefined;
        const onUploaded = (event) => {
          void refresh(settings);
          if (openKb !== null) {
            const kbId = event?.detail?.kbId;
            if (kbId === undefined || kbId === openKb.id) void reloadDocs();
          }
        };
        globalThis.addEventListener('weknora:uploaded', onUploaded);
        return () => globalThis.removeEventListener?.('weknora:uploaded', onUploaded);
      }, [openKb, refresh, reloadDocs, settings]);

      /** Apply the settings form and reconnect. */
      const applySettings = useCallback(async () => {
        const patch = patchFromDraft(draft);
        // WeKnora reads this header as a uint64 space id; catching a name or a
        // UUID here saves the user from a bare "Invalid X-Tenant-ID header".
        if (patch.tenantId !== '' && !isTenantId(patch.tenantId)) {
          setNote({ kind: 'error', text: t('tenantInvalid') });
          return;
        }
        setBusy(true);
        setNote(null);
        try {
          const config = await saveConfig(patch);
          setSettings(config);
          setDraft(draftFrom(config));
          setShowSettings(false);
          setResults(null);
          setDocs(null);
          setPreview(null);
          setOpenKb(null);
          setKbSearch(null);
          setTab('kbs');
          // Saving is one thing, reaching the new deployment is another: say
          // which one failed so "it did not save" is never the only reading.
          const result = await refresh(config);
          if (result.ok) {
            setNote({ kind: 'ok', text: t('settingsSavedConnected', { count: result.count }) });
          } else {
            setNote({
              kind: 'error',
              text: t('settingsSavedOffline', { error: result.error.message }),
            });
          }
        } catch (error) {
          fail(error);
        } finally {
          setBusy(false);
        }
      }, [draft, fail, refresh, t]);

      /** Let Enter submit the settings form from any field. */
      const settingsOnKeyDown = useCallback(
        (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void applySettings();
          }
        },
        [applySettings],
      );

      /** Probe the saved deployment without touching the form. */
      const probeSettings = useCallback(async () => {
        setTesting(true);
        try {
          const result = await testConfig();
          if (result.ok === true) {
            setNote({ kind: 'ok', text: t('testOk', { count: result.knowledgeBases ?? 0 }) });
          } else {
            setNote({ kind: 'error', text: t('testFailed', { error: result.error ?? '未知错误' }) });
          }
        } catch (error) {
          fail(error);
        } finally {
          setTesting(false);
        }
      }, [fail, t]);

      /** Run a semantic retrieval over the checked knowledge bases. */
      const runSearch = useCallback(async () => {
        const text = query.trim();
        if (text === '') return;
        setBusy(true);
        setNote(null);
        setPreview(null);
        try {
          const payload = await call('/api/v1/knowledge-search', {
            method: 'POST',
            settings,
            body: {
              query: text,
              knowledge_base_ids: checked,
              match_count: Number(matchCount) || 6,
            },
          });
          const rows = (Array.isArray(payload?.data) ? payload.data : []).map(readSearchResult);
          setResults({ query: text, rows, meta: payload?.meta });
          if (rows.length === 0) {
            const outcome = payload?.meta?.rerank?.outcome;
            setNote({ kind: 'ok', text: t('noHits', { outcome: outcome ?? 'unknown' }) });
          }
        } catch (error) {
          setResults(null);
          fail(error);
        } finally {
          setBusy(false);
        }
      }, [checked, fail, matchCount, query, settings, t]);

      /** Open one document; the panel loads its own content per view. */
      const openPreview = useCallback((doc) => {
        setNote(null);
        setPreview({ doc });
      }, []);

      /** Copy a passage to the clipboard. */
      const copyResult = useCallback(
        async (result) => {
          const text = `${result.title}\n\n${result.content}`;
          try {
            await globalThis.navigator?.clipboard?.writeText(text);
            setNote({ kind: 'ok', text: t('copied') });
          } catch {
            setNote({ kind: 'error', text: t('copyFailed') });
          }
        },
        [t],
      );

      /** Hand one passage to the conversation as a prompt. */
      const askWithResult = useCallback(
        async (result) => {
          const composed = t('askTemplate', {
            query: results?.query ?? query,
            title: result.title,
            content: result.content.slice(0, 4000),
          });
          try {
            await env.sendToConversation(composed);
            setNote({ kind: 'ok', text: t('sent') });
          } catch (error) {
            fail(error);
          }
        },
        [env, fail, query, results, t],
      );

      const toggleKb = useCallback((id) => {
        setChecked((previous) => (previous.includes(id) ? previous.filter((x) => x !== id) : [...previous, id]));
      }, []);

      /** Enter one knowledge base's document table. */
      const openKnowledgeBase = useCallback((kb) => {
        setOpenKb(kb);
        setDocKeyword('');
        setDocPage(1);
        setDocs(null);
        setPreview(null);
        setNote(null);
      }, []);

      /** Leave the document table and return to the list. */
      const closeKnowledgeBase = useCallback(() => {
        setOpenKb(null);
        setDocs(null);
        setPreview(null);
        setDocKeyword('');
        setDocPage(1);
      }, []);

      /** Create a knowledge base and refresh the grid. */
      const createKb = useCallback(
        async (values) => {
          setBusy(true);
          try {
            await call('/api/v1/knowledge-bases', {
              method: 'POST',
              body: { name: values.name, description: values.description, type: values.type },
            });
            setShowCreateKb(false);
            await refresh(settings);
            setNote({ kind: 'ok', text: t('kbCreated', { name: values.name }) });
          } catch (error) {
            fail(error);
          } finally {
            setBusy(false);
          }
        },
        [fail, refresh, settings, t],
      );

      /** Delete the open knowledge base after a confirmation. */
      const deleteKb = useCallback(async () => {
        if (openKb === null) return;
        if (globalThis.confirm?.(t('confirmDeleteKb', { name: openKb.name })) !== true) return;
        setBusy(true);
        try {
          await call(`/api/v1/knowledge-bases/${encodeURIComponent(openKb.id)}`, { method: 'DELETE' });
          closeKnowledgeBase();
          await refresh(settings);
          setNote({ kind: 'ok', text: t('kbDeleted', { name: openKb.name }) });
        } catch (error) {
          fail(error);
        } finally {
          setBusy(false);
        }
      }, [closeKnowledgeBase, fail, openKb, refresh, settings, t]);

      /**
       * Upload one or more files into the open knowledge base. Sequential so a
       * large batch does not multiply the upload budget by the concurrency.
       */
      const uploadFiles = useCallback(
        async (input) => {
          if (openKb === null || input.length === 0) return;
          // Callers hand over File objects or `{file, path}` entries (folder drops).
          const entries = input.map((entry) =>
            typeof File !== 'undefined' && entry instanceof File ? { file: entry, path: entry.name } : entry,
          );
          const failures = [];
          setBusy(true);
          for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index];
            const relativePath = entry.path === '' ? entry.file.name : entry.path;
            setUploading(t('uploading', { name: relativePath, index: index + 1, total: entries.length }));
            try {
              const form = new FormData();
              form.append('file', entry.file, entry.file.name);
              // A folder upload keeps its relative path; WeKnora splits it into
              // folder_path + display file name on the server.
              if (relativePath !== entry.file.name) form.append('fileName', relativePath);
              await callForm(`/api/v1/knowledge-bases/${encodeURIComponent(openKb.id)}/knowledge/file`, form);
            } catch (error) {
              failures.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          setUploading(null);
          setBusy(false);
          if (uploadInput.current !== null) uploadInput.current.value = '';
          if (folderInput.current !== null) folderInput.current.value = '';
          await Promise.all([reloadDocs(), refresh(settings)]);
          if (failures.length === 0) setNote({ kind: 'ok', text: t('uploadDone', { count: entries.length }) });
          else setNote({ kind: 'error', text: `${t('uploadPartial', { count: entries.length - failures.length })}\n${failures.join('\n')}` });
        },
        [openKb, refresh, reloadDocs, settings, t],
      );

      /** A dialog covers the panel, so a drop there must not upload by surprise. */
      const dialogOpen = showSettings || showCreateKb || articleEditor !== null || showUrlImport;
      /** Files can only land in the open knowledge base while it is idle. */
      const canDropFiles = openKb !== null && !busy && !dialogOpen;

      const onDragEnter = useCallback(
        (event) => {
          if (!hasFileDrag(event)) return;
          event.preventDefault();
          if (dialogOpen) return;
          dragDepth.current += 1;
          if (canDropFiles) setDragging(true);
        },
        [canDropFiles, dialogOpen],
      );

      const onDragOver = useCallback(
        (event) => {
          if (!hasFileDrag(event)) return;
          // Always prevent the browser's default "open the dropped file" behavior.
          event.preventDefault();
          if (event.dataTransfer !== null && event.dataTransfer !== undefined) {
            event.dataTransfer.dropEffect = canDropFiles ? 'copy' : 'none';
          }
        },
        [canDropFiles],
      );

      const onDragLeave = useCallback((event) => {
        if (!hasFileDrag(event)) return;
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }, []);

      const onDrop = useCallback(
        (event) => {
          if (!hasFileDrag(event)) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (dialogOpen) return;
          const dataTransfer = event.dataTransfer;
          // Capture entries synchronously: DataTransfer items are invalidated
          // once this handler yields, but directory traversal is asynchronous.
          const entries = [];
          for (const item of Array.from(dataTransfer?.items ?? [])) {
            if (item.kind !== 'file') continue;
            try {
              const entry = item.webkitGetAsEntry?.();
              if (entry !== null && entry !== undefined) entries.push(entry);
            } catch {
              /* fall back to the FileList below */
            }
          }
          const files = Array.from(dataTransfer?.files ?? []);
          if (files.length === 0 && entries.length === 0) return;
          if (openKb === null) {
            setNote({ kind: 'error', text: t('dropOpenKbFirst') });
            return;
          }
          if (busy) {
            setNote({ kind: 'error', text: t('dropBusy') });
            return;
          }
          void (async () => {
            const collected = await collectDropEntries(entries, files);
            if (collected.items.length === 0) {
              setNote({ kind: 'error', text: t('dropEmpty') });
              return;
            }
            await uploadFiles(collected.items);
            if (collected.truncated) {
              setNote({ kind: 'error', text: t('dropTooMany', { max: MAX_DROP_FILES }) });
            }
          })();
        },
        [busy, dialogOpen, openKb, t, uploadFiles],
      );

      /** Create or update a manual (Markdown) article, then refresh the table. */
      const submitArticle = useCallback(
        async (values) => {
          if (articleEditor === null) return;
          setBusy(true);
          try {
            const body = { title: values.title, content: values.content, status: values.status };
            if (articleEditor.mode === 'edit') {
              await call(`/api/v1/knowledge/manual/${encodeURIComponent(articleEditor.doc.id)}`, { method: 'PUT', body });
            } else {
              await call(`/api/v1/knowledge-bases/${encodeURIComponent(articleEditor.kbId)}/knowledge/manual`, {
                method: 'POST',
                body,
              });
            }
            setArticleEditor(null);
            await Promise.all([reloadDocs(), refresh(settings)]);
            setNote({ kind: 'ok', text: t(articleEditor.mode === 'edit' ? 'articleUpdated' : 'articleCreated') });
          } catch (error) {
            fail(error);
          } finally {
            setBusy(false);
          }
        },
        [articleEditor, fail, refresh, reloadDocs, settings, t],
      );

      /** Load a manual document's Markdown, then open the editor on it. */
      const editManualDocument = useCallback(
        async (doc) => {
          if (openKb === null) return;
          setBusy(true);
          try {
            const payload = await call(`/api/v1/knowledge/${encodeURIComponent(doc.id)}`);
            const detail = payload?.data ?? {};
            const metadata = parseManualMetadata(detail.metadata);
            setArticleEditor({
              mode: 'edit',
              kbId: openKb.id,
              doc,
              initial: {
                title: String(detail.title || doc.title || ''),
                content: metadata?.content ?? '',
                status: metadata?.status ?? (detail.parse_status === 'completed' ? 'publish' : 'draft'),
              },
            });
          } catch (error) {
            fail(error);
          } finally {
            setBusy(false);
          }
        },
        [fail, openKb],
      );

      /** Delete one document after a confirmation. */
      const deleteDocument = useCallback(
        async (doc) => {
          if (globalThis.confirm?.(t('confirmDeleteDoc', { name: doc.title })) !== true) return;
          setBusy(true);
          try {
            await call(`/api/v1/knowledge/${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
            if (preview !== null && preview.doc.id === doc.id) setPreview(null);
            await Promise.all([reloadDocs(), refresh(settings)]);
            setNote({ kind: 'ok', text: t('docDeleted', { name: doc.title }) });
          } catch (error) {
            fail(error);
          } finally {
            setBusy(false);
          }
        },
        [fail, preview, refresh, reloadDocs, settings, t],
      );

      /** Queue a re-parse for one document. */
      const reparseDocument = useCallback(
        async (doc) => {
          setBusy(true);
          try {
            await call(`/api/v1/knowledge/${encodeURIComponent(doc.id)}/reparse`, { method: 'POST', body: {} });
            // Reload first: loadDocs clears the shared banner on entry.
            await reloadDocs();
            setNote({ kind: 'ok', text: t('reparseQueued', { name: doc.title }) });
          } catch (error) {
            fail(error);
          } finally {
            setBusy(false);
          }
        },
        [fail, reloadDocs, t],
      );

      /** Import one web page or file URL into the open knowledge base. */
      const importUrl = useCallback(
        async (values) => {
          if (openKb === null) return;
          setBusy(true);
          try {
            await call(`/api/v1/knowledge-bases/${encodeURIComponent(openKb.id)}/knowledge/url`, {
              method: 'POST',
              body: { url: values.url, ...(values.title.trim() === '' ? {} : { title: values.title }) },
            });
            setShowUrlImport(false);
            await Promise.all([reloadDocs(), refresh(settings)]);
            setNote({ kind: 'ok', text: t('urlImported') });
          } catch (error) {
            fail(error);
          } finally {
            setBusy(false);
          }
        },
        [fail, openKb, refresh, reloadDocs, settings, t],
      );

      /** Search knowledge base names and document names together. */
      const runKbSearch = useCallback(async () => {
        const keyword = kbQuery.trim();
        if (keyword === '') {
          setKbSearch(null);
          return;
        }
        setBusy(true);
        setNote(null);
        try {
          const payload = await call(`/api/v1/knowledge/search?keyword=${encodeURIComponent(keyword)}&limit=50`, {
            settings,
          });
          const rows = Array.isArray(payload?.data) ? payload.data.map(readKnowledge) : [];
          const needle = keyword.toLowerCase();
          setKbSearch({
            keyword,
            documents: rows,
            kbs: kbs.filter((kb) => kb.name.toLowerCase().includes(needle)),
          });
        } catch (error) {
          setKbSearch(null);
          fail(error);
        } finally {
          setBusy(false);
        }
      }, [fail, kbQuery, kbs, settings]);

      const pinnedKbs = kbs.filter((kb) => kb.pinned);
      const otherKbs = kbs.filter((kb) => !kb.pinned);
      const totalDocs = kbs.reduce((sum, kb) => sum + (kb.count ?? 0), 0);

      /** Document table columns, in the order the WeKnora table shows them. */
      const DOC_COLUMNS = ['colName', 'colStatus', 'colSize', 'colType', 'colSource', 'colUpdated', 'colActions'];
      const kbLabels = { fileCount: (count) => t('fileCount', { count }) };
      const docLabels = {
        source: (value) => (value === '' ? t('sourceFile') : t(SOURCE_KEYS[value] ?? value)),
      };
      const docActionLabels = {
        source: docLabels.source,
        edit: t('edit'),
        reparse: t('reparse'),
        remove: t('delete'),
      };

      const docTotalPages = docs ? Math.max(1, Math.ceil(docs.total / DOC_PAGE_SIZE)) : 1;

      if (!configReady) {
        return h(
          'div',
          { className: 'wkn-root' },
          h('style', null, STYLES),
          h('div', { className: 'wkn-empty' }, t('loading')),
        );
      }

      return h(
        'div',
        {
          className: 'wkn-root',
          onDragEnter,
          onDragOver,
          onDragLeave,
          onDrop,
        },
        h('style', null, STYLES),
        h(
          'div',
          { className: 'wkn-head' },
          h('div', null, h('h1', { className: 'wkn-title' }, t('panel')), h('div', { className: 'wkn-sub' }, t('subtitle'))),
          h('div', { className: 'wkn-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'wkn-btn',
              disabled: busy || !configured,
              onClick: () => void refresh(settings),
            },
            t('refresh'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'wkn-btn',
              'data-variant': showSettings ? 'primary' : undefined,
              onClick: () => {
                setDraft(draftFrom(settings));
                setShowSettings((value) => !value);
              },
            },
            t('settings'),
          ),
        ),
        showSettings
          ? h(
              'div',
              { className: 'wkn-body' },
              h('div', { className: 'wkn-sub' }, t('settingsHint')),
              h(
                'div',
                { className: 'wkn-form' },
                h('label', null, t('fieldBase')),
                h('input', {
                  className: 'wkn-input',
                  placeholder: 'http://192.168.1.20:8080',
                  value: draft.baseUrl ?? '',
                  spellCheck: false,
                  onChange: (event) => setDraft({ ...draft, baseUrl: event.target.value }),
                  onKeyDown: settingsOnKeyDown,
                }),
                h('label', null, t('fieldKey')),
                h('input', {
                  className: 'wkn-input',
                  type: 'password',
                  placeholder: settings.hasApiKey ? t('secretStored') : 'X-API-Key',
                  value: draft.apiKey ?? '',
                  spellCheck: false,
                  onChange: (event) => setDraft({ ...draft, apiKey: event.target.value }),
                  onKeyDown: settingsOnKeyDown,
                }),
                h('label', null, t('fieldTenant')),
                h('input', {
                  className: 'wkn-input',
                  placeholder: t('tenantPlaceholder'),
                  value: draft.tenantId ?? '',
                  spellCheck: false,
                  inputMode: 'numeric',
                  onChange: (event) => setDraft({ ...draft, tenantId: event.target.value }),
                  onKeyDown: settingsOnKeyDown,
                }),
                h('label', null, t('fieldToken')),
                h('input', {
                  className: 'wkn-input',
                  type: 'password',
                  placeholder: settings.hasToken ? t('secretStored') : t('optional'),
                  value: draft.token ?? '',
                  spellCheck: false,
                  onChange: (event) => setDraft({ ...draft, token: event.target.value }),
                  onKeyDown: settingsOnKeyDown,
                }),
                h('label', null, t('fieldAgent')),
                h('input', {
                  className: 'wkn-input',
                  placeholder: t('agentPlaceholderDefault'),
                  value: draft.agentId ?? '',
                  spellCheck: false,
                  onChange: (event) => setDraft({ ...draft, agentId: event.target.value }),
                  onKeyDown: settingsOnKeyDown,
                }),
              ),
              h('div', { className: 'wkn-sub', style: { marginTop: '10px' } }, t('tenantHint')),
              h('div', { className: 'wkn-sub' }, t('settingsPersistHint')),
              h(
                'div',
                { className: 'wkn-actions' },
                h(
                  'button',
                  { type: 'button', className: 'wkn-btn', 'data-variant': 'primary', onClick: () => void applySettings() },
                  t('save'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'wkn-btn', disabled: busy || testing, onClick: () => void probeSettings() },
                  testing ? t('testing') : t('testConnection'),
                ),
                h('button', { type: 'button', className: 'wkn-btn', onClick: () => setShowSettings(false) }, t('close')),
              ),
              h('div', { className: 'wkn-hint' }, t('testHint')),
              note ? h('div', { className: 'wkn-note', 'data-kind': note.kind }, note.text) : null,
            )
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'wkn-tabs' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'wkn-tab',
                    'data-on': tab === 'kbs' ? 'true' : 'false',
                    onClick: () => setTab('kbs'),
                  },
                  t('tabKbs'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'wkn-tab',
                    'data-on': tab === 'search' ? 'true' : 'false',
                    onClick: () => setTab('search'),
                  },
                  t('tabSearch'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'wkn-tab',
                    'data-on': tab === 'agent' ? 'true' : 'false',
                    onClick: () => setTab('agent'),
                  },
                  t('tabAgent'),
                ),
              ),
              h(
                'div',
                { className: 'wkn-body' },
                tab === 'agent'
                  ? h(AgentPanel, {
                      settings,
                      kbs,
                      checked,
                      toggleKb,
                      env,
                      notify: setNote,
                    })
                  : tab === 'search'
                  ? h(
                      React.Fragment,
                      null,
                      h(
                        'div',
                        { className: 'wkn-row' },
                        h('input', {
                          className: 'wkn-input wkn-grow',
                          placeholder: t('searchPlaceholder'),
                          value: query,
                          spellCheck: false,
                          onChange: (event) => setQuery(event.target.value),
                          onKeyDown: (event) => {
                            if (event.key === 'Enter') void runSearch();
                          },
                        }),
                        h('input', {
                          className: 'wkn-input',
                          style: { width: '64px' },
                          type: 'number',
                          min: 1,
                          max: 50,
                          title: t('matchCount'),
                          value: matchCount,
                          onChange: (event) => setMatchCount(event.target.value),
                        }),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'wkn-btn',
                            'data-variant': 'primary',
                            disabled: busy || !configured || query.trim() === '',
                            onClick: () => void runSearch(),
                          },
                          t('search'),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'wkn-crumbs' },
                        h('span', { className: 'wkn-meta' }, t('scope')),
                        kbs.length > 0
                          ? h(
                              'button',
                              {
                                type: 'button',
                                className: 'wkn-btn',
                                onClick: () => setChecked(checked.length === kbs.length ? [] : kbs.map((kb) => kb.id)),
                              },
                              checked.length === kbs.length ? t('clearAll') : t('selectAll'),
                            )
                          : null,
                      ),
                      kbs.length > 0
                        ? h(
                            'div',
                            { className: 'wkn-chips' },
                            kbs.map((kb) =>
                              h(KbChip, { key: kb.id, kb, on: checked.includes(kb.id), onToggle: toggleKb }),
                            ),
                          )
                        : h('div', { className: 'wkn-empty' }, t('noKbs')),
                      note ? h('div', { className: 'wkn-note', 'data-kind': note.kind }, note.text) : null,
                      results
                        ? results.rows.length === 0
                          ? h('div', { className: 'wkn-empty' }, t('emptyResults'))
                          : h(
                              React.Fragment,
                              null,
                              h('div', { className: 'wkn-meta', style: { marginTop: '14px' } },
                                t('resultCount', { count: results.rows.length })),
                              results.rows.map((result) =>
                                h(ResultCard, {
                                  key: `${result.kbId}:${result.id}`,
                                  result,
                                  labels: { copy: t('copy'), ask: t('ask') },
                                  onCopy: copyResult,
                                  onAsk: env.canSend() ? askWithResult : undefined,
                                }),
                              ),
                            )
                        : null,
                    )
                  : h(
                      React.Fragment,
                      null,
                      openKb === null
                        ? h(
                            React.Fragment,
                            null,
                            h(
                              'div',
                              { className: 'wkn-row' },
                              h(
                                'div',
                                { className: 'wkn-stats' },
                                h('span', null, t('statKbs', { count: kbs.length })),
                                h('span', null, t('statDocs', { count: totalDocs })),
                              ),
                              h('div', { className: 'wkn-spacer' }),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'wkn-btn',
                                  'data-variant': 'primary',
                                  disabled: busy || !configured,
                                  onClick: () => setShowCreateKb(true),
                                },
                                t('newKb'),
                              ),
                            ),
                            h(
                              'div',
                              { className: 'wkn-row', style: { marginTop: '10px' } },
                              h('input', {
                                className: 'wkn-input wkn-grow',
                                placeholder: t('kbSearchPlaceholder'),
                                value: kbQuery,
                                spellCheck: false,
                                onChange: (event) => {
                                  setKbQuery(event.target.value);
                                  if (event.target.value.trim() === '') setKbSearch(null);
                                },
                                onKeyDown: (event) => {
                                  if (event.key === 'Enter') void runKbSearch();
                                },
                              }),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'wkn-btn',
                                  'data-variant': 'primary',
                                  disabled: busy || !configured || kbQuery.trim() === '',
                                  onClick: () => void runKbSearch(),
                                },
                                t('search'),
                              ),
                              kbSearch === null
                                ? null
                                : h(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'wkn-btn',
                                      onClick: () => {
                                        setKbSearch(null);
                                        setKbQuery('');
                                      },
                                    },
                                    t('clearSearch'),
                                  ),
                            ),
                            note ? h('div', { className: 'wkn-note', 'data-kind': note.kind }, note.text) : null,
                            kbSearch !== null
                              ? h(
                                  React.Fragment,
                                  null,
                                  h('div', { className: 'wkn-section-title' }, t('searchResultsFor', { keyword: kbSearch.keyword })),
                                  kbSearch.kbs.length === 0 && kbSearch.documents.length === 0
                                    ? h('div', { className: 'wkn-empty' }, t('noSearchResults'))
                                    : h(
                                        React.Fragment,
                                        null,
                                        kbSearch.kbs.length === 0
                                          ? null
                                          : h(
                                              'div',
                                              { className: 'wkn-grid' },
                                              kbSearch.kbs.map((kb) =>
                                                h(KnowledgeCard, {
                                                  key: kb.id,
                                                  kb,
                                                  onOpen: openKnowledgeBase,
                                                  labels: kbLabels,
                                                }),
                                              ),
                                            ),
                                        kbSearch.documents.length === 0
                                          ? null
                                          : h(
                                              'table',
                                              { className: 'wkn-table' },
                                              h(
                                                'thead',
                                                null,
                                                h(
                                                  'tr',
                                                  null,
                                                  DOC_COLUMNS.map((column) => h('th', { key: column }, t(column))),
                                                ),
                                              ),
                                              h(
                                                'tbody',
                                                null,
                                                kbSearch.documents.map((doc) =>
                                                  h(DocumentRow, {
                                                    key: doc.id,
                                                    doc,
                                                    onOpen: openPreview,
                                                    labels: docActionLabels,
                                                    actions: {
                                                      edit: editManualDocument,
                                                      reparse: reparseDocument,
                                                      remove: deleteDocument,
                                                    },
                                                  }),
                                                ),
                                              ),
                                            ),
                                      ),
                                  preview !== null && openKb === null
                                    ? h(DocumentPanel, {
                                        key: preview.doc.id,
                                        doc: preview.doc,
                                        settings,
                                        env,
                                        notify: setNote,
                                        onClose: () => setPreview(null),
                                      })
                                    : null,
                                )
                              : h(
                                  React.Fragment,
                                  null,
                                  pinnedKbs.length === 0                                    ? null
                                    : h(
                                        React.Fragment,
                                        null,
                                        h('div', { className: 'wkn-section-title' }, t('pinned')),
                                        h(
                                          'div',
                                          { className: 'wkn-grid' },
                                          pinnedKbs.map((kb) =>
                                            h(KnowledgeCard, { key: kb.id, kb, onOpen: openKnowledgeBase, labels: kbLabels }),
                                          ),
                                        ),
                                      ),
                                  h(
                                    'div',
                                    { className: 'wkn-section-title', style: { marginTop: '18px' } },
                                    t('myKbs'),
                                  ),
                                  otherKbs.length === 0
                                    ? h('div', { className: 'wkn-empty' }, t('noKbs'))
                                    : h(
                                        'div',
                                        { className: 'wkn-grid' },
                                        otherKbs.map((kb) =>
                                          h(KnowledgeCard, { key: kb.id, kb, onOpen: openKnowledgeBase, labels: kbLabels }),
                                        ),
                                      ),
                                ),
                          )
                        : h(
                            React.Fragment,
                            null,
                            h(
                              'div',
                              { className: 'wkn-crumbs' },
                              h('button', { type: 'button', className: 'wkn-link', onClick: closeKnowledgeBase }, t('panel')),
                              h('span', { className: 'wkn-meta' }, '›'),
                              h('span', { className: 'wkn-card-title' }, openKb.name),
                              h('div', { className: 'wkn-spacer' }),
                              h(
                                'a',
                                {
                                  className: 'wkn-link',
                                  href: String(settings.baseUrl ?? '').replace(/\/+$/, '') || '#',
                                  target: '_blank',
                                  rel: 'noreferrer',
                                },
                                t('openInWeKnora'),
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'wkn-btn',
                                  'data-variant': 'primary',
                                  disabled: busy,
                                  onClick: () => setArticleEditor({ mode: 'create', kbId: openKb.id, initial: null }),
                                },
                                t('newArticle'),
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'wkn-btn',
                                  disabled: busy,
                                  onClick: () => uploadInput.current?.click(),
                                },
                                t('uploadFile'),
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'wkn-btn',
                                  disabled: busy,
                                  onClick: () => folderInput.current?.click(),
                                },
                                t('uploadFolder'),
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'wkn-btn',
                                  disabled: busy,
                                  onClick: () => setShowUrlImport(true),
                                },
                                t('importUrl'),
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'wkn-btn wkn-danger',
                                  disabled: busy,
                                  onClick: () => void deleteKb(),
                                },
                                t('deleteKb'),
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'wkn-btn',
                                  disabled: busy,
                                  onClick: () => void loadDocs(openKb.id, docPage, docKeyword),
                                },
                                t('refresh'),
                              ),
                            ),
                            h(
                              'div',
                              { className: 'wkn-row', style: { marginTop: '10px' } },
                              h('input', {
                                className: 'wkn-input wkn-grow',
                                placeholder: t('docSearchPlaceholder'),
                                value: docKeyword,
                                spellCheck: false,
                                onChange: (event) => setDocKeyword(event.target.value),
                                onKeyDown: (event) => {
                                  if (event.key === 'Enter') {
                                    setDocPage(1);
                                    void loadDocs(openKb.id, 1, docKeyword, settings);
                                  }
                                },
                              }),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'wkn-btn',
                                  disabled: busy,
                                  onClick: () => {
                                    setDocPage(1);
                                    void loadDocs(openKb.id, 1, docKeyword, settings);
                                  },
                                },
                                t('search'),
                              ),
                              h('div', { className: 'wkn-spacer' }),
                              h('span', { className: 'wkn-hint wkn-drop-inline' }, t('dropInline')),
                              h('span', { className: 'wkn-meta' }, t('docCount', { count: docs === null ? 0 : docs.total })),
                            ),
                            h('input', {
                              type: 'file',
                              multiple: true,
                              ref: uploadInput,
                              style: { display: 'none' },
                              onChange: (event) => {
                                const files = Array.from(event.target.files ?? []);
                                if (files.length > 0) void uploadFiles(files);
                              },
                            }),
                            h('input', {
                              type: 'file',
                              multiple: true,
                              webkitdirectory: '',
                              directory: '',
                              ref: folderInput,
                              style: { display: 'none' },
                              onChange: (event) => {
                                const files = Array.from(event.target.files ?? []);
                                if (files.length === 0) return;
                                void uploadFiles(
                                  files.map((file) => ({
                                    file,
                                    path: file.webkitRelativePath === '' ? file.name : file.webkitRelativePath,
                                  })),
                                );
                              },
                            }),
                            uploading === null
                              ? null
                              : h('div', { className: 'wkn-note', 'data-kind': 'ok' }, uploading),
                            note ? h('div', { className: 'wkn-note', 'data-kind': note.kind }, note.text) : null,
                            preview
                              ? h(DocumentPanel, {
                                  key: preview.doc.id,
                                  doc: preview.doc,
                                  settings,
                                  env,
                                  notify: setNote,
                                  onClose: () => setPreview(null),
                                })
                              : docs === null
                                ? null
                                : docs.documents.length === 0
                                  ? h('div', { className: 'wkn-empty' }, t('emptyDocs'))
                                  : h(
                                      React.Fragment,
                                      null,
                                      h(
                                        'table',
                                        { className: 'wkn-table' },
                                        h(
                                          'thead',
                                          null,
                                          h(
                                            'tr',
                                            null,
                                            DOC_COLUMNS.map((column) => h('th', { key: column }, t(column))),
                                          ),
                                        ),
                                        h(
                                          'tbody',
                                          null,
                                          docs.documents.map((doc) =>
                                            h(DocumentRow, {
                                              key: doc.id,
                                              doc,
                                              onOpen: openPreview,
                                              labels: docActionLabels,
                                              actions: {
                                                edit: editManualDocument,
                                                reparse: reparseDocument,
                                                remove: deleteDocument,
                                              },
                                            }),
                                          ),
                                        ),
                                      ),
                                      h(
                                        'div',
                                        { className: 'wkn-pager' },
                                        h(
                                          'button',
                                          {
                                            type: 'button',
                                            className: 'wkn-btn',
                                            disabled: docPage <= 1 || busy,
                                            onClick: () => setDocPage((page) => Math.max(1, page - 1)),
                                          },
                                          t('prev'),
                                        ),
                                        h(
                                          'span',
                                          { className: 'wkn-meta' },
                                          t('pageOf', { page: docPage, total: docTotalPages, count: docs.total }),
                                        ),
                                        h(
                                          'button',
                                          {
                                            type: 'button',
                                            className: 'wkn-btn',
                                            disabled: docPage >= docTotalPages || busy,
                                            onClick: () => setDocPage((page) => page + 1),
                                          },
                                          t('next'),
                                        ),
                                      ),
                                    ),
                          ),
                    ),
              ),
            ),
        dragging && openKb !== null && !dialogOpen
          ? h(
              'div',
              { className: 'wkn-drop-overlay' },
              h(
                'div',
                { className: 'wkn-drop-card' },
                h('div', { className: 'wkn-drop-title' }, t('dropTitle')),
                h('div', { className: 'wkn-hint' }, t('dropHint', { name: openKb.name })),
              ),
            )
          : null,
        showCreateKb
          ? h(KnowledgeBaseDialog, {
              t,
              busy,
              onClose: () => setShowCreateKb(false),
              onSubmit: (values) => void createKb(values),
            })
          : null,
        articleEditor === null
          ? null
          : h(ArticleEditor, {
              t,
              busy,
              initial: { ...(articleEditor.initial ?? {}), mode: articleEditor.mode },
              onClose: () => setArticleEditor(null),
              onSubmit: (values) => void submitArticle(values),
            }),
        showUrlImport
          ? h(UrlImportDialog, {
              t,
              busy,
              onClose: () => setShowUrlImport(false),
              onSubmit: (values) => void importUrl(values),
            })
          : null,
      );
    }

    //#endregion

    return {
      inject: ['slots', 'locale'],
      /**
       * Test seam: the pure decision functions, exposed so `test/client.test.mjs`
       * can drive them with real bytes. Cordis ignores unknown plugin keys and
       * nothing at runtime reads this.
       */
      __internals: {
        charsetOf,
        classifyContent,
        decodeText,
        fileNameFrom,
        stripMarkup,
        readChunk,
        readSearchResult,
        readKnowledge,
        readKnowledgeList,
        readAgents,
        readReference,
        parseManualMetadata,
        collectDropEntries,
        basenameOf,
        workspaceRelativePath,
        workspaceReadError,
        WorkspaceUploadAction,
        KnowledgeBaseMentionChip,
        KB_USER_TEXT_RULE,
        formatKnowledgeBaseMention,
        knowledgeBaseCandidates,
        readKnowledgeBases,
        formatSize,
        relativeTime,
        kbKindLabel,
        isTenantId,
        chunkSaveRequest,
        isEditableChunk,
        errorMessage,
        safeUrl,
        parseMarkdown,
        renderInline,
        Markdown,
        KnowledgeCard,
        DocumentRow,
        DocumentPanel,
      },
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh: {
                panel: '知识库',
                subtitle: 'WeKnora',
                refresh: '刷新',
                settings: '设置',
                settingsHint: '填写 WeKnora 部署地址与凭证。请求经本地服务转发，密钥不会进入浏览器跨域请求。',
                fieldBase: '服务地址',
                fieldKey: 'API Key',
                fieldTenant: '租户 ID',
                fieldToken: '访问令牌',
                optional: '可留空',
                tenantPlaceholder: '留空，或填数字空间 ID',
                tenantHint:
                  '租户 ID 只能是数字空间 ID（如 7）。空间级 API Key 不需要它——填了非数字会得到 WeKnora 的 “Invalid X-Tenant-ID header” 报错，请清空。',
                tenantInvalid: '租户 ID 必须是数字空间 ID（如 7）。空间级 API Key 请把该字段留空，平台级 Key 才需要填。',
                tenantDropped:
                  '已丢弃本地保存的租户 ID「{value}」：它必须是数字空间 ID（如 7），否则 WeKnora 会返回 Invalid X-Tenant-ID header。空间级 API Key 无需填写；如确实需要，请在「设置」里填入正确的数字 ID。',
                save: '保存并连接',
                close: '关闭',
                tabKbs: '知识库',
                tabSearch: '检索',
                statKbs: '{count} 个知识库',
                statDocs: '{count} 篇文章',
                kbSearchPlaceholder: '搜索知识库和文档内容…',
                clearSearch: '清除',
                searchResultsFor: '「{keyword}」的搜索结果',
                noSearchResults: '没有匹配的知识库或文档。',
                pinned: '置顶',
                myKbs: '我的知识库',
                fileCount: '{count} 个文件',
                docSearchPlaceholder: '搜索文档标题和内容…',
                docCount: '{count} 个文档',
                colName: '名称',
                colStatus: '状态',
                colSize: '大小',
                colType: '类型',
                colSource: '来源',
                colUpdated: '更新时间',
                sourceFile: '文件上传',
                sourceUrl: '网页导入',
                sourceManual: '手工创建',
                openInWeKnora: '在 WeKnora 中打开',
                searchPlaceholder: '输入问题，检索知识库…',
                matchCount: '返回条数',
                search: '检索',
                scope: '检索范围',
                selectAll: '全选',
                clearAll: '清空',
                noKbs: '还没有知识库，或尚未连接。请在「设置」中检查地址与 API Key。',
                emptyResults: '没有命中内容，换个说法或调低阈值再试。',
                resultCount: '命中 {count} 条',
                noHits: '没有命中内容（rerank: {outcome}）。',
                copy: '复制',
                copied: '已复制到剪贴板。',
                copyFailed: '复制失败，请手动选择文本。',
                ask: '发送到对话',
                sent: '已把资料发送到当前对话。',
                sendUnavailable: '当前会话尚未就绪，无法发送到对话。',
                askTemplate:
                  '请只依据下面的知识库资料回答我的问题，并在末尾标注引用来源。\n\n【问题】{query}\n\n【资料·{title}】\n{content}',
                back: '返回列表',
                tabChunks: '解析内容',
                tabFile: '原文件',
                loading: '加载中…',
                noChunks: '该文档没有可读的解析内容（可能仍在解析、解析失败，或该类型未启用分块）。可切到「原文件」查看原件。',
                chunkCount: '共 {count} 个分块，显示前 50 个',
                chunkIndex: '分块 {index}',
                chunkDisabled: '已停用',
                emptyChunk: '（空分块）',
                edit: '编辑',
                saveEdit: '保存',
                saving: '保存中…',
                cancel: '取消',
                saved: '已保存，检索索引已排队重建。',
                savedSummary: '已保存。文档摘要状态：{status}。',
                saveConflict: '保存失败：该分块已被其他人修改（版本冲突）。你的编辑内容仍在编辑框里，请先复制，然后点「重新载入」获取最新版本再改。',
                saveForbidden: '保存失败：当前 API Key 没有写入权限。编辑分块需要 ingest（或 full_access）能力。',
                saveUnavailable:
                  '保存失败：WeKnora 返回 503（服务暂不可用）。这通常是暂时状态——服务在重启，或它前面的网关不健康。重试是安全的：每次保存都带 expected_revision，若上一次其实已写入，重试会返回 409 冲突，点「重新载入」即可确认。你的编辑内容仍在编辑框里。下面是这次响应的原始信息：',
                notEditable: '该类型分块不可编辑',
                revision: 'r{value}',
                reload: '重新载入',
                emptyFile: '（文件为空）',
                binaryNotice: '该格式（{type}）无法内联预览，请下载后用本机应用打开。',
                unknownType: '未知类型',
                openExternal: '在新窗口打开',
                download: '下载原文件',
                askChunkTemplate: '请只依据下面的知识库资料回答我的问题，并在末尾标注引用来源。\n\n【资料·{title}】\n{content}',
                emptyDocs: '该知识库下没有文档。',
                prev: '上一页',
                next: '下一页',
                pageOf: '第 {page} / {total} 页 · 共 {count} 篇',
                testConnection: '测试连接',
                testing: '测试中…',
                baseMissing: '尚未配置服务地址',
                testOk: '连接成功，可见 {count} 个知识库。',
                settingsSavedConnected: '设置已保存并已连接，共 {count} 个知识库。',
                settingsSavedOffline: '设置已保存到本机，但连接失败：{error}',
                testHint: '「测试连接」使用已保存的设置；修改表单后请先保存，再测试。',
                testFailed: '连接失败：{error}',
                secretStored: '已保存（留空保持不变）',
                settingsPersistHint: '设置保存在 DSH 本机（$DSH_HOME/weknora/config.json），知识库面板和 DSH Agent 的工具共用同一份配置。',
                fieldAgent: '默认智能体',
                agentPlaceholderDefault: '可选，WeKnora 智能体 ID（如内置的 builtin-smart-reasoning）',
                kbTypeDocument: '文档知识库',
                kbTypeFaq: 'FAQ 知识库',
                kbTypeWiki: 'Wiki 知识库',
                newKb: '新建知识库',
                kbCreateTitle: '新建知识库',
                fieldName: '名称',
                fieldDescription: '描述',
                fieldType: '类型',
                create: '创建',
                kbCreateHint: '创建后可以上传文件、导入网页或直接撰写 Markdown 文章。需要 API Key 具备 manage_kbs（或 full_access）能力。',
                kbCreated: '已创建知识库「{name}」。',
                kbDeleted: '已删除知识库「{name}」。',
                confirmDeleteKb: '确定删除知识库「{name}」？其中的文档和索引会一并删除，且不可恢复。',
                newArticle: '新建文章',
                uploadFile: '上传文件',
                importUrl: '导入网页',
                deleteKb: '删除知识库',
                uploading: '正在上传 {index}/{total}：{name}',
                uploadDone: '已上传 {count} 个文件，解析在 WeKnora 后台进行。',
                dropTitle: '松开即可上传',
                dropHint: '文件或文件夹会直接上传到「{name}」，支持一次拖入多个',
                dropInline: '可将文件或文件夹拖到此区域上传',
                dropOpenKbFirst: '请先打开一个知识库，再把文件拖进来。',
                dropBusy: '正在上传或加载，请稍后再拖入文件。',
                uploadFolder: '上传文件夹',
                dropEmpty: '没有找到可上传的文件。',
                dropTooMany: '一次最多上传 {max} 个文件，已只处理前 {max} 个。',
                uploadPartial: '成功上传 {count} 个文件，其余失败：',
                articleCreateTitle: '新建文章',
                articleEditTitle: '编辑文章',
                fieldTitle: '标题',
                fieldContent: '正文（Markdown）',
                articleHint: '「草稿」不会进入检索；「发布」会排队解析并建立索引。保存后可在文档列表里看到。',
                statusDraft: '草稿',
                statusPublish: '发布',
                articleCreated: '文章已创建，正在排队解析。',
                articleUpdated: '文章已更新。',
                saveArticle: '保存',
                confirmDeleteDoc: '确定删除「{name}」？该文档的分块与索引会一并删除。',
                docDeleted: '已删除「{name}」。',
                reparseQueued: '已提交重新解析：「{name}」。',
                reparse: '重新解析',
                delete: '删除',
                colActions: '操作',
                urlImportTitle: '从网页导入',
                fieldUrl: '网页或文件 URL',
                fieldTitleOptional: '标题（可选）',
                urlImportHint: 'WeKnora 会抓取该地址并解析为知识；只导入你有权访问的公开地址。',
                import: '导入',
                urlImported: '已提交导入，解析在 WeKnora 后台进行。',
                tabAgent: '智能体',
                agentHint: '使用 WeKnora 中配置的智能体回答；问题会基于所选知识库检索。',
                agentNoDescription: '没有描述',
                agentModeRag: 'RAG 问答',
                agentModeReAct: 'ReAct 智能体',
                builtin: '内置',
                agentsEmpty: '这个部署没有可用的智能体。可以直接使用「检索」标签，或检查 API Key 的 chat 能力。',
                agentsUnavailable: '读取智能体失败：{error}',
                agentPlaceholder: '向 WeKnora 智能体提问…',
                send: '发送',
                stop: '停止',
                newChat: '新对话',
                thinking: '思考中…',
                toolCalls: '调用工具 {count} 次',
                emptyAnswer: '（没有返回内容）',
                references: '引用来源',
                weknoraAgent: 'WeKnora 智能体',
                sessionFailed: 'WeKnora 创建会话失败：响应中没有 session id',
                chatError: '智能体返回错误',
                uploadToKb: '上传到知识库',
                uploadMenuTitle: '选择目标知识库',
                uploadLoading: '正在读取知识库…',
                uploadNoKbs: '还没有可用的知识库。',
                uploadRetry: '重试',
                uploadOpenPanel: '打开知识库面板',
                uploadBusy: '上传中…',
                uploadCount: '{count} 篇',
                mentionSection: 'WeKnora 知识库',
                mentionCount: '{count} 篇',
                workspaceUploaded: '已上传到「{name}」',
                workspaceTooLarge: '文件超过 DSH 读取上限（默认 20 MiB），无法从工作区上传。',
                workspaceForbidden: '没有权限读取该文件。',
                workspaceMissing: '文件不存在或已被移动。',
                workspaceReadFailed: '读取文件失败（HTTP {status}）。',
                workspaceDuplicate: '该文件已存在于目标知识库（内容重复）。',
                workspaceNoIngest: 'API Key 缺少 ingest 权限，无法上传文件。',
              },
              en: {
                panel: 'Knowledge',
                subtitle: 'WeKnora',
                refresh: 'Refresh',
                settings: 'Settings',
                settingsHint:
                  'Point at your WeKnora deployment. Requests are relayed by the local host, so the key never enters a cross-origin browser call.',
                fieldBase: 'Base URL',
                fieldKey: 'API key',
                fieldTenant: 'Tenant ID',
                fieldToken: 'Access token',
                optional: 'optional',
                tenantPlaceholder: 'Leave blank, or a numeric space id',
                tenantHint:
                  'Tenant ID must be a numeric space id (for example 7). A workspace API key does not need it — a non-numeric value makes WeKnora answer "Invalid X-Tenant-ID header", so clear the field.',
                tenantInvalid:
                  'Tenant ID must be a numeric space id (for example 7). Leave it blank for a workspace API key; only a platform key needs it.',
                tenantDropped:
                  'Discarded the stored tenant ID "{value}": it must be a numeric space id (for example 7), otherwise WeKnora answers "Invalid X-Tenant-ID header". A workspace API key needs no tenant; enter the correct numeric id under Settings if you really need one.',
                save: 'Save and connect',
                close: 'Close',
                tabKbs: 'Knowledge bases',
                tabSearch: 'Search',
                statKbs: '{count} knowledge bases',
                statDocs: '{count} articles',
                kbSearchPlaceholder: 'Search knowledge bases and documents…',
                clearSearch: 'Clear',
                searchResultsFor: 'Results for "{keyword}"',
                noSearchResults: 'No matching knowledge base or document.',
                pinned: 'Pinned',
                myKbs: 'My knowledge bases',
                fileCount: '{count} files',
                docSearchPlaceholder: 'Search document titles and content…',
                docCount: '{count} documents',
                colName: 'Name',
                colStatus: 'Status',
                colSize: 'Size',
                colType: 'Type',
                colSource: 'Source',
                colUpdated: 'Updated',
                sourceFile: 'Upload',
                sourceUrl: 'Web',
                sourceManual: 'Manual',
                openInWeKnora: 'Open in WeKnora',
                searchPlaceholder: 'Ask a question against the knowledge base…',
                matchCount: 'Results',
                search: 'Search',
                scope: 'Scope',
                selectAll: 'All',
                clearAll: 'None',
                noKbs: 'No knowledge base yet, or not connected. Check the URL and API key in Settings.',
                emptyResults: 'Nothing matched. Rephrase the query or lower the threshold.',
                resultCount: '{count} hits',
                noHits: 'Nothing matched (rerank: {outcome}).',
                copy: 'Copy',
                copied: 'Copied to the clipboard.',
                copyFailed: 'Copy failed — select the text manually.',
                ask: 'Send to chat',
                sent: 'Sent the passage to the current conversation.',
                sendUnavailable: 'The conversation is not ready yet, so nothing could be sent.',
                askTemplate:
                  'Answer my question using only the knowledge-base material below, and cite the source at the end.\n\n[Question] {query}\n\n[Source · {title}]\n{content}',
                back: 'Back to list',
                tabChunks: 'Parsed content',
                tabFile: 'Original file',
                loading: 'Loading…',
                noChunks:
                  'This document has no readable parsed content (still parsing, failed, or chunking is off for its type). Switch to Original file to see the source.',
                chunkCount: '{count} chunks — showing the first 50',
                chunkIndex: 'Chunk {index}',
                chunkDisabled: 'disabled',
                emptyChunk: '(empty chunk)',
                edit: 'Edit',
                saveEdit: 'Save',
                saving: 'Saving…',
                cancel: 'Cancel',
                saved: 'Saved — the retrieval index has been queued for rebuild.',
                savedSummary: 'Saved. Document summary status: {status}.',
                saveConflict:
                  'Save rejected: this chunk was modified by someone else (revision conflict). Your text is still in the editor — copy it, then click Reload to fetch the latest version and reapply.',
                saveForbidden: 'Save rejected: the current API key has no write permission. Editing chunks needs the ingest (or full_access) capability.',
                saveUnavailable:
                  'Save failed: WeKnora answered 503 (service unavailable). This is usually transient — a restart, or an unhealthy gateway in front of it. Retrying is safe: every save carries expected_revision, so if the previous attempt landed the retry answers 409 and Reload confirms it. Your text is still in the editor. Raw response follows:',
                notEditable: 'This chunk type is not editable',
                revision: 'r{value}',
                reload: 'Reload',
                emptyFile: '(empty file)',
                binaryNotice: 'This format ({type}) cannot be previewed inline — download it and open it with a local app.',
                unknownType: 'unknown type',
                openExternal: 'Open in a new window',
                download: 'Download original',
                askChunkTemplate:
                  'Answer my question using only the knowledge-base material below, and cite the source at the end.\n\n[Source · {title}]\n{content}',
                emptyDocs: 'This knowledge base has no documents.',
                prev: 'Previous',
                next: 'Next',
                pageOf: 'Page {page} / {total} · {count} documents',
                testConnection: 'Test connection',
                testing: 'Testing…',
                baseMissing: 'No service address configured',
                testOk: 'Connected — {count} knowledge bases visible.',
                settingsSavedConnected: 'Saved and connected — {count} knowledge bases.',
                settingsSavedOffline: 'Saved on this machine, but the connection failed: {error}',
                testHint: 'Test connection uses the saved settings; save the form first, then test.',
                testFailed: 'Connection failed: {error}',
                secretStored: 'stored — leave blank to keep',
                settingsPersistHint:
                  'Settings are stored on this machine ($DSH_HOME/weknora/config.json) and shared by the panel and the DSH agent tools.',
                fieldAgent: 'Default agent',
                agentPlaceholderDefault: 'optional WeKnora agent id (e.g. builtin-smart-reasoning)',
                kbTypeDocument: 'Document',
                kbTypeFaq: 'FAQ',
                kbTypeWiki: 'Wiki',
                newKb: 'New knowledge base',
                kbCreateTitle: 'New knowledge base',
                fieldName: 'Name',
                fieldDescription: 'Description',
                fieldType: 'Type',
                create: 'Create',
                kbCreateHint:
                  'After creating it you can upload files, import a page, or write Markdown directly. Needs manage_kbs (or full_access) on the API key.',
                kbCreated: 'Created knowledge base "{name}".',
                kbDeleted: 'Deleted knowledge base "{name}".',
                confirmDeleteKb: 'Delete knowledge base "{name}"? Its documents and index are removed permanently.',
                newArticle: 'New article',
                uploadFile: 'Upload files',
                importUrl: 'Import URL',
                deleteKb: 'Delete knowledge base',
                uploading: 'Uploading {index}/{total}: {name}',
                uploadDone: 'Uploaded {count} file(s); WeKnora parses them in the background.',
                dropTitle: 'Drop to upload',
                dropHint: 'Files or whole folders go straight into "{name}"',
                dropInline: 'Drag files or folders here to upload',
                dropOpenKbFirst: 'Open a knowledge base first, then drop files into it.',
                dropBusy: 'An upload or reload is in progress — try dropping again in a moment.',
                uploadFolder: 'Upload folder',
                dropEmpty: 'No uploadable files were found.',
                dropTooMany: 'At most {max} files per drop — only the first {max} were processed.',
                uploadPartial: 'Uploaded {count} file(s); the rest failed:',
                articleCreateTitle: 'New article',
                articleEditTitle: 'Edit article',
                fieldTitle: 'Title',
                fieldContent: 'Content (Markdown)',
                articleHint:
                  'A draft stays out of retrieval; publishing queues parsing and indexing. Saved articles appear in the document table.',
                statusDraft: 'Draft',
                statusPublish: 'Publish',
                articleCreated: 'Article created; parsing is queued.',
                articleUpdated: 'Article updated.',
                saveArticle: 'Save',
                confirmDeleteDoc: 'Delete "{name}"? Its chunks and index are removed too.',
                docDeleted: 'Deleted "{name}".',
                reparseQueued: 'Re-parse queued for "{name}".',
                reparse: 'Re-parse',
                delete: 'Delete',
                colActions: 'Actions',
                urlImportTitle: 'Import from URL',
                fieldUrl: 'Page or file URL',
                fieldTitleOptional: 'Title (optional)',
                urlImportHint: 'WeKnora fetches the address and parses it into knowledge. Only import public URLs you may access.',
                import: 'Import',
                urlImported: 'Import submitted; WeKnora parses it in the background.',
                tabAgent: 'Agents',
                agentHint: 'Ask the agent configured in WeKnora; answers retrieve from the selected knowledge bases.',
                agentNoDescription: 'No description',
                agentModeRag: 'RAG answer',
                agentModeReAct: 'ReAct agent',
                builtin: 'built-in',
                agentsEmpty: 'No agent is available on this deployment. Use the Search tab, or check the API key\u2019s chat capability.',
                agentsUnavailable: 'Could not list agents: {error}',
                agentPlaceholder: 'Ask the WeKnora agent…',
                send: 'Send',
                stop: 'Stop',
                newChat: 'New chat',
                thinking: 'Thinking…',
                toolCalls: '{count} tool call(s)',
                emptyAnswer: '(no content returned)',
                references: 'Sources',
                weknoraAgent: 'WeKnora agent',
                sessionFailed: 'WeKnora did not return a session id',
                chatError: 'The agent returned an error',
                uploadToKb: 'Upload to knowledge base',
                uploadMenuTitle: 'Choose a knowledge base',
                uploadLoading: 'Loading knowledge bases…',
                uploadNoKbs: 'No knowledge base is available.',
                uploadRetry: 'Retry',
                uploadOpenPanel: 'Open knowledge panel',
                uploadBusy: 'Uploading…',
                uploadCount: '{count} docs',
                mentionSection: 'WeKnora knowledge bases',
                mentionCount: '{count} docs',
                workspaceUploaded: 'Uploaded to "{name}"',
                workspaceTooLarge: 'This file exceeds the harness read limit (20 MiB by default), so it cannot be uploaded from the workspace.',
                workspaceForbidden: 'You do not have permission to read this file.',
                workspaceMissing: 'The file no longer exists or was moved.',
                workspaceReadFailed: 'Could not read the file (HTTP {status}).',
                workspaceDuplicate: 'That file already exists in the target knowledge base (identical content).',
                workspaceNoIngest: 'The API key lacks the ingest capability required to upload files.',
              },
            }),
          'weknora: dictionaries',
        );
        const bound = ctx.locale.bind(NS);

        /** Translate through the locale seat, falling back to the raw key. */
        const text = (key, params) => {
          const raw = bound(key);
          const template = typeof raw === 'string' && raw !== '' ? raw : key;
          if (params === undefined) return template;
          return template.replace(/\{(\w+)\}/g, (match, name) =>
            Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
          );
        };

        /** Resolve the conversation controller lazily: it is a sibling plugin. */
        const conversation = () => {
          try {
            return ctx.get('conversation');
          } catch {
            return undefined;
          }
        };

        const env = {
          text,
          canSend: () => conversation() !== undefined,
          sendToConversation: async (message) => {
            const service = conversation();
            if (service === undefined || typeof service.send !== 'function') {
              throw new Error(text('sendUnavailable'));
            }
            await service.send(message);
          },
          /** Bring the knowledge panel forward after a workspace upload. */
          openPanel: () => {
            try {
              ctx.get('layout')?.selectPanel?.(PANEL_ID);
            } catch {
              /* layout is optional */
            }
          },
          /** Let a mounted panel refresh itself after an external upload. */
          notifyUploaded: (detail) => {
            try {
              if (typeof CustomEvent === 'function') {
                globalThis.dispatchEvent?.(new CustomEvent('weknora:uploaded', { detail }));
              }
            } catch {
              /* best effort: the upload already succeeded */
            }
          },
        };

        /** Knowledge-base cache for the `@` source (menu queries run per keystroke). */
        let mentionCache = { at: 0, items: null, pending: null };
        const loadMentionKbs = async () => {
          if (mentionCache.items !== null && Date.now() - mentionCache.at < 60_000) return mentionCache.items;
          if (mentionCache.pending !== null) return mentionCache.pending;
          mentionCache.pending = call('/api/v1/knowledge-bases')
            .then((payload) => {
              const items = readKnowledgeBases(payload);
              mentionCache.items = items;
              mentionCache.at = Date.now();
              return items;
            })
            .finally(() => {
              mentionCache.pending = null;
            });
          return mentionCache.pending;
        };

        /** `@` source listing WeKnora knowledge bases beside files and sessions. */
        const mentionSource = {
          trigger: '@',
          name: 'weknora-kb',
          showGroupTitle: false,
          async candidates(_session, { query, signal }) {
            try {
              const items = await loadMentionKbs();
              if (signal?.aborted) return [];
              return knowledgeBaseCandidates(items, query, text);
            } catch {
              // A missing deployment should not take the whole @ menu down.
              return [];
            }
          },
          onPick({ candidate }) {
            let value;
            try {
              value = JSON.parse(candidate.value);
            } catch {
              return undefined;
            }
            if (value === null || typeof value !== 'object' || typeof value.id !== 'string') return undefined;
            const ref = formatKnowledgeBaseMention(value.id, value.name);
            return {
              insert: {
                source: 'weknora-kb',
                ref,
                label: value.name,
                appearance: 'folder',
                clipboardText: ref,
              },
            };
          },
          openReference() {
            return false;
          },
          codec: {
            clipboardText: (ref) => ref,
            serialize: (ref) => Promise.resolve(ref),
          },
        };

        // Render the canonical mention as a chip in sent messages.
        ctx.slots.inject('conversation.user.text.node', () =>
          ctx.slots.register(
            { name: 'conversation.user.text.node', key: 'weknora-kb', priority: 100, locale: NS },
            KnowledgeBaseMentionChip,
          ),
        );
        ctx.inject(['inputTriggers', 'uiConversation'], (mentionCtx) => {
          mentionCtx.effect(
            () => mentionCtx.uiConversation.userText.register(KB_USER_TEXT_RULE),
            'weknora: @ mention rule',
          );
          mentionCtx.effect(
            () => mentionCtx.inputTriggers.registerSource(mentionSource),
            'weknora: @ mention source',
          );
        });

        /** Bind the environment once; slot components only receive slot props. */
        const BoundPage = (slotProps) => h(WeKnoraPage, { ...slotProps, env });

        // Register the panel page first: the sidebar entry refuses to select a
        // key that `main` does not resolve.
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, BoundPage),
        );

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 15,
              label: () => text('panel'),
              locale: NS,
            },
            PanelIcon,
          ),
        );

        // A previewed workspace file gets a small shortcut in its header. The
        // slot is declared by ui-sidebar-documentpreview, so waiting for the
        // declaration keeps this plugin loadable in deployments without it.
        const BoundUploadAction = (slotProps) => h(WorkspaceUploadAction, { ...slotProps, env, variant: 'icon' });
        const BoundUploadEmpty = (slotProps) => h(WorkspaceUploadAction, { ...slotProps, env, variant: 'empty' });
        ctx.slots.inject('sidebar.right.tab.document.actions', () =>
          ctx.slots.register(
            { name: 'sidebar.right.tab.document.actions', id: 'weknora-upload', order: 20, locale: NS },
            BoundUploadAction,
          ),
        );
        ctx.slots.inject('sidebar.right.tab.document.unpreviewable', () =>
          ctx.slots.register(
            { name: 'sidebar.right.tab.document.unpreviewable', id: 'weknora-upload', order: 20, locale: NS },
            BoundUploadEmpty,
          ),
        );
      },
    };
  },
});
