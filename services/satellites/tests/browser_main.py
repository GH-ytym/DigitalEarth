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


def tracking_snapshot(page):
    return page.evaluate("""() => {
      const v = window.__testViewer;
      const p = v.trackedEntity.position.getValue(v.clock.currentTime);
      const c = v.camera.positionWC;
      const screen = v.scene.cartesianToCanvasCoordinates(p);
      return {id:v.trackedEntity.id, distance:Math.hypot(c.x-p.x,c.y-p.y,c.z-p.z),
        height:v.camera.positionCartographic.height, pitch:v.camera.pitch,
        centreError:Math.hypot(screen.x-v.scene.canvas.clientWidth/2,screen.y-v.scene.canvas.clientHeight/2),
        camera:[c.x,c.y,c.z]};
    }""")


def assert_overview(state, satellite_id, distance=16000000):
    assert state["id"] == satellite_id, state
    assert abs(state["distance"] - distance) < 100, state
    assert state["height"] > 15000000, state
    assert state["pitch"] < -1.5, state
    assert state["centreError"] < 2, state

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
    toggle = page.get_by_role("button", name="时间轴与曲线", exact=True)
    expect(toggle).to_be_disabled()
    expect(toggle).to_have_attribute("aria-expanded", "false")
    # Capture the real controller's Viewer for assertions; production exposes no debug globals.
    page.evaluate("""async () => {
      const moduleUrl = performance.getEntriesByType('resource')
        .find(e => new URL(e.name).pathname === '/src/features/globe/SceneController.ts').name;
      const { SceneController } = await import(moduleUrl);
      const load = SceneController.prototype.loadSatellites;
      SceneController.prototype.loadSatellites = function(...args) {
        window.__testViewer = this.viewer;
        return load.apply(this, args);
      };
    }""")
    load = page.get_by_role("button", name="加载所选卫星轨迹", exact=True)
    expect(load).to_be_enabled(timeout=60000)
    page.evaluate("window.__initialGlobeCanvas = document.querySelector('.cesium-widget canvas')")
    load.click()
    controls = page.get_by_role("region", name="卫星轨迹回放", exact=True)
    expect(toggle).to_be_enabled(timeout=60000)
    page.wait_for_function("!!window.__testViewer")
    expect(controls).to_have_count(0)
    expect(page.locator(".satellite-position")).to_have_count(3)
    page.wait_for_timeout(15000)
    page.screenshot(path=str(OUT / "timeline-collapsed.png"))
    toggle.click()
    expect(toggle).to_have_attribute("aria-expanded", "true")
    expect(controls).to_be_visible()
    map_bounds = page.locator(".map-controls").bounding_box()
    assert map_bounds["y"] + map_bounds["height"] < controls.bounding_box()["y"]
    expect(load).to_be_enabled()
    expect(page.locator(".cesium-widget canvas")).to_have_count(1)
    expect(page.locator(".satellite-position")).to_have_count(3)
    subpoints = page.evaluate("""() => {
      const viewer = window.__testViewer;
      return viewer.dataSources.getByName('public-satellites')[0].entities.values
        .filter(e => e.id.endsWith('-subpoint')).map(e => {
          const p = e.position.getValue(viewer.clock.currentTime);
          return { id:e.id, radius:Math.hypot(p.x,p.y,p.z),
            label:e.label.text.getValue(viewer.clock.currentTime),
            noTrail:!e.path && !e.polyline };
        });
    }""")
    assert len(subpoints) == 3
    assert all(p["noTrail"] and 6356750 < p["radius"] < 6378140 and "星下点" in p["label"] for p in subpoints)
    assert "公开要素推算轨迹" not in page.locator("body").inner_text()
    old_time = controls.locator("time").inner_text()
    frame_a = page.locator(".globe-viewport").screenshot(path=str(OUT / "motion-a.png"))
    page.wait_for_function("text => document.querySelector('.satellite-controls time').textContent !== text", arg=old_time)
    page.wait_for_timeout(700)
    frame_b = page.locator(".globe-viewport").screenshot(path=str(OUT / "motion-b.png"))
    assert frame_a != frame_b
    count_before_fold = len(requests)
    before_fold = page.evaluate("window.__testViewer.clock.currentTime.toString()")
    controls.get_by_role("button", name="折叠时间轴", exact=True).click()
    expect(toggle).to_be_focused()
    expect(controls).to_have_count(0)
    expect(toggle).to_have_attribute("aria-expanded", "false")
    page.wait_for_timeout(500)
    assert page.evaluate("window.__testViewer.clock.shouldAnimate")
    assert before_fold != page.evaluate("window.__testViewer.clock.currentTime.toString()")
    assert len(requests) == count_before_fold
    toggle.click()
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
    page.wait_for_timeout(1800)
    assert_overview(tracking_snapshot(page), "norad-25544")
    # Seeking and switching satellites keep the target centred in a high, downward view.
    slider.click(position={"x":bounds["width"]*.6,"y":bounds["height"]/2})
    page.wait_for_timeout(200)
    assert_overview(tracking_snapshot(page), "norad-25544")
    page.get_by_label("跟随卫星", exact=True).select_option("norad-43013")
    page.wait_for_timeout(1800)
    assert_overview(tracking_snapshot(page), "norad-43013")
    page.screenshot(path=str(OUT / "satellite-follow.png"))
    before_follow_play = tracking_snapshot(page)
    controls.get_by_role("button", name="播放", exact=True).click()
    page.wait_for_timeout(700)
    controls.get_by_role("button", name="暂停", exact=True).click()
    after_follow_play = tracking_snapshot(page)
    assert_overview(after_follow_play, "norad-43013")
    assert sum((a-b)**2 for a,b in zip(before_follow_play["camera"],after_follow_play["camera"])) > 100000000
    # User zoom is retained while the view centre continues to follow playback time.
    page.get_by_role("button", name="缩小", exact=True).click()
    page.wait_for_timeout(200)
    zoomed = tracking_snapshot(page)
    assert zoomed["distance"] > 17000000, zoomed
    slider.click(position={"x":bounds["width"]*.4,"y":bounds["height"]/2})
    page.wait_for_timeout(200)
    assert_overview(tracking_snapshot(page), "norad-43013", zoomed["distance"])
    before_free = tracking_snapshot(page)["camera"]
    page.get_by_label("跟随卫星", exact=True).select_option("")
    after_free = page.evaluate("""() => {
      const v = window.__testViewer;
      if (v.trackedEntity) throw Error('Free view still tracks an entity');
      const c = v.camera.positionWC;
      return [c.x,c.y,c.z];
    }""")
    assert sum((a-b)**2 for a,b in zip(before_free,after_free)) < 1
    assert len(requests) == count, "Following, seeking and zoom must stay local."
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
    expect(toggle).to_be_enabled(timeout=30000)
    expect(controls).to_have_count(0)
    toggle.click()
    expect(controls).to_be_visible()
    expect(load).to_be_enabled()
    expect(page.locator(".satellite-message").filter(has_text="已加载保存的轨迹")).to_be_visible()
    expect(page.locator(".scene-status")).to_have_text("场景就绪", timeout=60000)
    page.set_viewport_size({"width":1000,"height":760})
    page.wait_for_timeout(2500)
    page.screenshot(path=str(OUT / "integrated-compact.png"))
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    toggle_bounds = toggle.bounding_box()
    assert toggle_bounds["x"] > 700 and toggle_bounds["y"] > 720
    map_bounds = page.locator(".map-controls").bounding_box()
    assert map_bounds["y"] + map_bounds["height"] < controls.bounding_box()["y"]
    credits_bounds = page.locator(".cesium-viewer-bottom").bounding_box()
    assert credits_bounds["x"] + credits_bounds["width"] < map_bounds["x"]
    toggle.click()
    expect(controls).to_have_count(0)
    expect(page.locator(".satellite-position")).to_have_count(3)
    assert not errors, errors
    page.get_by_role("button",name="卸载轨迹",exact=True).click()
    expect(page.get_by_role("region",name="卫星轨迹回放",exact=True)).to_have_count(0)
    expect(toggle).to_be_disabled()
    expect(page.locator(".cesium-widget canvas")).to_have_count(1)
    (OUT / "browser-result.json").write_text(json.dumps({"page_errors":errors,"satellite_api_requests":len(requests)},indent=2),encoding="utf-8")
    print("Integrated workspace passed: Earth overview tracking, centred target during playback/seek, retained zoom, timeline and cache reuse.")
    browser.close()
