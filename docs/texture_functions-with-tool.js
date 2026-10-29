/**
 * texture_functions-with-tool.js -- PROTOTYPE fork of texture_functions.js,
 * used only by parametric-with-tool.html. Same deposited G-code as the
 * pinned texture_functions.js for every texture (verified by
 * tests/golden-brushes.mjs, a byte-for-byte golden diff), but
 * restructured around ONE idea: a texture is what happens between two
 * points.
 *
 *   SECTION 2  path engine  -- a formula path (samplePath) or an explicit
 *                             polyline (polylineToPts) becomes an
 *                             arc-length-tagged point list.
 *   SECTION 3  brushes      -- brush*(em, pts, options): what is deposited
 *                             along a point list.
 *   SECTION 4  patterns     -- hatchStrokes / diamondStrokes: how a region
 *                             becomes a list of strokes for a brush.
 *   SECTION 5  stamps       -- stamp*(em, cx, cy, options): what is
 *                             deposited at a single point.
 *
 * The old freeform*(em, xFunc, yFunc, ...) / *Dot / fill() entry points are
 * gone from this fork; the compiler in ../parametric-catalog-with-tool.js
 * samples paths, generates pattern strokes, calls em.newPattern() per
 * top-level element and dispatches through BRUSHES / STAMPS. Comments
 * document only the FINAL current behavior -- see texture_functions.js (or
 * ../../texture_docs/) for the historical tuning log.
 *
 * ============================================================================
 * SECTION 1: CORE INFRASTRUCTURE (Emitter, shared constants, e-rate math)
 * ============================================================================
 */

// ---------------------------------------------------------------- globals --
export const FILAMENT_DIA = 1.75;
export const FIL_AREA = Math.PI * (FILAMENT_DIA / 2) ** 2;

export const NOZZLE_TEMP = 220;   // TPU default
export const BED_TEMP = 50;
export const RETRACT_MM = 1.3;
export const RETRACT_SPEED = 900; // 15mm/s -- fast retraction risks flat-spotting TPU at the drive gear
export const LINE_START_PRIME_MM = 0.3; // extra one-time prime per top-level printed element

export const TRAVEL_SPEED = 3000;
export const Z_HOP = 0.4;
export const LAYER_HEIGHT = 0.20;
export const FLOW_PERCENT = 180;

// Conservative placeholder pending a confirming print (same status as
// every other PRINT_LIMITS number) -- the extruder's maximum volumetric
// flow rate, for the Ender 3 V2 / Sprite direct-drive, 0.4mm nozzle, TPU.
// Well under Takahashi & Miyashita's ~11mm3/s (UIST'16 Adjunct,
// "Thickness Control Technique for Printing Tactile Sheets with FDM"),
// which was measured on a different printer and not specifically TPU --
// TPU buckles under back-pressure well before a rigid filament would, so
// published safe rates for it on a standard hotend commonly sit lower.
export const MAX_EXTRUSION_RATE_MM3_S = 4.0;

export const BED_X = 220.0;
export const BED_Y = 220.0;

/** mm of filament per mm of XY travel, for a bead of given width/height. */
export function eRate(width, height, flowMult = 1.0) {
  return (width * height * flowMult) / FIL_AREA;
}

export function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * Tracks running state (E, Z, XY, retracted-ness) across the whole file and
 * provides the common hop/travel/settle/retract primitives so every texture
 * function can be written as a small, self-contained unit.
 *
 * RELATIVE EXTRUSION (M83), not absolute: every `G1 E<value>` this class (and
 * every texture function) emits is a DELTA -- positive always means
 * extrude, negative always means retract, with no need to know any earlier
 * line's E value. `eTotal` is kept only for informational/debug totals
 * (e.g. total filament used) -- never itself written into a G-code line.
 */
export class Emitter {
  constructor() {
    this.lines = [];
    this.eTotal = 0;
    this.x = null;
    this.y = null;
    this.z = null;
    this.retracted = true;
    this.pendingPrimeBonus = false;
  }

  a(s) {
    this.lines.push(s);
  }

  /**
   * Call once at the start of each top-level printed element (a line, a
   * fill region, a dot). Adds LINE_START_PRIME_MM the NEXT time the
   * pattern un-retracts -- once only. Does not affect internal
   * layer-to-layer or dot-to-dot un-retracts within the same element.
   */
  newPattern() {
    this.pendingPrimeBonus = true;
  }

  header({ nozzleTemp = NOZZLE_TEMP, bedTemp = BED_TEMP, flowPercent = FLOW_PERCENT } = {}) {
    const a = (s) => this.a(s);
    a("G21"); a("G90"); a("M83");
    a("M220 S100");
    a(`M221 S${flowPercent}`);
    a(`M104 S${nozzleTemp}`);
    a(`M140 S${bedTemp}`);
    a(`M190 S${bedTemp}`);
    a(`M109 S${nozzleTemp}`);
    a("G28");
    a("G92 E0");
    a("G1 Z5 F3000");
    a("G1 X10 Y15 Z0.28 F5000");
    a("G1 X10 Y100 Z0.28 F1500 E12");
    a("G1 X10.4 Y100 Z0.28 F5000");
    a("G1 X10.4 Y15 Z0.28 F1500 E12");
    a("G92 E0");
    a("G1 Z2.0 F3000");
    // explicit retract (a relative delta) to establish the starting
    // retracted state
    a(`G1 E${(-RETRACT_MM).toFixed(4)} F${RETRACT_SPEED}`);
    this.eTotal = -RETRACT_MM;
    this.x = 10.4; this.y = 15.0; this.z = 2.0;
    this.retracted = true;
  }

  footer() {
    const a = (s) => this.a(s);
    a("G91");
    if (!this.retracted) {
      a(`G1 E${(-RETRACT_MM).toFixed(3)} F${RETRACT_SPEED}`);
      this.eTotal -= RETRACT_MM;
    }
    a("G1 Z10 F3000");
    a("G90");
    a(`G1 X0 Y${(BED_Y - 2).toFixed(0)} F3000`);
    a("M104 S0"); a("M140 S0"); a("M84");
  }

  /** Hop to a safe height, travel, settle, un-retract-if-needed. */
  goto(x, y, z) {
    const hopZ = Math.max(z, this.z ?? 0) + Z_HOP;
    this.a(`G1 Z${hopZ.toFixed(3)} F3000`);
    if (!this.retracted) {
      this.a(`G1 E${(-RETRACT_MM).toFixed(4)} F${RETRACT_SPEED}`);
      this.eTotal -= RETRACT_MM;
      this.retracted = true;
    }
    this.a(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} F${TRAVEL_SPEED}`);
    this.a(`G1 Z${z.toFixed(3)} F1500`);
    this.x = x; this.y = y; this.z = z;
  }

  unretract() {
    if (this.retracted) {
      const bonus = this.pendingPrimeBonus ? LINE_START_PRIME_MM : 0.0;
      this.pendingPrimeBonus = false;
      const amt = RETRACT_MM + bonus;
      this.a(`G1 E${amt.toFixed(4)} F${RETRACT_SPEED}`);
      this.eTotal += amt;
      this.retracted = false;
    }
  }

  retract() {
    if (!this.retracted) {
      this.a(`G1 E${(-RETRACT_MM).toFixed(4)} F${RETRACT_SPEED}`);
      this.eTotal -= RETRACT_MM;
      this.retracted = true;
    }
  }

  printMove(x, y, eAdd, speed, z = null) {
    this.eTotal += eAdd;
    const zpart = z !== null ? ` Z${z.toFixed(3)}` : "";
    this.a(`G1 X${x.toFixed(3)} Y${y.toFixed(3)}${zpart} E${eAdd.toFixed(4)} F${speed.toFixed(0)}`);
    this.x = x; this.y = y;
    if (z !== null) this.z = z;
  }

  dwell(ms) {
    this.a(`G4 P${Math.round(ms)}`);
  }
}

export function stripComments(text) {
  const out = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine;
    const idx = line.indexOf(";");
    if (idx !== -1) line = line.slice(0, idx).replace(/\s+$/, "");
    if (line.trim()) out.push(line);
  }
  return out.join("\n") + "\n";
}

/** Points for a solid filled circular dot. */
export function spiralDisc(center, radius, spacing = 0.28, ptsPerTurn = 20) {
  const nTurns = Math.max(1, Math.ceil(radius / spacing));
  const nPts = nTurns * ptsPerTurn;
  const pts = [];
  for (let k = 0; k <= nPts; k++) {
    const theta = (k * (nTurns * 2 * Math.PI)) / nPts;
    const r = radius * (theta / (nTurns * 2 * Math.PI));
    pts.push([center[0] + r * Math.cos(theta), center[1] + r * Math.sin(theta)]);
  }
  return pts;
}

/**
 * ============================================================================
 * SECTION 2: FREEFORM PATH ENGINE
 * ============================================================================
 * Any line follows x(t), y(t) -- a straight line, an angle, a sine wiggle,
 * an arc, or a hand-authored curve. samplePath() IS the "linked list of
 * points" a path resolves to: an arc-length-tagged point sequence every
 * texture function (line style or per-point stamp) walks.
 */

/**
 * The path has a direction change too sharp to print smoothly, even after
 * refining sampling -- the SHAPE is the problem (e.g. amplitude exceeding
 * wavelength), not the resolution. Reduce amplitude or increase
 * wavelength/radius.
 */
export class PathTooSteepError extends Error {
  constructor(message) {
    super(message);
    this.name = "PathTooSteepError";
  }
}

function turnAngleDeg(p0, p1, p2) {
  const v1 = [p1[0] - p0[0], p1[1] - p0[1]];
  const v2 = [p2[0] - p1[0], p2[1] - p1[1]];
  const a1 = Math.atan2(v1[1], v1[0]);
  const a2 = Math.atan2(v2[1], v2[0]);
  let turn = Math.abs(((a2 - a1) * 180) / Math.PI);
  return turn > 180 ? 360 - turn : turn;
}

/**
 * Samples (xFunc(t), yFunc(t)) at a fixed, fine step (deliberately NOT
 * adaptive). Verifies no consecutive-segment turn exceeds maxTurnDeg;
 * refines (halves step) up to maxRefineAttempts times; throws
 * PathTooSteepError if the violation persists.
 * Returns array of [x, y, s], s = cumulative arc length from tStart.
 */
export function samplePath(xFunc, yFunc, tStart, tEnd, {
  step = 0.1, maxTurnDeg = 15.0, maxRefineAttempts = 3,
} = {}) {
  const doSample = (step) => {
    const pts = [];
    let t = tStart;
    while (t < tEnd - 1e-9) {
      pts.push([xFunc(t), yFunc(t)]);
      t += step;
    }
    pts.push([xFunc(tEnd), yFunc(tEnd)]);
    return pts;
  };

  const maxTurn = (pts) => {
    let worst = 0.0;
    for (let i = 1; i < pts.length - 1; i++) {
      worst = Math.max(worst, turnAngleDeg(pts[i - 1], pts[i], pts[i + 1]));
    }
    return worst;
  };

  let pts = doSample(step);
  let attempts = 0;
  let prevWorst = null;
  let curStep = step;
  while (true) {
    const worst = maxTurn(pts);
    if (worst <= maxTurnDeg) break;
    if (attempts >= maxRefineAttempts) {
      throw new PathTooSteepError(
        `Path has a ${worst.toFixed(1)} degree direction change that ` +
        `persists after ${attempts} sampling refinements ` +
        `(step=${curStep.toFixed(4)}mm). Reduce amplitude or increase ` +
        `wavelength/radius rather than resampling further.`
      );
    }
    if (prevWorst !== null && worst >= prevWorst * 0.98) {
      throw new PathTooSteepError(
        `Path has a ${worst.toFixed(1)} degree direction change NOT ` +
        `improving with finer sampling (was ${prevWorst.toFixed(1)} ` +
        `degrees before refinement) -- the shape itself is too steep, ` +
        `not a resolution problem.`
      );
    }
    prevWorst = worst;
    curStep /= 2.0;
    pts = doSample(curStep);
    attempts += 1;
  }

  const out = [[pts[0][0], pts[0][1], 0.0]];
  let s = 0.0;
  for (let i = 1; i < pts.length; i++) {
    s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    out.push([pts[i][0], pts[i][1], s]);
  }
  return out;
}

/** Interpolates the (x,y) position at a specific arc-length distance
 * along a samplePath() result. */
export function pointAtArcLength(sampledPts, targetS) {
  if (targetS <= 0) return [sampledPts[0][0], sampledPts[0][1]];
  const last = sampledPts[sampledPts.length - 1];
  if (targetS >= last[2]) return [last[0], last[1]];
  let lo = 0, hi = sampledPts.length - 1;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (sampledPts[mid][2] <= targetS) lo = mid; else hi = mid;
  }
  const [x0, y0, s0] = sampledPts[lo];
  const [x1, y1, s1] = sampledPts[hi];
  const frac = s1 === s0 ? 0.0 : (targetS - s0) / (s1 - s0);
  return [x0 + frac * (x1 - x0), y0 + frac * (y1 - y0)];
}

export function totalLength(sampledPts) {
  return sampledPts[sampledPts.length - 1][2];
}

/**
 * The polyline counterpart of samplePath(): turns an explicit
 * [[x,y], ...] point list (corners allowed -- no steepness check, the
 * corners are deliberate) into the same arc-length-tagged [x, y, s] list
 * every brush walks. `step` densifies each straight run so a brush sees
 * the same point density it sees from a formula path (dash sub-segment
 * filtering and per-point height profiles depend on it); pass `null` to
 * keep only the given vertices (a solid brush on a straight run needs no
 * more than that).
 */
export function polylineToPts(points, step = 0.1) {
  if (!Array.isArray(points) || points.length < 2) throw new Error("polylineToPts needs at least 2 points");
  // Walk each straight run exactly the way samplePath() walks
  // xFunc(t) = p0 + t*u (unit direction, t += step while t < len - 1e-9,
  // then the exact end), and tag arc length by accumulated hypot between
  // consecutive points -- same float rounding, so a brush's arc-length
  // boundary tests give the same answer as on a formula path.
  const raw = [[points[0][0], points[0][1]]];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-9) continue;
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    if (step) {
      let t = step;
      while (t < len - 1e-9) { raw.push([x0 + t * ux, y0 + t * uy]); t += step; }
    }
    raw.push([x0 + len * ux, y0 + len * uy]);
  }
  const out = [[raw[0][0], raw[0][1], 0.0]];
  let s = 0.0;
  for (let i = 1; i < raw.length; i++) {
    s += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
    out.push([raw[i][0], raw[i][1], s]);
  }
  return out;
}

/**
 * ============================================================================
 * SECTION 3: BRUSHES -- what happens between two points
 * ============================================================================
 * Every PUBLIC brush is brush*(em, pts, options): `pts` is an arc-length-
 * tagged point list from samplePath() (a formula path) or polylineToPts()
 * (an explicit polyline). A brush never calls em.newPattern() -- the
 * caller does, once per top-level printed element (each line, each hatch
 * stroke, each dot, one whole diamond fill), exactly as the pre-refactor
 * functions did.
 *
 * Internally, the continuous-ridge brushes (solid, dashed, segmented,
 * variableThickness) are each split into two layers, matching the
 * Shape -> Stroke -> Brush model: the exported function is the STROKE --
 * it owns `pts`, any layer/pass looping, and retract/unretract sequencing
 * -- which calls a private, non-exported BRUSH primitive per adjacent
 * point pair. A Brush primitive is purely local: given two points and
 * explicit options, it decides what is deposited between them, with no
 * knowledge of layers, retraction, or the rest of the path. The `*Dotted`
 * family below (and Section 5's stamps) already have this shape --
 * walkArcLengthStops() is their Stroke, emit*Dot() their Brush -- and
 * needed no change.
 */

/** BRUSH: one straight swept segment from p0 to p1, at a constant given
 * width/height. Shared by brushSolid, brushDashed and brushSegmented --
 * the three continuous-ridge brushes whose height is either constant for
 * a whole pass or one of a small number of author-chosen discrete values,
 * so no per-call speed safety check is needed (contrast
 * emitVariableThicknessSegment below, whose height sweeps continuously
 * and DOES need one). `z`, like printMove()'s own z argument, is optional
 * -- omit it when the caller has already set height via goto() for a
 * whole pass (solid, dashed); pass it when height changes every segment
 * (segmented). */
function emitSweptSegment(em, p0, p1, { width, height, speed, flowMult = 1.0, z = null }) {
  const [x0, y0] = p0, [x1, y1] = p1;
  const seg = Math.hypot(x1 - x0, y1 - y0);
  if (seg < 1e-9) return;
  em.printMove(x1, y1, seg * eRate(width, height, flowMult), speed, z);
}

/** STROKE: continuous solid ridge. */
export function brushSolid(em, pts, {
  width = 0.5, nLayers = 2, speed = 400,
} = {}) {
  for (let layer = 1; layer <= nLayers; layer++) {
    const z = LAYER_HEIGHT * layer;
    em.goto(pts[0][0], pts[0][1], z);
    em.unretract();
    for (let i = 1; i < pts.length; i++) {
      emitSweptSegment(em, pts[i - 1], pts[i], { width, height: LAYER_HEIGHT, speed });
    }
    em.retract();
  }
  return pts;
}

/** STROKE: dashes -- segLen/gapLen measured along actual arc length. A
 * gap is not a Brush call at all, just travel: each "on" sub-range is
 * walked with the exact same per-layer goto/unretract/walk/retract
 * bracket as brushSolid's Stroke (reusing its Brush verbatim), and the
 * gap between one dash and the next is entirely the next dash's own
 * leading goto(). Because this loop only ever draws a dash (whatever
 * length remains, even a shortened final one) and never renders a gap as
 * its own step, it structurally cannot end on a gap. */
export function brushDashed(em, pts, {
  segLen, gapLen, width = 0.5, nLayers = 2, speed = 400,
} = {}) {
  if (typeof segLen !== "number" || typeof gapLen !== "number") {
    throw new TypeError(
      "dashed brush requires numeric segLen and gapLen in its options object, e.g. {segLen: 8, gapLen: 4}."
    );
  }
  const length = totalLength(pts);
  let s = 0.0;
  while (s < length - 1e-6) {
    const s2 = Math.min(s + segLen, length);
    const subStart = pointAtArcLength(pts, s);
    let subPts = pts.filter((p) => p[2] >= s && p[2] <= s2);
    if (subPts.length === 0 || subPts[0][2] > s + 1e-6) {
      subPts = [[subStart[0], subStart[1], s], ...subPts];
    }
    for (let layer = 1; layer <= nLayers; layer++) {
      const z = LAYER_HEIGHT * layer;
      em.goto(subPts[0][0], subPts[0][1], z);
      em.unretract();
      for (let i = 1; i < subPts.length; i++) {
        emitSweptSegment(em, subPts[i - 1], subPts[i], { width, height: LAYER_HEIGHT, speed });
      }
      em.retract();
    }
    s = s2 + gapLen;
  }
  return pts;
}

/**
 * Shared driver for the four per-point "*Dotted" brushes below: compute
 * arc-length stops every `gap` from 0 to the path length (inclusive),
 * optionally decide whether to walk them in reverse, optionally compute
 * each stop's local path heading, then call `stampFn(cx, cy, {headingDeg})`
 * at each stop.
 *
 * `reverseCheck`, if given, receives `{pts, length, gap, stops, step}` and
 * returns true/false -- each caller supplies its OWN reversal criterion
 * (they differ: directional lean vs. hair-pull direction), this driver
 * does not impose one. `withTangent` additionally hands the stamp a local
 * heading in degrees (only the directional-lean style needs this). `step`
 * is only the tangent half-width floor here (the caller already sampled).
 */
function walkArcLengthStops(pts, gap, step, { reverseCheck = null, withTangent = false } = {}, stampFn) {
  const length = totalLength(pts);
  const stops = [];
  for (let s = 0; s <= length + 1e-6; s += gap) stops.push(s);

  if (reverseCheck && reverseCheck({ pts, length, gap, stops, step })) stops.reverse();

  const tanH = Math.max(step, Math.min(gap * 0.5, 1.0));
  for (const s of stops) {
    const [cx, cy] = pointAtArcLength(pts, s);
    if (withTangent) {
      const a = pointAtArcLength(pts, Math.max(0, s - tanH));
      const b = pointAtArcLength(pts, Math.min(length, s + tanH));
      const headingDeg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      stampFn(cx, cy, { headingDeg });
    } else {
      stampFn(cx, cy, {});
    }
  }
  return pts;
}

/** Flat spiral-filled discs at regular arc-length intervals. */
export function brushDotted(em, pts, {
  gap = 10.0, dotRadius = 0.8, nLayers = 2, speed = 250, step = 0.1,
} = {}) {
  return walkArcLengthStops(pts, gap, step, {}, (cx, cy) => {
    const dotPts = spiralDisc([cx, cy], dotRadius);
    for (let layer = 1; layer <= nLayers; layer++) {
      const z = LAYER_HEIGHT * layer;
      em.goto(dotPts[0][0], dotPts[0][1], z);
      em.unretract();
      for (let i = 1; i < dotPts.length; i++) {
        const seg = dist(dotPts[i - 1], dotPts[i]);
        if (seg < 1e-9) continue;
        em.printMove(dotPts[i][0], dotPts[i][1], seg * eRate(0.42, LAYER_HEIGHT), speed);
      }
      em.retract();
    }
  });
}

/** Blob domes (the stampBlob() mechanism, SECTION 5) at regular arc-length
 * intervals -- the DEFAULT dotted brush, preferred over brushDotted()
 * unless a flat, spiral-filled disc is specifically needed. */
export function brushBlobDotted(em, pts, {
  gap = 10.0, diameter = 1.6, baseZ = 0.2, buildSteps = 6, taperFactor = 0.7,
  extrudeSpeed = 120, dwellMs = 2000, extrusionMultiplier = 1.3,
  retractMm = 4.0, postRetractDwellMs = 2000, baseExtraMm = 0.3,
  baseDwellMs = 1000, orbitRadius = null, orbitPts = 16, orbitSpeed = 600,
  orbitLoops = 3, orbitDwellMs = 2000, blobClearanceMm = 0.3,
  liftZ = 5.0, liftSpeed = 600, liftDwellMs = 1000, topOrbitLoops = 3,
  step = 0.1,
} = {}) {
  return walkArcLengthStops(pts, gap, step, {}, (cx, cy) => {
    emitBlobDot(em, cx, cy, {
      diameter, baseZ, buildSteps, taperFactor, extrudeSpeed, dwellMs,
      extrusionMultiplier, retractMm, postRetractDwellMs, baseExtraMm,
      baseDwellMs, orbitRadius, orbitPts, orbitSpeed, orbitLoops,
      orbitDwellMs, blobClearanceMm, liftZ, liftSpeed, liftDwellMs,
      topOrbitLoops,
    });
  });
}

/** `stampDirectionalBlob()`-mechanism dots at regular arc-length intervals
 * -- like `brushBlobDotted` but each dot LEANS along the path tangent at
 * that point (a curved line produces blobs that each rake "downstream").
 * `azimuthDeg` is an OFFSET added to that local tangent, in degrees CCW --
 * 0 (default) leans exactly along the direction of travel. `gap` defaults
 * to one `diameter` so adjacent dots' base circles just touch and the
 * drags chain into a continuous raked ridge. `stampOrder` (default
 * "auto"): if the (offset) lean at the path start points forward along the
 * path, the line is stamped in reverse so each apex leans back over
 * already-placed (cooled) dots rather than toward the fresh next one. */
export function brushDirectionalBlobDotted(em, pts, {
  gap = null, diameter = 2.0, azimuthDeg = 0, baseZ = 0.2, buildSteps = 6,
  taperFactor = 0.7, extrudeSpeed = 120, dwellMs = 2000,
  extrusionMultiplier = 1.3, retractMm = 4.0, postRetractDwellMs = 2000,
  baseExtraMm = 0.3, baseDwellMs = 1000, dragSpeed = 600,
  stampOrder = "auto", step = 0.1,
} = {}) {
  const g = gap ?? diameter;
  return walkArcLengthStops(pts, g, step, {
    withTangent: true,
    reverseCheck: ({ pts, length, gap, stops, step }) => {
      if (stampOrder === "reverse") return true;
      if (stampOrder !== "auto") return false;
      if (stops.length <= 1) return false;
      const tanH = Math.max(step, Math.min(gap * 0.5, 1.0));
      const a = pointAtArcLength(pts, Math.max(0, 0 - tanH));
      const b = pointAtArcLength(pts, Math.min(length, 0 + tanH));
      const headingDeg0 = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      const azR = ((headingDeg0 + azimuthDeg) * Math.PI) / 180;
      const ax = Math.cos(azR), ay = Math.sin(azR);
      const p0 = pointAtArcLength(pts, 0);
      const p1 = pointAtArcLength(pts, Math.min(length, gap));
      return ax * (p1[0] - p0[0]) + ay * (p1[1] - p0[1]) > 0;
    },
  }, (cx, cy, { headingDeg }) => {
    emitDirectionalBlobDot(em, cx, cy, {
      diameter, azimuthDeg: headingDeg + azimuthDeg, baseZ, buildSteps, taperFactor,
      extrudeSpeed, dwellMs, extrusionMultiplier, retractMm,
      postRetractDwellMs, baseExtraMm, baseDwellMs, dragSpeed,
    });
  });
}

/** BRUSH: one vertical-lift strand at the nozzle's CURRENT XY position --
 * a point-op, like the *Dotted family's emit*Dot() functions, not a
 * between-two-points segment. No travel here: the Stroke below has
 * already positioned the nozzle and stays un-retracted at `baseZ` between
 * calls, trading the *Dotted family's full retract-travel-unretract cycle
 * per stop for a bare G0 move -- cheaper over a dense line of strands, at
 * the cost of the Emitter's own retract bookkeeping (deliberately left to
 * the Stroke, not this function, since it spans multiple strands). */
function emitHairyStrand(em, { esegmentMm, retractMm, dwellMs, smallLift, bigLift, baseZ }) {
  em.a(`G1 E${esegmentMm.toFixed(4)} F500`);
  em.eTotal += esegmentMm;
  const z1 = baseZ + smallLift;
  em.a(`G0 Z${z1.toFixed(3)}`);
  em.z = z1;
  em.dwell(dwellMs);
  const z2 = z1 + bigLift;
  em.a(`G0 Z${z2.toFixed(3)} F600`);
  em.z = z2;
  em.a(`G1 E${(-retractMm).toFixed(4)} F${RETRACT_SPEED}`);
  em.eTotal -= retractMm;
}

/** STROKE: vertical-lift hair strands at regular arc-length intervals --
 * one emitHairyStrand() call per root, with a plain G0 travel (not
 * walkArcLengthStops(), which doesn't handle travel and whose callers
 * each do a full goto() cycle per stop; this Stroke's cheaper single
 * un-retract for the whole line is the point). CAUTION: each strand is
 * still a retract/un-retract cycle -- mind the retraction-cycle cap
 * before using a dense spacing over a long path. */
export function brushHairy(em, pts, {
  spacing = 2.0, esegmentMm = 1.2, retractMm = 1.3, dwellMs = 400,
  smallLift = 0.2, bigLift = 4.0, baseZ = 0.3, speed = 200,
} = {}) {
  const length = totalLength(pts);
  const nRoots = Math.floor(length / spacing) + 1;
  const first = pointAtArcLength(pts, 0);
  em.goto(first[0], first[1], baseZ);
  em.unretract();
  for (let i = 0; i < nRoots; i++) {
    const s = i * spacing;
    emitHairyStrand(em, { esegmentMm, retractMm, dwellMs, smallLift, bigLift, baseZ });
    // Travel while still lifted (at bigLift height), THEN descend to
    // baseZ at the new position -- keeps the nozzle clear of the strand
    // just placed instead of dragging through it at print height.
    if (i < nRoots - 1) {
      const [nx, ny] = pointAtArcLength(pts, s + spacing);
      em.a(`G0 X${nx.toFixed(3)} Y${ny.toFixed(3)} F${speed}`);
      em.x = nx; em.y = ny;
    }
    em.a(`G0 Z${baseZ.toFixed(3)} F600`);
    em.z = baseZ;
  }
  em.retracted = true;
  return pts;
}

/** Discrete "hairy dots" (see emitHairyDot() in SECTION 5) at regular
 * arc-length intervals -- each stamp is an anchor blob plus ONE pulled hair
 * strand, not `brushHairy`'s simpler point-stamp. Shares `brushHairy`'s
 * retraction-cycle-count caution (one retract/unretract PER strand).
 * `stampOrder` (default "auto"): if the hair's XY projection leans FORWARD
 * along the path (toward the next dot), the line is stamped in REVERSE so
 * every strand trails behind its own dot, away from where the nozzle heads
 * next. */
export function brushHairyDotted(em, pts, {
  gap = 10.0, rootDiameter = 2.0, baseZ = 0.2, buildSteps = 6,
  taperFactor = 0.7, extrudeSpeed = 120, baseExtraMm = 0.3,
  baseDwellMs = 1000, dwellMs = 2000, extrusionMultiplier = 1.3,
  hairThickness = null, hairLength = 10.0, pullExtrudeSpeed = 150,
  beadFlowMult = 3.5, dryRiseFeedDrop = 10, retractMm = 4.0,
  postRetractDwellMs = 500, hairDirection = "top",
  hairAzimuthDeg = null, hairElevationDeg = null, stringMm = 2.0,
  hairSpeed = 8000, clearanceZ = 0.5, clearanceSpeed = 600,
  overtravelMm = 2.0, overtravelSpeed = 600,
  stampOrder = "auto", step = 0.1,
} = {}) {
  return walkArcLengthStops(pts, gap, step, {
    reverseCheck: ({ pts, length, gap, stops }) => {
      if (stampOrder === "reverse") return true;
      if (stampOrder !== "auto") return false;
      if (stops.length <= 1) return false;
      const { dx: hx, dy: hy } = resolveHairDir(hairDirection, hairAzimuthDeg, hairElevationDeg);
      if (Math.hypot(hx, hy) <= 1e-6) return false;
      const p0 = pointAtArcLength(pts, 0);
      const p1 = pointAtArcLength(pts, Math.min(length, gap));
      return (hx * (p1[0] - p0[0]) + hy * (p1[1] - p0[1])) > 0;
    },
  }, (cx, cy) => {
    emitHairyDot(em, cx, cy, {
      rootDiameter, baseZ, buildSteps, taperFactor, extrudeSpeed,
      baseExtraMm, baseDwellMs, dwellMs, extrusionMultiplier,
      hairThickness, hairLength, pullExtrudeSpeed, beadFlowMult,
      dryRiseFeedDrop, retractMm, postRetractDwellMs, hairDirection,
      hairAzimuthDeg, hairElevationDeg, stringMm, hairSpeed,
      clearanceZ, clearanceSpeed, overtravelMm, overtravelSpeed,
    });
  });
}

/** STROKE: alternating thin/fat segments -- a continuous, single-layer
 * line that switches bead WIDTH between two segment types, each with its
 * own LENGTH: `thinWidth` x `thinLen`, then `fatWidth` x `fatLen`,
 * repeating to the end of the path. Each segment type also has its own
 * bead HEIGHT -- the fat segment sitting a little higher is what lets its
 * extra volume spread into a genuinely wider bead instead of doming at a
 * fixed low Z. No retract between segments (the line is continuous); one
 * prime at the start, one retract at the very end.
 *
 * Absolute (G90) throughout, like every other brush in this file --
 * height changes are embedded in each emitSweptSegment call's own `z`
 * argument (one combined G1 X/Y/Z/E line per segment) instead of the
 * separate relative-mode G91 XY move + standalone Z-delta line this used
 * to hand-write. That removes three things the old G91 approach had:
 * accumulated rounding drift from many small relative deltas, the
 * Emitter's own em.x/em.y/em.z going stale mid-function (this used to
 * track curX/curY itself and only re-sync at the very end), and the
 * silent-failure risk of an exception leaving the machine stuck in
 * relative mode. It also lets this share emitSweptSegment with
 * brushSolid/brushDashed instead of needing its own deposition mechanics. */
export function brushSegmented(em, pts, {
  thinLen = 8.0, thinWidth = 0.8, thinHeight = 0.2, thinSpeed = 130,
  fatLen = 4.0, fatWidth = 1.6, fatHeight = 0.3, fatSpeed = 60,
  flowMult = 1.4, segDwellMs = 250,
  // eprime: one-time prime after goto() leaves the nozzle retracted --
  // just over the RETRACT_MM (1.3mm) the goto pulled.
  eprime = 1.6, primedwellS = 1.0, retractMm = 4.0, retractSpeed = 1000,
} = {}) {
  const length = totalLength(pts);

  const first = pointAtArcLength(pts, 0);
  em.goto(first[0], first[1], thinHeight);   // first segment is thin (i=0)
  em.a(`G1 E${eprime.toFixed(4)} F150`);
  em.eTotal += eprime;
  em.dwell(primedwellS * 1000);
  em.retracted = false;

  let curPt = first;
  let s = 0, i = 0;
  while (s < length - 1e-6) {
    const fat = i % 2 === 1;
    const segLen = fat ? fatLen : thinLen;
    const width  = fat ? fatWidth  : thinWidth;
    const height = fat ? fatHeight : thinHeight;
    const spd    = fat ? fatSpeed  : thinSpeed;
    const s1 = Math.min(s + segLen, length);
    const nextPt = pointAtArcLength(pts, s1);

    if (segDwellMs > 0) em.dwell(segDwellMs);
    emitSweptSegment(em, curPt, nextPt, { width, height, speed: spd, flowMult, z: height });

    curPt = nextPt;
    s = s1; i++;
  }
  em.a(`G1 E${(-retractMm).toFixed(4)} F${retractSpeed}`);
  em.eTotal -= retractMm;
  em.retracted = true;
  return pts;
}

/** BRUSH for brushVariableThickness ONLY -- not shared with
 * emitSweptSegment. Height sweeps continuously along this Stroke's whole
 * path (unlike solid's constant-per-layer height or segmented's two
 * author-tuned discrete heights), so there's no discrete "type" to have
 * pre-picked a safe speed for -- the cap has to be computed fresh per
 * call. Follows Takahashi & Miyashita, "Thickness Control Technique for
 * Printing Tactile Sheets with Fused Deposition Modeling" (UIST'16
 * Adjunct): F <= MaxExtrusionRate / (Height x Width) x 60. */
function emitVariableThicknessSegment(em, p0, p1, { width, height, speed, z }) {
  const [x0, y0] = p0, [x1, y1] = p1;
  const seg = Math.hypot(x1 - x0, y1 - y0);
  if (seg < 1e-9) return;
  const maxSpeed = (MAX_EXTRUSION_RATE_MM3_S / (width * height)) * 60;
  const effectiveSpeed = Math.min(speed, maxSpeed);
  em.printMove(x1, y1, seg * eRate(width, height), effectiveSpeed, z);
}

/** STROKE: the sine-wave bulge technique -- bead height varies as a
 * function of ARC LENGTH along the path. Walks the given `pts` exactly as
 * handed to it -- no new points are inserted here; resolution comes
 * entirely from however finely samplePath()/polylineToPts() already
 * sampled the path upstream. */
export function brushVariableThickness(em, pts, {
  hMin = 0.16, hMax = 0.9, wavelength = 8.0, beadWidth = 0.8,
  zGap = 0.25, speed = 25, peakDwellMs = 300,
} = {}) {
  const hAt = (s) => hMin + (hMax - hMin) * 0.5 * (1 + Math.sin((2 * Math.PI * s) / wavelength));

  const firstH = hAt(0);
  em.goto(pts[0][0], pts[0][1], firstH + zGap);
  em.unretract();
  let prevPt = pts[0];
  let prevH = firstH;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = prevPt;
    const [x1, y1, s1] = pts[i];
    if (Math.hypot(x1 - x0, y1 - y0) < 1e-9) continue;
    const h1 = hAt(s1);
    const hAvg = (prevH + h1) / 2.0;
    emitVariableThicknessSegment(em, prevPt, pts[i], { width: beadWidth, height: hAvg, speed, z: h1 + zGap });
    prevPt = pts[i];
    prevH = h1;
  }
  em.retract();
  return pts;
}

/**
 * ============================================================================
 * SECTION 4: PATTERNS -- stroke generators for filling a region
 * ============================================================================
 * A pattern turns a region (an axis-aligned rectangle {x0, y0, w, h} or a
 * polygon [[x,y], ...]) into a list of STROKES (point lists) that a brush
 * from SECTION 3 is then walked along. Patterns never emit G-code
 * themselves. Diamond/checkerboard is NOT a generic "lines at a gap"
 * pattern -- which cells get filled solid is a discrete checkerboard
 * parity selection -- so it is its own generator, never emulated with two
 * angled hatches.
 */

/** Exact (Liang-Barsky) clip of the infinite line (px,py)+s*(dx,dy)
 * against [x0,x1]x[y0,y1]. Returns [pStart,pEnd] or null if it misses. */
export function clipLineToRect(px, py, dx, dy, x0, y0, x1, y1) {
  let tMin = -Infinity, tMax = Infinity;
  const axes = [[px, dx, x0, x1], [py, dy, y0, y1]];
  for (const [p, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (p < lo || p > hi) return null;
      continue;
    }
    let t0 = (lo - p) / d;
    let t1 = (hi - p) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tMin = Math.max(tMin, t0);
    tMax = Math.min(tMax, t1);
    if (tMin > tMax) return null;
  }
  return [[px + tMin * dx, py + tMin * dy], [px + tMax * dx, py + tMax * dy]];
}

/** Returns the clipped [start,end] line segments needed to fill `region`
 * with parallel lines at `angleDeg`, `gap` apart. Recomputes from scratch
 * every call. */
export function regionFillLines(region, angleDeg, gap) {
  const { x0, y0, w, h } = region;
  const x1 = x0 + w, y1 = y0 + h;
  const theta = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(theta), dy = Math.sin(theta);
  const nx = -Math.sin(theta), ny = Math.cos(theta);

  const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
  const perpVals = corners.map(([cx, cy]) => cx * nx + cy * ny);
  const pMin = Math.min(...perpVals), pMax = Math.max(...perpVals);

  const segments = [];
  for (let p = pMin; p <= pMax; p += gap) {
    const px = p * nx, py = p * ny;
    const clipped = clipLineToRect(px, py, dx, dy, x0, y0, x1, y1);
    if (clipped) {
      const [[ax, ay], [bx, by]] = clipped;
      if (Math.hypot(bx - ax, by - ay) > 1e-6) segments.push(clipped);
    }
  }
  return segments;
}

/** Returns the clipped [start,end] segments needed to fill a polygon (an
 * array of [x,y] points, edges implied by consecutive pairs plus a
 * closing edge back to the first point -- SIMPLE, non-self-intersecting,
 * single contour, no holes; behavior is undefined otherwise) with
 * parallel lines at `angleDeg`, `gap` apart. The polygon analogue of
 * regionFillLines(): projects every vertex onto the sweep normal to find
 * the scan range, then for each swept line finds ALL intersections with
 * the polygon's edges (not just 2, as a rectangle guarantees), sorts them
 * along the sweep direction, and pairs up consecutive crossings as filled
 * sub-segments (standard scanline polygon fill). */
export function polygonFillLines(polygon, angleDeg, gap) {
  const theta = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(theta), dy = Math.sin(theta);
  const nx = -Math.sin(theta), ny = Math.cos(theta);

  const perpVals = polygon.map(([px, py]) => px * nx + py * ny);
  const pMin = Math.min(...perpVals), pMax = Math.max(...perpVals);

  const n = polygon.length;
  const segments = [];
  for (let p = pMin; p <= pMax; p += gap) {
    const ox = p * nx, oy = p * ny; // a point on this sweep line
    const hits = [];
    for (let i = 0; i < n; i++) {
      const [ax, ay] = polygon[i], [bx, by] = polygon[(i + 1) % n];
      const ex = bx - ax, ey = by - ay;
      const cx = ax - ox, cy = ay - oy;
      const denom = ex * dy - ey * dx;
      if (Math.abs(denom) < 1e-12) continue; // edge parallel to the sweep line
      const s = (ex * cy - ey * cx) / denom;   // position along the sweep line
      const u = (dx * cy - dy * cx) / denom;   // position along the edge
      if (u < -1e-9 || u > 1 + 1e-9) continue; // intersection outside this edge segment
      hits.push(s);
    }
    hits.sort((a, b) => a - b);
    for (let i = 0; i + 1 < hits.length; i += 2) {
      const s0 = hits[i], s1 = hits[i + 1];
      if (s1 - s0 > 1e-6) {
        segments.push([[ox + s0 * dx, oy + s0 * dy], [ox + s1 * dx, oy + s1 * dy]]);
      }
    }
  }
  return segments;
}

/** HATCH pattern: parallel strokes across `region` (rect or polygon) at
 * `angleDeg`, `gap` apart. Returns an array of 2-point strokes
 * [[x0,y0],[x1,y1]], each meant to be densified (polylineToPts) and
 * walked by one brush call with its own em.newPattern(). */
export function hatchStrokes(region, angleDeg = 0, gap = 4.0) {
  const segments = Array.isArray(region)
    ? polygonFillLines(region, angleDeg, gap)
    : regionFillLines(region, angleDeg, gap);
  return segments.filter(([p0, p1]) => Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) >= 1e-6);
}

function clipLineFamilyRegion(x0, y0, w, h, constVal, family) {
  const nScan = 200;
  let prevValid = false, runStart = null, prevPt = null, result = null;
  for (let k = 0; k <= nScan; k++) {
    const px = x0 + (w * k) / nScan;
    const py = family === "diff" ? px - constVal : constVal - px;
    const valid = py >= y0 && py <= y0 + h;
    if (valid && !prevValid) runStart = [px, py];
    if (!valid && prevValid) { result = [runStart, prevPt]; break; }
    prevValid = valid;
    prevPt = [px, py];
  }
  if (result === null && prevValid) result = [runStart, prevPt];
  return result;
}

/** DIAMOND pattern: lattice lines plus checkerboard-filled cells for a
 * rectangle region={x0,y0,w,h}. Indexes diamonds by their TRUE rotated-
 * square-grid coordinates (i,j) via center=(x0+half*(i+j), y0+half*(i-j)),
 * checkerboard parity=(i+j)%2. Returns {strokes, diamonds}: each stroke is
 * {points: [[x,y],[x,y]], brush: {nLayers, width, speed}} for the SOLID
 * brush (lattice at 400 mm/min, cell scanlines at 450), to be walked
 * WITHOUT densifying (`polylineToPts(points, null)`) under ONE
 * em.newPattern() for the whole fill. `diamonds` feeds
 * verifyCheckerboard(). DO NOT emulate this with two angled hatches. */
export function diamondStrokes(region, { diag = 8.0, fillGap = 0.6 } = {}) {
  const { x0, y0, w, h } = region;
  const strokes = [];
  const push = (seg, speed) => strokes.push({ points: seg, brush: { nLayers: 2, width: 0.4, speed } });
  const half = diag / 2.0;

  const diamonds = [];
  const N = Math.floor((w + h) / diag) + 3;
  for (let i = -N; i <= N; i++) {
    for (let j = -N; j <= N; j++) {
      const cx = x0 + half * (i + j);
      const cy = y0 + half * (i - j);
      if (cx < x0 - diag || cx > x0 + w + diag) continue;
      if (cy < y0 - diag || cy > y0 + h + diag) continue;
      diamonds.push([cx, cy, (i + j) % 2 === 0]);
    }
  }

  const diffConsts = new Set(), sumConsts = new Set();
  for (const [cx, cy] of diamonds) {
    diffConsts.add(Math.round((cx - cy - half) * 10000) / 10000);
    diffConsts.add(Math.round((cx - cy + half) * 10000) / 10000);
    sumConsts.add(Math.round((cx + cy - half) * 10000) / 10000);
    sumConsts.add(Math.round((cx + cy + half) * 10000) / 10000);
  }

  for (const c of [...diffConsts].sort((a, b) => a - b)) {
    const seg = clipLineFamilyRegion(x0, y0, w, h, c, "diff");
    if (seg) push(seg, 400);
  }
  for (const c of [...sumConsts].sort((a, b) => a - b)) {
    const seg = clipLineFamilyRegion(x0, y0, w, h, c, "sum");
    if (seg) push(seg, 400);
  }

  for (const [cx, cy, filled] of diamonds) {
    if (!filled) continue;
    for (let yy = cy - half + fillGap; yy < cy + half - 1e-6; yy += fillGap) {
      if (yy >= y0 && yy <= y0 + h) {
        const ww = half - Math.abs(yy - cy);
        if (ww > 0.05) {
          const xa = Math.max(x0, cx - ww);
          const xb = Math.min(x0 + w, cx + ww);
          if (xb > xa) push([[xa, yy], [xb, yy]], 450);
        }
      }
    }
  }
  return { strokes, diamonds };
}

/** Explicit adjacency verification -- the ONLY acceptable way to confirm
 * diamond fill correctness. Visual inspection is NOT sufficient. Always
 * call this after generating/modifying diamond fill and confirm
 * violations === 0 before trusting the output. */
export function verifyCheckerboard(diamonds, diag) {
  const half = diag / 2.0;
  const lookup = new Map();
  for (const [cx, cy, filled] of diamonds) {
    lookup.set(`${Math.round(cx * 1000) / 1000},${Math.round(cy * 1000) / 1000}`, filled);
  }
  let checked = 0, violations = 0;
  const offsets = [[half, half], [half, -half], [-half, half], [-half, -half]];
  for (const [cx, cy, filled] of diamonds) {
    for (const [ddx, ddy] of offsets) {
      const key = `${Math.round((cx + ddx) * 1000) / 1000},${Math.round((cy + ddy) * 1000) / 1000}`;
      if (lookup.has(key)) {
        checked += 1;
        if (lookup.get(key) === filled) violations += 1;
      }
    }
  }
  return { checked, violations };
}

/**
 * ============================================================================
 * SECTION 5: STAMPS -- what happens at one point
 * ============================================================================
 * stamp*(em, cx, cy, options). Like brushes, a stamp never calls
 * em.newPattern(); the caller does once per standalone dot (the *Dotted
 * brushes above call the same emit* mechanisms per stop under a single
 * newPattern() for the whole line).
 */

/**
 * Shared point-extrusion mechanism for stampBlob() / brushBlobDotted():
 * builds a small dome by extruding WHILE rising in Z (no XY movement),
 * dwell, retract, orbit around the dome at its own height, then (via the
 * caller's next goto()) travel to the next spot. `diameter` is the primary
 * sizing knob; filament amount is DERIVED from it via a standoff-cylinder
 * + hemispherical-dome volume model, converted through FIL_AREA and scaled
 * by `extrusionMultiplier`.
 *
 * The rise is split into `buildSteps` increments, extruding at each step,
 * tapering toward the top by `taperFactor` (deliberate "coasting" so
 * residual nozzle pressure finishes the tip instead of a hard stop). The
 * first step also carries the priming restoration (folded in rather than
 * emitted as a stationary E-only line -- extrusion and motion are never
 * separated here) plus `baseExtraMm`, a deliberately bigger first-contact
 * blob meant to spread and stick to the bed before the rest piles on top,
 * followed by its own `baseDwellMs` dwell.
 *
 * `retractMm` (default 4.0mm) is dot-specific, larger than the shared
 * global default (1.3mm) -- confirmed on hardware to reduce stringing for
 * this deposition method; only the distance is increased; speed stays at
 * the global default (TPU filament-damage caution: don't retract fast).
 *
 * Anti-stringing: after retract + `postRetractDwellMs`, trace an orbit
 * (`orbitRadius`, default the dot's own radius) around (cx, cy) at the
 * dome's own top height, repeated `orbitLoops` times, no extrusion --
 * confirmed on hardware to reduce stringing. Pass `orbitRadius: 0` to
 * disable it.
 */
function emitBlobDot(em, cx, cy, {
  diameter = 1.6, baseZ = 0.2, buildSteps = 6, taperFactor = 0.7,
  extrudeSpeed = 120, dwellMs = 2000, extrusionMultiplier = 1.3,
  retractMm = 4.0, postRetractDwellMs = 2000, baseExtraMm = 0.3,
  baseDwellMs = 1000, orbitRadius = null, orbitPts = 16, orbitSpeed = 600,
  orbitLoops = 3, orbitDwellMs = 2000, blobClearanceMm = 0.3,
  liftZ = 5.0, liftSpeed = 600, liftDwellMs = 1000, topOrbitLoops = 3,
} = {}) {
  const radius = diameter / 2.0;
  const domeHeight = radius;
  const standoffVolume = Math.PI * radius * radius * baseZ;
  const domeVolume = (2 / 3) * Math.PI * radius ** 3;
  const totalE = ((standoffVolume + domeVolume) / FIL_AREA) * extrusionMultiplier;

  em.goto(cx, cy, baseZ);

  const bonus = em.pendingPrimeBonus ? LINE_START_PRIME_MM : 0.0;
  em.pendingPrimeBonus = false;
  const primeE = retractMm + bonus;
  em.retracted = false;

  const nSteps = Math.max(1, Math.round(buildSteps));
  const zStep = domeHeight / nSteps;
  const weights = [];
  for (let i = 0; i < nSteps; i++) {
    weights.push(1 - taperFactor * (nSteps > 1 ? i / (nSteps - 1) : 0));
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);

  let z = baseZ;
  for (let i = 0; i < nSteps; i++) {
    z += zStep;
    const stepE = totalE * (weights[i] / weightSum) + (i === 0 ? primeE + baseExtraMm : 0);
    em.a(`G1 Z${z.toFixed(3)} E${stepE.toFixed(4)} F${extrudeSpeed}`);
    em.eTotal += stepE;
    if (i === 0) em.dwell(baseDwellMs);
  }
  em.z = z;

  em.dwell(dwellMs);

  em.a(`G1 E${(-retractMm).toFixed(4)} F${RETRACT_SPEED}`);
  em.eTotal -= retractMm;
  em.retracted = true;

  em.dwell(postRetractDwellMs);

  const actualOrbitRadius = orbitRadius ?? radius;
  const nOrbit = Math.max(3, Math.round(orbitPts));
  if (actualOrbitRadius > 0) {
    const nLoops = Math.max(1, Math.round(orbitLoops));
    for (let loop = 0; loop < nLoops; loop++) {
      for (let i = 0; i <= nOrbit; i++) {
        const theta = (i / nOrbit) * 2 * Math.PI;
        const ox = cx + actualOrbitRadius * Math.cos(theta);
        const oy = cy + actualOrbitRadius * Math.sin(theta);
        em.a(`G0 X${ox.toFixed(3)} Y${oy.toFixed(3)} F${orbitSpeed}`);
        em.x = ox; em.y = oy;
      }
    }
  }
  // (recenter / lift / second orbit intentionally disabled -- the nozzle
  // goes straight from the dome-height orbit above to the next dot's
  // goto(), which itself lifts to travel height before the XY move)
}

/** The DEFAULT stamp -- a single-point "blob" dome, preferred over
 * stampDisc() unless a flat, precisely spiral-filled disc is specifically
 * needed. Extrudes filament at one fixed XY position (no lateral
 * movement), dwells, retracts, orbits -- see emitBlobDot() above. */
export function stampBlob(em, cx, cy, options = {}) {
  emitBlobDot(em, cx, cy, options);
}

/**
 * "Directional" blob dot -- a `blobDot`-family dome that LEANS in a chosen
 * compass direction, for a raked/combed-looking tactile bump. Reuses
 * `blobDot`'s volume model, with two `azimuthDeg`-driven changes:
 *  1. SHEARED BUILD -- the nozzle travels `radius` in the azimuth
 *     direction as it rises through `buildSteps` to the dome top, while
 *     extruding, so the apex ends off-center in that direction.
 *  2. SQUISH-THEN-DRAG -- after build/dwell/retract/dwell, the nozzle
 *     (still at the leaning apex) drops straight down to bed level
 *     (squishing the leaning blob onto the bed), then drags laterally
 *     -azimuth by `diameter`, ending at the trailing edge of the base
 *     circle. This shapes the blob AND sweeps near any residual string.
 * `azimuthDeg` is CCW from +X (same convention as `hairyDot`).
 */
function emitDirectionalBlobDot(em, cx, cy, {
  diameter = 2.0, azimuthDeg = 0, baseZ = 0.2, buildSteps = 6,
  taperFactor = 0.7, extrudeSpeed = 120, dwellMs = 2000,
  extrusionMultiplier = 1.3, retractMm = 4.0, postRetractDwellMs = 2000,
  baseExtraMm = 0.3, baseDwellMs = 1000, dragSpeed = 600,
} = {}) {
  const radius = diameter / 2.0;
  const domeHeight = radius;
  const standoffVolume = Math.PI * radius * radius * baseZ;
  const domeVolume = (2 / 3) * Math.PI * radius ** 3;
  const totalE = ((standoffVolume + domeVolume) / FIL_AREA) * extrusionMultiplier;

  const azR = (azimuthDeg * Math.PI) / 180;
  const ax = Math.cos(azR), ay = Math.sin(azR);

  em.goto(cx, cy, baseZ);

  const bonus = em.pendingPrimeBonus ? LINE_START_PRIME_MM : 0.0;
  em.pendingPrimeBonus = false;
  const primeE = retractMm + bonus;
  em.retracted = false;

  const nSteps = Math.max(1, Math.round(buildSteps));
  const zStep = domeHeight / nSteps;
  const xStep = (ax * radius) / nSteps, yStep = (ay * radius) / nSteps;
  const weights = [];
  for (let i = 0; i < nSteps; i++) {
    weights.push(1 - taperFactor * (nSteps > 1 ? i / (nSteps - 1) : 0));
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);

  let z = baseZ, bx = cx, by = cy;
  for (let i = 0; i < nSteps; i++) {
    z += zStep; bx += xStep; by += yStep;
    const stepE = totalE * (weights[i] / weightSum) + (i === 0 ? primeE + baseExtraMm : 0);
    em.a(`G1 X${bx.toFixed(3)} Y${by.toFixed(3)} Z${z.toFixed(3)} E${stepE.toFixed(4)} F${extrudeSpeed}`);
    em.eTotal += stepE;
    if (i === 0) em.dwell(baseDwellMs);
  }
  em.x = bx; em.y = by; em.z = z;
  const apexX = bx, apexY = by;

  em.dwell(dwellMs);

  em.a(`G1 E${(-retractMm).toFixed(4)} F${RETRACT_SPEED}`);
  em.eTotal -= retractMm;
  em.retracted = true;
  em.dwell(postRetractDwellMs);

  em.a(`G1 Z${baseZ.toFixed(3)} F${dragSpeed}`);
  em.z = baseZ;
  const endX = apexX - ax * diameter, endY = apexY - ay * diameter;
  em.a(`G1 X${endX.toFixed(3)} Y${endY.toFixed(3)} F${dragSpeed}`);
  em.x = endX; em.y = endY;
}

/** The directional (leaning) blob stamp -- see emitDirectionalBlobDot()
 * above. `azimuthDeg` (CCW from +X) sets the lean direction. For a line
 * of these use brushDirectionalBlobDotted(). */
export function stampDirectionalBlob(em, cx, cy, options = {}) {
  emitDirectionalBlobDot(em, cx, cy, options);
}

/** A single solid circular disc, built by spiraling a fill path outward --
 * an ALTERNATIVE to the default stampBlob() when a flat, precisely
 * diameter'd disc is needed (diameter and height are independently
 * controlled, unlike the blob's derived-from-diameter dome). height
 * should be a multiple of LAYER_HEIGHT (0.2mm). The 0.4mm/2-layer default
 * is a tactile-legibility RECOMMENDATION, not an enforced floor -- pass a
 * smaller `height` for a shorter disc if that's what's wanted; only the
 * 1-layer physical minimum (there has to be at least one layer to print
 * anything) is enforced here. No hollow-centre ("donut") shape is
 * implemented. */
export function stampDisc(em, cx, cy, { diameter = 1.6, height = 0.4, speed = 250 } = {}) {
  const nLayers = Math.max(1, Math.round(height / LAYER_HEIGHT));
  const pts = spiralDisc([cx, cy], diameter / 2.0);
  brushSolid(em, polylineToPts(pts, null), { width: 0.42, nLayers, speed });
}

// The 4 named hair directions, as (azimuth, elevation) degree pairs.
// Elevation is measured from the bed plane (0 = flat, 90 = straight up);
// azimuth is CCW from +X.
const HAIR_PRESET = {
  top:    { azDeg: 0,   elDeg: 90 },
  right:  { azDeg: 0,   elDeg: 0 },
  left:   { azDeg: 180, elDeg: 0 },
  bottom: { azDeg: 270, elDeg: 0 },
};

/**
 * Resolve a hair pull direction to azimuth/elevation degrees plus a unit
 * vector (dx,dy,dz). Explicit `azimuthDeg` / `elevationDeg` (either one
 * non-null) win over the `hairDirection` string preset; an unset explicit
 * angle defaults (azimuth 0 = +X, elevation 90 = straight up).
 */
function resolveHairDir(hairDirection, azimuthDeg, elevationDeg) {
  let azDeg, elDeg;
  if (azimuthDeg != null || elevationDeg != null) {
    azDeg = azimuthDeg ?? 0;
    elDeg = elevationDeg ?? 90;
  } else {
    if (!(hairDirection in HAIR_PRESET)) {
      throw new Error(
        `hairyDot: hairDirection must be "top", "left", "right", or ` +
        `"bottom" (got "${hairDirection}"), or pass hairAzimuthDeg / ` +
        `hairElevationDeg for an arbitrary polar direction`
      );
    }
    ({ azDeg, elDeg } = HAIR_PRESET[hairDirection]);
  }
  const DEG = Math.PI / 180;
  const elR = elDeg * DEG, azR = azDeg * DEG;
  const dxy = Math.cos(elR);
  return {
    azDeg, elDeg,
    dx: Math.cos(azR) * dxy,
    dy: Math.sin(azR) * dxy,
    dz: Math.sin(elR),
  };
}

/**
 * A single dot with ONE hair strand pulled from its center. Builds a real
 * root dome first (reusing emitBlobDot's own tapered-rise build mechanism
 * and volume model), then pulls a hair out of that dome's own melt:
 *  1. EXTRUDE segment -- move `hairLength` mm along the pull vector while
 *     extruding a real bead (cross-section via the shared `eRate()`
 *     helper), split into a rate-matched extrude sub-move plus a
 *     no-extrusion "dry rise" finishing the climb, so the bead is fully
 *     laid down before the tip stretches to height.
 *  2. Retract immediately (fixes whole-pull stringing from the
 *     pressurized root), dwell.
 *  3. An optional clearance hop (near-horizontal pulls only), then a
 *     short STRING segment (fast, zero extrusion) and `overtravelMm` for
 *     final clearance from wherever the next dot is.
 * `hairThickness`, when `null`, derives from `hairLength`
 * (`0.5 * (hairLength/4.0)`, clamped 0.4-2.0mm). `rootDiameter` changes how
 * soft/tough the finished hair feels and is kept independent of the
 * thickness derivation on purpose. `hairDirection`/`hairAzimuthDeg`/
 * `hairElevationDeg` resolve via `resolveHairDir()` above.
 * CAUTION: one retract/unretract cycle PER dot -- see
 * PARAMETER_CONSTRAINTS.md before a dense `gap` over a long path.
 */
function emitHairyDot(em, cx, cy, {
  rootDiameter = 2.0, baseZ = 0.2, buildSteps = 6, taperFactor = 0.7,
  extrudeSpeed = 120, baseExtraMm = 0.3, baseDwellMs = 1000,
  dwellMs = 2000, extrusionMultiplier = 1.3, hairThickness = null,
  hairLength = 10.0, pullExtrudeSpeed = 150, beadFlowMult = 3.5,
  dryRiseFeedDrop = 10, retractMm = 4.0,
  postRetractDwellMs = 500, hairDirection = "top",
  hairAzimuthDeg = null, hairElevationDeg = null, stringMm = 2.0,
  hairSpeed = 8000, clearanceZ = 0.5, clearanceSpeed = 600,
  overtravelMm = 2.0, overtravelSpeed = 600,
} = {}) {
  const { elDeg, dx, dy, dz } = resolveHairDir(
    hairDirection, hairAzimuthDeg, hairElevationDeg);

  // root dome build -- identical formulas/loop to emitBlobDot's own build.
  const radius = rootDiameter / 2.0;
  const domeHeight = radius;
  const standoffVolume = Math.PI * radius * radius * baseZ;
  const domeVolume = (2 / 3) * Math.PI * radius ** 3;
  const totalE = ((standoffVolume + domeVolume) / FIL_AREA) * extrusionMultiplier;

  const HAIR_T_REF = 0.5, HAIR_L_REF = 4.0;
  const effThickness = hairThickness ??
    Math.min(2.0, Math.max(0.4, HAIR_T_REF * (hairLength / HAIR_L_REF)));

  const pullERate = eRate(effThickness, effThickness, extrusionMultiplier * beadFlowMult);

  em.goto(cx, cy, baseZ);

  const bonus = em.pendingPrimeBonus ? LINE_START_PRIME_MM : 0.0;
  em.pendingPrimeBonus = false;
  const primeE = retractMm + bonus;
  em.retracted = false;

  const nSteps = Math.max(1, Math.round(buildSteps));
  const zStep = domeHeight / nSteps;
  const weights = [];
  for (let i = 0; i < nSteps; i++) {
    weights.push(1 - taperFactor * (nSteps > 1 ? i / (nSteps - 1) : 0));
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);

  let z = baseZ;
  for (let i = 0; i < nSteps; i++) {
    z += zStep;
    const stepE = totalE * (weights[i] / weightSum) + (i === 0 ? primeE + baseExtraMm : 0);
    em.a(`G1 Z${z.toFixed(3)} E${stepE.toFixed(4)} F${extrudeSpeed}`);
    em.eTotal += stepE;
    if (i === 0) em.dwell(baseDwellMs);
  }
  em.z = z;

  em.dwell(dwellMs);

  const dryF = Math.max(1, pullExtrudeSpeed - dryRiseFeedDrop);
  const eA = pullERate * hairLength;
  const dExtrude = Math.min(eA, hairLength);

  const HORIZ = Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9;
  const VERT = Math.abs(dz) > 1e-9;
  const pull = (d, e, f, rapid) => {
    const nx = em.x + dx * d, ny = em.y + dy * d, nz = em.z + dz * d;
    let s = rapid ? "G0" : "G1";
    if (HORIZ) s += ` X${nx.toFixed(3)} Y${ny.toFixed(3)}`;
    if (VERT) s += ` Z${nz.toFixed(3)}`;
    if (e != null) { s += ` E${e.toFixed(4)}`; em.eTotal += e; }
    s += ` F${f}`;
    em.a(s);
    em.x = nx; em.y = ny; em.z = nz;
  };

  pull(dExtrude, eA, pullExtrudeSpeed, false);
  if (hairLength > dExtrude + 1e-6) pull(hairLength - dExtrude, null, dryF, false);

  em.a(`G1 E${(-retractMm).toFixed(4)} F${RETRACT_SPEED}`);
  em.eTotal -= retractMm;
  em.retracted = true;
  em.dwell(postRetractDwellMs);

  const HAIR_CLEARANCE_MAX_EL_DEG = 30;
  if (elDeg < HAIR_CLEARANCE_MAX_EL_DEG && clearanceZ > 0) {
    em.a(`G0 Z${(em.z + clearanceZ).toFixed(3)} F${clearanceSpeed}`);
    em.z += clearanceZ;
  }

  if (stringMm > 0) pull(stringMm, null, hairSpeed, true);
  pull(overtravelMm, null, overtravelSpeed, true);
}

/** The stamp form of the hairy texture -- see emitHairyDot() above. Do NOT
 * improvise a single hairy dot by calling `brushHairy` on a zero-length
 * path -- that brush's strand-placement logic assumes real extent. */
export function stampHairy(em, cx, cy, options = {}) {
  emitHairyDot(em, cx, cy, options);
}

/** Name → function maps the compiler dispatches on. Keys are the brush /
 * stamp names the scene model, the option table and the prompt docs use. */
export const BRUSHES = {
  solid: brushSolid, dashed: brushDashed, dotted: brushDotted,
  blobDotted: brushBlobDotted, directionalBlobDotted: brushDirectionalBlobDotted,
  hairy: brushHairy, hairyDotted: brushHairyDotted, segmented: brushSegmented,
  variableThickness: brushVariableThickness,
};
export const STAMPS = {
  blob: stampBlob, disc: stampDisc, directionalBlob: stampDirectionalBlob, hairyDot: stampHairy,
};

