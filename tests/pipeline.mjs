// Offline tests for the turn loop (no LLM, no browser):
//   node tests/pipeline.mjs
//
// Drives runStage/runTurn with a scripted fake model against the REAL
// catalog, so the gate really validates and really compiles. What is being
// checked is the control flow: what gets retried, what gets sent back to
// whom, and where the loop stops.

import assert from "node:assert/strict";
import * as C from "../parametric-catalog-with-tool.js";
import { runStage, runTurn, draftScene, CHAIN } from "../pipeline.js";
import { composeUserMessage } from "../prompt-assembly.js";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}

const rect = (x0, y0, w, h) => ({ points: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]] });

const GOOD_GEOMETRY = {
  chat: "one bar", transform: "",
  elements: [{ id: "el_1", label: "bar", kind: "region", role: "bar", geometry: JSON.stringify({ boundary: [rect(50, 40, 15, 12)] }) }],
};
const OFF_BED_GEOMETRY = {
  chat: "oops", transform: "",
  elements: [{ id: "el_1", label: "bar", kind: "region", role: "bar", geometry: JSON.stringify({ boundary: [rect(500, 40, 15, 12)] }) }],
};
const BAD_KIND_GEOMETRY = { chat: "?", transform: "", elements: [{ id: "", label: "x", kind: "blob", role: "", geometry: "{}" }] };

// A fake model: hand it a list of replies per stage and it serves them in
// order, recording every user message it was sent.
function scriptedModel(script) {
  const sent = [];
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, v.slice()]));
  return {
    sent,
    async callModel(stage, userMessage, contextScene) {
      sent.push({ stage, userMessage });
      const q = queues[stage];
      assert.ok(q && q.length, `fake model ran out of "${stage}" replies (call ${sent.length})`);
      const out = q.length > 1 ? q.shift() : q[0];
      const v = C.validateStageOutput(stage, out, contextScene);
      return { value: v.value, errors: v.errors, raw: JSON.stringify(out) };
    },
  };
}

function baseDeps(scene, model, extra = {}) {
  return {
    C,
    callModel: model.callModel,
    compile: (s) => C.compileScene(s),
    composeUser: (stage, opts) => composeUserMessage(stage, { scene, C, ...opts }),
    merge: (stage, value) => {
      if (stage === "geometry") return C.mergeGeometry(scene, value);
      if (stage === "texture") return C.mergeTextures(scene, value);
      if (stage === "ui") return C.mergeUi(scene, value);
      return [];
    },
    maxRepairs: 2,
    maxRefineRounds: 2,
    selfCheck: true,
    ...extra,
  };
}

await test("a rejected output goes back to the same stage with its own mistake quoted", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({ geometry: [BAD_KIND_GEOMETRY, GOOD_GEOMETRY] });
  const res = await runStage("geometry", { scene, instruction: "one bar", targets: [] }, baseDeps(scene, model));

  assert.equal(res.ok, true);
  assert.equal(model.sent.length, 2, "one rejection, one repair");
  assert.equal(res.attempts.length, 2);
  assert.ok(res.attempts[0].errors.length, "the first attempt failed validation");

  const repairMsg = model.sent[1].userMessage;
  assert.ok(repairMsg.startsWith("REPAIR:"), "the second call is framed as a repair");
  assert.ok(/kind must be line\|region\|point/.test(repairMsg), "with the exact rejection text");
  assert.ok(repairMsg.includes('"kind":"blob"'), "and its own previous answer to compare against");
  assert.ok(repairMsg.includes("one bar"), "the original instruction survives the repair");
});

await test("output that validates but will not compile is repaired too", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({ geometry: [OFF_BED_GEOMETRY, GOOD_GEOMETRY] });
  const res = await runStage("geometry", { scene, instruction: "one bar", targets: [] }, baseDeps(scene, model));

  assert.equal(res.ok, true);
  assert.equal(model.sent.length, 2);
  assert.deepEqual(res.attempts[0].errors, [], "it was valid JSON in the right shape");
  assert.ok(res.attempts[0].compileErrors.some((e) => /safe area/.test(e)), "but it does not fit the bed");
  assert.ok(/safe area/.test(model.sent[1].userMessage), "which is what the repair call is told");
  assert.equal(scene.elements.length, 0, "nothing was merged along the way -- the gate holds the scene");
});

await test("repairs are bounded, and the last usable attempt still comes back", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({ geometry: [OFF_BED_GEOMETRY] });   // never improves
  const res = await runStage("geometry", { scene, instruction: "one bar", targets: [] }, baseDeps(scene, model));

  assert.equal(res.ok, false);
  assert.equal(model.sent.length, 3, "the first call plus maxRepairs, and no more");
  assert.ok(res.value, "the attempt is returned anyway so the user can fix it by hand");
  assert.ok(res.errors.some((e) => /safe area/.test(e)));
});

await test("a full turn runs the chain the manager picked and stops when the judge passes", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({
    geometry: [GOOD_GEOMETRY],
    texture: [{ chat: "shaded", textures: [{ elementId: "el_1", slot: "fill", fn: "solid", pattern: JSON.stringify({ kind: "hatch", gap: 4 }), options: JSON.stringify({ width: 0.5 }) }] }],
    ui: [{ chat: "surfaced", groups: [{ id: "", title: "how dense", description: "", members: JSON.stringify([{ level: "pattern", elementId: "el_1", slot: "fill", option: "gap", label: "row spacing" }]) }] }],
  });
  const judged = [];
  const deps = baseDeps(scene, model, {
    route: async () => ({ route: "geometry", instruction: "one bar, shaded", targets: [], acceptance: ["one bar"], reply: "" }),
    judge: async (plan, ran) => { judged.push(ran.map((r) => r.stage)); return { pass: true, failures: [], note: "checks out" }; },
  });

  const out = await runTurn({ scene }, deps);
  assert.equal(out.ok, true);
  assert.equal(out.stopped, "passed");
  assert.deepEqual(judged, [["geometry", "texture", "ui"]], "the whole chain ran once, then one judge call");
  assert.equal(scene.elements.length, 1);
  assert.equal(scene.textures.el_1.fill.pattern.gap, 4);
  assert.equal(scene.groups.length, 1);
  assert.equal(scene.groups[0].members[0].label, "row spacing");
});

await test("a judge failure goes to the manager, which picks the stage to re-run", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({
    geometry: [GOOD_GEOMETRY],
    texture: [
      { chat: "first try", textures: [{ elementId: "el_1", slot: "fill", fn: "solid", pattern: JSON.stringify({ kind: "hatch", gap: 9 }), options: "{}" }] },
      { chat: "denser", textures: [{ elementId: "el_1", slot: "fill", fn: "solid", pattern: JSON.stringify({ kind: "hatch", gap: 3 }), options: "{}" }] },
    ],
    ui: [{ chat: "surfaced", groups: [] }],
  });
  const routeCalls = [];
  let judgeCall = 0;
  const deps = baseDeps(scene, model, {
    route: async (refine) => {
      routeCalls.push(refine);
      // first the manager enters at geometry; on refine it picks texture
      return refine
        ? { route: "texture", instruction: "make el_1's shading denser", targets: ["el_1"], acceptance: [], reply: "" }
        : { route: "geometry", instruction: "one shaded bar", targets: [], acceptance: ["the shading reads as dense"], reply: "" };
    },
    judge: async () => (++judgeCall === 1
      ? { pass: false, failures: [{ criterion: "the shading reads as dense", evidence: "hatch gap 9mm", suspectedStage: "texture" }], note: "too sparse" }
      : { pass: true, failures: [], note: "better" }),
  });

  const out = await runTurn({ scene }, deps);
  assert.equal(out.ok, true);
  assert.equal(out.stopped, "passed");
  assert.equal(out.rounds.length, 2, "one round, then one refine round");
  assert.equal(routeCalls.length, 2);
  assert.ok(routeCalls[1], "the second route call is a refine");
  assert.equal(routeCalls[1].failures[0].suspectedStage, "texture");
  assert.deepEqual(routeCalls[1].ranStages, ["geometry", "texture", "ui"]);
  assert.deepEqual(out.rounds[1].ran.map((r) => r.stage), ["texture", "ui"], "only the suffix from the chosen stage re-ran");
  assert.equal(scene.textures.el_1.fill.pattern.gap, 3, "and the refinement landed");
  // the acceptance criteria carry across the refine round
  assert.deepEqual(out.rounds[1].plan.acceptance, ["the shading reads as dense"]);
});

await test("refine rounds are bounded", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({
    geometry: [GOOD_GEOMETRY],
    texture: [{ chat: "", textures: [{ elementId: "el_1", slot: "fill", fn: "solid", pattern: JSON.stringify({ kind: "hatch", gap: 9 }), options: "{}" }] }],
    ui: [{ chat: "", groups: [] }],
  });
  let judges = 0;
  const deps = baseDeps(scene, model, {
    maxRefineRounds: 1,
    route: async (refine) => ({ route: refine ? "texture" : "geometry", instruction: "x", targets: [], acceptance: ["never satisfied"], reply: "" }),
    judge: async () => { judges++; return { pass: false, failures: [{ criterion: "never satisfied", evidence: "-", suspectedStage: "texture" }], note: "" }; },
  });

  const out = await runTurn({ scene }, deps);
  assert.equal(out.ok, false);
  assert.equal(out.stopped, "rounds");
  assert.equal(out.rounds.length, 2, "the first pass plus one refine round, then it gives up");
  assert.equal(judges, 2);
  assert.ok(out.verdict && !out.verdict.pass, "and the user is told which criterion never passed");
});

await test("with self-check off there is no judge and no refine", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({
    geometry: [GOOD_GEOMETRY],
    texture: [{ chat: "", textures: [] }],
    ui: [{ chat: "", groups: [] }],
  });
  let judged = false;
  const deps = baseDeps(scene, model, {
    selfCheck: false,
    route: async () => ({ route: "geometry", instruction: "one bar", targets: [], acceptance: ["one bar"], reply: "" }),
    judge: async () => { judged = true; return { pass: false, failures: [], note: "" }; },
  });

  const out = await runTurn({ scene }, deps);
  assert.equal(out.ok, true);
  assert.equal(out.stopped, "done");
  assert.equal(judged, false, "the gate still runs, the judge does not");
  assert.equal(scene.elements.length, 1);
});

await test("the manager can end a refine round by asking the user instead", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({
    geometry: [GOOD_GEOMETRY],
    texture: [{ chat: "", textures: [] }],
    ui: [{ chat: "", groups: [] }],
  });
  const deps = baseDeps(scene, model, {
    route: async (refine) => (refine
      ? { route: "chat", instruction: "", targets: [], acceptance: [], reply: "Which of the two curves did you want shaded?" }
      : { route: "geometry", instruction: "shade it", targets: [], acceptance: ["the right area is shaded"], reply: "" }),
    judge: async () => ({ pass: false, failures: [{ criterion: "the right area is shaded", evidence: "two candidates", suspectedStage: "geometry" }], note: "" }),
  });

  const out = await runTurn({ scene }, deps);
  assert.equal(out.stopped, "chat");
  assert.ok(/Which of the two curves/.test(out.plan.reply), "the question reaches the user rather than another silent round");
});

await test("a gate failure stops the chain before the next stage runs", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({ geometry: [OFF_BED_GEOMETRY], texture: [{ chat: "", textures: [] }] });
  const deps = baseDeps(scene, model, {
    route: async () => ({ route: "geometry", instruction: "one bar", targets: [], acceptance: ["one bar"], reply: "" }),
    judge: async () => ({ pass: true, failures: [], note: "" }),
  });

  const out = await runTurn({ scene }, deps);
  assert.equal(out.ok, false);
  assert.equal(out.stopped, "gate");
  assert.equal(out.failedStage, "geometry");
  assert.ok(!model.sent.some((c) => c.stage === "texture"), "texture never ran on geometry nobody could print");
});

await test("draftScene shows what the scene WOULD be, without touching it", async () => {
  const scene = C.defaultScene();
  scene.elements = [{ id: "el_1", label: "bar", kind: "region", role: "bar", boundary: [rect(50, 40, 15, 12)] }];
  const v = C.validateStageOutput("texture", {
    chat: "", textures: [{ elementId: "el_1", slot: "fill", fn: "solid", pattern: JSON.stringify({ kind: "hatch", gap: 4 }), options: "{}" }],
  }, scene);
  assert.deepEqual(v.errors, []);

  const draft = draftScene("texture", scene, v.value, C);
  assert.equal(draft.textures.el_1.fill.fn, "solid", "the draft has the proposed texture");
  assert.equal(scene.textures.el_1, undefined, "the live scene is untouched");
  assert.ok(C.compileScene(draft).jobs.length > 0, "and it is a real scene the compiler accepts");
});

await test("scene.lastReport is fresh mid-turn, not stale until the browser's own recompile", async () => {
  // Regression for a real bug: composeUserMessage/composeJudgeMessage both
  // read scene.lastReport, which used to be updated only by the browser's
  // post-turn rerunGcode() -- never during the turn itself. That meant any
  // acceptance criterion shaped like "the report confirms X" could never
  // pass within a refine loop, no matter how many rounds ran, since X was
  // always built THIS turn. Fixed by writing the gate's own fresh compile
  // back onto scene.lastReport right after each stage merges (pipeline.js).
  const scene = C.defaultScene();
  assert.equal(scene.lastReport, null, "starts stale, as if from a prior turn (or none at all)");
  const model = scriptedModel({
    geometry: [GOOD_GEOMETRY],
    texture: [{ chat: "solid", textures: [] }],
    ui: [{ chat: "nothing to surface", groups: [] }],
  });
  let sawAtJudge = null;
  const deps = baseDeps(scene, model, {
    route: async () => ({ route: "geometry", instruction: "one bar", targets: [], acceptance: ["one bar"], reply: "" }),
    judge: async () => {
      sawAtJudge = scene.lastReport;
      return { pass: true, failures: [], note: "ok" };
    },
  });

  const out = await runTurn({ scene }, deps);
  assert.equal(out.ok, true);
  assert.equal(out.stopped, "passed");
  // The judge runs after the whole chain, on the same live scene object --
  // it must see a real, current report, not the pre-turn null.
  assert.ok(sawAtJudge, "the judge call saw a populated report, not the pre-turn null");
  assert.equal(sawAtJudge.elements.length, 1);
  assert.equal(sawAtJudge.elements[0].id, "el_1");
});

await test("the chain table matches what the manager may choose", async () => {
  assert.deepEqual(CHAIN.geometry, ["geometry", "texture", "ui"]);
  assert.deepEqual(CHAIN.texture, ["texture", "ui"]);
  assert.deepEqual(CHAIN.ui, ["ui"]);
  assert.deepEqual(CHAIN.chat, []);
});

// groupsForElement / topLevelGroups: the panel's per-element vs. top-level
// placement of the ui stage's curated scene.groups. A group scoped to one
// element lives only in that element's own card; a group spanning several
// elements (or none, e.g. a lone graphic-level "scale") gets a top-level
// card AND still shows up inside each of its own elements' cards -- that
// double appearance is deliberate, not a bug (see the parameters-panel plan).

await test("a single-element group is nested only, never top-level", async () => {
  const scene = C.defaultScene();
  scene.groups = [{ id: "g1", title: "row spacing", description: "", members: [
    { level: "brush", elementId: "el_1", slot: "brush", option: "gap", label: "gap" },
  ] }];
  assert.equal(C.topLevelGroups(scene).length, 0);
  const forA = C.groupsForElement(scene, "el_1");
  assert.equal(forA.length, 1);
  assert.equal(forA[0].members.length, 1);
  assert.equal(C.groupsForElement(scene, "el_2").length, 0);
});

await test("a group spanning several elements is top-level AND nested in each", async () => {
  const scene = C.defaultScene();
  scene.groups = [{ id: "g1", title: "tactility", description: "", members: [
    { level: "brush", elementId: "el_1", slot: "brush", option: "nLayers", label: "layers" },
    { level: "brush", elementId: "el_2", slot: "fill", option: "nLayers", label: "layers" },
  ] }];
  const top = C.topLevelGroups(scene);
  assert.equal(top.length, 1);
  assert.equal(top[0].members.length, 2, "the top-level card shows both members together");

  const forA = C.groupsForElement(scene, "el_1");
  assert.equal(forA.length, 1);
  assert.equal(forA[0].members.length, 1);
  assert.equal(forA[0].members[0].elementId, "el_1");

  const forB = C.groupsForElement(scene, "el_2");
  assert.equal(forB.length, 1);
  assert.equal(forB[0].members[0].elementId, "el_2");
});

await test("a purely graphic-level group is top-level only", async () => {
  const scene = C.defaultScene();
  scene.groups = [{ id: "g1", title: "overall size", description: "", members: [
    { level: "graphic", option: "scale", label: "scale" },
  ] }];
  assert.equal(C.topLevelGroups(scene).length, 1);
  assert.equal(C.groupsForElement(scene, "el_1").length, 0);
});

await test("one element + a graphic member: nested only, graphic member rides along", async () => {
  const scene = C.defaultScene();
  scene.groups = [{ id: "g1", title: "pattern density", description: "", members: [
    { level: "graphic", option: "scale", label: "scale" },
    { level: "pattern", elementId: "el_1", slot: "fill", option: "gap", label: "gap" },
  ] }];
  assert.equal(C.topLevelGroups(scene).length, 0, "one real element -- not top-level");
  const forA = C.groupsForElement(scene, "el_1");
  assert.equal(forA.length, 1);
  assert.equal(forA[0].members.length, 2, "the graphic member is not silently dropped");
});

await test("two elements + a graphic member: top-level keeps the graphic member, per-element slices drop it", async () => {
  const scene = C.defaultScene();
  scene.groups = [{ id: "g1", title: "pattern density", description: "", members: [
    { level: "graphic", option: "scale", label: "scale" },
    { level: "pattern", elementId: "el_1", slot: "fill", option: "gap", label: "gap" },
    { level: "pattern", elementId: "el_2", slot: "fill", option: "gap", label: "gap" },
  ] }];
  const top = C.topLevelGroups(scene);
  assert.equal(top.length, 1);
  assert.equal(top[0].members.length, 3, "top-level keeps the graphic member");

  const forA = C.groupsForElement(scene, "el_1");
  assert.equal(forA[0].members.length, 1, "no single element to attach the graphic member to");
  assert.equal(forA[0].members[0].elementId, "el_1");
});

await test("groupsForElement never mutates the live scene", async () => {
  const scene = C.defaultScene();
  scene.groups = [{ id: "g1", title: "t", description: "", members: [
    { level: "brush", elementId: "el_1", slot: "brush", option: "gap", label: "gap" },
  ] }];
  const forA = C.groupsForElement(scene, "el_1");
  assert.notEqual(forA[0], scene.groups[0]);
  forA[0].members.push({ elementId: "intruder" });
  assert.equal(scene.groups[0].members.length, 1, "the original group is untouched");
});

await test("empty or missing scene.groups yields [] from both", async () => {
  const scene = C.defaultScene();
  assert.deepEqual(C.topLevelGroups(scene), []);
  assert.deepEqual(C.groupsForElement(scene, "el_1"), []);
  scene.groups = undefined;
  assert.deepEqual(C.topLevelGroups(scene), []);
  assert.deepEqual(C.groupsForElement(scene, "el_1"), []);
});

console.log(`${passed} passed${process.exitCode ? ", with failures" : ""}`);
