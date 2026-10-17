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
  const ctx = {
    effect: (factory) => factory(),
    get: () => undefined,
    inject: (_deps, callback) => callback(mentionCtx),
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
    assert.equal(registrations.length, 5);
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

  test('registers a WeKnora source and rule into the @ pipeline', () => {
    assert.equal(triggerSources.length, 1);
    const source = triggerSources[0];
    assert.equal(source.trigger, '@');
    assert.equal(source.name, 'weknora-kb');
    const rule = userTextRules.find((entry) => entry.id === 'weknora-kb');
    assert.ok(rule, 'a user-text rule must render sent mentions');
    const node = registrations.find((item) => item.options.name === 'conversation.user.text.node');
    assert.ok(node);
    assert.equal(node.options.key, 'weknora-kb');
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
}
