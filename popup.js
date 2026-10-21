const $ = (s) => document.querySelector(s);
const DEF_CONFIG = { items: [], loop: true, autoPause: true };

let config = { ...DEF_CONFIG };
let run = { running: false, paused: false, index: -1, nextAt: 0, remainingMs: 0, status: '' };
let openTabs = [];

// tạo phần tử DOM an toàn (không dùng innerHTML với tiêu đề tab)
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el[k] = v;
  }
  el.append(...kids);
  return el;
}

const fmt = (s) => {
  s = Math.max(0, Math.round(s));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const parts = [];
  if (hh) parts.push(hh + 'g');
  if (mm) parts.push(mm + 'p');
  if (ss || !parts.length) parts.push(ss + 's');
  return parts.join(' ');
};
// Thời gian dừng (giây). Hỗ trợ cả dữ liệu cũ dạng { value, unit }.
const dwellSec = (it) => {
  if (it.min != null || it.sec != null) return Math.max(1, (Number(it.min) || 0) * 60 + (Number(it.sec) || 0));
  return Math.max(1, Number(it.value) || 1) * (it.unit === 'min' ? 60 : 1);
};

async function load() {
  const d = await chrome.storage.local.get(['config', 'run']);
  config = { ...DEF_CONFIG, ...(d.config || {}) };
  run = { ...run, ...(d.run || {}) };
}
const saveConfig = () => chrome.storage.local.set({ config });
const cmd = (c) => chrome.runtime.sendMessage({ type: 'cmd', cmd: c });

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= config.items.length) return;
  [config.items[i], config.items[j]] = [config.items[j], config.items[i]];
  saveConfig(); render();
}
function removeItem(i) { config.items.splice(i, 1); saveConfig(); render(); }
function addTab(t) {
  config.items.push({ tabId: t.id, title: t.title || t.url || '', url: t.url || '', min: 0, sec: 30, clickEnabled: true, click: null });
  saveConfig(); render();
}
async function pick(tabId) {
  $('#msg').textContent = '';
  const r = await chrome.runtime.sendMessage({ type: 'pick', tabId });
  if (r && !r.ok) $('#msg').textContent = r.error;
}

function renderSeq() {
  const byId = new Map(openTabs.map((t) => [t.id, t]));
  const box = $('#seq');
  box.replaceChildren();
  if (!config.items.length) box.append(h('p', { class: 'empty', textContent: 'Chưa có tab nào. Thêm tab ở danh sách bên dưới.' }));

  config.items.forEach((it, i) => {
    const tab = byId.get(it.tabId);
    const alive = !!tab;
    if (tab) it.title = tab.title || it.title;

    const cur = dwellSec(it);
    const minIn = h('input', { type: 'number', min: 0, value: Math.floor(cur / 60), class: 'num', title: 'Phút' });
    const secIn = h('input', { type: 'number', min: 0, value: cur % 60, class: 'num', title: 'Giây' });
    const onTime = () => {
      // Chuẩn hóa: 0p 90s -> 1p 30s; tối thiểu 1 giây.
      const total = Math.max(1, Math.max(0, Math.floor(Number(minIn.value) || 0)) * 60 + Math.max(0, Math.floor(Number(secIn.value) || 0)));
      it.min = Math.floor(total / 60);
      it.sec = total % 60;
      delete it.value; delete it.unit;
      minIn.value = it.min; secIn.value = it.sec;
      saveConfig(); renderTotal();
    };
    minIn.addEventListener('change', onTime);
    secIn.addEventListener('change', onTime);

    const chk = h('input', { type: 'checkbox', checked: !!it.clickEnabled });
    chk.addEventListener('change', () => { it.clickEnabled = chk.checked; saveConfig(); });
    const pickBtn = h('button', { class: 'sm', textContent: it.click ? 'Đổi điểm' : 'Chọn điểm', onclick: () => pick(it.tabId) });
    pickBtn.disabled = !alive;
    const hint = h('span', {
      class: 'hint',
      textContent: it.click ? `đã chọn (${Math.round(it.click.xPct * 100)}%, ${Math.round(it.click.yPct * 100)}%)` : 'chưa chọn điểm',
    });

    const up = h('button', { class: 'ic', textContent: '↑', title: 'Lên', onclick: () => move(i, -1) });
    const down = h('button', { class: 'ic', textContent: '↓', title: 'Xuống', onclick: () => move(i, 1) });
    up.disabled = i === 0;
    down.disabled = i === config.items.length - 1;

    box.append(h('div', { class: 'row' + (alive ? '' : ' dead') + (run.running && run.index === i ? ' current' : '') },
      h('div', { class: 'top' },
        h('span', { class: 'idx', textContent: String(i + 1) }),
        h('span', { class: 'ttl', textContent: (it.title || '(không tiêu đề)') + (alive ? '' : ' — tab đã đóng'), title: it.title || '' }),
        up, down,
        h('button', { class: 'ic', textContent: '✕', title: 'Xóa khỏi chuỗi', onclick: () => removeItem(i) }),
      ),
      h('div', { class: 'bot' },
        h('span', { class: 'hint', textContent: 'Dừng' }), minIn, h('span', { class: 'hint', textContent: 'phút' }), secIn, h('span', { class: 'hint', textContent: 'giây' }),
        h('label', {}, chk, 'Nhấp'), pickBtn, hint,
      ),
    ));
  });
}

function renderAvail() {
  const used = new Set(config.items.map((i) => i.tabId));
  const box = $('#avail');
  box.replaceChildren();
  const free = openTabs.filter((t) => !used.has(t.id));
  if (!free.length) box.append(h('p', { class: 'empty', textContent: 'Không còn tab nào để thêm.' }));
  free.forEach((t) => box.append(h('div', { class: 'avail' },
    h('span', { class: 'ttl', textContent: t.title || t.url || '(không tiêu đề)', title: t.url || '' }),
    h('button', { class: 'sm', textContent: '+ Thêm', onclick: () => addTab(t) }),
  )));
}

function renderTotal() {
  const sum = config.items.reduce((s, it) => s + dwellSec(it), 0);
  $('#total').textContent = config.items.length
    ? `Tổng một vòng ≈ ${fmt(sum)} — mỗi tab được nhấp 1 lần mỗi vòng, nên giữ con số này nhỏ hơn thời gian timeout của trang.`
    : '';
}

function renderStatus() {
  const n = config.items.length;
  $('#start').disabled = run.running || !n;
  $('#pause').disabled = !run.running;
  $('#pause').textContent = run.paused ? 'Tiếp tục' : 'Tạm dừng';
  $('#stop').disabled = !run.running;
  $('#prev').disabled = !run.running;
  $('#next').disabled = !run.running;

  let t;
  if (!run.running) t = run.status || 'Đang dừng';
  else if (run.paused) t = `Tạm dừng · tab ${run.index + 1}/${n}` + (run.remainingMs ? ` · còn ${fmt(run.remainingMs / 1000)}` : '');
  else t = `Đang chạy · tab ${run.index + 1}/${n} · còn ${fmt((run.nextAt - Date.now()) / 1000)}`;
  $('#status').textContent = t;
  $('#note').textContent = run.running ? run.status || '' : '';
}

function render() { renderSeq(); renderAvail(); renderTotal(); renderStatus(); }

$('#start').onclick = () => cmd('start');
$('#pause').onclick = () => cmd(run.paused ? 'resume' : 'pause');
$('#stop').onclick = () => cmd('stop');
$('#prev').onclick = () => cmd('prev');
$('#next').onclick = () => cmd('next');
$('#loop').onchange = (e) => { config.loop = e.target.checked; saveConfig(); };
$('#autoPause').onchange = (e) => { config.autoPause = e.target.checked; saveConfig(); };

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  const typing = document.activeElement && document.activeElement.matches('input[type=number], select');
  if (ch.config) {
    config = { ...DEF_CONFIG, ...(ch.config.newValue || {}) };
    if (!typing) render();
  }
  if (ch.run) {
    const prevIndex = run.index;
    run = { ...run, ...(ch.run.newValue || {}) };
    renderStatus();
    if (run.index !== prevIndex && !typing) renderSeq();
  }
});

(async () => {
  await load();
  openTabs = await chrome.tabs.query({});
  $('#loop').checked = !!config.loop;
  $('#autoPause').checked = !!config.autoPause;
  render();
  setInterval(renderStatus, 500);
})();
