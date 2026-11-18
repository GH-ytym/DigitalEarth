"""Exercise public satellites in the actual React workspace with its one existing Viewer."""
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "work/satellites"
OUT.mkdir(parents=True, exist_ok=True)

def executable():
    for root in (os.getenv("PROGRAMFILES"), os.getenv("PROGRAMFILES(X86)"), os.getenv("LOCALAPPDATA")):
        if root:
            for name in ("Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"):
                path = Path(root) / name
                if path.is_file():
                    return str(path)
    return None

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=executable(), headless=True,
                                         args=["--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width":1440,"height":1000})
    errors, requests = [], []
    page.on("pageerror", lambda error: errors.append(str(error).split("?")[0]))
    page.on("request", lambda req: requests.append((req.method,req.url)) if "/api/v1/satellites/" in req.url else None)
    page.goto("http://127.0.0.1:5173/?panel=satellites", wait_until="domcontentloaded")
    expect(page.locator(".satellite-choice")).to_have_count(3, timeout=60000)
    expect(page.locator(".satellite-panel-content input[type=number]")).to_have_count(0)
    expect(page.locator(".satellite-choice").filter(has_text="国际空间站")).to_be_visible()
    load = page.get_by_role("button", name="加载所选卫星轨迹", exact=True)
    expect(load).to_be_enabled(timeout=60000)
    page.evaluate("window.__initialGlobeCanvas = document.querySelector('.cesium-widget canvas')")
    load.click()
    controls = page.get_by_role("region", name="卫星轨迹回放", exact=True)
    expect(controls).to_be_visible(timeout=60000)
    expect(load).to_be_enabled()
    expect(page.locator(".cesium-widget canvas")).to_have_count(1)
    expect(page.locator(".satellite-position")).to_have_count(3)
    old_time = controls.locator("time").inner_text()
    frame_a = page.locator(".globe-viewport").screenshot(path=str(OUT / "motion-a.png"))
    page.wait_for_function("text => document.querySelector('.satellite-controls time').textContent !== text", arg=old_time)
    page.wait_for_timeout(700)
    frame_b = page.locator(".globe-viewport").screenshot(path=str(OUT / "motion-b.png"))
    assert frame_a != frame_b
    controls.get_by_role("button", name="暂停", exact=True).click()
    page.wait_for_timeout(200)
    paused = controls.locator("time").inner_text()
    count = len(requests)
    page.wait_for_timeout(500)
    assert controls.locator("time").inner_text() == paused
    page.get_by_label("卫星回放倍速").select_option("120")
    controls.get_by_role("button", name="播放", exact=True).click()
    page.wait_for_function("text => document.querySelector('.satellite-controls time').textContent !== text", arg=paused)
    slider = page.get_by_label("卫星回放时间", exact=True)
    bounds = slider.bounding_box()
    slider.click(position={"x":bounds["width"]*.4,"y":bounds["height"]/2})
    expect(controls.get_by_role("button", name="播放", exact=True)).to_be_visible()
    controls.get_by_role("button", name="回到起点", exact=True).click()
    expect(slider).to_have_value("0")
    assert len(requests) == count, "Playback controls must not issue backend requests."
    page.get_by_label("跟随卫星", exact=True).select_option("norad-25544")
    page.get_by_label("跟随卫星", exact=True).select_option("")
    page.locator(".navigation").get_by_role("button",name="查询索引",exact=True).click()
    expect(page.get_by_role("tab",name="地名查询",exact=True)).to_be_visible()
    assert page.evaluate("document.querySelector('.cesium-widget canvas') === window.__initialGlobeCanvas")
    page.locator(".navigation").get_by_role("button",name="图层管理",exact=True).click()
    expect(page.get_by_text("中国省级行政区界线",exact=True)).to_be_visible()
    page.locator(".navigation").get_by_role("button",name="卫星轨迹",exact=True).click()
    assert page.evaluate("document.querySelector('.cesium-widget canvas') === window.__initialGlobeCanvas")
    load.click()
    expect(page.locator(".satellite-message").filter(has_text="复用")).to_be_visible(timeout=30000)
    expect(load).to_be_enabled()
    page.get_by_role("button",name="查看全部轨迹",exact=True).click()
    page.wait_for_timeout(1200)
    page.screenshot(path=str(OUT / "integrated-desktop.png"))
    # Restoring a persisted result after a full page reload reconstructs the same scene.
    page.reload(wait_until="domcontentloaded")
    expect(page.locator(".satellite-history button").first).to_be_visible(timeout=60000)
    page.locator(".satellite-history button").first.click()
    expect(page.get_by_role("region",name="卫星轨迹回放",exact=True)).to_be_visible(timeout=30000)
    expect(load).to_be_enabled()
    expect(page.locator(".satellite-message").filter(has_text="历史成果")).to_be_visible()
    page.set_viewport_size({"width":1000,"height":760})
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / "integrated-compact.png"))
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    assert not errors, errors
    page.get_by_role("button",name="关闭卫星轨迹",exact=True).click()
    expect(page.get_by_role("region",name="卫星轨迹回放",exact=True)).to_have_count(0)
    expect(page.locator(".cesium-widget canvas")).to_have_count(1)
    (OUT / "browser-result.json").write_text(json.dumps({"page_errors":errors,"satellite_api_requests":len(requests)},indent=2),encoding="utf-8")
    print("Integrated workspace passed: public catalog, one Viewer, SGP4 playback, cache reuse, history and existing panels.")
    browser.close()
