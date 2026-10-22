// ===== Tab Cycler - background (service worker) =====
// Trạng thái lưu hoàn toàn trong chrome.storage.local vì service worker có thể bị tắt bất cứ lúc nào.

const DEF_CONFIG = { items: [], loop: true, autoPause: true, timeMode: 'each', globalMin: 0, globalSec: 30 };
const DEF_RUN = { running: false, paused: false, index: -1, nextAt: 0, remainingMs: 0, token: 0, status: '' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hàng đợi: mọi thao tác chuyển tab chạy tuần tự, tránh race giữa timer / nút bấm / alarm.
let chain = Promise.resolve();
const enqueue = (fn) => (chain = chain.then(fn).catch((e) => console.error('[TabCycler]', e)));

let busy = false;      // đang tự chuyển tab
let selfUntil = 0;     // mốc thời gian đến khi bỏ qua sự kiện onActivated do chính mình gây ra

// ---------- state ----------
async function getState() {
  const d = await chrome.storage.local.get(['config', 'run']);
  return {
    config: { ...DEF_CONFIG, ...(d.config || {}) },
    run: { ...DEF_RUN, ...(d.run || {}) },
  };
}

async function patchRun(patch) {
  const { run } = await getState();
  const next = { ...run, ...patch };
  await chrome.storage.local.set({ run: next });
  await updateBadge(next);
  return next;
}

async function updateBadge(run) {
  const { config } = await getState();
  let text = '';
  if (run.running) text = run.paused ? 'II' : `${run.index + 1}/${config.items.length}`;
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: run.paused ? '#b45309' : '#15803d' });
}

// Phút + giây -> tổng giây, tối thiểu 1 giây.
const toSec = (m, s) => Math.max(1, (Number(m) || 0) * 60 + (Number(s) || 0));
// Thời gian dừng riêng của tab (giây): ưu tiên { min, sec }, hỗ trợ dữ liệu cũ { value, unit }.
const dwellSec = (it) => {
  if (it.min != null || it.sec != null) return toSec(it.min, it.sec);
  return Math.max(1, Number(it.value) || 1) * (it.unit === 'min' ? 60 : 1);
};
// Thời gian dừng (ms). Chế độ 'all' -> dùng thời gian chung; ngược lại dùng thời gian riêng của tab.
const dwellMs = (it, config) =>
  (config?.timeMode === 'all' ? toSec(config.globalMin, config.globalSec) : dwellSec(it)) * 1000;

// ---------- offscreen timer ----------
// Gửi lệnh tới offscreen; bỏ qua lỗi khi document chưa tồn tại.
const toOffscreen = (msg) => chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => {});

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Hẹn giờ chính xác cho khoảng dừng giữa các tab',
    });
  } catch (e) {
    if (!/single|exist/i.test(String(e.message))) throw e;
  }
}

async function stopTimers() {
  await chrome.alarms.clear('due');
  await toOffscreen({ type: 'stop' });
}

async function startTimer(index, ms, status = '') {
  const { run } = await getState();
  if (run.paused) {
    await patchRun({ index, remainingMs: ms, nextAt: 0, status });
    return;
  }
  const token = run.token + 1;
  const nextAt = Date.now() + ms;
  await patchRun({ running: true, index, nextAt, token, remainingMs: 0, status });
  await ensureOffscreen();
  await toOffscreen({ type: 'start', ms, token });
  // Alarm dự phòng: nếu timer của offscreen bị trễ/mất thì alarm vẫn đẩy tiếp.
  await chrome.alarms.create('due', { when: nextAt + 1000 });
}

// ---------- kích hoạt + xác minh tab ----------
// Bọc thao tác tự chuyển tab để tabs.onActivated không coi đó là người dùng đổi tab.
async function asSelf(fn) {
  busy = true;
  selfUntil = Date.now() + 3000;
  try { return await fn(); }
  finally { busy = false; selfUntil = Date.now() + 1500; }
}

async function waitComplete(tabId, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete' && !t.discarded) return true;
    await sleep(300);
  }
  return false;
}

async function checkVisible(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.visibilityState === 'visible',
    });
    return r?.[0]?.result ?? null;
  } catch {
    return null; // trang hệ thống/không inject được: bỏ qua lớp kiểm tra này
  }
}

// Trả về { ok, note }
async function activateAndVerify(tabId) {
  let lastNote = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      let tab = await chrome.tabs.get(tabId);
      const win = await chrome.windows.get(tab.windowId);
      const upd = { focused: true };
      if (win.state === 'minimized') upd.state = 'normal';
      await chrome.windows.update(tab.windowId, upd);
      await chrome.tabs.update(tabId, { active: true });
      await sleep(300);

      tab = await chrome.tabs.get(tabId);
      const w2 = await chrome.windows.get(tab.windowId);
      if (!tab.active || w2.state === 'minimized') { lastNote = 'tab chưa active'; await sleep(400); continue; }

      if (tab.discarded || tab.status === 'loading') await waitComplete(tabId);

      const vis = await checkVisible(tabId);
      if (vis === false) { lastNote = 'trang chưa visible'; await sleep(400); continue; }

      return { ok: true, note: w2.focused ? '' : 'cửa sổ chưa nhận focus hệ thống' };
    } catch (e) {
      if (/No tab with id/i.test(String(e.message))) return { ok: false, note: 'tab đã đóng' };
      lastNote = String(e.message);
      await sleep(400);
    }
  }
  return { ok: false, note: lastNote || 'không kích hoạt được' };
}

// ---------- nhấp thật bằng chrome.debugger ----------
async function realClick(tabId, p) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    await sleep(250); // chờ thanh cảnh báo debug (nếu có) ổn định layout
    const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: '({w: innerWidth, h: innerHeight})',
      returnByValue: true,
    });
    const { w, h } = r.result.value;

    // Cùng chiều rộng viewport -> dùng pixel gốc (chính xác, không lệch do thanh debug đẩy trang xuống).
    // Khác chiều rộng (đổi cỡ cửa sổ, zoom) -> dùng tỷ lệ phần trăm.
    let x, y;
    if (p.w && Math.abs(w - p.w) <= 2) {
      x = p.x;
      y = Math.min(p.y, h - 2);
    } else {
      x = Math.round(p.xPct * w);
      y = Math.round(p.yPct * h);
    }

    const send = (params) => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', params);
    await send({ type: 'mouseMoved', x, y });
    await send({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await send({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  } finally {
    try { await chrome.debugger.detach(target); } catch {}
  }
}

// ---------- vòng chạy ----------
async function go(dir) {
  const { config, run } = await getState();
  const items = config.items;
  const n = items.length;
  if (!n) return stopRun('Chưa có tab nào trong chuỗi');

  return asSelf(async () => {
    const notes = [];
    let idx = run.index;
    for (let k = 0; k < n; k++) {
      idx += dir;
      if (idx >= n) {
        if (!config.loop) return stopRun('Đã chạy hết chuỗi');
        idx = 0;
      }
      if (idx < 0) idx = n - 1;

      const item = items[idx];
      const res = await activateAndVerify(item.tabId);
      if (!res.ok) { notes.push(`Bỏ qua tab ${idx + 1}: ${res.note}`); continue; }
      if (res.note) notes.push(`Tab ${idx + 1}: ${res.note}`);

      if (item.clickEnabled && item.click) {
        try { await realClick(item.tabId, item.click); }
        catch (e) { notes.push(`Tab ${idx + 1} không nhấp được: ${String(e.message).slice(0, 80)}`); }
      }

      await startTimer(idx, dwellMs(item, config), notes.join(' · '));
      return;
    }
    await stopRun('Không tab nào kích hoạt được');
  });
}

async function startRun() {
  const { config } = await getState();
  if (!config.items.length) { await patchRun({ status: 'Chưa có tab nào trong chuỗi' }); return; }
  await stopTimers();
  await patchRun({ running: true, paused: false, index: -1, nextAt: 0, remainingMs: 0, status: 'Đang bắt đầu...' });
  await go(1);
}

async function pause(reason = 'Tạm dừng') {
  const { run } = await getState();
  if (!run.running || run.paused) return;
  const remaining = Math.max(1000, run.nextAt - Date.now());
  await stopTimers();
  await patchRun({ paused: true, remainingMs: remaining, token: run.token + 1, status: reason });
}

async function resume() {
  const { config, run } = await getState();
  if (!run.running || !run.paused) return;
  const item = config.items[run.index];
  if (item) await asSelf(() => activateAndVerify(item.tabId));
  await patchRun({ paused: false, status: '' });
  await startTimer(run.index, run.remainingMs > 0 ? run.remainingMs : item ? dwellMs(item, config) : 1000, '');
}

async function stopRun(status = '') {
  const { run } = await getState();
  await stopTimers();
  await patchRun({ running: false, paused: false, index: -1, nextAt: 0, remainingMs: 0, token: run.token + 1, status });
  try { await chrome.offscreen.closeDocument(); } catch {}
}

// ---------- chọn điểm nhấp ----------
function pickerOverlay() {
  if (window.__tcPicker) return;
  window.__tcPicker = true;

  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(30,120,255,.12);outline:3px solid rgba(30,120,255,.7);outline-offset:-3px';
  const tip = document.createElement('div');
  tip.textContent = 'Tab Cycler: bấm vào vị trí muốn nhấp tự động · Esc để hủy';
  tip.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);padding:8px 14px;border-radius:8px;background:#111;color:#fff;font:14px/1.3 system-ui,sans-serif;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.4)';
  ov.appendChild(tip);

  const cleanup = () => {
    document.removeEventListener('keydown', onKey, true);
    ov.remove();
    window.__tcPicker = false;
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      cleanup();
      chrome.runtime.sendMessage({ type: 'pickCancelled' }).catch(() => {});
    }
  };

  ov.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const w = window.innerWidth, h = window.innerHeight;
    const dot = document.createElement('div');
    dot.style.cssText = `position:fixed;left:${e.clientX - 9}px;top:${e.clientY - 9}px;width:18px;height:18px;border-radius:50%;background:#e11d48;border:3px solid #fff;box-shadow:0 0 0 2px #e11d48;pointer-events:none`;
    ov.appendChild(dot);
    tip.textContent = 'Đã lưu điểm nhấp ✓';
    ov.style.pointerEvents = 'none';
    chrome.runtime.sendMessage({
      type: 'pointPicked',
      x: Math.round(e.clientX), y: Math.round(e.clientY), w, h,
      xPct: e.clientX / w, yPct: e.clientY / h,
    }).catch(() => {});
    setTimeout(cleanup, 800);
  }, true);

  document.addEventListener('keydown', onKey, true);
  document.documentElement.appendChild(ov);
}

async function startPick(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: pickerOverlay });
  } catch {
    return { ok: false, error: 'Không thể chọn điểm trên tab này (trang hệ thống hoặc bị chặn).' };
  }
  selfUntil = Date.now() + 3000;
  await enqueue(() => pause('Tạm dừng để chọn điểm nhấp'));
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {}
  return { ok: true };
}

// ---------- lệnh từ popup / phím tắt ----------
// next/prev: chỉ bước khi đang chạy.
const step = (dir) => enqueue(async () => { const { run } = await getState(); if (run.running) await go(dir); });

function handleCmd(cmd) {
  switch (cmd) {
    case 'start': return enqueue(startRun);
    case 'pause': return enqueue(() => pause('Tạm dừng'));
    case 'resume': return enqueue(resume);
    case 'stop': return enqueue(() => stopRun('Đã dừng'));
    case 'next': return step(1);
    case 'prev': return step(-1);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'cmd':
      Promise.resolve(handleCmd(msg.cmd)).then(() => sendResponse({ ok: true }));
      return true;
    case 'pick':
      startPick(msg.tabId).then(sendResponse);
      return true;
    case 'pointPicked': {
      const tabId = sender.tab?.id;
      enqueue(async () => {
        const { config } = await getState();
        const it = config.items.find((i) => i.tabId === tabId);
        if (!it) return;
        it.click = { x: msg.x, y: msg.y, w: msg.w, h: msg.h, xPct: msg.xPct, yPct: msg.yPct };
        it.clickEnabled = true;
        await chrome.storage.local.set({ config });
      });
      break;
    }
    case 'timerDone':
      enqueue(async () => {
        const { run } = await getState();
        if (!run.running || run.paused || run.token !== msg.token) return; // token cũ -> bỏ
        await go(1);
      });
      break;
    case 'offscreenReady':
      getState().then(({ run }) => {
        if (run.running && !run.paused && run.nextAt) {
          toOffscreen({ type: 'start', ms: Math.max(0, run.nextAt - Date.now()), token: run.token });
        }
      });
      break;
  }
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'due') return;
  enqueue(async () => {
    const { run } = await getState();
    if (!run.running || run.paused) return;
    if (Date.now() < run.nextAt) return; // đã được đẩy tiếp bởi timer chính
    await go(1);
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'stop-all') return handleCmd('stop');
  if (command === 'toggle-pause') {
    const { run } = await getState();
    if (!run.running) return handleCmd('start');
    return handleCmd(run.paused ? 'resume' : 'pause');
  }
});

// Người dùng tự đổi tab -> tự tạm dừng (nếu bật).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (busy || Date.now() < selfUntil) return;
  const { config, run } = await getState();
  if (!run.running || run.paused || !config.autoPause) return;
  const cur = config.items[run.index];
  if (cur && cur.tabId === tabId) return;
  enqueue(() => pause('Tự tạm dừng: bạn vừa đổi tab'));
});

// Tab đang treo bị đóng -> sang tab kế ngay.
chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(async () => {
    const { config, run } = await getState();
    if (!run.running || run.paused) return;
    const cur = config.items[run.index];
    if (cur && cur.tabId === tabId) await go(1);
  });
});

// Khởi động lại trình duyệt: tab ID cũ vô hiệu -> reset trạng thái chạy.
chrome.runtime.onStartup.addListener(() => enqueue(() => stopRun('')));
chrome.runtime.onInstalled.addListener(() => enqueue(() => stopRun('')));
