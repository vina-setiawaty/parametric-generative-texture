// Compatibility shim for parametric-with-tool.html so `script.js` (shared
// with index.html) can be reused unmodified. Same rationale as
// parametric-compat.js (which parametric.html keeps using): script.js's
// setup() unconditionally calls loadActions()/initActionEditor()
// (actions.js) and initLlmEditor() (llm.js) before wiring the Main/Motion
// controllers and #run-gcode-btn/#save-gcode-btn -- each does a
// querySelector(...).addEventListener with no null check, so on a page
// missing that DOM they throw and abort the rest of setup().
//
// Loaded AFTER llm.js (so this no-op initLlmEditor wins over the real one)
// and BEFORE p5 invokes setup(). initGcodeLlmEditor is repurposed as the
// entry point for this page's own editor, which parametric-with-tool.js
// (an ES module) exposes as window.initParametricEditor.
function loadActions() {}
function initActionEditor() {}
function initLlmEditor() {}
function initGcodeLlmEditor() {
  window.initParametricEditor();
}
let activeAction = "";
