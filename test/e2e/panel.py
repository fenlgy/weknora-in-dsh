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
    page.screenshot(path=str(OUT / "03-documents.png"))

    # 4. Create a manual article.
    page.get_by_role("button", name="新建文章").first.click()
    dialog = page.locator(".wkn-modal")
    dialog.wait_for(state="visible", timeout=5000)
    dialog.locator("input.wkn-input").first.fill(ARTICLE)
    dialog.locator("textarea.wkn-textarea").first.fill("# 测试\n\n这是端到端测试创建的文章。")
    dialog.locator("select.wkn-select").first.select_option("publish")
    page.get_by_role("button", name="保存", exact=True).click()
    page.wait_for_timeout(2000)
    if ARTICLE not in panel.inner_text():
        fail(page, "created article is not in the document table")
    page.screenshot(path=str(OUT / "04-article-created.png"))

    # 4b. Re-parse and delete the article through the row actions.
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
