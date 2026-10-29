# The geometry language: pieces, elements, groups, solved regions

## Pieces

A **piece** is one run of geometry:

| piece | meaning |
|---|---|
| `{"x": "<expr in t>", "y": "<expr in t>", "tEnd": n}` | a formula curve over `t ∈ [0, tEnd]` |
| `{"points": [[x, y], [x, y], ...]}` | straight runs through the points, corners allowed |
| `{"ref": "<line element id>", "xFrom": n, "xTo": n, "reverse": bool}` | another line element's path reused as an edge, optionally walked backwards. `xFrom`/`xTo` cut it to an x range — on a formula path and a hand-written point list alike, so "the axis under the shaded part" needs no retyping. Omit both for the whole path. |

## Elements

| kind | geometry | notes |
|---|---|---|
| `line`, one stroke | `{"path": <piece>}` | an axis, a curve, a polyline |
| `line`, a **group** | `{"paths": [<piece>, <piece>, ...]}` | several disconnected strokes, printed separately but sharing this ONE element's texture — see "Grouping repeated features" |
| `region`, between curves | `{"between": {"upper": "<line id>", "lower": "<line id>" \| {"y": n}, "xFrom": n, "xTo": n}}` | **the form for any shaded area between or under curves** — see "Solved regions" |
| `region`, any other shape | `{"boundary": [<piece>, ...]}` | pieces concatenated in order, coming back to the start (an end within 0.5 mm snaps; a larger gap is closed with a straight edge and warned about). Must be a simple, non-self-intersecting shape. |
| `point`, one stamp | `{"at": [x, y]}` | a single marker or data point |
| `point`, a **group** | `{"at": [[x, y], [x, y], ...]}` | several stamps sharing this ONE element's texture |

Elements are printed in list order. Give every element a short `label`
and a `role` — a semantic tag for the report (`axis`, `tick`, `curve`,
`bar`, `marker`, `label`, `other`, or any other label that fits the
element). When the roles it recognizes are present, the page's geometry
report uses them to tabulate measurements like bar heights, axis extents
and curve ranges; any other role still gets the element's plain measured
fields (bbox, length, area, ...), just not that extra table.

## Grouping repeated features

Later stages assign ONE brush, pattern and set of numbers per ELEMENT,
not per stroke or stamp — so a set of identical, repeated marks must be
ONE element (a `paths` or array-`at` group), never N separate elements.
This is not about labelling: it changes how many texture decisions later
stages face, and keeps them consistent by construction.

**Recognize the pattern, don't just follow a keyword list.** Ask: are
these instances of the *same visual feature*, repeated regularly, that a
person would touch and read as ONE kind of mark rather than as N
individually meaningful things? If yes, group them into one element —
whatever the feature is called. For example, not an exhaustive list:

- **Axis tick marks** → ONE `line` element, `role: "tick"`, `paths`
  holding one short 2-point piece per tick. Not ten `tick` elements.
- **A row of evenly-spaced data markers** → ONE `point` element,
  `role: "marker"`, `at` holding one `[x, y]` per marker.
- **Gridlines** across a chart area → ONE `line` element, one 2-point
  piece per line.

The same test applies to anything else built from a repeated mark —
hatching, stitch dots, rivets, fence pickets, whatever the drawing calls
for — even though it isn't named above.

Do NOT group things that look alike but mean different things (three bars
with three different heights encode three different values) — those stay
separate so the report can list each one's own height. Group only when an
instance carries no meaning beyond "one more of these".

Example — an x-axis from 0 to 100 with a tick every 10 units, as two
elements rather than twelve:

```json
{ "id": "", "label": "x axis", "kind": "line", "role": "axis",
  "geometry": "{\"path\": {\"points\": [[40, 150], [140, 150]]}}" }
{ "id": "", "label": "x-axis ticks", "kind": "line", "role": "tick",
  "geometry": "{\"paths\": [{\"points\": [[40, 150], [40, 153]]}, {\"points\": [[50, 150], [50, 153]]}, {\"points\": [[60, 150], [60, 153]]}, {\"points\": [[70, 150], [70, 153]]}, {\"points\": [[80, 150], [80, 153]]}, {\"points\": [[90, 150], [90, 153]]}, {\"points\": [[100, 150], [100, 153]]}, {\"points\": [[110, 150], [110, 153]]}, {\"points\": [[120, 150], [120, 153]]}, {\"points\": [[130, 150], [130, 153]]}, {\"points\": [[140, 150], [140, 153]]}]}" }
```

## Solved regions — name the bounds, the app does the arithmetic

Draw each bounding curve over whatever domain suits it, then declare the
area with `between`. The app samples both bounds, finds every crossing,
picks the span, cuts both to it and closes the two ends exactly. You do
not solve intersections, match parameter ranges, or write an edge by hand.

Shade between `y = 8` and `y = (x-2)^2` (data units) at 8 mm per unit,
x=0 at mm 60 and y=0 at mm 150:

```json
{ "id": "", "label": "y=8", "kind": "line", "role": "curve",
  "geometry": "{\"path\": {\"points\": [[20, 86], [140, 86]]}}" }
{ "id": "", "label": "y=(x-2)^2", "kind": "line", "role": "curve",
  "geometry": "{\"path\": {\"x\": \"20 + t\", \"y\": \"150 - 8*(((20 + t - 60)/8 - 2)^2)\", \"tEnd\": 120}}" }
{ "id": "", "label": "shaded region", "kind": "region",
  "geometry": "{\"between\": {\"upper\": \"<y=8 id>\", \"lower\": \"<parabola id>\"}}" }
```

The crossings (`8 = (x-2)^2` → `x ≈ -0.83` and `x ≈ 4.83`) are found by
the app; the report gives back the x range it used and the crossing
points, so the result is checkable rather than your arithmetic.

What still matters on your side:

- **Every point of each bound must land inside 15–205**, including the
  parts outside the shaded span — they are drawn as curves in their own
  right.
- **A bound must give one y per x.** A circle, or anything that doubles
  back, is rejected; use an explicit `boundary` for those.
- **If the bounds cross exactly once, or more than twice**, the area
  between them is ambiguous and the app says so — add `xFrom`/`xTo` to
  name the span you mean.
- **"Under a curve"** is the same form with the axis, or a bare level, as
  `lower`: `{"between": {"upper": "<curve id>", "lower": {"y": 150}}}`.
