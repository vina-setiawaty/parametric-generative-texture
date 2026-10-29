// Prompt assembly for the parametric-with-tool pipeline.
//
// Pure ES module -- no DOM, no network, no page state beyond the scene it
// is handed -- so tests/prompt-assembly.mjs can build every
// stage's real prompt under node and check it. This used to live inside
// parametric-with-tool.js, where nothing could reach it without a browser.
//
// Two rules shape what goes into a prompt:
//
//   1. A stage gets only the reference it needs. The texture stage has no
//      use for the piece/element geometry language and the ui stage has no
//      use for the machine's start sequence; carrying them anyway made
//      every call more expensive and buried the part that mattered.
//   2. Anything that mirrors code is GENERATED from the code (the limit
//      tables, the option specs), never written out in a doc where it can
//      drift.
//
// Each stage's prompt is therefore self-contained: it states that stage's
// own job, input and output contract without assuming the model saw an
// earlier call. Only the router sees the conversation; every other stage
// works from the self-contained instruction the router wrote.

export const STAGE_DOCS = {
  route: ["docs/stage-route.md"],
  geometry: ["docs/stage-geometry.md", "docs/ref-coordinates.md", "docs/ref-expressions.md", "docs/ref-geometry-language.md"],
  texture: ["docs/stage-texture.md", "docs/ref-coordinates.md", "docs/ref-expressions.md", "docs/ref-patterns.md", "docs/ref-brush-menu.md"],
  ui: ["docs/stage-ui.md"],
  judge: ["docs/stage-judge.md"],
};

// Generated sections, by name, appended after the docs.
export const STAGE_GENERATED = {
  geometry: ["limits"],
  texture: ["limits", "legibility"],
  ui: [],
};

/** Every doc path the page must fetch, deduplicated. */
export const DOC_PATHS = [...new Set(Object.values(STAGE_DOCS).flat())];

/** Raw markdown -> the text that actually goes into a prompt.
 *
 * A STAGE doc wraps its whole prompt in one ``` fence, with the prose
 * outside the fence being notes to us; only the fenced block is the
 * prompt. A REFERENCE doc is used whole -- its fences are examples.
 *
 * That distinction has to be explicit. The page used to apply
 * "first fenced block if there is one" to every doc alike, which silently
 * reduced reference-machine.md from 9658 characters to the 712-character
 * JSON example that happened to be its first fence: the machine table, the
 * safe-area rule, the expression grammar, the piece and element tables and
 * the grouping guidance never reached the model, on any stage, for as long
 * as that file existed. Nothing failed -- the prompt was simply missing
 * most of itself. */
export function docText(path, raw) {
  const isStageDoc = /(^|\/)stage-[^/]*\.md$/.test(path);
  if (!isStageDoc) return raw;
  const fenced = raw.match(/```([\s\S]*?)```/);
  if (!fenced) throw new Error(`stage doc "${path}" has no \`\`\` fenced prompt block`);
  return fenced[1].trim();
}

const SEP = "\n\n---\n\n";

/** The session's material, as a line of prompt rather than a doc: it is
 * the one piece of machine context that changes per conversation. */
export function materialText(scene) {
  const mat = scene?.config?.material || "TPU";
  return `SESSION: material = ${mat}.` + (mat === "PLA"
    ? " Use PLA numbers; the page emits a PLA start sequence."
    : " Use TPU numbers (the library defaults).");
}

/** Errors and warnings the app found compiling the CURRENT scene, so a
 * later turn knows the scene it is editing is broken. Without this a
 * "boundary crosses itself" was invisible to every subsequent call. */
export function compileStatusText(compiled) {
  if (!compiled) return "(the scene has not been compiled yet)";
  const out = [];
  if (compiled.errors?.length) out.push(`BLOCKING ERRORS in the current scene (fix these):\n${compiled.errors.map((e) => `  - ${e}`).join("\n")}`);
  if (compiled.warnings?.length) out.push(`WARNINGS on the current scene:\n${compiled.warnings.map((w) => `  - ${w}`).join("\n")}`);
  if (!out.length) out.push("The current scene compiles cleanly.");
  return out.join("\n");
}

/** The most recent thing the user actually typed, verbatim -- given to
 * every generating stage alongside the router's rewritten instruction, so a
 * specialist can notice when the instruction seems to have dropped or
 * contradicted something the user said, without becoming a second source
 * of instructions itself (see composeUserMessage's use of this). */
function lastUserMessageText(scene) {
  const msgs = scene?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") return msgs[i].content;
  return null;
}

/** `stage` -> the full system prompt. `docs` maps a path to its text. */
export function composeSystemPrompt(stage, { docs, scene, C }) {
  const paths = STAGE_DOCS[stage];
  if (!paths) throw new Error(`no docs configured for stage "${stage}"`);
  const parts = paths.map((p) => {
    const text = docs[p];
    if (text == null) throw new Error(`prompt doc "${p}" was not loaded`);
    return text;
  });
  const GENERATE = { limits: () => C.limitsText(), legibility: () => C.legibilityText() };
  for (const name of STAGE_GENERATED[stage] || []) parts.push(GENERATE[name]());
  if (stage === "route") parts.push(`SCENE SUMMARY:\n${C.sceneSummary(scene)}`);
  else parts.push(materialText(scene));
  return parts.join(SEP);
}

// One array item per line, each compact -- readable without pretty-printing
// every coordinate onto its own line.
function jsonLines(arr) {
  if (!Array.isArray(arr) || !arr.length) return "[]";
  return "[\n" + arr.map((x) => "  " + JSON.stringify(x)).join(",\n") + "\n]";
}

/** The router is the only stage that sees the conversation. Consecutive
 * same-role turns are merged (both providers require alternation) and the
 * history is capped -- an unbounded transcript grew the cheapest call in
 * the pipeline without making its decision any better. */
export function composeRouteMessages(scene, { maxTurns = 12 } = {}) {
  const out = [];
  for (const m of scene.messages.slice(-maxTurns)) {
    const content = m.stage && m.role === "assistant" ? `[${m.stage}] ${m.content}` : m.content;
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += "\n\n" + content;
    else out.push({ role: m.role, content });
  }
  return out;
}

/** The manager's user message on a REFINE round: what the evaluation
 * found, and which specialists have already run this turn. The manager
 * decides which one to send it back to -- that decision is its job, not
 * the judge's, which is why the judge only names a suspect. */
export function composeRefineMessage({ failures = [], ranStages = [] }) {
  const lines = failures.map((f) => `  - ${f.criterion}\n      evidence: ${f.evidence}\n      likely stage: ${f.suspectedStage}`);
  return [
    "REFINE: the work just done did not meet every acceptance criterion.",
    "",
    `WHAT FAILED:\n${lines.join("\n") || "  (none given)"}`,
    "",
    `ALREADY RUN THIS TURN: ${ranStages.join(" -> ") || "(none)"}`,
    "",
    "Decide which specialist should run again and say exactly what to change",
    "and what to leave alone. Route to chat instead if this needs the user.",
  ].join("\n");
}

/** The judge's user message: the criteria, the scene as it now stands, and
 * the app's own measured numbers. */
export function composeJudgeMessage({ scene, C, instruction, acceptance = [], compiled = null, notes = [] }) {
  return [
    `INSTRUCTION:\n${instruction}`,
    `ACCEPTANCE CRITERIA:\n${acceptance.map((a, i) => `  ${i + 1}. ${a}`).join("\n") || "  (none)"}`,
    `SCENE NOW:\n${C.sceneSummary(scene)}`,
    `DETERMINISTIC REPORT (measured by the app from the exact geometry that will print):\n${C.reportText(scene.lastReport)}`,
    `COMPILE STATUS:\n${compileStatusText(compiled)}`,
    `WHAT THE SPECIALISTS SAID THEY DID:\n${notes.map((n) => `  - ${n}`).join("\n") || "  (nothing)"}`,
  ].join("\n\n");
}
/** The user message for one generating stage. `repair` (the errors a
 * previous attempt produced, plus that attempt's own output) turns this
 * into a repair call for the same stage -- same schema, same settings. */
export function composeUserMessage(stage, { scene, C, instruction, targets = [], compiled = null, repair = null }) {
  const ids = targets.length ? targets : null;
  const parts = [];

  if (repair) {
    parts.push(
      "REPAIR: your previous answer to this same instruction was rejected. " +
      "Fix exactly what is listed and return the whole output again in the same shape.\n\n" +
      `WHAT WAS WRONG:\n${repair.errors.map((e) => `  - ${e}`).join("\n")}` +
      (repair.previous ? `\n\nYOUR PREVIOUS OUTPUT:\n${repair.previous}` : ""),
    );
  }

  parts.push(`INSTRUCTION:\n${instruction}`);
  const lastUser = lastUserMessageText(scene);
  if (lastUser) parts.push(`USER'S LAST MESSAGE, VERBATIM (reference only -- the router already resolved this into the instruction above; use this only to notice if that resolution dropped or contradicts something, never as a second instruction to act on):\n${lastUser}`);
  parts.push(`TARGET ELEMENTS: ${targets.length ? targets.join(", ") : "(whole scene)"}`);

  if (stage === "geometry") {
    parts.push(`CURRENT ELEMENTS (JSON):\n${jsonLines(C.elementsJson(scene))}`);
    parts.push(`CURRENT TRANSFORM: ${JSON.stringify(scene.transform)}`);
  } else {
    // Texture and parameters reason about printed size, so each element
    // carries what the app measured for it.
    const els = C.elementsJson(scene).map((e) => {
      const rep = scene.lastReport?.elements?.find((r) => r.id === e.id);
      return { ...e, size: rep ? { bbox: rep.bbox, length: rep.length, area: rep.area, width: rep.width, height: rep.height } : undefined };
    });
    parts.push(`ELEMENTS (JSON, geometry + printed size):\n${jsonLines(els)}`);
    parts.push(`CURRENT TEXTURES (JSON):\n${jsonLines(C.texturesJson(scene))}`);
  }

  if (stage === "texture") {
    // The texture stage sets the numbers now, so it needs the specs. These
    // cover the brushes already in use; anything it newly chooses is
    // described in the brush and pattern reference in its system prompt.
    parts.push(`OPTION SPECS for the brushes/stamps currently in use:\n${C.optionSpecsText(scene, ids) || "(no textures yet)"}`);
  }
  if (stage === "ui") {
    // The ui stage picks its group members straight from this real option
    // list (each already tagged stroke/brush/pattern/graphic) -- no
    // separate attribute-candidate block needed now that there's no fixed
    // attribute table to expand against.
    parts.push(`OPTION SPECS for the brushes in use:\n${C.optionSpecsText(scene, ids) || "(no textures yet)"}`);
    parts.push(`CURRENTLY SURFACED GROUPS (JSON):\n${jsonLines(scene.groups || [])}`);
  }

  parts.push(`LATEST GEOMETRY REPORT:\n${C.reportText(scene.lastReport)}`);
  if (compiled) parts.push(`COMPILE STATUS:\n${compileStatusText(compiled)}`);
  return parts.join("\n\n");
}
