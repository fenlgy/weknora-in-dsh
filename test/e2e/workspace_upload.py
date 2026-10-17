"""End-to-end check for the workspace-file upload shortcut.

The shortcut lives in the right-sidebar document preview: a header button opens
a knowledge-base picker and uploads the previewed file through the plugin proxy.

Prerequisites (same as panel.py): a mock WeKnora on 19090 and an isolated DSH
web app started with `SSH_CONNECTION` set so the in-app directory picker is used
instead of the native OS dialog. The app must be launched from the repository
root so the created workspace points at this checkout.

Usage: python3 test/e2e/workspace_upload.py <web-url-with-token>
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = sys.argv[1]
REPO = Path(__file__).resolve().parents[2]
REPO_NAME = REPO.name
OUT = Path(__file__).parent / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)


def fail(page, message):
    page.screenshot(path=str(OUT / "workspace-upload-failure.png"), full_page=True)
    print(f"FAIL: {message}")
    print(page.inner_text("body")[:2500])
    raise SystemExit(1)


def dismiss_startup(page):
    for label in ("继续", "稍后配置", "关闭"):
        button = page.get_by_role("button", name=label, exact=True)
        if button.count() > 0 and button.first.is_visible():
            button.first.click()
            page.wait_for_timeout(700)


def ensure_workspace(page):
    if REPO_NAME in page.inner_text("body"):
        return
    page.get_by_role("button", name="添加工作区", exact=True).click()
    page.wait_for_timeout(1500)
    dialog = page.locator('[role="dialog"]')
    dialog.wait_for(state="visible", timeout=5000)
    home = dialog.get_by_role("button", name="主目录", exact=True)
    if home.count() > 0:
        home.first.click()
        page.wait_for_timeout(600)
    parent = dialog.get_by_role("button", name=REPO.parent.name, exact=True)
    if parent.count() > 0:
        parent.first.click()
        page.wait_for_timeout(600)
    target = dialog.get_by_role("button", name=REPO_NAME, exact=True)
    if target.count() == 0:
        fail(page, f"directory picker does not show {REPO}")
    target.first.click()
    page.wait_for_timeout(600)
    page.get_by_role("button", name="打开", exact=True).click()
    page.wait_for_timeout(2500)


def open_workspace_file(page):
    # A session is needed before the right sidebar owns a file tree.
    page.get_by_role("button", name="新建会话", exact=False).first.click()
    page.wait_for_timeout(2500)
    open_right = page.get_by_label("打开右侧边栏")
    if open_right.count() > 0:
        open_right.first.click()
        page.wait_for_timeout(1200)
    card = page.get_by_text("工作区文件", exact=True)
    if card.count() > 0:
        card.first.click()
    page.wait_for_timeout(2500)
    if page.locator("[data-files-body]").count() == 0:
        # Fallback for the file tab shortcut shown on the Start panel.
        page.keyboard.press("Alt+Meta+p")
        page.wait_for_timeout(2500)
    if page.locator("[data-files-body]").count() == 0:
        fail(page, "files tab did not open")
    readme = page.get_by_text("README.md", exact=True)
    if readme.count() == 0:
        fail(page, "README.md is not in the files tree")
    readme.first.click()
    page.wait_for_timeout(3000)
    if page.locator("[data-textpreview-body]").count() == 0:
        fail(page, "README.md preview did not open")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="zh-CN")
    page = context.new_page()
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_timeout(6000)
    dismiss_startup(page)
    ensure_workspace(page)

    open_workspace_file(page)
    shortcut = page.get_by_label("上传到知识库")
    if shortcut.count() == 0:
        fail(page, "upload shortcut is missing from the preview header")
    shortcut.first.click()
    page.wait_for_timeout(1800)
    menu = page.locator(".wkn-up-menu")
    if menu.count() == 0:
        fail(page, "knowledge-base menu did not open")
    menu_text = menu.inner_text()
    if "产品文档" not in menu_text:
        fail(page, f"menu does not list the mock knowledge bases: {menu_text[:300]}")
    page.screenshot(path=str(OUT / "08-workspace-upload.png"), full_page=True)

    page.locator(".wkn-up-item", has_text="产品文档").first.click()
    # The successful upload auto-closes the menu after ~1.2s.
    try:
        menu.wait_for(state="detached", timeout=8000)
    except Exception:
        fail(page, "menu did not close after the upload")

    # The uploaded document must be visible in the knowledge panel.
    page.get_by_role("button", name="知识库", exact=True).first.click()
    page.wait_for_timeout(3000)
    panel = page.locator(".wkn-root")
    panel.get_by_text("产品文档", exact=True).first.click()
    page.wait_for_timeout(2500)
    if "README" not in panel.inner_text():
        fail(page, "README was not uploaded into the knowledge base")
    page.screenshot(path=str(OUT / "08b-workspace-uploaded.png"), full_page=True)

    print("PASS: workspace file shortcut opens the KB menu and uploads README.md")
    browser.close()
