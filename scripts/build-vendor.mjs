/**
 * Rebuild the vendored Toast UI Editor assets in `vendor/toastui/`.
 *
 * The plugin ships these files so users never need a bundler and the editor
 * works entirely offline: the host half serves them from the DSH web server
 * under a versioned path, and `client.js` lazily loads them when the article
 * dialog opens.
 *
 * Run after installing dev dependencies:
 *
 *   npm install
 *   npm run build:vendor
 *
 * The generated files are committed, so a plain plugin install needs nothing.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

/** Toast UI Editor release this plugin vendors. Keep in sync with the host + client paths. */
const TOASTUI_VERSION = '3.2.2';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', '@toast-ui', 'editor');
const outDir = path.join(root, 'vendor', 'toastui');
const banner = `@toast-ui/editor v${TOASTUI_VERSION} | MIT | https://github.com/nhn/tui.editor`;

/** Fail loudly when `node_modules` is missing or has a different version. */
async function checkSource() {
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  if (manifest.version !== TOASTUI_VERSION) {
    throw new Error(`expected @toast-ui/editor@${TOASTUI_VERSION}, found ${manifest.version}`);
  }
  return manifest;
}

/** Minify one CSS file and keep the license notice on top. */
async function minifyCss(from, to) {
  const css = await readFile(from, 'utf8');
  const result = await transform(css, { loader: 'css', minify: true, legalComments: 'none' });
  await writeFile(to, `/*! ${banner} */\n${result.code}\n`);
}

async function main() {
  await checkSource();
  await mkdir(outDir, { recursive: true });

  // One self-contained IIFE: the ESM package plus its ProseMirror dependencies.
  await build({
    stdin: {
      contents: [
        "import Editor, { EditorCore } from '@toast-ui/editor';",
        'globalThis.__WKN_TOASTUI__ = Editor;',
        'globalThis.__WKN_TOASTUI_CORE__ = EditorCore;',
        'globalThis.toastui = { Editor };',
        '',
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'toastui-entry.js',
      loader: 'js',
    },
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['chrome100'],
    outfile: path.join(outDir, 'toastui-editor.min.js'),
    legalComments: 'none',
    banner: { js: `/*! ${banner} */` },
    logLevel: 'info',
  });

  await minifyCss(
    path.join(source, 'dist', 'toastui-editor.css'),
    path.join(outDir, 'toastui-editor.min.css'),
  );
  await minifyCss(
    path.join(source, 'dist', 'theme', 'toastui-editor-dark.css'),
    path.join(outDir, 'toastui-editor-dark.min.css'),
  );

  // Official zh-CN registration bundle. It reads `globalThis.toastui.Editor`,
  // which the IIFE above installs before this file runs.
  // `EditorCore` is exported too: client.js uses an offscreen instance to turn
  // pasted Markdown into WYSIWYG HTML.
  await copyFile(path.join(source, 'dist', 'i18n', 'zh-cn.js'), path.join(outDir, 'zh-cn.js'));

  // The npm tarball omits the license file; the committed copy lives alongside.
  try {
    await stat(path.join(source, 'LICENSE'));
    await copyFile(path.join(source, 'LICENSE'), path.join(outDir, 'LICENSE'));
  } catch {
    /* keep the committed LICENSE */
  }

  console.log(`vendor/toastui: rebuilt assets for @toast-ui/editor@${TOASTUI_VERSION}`);
}

await main();
