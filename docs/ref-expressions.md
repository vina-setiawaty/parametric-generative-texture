# Expression syntax

Formulas in `t`, or in `t` and `u` for fill families.

`+ - * /`, `^` (power), unary minus, parentheses, the constant `pi`, the
variables, and these functions only: `sin cos tan sqrt abs exp log`
(1 argument), `min max pow` (2 arguments). Anything else is a hard error.
Example: a 30 mm circle centred at (110,110):
`{"x": "110 + 30*cos(t)", "y": "110 + 30*sin(t)", "tEnd": 6.283185}`.

`t` need not be arc length — the page re-parameterises by real arc length,
so brush spacings always mean real mm. A single formula is one smooth
curve: it **cannot have a sharp corner**. A shape with corners uses a
`points` piece instead. A formula too steep to print at any resolution
(an extremely tight spiral, a saw-tooth) is rejected — soften it.

The curve is sampled in steps of `t`, not of millimetres, so a formula
written with a very small `tEnd` is sampled coarsely and its polygon cuts
corners. Prefer a `tEnd` in the tens over one around 1.
