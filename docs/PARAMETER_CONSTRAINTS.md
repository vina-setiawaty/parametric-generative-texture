# Parameter constraints — FILL-IN FORM (parametric-with-tool)

> **Generated file.** `node tests/print-constraints.mjs` rewrites it
> from `PRINT_LIMITS` / `GEOMETRY_LIMITS` / `LEGIBILITY_GUIDE` in
> `../parametric-catalog-with-tool.js`, which is what the page actually
> enforces. To change a number, change it **there** and regenerate — editing
> this file alone changes nothing.
>
> **How to use it:** mark up the `Value` and `Status` you know to be right,
> send the file back, and the numbers get transcribed into the code and the
> `Status` flipped to `confirmed`. The prompt text the model sees is
> generated from the same objects (`limitsText()` / `legibilityText()`), so a
> confirmed number reaches the model in the same change.
>
> A **hard** rule blocks the print (the page will not mark the G-code safe).
> A **warn** rule is a notice the user can override.

---

## 1. Print limits — physical, enforced

What the printer and the filament can do. Violating one damages the print
or the machine.

| Key | Applies to | Value | Kind | Status | Why |
| --- | --- | --- | --- | --- | --- |
| `zGapFloor` | variableThickness zGap | **0.25** | hard | placeholder | user-validated; lower prints flat |
| `minSolidSheetGap` | hatch gap with the solid brush, and diamond fillGap | **0.35** | hard | placeholder | below this is severe over-extrusion |
| `retractCyclesHard` | retraction cycles in one job | **2000** | hard | placeholder | TPU drive-gear damage; deliberately high -- a diamond fill alone does hundreds of small in-place retracts |
| `netExtrusionTrip` | running sum of E deltas across the job | **-20** | hard | placeholder | a dip this far negative is a retraction-math bug in a brush, not a real move |
| `minBeadWidth` | width / beadWidth / thinWidth | **0.4** | warn | placeholder | about one nozzle width |
| `blobDottedGapOverDiameter` | blobDotted gap, required as gap >= diameter + this | **1** | warn | placeholder | closer and adjacent domes fuse into a ridge |
| `hairyDottedGapOverRoot` | hairyDotted gap, required as gap >= rootDiameter + this | **2** | warn | placeholder |  |
| `minDottedGapOverDot` | dotted gap, required as gap >= 2*dotRadius + this | **1** | warn | placeholder |  |
| `minHairSpacing` | hairy strand spacing | **2.5** | warn | placeholder | closer and strands fuse |
| `minHairyFillRowGap` | hatch gap with the hairy brush | **4** | warn | placeholder | closer and the hair rows fuse |
| `retractCyclesWarn` | retraction cycles in one job | **250** | warn | placeholder | TPU can flat-spot at the drive gear; the count is surfaced to the user |

`netExtrusionTrip` is the only row above that is not about a choice anyone
makes: it catches a retraction-math bug inside a brush, so it is checked but
never shown to the model.

## 2. Geometry limits — the coordinate system

Not tunable by taste; they describe the machine's working area and what the
compiler needs in order to close a shape.

| Key | Applies to | Value | Note |
| --- | --- | --- | --- |
| `bed` | bed size in mm, both axes | **220** | absolute bound on any emitted coordinate |
| `safeMin` | minimum X/Y for every printed coordinate | **15** | margin the prime line and the bed clips need |
| `safeMax` | maximum X/Y for every printed coordinate | **205** |  |
| `closureSnapMm` | a region boundary's end vs. its start | **0.5** | within this snaps closed; a larger gap is closed with a straight edge and warned about |

## 3. Tactile legibility — guidance, NOT enforced

Currently `enforced: false`, `status: untested`.

Past these a "line" stops reading as a line and a "fill" as a filled area.
**None of them has been printed and confirmed**, so the page does not enforce
them — they reach the model as guidance it can weigh, not as a rule it can
point at. The checking code exists and is tested; confirming the numbers is a
one-line change (`LEGIBILITY_GUIDE.enforced = true`) that turns every row
below into a warning.

These are the rows most worth your attention: they are the ones that decide
whether a graphic is readable by touch, and they are pure guesswork today.

| Key | Applies to | Value | Why |
| --- | --- | --- | --- |
| `minDomeDiameter` | blob / directionalBlob dome diameter, hairy root diameter, disc diameter, 2*dotRadius | **0.8** | below this the dome does not clear the 0.4mm relief floor -- may be hard to feel |
| `minDiscHeight` | disc height | **0.4** | two 0.2mm layers -- thinner relief may be hard to feel |
| `minLayers` | any line brush's nLayers | **2** | 0.4mm relief floor -- thinner relief may be hard to feel |
| `maxDottedGapOverDiameter` | dotted / blobDotted / directionalBlobDotted / hairyDotted gap, as a multiple of the dot diameter | **4** | past this it reads as scattered dots, not a line |
| `maxDashGapOverSegLen` | dashed gapLen, as a multiple of segLen | **3** | past this it reads as isolated dashes |
| `minDashLen` | dashed segLen | **2** | shorter dashes are indistinct by touch |
| `minDashGap` | dashed gapLen | **2** |  |
| `minSegmentLen` | segmented thinLen / fatLen | **3** |  |
| `maxHairSpacing` | hairy strand spacing | **12** | past this the strands stop reading as one hairy line |
| `maxShadeFillGap` | hatch row gap with a continuous brush | **8** | past this the area no longer reads as shaded, just as spaced lines |
| `maxDottedFillRowGap` | hatch row gap with a dotted or hairy brush | **12** | past this it reads as separate rows, not a filled patch |
| `minDiamondDiag` | diamond diag | **4** | smaller cells blur together |

## 4. Fixed (not tunable here — listed for reference)

| | Value | Where |
|---|---|---|
| Printer | Ender 3 V2, Sprite direct drive, 0.4 mm nozzle | — |
| Layer height | 0.20 mm | `texture_functions-with-tool.js` `LAYER_HEIGHT` |
| Default bead width | 0.5 mm | hardcoded per-brush `width` default (e.g. `brushSolid`) |
| Nozzle / bed temp (TPU) | 220 / 50 °C | `NOZZLE_TEMP` / `BED_TEMP` |
| Nozzle / bed temp (PLA) | 205 / 60 °C | `runJobs()` header options |
| Default retraction | 1.3 mm @ 900 mm/min | `RETRACT_MM` / `RETRACT_SPEED` |
| Travel speed / Z-hop | 3000 mm/min / 0.4 mm | `TRAVEL_SPEED` / `Z_HOP` |

<!-- generated by tests/print-constraints.mjs -->
