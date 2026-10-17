"""End-to-end check for the `@` WeKnora knowledge-base source.

Types `@` in a fresh conversation composer, verifies the menu contains the mock
knowledge bases, picks one, and confirms the inserted composer chip plus the
canonical `@[name](weknora:kb/<id>)` draft text the host parser consumes.

Prerequisites: mock WeKnora on 19090 and an isolated DSH web app started with
`SSH_CONNECTION` set (so the in-app directory picker is used). See
workspace_upload.py for the full launch recipe.

Usage: python3 test/e2e/mention.py <web-url-with-token>
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
    page.screenshot(path=str(OUT / "mention-failure.png"), full_page=True)
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


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="zh-CN")
    page = context.new_page()
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_timeout(6000)
    dismiss_startup(page)
    ensure_workspace(page)
    page.get_by_role("button", name="新建会话", exact=False).first.click()
    page.wait_for_timeout(2500)

    composer = page.get_by_label("描述你想要构建的内容, / 调用指令, @ 文件或对话")
    if composer.count() == 0:
        fail(page, "composer is missing")
    composer.first.click()
    page.wait_for_timeout(300)
    page.keyboard.type("@产品")
    page.wait_for_timeout(2000)

    options = page.get_by_role("option")
    labels = [options.nth(index).inner_text() for index in range(options.count())]
    if not any("产品文档" in label for label in labels):
        fail(page, f"@ menu does not list the WeKnora knowledge bases: {labels}")
    if any("售后 FAQ" in label for label in labels):
        fail(page, f"@ query '产品' did not filter out 售后 FAQ: {labels}")
    page.screenshot(path=str(OUT / "09-mention.png"), full_page=True)

    page.get_by_role("option").filter(has_text="产品文档").first.click()
    page.wait_for_timeout(1200)
    chip = composer.locator('[data-composer-chip="weknora-kb"]')
    if chip.count() == 0:
        fail(page, "selecting a knowledge base did not insert the composer chip")
    if "产品文档" not in composer.inner_text():
        fail(page, "the inserted chip does not show the knowledge-base name")

    # The draft serializer must carry the canonical mention the host parses.
    draft = page.evaluate(
        """() => {
          for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (!key || !key.startsWith('dsh.conversation.')) continue;
            const raw = localStorage.getItem(key) ?? '';
            if (raw.includes('weknora:kb/')) return raw;
          }
          return '';
        }"""
    )
    if "weknora:kb/kb-1" not in draft:
        fail(page, f"draft does not serialize the canonical mention: {draft[:400]}")
    page.screenshot(path=str(OUT / "09-mention-selected.png"), full_page=True)

    print("PASS: @ menu lists filtered knowledge bases and inserts the canonical mention")
    browser.close()
