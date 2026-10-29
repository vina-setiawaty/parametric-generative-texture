// The turn loop for parametric-with-tool: manager -> specialists, with a
// deterministic gate between calls and an intent evaluation after them.
//
// Pure control flow. Every side effect (calling a model, compiling,
// merging into the live scene, reporting progress) arrives as a dependency,
// so tests/pipeline.mjs drives the whole loop with a scripted
// fake model and no browser.
//
// Two layers, and they catch different things:
//
//   The GATE, after every call. Schema, ids, option ranges, then an actual
//   compile of what the stage proposed. It answers "can the next stage
//   even work with this?" and nothing reaches the next stage until it can.
//   A failure is handed straight back to the SAME stage as a repair, with
//   the errors verbatim and its own previous answer. Before this, a
//   rejected stage ended the turn with a retry link and the model was
//   never told what was wrong.
//
//   The JUDGE, once the chain is done. It answers the different question
//   "is this what was asked for?", against the acceptance criteria the
//   manager wrote at the start and the app's own measured numbers. Its
//   failures go back to the MANAGER, which decides which specialist to
//   re-run -- a mis-shaded area is geometry's problem, an indistinct
//   texture is texture's, a number out of proportion is the panel's.
//
// Bounded on purpose: at most `maxRepairs` repairs per stage and
// `maxRefineRounds` manager rounds per turn, so a turn cannot spend the
// user's money in a loop.

export const CHAIN = {
  geometry: ["geometry", "texture", "ui"],
  texture: ["texture", "ui"],
  ui: ["ui"],
  chat: [],
};

/** A scene as it WOULD be if this stage's output were accepted -- built by
 * running the real merge over a clone, so the gate compiles exactly what
 * the user would get rather than an approximation of it. */
export function draftScene(stage, scene, value, C) {
  const copy = C.normalizeScene(JSON.parse(JSON.stringify({ ...scene, messages: [], lastReport: null })));
  copy.messages = [];
  if (stage === "geometry") C.mergeGeometry(copy, value);
  else if (stage === "texture") C.mergeTextures(copy, value);
  else if (stage === "ui") C.mergeUi(copy, value);
  return copy;
}

/** One stage, with its gate. Returns
 * { ok, value, compiled, attempts, errors } -- `value` is the last output
 * that parsed and validated, even when it failed to compile, so the caller
 * can still merge something the user can edit by hand. */
export async function runStage(stage, ctx, deps) {
  const maxRepairs = deps.maxRepairs ?? 2;
  const attempts = [];
  let repair = null;
  let lastValid = null;

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    deps.onProgress?.({ stage, attempt, repairing: !!repair });
    const userMessage = deps.composeUser(stage, { instruction: ctx.instruction, targets: ctx.targets, repair });
    const res = await deps.callModel(stage, userMessage, ctx.scene);
    const record = { stage, attempt, errors: res.errors || [], compileErrors: [] };
    attempts.push(record);

    if (record.errors.length) {
      // Rejected before it could mean anything -- ask the same stage again
      // with its own mistake quoted back.
      repair = { errors: record.errors, previous: res.raw };
      continue;
    }
    lastValid = res.value;

    let compiled;
    try {
      compiled = deps.compile(draftScene(stage, ctx.scene, res.value, deps.C));
    } catch (e) {
      compiled = { errors: [String(e?.message || e)], warnings: [], report: null };
    }
    record.compileErrors = compiled.errors || [];
    if (!record.compileErrors.length) {
      return { ok: true, value: res.value, compiled, attempts, errors: [] };
    }
    repair = { errors: record.compileErrors, previous: res.raw };
  }

  const last = attempts[attempts.length - 1] || { errors: [], compileErrors: [] };
  return {
    ok: false,
    value: lastValid,
    compiled: null,
    attempts,
    errors: last.errors.length ? last.errors : last.compileErrors,
  };
}

/** One user turn: route, run the chain, judge, and let the manager decide
 * what to re-run. Returns everything the page needs to report what
 * happened, including each round's attempts for the debug log. */
export async function runTurn(ctx, deps) {
  const maxRefineRounds = deps.maxRefineRounds ?? 2;
  const rounds = [];

  let plan = await deps.route(null);
  if (!plan || plan.route === "chat" || !CHAIN[plan.route]) {
    return { plan, rounds, verdict: null, ok: true, stopped: "chat" };
  }

  for (let round = 0; ; round++) {
    const chain = CHAIN[plan.route].slice();
    const ran = [];
    let failed = null;

    for (const stage of chain) {
      const res = await runStage(stage, { scene: ctx.scene, instruction: plan.instruction, targets: plan.targets }, deps);
      ran.push({ stage, ...res });
      // Merge whatever validated, even when it would not compile: the
      // panel is editable, and showing the user a broken attempt they can
      // fix beats discarding the work and showing them nothing.
      if (res.value) deps.merge(stage, res.value);
      // The gate already compiled this stage's accepted output (against a
      // draft, but with the same merge logic a real merge just applied) --
      // reuse that report instead of leaving scene.lastReport stale until
      // the browser's own post-turn recompile. Without this, every prompt
      // and the judge see last turn's report for the whole of this one:
      // "does the report confirm X" can never pass mid-refine no matter
      // how many rounds run, since X was always built THIS turn.
      if (res.ok && res.compiled) ctx.scene.lastReport = res.compiled.report;
      if (!res.ok) { failed = stage; break; }
    }
    const thisRound = { plan, ran, verdict: null };
    rounds.push(thisRound);

    if (failed) return { plan, rounds, verdict: null, ok: false, stopped: "gate", failedStage: failed };
    if (!deps.selfCheck || !plan.acceptance?.length) return { plan, rounds, verdict: null, ok: true, stopped: "done" };

    const verdict = await deps.judge(plan, ran);
    thisRound.verdict = verdict;
    if (verdict?.pass) return { plan, rounds, verdict, ok: true, stopped: "passed" };
    if (round >= maxRefineRounds) return { plan, rounds, verdict, ok: false, stopped: "rounds" };

    // Back to the manager: it picks which specialist can fix this.
    const next = await deps.route({ failures: verdict?.failures || [], ranStages: chain });
    if (!next || next.route === "chat" || !CHAIN[next.route]) {
      return { plan: next || plan, rounds, verdict, ok: false, stopped: "chat" };
    }
    plan = { ...next, acceptance: next.acceptance?.length ? next.acceptance : plan.acceptance };
  }
}
