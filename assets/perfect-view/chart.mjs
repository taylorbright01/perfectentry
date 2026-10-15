// Original Canvas 2D renderer, authored for Perfect Entry.
// Drawings are anchored to market timestamps and prices, never screen pixels.
import {defaultFib,fibPrices,validatePriceRange} from './drawings.mjs';
export class PerfectViewChart extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bars = []; this.drawings = []; this.models = [];
    this.count = 110; this.end = 0; this.timeframe = 300; this.precision = 5;
    this.mode = 'candles'; this.focus = true; this.tool = 'select';
    this.selected = null; this.pending = null; this.pendingStop = null; this.cursor = null;
    this.drawingColor = '#e3b975';
    this.fibSettings = defaultFib(); this.priceRange = null; this.positionSizer = null;
    this.drag = null; this.frame = null; this.width = 0; this.height = 0;
    this.abort = new AbortController();
    const opts = { signal: this.abort.signal };
    canvas.addEventListener('pointermove', e => this.onMove(e), opts);
    canvas.addEventListener('pointerdown', e => this.onDown(e), opts);
    canvas.addEventListener('pointerup', e => this.onUp(e), opts);
    canvas.addEventListener('pointercancel', e => this.onCancel(e), opts);
    canvas.addEventListener('pointerleave', () => { if (!this.drag) { this.cursor = null; this.requestDraw(); } }, opts);
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const p = this.position(e);
      if(e.shiftKey||e.altKey||this.plot&&p.x>this.plot.right)this.zoomPrice(e.deltaY>0?1.14:.88,p.y);
      else this.zoom(e.deltaY > 0 ? 1.14 : 0.88, p.x);
    }, { ...opts, passive: false });
    canvas.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault(); this.end += (e.key === 'ArrowLeft' ? -1 : 1) * this.count * 0.15;
        this.clamp(); this.requestDraw(); this.emit('viewport');
      } else if (e.key === '+' || e.key === '=') { e.preventDefault(); e.altKey?this.zoomPrice(.8):this.zoom(0.8); }
      else if (e.key === '-') { e.preventDefault(); e.altKey?this.zoomPrice(1.25):this.zoom(1.25); }
      else if (e.key === 'Escape') { this.setTool('select'); this.selected = null; this.requestDraw(); this.emit('selection'); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
        e.preventDefault(); this.removeDrawing(this.selected);
      }
    }, opts);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  destroy() { this.abort.abort(); this.resizeObserver.disconnect(); cancelAnimationFrame(this.frame); }
  position(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.width = r.width; this.height = r.height;
    const dpr = Math.min(devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.requestDraw();
  }
  requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.draw(); });
  }
  setBars(bars, { timeframe = this.timeframe, precision = this.precision, reset = false } = {}) {
    const atLatest = this.end >= this.bars.length - 0.5;
    // Keep the same market time when a historical viewport receives new data.
    const anchor = this.bars.length ? this.timeAt(this.end - 1) : null;
    this.bars = bars; this.timeframe = timeframe; this.precision = precision;
    if (reset || !anchor || atLatest) this.end = bars.length;
    else this.end = this.indexAt(anchor) + 1;
    if (reset) {this.count = 110; this.priceRange = null;}
    if(reset){this.pending=null;this.pendingStop=null;}
    this.clamp(); this.requestDraw();
  }
  setModels(models) {
    this.models = models; const panes = models.filter(m => m.pane === 'oscillator').length;
    if(this.canvas.parentElement) this.canvas.parentElement.style.minHeight = panes ? (260 + Math.min(4, panes) * 100) + 'px' : '';
    this.requestDraw();
  }
  setDrawings(drawings) { this.drawings = structuredClone(drawings); this.selected = null; this.pending = null; this.pendingStop=null;this.requestDraw(); }
  setTool(tool) { this.tool = tool; this.pending = null; this.pendingStop = null; this.canvas.dataset.tool = tool; this.requestDraw(); this.emit('tool', { tool }); }
  setFocus(focus) { this.focus = focus; this.requestDraw(); }
  setMode(mode) { this.mode = mode; this.requestDraw(); }
  getPriceRange() { return this.priceRange ? {...this.priceRange} : null; }
  setPriceRange(range) {this.priceRange=validatePriceRange(range);this.requestDraw();this.emit('viewport');}
  resetPriceScale() {this.priceRange=null;this.requestDraw();this.emit('viewport');}
  zoomPrice(factor,y=this.plot?(this.plot.top+this.plot.bottom)/2:0) {
    if(!this.bars.length||!this.plot||!Number.isFinite(this.min)||!Number.isFinite(this.max)||!Number.isFinite(factor)||factor<=0)return;
    const fraction=Math.max(0,Math.min(1,(this.plot.bottom-y)/this.plot.height)),span=this.max-this.min;
    const anchor=this.min+fraction*span,next=Math.max(Math.max(1e-10,Math.abs(anchor)*1e-10),Math.min(1e14,span*factor));
    const range=validatePriceRange({min:anchor-fraction*next,max:anchor+(1-fraction)*next});
    if(range){this.priceRange=range;this.min=range.min;this.max=range.max;this.requestDraw();this.emit('viewport');}
  }
  activePosition() {
    if(['long','short'].includes(this.tool)&&this.pending&&this.cursor&&this.inPlot(this.cursor)){
      const point=this.marketPoint(this.cursor),stop=this.pendingStop??point,direction=this.tool==='long'?1:-1;
      const target=this.pendingStop?point:{time:point.time,price:this.pending.price+direction*Math.abs(this.pending.price-stop.price)*2};
      return {type:this.tool,points:[this.pending,stop,target]};
    }
    return this.drawings.find(d=>d.id===this.selected&&['long','short'].includes(d.type))??null;
  }
  clamp() {
    this.count = Math.max(12, Math.min(1500, this.count));
    this.end = Math.max(Math.min(this.count, this.bars.length), Math.min(this.bars.length + this.count * 0.15, this.end));
  }
  latest() { this.end = this.bars.length; this.clamp(); this.requestDraw(); this.emit('viewport'); }
  zoom(factor, x = this.plot ? (this.plot.left + this.plot.right) / 2 : this.width / 2) {
    if (!this.bars.length) return;
    const old = this.count;
    const portion = this.plot ? Math.max(0, Math.min(1, (x - this.plot.left) / this.plot.width)) : 0.5;
    const anchor = this.end - old + portion * old;
    this.count = Math.max(12, Math.min(1500, old * factor));
    this.end = anchor + (1 - portion) * this.count;
    this.clamp(); this.requestDraw(); this.emit('viewport');
  }
  indexAt(time) {
    const bars = this.bars;
    if (!bars.length) return 0;
    if (time <= bars[0].time) return (time - bars[0].time) / this.timeframe;
    const last = bars.length - 1;
    if (time >= bars[last].time) return last + (time - bars[last].time) / this.timeframe;
    let lo = 0, hi = last;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (bars[mid].time <= time) lo = mid; else hi = mid; }
    return lo + (time - bars[lo].time) / (bars[hi].time - bars[lo].time);
  }
  timeAt(index) {
    if (!this.bars.length) return 0;
    const i = Math.floor(index), fraction = index - i;
    if (i < 0) return this.bars[0].time + index * this.timeframe;
    if (i >= this.bars.length - 1) return this.bars.at(-1).time + (index - this.bars.length + 1) * this.timeframe;
    return this.bars[i].time + fraction * (this.bars[i + 1].time - this.bars[i].time);
  }
  x(index) { return this.plot.left + (index - (this.end - this.count) + 0.5) * this.plot.width / this.count; }
  y(price) { return this.plot.bottom - (price - this.min) / (this.max - this.min) * this.plot.height; }
  xy(point) { return { x: this.x(this.indexAt(point.time)), y: this.y(point.price) }; }
  marketPoint(p) {
    const index = this.end - this.count + (p.x - this.plot.left) / this.plot.width * this.count - 0.5;
    return { time: Math.round(this.timeAt(index)), price: this.min + (this.plot.bottom - p.y) / this.plot.height * (this.max - this.min) };
  }
  inPlot(p) { return this.plot && p.x >= this.plot.left && p.x <= this.plot.right && p.y >= this.plot.top && p.y <= this.plot.bottom; }

  draw() {
    const c = this.ctx, w = this.width, h = this.height;
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#0f151b'; c.fillRect(0, 0, w, h);
    const panes = this.models.filter(m => m.pane === 'oscillator');
    const paneHeight = Math.min(108, Math.max(64, (h - 210) / Math.max(1, panes.length)));
    this.plot = { left: 18, right: w - (this.focus ? 24 : 86), top: 30, bottom: h - 42 - panes.length * paneHeight };
    this.plot.width = Math.max(1, this.plot.right - this.plot.left);
    this.plot.height = Math.max(1, this.plot.bottom - this.plot.top);
    const start = Math.max(0, Math.floor(this.end - this.count)), end = Math.min(this.bars.length, Math.ceil(this.end));
    const visible = this.bars.slice(start, end);
    if (!visible.length) {
      c.fillStyle = '#a5b1bc'; c.font = '16px system-ui'; c.textAlign = 'center';
      c.fillText('No complete candles for this timeframe.', w / 2, h / 2); return;
    }
    this.min = Math.min(...visible.map(b => b.low)); this.max = Math.max(...visible.map(b => b.high));
    const pad = Math.max((this.max - this.min) * 0.14, this.max * 0.00002);
    this.min -= pad; this.max += pad;
    if(this.priceRange){this.min=this.priceRange.min;this.max=this.priceRange.max;}
    c.font = '12px system-ui'; c.lineWidth = 1; c.textBaseline = 'middle';
    for (let i = 0; i <= 5; i++) {
      const y = this.plot.top + i / 5 * this.plot.height;
      c.strokeStyle = '#ffffff07'; c.beginPath(); c.moveTo(this.plot.left, y); c.lineTo(this.plot.right, y); c.stroke();
      if (!this.focus) {
        c.fillStyle = '#8b99a8'; c.textAlign = 'left';
        c.fillText((this.max - i / 5 * (this.max - this.min)).toFixed(this.precision), this.plot.right + 12, y);
      }
    }
    // Dates take priority over clock labels at UTC day changes. Keep one date
    // visible even when the viewport lies entirely within a single day.
    const dateLabels = [];
    for (let index = start; index < end; index++) {
      if (index !== start && Math.floor(this.bars[index].time / 86400) === Math.floor(this.bars[index - 1].time / 86400)) continue;
      const boundary = index > 0 && Math.floor(this.bars[index].time / 86400) !== Math.floor(this.bars[index - 1].time / 86400);
      const date = new Date(this.bars[index].time * 1000);
      const label = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: this.timeframe >= 86400 ? 'numeric' : undefined, timeZone: 'UTC' });
      const half = c.measureText(label).width / 2;
      const x = Math.max(this.plot.left + half, Math.min(this.plot.right - half, this.x(index)));
      if (dateLabels.some(previous => Math.abs(previous.x - x) < previous.half + half + 16)) continue;
      dateLabels.push({ x, half });
      if (boundary) {
        c.strokeStyle = '#ffffff10'; c.beginPath(); c.moveTo(this.x(index), this.plot.top); c.lineTo(this.x(index), this.plot.bottom); c.stroke();
      }
      c.fillStyle = '#b0bdc9'; c.textAlign = 'center'; c.fillText(label, x, h - 19);
    }
    const labels = Math.max(2, Math.floor(this.plot.width / 145));
    for (let i = 0; i < labels; i++) {
      const index = Math.max(0, Math.min(this.bars.length - 1, Math.round(this.end - this.count + this.count * (i + 0.35) / labels)));
      const x = this.x(index), date = new Date(this.bars[index].time * 1000);
      c.fillStyle = '#82909d'; c.textAlign = 'center';
      const label = this.timeframe >= 3600
        ? date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: this.timeframe >= 86400 ? 'numeric' : undefined, timeZone: 'UTC' })
        : date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
      if (dateLabels.some(date => Math.abs(date.x - x) < date.half + c.measureText(label).width / 2 + 16)) continue;
      c.fillText(label, x, h - 19);
    }
    c.save(); c.beginPath(); c.rect(this.plot.left, this.plot.top, this.plot.width, this.plot.height); c.clip();
    const bodyWidth = Math.max(1, Math.min(14, this.plot.width / this.count * 0.67));
    if (this.mode === 'line') {
      c.strokeStyle = '#73c7c4'; c.lineWidth = 1.7; c.beginPath();
      visible.forEach((b, i) => { const x = this.x(start + i), y = this.y(b.close); i ? c.lineTo(x, y) : c.moveTo(x, y); });
      c.stroke();
    } else for (let i = start; i < end; i++) {
      const b = this.bars[i], x = this.x(i), up = b.close >= b.open;
      c.strokeStyle = up ? '#74c8bb' : '#8797ad'; c.fillStyle = up ? '#74c8bb' : '#8797ad';
      c.lineWidth = 1; c.beginPath(); c.moveTo(x, this.y(b.high)); c.lineTo(x, this.y(b.low)); c.stroke();
      const top = Math.min(this.y(b.open), this.y(b.close)), height = Math.max(1.4, Math.abs(this.y(b.open) - this.y(b.close)));
      c.fillRect(x - bodyWidth / 2, top, bodyWidth, height);
    }
    for (const model of this.models) if (model.pane !== 'oscillator') this.drawModel(model);
    for (const drawing of this.drawings) this.drawAnnotation(drawing);
    if (this.pending && this.cursor && this.inPlot(this.cursor)) {
      const point = this.marketPoint(this.cursor);
      if (['long', 'short'].includes(this.tool)) {
        const stop = this.pendingStop ?? point, direction = this.tool === 'long' ? 1 : -1;
        const target = this.pendingStop ? point : {time: point.time, price: this.pending.price + direction * Math.abs(this.pending.price - stop.price) * 2};
        this.drawAnnotation({type: this.tool, color: this.drawingColor, points: [this.pending, stop, target]});
      } else this.drawAnnotation({ type: this.tool, color: this.drawingColor, points: [this.pending, point] });
    }
    if (this.cursor && this.inPlot(this.cursor)) {
      c.strokeStyle = '#cedbe02a'; c.lineWidth = 1; c.setLineDash([3, 5]); c.beginPath();
      c.moveTo(this.cursor.x, this.plot.top); c.lineTo(this.cursor.x, this.plot.bottom);
      if (!this.focus) { c.moveTo(this.plot.left, this.cursor.y); c.lineTo(this.plot.right, this.cursor.y); }
      c.stroke(); c.setLineDash([]);
    }
    c.restore();
    panes.forEach((model, i) => this.drawPane(model, this.plot.bottom + i * paneHeight + 8, paneHeight - 12));
    if (this.cursor && this.inPlot(this.cursor) && (this.tool !== 'select' || this.selected || !this.focus)) {
      const p = this.marketPoint(this.cursor); c.font = '11px system-ui'; c.fillStyle = '#dce6ef'; c.textAlign = 'right';
      c.fillText(p.price.toFixed(this.precision), this.plot.right - 5, Math.max(this.plot.top + 12, this.cursor.y - 9));
      c.textAlign = 'center'; c.fillText(new Date(p.time * 1000).toLocaleString('en-GB', {timeZone:'UTC',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}), Math.max(75, Math.min(w - 75, this.cursor.x)), h - 7);
    }
    if (this.selected) {
      const d = this.drawings.find(d => d.id === this.selected);
      if (d) for (const p of d.points) {
        const point = this.xy(p); c.fillStyle = '#0f151b'; c.strokeStyle = d.color; c.lineWidth = 2;
        c.beginPath(); c.arc(point.x, point.y, 4, 0, Math.PI * 2); c.fill(); c.stroke();
      }
    }
  }

  drawPane(model, top, height) {
    const c = this.ctx, start = this.end - this.count;
    const visible = p => this.indexAt(p.time) >= start - 1 && this.indexAt(p.time) <= this.end + 1 && Number.isFinite(p.value);
    const values = [...(model.lines ?? []), ...(model.histograms ?? [])].flatMap(l => (l.points ?? []).filter(visible).map(p => p.value));
    let min = model.range?.[0] ?? Math.min(0, ...values), max = model.range?.[1] ?? Math.max(0, ...values);
    if (max === min) { min -= 1; max += 1; }
    const y = value => top + height - 12 - (value - min) / (max - min) * (height - 24);
    c.save(); c.beginPath(); c.rect(this.plot.left, top, this.plot.width, height); c.clip();
    c.strokeStyle = '#ffffff18'; c.lineWidth = 1; c.beginPath(); c.moveTo(this.plot.left, top); c.lineTo(this.plot.right, top); c.stroke();
    c.fillStyle = '#9caab8'; c.font = '11px system-ui'; c.textAlign = 'left'; c.fillText(model.title ?? '', this.plot.left + 5, top + 10);
    for (const level of model.levels ?? []) {
      c.strokeStyle = '#ffffff18'; c.setLineDash([3, 5]); c.beginPath(); c.moveTo(this.plot.left, y(level)); c.lineTo(this.plot.right, y(level)); c.stroke();
      c.fillStyle = '#82909d'; c.textAlign = 'right'; c.fillText(String(level), this.plot.right - 4, y(level) - 6);
    }
    c.setLineDash([]);
    for (const histogram of model.histograms ?? []) for (const p of (histogram.points ?? []).filter(visible)) {
      c.fillStyle = p.value >= 0 ? histogram.positive : histogram.negative;
      const py = y(p.value), zero = y(0); c.fillRect(this.x(this.indexAt(p.time)) - 2, Math.min(py, zero), Math.max(1, Math.min(8, this.plot.width / this.count * .6)), Math.max(1, Math.abs(zero - py)));
    }
    for (const line of model.lines ?? []) {
      c.strokeStyle = line.color ?? '#b4a2ff'; c.lineWidth = 1.4; c.beginPath(); let started = false;
      for (const p of line.points ?? []) { if (!visible(p)) { started = false; continue; } const px = this.x(this.indexAt(p.time)), py = y(p.value); started ? c.lineTo(px, py) : c.moveTo(px, py); started = true; } c.stroke();
    }
    c.restore();
  }

  drawModel(model) {
    const c = this.ctx;
    for (const zone of model.zones ?? []) {
      if (![zone.from, zone.to, zone.high, zone.low].every(Number.isFinite)) continue;
      const x1 = this.x(this.indexAt(zone.from)), x2 = this.x(this.indexAt(zone.to));
      c.fillStyle = zone.color ?? '#e3b975'; c.globalAlpha = 0.12;
      c.fillRect(x1, this.y(zone.high), x2 - x1, this.y(zone.low) - this.y(zone.high)); c.globalAlpha = 1;
    }
    for (const line of model.lines ?? []) {
      c.strokeStyle = line.color ?? '#b4a2ff'; c.lineWidth = line.width ?? 1.5; c.beginPath();
      let started = false;
      for (const p of line.points ?? []) {
        if (!Number.isFinite(p.value) || !Number.isFinite(p.time)) { started = false; continue; }
        const i = this.indexAt(p.time);
        if (i < this.end - this.count - 1 || i > this.end + 1) continue;
        const x = this.x(i), y = this.y(p.value); started ? c.lineTo(x, y) : c.moveTo(x, y); started = true;
      }
      c.stroke();
    }
    for (const m of model.markers ?? []) {
      if (!Number.isFinite(m.time) || !Number.isFinite(m.price)) continue;
      const p = this.xy(m); c.fillStyle = m.color ?? '#e3b975'; c.beginPath();
      c.arc(p.x, p.y, 3, 0, 2 * Math.PI); c.fill();
      if (m.text) { c.font = '13px system-ui'; c.textAlign = 'center'; c.fillText(String(m.text).slice(0, 40), p.x, p.y - 14); }
    }
  }
  drawAnnotation(d) {
    const c = this.ctx, p = this.xy(d.points[0]);
    c.strokeStyle = d.color; c.fillStyle = d.color; c.lineWidth = d.id === this.selected ? 2 : 1.5;
    c.setLineDash([]);
    if (d.type === 'long' || d.type === 'short') {
      const stop = this.xy(d.points[1]), target = this.xy(d.points[2]);
      const right = Math.max(p.x + 35, target.x), risk = Math.abs(d.points[0].price - d.points[1].price), reward = Math.abs(d.points[2].price - d.points[0].price);
      c.globalAlpha = .14; c.fillStyle = '#74c8bb'; c.fillRect(p.x, Math.min(p.y, target.y), right - p.x, Math.abs(p.y - target.y));
      c.fillStyle = '#ce8585'; c.fillRect(p.x, Math.min(p.y, stop.y), right - p.x, Math.abs(p.y - stop.y)); c.globalAlpha = 1;
      c.font = '11px system-ui'; c.textAlign = 'left';
      for (const [name, point, price, colour] of [['Entry',p,d.points[0].price,d.color],['Stop',stop,d.points[1].price,'#ce8585'],['Target',target,d.points[2].price,'#74c8bb']]) {
        c.strokeStyle = colour; c.beginPath(); c.moveTo(p.x, point.y); c.lineTo(right, point.y); c.stroke(); c.fillStyle = colour; c.fillText(name + ' ' + price.toFixed(this.precision), p.x + 5, point.y - 8);
      }
      const size=this.positionSizer?.(d);
      c.fillStyle = '#c8d4df'; c.fillText(risk > 0 ? (size?.ok?'Est. R:R ':'R:R ') + (size?.ok?size.rr:reward / risk).toFixed(2) : 'Set stop', p.x + 5, p.y + 13);
      if(size?.ok){c.fillText(size.lots.toLocaleString('en-GB',{maximumFractionDigits:8})+' lots'+(size.units==null?'':' · '+size.units.toLocaleString('en-GB',{maximumFractionDigits:2})+' units'),p.x+5,p.y+28);}
    } else if (d.type === 'fib') {
      const q=this.xy(d.points[1]),settings=d.fib??this.fibSettings,left=Math.min(p.x,q.x),right=settings.extend?this.plot.right:Math.max(p.x,q.x);
      c.save();c.font='11px system-ui';c.textAlign='left';c.lineWidth=settings.width;
      for(const level of fibPrices(d.points,settings)){
        const y=this.y(level.price);c.globalAlpha=settings.opacity*level.opacity;c.strokeStyle=level.color;c.fillStyle=level.color;
        c.beginPath();c.moveTo(left,y);c.lineTo(right,y);c.stroke();
        if(settings.labels)c.fillText((level.value*100).toLocaleString('en-GB',{maximumFractionDigits:3})+'%  '+level.price.toFixed(this.precision),Math.max(this.plot.left+4,left+5),y-8);
      }
      c.globalAlpha=.45;c.strokeStyle=d.color;c.lineWidth=1;c.setLineDash([4,5]);c.beginPath();c.moveTo(p.x,p.y);c.lineTo(q.x,q.y);c.stroke();c.restore();
    } else if (d.type === 'vertical') {
      c.beginPath(); c.moveTo(p.x, this.plot.top); c.lineTo(p.x, this.plot.bottom); c.stroke();
    } else if (d.type === 'horizontal') {
      c.beginPath(); c.moveTo(this.plot.left, p.y); c.lineTo(this.plot.right, p.y); c.stroke();
      if (d.id === this.selected) {c.font = '11px system-ui'; c.textAlign = 'right'; c.fillText(d.points[0].price.toFixed(this.precision), this.plot.right - 5, p.y - 9);}
    } else if (d.type === 'text') {
      c.font = '14px system-ui'; c.textAlign = 'left'; c.fillText(d.text, p.x + 7, p.y);
    } else {
      const q = this.xy(d.points[1]);
      if (d.type === 'trend' || d.type === 'ray') {
        const end = d.type === 'ray' && Math.abs(q.x - p.x) > 1 ? {x:this.plot.right,y:p.y+(q.y-p.y)*(this.plot.right-p.x)/(q.x-p.x)} : q;
        c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(end.x, end.y); c.stroke();
      }
      else if (d.type === 'rectangle') {
        c.globalAlpha = 0.09; c.fillRect(p.x, p.y, q.x - p.x, q.y - p.y); c.globalAlpha = 1;
        c.strokeRect(p.x, p.y, q.x - p.x, q.y - p.y);
      }
    }
  }
  hit(p) {
    for (const d of [...this.drawings].reverse()) {
      const a = this.xy(d.points[0]);
      const handle = d.points.findIndex(point => { const q = this.xy(point); return Math.hypot(q.x - p.x, q.y - p.y) < 10; });
      if (handle >= 0) return { d, handle };
      if (d.type === 'vertical' && Math.abs(p.x - a.x) < 8) return {d, handle:-1};
      if(d.type==='fib'){
        const b=this.xy(d.points[1]),settings=d.fib??this.fibSettings,l=Math.min(a.x,b.x),r=settings.extend?this.plot.right:Math.max(a.x,b.x);
        if(p.x>=l-7&&p.x<=r+7&&fibPrices(d.points,settings).some(level=>Math.abs(p.y-this.y(level.price))<Math.max(7,settings.width+3)))return {d,handle:-1};
      }
      if (['long', 'short'].includes(d.type)) {const q=this.xy(d.points[2]), stop=this.xy(d.points[1]);if(p.x>=a.x-7&&p.x<=Math.max(a.x+35,q.x)+7&&p.y>=Math.min(q.y,stop.y)-8&&p.y<=Math.max(q.y,stop.y)+8)return {d,handle:-1};}
      if (d.type === 'horizontal' && Math.abs(p.y - a.y) < 8) return { d, handle: -1 };
      if (d.type === 'text' && p.x >= a.x && p.x <= a.x + this.ctx.measureText(d.text).width + 16 && Math.abs(p.y - a.y) < 12) return { d, handle: -1 };
      if (d.points.length === 2) {
        const b = this.xy(d.points[1]);
        if (d.type === 'rectangle') {
          const l = Math.min(a.x, b.x), r = Math.max(a.x, b.x), t = Math.min(a.y, b.y), bot = Math.max(a.y, b.y);
          if (p.x >= l - 7 && p.x <= r + 7 && p.y >= t - 7 && p.y <= bot + 7 &&
              (Math.abs(p.x - l) < 7 || Math.abs(p.x - r) < 7 || Math.abs(p.y - t) < 7 || Math.abs(p.y - bot) < 7)) return { d, handle: -1 };
        } else if(d.type!=='fib') {
          const dx = b.x - a.x, dy = b.y - a.y;
          const fraction = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
          if (Math.hypot(p.x - a.x - fraction * dx, p.y - a.y - fraction * dy) < 8) return { d, handle: -1 };
        }
      }
    }
    return null;
  }
  onDown(e) {
    if (e.button !== 0 || this.drag) return;
    const p = this.position(e); if (!this.plot||!this.bars.length) return;this.cursor=p;
    if(p.x>this.plot.right&&p.y>=this.plot.top&&p.y<=this.plot.bottom){
      this.canvas.setPointerCapture(e.pointerId);this.drag={id:e.pointerId,start:p,scale:true,range:{min:this.min,max:this.max},previousRange:this.getPriceRange(),moved:false};return;
    }
    if(!this.inPlot(p))return;
    this.canvas.focus({ preventScroll: true }); this.canvas.setPointerCapture(e.pointerId);
    if (this.tool === 'select') {
      const hit = e.shiftKey?null:this.hit(p); if(!e.shiftKey)this.selected = hit?.d.id ?? null;
      this.drag = { id: e.pointerId, start: p, end: this.end, hit, before: hit ? structuredClone(hit.d.points) : null,
        market: this.marketPoint(p), moved: false,pricePan:e.shiftKey&&!hit,range:{min:this.min,max:this.max},previousRange:this.getPriceRange() };
      this.emit('selection', { id: this.selected }); this.requestDraw(); return;
    }
    const point = this.marketPoint(p);
    if (this.tool === 'text') { this.emit('text', { point }); return; }
    if (this.tool === 'horizontal' || this.tool === 'vertical') { this.addDrawing({ type: this.tool, points: [point] }); this.setTool('select'); }
    else if (!this.pending) { this.pending = point; this.requestDraw(); this.emit('tool', { tool: this.tool, pending: true }); }
    else if (['long','short'].includes(this.tool)) {
      const direction = this.tool === 'long' ? 1 : -1;
      if (!this.pendingStop) {
        if ((point.price - this.pending.price) * direction >= 0) {this.emit('message', {text:'Place the stop on the loss side of the entry.'}); return;}
        this.pendingStop = point; this.emit('tool', {tool:this.tool,pending:true,stop:true});
      } else {
        if ((point.price - this.pending.price) * direction <= 0) {this.emit('message', {text:'Place the target on the profit side of the entry.'}); return;}
        this.addDrawing({type:this.tool,points:[this.pending,this.pendingStop,point]}); this.setTool('select');
      }
    } else {
      if(this.tool==='fib'&&point.price===this.pending.price){this.emit('message',{text:'Choose a second anchor at a different price.'});return;}
      this.addDrawing({ type: this.tool, points: [this.pending, point] }); this.setTool('select');
    }
  }
  onMove(e) {
    const p = this.position(e); this.cursor = p;
    this.canvas.style.cursor=this.plot&&p.x>this.plot.right&&p.y<=this.plot.bottom?'ns-resize':'';
    if (this.drag && this.drag.id === e.pointerId) {
      const delta = p.x - this.drag.start.x;
      this.drag.moved ||= Math.hypot(delta, p.y - this.drag.start.y) > 3;
      if((this.drag.scale||this.drag.pricePan)&&this.drag.moved){
        const before=this.drag.range,span=before.max-before.min,center=(before.min+before.max)/2,dy=p.y-this.drag.start.y;
        const next=this.drag.scale?Math.max(Math.abs(center)*1e-10,Math.min(1e14,span*Math.exp(Math.max(-8,Math.min(8,dy*.008))))):span;
        const shift=this.drag.pricePan?dy/this.plot.height*span:0;
        const range=validatePriceRange({min:center-next/2+shift,max:center+next/2+shift});
        if(range){this.priceRange=range;this.min=range.min;this.max=range.max;}
      }else if (this.drag.hit && this.drag.moved) {
        const { d, handle } = this.drag.hit, point = this.marketPoint(p);
        if (handle >= 0) {
          if (['long','short'].includes(d.type)) {
            const direction=d.type==='long'?1:-1, entry=d.points[0].price;
            if(handle===1 && (point.price-entry)*direction>=0)return;
            if(handle===2 && (point.price-entry)*direction<=0)return;
            if(handle===0 && !((d.points[1].price-point.price)*direction<0&&(d.points[2].price-point.price)*direction>0))return;
          }
          if(d.type==='fib'&&d.points[1-handle].price===point.price)return;
          d.points[handle] = point;
        }
        else {const moved=this.drag.before.map(a=>({time:Math.max(0,a.time+point.time-this.drag.market.time),price:a.price+point.price-this.drag.market.price}));if(moved.every(a=>a.price>0))d.points=moved;}
      } else if (!this.drag.hit&&!this.drag.scale&&!this.drag.pricePan) { this.end = this.drag.end - delta / this.plot.width * this.count; this.clamp(); }
    }
    if (this.inPlot(p) && this.bars.length) {
      const index = Math.round(this.end - this.count + (p.x - this.plot.left) / this.plot.width * this.count - 0.5);
      this.emit('hover', { bar: this.bars[index] ?? null });
    } else this.emit('hover', { bar: null });
    this.emit('positionpreview',{drawing:this.activePosition()});
    this.requestDraw();
  }
  onUp(e) {
    if (!this.drag || this.drag.id !== e.pointerId) return;
    const { hit, moved } = this.drag; this.drag = null;
    if (hit && moved) this.emit('drawings'); else if (!hit && moved) this.emit('viewport');
  }
  onCancel(e) {
    if (!this.drag || this.drag.id !== e.pointerId) return;
    if (this.drag.hit) this.drag.hit.d.points = this.drag.before;
    if(this.drag.scale||this.drag.pricePan)this.priceRange=this.drag.previousRange;
    this.drag = null; this.requestDraw();this.emit('positionpreview',{drawing:this.activePosition()});
  }
  addDrawing(d) {
    if (this.drawings.length >= 300) { this.emit('limit'); return; }
    const drawing = { ...d, id: crypto.randomUUID(), color: d.color ?? this.drawingColor, name: d.name ?? '', text: d.text ?? '' };
    if(d.type==='fib')drawing.fib=structuredClone(d.fib??this.fibSettings);
    this.drawings.push(drawing); this.selected = drawing.id; this.requestDraw(); this.emit('drawings'); this.emit('selection', { id: drawing.id });
  }
  removeDrawing(id) {
    this.drawings = this.drawings.filter(d => d.id !== id); this.selected = null;
    this.requestDraw(); this.emit('drawings'); this.emit('selection');
  }
}
