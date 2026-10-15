import { aggregateBars, createDemoBars, indicators, parseDataset, validateDrawing, validateStudies, TIMEFRAMES } from './core.mjs';
import { PerfectViewChart } from './chart.mjs';
import { config } from './config.mjs';
import { registerCustomIndicators } from './custom-indicators.mjs';
registerCustomIndicators(indicators);
import { Account, showMembershipGate } from './account.mjs';
import { validateLayout } from './layouts.mjs';
import { CdnFeed, nextCdnCheck } from './cdn.mjs';
import {defaultFib,validateFib,validatePriceRange} from './drawings.mjs';
import {instrumentPreset,validateRiskSession,calculatePositionSize} from './risk.mjs';
import {FxBook} from './fx.mjs';

const account = new Account(config.accountApiUrl);
const $ = id => document.getElementById(id);
const chart = new PerfectViewChart($('chart'));
const PREFIX = 'perfect-view:v1:';
const defaults = { symbol: 'EURUSD', timeframe: 300, focus: true, crosshair: true, mode: 'candles', closedOnly: true,
  refreshSeconds: config.refreshSeconds === 30 ? 30 : 60, source: 'demo', datasetId: null, drawingColor: '#e3b975' };
let storageOkay = true, preferences = { ...defaults };
try {
  const raw = JSON.parse(localStorage.getItem(PREFIX + 'preferences') || 'null');
  if (raw && typeof raw === 'object') preferences = {
    ...defaults,
    symbol: /^[A-Z0-9._-]{2,24}$/.test(raw.symbol) ? raw.symbol : defaults.symbol,
    timeframe: TIMEFRAMES.includes(raw.timeframe) ? raw.timeframe : defaults.timeframe,
    focus: typeof raw.focus === 'boolean' ? raw.focus : true,
    crosshair: typeof raw.crosshair === 'boolean' ? raw.crosshair : true,
    closedOnly: typeof raw.closedOnly === 'boolean' ? raw.closedOnly : true,
    mode: raw.mode === 'line' ? 'line' : 'candles',
    refreshSeconds: raw.refreshSeconds === 30 ? 30 : 60,
    drawingColor: /^#[0-9a-f]{6}$/i.test(raw.drawingColor) ? raw.drawingColor : defaults.drawingColor,
    source: raw.source === 'import' ? 'import' : 'demo',
    datasetId: typeof raw.datasetId === 'string' && raw.datasetId.length < 120 ? raw.datasetId : null
  };
} catch { storageOkay = false; }

let activeLayoutId = null, activeLayoutRevision = 0;
let editingFibId=null;
let riskSession=validateRiskSession(getSaved('risk-session'))??{currency:'USD',balance:0,mode:'percent',risk:1,updated:''};
let riskProfiles=getSaved('risk-profiles')??{};
if(!riskProfiles||Array.isArray(riskProfiles)||typeof riskProfiles!=='object')riskProfiles={};
chart.fibSettings=validateFib(getSaved('fib-settings'))??defaultFib();
chart.positionSizer=drawing=>positionSize(drawing);
const archiveCache = new Map();
let dataset = null, kind = 'demo', datasetId = '', scope = '', studies = [], history = [], historyIndex = 0;
let pollTimer = null, feedController = null, feedGeneration = 0, notePoint = null, saveTimer = null;
let studyTemplateLoaded = false, renameTarget = null, editingStudy = null;
const workspaceCache = new Map();
let feedFetching = false, feedFailures = 0;
const cdn = new CdnFeed({url: config.feedUrl, readCache: readDataset, writeCache: cacheDataset});
const sampleFx=new FxBook(),fxErrors=new Map();let sampleFxTime=0,fxTimer=null;
const labels = { 30: '30 seconds', 60: '1 minute', 300: '5 minute', 900: '15 minute', 3600: '1 hour', 14400: '4 hour', 86400: '1 day' };
const names = { horizontal: 'Horizontal level', trend: 'Trendline', rectangle: 'Price zone', text: 'Note', vertical: 'Vertical line', ray: 'Ray', long: 'Long position', short: 'Short position', fib: 'Fibonacci retracement' };

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
    viewport: { count: chart.count, endTime: chart.bars.length ? chart.timeAt(chart.end - 1) : null, ...(chart.getPriceRange()?{priceRange:chart.getPriceRange()}:{}) } };
}
function validatedState(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.drawings) || raw.drawings.length > 300) throw new Error('Invalid workspace file.');
  const drawings = raw.drawings.map(validateDrawing);
  if (drawings.some(d => !d)) throw new Error('A drawing contains invalid coordinates.');
  const savedStudies = validateStudies(raw.studies);
  const priceRange=validatePriceRange(raw.viewport?.priceRange);
  if(raw.viewport?.priceRange!=null&&!priceRange)throw new Error('Invalid price scale.');
  const viewport = raw.viewport && Number.isFinite(raw.viewport.count) && Number.isFinite(raw.viewport.endTime)
    ? { count: Math.max(12, Math.min(1500, raw.viewport.count)), endTime: raw.viewport.endTime,...(priceRange?{priceRange}:{}) } : null;
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
function displayedBars(closedOnly = preferences.closedOnly) {
  if (!dataset) return [];
  const live = aggregateBars(dataset.candles, preferences.timeframe, {baseTimeframe:dataset.baseTimeframe,closedOnly});
  const cached = kind === 'feed' ? archiveCache.get(dataset.symbol + ':' + preferences.timeframe)?.data : null;
  if (!cached) return live;
  const older = aggregateBars(cached.candles, preferences.timeframe, {baseTimeframe:cached.baseTimeframe,closedOnly:true});
  return [...new Map([...older,...live].map(b => [b.time,b])).values()].sort((a,b) => a.time-b.time);
}
async function loadArchive() {
  if (kind !== 'feed' || ![3600,14400,86400].includes(preferences.timeframe)) return;
  const symbol=dataset.symbol,tf=preferences.timeframe,key=symbol+':'+tf,cached=archiveCache.get(key);
  // Archive files change hourly; a five-minute recheck avoids extra reads on every candle.
  if (cached && Date.now()-cached.checked<300000) return;
  archiveCache.set(key,{...cached,checked:Date.now()});
  try {const data=await cdn.history(symbol,tf);archiveCache.set(key,{checked:Date.now(),data});if(dataset?.symbol===symbol&&preferences.timeframe===tf)rebuild();}
  catch(error){announce('Older history could not be loaded. Recent candles remain available.');}
}
function rebuild({ reset = false } = {}) {
  if (!dataset) return;
  if (preferences.timeframe < dataset.baseTimeframe) preferences.timeframe = dataset.baseTimeframe;
  const bars = displayedBars();
  chart.setBars(bars, { timeframe: preferences.timeframe, precision: precision(dataset.symbol, bars), reset });
  chart.setFocus(preferences.focus); chart.setMode(preferences.mode);
  chart.setCrosshair(preferences.crosshair);$('crosshair').setAttribute('aria-pressed',String(preferences.crosshair));
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
    : `${preferences.refreshSeconds}s updates · ${sourceLast ? 'feed candle ' + utc(sourceLast.time) : 'no feed candles'} · UTC${delayed ? ' · delayed or market closed' : ''}`;
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
  if (source !== 'feed') clearTimeout(pollTimer);
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
  if(saved?.viewport?.priceRange)chart.setPriceRange(saved.viewport.priceRange);
  if (restoreViewport && saved?.viewport && chart.bars.length) {
    chart.count = saved.viewport.count; chart.end = chart.indexAt(saved.viewport.endTime) + 1;
    chart.clamp(); chart.requestDraw();
  }
  history = [{ drawings: structuredClone(chart.drawings), studies: structuredClone(studies) }]; historyIndex = 0;
  chart.setTool('select'); renderStudies(); renderDrawings(); renderRiskForm(); updateUndo(); save();
}
function useDemo(symbol = preferences.symbol, restoreViewport = false) {
  if (!['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD'].includes(symbol)) symbol = 'EURUSD';
  useDataset({ symbol, baseTimeframe: 60, candles: createDemoBars(symbol) }, 'demo', 'demo', { restoreViewport });
}
function calculateStudies() {
  const models = [];
  const completed = displayedBars(true);
  for (const study of studies) {
    if (study.enabled === false) continue;
    try { models.push({ ...indicators.calculate(study.id, completed, study), id: study.id, key: study.key, title: itemName(study, 'study') }); }
    catch { announce('An indicator could not be calculated. Remove it and try again.'); }
  }
  chart.setModels(models);
  updateStudyValues(chart.readout());
}
function updateStudyValues(readout){
  const byKey=new Map(readout.models.map(model=>[model.key,model]));
  document.querySelectorAll('[data-study-values]').forEach(element=>{
    const model=byKey.get(element.dataset.studyValues),values=model?.values??[];
    element.textContent=model?(values.length?values.map(v=>(values.length>1?v.name+' ':'')+v.text).join(' · '):'No visible components'):'Hidden';
    element.title=(readout.latest?'Latest closed candle':'Cursor candle')+' · '+element.textContent;
  });
}
function itemName(item, type) {
  return item.name || (type === 'study' ? `${item.id.startsWith('pe_') ? indicators.definitions.get(item.id)?.name ?? item.id : item.id.toUpperCase()}${item.period ? ' ' + item.period : ''}` : item.text || names[item.type]);
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
      if(item.type==='fib')item.fib={...(item.fib??defaultFib()),levels:(item.fib??defaultFib()).levels.map(level=>({...level,color:picker.value}))};
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
    const title = document.createElement('span'); title.className = 'item-title'; title.textContent = label; title.title = label;
    const heading=document.createElement('div');heading.className='study-heading';const values=document.createElement('small');values.className='study-values';values.dataset.studyValues=study.key;heading.append(title,values);
    const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${label}`);
    remove.addEventListener('click', () => { studies = studies.filter(s => s.key !== study.key); calculateStudies(); renderStudies(); checkpoint(); });
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = study.enabled !== false;
    enabled.setAttribute('aria-label', `Show ${label}`);
    enabled.addEventListener('change', () => {
      if(enabled.checked && indicators.definitions.get(study.id)?.pane === 'oscillator' && studies.filter(s => s.key !== study.key && s.enabled !== false && indicators.definitions.get(s.id)?.pane === 'oscillator').length >= 4) {enabled.checked=false;announce('Show up to four oscillator panels at once.');return;}
      study.enabled = enabled.checked; calculateStudies(); checkpoint(); });
    const settings = document.createElement('button'); settings.textContent = '⚙'; settings.setAttribute('aria-label', `Settings for ${label}`);
    settings.addEventListener('click', () => openIndicator(study));
    row.append(enabled, heading, colourPicker(study, 'study'), settings, renameButton('study', study.key, label), remove); list.append(row);
  }
  updateStudyValues(chart.readout());
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
    row.append(select, colourPicker(drawing, 'drawing'));
    if(drawing.type==='fib'){const settings=document.createElement('button');settings.textContent='⚙';settings.title='Edit Fibonacci levels and brightness';settings.setAttribute('aria-label','Settings for '+label);settings.addEventListener('click',()=>openFibSettings(drawing));row.append(settings);}
    row.append(renameButton('drawing', drawing.id, label), remove); list.append(row);
  }
  renderRiskReadout();
}
function openPanel(name) {
  document.querySelectorAll('[data-panel]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.panel === name)));
  $('indicators-panel').hidden = name !== 'indicators'; $('drawings-panel').hidden = name !== 'drawings';$('risk-panel').hidden=name!=='risk';
  if(name==='risk'){renderRiskReadout();if(['long','short'].includes(chart.tool)){$('side-panel').classList.add('open');$('panel-toggle').setAttribute('aria-expanded','true');}}
}

function addFibLevel(level={value:1,color:'#80cec6',opacity:1,visible:true}) {
  if($('fib-levels').children.length>=24)return;
  const row=document.createElement('div');row.className='fib-level-row';
  for(const [field,type] of [['visible','checkbox'],['value','number'],['color','color'],['opacity','range']]){
    const input=document.createElement('input');input.type=type;input.dataset.fib=field;input.setAttribute('aria-label',field==='value'?'Level ratio':field==='visible'?'Show level':field==='color'?'Level colour':'Level brightness');
    if(field==='visible')input.checked=level.visible;
    else if(field==='opacity'){input.min=10;input.max=100;input.step=5;input.value=level.opacity*100;}
    else{input.value=level[field];if(field==='value'){input.min=-10;input.max=10;input.step='any';input.required=true;}}
    row.append(input);
  }
  const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','Remove level');remove.addEventListener('click',()=>row.remove());row.append(remove);$('fib-levels').append(row);
}
function fillFibSettings(settings) {
  $('fib-width').value=settings.width;$('fib-opacity').value=settings.opacity*100;$('fib-extend').checked=settings.extend;$('fib-labels').checked=settings.labels;
  $('fib-levels').replaceChildren();settings.levels.forEach(addFibLevel);$('fib-error').hidden=true;
}
function openFibSettings(drawing) {
  editingFibId=drawing.id;fillFibSettings(drawing.fib??chart.fibSettings);$('fib-dialog').showModal();
}
$('fib-add-level').addEventListener('click',()=>addFibLevel());
$('fib-defaults').addEventListener('click',()=>fillFibSettings(defaultFib()));
$('fib-form').addEventListener('submit',event=>{
  event.preventDefault();
  const settings=validateFib({opacity:Number($('fib-opacity').value)/100,width:Number($('fib-width').value),extend:$('fib-extend').checked,labels:$('fib-labels').checked,levels:[...$('fib-levels').children].map(row=>({value:Number(row.querySelector('[data-fib="value"]').value),color:row.querySelector('[data-fib="color"]').value,opacity:Number(row.querySelector('[data-fib="opacity"]').value)/100,visible:row.querySelector('[data-fib="visible"]').checked}))});
  if(!settings){$('fib-error').textContent='Use 1–24 valid levels and keep at least one visible.';$('fib-error').hidden=false;return;}
  const drawing=chart.drawings.find(d=>d.id===editingFibId&&d.type==='fib');
  if(drawing)drawing.fib=structuredClone(settings);
  chart.fibSettings=settings;store('fib-settings',settings);chart.requestDraw();checkpoint();$('fib-dialog').close();
});

function currentRiskProfile() {
  const symbol=dataset?.symbol??preferences.symbol;
  return {...instrumentPreset(symbol),...(riskProfiles[symbol+':'+riskSession.currency]??{})};
}
function positionSize(drawing) {
  return calculatePositionSize(drawing,riskSession,currentRiskProfile(),dataset?.symbol??preferences.symbol,currentFxRate());
}
function needsConversion(){
  const p=currentRiskProfile(),symbol=dataset?.symbol??preferences.symbol;
  return p.mode==='contract'&&p.profitCurrency!==riskSession.currency&&!(symbol.length===6&&symbol.slice(0,3)===riskSession.currency&&symbol.slice(3)===p.profitCurrency);
}
function currentFxRate(){
  const p=currentRiskProfile();
  if(kind==='demo'){
    if(!sampleFxTime)for(const symbol of ['EURUSD','GBPUSD','USDJPY']){const b=createDemoBars(symbol).at(-1);sampleFxTime=Math.max(sampleFxTime,b.time+60);sampleFx.set({symbol,close:b.close,asOf:b.time+60});}
    const result=sampleFx.resolve(p.profitCurrency,riskSession.currency,{now:sampleFxTime});return result?{...result,sample:true}:null;
  }
  return cdn.fxBook.resolve(p.profitCurrency,riskSession.currency);
}
function renderConversionStatus(){
  const element=$('risk-conversion-status'),p=currentRiskProfile();if(!element)return;element.hidden=!needsConversion();if(element.hidden)return;
  const rate=currentFxRate(),key=p.profitCurrency+':'+riskSession.currency;
  if(rate){element.textContent='1 '+rate.from+' ≈ '+rate.rate.toLocaleString('en-GB',{maximumFractionDigits:8})+' '+rate.to+' · '+rate.symbols.join(' → ')+(rate.sample?' · sample tickers, not live':' · '+new Date(rate.asOf*1000).toLocaleTimeString('en-GB',{timeZone:'UTC',hour12:false})+' UTC');}
  else element.textContent=kind==='demo'?'No conversion route in these sample tickers.':!config.feedUrl?'Automatic conversion needs the broker feed. This offline preview converts its sample tickers.':fxErrors.get(key)??(riskSession.balance>0?'Loading '+p.profitCurrency+' → '+riskSession.currency+' from ticker closes…':'Currency conversion loads automatically when you set your balance.');
}
async function refreshConversion(){
  renderConversionStatus();
  if(!dataset||!needsConversion()||!(riskSession.balance>0)||kind==='demo'||!config.feedUrl||document.hidden||(config.requireMembership&&!account.access.perfectView)){renderRiskReadout();return;}
  const p=currentRiskProfile(),from=p.profitCurrency,to=riskSession.currency,key=from+':'+to;
  try{await cdn.conversionRate(from,to,{refresh:true,signal:AbortSignal.timeout(8000)});fxErrors.delete(key);}
  catch(error){fxErrors.set(key,error.message);}
  if(key===currentRiskProfile().profitCurrency+':'+riskSession.currency){renderConversionStatus();renderRiskReadout();chart.requestDraw();}
}
function scheduleFx(){
  clearTimeout(fxTimer);
  if(!dataset||kind==='demo'||!config.feedUrl||document.hidden||!needsConversion()||!(riskSession.balance>0)||(config.requireMembership&&!account.access.perfectView))return;
  fxTimer=setTimeout(async()=>{await refreshConversion();scheduleFx();},60000);
}
function renderRiskForm() {
  const p=currentRiskProfile(),symbol=dataset?.symbol??preferences.symbol;
  $('risk-currency').value=riskSession.currency;$('risk-balance').value=riskSession.balance||'';$('risk-mode').value=riskSession.mode;$('risk-value').value=riskSession.risk;
  for(const [id,field] of [['risk-contract-size','contractSize'],['risk-min-lot','minLot'],['risk-lot-step','lotStep'],['risk-max-lot','maxLot'],['risk-tick-size','tickSize'],['risk-tick-value','tickValue'],['risk-commission','commissionPerLot']])$(id).value=p[field]||'';
  $('risk-max-lot').value=p.maxLot;$('risk-commission').value=p.commissionPerLot;
  $('risk-calculation').value=p.mode;$('risk-profit-currency').value=p.profitCurrency;$('risk-market').textContent=symbol;
  $('risk-preset-note').textContent=riskProfiles[symbol+':'+riskSession.currency]?'Using your saved settings. Keep these matched to the MT5 symbol specification.':p.forex?'FX preset: 100,000 units/lot and 0.01 steps. Match these to your MT5 symbol specification.':'Enter the contract size and volume limits from this instrument’s MT5 specification.';
  if(!p.forex&&!p.contractSize)$('risk-contract').open=true;
  updateRiskVisibility();renderRiskReadout();void refreshConversion();scheduleFx();
}
function updateRiskVisibility() {
  const p=currentRiskProfile();renderConversionStatus();
  document.querySelectorAll('.contract-field').forEach(el=>el.hidden=p.mode!=='contract');document.querySelectorAll('.tick-field').forEach(el=>el.hidden=p.mode!=='tick');
  $('risk-value').max=riskSession.mode==='percent'?'100':'1000000000000';
  $('risk-value').setAttribute('aria-label',riskSession.mode==='percent'?'Risk percent of balance':'Risk amount in '+riskSession.currency);
  $('risk-session-date').textContent=riskSession.updated?'Balance/risk updated '+new Date(riskSession.updated).toLocaleDateString('en-GB')+' · saved on this device':'Enter your balance to start this session.';
}
function readRiskForm(event) {
  if($('risk-currency').value!==riskSession.currency){riskSession.currency=$('risk-currency').value;renderRiskForm();}
  riskSession={currency:$('risk-currency').value,balance:Number($('risk-balance').value),mode:$('risk-mode').value,risk:Number($('risk-value').value),updated:new Date().toISOString()};
  const p={...currentRiskProfile(),mode:$('risk-calculation').value,profitCurrency:$('risk-profit-currency').value};
  for(const [id,field] of [['risk-contract-size','contractSize'],['risk-min-lot','minLot'],['risk-lot-step','lotStep'],['risk-max-lot','maxLot'],['risk-tick-size','tickSize'],['risk-tick-value','tickValue'],['risk-commission','commissionPerLot']])p[field]=Number($(id).value);
  riskProfiles[(dataset?.symbol??preferences.symbol)+':'+riskSession.currency]=p;
  if(validateRiskSession(riskSession))store('risk-session',riskSession);store('risk-profiles',riskProfiles);
  updateRiskVisibility();renderRiskReadout();chart.requestDraw();void refreshConversion();scheduleFx();
}
function renderRiskReadout(drawing=chart.activePosition()) {
  const result=positionSize(drawing),holder=$('risk-readout');if(!holder)return;holder.replaceChildren();
  if(!result.ok){const p=document.createElement('p'),key=currentRiskProfile().profitCurrency+':'+riskSession.currency;p.textContent=result.message.startsWith('Waiting for')?(fxErrors.get(key)??result.message):result.message;holder.append(p);return;}
  const numbers=new Intl.NumberFormat('en-GB',{maximumFractionDigits:8}),money=n=>new Intl.NumberFormat('en-GB',{style:'currency',currency:result.currency,maximumFractionDigits:2}).format(n);
  const title=document.createElement('strong');title.className='risk-size';title.textContent=numbers.format(result.lots)+' lots';holder.append(title);
  const rows=[['Units',result.units==null?'Set contract size':numbers.format(result.units)],['Risk budget',money(result.budget)],['Est. stop loss',money(result.loss)],['Est. target P/L',money(result.reward)],['Est. reward / risk',result.rr.toFixed(2)],['Stop distance',result.distance.toFixed(chart.precision)]];
  const dl=document.createElement('dl');for(const [label,value] of rows){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;dl.append(dt,dd);}holder.append(dl);
  const note=document.createElement('p');note.textContent=result.message||result.conversion;holder.append(note);
}
$('risk-form').addEventListener('submit',event=>event.preventDefault());
$('risk-form').addEventListener('input',readRiskForm);$('risk-form').addEventListener('change',readRiskForm);
$('risk-new-session').addEventListener('click',()=>{riskSession={...riskSession,balance:0,updated:new Date().toISOString()};store('risk-session',riskSession);renderRiskForm();chart.requestDraw();scheduleFx();$('risk-balance').focus();});

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
let lastCacheCleanup = 0;
function pruneCdnCache() {
  const now = Date.now();
  if (now - lastCacheCleanup < 86400000) return;
  lastCacheCleanup = now;
  withDB((db, resolve, reject) => {
    const tx = db.transaction('datasets', 'readwrite'), store = tx.objectStore('datasets');
    const request = store.openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const key = String(cursor.key), match = key.startsWith('cdn:') && /:hour:\d+:(\d+)$/.exec(key);
      if (match && Number(match[1]) < now / 1000 - 7 * 86400) store.delete(cursor.key);
      cursor.continue();
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }).catch(() => {});
}
function cacheDataset(id, data) {
  if (id.startsWith('cdn:')) pruneCdnCache();
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
  feedFetching = true;
  feedController?.abort(); feedController = new AbortController();
  const controller = feedController;
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const id = 'feed:' + (config.workspaceFeedId ?? new URL(config.feedUrl, location.href).href);
    const previous = kind === 'feed' && scope === id + ':' + symbol ? dataset : null;
    const data = await cdn.load(symbol, previous, {signal: controller.signal});
    if (generation !== feedGeneration) return;
    if (scope === id + ':' + symbol) { dataset = data; rebuild(); save(); }
    else useDataset(data, 'feed', id, { restoreViewport });
    feedFailures = 0;
    $('message').hidden = true;
    loadArchive();
    void refreshConversion();
  } catch (error) {
    if (generation !== feedGeneration) return;
    feedFailures++;
    announce(error.name === 'AbortError' ? 'The feed timed out. Existing candles remain visible; they may be stale.' : error.message);
    $('data-status').textContent = 'Feed unavailable · displayed data may be stale';
    $('source-badge').textContent = 'Feed unavailable';
    if (dataset && dataset.symbol !== symbol) { ensureSymbol(dataset.symbol); preferences.symbol = dataset.symbol; }
  } finally {
    clearTimeout(timeout);
    if (generation === feedGeneration) {
      feedFetching = false;
    }
  }
}
function scheduleFeed() {
  clearTimeout(pollTimer);
  if (!config.feedUrl || document.hidden || (dataset && kind !== 'feed')) return;
  const delay = feedFailures ? Math.min(300000, 30000 * 2 ** Math.min(feedFailures - 1, 4))
    : nextCdnCheck(Date.now(), preferences.refreshSeconds);
  pollTimer = setTimeout(async () => {
    if (!document.hidden && !feedFetching) await fetchFeed();
    scheduleFeed();
  }, delay);
}
function pauseFeed() {
  clearTimeout(pollTimer);clearTimeout(fxTimer); feedController?.abort(); feedGeneration++; feedFetching = false;
}

document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => chart.setTool(button.dataset.tool)));
chart.addEventListener('tool', ({ detail }) => {
  document.querySelectorAll('[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === detail.tool)));
  if(['long','short'].includes(detail.tool))openPanel('risk');
  renderRiskReadout();
  $('chart-instructions').textContent = detail.tool === 'select' ? 'Scroll to zoom time. Shift + scroll to zoom price. Shift + drag to move price.'
    : detail.tool === 'horizontal' ? 'Click the chart to mark a level.'
    : ['long','short'].includes(detail.tool) ? (detail.stop ? 'Choose the target. Escape to cancel.' : detail.pending ? 'Choose the stop. Escape to cancel.' : 'Choose the entry, then stop, then target.')
    : detail.tool === 'vertical' ? 'Click to mark a time.'
    : detail.tool === 'fib' ? (detail.pending?'Choose the swing end. 0 will sit here.':'Choose the swing start, then the swing end. Edit levels in Drawings.')
    : detail.tool === 'text' ? 'Click where you want to leave a note.'
    : detail.pending ? 'Choose the second point. Escape to cancel.' : 'Choose the first point. Escape to cancel.';
});
chart.addEventListener('drawings', () => { renderDrawings(); checkpoint(); openPanel(chart.activePosition()?'risk':'drawings'); });
chart.addEventListener('selection', renderDrawings);
chart.addEventListener('readout',({detail})=>updateStudyValues(detail));
chart.addEventListener('viewport', () => {$('price-reset').setAttribute('aria-pressed',String(!chart.getPriceRange()));scheduleSave();});
chart.addEventListener('positionpreview',({detail})=>renderRiskReadout(detail.drawing));
chart.addEventListener('message', ({detail}) => announce(detail.text));
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
$('price-zoom-in').addEventListener('click',()=>chart.zoomPrice(.8));$('price-zoom-out').addEventListener('click',()=>chart.zoomPrice(1.25));$('price-reset').addEventListener('click',()=>chart.resetPriceScale());
$('latest').addEventListener('click', () => chart.latest());
document.querySelectorAll('[data-tf]').forEach(button => button.addEventListener('click', () => {
  preferences.timeframe = Number(button.dataset.tf); chart.setTool('select'); rebuild({ reset: true }); save(); loadArchive();
}));
$('symbol').addEventListener('change', async () => {
  const symbol = $('symbol').value;
  if (config.feedUrl) { await fetchFeed(symbol); scheduleFeed(); }
  else useDemo(symbol);
});
$('focus').addEventListener('click', () => { preferences.focus = !preferences.focus; chart.setFocus(preferences.focus); $('focus').setAttribute('aria-pressed', String(preferences.focus)); $('hover-time').textContent = ''; save(); });
$('crosshair').addEventListener('click',()=>{preferences.crosshair=!preferences.crosshair;chart.setCrosshair(preferences.crosshair);$('crosshair').setAttribute('aria-pressed',String(preferences.crosshair));save();});
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
function indicatorInputs(study = null) {
  const id = $('indicator-type').value, definition = indicators.definitions.get(id);
  const holder = $('indicator-inputs'); holder.replaceChildren();
  for (const [key, schema] of Object.entries(definition.inputs ?? {})) {
    const label = document.createElement('label'), input = document.createElement('input');
    label.textContent = schema.label; input.dataset.setting = key;
    input.id = key === 'period' ? 'ema-period' : 'study-' + key;
    if (schema.type === 'boolean') { input.type = 'checkbox'; input.checked = study?.[key] ?? schema.default; }
    else { input.type = 'number'; input.min = schema.min; input.max = schema.max; input.step = schema.step; input.value = study?.[key] ?? schema.default; input.required = true; }
    label.append(input); holder.append(label);
  }
  $('ema-color').value = study?.color ?? definition.defaults.color ?? '#b4a2ff';
}
function openIndicator(study = null) {
  if (!study && studies.length >= 12) { announce('Up to twelve indicators can be saved in a layout.'); return; }
  editingStudy = study;
  $('indicator-type').replaceChildren(...[...indicators.definitions.values()].map(d => {const o = document.createElement('option'); o.value = d.id; o.textContent = d.name; return o;}));
  $('indicator-type').value = study?.id ?? 'ema'; $('indicator-type').disabled = !!study;
  $('indicator-heading').textContent = study ? 'Indicator settings' : 'Add an indicator';
  indicatorInputs(study); $('indicator-dialog').showModal();
}
$('add-indicator').addEventListener('click', () => openIndicator());
$('indicator-type').addEventListener('change', () => indicatorInputs());
$('indicator-form').addEventListener('submit', event => {
  event.preventDefault(); const raw = {id: $('indicator-type').value, key: editingStudy?.key ?? crypto.randomUUID(),
    color: $('ema-color').value, name: editingStudy?.name ?? '', enabled: editingStudy?.enabled ?? true};
  for (const input of $('indicator-inputs').querySelectorAll('[data-setting]')) raw[input.dataset.setting] = input.type === 'checkbox' ? input.checked : Number(input.value);
  const validated = validateStudies([raw])[0];
  if (!validated) { announce('Check the indicator settings. RSI lower must be below upper; MACD fast must be below slow.'); return; }
  const next = editingStudy ? studies.map(s => s.key === editingStudy.key ? validated : s) : [...studies, validated];
  if (next.filter(s => s.enabled !== false && indicators.definitions.get(s.id)?.pane === 'oscillator').length > 4) { announce('Show up to four oscillator panels at once. Hide one before adding another.'); return; }
  studies = next; calculateStudies(); renderStudies(); checkpoint(); $('indicator-dialog').close(); editingStudy = null;
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
  feedFetching = false;
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
window.addEventListener('pagehide', () => { save(); pauseFeed(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { save(); pauseFeed(); }
  else {if (config.feedUrl && (!dataset || kind === 'feed')) fetchFeed().finally(scheduleFeed);void refreshConversion();scheduleFx();}
});
if (config.loginUrl) { $('login').href = config.loginUrl; $('login').hidden = false; }

function layoutDocument(name) {
  save(); const markets = {}, id = 'feed:' + (config.workspaceFeedId ?? new URL(config.feedUrl, location.href).href);
  for (const symbol of config.availableSymbols ?? [preferences.symbol]) {
    const state = workspaceCache.get(id + ':' + symbol) ?? getSaved('workspace:' + id + ':' + symbol);
    if (state) markets[symbol] = {drawings: state.drawings ?? [], viewport: state.viewport ?? null};
  }
  if (dataset) markets[dataset.symbol] = {drawings: structuredClone(chart.drawings), viewport: state().viewport};
  return validateLayout({version:2,name,preferences:{symbol:preferences.symbol,timeframe:preferences.timeframe,mode:preferences.mode,focus:preferences.focus,crosshair:preferences.crosshair,closedOnly:preferences.closedOnly,refreshSeconds:preferences.refreshSeconds},studies,markets});
}
async function listLayouts() {
  const result = await account.request('/layouts');
  $('layout-picker').replaceChildren(new Option('Choose a saved layout', ''), ...result.layouts.map(l => new Option(l.name, l.id)));
  if (activeLayoutId) $('layout-picker').value = activeLayoutId;
}
$('save-layout').addEventListener('click', async () => {
  if (!account.user) { if (config.accountApiUrl) await account.signIn(); else announce('Account sync will be available when Whop sign-in is connected. Your drawings are still saved in this browser.'); return; }
  if(kind !== 'feed') {announce('Account layouts use the broker feed. Export drawings separately for imported charts.');return;}
  $('layout-save-copy').checked = false; $('delete-layout').hidden = !activeLayoutId;
  $('layout-name').value = activeLayoutId ? $('layout-picker').selectedOptions[0]?.textContent ?? 'My layout' : 'My layout'; $('layout-dialog').showModal();
});
$('delete-layout').addEventListener('click', async () => {
  if (!activeLayoutId || !window.confirm('Delete this saved account layout? Your current chart will stay open.')) return;
  try {await account.request('/layouts/' + activeLayoutId,{method:'DELETE',headers:{'If-Match':String(activeLayoutRevision)}});activeLayoutId=null;activeLayoutRevision=0;await listLayouts();$('layout-dialog').close();announce('Saved layout deleted.');}
  catch(error) {announce(error.message);}
});
$('layout-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('save-layout-confirm'); button.disabled = true;
  try {
    const copy = $('layout-save-copy').checked, id = copy || !activeLayoutId ? crypto.randomUUID() : activeLayoutId;
    const result = await account.request('/layouts/' + id, {method:'PUT',headers:{'If-Match':String(copy || !activeLayoutId ? 0 : activeLayoutRevision)},body:JSON.stringify(layoutDocument($('layout-name').value))});
    activeLayoutId = id; activeLayoutRevision = result.revision; await listLayouts(); $('layout-dialog').close(); announce('Layout saved to your Whop account.');
  } catch(e) { announce(e.message); } finally { button.disabled = false; }
});
$('layout-picker').addEventListener('change', async () => {
  const id = $('layout-picker').value; if (!id) return;
  try {
    const result = await account.request('/layouts/' + id), layout = validateLayout(result.layout);
    save(); const source = 'feed:' + (config.workspaceFeedId ?? new URL(config.feedUrl, location.href).href);
    for (const symbol of config.availableSymbols ?? []) { const item=layout.markets[symbol] ?? {drawings:[],viewport:null};const data={version:1,...item,studies:layout.studies};workspaceCache.set(source+':'+symbol,data);store('workspace:'+source+':'+symbol,data); }
    // Clear the active scope so useDataset cannot overwrite the incoming layout with old drawings.
    scope = ''; preferences = {...preferences,...layout.preferences}; studies = layout.studies; store('studies',studies); studyTemplateLoaded = true;
    activeLayoutId = id; activeLayoutRevision = result.revision; await fetchFeed(preferences.symbol,true); scheduleFeed(); renderStudies(); announce('Layout loaded.');
  } catch(e) { announce(e.message); }
});
async function initializeAccount() {
  if (!config.accountApiUrl) return true;
  try {
    await account.initialize(); $('login').hidden = false; $('login').href = '#';
    $('login').textContent = account.user ? account.user.name + ' · Sign out' : 'Sign in with Whop';
    $('login').addEventListener('click', async event => {event.preventDefault();if(account.user){await account.signOut();location.reload();}else await account.signIn();});
    if (config.requireMembership && !showMembershipGate(account,'perfectView')) return false;
    if (account.access.perfectView) {
      try { await account.loadPremium(indicators); } catch(error) { announce(error.message); }
      $('layout-picker').hidden = false; try { await listLayouts(); } catch(error) { announce(error.message); }
    }
    return true;
  } catch(e) {announce(e.message);if(config.requireMembership) {showMembershipGate(account,'perfectView');return false;}return true;}
}

async function initialize() {
  if (config.feedUrl) {
    for (const symbol of config.availableSymbols ?? []) ensureSymbol(symbol);
    ensureSymbol(preferences.symbol);
    await fetchFeed(preferences.symbol, true);
    scheduleFeed(); return;
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
if (await initializeAccount()) {
  await initialize();
  if (config.requireMembership && config.accountApiUrl) {const membershipTimer = setInterval(async () => {
    if(document.hidden)return;
    try{const profile=await account.request('/me');account.user=profile.user;account.access=profile.access;if(!profile.access.perfectView){clearInterval(membershipTimer);save();pauseFeed();showMembershipGate(account,'perfectView');}}
    catch(error){if(error.status===401||error.status===403){clearInterval(membershipTimer);save();pauseFeed();account.user=null;account.access={};showMembershipGate(account,'perfectView');}}
  },300000);}
}
