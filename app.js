'use strict';

/* ================= State ================= */
const state = {
  view: 'review',
  lines: [],
  models: [],
  config: {},
  date: todayStr(),
  enteredBy: localStorage.getItem('dpr_enteredBy') || '',
  grid: {},          // LineName -> { YesterdayAchieved, Shifts, PlanYesterday, PlanToday, Backlog, Remarks }
  modelsByLine: {},  // LineName -> [ { Model, PlannedQty } ]
  hist: { page: 1, q: '' },
  chart: null
};
const NUM = ['YesterdayAchieved', 'Shifts', 'PlanYesterday', 'PlanToday'];

/* ================= JSONP (timeout + resilience) ================= */
function api(action, params = {}) {
  return new Promise((resolve, reject) => {
    const cb = 'jp_' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('Network timeout')); }, 25000);
    function cleanup() { clearTimeout(timer); delete window[cb]; s.remove(); }
    window[cb] = (res) => { cleanup(); resolve(res); };
    const qs = Object.keys(params)
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
    s.src = CONFIG.API_URL + '?action=' + action + '&callback=' + cb + (qs ? '&' + qs : '');
    s.onerror = () => { cleanup(); reject(new Error('Network error')); };
    document.body.appendChild(s);
  });
}

/* ================= Helpers ================= */
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function pad(n) { return (n < 10 ? '0' : '') + n; }
function esc(v) { return (v == null ? '' : String(v)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function num(v) { return Number(v) || 0; }
function toast(msg, ok = true) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show ' + (ok ? 'ok' : 'bad');
  setTimeout(() => (t.className = 'toast'), 2800);
}
function openModal(html) {
  document.getElementById('modalBox').innerHTML = html;
  document.getElementById('modalWrap').classList.remove('hidden');
}
function closeModal() { document.getElementById('modalWrap').classList.add('hidden'); }

/* ================= Boot ================= */
async function boot() {
  try {
    const r = await api('bootstrap');
    if (!r.ok) return toast(r.message || 'Load failed', false);
    state.lines = r.lines || [];
    state.models = r.models || [];
    state.config = r.config || {};
    render();
  } catch (e) {
    document.getElementById('page').innerHTML =
      `<div class="empty">Could not reach the server.<br><span class="muted">${esc(e.message)}</span>
       <br><button class="btn btn-primary" style="width:auto;margin-top:14px" onclick="boot()">Retry</button></div>`;
  }
}

/* ================= Router ================= */
function setView(v) {
  state.view = v;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === v));
  document.getElementById('pageTitle').textContent =
    v === 'review' ? 'Daily Review' : v === 'dashboard' ? 'Dashboard' : 'Settings';
  render();
}
function render() {
  if (state.view === 'review') renderReview();
  else if (state.view === 'dashboard') renderDashboard();
  else renderSettings();
}

/* ================= View: Daily Review ================= */
async function renderReview() {
  const page = document.getElementById('page');
  page.innerHTML = `
    <div class="bar">
      <label class="field"><span>Date</span>
        <input id="revDate" class="input" type="date" value="${state.date}" max="${todayStr()}"></label>
      <label class="field"><span>Entered by</span>
        <input id="revBy" class="input" placeholder="Your name" value="${esc(state.enteredBy)}"></label>
      <div class="spacer"></div>
      <button id="saveDayBtn" class="btn btn-primary" style="width:auto">Save Day</button>
    </div>
    <div id="gridWrap" class="skeleton"></div>`;

  document.getElementById('revDate').onchange = e => { state.date = e.target.value; loadDay(); };
  document.getElementById('revBy').oninput = e => {
    state.enteredBy = e.target.value;
    localStorage.setItem('dpr_enteredBy', state.enteredBy);
  };
  document.getElementById('saveDayBtn').onclick = saveDay;
  await loadDay();
}

async function loadDay() {
  const wrap = document.getElementById('gridWrap');
  if (!wrap) return;
  wrap.className = ''; wrap.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  state.grid = {}; state.modelsByLine = {};
  try {
    const r = await api('getDay', { date: state.date });
    if (r.ok) {
      (r.reviews || []).forEach(rv => {
        state.grid[rv.LineName] = {
          YesterdayAchieved: blank(rv.YesterdayAchieved), Shifts: blank(rv.Shifts),
          PlanYesterday: blank(rv.PlanYesterday), PlanToday: blank(rv.PlanToday),
          Backlog: rv.Backlog || '', Remarks: rv.Remarks || ''
        };
      });
      (r.models || []).forEach(m => {
        (state.modelsByLine[m.LineName] = state.modelsByLine[m.LineName] || [])
          .push({ Model: m.Model, PlannedQty: blank(m.PlannedQty) });
      });
    }
    // fall back to local draft only if server had nothing for this date
    if (!Object.keys(state.grid).length) {
      const draft = JSON.parse(localStorage.getItem('dpr_draft_' + state.date) || 'null');
      if (draft) { state.grid = draft.grid || {}; state.modelsByLine = draft.modelsByLine || {}; }
    }
  } catch (e) {
    toast(e.message + ' — showing local draft if any', false);
    const draft = JSON.parse(localStorage.getItem('dpr_draft_' + state.date) || 'null');
    if (draft) { state.grid = draft.grid || {}; state.modelsByLine = draft.modelsByLine || {}; }
  }
  drawGrid();
}

function blank(v) { return (v === '' || v == null) ? '' : v; }

function drawGrid() {
  const wrap = document.getElementById('gridWrap');
  const rows = state.lines.map(l => {
    const nm = l.LineName;
    const g = state.grid[nm] || {};
    const mc = (state.modelsByLine[nm] || []).length;
    return `<tr data-line="${esc(nm)}">
      <td class="linecell">${esc(nm)}</td>
      <td class="tgt">${esc(l.WeeklyTarget)}</td>
      <td class="tgt">${esc(l.PerDayTarget)}</td>
      ${['YesterdayAchieved','Shifts','PlanYesterday','PlanToday'].map(f =>
        `<td><input class="cin" data-f="${f}" inputmode="numeric" value="${esc(g[f] ?? '')}"></td>`).join('')}
      <td><input class="cin wide" data-f="Backlog" value="${esc(g.Backlog ?? '')}"></td>
      <td><input class="cin wide" data-f="Remarks" value="${esc(g.Remarks ?? '')}"></td>
      <td><button class="btn btn-ghost mbtn" data-line="${esc(nm)}">Models${mc ? ` (${mc})` : ''}</button></td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="tblscroll">
      <table class="tbl grid fade-in">
        <thead><tr>
          <th>Production Line</th><th>Weekly<br>Target</th><th>Per<br>Day</th>
          <th>Yesterday<br>Achieved</th><th>Shifts</th><th>Plan (Y)</th><th>Plan (T)</th>
          <th>Backlog</th><th>Remarks</th><th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="10" class="empty">No production lines yet. Add them in Settings.</td></tr>`}</tbody>
        <tfoot><tr class="totrow">
          <td>TOTAL</td><td></td><td></td>
          <td id="tYA">0</td><td></td><td id="tPY">0</td><td id="tPT">0</td><td></td><td></td><td></td>
        </tr></tfoot>
      </table>
    </div>`;

  wrap.querySelectorAll('.cin').forEach(inp => {
    inp.addEventListener('input', e => {
      const line = e.target.closest('tr').dataset.line;
      const f = e.target.dataset.f;
      (state.grid[line] = state.grid[line] || {})[f] = e.target.value;
      if (NUM.includes(f)) recalcTotals();
      saveDraft();
    });
  });
  wrap.querySelectorAll('.mbtn').forEach(b => b.onclick = () => openModelsModal(b.dataset.line));
  recalcTotals();
}

function recalcTotals() {
  let ya = 0, py = 0, pt = 0;
  state.lines.forEach(l => {
    const g = state.grid[l.LineName] || {};
    ya += num(g.YesterdayAchieved); py += num(g.PlanYesterday); pt += num(g.PlanToday);
  });
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('tYA', ya); set('tPY', py); set('tPT', pt);
}

function saveDraft() {
  localStorage.setItem('dpr_draft_' + state.date,
    JSON.stringify({ grid: state.grid, modelsByLine: state.modelsByLine }));
}

/* ---- Model breakdown modal ---- */
function openModelsModal(line) {
  const list = state.modelsByLine[line] || [];
  const dl = state.models.map(m => `<option value="${esc(m.ModelCode)}">`).join('');
  openModal(`
    <div class="modal-head"><h3>Model breakdown — ${esc(line)}</h3>
      <button class="xbtn" onclick="closeModal()">&times;</button></div>
    <datalist id="modelOpts">${dl}</datalist>
    <div id="mplist">${list.map((m, i) => modelRow(m, i)).join('') || ''}</div>
    <button class="btn btn-ghost" style="width:auto;margin-top:10px" onclick="addModelRow()">+ Add model</button>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" style="width:auto" onclick="saveModelsModal('${esc(line)}')">Done</button>
    </div>`);
  if (!list.length) addModelRow();
}
function modelRow(m, i) {
  return `<div class="mprow">
    <input class="input mcode" list="modelOpts" placeholder="Model code" value="${esc(m.Model || '')}">
    <input class="input mqty" inputmode="numeric" placeholder="Qty" value="${esc(m.PlannedQty ?? '')}">
    <button class="xbtn" onclick="this.parentNode.remove()">&times;</button>
  </div>`;
}
function addModelRow() {
  document.getElementById('mplist').insertAdjacentHTML('beforeend', modelRow({}, 0));
}
function saveModelsModal(line) {
  const rows = [...document.querySelectorAll('#mplist .mprow')].map(r => ({
    Model: r.querySelector('.mcode').value.trim(),
    PlannedQty: r.querySelector('.mqty').value.trim()
  })).filter(x => x.Model);
  state.modelsByLine[line] = rows;
  saveDraft();
  closeModal();
  drawGrid();
}

/* ---- Save day (double-submit guard + keep data on failure) ---- */
let saving = false;
async function saveDay() {
  if (saving) return;
  if (!state.enteredBy.trim()) return toast('Enter your name first', false);
  // client validation
  const reviews = [];
  for (const l of state.lines) {
    const g = state.grid[l.LineName] || {};
    for (const f of NUM) if (g[f] !== '' && g[f] != null && isNaN(Number(g[f])))
      return toast(`${l.LineName}: ${f} must be a number`, false);
    reviews.push({
      LineName: l.LineName,
      YesterdayAchieved: g.YesterdayAchieved ?? '', Shifts: g.Shifts ?? '',
      PlanYesterday: g.PlanYesterday ?? '', PlanToday: g.PlanToday ?? '',
      Backlog: g.Backlog ?? '', Remarks: g.Remarks ?? ''
    });
  }
  const models = [];
  Object.keys(state.modelsByLine).forEach(line =>
    (state.modelsByLine[line] || []).forEach(m =>
      m.Model && models.push({ LineName: line, Model: m.Model, PlannedQty: m.PlannedQty ?? '' })));

  const btn = document.getElementById('saveDayBtn');
  saving = true; btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const r = await api('saveDay', {
      date: state.date, user: state.enteredBy.trim(),
      reviews: JSON.stringify(reviews), models: JSON.stringify(models)
    });
    if (r.ok) { toast('Day saved'); localStorage.removeItem('dpr_draft_' + state.date); }
    else toast(r.message || 'Save failed', false);
  } catch (e) { toast(e.message + ' — your entries are kept', false); }
  finally { saving = false; btn.disabled = false; btn.textContent = 'Save Day'; }
}

/* ================= View: Dashboard ================= */
async function renderDashboard() {
  const page = document.getElementById('page');
  page.innerHTML = `
    <div class="bar">
      <label class="field"><span>Date</span>
        <input id="dashDate" class="input" type="date" value="${state.date}" max="${todayStr()}"></label>
      <div class="spacer"></div>
      <button id="expBtn" class="btn btn-ghost" style="width:auto">Export CSV</button>
    </div>
    <div id="dashBody"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;
  document.getElementById('dashDate').onchange = e => { state.date = e.target.value; renderDashboard(); };
  document.getElementById('expBtn').onclick = exportHistory;

  try {
    const r = await api('dashboard', { date: state.date });
    if (!r.ok) return toast(r.message || 'Load failed', false);
    drawDashboard(r);
  } catch (e) { document.getElementById('dashBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

function drawDashboard(r) {
  const byLine = {}; (r.reviews || []).forEach(rv => byLine[rv.LineName] = rv);
  let tPT = 0, tYA = 0, tPY = 0;
  const cards = r.lines.map(l => {
    const rv = byLine[l.LineName] || {};
    const pt = num(rv.PlanToday), ya = num(rv.YesterdayAchieved), py = num(rv.PlanYesterday);
    tPT += pt; tYA += ya; tPY += py;
    const wa = num(r.weekAchieved[l.LineName]), wt = num(l.WeeklyTarget);
    const pct = wt ? Math.min(100, Math.round(wa / wt * 100)) : 0;
    const varc = py ? ya - py : 0;
    const vcls = varc > 0 ? 'up' : varc < 0 ? 'down' : '';
    return `<div class="card fade-in">
      <div class="card-top"><span class="cname">${esc(l.LineName)}</span>
        <span class="badge">Today plan ${pt}</span></div>
      <div class="card-nums">
        <div><b>${ya}</b><span>Yest. achieved</span></div>
        <div><b>${py || '—'}</b><span>Yest. plan</span></div>
        <div class="${vcls}"><b>${py ? (varc > 0 ? '+' : '') + varc : '—'}</b><span>Variance</span></div>
      </div>
      <div class="prog"><div class="prog-bar" style="width:${pct}%"></div></div>
      <div class="prog-lbl muted">Week: ${wa} / ${wt || '—'} (${pct}%)</div>
    </div>`;
  }).join('');

  document.getElementById('dashBody').innerHTML = `
    <div class="kpis">
      <div class="kpi"><b>${tPT}</b><span>Total plan (today)</span></div>
      <div class="kpi"><b>${tYA}</b><span>Total achieved (yest.)</span></div>
      <div class="kpi ${tYA - tPY > 0 ? 'up' : tYA - tPY < 0 ? 'down' : ''}"><b>${tPY ? (tYA - tPY > 0 ? '+' : '') + (tYA - tPY) : '—'}</b><span>Total variance</span></div>
      <div class="kpi"><b>${esc(r.weekStart)}</b><span>Week start</span></div>
    </div>
    <div class="chart-card"><canvas id="chart" height="110"></canvas></div>
    <div class="cards">${cards || `<div class="empty">No lines configured.</div>`}</div>`;

  drawChart(r, byLine);
}

function drawChart(r, byLine) {
  const ctx = document.getElementById('chart');
  if (!ctx || !window.Chart) return;
  if (state.chart) state.chart.destroy();
  const labels = r.lines.map(l => l.LineName);
  state.chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'Plan (Today)', data: r.lines.map(l => num((byLine[l.LineName] || {}).PlanToday)),
          backgroundColor: '#c7c4ff', borderRadius: 6 },
        { label: 'Achieved (Yest.)', data: r.lines.map(l => num((byLine[l.LineName] || {}).YesterdayAchieved)),
          backgroundColor: '#635bff', borderRadius: 6 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { boxWidth: 12 } } },
      scales: { y: { beginAtZero: true, grid: { color: '#eef0f6' } }, x: { grid: { display: false } } }
    }
  });
}

/* ================= View: Settings ================= */
function renderSettings() {
  const page = document.getElementById('page');
  page.innerHTML = `
    <div class="settings">
      <div class="sec">
        <div class="sec-head"><h3>Production Lines</h3>
          <button class="btn btn-primary" style="width:auto" onclick="editLine()">+ Add line</button></div>
        <div class="tblscroll"><table class="tbl">
          <thead><tr><th>Line</th><th>Weekly Target</th><th>Per Day</th><th>Seq</th><th></th></tr></thead>
          <tbody>${state.lines.map(l => `<tr>
            <td>${esc(l.LineName)}</td><td>${esc(l.WeeklyTarget)}</td><td>${esc(l.PerDayTarget)}</td>
            <td>${esc(l.Sequence)}</td>
            <td class="rowact">
              <button class="btn btn-ghost sm" onclick='editLine(${JSON.stringify(l)})'>Edit</button>
              <button class="btn btn-ghost sm danger" onclick="delLine('${esc(l.ID)}','${esc(l.LineName)}')">Delete</button>
            </td></tr>`).join('') || `<tr><td colspan="5" class="empty">No lines yet.</td></tr>`}</tbody>
        </table></div>
      </div>

      <div class="sec">
        <div class="sec-head"><h3>Model Master</h3>
          <button class="btn btn-primary" style="width:auto" onclick="editModel()">+ Add model</button></div>
        <div class="tblscroll"><table class="tbl">
          <thead><tr><th>Model Code</th><th>Category</th><th></th></tr></thead>
          <tbody>${state.models.map(m => `<tr>
            <td>${esc(m.ModelCode)}</td><td>${esc(m.Category)}</td>
            <td class="rowact">
              <button class="btn btn-ghost sm" onclick='editModel(${JSON.stringify(m)})'>Edit</button>
              <button class="btn btn-ghost sm danger" onclick="delModel('${esc(m.ID)}','${esc(m.ModelCode)}')">Delete</button>
            </td></tr>`).join('') || `<tr><td colspan="3" class="empty">No models yet.</td></tr>`}</tbody>
        </table></div>
      </div>
    </div>`;
}

/* ---- Line editor ---- */
function editLine(l) {
  l = l || {};
  openModal(`
    <div class="modal-head"><h3>${l.ID ? 'Edit' : 'Add'} line</h3><button class="xbtn" onclick="closeModal()">&times;</button></div>
    <label class="field2"><span>Line name</span><input id="lName" class="input" value="${esc(l.LineName || '')}"></label>
    <label class="field2"><span>Weekly target</span><input id="lWT" class="input" inputmode="numeric" value="${esc(l.WeeklyTarget ?? '')}"></label>
    <label class="field2"><span>Per-day target</span><input id="lPD" class="input" inputmode="numeric" value="${esc(l.PerDayTarget ?? '')}"></label>
    <label class="field2"><span>Sequence</span><input id="lSeq" class="input" inputmode="numeric" value="${esc(l.Sequence ?? '')}"></label>
    <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" style="width:auto" onclick="saveLineRec('${esc(l.ID || '')}')">Save</button></div>`);
}
async function saveLineRec(id) {
  const rec = {
    ID: id || undefined,
    LineName: document.getElementById('lName').value.trim(),
    WeeklyTarget: document.getElementById('lWT').value.trim(),
    PerDayTarget: document.getElementById('lPD').value.trim(),
    Sequence: document.getElementById('lSeq').value.trim()
  };
  if (!rec.LineName) return toast('Line name required', false);
  await mutate('saveLine', { record: JSON.stringify(rec) }, 'Line saved');
}
async function delLine(id, name) {
  if (!confirm('Delete line "' + name + '"? (soft delete, history kept)')) return;
  await mutate('deleteLine', { id }, 'Line deleted');
}

/* ---- Model editor ---- */
function editModel(m) {
  m = m || {};
  const cats = (state.config.LineCategory || []).map(c => `<option value="${esc(c.value)}">`).join('');
  openModal(`
    <div class="modal-head"><h3>${m.ID ? 'Edit' : 'Add'} model</h3><button class="xbtn" onclick="closeModal()">&times;</button></div>
    <label class="field2"><span>Model code</span><input id="mCode" class="input" value="${esc(m.ModelCode || '')}"></label>
    <label class="field2"><span>Category</span><input id="mCat" class="input" list="catOpts" value="${esc(m.Category || '')}" placeholder="e.g. 2W / Prismatic">
      <datalist id="catOpts">${cats}</datalist></label>
    <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" style="width:auto" onclick="saveModelRec('${esc(m.ID || '')}')">Save</button></div>`);
}
async function saveModelRec(id) {
  const rec = {
    ID: id || undefined,
    ModelCode: document.getElementById('mCode').value.trim(),
    Category: document.getElementById('mCat').value.trim()
  };
  if (!rec.ModelCode) return toast('Model code required', false);
  await mutate('saveModel', { record: JSON.stringify(rec) }, 'Model saved');
}
async function delModel(id, code) {
  if (!confirm('Delete model "' + code + '"?')) return;
  await mutate('deleteModel', { id }, 'Model deleted');
}

/* ---- Shared mutate: run action, refresh masters, re-render ---- */
async function mutate(action, params, okMsg) {
  try {
    const r = await api(action, Object.assign({ user: state.enteredBy || 'Admin' }, params));
    if (!r.ok) return toast(r.message || 'Failed', false);
    toast(okMsg);
    closeModal();
    const b = await api('bootstrap');
    if (b.ok) { state.lines = b.lines || []; state.models = b.models || []; state.config = b.config || {}; }
    render();
  } catch (e) { toast(e.message, false); }
}

/* ================= Export ================= */
async function exportHistory() {
  try {
    let page = 1, all = [];
    while (true) {
      const r = await api('listHistory', { page, q: '' });
      if (!r.ok) break;
      all = all.concat(r.rows || []);
      if (page * r.pageSize >= r.total) break;
      page++;
    }
    if (!all.length) return toast('Nothing to export', false);
    const cols = ['Date','LineName','YesterdayAchieved','Shifts','PlanYesterday','PlanToday','Backlog','Remarks','EnteredBy'];
    const csv = [cols.join(',')].concat(all.map(row =>
      cols.map(h => `"${(row[h] ?? '').toString().replace(/"/g, '""')}"`).join(','))).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'Daily_Production_Review.csv'; a.click();
  } catch (e) { toast(e.message, false); }
}

/* ================= Wire up ================= */
document.querySelectorAll('.nav-item').forEach(n => n.onclick = () => setView(n.dataset.view));
document.getElementById('modalWrap').addEventListener('click', e => { if (e.target.id === 'modalWrap') closeModal(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
