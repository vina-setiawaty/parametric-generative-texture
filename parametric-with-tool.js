// parametric-with-tool.html -- a staged LLM pipeline for tactile graphics.
//
// Column 1: a multi-turn chat. Column 2: the parameter panel (global
// transform, elements with their textures, the parameter groups the ui
// stage surfaced, and the full option list). Column 3: the geometry report, the print
// digest and the generated G-code (the shared #raw-gcode-textarea +
// run/save wiring from script.js).
//
// A user message goes to the ROUTE stage, which rewrites it as a
// self-contained instruction and picks the entry stage; the page then
// chains geometry -> texture -> ui (or a suffix of that), calling
// the chosen provider (OpenAI or Anthropic) DIRECTLY from the browser with
// a key the user enters (see stage-schemas.js for per-stage schemas/token
// budgets and llm.js's callLlmDirect for the request itself -- no Vercel
// proxy is involved). Every stage's JSON is validated and merged into the
// SCENE by parametric-catalog-with-tool.js, which also compiles the scene
// to G-code locally -- editing anything in column 2 re-generates without
// an API round-trip.
//
// This is an ES module; it reads llm.js's classic-script helpers
// (escapeHtml, readJsonResponse, wasTruncated, extractResponseOutput,
// recordCost, renderCostTracker, updateModelOptions, saveApiKeyFrom,
// loadApiKeyInto, callLlmDirect) as globals, and exposes
// initParametricEditor on window for parametric-with-tool-compat.js.

import { STAGES } from "./stage-schemas.js";
import {
  DOC_PATHS, docText, composeSystemPrompt, composeUserMessage, composeRouteMessages,
  composeJudgeMessage, composeRefineMessage,
} from "./prompt-assembly.js";
import { runTurn, CHAIN } from "./pipeline.js";

const STORAGE_KEY = "parametricWithToolSessionState";
const DEBUG_LOG_KEY = "parametricWithToolDebugLog";
const DEBUG_LOG_MAX_TURNS = 15;   // localStorage is finite; keep the most recent turns

const STAGE_LABEL = { route: "deciding", geometry: "geometry", texture: "texture", ui: "controls", judge: "checking" };

let C = null;              // parametric-catalog-with-tool.js module
let docs = {};             // path -> text
let ready = false;
let scene = null;
let rerunTimer = null;
let lastTurn = null;       // the finished runTurn() result, for the retry link and the criteria list
let busy = false;

// Debug log: one entry per user turn, each holding every stage call that
// turn triggered (route, then whichever chain), with the RAW text the
// model returned -- before JSON.parse, before validation -- so a broken
// response (malformed JSON, a rejected field, a timeout) is inspectable
// after the fact instead of only a summarized error message. Persisted
// separately from the scene so "new conversation" doesn't lose it.
let debugLog = [];
let currentDebugTurn = null;

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- state --

function loadScene() {
  try { return C.normalizeScene(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")); }
  catch (e) { return C.defaultScene(); }
}
function saveScene() { localStorage.setItem(STORAGE_KEY, JSON.stringify(scene)); }

function loadDebugLog() {
  try {
    const v = JSON.parse(localStorage.getItem(DEBUG_LOG_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}
function saveDebugLog() {
  while (debugLog.length > DEBUG_LOG_MAX_TURNS) debugLog.shift();
  try { localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(debugLog)); }
  catch (e) { /* quota exceeded -- drop the oldest half and try once more */
    debugLog = debugLog.slice(Math.ceil(debugLog.length / 2));
    try { localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(debugLog)); } catch (e2) { /* give up silently */ }
  }
}

// Starts a new turn in the debug log (one user input -> one or more
// stage calls). Call once per onSend(), before any callStage().
function beginDebugTurn(userInput) {
  currentDebugTurn = { at: new Date().toISOString(), userInput, calls: [] };
  debugLog.push(currentDebugTurn);
  saveDebugLog();
}

// Appends one call's record to the current turn (or a turn-less
// fallback, so a retry outside onSend() still gets logged). Called from
// callStage() via a try/finally so a thrown error still gets logged.
function logDebugCall(record) {
  if (!currentDebugTurn) { currentDebugTurn = { at: new Date().toISOString(), userInput: "(no turn context)", calls: [] }; debugLog.push(currentDebugTurn); }
  currentDebugTurn.calls.push(record);
  saveDebugLog();
}

function formatDebugLog(log) {
  if (!log.length) return "(the debug log is empty)";
  const pretty = (text) => { try { return JSON.stringify(JSON.parse(text), null, 1); } catch (e) { return text; } };
  const lines = [`parametric-with-tool debug log -- ${log.length} turn(s), exported ${new Date().toISOString()}`, ""];
  log.forEach((turn, i) => {
    lines.push(`${"=".repeat(70)}`, `TURN ${i + 1} -- ${turn.at}`, `USER: ${turn.userInput}`, "");
    for (const c of turn.calls) {
      lines.push(`${"-".repeat(70)}`, `[${c.stage}]  ${c.provider || ""} ${c.model || ""}${c.usage ? `  (in=${c.usage.input_tokens ?? "?"} out=${c.usage.output_tokens ?? "?"})` : ""}`);
      lines.push(`settings: effort=${c.effort ?? "?"}  thinking=${c.thinking ?? "?"}  self-check=${c.selfCheck ?? "?"}  material=${c.material ?? "?"}`, "");
      lines.push("user message sent:", c.userMessage || "(none)", "");
      if (c.networkError) lines.push("NETWORK ERROR:", c.networkError, "");
      if (c.httpError) lines.push("HTTP/PROXY ERROR:", c.httpError, "");
      if (c.refusal) lines.push("MODEL REFUSED:", c.refusal, "");
      if (c.rawOutput != null) lines.push("raw model output:", pretty(c.rawOutput), "");
      if (c.parseError) lines.push("JSON PARSE ERROR:", c.parseError, "");
      if (c.validationErrors && c.validationErrors.length) lines.push("REJECTED BY THE GATE (sent back to this same stage as a repair):", c.validationErrors.join("\n"), "");
      if (!c.networkError && !c.httpError && !c.refusal && !c.parseError && !(c.validationErrors && c.validationErrors.length)) lines.push("(accepted)", "");
    }
    lines.push("");
  });
  return lines.join("\n");
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// -------------------------------------------------------------- loading --

async function loadDeps() {
  const status = $("#pg-status");
  status.textContent = "loading texture library…";
  try {
    C = await import("./parametric-catalog-with-tool.js");
  } catch (e) {
    status.textContent = "";
    $("#pg-messages").innerHTML = `<li>could not load parametric-catalog-with-tool.js: ${escapeHtml(String(e.message || e))}</li>`;
    return;
  }
  scene = loadScene();
  debugLog = loadDebugLog();
  $("#pg-material").value = scene.config.material;
  try {
    await Promise.all(DOC_PATHS.map(async (path) => {
      const r = await fetch(path);
      if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
      docs[path] = docText(path, await r.text());
    }));
  } catch (e) {
    status.textContent = "";
    $("#pg-messages").innerHTML = `<li>could not load the prompt docs: ${escapeHtml(String(e.message || e))}</li>`;
    return;
  }
  ready = true;
  status.textContent = "";
  $("#pg-send-btn").classList.remove("disabled");
  renderTranscript();
  rerenderAll();
}

// ------------------------------------------------------- stage requests --
//
// Prompt text is assembled by prompt-assembly.js -- a DOM-free module, so
// the same code that builds a live call is what the offline prompt tests
// exercise. This file only supplies the scene and the catalog.

const systemPromptFor = (stage) => composeSystemPrompt(stage, { docs, scene, C });
const routeMessages = () => composeRouteMessages(scene);
const stageUserMessage = (stage, instruction, targets) => composeUserMessage(stage, { scene, C, instruction, targets });

// One array item per line, each compact -- readable for the model without
// pretty-printing every coordinate onto its own line.
function jsonLines(arr) {
  if (!Array.isArray(arr) || !arr.length) return "[]";
  return "[\n" + arr.map((x) => "  " + JSON.stringify(x)).join(",\n") + "\n]";
}

// `contextScene` defaults to the live scene; a *-check call passes a
// draft scene-like object instead, since its response's elementIds may
// reference elements the real scene hasn't merged yet.
function apiKeyFor(provider) {
  return $(provider === "openai" ? "#pg-openai-key" : "#pg-anthropic-key").value;
}

async function callStage(stage, messages, contextScene = scene) {
  const provider = $("#pg-provider").value;
  const model = $("#pg-model").value;
  const effort = $("#pg-effort").value;
  // A stage that isn't thinking-capable (route, geometry-check,
  // texture-check -- see stage-schemas.js) never gets thinking on, even if
  // the page-wide toggle is, same cap the old proxy enforced server-side.
  const thinking = $("#pg-thinking").value === "on" && !!STAGES[stage].thinking;
  const apiKey = apiKeyFor(provider);

  // Built up as the call progresses and logged in `finally` below no
  // matter where (or whether) it throws -- a failed call is exactly the
  // one you most need in the debug log. Includes the generation settings
  // actually in effect for this call (not just stage/model), so "was
  // thinking on for this?" / "did self-check even run?" are answerable
  // from the log alone instead of having to be asked.
  const record = {
    stage, provider, model, effort, thinking, selfCheck: selfCheckEnabled(), material: scene?.config?.material,
    userMessage: messages[messages.length - 1]?.content || "",
  };
  try {
    const cfg = STAGES[stage];
    let data;
    try {
      data = await callLlmDirect({
        provider, apiKey, model, systemPrompt: systemPromptFor(stage), messages,
        schema: cfg.schema, schemaName: cfg.schemaName, maxOutputTokens: cfg.maxOutputTokens,
        effort, thinking,
      });
    } catch (e) {
      record.httpError = String(e.message || e);
      throw e;
    }
    const { text, refusal } = extractResponseOutput(data, provider);
    if (refusal) { record.refusal = refusal; throw new Error(`the model declined: ${refusal}`); }
    if (!text) { record.httpError = "no text content returned by the model"; throw new Error(record.httpError); }
    record.rawOutput = text;
    if (data.usage) record.usage = data.usage;
    let json;
    try { json = JSON.parse(text); }
    catch (e) {
      record.parseError = e.message + (wasTruncated(data, provider) ? " (looks truncated -- hit the token limit)" : "");
      if (wasTruncated(data, provider)) throw new Error("generation was cut off (token limit) -- try again or narrow the request");
      throw new Error(`could not parse the model output as JSON: ${e.message}`);
    }
    if (data.usage) recordCost(data.usage, model);
    // A rejected output is data, not an exception: the pipeline's gate
    // hands these errors straight back to the same stage as a repair.
    // Only a network, refusal or parse failure is fatal to the turn.
    const v = C.validateStageOutput(stage, json, contextScene);
    record.validationErrors = v.errors;
    return { value: v.value, errors: v.errors, raw: text };
  } finally {
    logDebugCall(record);
  }
}

// The two calls that are not one of the pipeline's generating stages: the
// manager (multi-turn, sees the conversation) and the judge (single-turn,
// sees the finished scene and the app's numbers).
async function callRoute(refine) {
  const messages = composeRouteMessages(scene);
  if (refine) messages.push({ role: "user", content: composeRefineMessage(refine) });
  const res = await callStage("route", messages);
  if (res.errors.length) throw new Error(`the manager's answer was rejected: ${res.errors.join("; ")}`);
  return res.value;
}

async function callJudge(plan, compiled, notes) {
  const content = composeJudgeMessage({ scene, C, instruction: plan.instruction, acceptance: plan.acceptance, compiled, notes });
  const res = await callStage("judge", [{ role: "user", content }]);
  return res.value;
}

// ---------------------------------------------------------- orchestration --

function setBusy(on, text = "") {
  busy = on;
  $("#pg-send-btn").classList.toggle("active", on);
  $("#pg-status").textContent = text;
}

function showMessages(items) {
  $("#pg-messages").innerHTML = items.map((w) => `<li>${w}</li>`).join("");
}

function pushMessage(role, content, stage) {
  scene.messages.push(stage ? { role, content, stage } : { role, content });
  saveScene();
  renderTranscript();
}

async function onSend() {
  const input = $("#pg-input");
  const instruction = input.value.trim();
  showMessages([]);
  if (busy) return;
  if (!ready) { showMessages(["still loading — try again in a moment"]); return; }
  if (!instruction) { showMessages(["type a message first"]); return; }
  if (!apiKeyFor($("#pg-provider").value)) { showMessages([`enter your ${$("#pg-provider").value} API key first`]); return; }

  pushMessage("user", instruction);
  input.value = "";
  beginDebugTurn(instruction);
  setBusy(true, "deciding…");
  await driveTurn();
}

// Everything the pipeline needs from the page: how to call a model, how to
// compile, how to merge, and how to say what it is doing. The loop itself
// lives in pipeline.js, where it is tested without a browser.
function turnDeps() {
  const notes = [];
  return {
    C,
    selfCheck: selfCheckEnabled(),
    maxRepairs: 2,
    maxRefineRounds: selfCheckEnabled() ? 2 : 0,
    notes,
    route: (refine) => {
      setBusy(true, refine ? "deciding what to fix…" : "deciding…");
      return callRoute(refine);
    },
    callModel: (stage, content, contextScene) => callStage(stage, [{ role: "user", content }], contextScene),
    composeUser: (stage, opts) => composeUserMessage(stage, { scene, C, ...opts }),
    compile: (s) => C.compileScene(s),
    merge: (stage, value) => {
      if (value.chat) { pushMessage("assistant", value.chat, stage); notes.push(`${stage}: ${value.chat}`); }
      if (stage === "geometry") return C.mergeGeometry(scene, value);
      if (stage === "texture") return C.mergeTextures(scene, value);
      if (stage === "ui") return C.mergeUi(scene, value);
      return [];
    },
    judge: (plan) => {
      setBusy(true, "checking it against what you asked for…");
      return callJudge(plan, C.compileScene(scene), notes);
    },
    onProgress: ({ stage, attempt, repairing }) => {
      setBusy(true, repairing
        ? `fixing ${STAGE_LABEL[stage] || stage} (attempt ${attempt + 1})…`
        : `generating ${STAGE_LABEL[stage] || stage}…`);
    },
  };
}

async function driveTurn(refineOnly = false) {
  const deps = turnDeps();
  let out;
  try {
    out = await runTurn({ scene }, deps);
  } catch (e) {
    setBusy(false);
    rerenderAll();
    showMessages([escapeHtml(String(e.message || e)), retryLink()]);
    return;
  }
  lastTurn = out;

  if (out.stopped === "chat") {
    pushMessage("assistant", out.plan?.reply || "(no reply)", "chat");
  } else if (out.stopped === "gate") {
    const errs = out.rounds[out.rounds.length - 1]?.ran?.slice(-1)[0]?.errors || [];
    showMessages([
      `the ${escapeHtml(STAGE_LABEL[out.failedStage] || out.failedStage)} stage could not produce something printable after ${deps.maxRepairs} attempts:`,
      ...errs.slice(0, 4).map((e) => escapeHtml(e)),
      "what it last proposed is in the panel, so you can also fix it by hand",
      retryLink(),
    ]);
  } else if (out.verdict && !out.verdict.pass) {
    pushMessage("assistant", out.verdict.note || "some of what you asked for is still not right", "check");
  } else if (out.verdict?.note) {
    pushMessage("assistant", out.verdict.note, "check");
  }

  setBusy(false);
  rerenderAll();
}

function retryLink() {
  return `<span class="pg-retry" data-kind="turn">try that turn again</span>`;
}

function selfCheckEnabled() { return $("#pg-self-check").value === "on"; }

async function onRetry() {
  if (busy || !scene.messages.length) return;
  setBusy(true, "deciding…");
  await driveTurn();
}

// The turn's acceptance criteria and how they came out, under the digest:
// what the manager decided "done" meant, and whether the app's own numbers
// agreed. Rendered from the last turn only -- it describes that turn.
function renderVerdict() {
  const el = $("#pg-verdict");
  if (!el) return;
  const plan = lastTurn?.plan;
  const criteria = plan?.acceptance || [];
  if (!criteria.length) { el.innerHTML = ""; return; }
  const failures = lastTurn?.verdict?.failures || [];
  const failed = new Set(failures.map((f) => f.criterion));
  const rows = criteria.map((c) => {
    const bad = failed.has(c);
    return `<li class="${bad ? "pg-crit-bad" : "pg-crit-ok"}">${bad ? "✗" : "✓"} ${escapeHtml(c)}</li>`;
  }).join("");
  const why = failures.map((f) => `<li>${escapeHtml(f.criterion)} — ${escapeHtml(f.evidence)}</li>`).join("");
  el.innerHTML = `<div class="pg-section">what this turn was checked against</div><ul class="pg-crits">${rows}</ul>` +
    (why ? `<div class="pg-warns"><strong>not met:</strong><ul>${why}</ul></div>` : "");
}

// ----------------------------------------------------------------- render --

function renderTranscript() {
  const el = $("#pg-transcript");
  el.innerHTML = scene.messages.map((m) =>
    `<div class="pg-msg pg-${m.role}"><span class="pg-role">${m.role === "user" ? "you" : `AI${m.stage ? ` · ${escapeHtml(m.stage)}` : ""}`}</span>` +
    `<div class="pg-msg-body">${escapeHtml(m.content)}</div></div>`
  ).join("");
  el.scrollTop = el.scrollHeight;
}

function rerenderAll() {
  renderPanel();
  rerunGcode();
  renderVerdict();
}

function scheduleRerun() {
  clearTimeout(rerunTimer);
  rerunTimer = setTimeout(rerunGcode, 250);
}

function rerunGcode() {
  const digestEl = $("#pg-digest");
  const reportEl = $("#pg-report");
  const textarea = $("#raw-gcode-textarea");
  if (!ready) { digestEl.textContent = "not loaded"; return; }
  if (!scene.elements.length) {
    textarea.value = "";
    reportEl.textContent = "(no elements yet)";
    digestEl.innerHTML = `<p style="color:#999;">no elements yet — describe a graphic in the chat</p>`;
    scene.lastReport = null;
    saveScene();
    return;
  }
  let compiled, run;
  try {
    compiled = C.compileScene(scene);
    run = C.runJobs(compiled.jobs, { material: scene.config.material });
  } catch (e) {
    digestEl.innerHTML = `<p style="color:#c00;">compiler error: ${escapeHtml(String(e.message || e))}</p>`;
    return;
  }
  scene.lastReport = compiled.report;
  saveScene();
  textarea.value = run.gcode;
  reportEl.textContent = C.reportText(compiled.report);

  const errors = [...compiled.errors, ...run.errors];
  const warnings = [...compiled.warnings, ...run.warnings];
  const d = run.digest;
  const rows = [
    `<tr><td>G-code lines</td><td>${d.lineCount}</td></tr>`,
    `<tr><td>retraction cycles</td><td>${d.retractCycles}</td></tr>`,
    `<tr><td>bed bounds</td><td>${d.boundsOk ? "ok" : "OUT OF BOUNDS"}</td></tr>`,
    `<tr><td>jobs</td><td>${compiled.jobs.length}</td></tr>`,
  ].join("");
  const errs = errors.length ? `<div class="pg-errs"><strong>errors — not safe to print:</strong><ul>${errors.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : "";
  const warns = warnings.length ? `<div class="pg-warns"><strong>warnings:</strong><ul>${warnings.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : "";
  const badge = errors.length ? `<div class="pg-notok">✗ ${errors.length} blocking issue(s)</div>` : `<div class="pg-ok">✓ verification passed</div>`;
  digestEl.innerHTML = `${badge}<table class="pg-digest-table">${rows}</table>${errs}${warns}`;
}

// -------------------------------- panel --

// Order, top to bottom: printing settings (global, always visible) -- one
// top-level card per scene.groups entry NOT scoped to exactly one element
// (a graphic-level control, or a felt quality spanning several elements --
// see topLevelGroups/groupsForElement in the catalog) -- then one card per
// element, each holding its own slice of the relevant groups, its shape
// editor, and a fully collapsible per-slot stroke/brush/pattern breakdown.
// A group spanning several elements shows up BOTH as its own top-level card
// AND inside each of those elements' own cards -- deliberate, not a
// duplicate to remove (see the parameters-panel plan).
//
// Editing any field now re-renders this whole panel (so two displays of the
// same value never drift), which would otherwise collapse every open
// <details> back closed on every keystroke -- captureOpenKeys/applyOpenState
// preserve open/closed state, at every nesting level, across each rebuild.
function renderPanel() {
  const el = $("#pg-params");
  const openKeys = captureOpenKeys(el);
  el.innerHTML = "";
  el.appendChild(renderGraphicCard());

  const topGroups = C.topLevelGroups(scene);
  if (topGroups.length) {
    el.appendChild(section("relevant parameters"));
    topGroups.forEach((g) => el.appendChild(renderGroupCard(g)));
  }

  el.appendChild(section("elements"));
  if (!scene.elements.length) el.appendChild(note("elements appear here after the AI proposes a graphic"));
  const targeted = new Set(lastTurn?.plan?.targets || []);
  const rank = (e) => (targeted.has(e.id) ? 0 : 1);
  const ordered = scene.elements.map((e, idx) => [e, idx]).sort((a, b) => rank(a[0]) - rank(b[0]));
  ordered.forEach(([element, idx]) => el.appendChild(renderElementCard(element, idx)));

  applyOpenState(el, openKeys, targeted);
}

// Every collapsible <details> this panel builds (element cards, slot
// breakdowns, stroke/brush/pattern subsections, an element's own
// generated-ui section) carries a stable `data-open-key` -- see
// collapsibleCard()'s callers. Captured before a rebuild, restored after.
function captureOpenKeys(container) {
  return new Set([...container.querySelectorAll("details[data-open-key][open]")].map((d) => d.dataset.openKey));
}
function applyOpenState(container, openKeys, targetedIds) {
  const GEN_UI_SUFFIX = ":generated-ui";
  for (const d of container.querySelectorAll("details[data-open-key]")) {
    const key = d.dataset.openKey;
    if (openKeys.has(key)) { d.open = true; continue; }
    // A freshly-relevant generated-ui section defaults open even before the
    // user has ever manually opened it -- but only as a default: an
    // explicit prior close (captured above) always wins.
    if (key.endsWith(GEN_UI_SUFFIX) && targetedIds.has(key.slice(0, -GEN_UI_SUFFIX.length))) d.open = true;
  }
}

function section(title) {
  const h = document.createElement("div");
  h.className = "pg-section";
  h.textContent = title;
  return h;
}
function note(text) {
  const p = document.createElement("p");
  p.style.color = "#999";
  p.textContent = text;
  return p;
}
function card(title, sub) {
  const c = document.createElement("div");
  c.className = "pg-call";
  const head = document.createElement("div");
  head.className = "pg-call-head";
  head.innerHTML = `<span class="pg-call-label">${escapeHtml(title)}</span><span class="pg-call-fn">${escapeHtml(sub || "")}</span>`;
  c.appendChild(head);
  return c;
}
// Same head shape as card(), but a native <details> so it starts closed --
// used for per-element cards, which default to collapsed so a scene with
// many elements doesn't bury the parameters the ui stage actually surfaced.
function collapsibleCard(title, sub, openKey) {
  const c = document.createElement("details");
  c.className = "pg-call";
  if (openKey) c.dataset.openKey = openKey;
  const head = document.createElement("summary");
  head.className = "pg-call-head";
  head.innerHTML = `<span class="pg-call-label">${escapeHtml(title)}</span><span class="pg-call-fn">${escapeHtml(sub || "")}</span>`;
  c.appendChild(head);
  return c;
}
function fieldsGrid() {
  const w = document.createElement("div");
  w.className = "pg-fields";
  return w;
}
// A light-weight in-card heading -- same visual weight as a slot's own
// "brush"/"pattern" title, used for things nested inside a card that aren't
// worth a full top-level section() heading.
function subLabel(text) {
  const d = document.createElement("div");
  d.className = "pg-fields-title";
  d.textContent = text;
  return d;
}
// One collapsible stroke/brush/pattern subsection inside a slot.
function renderOptionSubsection(openKey, label, fields) {
  const c = collapsibleCard(label, "", openKey);
  const g = fieldsGrid();
  fields.forEach((f) => g.appendChild(f));
  c.appendChild(g);
  return c;
}
function commitGeometry() { saveScene(); scheduleRerun(); }

// --- graphic (global) ---

function renderGraphicCard() {
  const c = card("printing settings", "scale, position, material — the whole print, not one element");
  const grid = fieldsGrid();
  grid.appendChild(renderField("scale %", { kind: "num", step: 5, min: 10, max: 400 }, +(scene.transform.scale * 100).toFixed(1), (v) => {
    if (v != null && v > 0) scene.transform.scale = v / 100;
    commitGeometry();
  }));
  const natural = scene.lastReport?.naturalBbox;
  const ox = scene.transform.origin ? scene.transform.origin[0] : natural?.minX;
  const oy = scene.transform.origin ? scene.transform.origin[1] : natural?.minY;
  const setOrigin = (i, v) => {
    const cur = scene.transform.origin || [natural?.minX ?? 20, natural?.minY ?? 20];
    if (v == null) { scene.transform.origin = null; }
    else { cur[i] = v; scene.transform.origin = cur; }
    commitGeometry();
  };
  grid.appendChild(renderField("origin x (min corner)", { kind: "nnum", step: 1 }, ox, (v) => setOrigin(0, v)));
  grid.appendChild(renderField("origin y (min corner)", { kind: "nnum", step: 1 }, oy, (v) => setOrigin(1, v)));
  const matLbl = document.createElement("label");
  matLbl.className = "pg-field";
  matLbl.innerHTML = `<span>material</span>`;
  const matSel = document.createElement("select");
  for (const [v, text] of [["TPU", "TPU (default)"], ["PLA", "PLA"]]) {
    const o = document.createElement("option");
    o.value = v; o.textContent = text;
    if (v === scene.config.material) o.selected = true;
    matSel.appendChild(o);
  }
  matSel.onchange = () => {
    scene.config.material = matSel.value;
    const other = $("#pg-material");
    if (other) other.value = matSel.value;
    saveScene(); scheduleRerun();
  };
  matLbl.appendChild(matSel);
  grid.appendChild(matLbl);
  c.appendChild(grid);
  const row = document.createElement("div");
  row.className = "pg-btn-row";
  row.appendChild(smallBtn("fit to safe area", () => {
    const nb = scene.lastReport?.naturalBbox;
    if (!nb) return;
    const w = nb.maxX - nb.minX, h = nb.maxY - nb.minY;
    const span = C.CONSTRAINTS.safeMax - C.CONSTRAINTS.safeMin;
    scene.transform.scale = Math.min(span / Math.max(w, 1e-6), span / Math.max(h, 1e-6));
    scene.transform.origin = [C.CONSTRAINTS.safeMin, C.CONSTRAINTS.safeMin];
    commitGeometry(); renderPanel();
  }));
  row.appendChild(smallBtn("reset", () => { scene.transform = { scale: 1, origin: null }; commitGeometry(); renderPanel(); }));
  c.appendChild(row);
  return c;
}

function smallBtn(label, onClick) {
  const b = document.createElement("span");
  b.className = "btn pg-small-btn";
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

// --- elements ---

function renderElementCard(el, idx) {
  const groupCount = el.kind === "point" && Array.isArray(el.at) && Array.isArray(el.at[0]) ? el.at.length
    : el.kind === "line" && Array.isArray(el.paths) ? el.paths.length : null;
  const c = collapsibleCard(el.label || el.id, `${el.id} · ${el.kind}${el.role ? ` · ${el.role}` : ""}${groupCount != null ? ` · group of ${groupCount}` : ""}`, el.id);
  const del = document.createElement("span");
  del.className = "pg-call-del";
  del.textContent = "remove";
  del.onclick = () => {
    scene.elements.splice(idx, 1);
    delete scene.textures[el.id];
    C.pruneGroups(scene);
    saveScene(); rerenderAll();
  };
  c.querySelector(".pg-call-head").appendChild(del);

  const generatedUi = renderElementGeneratedUi(el);
  if (generatedUi) c.appendChild(generatedUi);

  c.appendChild(subLabel("shape"));
  c.appendChild(renderGeometryEditor(el));

  const tex = scene.textures[el.id] || (scene.textures[el.id] = {});
  if (el.kind === "region") c.appendChild(renderPatternEditor(el, tex));

  for (const slot of C.slotsFor(el.kind)) {
    const slotCard = collapsibleCard(slot, "", `${el.id}:${slot}`);
    slotCard.appendChild(renderSlotEditor(el, tex, slot));
    c.appendChild(slotCard);
  }
  return c;
}

// This element's own slice of every relevant scene.groups entry -- its own
// single-element groups (shown complete), plus its own member from any
// group that also spans other elements (that group's other members live in
// their own elements' cards, and the whole group also has its own top-level
// card -- see groupsForElement in the catalog for why that's intentional).
// Returns null when there's nothing to show, so the caller can skip the
// section entirely rather than rendering an empty heading.
function renderElementGeneratedUi(el) {
  const groups = C.groupsForElement(scene, el.id);
  if (!groups.length) return null;
  const c = collapsibleCard("generated ui", "", `${el.id}:generated-ui`);
  for (const g of groups) c.appendChild(renderGroupCard(g, el.id));
  return c;
}

// A small "single | group" toggle shared by point/line editors -- a group
// is several stamps/strokes sharing this one element's texture (ticks,
// gridlines, a row of markers). `onToggle(isGroup)` swaps the element's
// geometry field shape; the caller re-renders.
// A "form" select: which shape of geometry this element is written in.
// `options` is [[value, label], ...]; `onChange` gets the chosen value.
function formToggle(options, current, onChange) {
  const lbl = document.createElement("label");
  lbl.className = "pg-field";
  lbl.innerHTML = `<span>form</span>`;
  const sel = document.createElement("select");
  options.forEach(([v, text]) => {
    const o = document.createElement("option");
    o.value = v; o.textContent = text;
    if (v === current) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = () => onChange(sel.value);
  lbl.appendChild(sel);
  return lbl;
}

// The bounds of an app-solved region. The crossings and the shaded span
// are computed by the compiler, so the only things to edit here are which
// curves bound it and (optionally) a narrower x range -- the solved range
// itself is shown in the geometry report, not typed in.
function renderBetweenEditor(el) {
  const b = el.between;
  const g = fieldsGrid();
  const lineIds = scene.elements.filter((e) => e.kind === "line" && !Array.isArray(e.paths)).map((e) => e.id);
  const LEVEL = "(a flat y level)";
  const boundField = (which) => {
    const cur = b[which];
    const isLevel = cur && typeof cur === "object";
    g.appendChild(renderField(`${which} bound`, { kind: "enum", options: [...(lineIds.length ? lineIds : [""]), LEVEL], def: lineIds[0] || "" }, isLevel ? LEVEL : cur, (v) => {
      b[which] = v === LEVEL ? { y: 40 } : v;
      commitGeometry(); renderPanel();
    }));
    if (isLevel) g.appendChild(numField(`${which} y (mm)`, cur.y, (v) => { if (v != null) { b[which] = { y: v }; commitGeometry(); } }));
  };
  boundField("upper");
  boundField("lower");
  const xField = (key) => renderField(`${key} (blank = solved)`, { kind: "nnum", step: 1 }, b[key] ?? null, (v) => {
    if (v == null) delete b[key]; else b[key] = v;
    commitGeometry();
  });
  g.appendChild(xField("xFrom"));
  g.appendChild(xField("xTo"));
  return g;
}

function groupToggle(isGroup, onToggle) {
  const lbl = document.createElement("label");
  lbl.className = "pg-field";
  lbl.innerHTML = `<span>form</span>`;
  const sel = document.createElement("select");
  [["single", "single"], ["group", "group (repeated, one texture)"]].forEach(([v, text]) => {
    const o = document.createElement("option"); o.value = v; o.textContent = text;
    if ((isGroup ? "group" : "single") === v) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = () => onToggle(sel.value === "group");
  lbl.appendChild(sel);
  return lbl;
}

function renderGeometryEditor(el) {
  const wrap = document.createElement("div");
  if (el.kind === "point") {
    const isGroup = Array.isArray(el.at) && Array.isArray(el.at[0]);
    wrap.appendChild(groupToggle(isGroup, (toGroup) => {
      el.at = toGroup ? (isGroup ? el.at : [el.at || [110, 110]]) : (isGroup ? (el.at[0] || [110, 110]) : (el.at || [110, 110]));
      commitGeometry(); renderPanel();
    }));
    if (isGroup) {
      wrap.appendChild(jsonField("points [[x,y],…] -- one stamp per entry, all sharing this element's texture", el.at, (v) => {
        if (Array.isArray(v) && v.length) { el.at = v; commitGeometry(); }
      }));
    } else {
      el.at = Array.isArray(el.at) && !Array.isArray(el.at[0]) ? el.at : [110, 110];
      const g = fieldsGrid();
      g.appendChild(numField("x", el.at[0], (v) => { el.at[0] = v; commitGeometry(); }));
      g.appendChild(numField("y", el.at[1], (v) => { el.at[1] = v; commitGeometry(); }));
      wrap.appendChild(g);
    }
  } else if (el.kind === "line") {
    const isGroup = Array.isArray(el.paths);
    wrap.appendChild(groupToggle(isGroup, (toGroup) => {
      if (toGroup) { el.paths = isGroup ? el.paths : [el.path || { points: [[40, 40], [60, 40]] }]; delete el.path; }
      else { el.path = isGroup ? (el.paths[0] || { x: "40 + t", y: "110", tEnd: 60 }) : el.path; delete el.paths; }
      commitGeometry(); renderPanel();
    }));
    if (isGroup) {
      // A group is ONE element sharing ONE texture -- edit it as one
      // compact block (like a point group's point list), not as N
      // expanded per-stroke editors that read as N separate elements.
      // Each entry is a piece object (usually {"points": [[x,y],[x,y]]}
      // for a short straight stroke; a formula/ref piece object also
      // works but is rarer for a group and edited as raw JSON here).
      wrap.appendChild(jsonField(`strokes [{"points":[[x,y],[x,y]]}, …] -- one stroke per entry, all sharing this element's texture`, el.paths, (v) => {
        if (Array.isArray(v) && v.length) { el.paths = v; commitGeometry(); }
      }));
    } else {
      el.path = el.path && typeof el.path === "object" ? el.path : { x: "40 + t", y: "110", tEnd: 60 };
      wrap.appendChild(renderPieceEditor(el.path, (p) => { el.path = p; commitGeometry(); renderPanel(); }, false));
    }
  } else if (el.kind === "region") {
    const isBetween = !!el.between;
    wrap.appendChild(formToggle(
      [["boundary", "boundary (an explicit outline)"], ["between", "between (app-solved area under/between curves)"]],
      isBetween ? "between" : "boundary",
      (form) => {
        if (form === "between") {
          const lines = scene.elements.filter((e) => e.kind === "line" && !Array.isArray(e.paths)).map((e) => e.id);
          el.between = { upper: lines[0] || "", lower: lines[1] || { y: 40 } };
          delete el.boundary;
        } else {
          el.boundary = [{ points: [[40, 40], [80, 40], [80, 70], [40, 70], [40, 40]] }];
          delete el.between;
        }
        commitGeometry(); renderPanel();
      },
    ));
    if (isBetween) { wrap.appendChild(renderBetweenEditor(el)); return wrap; }
    el.boundary = Array.isArray(el.boundary) && el.boundary.length ? el.boundary : [{ points: [[40, 40], [80, 40], [80, 70], [40, 70], [40, 40]] }];
    const list = document.createElement("div");
    el.boundary.forEach((piece, i) => {
      const pw = document.createElement("div");
      pw.className = "pg-piece";
      const head = document.createElement("div");
      head.className = "pg-fields-title";
      head.textContent = `boundary piece ${i + 1}`;
      const rm = document.createElement("span");
      rm.className = "pg-call-del";
      rm.textContent = "remove piece";
      rm.onclick = () => { el.boundary.splice(i, 1); commitGeometry(); renderPanel(); };
      head.appendChild(rm);
      pw.appendChild(head);
      pw.appendChild(renderPieceEditor(piece, (p) => { el.boundary[i] = p; commitGeometry(); renderPanel(); }, true));
      list.appendChild(pw);
    });
    wrap.appendChild(list);
    const row = document.createElement("div");
    row.className = "pg-btn-row";
    row.appendChild(smallBtn("+ piece", () => { el.boundary.push({ points: [[40, 40], [60, 40]] }); commitGeometry(); renderPanel(); }));
    wrap.appendChild(row);
  }
  return wrap;
}

function pieceType(piece) {
  if (piece && Array.isArray(piece.points)) return "points";
  if (piece && typeof piece.ref === "string") return "ref";
  return "formula";
}

// One piece: type select + its fields. `onReplace` gets a whole new piece
// object when the type changes; in-place edits just commit.
function renderPieceEditor(piece, onReplace, allowRef) {
  const g = fieldsGrid();
  const type = pieceType(piece);
  const types = allowRef ? ["formula", "points", "ref"] : ["formula", "points"];
  g.appendChild(renderField("piece", { kind: "enum", options: types, def: type }, type, (t) => {
    if (t === type) return;
    if (t === "points") onReplace({ points: [[40, 40], [80, 40]] });
    else if (t === "ref") onReplace({ ref: scene.elements.find((e) => e.kind === "line")?.id || "", reverse: false });
    else onReplace({ x: "40 + t", y: "110", tEnd: 60 });
  }));
  if (type === "formula") {
    g.appendChild(textField("x(t)", piece.x ?? "", (v) => { piece.x = v; commitGeometry(); }, true));
    g.appendChild(textField("y(t)", piece.y ?? "", (v) => { piece.y = v; commitGeometry(); }, true));
    g.appendChild(numField("tEnd", piece.tEnd, (v) => { piece.tEnd = v; commitGeometry(); }));
  } else if (type === "points") {
    g.appendChild(jsonField("points [[x,y],…]", piece.points, (v) => { if (Array.isArray(v)) { piece.points = v; commitGeometry(); } }));
  } else {
    const lines = scene.elements.filter((e) => e.kind === "line").map((e) => e.id);
    g.appendChild(renderField("ref (line id)", { kind: "enum", options: lines.length ? lines : [""], def: piece.ref }, piece.ref, (v) => { piece.ref = v; commitGeometry(); }));
    g.appendChild(renderField("reverse", { kind: "bool", def: false }, !!piece.reverse, (v) => { piece.reverse = v; commitGeometry(); }));
    // x range rather than the referenced path's own parameter: it means
    // the same thing on a formula and on a point list, and it is the
    // number anyone actually has in mind ("the axis from 60 to 90").
    g.appendChild(renderField("xFrom (blank = whole path)", { kind: "nnum", step: 1 }, piece.xFrom ?? null, (v) => { if (v == null) delete piece.xFrom; else piece.xFrom = v; commitGeometry(); }));
    g.appendChild(renderField("xTo (blank = whole path)", { kind: "nnum", step: 1 }, piece.xTo ?? null, (v) => { if (v == null) delete piece.xTo; else piece.xTo = v; commitGeometry(); }));
  }
  return g;
}

// --- textures ---

function renderSlotEditor(el, tex, slot) {
  const wrap = document.createElement("div");
  const g = fieldsGrid();
  const s = tex[slot];
  const isFill = slot === "fill";
  // A point element or a points-placing fill pattern needs a brush that's
  // point-safe (see POINT_SAFE_BRUSHES/isPointSafe) -- everything else can
  // offer the full brush list. The pattern KIND itself is chosen under
  // "shape" (renderPatternEditor) -- it decides the spatial arrangement,
  // not how it's printed -- but this slot still reads it, since which
  // brushes are even valid here depends on it (a stamp-style pattern needs
  // a point-safe brush, a stroke-style one doesn't).
  const patKind = isFill ? (s?.pattern?.kind || "hatch") : null;
  const needsPointSafe = el.kind === "point" || (isFill && C.STAMP_PATTERNS.includes(patKind));
  const names = ["(none)", ...(needsPointSafe ? [...C.POINT_SAFE_BRUSHES] : C.BRUSH_NAMES)];
  g.appendChild(renderField("brush", { kind: "enum", options: names, def: "(none)" }, s?.fn || "(none)", (v) => {
    if (v === "(none)") delete tex[slot];
    else if (!s || s.fn !== v) tex[slot] = { fn: v, options: {}, bases: {}, ...(isFill ? { pattern: s?.pattern || { kind: "hatch" } } : {}) };
    C.pruneGroups(scene);
    saveScene(); rerenderAll();
  }));
  wrap.appendChild(g);

  // The brush dropdown above only picks WHICH brush is used; its own
  // numeric options (width, nLayers, spacing, ...) get their own
  // collapsible subsection per level, bucketed by the level S()/B() already
  // tags each option with in BRUSH_OPTIONS -- stroke (the walk: layers,
  // arc-length spacing, ...) vs brush (the local deposit: width, height,
  // local speed, ...). Only shown once a brush is actually selected.
  if (s) {
    const spec = C.optionSpecFor(s.fn);
    const strokeKeys = Object.keys(spec).filter((k) => spec[k].level === "stroke");
    const brushKeys = Object.keys(spec).filter((k) => spec[k].level === "brush");
    if (strokeKeys.length) {
      wrap.appendChild(renderOptionSubsection(`${el.id}:${slot}:stroke`, "stroke",
        strokeKeys.map((k) => optionField(k, spec[k], { level: "stroke", elementId: el.id, slot, option: k }, s))));
    }
    if (brushKeys.length) {
      wrap.appendChild(renderOptionSubsection(`${el.id}:${slot}:brush`, "brush",
        brushKeys.map((k) => optionField(k, spec[k], { level: "brush", elementId: el.id, slot, option: k }, s))));
    }
  }
  return wrap;
}

// Fill pattern selection lives under "shape", not inside the fill slot's
// own collapsible: which spatial arrangement fills a region (hatch, grid,
// diamond, ...) is a geometric decision about what the shape looks like,
// same as the boundary itself -- the fill slot's own stroke/brush
// breakdown (renderSlotEditor) is purely about how that arrangement gets
// printed, a separate concern. Region elements only; line/point elements
// have no fill slot.
function renderPatternEditor(el, tex) {
  const wrap = document.createElement("div");
  wrap.appendChild(subLabel("pattern"));
  const s = tex.fill;
  const pat = s?.pattern || { kind: "hatch" };
  const g = fieldsGrid();
  g.appendChild(renderField("pattern", { kind: "enum", options: C.PATTERN_KINDS, def: "hatch" }, pat.kind, (kind) => {
    const next = { kind, ...(C.PATTERN_OPTIONS[kind] ? Object.fromEntries(Object.entries(C.PATTERN_OPTIONS[kind]).map(([k, m]) => [k, m.def])) : {}) };
    if (kind === "stamps") next.points = [[60, 60], [70, 60]];
    if (kind === "strokes") next.strokes = [[[40, 40], [80, 80]]];
    if (kind === "curves") next.curves = [{ x: "40 + t", y: "60 + 5*sin(t/4)", tEnd: 60 }];
    if (kind === "family") Object.assign(next, { x: "110 + t*cos(u)", y: "110 + t*sin(u)", tEnd: 40, uEnd: 6.28, uStep: 0.5 });
    if (!s) tex.fill = { fn: C.STAMP_PATTERNS.includes(kind) ? "blob" : "solid", options: {}, bases: {}, pattern: next };
    else {
      s.pattern = next;
      const needStamp = C.STAMP_PATTERNS.includes(kind);
      if (needStamp !== C.isPointSafe(s.fn)) { s.fn = needStamp ? "blob" : "solid"; s.options = {}; s.bases = {}; }
    }
    C.pruneGroups(scene);
    saveScene(); rerenderAll();
  }));
  wrap.appendChild(g);

  if (s) {
    // level "pattern" explicitly: a fill's brush and its pattern are
    // separately-named spaces, and some names exist in both (a
    // blobDotted fill and a hatch pattern both have "gap").
    const patSpec = C.PATTERN_OPTIONS[pat.kind];
    if (patSpec) {
      const fields = Object.keys(patSpec).map((k) => optionField(k, patSpec[k], { level: "pattern", elementId: el.id, slot: "fill", option: k }, s));
      wrap.appendChild(renderOptionSubsection(`${el.id}:pattern`, "options", fields));
    } else {
      const { kind, ...rest } = pat;
      const patCard = collapsibleCard("options", "", `${el.id}:pattern`);
      patCard.appendChild(jsonField(`${kind} spec (JSON)`, rest, (v) => {
        if (v && typeof v === "object") { s.pattern = { kind, ...v }; saveScene(); renderPanel(); scheduleRerun(); }
      }));
      wrap.appendChild(patCard);
    }
  }
  return wrap;
}

// --- surfaced parameter groups ---

// A group is a heading plus whichever real parameters the ui stage judged
// relevant to this turn. Each control edits its own option directly: no
// knob, no weights, nothing between the number shown and the number
// printed.
// `forElementId`: when this card is being rendered nested inside that
// element's own card (renderElementGeneratedUi), each member's label drops
// the redundant "element name" part -- the enclosing card already says
// which element this is. Omitted for the top-level rendering, where a
// group can span several elements and each row needs to say which one.
function renderGroupCard(group, forElementId = null) {
  const c = card(group.title, "");
  const del = document.createElement("span");
  del.className = "pg-call-del";
  del.textContent = "remove";
  // Match by id, not by reference: a per-element slice (groupsForElement)
  // hands this a freshly filtered copy, never the object actually sitting
  // in scene.groups -- removing by identity would silently no-op there.
  del.onclick = () => { scene.groups = scene.groups.filter((x) => x.id !== group.id); saveScene(); rerenderAll(); };
  c.querySelector(".pg-call-head").appendChild(del);
  if (group.description) {
    const p = document.createElement("div");
    p.className = "pg-desc";
    p.textContent = group.description;
    c.appendChild(p);
  }
  const g = fieldsGrid();
  let shown = 0;
  for (const m of group.members || []) {
    const f = memberField(m, forElementId);
    if (f) { g.appendChild(f); shown++; }
  }
  c.appendChild(g);
  if (!shown) c.appendChild(note("these controls no longer apply to the current textures"));
  return c;
}

// One control for one group member. `control.min`/`max` narrow the input
// to what suits this scene; the option's own range still bounds it.
function memberField(m, forElementId = null) {
  const loc = C.memberLocation(scene, m);
  if (!loc) return null;
  const r = C.resolveMember(scene, m);
  const spec = { ...r.spec };

  const el = m.elementId ? scene.elements.find((e) => e.id === m.elementId) : null;
  const dropElementName = forElementId != null && m.elementId === forElementId;
  const where = m.level === "graphic" ? "whole graphic" : (dropElementName ? m.slot : `${el?.label || m.elementId} · ${m.slot}`);
  const label = `${m.label || m.option} — ${where}`;

  // The graphic's scale reads as a percentage everywhere else in the
  // panel, so it does here too.
  if (m.level === "graphic" && m.option === "scale") {
    const f = renderField(label, { kind: "num", step: 5, min: (spec.min ?? 0.1) * 100, max: (spec.max ?? 4) * 100 },
      +(scene.transform.scale * 100).toFixed(1), (v) => {
        if (v != null && v > 0) scene.transform.scale = v / 100;
        saveScene(); renderPanel(); scheduleRerun();
      });
    return f;
  }

  const f = renderField(label, spec, C.memberValue(scene, m), (v) => {
    C.setMemberValue(scene, m, v);
    saveScene(); renderPanel(); scheduleRerun();
  });
  f.title = C.OPTION_DESC[m.option] || "";
  return f;
}

// An option input bound to one texture slot, for a slot's full stroke/
// brush/pattern breakdown. The value lives either on the slot's own
// brush/stamp options or (fill only) on its pattern's own fields.
function optionField(label, spec, t, s) {
  const loc = () => C.memberLocation(scene, t) || "options";
  const bagOf = (l) => (l === "pattern" ? s.pattern : s.options) || {};
  const f = renderField(label, spec, bagOf(loc())[t.option], (v) => {
    const l = loc();
    const bag = l === "pattern" ? (s.pattern = s.pattern || {}) : (s.options = s.options || {});
    if (v === null || v === undefined || v === "") delete bag[t.option];
    else bag[t.option] = v;
    saveScene(); renderPanel(); scheduleRerun();
  });
  if (C.OPTION_DESC[t.option]) f.title = C.OPTION_DESC[t.option];
  return f;
}

// --- fields ---

function numField(label, value, onChange) {
  return renderField(label, { kind: "num", step: 0.5 }, value, onChange);
}

function textField(label, value, onChange, wide) {
  const lbl = document.createElement("label");
  lbl.className = "pg-field" + (wide ? " pg-field-wide" : "");
  lbl.innerHTML = `<span>${escapeHtml(label)}</span>`;
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = value ?? "";
  inp.onchange = () => onChange(inp.value);
  lbl.appendChild(inp);
  return lbl;
}

function jsonField(label, value, onChange) {
  const lbl = document.createElement("label");
  lbl.className = "pg-field pg-field-wide";
  lbl.innerHTML = `<span>${escapeHtml(label)}</span>`;
  const ta = document.createElement("textarea");
  ta.className = "pg-json";
  ta.value = JSON.stringify(value);
  ta.onchange = () => {
    try { onChange(JSON.parse(ta.value)); ta.classList.remove("pg-bad"); }
    catch (e) { ta.classList.add("pg-bad"); }
  };
  lbl.appendChild(ta);
  return lbl;
}

function renderField(label, meta, value, onChange) {
  const lbl = document.createElement("label");
  lbl.className = "pg-field";
  lbl.innerHTML = `<span>${escapeHtml(label)}</span>`;

  if (meta.kind === "enum") {
    const sel = document.createElement("select");
    meta.options.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o; opt.textContent = o;
      if ((value ?? meta.def) === o) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = () => onChange(sel.value);
    lbl.appendChild(sel);
    return lbl;
  }
  if (meta.kind === "bool") {
    const inp = document.createElement("input");
    inp.type = "checkbox";
    inp.checked = value ?? meta.def ?? false;
    inp.onchange = () => onChange(inp.checked);
    lbl.appendChild(inp);
    return lbl;
  }
  const inp = document.createElement("input");
  inp.type = "number";
  if (meta.step != null) inp.step = meta.step;
  if (meta.min != null) inp.min = meta.min;
  if (meta.max != null) inp.max = meta.max;
  if (meta.kind === "nnum") inp.placeholder = "auto";
  // A stored "" (the app's "no value" convention elsewhere) or a
  // non-finite number is not a real value either -- fall back the same
  // way missing does, instead of rendering permanently blank.
  const hasValue = value !== null && value !== undefined && value !== "" && (typeof value !== "number" || Number.isFinite(value));
  inp.value = hasValue ? value : (meta.kind === "nnum" ? "" : (meta.def ?? ""));
  inp.onchange = () => {
    if (inp.value === "") { onChange(null); return; }
    const n = parseFloat(inp.value);
    onChange(isNaN(n) ? null : (meta.kind === "int" ? Math.round(n) : n));
  };
  lbl.appendChild(inp);
  return lbl;
}

// ------------------------------------------------------------- controls --

function newConversation() {
  if (!confirm("Clear the conversation, the scene, and the generated G-code?")) return;
  scene = C.defaultScene();
  scene.config.material = $("#pg-material").value;
  lastTurn = null;
  saveScene();
  renderTranscript();
  rerenderAll();
  showMessages([]);
}

function initParametricEditor() {
  $("#pg-send-btn").addEventListener("click", onSend);
  $("#pg-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSend(); }
  });
  $("#pg-messages").addEventListener("click", (e) => {
    if (e.target.closest(".pg-retry")) onRetry();
  });
  $("#pg-openai-key").addEventListener("change", () => saveApiKeyFrom("openai", "pg-openai-key"));
  $("#pg-anthropic-key").addEventListener("change", () => saveApiKeyFrom("anthropic", "pg-anthropic-key"));
  $("#pg-provider").addEventListener("change", () => updateModelOptions("pg-provider", "pg-model"));
  $("#pg-new-btn").addEventListener("click", newConversation);
  $("#pg-save-log-btn").addEventListener("click", () => {
    if (!debugLog.length) { showMessages(["the debug log is empty — send a message first"]); return; }
    downloadText(`parametric-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`, formatDebugLog(debugLog));
  });
  $("#pg-clear-log-btn").addEventListener("click", () => {
    if (!confirm("Clear the saved debug log? This does not affect the conversation or scene.")) return;
    debugLog = [];
    currentDebugTurn = null;
    saveDebugLog();
  });
  $("#pg-material").addEventListener("change", () => {
    if (!scene) return;
    scene.config.material = $("#pg-material").value;
    saveScene();
    scheduleRerun();
  });

  updateModelOptions("pg-provider", "pg-model");
  loadApiKeyInto("openai", "pg-openai-key");
  loadApiKeyInto("anthropic", "pg-anthropic-key");
  renderCostTracker();
  $("#pg-send-btn").classList.add("disabled");

  loadDeps();
}

window.initParametricEditor = initParametricEditor;
