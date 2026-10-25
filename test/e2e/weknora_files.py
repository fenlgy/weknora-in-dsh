"""End-to-end check for the "+ menu → WeKnora files" composer picker.

Opens a new session, clicks the composer's "+" button ("添加文件或调用指令"),
picks the "WeKnora 文件" row added by the plugin, ticks two documents from the
mock deployment in the multi-select dialog, and confirms that:

  * two `weknora-doc` reference chips land in the composer;
  * the persisted draft carries the canonical
    `@[name](weknora:doc/<kb>/<doc>)` mentions the host parses.

Prerequisites (same as panel.py): a mock WeKnora on 19090 and an isolated DSH
web app started with `SSH_CONNECTION` set (so the in-app directory picker is
used). See workspace_upload.py for the full launch recipe.

Usage: python3 test/e2e/weknora_files.py <web-url-with-token>
"""
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = sys.argv[1]
REPO = Path(__file__).resolve().parents[2]
REPO_NAME = REPO.name
OUT = Path(__file__).parent / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)


def fail(page, message):
    page.screenshot(path=str(OUT / "weknora-files-failure.png"), full_page=True)
    print(f"FAIL: {message}")
    print(page.inner_text("body")[:2500])
    print("LOCALSTORAGE:", page.evaluate(
        """() => Object.keys(localStorage).map((key) => {
             const value = localStorage.getItem(key) ?? '';
             return value.includes('weknora:doc/') ? `${key}=${value}` : null;
           }).filter(Boolean)"""
    ))
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


def stored_drafts(page):
    """Every localStorage value that looks like a persisted conversation draft."""
    return page.evaluate(
        """() => Object.keys(localStorage)
             .map((key) => ({ key, value: localStorage.getItem(key) ?? '' }))
             .filter((entry) => entry.value.includes('weknora:doc/'))"""
    )


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

    add_button = page.get_by_role("button", name="添加文件或调用指令", exact=True)
    if add_button.count() == 0:
        fail(page, "the composer + button is missing")
    add_button.first.click()
    page.wait_for_timeout(900)
    page.screenshot(path=str(OUT / "09b-picker-menu.png"), full_page=True)

    row = page.get_by_text("WeKnora 文件", exact=True)
    if row.count() == 0:
        fail(page, "the + menu does not list the WeKnora files row")
    row.first.click()
    page.wait_for_timeout(500)

    dialog = page.locator('[role="dialog"][aria-label="从 WeKnora 添加文件"]')
    dialog.wait_for(state="visible", timeout=8000)
    page.screenshot(path=str(OUT / "10-picker-open.png"), full_page=True)

    kb = dialog.get_by_role("option", name=re.compile("产品文档"))
    kb.first.wait_for(state="visible", timeout=8000)
    kb.first.click()
    page.wait_for_timeout(1200)

    first = dialog.get_by_role("checkbox", name=re.compile("退款流程"))
    first.first.wait_for(state="visible", timeout=8000)
    if dialog.get_by_role("checkbox").count() < 2:
        fail(page, "the document list did not load the mock documents")
    first.first.click()
    page.wait_for_timeout(300)

    # Picking across knowledge bases must keep the earlier tick.
    second_kb = dialog.get_by_role("option", name=re.compile("售后 FAQ"))
    second_kb.first.click()
    page.wait_for_timeout(1200)
    second = dialog.get_by_role("checkbox", name=re.compile("售后政策"))
    second.first.wait_for(state="visible", timeout=8000)
    second.first.click()
    page.wait_for_timeout(300)

    foot = dialog.get_by_text("已选 2 个文件", exact=True)
    if foot.count() == 0:
        fail(page, "the selection counter did not reach 2")
    page.screenshot(path=str(OUT / "11-picker-selected.png"), full_page=True)

    dialog.get_by_role("button", name="添加 2 个文件", exact=True).click()
    page.wait_for_timeout(1200)
    if page.locator('[role="dialog"][aria-label="从 WeKnora 添加文件"]').count() > 0:
        fail(page, "the picker did not close after adding")

    chips = page.locator('[data-composer-chip="weknora-doc"]')
    if chips.count() != 2:
        fail(page, f"expected 2 document chips in the composer, found {chips.count()}")
    composer_text = composer.first.inner_text()
    for expected in ("退款流程", "售后政策"):
        if expected not in composer_text:
            fail(page, f"composer chips do not show {expected}: {composer_text!r}")

    drafts = stored_drafts(page)
    if not drafts:
        fail(page, "the draft did not persist any weknora:doc mention")
    blob = "\n".join(entry["value"] for entry in drafts)
    for expected in ("weknora:doc/kb-1/doc-1", "weknora:doc/kb-2/doc-4"):
        if expected not in blob:
            fail(page, f"persisted draft is missing {expected}")
    page.screenshot(path=str(OUT / "12-picker-chips.png"), full_page=True)

    print("PASS: + menu picker inserted two WeKnora document chips across knowledge bases")
    print(f"chips: {chips.count()}")
    print(f"persisted mentions: {drafts[0]['key']}")
    browser.close()
