// Offline tests for the scene compiler (no LLM involved):
//   node tests/compile-fixtures.mjs
// Scene -> jobs -> G-code, transform math, clipping, app-solved regions,
// the enforced limits, parameter groups, stage-output validation and merging.

import assert from "node:assert/strict";
import * as C from "../parametric-catalog-with-tool.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}

const rect = (x0, y0, w, h) => ({ points: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]] });

function barChart() {
  const s = C.defaultScene();
  s.elements = [
    { id: "el_1", label: "x axis", kind: "line", role: "axis", path: { points: [[40, 40], [120, 40]] } },
    { id: "el_2", label: "bar 1", kind: "region", role: "bar", boundary: [rect(50, 40, 15, 5)] },
    { id: "el_3", label: "bar 2", kind: "region", role: "bar", boundary: [rect(75, 40, 15, 12)] },
    { id: "el_4", label: "bar 3", kind: "region", role: "bar", boundary: [rect(100, 40, 15, 8)] },
    { id: "el_5", label: "peak", kind: "point", role: "marker", at: [82.5, 60] },
  ];
  s.textures = {
    el_1: { brush: { fn: "solid", options: {} } },
    el_2: { outline: { fn: "solid", options: {} }, fill: { fn: "solid", options: {}, pattern: { kind: "hatch", angleDeg: 0, gap: 1 } } },
    el_3: { outline: { fn: "solid", options: {} }, fill: { fn: "hairy", options: { spacing: 4 }, pattern: { kind: "hatch", angleDeg: 90, gap: 4 } } },
    el_4: { fill: { fn: "blob", options: {}, pattern: { kind: "grid", dx: 4, dy: 4 } } },
    el_5: { brush: { fn: "blob", options: {} } },
  };
  return s;
}

test("bar chart compiles, report lists bar heights in order", () => {
  const s = barChart();
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.equal(r.report.chart.bars.map((b) => b.height).join(","), "5,12,8");
  assert.equal(r.report.chart.axes.length, 1);
  const kinds = r.jobs.map((j) => `${j.elementId}:${j.slot}:${C.isPointSafe(j.fn) ? "stamp" : "brush"}`);
  assert.ok(kinds.includes("el_1:brush:brush") && kinds.includes("el_2:outline:brush") && kinds.includes("el_2:fill:brush"));
  assert.ok(r.jobs.filter((j) => j.elementId === "el_4" && C.isPointSafe(j.fn)).length > 4, "grid stamps inside bar 3");
  assert.ok(r.jobs.some((j) => j.elementId === "el_5" && C.isPointSafe(j.fn)));
  // outline before fill within the element, elements in order
  const order = r.jobs.map((j) => `${j.elementId}:${j.slot}`);
  assert.ok(order.indexOf("el_2:outline") < order.indexOf("el_2:fill"));
  const g = C.runJobs(r.jobs);
  assert.ok(g.ok, g.errors.join("; "));
  assert.ok(g.digest.lineCount > 100 && g.digest.boundsOk);
});

test("transform: scale 1.2 moves the bbox, pattern spacing scales, brush options do not", () => {
  const s = barChart();
  const base = C.compileScene(s);
  s.transform = { scale: 1.2, origin: [30, 30] };
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.equal(r.report.bbox.minX, 30);
  assert.equal(r.report.bbox.minY, 30);
  assert.equal(r.report.chart.bars[1].height, +(12 * 1.2).toFixed(2));
  const baseHatch = base.jobs.filter((j) => j.elementId === "el_2" && j.slot === "fill");
  const scaledHatch = r.jobs.filter((j) => j.elementId === "el_2" && j.slot === "fill");
  // gap scales with the region: row pitch 1 -> 1.2 (row COUNT may differ by
  // one when the last row lands exactly on the top edge)
  assert.ok(Math.abs(baseHatch.length - scaledHatch.length) <= 1, "hatch row count within one of the unscaled fill");
  assert.equal(+(scaledHatch[1].pts[0][1] - scaledHatch[0].pts[0][1]).toFixed(3), 1.2, "row pitch scaled");
  const hairy = r.jobs.find((j) => j.elementId === "el_3" && j.slot === "fill");
  assert.equal(hairy.options.spacing, 4, "brush mm untouched");
  assert.ok(r.jobs.every((j) => (j.pts || [j.at]).every((p) => p[0] >= 30 - 1e-9 && p[1] >= 30 - 1e-9)));
});

test("out of safe area is a hard error", () => {
  const s = barChart();
  s.transform = { scale: 2.5, origin: [100, 100] };
  const r = C.compileScene(s);
  assert.ok(r.errors.some((e) => /safe area/.test(e)), r.errors.join("; "));
});

test("region between two curves via ref pieces closes and fills", () => {
  const s = C.defaultScene();
  s.elements = [
    { id: "a", label: "y=x", kind: "line", role: "curve", path: { x: "40 + 60*t", y: "40 + 60*t", tEnd: 1 } },
    { id: "b", label: "y=x^2", kind: "line", role: "curve", path: { x: "40 + 60*t", y: "40 + 60*t^2", tEnd: 1 } },
    { id: "r", label: "between", kind: "region", boundary: [{ ref: "a" }, { ref: "b", reverse: true }] },
  ];
  s.textures = {
    a: { brush: { fn: "solid", options: {} } }, b: { brush: { fn: "dashed", options: {} } },
    r: { fill: { fn: "solid", options: {}, pattern: { kind: "hatch", angleDeg: 0, gap: 3 } } },
  };
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  const region = r.report.elements.find((e) => e.id === "r");
  assert.ok(region.closureGap < 0.01, `closure ${region.closureGap}`);
  assert.ok(region.area > 500 && region.area < 700, `lens area ${region.area}`);   // 60*60/6 = 600
  assert.ok(region.fill.strokes > 5);
  assert.ok(C.runJobs(r.jobs).ok);
});

test("family, curves, strokes and stamps patterns are clipped to the region", () => {
  const s = C.defaultScene();
  s.elements = [{ id: "c", label: "disc", kind: "region", boundary: [{ x: "110 + 30*cos(t)", y: "110 + 30*sin(t)", tEnd: 2 * Math.PI }] }];
  const inside = (r) => r.jobs.every((j) => (j.pts || [j.at]).every(([x, y]) => Math.hypot(x - 110, y - 110) <= 30 + 0.05));

  s.textures = { c: { fill: { fn: "solid", options: {}, pattern: { kind: "family", x: "110 + t*cos(u)", y: "110 + t*sin(u)", tEnd: 40, uEnd: 3.1, uStep: 0.4 } } } };
  let r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.ok(r.jobs.length >= 8 && inside(r), "radial family clipped");

  s.textures = { c: { fill: { fn: "solid", options: {}, pattern: { kind: "curves", curves: [{ x: "60 + t", y: "110 + 10*sin(t/5)", tEnd: 100 }] } } } };
  r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.ok(r.jobs.length === 1 && inside(r), "wavy curve clipped to one run");

  s.textures = { c: { fill: { fn: "solid", options: {}, pattern: { kind: "strokes", strokes: [[[60, 110], [160, 110]], [[110, 60], [110, 160]]] } } } };
  r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.equal(r.jobs.length, 2);
  assert.ok(inside(r));
  assert.ok(Math.abs(r.jobs[0].pts[0][0] - 80) < 0.1, "stroke clipped at the circle (sampled polygon chord)");
  assert.ok(Math.abs(r.jobs[0].pts[r.jobs[0].pts.length - 1][0] - 140) < 0.1, "stroke clipped at the vertex on the far side");

  s.textures = { c: { fill: { fn: "blob", options: {}, pattern: { kind: "stamps", points: [[110, 110], [100, 100], [200, 200]] } } } };
  r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.equal(r.jobs.length, 2, "stamp outside the region dropped");
});

test("diamond needs a rectangle; one newPattern for the whole fill", () => {
  const s = C.defaultScene();
  s.elements = [{ id: "d", label: "box", kind: "region", boundary: [rect(60, 60, 40, 30)] }];
  s.textures = { d: { fill: { fn: "solid", options: {}, pattern: { kind: "diamond", diag: 8, fillGap: 0.6 } } } };
  let r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.equal(r.jobs.filter((j) => j.newPattern).length, 1);
  assert.ok(r.jobs.every((j) => j.options.width === 0.4));
  s.elements[0].boundary = [{ x: "110 + 30*cos(t)", y: "110 + 30*sin(t)", tEnd: 2 * Math.PI }];
  r = C.compileScene(s);
  assert.ok(r.errors.some((e) => /rectangular/.test(e)));
});

test("verification: closure warning, self-intersection, brush/pattern mismatch, over-extrusion", () => {
  const s = C.defaultScene();
  s.elements = [{ id: "z", label: "bow", kind: "region", boundary: [{ points: [[40, 40], [80, 80], [80, 40], [40, 80], [40, 40]] }] }];
  let r = C.compileScene(s);
  assert.ok(r.errors.some((e) => /crosses itself/.test(e)));

  s.elements = [{ id: "o", label: "open arc", kind: "region", boundary: [{ x: "110 + 30*cos(t)", y: "110 + 30*sin(t)", tEnd: 4 }] }];
  r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /straight edge/.test(w)));

  s.textures = { o: { fill: { fn: "blob", options: {}, pattern: { kind: "hatch", gap: 4 } } } };
  r = C.compileScene(s);
  assert.ok(r.errors.some((e) => /must be a brush/.test(e)));

  s.textures = { o: { outline: { fn: "solid", options: { nLayers: 1 } } } };
  r = C.compileScene(s);
  assert.deepEqual(r.errors, [], "relief floor is guidance now, not a hard error -- see the legibility-guidance test");

  s.textures = { o: { fill: { fn: "solid", options: {}, pattern: { kind: "hatch", gap: 0.2 } } } };
  r = C.compileScene(s);
  assert.ok(r.errors.some((e) => /over-extrusion/.test(e)));
});

test("fill-on-fill overlap warns; outline around own fill does not", () => {
  const s = C.defaultScene();
  s.elements = [
    { id: "a", label: "A", kind: "region", boundary: [rect(40, 40, 30, 30)] },
    { id: "b", label: "B", kind: "region", boundary: [rect(55, 55, 30, 30)] },
  ];
  s.textures = {
    a: { outline: { fn: "solid", options: {} }, fill: { fn: "solid", options: {}, pattern: { kind: "hatch", gap: 4 } } },
    b: { fill: { fn: "solid", options: {}, pattern: { kind: "hatch", gap: 4 } } },
  };
  let r = C.compileScene(s);
  assert.ok(r.warnings.some((w) => /overlap/.test(w)));
  s.elements[1].boundary = [rect(80, 40, 30, 30)];
  r = C.compileScene(s);
  assert.ok(!r.warnings.some((w) => /overlap/.test(w)));
});




test("line group (tick marks): one element, one texture, N stroke jobs", () => {
  const s = C.defaultScene();
  const ticks = [];
  for (let x = 40; x <= 100; x += 10) ticks.push({ points: [[x, 40], [x, 43]] });
  s.elements = [
    { id: "el_1", label: "x axis", kind: "line", role: "axis", path: { points: [[40, 40], [100, 40]] } },
    { id: "el_2", label: "x-axis ticks", kind: "line", role: "tick", paths: ticks },
  ];
  s.textures = { el_1: { brush: { fn: "solid", options: {} } }, el_2: { brush: { fn: "solid", options: { width: 0.3 } } } };
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  const tickJobs = r.jobs.filter((j) => j.elementId === "el_2");
  assert.equal(tickJobs.length, ticks.length, "one brush job per tick");
  assert.ok(tickJobs.every((j) => j.fn === "solid" && j.options.width === 0.3 && j.newPattern), "same texture, each a separate stroke");
  const entry = r.report.elements.find((e) => e.id === "el_2");
  assert.equal(entry.strokeCount, ticks.length);
  assert.equal(entry.samples.length, ticks.length);
  assert.ok(C.runJobs(r.jobs).ok);

  // one texture assignment covers the WHOLE group: changing it changes
  // every tick, which is why repeated marks are one element
  s.textures.el_2.brush.options.width = 0.9;
  const r2 = C.compileScene(s);
  assert.ok(r2.jobs.filter((j) => j.elementId === "el_2").every((j) => j.options.width === 0.9), "every tick stroke picks up the one value");
});

test("point group (data markers): one element, one texture, N stamp jobs", () => {
  const s = C.defaultScene();
  const marks = [[45, 60], [55, 68], [65, 61], [75, 70]];
  s.elements = [{ id: "el_1", label: "markers", kind: "point", role: "marker", at: marks }];
  s.textures = { el_1: { brush: { fn: "blob", options: { diameter: 2 } } } };
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.equal(r.jobs.length, marks.length);
  assert.ok(r.jobs.every((j) => C.isPointSafe(j.fn) && j.fn === "blob" && j.options.diameter === 2));
  const entry = r.report.elements.find((e) => e.id === "el_1");
  assert.equal(entry.count, marks.length);
  assert.equal(entry.at.length, marks.length);
  assert.ok(C.runJobs(r.jobs).ok);
});

// Regression for a real bug: a single-point stamp job was built as a bare
// [x, y] pair. That's fine for a true TF.STAMPS function (dispatched by x,y
// directly), but the point-safe *Dotted family (blobDotted, dotted,
// directionalBlobDotted, hairyDotted) is a TF.BRUSHES function that walks
// its points via walkArcLengthStops, which reads pts[i][2] as cumulative
// arc length. A bare [x, y] made totalLength() return undefined, the walk's
// `0 <= NaN` stop condition false, and the dot silently never get emitted --
// no error anywhere, just G-code that quietly lost the fill. Fixed in
// addBrushJob() by tagging a bare single point with s=0.
test("a point-safe BRUSH (not a true stamp) at a single point still emits its dot", () => {
  const s = C.defaultScene();
  s.elements = [{ id: "el_1", label: "marker", kind: "point", role: "marker", at: [50, 50] }];
  s.textures = { el_1: { brush: { fn: "blobDotted", options: { diameter: 2 } } } };
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].pts[0].length, 3, "the point was tagged with an arc-length coordinate, not left bare");
  const run = C.runJobs(r.jobs);
  assert.ok(run.ok, run.errors.join("; "));
  assert.ok(/G4 /.test(run.gcode), "the dot's dwell command actually made it into the g-code");
});

test("a grid fill pattern with a point-safe BRUSH emits every stamp's dot", () => {
  const s = C.defaultScene();
  s.elements = [{ id: "el_1", label: "square", kind: "region", role: "other",
    boundary: [{ points: [[20, 20], [60, 20], [60, 60], [20, 60]] }] }];
  s.textures = { el_1: {
    outline: { fn: "solid", options: {} },
    fill: { fn: "blobDotted", pattern: { kind: "grid", dx: 8, dy: 8, angleDeg: 0 }, options: { diameter: 2 } },
  } };
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  const entry = r.report.elements.find((e) => e.id === "el_1");
  const fillJobs = r.jobs.filter((j) => j.slot === "fill");
  assert.equal(fillJobs.length, entry.fill.stamps, "one job per stamp the report says exist");
  assert.ok(fillJobs.length > 0);
  assert.ok(fillJobs.every((j) => j.pts[0].length === 3));
  const run = C.runJobs(r.jobs);
  assert.ok(run.ok, run.errors.join("; "));
  const dwells = (run.gcode.match(/G4 /g) || []).length;
  assert.ok(dwells >= fillJobs.length, `expected at least one dwell per dot (${fillJobs.length} dots), got ${dwells}`);
});

test("a ref cannot target a line GROUP (ambiguous which stroke)", () => {
  const s = C.defaultScene();
  s.elements = [
    { id: "g", label: "ticks", kind: "line", role: "tick", paths: [{ points: [[40, 40], [40, 43]] }, { points: [[50, 40], [50, 43]] }] },
    { id: "r", label: "bad ref", kind: "region", boundary: [{ ref: "g" }, { points: [[40, 60], [50, 60]] }] },
  ];
  const r = C.compileScene(s);
  assert.ok(r.errors.some((e) => /repeated group/.test(e)));
});

test("stage validation + merge round trip", () => {
  const s = C.defaultScene();
  const geo = C.validateStageOutput("geometry", {
    chat: "built", transform: "",
    elements: [
      { id: "el_1", label: "axis", kind: "line", role: "axis", geometry: JSON.stringify({ path: { points: [[40, 40], [100, 40]] } }) },
      { id: "", label: "bar", kind: "region", role: "bar", geometry: JSON.stringify({ boundary: [rect(50, 40, 10, 20)] }) },
      { id: "el_1", label: "dup id", kind: "point", role: "", geometry: JSON.stringify({ at: [60, 70] }) },
      { id: "", label: "ticks", kind: "line", role: "tick", geometry: JSON.stringify({ paths: [{ points: [[40, 40], [40, 43]] }, { points: [[50, 40], [50, 43]] }] }) },
    ],
  }, s);
  assert.deepEqual(geo.errors, []);
  assert.deepEqual(geo.value.elements.map((e) => e.id), ["el_1", "el_2", "el_3", "el_4"]);
  assert.deepEqual(geo.value.elements[3].paths.map((p) => p.points[0]), [[40, 40], [50, 40]]);
  C.mergeGeometry(s, geo.value);
  assert.equal(s.elements.length, 4);
  assert.deepEqual(C.elementsJson(s, ["el_4"])[0].geometry, { paths: geo.value.elements[3].paths });

  const tex = C.validateStageOutput("texture", {
    chat: "textured",
    textures: [
      { elementId: "el_1", slot: "brush", fn: "solid", pattern: "", options: "{}" },
      { elementId: "el_2", slot: "outline", fn: "dashed", pattern: "", options: "{}" },
      { elementId: "el_2", slot: "fill", fn: "hairy", pattern: JSON.stringify({ kind: "hatch", gap: 5 }), options: "{}" },
      { elementId: "el_3", slot: "brush", fn: "solid", pattern: "", options: "{}" },   // a point needs a stamp
      { elementId: "el_9", slot: "brush", fn: "solid", pattern: "", options: "{}" },   // unknown id
    ],
  }, s);
  assert.equal(tex.errors.length, 2, tex.errors.join("; "));

  const tex2 = C.validateStageOutput("texture", {
    chat: "textured",
    textures: [
      { elementId: "el_1", slot: "brush", fn: "solid", pattern: "", options: "{}" },
      { elementId: "el_2", slot: "outline", fn: "dashed", pattern: "", options: "{}" },
      // choosing a texture and choosing its numbers is one decision now
      { elementId: "el_2", slot: "fill", fn: "hairy", pattern: JSON.stringify({ kind: "hatch", gap: 5 }), options: JSON.stringify({ spacing: 5, bigLift: 3, gap: 6 }) },
      { elementId: "el_3", slot: "brush", fn: "blob", pattern: "", options: JSON.stringify({ diameter: 2 }) },
    ],
  }, s);
  assert.deepEqual(tex2.errors, []);
  C.mergeTextures(s, tex2.value);
  assert.equal(s.textures.el_2.fill.pattern.kind, "hatch");
  assert.equal(s.textures.el_2.fill.options.spacing, 5, "brush option stored");
  assert.equal(s.textures.el_2.fill.pattern.gap, 6, "a pattern field is routed to the pattern by name");
  assert.equal(s.textures.el_3.brush.options.diameter, 2);

  // an option belonging to neither space is a real error
  const bogus = C.validateStageOutput("texture", {
    chat: "", textures: [{ elementId: "el_2", slot: "fill", fn: "hairy", pattern: JSON.stringify({ kind: "hatch", gap: 5 }), options: JSON.stringify({ nonsense: 1 }) }],
  }, s);
  assert.equal(bogus.errors.length, 1);
  assert.ok(/not an option of hairy/.test(bogus.errors[0]), bogus.errors[0]);

  // the ui stage surfaces controls and sets no values -- a selection with
  // a short label each, no attribute name, no direction/weight
  const ui = C.validateStageOutput("ui", {
    chat: "surfaced",
    groups: [{
      id: "", title: "how dense the shading feels", description: "tighter rows read as darker",
      members: JSON.stringify([
        { level: "pattern", elementId: "el_2", slot: "fill", option: "gap", label: "row spacing" },
        { level: "brush", elementId: "el_2", slot: "fill", option: "spacing", label: "strand spacing" },
        { level: "graphic", option: "scale", label: "overall size" },
      ]),
    }],
  }, s);
  assert.deepEqual(ui.errors, []);
  C.mergeUi(s, ui.value);
  assert.equal(s.groups[0].id, "gr_1");
  assert.equal(s.groups[0].members.length, 3);
  assert.equal(s.groups[0].members[0].label, "row spacing", "the model's own short label is kept");
  assert.equal(s.textures.el_2.fill.pattern.gap, 6, "surfacing a control changed no value");

  // a member naming an option that does not exist on that texture is refused
  const wrong = C.validateStageOutput("ui", {
    chat: "", groups: [{ id: "", title: "density", description: "",
      members: JSON.stringify([{ level: "brush", elementId: "el_2", slot: "fill", option: "nonsense" }]) }],
  }, s);
  assert.equal(wrong.errors.length, 1);
  assert.ok(/is not a parameter of/.test(wrong.errors[0]), wrong.errors[0]);

  // no fixed attribute table left to consult -- any real option on the
  // texture is fair game, and a missing label falls back to the option name
  const noLabel = C.validateStageOutput("ui", {
    chat: "", groups: [{ id: "", title: "first-contact height", description: "",
      members: JSON.stringify([{ level: "brush", elementId: "el_2", slot: "fill", option: "baseZ" }]) }],
  }, s);
  assert.deepEqual(noLabel.errors, []);
  assert.equal(noLabel.value.groups[0].members[0].label, "baseZ", "falls back to the option name");

  // a texture change drops the controls that pointed at what is gone
  C.mergeTextures(s, { textures: [{ elementId: "el_2", slot: "fill", fn: "solid", pattern: { kind: "hatch", gap: 4 }, options: {}, patternOptions: {} }] });
  assert.ok(!s.groups.some((g) => g.members.some((m) => m.option === "spacing")), "the hairy-only control is gone");
  assert.ok(s.groups.some((g) => g.members.some((m) => m.option === "gap")), "the hatch control survives");

  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.ok(C.sceneSummary(s).includes("el_2"));
  assert.ok(C.optionSpecsText(s).includes("segLen"));
  const route = C.validateStageOutput("route", { route: "texture", instruction: "densify el_2", targets: ["el_2", "nope"], acceptance: ["el_2 reads denser", ""], reply: "" }, s);
  assert.deepEqual(route.value.targets, ["el_2"]);
  assert.deepEqual(route.value.acceptance, ["el_2 reads denser"], "blank criteria dropped");
});

test("every brush option is tagged stroke or brush level", () => {
  for (const fn of C.BRUSH_NAMES) {
    for (const [opt, spec] of Object.entries(C.optionSpecFor(fn))) {
      assert.ok(["stroke", "brush"].includes(spec.level), `${fn}.${opt} needs a stroke|brush level, got "${spec.level}"`);
    }
  }
});

test("resolveMember reports the real stroke/brush/pattern/graphic level", () => {
  const s = C.defaultScene();
  s.elements = [{ id: "l", label: "line", kind: "line", role: "curve", path: { points: [[40, 40], [100, 40]] } }];
  s.textures = { l: { brush: { fn: "solid", options: {} }, fill: undefined } };
  assert.equal(C.resolveMember(s, { elementId: "l", slot: "brush", option: "nLayers" }).level, "stroke", "nLayers owns the layer loop");
  assert.equal(C.resolveMember(s, { elementId: "l", slot: "brush", option: "width" }).level, "brush", "width is the local bead");
  assert.equal(C.resolveMember(s, { level: "graphic", option: "scale" }).level, "graphic");
});

test("normalizeScene discards old formats", () => {
  assert.equal(C.normalizeScene({ messages: [], calls: [] }).elements.length, 0);
  assert.equal(C.normalizeScene(null).version, C.SCENE_VERSION);
});

// ------------------------------------------------- app-solved regions (F) --

test("between: two curves, no range given -- the app solves the crossings", () => {
  // Same lens as the hand-written ref-boundary test above: y=x and y=x^2
  // over 60mm, area 60*60/6 = 600. Here the model names only the bounds.
  const s = C.defaultScene();
  s.elements = [
    { id: "a", label: "y=x", kind: "line", role: "curve", path: { x: "40 + 60*t", y: "40 + 60*t", tEnd: 1 } },
    { id: "b", label: "y=x^2", kind: "line", role: "curve", path: { x: "40 + 60*t", y: "40 + 60*t^2", tEnd: 1 } },
    { id: "r", label: "between", kind: "region", between: { upper: "a", lower: "b" } },
  ];
  s.textures = { r: { fill: { fn: "solid", options: {}, pattern: { kind: "hatch", angleDeg: 0, gap: 3 } } } };
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  const region = r.report.elements.find((e) => e.id === "r");
  // 594, not 600: the sampler steps 0.1 in the MODEL'S OWN t, so a curve
  // written with tEnd 1 is only ~10 chords and the polygon cuts the
  // corners. That is a property of sampling, not of solving -- the
  // hand-written boundary below lands on the same number, and at tEnd 20
  // both are exactly 600. Worth knowing when reading a report's area.
  assert.ok(Math.abs(region.area - 594) < 1, `lens area ${region.area}`);
  assert.equal(region.closureGap, 0, "closed by construction, no straight-edge guess");
  assert.deepEqual(region.solvedXRange, [40, 100]);
  assert.deepEqual(region.bounds, { upper: "a", lower: "b" });
  // These two only TOUCH, at their shared endpoints -- neither passes
  // through the other -- so there is no interior crossing to solve and the
  // span is the whole shared extent. Both ends still close exactly.
  assert.deepEqual(region.intersections, []);
  assert.ok(/shared x span/.test(region.rangeFrom));
  assert.ok(region.fill.strokes > 5);
  assert.ok(C.runJobs(r.jobs).ok);

  // identical to writing the boundary by hand, which is what it replaces
  const hand = C.defaultScene();
  hand.elements = [s.elements[0], s.elements[1], { id: "r", label: "between", kind: "region", boundary: [{ ref: "a" }, { ref: "b", reverse: true }] }];
  const handArea = C.compileScene(hand).report.elements.find((e) => e.id === "r").area;
  assert.equal(handArea, region.area, "solving adds no error of its own");

  // and with the same curves sampled finely, both reach the true 600
  const fine = C.defaultScene();
  fine.elements = [
    { id: "a", label: "y=x", kind: "line", role: "curve", path: { x: "40 + 3*t", y: "40 + 3*t", tEnd: 20 } },
    { id: "b", label: "y=x^2", kind: "line", role: "curve", path: { x: "40 + 3*t", y: "40 + 0.15*t^2", tEnd: 20 } },
    { id: "r", label: "between", kind: "region", between: { upper: "a", lower: "b" } },
  ];
  const fineArea = C.compileScene(fine).report.elements.find((e) => e.id === "r").area;
  assert.ok(Math.abs(fineArea - 600) < 0.05, `finely sampled area ${fineArea}, want 600`);
});

test("between: bounds that really cross -- the app solves for where", () => {
  // The docs' worked example, the case that used to be 40 lines of
  // hand-solved intersection arithmetic: a level and a parabola written
  // over a WIDER domain than the shaded part, crossing inside it.
  // (t-30)^2/10 = 30  ->  t = 30 +/- sqrt(300)  ->  x = 52.68 and 87.32
  const s = C.defaultScene();
  s.elements = [
    { id: "lv", label: "y=70", kind: "line", role: "curve", path: { points: [[40, 70], [100, 70]] } },
    { id: "pa", label: "parabola", kind: "line", role: "curve", path: { x: "40 + t", y: "40 + (t - 30)^2/10", tEnd: 60 } },
    { id: "r", label: "shaded", kind: "region", between: { upper: "lv", lower: "pa" } },
  ];
  s.textures = { r: { fill: { fn: "solid", options: {}, pattern: { kind: "hatch", gap: 3 } } } };
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  const region = r.report.elements.find((e) => e.id === "r");
  assert.equal(region.intersections.length, 2, "both crossings found");
  assert.ok(Math.abs(region.solvedXRange[0] - 52.68) < 0.2, `x0 ${region.solvedXRange[0]}`);
  assert.ok(Math.abs(region.solvedXRange[1] - 87.32) < 0.2, `x1 ${region.solvedXRange[1]}`);
  assert.ok(/crossings/.test(region.rangeFrom));
  assert.equal(region.closureGap, 0);
  // exact area between the two: (4/3)*half-width*height = (4/3)*17.32*30
  assert.ok(Math.abs(region.area - 692.8) < 4, `area ${region.area}`);
  // the shading stays inside the lens, not the curves' full 60mm domain
  assert.ok(region.bbox.minX > 52 && region.bbox.maxX < 88, JSON.stringify(region.bbox));
  assert.ok(C.runJobs(r.jobs).ok);
});

test("between: a curve down to an axis, and to a bare y level", () => {
  const s = C.defaultScene();
  s.elements = [
    // a hill that never touches the axis: the bounds never cross, so the
    // span is everything they share in x
    { id: "ax", label: "x axis", kind: "line", role: "axis", path: { points: [[40, 40], [140, 40]] } },
    { id: "c", label: "hill", kind: "line", role: "curve", path: { x: "60 + 40*t", y: "60 + 10*t", tEnd: 1 } },
    { id: "r", label: "under the hill", kind: "region", between: { upper: "c", lower: "ax" } },
  ];
  s.textures = { r: { fill: { fn: "solid", options: {}, pattern: { kind: "hatch", gap: 4 } } } };
  let r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  let region = r.report.elements.find((e) => e.id === "r");
  assert.deepEqual(region.solvedXRange, [60, 100], "clipped to the curve's span, not the whole axis");
  assert.deepEqual(region.intersections, []);
  assert.ok(/shared x span/.test(region.rangeFrom));
  // trapezoid: width 40, heights 20 and 30 -> 1000
  assert.ok(Math.abs(region.area - 1000) < 5, `area ${region.area}`);

  // an explicit range narrows it, cutting the axis exactly where asked
  s.elements[2].between = { upper: "c", lower: "ax", xFrom: 70, xTo: 90 };
  region = C.compileScene(s).report.elements.find((e) => e.id === "r");
  assert.deepEqual(region.solvedXRange, [70, 90]);
  assert.ok(Math.abs(region.area - 500) < 5, `area ${region.area}`);

  // a bare level works the same and spans the curve's own extent
  s.elements[2].between = { upper: "c", lower: { y: 50 } };
  region = C.compileScene(s).report.elements.find((e) => e.id === "r");
  assert.deepEqual(region.solvedXRange, [60, 100]);
  assert.deepEqual(region.bounds, { upper: "c", lower: "y=50" });
  assert.ok(Math.abs(region.area - 600) < 5, `area ${region.area}`);
});

test("between: the cases that used to produce silently wrong shading are errors", () => {
  const s = C.defaultScene();
  s.elements = [
    { id: "a", label: "left", kind: "line", role: "curve", path: { points: [[40, 60], [60, 60]] } },
    { id: "b", label: "right", kind: "line", role: "curve", path: { points: [[80, 50], [100, 50]] } },
    { id: "r", label: "nothing between", kind: "region", between: { upper: "a", lower: "b" } },
  ];
  assert.ok(C.compileScene(s).errors.some((e) => /never share an x range/.test(e)), "disjoint bounds");

  // one crossing: the bounds swap sides, so "between" is two pieces
  s.elements = [
    { id: "a", label: "rising", kind: "line", role: "curve", path: { points: [[40, 40], [100, 100]] } },
    { id: "b", label: "falling", kind: "line", role: "curve", path: { points: [[40, 100], [100, 40]] } },
    { id: "r", label: "X", kind: "region", between: { upper: "a", lower: "b" } },
  ];
  assert.ok(C.compileScene(s).errors.some((e) => /cross once/.test(e)), "single crossing is ambiguous");
  // ...and an explicit range resolves it
  s.elements[2].between = { upper: "a", lower: "b", xFrom: 75, xTo: 100 };
  assert.deepEqual(C.compileScene(s).errors, []);

  // a bound that doubles back in x is not a function of x
  s.elements = [
    { id: "a", label: "circle", kind: "line", role: "curve", path: { x: "110 + 30*cos(t)", y: "110 + 30*sin(t)", tEnd: 6.283 } },
    { id: "r", label: "bad", kind: "region", between: { upper: "a", lower: { y: 80 } } },
  ];
  assert.ok(C.compileScene(s).errors.some((e) => /doubles back in x/.test(e)));
});

test("a ref piece can be cut by x, on a formula path and a point list alike", () => {
  const s = C.defaultScene();
  s.elements = [
    // a points-path axis: tFrom/tTo never worked on one of these
    { id: "ax", label: "axis", kind: "line", role: "axis", path: { points: [[40, 40], [140, 40]] } },
    { id: "c", label: "curve", kind: "line", role: "curve", path: { x: "40 + 100*t", y: "80", tEnd: 1 } },
    { id: "r", label: "box", kind: "region", boundary: [{ ref: "c", xFrom: 60, xTo: 90 }, { ref: "ax", xFrom: 60, xTo: 90, reverse: true }] },
  ];
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  const region = r.report.elements.find((e) => e.id === "r");
  assert.deepEqual(region.bbox, { minX: 60, minY: 40, maxX: 90, maxY: 80 });
  assert.ok(Math.abs(region.area - 30 * 40) < 1, `area ${region.area}`);

  // asking for x outside the path's own extent says what the extent is
  s.elements[2].boundary[0] = { ref: "c", xFrom: 300, xTo: 400 };
  assert.ok(C.compileScene(s).errors.some((e) => /nothing of this path lies between x 300 and x 400/.test(e) && /40\.0\.\.140\.0/.test(e)));
});

test("a boundary closed by a straight edge always warns, point lists included", () => {
  const s = C.defaultScene();
  // three sides of a rectangle, hand-written: the fourth is invented by the
  // compiler and used to be silent for a point list
  s.elements = [{ id: "u", label: "open box", kind: "region", boundary: [{ points: [[40, 40], [80, 40], [80, 70]] }] }];
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /closed with a straight edge/.test(w)), r.warnings.join("; "));
});

// ------------------------------------------------- guardrails / constraints --

test("an out-of-range option value is rejected, not stored", () => {
  const s = C.defaultScene();
  s.elements = [{ id: "b", label: "bar", kind: "region", boundary: [rect(40, 40, 20, 20)] }];
  const tex = (options) => ({ chat: "", textures: [{ elementId: "b", slot: "fill", fn: "solid", pattern: JSON.stringify({ kind: "hatch", angleDeg: 0, gap: 4 }), options: JSON.stringify(options) }] });

  // hatch gap's range is 0.3..20; 100 would silently produce a fill with a
  // single stroke (or none) in a 20mm bar.
  const bad = C.validateStageOutput("texture", tex({ gap: 100, width: 0.5 }), s);
  assert.equal(bad.errors.length, 1, bad.errors.join("; "));
  assert.ok(/within 0\.3\.\.20/.test(bad.errors[0]), bad.errors[0]);
  assert.deepEqual(bad.value.textures[0].patternOptions, {}, "the bad value is not stored");
  assert.deepEqual(bad.value.textures[0].options, { width: 0.5 }, "the good value alongside it still is");

  // the boundary values themselves are in range
  const edge = C.validateStageOutput("texture", tex({ gap: 20 }), s);
  assert.deepEqual(edge.errors, []);
  assert.equal(edge.value.textures[0].patternOptions.gap, 20);

  // an int option rounds first, then range-checks
  const low = C.validateStageOutput("texture", tex({ nLayers: 0 }), s);
  assert.equal(low.errors.length, 1);
  assert.ok(/within 1\.\.10/.test(low.errors[0]), low.errors[0]);

  // an empty or null value means "leave it alone", not "store a blank"
  const blank = C.validateStageOutput("texture", tex({ width: "", nLayers: null, speed: "400", gap: "" }), s);
  assert.deepEqual(blank.errors, []);
  assert.deepEqual(blank.value.textures[0].options, { speed: 400 }, "empty keys omitted; a numeric string coerces");
  assert.deepEqual(blank.value.textures[0].patternOptions, {});
  const garbage = C.validateStageOutput("texture", tex({ width: "wide", gap: "loose" }), s);
  assert.equal(garbage.errors.length, 2, "non-numeric garbage is a real error, not silently dropped");
  assert.ok(garbage.errors.every((e) => /must be a number/.test(e)));
});

test("diamond fillGap below the over-extrusion floor is a hard error", () => {
  const s = C.defaultScene();
  s.elements = [{ id: "d", label: "box", kind: "region", boundary: [rect(60, 60, 40, 30)] }];
  s.textures = { d: { fill: { fn: "solid", options: {}, pattern: { kind: "diamond", diag: 8, fillGap: 0.2 } } } };
  let r = C.compileScene(s);
  assert.ok(r.errors.some((e) => /diamond fillGap .* over-extrusion/.test(e)), r.errors.join("; "));

  // a valid diamond fill is clean, and its checkerboard parity verifies --
  // the verifier is wired into compileScene and must not false-alarm
  s.textures.d.fill.pattern.fillGap = 0.6;
  r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.ok(!r.errors.some((e) => /checkerboard/.test(e)));

  // fillGap is in graphic units: scaling the graphic down scales it below
  // the floor even though the written number is unchanged
  s.transform = { scale: 0.4, origin: [40, 40] };
  r = C.compileScene(s);
  assert.ok(r.errors.some((e) => /diamond fillGap .* over-extrusion/.test(e)), "scaled fillGap 0.24mm is checked in bed mm");
});

test("net extrusion dipping far negative is a hard error", () => {
  const clean = C.scanGcode(["G90", "G1 X20 Y20 E1", "G1 X30 Y20 E1", "G1 E-1.3"]);
  assert.equal(clean.retractCycles, 1);
  assert.equal(clean.negTrip, false);
  assert.ok(Math.abs(clean.eSum - 0.7) < 1e-9);

  const buggy = C.scanGcode(["G90", ...Array.from({ length: 20 }, () => "G1 X20 Y20 E-1.3")]);
  assert.equal(buggy.negTrip, true, `eMin ${buggy.eMin}`);
  assert.ok(buggy.eMin < -20);
});

test("a stroke printed over another element's fill warns; its own outline does not", () => {
  const s = C.defaultScene();
  s.elements = [
    { id: "a", label: "shaded area", kind: "region", boundary: [rect(40, 40, 40, 40)] },
    { id: "c", label: "curve across it", kind: "line", role: "curve", path: { points: [[45, 60], [75, 60]] } },
    { id: "m", label: "marker inside", kind: "point", role: "marker", at: [60, 50] },
  ];
  s.textures = {
    a: { outline: { fn: "solid", options: {} }, fill: { fn: "solid", options: {}, pattern: { kind: "hatch", gap: 4 } } },
    c: { brush: { fn: "solid", options: {} } },
    m: { brush: { fn: "blob", options: {} } },
  };
  let r = C.compileScene(s);
  assert.ok(r.warnings.some((w) => /"curve across it" prints over the fill of "shaded area"/.test(w)), r.warnings.join("; "));
  assert.ok(r.warnings.some((w) => /"marker inside" prints over the fill of "shaded area"/.test(w)));
  assert.ok(!r.warnings.some((w) => /"shaded area" prints over the fill of "shaded area"/.test(w)), "a region's own outline is expected, not a collision");

  // moved clear of the region, nothing is flagged
  s.elements[1].path = { points: [[100, 60], [130, 60]] };
  s.elements[2].at = [110, 50];
  r = C.compileScene(s);
  assert.ok(!r.warnings.some((w) => /prints over the fill/.test(w)), r.warnings.join("; "));
});

test("legibility limits are guidance only until enforced is flipped", () => {
  const s = C.defaultScene();
  // gap 40mm on a 1.6mm dome: 25x the diameter, far past "reads as a line"
  s.elements = [{ id: "l", label: "dotty", kind: "line", role: "curve", path: { points: [[40, 40], [160, 40]] } }];
  s.textures = { l: { brush: { fn: "blobDotted", options: { gap: 40, diameter: 1.6 } } } };

  let r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.ok(!r.warnings.some((w) => /scattered dots/.test(w)), "not enforced by default -- the numbers are untested");
  assert.equal(C.LEGIBILITY_GUIDE.enforced, false);

  C.LEGIBILITY_GUIDE.enforced = true;
  try {
    r = C.compileScene(s);
    assert.deepEqual(r.errors, [], "legibility never blocks, even when enforced");
    assert.ok(r.warnings.some((w) => /scattered dots/.test(w)), r.warnings.join("; "));

    // relief-floor rules (nLayers / dome diameter / disc height) moved out
    // of PRINT_LIMITS into LEGIBILITY_GUIDE: guidance-only by default, and
    // still only a warning -- never an error -- once enforced.
    const thin = C.defaultScene();
    thin.elements = [{ id: "o", label: "box", kind: "region", boundary: [rect(40, 40, 30, 30)] }];
    thin.textures = { o: { outline: { fn: "solid", options: { nLayers: 1 } } } };
    let rt = C.compileScene(thin);
    assert.deepEqual(rt.errors, []);
    assert.ok(rt.warnings.some((w) => /relief-floor guidance/.test(w)), rt.warnings.join("; "));

    // the fill-row-gap rule reads the pattern, and knows a dotted row from
    // a continuous one (12mm vs 8mm)
    const f = C.defaultScene();
    f.elements = [{ id: "p", label: "patch", kind: "region", boundary: [rect(40, 40, 60, 60)] }];
    f.textures = { p: { fill: { fn: "solid", options: {}, pattern: { kind: "hatch", gap: 10 } } } };
    assert.ok(C.compileScene(f).warnings.some((w) => /reads as separate rows/.test(w)), "10mm rows of solid are past the 8mm shade limit");
    f.textures.p.fill.fn = "blobDotted";
    assert.ok(!C.compileScene(f).warnings.some((w) => /reads as separate rows/.test(w)), "10mm rows of dots are inside the 12mm limit");
  } finally {
    C.LEGIBILITY_GUIDE.enforced = false;
  }
});

test("the prompt's limit text is generated from the limit objects", () => {
  const limits = C.limitsText();
  for (const [key, rule] of Object.entries(C.PRINT_LIMITS)) {
    if (rule.internal) continue;
    assert.ok(limits.includes(String(rule.value)), `${key}'s value ${rule.value} is missing from limitsText()`);
    assert.ok(limits.includes(rule.applies), `${key}'s description is missing from limitsText()`);
  }
  assert.ok(limits.includes("15-205"), "the safe area comes from GEOMETRY_LIMITS");
  assert.ok(!limits.includes("running sum of E deltas"), "internal rules are not addressed to the model");
  assert.ok(/placeholder/i.test(limits), "the text says the numbers are unconfirmed");

  const leg = C.legibilityText();
  for (const rule of Object.values(C.LEGIBILITY_GUIDE.rules)) assert.ok(leg.includes(rule.applies), `${rule.applies} missing from legibilityText()`);
  assert.ok(/NOT enforced/.test(leg) && /not yet hardware-tested/.test(leg), "the text says these are guidance, not rules");

  // the flat view every check reads stays in step with the structured one
  assert.equal(C.CONSTRAINTS.minSolidSheetGap, C.PRINT_LIMITS.minSolidSheetGap.value);
  assert.equal(C.CONSTRAINTS.safeMax, C.GEOMETRY_LIMITS.safeMax.value);
});

console.log(`${passed} passed${process.exitCode ? ", with failures" : ""}`);
