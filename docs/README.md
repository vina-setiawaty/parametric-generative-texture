# parametric-with-tool docs

Reference set for the **pipeline page** (`../parametric-with-tool.html`) —
a manager (route) that picks one of three specialists (geometry, texture,
ui), a deterministic gate between calls, and a judge at the end whose
failures go back to the manager. Over a scene model: elements, per-slot
textures with their values, and the parameter groups the panel surfaces.

Standalone fork of `sewingeditor/parametric-with-tool/` in the
3D-printer-interface repo, taken 2026-10-29. It calls OpenAI/Anthropic
directly from the browser (`../llm.js`); there is no server endpoint. It
keeps its own copy of the texture library below, and `../script.js`,
`../llm.js` and `../lib/p5.fab.sewing.js` are forked copies too — fixes
to the originals do not arrive here automatically.

| File | What it is |
|---|---|
| `texture_functions-with-tool.js` | The texture library restructured as brushes / patterns / stamps (every texture is "what happens between two points"). Verified byte-identical to the original library's output by `tests/golden-brushes.mjs`. |
| `stage-route.md` | System prompt for **route**, the manager — the only call that sees the chat history. Picks the specialist, rewrites the request as a self-contained instruction, and writes the turn's acceptance criteria. Also runs in refine mode after a failed evaluation. |
| `stage-geometry.md` | System prompt for **geometry** — defines or changes elements (lines, regions, points) and the global transform. |
| `stage-texture.md` | System prompt for **texture** — assigns a brush, a fill pattern, and their option values to each element slot. |
| `stage-judge.md` | System prompt for **judge** — reads the finished scene against the turn's acceptance criteria and the app's measured report, and names which specialist can fix each unmet one. |
| `stage-ui.md` | System prompt for **ui** — decides which parameters the panel surfaces and under which heading, selecting freely from the scene's real options (no fixed attribute table). Sets no values (the texture stage does). |
| `ref-coordinates.md` | Bed, safe area, the global transform, material. |
| `ref-expressions.md` | The formula grammar and what sampling does to a curve. |
| `ref-geometry-language.md` | Pieces, elements, grouping repeated features, and solved (`between`) regions. |
| `ref-brush-menu.md` | The brush and stamp menu with their options. |
| `ref-patterns.md` | Fill patterns, the pattern/brush pairing, and a fill's two option spaces. |
| `PARAMETER_CONSTRAINTS.md` | **Generated fill-in form** (`node tests/print-constraints.mjs`) listing every enforced print limit, the geometry limits, and the unenforced tactile-legibility guesses. Edit the values you know and send it back; they get transcribed into the catalog. |

## How a doc becomes a prompt

`../prompt-assembly.js` owns this — which docs each stage gets, which
generated sections are appended, and how a file is read:

- a **`stage-*.md`** file contributes only its ``` fenced block (the prose
  outside the fence is notes to us, not prompt);
- a **`ref-*.md`** file is used **whole**, fenced examples included.

That distinction is load-bearing. The page previously took "the first
fenced block, if any" from every file alike, which cut `reference-machine.md`
down to the 712-character JSON example that happened to come first — the
machine table, the safe-area rule, the expression grammar and the element
tables never reached any stage. `tests/prompt-assembly.mjs`
builds every stage's real prompt offline and guards against it recurring.

## Keeping things in sync

- Prompt text changes → update the matching `stage-*.md` / `ref-*.md`
  file.
  Changing which docs a stage gets is a change to `../prompt-assembly.js`,
  not to this folder.
- Limit changes → edit `PRINT_LIMITS` / `GEOMETRY_LIMITS` /
  `LEGIBILITY_GUIDE` in `../parametric-catalog-with-tool.js` and nothing
  else: the prompt section (`limitsText()` / `legibilityText()`, appended to
  the texture and ui prompts by `../prompt-assembly.js`) and the
  `PARAMETER_CONSTRAINTS.md` form (`node tests/print-constraints.mjs`)
  are both generated from those objects. Never hand-write a limit into a doc.
- Legibility limits are **not enforced** — none of the numbers has been
  printed and confirmed. `LEGIBILITY_GUIDE.enforced = true` turns them into
  warnings; the code path exists and is tested, waiting on real numbers.
- Library changes → run `node tests/golden-brushes.mjs` (must
  stay byte-identical) and `node tests/compile-fixtures.mjs`.
- Loop or prompt-shape changes → `node tests/pipeline.mjs` and
  `node tests/prompt-assembly.mjs`. Both run offline, with a
  scripted fake model, so there is no reason not to.
