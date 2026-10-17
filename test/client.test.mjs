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
  const ctx = {
    effect: (factory) => factory(),
    get: () => undefined,
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
    assert.equal(registrations.length, 2);
    const [main, entry] = registrations;
    assert.equal(main.options.name, 'main');
    assert.equal(main.options.key, 'weknora');
    assert.equal(entry.options.name, 'sidebar.panellist');
    assert.equal(entry.options.id, 'weknora');
    assert.equal(entry.options.order, 15);
    assert.equal(entry.options.locale, 'weknora');
    assert.equal(entry.options.label(), '知识库');
    const svg = renderToStaticMarkup(React.createElement(entry.component, { size: 16, active: false }));
    assert.match(svg, /^<svg/);
    assert.match(svg, /viewBox="0 0 16 16"/);
  });

  test('registers bilingual dictionaries with the new surfaces', () => {
    const dict = dictionaries.get('weknora');
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
    const page = registrations[0].component;
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
