// Original Canvas 2D renderer, authored for Perfect Entry.
// Drawings are anchored to market timestamps and prices, never screen pixels.
export class PerfectViewChart extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bars = []; this.drawings = []; this.models = [];
    this.count = 110; this.end = 0; this.timeframe = 300; this.precision = 5;
    this.mode = 'candles'; this.focus = true; this.tool = 'select';
    this.selected = null; this.pending = null; this.cursor = null;
    this.drawingColor = '#e3b975';
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
      this.zoom(e.deltaY > 0 ? 1.14 : 0.88, p.x);
    }, { ...opts, passive: false });
    canvas.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault(); this.end += (e.key === 'ArrowLeft' ? -1 : 1) * this.count * 0.15;
        this.clamp(); this.requestDraw(); this.emit('viewport');
      } else if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoom(0.8); }
      else if (e.key === '-') { e.preventDefault(); this.zoom(1.25); }
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
    if (reset) this.count = 110;
    this.pending = null;
    this.clamp(); this.requestDraw();
  }
  setModels(models) { this.models = models; this.requestDraw(); }
  setDrawings(drawings) { this.drawings = structuredClone(drawings); this.selected = null; this.pending = null; this.requestDraw(); }
  setTool(tool) { this.tool = tool; this.pending = null; this.canvas.dataset.tool = tool; this.requestDraw(); this.emit('tool', { tool }); }
  setFocus(focus) { this.focus = focus; this.requestDraw(); }
  setMode(mode) { this.mode = mode; this.requestDraw(); }
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
    this.plot = { left: 18, right: w - (this.focus ? 24 : 86), top: 30, bottom: h - 42 };
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
      const label = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
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
        ? date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })
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
    for (const model of this.models) this.drawModel(model);
    for (const drawing of this.drawings) this.drawAnnotation(drawing);
    if (this.pending && this.cursor && this.inPlot(this.cursor)) {
      this.drawAnnotation({ type: this.tool, color: this.drawingColor, points: [this.pending, this.marketPoint(this.cursor)] });
    }
    if (this.cursor && this.inPlot(this.cursor)) {
      c.strokeStyle = '#cedbe02a'; c.lineWidth = 1; c.setLineDash([3, 5]); c.beginPath();
      c.moveTo(this.cursor.x, this.plot.top); c.lineTo(this.cursor.x, this.plot.bottom);
      if (!this.focus) { c.moveTo(this.plot.left, this.cursor.y); c.lineTo(this.plot.right, this.cursor.y); }
      c.stroke(); c.setLineDash([]);
    }
    c.restore();
    if (this.selected) {
      const d = this.drawings.find(d => d.id === this.selected);
      if (d) for (const p of d.points) {
        const point = this.xy(p); c.fillStyle = '#0f151b'; c.strokeStyle = d.color; c.lineWidth = 2;
        c.beginPath(); c.arc(point.x, point.y, 4, 0, Math.PI * 2); c.fill(); c.stroke();
      }
    }
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
    if (d.type === 'horizontal') {
      c.beginPath(); c.moveTo(this.plot.left, p.y); c.lineTo(this.plot.right, p.y); c.stroke();
    } else if (d.type === 'text') {
      c.font = '14px system-ui'; c.textAlign = 'left'; c.fillText(d.text, p.x + 7, p.y);
    } else {
      const q = this.xy(d.points[1]);
      if (d.type === 'trend') { c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(q.x, q.y); c.stroke(); }
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
      if (d.type === 'horizontal' && Math.abs(p.y - a.y) < 8) return { d, handle: -1 };
      if (d.type === 'text' && p.x >= a.x && p.x <= a.x + this.ctx.measureText(d.text).width + 16 && Math.abs(p.y - a.y) < 12) return { d, handle: -1 };
      if (d.points.length === 2) {
        const b = this.xy(d.points[1]);
        if (d.type === 'rectangle') {
          const l = Math.min(a.x, b.x), r = Math.max(a.x, b.x), t = Math.min(a.y, b.y), bot = Math.max(a.y, b.y);
          if (p.x >= l - 7 && p.x <= r + 7 && p.y >= t - 7 && p.y <= bot + 7 &&
              (Math.abs(p.x - l) < 7 || Math.abs(p.x - r) < 7 || Math.abs(p.y - t) < 7 || Math.abs(p.y - bot) < 7)) return { d, handle: -1 };
        } else {
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
    const p = this.position(e); if (!this.inPlot(p) || !this.bars.length) return;
    this.canvas.focus({ preventScroll: true }); this.canvas.setPointerCapture(e.pointerId);
    if (this.tool === 'select') {
      const hit = this.hit(p); this.selected = hit?.d.id ?? null;
      this.drag = { id: e.pointerId, start: p, end: this.end, hit, before: hit ? structuredClone(hit.d.points) : null,
        market: this.marketPoint(p), moved: false };
      this.emit('selection', { id: this.selected }); this.requestDraw(); return;
    }
    const point = this.marketPoint(p);
    if (this.tool === 'text') { this.emit('text', { point }); return; }
    if (this.tool === 'horizontal') { this.addDrawing({ type: this.tool, points: [point] }); this.setTool('select'); }
    else if (!this.pending) { this.pending = point; this.requestDraw(); this.emit('tool', { tool: this.tool, pending: true }); }
    else {
      this.addDrawing({ type: this.tool, points: [this.pending, point] }); this.setTool('select');
    }
  }
  onMove(e) {
    const p = this.position(e); this.cursor = p;
    if (this.drag && this.drag.id === e.pointerId) {
      const delta = p.x - this.drag.start.x;
      this.drag.moved ||= Math.hypot(delta, p.y - this.drag.start.y) > 3;
      if (this.drag.hit && this.drag.moved) {
        const { d, handle } = this.drag.hit, point = this.marketPoint(p);
        if (handle >= 0) d.points[handle] = point;
        else d.points = this.drag.before.map(a => ({ time: Math.max(0, a.time + point.time - this.drag.market.time),
          price: Math.max(1e-10, a.price + point.price - this.drag.market.price) }));
      } else if (!this.drag.hit) { this.end = this.drag.end - delta / this.plot.width * this.count; this.clamp(); }
    }
    if (this.inPlot(p) && this.bars.length) {
      const index = Math.round(this.end - this.count + (p.x - this.plot.left) / this.plot.width * this.count - 0.5);
      this.emit('hover', { bar: this.bars[index] ?? null });
    } else this.emit('hover', { bar: null });
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
    this.drag = null; this.requestDraw();
  }
  addDrawing(d) {
    if (this.drawings.length >= 300) { this.emit('limit'); return; }
    const drawing = { ...d, id: crypto.randomUUID(), color: d.color ?? this.drawingColor, name: d.name ?? '', text: d.text ?? '' };
    this.drawings.push(drawing); this.selected = drawing.id; this.requestDraw(); this.emit('drawings'); this.emit('selection', { id: drawing.id });
  }
  removeDrawing(id) {
    this.drawings = this.drawings.filter(d => d.id !== id); this.selected = null;
    this.requestDraw(); this.emit('drawings'); this.emit('selection');
  }
}
