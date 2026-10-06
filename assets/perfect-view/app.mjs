import { aggregateBars, createDemoBars, indicators, parseDataset, validateDrawing, validateStudies, TIMEFRAMES } from './core.mjs';
import { PerfectViewChart } from './chart.mjs';
import { config } from './config.mjs';
import { parseFeedResponse } from './feed.mjs';

const $ = id => document.getElementById(id);
const chart = new PerfectViewChart($('chart'));
const PREFIX = 'perfect-view:v1:';
const defaults = { symbol: 'EURUSD', timeframe: 300, focus: true, mode: 'candles', closedOnly: true,
  refreshSeconds: config.refreshSeconds === 30 ? 30 : 60, source: 'demo', datasetId: null, drawingColor: '#e3b975' };
let storageOkay = true, preferences = { ...defaults };
try {
  const raw = JSON.parse(localStorage.getItem(PREFIX + 'preferences') || 'null');
  if (raw && typeof raw === 'object') preferences = {
    ...defaults,
    symbol: /^[A-Z0-9._-]{2,24}$/.test(raw.symbol) ? raw.symbol : defaults.symbol,
    timeframe: TIMEFRAMES.includes(raw.timeframe) ? raw.timeframe : defaults.timeframe,
    focus: typeof raw.focus === 'boolean' ? raw.focus : true,
    closedOnly: typeof raw.closedOnly === 'boolean' ? raw.closedOnly : true,
    mode: raw.mode === 'line' ? 'line' : 'candles',
    refreshSeconds: raw.refreshSeconds === 30 ? 30 : 60,
    drawingColor: /^#[0-9a-f]{6}$/i.test(raw.drawingColor) ? raw.drawingColor : defaults.drawingColor,
    source: raw.source === 'import' ? 'import' : 'demo',
    datasetId: typeof raw.datasetId === 'string' && raw.datasetId.length < 120 ? raw.datasetId : null
  };
} catch { storageOkay = false; }

let dataset = null, kind = 'demo', datasetId = '', scope = '', studies = [], history = [], historyIndex = 0;
let pollTimer = null, feedController = null, feedGeneration = 0, notePoint = null, saveTimer = null;
let studyTemplateLoaded = false, renameTarget = null;
const workspaceCache = new Map();
const labels = { 30: '30 seconds', 60: '1 minute', 300: '5 minute', 900: '15 minute', 3600: '1 hour', 14400: '4 hour', 86400: '1 day' };
const names = { horizontal: 'Horizontal level', trend: 'Trendline', rectangle: 'Price zone', text: 'Note' };

function announce(text) { $('message').textContent = text; $('message').hidden = false; }
function store(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); storageOkay = true; }
  catch { storageOkay = false; }
  $('save-status').textContent = storageOkay ? 'Saved in this browser · this device only' : 'Saving unavailable. Export your drawings to keep them.';
}
function getSaved(key) {
  try { return JSON.parse(localStorage.getItem(PREFIX + key) || 'null'); }
  catch { storageOkay = false; return null; }
}
function state() {
  return { version: 1, drawings: structuredClone(chart.drawings), studies: structuredClone(studies),
    viewport: { count: chart.count, endTime: chart.bars.length ? chart.timeAt(chart.end - 1) : null } };
}
function validatedState(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.drawings) || raw.drawings.length > 300) throw new Error('Invalid workspace file.');
  const drawings = raw.drawings.map(validateDrawing);
  if (drawings.some(d => !d)) throw new Error('A drawing contains invalid coordinates.');
  const savedStudies = validateStudies(raw.studies);
  const viewport = raw.viewport && Number.isFinite(raw.viewport.count) && Number.isFinite(raw.viewport.endTime)
    ? { count: Math.max(12, Math.min(1500, raw.viewport.count)), endTime: raw.viewport.endTime } : null;
  return { version: 1, drawings, studies: savedStudies, viewport };
}
function save() {
  if (!scope) return;
  const saved = state();
  workspaceCache.set(scope, saved);
  store('workspace:' + scope, saved);
  store('studies', studies);
  preferences = { ...preferences, symbol: dataset.symbol, source: kind === 'import' ? 'import' : 'demo',
    datasetId: kind === 'import' ? datasetId : null };
  store('preferences', preferences);
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); }
function checkpoint() {
  history = history.slice(0, historyIndex + 1);
  history.push({ drawings: structuredClone(chart.drawings), studies: structuredClone(studies) });
  if (history.length > 60) history.shift();
  historyIndex = history.length - 1;
  updateUndo(); save();
}
function updateUndo() { $('undo').disabled = historyIndex <= 0; $('redo').disabled = historyIndex >= history.length - 1; }
function travel(delta) {
  const next = historyIndex + delta;
  if (next < 0 || next >= history.length) return;
  historyIndex = next;
  chart.setDrawings(history[next].drawings); studies = structuredClone(history[next].studies);
  renderStudies(); calculateStudies(); renderDrawings(); updateUndo(); save();
}
function precision(symbol, bars) {
  if (/JPY/.test(symbol)) return 3;
  if (/XAU|XAG/.test(symbol)) return 2;
  const price = bars.at(-1)?.close ?? 1;
  return price >= 100 ? 2 : price < 0.1 ? 6 : 5;
}
function utc(time) {
  return new Date(time * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC', hour12: false });
}
function ensureSymbol(symbol) {
  if (![...$('symbol').options].some(o => o.value === symbol)) {
    const option = document.createElement('option'); option.value = symbol; option.textContent = symbol; $('symbol').append(option);
  }
  $('symbol').value = symbol;
}
function rebuild({ reset = false } = {}) {
  if (!dataset) return;
  if (preferences.timeframe < dataset.baseTimeframe) preferences.timeframe = dataset.baseTimeframe;
  const bars = aggregateBars(dataset.candles, preferences.timeframe, {
    baseTimeframe: dataset.baseTimeframe, closedOnly: preferences.closedOnly
  });
  chart.setBars(bars, { timeframe: preferences.timeframe, precision: precision(dataset.symbol, bars), reset });
  chart.setFocus(preferences.focus); chart.setMode(preferences.mode);
  $('chart-title').textContent = dataset.symbol;
  $('timeframe-label').textContent = labels[preferences.timeframe];
  $('focus').setAttribute('aria-pressed', String(preferences.focus));
  $('chart-mode').value = preferences.mode;
  $('closed-only').checked = preferences.closedOnly;
  $('refresh').value = String(preferences.refreshSeconds);
  document.querySelectorAll('[data-tf]').forEach(button => {
    button.disabled = Number(button.dataset.tf) < dataset.baseTimeframe;
    button.setAttribute('aria-pressed', String(Number(button.dataset.tf) === preferences.timeframe));
  });
  $('source-badge').textContent = kind === 'demo' ? 'Sample data · not live' : kind === 'import' ? 'Imported candles' : 'Broker feed';
  $('source-badge').dataset.source = kind;
  const last = bars.at(-1);
  const sourceLast = dataset.candles.at(-1);
  const delayed = kind === 'feed' && (!sourceLast || Date.now() / 1000 - sourceLast.time - dataset.baseTimeframe > Math.max(90, preferences.refreshSeconds * 3));
  if (delayed) $('source-badge').textContent = 'Broker feed · delayed';
  $('data-status').textContent = kind === 'demo' ? 'Synthetic sample · UTC · no live prices'
    : kind === 'import' ? `File data · ${last ? 'last candle ' + utc(last.time) : 'no complete candles'} · UTC`
    : `${preferences.refreshSeconds}s refresh · ${sourceLast ? 'feed candle ' + utc(sourceLast.time) : 'no feed candles'} · UTC${delayed ? ' · delayed or market closed' : ''}`;
  $('chart-summary').textContent = `${dataset.symbol}, ${labels[preferences.timeframe]} chart, ${bars.length} candles. ` +
    (last ? `Last candle opened ${utc(last.time)} UTC. Open ${last.open}, high ${last.high}, low ${last.low}, close ${last.close}. ` : '') +
    (kind === 'demo' ? 'Synthetic sample data, not live market prices.' : '');
  $('candle-table').replaceChildren(...bars.slice(-20).reverse().map(bar => {
    const row = document.createElement('tr');
    for (const value of [utc(bar.time), ...['open', 'high', 'low', 'close'].map(k => bar[k].toFixed(chart.precision))]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    return row;
  }));
  calculateStudies();
}
function useDataset(data, source, id, { reset = true, restoreViewport = false } = {}) {
  if (scope) save();
  dataset = data; kind = source; datasetId = id;
  scope = id + ':' + data.symbol;
  preferences.symbol = data.symbol;
  ensureSymbol(data.symbol);
  let saved = null;
  try { const raw = workspaceCache.get(scope) ?? getSaved('workspace:' + scope); if (raw) saved = validatedState(raw); }
  catch { announce('The saved workspace could not be read. Your candle data is still available.'); }
  chart.setDrawings(saved?.drawings ?? []);
  if (!studyTemplateLoaded) {
    const shared = getSaved('studies');
    // Migrate the active market's older indicators once; an empty shared list
    // remains authoritative after the user deliberately removes every study.
    studies = Array.isArray(shared) ? validateStudies(shared) : saved?.studies ?? [];
    studyTemplateLoaded = true;
  }
  chart.drawingColor = preferences.drawingColor;
  rebuild({ reset });
  if (restoreViewport && saved?.viewport && chart.bars.length) {
    chart.count = saved.viewport.count; chart.end = chart.indexAt(saved.viewport.endTime) + 1;
    chart.clamp(); chart.requestDraw();
  }
  history = [{ drawings: structuredClone(chart.drawings), studies: structuredClone(studies) }]; historyIndex = 0;
  chart.setTool('select'); renderStudies(); renderDrawings(); updateUndo(); save();
}
function useDemo(symbol = preferences.symbol, restoreViewport = false) {
  if (!['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD'].includes(symbol)) symbol = 'EURUSD';
  useDataset({ symbol, baseTimeframe: 60, candles: createDemoBars(symbol) }, 'demo', 'demo', { restoreViewport });
}
function calculateStudies() {
  const models = [];
  for (const study of studies) {
    try { models.push(indicators.calculate(study.id, chart.bars, study)); }
    catch { announce('An indicator could not be calculated. Remove it and try again.'); }
  }
  chart.setModels(models);
}
function itemName(item, type) {
  return item.name || (type === 'study' ? `EMA ${item.period}` : item.text || names[item.type]);
}
function renameButton(type, id, label) {
  const button = document.createElement('button'); button.className = 'rename-button';
  button.title = `Rename ${label}`; button.setAttribute('aria-label', `Rename ${label}`);
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5-11 11-6 1 1-6ZM13 6l5 5"/></svg>';
  button.addEventListener('click', () => {
    renameTarget = { type, id };
    $('rename-name').value = label;
    $('rename-dialog').showModal(); $('rename-name').focus(); $('rename-name').select();
  });
  return button;
}
function colourPicker(item, type) {
  const picker = document.createElement('input'); picker.type = 'color'; picker.className = 'item-colour';
  picker.value = item.color; picker.title = `Colour for ${itemName(item, type)}`;
  picker.setAttribute('aria-label', picker.title);
  picker.addEventListener('change', () => {
    item.color = picker.value;
    if (type === 'drawing') {
      preferences.drawingColor = picker.value; chart.drawingColor = picker.value; chart.requestDraw();
    } else calculateStudies();
    checkpoint();
  });
  return picker;
}
function renderStudies() {
  const list = $('indicator-list'); list.replaceChildren();
  if (!studies.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'A clear chart to start with. Add an indicator when you need one.'; list.append(p); }
  for (const study of studies) {
    const row = document.createElement('div'); row.className = 'entry-row';
    const label = itemName(study, 'study');
    const title = document.createElement('span'); title.className = 'item-title'; title.textContent = label; title.title = `${label} · EMA ${study.period}`;
    const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${label}`);
    remove.addEventListener('click', () => { studies = studies.filter(s => s.key !== study.key); calculateStudies(); renderStudies(); checkpoint(); });
    row.append(title, colourPicker(study, 'study'), renameButton('study', study.key, label), remove); list.append(row);
  }
}
function renderDrawings() {
  const list = $('drawing-list'); list.replaceChildren();
  $('drawing-count').textContent = `${chart.drawings.length} drawing${chart.drawings.length === 1 ? '' : 's'}`;
  $('delete').disabled = !chart.selected;
  if (!chart.drawings.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Mark a level, draw a zone or leave yourself a note. Your drawings appear here.'; list.append(p); }
  for (const drawing of chart.drawings) {
    const row = document.createElement('div'); row.className = 'entry-row' + (drawing.id === chart.selected ? ' selected' : '');
    const label = itemName(drawing, 'drawing');
    const select = document.createElement('button'); select.className = 'item-title'; select.textContent = label; select.title = label;
    select.addEventListener('click', () => {
      chart.selected = drawing.id; chart.setTool('select');
      chart.end = chart.indexAt(drawing.points[0].time) + chart.count / 2;
      chart.clamp(); chart.requestDraw(); renderDrawings(); scheduleSave();
    });
    const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', `Delete ${label}`);
    remove.addEventListener('click', () => chart.removeDrawing(drawing.id));
    row.append(select, colourPicker(drawing, 'drawing'), renameButton('drawing', drawing.id, label), remove); list.append(row);
  }
}
function openPanel(name) {
  document.querySelectorAll('[data-panel]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.panel === name)));
  $('indicators-panel').hidden = name !== 'indicators'; $('drawings-panel').hidden = name !== 'drawings';
}

// Imported candles are kept in IndexedDB, separate from small workspace documents.
function withDB(action) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('perfect-view-data', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('datasets');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      try { action(db, resolve, reject); } catch (error) { db.close(); reject(error); }
    };
  });
}
function cacheDataset(id, data) {
  return withDB((db, resolve, reject) => {
    const tx = db.transaction('datasets', 'readwrite'); tx.objectStore('datasets').put(data, id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
function readDataset(id) {
  return withDB((db, resolve, reject) => {
    const tx = db.transaction('datasets'); const request = tx.objectStore('datasets').get(id);
    request.onsuccess = () => resolve(request.result);
    tx.oncomplete = () => db.close(); tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function fetchFeed(symbol = preferences.symbol, restoreViewport = false) {
  const generation = ++feedGeneration;
  feedController?.abort(); feedController = new AbortController();
  const controller = feedController;
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const url = new URL(config.feedUrl, location.href);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error('The feed needs HTTPS.');
    url.searchParams.set('symbol', symbol); url.searchParams.set('timeframe', String(config.feedBaseTimeframe ?? 60));
    const id = 'feed:' + new URL(config.feedUrl, location.href).href;
    const previous = kind === 'feed' && scope === id + ':' + symbol ? dataset : null;
    if (previous?.candles.length) url.searchParams.set('since', String(Math.max(0, previous.candles.at(-1).time - 60)));
    const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal: controller.signal });
    if (response.status === 401 || response.status === 403) throw new Error('Sign in with an eligible membership to load this feed.');
    if (!response.ok) throw new Error('The broker feed is unavailable.');
    const text = await response.text();
    const data = parseFeedResponse(text, symbol, config.feedBaseTimeframe ?? 60, previous);
    if (generation !== feedGeneration) return;
    if (scope === id + ':' + symbol) { dataset = data; rebuild(); save(); }
    else useDataset(data, 'feed', id, { restoreViewport });
    $('message').hidden = true;
  } catch (error) {
    if (generation !== feedGeneration) return;
    announce(error.name === 'AbortError' ? 'The feed timed out. Existing candles remain visible; they may be stale.' : error.message);
    $('data-status').textContent = 'Feed unavailable · displayed data may be stale';
    $('source-badge').textContent = 'Feed unavailable';
    if (dataset && dataset.symbol !== symbol) { ensureSymbol(dataset.symbol); preferences.symbol = dataset.symbol; }
  } finally { clearTimeout(timeout); }
}
function scheduleFeed() {
  clearTimeout(pollTimer);
  if (!config.feedUrl || (dataset && kind !== 'feed')) return;
  pollTimer = setTimeout(async () => {
    if (!document.hidden) await fetchFeed();
    scheduleFeed();
  }, preferences.refreshSeconds * 1000);
}

document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => chart.setTool(button.dataset.tool)));
chart.addEventListener('tool', ({ detail }) => {
  document.querySelectorAll('[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === detail.tool)));
  $('chart-instructions').textContent = detail.tool === 'select' ? 'Drag to explore. Scroll to zoom.'
    : detail.tool === 'horizontal' ? 'Click the chart to mark a level.'
    : detail.tool === 'text' ? 'Click where you want to leave a note.'
    : detail.pending ? 'Choose the second point. Escape to cancel.' : 'Choose the first point. Escape to cancel.';
});
chart.addEventListener('drawings', () => { renderDrawings(); checkpoint(); openPanel('drawings'); });
chart.addEventListener('selection', renderDrawings);
chart.addEventListener('viewport', scheduleSave);
chart.addEventListener('limit', () => announce('This workspace supports up to 300 drawings. Export or remove some before adding more.'));
chart.addEventListener('hover', ({ detail }) => {
  const b = detail.bar;
  $('hover-time').textContent = !b ? '' : preferences.focus ? `${utc(b.time)} UTC` : `${utc(b.time)} · O ${b.open.toFixed(chart.precision)} H ${b.high.toFixed(chart.precision)} L ${b.low.toFixed(chart.precision)} C ${b.close.toFixed(chart.precision)}`;
});
chart.addEventListener('text', ({ detail }) => { notePoint = detail.point; $('note-text').value = ''; $('note-dialog').showModal(); $('note-text').focus(); });
$('note-form').addEventListener('submit', event => {
  event.preventDefault(); const text = $('note-text').value.trim(); if (!text || !notePoint) return;
  chart.addDrawing({ type: 'text', points: [notePoint], text }); notePoint = null;
  $('note-dialog').close(); chart.setTool('select');
});
$('undo').addEventListener('click', () => travel(-1)); $('redo').addEventListener('click', () => travel(1));
$('delete').addEventListener('click', () => { if (chart.selected) chart.removeDrawing(chart.selected); });
$('zoom-in').addEventListener('click', () => chart.zoom(0.8)); $('zoom-out').addEventListener('click', () => chart.zoom(1.25));
$('latest').addEventListener('click', () => chart.latest());
document.querySelectorAll('[data-tf]').forEach(button => button.addEventListener('click', () => {
  preferences.timeframe = Number(button.dataset.tf); chart.setTool('select'); rebuild({ reset: true }); save();
}));
$('symbol').addEventListener('change', async () => {
  const symbol = $('symbol').value;
  if (config.feedUrl) { await fetchFeed(symbol); scheduleFeed(); }
  else useDemo(symbol);
});
$('focus').addEventListener('click', () => { preferences.focus = !preferences.focus; chart.setFocus(preferences.focus); $('focus').setAttribute('aria-pressed', String(preferences.focus)); $('hover-time').textContent = ''; save(); });
$('chart-mode').addEventListener('change', () => { preferences.mode = $('chart-mode').value; chart.setMode(preferences.mode); save(); });
$('closed-only').addEventListener('change', () => { preferences.closedOnly = $('closed-only').checked; rebuild(); save(); });
$('refresh').addEventListener('change', () => { preferences.refreshSeconds = Number($('refresh').value); rebuild(); save(); scheduleFeed(); });
document.querySelectorAll('[data-panel]').forEach(button => button.addEventListener('click', () => openPanel(button.dataset.panel)));
$('side-panel').addEventListener('pointerdown', event => {
  // Workspace labels are controls/read-only text, not inline editing surfaces.
  // Preserve intentional control interaction and keyboard focus.
  if (!event.target.closest('button,a,input,select,textarea,label')) event.preventDefault();
});
$('panel-toggle').addEventListener('click', () => { const open = $('side-panel').classList.toggle('open'); $('panel-toggle').setAttribute('aria-expanded', String(open)); });
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
$('rename-form').addEventListener('submit', event => {
  event.preventDefault(); const name = $('rename-name').value.trim().slice(0, 80);
  if (!name || !renameTarget) return;
  const item = renameTarget.type === 'drawing'
    ? chart.drawings.find(d => d.id === renameTarget.id) : studies.find(s => s.key === renameTarget.id);
  if (item) { item.name = name; renderDrawings(); renderStudies(); checkpoint(); }
  renameTarget = null; $('rename-dialog').close();
});
$('load').addEventListener('click', () => { $('import-symbol').value = dataset?.symbol ?? preferences.symbol; $('import-error').hidden = true; $('load-dialog').showModal(); });
$('add-indicator').addEventListener('click', () => {
  if (studies.length >= 8) { announce('Up to eight moving averages can be shown at once.'); return; }
  $('indicator-dialog').showModal();
});
$('indicator-form').addEventListener('submit', event => {
  event.preventDefault(); const period = Number($('ema-period').value);
  if (!Number.isInteger(period) || period < 1 || period > 500) return;
  studies.push({ id: 'ema', key: crypto.randomUUID(), period, color: $('ema-color').value });
  calculateStudies(); renderStudies(); checkpoint(); $('indicator-dialog').close();
});
$('data-form').addEventListener('submit', async event => {
  event.preventDefault(); const file = $('data-file').files[0]; if (!file) return;
  const button = event.submitter; button.disabled = true; $('import-error').hidden = true;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('Choose a file under 8 MB (up to 50,000 candles).');
    const text = await file.text();
    const data = parseDataset(text, $('import-symbol').value.toUpperCase(), Number($('import-timeframe').value));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text + data.symbol + data.baseTimeframe));
    const id = 'import:' + [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
    clearTimeout(pollTimer); feedController?.abort(); feedGeneration++;
    try { await cacheDataset(id, data); }
    catch { announce('The file is open, but this browser could not store the candles. Keep the original file for your next visit.'); }
    useDataset(data, 'import', id); $('load-dialog').close();
  } catch (error) { $('import-error').textContent = error.message; $('import-error').hidden = false; }
  finally { button.disabled = false; }
});
$('sample-data').addEventListener('click', () => {
  feedController?.abort(); feedGeneration++; clearTimeout(pollTimer);
  useDemo(); $('load-dialog').close();
});
$('export').addEventListener('click', () => {
  const content = JSON.stringify({ ...state(), symbol: dataset.symbol, datasetId, exportedAt: new Date().toISOString() }, null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `perfect-view-${dataset.symbol}-drawings.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('restore').addEventListener('click', () => $('restore-file').click());
$('restore-file').addEventListener('change', async () => {
  const file = $('restore-file').files[0]; if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('Workspace file is too large.');
    const raw = JSON.parse(await file.text()), saved = validatedState(raw);
    if (raw.symbol !== dataset.symbol || raw.datasetId !== datasetId) throw new Error('Open the original market and candle source before restoring these drawings.');
    chart.setDrawings(saved.drawings); studies = saved.studies; renderDrawings(); renderStudies(); calculateStudies(); checkpoint();
    announce('Drawings and indicators restored.');
  } catch (error) { announce(error.message); }
  $('restore-file').value = '';
});
document.addEventListener('keydown', event => {
  if (event.target.matches('input,textarea,select') || document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); travel(event.shiftKey ? 1 : -1); }
});
window.addEventListener('pagehide', save);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { save(); clearTimeout(pollTimer); }
  else if (config.feedUrl && kind === 'feed') { fetchFeed().finally(scheduleFeed); }
});
if (config.loginUrl) { $('login').href = config.loginUrl; $('login').hidden = false; }

async function initialize() {
  if (config.feedUrl) {
    for (const symbol of config.availableSymbols ?? []) ensureSymbol(symbol);
    ensureSymbol(preferences.symbol);
    await fetchFeed(preferences.symbol, true); scheduleFeed(); return;
  }
  if (preferences.source === 'import' && preferences.datasetId) {
    try {
      const cached = await readDataset(preferences.datasetId);
      if (cached) {
        const validated = parseDataset(JSON.stringify(cached));
        useDataset(validated, 'import', preferences.datasetId, { restoreViewport: true }); return;
      }
      announce('The imported candles are no longer stored here. Reopen the original file to restore that chart’s drawings.');
    } catch { announce('Stored candles could not be loaded. Reopen the original file to restore your imported chart.'); }
  }
  useDemo(preferences.symbol, true);
}
await initialize();
