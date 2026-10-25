"""End-to-end check for the dsh-weknora client panel.

Drives the real DSH web UI (an isolated test profile) in headless Chromium:
the sidebar entry, knowledge-base browsing, article management (create/upload),
and WeKnora-agent chat all have to work against the mock deployment.

Usage: python3 test/e2e/panel.py <web-url-with-token>
"""
import os
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = sys.argv[1]
OUT = Path(__file__).parent / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)

# Unique names keep reruns independent of state left by an earlier run.
RUN = str(int(time.time()))[-5:]
KB_NAME = f"端到端测试库-{RUN}"
ARTICLE = f"Playwright 测试文章-{RUN}"


def assert_uniform_controls(page, where):
    """Every visible panel control shares one 32px control height."""
    sizes = page.evaluate(
        """() => [...document.querySelectorAll(
          '.wkn-root .wkn-btn, .wkn-root .wkn-tab, .wkn-root .wkn-chip, .wkn-root .wkn-link'
        )].filter((node) => node.offsetWidth > 0 && node.offsetHeight > 0)
          .map((node) => Math.round(node.getBoundingClientRect().height))"""
    )
    if set(sizes) != {32}:
        fail(page, f"inconsistent control heights in {where}: {sorted(set(sizes))}")
    if "已连接，共" in page.locator('.wkn-root').inner_text():
        fail(page, f"routine connection banner is still visible in {where}")


def scroll_editor_to_top(page):
    """Put every soft-scrolled pane in the article modal back to the top (screenshots)."""
    page.evaluate(
        """() => {
          const root = document.querySelector('.wkn-modal.wkn-modal-wide');
          if (root === null) return;
          for (const node of root.querySelectorAll('*')) {
            if (node.scrollHeight > node.clientHeight + 2) node.scrollTop = 0;
          }
        }"""
    )
    page.wait_for_timeout(300)


def assert_modal_body_no_h_overflow(page, dialog, where):
    """A content-box width bug used to give the article modal body a horizontal scrollbar."""
    metrics = dialog.locator(".wkn-modal-body").first.evaluate(
        "el => ({clientWidth: el.clientWidth, scrollWidth: el.scrollWidth})"
    )
    if metrics["scrollWidth"] > metrics["clientWidth"] + 1:
        fail(page, f"modal body overflows horizontally in {where}: {metrics}")
    print(f"PASS: no horizontal overflow in the article modal body ({where}): {metrics['clientWidth']}px")


def assert_title_visible(page, dialog, title_input, where):
    """The 标题 field must not be scrolled out of the modal body."""
    title_box = title_input.bounding_box()
    modal_box = dialog.bounding_box()
    head_box = dialog.locator(".wkn-modal-head").bounding_box()
    scroll_top = dialog.locator(".wkn-modal-body").first.evaluate("el => el.scrollTop")
    if title_box is None or modal_box is None or head_box is None:
        fail(page, f"标题 field has no layout box in {where}")
    if title_box["y"] < head_box["y"] + head_box["height"] - 1:
        fail(page, f"标题 field is clipped above in {where}: title={title_box}, head={head_box}")
    if title_box["y"] + title_box["height"] > modal_box["y"] + modal_box["height"] + 1:
        fail(page, f"标题 field is clipped below in {where}: title={title_box}, modal={modal_box}")
    if scroll_top != 0:
        fail(page, f"article modal body is scrolled in {where} (scrollTop={scroll_top})")
    print(f"PASS: 标题 field visible without scrolling ({where})")


def fail(page, message):
    page.screenshot(path=str(OUT / "failure.png"), full_page=True)
    print(f"FAIL: {message}")
    print("--- visible text ---")
    print(page.inner_text("body")[:4000])
    raise SystemExit(1)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
    page = context.new_page()
    page.on("dialog", lambda dialog: dialog.accept())
    # The panel uses window.confirm for destructive actions; a stubbed confirm
    # keeps the test deterministic across headless dialog handling.
    page.add_init_script("window.confirm = () => true")
    console = []
    page.on("console", lambda message: console.append(f"{message.type}: {message.text}"))
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_timeout(6000)

    # A fresh DSH home walks through a preview notice and then offers an API
    # key setup; neither is under test, so dismiss whatever is covering the
    # shell (the dialog stack can show the next one immediately).
    for _ in range(4):
        dismissed = False
        for label in ("继续", "Continue", "稍后配置", "Configure later", "关闭", "Close"):
            candidate = page.get_by_role("button", name=label, exact=True)
            if candidate.count() > 0 and candidate.first.is_visible():
                candidate.first.click()
                page.wait_for_timeout(900)
                dismissed = True
                break
        if not dismissed:
            break

    # 1. The sidebar entry contributed by the plugin must be present.
    try:
        entry = page.get_by_role("button", name="知识库", exact=True).first
        entry.wait_for(state="visible", timeout=15000)
    except Exception:
        fail(page, 'left sidebar has no "知识库" entry')
    page.screenshot(path=str(OUT / "01-sidebar.png"))

    # 2. Opening it selects the main panel and loads the knowledge bases.
    entry.click()
    page.wait_for_timeout(2500)
    panel = page.locator(".wkn-root")
    panel.wait_for(state="visible", timeout=10000)
    if "产品文档" not in panel.inner_text():
        fail(page, "knowledge base list did not render (产品文档 missing)")
    if "新建知识库" not in panel.inner_text():
        fail(page, "new-knowledge-base action missing")
    assert_uniform_controls(page, "knowledge-base list")
    page.screenshot(path=str(OUT / "02-kbs.png"))

    # 2b. Settings round-trip: the host probe must reach the deployment.
    panel.get_by_role("button", name="设置", exact=True).first.click()
    page.wait_for_timeout(800)
    page.get_by_role("button", name="测试连接", exact=True).click()
    page.wait_for_timeout(1200)
    if "连接成功" not in panel.inner_text():
        fail(page, "test-connection did not report success")
    page.get_by_role("button", name="关闭", exact=True).last.click()
    page.wait_for_timeout(500)

    # 2c. Create a knowledge base, then delete it again.
    page.get_by_role("button", name="新建知识库").first.click()
    dialog = page.locator(".wkn-modal")
    dialog.wait_for(state="visible", timeout=5000)
    dialog.locator("input.wkn-input").first.fill(KB_NAME)
    page.get_by_role("button", name="创建", exact=True).click()
    page.wait_for_timeout(1800)
    if KB_NAME not in panel.inner_text():
        fail(page, "created knowledge base is not in the grid")
    page.get_by_text(KB_NAME, exact=True).first.click()
    page.wait_for_timeout(1200)
    page.get_by_role("button", name="删除知识库", exact=True).click()
    page.wait_for_timeout(1800)
    # The success banner names the deleted KB, so look at the cards, not text.
    if panel.locator(".wkn-kb-name", has_text=KB_NAME).count() > 0:
        fail(page, "deleted knowledge base is still listed")
    if "已删除知识库" not in panel.inner_text():
        fail(page, "delete did not report success")

    # 3. Open one knowledge base and see its document table.
    page.get_by_text("产品文档", exact=True).first.click()
    page.wait_for_timeout(1500)
    body = panel.inner_text()
    if "退款流程" not in body or "上传文件" not in body:
        fail(page, "document table did not render")
    assert_uniform_controls(page, "document table")
    page.screenshot(path=str(OUT / "03-documents.png"))

    # 4. Create a manual article with the vendored Toast UI Editor (WYSIWYG by
    # default): heading from the visual toolbar, a table from the table picker,
    # and a Markdown-source round-trip.
    page.get_by_role("button", name="新建文章").first.click()
    dialog = page.locator(".wkn-modal.wkn-modal-wide")
    dialog.wait_for(state="visible", timeout=5000)
    title_input = dialog.locator("input.wkn-input").first
    title_input.fill(ARTICLE)
    if dialog.locator(".wkn-md-shell").count() == 0:
        fail(page, "article dialog has no .wkn-md-shell container")
    try:
        dialog.locator(".wkn-toastui .toastui-editor-defaultUI").wait_for(state="visible", timeout=20000)
    except Exception:
        fail(page, "Toast UI Editor did not load from the host vendor route")
    page.wait_for_timeout(800)
    if dialog.locator(".wkn-md-loading").count() != 0:
        fail(page, "editor loading placeholder is still visible after the editor became ready")

    # The vendored editor must be the Chinese Toast UI toolbar.
    labels = dialog.locator(".toastui-editor-toolbar-icons").evaluate_all(
        "els => els.map(el => el.getAttribute('aria-label') || '')"
    )
    expected_labels = [
        "标题", "加粗", "斜体字", "删除线", "水平线", "引用块", "无序列表", "有序列表",
        "任务", "缩进", "减少缩进", "插入表格", "插入链接", "内嵌代码", "插入代码块",
    ]
    if labels[:15] != expected_labels:
        fail(page, f"Toast UI toolbar is not the expected Chinese toolbar: {labels}")
    prose = dialog.locator(".toastui-editor-ww-container .ProseMirror")
    if prose.count() != 1 or not prose.is_visible():
        fail(page, "WYSIWYG .toastui-editor-ww-container .ProseMirror body is missing")
    tabs = dialog.locator(".toastui-editor-mode-switch .tab-item")
    tab_texts = [text.strip() for text in tabs.all_inner_texts()]
    if tab_texts != ["Markdown", "所见即所得"]:
        fail(page, f"mode switch tabs are {tab_texts}, expected Markdown/所见即所得")
    if "active" not in (tabs.nth(1).get_attribute("class") or ""):
        fail(page, "所见即所得 is not the active mode when the editor opens")
    print("PASS: Toast UI Editor loaded from the vendor route (Chinese toolbar, WYSIWYG, Markdown/所见即所得)")
    assert_title_visible(page, dialog, title_input, "WYSIWYG on open")
    assert_modal_body_no_h_overflow(page, dialog, "WYSIWYG on open")

    # Type the body, turn the line into a level-2 heading through the toolbar.
    prose.click()
    page.keyboard.insert_text("端到端测试正文。")
    page.wait_for_timeout(400)
    dialog.locator(".toastui-editor-toolbar-icons[aria-label='标题']").click()
    page.wait_for_timeout(400)
    dialog.locator(".toastui-editor-popup-add-heading li[data-level='2']").click()
    page.wait_for_timeout(500)
    heading = dialog.locator(".toastui-editor-ww-container .ProseMirror h2")
    if heading.count() != 1 or "端到端测试正文" not in heading.inner_text():
        fail(page, "标题 toolbar did not turn the line into a level-2 heading")

    # Insert a 3x3 table through the visual table picker (mouse coordinates:
    # a selection layer intercepts clicks on individual picker cells).
    dialog.locator(".toastui-editor-toolbar-icons[aria-label='插入表格']").click()
    page.wait_for_timeout(500)
    cells = dialog.locator(".toastui-editor-popup-add-table .toastui-editor-table-cell")
    if cells.count() != 36:
        fail(page, f"table picker has {cells.count()} cells, expected 36 (6x6)")
    target = cells.nth(2 * 6 + 2)  # third row, third column
    box = target.bounding_box()
    if box is None:
        fail(page, "table picker target cell has no bounding box")
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.wait_for_timeout(900)
    table = dialog.locator(".toastui-editor-ww-container table")
    if table.count() != 1 or table.locator("tr").count() != 3:
        fail(page, f"visual table insertion produced {table.count()} tables / {table.locator('tr').count()} rows, expected 1 / 3")
    print(f"PASS: visual table picker inserted a 3x3 table ({table.locator('tr').count()} rows)")
    assert_title_visible(page, dialog, title_input, "WYSIWYG with table")
    assert_modal_body_no_h_overflow(page, dialog, "WYSIWYG with table")
    page.screenshot(path=str(OUT / "04b-markdown-editor.png"))

    # 4b. Paste plain-text Markdown into WYSIWYG: it must be converted to rich
    # HTML (heading, inline styles, lists, quote, table, link), not stay literal.
    pasted_markdown = """## 粘贴标题

**粗体** 和 *斜体* 和 ~~删除~~ 和 `代码`

- 列表一
- 列表二

1. 步骤一
2. 步骤二

> 引用段落

| 列A | 列B |
| --- | --- |
| 值1 | 值2 |

[链接](https://example.com)"""
    paste_not_prevented = page.evaluate(
        """(md) => {
          const target = document.querySelector('.wkn-modal.wkn-modal-wide .toastui-editor-ww-container .ProseMirror');
          target.focus();
          const range = document.createRange();
          range.setStart(target, target.childNodes.length);
          range.collapse(true);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          const data = new DataTransfer();
          data.setData('text/plain', md);
          const event = new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: data});
          return target.dispatchEvent(event);
        }""",
        pasted_markdown,
    )
    if paste_not_prevented is not False:
        fail(page, "Markdown paste was not intercepted (the default paste was not prevented)")
    page.wait_for_timeout(1200)
    pasted = dialog.locator(".toastui-editor-ww-container .ProseMirror").evaluate(
        """(root) => {
          const count = (selector) => root.querySelectorAll(selector).length;
          return {
            h2: count('h2'), strong: count('strong'), em: count('em'), del: count('del'),
            code: count('code'), ul: count('ul'), ulLi: count('ul li'), ol: count('ol'),
            olLi: count('ol li'), blockquote: count('blockquote'), table: count('table'),
            links: count('a'), literalHeading: root.innerText.includes('## 粘贴标题'),
          };
        }"""
    )
    expected_paste = {
        "h2": 2, "strong": 1, "em": 1, "del": 1, "code": 1, "ul": 1, "ulLi": 2,
        "ol": 1, "olLi": 2, "blockquote": 1, "table": 2, "links": 1,
    }
    for key, expected in expected_paste.items():
        if pasted[key] != expected:
            fail(page, f"pasted Markdown did not render {key}: got {pasted[key]}, expected {expected}; counts={pasted}")
    if pasted["literalHeading"]:
        fail(page, "pasted Markdown stayed literal in WYSIWYG (found the text '## 粘贴标题')")
    print("PASS: pasted Markdown converted to rich WYSIWYG content (h2/strong/em/del/code/lists/quote/table/link)")
    assert_modal_body_no_h_overflow(page, dialog, "WYSIWYG after paste")

    # 4c. Typed Markdown block shortcuts in a fresh paragraph: "# " -> h1,
    # "- " -> bullet list (the caret is moved to the end of the document first).
    page.evaluate(
        """() => {
          const target = document.querySelector('.wkn-modal.wkn-modal-wide .toastui-editor-ww-container .ProseMirror');
          target.focus();
          const range = document.createRange();
          range.setStart(target, target.childNodes.length);
          range.collapse(true);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }"""
    )
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    page.keyboard.type("# ")
    page.wait_for_timeout(400)
    page.keyboard.insert_text("一级标题")
    page.wait_for_timeout(400)
    shortcut_heading = dialog.locator(".toastui-editor-ww-container .ProseMirror h1")
    if shortcut_heading.count() != 1 or "一级标题" not in shortcut_heading.inner_text():
        fail(page, "typed '# ' shortcut did not create an h1 heading")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    page.keyboard.type("- ")
    page.wait_for_timeout(400)
    page.keyboard.insert_text("列表项")
    page.wait_for_timeout(600)
    shortcut_lists = dialog.locator(".toastui-editor-ww-container .ProseMirror ul")
    if shortcut_lists.count() != 2 or dialog.locator(".toastui-editor-ww-container .ProseMirror ul li").count() != 3:
        fail(page, f"typed '- ' shortcut did not create a bullet list (ul={shortcut_lists.count()})")
    print("PASS: typed '# ' and '- ' shortcuts created an h1 heading and a bullet list")
    scroll_editor_to_top(page)
    page.screenshot(path=str(OUT / "04e-paste-typing.png"))

    # Markdown mode: the source pane must carry the heading and table syntax,
    # plus the converted pasted Markdown without escaped markers.
    tabs.filter(has_text="Markdown").first.click()
    page.wait_for_timeout(1200)
    markdown_source = dialog.locator(".toastui-editor-md-container").inner_text()
    for needle in (
        "## 端到端测试正文",
        "| --- |",
        "## 粘贴标题",
        "**粗体**",
        "*斜体*",
        "~~删除~~",
        "`代码`",
        "[链接](https://example.com)",
    ):
        if needle not in markdown_source:
            fail(page, f"Markdown source pane is missing {needle!r}: {markdown_source[:400]!r}")
    if "\\#" in markdown_source or "\\*\\*" in markdown_source:
        fail(page, f"Markdown source pane contains escaped markers: {markdown_source[:400]!r}")
    assert_title_visible(page, dialog, title_input, "Markdown mode")
    assert_modal_body_no_h_overflow(page, dialog, "Markdown mode")
    scroll_editor_to_top(page)
    page.screenshot(path=str(OUT / "04c-markdown-split.png"))

    # Back to WYSIWYG: headings, tables and typed shortcuts must survive the
    # Markdown round-trip (toolbar heading/table + pasted heading/table).
    tabs.filter(has_text="所见即所得").first.click()
    page.wait_for_timeout(1200)
    round_trip = dialog.locator(".toastui-editor-ww-container .ProseMirror").evaluate(
        """(root) => {
          const count = (selector) => root.querySelectorAll(selector).length;
          return {h1: count('h1'), h2: count('h2'), table: count('table'), ul: count('ul'), ol: count('ol'), blockquote: count('blockquote')};
        }"""
    )
    if round_trip["h2"] != 2:
        fail(page, f"WYSIWYG mode lost a heading after the Markdown round-trip: {round_trip}")
    if round_trip["table"] != 2:
        fail(page, f"WYSIWYG mode lost a table after the Markdown round-trip: {round_trip}")
    if round_trip["h1"] != 1 or round_trip["ul"] != 2 or round_trip["ol"] != 1 or round_trip["blockquote"] != 1:
        fail(page, f"WYSIWYG mode lost typed/pasted structure after the Markdown round-trip: {round_trip}")
    print("PASS: Markdown source exposed heading/table/paste syntax and the round-trip kept all structure")

    dialog.locator("select.wkn-select").first.select_option("publish")
    page.get_by_role("button", name="保存", exact=True).click()
    page.wait_for_timeout(2500)
    if ARTICLE not in panel.inner_text():
        fail(page, "created article is not in the document table")
    page.screenshot(path=str(OUT / "04-article-created.png"))

    # 4b. Reopen the article: the title and Markdown body must be prefilled.
    row = panel.locator(".wkn-table tbody tr", has_text=ARTICLE).first
    row.get_by_role("button", name="编辑", exact=True).click()
    edit_dialog = page.locator(".wkn-modal.wkn-modal-wide")
    edit_dialog.wait_for(state="visible", timeout=5000)
    try:
        edit_dialog.locator(".wkn-toastui .toastui-editor-defaultUI").wait_for(state="visible", timeout=20000)
    except Exception:
        fail(page, "edit-article dialog Toast UI Editor did not load")
    page.wait_for_timeout(900)
    if edit_dialog.locator("input.wkn-input").first.input_value() != ARTICLE:
        fail(page, "edit-article dialog did not prefill the title")
    edit_body = edit_dialog.locator(".toastui-editor-ww-container .ProseMirror")
    edit_text = edit_body.inner_text()
    for needle in ("端到端测试正文", "粘贴标题", "一级标题", "列表项"):
        if needle not in edit_text:
            fail(page, f"edit-article dialog did not prefill {needle!r}")
    if edit_dialog.locator(".toastui-editor-ww-container table").count() != 2:
        fail(page, "edit-article dialog did not prefill both Markdown tables")
    if edit_body.locator("h2").count() != 2 or edit_body.locator("h1").count() != 1:
        fail(page, "edit-article dialog did not prefill the heading structure")
    print("PASS: edit-article dialog prefilled title, body text and table")
    assert_modal_body_no_h_overflow(page, edit_dialog, "edit-article dialog")
    page.screenshot(path=str(OUT / "04d-article-edit.png"))
    edit_dialog.get_by_role("button", name="取消", exact=True).click()
    page.wait_for_timeout(600)
    if page.locator(".wkn-modal").count() != 0:
        fail(page, "取消 did not close the edit-article dialog")

    # 4c. Re-parse and delete the article through the row actions.
    row = panel.locator(".wkn-table tbody tr", has_text=ARTICLE).first
    row.get_by_role("button", name="重新解析", exact=True).click()
    page.wait_for_timeout(1500)
    if "已提交重新解析" not in panel.inner_text():
        fail(page, "reparse action did not report success")
    row = panel.locator(".wkn-table tbody tr", has_text=ARTICLE).first
    row.get_by_role("button", name="删除", exact=True).click()
    page.wait_for_timeout(1800)
    if panel.locator(".wkn-table tbody tr", has_text=ARTICLE).count() > 0:
        fail(page, "deleted article is still in the document table")
    if "已删除" not in panel.inner_text():
        fail(page, "delete did not report success")

    # 5. Upload one file through the real multipart proxy.
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as handle:
        handle.write("# 上传测试\n\n上传文件的内容。")
        upload_path = handle.name
    page.locator("input[type=file]").first.set_input_files(upload_path)
    page.wait_for_timeout(2500)
    if "upload-test" not in panel.inner_text() and "上传测试" not in panel.inner_text():
        # The mock names the row after the file; the browser uploads the
        # temporary name, so accept its stem too.
        upload_name = Path(upload_path).stem
        if upload_name not in panel.inner_text():
            fail(page, "uploaded file is not in the document table")
    page.screenshot(path=str(OUT / "05-uploaded.png"))

    # 5b. Drag-and-drop upload: the overlay must appear on dragover and the
    # dropped file must land in the open knowledge base.
    dropped = f"dropped-{RUN}.md"
    dropped_stem = f"dropped-{RUN}"
    page.evaluate(
        """(name) => {
          const dt = new DataTransfer();
          dt.items.add(new File(['# 拖拽测试\\n\\n通过拖拽上传的文件。'], name, {type: 'text/markdown'}));
          const root = document.querySelector('.wkn-root');
          for (const type of ['dragenter', 'dragover']) {
            root.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: dt}));
          }
        }""",
        dropped,
    )
    page.wait_for_timeout(400)
    if page.locator(".wkn-drop-overlay").count() == 0:
        fail(page, "drag overlay did not appear on dragover")
    page.screenshot(path=str(OUT / "05b-dragover.png"))
    page.evaluate(
        """(name) => {
          const dt = new DataTransfer();
          dt.items.add(new File(['# 拖拽测试\\n\\n通过拖拽上传的文件。'], name, {type: 'text/markdown'}));
          const root = document.querySelector('.wkn-root');
          root.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt}));
        }""",
        dropped,
    )
    page.wait_for_timeout(3000)
    if dropped_stem not in panel.inner_text():
        fail(page, "dropped file is not in the document table")
    if page.locator(".wkn-drop-overlay").count() != 0:
        fail(page, "drop overlay did not disappear after drop")
    page.screenshot(path=str(OUT / "05c-dropped.png"))

    # 5c. Folder picker: every file keeps its relative directory path.
    folder_name = f"wkn-folder-{RUN}"
    folder_root = Path(tempfile.mkdtemp(prefix="wkn-e2e-"))
    os.makedirs(folder_root / folder_name / "subdir")
    top_name = f"folder-top-{RUN}"
    nested_name = f"folder-nested-{RUN}"
    (folder_root / folder_name / f"{top_name}.md").write_text("# top", encoding="utf-8")
    (folder_root / folder_name / "subdir" / f"{nested_name}.md").write_text("# nested", encoding="utf-8")
    page.locator("input[webkitdirectory]").set_input_files(str(folder_root / folder_name))
    page.wait_for_timeout(3500)
    sidebar_text = panel.inner_text()
    if top_name not in sidebar_text or nested_name not in sidebar_text:
        fail(page, "folder picker did not upload both files")
    if panel.locator(".wkn-cell-name span[title*='subdir']").count() == 0:
        fail(page, "folder picker did not preserve the relative directory path")
    page.screenshot(path=str(OUT / "05d-folder.png"))

    # 6. Chat with the WeKnora agent.
    page.get_by_role("button", name="智能体", exact=True).click()
    page.wait_for_timeout(2000)
    agent_panel_text = panel.inner_text()
    if "售后助手" not in agent_panel_text:
        fail(page, "agent list did not include 售后助手")
    page.get_by_role("button", name="售后助手", exact=False).first.click()
    page.locator("input.wkn-input").first.fill("退款期限是多久？")
    page.get_by_role("button", name="发送", exact=True).click()
    page.wait_for_timeout(4000)
    chat_text = panel.inner_text()
    if "签收后 7 天内可申请退款" not in chat_text:
        fail(page, "agent answer did not stream into the panel")
    if "引用来源" not in chat_text and "退款流程" not in chat_text:
        fail(page, "agent citations did not render")
    page.screenshot(path=str(OUT / "06-agent-chat.png"))

    # 7. The search tab still works.
    page.get_by_role("button", name="检索", exact=True).click()
    page.wait_for_timeout(1000)
    page.locator("input.wkn-input").first.fill("退款")
    page.get_by_role("button", name="检索", exact=True).last.click()
    page.wait_for_timeout(2000)
    if "score" not in panel.inner_text() and "命中" not in panel.inner_text():
        fail(page, "retrieval tab did not render hits")
    page.screenshot(path=str(OUT / "07-search.png"))

    errors = [line for line in console if line.startswith("error:")]
    if errors:
        print("console errors (non-fatal unless the page broke):")
        for line in errors:
            print("  ", line[:300])

    print("PASS: sidebar entry, knowledge bases, article create/upload, agent chat, search")
    browser.close()
