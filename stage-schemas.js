// Per-stage JSON schemas and generation settings for the parametric-with-tool
// staged pipeline. Shared between api/parametric-stage.js (the legacy
// server-proxied path, kept as a fallback) and parametric-with-tool.js
// (which now calls the providers directly from the browser) so the two
// never drift. Pure data/ES module -- no Node-only or DOM-only APIs -- so it
// loads fine both as a Vercel function import and as a browser <script
// type="module"> import.
//
// `codeExecution` is always false here: see parametric-with-tool.js's header
// comment / docs/README.md for why this page's stages never request
// Anthropic's server-side code_execution tool.

export const chat = (what) => ({ type: "string", description: `conversational reply: ${what}` });

// The geometry stage's per-element shape.
export const GEOMETRY_ELEMENT_ITEM = {
  type: "object",
  properties: {
    id: { type: "string", description: "el_N; reuse the existing id for an element you keep, modify, or fix, empty for a brand-new one" },
    label: { type: "string", description: "short human label, e.g. 'x axis', 'bar 2', 'shaded area'" },
    kind: { type: "string", enum: ["line", "region", "point"] },
    role: { type: "string", description: "semantic role for the report: axis | tick | curve | bar | marker | label | other, or any other label that fits the element" },
    geometry: { type: "string", description: "JSON string. line, ONE stroke: {\"path\": <piece>}. line, a GROUP of several disconnected strokes sharing this one element's texture (e.g. all the axis's tick marks as one element): {\"paths\": [<piece>, <piece>, ...]}. region, an area between or under curves (ALWAYS use this form for one): {\"between\": {\"upper\": \"<line element id>\", \"lower\": \"<line element id>\" | {\"y\": <mm>}, \"xFrom\": n, \"xTo\": n}} -- the app samples both bounds, solves where they cross, cuts both to the same span and closes the ends, so do NOT compute intersections or write a bound's edge yourself; give xFrom/xTo only to pick a span narrower than the natural one. region, any other shape: {\"boundary\": [<piece>, ...]} concatenated in order and closed. point, ONE stamp: {\"at\": [x, y]}. point, a GROUP of several stamps sharing this one element's texture (e.g. a row of data markers): {\"at\": [[x,y], [x,y], ...]}. A piece is {\"x\": \"<expr in t>\", \"y\": \"<expr in t>\", \"tEnd\": n} OR {\"points\": [[x,y], ...]} OR {\"ref\": \"<line element id>\", \"xFrom\": n, \"xTo\": n, \"reverse\": bool} (a ref reuses another line's shape; xFrom/xTo cut it to an x range, on a formula path and a point list alike; ref only targets a single-stroke \"path\" line, not a \"paths\" group)." },
  },
  required: ["id", "label", "kind", "role", "geometry"],
  additionalProperties: false,
};

// One entry per element slot the texture stage sets or clears.
export const TEXTURE_ITEM = {
  type: "object",
  properties: {
    elementId: { type: "string" },
    slot: { type: "string", enum: ["brush", "outline", "fill"], description: "line/point: brush. region: outline (a line brush along the boundary) and/or fill (a pattern + brush)" },
    fn: { type: "string", description: "brush name from the reference; empty string clears the slot" },
    pattern: { type: "string", description: "fill slot only: JSON string of the pattern spec, e.g. {\"kind\": \"hatch\", \"angleDeg\": 45, \"gap\": 4}; empty otherwise" },
    options: { type: "string", description: "JSON string { optionName: value, ... } of the NUMBERS for this slot -- the brush's own options and, for a fill, its pattern's fields, named the same way (the app looks up which is which). Use only names listed in the OPTION SPECS you are given, and keep every value inside its stated range. Omit a name to keep the value it already has; \"{}\" to change none." },
  },
  required: ["elementId", "slot", "fn", "pattern", "options"],
  additionalProperties: false,
};

export const STAGES = {
  route: {
    schemaName: "parametric_route",
    schema: {
      type: "object",
      properties: {
        route: { type: "string", enum: ["geometry", "texture", "ui", "chat"], description: "which specialist the request enters (geometry runs texture and ui after it; texture runs ui after it); 'chat' answers without changing the scene" },
        instruction: { type: "string", description: "the user's request rewritten so it is self-contained: resolve 'this', 'the second bar', 'again' into element ids and concrete asks; empty when route is chat" },
        targets: { type: "array", items: { type: "string" }, description: "element ids the request is about (empty = the whole scene)" },
        acceptance: { type: "array", items: { type: "string" }, description: "2-6 short, checkable statements that would settle whether this turn succeeded, specific to this request ('three bars', 'bar heights in the ratio 5:12:8', 'the shading lies between the two curves only'). They are checked against the app's own measured numbers, so prefer statements numbers can settle. Empty when route is chat." },
        reply: { type: "string", description: "when route is chat: the answer or clarifying question; otherwise a one-line note of what will be done" },
      },
      required: ["route", "instruction", "targets", "acceptance", "reply"],
      additionalProperties: false,
    },
    maxOutputTokens: 8192, effort: "low", thinking: false, codeExecution: false,
  },
  geometry: {
    schemaName: "parametric_geometry",
    schema: {
      type: "object",
      properties: {
        chat: chat("what was built or changed, assumptions, anything the user should check"),
        elements: {
          type: "array",
          description: "the FULL ordered element list (print order), not a diff; keep ids of unchanged elements",
          items: GEOMETRY_ELEMENT_ITEM,
        },
        transform: { type: "string", description: "JSON string {\"scale\": n, \"origin\": [x, y] | null} to change the global placement, or empty to leave it" },
      },
      required: ["chat", "elements", "transform"],
      additionalProperties: false,
    },
    maxOutputTokens: 32768, effort: "medium", thinking: true, codeExecution: false,
  },
texture: {
    schemaName: "parametric_texture",
    schema: {
      type: "object",
      properties: {
        chat: chat("which texture and fill each element got and why it will feel distinct"),
        textures: {
          type: "array",
          description: "one entry per element slot you set or clear; omit slots you leave as they are",
          items: TEXTURE_ITEM,
        },
      },
      required: ["chat", "textures"],
      additionalProperties: false,
    },
    maxOutputTokens: 16384, effort: "medium", thinking: true, codeExecution: false,
  },
judge: {
    schemaName: "parametric_judge",
    schema: {
      type: "object",
      properties: {
        pass: { type: "boolean", description: "true when every acceptance criterion is met by the scene as measured" },
        failures: {
          type: "array",
          description: "one entry per criterion NOT met -- empty when pass is true",
          items: {
            type: "object",
            properties: {
              criterion: { type: "string", description: "the acceptance criterion, quoted" },
              evidence: { type: "string", description: "the number or fact from the report that shows it is not met" },
              suspectedStage: { type: "string", enum: ["geometry", "texture", "ui"], description: "which specialist can fix it: geometry for shapes, sizes, positions and which area is shaded; texture for which brush/pattern and its numbers; ui for what the panel surfaces" },
            },
            required: ["criterion", "evidence", "suspectedStage"],
            additionalProperties: false,
          },
        },
        note: { type: "string", description: "one line for the user: what you checked and what, if anything, is off" },
      },
      required: ["pass", "failures", "note"],
      additionalProperties: false,
    },
    maxOutputTokens: 2048, effort: "low", thinking: false, codeExecution: false,
  },
  ui: {
    schemaName: "parametric_ui",
    schema: {
      type: "object",
      properties: {
        chat: chat("which qualities are now surfaced in the panel, and what each one adjusts"),
        groups: {
          type: "array",
          description: "the FULL list of parameter groups the panel should show (replaces the previous list; keep the ids of ones you retain)",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "gr_N; reuse an existing id, empty for a new one" },
              title: { type: "string", description: "the heading, in the user's own words for the quality, e.g. 'shading density', 'how hairy the area feels'" },
              description: { type: "string", description: "one line: what this group of controls changes about how the graphic feels" },
              members: { type: "string", description: "JSON string [{\"level\": \"stroke\"|\"brush\"|\"pattern\"|\"graphic\", \"elementId\", \"slot\", \"option\", \"label\"}, ...] -- a curated SELECTION of real parameters relevant to this turn's request, each with its own short (1-3 word) label, e.g. \"row spacing\", \"dome size\". Only pick names that exist in the OPTION SPECS you were given for the texture actually in that slot. Omit elementId/slot for a graphic-level parameter. No weighting or direction -- just which parameters matter right now and what to call them." },
            },
            required: ["id", "title", "description", "members"],
            additionalProperties: false,
          },
        },
      },
      required: ["chat", "groups"],
      additionalProperties: false,
    },
    maxOutputTokens: 8192, effort: "medium", thinking: true, codeExecution: false,
  },
};
