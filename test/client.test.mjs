/**
 * Render test for the browser half of `dsh-weknora`.
 *
 * Executes the shipped `client.js` bundle against the module-loader contract the
 * harness uses, mounts it on a stand-in Cordis context, and server-renders the
 * registered components so wiring mistakes surface as failures rather than as
 * an empty slot in the GUI.
 *
 * Run: node --test test/client.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/** React pair shipped with the harness client stack. */
const profileModules = process.env.DSH_PROFILES_NODE_MODULES
  ?? path.join(os.homedir(), '.dsh', 'profiles', 'node_modules');

/**
 * Find a React + react-dom/server pair. The profile's node_modules symlinks can
 * go stale when the npx cache is pruned, so fall back to scanning npx caches.
 * @returns `{React, renderToStaticMarkup}` or undefined.
 */
function findReact() {
  const candidates = [profileModules];
  const npx = path.join(os.homedir(), '.npm', '_npx');
  try {
    for (const entry of fs.readdirSync(npx)) candidates.push(path.join(npx, entry, 'node_modules'));
  } catch {
    /* no npx cache */
  }
  for (const directory of candidates) {
    try {
      const nodeRequire = createRequire(path.join(directory, 'noop.js'));
      const react = nodeRequire('react');
      const server = nodeRequire('react-dom/server');
      return { React: react, renderToStaticMarkup: server.renderToStaticMarkup };
    } catch {
      /* try the next directory */
    }
  }
  return undefined;
}

const reactStack = findReact();
let React;
let renderToStaticMarkup;
if (reactStack === undefined) {
  test('client render tests', { skip: 'no usable React + react-dom/server pair found' }, () => {});
} else {
  React = reactStack.React;
  renderToStaticMarkup = reactStack.renderToStaticMarkup;
}

/** Loader definition captured from `window.__ModuleLoader__.load`. */
let captured;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition;
    },
  },
};

await import('../client.js');

if (captured !== undefined && reactStack !== undefined) {
  assert.equal(captured.id, 'dsh-weknora');

  const plugin = captured.factory((specifier) => {
    if (specifier === 'react') return React;
    throw new Error(`unexpected require("${specifier}")`);
  });

  assert.deepEqual(plugin.inject, ['slots', 'locale']);

  /** Slot registrations performed by the plugin. */
  const registrations = [];
  const dictionaries = new Map();
  /** @-menu sources registered through `ctx.inputTriggers`. */
  const triggerSources = [];
  /** User-text rules registered through `ctx.uiConversation`. */
  const userTextRules = [];
  /** Command contributions registered through `ctx.commandUi`. */
  const commands = [];
  const mentionCtx = {
    effect: (factory) => factory(),
    uiConversation: {
      userText: {
        register: (rule) => {
          userTextRules.push(rule);
          return () => {};
        },
      },
    },
    inputTriggers: {
      registerSource: (source) => {
        triggerSources.push(source);
        return () => {};
      },
    },
  };
  const commandCtx = {
    effect: (factory) => factory(),
    get: (key) =>
      key === 'commandUi'
        ? {
            register: (contribution) => {
              commands.push(contribution);
              return () => {};
            },
          }
        : undefined,
  };
  const ctx = {
    effect: (factory) => factory(),
    get: () => undefined,
    inject: (deps, callback) => callback(deps.includes('commandUi') ? commandCtx : mentionCtx),
    locale: {
      register: (ns, dict) => {
        dictionaries.set(ns, dict);
        return () => dictionaries.delete(ns);
      },
      bind: (ns) => (key) => dictionaries.get(ns)?.zh?.[key] ?? key,
    },
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  plugin.apply(ctx);

  test('registers the panel page and its sidebar entry', () => {
    assert.equal(registrations.length, 7);
    const main = registrations.find((item) => item.options.name === 'main');
    const entry = registrations.find((item) => item.options.name === 'sidebar.panellist');
    assert.ok(main && entry);
    assert.equal(main.options.key, 'weknora-kb');
    assert.equal(entry.options.id, 'weknora-kb');
    assert.equal(entry.options.order, 15);
    assert.equal(entry.options.locale, 'weknora-kb');
    assert.equal(entry.options.label(), '知识库');
    const svg = renderToStaticMarkup(React.createElement(entry.component, { size: 16, active: false }));
    assert.match(svg, /^<svg/);
    assert.match(svg, /viewBox="0 0 16 16"/);
  });

  test('registers the workspace-file upload shortcut in both preview states', () => {
    const actions = registrations.find((item) => item.options.name === 'sidebar.right.tab.document.actions');
    const unpreviewable = registrations.find((item) => item.options.name === 'sidebar.right.tab.document.unpreviewable');
    assert.ok(actions && unpreviewable);
    assert.equal(actions.options.id, 'weknora-upload');
    assert.equal(unpreviewable.options.id, 'weknora-upload');
    assert.equal(actions.options.order, 20);
  });

  test('registers bilingual dictionaries with the new surfaces', () => {
    const dict = dictionaries.get('weknora-kb');
    assert.ok(dict);
    for (const key of [
      'panel',
      'tabKbs',
      'tabSearch',
      'tabAgent',
      'newKb',
      'newArticle',
      'uploadFile',
      'importUrl',
      'deleteKb',
      'articleCreateTitle',
      'urlImportTitle',
      'agentHint',
      'agentsEmpty',
      'send',
      'thinking',
      'references',
      'testConnection',
      'fieldAgent',
      'colActions',
      'reparse',
      'delete',
      'editorLoading',
      'editorLoadFailed',
      'editorRetry',
      'editorFallbackPlaceholder',
      'pickerMenuLabel',
      'pickerTitle',
      'pickerSearchPlaceholder',
      'pickerAddCount',
      'pickerInsertFailed',
    ]) {
      assert.equal(typeof dict.zh[key], 'string', `zh.${key} missing`);
      assert.equal(typeof dict.en[key], 'string', `en.${key} missing`);
    }
  });

  test('shows the loading state before the settings arrive', () => {
    const page = registrations.find((item) => item.options.name === 'main').component;
    const html = renderToStaticMarkup(React.createElement(page, {}));
    assert.match(html, /加载中/);
  });

  test('renders knowledge-base rows with management actions', () => {
    const { DocumentRow } = plugin.__internals;
    const html = renderToStaticMarkup(
      React.createElement(DocumentRow, {
        doc: {
          id: 'doc-1',
          title: '退款流程.md',
          fileType: 'md',
          status: 'completed',
          size: 1024,
          source: 'manual',
          type: 'manual',
          updatedAt: new Date().toISOString(),
        },
        onOpen: () => {},
        labels: { source: (value) => value, edit: '编辑', reparse: '重新解析', remove: '删除' },
        actions: { edit: () => {}, reparse: () => {}, remove: () => {} },
      }),
    );
    assert.match(html, /退款流程\.md/);
    assert.match(html, /编辑/);
    assert.match(html, /重新解析/);
    assert.match(html, /删除/);
  });

  test('normalizes agents and manual metadata', () => {
    const { readAgents, parseManualMetadata, readKnowledge } = plugin.__internals;
    const agents = readAgents({
      data: [
        { id: 'agent-1', name: '售后助手', description: '处理售后', config: { agent_mode: 'smart-reasoning' } },
        { id: 'builtin-quick-answer', name: '快速问答', is_builtin: true, config: { agent_mode: 'quick-answer' } },
      ],
    });
    assert.equal(agents.length, 2);
    assert.equal(agents[0].mode, 'smart-reasoning');
    assert.equal(agents[1].builtin, true);

    assert.deepEqual(parseManualMetadata({ content: '# 标题', status: 'publish' }), {
      content: '# 标题',
      status: 'publish',
    });
    assert.deepEqual(parseManualMetadata('{"content":"x","status":"draft"}'), { content: 'x', status: 'draft' });
    assert.equal(parseManualMetadata(null), null);

    const manual = readKnowledge({ id: 'd1', type: 'manual', file_name: 'a.md', parse_status: 'completed' });
    assert.equal(manual.type, 'manual');
    assert.equal(manual.status, 'completed');
  });

  test('computes workspace-relative upload names', () => {
    const { workspaceRelativePath, basenameOf } = plugin.__internals;
    assert.equal(workspaceRelativePath('/tmp/ws', '/tmp/ws/README.md'), 'README.md');
    assert.equal(workspaceRelativePath('/tmp/ws', '/tmp/ws/docs/a/b.md'), 'docs/a/b.md');
    assert.equal(workspaceRelativePath('C:\\ws', 'C:\\ws\\docs\\a.md'), 'docs/a.md');
    assert.equal(workspaceRelativePath('/tmp/ws', '/tmp/ws'), 'ws');
    assert.equal(workspaceRelativePath('/tmp/ws', '/elsewhere/a.md'), 'a.md');
    assert.equal(workspaceRelativePath(undefined, '/tmp/ws/a.md'), 'a.md');
    assert.equal(basenameOf('/a/b/c.txt'), 'c.txt');
    assert.equal(basenameOf(''), 'workspace-file');
  });

  test('maps /api/file failures to readable messages', () => {
    const { workspaceReadError } = plugin.__internals;
    const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`);
    assert.equal(workspaceReadError(413, t), 'workspaceTooLarge');
    assert.equal(workspaceReadError(403, t), 'workspaceForbidden');
    assert.equal(workspaceReadError(404, t), 'workspaceMissing');
    assert.equal(workspaceReadError(500, t), 'workspaceReadFailed:{"status":500}');
  });

  test('renders the workspace upload shortcut button', () => {
    const { WorkspaceUploadAction } = plugin.__internals;
    const dict = dictionaries.get('weknora-kb');
    const env = { text: (key) => dict.zh[key] ?? key };
    const html = renderToStaticMarkup(
      React.createElement(WorkspaceUploadAction, {
        absolutePath: '/tmp/ws/README.md',
        sessionId: 'session-1',
        useSessions: (selector) => selector({ byId: { 'session-1': { cwd: '/tmp/ws' } } }),
        env,
        variant: 'icon',
      }),
    );
    assert.match(html, /aria-label="上传到知识库"/);
    assert.match(html, /aria-haspopup="menu"/);
    assert.match(html, /aria-expanded="false"/);
    const empty = renderToStaticMarkup(
      React.createElement(WorkspaceUploadAction, {
        absolutePath: '/tmp/ws/README.md',
        env,
        variant: 'empty',
      }),
    );
    assert.match(empty, /上传到知识库/);
  });

  test('registers a WeKnora source and rule into the @ pipeline', async () => {
    assert.equal(triggerSources.length, 2);
    const source = triggerSources.find((entry) => entry.name === 'weknora-kb');
    assert.ok(source);
    assert.equal(source.trigger, '@');
    const documentSource = triggerSources.find((entry) => entry.name === 'weknora-doc');
    assert.ok(documentSource, 'document chips need a serializer source');
    assert.equal(documentSource.trigger, '@');
    assert.deepEqual(await documentSource.candidates(), []);
    assert.equal(documentSource.codec.clipboardText('x'), 'x');
    assert.equal(typeof documentSource.codec.serialize, 'function');
    assert.equal(userTextRules.length, 2);
    const rule = userTextRules.find((entry) => entry.id === 'weknora-kb');
    assert.ok(rule, 'a user-text rule must render sent mentions');
    const docRule = userTextRules.find((entry) => entry.id === 'weknora-doc');
    assert.ok(docRule, 'a user-text rule must render sent documents');
    const nodes = registrations.filter((item) => item.options.name === 'conversation.user.text.node');
    assert.equal(nodes.length, 2);
    assert.ok(nodes.some((node) => node.options.key === 'weknora-kb'));
    assert.ok(nodes.some((node) => node.options.key === 'weknora-doc'));
  });

  test('registers the + menu command and the composer picker overlay', () => {
    const overlay = registrations.find((item) => item.options.name === 'conversation.input.overlay');
    assert.ok(overlay, 'the picker must mount in the composer overlay');
    assert.equal(overlay.options.id, 'weknora-picker');
    assert.equal(overlay.options.order, 30);
    assert.equal(overlay.options.locale, 'weknora-kb');

    assert.equal(commands.length, 1);
    const command = commands[0];
    assert.equal(command.name, 'weknora');
    assert.equal(command.label(), 'WeKnora 文件');
    assert.equal(command.description(), '从知识库挑选几个文件加入这条消息');
    assert.equal(command.ui.kind, 'action');
    assert.equal(command.available({ sessionId: 'session-1' }), true);
    assert.equal(command.available({}), false);

    const { pickerHub, openDocumentPicker, closeDocumentPicker } = plugin.__internals;
    openDocumentPicker('session-9');
    assert.equal(pickerHub.request.sessionId, 'session-9');
    closeDocumentPicker(pickerHub.request.seq);
    assert.equal(pickerHub.request, null);
  });

  test('formats, parses, and renders canonical document mentions', () => {
    const { formatDocumentMention, documentChip, DOC_USER_TEXT_RULE, DocumentMentionChip } = plugin.__internals;
    const mention = formatDocumentMention('kb/1', 'doc 2', '退款 [流程]');
    assert.equal(mention, '@[退款 流程](weknora:doc/kb%2F1/doc%202)');
    const text = `请看 ${mention} 的内容`;
    const node = DOC_USER_TEXT_RULE.match(text, 0);
    assert.ok(node);
    assert.equal(node.id, 'weknora-doc');
    assert.equal(node.data.label, '退款 流程');
    assert.equal(node.data.kbId, 'kb/1');
    assert.equal(node.data.id, 'doc 2');
    assert.equal(text.slice(node.start, node.end), mention);

    const chip = documentChip({ kbId: 'kb-1', id: 'doc-1', title: '退款流程.md' });
    assert.equal(chip.source, 'weknora-doc');
    assert.equal(chip.ref, '@[退款流程.md](weknora:doc/kb-1/doc-1)');
    assert.equal(chip.appearance, 'file');
    assert.equal(chip.clipboardText, chip.ref);

    const html = renderToStaticMarkup(
      React.createElement(DocumentMentionChip, {
        node: { data: { label: '退款流程.md' } },
        raw: chip.ref,
      }),
    );
    assert.match(html, /退款流程\.md/);
    assert.match(html, /wkn-kb-mention/);
  });

  test('renders the picker only for the addressed session', () => {
    const { WeKnoraDocumentPicker, openDocumentPicker, closeDocumentPicker, pickerHub } = plugin.__internals;
    const dict = dictionaries.get('weknora-kb');
    const env = { text: (key, params) => (params === undefined ? dict.zh[key] ?? key : (dict.zh[key] ?? key).replace(/\{(\w+)\}/g, (m, name) => String(params[name] ?? m))) };
    const Picker = (props) => React.createElement(WeKnoraDocumentPicker, { env, ...props });
    assert.equal(renderToStaticMarkup(React.createElement(Picker, { sessionId: 'session-1' })), '');

    openDocumentPicker('session-1');
    try {
      assert.equal(renderToStaticMarkup(React.createElement(Picker, { sessionId: 'session-2' })), '');
      const html = renderToStaticMarkup(React.createElement(Picker, { sessionId: 'session-1' }));
      assert.match(html, /role="dialog"/);
      assert.match(html, /从 WeKnora 添加文件/);
      assert.match(html, /正在读取知识库/);
      assert.match(html, /从左侧选择一个知识库/);
      assert.match(html, /aria-label="取消"/);
    } finally {
      closeDocumentPicker(pickerHub.request?.seq);
    }
  });

  test('inserts one chip per picked document through the composer shell', () => {
    const { insertDocumentChips } = plugin.__internals;
    const inserted = [];
    const shell = {
      caretSpan: () => ({ start: 0, end: 0 }),
      rev: 4,
      insertReference: (ref, span) => {
        inserted.push({ ref, span });
        return true;
      },
    };
    const ctx = {
      get: (key) => (key === 'conversation' ? { input: { shell: () => shell } } : undefined),
    };
    const documents = [
      { kbId: 'kb-1', id: 'doc-1', title: '退款流程.md' },
      { kbId: 'kb-2', id: 'doc-4', title: '售后政策.md' },
    ];
    const result = insertDocumentChips(ctx, 'session-1', documents, undefined);
    assert.deepEqual(result, { inserted: 2, unavailable: false });
    assert.equal(inserted.length, 2);
    assert.equal(inserted[0].ref.source, 'weknora-doc');
    assert.equal(inserted[0].ref.ref, '@[退款流程.md](weknora:doc/kb-1/doc-1)');
    assert.equal(inserted[1].ref.ref, '@[售后政策.md](weknora:doc/kb-2/doc-4)');
    assert.deepEqual(inserted[1].span, { start: 0, end: 0, draftRev: 4 });

    const unavailable = insertDocumentChips({ get: () => undefined }, 'session-1', documents, undefined);
    assert.deepEqual(unavailable, { inserted: 0, unavailable: true });
  });

  test('formats and parses canonical knowledge-base mentions', () => {
    const { formatKnowledgeBaseMention, KB_USER_TEXT_RULE } = plugin.__internals;
    const mention = formatKnowledgeBaseMention('kb/1', '产品 [文档]');
    assert.equal(mention, '@[产品 文档](weknora:kb/kb%2F1)');
    const text = `请看 ${mention} 的内容`;
    const node = KB_USER_TEXT_RULE.match(text, 0);
    assert.ok(node);
    assert.equal(node.data.label, '产品 文档');
    assert.equal(node.data.id, 'kb/1');
    assert.equal(text.slice(node.start, node.end), mention);
  });

  test('filters knowledge-base candidates for the @ query', () => {
    const { knowledgeBaseCandidates } = plugin.__internals;
    const t = (key, params) => (params === undefined ? key : `${key}:${params.count}`);
    const items = [
      { id: 'kb-1', name: '产品文档', description: '退款', count: 3 },
      { id: 'kb-2', name: '售后 FAQ', description: '', count: 1 },
    ];
    assert.equal(knowledgeBaseCandidates(items, '', t).length, 2);
    const filtered = knowledgeBaseCandidates(items, '退款', t);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].name, '产品文档');
    assert.equal(filtered[0].description, 'mentionCount:3');
    const html = renderToStaticMarkup(
      React.createElement(plugin.__internals.KnowledgeBaseMentionChip, {
        node: { data: { label: '产品文档', id: 'kb-1' } },
        raw: '@[产品文档](weknora:kb/kb-1)',
      }),
    );
    assert.match(html, /产品文档/);
    assert.match(html, /wkn-kb-mention/);
  });

  test('walks dropped directories into relative upload paths', async () => {
    const { collectDropEntries } = plugin.__internals;
    const fileEntry = (name) => ({
      isFile: true,
      isDirectory: false,
      name,
      file: (resolve) => resolve(new File(['x'], name, { type: 'text/markdown' })),
    });
    const dirEntry = (name, children) => ({
      isFile: false,
      isDirectory: true,
      name,
      createReader: () => {
        let sent = false;
        return {
          readEntries: (resolve) => {
            if (sent) return resolve([]);
            sent = true;
            return resolve(children);
          },
        };
      },
    });
    const result = await collectDropEntries(
      [
        dirEntry('docs', [fileEntry('a.md'), dirEntry('sub', [fileEntry('b.md')]), fileEntry('.DS_Store')]),
        fileEntry('root.md'),
      ],
      [],
    );
    assert.deepEqual(
      result.items.map((item) => item.path),
      ['docs/a.md', 'docs/sub/b.md', 'root.md'],
    );
    assert.equal(result.truncated, false);

    const fallback = await collectDropEntries([], [new File(['x'], 'f.txt'), new File(['x'], '.DS_Store')]);
    assert.deepEqual(fallback.items.map((item) => item.path), ['f.txt']);
  });

  test('caps a folder drop at the per-drop file limit', async () => {
    const { collectDropEntries } = plugin.__internals;
    const fileEntry = (name) => ({
      isFile: true,
      isDirectory: false,
      name,
      file: (resolve) => resolve(new File(['x'], name)),
    });
    const dirEntry = (name, children) => ({
      isFile: false,
      isDirectory: true,
      name,
      createReader: () => {
        let sent = false;
        return {
          readEntries: (resolve) => {
            if (sent) return resolve([]);
            sent = true;
            return resolve(children);
          },
        };
      },
    });
    const many = Array.from({ length: 501 }, (_, index) => fileEntry(`f${index}.md`));
    const result = await collectDropEntries([dirEntry('big', many)], []);
    assert.equal(result.items.length, 500);
    assert.equal(result.truncated, true);
  });

  test('classifies original files by media type', () => {
    const { classifyContent, fileNameFrom, readSearchResult, readKnowledgeList } = plugin.__internals;
    assert.equal(classifyContent('application/pdf', 'x.pdf'), 'pdf');
    assert.equal(classifyContent('image/png', 'x.png'), 'image');
    assert.equal(classifyContent('text/markdown', 'x.md'), 'text');
    assert.equal(classifyContent('application/octet-stream', 'x.zip'), 'binary');
    assert.equal(fileNameFrom('attachment; filename="a.txt"', 'fallback'), 'a.txt');
    const hit = readSearchResult({ id: 'c1', knowledge_id: 'k1', knowledge_title: '退款流程', content: '七天', score: 0.9 });
    assert.equal(hit.title, '退款流程');
    assert.equal(hit.score, 0.9);
    const list = readKnowledgeList({ data: [{ id: 'k2', file_name: 'b.pdf' }], total: 1 });
    assert.equal(list.total, 1);
    assert.equal(list.documents[0].id, 'k2');
  });

  test('builds same-origin asset URLs for the vendored editor', () => {
    const { editorAssetUrls } = plugin.__internals;
    const urls = editorAssetUrls();
    for (const [key, suffix] of Object.entries({
      script: '/weknora/__vendor/toastui-3.2.2/toastui-editor.min.js',
      style: '/weknora/__vendor/toastui-3.2.2/toastui-editor.min.css',
      darkStyle: '/weknora/__vendor/toastui-3.2.2/toastui-editor-dark.min.css',
      i18n: '/weknora/__vendor/toastui-3.2.2/zh-cn.js',
    })) {
      assert.equal(typeof urls[key], 'string', key);
      assert.ok(urls[key].includes(suffix), `${key}: ${urls[key]}`);
      assert.ok(urls[key].includes('?rev='), `${key} is not cache-busted: ${urls[key]}`);
    }
  });

  test('detects Markdown in pasted plain text', () => {
    const { looksLikeMarkdown } = plugin.__internals;
    for (const markdown of [
      '# 标题',
      '## 二级标题\n\n正文',
      '- 列表项',
      '1. 第一步',
      '> 引用',
      '**粗体**和普通文字',
      '看这个 [链接](https://example.com)',
      '```js\nconst a = 1;\n```',
      '| 列A | 列B |\n| --- | --- |',
    ]) {
      assert.equal(looksLikeMarkdown(markdown), true, markdown);
    }
    for (const prose of ['普通的一段话。', '包含 ** 但不是成对标记', 'a | b']) {
      assert.equal(looksLikeMarkdown(prose), false, prose);
    }
  });

  test('matches completed inline Markdown tokens for WYSIWYG shortcuts', () => {
    const { matchTypedInlineMarkdown } = plugin.__internals;
    assert.deepEqual(matchTypedInlineMarkdown('**粗体**'), {
      start: 0,
      end: 6,
      command: 'bold',
      delim: 2,
    });
    assert.deepEqual(matchTypedInlineMarkdown('这是**粗体**'), {
      start: 2,
      end: 8,
      command: 'bold',
      delim: 2,
    });
    assert.deepEqual(matchTypedInlineMarkdown('也有*斜体*'), {
      start: 2,
      end: 6,
      command: 'italic',
      delim: 1,
    });
    assert.deepEqual(matchTypedInlineMarkdown('~~删除~~'), {
      start: 0,
      end: 6,
      command: 'strike',
      delim: 2,
    });
    assert.deepEqual(matchTypedInlineMarkdown('`代码`'), {
      start: 0,
      end: 4,
      command: 'code',
      delim: 1,
    });
    assert.equal(matchTypedInlineMarkdown('普通文字'), null);
    assert.equal(matchTypedInlineMarkdown('**未闭合'), null);
  });

  test('renders the article editor shell while the vendor editor loads', () => {
    const dict = dictionaries.get('weknora-kb');
    const t = (key, params) => {
      const raw = dict.zh[key] ?? key;
      if (params === undefined) return raw;
      return raw.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      );
    };
    const html = renderToStaticMarkup(
      React.createElement(plugin.__internals.ArticleEditor, {
        t,
        busy: false,
        initial: { mode: 'create', title: '', content: '', status: 'draft' },
        onClose: () => {},
        onSubmit: () => {},
      }),
    );
    assert.match(html, /新建文章/);
    assert.match(html, /正文（Markdown）/);
    assert.match(html, /wkn-md-shell/);
    assert.match(html, /wkn-md-loading/);
    assert.match(html, /正在加载 Markdown 编辑器/);
    assert.match(html, /保存/);
    assert.doesNotMatch(html, /wkn-editor-hint/);
    // The vendored script only runs in a real browser, never during SSR.
    assert.doesNotMatch(html, /toastui-editor-defaultUI/);
  });
}
