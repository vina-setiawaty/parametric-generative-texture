// Golden G-code regression test for texture_functions-with-tool.js.
//
//   node tests/golden-brushes.mjs           # compare against golden/
//   node tests/golden-brushes.mjs --update  # (re)write golden/ files
//
// Every line style, every stamp, rect + polygon hatch fills and DIAMOND are
// emitted for a fixed set of paths/options. The output must stay byte-
// identical across the two-point (brush/stamp/pattern) refactor -- the
// golden files were written by the pre-refactor library. Also hosts the two
// library self-tests that used to run in the browser on every regen
// (checkerboard adjacency, net-extrusion tripwire).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TF = await import("../docs/texture_functions-with-tool.js");
const GOLDEN_DIR = join(here, "golden");
const update = process.argv.includes("--update");

// ---------------------------------------------------------------- fixtures --

const PATHS = {
  straight: { x: (t) => 40 + t, y: () => 110, tEnd: 60 },
  arc: { x: (t) => 110 + 30 * Math.cos(t), y: (t) => 110 + 30 * Math.sin(t), tEnd: Math.PI },
  wave: { x: (t) => 40 + t, y: (t) => 110 + 3 * Math.sin(t / 4), tEnd: 80 },
};

// Post-refactor names (brush*/stamp*) with the pre-refactor name each one
// must reproduce byte-for-byte. Golden files are keyed by the OLD name.
const LINE_CASES = [
  ["freeformSolid", "brushSolid", {}], ["freeformSolid", "brushSolid", { width: 0.8, nLayers: 3, speed: 300 }],
  ["freeformDashed", "brushDashed", { segLen: 8, gapLen: 4 }], ["freeformDashed", "brushDashed", { segLen: 5, gapLen: 3, width: 0.6 }],
  ["freeformDotted", "brushDotted", {}], ["freeformDotted", "brushDotted", { gap: 6, dotRadius: 1.2 }],
  ["freeformBlobDotted", "brushBlobDotted", {}], ["freeformBlobDotted", "brushBlobDotted", { gap: 8, diameter: 2.2, orbitRadius: 0 }],
  ["freeformDirectionalBlobDotted", "brushDirectionalBlobDotted", {}], ["freeformDirectionalBlobDotted", "brushDirectionalBlobDotted", { gap: 5, azimuthDeg: 45, stampOrder: "forward" }],
  ["freeformHairy", "brushHairy", {}], ["freeformHairy", "brushHairy", { spacing: 7, bigLift: 3 }],
  ["freeformHairyDotted", "brushHairyDotted", { hairLength: 3 }], ["freeformHairyDotted", "brushHairyDotted", { gap: 12, hairDirection: "right", hairLength: 4 }],
  ["freeformSegmented", "brushSegmented", {}], ["freeformSegmented", "brushSegmented", { thinLen: 6, fatLen: 3 }],
  ["freeformVariableThickness", "brushVariableThickness", {}], ["freeformVariableThickness", "brushVariableThickness", { hMax: 0.6, wavelength: 12 }],
];

const DOT_CASES = [
  ["blobDot", "stampBlob", {}], ["blobDot", "stampBlob", { diameter: 2.5, orbitRadius: 0 }],
  ["circularDot", "stampDisc", {}], ["circularDot", "stampDisc", { diameter: 3, height: 0.8 }],
  ["directionalBlobDot", "stampDirectionalBlob", {}], ["directionalBlobDot", "stampDirectionalBlob", { azimuthDeg: 90 }],
  ["hairyDot", "stampHairy", { hairLength: 3 }], ["hairyDot", "stampHairy", { hairLength: 4, hairDirection: "left" }],
];

const RECT = { x0: 60, y0: 60, w: 40, h: 30 };
const POLYGON = (() => {
  const pts = [];
  for (let i = 0; i < 64; i++) {
    const a = (2 * Math.PI * i) / 64;
    pts.push([110 + 25 * Math.cos(a), 110 + 18 * Math.sin(a)]);
  }
  return pts;
})();

const FILL_CASES = [
  ["rect", "freeformSolid", "brushSolid", { gap: 4 }], ["rect", "freeformSolid", "brushSolid", { gap: 0.45, angleDeg: 90 }],
  ["rect", "freeformDashed", "brushDashed", { gap: 5, segLen: 6, gapLen: 3, angleDeg: 45 }],
  ["rect", "freeformDotted", "brushDotted", { gap: 6 }], ["rect", "freeformBlobDotted", "brushBlobDotted", { gap: 8, angleDeg: 30 }],
  ["rect", "freeformHairy", "brushHairy", { gap: 6, spacing: 6 }],
  ["rect", "DIAMOND", null, {}], ["rect", "DIAMOND", null, { diag: 6, fillGap: 0.5 }],
  ["poly", "freeformSolid", "brushSolid", { gap: 4, angleDeg: 20 }], ["poly", "freeformBlobDotted", "brushBlobDotted", { gap: 8 }],
];

// ------------------------------------------------------------------ emit --

const hasNewApi = typeof TF.brushSolid === "function";

function finish(em) { em.footer(); return em.lines.join("\n") + "\n"; }
function fresh() { const em = new TF.Emitter(); em.header(); return em; }

// Old API: style(em, xFunc, yFunc, 0, tEnd, opts) with newPattern() inside.
// New API: the caller samples the path, calls newPattern() once per line
// and hands the point list to the brush.
function emitLine(oldFn, newFn, path, opts) {
  const em = fresh();
  if (hasNewApi) { em.newPattern(); TF[newFn](em, TF.samplePath(path.x, path.y, 0, path.tEnd), opts); }
  else TF[oldFn](em, path.x, path.y, 0, path.tEnd, opts);
  return finish(em);
}

function emitDot(oldFn, newFn, opts) {
  const em = fresh();
  if (hasNewApi) em.newPattern();
  TF[hasNewApi ? newFn : oldFn](em, 110, 110, opts);
  return finish(em);
}

// Old API: fill(em, region, styleFunc|DIAMOND, opts). New API: a pattern
// generator returns strokes; each stroke goes to a brush. Hatch: one
// newPattern() per stroke (the old per-stroke style call did that), strokes
// densified. DIAMOND: one newPattern() for the whole fill, sparse 2-point
// strokes, solid brush with the per-stroke width/nLayers/speed the pattern
// specifies -- exactly what the old emitStroke() loop did.
function emitFill(shape, oldStyle, newBrush, opts) {
  const em = fresh();
  const region = shape === "rect" ? RECT : POLYGON;
  let ret = null;
  if (!hasNewApi) {
    ret = TF.fill(em, region, oldStyle === "DIAMOND" ? TF.DIAMOND : TF[oldStyle], opts);
  } else if (oldStyle === "DIAMOND") {
    const d = TF.diamondStrokes(region, opts);
    em.newPattern();
    for (const s of d.strokes) TF.brushSolid(em, TF.polylineToPts(s.points, null), s.brush);
    ret = d.diamonds;
  } else {
    const { angleDeg = 0, gap = 4.0, ...brushOpts } = opts;
    for (const s of TF.hatchStrokes(region, angleDeg, gap)) { em.newPattern(); TF[newBrush](em, TF.polylineToPts(s), brushOpts); }
  }
  return { text: finish(em), ret };
}

const cases = [];
for (const [pname, path] of Object.entries(PATHS)) {
  LINE_CASES.forEach(([o, n, opts], i) => cases.push({ name: `line-${pname}-${o}-${i}`, run: () => emitLine(o, n, path, opts) }));
}
DOT_CASES.forEach(([o, n, opts], i) => cases.push({ name: `dot-${o}-${i}`, run: () => emitDot(o, n, opts) }));
FILL_CASES.forEach(([shape, o, n, opts], i) => cases.push({ name: `fill-${shape}-${o}-${i}`, run: () => emitFill(shape, o, n, opts).text }));

// ------------------------------------------------------------- self-tests --

function netExtrusionMin(text) {
  let eSum = 0, eMin = 0;
  for (const line of text.split("\n")) {
    const m = line.match(/(?:^|\s)E(-?\d+(?:\.\d+)?)/);
    if (m && /^G[01]\s/.test(line)) { eSum += parseFloat(m[1]); if (eSum < eMin) eMin = eSum; }
  }
  return eMin;
}

// ------------------------------------------------------------------- main --

let failures = 0, written = 0;
if (update) mkdirSync(GOLDEN_DIR, { recursive: true });

for (const c of cases) {
  let text;
  try { text = c.run(); }
  catch (e) { console.log(`FAIL ${c.name}: threw ${e.message}`); failures++; continue; }
  const file = join(GOLDEN_DIR, `${c.name}.gcode`);
  if (update) { writeFileSync(file, text); written++; continue; }
  if (!existsSync(file)) { console.log(`FAIL ${c.name}: no golden file (run with --update)`); failures++; continue; }
  // Normalize line endings: a Windows checkout (core.autocrlf=true) can
  // rewrite the committed LF fixtures to CRLF regardless of .gitattributes
  // until the next fresh clone, and that's a checkout artifact, not a
  // library regression -- compare content, not line-ending style.
  const golden = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  if (golden !== text) {
    const a = golden.split("\n"), b = text.split("\n");
    let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++;
    console.log(`FAIL ${c.name}: first difference at line ${k + 1}\n  golden: ${a[k]}\n  actual: ${b[k]}`);
    failures++;
  }
  const eMin = netExtrusionMin(text);
  if (eMin < -20) { console.log(`FAIL ${c.name}: net extrusion dips to ${eMin.toFixed(2)}mm`); failures++; }
}

// checkerboard adjacency on every DIAMOND fill
for (const [shape, style, , opts] of FILL_CASES) {
  if (style !== "DIAMOND") continue;
  const { ret } = emitFill(shape, style, null, opts);
  const { violations } = TF.verifyCheckerboard(ret, opts.diag || 8.0);
  if (violations !== 0) { console.log(`FAIL diamond ${JSON.stringify(opts)}: ${violations} adjacency violations`); failures++; }
}

console.log(`api: ${hasNewApi ? "brush/stamp/pattern (post-refactor)" : "freeform*/fill (pre-refactor)"}`);
if (update) console.log(`wrote ${written} golden files to ${GOLDEN_DIR}`);
else if (failures) { console.log(`${failures} failure(s) over ${cases.length} cases`); process.exit(1); }
else console.log(`ok — ${cases.length} cases byte-identical to golden`);
