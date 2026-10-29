// Offline tests for session save/load (no LLM, no browser):
//   node tests/session-file.mjs
//
// A saved session must come back exactly, and a file that can't be loaded
// must be refused with a reason -- never turned into an empty scene, which
// would look like a successful load and wipe the user's work.

import assert from "node:assert/strict";
import * as C from "../parametric-catalog-with-tool.js";
import { serializeSession, parseSession, SESSION_KIND, SESSION_FILE_VERSION } from "../session-file.js";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}

function sampleScene() {
  const s = C.defaultScene();
  s.config.material = "PLA";
  s.transform = { scale: 1.5, origin: [10, 20] };
  s.elements = [{ id: "el_1", kind: "line", label: "edge", points: [[0, 0], [30, 0]] }];
  s.textures = { el_1: { brush: { name: "freeformDotted", values: { spacing: 3 } } } };
  s.groups = [{ id: "grp_1", label: "edge look", members: [{ elementId: "el_1" }] }];
  s.messages = [{ role: "user", content: "a dotted line" }, { role: "assistant", content: "done", stage: "texture" }];
  s.lastReport = { ok: true, warnings: [] };
  return s;
}
const sampleLog = [{ at: "2026-10-29T10:00:00.000Z", userInput: "a dotted line", calls: [{ stage: "route", rawOutput: "{\"entry\":\"geometry\"}" }] }];

await test("a saved session round-trips exactly", async () => {
  const scene = sampleScene();
  const back = parseSession(serializeSession(scene, sampleLog), C);
  assert.deepEqual(back.scene, scene);
  assert.deepEqual(back.debugLog, sampleLog);
  assert.match(back.savedAt, /^\d{4}-\d\d-\d\dT/);
});

await test("the default (empty) scene round-trips", async () => {
  const back = parseSession(serializeSession(C.defaultScene(), []), C);
  assert.deepEqual(back.scene, C.defaultScene());
  assert.deepEqual(back.debugLog, []);
});

await test("a missing or non-array debug log loads as []", async () => {
  const raw = JSON.parse(serializeSession(sampleScene(), sampleLog));
  delete raw.debugLog;
  assert.deepEqual(parseSession(JSON.stringify(raw), C).debugLog, []);
  raw.debugLog = "nope";
  assert.deepEqual(parseSession(JSON.stringify(raw), C).debugLog, []);
});

await test("non-JSON is refused", async () => {
  assert.throws(() => parseSession("parametric-with-tool debug log -- 1 turn(s)", C), /not a JSON file/);
});

await test("JSON that isn't a session (e.g. a bare scene) is refused", async () => {
  assert.throws(() => parseSession(JSON.stringify(sampleScene()), C), /not a saved session/);
});

await test("an unknown session file version is refused", async () => {
  const raw = JSON.parse(serializeSession(sampleScene(), sampleLog));
  raw.fileVersion = SESSION_FILE_VERSION + 1;
  assert.throws(() => parseSession(JSON.stringify(raw), C), /version \d+ isn't supported/);
});

await test("a scene from another scene version is refused, not emptied", async () => {
  const raw = JSON.parse(serializeSession(sampleScene(), sampleLog));
  raw.scene.version = C.SCENE_VERSION - 1;
  assert.throws(() => parseSession(JSON.stringify(raw), C), /scene was saved as version/);
  delete raw.scene;
  assert.throws(() => parseSession(JSON.stringify(raw), C), /scene was saved as version \?/);
});

await test("the file says what it is", async () => {
  const raw = JSON.parse(serializeSession(sampleScene(), sampleLog));
  assert.equal(raw.kind, SESSION_KIND);
  assert.equal(raw.fileVersion, SESSION_FILE_VERSION);
});

console.log(`${passed} passed${process.exitCode ? ", with failures" : ""}`);
