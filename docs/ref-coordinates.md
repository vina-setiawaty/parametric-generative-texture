# Machine, material and coordinates

## Machine & material

| | |
|---|---|
| Bed | 220 × 220 mm — every printed coordinate must stay inside X/Y **15–205** |
| Layer height | 0.20 mm; relief of at least 0.40 mm (2 layers) is recommended for reliable tactile feel, but not enforced -- go thinner if asked to |
| Default bead width | 0.5 mm |
| Material | **TPU** unless the user names PLA (the page sets temperatures and flow itself) |

The page wraps every job in its own start/end sequence (heat, home, prime,
retract; retract, lift, cooldown at the end). Never plan heating, homing,
priming or cooldown.

## Coordinates

Millimetres, X right, Y up (away from the front of the bed). The graphic is
drawn in its own coordinates; the page applies a global **transform**
(`scale`, `origin`) afterwards: the graphic's minimum-x / minimum-y corner
lands on `origin` and everything scales about it. `origin: null` means
"leave the graphic where its coordinates put it". Design a graphic at a
sensible printed size (a chart 60–120 mm wide) inside the safe area; the
user rescales or moves it with the transform, not by asking for new
coordinates.

**Every curve's Y (and X) must land inside 15–205 after whatever data→mm
mapping you chose.** Plugging a function straight through as millimetres
without checking its actual range at the domain you picked is the most
common way to break this — a downward parabola with a wide domain, an
unshifted trig function, a steep line, all commonly swing well past the
bed. Before finalizing, evaluate each formula's own y at its own
endpoints and a midpoint and confirm those numbers land in 15–205; if
not, shift the mapping's offset or shrink the domain until they do.

Pattern spacing is written in the graphic's own units and scales with the
transform; a brush's millimetre options do not.
