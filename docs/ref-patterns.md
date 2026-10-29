# Fill patterns — `slot: fill` on a region

A pattern says **where** the texture goes inside the region; the page clips
everything to the boundary and transforms it with the graphic. Any pattern
whose coordinates you write yourself is in the graphic's own coordinates.

| kind | spec | brush type |
|---|---|---|
| `hatch` | `{"kind": "hatch", "angleDeg": 0, "gap": 4}` parallel strokes, recomputed from the region | line brush |
| `grid` | `{"kind": "grid", "dx": 6, "dy": 6, "angleDeg": 0}` stamp lattice | stamp |
| `diamond` | `{"kind": "diamond", "diag": 8, "fillGap": 0.6}` lattice + checkerboard-filled cells; **rectangular region only**; always this kind, never two angled hatches | `solid` |
| `stamps` | `{"kind": "stamps", "points": [[x, y], ...]}` explicit stamp positions | stamp |
| `strokes` | `{"kind": "strokes", "strokes": [[[x, y], [x, y], ...], ...]}` explicit polylines, corners allowed | line brush |
| `curves` | `{"kind": "curves", "curves": [{"x": ..., "y": ..., "tEnd": n}, ...]}` a collection of formula strokes | line brush |
| `family` | `{"kind": "family", "x": "<expr in t,u>", "y": "<expr in t,u>", "tEnd": n, "uEnd": n, "uStep": n}` one stroke per `u` — radial (`x: cx + t*cos(u)`), concentric (`x: cx + u*cos(t)`), wavy hatch, … | line brush |

**Pattern/brush pairing is enforced:** stroke patterns (`hatch`,
`diamond`, `strokes`, `curves`, `family`) take a line brush; stamp
patterns (`grid`, `stamps`) take a stamp. `diamond` always uses `solid`.

A fill slot therefore has TWO independently-named sets of numbers, and
you name either one the same way — the app looks up which it belongs to:

- the fill's **brush** options (a hairy fill's `hairLength`, `spacing`, …)
- the **pattern's** own options (`hatch`'s `gap`/`angleDeg`, `grid`'s
  `dx`/`dy`, `diamond`'s `diag`/`fillGap`)

A hatch or grid fill's "density" is its pattern's `gap`/`dx`/`dy`, **not**
a brush option — never reach for a brush option, or invent one, to control
fill spacing when the pattern already has one.

Starting points: a solid sheet is `hatch` + `solid` with `gap` ≈ 0.45;
line shading is `hatch` + `solid` with `gap` 3–6; dotted or hairy shading
is `hatch` + that brush with `gap` 6–10, or `grid`/`stamps` + a stamp.
Pattern spacing scales with the graphic; brush mm values do not.
