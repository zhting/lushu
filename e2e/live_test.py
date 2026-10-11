"""线上冒烟测试：对 https://lushu.tangletang.top 跑真实地图 / 天气 / 搜索服务，结果写到 OUT 目录。"""
import json, os, re, sys, time, traceback, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'https://lushu.tangletang.top')
OUT = os.environ.get('OUT', 'e2e-results')
os.makedirs(OUT, exist_ok=True)
R = {'base': BASE, 'started': time.strftime('%Y-%m-%d %H:%M:%S'), 'steps': [], 'console_errors': [], 'failed_requests': []}
USER = 'e2etest_' + time.strftime('%m%d%H%M')


def step(name, fn):
    t0 = time.time()
    try:
        info = fn()
        R['steps'].append({'step': name, 'ok': True, 'sec': round(time.time() - t0, 1), 'info': info})
        print(f'[OK] {name}: {info}')
        return info
    except Exception as e:
        R['steps'].append({'step': name, 'ok': False, 'sec': round(time.time() - t0, 1), 'error': f'{type(e).__name__}: {e}'[:600]})
        print(f'[FAIL] {name}: {e}')
        traceback.print_exc()
        return None


def save():
    R['finished'] = time.strftime('%Y-%m-%d %H:%M:%S')
    json.dump(R, open(f'{OUT}/results.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)


def S(page, js):
    return page.evaluate(f"() => {{ const s = window.__trip_store__; return {js} }}")


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1366, 'height': 860}, accept_downloads=True, service_workers='allow',
                        locale='zh-CN', timezone_id='Asia/Shanghai')
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
    page = ctx.new_page()
    page.on('dialog', lambda d: d.accept())
    page.on('console', lambda m: R['console_errors'].append(m.text[:200]) if m.type == 'error' and len(R['console_errors']) < 40 else None)
    page.on('requestfailed', lambda r: R['failed_requests'].append(f'{r.url[:120]} {r.failure}') if len(R['failed_requests']) < 40 else None)

    def open_site():
        resp = page.goto(BASE, wait_until='domcontentloaded', timeout=60000)
        page.wait_for_selector('button[type=submit]', timeout=30000)
        man = page.evaluate("fetch('/manifest.webmanifest').then(r => r.status)")
        sw = page.evaluate("fetch('/sw.js').then(r => r.status)")
        return {'status': resp.status, 'manifest': man, 'sw_js': sw, 'title': page.title()}
    step('打开首页 / PWA 文件', open_site)

    def register():
        page.get_by_text('注册', exact=False).first.click()
        i = page.locator('input'); i.nth(0).fill(USER); i.nth(1).fill('Test-pass-1234'); i.nth(2).fill('Test-pass-1234')
        page.locator('button[type=submit]').click()
        page.wait_for_selector('.home-page', timeout=30000)
        cfg = page.evaluate("fetch('/api/config', {headers: {Authorization: 'Bearer ' + localStorage.getItem('lushu.token')}}).then(r => r.json())")
        return {'user': USER, 'provider': cfg.get('defaultProvider'), 'hasAmapKey': cfg.get('hasAmapKey'), 'hasAi': cfg.get('hasAi'), 'aiVision': cfg.get('aiVision')}
    cfg = step('注册测试账号 / 读取配置', register) or {}
    page.screenshot(path=f'{OUT}/01-home.png')

    def sample():
        page.click('.sample-link-btn')
        page.wait_for_selector('.day-plan', timeout=30000)
        page.wait_for_selector('.day-plan-stat:has-text("到达"), .day-plan-stat:has-text("未算出")', timeout=120000)
        txt = page.locator('.day-plan').inner_text()
        page.wait_for_timeout(8000)  # 等其余天数的线路
        return {'day_plan': txt.replace('\n', ' | '), 'legs': page.locator('.tl-leg-pill').count(),
                'stop_times': page.locator('.tl-stop-time').all_inner_texts(), 'provider': S(page, 's.mapCfg.provider')}
    step('载入示例 → 车程、到达时间、费用', sample)
    page.screenshot(path=f'{OUT}/02-day1.png')

    def weather():
        page.wait_for_selector('.day-plan .weather-chip', timeout=30000)
        return page.locator('.day-plan .weather-chip').inner_text().replace('\n', ' ')
    step('天气（Open-Meteo）', weather)

    def nav():
        page.locator('.tl-leg-pill .nav-btn').first.click()
        page.wait_for_selector('.nav-popover a', timeout=5000)
        hrefs = page.locator('.nav-popover a').evaluate_all('els => els.map(e => e.href)')
        page.keyboard.press('Escape'); page.mouse.click(5, 500)
        return hrefs
    step('一键导航链接', nav)

    def map_render():
        page.wait_for_timeout(2000)
        return {'leaflet': page.locator('.leaflet-container').count(), 'leaflet_tiles_loaded': page.evaluate("[...document.querySelectorAll('img.leaflet-tile')].filter(i => i.complete && i.naturalWidth > 0).length"),
                'amap': page.locator('.amap-container').count()}
    step('地图渲染', map_render)

    def supply():
        n0 = S(page, 's.trip.days[0].stops.length')
        kind = '加油' if S(page, 's.vehicle.energy') == 'fuel' else '充电'
        page.locator(f'.supply-head .chip:has-text("{kind}")').click()
        page.wait_for_selector('.supply-list li, .supply-status.error-text', timeout=90000)
        if page.locator('.supply-list li').count() == 0:
            return {'result': page.locator('.supply-status').inner_text()}
        items = page.locator('.supply-list li').all_inner_texts()[:5]
        page.locator('.supply-list li .btn').first.click()
        page.wait_for_timeout(500)
        return {'count': page.locator('.supply-list li').count(), 'first': [x.replace('\n', ' ') for x in items], 'stops_before_after': [n0, S(page, 's.trip.days[0].stops.length')]}
    step('沿途补给（加油站）', supply)
    page.screenshot(path=f'{OUT}/03-supply.png')

    def hotel():
        page.locator('.supply-head .chip:has-text("终点住宿")').click()
        page.wait_for_selector('.supply-list li, .supply-status.error-text', timeout=90000)
        return page.locator('.supply-body').inner_text().replace('\n', ' | ')[:300]
    step('终点附近住宿', hotel)

    def overview():
        S(page, 's.goOverview()')
        page.wait_for_selector('.stat-tiles', timeout=10000)
        page.wait_for_timeout(3000)
        return {'tiles': page.locator('.stat-tiles').inner_text().replace('\n', ' | '), 'bars': page.locator('.day-bars').inner_text().replace('\n', ' | '),
                'foot': page.locator('.stat-foot').inner_text()}
    step('总览合计与每日对比', overview)
    page.screenshot(path=f'{OUT}/04-overview.png', full_page=True)

    def exports():
        page.click('.header-right-actions .glass-circle-btn[title="分享与导出"]')
        page.wait_for_selector('.share-sheet')
        out = {}
        for label, fn in [('GPX', 'trip.gpx'), ('日历', 'trip.ics'), ('长图', 'trip.png')]:
            with page.expect_download(timeout=60000) as d:
                page.click(f'.export-item:has-text("{label}")')
            path = f'{OUT}/{fn}'; d.value.save_as(path)
            out[label] = os.path.getsize(path)
        return out
    step('导出 GPX / 日历 / 长图', exports)
    page.screenshot(path=f'{OUT}/05-sharesheet.png')

    share_url = {}

    def share_video():
        page.click('.share-sheet button:has-text("录制并分享")')
        page.wait_for_selector('.recording-bar-float', timeout=30000)
        page.wait_for_timeout(3000)
        page.screenshot(path=f'{OUT}/06-recording.png')
        page.wait_for_selector('.share-sheet .share-link-input, .share-sheet button:has-text("录制并分享")', timeout=420000)
        page.wait_for_timeout(2000)
        page.wait_for_selector('.share-sheet .share-link-input, .upload-progress', timeout=5000)
        page.wait_for_selector('.share-sheet .share-link-input', timeout=300000)
        url = page.locator('.share-link-input').input_value()
        share_url['url'] = url
        return {'url': url.replace(url.rsplit('/', 1)[1], '<token>'), 'ops': page.locator('.share-link-ops').inner_text().replace('\n', ' | ')}
    r = step('录制并分享视频（上传到服务器）', share_video)
    if r is None:
        R['steps'][-1]['toasts'] = page.locator('.toast').all_inner_texts()
        page.screenshot(path=f'{OUT}/06-share-failed.png')

    if share_url.get('url'):
        def guest():
            g = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2).new_page()
            g.goto(share_url['url'], timeout=60000)
            g.wait_for_selector('video.share-video-player, .share-error', timeout=30000)
            meta = g.evaluate("fetch(location.pathname.replace('/s/', '/api/public/share/')).then(r => r.json())")
            g.wait_for_timeout(4000)
            dur = g.evaluate("(() => { const v = document.querySelector('video'); return v ? [v.readyState, v.duration] : null })()")
            g.screenshot(path=f'{OUT}/07-guest-video.png')
            return {'public_meta_keys': sorted(meta.keys()), 'video_state_duration': dur, 'page_text': g.locator('body').inner_text().replace('\n', ' | ')}
        step('访客打开视频分享链接', guest)

        def revoke():
            page.click('.share-link-ops button:has-text("关闭链接")')
            page.wait_for_selector('.share-sheet button:has-text("录制并分享")', timeout=20000)
            st = page.evaluate(f"fetch('{share_url['url'].replace('/s/', '/api/public/share/')}').then(r => r.status)")
            return {'after_revoke_status': st}
        step('关闭分享链接', revoke)
    try:
        page.click('.share-sheet .modal-close-btn', timeout=3000)
    except Exception:
        pass

    def offline():
        trip_id = S(page, 's.currentId')
        page.wait_for_timeout(3000)
        sw = page.evaluate("navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))")
        ctx.set_offline(True)
        page.reload(wait_until='domcontentloaded')
        page.wait_for_selector('.home-page', timeout=30000)
        banner = page.locator('.offline-banner').inner_text() if page.locator('.offline-banner').count() else ''
        page.evaluate(f"() => window.__trip_store__.openTrip({json.dumps(trip_id)})")
        page.wait_for_selector('.day-plan', timeout=20000)
        page.wait_for_timeout(3000)
        page.screenshot(path=f'{OUT}/08-offline.png')
        info = {'sw_active': sw, 'banner': banner.replace('\n', ' '), 'day_plan': page.locator('.day-plan').inner_text().replace('\n', ' | '),
                'pending_after_open': S(page, 's.pendingCount')}
        ctx.set_offline(False)
        page.wait_for_timeout(3000)
        return info
    step('PWA 离线打开路书', offline)

    def ai():
        S(page, 's.goHome()')
        page.wait_for_selector('.ai-entry-btn', timeout=10000)
        page.click('.ai-entry-btn')
        page.wait_for_selector('.ai-modal', timeout=5000)
        txt = page.locator('.ai-modal .modal-body').inner_text().replace('\n', ' ')
        page.screenshot(path=f'{OUT}/09-ai.png')
        page.click('.ai-modal .modal-close-btn')
        return txt[:200]
    step('AI 生成入口', ai)

    def cleanup():
        ids = page.evaluate("window.__trip_store__.savedTrips.list.map(e => e.id)")
        for i in ids:
            page.evaluate(f"() => window.__trip_store__.deleteTrip({json.dumps(i)})")
            page.wait_for_timeout(500)
        left = page.evaluate("fetch('/api/trips', {headers: {Authorization: 'Bearer ' + localStorage.getItem('lushu.token')}}).then(r => r.json()).then(d => d.trips.length)")
        return {'deleted': len(ids), 'left_on_server': left}
    step('清理测试数据', cleanup)

    # 手机尺寸首页与单日页截图（新账号无数据，载入示例后再删除）
    def mobile():
        m = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, locale='zh-CN', timezone_id='Asia/Shanghai')
        tok = page.evaluate("localStorage.getItem('lushu.token')")
        m.add_init_script(f"localStorage.setItem('lushu.token', {json.dumps(tok)})")
        mp = m.new_page(); mp.on('dialog', lambda d: d.accept())
        mp.goto(BASE, timeout=60000)
        mp.wait_for_selector('.sample-link-btn', timeout=30000)
        mp.click('.sample-link-btn')
        mp.wait_for_selector('.day-plan-stat:has-text("到达"), .day-plan-stat:has-text("未算出")', timeout=120000)
        mp.wait_for_timeout(3000)
        mp.screenshot(path=f'{OUT}/10-mobile-day.png')
        ids = mp.evaluate("window.__trip_store__.savedTrips.list.map(e => e.id)")
        for i in ids:
            mp.evaluate(f"() => window.__trip_store__.deleteTrip({json.dumps(i)})")
            mp.wait_for_timeout(500)
        return mp.locator('.day-plan').count()
    step('手机尺寸单日页', mobile)
    b.close()

save()
print(json.dumps(R, ensure_ascii=False, indent=2)[:4000])
