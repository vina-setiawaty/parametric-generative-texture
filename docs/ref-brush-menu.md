# Brushes — the texture menu

Every texture is **what happens between two points**. A line element, a
region outline, each stroke of a fill pattern, and a point element (or each
position of a `grid`/`stamps` fill pattern) all use the same `brush` slot
and the same menu below — the only difference is how many points the brush
gets called with. Most brushes need a real path (2+ points) to do
anything; nine of the thirteen below also work fine called at a single
point (marked **point-safe**) — those are the only ones valid for a point
element or a `grid`/`stamps` fill pattern. Options in mm, degrees CCW from
+X, mm/min, ms. Defaults apply for anything omitted.

| name | point-safe | makes | key options (default) |
|---|---|---|---|
| `solid` | | continuous ridge | `width` (0.5), `nLayers` (2), `speed` (400) |
| `dashed` | | dashes measured along arc length | `segLen` (8), `gapLen` (4), `width`, `nLayers`, `speed` |
| `segmented` | | alternating thin/fat bead segments | `thinLen` (8), `thinWidth` (0.8), `fatLen` (4), `fatWidth` (1.6), heights, speeds, `flowMult` |
| `variableThickness` | | ridge that swells and thins sinusoidally | `hMin` (0.16), `hMax` (0.9), `wavelength` (8), `beadWidth` (0.8), `zGap` (0.25, never lower) |
| `hairy` | | vertical strands pulled up along the path | `spacing` (5), `bigLift` (4), `esegmentMm` (1.2), `smallLift`, `dwellMs`, `baseZ`, `speed` — one retraction per strand |
| `dotted` | ✓ | flat spiral discs along the path (or one disc, at a point) | `gap` (10), `dotRadius` (0.8), `nLayers`, `speed` (250) |
| `blobDotted` — **default dotted** | ✓ | domed blob dots along the path (or one dome, at a point) | `gap` (10), `diameter` (1.6) + blob build + orbit options |
| `directionalBlobDotted` | ✓ | leaning domes raking along the local tangent (or one, at a point, leaning per `azimuthDeg` alone) | `gap` (= diameter), `diameter` (2.0), `azimuthDeg` (0, offset from the tangent), `dragSpeed`, `stampOrder` |
| `hairyDotted` | ✓ | anchored hairy dots (root dome + one pulled strand), along a path or one at a point | `gap` (10), `rootDiameter` (2), `hairLength` (3), `hairDirection` (`top`\|`right`\|`left`\|`bottom`), `hairAzimuthDeg`/`hairElevationDeg`, `beadFlowMult`, `pullExtrudeSpeed` — one retraction per dot |
| `blob` — **default dot** | ✓ (point only) | small extruded dome | `diameter` (1.6) + blob build + orbit |
| `disc` | ✓ (point only) | flat precise disc, diameter and height independent | `diameter` (1.6), `height` (0.4, steps of 0.2), `speed` (250) |
| `directionalBlob` | ✓ (point only) | leaning dome | `diameter` (2.0), `azimuthDeg` (absolute heading), `dragSpeed` |
| `hairyDot` | ✓ (point only) | dome + one pulled strand | `rootDiameter` (2), `hairLength` (3), `hairDirection`, … as hairyDotted |

"Point only" means exactly that: unlike the other point-safe brushes,
`blob`/`disc`/`directionalBlob`/`hairyDot` can ONLY be called at a single
point — assigning one to a line's `brush` slot or a stroke-drawing fill
pattern is rejected, since it would otherwise silently draw at just the
path's first point instead of walking it.

**Blob build options** (every blob / hairy dome): `baseZ` 0.2, `buildSteps` 6,
`taperFactor` 0.7, `extrudeSpeed` 120, `dwellMs` 2000, `extrusionMultiplier` 1.3,
`retractMm` 4.0, `postRetractDwellMs` 2000, `baseExtraMm` 0.3, `baseDwellMs` 1000.
**Orbit options** (blob only): `orbitRadius` (null = dome radius, 0 = off),
`orbitPts` 16, `orbitSpeed` 600, `orbitLoops` 3.
