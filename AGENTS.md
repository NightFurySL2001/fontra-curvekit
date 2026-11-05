# AGENTS.md: fontra-curvekit

Notes for coding agents working on this package: decisions that were made on purpose and
aren't obvious from the code. Read `README.md` for what the tools do. Keep this file up
to date when a decision changes.

## What it is

A Fontra glyph-editor plug-in with three tools: **Curve Point**, **Scissors** and
**Matchmaker**, plus the Matchmaker sidebar panel. Pure JavaScript; the Python package
only exists to serve the plug-in. MIT licensed, like fontra-splitzi.

- Package `fontra-curvekit`, Python module `fontra_curvekit`, served at `/curvekit/`
  through the `fontra.webcontent` entry point.
- Users add it in **Application settings › Plugins** as `/curvekit/`. The trailing slash
  matters: Fontra reads an address with exactly one `/` as a GitHub `owner/repo`.
- The standalone jsDelivr manifest is the repository-root `plugin.json`. Its `init` path
  points to `src/fontra_curvekit/plugin/init.js`; do not move that entry point or assume
  the repository root is the plug-in directory.
- Static assets are resolved with `new URL("./images/<name>.svg", import.meta.url).href`,
  relative to the module that uses them. This is required because `pluginPath` is the
  plug-in base URL in Fontra, while a jsDelivr deployment may expose the nested source
  directory below the repository root. The same code must continue to work for both
  jsDelivr and `/curvekit/`.
- Identifiers use the `curvekit` prefix: tools `curvekit-<name>-tool` (sub-tools
  `curvekit-curve-point-tool-cubic` / `-quad`), visualization layers
  `curvekit.<name>.<layer>`, the panel `curvekit-matchmaker`.

## Wording and naming

- **Don't name other products.** Don't name third-party font or vector applications in
  code, comments, README, `plugin.json` or `pyproject.toml`. The tools are described as
  "new tools modelled after popular font and vector editors". No links to other
  products' manuals.
- **Tool titles are the name only**, like Fontra's own ("Pen Tool (cubic)"):
  "Curve Point Tool (cubic)", "Curve Point Tool (quadratic)", "Scissors Tool",
  "Matchmaker Tool". No usage hints in tooltips; usage goes in the README.
- The tool is **Curve Point**, not Anchor Point. `anchor-ops.js` keeps its name because
  it operates on anchors (on-curve points).
- Plug-in name in `plugin.json`: "CurveKit".

## Fontra constraints

- **Plug-ins can't import Fontra modules** (`@fontra/core/...` is bundled). What's needed
  is re-implemented in `editor-glue.js`. Live edits send plain change objects in Fontra's
  format, built by hand (see `replaceContourChange` in `curve-point-tool.js`).
- **Edits apply to the editing layers only** (`sceneController.getEditingLayerFromGlyphLayers`
  / `editLayersAndRecordChanges`), as Fontra's pen tool does: normally just the current
  source, more when the user turns on editing for several sources. Never edit every
  master. Unlike the pen tool, we find the hit once on the displayed glyph and apply the
  same operation to each layer, so layers whose contour structure differs
  (`contourSignature`) are skipped and logged.
- **No shortcuts.** Fontra registers `actions.tools.<id>` for tools in `initActions()`,
  before plug-ins load, and the action registry isn't reachable from a plug-in. So plug-in
  tools get no keyboard shortcut and don't appear in Application settings › Shortcuts.
  Options discussed and not yet chosen: a plug-in `keydown` listener, or a small upstream
  Fontra change that registers actions for tools added later.
- Sub-tools are constructed by Fontra as `new SubTool(editor)`, so `createCurvePointTool`
  defines the classes in a closure to pass `pluginPath`.
- Tool button titles are set after `addEditTool` with `setToolButtonTitle` (it matches
  `.tool-button` and `.subtool-button`). The multi-tool wrapper has no title, same as
  Fontra's pen tool.
- Toolbar order: Curve Point, then Scissors, then Matchmaker (`init.js`).

## Fontra internals used

None of these are a public plug-in API; they're Fontra's editor objects as of the
version in the workspace `fontra/` checkout. Check them first when Fontra is updated.
`editor` is the editor controller Fontra passes to `init(editor, pluginPath)`.

- **Registration** (`init.js`): `editor.addEditTool(tool)`, `editor.tools` (all tools by
  identifier, including sub-tools), `editor.setSelectedTool(id)`,
  `editor.selectedToolIdentifier`, `editor.addSidebarPanel(element, "right")`. DOM:
  `.tool-button[data-tool]`, `.subtool-button[data-tool]` (titles),
  `.sidebar-tab[data-sidebar-name]` (panel tab title).
- **Tool protocol** (what Fontra calls on a tool): `identifier`, `title`, `iconPath`,
  `subTools` (multi-tool; Fontra does `new SubTool(editor)`), `activate()`,
  `deactivate()`, `handleHover(event)`, `handleDrag(eventStream, initialEvent)`,
  `handleKeyDown(event)`, `getContextMenuItems(event)`. Fallback for the editing case:
  `editor.tools["pointer-tool"].handleDrag(...)`.
- **Scene** (`editor.sceneController`, `.sceneModel`):
  - reading: `sceneModel.selectedGlyph?.isEditing`,
    `sceneModel.getSelectedPositionedGlyph().glyph` (`.path`, the interpolated instance),
    `sceneModel.getSelectedVariableGlyphController()` (`.glyph.sources`,
    `.glyph.layers`), `sceneController.selectedGlyphPoint(event)`,
    `sceneController.mouseClickMargin`, `sceneController.onePixelUnit`;
  - editing: `sceneController.editLayersAndRecordChanges(cb)` (one-shot edits on the
    editing layers), `sceneController.getEditingLayerFromGlyphLayers(layers)` +
    `sceneController.editGlyph(async (sendIncrementalChange, glyph) => ...)` (live
    drags in the Curve Point tool, with hand-built change objects),
    `sceneController.editGlyphAndRecordChanges(cb)` (Matchmaker's per-master edits),
    `sceneController.selection` (cleared or set after edits);
  - listening: `sceneController.addCurrentGlyphChangeListener(cb)`,
    `editor.sceneSettingsController.addKeyListener(keys, cb)` on `selectedGlyphName`,
    `fontLocationSourceMapped`, `glyphLocation`, `editLayerName`; the panel follows the
    selected source through `sceneSettings.editLayerName` and sets it with
    `sceneController.setLocationFromSourceIndex(i)`.
- **Context menu**: Matchmaker wraps `editor.buildContextMenuItems` once
  (`installContextMenu`); while the tool is active and the right-click is on a schematic
  node, it returns its own items (Set Start Point), otherwise Fontra's.
- **Paths** (`VarPackedPath`): `numContours`, `getUnpackedContour(i)`,
  `setUnpackedContour(i, c)`, `insertUnpackedContour(i, c)`,
  `appendUnpackedContour(c)`, `deleteContour(i)`, `getContour(i)`. Unpacked contours are
  `{points: [{x, y, type?, smooth?}], isClosed}`, `type` set on off-curve points only
  (`"cubic"` / `"quad"`).
- **Drawing**: `editor.visualizationLayers.definitions` (we splice our layer
  definitions in by `zIndex`), `visualizationLayers.toggle(id, true)` (visible ids are
  only computed at construction), `visualizationLayers.darkTheme`;
  `visContext.glyphsBySelectionMode.editing` in the selection function;
  `canvasController.requestUpdate()`, `canvasController.canvas.style.cursor`.

## Icons

- **No `<?xml …?>` declaration.** Fontra inlines icons with `htmlToElement()`, which
  rejects markup with more than one top-level node; the declaration becomes a comment
  node and the icon silently disappears.
- Filled icons: plain paths, no fill colour (the toolbar CSS sets `fill`).
- Stroked icons: `class="icon-tabler"`, `fill="none"`, `stroke="currentColor"`, like
  Fontra's tabler icons, so they follow dark mode and the selected state.
- The user draws the icons; don't redesign them unasked.

## Tool decisions

### Curve Point

- **Anchors never move.** Every operation changes only off-curve points and smooth flags.
  Tests check on-curve coordinates are unchanged.
- Drag a segment: bend so the grabbed point follows the pointer (cubic handles weighted by
  position along the curve, `t` clamped to 0.1–0.9). A line becomes a curve of the
  current mode's type.
- Click a corner anchor: make it smooth. Click a smooth anchor: retract to a corner.
- Drag an anchor: pull out symmetric handles. Drag a handle: move it alone (cusp).
- **Click a line**: add straight handles on it at 1/3 and 2/3 (`addStraightHandles`,
  rounded), so it stays straight. Cubic mode: 2 cubic handles; **quadratic mode: 2 quad
  off-curve points** (the user's choice, not 1). Undo label "Add handles". A click on a
  curve does nothing (no undo step). Shift-click is the reverse.
- **Shift-click a handle or a curve segment**: remove all handles of the segment, back to a
  straight line (`straightenSegment` / `straightenSegmentAt`); both end anchors become
  corners. Undo label "Straighten segment". A plain click on a handle does nothing;
  Shift-click on a line does nothing.
- Cubic/quadratic modes like the pen tool. The mode only decides the type of curves made
  from lines; existing curves keep their type.
- Drags are live (`sceneController.editGlyph` + incremental changes) and undo in one step.

### Scissors

- **Click a node**: cut there (closed → open at the node; open → two pieces).
- **Click a segment: only inserts a node**, for open and closed contours alike. It never
  cuts; click the new node to cut. Undo label "Insert point".
- **Node-to-node drag runs the marquee's two-corner check first** (the user's request):
  if the two nodes are the corners of a junction, it's the same extension split as a
  marquee around them (`planExtensionSplitForCorners`, shared with `planExtensionSplit`;
  undo label "Split junction"; the bridges preview in green instead of the drag line).
  The corners are sorted into index order first, as the marquee finds them; drag order
  would otherwise give the pieces in a different contour order. Only if that doesn't
  apply: split one contour, or join two contours through a slit ("Split contour").
- **Which contours can be joined** (`canJoinContours` in `canCutBetween`, the user's
  rule): two different contours running the same way (same `signedArea` sign) **and
  both at the top level** (no other contour holds all of their outline,
  `isTopLevel` / `pointInPolygon`) are separate shapes and are refused, even if they
  overlap: an "i" dot and stem, two overlapping strokes. Opposite directions (outer and
  counter) join; same-direction contours that aren't both top level join too, like the
  two counters of 日, so a cut across its middle bar splits it. Marquee stem cuts use
  the same check when pairing nodes.
- Marquee with the 4 corners of a crossing: parallel split (`parallelSplitContours`).
- **Marquee with the 2 corners of a junction** (T, Λ, "e" bar): extension split
  (`extensionSplitContours`).
  - Edges in line: straight bridge.
  - Converging edges: run on to their meeting point **however deep, as long as it's
    inside the outline** (on the outline counts as inside).
  - Otherwise (parallel or diverging, or the meeting point sticks out): run on
    **`maxDepth` = 50%** of the way across the stroke they enter (measured along the
    edge to where it hits the far side) and join with a flat cap. Never through to the
    far side. Each layer computes its own 50%; `kinds` from the displayed glyph keep the
    structure the same across layers.
  - **After any Scissors cut or split, cut nodes left mid-line are removed**: 
    on-curve, both neighbours on-curve, direction change ≤ 5°
    (`redundantLineNodes`, checked one after another against current neighbours;
    `removeNodes`). Decided on the displayed glyph and removed by index in every layer
    (`applyOperations`), so the layers stay compatible. Clicks (cut at a node, insert a
    node) don't count. Nodes next to curves stay.
  - Edge directions at the corners skip short straight steps (< `STUB_FRACTION` = 25%
    of the corner distance, `edgeDirection`), e.g. the 3-unit notch in Source Han Sans
    "a"; otherwise the extension runs along the notch instead of the curve.

### Matchmaker

- Schematic view of all masters side by side. Blue and orange node groups select a
  segment run. "Match segment" adds nodes and unifies segment types.
- **Groups are picked with a free-hand lasso, not a marquee** (the user's choice;
  `dragLasso` / `nodesInLasso`):
  - the pointer's path, **always closed by a straight line from the current point back
    to the start**, both when drawn and when testing nodes (even-odd `pointInPolygon` in
    `contour-ops.js`);
  - at most one node per master, the one nearest the centre of the lasso's bounding box;
  - fewer than 3 points select nothing; Shift-lasso adds to the current group; a click
    on a single node still adds it.
  - The Scissors tool keeps its **rectangle** marquee; don't change one with the other.
- **Different contour order per master**: the groups may be on different contour
  indices in different masters. Match segment then also moves each master's contour to
  the index it has in the **selected master** (the reference, as for the start points;
  the user first asked for the first master, then changed it to the selected one), in
  the same undo step. The message says "Moved the contour to position N in M
  master(s)."
- **Start points are aligned relative to the selected nodes.** "Match segment" does it
  automatically from the blue group, after matching the nodes (one undo step: add nodes,
  align start points, move the contour); "Align start points" does it on its own. The
  reference is the master selected in the panel (synced with Fontra's selected source),
  else the first shown master; it isn't changed. Open contours are left alone.
- **Force match masters** (`matchAllMasters`), against the reference master (the
  selected one, as above), in one undo step:
  1. reorder contours by bounding box relative to the glyph bounds
     (`matchContourOrder`, Hungarian assignment). A direction mismatch only adds a
     penalty, so a contour pairs with a same-direction partner when there is one; only
     then
  2. reverse contours still running the other way (`reverseContour`, keeps the start
     node);
  3. align start points by comparing the whole outline, sampled by arc length, inside
     each contour's own bounding box (`alignContourStartsToReference`). Never by raw
     coordinates or the start node alone: that spins contours in bolder, wider or
     shifted masters. Ties keep the current start;
  4. `autoMatchContours` (nodes by arc-length fraction, segment types unified).

  It runs on compatible masters too, so the button stays enabled with 2+ masters.
- **Reorder contours** (`reorderAllContours`) is step 1 alone, sharing
  `reorderedContourLists` with Force match masters. It must not reverse, rotate or add
  nodes.
- Matchmaker only adds nodes, never removes them.
- The panel's labels are the user's: "👁 Matchmaker tool", "Align start points", "Match
  segment", "Reorder contours", "Force match masters", "Stretch masters width in
  preview". Keep the README's panel section in step with `matchmaker-panel.js`.

## Code layout

- `contour-ops.js` and `anchor-ops.js`: pure geometry on unpacked contours
  (`{points, isClosed}`), no DOM or Fontra. Put new geometry here and unit-test it.
  Operations return new contours, or `undefined` when they don't apply.
- Tool files (`*-tool.js`, `matchmaker-panel.js`): event handling, hit testing, feedback
  drawing, Fontra edits.

## Formatting

- The sources use Prettier-style formatting (80 columns, trailing commas), but several
  files aren't Prettier-clean. Keep new lines within 80 columns; don't run Prettier over
  whole files, which would reformat the user's code.

## Testing and checking

- `npm test` (node:test). `tests/tools.test.js` drives the tools through a fake editor
  (fake `editGlyph`, `editLayersAndRecordChanges`, sub-tool support). Use 2+ move events
  per test drag: `shouldInitiateDrag` consumes the first.
- Check behaviour in the real editor when it matters: run Fontra from the workspace
  `.venv` on a spare port against a scratch copy of a font (never the user's own files)
  and drive headless Edge with puppeteer-core. Don't stop the user's own Fontra server.
  The venv is in the workspace root, not in `fontra/`:
  `.venv/Scripts/fontra.exe --http-port 8124 filesystem <scratch folder>`, and stop only
  the process listening on that port afterwards. Reinstall a plug-in after changing its
  packaging with `uv pip install --python .venv/Scripts/python.exe -e ./<plug-in>`.
- After changes, the user restarts Fontra or hard-reloads (Ctrl+Shift+R); Fontra and the
  browser cache static files and icons.

## Licence

- MIT (`LICENSE`, `pyproject.toml`). Don't copy code or artwork from GPL sources such as
  Fontra itself into this package; re-implement instead.
