"""Verify the plugin inside the *running desktop DSH window's* web server.

Reuses the desktop app's own auth cookie (read from its Chromium cookie store)
so a headless browser can load the real GUI at 127.0.0.1:19387 without touching
the user's window. Read-only: it never creates or deletes anything in WeKnora.

Usage: python3 test/e2e/desktop.py <cookie-name> <cookie-value>
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

NAME, VALUE = sys.argv[1], sys.argv[2]
OUT = Path(__file__).parent / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)


def fail(page, message):
    page.screenshot(path=str(OUT / "desktop-failure.png"), full_page=True)
    print(f"FAIL: {message}")
    print(page.inner_text("body")[:2000])
    raise SystemExit(1)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
    context.add_cookies(
        [{"name": NAME, "value": VALUE, "domain": "127.0.0.1", "path": "/", "httpOnly": True, "secure": False}]
    )
    page = context.new_page()
    page.goto("http://127.0.0.1:19387/", wait_until="domcontentloaded")
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

    print("PASS: desktop sidebar entry, real knowledge bases and agents render")
    print(panel.inner_text()[:600])
    browser.close()
