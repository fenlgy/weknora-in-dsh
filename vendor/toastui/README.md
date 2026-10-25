# Vendored Toast UI Editor

The article editor uses [Toast UI Editor](https://github.com/nhn/tui.editor) — the
open-source Markdown editor with the most GitHub stars among dedicated Markdown
editor projects (MIT license).

These files are prebuilt and committed because the plugin is installed from a
GitHub snapshot without a bundling step, and the DSH desktop app must work
offline:

| File | Purpose |
| --- | --- |
| `toastui-editor.min.js` | One self-contained IIFE bundling `@toast-ui/editor@3.2.2` and its ProseMirror dependencies; exposes `globalThis.toastui.Editor` and `globalThis.__WKN_TOASTUI_CORE__` (used to convert pasted Markdown for WYSIWYG). |
| `toastui-editor.min.css` | The editor stylesheet (icons are inlined as data URLs). |
| `toastui-editor-dark.min.css` | Optional dark theme, loaded only when the harness uses a dark background. |
| `zh-cn.js` | Official Simplified Chinese language registration bundle. |
| `LICENSE` | MIT license text of the bundled project. |

Do not edit these by hand. Regenerate them with the pinned toolchain:

```sh
npm install
npm run build:vendor
```

The host half serves this directory from the DSH web server at
`/weknora/__vendor/toastui-3.2.2/…`; see `VENDOR_PREFIX` in `index.js`.

After rebuilding, bump `EDITOR_ASSET_REVISION` in `client.js` so browsers fetch
the new bundle instead of the immutable-cached copy.
