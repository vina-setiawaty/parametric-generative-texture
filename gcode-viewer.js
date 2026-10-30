// gcode-viewer.js -- the toolpath preview beside the G-code textarea, in
// the spirit of ncviewer.com: extrusions and travel moves drawn over the
// bed, orbit / pan / zoom, and a scrubber that replays the file move by
// move. Clicking a line in the textarea jumps the scrubber to it.
//
// Plain Canvas 2D with an orthographic projection: the p5 canvas on this
// page is a full-window WEBGL layer behind everything, so the viewer keeps
// its own canvas and touches nothing of p5's.
//
// The textarea stays the source of truth: parametric-with-tool.js calls
// window.gcodeViewer.setGcode() after each compile, and hand edits in the
// textarea are picked up from its "input" event.

(function () {
  const BED = 220;          // mm, matches CONSTRAINTS.bed in the catalog
  const GRID = 10;          // mm between grid lines

  /** G-code text -> { segs: [{a:[x,y,z], b:[x,y,z], extrude, line}], bbox }.
   * Tracks G90/G91, M82/M83, G92 and G28; G2/G3 arcs (I/J form) are
   * flattened. Moves that change only E or nothing are skipped. */
  function parse(text) {
    const lines = text.split("\n");
    const segs = [];
    let pos = [0, 0, 0], e = 0;
    let absXYZ = true, absE = true;
    let bbox = null, allBox = null;
    const grow = (box, p) => {
      if (!box) return { min: [...p], max: [...p] };
      for (let i = 0; i < 3; i++) { box.min[i] = Math.min(box.min[i], p[i]); box.max[i] = Math.max(box.max[i], p[i]); }
      return box;
    };

    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li].replace(/;.*$/, "").replace(/\(.*?\)/g, "").trim().toUpperCase();
      if (!raw) continue;
      const cmd = raw.split(/\s+/)[0];
      const word = (k) => {
        const m = raw.match(new RegExp(`${k}\\s*(-?\\d*\\.?\\d+)`));
        return m ? parseFloat(m[1]) : null;
      };

      if (cmd === "G90") { absXYZ = true; absE = true; continue; }
      if (cmd === "G91") { absXYZ = false; absE = false; continue; }
      if (cmd === "M82") { absE = true; continue; }
      if (cmd === "M83") { absE = false; continue; }
      if (cmd === "G92") {
        const v = ["X", "Y", "Z"].map(word);
        pos = v.map((n, i) => (n === null ? pos[i] : n));
        const ne = word("E"); if (ne !== null) e = ne;
        continue;
      }
      if (cmd === "G28") {
        const axes = ["X", "Y", "Z"].filter((k) => raw.includes(k));
        const all = axes.length === 0;
        const next = [...pos];
        ["X", "Y", "Z"].forEach((k, i) => { if (all || axes.includes(k)) next[i] = 0; });
        segs.push({ a: pos, b: next, extrude: false, line: li });
        pos = next;
        continue;
      }
      const isArc = cmd === "G2" || cmd === "G02" || cmd === "G3" || cmd === "G03";
      if (!(cmd === "G0" || cmd === "G00" || cmd === "G1" || cmd === "G01" || isArc)) continue;

      const v = ["X", "Y", "Z"].map(word);
      const next = v.map((n, i) => (n === null ? pos[i] : absXYZ ? n : pos[i] + n));
      const ev = word("E");
      let extrude = false;
      if (ev !== null) {
        const de = absE ? ev - e : ev;
        extrude = de > 0;
        e = absE ? ev : e + ev;
      }
      if (next[0] === pos[0] && next[1] === pos[1] && next[2] === pos[2]) continue;

      let pts = [next];
      if (isArc) {
        const I = word("I") ?? 0, J = word("J") ?? 0;
        const cx = pos[0] + I, cy = pos[1] + J;
        const r = Math.hypot(I, J);
        let a0 = Math.atan2(pos[1] - cy, pos[0] - cx);
        let a1 = Math.atan2(next[1] - cy, next[0] - cx);
        const cw = cmd === "G2" || cmd === "G02";
        if (cw && a1 >= a0) a1 -= 2 * Math.PI;
        if (!cw && a1 <= a0) a1 += 2 * Math.PI;
        const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) * r / 0.5));
        pts = [];
        for (let k = 1; k <= n; k++) {
          const t = k / n, a = a0 + (a1 - a0) * t;
          pts.push(k === n ? next : [cx + r * Math.cos(a), cy + r * Math.sin(a), pos[2] + (next[2] - pos[2]) * t]);
        }
      }
      for (const p of pts) {
        segs.push({ a: pos, b: p, extrude, line: li });
        if (extrude) { bbox = grow(bbox, pos); bbox = grow(bbox, p); }
        allBox = grow(allBox, pos); allBox = grow(allBox, p);
        pos = p;
      }
    }
    return { segs, bbox: bbox || allBox, lineCount: lines.length, lines };
  }

  class GcodeViewer {
    constructor({ canvas, textarea, slider, label, buttons }) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.textarea = textarea;
      this.slider = slider;
      this.label = label;
      this.buttons = buttons;
      this.data = { segs: [], bbox: null, lines: [] };
      this.shown = 0;                  // segments drawn in full (scrubber)
      this.showTravel = true;
      this.view = { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0, target: [BED / 2, BED / 2, 0], scale: 1 };
      this.fitted = false;
      this.playTimer = null;

      new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
      this.bindMouse();
      this.bindControls();

      let inputTimer = null;
      textarea.addEventListener("input", () => {
        clearTimeout(inputTimer);
        inputTimer = setTimeout(() => this.setGcode(textarea.value), 300);
      });
      const syncFromCursor = () => this.jumpToLine(textarea.value.slice(0, textarea.selectionStart).split("\n").length - 1);
      textarea.addEventListener("click", syncFromCursor);
      textarea.addEventListener("keyup", (ev) => { if (ev.key.startsWith("Arrow") || ev.key === "PageUp" || ev.key === "PageDown") syncFromCursor(); });
    }

    setGcode(text) {
      this.stop();
      this.data = parse(text || "");
      this.slider.max = this.data.segs.length;
      this.shown = this.data.segs.length;
      this.slider.value = this.shown;
      // Fit once, on the first G-code -- later recompiles keep the user's view.
      if (!this.fitted && this.data.bbox) { this.fitted = true; this.fit(); }
      this.updateLabel();
      this.draw();
    }

    // ---- view ----

    resize() {
      const r = this.canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.round(r.width * dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * dpr));
      const first = !this.w;
      this.w = r.width; this.h = r.height; this.dpr = dpr;
      // a fit requested before the canvas had a size measured nothing
      if (first) this.fit(); else this.draw();
    }

    /** world -> view-plane coords (orthographic; pitch 0 = top view). */
    rot(p) {
      const v = this.view, t = v.target;
      const x = p[0] - t[0], y = p[1] - t[1], z = p[2] - t[2];
      const cy = Math.cos(v.yaw), sy = Math.sin(v.yaw);
      const x1 = x * cy - y * sy, y1 = x * sy + y * cy;
      return [x1, y1 * Math.cos(v.pitch) + z * Math.sin(v.pitch)];
    }

    project(p) {
      const v = this.view, q = this.rot(p), s = v.scale * v.zoom;
      return [this.w / 2 + v.panX + q[0] * s, this.h / 2 + v.panY - q[1] * s];
    }

    fit() {
      const b = this.data.bbox;
      const v = this.view;
      if (!b) { v.target = [BED / 2, BED / 2, 0]; v.scale = Math.min(this.w, this.h) / (BED * 1.1); }
      else {
        v.target = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
        // Measure the box's extent in the current orientation.
        let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
        for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
          const q = this.rot([x, y, z]);
          lo = [Math.min(lo[0], q[0]), Math.min(lo[1], q[1])];
          hi = [Math.max(hi[0], q[0]), Math.max(hi[1], q[1])];
        }
        const ext = [Math.max(hi[0] - lo[0], 1), Math.max(hi[1] - lo[1], 1)];
        v.scale = 0.85 * Math.min((this.w || 1) / ext[0], (this.h || 1) / ext[1]);
      }
      v.zoom = 1; v.panX = 0; v.panY = 0;
      this.draw();
    }

    setOrientation(yaw, pitch) {
      this.view.yaw = yaw; this.view.pitch = pitch;
      this.fit();
    }

    // ---- interaction ----

    bindMouse() {
      const c = this.canvas;
      let drag = null;
      c.addEventListener("contextmenu", (ev) => ev.preventDefault());
      c.addEventListener("mousedown", (ev) => {
        drag = { x: ev.clientX, y: ev.clientY, pan: ev.button === 2 || ev.button === 1 || ev.shiftKey };
        ev.preventDefault();
      });
      window.addEventListener("mouseup", () => { drag = null; });
      window.addEventListener("mousemove", (ev) => {
        if (!drag) return;
        const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        drag.x = ev.clientX; drag.y = ev.clientY;
        const v = this.view;
        if (drag.pan) { v.panX += dx; v.panY += dy; }
        else {
          v.yaw += dx * 0.01;
          // dragging up tilts the bed away (from the top view, up is the only way to go)
          v.pitch = Math.min(Math.PI / 2, Math.max(0, v.pitch - dy * 0.01));
        }
        this.draw();
      });
      c.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        const v = this.view;
        const r = c.getBoundingClientRect();
        const mx = ev.clientX - r.left - this.w / 2 - v.panX, my = ev.clientY - r.top - this.h / 2 - v.panY;
        const f = Math.exp(-ev.deltaY * 0.0015);
        v.zoom *= f;
        // keep the point under the cursor fixed
        v.panX -= mx * (f - 1); v.panY -= my * (f - 1);
        this.draw();
      }, { passive: false });
    }

    bindControls() {
      const b = this.buttons;
      b.top.addEventListener("click", () => this.setOrientation(0, 0));
      b.iso.addEventListener("click", () => this.setOrientation(-Math.PI / 6, Math.PI / 3.2));
      b.fit.addEventListener("click", () => this.fit());
      b.travel.addEventListener("click", () => {
        this.showTravel = !this.showTravel;
        b.travel.classList.toggle("active", this.showTravel);
        this.draw();
      });
      b.travel.classList.toggle("active", this.showTravel);
      b.play.addEventListener("click", () => (this.playTimer ? this.stop() : this.play()));
      this.slider.addEventListener("input", () => {
        this.stop();
        this.shown = +this.slider.value;
        this.updateLabel();
        this.draw();
      });
    }

    play() {
      const n = this.data.segs.length;
      if (!n) return;
      if (this.shown >= n) this.shown = 0;
      const step = Math.max(1, Math.round(n / 400));
      this.buttons.play.textContent = "pause";
      this.playTimer = setInterval(() => {
        this.shown = Math.min(n, this.shown + step);
        this.slider.value = this.shown;
        this.updateLabel();
        this.draw();
        if (this.shown >= n) this.stop();
      }, 30);
    }

    stop() {
      clearInterval(this.playTimer);
      this.playTimer = null;
      this.buttons.play.textContent = "play";
    }

    /** Show the path up to and including G-code line `li` (0-based). */
    jumpToLine(li) {
      const segs = this.data.segs;
      let n = 0;
      while (n < segs.length && segs[n].line <= li) n++;
      this.stop();
      this.shown = n;
      this.slider.value = n;
      this.updateLabel();
      this.draw();
    }

    updateLabel() {
      const segs = this.data.segs;
      if (!segs.length) { this.label.textContent = "no moves"; return; }
      if (this.shown >= segs.length) { this.label.textContent = `${segs.length} moves`; return; }
      const s = segs[Math.max(0, this.shown - 1)];
      this.label.textContent = `line ${s.line + 1}: ${this.data.lines[s.line].trim()}`;
    }

    // ---- drawing ----

    draw() {
      const ctx = this.ctx;
      if (!this.w) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = "#FAFAFA";
      ctx.fillRect(0, 0, this.w, this.h);

      // bed + grid
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#E6E6E6";
      ctx.beginPath();
      for (let g = 0; g <= BED; g += GRID) {
        this.line(ctx, [g, 0, 0], [g, BED, 0]);
        this.line(ctx, [0, g, 0], [BED, g, 0]);
      }
      ctx.stroke();
      ctx.strokeStyle = "#999";
      ctx.beginPath();
      this.line(ctx, [0, 0, 0], [BED, 0, 0]); this.line(ctx, [BED, 0, 0], [BED, BED, 0]);
      this.line(ctx, [BED, BED, 0], [0, BED, 0]); this.line(ctx, [0, BED, 0], [0, 0, 0]);
      ctx.stroke();
      // axis hints at the origin
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#d33"; ctx.beginPath(); this.line(ctx, [0, 0, 0], [20, 0, 0]); ctx.stroke();
      ctx.strokeStyle = "#3a3"; ctx.beginPath(); this.line(ctx, [0, 0, 0], [0, 20, 0]); ctx.stroke();
      ctx.strokeStyle = "#36c"; ctx.beginPath(); this.line(ctx, [0, 0, 0], [0, 0, 20]); ctx.stroke();

      const segs = this.data.segs, n = this.shown;
      const batch = (from, to, extrude, style, width, dash) => {
        ctx.strokeStyle = style; ctx.lineWidth = width; ctx.setLineDash(dash);
        ctx.beginPath();
        for (let i = from; i < to; i++) {
          const s = segs[i];
          if (s.extrude === extrude) this.line(ctx, s.a, s.b);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      };
      // not yet reached by the scrubber: faint
      if (n < segs.length) {
        batch(n, segs.length, true, "rgba(30,60,140,0.12)", 1.2, []);
      }
      if (this.showTravel) batch(0, n, false, "rgba(220,60,60,0.55)", 0.8, [3, 3]);
      batch(0, n, true, "#1E3C8C", 1.6, []);

      // tool position
      if (n > 0 && n < segs.length) {
        const [x, y] = this.project(segs[n - 1].b);
        ctx.fillStyle = "#f80";
        ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill();
      }
    }

    line(ctx, a, b) {
      const p = this.project(a), q = this.project(b);
      ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
    }
  }

  const $ = (s) => document.querySelector(s);
  window.gcodeViewer = new GcodeViewer({
    canvas: $("#pg-toolpath-canvas"),
    textarea: $("#raw-gcode-textarea"),
    slider: $("#pg-toolpath-slider"),
    label: $("#pg-toolpath-label"),
    buttons: {
      top: $("#pg-toolpath-top"), iso: $("#pg-toolpath-iso"), fit: $("#pg-toolpath-fit"),
      travel: $("#pg-toolpath-travel"), play: $("#pg-toolpath-play"),
    },
  });
  window.gcodeViewer.setGcode($("#raw-gcode-textarea").value);
})();
