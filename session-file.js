// Session save/load: one JSON file holding the scene (elements, textures,
// groups, transcript, last report) and the debug log, so a session can be
// put away and brought back exactly. DOM-free, and the catalog is passed
// in rather than imported (same as prompt-assembly.js), so
// tests/session-file.mjs can exercise it under node.
//
// The .txt "save log" export is for reading; this file is for loading.
// Not saved: API keys (never written to a file), provider/model/effort
// pickers (they're per-browser settings, not part of the work), and the
// in-memory last turn behind the retry link.

export const SESSION_KIND = "parametric-with-tool-session";
export const SESSION_FILE_VERSION = 1;

export function serializeSession(scene, debugLog) {
  return JSON.stringify({
    kind: SESSION_KIND,
    fileVersion: SESSION_FILE_VERSION,
    savedAt: new Date().toISOString(),
    scene,
    debugLog: Array.isArray(debugLog) ? debugLog : [],
  }, null, 1);
}

// Returns { scene, debugLog, savedAt } or throws an Error whose message is
// fit to show the user. Refuses rather than falling back: normalizeScene()
// silently returns an empty scene on a version mismatch, which on load
// would look like success and then wipe the user's current work.
export function parseSession(text, C) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { throw new Error(`not a JSON file (${e.message})`); }
  if (!raw || raw.kind !== SESSION_KIND) {
    throw new Error("not a saved session — use a file from \"save session\" (the .txt from \"save log\" can't be loaded)");
  }
  if (raw.fileVersion !== SESSION_FILE_VERSION) {
    throw new Error(`session file version ${raw.fileVersion} isn't supported (this page reads version ${SESSION_FILE_VERSION})`);
  }
  if (!raw.scene || raw.scene.version !== C.SCENE_VERSION) {
    throw new Error(`the scene was saved as version ${raw.scene?.version ?? "?"}; this page uses scene version ${C.SCENE_VERSION}`);
  }
  return {
    scene: C.normalizeScene(raw.scene),
    debugLog: Array.isArray(raw.debugLog) ? raw.debugLog : [],
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : null,
  };
}
