// Scene compiler for parametric-with-tool.html (ES module; also imported by
// tests/*.mjs under node).
//
// The page holds a SCENE (see defaultScene()): elements with ids (a line
// path, a closed region boundary, or a point), a texture per element slot
// (brush + options, plus a fill pattern for regions), a global transform
// (scale + origin) and a list of parameter GROUPS -- an ad hoc selection
// of real options the ui stage judged relevant to the current turn, each
// with its own short label, no weighting or transform of anyone's values.
// Four LLM stages write into that scene; everything below the LLMs is
// deterministic:
//
//   resolveScene()   pieces -> vertex lists in graphic space, closure and
//                    simple-polygon checks, natural bbox
//   compileScene()   transform, pattern -> strokes/stamps clipped to the
//                    region, one JOB per brush call, hard/warn checks,
//                    geometry REPORT (the model verifies against this)
//   runJobs()        jobs -> G-code via texture_functions-with-tool.js's
//                    BRUSHES / STAMPS, bounds + retraction scan, digest
//   resolveMember()                         parameter groups
//   validateStageOutput() / merge*()       stage JSON -> scene
//
// A model-supplied formula string is NEVER eval()'d or passed to
// `new Function()` -- see compileExpr(): a small hand-rolled tokenizer +
// recursive-descent parser + AST evaluator with a closed whitelist of
// operators/functions. There is no code path from a formula string to any
// JS object, global, or property access outside that grammar.

import * as TF from "./docs/texture_functions-with-tool.js";

// 3: parameter "abstractions" (weighted knobs) became "groups" (a heading
// over the parameters that affect one attribute). An older stored scene is
// discarded by normalizeScene rather than migrated -- the knob values had
// no meaning under the new model.
export const SCENE_VERSION = 3;

// ------------------------------------------------------------ constraints --
//
// Three groups, kept separate because they answer different questions and
// have different provenance:
//
//   PRINT_LIMITS     physical -- what the printer and the filament can do.
//                    Violating one damages the print or the machine.
//   GEOMETRY_LIMITS  the coordinate system and shape rules the compiler
//                    itself needs (bed size, safe area, closure snap).
//   LEGIBILITY_GUIDE tactile perception -- past these a "line" stops
//                    reading as a line and a "fill" as a filled area.
//                    NONE of these have been tested on hardware, so they
//                    are NOT enforced: they reach the model as prompt
//                    guidance only. Flip `enforced` once the numbers are
//                    confirmed and they become warnings in the rule checks.
//
// Every PRINT_LIMITS value is still a PLACEHOLDER guessed from the library
// defaults and the TPU cautions -- docs/PARAMETER_CONSTRAINTS.md is the
// fill-in form generated from these objects. Flip a row's `status` to
// "confirmed" here once a print confirms it; the form and the prompt text
// both follow automatically.

const hard = (value, applies, note = "", extra = {}) => ({ value, kind: "hard", status: "placeholder", applies, note, ...extra });
const warn = (value, applies, note = "", extra = {}) => ({ value, kind: "warn", status: "placeholder", applies, note, ...extra });

export const PRINT_LIMITS = {
  zGapFloor: hard(0.25, "variableThickness zGap", "user-validated; lower prints flat"),
  minSolidSheetGap: hard(0.35, "hatch gap with the solid brush, and diamond fillGap", "below this is severe over-extrusion"),
  retractCyclesHard: hard(2000, "retraction cycles in one job", "TPU drive-gear damage; deliberately high -- a diamond fill alone does hundreds of small in-place retracts"),
  netExtrusionTrip: hard(-20, "running sum of E deltas across the job", "a dip this far negative is a retraction-math bug in a brush, not a real move", { internal: true }),
  minBeadWidth: warn(0.4, "width / beadWidth / thinWidth", "about one nozzle width"),
  blobDottedGapOverDiameter: warn(1.0, "blobDotted gap, required as gap >= diameter + this", "closer and adjacent domes fuse into a ridge"),
  hairyDottedGapOverRoot: warn(2.0, "hairyDotted gap, required as gap >= rootDiameter + this"),
  minDottedGapOverDot: warn(1.0, "dotted gap, required as gap >= 2*dotRadius + this"),
  minHairSpacing: warn(2.5, "hairy strand spacing", "closer and strands fuse"),
  minHairyFillRowGap: warn(4.0, "hatch gap with the hairy brush", "closer and the hair rows fuse"),
  retractCyclesWarn: warn(250, "retraction cycles in one job", "TPU can flat-spot at the drive gear; the count is surfaced to the user"),
};

export const GEOMETRY_LIMITS = {
  bed: { value: 220, applies: "bed size in mm, both axes", note: "absolute bound on any emitted coordinate" },
  safeMin: { value: 15, applies: "minimum X/Y for every printed coordinate", note: "margin the prime line and the bed clips need" },
  safeMax: { value: 205, applies: "maximum X/Y for every printed coordinate", note: "" },
  closureSnapMm: { value: 0.5, applies: "a region boundary's end vs. its start", note: "within this snaps closed; a larger gap is closed with a straight edge and warned about" },
};

// Not enforced -- see the header comment. `enforced` is flipped by tests
// (and, once the numbers are confirmed, here) to route these into the rule
// checks as warnings.
export const LEGIBILITY_GUIDE = {
  enforced: false,
  status: "untested",
  rules: {
    minDomeDiameter: { value: 0.8, applies: "blob / directionalBlob dome diameter, hairy root diameter, disc diameter, 2*dotRadius", note: "below this the dome does not clear the 0.4mm relief floor -- may be hard to feel" },
    minDiscHeight: { value: 0.4, applies: "disc height", note: "two 0.2mm layers -- thinner relief may be hard to feel" },
    minLayers: { value: 2, applies: "any line brush's nLayers", note: "0.4mm relief floor -- thinner relief may be hard to feel" },
    maxDottedGapOverDiameter: { value: 4.0, applies: "dotted / blobDotted / directionalBlobDotted / hairyDotted gap, as a multiple of the dot diameter", note: "past this it reads as scattered dots, not a line" },
    maxDashGapOverSegLen: { value: 3.0, applies: "dashed gapLen, as a multiple of segLen", note: "past this it reads as isolated dashes" },
    minDashLen: { value: 2.0, applies: "dashed segLen", note: "shorter dashes are indistinct by touch" },
    minDashGap: { value: 2.0, applies: "dashed gapLen", note: "" },
    minSegmentLen: { value: 3.0, applies: "segmented thinLen / fatLen", note: "" },
    maxHairSpacing: { value: 12.0, applies: "hairy strand spacing", note: "past this the strands stop reading as one hairy line" },
    maxShadeFillGap: { value: 8.0, applies: "hatch row gap with a continuous brush", note: "past this the area no longer reads as shaded, just as spaced lines" },
    maxDottedFillRowGap: { value: 12.0, applies: "hatch row gap with a dotted or hairy brush", note: "past this it reads as separate rows, not a filled patch" },
    minDiamondDiag: { value: 4.0, applies: "diamond diag", note: "smaller cells blur together" },
  },
};

// Flat numeric view -- what every check below (and the page's "fit to safe
// area" button, via C.CONSTRAINTS) actually reads, so a number lives in
// exactly one place.
export const CONSTRAINTS = Object.fromEntries([
  ...Object.entries(PRINT_LIMITS).map(([k, r]) => [k, r.value]),
  ...Object.entries(GEOMETRY_LIMITS).map(([k, r]) => [k, r.value]),
]);

const LEG = (name) => LEGIBILITY_GUIDE.rules[name].value;

/** The enforced-limits section of a stage prompt, generated from
 * PRINT_LIMITS + GEOMETRY_LIMITS so the prompt can never drift from what
 * the code checks (it used to be hand-copied into reference-brushes.md).
 * `internal` rows are about library bugs, not model choices -- omitted. */
export function limitsText() {
  const rows = (kind) => Object.values(PRINT_LIMITS)
    .filter((r) => r.kind === kind && !r.internal)
    .map((r) => `  ${r.applies}: ${r.value}${r.note ? ` -- ${r.note}` : ""}`);
  return [
    "LIMITS THE PAGE ENFORCES (physical; every number is a placeholder pending hardware confirmation)",
    "",
    "Hard -- the page refuses to mark the job safe:",
    ...rows("hard"),
    `  every printed coordinate: inside X/Y ${CONSTRAINTS.safeMin}-${CONSTRAINTS.safeMax}`,
    "  a region boundary: simple (never self-crossing) and closed",
    "  a path: not too steep to print at any sampling resolution",
    "",
    "Warned -- surfaced to the user, not blocking:",
    ...rows("warn"),
    `  a boundary whose ends are more than ${CONSTRAINTS.closureSnapMm}mm apart: closed with a straight edge`,
    "  two elements' fills overlapping, or a stroke printed over another element's fill",
  ].join("\n");
}

/** The perceptual-guidance section. Explicitly marked as untested and
 * unenforced so the model treats it as judgement, not as a rule it can
 * point at. */
export function legibilityText() {
  return [
    "TACTILE LEGIBILITY (guidance, NOT enforced -- these numbers are not yet hardware-tested)",
    "",
    ...Object.values(LEGIBILITY_GUIDE.rules).map((r) => `  ${r.applies}: ${r.value}${r.note ? ` -- ${r.note}` : ""}`),
    "",
    "Pick textures that feel DISTINCT by touch when they encode different",
    "meanings (a ridge vs. dots vs. hair), not merely different to look at.",
  ].join("\n");
}

// ---------------------------------------------------------------- options --

// kind: "num" | "int" | "nnum" (nullable number) | "enum". min/max are the
// range a value must sit inside, and the span the UI input uses. `level`
// (added by the S()/B() wrappers below) says which half of the
// Shape->Stroke->Brush split an option belongs to: "stroke" (the walk --
// layer/pass count, arc-length spacing, priming/retract brackets, inter-
// stop travel speed) or "brush" (the local deposit -- width, per-call
// height, local speed, the local mechanism's own timing). Assigned by
// hand against texture_functions-with-tool.js's actual Stroke/Brush split,
// not derived automatically.
const N = (def, min, max, step) => ({ kind: "num", def, min, max, step: step ?? 0.1 });
const I = (def, min, max) => ({ kind: "int", def, min, max, step: 1 });
const NN = (def) => ({ kind: "nnum", def });
const EN = (def, options) => ({ kind: "enum", def, options });
const S = (spec) => ({ ...spec, level: "stroke" });
const B = (spec) => ({ ...spec, level: "brush" });

// Always brush-level in every brush that uses them: each is the local
// dome/hair mechanism's own volume, timing or anti-string behavior, never
// something a Stroke's walk decides.
const BLOB_BUILD_OPTS = {
  baseZ: B(N(0.2, 0.1, 0.6)), buildSteps: B(I(6, 1, 20)), taperFactor: B(N(0.7, 0, 1)),
  extrudeSpeed: B(N(120, 20, 600, 5)), dwellMs: B(I(2000, 0, 8000)),
  extrusionMultiplier: B(N(1.3, 0.5, 3)), retractMm: B(N(4.0, 0, 8)),
  postRetractDwellMs: B(I(2000, 0, 8000)), baseExtraMm: B(N(0.3, 0, 2)),
  baseDwellMs: B(I(1000, 0, 5000)),
};
const ORBIT_OPTS = {
  orbitRadius: B(NN(null)), orbitPts: B(I(16, 3, 48)), orbitSpeed: B(N(600, 100, 2000, 10)), orbitLoops: B(I(3, 0, 10)),
};
const HAIR_OPTS = {
  hairLength: B(N(3.0, 1, 30)), hairThickness: B(NN(null)),
  hairDirection: B(EN("top", ["top", "right", "left", "bottom"])),
  hairAzimuthDeg: B(NN(null)), hairElevationDeg: B(NN(null)), beadFlowMult: B(N(3.5, 1, 6)),
  pullExtrudeSpeed: B(N(150, 30, 600, 5)), stringMm: B(N(2.0, 0, 10)), overtravelMm: B(N(2.0, 0, 10)),
};

// Every brush -- what is deposited, and how it's walked. `blob`, `disc`,
// `directionalBlob` and `hairyDot` (formerly a separate STAMP_OPTIONS
// category) are POINT_SAFE_BRUSHES below: brush-only, since a genuine
// single-point call has no Stroke wrapper around it.
export const BRUSH_OPTIONS = {
  solid: { width: B(N(0.5, 0.3, 3)), nLayers: S(I(2, 1, 10)), speed: B(N(400, 50, 1500, 10)) },
  dashed: {
    segLen: S(N(8, 1, 60)), gapLen: S(N(4, 1, 60)), width: B(N(0.5, 0.3, 3)),
    nLayers: S(I(2, 1, 10)), speed: B(N(400, 50, 1500, 10)),
  },
  dotted: { gap: S(N(10, 1, 60)), dotRadius: B(N(0.8, 0.3, 3)), nLayers: S(I(2, 1, 10)), speed: B(N(250, 50, 1000, 10)) },
  blobDotted: { gap: S(N(10, 1, 60)), diameter: B(N(1.6, 0.6, 8)), ...BLOB_BUILD_OPTS, ...ORBIT_OPTS },
  directionalBlobDotted: {
    gap: S(NN(null)), diameter: B(N(2.0, 0.6, 8)), azimuthDeg: B(N(0, -180, 180, 1)),
    dragSpeed: B(N(600, 100, 2000, 10)), stampOrder: B(EN("auto", ["auto", "forward", "reverse"])), ...BLOB_BUILD_OPTS,
  },
  hairy: {
    spacing: S(N(5.0, 1, 30)), esegmentMm: B(N(1.2, 0.2, 4)), retractMm: B(N(1.3, 0, 6)), dwellMs: B(I(400, 0, 3000)),
    smallLift: B(N(0.2, 0, 2)), bigLift: B(N(4.0, 1, 10)), baseZ: B(N(0.3, 0.1, 1)), speed: S(N(200, 50, 1000, 10)),
  },
  hairyDotted: {
    gap: S(N(10, 1, 60)), rootDiameter: B(N(2.0, 0.6, 8)), ...HAIR_OPTS,
    stampOrder: B(EN("auto", ["auto", "forward", "reverse"])), ...BLOB_BUILD_OPTS,
  },
  segmented: {
    thinLen: S(N(8, 1, 40)), thinWidth: B(N(0.8, 0.3, 3)), thinHeight: B(N(0.2, 0.1, 0.6)), thinSpeed: B(N(130, 30, 600, 5)),
    fatLen: S(N(4, 1, 40)), fatWidth: B(N(1.6, 0.3, 4)), fatHeight: B(N(0.3, 0.1, 0.8)), fatSpeed: B(N(60, 20, 400, 5)),
    flowMult: B(N(1.4, 0.5, 3)), segDwellMs: S(I(250, 0, 2000)),
  },
  variableThickness: {
    hMin: S(N(0.16, 0.1, 1)), hMax: S(N(0.9, 0.2, 2)), wavelength: S(N(8.0, 2, 40)),
    beadWidth: B(N(0.8, 0.3, 3)), zGap: S(N(0.25, 0.25, 1)), speed: B(N(25, 10, 300, 5)),
  },
  // Formerly STAMP_OPTIONS -- merged in (no key collisions). All
  // brush-level: called as a genuine single point, there's no Stroke
  // wrapper deciding a walk.
  blob: { diameter: B(N(1.6, 0.6, 8)), ...BLOB_BUILD_OPTS, ...ORBIT_OPTS },
  disc: { diameter: B(N(1.6, 0.6, 8)), height: B(N(0.4, 0.4, 3, 0.2)), speed: B(N(250, 50, 1000, 10)) },
  directionalBlob: { diameter: B(N(2.0, 0.6, 8)), azimuthDeg: B(N(0, -180, 180, 1)), dragSpeed: B(N(600, 100, 2000, 10)), ...BLOB_BUILD_OPTS },
  hairyDot: { rootDiameter: B(N(2.0, 0.6, 8)), ...HAIR_OPTS, ...BLOB_BUILD_OPTS },
};

// Built-in fill patterns with editable numeric specs. The free-form kinds
// (stamps / strokes / curves / family) carry their own JSON and are edited
// as text.
export const PATTERN_OPTIONS = {
  hatch: { angleDeg: N(0, -180, 180, 1), gap: N(4.0, 0.3, 20) },
  grid: { dx: N(6, 1, 40), dy: N(6, 1, 40), angleDeg: N(0, -180, 180, 1) },
  diamond: { diag: N(8.0, 2, 30), fillGap: N(0.6, 0.35, 3) },
};
export const PATTERN_KINDS = ["hatch", "grid", "diamond", "stamps", "strokes", "curves", "family"];
export const STAMP_PATTERNS = ["grid", "stamps"];      // these place points, not strokes
export const BRUSH_NAMES = Object.keys(BRUSH_OPTIONS);
// Brushes that produce a real deposit when called at a single point (no
// Stroke walk needed) -- verified against texture_functions-with-tool.js:
// brushSolid/brushDashed/brushSegmented/brushVariableThickness/brushHairy
// all need pts.length >= 2 to emit anything (their inner walk loop never
// runs otherwise); these eight have their own size parameter independent
// of path length and degrade cleanly to one call.
export const POINT_SAFE_BRUSHES = new Set([
  "blob", "disc", "directionalBlob", "hairyDot",
  "dotted", "blobDotted", "directionalBlobDotted", "hairyDotted",
]);

// One-line semantic descriptor per option name (shared names share a
// meaning) -- what it does physically and which way is "more". Sent to the
// parameters stage with the numeric spec; shown as a tooltip in the UI.
export const OPTION_DESC = {
  width: "bead width in mm; wider = broader, more prominent ridge",
  beadWidth: "bead width in mm; wider = broader ridge",
  nLayers: "stacked 0.2mm layers; more = taller relief",
  speed: "print speed mm/min; slower = cleaner deposition",
  segLen: "dash length in mm along the path",
  gapLen: "gap between dashes in mm; larger = sparser dashes",
  gap: "spacing between stamps / dashes / hatch rows in mm; smaller = denser",
  dotRadius: "radius of each flat disc in mm",
  diameter: "dome diameter in mm; larger = bigger, taller bump",
  rootDiameter: "diameter of the root dome under each hair in mm; larger = tougher hair",
  azimuthDeg: "lean / rake direction in degrees CCW from +X (offset from the path tangent on a line)",
  dragSpeed: "speed of the squish-and-drag that shapes a leaning dome",
  stampOrder: "walk the path forward or reverse so each dome leans over already-cooled ones",
  spacing: "distance between hair strands in mm; smaller = denser, hairier",
  esegmentMm: "filament extruded per strand in mm; more = thicker strand",
  retractMm: "retraction distance in mm after each strand / dome",
  dwellMs: "pause after depositing, ms; longer = more solidified before moving",
  smallLift: "first small lift after the strand root in mm",
  bigLift: "pull height in mm; taller = longer strand",
  baseZ: "nozzle height at first contact in mm",
  hairLength: "pulled hair length in mm; longer = longer, more flexible strand",
  hairThickness: "hair bead thickness in mm (blank = derived from hairLength)",
  hairDirection: "which way the hair is pulled: top (up), right, left, bottom",
  hairAzimuthDeg: "explicit hair azimuth in degrees CCW from +X (overrides hairDirection)",
  hairElevationDeg: "explicit hair elevation in degrees; 0 flat, 90 straight up",
  beadFlowMult: "extra flow while pulling the hair; more = fatter strand",
  pullExtrudeSpeed: "speed of the hair pull mm/min; slower = thicker",
  stringMm: "fast no-extrusion string break after the pull, mm",
  overtravelMm: "clearance travel after the string, mm",
  thinLen: "length of each thin segment, mm", thinWidth: "bead width of thin segments, mm",
  thinHeight: "bead height of thin segments, mm", thinSpeed: "speed on thin segments",
  fatLen: "length of each fat segment, mm", fatWidth: "bead width of fat segments, mm",
  fatHeight: "bead height of fat segments, mm", fatSpeed: "speed on fat segments",
  flowMult: "flow multiplier for the whole segmented line",
  segDwellMs: "pause at each segment change, ms",
  hMin: "lowest bead height of the swelling ridge, mm", hMax: "highest bead height of the swelling ridge, mm",
  wavelength: "distance between swells, mm; shorter = more frequent bumps",
  zGap: "nozzle-to-bead clearance, mm (never below 0.25)",
  height: "disc height in mm, multiple of 0.2",
  buildSteps: "Z increments while building a dome", taperFactor: "how much extrusion tapers toward the dome top",
  extrudeSpeed: "extrusion feed while building a dome", extrusionMultiplier: "dome volume multiplier; more = fatter dome",
  postRetractDwellMs: "pause after retracting, ms", baseExtraMm: "extra first-contact filament, mm",
  baseDwellMs: "pause after the first-contact blob, ms",
  orbitRadius: "anti-string orbit radius, mm (blank = dome radius, 0 = off)", orbitPts: "points per orbit loop",
  orbitSpeed: "orbit travel speed", orbitLoops: "number of orbit loops",
  angleDeg: "hatch / grid rotation in degrees CCW from +X",
  dx: "grid spacing along the grid's X in mm", dy: "grid spacing along the grid's Y in mm",
  diag: "diamond cell diagonal in mm; larger = bigger cells", fillGap: "scanline gap inside filled cells, mm",
};

export function optionSpecFor(fn) {
  return BRUSH_OPTIONS[fn] || {};
}
export function isBrush(fn) { return fn in BRUSH_OPTIONS; }
export function isPointSafe(fn) { return POINT_SAFE_BRUSHES.has(fn); }
// A recognized brush that can actually walk a multi-point path. The four
// former stamps (blob/disc/directionalBlob/hairyDot) are point-safe but
// NOT this -- their G-code function only ever takes one (cx, cy); handed
// a real path they'd silently draw at just its first point, not walk it.
export function isStrokeCapable(fn) { return isBrush(fn) && !(fn in TF.STAMPS); }

// ---------------------------------------------------------- safe expression --

const FN1 = { sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, log: Math.log };
const FN2 = { min: Math.min, max: Math.max, pow: Math.pow };

function tokenizeExpr(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`bad number "${text}" in expression`);
      toks.push({ type: "num", value: parseFloat(text) });
      i = j; continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      toks.push({ type: "ident", value: src.slice(i, j) });
      i = j; continue;
    }
    if ("+-*/^(),".includes(c)) { toks.push({ type: c }); i++; continue; }
    throw new Error(`unexpected character "${c}" in expression`);
  }
  toks.push({ type: "eof" });
  return toks;
}

function parseExprTokens(toks, vars) {
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (type) => { if (peek().type !== type) throw new Error(`expected "${type}", got "${peek().type}"`); return next(); };

  function parseExpr() {
    let node = parseTerm();
    while (peek().type === "+" || peek().type === "-") {
      const op = next().type;
      node = { type: "bin", op, left: node, right: parseTerm() };
    }
    return node;
  }
  function parseTerm() {
    let node = parseUnary();
    while (peek().type === "*" || peek().type === "/") {
      const op = next().type;
      node = { type: "bin", op, left: node, right: parseUnary() };
    }
    return node;
  }
  function parseUnary() {
    if (peek().type === "-") { next(); return { type: "un", op: "-", arg: parseUnary() }; }
    return parsePower();
  }
  function parsePower() {
    const base = parseAtom();
    if (peek().type === "^") { next(); return { type: "bin", op: "^", left: base, right: parseUnary() }; }
    return base;
  }
  function parseAtom() {
    const tok = peek();
    if (tok.type === "num") { next(); return { type: "num", value: tok.value }; }
    if (tok.type === "(") {
      next();
      const node = parseExpr();
      expect(")");
      return node;
    }
    if (tok.type === "ident") {
      next();
      const name = tok.value;
      if (peek().type === "(") {
        next();
        const args = [parseExpr()];
        while (peek().type === ",") { next(); args.push(parseExpr()); }
        expect(")");
        if (name in FN1) {
          if (args.length !== 1) throw new Error(`${name}() takes exactly 1 argument`);
          return { type: "call1", fn: name, arg: args[0] };
        }
        if (name in FN2) {
          if (args.length !== 2) throw new Error(`${name}() takes exactly 2 arguments`);
          return { type: "call2", fn: name, args };
        }
        throw new Error(`unknown function "${name}" -- allowed: ${Object.keys(FN1).concat(Object.keys(FN2)).join(", ")}`);
      }
      const vi = vars.indexOf(name);
      if (vi >= 0) return { type: "var", idx: vi };
      if (name === "pi") return { type: "const", value: Math.PI };
      throw new Error(`unknown identifier "${name}" -- only ${vars.map((v) => `"${v}"`).join(", ")} and "pi" are defined`);
    }
    throw new Error(`unexpected token "${tok.type}" in expression`);
  }

  const result = parseExpr();
  expect("eof");
  return result;
}

function evalExprNode(node, args) {
  switch (node.type) {
    case "num": return node.value;
    case "const": return node.value;
    case "var": return args[node.idx];
    case "un": return -evalExprNode(node.arg, args);
    case "call1": return FN1[node.fn](evalExprNode(node.arg, args));
    case "call2": return FN2[node.fn](evalExprNode(node.args[0], args), evalExprNode(node.args[1], args));
    case "bin": {
      const a = evalExprNode(node.left, args), b = evalExprNode(node.right, args);
      switch (node.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "^": return Math.pow(a, b);
      }
    }
  }
  throw new Error(`unhandled expression node "${node.type}"`);
}

/** Compiles a formula string in the given variables (default ["t"]; a
 * fill family uses ["t", "u"]) into a plain function (t, u) => number.
 * Never uses eval()/Function() -- parses into a closed AST via a
 * whitelisted grammar, then evaluates that AST with a switch we control.
 * Throws at compile time on anything outside the grammar. */
export function compileExpr(src, vars = ["t"]) {
  if (typeof src !== "string" || !src.trim()) throw new Error("expression must be a non-empty string");
  const ast = parseExprTokens(tokenizeExpr(src), vars);
  return (...args) => evalExprNode(ast, args);
}

// ------------------------------------------------------------- 2D helpers --

const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function bboxOf(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}
function mergeBbox(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}
function polylineLength(points) {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += dist2(points[i - 1], points[i]);
  return s;
}
function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}
function dedupeConsecutive(points, eps = 1e-6) {
  const out = [];
  for (const p of points) if (!out.length || dist2(out[out.length - 1], p) > eps) out.push(p);
  return out;
}

export function pointInPolygon([px, py], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Parameters (t along ab, u along cd) of the proper intersection of two
// segments, or null if they do not cross (touching endpoints excluded).
// With `inclusiveU` a crossing exactly through an endpoint of cd counts
// too -- the clipper needs that so a stroke passing through a polygon
// VERTEX still gets split there (it is then found on both adjacent
// edges at the same t, which the clipper's zero-length skip absorbs).
function segCross(a, b, c, d, inclusiveU = false) {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const qx = c[0] - a[0], qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / denom, u = (qx * ry - qy * rx) / denom;
  if (t <= 1e-9 || t >= 1 - 1e-9) return null;
  if (inclusiveU ? (u < -1e-9 || u > 1 + 1e-9) : (u <= 1e-9 || u >= 1 - 1e-9)) return null;
  return { t, u };
}

/** True if a closed polygon has no self-intersections (non-adjacent edges
 * never cross). O(n^2) -- boundaries are at most a few thousand points. */
export function isSimplePolygon(poly) {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;   // closing edge is adjacent to edge 0
      if (segCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** True if two simple polygons overlap in area (edges cross, or one
 * contains a vertex of the other). */
export function polygonsOverlap(a, b) {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
}

/** Clips a polyline to the inside of a polygon: splits every segment at
 * its crossings with the polygon's edges, keeps the sub-segments whose
 * midpoint is inside, and joins consecutive kept pieces into runs.
 * Returns an array of polylines (each >= 2 points). */
export function clipPolylineToPolygon(points, poly) {
  const runs = [];
  let cur = [];
  const flush = () => { if (cur.length > 1) runs.push(cur); cur = []; };
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    if (dist2(a, b) < 1e-9) continue;
    const ts = [0, 1];
    for (let j = 0; j < poly.length; j++) {
      const x = segCross(a, b, poly[j], poly[(j + 1) % poly.length], true);
      if (x) ts.push(x.t);
    }
    ts.sort((p, q) => p - q);
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k], t1 = ts[k + 1];
      if (t1 - t0 < 1e-9) continue;
      const pa = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      const pb = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      if (pointInPolygon(mid, poly)) {
        if (cur.length && dist2(cur[cur.length - 1], pa) < 1e-6) cur.push(pb);
        else { flush(); cur = [pa, pb]; }
      } else {
        flush();
      }
    }
  }
  flush();
  return runs;
}

// ---------------------------------------------------------------- scene --

export function defaultScene() {
  return {
    version: SCENE_VERSION,
    config: { material: "TPU" },
    transform: { scale: 1.0, origin: null },
    elements: [],
    textures: {},
    groups: [],
    messages: [],
    lastReport: null,
  };
}

/** Coerces a stored blob into a valid scene; anything from an older
 * format (or garbage) becomes a fresh scene. */
export function normalizeScene(raw) {
  const s = defaultScene();
  if (!raw || raw.version !== SCENE_VERSION) return s;
  s.config = { ...s.config, ...(raw.config || {}) };
  s.transform = { scale: Number(raw.transform?.scale) || 1.0, origin: Array.isArray(raw.transform?.origin) ? raw.transform.origin : null };
  s.elements = Array.isArray(raw.elements) ? raw.elements : [];
  s.textures = raw.textures && typeof raw.textures === "object" ? raw.textures : {};
  s.groups = Array.isArray(raw.groups) ? raw.groups : [];
  s.messages = Array.isArray(raw.messages) ? raw.messages : [];
  s.lastReport = raw.lastReport || null;
  return s;
}

export function nextId(scene, prefix) {
  let n = 1;
  const taken = new Set([...scene.elements.map((e) => e.id), ...(scene.groups || []).map((g) => g.id)]);
  while (taken.has(`${prefix}_${n}`)) n++;
  return `${prefix}_${n}`;
}

const SLOTS_FOR_KIND = { line: ["brush"], point: ["brush"], region: ["outline", "fill"] };
export function slotsFor(kind) { return SLOTS_FOR_KIND[kind] || []; }

// ------------------------------------------------------------- resolution --

const SAMPLE_STEP = 0.1;

function checkPointList(points, what) {
  if (!Array.isArray(points) || points.length < 2) throw new Error(`${what}: needs at least 2 points`);
  for (const p of points) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error(`${what}: every point must be [x, y]`);
  }
  return points.map((p) => [p[0], p[1]]);
}

function sampleFormula(spec, what, tFrom = 0, tTo = null) {
  if (typeof spec.x !== "string" || typeof spec.y !== "string" || !Number.isFinite(spec.tEnd)) {
    throw new Error(`${what}: a formula piece is {"x": "<expr in t>", "y": "<expr in t>", "tEnd": <number>}`);
  }
  const fx = compileExpr(spec.x), fy = compileExpr(spec.y);
  const t0 = tFrom ?? 0, t1 = tTo ?? spec.tEnd;
  if (!(t1 > t0)) throw new Error(`${what}: t range must be increasing (got ${t0}..${t1})`);
  return TF.samplePath((t) => fx(t), (t) => fy(t), t0, t1, { step: SAMPLE_STEP }).map((p) => [p[0], p[1]]);
}

/** Cuts a polyline to an x range, interpolating a new vertex exactly on
 * each cut. Works on a sampled formula and on a hand-written point list
 * alike, which is the point: "the axis from x=40 to x=90" used to have to
 * be retyped as its own point list because tFrom/tTo only ever applied to
 * a formula's own parameter. */
function cutPolylineByX(pts, x0, x1, what) {
  const lerp = (a, b, x) => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p[0] >= x0 - 1e-9 && p[0] <= x1 + 1e-9) out.push(p);
    const q = pts[i + 1];
    if (!q) continue;
    for (const xc of [x0, x1]) if ((p[0] - xc) * (q[0] - xc) < 0) out.push(lerp(p, q, xc));
  }
  const cut = dedupeConsecutive(out.sort((a, b) => a[0] - b[0]));
  if (cut.length < 2) {
    const bb = bboxOf(pts);
    throw new Error(`${what}: nothing of this path lies between x ${x0} and x ${x1} -- its own x range is ${bb.minX.toFixed(1)}..${bb.maxX.toFixed(1)}`);
  }
  return cut;
}

/** The vertex list of a single-stroke line element, in graphic space. */
function linePolyline(id, scene, what) {
  const target = scene.elements.find((e) => e.id === id);
  if (!target) throw new Error(`${what}: "${id}" is not an element id`);
  if (target.kind !== "line") throw new Error(`${what}: "${id}" must be a line element`);
  if (Array.isArray(target.paths)) throw new Error(`${what}: "${id}" is a repeated group (multiple strokes) -- only a single-stroke line can bound a region`);
  if (Array.isArray(target.path?.points)) return checkPointList(target.path.points, what);
  return sampleFormula(target.path || {}, `${what} (${id})`);
}

/** A piece -> vertex list in graphic space (no arc-length tag yet). */
function resolvePiece(piece, scene, what, depth = 0) {
  if (!piece || typeof piece !== "object") throw new Error(`${what}: missing piece`);
  if (Array.isArray(piece.points)) return checkPointList(piece.points, what);
  if (typeof piece.ref === "string") {
    if (depth > 2) throw new Error(`${what}: ref chain too deep`);
    const target = scene.elements.find((e) => e.id === piece.ref);
    if (!target) throw new Error(`${what}: ref "${piece.ref}" is not an element id`);
    if (target.kind !== "line") throw new Error(`${what}: ref "${piece.ref}" must be a line element`);
    if (Array.isArray(target.paths)) throw new Error(`${what}: ref "${piece.ref}" is a repeated group (multiple strokes) -- ref only targets a single-stroke line`);
    let pts;
    if (Array.isArray(target.path?.points)) pts = checkPointList(target.path.points, what);
    else pts = sampleFormula(target.path || {}, `${what} (ref ${piece.ref})`, piece.tFrom ?? 0, piece.tTo ?? target.path?.tEnd);
    // An x range is the sub-range anyone actually means ("the axis under
    // the shaded part"), and unlike tFrom/tTo it means the same thing on a
    // formula path and a point list.
    const hasX = Number.isFinite(Number(piece.xFrom)) || Number.isFinite(Number(piece.xTo));
    if (hasX) {
      const bb = bboxOf(pts);
      const x0 = Number.isFinite(Number(piece.xFrom)) ? Number(piece.xFrom) : bb.minX;
      const x1 = Number.isFinite(Number(piece.xTo)) ? Number(piece.xTo) : bb.maxX;
      if (!(x1 > x0)) throw new Error(`${what}: xFrom must be less than xTo (got ${x0}..${x1})`);
      pts = cutPolylineByX(pts, x0, x1, `${what} (ref ${piece.ref})`);
    }
    return piece.reverse ? pts.slice().reverse() : pts;
  }
  return sampleFormula(piece, what);
}

// ------------------------------------------------- app-solved "between" --

/** Normalizes a bound to run left-to-right and rejects one that doubles
 * back: "between" only means anything when each bound gives one y per x. */
function ascendingInX(pts, what) {
  let dir = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    if (Math.abs(dx) < 1e-9) continue;
    const d = dx > 0 ? 1 : -1;
    if (dir === 0) dir = d;
    else if (d !== dir) throw new Error(`${what}: this bound doubles back in x, so it has no single y per x -- write the shape as an explicit boundary instead of "between"`);
  }
  return dir < 0 ? pts.slice().reverse() : pts;
}

/** Every proper crossing of two polylines, as [x, y], left to right. */
function polylineCrossings(a, b) {
  const hits = [];
  for (let i = 0; i + 1 < a.length; i++) {
    const aLo = Math.min(a[i][0], a[i + 1][0]), aHi = Math.max(a[i][0], a[i + 1][0]);
    for (let j = 0; j + 1 < b.length; j++) {
      if (Math.max(b[j][0], b[j + 1][0]) < aLo) continue;
      if (Math.min(b[j][0], b[j + 1][0]) > aHi) break;   // b ascends in x
      const c = segCross(a[i], a[i + 1], b[j], b[j + 1], true);
      if (c) hits.push([a[i][0] + (a[i + 1][0] - a[i][0]) * c.t, a[i][1] + (a[i + 1][1] - a[i][1]) * c.t]);
    }
  }
  hits.sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const p of hits) if (!out.length || Math.abs(p[0] - out[out.length - 1][0]) > 1e-6) out.push(p);
  return out;
}

/** Solves `{between: {upper, lower, xFrom?, xTo?}}` into a closed polygon.
 *
 * The model names the two bounds and, if it wants one, an x range; the app
 * samples them, finds where they cross, cuts both to the same span and
 * closes the ends. Previously all of that was the model's arithmetic --
 * solve the intersection, pick matching parameter ranges, hope the ends
 * meet -- which is where inaccurate shading came from: a boundary whose
 * ends missed was silently closed with a straight edge across the shape.
 *
 * Returns { polygon, meta } where meta feeds the geometry report. */
function solveBetween(spec, scene, what) {
  if (!spec || typeof spec !== "object") throw new Error(`${what}: "between" needs {"upper": <line id>, "lower": <line id> | {"y": <mm>}}`);
  const isLevel = (b) => b && typeof b === "object" && Number.isFinite(Number(b.y));
  const { upper, lower } = spec;
  if (isLevel(upper) && isLevel(lower)) throw new Error(`${what}: at least one bound must be a line element -- two levels have no x range of their own`);

  // Resolve whichever bound is a real path first; a {"y": n} level then
  // spans exactly that path's x extent.
  const anchorIsUpper = !isLevel(upper);
  const anchor = ascendingInX(linePolyline(anchorIsUpper ? upper : lower, scene, `${what} ${anchorIsUpper ? "upper" : "lower"} bound`), `${what} ${anchorIsUpper ? "upper" : "lower"} bound`);
  const anchorBox = bboxOf(anchor);
  const other = isLevel(anchorIsUpper ? lower : upper)
    ? [[anchorBox.minX, Number((anchorIsUpper ? lower : upper).y)], [anchorBox.maxX, Number((anchorIsUpper ? lower : upper).y)]]
    : ascendingInX(linePolyline(anchorIsUpper ? lower : upper, scene, `${what} ${anchorIsUpper ? "lower" : "upper"} bound`), `${what} ${anchorIsUpper ? "lower" : "upper"} bound`);

  let up = anchorIsUpper ? anchor : other;
  let lo = anchorIsUpper ? other : anchor;

  const crossings = polylineCrossings(up, lo);
  const upBox = bboxOf(up), loBox = bboxOf(lo);
  const overlap = { min: Math.max(upBox.minX, loBox.minX), max: Math.min(upBox.maxX, loBox.maxX) };
  if (!(overlap.max > overlap.min)) throw new Error(`${what}: the two bounds never share an x range (upper spans ${upBox.minX.toFixed(1)}..${upBox.maxX.toFixed(1)}, lower ${loBox.minX.toFixed(1)}..${loBox.maxX.toFixed(1)}) -- there is no area between them`);

  const given = Number.isFinite(Number(spec.xFrom)) || Number.isFinite(Number(spec.xTo));
  let x0, x1;
  if (given) {
    x0 = Number.isFinite(Number(spec.xFrom)) ? Number(spec.xFrom) : overlap.min;
    x1 = Number.isFinite(Number(spec.xTo)) ? Number(spec.xTo) : overlap.max;
    if (!(x1 > x0)) throw new Error(`${what}: xFrom must be less than xTo (got ${x0}..${x1})`);
  } else if (crossings.length >= 2) {
    // The classic lens: shade between the first and last crossing.
    x0 = crossings[0][0];
    x1 = crossings[crossings.length - 1][0];
    if (crossings.length > 2) throw new Error(`${what}: the bounds cross ${crossings.length} times, so "the area between them" is ambiguous -- give xFrom and xTo to say which span you mean`);
  } else if (crossings.length === 1) {
    throw new Error(`${what}: the bounds cross once (at x ${crossings[0][0].toFixed(2)}), so they swap sides and the area between them is two separate pieces -- give xFrom and xTo to pick one`);
  } else {
    // Never cross (a curve over an axis): the whole shared span.
    x0 = overlap.min;
    x1 = overlap.max;
  }

  up = cutPolylineByX(up, x0, x1, `${what} upper bound`);
  lo = cutPolylineByX(lo, x0, x1, `${what} lower bound`);

  // Walk the upper left-to-right, then the lower back right-to-left; the
  // two vertical edges at x0 and x1 close it. A zero-height end (the
  // bounds meet there) collapses to a single vertex via dedupe.
  const polygon = dedupeConsecutive([...up, ...lo.slice().reverse()]);
  if (polygon.length < 3) throw new Error(`${what}: the two bounds coincide over this span -- there is no area between them`);
  return {
    polygon,
    meta: {
      solvedXRange: [+x0.toFixed(2), +x1.toFixed(2)],
      bounds: { upper: isLevel(upper) ? `y=${Number(upper.y)}` : upper, lower: isLevel(lower) ? `y=${Number(lower.y)}` : lower },
      intersections: crossings.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)]),
      rangeFrom: given ? "given" : (crossings.length >= 2 ? "solved from the crossings" : "the bounds' shared x span"),
    },
  };
}

/** Resolves every element to vertex lists in GRAPHIC space and validates
 * region boundaries. Returns { resolved: {id -> {points|polygon, closureGap}},
 * errors, bbox }. Errors are per element; a failed element is skipped. */
export function resolveScene(scene) {
  const resolved = {}, errors = [], warnings = [];
  let bbox = null;
  for (const el of scene.elements) {
    const what = `"${el.label || el.id}"`;
    try {
      if (el.kind === "point") {
        // A point's `at` is either one pair [x,y] (a single stamp) or an
        // array of pairs (a GROUP: many stamps -- repeated markers, data
        // points along an axis -- sharing this one element's texture).
        const many = Array.isArray(el.at) && Array.isArray(el.at[0]);
        const atList = many ? el.at : [el.at];
        atList.forEach((p, i) => {
          if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) {
            throw new Error(`${what}${many ? ` point ${i + 1}` : ""}: point needs at = [x, y]${many ? " (each entry of the group)" : ""}`);
          }
        });
        resolved[el.id] = { kind: "point", atList: atList.map((p) => [p[0], p[1]]) };
        bbox = mergeBbox(bbox, bboxOf(atList));
      } else if (el.kind === "line") {
        // A line's geometry is either `path` (ONE continuous stroke) or
        // `paths` (a GROUP: several independent, disconnected strokes --
        // axis ticks, gridlines, a row of short marks -- sharing this one
        // element's texture; each piece is resolved on its own, never
        // concatenated into one path).
        const pieces = Array.isArray(el.paths) ? el.paths : [el.path];
        if (!pieces.length) throw new Error(`${what}: line needs "path" or a non-empty "paths"`);
        const strokes = pieces.map((piece, i) => {
          const pts = dedupeConsecutive(resolvePiece(piece, scene, pieces.length > 1 ? `${what} stroke ${i + 1}` : what));
          if (pts.length < 2) throw new Error(`${what}${pieces.length > 1 ? ` stroke ${i + 1}` : ""}: path has no length`);
          return pts;
        });
        resolved[el.id] = { kind: "line", strokes, dense: pieces.every((p) => !Array.isArray(p.points)) };
        for (const pts of strokes) bbox = mergeBbox(bbox, bboxOf(pts));
      } else if (el.kind === "region") {
        let poly, closureGap = 0, meta = null;
        if (el.between) {
          // App-solved: the model named the bounds, the compiler did the
          // intersecting and closing. Closed by construction, so there is
          // no closure gap to report.
          const solved = solveBetween(el.between, scene, what);
          poly = solved.polygon;
          meta = solved.meta;
        } else {
          if (!Array.isArray(el.boundary) || !el.boundary.length) throw new Error(`${what}: region needs a boundary piece list, or a "between" spec`);
          poly = [];
          el.boundary.forEach((piece, i) => { poly.push(...resolvePiece(piece, scene, `${what} boundary piece ${i + 1}`)); });
          poly = dedupeConsecutive(poly);
          // Closure: an end within closureSnapMm of the start snaps onto
          // it; a larger gap is closed with a straight edge. That edge is
          // now ALWAYS warned about, point lists included -- a boundary
          // silently closed across the middle of the shape is exactly how
          // inaccurate shading used to get through unnoticed.
          closureGap = poly.length > 1 ? dist2(poly[0], poly[poly.length - 1]) : Infinity;
          if (closureGap <= CONSTRAINTS.closureSnapMm) poly.pop();
          else warnings.push(`${what}: the boundary's end is ${closureGap.toFixed(1)}mm from its start -- closed with a straight edge. If that edge is not meant to be part of the shape, the pieces do not meet.`);
        }
        if (poly.length < 3) throw new Error(`${what}: boundary needs at least 3 distinct points`);
        if (!isSimplePolygon(poly)) throw new Error(`${what}: boundary crosses itself -- a fill region must be a simple, single-contour shape`);
        resolved[el.id] = { kind: "region", polygon: poly, closureGap, meta };
        bbox = mergeBbox(bbox, bboxOf(poly));
      } else {
        throw new Error(`${what}: unknown kind "${el.kind}"`);
      }
    } catch (e) {
      errors.push(e && e.name === "PathTooSteepError" ? `${what}: path is too steep to print -- ${e.message}` : String(e.message || e));
    }
  }
  return { resolved, errors, warnings, bbox };
}

// ---------------------------------------------------------------- transform --

/** The affine map graphic -> bed space: natural bbox min corner lands on
 * transform.origin (or stays put when origin is null), scaled about it. */
export function transformFor(scene, naturalBbox) {
  const scale = Number(scene.transform?.scale) > 0 ? Number(scene.transform.scale) : 1;
  const minX = naturalBbox ? naturalBbox.minX : 0, minY = naturalBbox ? naturalBbox.minY : 0;
  const origin = Array.isArray(scene.transform?.origin) ? scene.transform.origin : [minX, minY];
  const map = ([x, y]) => [origin[0] + scale * (x - minX), origin[1] + scale * (y - minY)];
  return { scale, origin, minX, minY, map };
}

function rectOfPolygon(poly) {
  if (poly.length !== 4) return null;
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const ok = poly.every(([x, y]) => (Math.abs(x - x0) < 1e-6 || Math.abs(x - x1) < 1e-6) && (Math.abs(y - y0) < 1e-6 || Math.abs(y - y1) < 1e-6));
  return ok ? { x0, y0, w: x1 - x0, h: y1 - y0 } : null;
}

// ----------------------------------------------------------------- patterns --

/** pattern spec + region polygon (bed space) + transform -> { strokes:
 * [{points, brushOverride?}], stamps: [[x,y]], newPatternOnce }.
 * Built-in kinds are generated in bed space with their spacing scaled;
 * free-form kinds are given in graphic space and mapped through `tf`. */
export function generatePattern(pattern, polygon, tf, what) {
  const kind = pattern?.kind;
  const strokes = [], stamps = [];
  const bb = bboxOf(polygon);
  const T = tf.map;

  if (kind === "hatch") {
    const gap = (Number(pattern.gap) || 4) * tf.scale;
    for (const seg of TF.hatchStrokes(polygon, Number(pattern.angleDeg) || 0, gap)) strokes.push({ points: seg });
    return { strokes, stamps, newPatternOnce: false };
  }
  if (kind === "diamond") {
    const rect = rectOfPolygon(polygon);
    if (!rect) throw new Error(`${what}: diamond fill needs an axis-aligned rectangular boundary`);
    const d = TF.diamondStrokes(rect, { diag: (Number(pattern.diag) || 8) * tf.scale, fillGap: (Number(pattern.fillGap) || 0.6) * tf.scale });
    for (const s of d.strokes) strokes.push({ points: s.points, brushOverride: s.brush, sparse: true });
    return { strokes, stamps, newPatternOnce: true, diamonds: d.diamonds };
  }
  if (kind === "grid") {
    const dx = (Number(pattern.dx) || 6) * tf.scale, dy = (Number(pattern.dy) || 6) * tf.scale;
    const a = ((Number(pattern.angleDeg) || 0) * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
    const r = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY) / 2 + Math.max(dx, dy);
    for (let i = -Math.ceil(r / dx); i <= Math.ceil(r / dx); i++) {
      for (let j = -Math.ceil(r / dy); j <= Math.ceil(r / dy); j++) {
        const lx = i * dx, ly = j * dy;
        const p = [cx + lx * ca - ly * sa, cy + lx * sa + ly * ca];
        if (pointInPolygon(p, polygon)) stamps.push(p);
      }
    }
    return { strokes, stamps, newPatternOnce: false };
  }
  if (kind === "stamps") {
    for (const p of checkPointList(pattern.points, `${what} stamps`)) { const q = T(p); if (pointInPolygon(q, polygon)) stamps.push(q); }
    return { strokes, stamps, newPatternOnce: false };
  }
  if (kind === "strokes") {
    if (!Array.isArray(pattern.strokes)) throw new Error(`${what}: strokes pattern needs "strokes": [[[x,y],...], ...]`);
    pattern.strokes.forEach((pl, i) => {
      for (const run of clipPolylineToPolygon(checkPointList(pl, `${what} stroke ${i + 1}`).map(T), polygon)) strokes.push({ points: run });
    });
    return { strokes, stamps, newPatternOnce: false };
  }
  if (kind === "curves") {
    if (!Array.isArray(pattern.curves)) throw new Error(`${what}: curves pattern needs "curves": [{x,y,tEnd}, ...]`);
    pattern.curves.forEach((c, i) => {
      for (const run of clipPolylineToPolygon(sampleFormula(c, `${what} curve ${i + 1}`).map(T), polygon)) strokes.push({ points: run });
    });
    return { strokes, stamps, newPatternOnce: false };
  }
  if (kind === "family") {
    if (typeof pattern.x !== "string" || typeof pattern.y !== "string" || !Number.isFinite(pattern.tEnd) || !Number.isFinite(pattern.uEnd) || !(Number(pattern.uStep) > 0)) {
      throw new Error(`${what}: family pattern needs {"x": "<expr in t,u>", "y": "<expr in t,u>", "tEnd", "uEnd", "uStep"}`);
    }
    const fx = compileExpr(pattern.x, ["t", "u"]), fy = compileExpr(pattern.y, ["t", "u"]);
    for (let u = 0; u <= pattern.uEnd + 1e-9; u += pattern.uStep) {
      const pts = TF.samplePath((t) => fx(t, u), (t) => fy(t, u), 0, pattern.tEnd, { step: SAMPLE_STEP }).map((p) => T([p[0], p[1]]));
      for (const run of clipPolylineToPolygon(pts, polygon)) strokes.push({ points: run });
    }
    return { strokes, stamps, newPatternOnce: false };
  }
  throw new Error(`${what}: unknown pattern kind "${kind}" (${PATTERN_KINDS.join(", ")})`);
}

// ------------------------------------------------------------------ rules --

// Physical checks on one brush/stamp's options (see PRINT_LIMITS). Rules
// that belong to a fill's PATTERN rather than to the brush walking it live
// in checkPatternRules() below.
export function checkBrushRules(fn, opts, tag = fn) {
  const errors = [], warnings = [];
  const g = (k, d) => (opts[k] === undefined || opts[k] === null ? d : opts[k]);
  const spec = optionSpecFor(fn);
  const def = (k, fallback) => (spec[k] && spec[k].def != null ? spec[k].def : fallback);

  const diaKey = fn === "hairyDotted" || fn === "hairyDot" ? "rootDiameter" : (fn === "dotted" ? null : "diameter");
  if (fn === "variableThickness" && g("zGap", 0.25) < CONSTRAINTS.zGapFloor) errors.push(`${tag}: zGap below the ${CONSTRAINTS.zGapFloor}mm floor (prints flat).`);

  for (const k of ["width", "beadWidth", "thinWidth"]) {
    if (k in spec && g(k, def(k, 0.5)) < CONSTRAINTS.minBeadWidth) warnings.push(`${tag}: ${k} below ${CONSTRAINTS.minBeadWidth}mm.`);
  }
  if (fn === "blobDotted") {
    const dia = g("diameter", 1.6), gap = g("gap", 10);
    if (gap < dia + CONSTRAINTS.blobDottedGapOverDiameter) warnings.push(`${tag}: gap ${gap}mm is tight for diameter ${dia}mm -- adjacent domes may fuse (want >= ${(dia + CONSTRAINTS.blobDottedGapOverDiameter).toFixed(1)}mm).`);
  }
  if (fn === "directionalBlobDotted") {
    const dia = g("diameter", 2.0), gap = g("gap", dia);
    if (gap < dia) warnings.push(`${tag}: gap ${gap}mm is below the diameter ${dia}mm -- domes overlap.`);
  }
  if (fn === "hairyDotted") {
    const root = g("rootDiameter", 2.0), gap = g("gap", 10);
    if (gap < root + CONSTRAINTS.hairyDottedGapOverRoot) warnings.push(`${tag}: gap ${gap}mm is tight for rootDiameter ${root}mm (want >= ${root + CONSTRAINTS.hairyDottedGapOverRoot}mm).`);
  }
  if (fn === "dotted") {
    const dr = g("dotRadius", 0.8), gap = g("gap", 10);
    if (gap < 2 * dr + CONSTRAINTS.minDottedGapOverDot) warnings.push(`${tag}: gap ${gap}mm is tight for dotRadius ${dr}mm.`);
  }
  if (fn === "hairy" && g("spacing", 5) < CONSTRAINTS.minHairSpacing) warnings.push(`${tag}: strand spacing ${g("spacing")}mm below ${CONSTRAINTS.minHairSpacing}mm -- strands may fuse.`);

  // Tactile legibility -- the "stops reading as a line / as a fill" family
  // the older single-call page enforced. OFF by default: none of these
  // numbers have been printed and confirmed, so enforcing them would
  // manufacture authority the project does not have. The path exists (and
  // is tested with the flag on) so confirming the numbers is a one-line
  // change rather than a rewrite.
  if (LEGIBILITY_GUIDE.enforced) {
    if (diaKey && diaKey in spec) {
      const dia = g(diaKey, def(diaKey, 1.6));
      if (dia < LEG("minDomeDiameter")) warnings.push(`${tag}: ${diaKey} ${dia}mm is below the ${LEG("minDomeDiameter")}mm relief-floor guidance -- may be hard to feel.`);
    }
    if (fn === "dotted" && 2 * g("dotRadius", 0.8) < LEG("minDomeDiameter")) warnings.push(`${tag}: dotRadius ${g("dotRadius")}mm makes a disc below the ${LEG("minDomeDiameter")}mm relief-floor guidance -- may be hard to feel.`);
    if (fn === "disc" && g("height", 0.4) < LEG("minDiscHeight")) warnings.push(`${tag}: height below the ${LEG("minDiscHeight")}mm relief-floor guidance -- may be hard to feel.`);
    if ("nLayers" in spec && g("nLayers", 2) < LEG("minLayers")) warnings.push(`${tag}: nLayers ${g("nLayers")} is below the ${LEG("minLayers")}-layer relief-floor guidance -- may be hard to feel.`);

    const dotty = { blobDotted: "diameter", directionalBlobDotted: "diameter", hairyDotted: "rootDiameter" };
    if (fn in dotty) {
      const dia = g(dotty[fn], def(dotty[fn], 1.6)), gap = g("gap", fn === "directionalBlobDotted" ? dia : 10);
      if (gap > dia * LEG("maxDottedGapOverDiameter")) warnings.push(`${tag}: gap ${gap}mm is large for ${dotty[fn]} ${dia}mm -- reads as scattered dots, not a line (want <= ${(dia * LEG("maxDottedGapOverDiameter")).toFixed(1)}mm).`);
    }
    if (fn === "dotted") {
      const dia = 2 * g("dotRadius", 0.8), gap = g("gap", 10);
      if (gap > dia * LEG("maxDottedGapOverDiameter")) warnings.push(`${tag}: gap ${gap}mm is large for dotRadius ${g("dotRadius", 0.8)}mm -- reads as scattered dots, not a line (want <= ${(dia * LEG("maxDottedGapOverDiameter")).toFixed(1)}mm).`);
    }
    if (fn === "dashed") {
      const segLen = g("segLen", 8), gapLen = g("gapLen", 4);
      if (segLen < LEG("minDashLen")) warnings.push(`${tag}: segLen ${segLen}mm below ${LEG("minDashLen")}mm -- dashes are indistinct.`);
      if (gapLen < LEG("minDashGap")) warnings.push(`${tag}: gapLen ${gapLen}mm below ${LEG("minDashGap")}mm.`);
      if (gapLen > segLen * LEG("maxDashGapOverSegLen")) warnings.push(`${tag}: gapLen ${gapLen}mm is large vs segLen ${segLen}mm -- reads as isolated dashes (want <= ${(segLen * LEG("maxDashGapOverSegLen")).toFixed(1)}mm).`);
    }
    if (fn === "segmented" && (g("thinLen", 8) < LEG("minSegmentLen") || g("fatLen", 4) < LEG("minSegmentLen"))) {
      warnings.push(`${tag}: a segment length is below ${LEG("minSegmentLen")}mm -- the alternation stops being felt.`);
    }
    if (fn === "hairy" && g("spacing", 5) > LEG("maxHairSpacing")) warnings.push(`${tag}: strand spacing ${g("spacing")}mm above ${LEG("maxHairSpacing")}mm -- the strands stop reading as one hairy line.`);
  }
  return { errors, warnings };
}

/** Physical checks on a fill PATTERN's own numbers, given the brush that
 * will walk it and the graphic's scale (pattern spacing is written in
 * graphic units and scales with the transform; a brush's mm do not).
 *
 * Separate from checkBrushRules because these are properties of the
 * pattern, not of the brush -- and because almost nothing checked them
 * before: only hatch's gap ever reached a rule, through an ad-hoc context
 * field, and diamond's fillGap (an over-extrusion limit the older
 * single-call page did enforce) was lost entirely in the move to this
 * page. */
export function checkPatternRules(pattern, fn, scale, tag) {
  const errors = [], warnings = [];
  const kind = pattern?.kind;
  const num = (k, fallback) => {
    const v = Number(pattern?.[k]);
    return Number.isFinite(v) ? v : fallback;
  };

  if (kind === "hatch") {
    const gap = num("gap", PATTERN_OPTIONS.hatch.gap.def) * scale;
    if (fn === "solid" && gap < CONSTRAINTS.minSolidSheetGap) errors.push(`${tag}: hatch gap ${gap.toFixed(2)}mm below ${CONSTRAINTS.minSolidSheetGap}mm -- severe over-extrusion.`);
    if (fn === "hairy" && gap < CONSTRAINTS.minHairyFillRowGap) warnings.push(`${tag}: hairy hatch row gap ${gap.toFixed(1)}mm below ${CONSTRAINTS.minHairyFillRowGap}mm -- rows may fuse.`);
    if (LEGIBILITY_GUIDE.enforced) {
      const dottedRows = ["dotted", "blobDotted", "directionalBlobDotted", "hairyDotted", "hairy"].includes(fn);
      const max = dottedRows ? LEG("maxDottedFillRowGap") : LEG("maxShadeFillGap");
      if (gap > max) warnings.push(`${tag}: hatch row gap ${gap.toFixed(1)}mm above ${max}mm -- reads as separate rows, not a filled area.`);
    }
  }
  if (kind === "diamond") {
    const fillGap = num("fillGap", PATTERN_OPTIONS.diamond.fillGap.def) * scale;
    if (fillGap < CONSTRAINTS.minSolidSheetGap) errors.push(`${tag}: diamond fillGap ${fillGap.toFixed(2)}mm below ${CONSTRAINTS.minSolidSheetGap}mm -- severe over-extrusion.`);
    if (LEGIBILITY_GUIDE.enforced) {
      const diag = num("diag", PATTERN_OPTIONS.diamond.diag.def) * scale;
      if (diag < LEG("minDiamondDiag")) warnings.push(`${tag}: diamond diag ${diag.toFixed(1)}mm below ${LEG("minDiamondDiag")}mm -- cells blur together.`);
    }
  }
  return { errors, warnings };
}

// A value the model deliberately left alone arrives as an EMPTY STRING or
// null -- the app's own convention for "no value" everywhere else (a
// cleared texture slot's `fn`, an unused `pattern`/`transform` field all
// use "" the same way) -- so treat those as "skip this key", never as a
// stored value: falling through to `??` at render time only works for
// undefined/null, so a stored "" would render as a blank field forever
// instead of showing its real current value or default. A non-empty
// value that doesn't fit the option's kind is a real mistake, not
// something to silently drop.
function coerceOptionValue(meta, v) {
  if (v === null || v === undefined || v === "") return { skip: true };
  if (meta.kind === "enum") {
    if (typeof v === "string" && meta.options.includes(v)) return { value: v };
    return { error: `must be one of ${meta.options.join("|")}` };
  }
  if (meta.kind === "bool") return { value: !!v };
  const n = Number(v);
  if (!Number.isFinite(n)) return { error: "must be a number" };
  const out = meta.kind === "int" ? Math.round(n) : n;
  // An option's range is part of its contract, not just a slider hint. A
  // value outside it (a 100mm hatch gap on a 15mm bar, a 40mm dome) is a
  // real mistake, and storing it silently produced textures nobody asked
  // for -- the option range was previously consulted only to size the UI
  // input and to clamp knob-driven values, never to check what a stage
  // wrote directly. Rejecting here gives the stage its own mistake back.
  if (meta.min != null && meta.max != null && (out < meta.min || out > meta.max)) {
    return { error: `must be within ${meta.min}..${meta.max}` };
  }
  return { value: out };
}

function cleanOptions(fn, options) {
  const opts = {};
  for (const [k, v] of Object.entries(options || {})) if (v !== null && v !== undefined && v !== "") opts[k] = v;
  if (fn === "dashed") { opts.segLen ??= BRUSH_OPTIONS.dashed.segLen.def; opts.gapLen ??= BRUSH_OPTIONS.dashed.gapLen.def; }
  return opts;
}

// ---------------------------------------------------------------- compile --

/** scene -> { jobs, report, errors, warnings, bbox }. A job is
 * { elementId, slot, label, fn, options, pts, newPattern } -- `pts` is
 * always a point list (one point long for a point-safe brush used at a
 * single spot); runJobs() is the only place that cares whether `fn`
 * happens to use TF.STAMPS' (em, x, y, options) call shape. */
export function compileScene(scene) {
  const { resolved, errors, warnings, bbox: naturalBbox } = resolveScene(scene);
  const tf = transformFor(scene, naturalBbox);
  const jobs = [];
  const report = { transform: { scale: tf.scale, origin: tf.origin.map((v) => +v.toFixed(2)) }, elements: [], chart: {} };
  const fillPolys = [];
  // Every line stroke / point stamp in bed space, for the
  // stroke-over-another-element's-fill check after the element loop.
  const marks = [];
  let bedBbox = null;

  const outOfSafe = (points) => points.some(([x, y]) => x < CONSTRAINTS.safeMin || x > CONSTRAINTS.safeMax || y < CONSTRAINTS.safeMin || y > CONSTRAINTS.safeMax);
  const rnd = (v) => +v.toFixed(2);
  const rndBox = (b) => ({ minX: rnd(b.minX), minY: rnd(b.minY), maxX: rnd(b.maxX), maxY: rnd(b.maxY) });

  for (const el of scene.elements) {
    const r = resolved[el.id];
    if (!r) continue;
    const label = el.label || el.id;
    const tex = scene.textures[el.id] || {};
    const entry = { id: el.id, label, kind: el.kind, role: el.role || "" };
    report.elements.push(entry);

    // One job shape for every brush call -- `pts` is always a point list,
    // one point long for a stamp-shaped use (TF.STAMPS dispatches on that
    // in runJobs() below, calling it (em, x, y, options) instead of
    // (em, pts, options); the catalog never needs to know that, only
    // runJobs() does).
    const addBrushJob = (slot, fn, options, pts, extra = {}) => {
      const tag = `"${label}" ${slot}`;
      if (!isBrush(fn)) { errors.push(`${tag}: "${fn}" is not a brush (${BRUSH_NAMES.join(", ")}).`); return false; }
      // Defense in depth: a stamp-only fn handed more than one point would
      // silently draw at just the first one (see isStrokeCapable) rather
      // than error -- callers should already be filtering this via
      // isPointSafe/isStrokeCapable, but this backstops any that aren't.
      if (pts.length > 1 && fn in TF.STAMPS) { errors.push(`${tag}: "${fn}" only works at a single point, not along a path of ${pts.length}.`); return false; }
      const opts = cleanOptions(fn, options);
      const rule = checkBrushRules(fn, opts, tag);
      errors.push(...rule.errors); warnings.push(...rule.warnings);
      // A bare single [x,y] point (no arc-length tag) is fine for a true
      // TF.STAMPS function -- runJobs calls it with (x, y) directly -- but
      // a point-safe TF.BRUSHES function (the *Dotted family: blobDotted,
      // dotted, directionalBlobDotted, hairyDotted) walks pts via
      // walkArcLengthStops, which reads pts[i][2] as cumulative arc length.
      // Without it, totalLength() returns undefined, the walk's stop loop
      // becomes `0 <= NaN` (false), and it silently emits nothing -- no
      // error, just a dot that never happened. Tag it with s=0 so the
      // single stop walkArcLengthStops is designed to produce here actually
      // gets walked.
      const safePts = (pts.length === 1 && pts[0].length === 2 && !(fn in TF.STAMPS)) ? [[pts[0][0], pts[0][1], 0]] : pts;
      jobs.push({ elementId: el.id, slot, label, fn, options: { ...opts, ...(extra.brushOverride || {}) }, pts: safePts, newPattern: extra.newPattern ?? true });
      return true;
    };

    try {
      if (r.kind === "point") {
        // atList has one entry for a plain point, several for a GROUP
        // (repeated markers sharing this element's one texture) -- each
        // gets its own stamp job, same fn/options.
        const pts = r.atList.map(tf.map);
        entry.at = pts.length === 1 ? pts[0].map(rnd) : pts.map((p) => p.map(rnd));
        entry.count = pts.length;
        bedBbox = mergeBbox(bedBbox, bboxOf(pts));
        if (pts.some((p) => outOfSafe([p]))) errors.push(`"${label}": a point is outside the safe area (${CONSTRAINTS.safeMin}-${CONSTRAINTS.safeMax}mm).`);
        if (tex.brush?.fn) {
          marks.push({ id: el.id, label, points: pts });
          if (!isPointSafe(tex.brush.fn)) errors.push(`"${label}" brush: "${tex.brush.fn}" is not point-safe (${[...POINT_SAFE_BRUSHES].join(", ")}).`);
          else for (const p of pts) addBrushJob("brush", tex.brush.fn, tex.brush.options, [p]);
        }
      } else if (r.kind === "line") {
        // strokes has one entry for a plain line, several for a GROUP
        // (repeated disconnected strokes -- axis ticks, gridlines --
        // sharing this element's one texture); each stroke is its own
        // brush job (own travel/newPattern), same fn/options.
        const strokeSets = r.strokes.map((pts) => pts.map(tf.map));
        let bb = null;
        for (const pts of strokeSets) bb = mergeBbox(bb, bboxOf(pts));
        entry.bbox = rndBox(bb);
        entry.length = rnd(strokeSets.reduce((s, pts) => s + polylineLength(pts), 0));
        entry.strokeCount = strokeSets.length;
        if (strokeSets.length === 1) {
          const pts = strokeSets[0];
          entry.start = pts[0].map(rnd); entry.end = pts[pts.length - 1].map(rnd);
          if (r.dense && pts.length > 5) {
            const n = 5;
            entry.samples = [];
            for (let i = 0; i < n; i++) entry.samples.push(pts[Math.round(((pts.length - 1) * i) / (n - 1))].map(rnd));
          }
        } else {
          entry.samples = strokeSets.slice(0, 8).map((pts) => pts[0].map(rnd));
        }
        bedBbox = mergeBbox(bedBbox, bb);
        if (strokeSets.some((pts) => outOfSafe(pts))) errors.push(`"${label}": path leaves the safe area (${CONSTRAINTS.safeMin}-${CONSTRAINTS.safeMax}mm).`);
        if (tex.brush?.fn) {
          marks.push({ id: el.id, label, points: strokeSets.flat() });
          for (const pts of strokeSets) addBrushJob("brush", tex.brush.fn, tex.brush.options, TF.polylineToPts(pts, r.dense ? null : SAMPLE_STEP));
        }
      } else if (r.kind === "region") {
        const poly = r.polygon.map(tf.map);
        const bb = bboxOf(poly);
        entry.bbox = rndBox(bb); entry.area = rnd(polygonArea(poly)); entry.closureGap = rnd(r.closureGap);
        // For an app-solved region: the x span actually used, where the
        // bounds were found to cross, and how the span was decided -- so
        // "shade between x=1 and x=3" is checkable against numbers rather
        // than against what the model said it did.
        if (r.meta) Object.assign(entry, r.meta);
        entry.width = rnd(bb.maxX - bb.minX); entry.height = rnd(bb.maxY - bb.minY);
        bedBbox = mergeBbox(bedBbox, bb);
        if (outOfSafe(poly)) errors.push(`"${label}": boundary leaves the safe area (${CONSTRAINTS.safeMin}-${CONSTRAINTS.safeMax}mm).`);
        if (tex.outline?.fn) addBrushJob("outline", tex.outline.fn, tex.outline.options, TF.polylineToPts([...poly, poly[0]], SAMPLE_STEP));
        if (tex.fill?.fn) {
          fillPolys.push({ id: el.id, label, poly });
          const pat = tex.fill.pattern || { kind: "hatch" };
          const gen = generatePattern(pat, poly, tf, `"${label}" fill`);
          entry.fill = { kind: pat.kind, strokes: gen.strokes.length, stamps: gen.stamps.length, strokeLength: rnd(gen.strokes.reduce((s, st) => s + polylineLength(st.points), 0)) };
          const patRule = checkPatternRules(pat, tex.fill.fn, tf.scale, `"${label}" fill`);
          errors.push(...patRule.errors); warnings.push(...patRule.warnings);
          // The checkerboard parity is the one thing about a diamond fill
          // that cannot be eyeballed, and the library ships the explicit
          // verifier for exactly this -- it was simply never called here.
          if (pat.kind === "diamond" && gen.diamonds) {
            const v = TF.verifyCheckerboard(gen.diamonds, (Number(pat.diag) || PATTERN_OPTIONS.diamond.diag.def) * tf.scale);
            if (v.violations !== 0) errors.push(`"${label}" fill: diamond checkerboard has ${v.violations} adjacency violation(s) of ${v.checked} checked -- neighbouring cells share a fill state.`);
          }
          const needsStamp = STAMP_PATTERNS.includes(pat.kind);
          if (needsStamp && !isPointSafe(tex.fill.fn)) errors.push(`"${label}" fill: pattern "${pat.kind}" places points, so the fill brush must be point-safe (${[...POINT_SAFE_BRUSHES].join(", ")}), not "${tex.fill.fn}".`);
          else if (!needsStamp && !isStrokeCapable(tex.fill.fn)) errors.push(`"${label}" fill: pattern "${pat.kind}" draws strokes, so the fill brush must be a brush that can walk a path, not "${tex.fill.fn}".`);
          else if (needsStamp) {
            for (const at of gen.stamps) addBrushJob("fill", tex.fill.fn, tex.fill.options, [at]);
          } else {
            gen.strokes.forEach((st, i) => {
              addBrushJob("fill", tex.fill.fn, tex.fill.options, TF.polylineToPts(st.points, st.sparse ? null : SAMPLE_STEP),
                { brushOverride: st.brushOverride, newPattern: gen.newPatternOnce ? i === 0 : true });
            });
            if (gen.strokes.length && !gen.strokes.some((st) => st.points.length > 1)) warnings.push(`"${label}" fill: pattern produced no printable strokes inside the region.`);
          }
          if (!gen.strokes.length && !gen.stamps.length) warnings.push(`"${label}" fill: the pattern produced nothing inside the region.`);
        }
      }
    } catch (e) {
      errors.push(e && e.name === "PathTooSteepError" ? `"${label}": path is too steep to print -- ${e.message}` : String(e.message || e));
    }
  }

  // fill-on-fill overlap between different elements (polygon test)
  for (let i = 0; i < fillPolys.length; i++) {
    for (let j = i + 1; j < fillPolys.length; j++) {
      if (polygonsOverlap(fillPolys[i].poly, fillPolys[j].poly)) warnings.push(`fills of "${fillPolys[i].label}" and "${fillPolys[j].label}" overlap -- double deposition where they share area.`);
    }
  }

  // A stroke or stamp printed on top of ANOTHER element's fill -- the
  // nozzle passing over already-deposited material. The older single-call
  // page caught this with a bbox layout check over every call; this page
  // checked only fill-against-fill, so a marker or curve sitting inside a
  // shaded area went unflagged. Subsampled and bbox-prefiltered: a dense
  // curve can carry thousands of points and a sampled boundary hundreds of
  // edges, and one interior point is enough to prove the case.
  for (const m of marks) {
    for (const f of fillPolys) {
      if (m.id === f.id) continue;            // a region's own outline/fill is expected
      const fb = bboxOf(f.poly);
      const stride = Math.max(1, Math.ceil(m.points.length / 200));
      let hit = false;
      for (let i = 0; i < m.points.length && !hit; i += stride) {
        const [x, y] = m.points[i];
        if (x < fb.minX || x > fb.maxX || y < fb.minY || y > fb.maxY) continue;
        if (pointInPolygon(m.points[i], f.poly)) hit = true;
      }
      if (hit) warnings.push(`"${m.label}" prints over the fill of "${f.label}" -- fine if it is meant to stand taller, a nozzle collision risk if they print at the same height.`);
    }
  }

  // chart-role table
  const bars = report.elements.filter((e) => e.role === "bar" && e.bbox);
  if (bars.length) report.chart.bars = bars.map((e) => ({ label: e.label, x: e.bbox.minX, width: e.width, height: e.height }));
  const axes = report.elements.filter((e) => e.role === "axis" && e.bbox);
  if (axes.length) report.chart.axes = axes.map((e) => ({ label: e.label, from: e.start, to: e.end }));
  const curves = report.elements.filter((e) => e.role === "curve" && e.bbox);
  if (curves.length) report.chart.curves = curves.map((e) => ({ label: e.label, xRange: [e.bbox.minX, e.bbox.maxX], yRange: [e.bbox.minY, e.bbox.maxY], samples: e.samples }));
  report.bbox = bedBbox ? rndBox(bedBbox) : null;
  report.naturalBbox = naturalBbox ? rndBox(naturalBbox) : null;

  return { jobs, report, errors, warnings, bbox: bedBbox };
}

// ------------------------------------------------------------- gcode scan --

// Walks the emitted G-code tracking G90/G91 and absolute position so the
// bed-bounds check reasons about real coordinates (the segmented brush
// and the footer emit G91 relative moves). Counts retraction cycles.
export function scanGcode(lines) {
  let retractCycles = 0, absolute = true, px = null, py = null;
  // Running sum of E deltas. Not a machine-accurate filament model (it
  // ignores G92 resets) but a tripwire for a gross retraction-math bug in
  // a brush: real printing never drives the net this far negative.
  let eSum = 0, eMin = 0;
  const outOfBounds = [];
  const num = (line, axis) => {
    const m = line.match(new RegExp(`(?:^|\\s)${axis}(-?\\d+(?:\\.\\d+)?)`));
    return m ? parseFloat(m[1]) : null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    const cmd = line.split(/\s+/)[0];
    if (cmd === "G90") { absolute = true; continue; }
    if (cmd === "G91") { absolute = false; continue; }
    if (cmd === "G28") { px = 0; py = 0; continue; }
    if (cmd === "G92") { const gx = num(line, "X"), gy = num(line, "Y"); if (gx !== null) px = gx; if (gy !== null) py = gy; continue; }
    if (cmd !== "G0" && cmd !== "G1" && cmd !== "G2" && cmd !== "G3") continue;
    const e = num(line, "E");
    if (e !== null) {
      eSum += e;
      if (eSum < eMin) eMin = eSum;
      if (e < 0) retractCycles++;
    }
    const mx = num(line, "X"), my = num(line, "Y");
    if (absolute) { if (mx !== null) px = mx; if (my !== null) py = my; }
    else { if (mx !== null && px !== null) px += mx; if (my !== null && py !== null) py += my; }
    if (px !== null && (px < 0 || px > CONSTRAINTS.bed)) outOfBounds.push(`X${px.toFixed(2)} (line: ${line})`);
    if (py !== null && (py < 0 || py > CONSTRAINTS.bed)) outOfBounds.push(`Y${py.toFixed(2)} (line: ${line})`);
  }
  return { retractCycles, outOfBounds, eSum, eMin, negTrip: eMin < CONSTRAINTS.netExtrusionTrip };
}

// ---------------------------------------------------------------- runJobs --

/** jobs -> { gcode, digest, errors, warnings, ok }. */
export function runJobs(jobs, { material = "TPU" } = {}) {
  const errors = [], warnings = [];
  const em = new TF.Emitter();
  em.header(material === "PLA" ? { nozzleTemp: 205, bedTemp: 60, flowPercent: 100 } : {});
  for (const job of jobs) {
    try {
      if (job.newPattern) em.newPattern();
      // TF.STAMPS/TF.BRUSHES keep two call shapes internally -- (em, x, y,
      // options) vs (em, pts, options) -- purely mechanical, invisible to
      // the LLM and to every other part of this compiler, which only ever
      // deals in one unified `fn`/`pts` job shape.
      if (job.fn in TF.STAMPS) TF.STAMPS[job.fn](em, job.pts[0][0], job.pts[0][1], job.options);
      else TF.BRUSHES[job.fn](em, job.pts, job.options);
    } catch (e) {
      errors.push(`"${job.label}" ${job.slot}: ${e && e.message ? e.message : e}`);
    }
  }
  em.footer();
  const lines = em.lines;
  const gcode = TF.stripComments(lines.join("\n") + "\n");
  const scan = scanGcode(lines);
  for (const oob of scan.outOfBounds.slice(0, 5)) errors.push(`coordinate out of bed bounds: ${oob}`);
  if (scan.negTrip) errors.push(`net extrusion dips to ${scan.eMin.toFixed(2)}mm -- a retraction-math bug in one of the brushes, not a printable job.`);
  if (scan.retractCycles >= CONSTRAINTS.retractCyclesHard) errors.push(`${scan.retractCycles} retraction cycles -- over the ${CONSTRAINTS.retractCyclesHard} cap (TPU drive-gear damage risk).`);
  else if (scan.retractCycles >= CONSTRAINTS.retractCyclesWarn) warnings.push(`${scan.retractCycles} retraction cycles (soft cap ${CONSTRAINTS.retractCyclesWarn}) -- TPU can flat-spot; consider wider spacing.`);
  const digest = {
    lineCount: lines.length, retractCycles: scan.retractCycles, boundsOk: scan.outOfBounds.length === 0,
    netExtrusionMm: +scan.eSum.toFixed(1), minNetExtrusionMm: +scan.eMin.toFixed(1),
  };
  return { gcode, digest, errors, warnings, ok: errors.length === 0 };
}

// ---------------------------------------------------------------- groups --
//
// A GROUP is a heading plus whichever real parameters the ui stage judged
// relevant to the current turn, each carrying its own short (1-3 word)
// label. It is presentation, not arithmetic: the panel shows those
// controls together, and each control edits its own option directly.
//
// This replaces two earlier designs in turn: first a weighted-knob model
// where the model invented targets and weights per turn and the page
// moved each one by direction x weight x (value - base) x range (too much
// at once -- inventing the relationships AND hiding the real numbers
// behind a slider, re-derived every turn); then a fixed attribute->option
// table (attributes.js) that traded that opacity for a closed, hand-
// maintained list the model could only select from, never adapt to a
// scene's actual textures. Now the ui stage picks real options straight
// from the scene per turn, with a label but no weight -- nothing transforms
// anyone's values, and nothing constrains the selection to a fixed list.

function slotObj(scene, elementId, slot) {
  const tex = scene.textures[elementId];
  return tex && tex[slot] && tex[slot].fn ? tex[slot] : null;
}

/** What a group member names, and where its value lives.
 *
 * A member is {level, elementId?, slot?, option}:
 *   level "graphic"  a property of the whole graphic -- only `scale`
 *   level "stroke"   an option that owns a brush's WALK (layer/pass
 *                    count, arc-length spacing, priming/retract brackets)
 *   level "brush"    an option of the brush's own local deposit (the
 *                    tags added in BRUSH_OPTIONS distinguish these two)
 *   level "pattern"  a fill pattern's own numeric field (hatch gap, grid
 *                    dx/dy, diamond diag -- a different bag entirely)
 *
 * For a fill slot the brush/stroke options and the pattern's own fields
 * are independently-named spaces; resolveMember accepts either level
 * spelling by looking the name up when `level` is absent (the model does
 * not have to know). Returns null when the option is not a recognized
 * numeric field of the texture actually in that slot. */
export function resolveMember(scene, member) {
  const { elementId, slot, option } = member || {};
  if (member?.level === "graphic" || (!elementId && !slot)) {
    if (option !== "scale") return null;
    return { level: "graphic", spec: GRAPHIC_OPTIONS.scale, location: "graphic" };
  }
  const s = slotObj(scene, elementId, slot);
  if (!s) return null;
  const wantPattern = member.level === "pattern";
  const brushSpec = optionSpecFor(s.fn)[option];
  if (!wantPattern && brushSpec) return { level: brushSpec.level, s, spec: brushSpec, location: "options" };
  if (slot === "fill" && s.pattern) {
    const patSpec = (PATTERN_OPTIONS[s.pattern.kind] || {})[option];
    if (patSpec) return { level: "pattern", s, spec: patSpec, location: "pattern" };
  }
  // asked for a pattern option that does not exist; fall back to the brush
  if (wantPattern && brushSpec) return { level: brushSpec.level, s, spec: brushSpec, location: "options" };
  return null;
}

/** Graphic-level parameters a group may surface. `scale` is stored as a
 * multiplier on the transform; the panel shows it as a percentage. */
export const GRAPHIC_OPTIONS = {
  scale: { kind: "num", def: 1, min: 0.1, max: 4, step: 0.05 },
};

/** Read / write a resolved member's current value. */
export function memberValue(scene, member) {
  const r = resolveMember(scene, member);
  if (!r) return undefined;
  if (r.location === "graphic") return scene.transform.scale;
  const bag = r.location === "pattern" ? r.s.pattern : r.s.options;
  return (bag || {})[member.option];
}

export function setMemberValue(scene, member, value) {
  const r = resolveMember(scene, member);
  if (!r) return false;
  if (r.location === "graphic") {
    if (Number(value) > 0) scene.transform.scale = Number(value);
    return true;
  }
  const bag = r.location === "pattern" ? (r.s.pattern = r.s.pattern || {}) : (r.s.options = r.s.options || {});
  if (value === null || value === undefined || value === "") delete bag[member.option];
  else bag[member.option] = value;
  return true;
}

/** Which named bag a member's value lives in -- "graphic", "options" or
 * "pattern". The panel needs it to read and write the right place. */
export function memberLocation(scene, member) {
  return resolveMember(scene, member)?.location ?? null;
}

/** The groups that surface a given option (so the panel can list
 * everything no group claims). */
export function groupsOf(scene, elementId, slot, option) {
  return (scene.groups || []).filter((g) => (g.members || []).some((m) => m.elementId === elementId && m.slot === slot && m.option === option));
}

/** How many distinct real elements a group's members touch -- a
 * graphic-level member (elementId undefined) never counts toward this. */
function distinctElementIds(group) {
  return [...new Set((group.members || []).map((m) => m.elementId).filter(Boolean))];
}

/** Every group NOT scoped to exactly one element -- zero (purely graphic,
 * e.g. a lone "scale") or several (a felt quality spanning multiple
 * elements, e.g. "tactility" pulling nLayers from more than one) -- shown
 * whole, unfiltered, as its own top-level card. A single-element group is
 * deliberately excluded: it already has a complete home in that element's
 * own card (see groupsForElement), so a second top-level copy would just be
 * a redundant duplicate of the exact same thing. */
export function topLevelGroups(scene) {
  return (scene.groups || []).filter((g) => distinctElementIds(g).length !== 1);
}

/** This element's own slice of EVERY group that has at least one member
 * here, whether that group is scoped to just this element or spans several.
 * Filtered down to only this element's members, keeping the group's
 * title/description for context. A member of a multi-element group
 * legitimately appears both here (inside this element's card) and, whole,
 * in topLevelGroups()'s rendering of that same group -- intentional, not a
 * duplicate to dedupe away: the top-level card is "see the whole quality
 * together," this is "see everything relevant to just this element."
 *
 * A group's graphic-level members ride along here only when this element is
 * the group's one real element -- i.e. the whole group is otherwise already
 * about to be nested in this element's card, so its graphic-level member
 * (e.g. "scale" alongside this element's own pattern spacing) belongs here
 * too rather than being silently dropped by an elementId match that can
 * never equal undefined. For a group spanning several real elements, a
 * graphic-level member has no single right element to attach to, so it only
 * shows in topLevelGroups()'s whole-group rendering. */
export function groupsForElement(scene, elementId) {
  return (scene.groups || [])
    .map((g) => {
      const ids = distinctElementIds(g);
      const soleElement = ids.length === 1 && ids[0] === elementId;
      const members = (g.members || []).filter((m) => m.elementId === elementId || (soleElement && !m.elementId));
      return { ...g, members };
    })
    .filter((g) => g.members.length);
}

// expandAttribute()/attributeGuideText() (attributes.js-backed) retired:
// the ui stage now selects whichever options it judges relevant to the
// turn's request directly from optionSpecsText()'s real option list,
// instead of being constrained to a fixed attribute->option table.

/** Drop members whose element/slot/option no longer exists (after a
 * geometry or texture change), then empty groups. Returns descriptions of
 * what was dropped. */
export function pruneGroups(scene) {
  const dropped = [];
  for (const g of scene.groups || []) {
    g.members = (g.members || []).filter((m) => {
      const ok = !!resolveMember(scene, m);
      if (!ok) dropped.push(`${g.title}: ${m.elementId || "graphic"}.${m.slot || ""}.${m.option}`);
      return ok;
    });
  }
  scene.groups = (scene.groups || []).filter((g) => g.members.length);
  return dropped;
}

// ------------------------------------------------------- summaries / text --

/** Compact scene description for the router and the stage prompts. */
export function sceneSummary(scene) {
  if (!scene.elements.length) return "(the scene is empty)";
  const lines = [`transform: scale ${scene.transform.scale}, origin ${scene.transform.origin ? JSON.stringify(scene.transform.origin) : "natural"}`];
  for (const el of scene.elements) {
    const tex = scene.textures[el.id] || {};
    const parts = [];
    for (const slot of slotsFor(el.kind)) {
      const s = tex[slot];
      if (s?.fn) parts.push(`${slot}=${s.fn}${slot === "fill" && s.pattern ? `/${s.pattern.kind}` : ""}`);
    }
    const groupCount = el.kind === "point" && Array.isArray(el.at) && Array.isArray(el.at[0]) ? el.at.length
      : el.kind === "line" && Array.isArray(el.paths) ? el.paths.length : null;
    lines.push(`${el.id} "${el.label || ""}" ${el.kind}${groupCount != null ? ` (group of ${groupCount})` : ""}${el.role ? ` role=${el.role}` : ""}${parts.length ? ` [${parts.join(", ")}]` : " [no texture]"}`);
  }
  if ((scene.groups || []).length) {
    lines.push("surfaced parameter groups: " + scene.groups.map((g) => `${g.id} "${g.title}" (${g.attribute}) -> ${(g.members || []).map((m) => `${m.elementId || "graphic"}.${m.option}`).join(", ")}`).join("; "));
  }
  return lines.join("\n");
}

/** Element geometry as the geometry stage should see / return it. */
export function elementsJson(scene, ids = null) {
  return scene.elements
    .filter((el) => !ids || ids.includes(el.id))
    .map((el) => ({
      id: el.id, label: el.label, kind: el.kind, role: el.role || "",
      geometry: el.kind === "line" ? (Array.isArray(el.paths) ? { paths: el.paths } : { path: el.path })
        : el.kind === "region" ? (el.between ? { between: el.between } : { boundary: el.boundary })
          : { at: el.at },
    }));
}

/** Textures as the texture / parameters stages should see them. */
export function texturesJson(scene, ids = null) {
  const out = [];
  for (const el of scene.elements) {
    if (ids && !ids.includes(el.id)) continue;
    const tex = scene.textures[el.id] || {};
    for (const slot of slotsFor(el.kind)) {
      const s = tex[slot];
      if (s?.fn) out.push({ elementId: el.id, slot, fn: s.fn, ...(slot === "fill" ? { pattern: s.pattern || null } : {}), options: s.options || {} });
    }
  }
  return out;
}

/** Option specs (numeric + semantic) for the brushes/stamps actually used
 * by the given elements -- what the parameters stage needs. */
function specRows(spec) {
  return Object.entries(spec).map(([k, m]) => {
    const range = m.kind === "enum" ? m.options.join("|") : m.kind === "nnum" ? "number or null" : `${m.min}..${m.max}`;
    return `  ${k}: default ${m.def === null ? "null" : m.def}, ${range}${OPTION_DESC[k] ? ` -- ${OPTION_DESC[k]}` : ""}`;
  });
}

export function optionSpecsText(scene, ids = null) {
  const fns = new Set();
  const patternKinds = new Set();
  for (const t of texturesJson(scene, ids)) {
    fns.add(t.fn);
    if (t.slot === "fill" && t.pattern && PATTERN_OPTIONS[t.pattern.kind]) patternKinds.add(t.pattern.kind);
  }
  const blocks = [];
  for (const fn of fns) blocks.push(`${fn} (brush${isPointSafe(fn) ? ", point-safe" : ""}):\n${specRows(optionSpecFor(fn)).join("\n")}`);
  // A fill has TWO option spaces: its brush's own options (above) and its
  // pattern's own numeric fields -- both are valid targets for an
  // group member or a direct options edit on that same {elementId, slot:
  // "fill"} pair; the app tells them apart by name, not by anything you
  // need to say.
  for (const kind of patternKinds) blocks.push(`${kind} (fill pattern, on any "fill" slot using it):\n${specRows(PATTERN_OPTIONS[kind]).join("\n")}`);
  return blocks.join("\n\n");
}

/** The geometry report as compact text: one line per element / chart
 * row, so the model (and the UI) can scan it without a pretty-printed
 * number per line. */
export function reportText(report) {
  if (!report) return "(no report yet)";
  const lines = [];
  lines.push(`transform: ${JSON.stringify(report.transform)}`);
  lines.push(`printed bbox: ${JSON.stringify(report.bbox)}  natural bbox: ${JSON.stringify(report.naturalBbox)}`);
  lines.push("elements:");
  for (const e of report.elements || []) lines.push("  " + JSON.stringify(e));
  const chart = report.chart || {};
  for (const [k, rows] of Object.entries(chart)) {
    lines.push(`${k}:`);
    for (const r of rows) lines.push("  " + JSON.stringify(r));
  }
  return lines.join("\n");
}

// ------------------------------------------------- stage output validation --

const parseJsonField = (v, what, errors, fallback = null) => {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch (e) { errors.push(`${what}: JSON did not parse (${e.message})`); return fallback; }
};

/** Parses/validates one stage's JSON output against the scene. Returns
 * { value, errors } -- value is the normalized output, errors are fatal. */
export function validateStageOutput(stage, out, scene) {
  const errors = [];
  const ids = new Set(scene.elements.map((e) => e.id));
  if (!out || typeof out !== "object") return { value: null, errors: ["output is not an object"] };

  if (stage === "route") {
    const route = ["geometry", "texture", "ui", "chat"].includes(out.route) ? out.route : null;
    if (!route) errors.push(`route must be geometry|texture|ui|chat (got "${out.route}")`);
    const targets = Array.isArray(out.targets) ? out.targets.filter((t) => ids.has(t)) : [];
    const acceptance = (Array.isArray(out.acceptance) ? out.acceptance : []).map((a) => String(a || "").trim()).filter(Boolean);
    return { value: { route, instruction: String(out.instruction || ""), targets, acceptance, reply: String(out.reply || "") }, errors };
  }

  if (stage === "geometry") {
    const elements = [];
    const seen = new Set();
    (Array.isArray(out.elements) ? out.elements : []).forEach((e, i) => {
      const what = `element ${i + 1}`;
      const g = parseJsonField(e.geometry, `${what} geometry`, errors, {});
      let id = typeof e.id === "string" && e.id.trim() ? e.id.trim() : "";
      if (!id || seen.has(id)) id = nextId({ elements: [...scene.elements, ...elements], groups: [] }, "el");
      seen.add(id);
      const el = { id, label: String(e.label || id), kind: e.kind, role: String(e.role || "") };
      if (e.kind === "line") { if (Array.isArray(g.paths)) el.paths = g.paths; else el.path = g.path; }
      else if (e.kind === "region") { if (g.between) el.between = g.between; else el.boundary = g.boundary; }
      else if (e.kind === "point") el.at = g.at;
      else errors.push(`${what}: kind must be line|region|point (got "${e.kind}")`);
      elements.push(el);
    });
    const transform = parseJsonField(out.transform, "transform", errors, null);
    return { value: { chat: String(out.chat || ""), elements, transform }, errors };
  }

  if (stage === "texture") {
    const textures = [];
    (Array.isArray(out.textures) ? out.textures : []).forEach((t, i) => {
      const what = `texture ${i + 1}`;
      if (!ids.has(t.elementId)) { errors.push(`${what}: elementId "${t.elementId}" does not exist`); return; }
      const el = scene.elements.find((e) => e.id === t.elementId);
      if (!slotsFor(el.kind).includes(t.slot)) { errors.push(`${what}: slot "${t.slot}" is not valid for a ${el.kind} (${slotsFor(el.kind).join("|")})`); return; }
      const fn = String(t.fn || "");
      const pattern = t.slot === "fill" ? parseJsonField(t.pattern, `${what} pattern`, errors, null) : null;
      if (fn) {
        if (el.kind === "point" && !isPointSafe(fn)) errors.push(`${what}: a point needs a point-safe brush (${[...POINT_SAFE_BRUSHES].join(", ")}), got "${fn}"`);
        else if ((el.kind === "line" || t.slot === "outline") && !isStrokeCapable(fn)) errors.push(`${what}: ${t.slot} needs a brush that can walk a path, got "${fn}"`);
        else if (t.slot === "fill") {
          if (!pattern || !PATTERN_KINDS.includes(pattern.kind)) errors.push(`${what}: fill pattern kind must be one of ${PATTERN_KINDS.join(", ")}`);
          else if (STAMP_PATTERNS.includes(pattern.kind) ? !isPointSafe(fn) : !isStrokeCapable(fn)) errors.push(`${what}: pattern "${pattern.kind}" needs a ${STAMP_PATTERNS.includes(pattern.kind) ? "point-safe brush" : "brush that can walk a path"}, got "${fn}"`);
        }
      }
      // The texture stage sets the numbers for the texture it chose --
      // the brush's own options and, for a fill, its pattern's fields,
      // named the same way and sorted out here. Choosing a texture and
      // choosing its values is one decision ("a hairy fill, strands about
      // 4mm apart"); splitting them across two calls meant the stage that
      // picked the texture could not say what it had in mind.
      const values = parseJsonField(t.options, `${what} options`, errors, {});
      const clean = {}, patternClean = {};
      if (fn) {
        const spec = optionSpecFor(fn);
        const patSpec = t.slot === "fill" && pattern ? (PATTERN_OPTIONS[pattern.kind] || {}) : {};
        for (const [k, v] of Object.entries(values || {})) {
          const meta = spec[k] || patSpec[k];
          if (!meta) { errors.push(`${what}: "${k}" is not an option of ${fn}${Object.keys(patSpec).length ? ` or its ${pattern.kind} pattern` : ""}`); continue; }
          const c = coerceOptionValue(meta, v);
          if (c.error) { errors.push(`${what}: "${k}" ${c.error} (got ${JSON.stringify(v)})`); continue; }
          if (c.skip) continue;
          if (k in spec) clean[k] = c.value; else patternClean[k] = c.value;
        }
      }
      textures.push({ elementId: t.elementId, slot: t.slot, fn, pattern, options: clean, patternOptions: patternClean });
    });
    return { value: { chat: String(out.chat || ""), textures }, errors };
  }

  if (stage === "ui") {
    // A group is a selection, not an assertion: the ui stage picks
    // whichever real parameters (from the textures actually in the scene)
    // it judges relevant to the turn's request, each with its own short
    // label. No attribute name to validate against, no direction/weight --
    // resolveMember() still does the one thing that has to be checked
    // (the option genuinely exists on that texture); everything else is
    // free-form curation.
    const groups = [];
    const seen = new Set();
    (Array.isArray(out.groups) ? out.groups : []).forEach((g, i) => {
      const what = `group ${i + 1}`;
      const membersRaw = parseJsonField(g.members, `${what} members`, errors, []);
      const members = [];
      (Array.isArray(membersRaw) ? membersRaw : []).forEach((m, j) => {
        const where = `${what} member ${j + 1}`;
        const resolved = resolveMember(scene, m);
        if (!resolved) {
          const s0 = m.elementId ? slotObj(scene, m.elementId, m.slot) : null;
          errors.push(`${where}: "${m.option}" is not a parameter of ${m.level === "graphic" || !m.elementId ? "the graphic" : `${m.elementId}.${m.slot}${s0 ? ` (${s0.fn})` : " (no texture)"}`}`);
          return;
        }
        const label = String(m.label || m.option).trim();
        if (!label) { errors.push(`${where}: needs a short label`); return; }
        members.push({
          level: resolved.level,
          ...(resolved.level === "graphic" ? {} : { elementId: m.elementId, slot: m.slot }),
          option: m.option,
          label,
        });
      });
      let id = typeof g.id === "string" && g.id.trim() ? g.id.trim() : "";
      if (!id || seen.has(id)) id = nextId({ elements: scene.elements, groups: [...(scene.groups || []), ...groups] }, "gr");
      seen.add(id);
      if (members.length) groups.push({ id, title: String(g.title || "relevant parameters"), description: String(g.description || ""), members });
    });
    return { value: { chat: String(out.chat || ""), groups }, errors };
  }

  if (stage === "judge") {
    // The judge reads the scene rather than writing to it, so there is
    // nothing to resolve against -- only its own shape to normalize.
    const failures = (Array.isArray(out.failures) ? out.failures : []).map((f) => ({
      criterion: String(f.criterion || ""),
      evidence: String(f.evidence || ""),
      suspectedStage: ["geometry", "texture", "ui"].includes(f.suspectedStage) ? f.suspectedStage : "geometry",
    })).filter((f) => f.criterion);
    // "pass with failures listed" is a contradiction; trust the list.
    const pass = !!out.pass && !failures.length;
    return { value: { pass, failures, note: String(out.note || "") }, errors: [] };
  }

  return { value: null, errors: [`unknown stage "${stage}"`] };
}

// ------------------------------------------------------------------ merge --

/** Geometry stage output -> scene. Keeps the textures and groups of ids
 * that survive; drops the rest (what was pruned is returned). */
export function mergeGeometry(scene, value) {
  scene.elements = value.elements;
  const ids = new Set(scene.elements.map((e) => e.id));
  for (const id of Object.keys(scene.textures)) if (!ids.has(id)) delete scene.textures[id];
  for (const el of scene.elements) {
    const tex = scene.textures[el.id];
    if (!tex) continue;
    for (const slot of Object.keys(tex)) if (!slotsFor(el.kind).includes(slot)) delete tex[slot];
  }
  if (value.transform && typeof value.transform === "object") {
    if (Number(value.transform.scale) > 0) scene.transform.scale = Number(value.transform.scale);
    if (Array.isArray(value.transform.origin) && value.transform.origin.length === 2) scene.transform.origin = value.transform.origin.map(Number);
    else if (value.transform.origin === null) scene.transform.origin = null;
  }
  return pruneGroups(scene);
}

/** Texture stage output -> scene: the brush/stamp, the fill pattern, and
 * the option values for both. Keeping a slot's existing values when the fn
 * is unchanged means "make it hairier" can adjust one number without the
 * stage having to restate the rest. `fn` of "" clears the slot. */
export function mergeTextures(scene, value) {
  for (const t of value.textures) {
    scene.textures[t.elementId] = scene.textures[t.elementId] || {};
    const tex = scene.textures[t.elementId];
    if (!t.fn) { delete tex[t.slot]; continue; }
    const prev = tex[t.slot];
    const same = prev && prev.fn === t.fn;
    const options = { ...(same ? prev.options || {} : {}), ...(t.options || {}) };
    const slot = { fn: t.fn, options };
    if (t.slot === "fill") {
      const samePattern = same && prev.pattern && t.pattern && prev.pattern.kind === t.pattern.kind;
      slot.pattern = { ...(samePattern ? prev.pattern : {}), ...(t.pattern || {}), ...(t.patternOptions || {}) };
    }
    tex[t.slot] = slot;
  }
  return pruneGroups(scene);
}

/** UI stage output -> scene. Groups are presentation only: they say what
 * the panel surfaces and under which heading. Nothing here touches a
 * value, which is exactly the point -- the numbers are the texture
 * stage's, and what the user sees in the panel is those same numbers. */
export function mergeUi(scene, value) {
  scene.groups = value.groups;
  return pruneGroups(scene);
}
