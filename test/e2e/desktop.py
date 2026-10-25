"""Verify the plugin inside the *running desktop DSH window's* web server.

Reuses the desktop app's own auth cookie (read from its Chromium cookie store)
so a headless browser can load the real GUI without touching the user's window.
Read-only: it never creates, saves or deletes anything in WeKnora. The article
editor is opened, exercised, and always dismissed with 取消.

The GUI origin is taken from the auth cookie's JWT `authority` claim (the
desktop app's port changes between launches); pass a URL as the third argument
to override it.

Usage: python3 test/e2e/desktop.py <cookie-name> <cookie-value> [base-url]
"""
import base64
import json
import sys
import time
from pathlib import Path
from urllib.parse import unquote

from playwright.sync_api import sync_playwright

NAME, VALUE = sys.argv[1], sys.argv[2]
OUT = Path(__file__).parent / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)
RUN = str(int(time.time()))[-5:]
ARTICLE_TITLE = f"MARKDOWN-E2E-{RUN}"


def auth_authority(cookie_value):
    """Return the JWT authority (host:port) carried by the dsh-auth cookie."""
    try:
        payload = unquote(cookie_value).split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))["authority"]
    except Exception:
        return None


AUTHORITY = auth_authority(VALUE)
URL = sys.argv[3] if len(sys.argv) > 3 else (f"http://{AUTHORITY}/" if AUTHORITY else "http://127.0.0.1:50747/")

# The vendored Toast UI Editor ships a Chinese toolbar; aria-labels in order.
TOASTUI_TOOLBAR_LABELS = [
    "标题", "加粗", "斜体字", "删除线", "水平线", "引用块", "无序列表", "有序列表",
    "任务", "缩进", "减少缩进", "插入表格", "插入链接", "内嵌代码", "插入代码块",
]


def fail(page, message):
    page.screenshot(path=str(OUT / "desktop-failure.png"), full_page=True)
    print(f"FAIL: {message}")
    print(page.inner_text("body")[:2000])
    raise SystemExit(1)


def dump_modal(page, tag):
    """Save the current modal markup outside the repo for baseline comparison."""
    modal = page.locator(".wkn-modal").last
    html = modal.inner_html() if modal.count() > 0 else ""
    path = Path("/tmp") / f"wkn-modal-{tag}.html"
    path.write_text(html, encoding="utf-8")
    print(f"DEBUG: modal DOM ({len(html)} bytes) saved to {path}")
    print(html[:4000])
    return html


def open_kb(page, panel, index):
    """Open the KB card at `index` and wait until its document list settled."""
    card = panel.locator(".wkn-kb").nth(index)
    name = card.inner_text().splitlines()[0].strip()
    card.click()
    page.wait_for_timeout(600)
    try:
        panel.locator(".wkn-crumbs .wkn-card-title").first.wait_for(state="visible", timeout=10000)
        panel.locator(".wkn-table, .wkn-empty").first.wait_for(state="visible", timeout=20000)
    except Exception:
        return name, -1
    page.wait_for_timeout(400)
    return name, panel.locator(".wkn-table tbody tr").count()


def back_to_kb_list(page, panel):
    """Return to the knowledge-base grid from an open knowledge base."""
    crumbs = panel.locator(".wkn-crumbs .wkn-link")
    if crumbs.count() > 0:
        crumbs.first.click()
        page.wait_for_timeout(800)
    panel.locator(".wkn-kb").first.wait_for(state="visible", timeout=10000)


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


def assert_no_horizontal_overflow(page, modal, where):
    """The modal body must never scroll horizontally (content-box width bug).

    `.wkn-textarea`/`.wkn-editor`/`.wkn-table-grid input` use `width:100%`;
    with the default `box-sizing:content-box` their padding+border pushed the
    body 2px wider than its client width and produced a scrollbar. This checks
    the body itself and every descendant whose right edge escapes it, skipping
    nodes that are legitimately clipped/scrolled by their own container.
    """
    metrics = modal.locator(".wkn-modal-body").first.evaluate(
        """(element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const contentLeft = rect.left + (parseFloat(style.borderLeftWidth) || 0);
          const contentRight = rect.right - (parseFloat(style.borderRightWidth) || 0);
          const offenders = [];
          for (const node of element.querySelectorAll('*')) {
            const box = node.getBoundingClientRect();
            if (box.width === 0 || box.height === 0) continue;
            let exempt = false;
            for (let parent = node; parent !== null && parent !== element; parent = parent.parentElement) {
              const parentStyle = getComputedStyle(parent);
              const overflowX = parentStyle.overflowX;
              if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden'
                  || parentStyle.position === 'fixed' || parentStyle.position === 'sticky') {
                exempt = true;
                break;
              }
            }
            if (exempt) continue;
            if (box.right > contentRight + 1 || box.left < contentLeft - 1) {
              offenders.push({
                tag: node.tagName,
                cls: typeof node.className === 'string' ? node.className : '',
                left: Math.round(box.left * 10) / 10,
                right: Math.round(box.right * 10) / 10,
              });
            }
          }
          const owner = element.closest('.wkn-modal');
          const ownerRect = owner === null ? null : owner.getBoundingClientRect();
          return {
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            contentLeft: Math.round(contentLeft * 10) / 10,
            contentRight: Math.round(contentRight * 10) / 10,
            modal: ownerRect === null ? null : {
              left: Math.round(ownerRect.left * 10) / 10,
              right: Math.round(ownerRect.right * 10) / 10,
              width: Math.round(ownerRect.width * 10) / 10,
            },
            offenders: offenders.slice(0, 6),
          };
        }"""
    )
    problems = []
    if metrics["scrollWidth"] > metrics["clientWidth"] + 1:
        problems.append(f"scrollWidth {metrics['scrollWidth']} > clientWidth {metrics['clientWidth']}")
    if metrics["offenders"]:
        problems.append(
            "descendants past the body edge: "
            + ", ".join(f"{item['tag']}.{item['cls']} right={item['right']}" for item in metrics["offenders"])
        )
    if problems:
        fail(page, f"[{where}] horizontal overflow: " + "; ".join(problems) + f"; geometry={metrics}")
    print(
        f"PASS: no horizontal overflow ({where}): "
        f"clientWidth={metrics['clientWidth']} scrollWidth={metrics['scrollWidth']} "
        f"body x={metrics['contentLeft']}..{metrics['contentRight']}"
    )


def assert_title_visible(page, modal, title_input, where):
    """The 标题 field must sit below the modal head and need no body scrolling.

    The article modal's body is the scroll container (`.wkn-modal-body` has
    `overflow:auto`); a too-tall editor used to push the title out of view.
    """
    body = modal.locator(".wkn-modal-body")
    geometry = {
        "title": title_input.bounding_box(),
        "modal": modal.bounding_box(),
        "head": modal.locator(".wkn-modal-head").bounding_box(),
        "body": body.evaluate(
            "element => ({scrollTop: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight})"
        ),
        "viewport": page.viewport_size,
    }
    title, box, head, viewport = geometry["title"], geometry["modal"], geometry["head"], geometry["viewport"]
    problems = []
    if title is None or box is None or head is None:
        problems.append("missing layout box")
    else:
        head_bottom = head["y"] + head["height"]
        modal_bottom = box["y"] + box["height"]
        if not title_input.is_visible():
            problems.append("title input is not visible")
        if title["y"] < head_bottom - 1:
            problems.append(f"title top {title['y']:.1f} above visible body top {head_bottom:.1f}")
        if title["y"] + title["height"] > modal_bottom + 1:
            problems.append(f"title bottom {title['y'] + title['height']:.1f} below modal bottom {modal_bottom:.1f}")
        if title["y"] < -1 or title["y"] + title["height"] > viewport["height"] + 1:
            problems.append(f"title outside the {viewport['height']}px viewport")
    if geometry["body"]["scrollTop"] != 0:
        problems.append(f"modal body scrollTop is {geometry['body']['scrollTop']}")
    if problems:
        fail(page, f"[{where}] 标题 field is clipped: " + "; ".join(problems) + f"; geometry={geometry}")
    print(
        f"PASS: 标题 field visible without scrolling ({where}): "
        f"title y={title['y']:.0f}..{title['y'] + title['height']:.0f}, "
        f"modal y={box['y']:.0f}..{box['y'] + box['height']:.0f}, "
        f"body scrollTop={geometry['body']['scrollTop']} "
        f"({geometry['body']['clientHeight']}/{geometry['body']['scrollHeight']}px)"
    )


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
    context.add_cookies(
        [{"name": NAME, "value": VALUE, "domain": "127.0.0.1", "path": "/", "httpOnly": True, "secure": False}]
    )
    # A fresh context has an empty cache; the no-cache request headers make the
    # hard reload of the linked client.js explicit against the live desktop app.
    context.set_extra_http_headers({"Cache-Control": "no-cache", "Pragma": "no-cache"})
    page = context.new_page()
    console = []
    page.on("console", lambda message: console.append(f"{message.type}: {message.text}"))
    page.on("pageerror", lambda error: console.append(f"pageerror: {error}"))
    print(f"live GUI: {URL} (cookie authority: {AUTHORITY})")
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_timeout(7000)

    # Dismiss any first-run dialog that a fresh browser context sees.
    for _ in range(4):
        dismissed = False
        for label in ("继续", "稍后配置", "关闭", "Continue", "Configure later", "Close"):
            candidate = page.get_by_role("button", name=label, exact=True)
            if candidate.count() > 0 and candidate.first.is_visible():
                candidate.first.click()
                page.wait_for_timeout(800)
                dismissed = True
                break
        if not dismissed:
            break

    # 1. The desktop app's live sidebar must show the plugin's entry.
    entry = page.get_by_role("button", name="知识库", exact=True).first
    try:
        entry.wait_for(state="visible", timeout=15000)
    except Exception:
        fail(page, 'desktop sidebar has no "知识库" entry')
    page.screenshot(path=str(OUT / "desktop-sidebar.png"))

    # 2. The panel must load knowledge bases from the real deployment.
    entry.click()
    page.wait_for_timeout(3000)
    panel = page.locator(".wkn-root")
    panel.wait_for(state="visible", timeout=15000)
    text = panel.inner_text()
    if "个知识库" not in text:
        fail(page, f"real deployment did not render knowledge bases: {text[:400]}")
    page.screenshot(path=str(OUT / "desktop-panel.png"))

    # 3. Agents configured in WeKnora must be listed in the agent tab.
    page.get_by_role("button", name="智能体", exact=True).click()
    page.wait_for_timeout(2500)
    agent_text = panel.inner_text()
    if "内置" not in agent_text and "ReAct" not in agent_text and "RAG" not in agent_text:
        fail(page, f"agent list did not render: {agent_text[:600]}")
    page.screenshot(path=str(OUT / "desktop-agents.png"))

    # 4. Open a real knowledge base and its document table. Prefer one that has
    #    documents: only those can expose a manual article's 编辑 action.
    panel.locator(".wkn-tab", has_text="知识库").first.click()
    page.wait_for_timeout(1200)
    kb_total = panel.locator(".wkn-kb").count()
    if kb_total == 0:
        fail(page, "no knowledge-base card to open")
    chosen_index = 0
    chosen_name = None
    for index in range(kb_total):
        name, rows = open_kb(page, panel, index)
        print(f"knowledge base #{index + 1}: {name!r} document rows={rows}")
        if rows > 0:
            chosen_index, chosen_name = index, name
            break
        if index + 1 < kb_total:
            back_to_kb_list(page, panel)
    if chosen_name is None:
        # Every listed KB is empty; the editor can still be exercised.
        chosen_index = kb_total - 1
        chosen_name = panel.locator(".wkn-crumbs .wkn-card-title").first.inner_text().strip()
        print(f"note: no listed knowledge base has documents; using {chosen_name!r}")
    print(f"using knowledge base: {chosen_name}")
    page.screenshot(path=str(OUT / "desktop-documents.png"))

    # 5. Create-article dialog: the vendored Toast UI Editor must load.
    panel.get_by_role("button", name="新建文章", exact=True).first.click()
    try:
        modal = page.locator(".wkn-modal.wkn-modal-wide")
        modal.wait_for(state="visible", timeout=10000)
    except Exception:
        dump_modal(page, "create")
        fail(page, "new-article dialog did not open as .wkn-modal.wkn-modal-wide")
    page.wait_for_timeout(500)
    modal_box = modal.bounding_box()
    viewport_height = page.viewport_size["height"]
    if modal_box is None or modal_box["width"] < 1000:
        fail(page, f"wide article modal width is {0 if modal_box is None else round(modal_box['width'])}px, expected ~1040px")
    if modal_box["height"] > 0.92 * viewport_height + 2:
        fail(page, f"wide modal height {modal_box['height']:.1f}px exceeds max-height 92vh of {viewport_height}px")

    title_input = modal.locator("input.wkn-input").first
    title_input.fill(ARTICLE_TITLE)
    if modal.locator(".wkn-md-shell").count() == 0:
        fail(page, "article dialog has no .wkn-md-shell container")
    try:
        modal.locator(".wkn-toastui .toastui-editor-defaultUI").wait_for(state="visible", timeout=20000)
    except Exception:
        dump_modal(page, "toastui")
        fail(page, "Toast UI Editor did not load from the host vendor route")
    page.wait_for_timeout(800)
    if modal.locator(".wkn-md-loading").count() != 0:
        fail(page, "editor loading placeholder is still visible after the editor became ready")

    toolbar_labels = modal.locator(".toastui-editor-toolbar-icons").evaluate_all(
        "els => els.map(el => el.getAttribute('aria-label') || '')"
    )
    if toolbar_labels[:15] != TOASTUI_TOOLBAR_LABELS:
        fail(page, f"Toast UI toolbar is not the expected Chinese toolbar: {toolbar_labels}")
    prose = modal.locator(".toastui-editor-ww-container .ProseMirror")
    if prose.count() != 1 or not prose.is_visible():
        fail(page, "WYSIWYG .toastui-editor-ww-container .ProseMirror body is missing")
    tabs = modal.locator(".toastui-editor-mode-switch .tab-item")
    tab_texts = [text.strip() for text in tabs.all_inner_texts()]
    if tab_texts != ["Markdown", "所见即所得"]:
        fail(page, f"mode switch tabs are {tab_texts}, expected Markdown/所见即所得")
    if "active" not in (tabs.nth(1).get_attribute("class") or ""):
        fail(page, "所见即所得 is not the active mode when the editor opens")
    assert_title_visible(page, modal, title_input, "on open")
    assert_no_horizontal_overflow(page, modal, "create modal (WYSIWYG)")

    # 6. Type the body, turn the line into a level-2 heading via the toolbar,
    #    then insert a 3x3 table through the visual table picker (the picker's
    #    selection layer intercepts cell clicks, so click by mouse coordinates).
    prose.click()
    page.keyboard.insert_text("端到端测试正文。")
    page.wait_for_timeout(400)
    modal.locator(".toastui-editor-toolbar-icons[aria-label='标题']").click()
    page.wait_for_timeout(400)
    modal.locator(".toastui-editor-popup-add-heading li[data-level='2']").click()
    page.wait_for_timeout(500)
    heading = modal.locator(".toastui-editor-ww-container .ProseMirror h2")
    if heading.count() != 1 or "端到端测试正文" not in heading.inner_text():
        fail(page, "标题 toolbar did not turn the line into a level-2 heading")
    modal.locator(".toastui-editor-toolbar-icons[aria-label='插入表格']").click()
    page.wait_for_timeout(500)
    cells = modal.locator(".toastui-editor-popup-add-table .toastui-editor-table-cell")
    if cells.count() != 36:
        fail(page, f"table picker has {cells.count()} cells, expected 36 (6x6)")
    cell_box = cells.nth(2 * 6 + 2).bounding_box()
    if cell_box is None:
        fail(page, "table picker target cell has no bounding box")
    page.mouse.click(cell_box["x"] + cell_box["width"] / 2, cell_box["y"] + cell_box["height"] / 2)
    page.wait_for_timeout(900)
    table = modal.locator(".toastui-editor-ww-container table")
    if table.count() != 1 or table.locator("tr").count() != 3:
        fail(page, f"visual table insertion produced {table.count()} tables / {table.locator('tr').count()} rows, expected 1 / 3")
    page.screenshot(path=str(OUT / "04b-markdown-editor.png"))

    # 6b. Paste plain-text Markdown into WYSIWYG: it must convert to rich HTML.
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
    pasted = modal.locator(".toastui-editor-ww-container .ProseMirror").evaluate(
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
    assert_no_horizontal_overflow(page, modal, "create modal (WYSIWYG after paste)")

    # 6c. Typed block shortcuts in a fresh paragraph: "# " -> h1, "- " -> ul.
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
    shortcut_heading = modal.locator(".toastui-editor-ww-container .ProseMirror h1")
    if shortcut_heading.count() != 1 or "一级标题" not in shortcut_heading.inner_text():
        fail(page, "typed '# ' shortcut did not create an h1 heading")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    page.keyboard.type("- ")
    page.wait_for_timeout(400)
    page.keyboard.insert_text("列表项")
    page.wait_for_timeout(600)
    shortcut_lists = modal.locator(".toastui-editor-ww-container .ProseMirror ul")
    if shortcut_lists.count() != 2 or modal.locator(".toastui-editor-ww-container .ProseMirror ul li").count() != 3:
        fail(page, f"typed '- ' shortcut did not create a bullet list (ul={shortcut_lists.count()})")
    scroll_editor_to_top(page)
    page.screenshot(path=str(OUT / "04e-paste-typing.png"))

    # 7. Markdown mode: heading/table/paste syntax must be readable, with no
    #    escaped Markdown markers from the pasted content.
    tabs.filter(has_text="Markdown").first.click()
    page.wait_for_timeout(1200)
    source = modal.locator(".toastui-editor-md-container").inner_text()
    for needle in ("| --- |", "## 端到端测试正文", "## 粘贴标题", "**粗体**", "[链接](https://example.com)"):
        if needle not in source:
            fail(page, f"Markdown source pane is missing {needle!r}: {source[:400]!r}")
    if "\\#" in source or "\\*\\*" in source:
        fail(page, f"Markdown source pane contains escaped markers: {source[:400]!r}")
    assert_title_visible(page, modal, title_input, "Markdown mode")
    assert_no_horizontal_overflow(page, modal, "create modal (Markdown)")
    scroll_editor_to_top(page)
    page.screenshot(path=str(OUT / "04c-markdown-split.png"))

    # 8. Back to WYSIWYG: all structure must survive the round-trip. This
    #    probe is read-only, so always cancel instead of saving.
    tabs.filter(has_text="所见即所得").first.click()
    page.wait_for_timeout(1200)
    round_trip = modal.locator(".toastui-editor-ww-container .ProseMirror").evaluate(
        """(root) => {
          const count = (selector) => root.querySelectorAll(selector).length;
          return {h1: count('h1'), h2: count('h2'), table: count('table'), ul: count('ul'), ol: count('ol'), blockquote: count('blockquote')};
        }"""
    )
    if round_trip["h2"] != 2 or round_trip["table"] != 2:
        fail(page, f"WYSIWYG mode lost a heading/table after the Markdown round-trip: {round_trip}")
    if round_trip["h1"] != 1 or round_trip["ul"] != 2 or round_trip["ol"] != 1 or round_trip["blockquote"] != 1:
        fail(page, f"WYSIWYG mode lost typed/pasted structure after the Markdown round-trip: {round_trip}")
    modal.get_by_role("button", name="取消", exact=True).click()
    page.wait_for_timeout(600)
    if page.locator(".wkn-modal").count() != 0:
        fail(page, "取消 did not close the article editor")
    if ARTICLE_TITLE in panel.inner_text():
        fail(page, "cancelled article leaked into the document table")
    print("PASS: Toast UI editor loaded and was exercised (heading, visual table, Markdown round-trip), cancelled")

    # 9. Edit flow: only manual articles expose 编辑. Search the open knowledge
    #    base first, then the others (open + cancel only, nothing is written).
    edit_buttons = panel.locator(".wkn-table tbody tr button", has_text="编辑")
    if edit_buttons.count() == 0:
        back_to_kb_list(page, panel)
        for index in range(kb_total):
            if index == chosen_index:
                continue
            name, _rows = open_kb(page, panel, index)
            edit_buttons = panel.locator(".wkn-table tbody tr button", has_text="编辑")
            if edit_buttons.count() > 0:
                print(f"found a manual article row in {name!r}")
                break
            back_to_kb_list(page, panel)
    if edit_buttons.count() == 0:
        print("SKIP: no manual article row with 编辑 in any listed knowledge base")
    else:
        edit_buttons.first.click()
        try:
            edit_modal = page.locator(".wkn-modal.wkn-modal-wide")
            edit_modal.wait_for(state="visible", timeout=10000)
        except Exception:
            fail(page, "编辑 did not open the wide article editor")
        try:
            edit_modal.locator(".wkn-toastui .toastui-editor-defaultUI").wait_for(state="visible", timeout=20000)
        except Exception:
            fail(page, "edit-article Toast UI Editor did not load")
        page.wait_for_timeout(900)
        edit_title = edit_modal.locator("input.wkn-input").first.input_value()
        if edit_title.strip() == "":
            fail(page, "edit-article title is not prefilled")
        edit_body = edit_modal.locator(".toastui-editor-ww-container .ProseMirror")
        if edit_body.inner_text().strip() == "":
            fail(page, "edit-article WYSIWYG body is not prefilled")
        assert_no_horizontal_overflow(page, edit_modal, "edit modal (WYSIWYG)")
        edit_modal.locator(".toastui-editor-mode-switch .tab-item", has_text="Markdown").first.click()
        page.wait_for_timeout(1200)
        if edit_modal.locator(".toastui-editor-md-container").inner_text().strip() == "":
            fail(page, "edit-article Markdown source pane is empty")
        assert_no_horizontal_overflow(page, edit_modal, "edit modal (Markdown)")
        page.screenshot(path=str(OUT / "04d-article-edit.png"))
        edit_modal.get_by_role("button", name="取消", exact=True).click()
        page.wait_for_timeout(500)
        if page.locator(".wkn-modal").count() != 0:
            fail(page, "取消 did not close the edit-article dialog")
        print(f"PASS: edit-article flow prefilled {len(edit_body.inner_text())} WYSIWYG chars (cancelled)")

    errors = [line for line in console if line.startswith("error:") or line.startswith("pageerror:")]
    if errors:
        print(f"console errors ({len(errors)}):")
        for line in errors:
            print("  ", line[:300])
        relevant = [
            line
            for line in errors
            if line.startswith("pageerror:")
            or "wkn" in line.lower()
            or "toastui" in line.lower()
            or "__vendor" in line
            or "editor" in line.lower()
        ]
        if relevant:
            fail(page, f"{len(relevant)} console error(s) related to the panel/editor")
    else:
        print("no console errors")

    print("PASS: desktop sidebar entry, real knowledge bases, agents, Toast UI article editor")
    browser.close()
