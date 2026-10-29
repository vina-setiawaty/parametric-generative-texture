// LLM-assisted action generation. Reads/writes the same DOM fields as the
// manual edit section below the generate button (#action-name,
// #action-description, #action-variables-container, #action-gcode) so
// generated results and hand edits never hold conflicting state.

const MODEL_OPTIONS = {
  openai: [
    { value: "gpt-5.6-luna", label: "gpt-5.6-luna (cheapest)" },
    { value: "gpt-5.6-terra", label: "gpt-5.6-terra (recommended)" },
    { value: "gpt-5.6-sol", label: "gpt-5.6-sol (best quality)" },
  ],
  anthropic: [
    { value: "claude-haiku-4-5", label: "claude-haiku-4-5 (cheapest)" },
    { value: "claude-sonnet-5", label: "claude-sonnet-5 (recommended)" },
    { value: "claude-opus-5", label: "claude-opus-5 (best quality)" },
  ],
};

const LLM_PRICE_PER_MTOK = {
  "gpt-5.6-luna": { input: 0.20, output: 1.20 },
  "gpt-5.6-terra": { input: 2.00, output: 12.00 },
  "gpt-5.6-sol": { input: 5.00, output: 30.00 },
  "claude-haiku-4-5": { input: 1.00, output: 5.00 },
  "claude-sonnet-5": { input: 2.00, output: 10.00 },
  "claude-opus-5": { input: 5.00, output: 25.00 },
};

let lastAppliedGcode = "";
let llmSessionCost = parseFloat(localStorage.getItem("llmCostTotal") || "0");

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// response.json() gives no access to the body once it fails to parse, which
// leaves failures like a Vercel timeout page (HTML, not JSON) undiagnosable.
// Read the raw text first so a parse failure can still show what actually
// came back, the same way a bad model-generated JSON body is previewed below.
async function readJsonResponse(response) {
  const rawText = await response.text();
  try {
    return JSON.parse(rawText);
  } catch (e) {
    e.rawText = rawText;
    throw e;
  }
}

// Detects whether the response was cut off by the token limit, so the parse
// failure below can say "hit the token limit" instead of a bare stack trace.
function wasTruncated(data, provider) {
  if (provider === "anthropic") {
    return data.stop_reason === "max_tokens";
  }
  return data.status === "incomplete" && data.incomplete_details && data.incomplete_details.reason === "max_output_tokens";
}

// Shared by the action editor's and the raw-gcode box's LLM panels — each
// passes its own pair of provider/model <select> element ids.
function updateModelOptions(providerSelectId, modelSelectId) {
  const provider = document.querySelector(`#${providerSelectId}`).value;
  const modelSelect = document.querySelector(`#${modelSelectId}`);
  modelSelect.innerHTML = "";
  MODEL_OPTIONS[provider].forEach((opt, i) => {
    const optionEl = document.createElement("option");
    optionEl.value = opt.value;
    optionEl.textContent = opt.label;
    if (i === 1) optionEl.selected = true;
    modelSelect.appendChild(optionEl);
  });
}

function resetLlmPanel() {
  document.querySelector("#llm-description").value = "";
  document.querySelector("#llm-messages").innerHTML = "";
  document.querySelector("#llm-explanation").textContent = "";
  document.querySelector("#llm-status").textContent = "";
  lastAppliedGcode = "";
}

function collectManualFormState() {
  const variables = [];
  document.querySelectorAll("#action-variables-container .action-variable-item").forEach(item => {
    const key = item.querySelector(".action-variable-key").value;
    const val = parseFloat(item.querySelector(".action-variable-val").value);
    if (key) {
      variables.push({ key, default: isNaN(val) ? 0 : val });
    }
  });
  return {
    name: document.querySelector("#action-name").value,
    description: document.querySelector("#action-description").value,
    variables,
    gcode: document.querySelector("#action-gcode").value.split("\n").filter(l => l.trim() !== ""),
  };
}

function buildSystemPrompt() {
  const whitelist = gcodeCheck.join(", ");
  return `You generate "actions" for a Marlin G-code motion-control web app. An action is JSON with:
- name: short lowercase alphanumeric identifier (no spaces/symbols)
- description: one sentence, plain language
- variables: array of {key, default} where key starts with "__" and contains only letters/digits (e.g. "__z"), default is a number
- gcode: array of strings, each one G-code line
- explanation: a short, conversational explanation of what you generated and why, written the way you'd reply in a chat interface

GCODE LINE RULES (all must be followed exactly):
1. Each line's command word (before the first space) MUST be one of this exact whitelist — any other G/M/T code is silently dropped by the app at runtime and will not run:
   ${whitelist}
2. Use a variable's key literally inside a line to substitute its live value at run time, e.g. "G0 Z__z F__fm".
3. For derived/computed numeric values, wrap a JavaScript arithmetic expression in curly braces, e.g. "G0 Z{-__z * 2} F__fm". Inside {}, use ONLY: the declared variable keys, numeric literals, arithmetic operators (+ - * / % ()), and nothing else. Never use any other function call, assignment, semicolon, or non-arithmetic JavaScript.
4. Do not include comments (// ...) in gcode lines.
5. Every __key placeholder used in gcode must be declared in variables with a sensible numeric default. Keep defaults physically conservative (small travel distances, e.g. a few mm, unless the instruction clearly calls for more) since this controls a physical machine.
6. Prefer relative positioning (G91) with a trailing G90 to restore absolute mode for self-contained relative moves, matching the style of the example below — but use whatever mode is correct for the requested motion.
7. Keep "explanation" to a few sentences (a few hundred words at most): say plainly what the action does, briefly why you made the key choices (variable defaults, gcode structure), and flag anything the user should double-check before running it on hardware — e.g. an unusually large travel distance or an assumption you had to make because the instruction was ambiguous. Write it as you would reply directly to the user in a chat, not as a code comment or a list of field names.

EXAMPLE (existing action in this app, for style reference):
{
  "name": "simple-up-down",
  "description": "move up and down, extruding at the bottom and retracting at the top",
  "variables": [
    {"key": "__e", "default": 1.5},
    {"key": "__r", "default": 1.5},
    {"key": "__fe", "default": 200.0},
    {"key": "__fm", "default": 600.0},
    {"key": "__z", "default": 5.0}
  ],
  "gcode": [
    "G91",
    "G0 Z__z F__fm",
    "G0 Z{-__z * 2} F__fm",
    "G1 F__fe E__e",
    "G1 Z__z F__fm E-__r"
  ],
  "explanation": "This moves the nozzle up 5mm, then back down while extruding, and retracts on the way up — a simple stitch-like up/down motion. I used moderate defaults (600mm/min travel, 200mm/min extrusion) since none were specified in the request. Worth double-checking __z if your material needs a taller lift before it clears the work surface."
}

You will also be given the CURRENT state of the action editor (may be empty/default, or already contain a name/description/variables/gcode from prior manual or AI edits). Treat the new instruction as a modification of that current state where it makes sense (e.g. "also add a pause at the top" keeps existing lines and adds to them); start fresh only if the instruction clearly describes a new, unrelated action. Always return the FULL resulting action, not a diff.

Respond with only the JSON object described by the schema.`;
}

function buildUserMessage(nlDescription, currentState) {
  return `Current action editor state (JSON):\n${JSON.stringify(currentState, null, 2)}\n\nInstruction: ${nlDescription}`;
}

function buildRequestBody(nlDescription, provider, model, currentState) {
  return {
    provider,
    model,
    systemPrompt: buildSystemPrompt(),
    userMessage: buildUserMessage(nlDescription, currentState),
  };
}

function validateGeneratedAction(result) {
  const warnings = [];
  const variables = Array.isArray(result.variables) ? result.variables : [];
  const gcode = Array.isArray(result.gcode) ? result.gcode : [];

  const MAGNITUDE_THRESHOLD = 50;
  variables.forEach(v => {
    if (typeof v.default === "number" && Math.abs(v.default) > MAGNITUDE_THRESHOLD) {
      warnings.push(`variable ${v.key} default of ${v.default} is unusually large — double-check before running on hardware`);
    }
  });

  const sortedVars = [...variables].sort((a, b) => (b.key || "").length - (a.key || "").length);
  const exprAllowlist = /^[0-9a-zA-Z_\s+\-*/%().,]*$/;

  gcode.forEach((rawLine, i) => {
    const command = rawLine.trim().split(" ")[0];
    if (command && !gcodeCheck.includes(command)) {
      warnings.push(`line ${i + 1}: "${command}" is not a whitelisted G/M/T code and will be dropped at runtime`);
    }

    let line = rawLine;
    sortedVars.forEach(v => {
      line = line.split(v.key).join(v.default);
    });

    const expLocations = [];
    let close = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === "{") {
        if (!close) { expLocations.push([c]); close = true; }
      }
      if (line[c] === "}") {
        if (close) { expLocations[expLocations.length - 1].push(c); close = false; }
      }
    }

    expLocations.forEach(loc => {
      if (loc.length !== 2) {
        warnings.push(`line ${i + 1}: unmatched { or } in generated gcode`);
        return;
      }
      const expr = line.slice(loc[0] + 1, loc[1]);
      if (!exprAllowlist.test(expr)) {
        warnings.push(`line ${i + 1}: expression "${expr}" contains disallowed characters and was not evaluated`);
        return;
      }
      try {
        eval(expr);
      } catch (e) {
        warnings.push(`line ${i + 1}: expression "${expr}" failed to evaluate (${e.message})`);
      }
    });
  });

  return warnings;
}

function applyResultToManualForm(result) {
  const name = (result.name || "").toLowerCase().replace(/[^a-zA-Z0-9]/g, "");
  document.querySelector("#action-name").value = name;
  document.querySelector("#action-description").value = result.description || "";

  const gcodeText = (result.gcode || []).join("\n");
  document.querySelector("#action-gcode").value = gcodeText;

  const container = document.querySelector("#action-variables-container");
  container.innerHTML = "";
  (result.variables || []).forEach(v => {
    addVariable();
    const last = container.querySelector(".action-variable-item:last-child");
    last.querySelector(".action-variable-key").value = v.key;
    last.querySelector(".action-variable-val").value = v.default;
  });

  lastAppliedGcode = gcodeText;
}

function recordCost(usage, model) {
  const price = LLM_PRICE_PER_MTOK[model];
  if (!price) return;
  const cost = ((usage.input_tokens || 0) / 1e6) * price.input + ((usage.output_tokens || 0) / 1e6) * price.output;
  llmSessionCost += cost;
  localStorage.setItem("llmCostTotal", llmSessionCost.toString());
  renderCostTracker();
}

// The action editor and the raw-gcode box each show their own cost-tracker
// element, but both reflect the same combined running total — update every
// element with this class so typing in either panel keeps both in sync.
function renderCostTracker() {
  const text = `estimated cost so far: $${llmSessionCost.toFixed(4)} (client-side estimate only — set real spend limits with your provider directly)`;
  document.querySelectorAll(".llm-cost-tracker").forEach(el => { el.textContent = text; });
}

// Both LLM panels share the same app-password value (one Vercel deployment,
// one APP_SECRET), so any input bound here reads/writes the same key —
// entering it in one panel fills it in for the other next time it loads.
function saveAppSecretFrom(inputId) {
  localStorage.setItem("llmAppSecret", document.querySelector(`#${inputId}`).value);
}

function loadAppSecretInto(inputId) {
  const secret = localStorage.getItem("llmAppSecret");
  if (secret) {
    document.querySelector(`#${inputId}`).value = secret;
  }
}

// Client-side-direct flows (no Vercel proxy) store the user's own OpenAI/
// Anthropic keys under one shared localStorage slot per provider, so any
// page that migrates to calling providers directly reuses whatever the
// user already entered elsewhere -- same pattern as saveAppSecretFrom/
// loadAppSecretInto above, just keyed per provider instead of one shared
// app password.
function saveApiKeyFrom(provider, inputId) {
  localStorage.setItem(`llmApiKey_${provider}`, document.querySelector(`#${inputId}`).value);
}

function loadApiKeyInto(provider, inputId) {
  const key = localStorage.getItem(`llmApiKey_${provider}`);
  if (key) {
    document.querySelector(`#${inputId}`).value = key;
  }
}

// Direct-from-browser equivalents of api/_lib/llm-proxy.js's callOpenAI/
// callAnthropic. No app secret, no server-side model/effort allowlist --
// the request goes straight from this page to the provider using a key the
// user typed in, so there's no shared budget to gate. Anthropic requires
// the browser-access header below or it rejects the request outright;
// OpenAI's API answers direct browser calls with no special header needed.
async function callOpenAIDirect(apiKey, model, systemPrompt, messages, schema, schemaName, maxOutputTokens, effort) {
  return fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      instructions: systemPrompt,
      input: (messages.length === 1 && messages[0].role === "user")
        ? messages[0].content
        : messages.map(m => ({
            role: m.role,
            content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
          })),
      max_output_tokens: maxOutputTokens,
      reasoning: { effort },
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          schema,
          strict: true,
        },
      },
    }),
  });
}

async function callAnthropicDirect(apiKey, model, systemPrompt, messages, schema, maxOutputTokens, effort, thinking) {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxOutputTokens,
      thinking: { type: thinking ? "adaptive" : "disabled" },
      output_config: {
        effort,
        format: { type: "json_schema", schema },
      },
      system: systemPrompt,
      messages,
    }),
  });
}

// Dispatches to the right provider, relays a clean Error on any failure
// (network, non-JSON body, upstream error, or an Anthropic pause_turn --
// see llm-proxy.js's handleGenerateRequest for why that one is treated as
// a hard failure here rather than something worth resuming), and otherwise
// returns the raw upstream JSON body untouched -- callers read it with the
// same extractResponseOutput()/wasTruncated() used for the proxied flows.
async function callLlmDirect({ provider, apiKey, model, systemPrompt, messages, schema, schemaName, maxOutputTokens, effort, thinking }) {
  if (!apiKey) throw new Error(`enter your ${provider} API key first`);

  let upstreamResponse;
  try {
    upstreamResponse = provider === "openai"
      ? await callOpenAIDirect(apiKey, model, systemPrompt, messages, schema, schemaName, maxOutputTokens, effort)
      : await callAnthropicDirect(apiKey, model, systemPrompt, messages, schema, maxOutputTokens, effort, thinking);
  } catch (e) {
    throw new Error(`could not reach ${provider}: ${e.message || e}`);
  }

  let data;
  try {
    data = await readJsonResponse(upstreamResponse);
  } catch (e) {
    const preview = e.rawText ? (e.rawText.length > 300 ? e.rawText.slice(0, 300) + "…" : e.rawText) : "(empty response)";
    throw new Error(`${provider} returned a response that wasn't valid JSON: ${preview}`);
  }

  if (!upstreamResponse.ok) {
    const detail = (data && data.error && data.error.message) ? data.error.message : `HTTP ${upstreamResponse.status}`;
    throw new Error(detail);
  }

  if (provider === "anthropic" && data.stop_reason === "pause_turn") {
    throw new Error("verification step didn't finish in time — try a simpler request");
  }

  return data;
}

// Anthropic Messages API and OpenAI Responses API return the generated text
// (and a refusal, if any) in different shapes — branch on which provider the
// request was sent to rather than guessing from the payload shape.
function extractResponseOutput(data, provider) {
  if (provider === "anthropic") {
    if (data.stop_reason === "refusal") {
      return { text: null, refusal: "the model declined this request" };
    }
    // Take the LAST text block, not the first: a server-side tool
    // (code_execution) can make Claude emit narration text before the tool
    // call, with the actual schema-constrained answer only in the final
    // text block after the tool result comes back.
    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const textBlock = textBlocks[textBlocks.length - 1];
    return { text: textBlock ? textBlock.text : null, refusal: null };
  }

  // OpenAI: walk the "output" array (one or more items of type "message",
  // "reasoning", etc.) to find either the generated JSON text or a refusal
  // explanation, wherever they landed in the array.
  for (const item of data.output || []) {
    if (item.type !== "message") continue;
    for (const block of item.content || []) {
      if (block.type === "output_text") return { text: block.text, refusal: null };
      if (block.type === "refusal") return { text: null, refusal: block.refusal };
    }
  }
  return { text: null, refusal: null };
}

async function onGenerateClick() {
  const btn = document.querySelector("#llm-generate-btn");
  const status = document.querySelector("#llm-status");
  const messages = document.querySelector("#llm-messages");
  const explanationEl = document.querySelector("#llm-explanation");
  const description = document.querySelector("#llm-description").value.trim();
  const secret = document.querySelector("#llm-app-secret").value;
  const provider = document.querySelector("#llm-provider").value;
  const model = document.querySelector("#llm-model").value;

  messages.innerHTML = "";
  explanationEl.textContent = "";

  if (!description) {
    messages.innerHTML = "<li>describe the action before generating</li>";
    return;
  }
  if (!secret) {
    messages.innerHTML = "<li>enter the app password before generating</li>";
    return;
  }

  const currentState = collectManualFormState();
  const currentGcode = currentState.gcode.join("\n");
  if (currentGcode && currentGcode !== lastAppliedGcode) {
    if (!confirm("Generating will overwrite the current Manual tab fields. Continue?")) {
      return;
    }
  }

  btn.classList.add("active");
  status.textContent = "generating...";

  let response;
  try {
    response = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-secret": secret },
      body: JSON.stringify(buildRequestBody(description, provider, model, currentState)),
    });
  } catch (e) {
    status.textContent = "";
    btn.classList.remove("active");
    messages.innerHTML = `<li>could not reach the LLM proxy: ${e.message}</li>`;
    return;
  }

  let data;
  try {
    data = await readJsonResponse(response);
  } catch (e) {
    status.textContent = "";
    btn.classList.remove("active");
    const preview = e.rawText ? (e.rawText.length > 500 ? e.rawText.slice(0, 500) + "…" : e.rawText) : "(empty response)";
    messages.innerHTML = `<li>the proxy returned a response that wasn't valid JSON</li><li style="white-space:pre-wrap;">${escapeHtml(preview)}</li>`;
    return;
  }

  if (!response.ok) {
    status.textContent = "";
    btn.classList.remove("active");
    const detail = (data && data.error) ? data.error : `HTTP ${response.status}`;
    messages.innerHTML = `<li>generation failed: ${detail}</li>`;
    return;
  }

  const { text: outputText, refusal } = extractResponseOutput(data, provider);

  if (refusal) {
    status.textContent = "";
    btn.classList.remove("active");
    messages.innerHTML = `<li>the model declined this request: ${refusal}</li>`;
    return;
  }

  if (!outputText) {
    status.textContent = "";
    btn.classList.remove("active");
    messages.innerHTML = "<li>no text content returned by the model</li>";
    return;
  }

  let result;
  try {
    result = JSON.parse(outputText);
  } catch (e) {
    status.textContent = "";
    btn.classList.remove("active");
    if (wasTruncated(data, provider)) {
      messages.innerHTML = "<li>generation was cut off before finishing (hit the token limit) — try again, or shorten the description</li>";
    } else {
      const preview = outputText.length > 500 ? outputText.slice(0, 500) + "…" : outputText;
      messages.innerHTML = `<li>could not parse the generated action as JSON: ${escapeHtml(e.message)}</li><li style="white-space:pre-wrap;">${escapeHtml(preview)}</li>`;
    }
    return;
  }

  const warnings = validateGeneratedAction(result);
  applyResultToManualForm(result);
  explanationEl.textContent = result.explanation || "";

  if (data.usage) {
    recordCost(data.usage, model);
  }

  status.textContent = "";
  btn.classList.remove("active");
  messages.innerHTML = warnings.map(w => `<li>${w}</li>`).join("");
}

function initLlmEditor() {
  document.querySelector("#llm-generate-btn").addEventListener("click", onGenerateClick);
  document.querySelector("#llm-app-secret").addEventListener("change", () => saveAppSecretFrom("llm-app-secret"));
  document.querySelector("#llm-provider").addEventListener("change", () => updateModelOptions("llm-provider", "llm-model"));
  updateModelOptions("llm-provider", "llm-model");
  loadAppSecretInto("llm-app-secret");
  renderCostTracker();
}
