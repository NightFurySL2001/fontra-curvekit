# fontra-curvekit

A [Fontra](https://github.com/fontra/fontra) editor plug-in that adds new tools to the glyph
editor, modelled after popular font and vector editors:

- **Scissors**: cut contours
- **Matchmaker**: make masters compatible
- **Curve Point**: bend segments and convert anchors

## Install

For public daily usage, add `NightFurySL2001/fontra-curvekit` in **Application settings
› Plugins**, then reload the page. Fontra loads the repository through jsDelivr. The
repository-root [`plugin.json`](plugin.json) points to the implementation under
`src/fontra_curvekit/plugin/`.

This plugin follows the [Fontra plug-in protocol](https://docs.fontra.xyz/how-tos/writing-plugins/).
Fontra calls `init(editor, pluginPath)` when the glyph editor opens. The package also has
a `fontra.webcontent` entry point, so an installed copy is served by the Fontra server at
`/curvekit/`.

For development, you can install it with these ways:

**A. As a Python package (like fontra-rcjk)**: install it in the same environment as
Fontra, then go to **Application settings › Plugins** and add `/curvekit/`:

```sh
pip install -e path/to/fontra-curvekit
```

The trailing slash matters in plugin manager: Fontra treats an address with exactly 
one `/` as a GitHub `owner/repo`.

**B. As a local plug-in in a Fontra source checkout**: copy or symlink
`src/fontra_curvekit/plugin` to `fontra/src/fontra/localplugins/curvekit` and add
`/localplugins/curvekit`. Git ignores that folder.

Fontra caches static files. After you change the plug-in, restart the server and reload with
the browser cache disabled.

## Layout

```
src/fontra_curvekit/plugin/    the editor plug-in (served at /curvekit/)
  plugin.json                  package manifest: { name, description, init, function }
  init.js                      entry point: registers the tools and the panel
  scissors-tool.js             Scissors tool
  matchmaker-tool.js           Matchmaker tool and its schematic view
  matchmaker-panel.js          Matchmaker sidebar panel (status, buttons)
  curve-point-tool.js          Curve Point tool (cubic and quadratic modes)
  anchor-ops.js                pure geometry of the Curve Point tool
  contour-ops.js               pure contour geometry (cut, split, match)
  editor-glue.js               small re-implementations of Fontra helpers
  images/                      tool icons
tests/                         node:test unit and smoke tests
plugin.json                    duplicate package manifest for JSDelivr, so the plugin can be served from the repository root
AGENTS.md                      decisions and conventions for coding agents
```

Plug-ins can't import Fontra's modules. Everything works on Fontra's editor objects
(`editor.sceneController`, `editor.visualizationLayers`, and so on) and on the
"unpacked contours" returned by `path.getUnpackedContour()`.

## Scissors

| Action | Result |
|---|---|
| Click a node | Cuts the contour at that node. A closed contour becomes open, starting and ending at the node. An open contour splits in two. |
| Click a segment | Inserts a node at that point. The contour isn't cut, whether open or closed; click the new node to cut there. |
| Drag from one node to another, the 2 corners of a junction | Same as a marquee around those 2 corners (see below): if they're the corners of a junction (T, Λ, "e" bar), it's split by extending the edges, previewed in green. Otherwise it's one of the straight cuts below. |
| Drag from one node to another, same contour | Splits a closed contour into two closed contours along a straight line. |
| Drag from one node to another, different contours | Joins two closed contours, such as the outer contour and a counter of an O or Ø, through a zero-width slit along the cut. The fill doesn't change. A second cut across the same stroke then splits the shape into two pieces. |

Two different contours that run the same way (both clockwise or both anticlockwise) and are both at the top level (not inside another contour) are separate shapes, such as the dot and the stem of an "i" or two overlapping strokes: a drag between them is refused (red), even where they overlap. An outer contour and its counter (opposite directions) can be joined, and so can two counters inside the same outer contour, like the two of 日, so cutting across 日's middle bar splits it. After any cut or split, a cut node left in the middle of a straight line (straight segments on both sides, in line within 5°) is removed, so a bar's edge that now runs straight across has no leftover node. Nodes next to a curve are kept.
| Marquee around the 4 inner corners of a crossing (X, +, Ø) | Splits the crossing into overlapping strokes, such as `\` and `/`. The 4 corners can be on one closed contour or on several; in an Ø they're on the outer contour and both counter halves. Each involved contour is cut at the corners, and the pieces are re-linked across the crossing with straight bridges. Each bridge goes to the corner that best continues its edge. If the edge arrives on a cubic curve and the edge it bridges to leaves on a cubic curve, the bridge is a cubic curve that extends both handles, and both corners become smooth (an Ø's ring and counter close up as smooth curves). Otherwise the bridge is a straight line (the slash edges). The split only happens if, at every corner, the arriving edge, the bridge and the leaving edge are within 40° of each other. Otherwise it falls back to stem cuts. No separate crossover contour is made. For an Ø, do this at both places where the slash crosses the ring to get a separate O and slash. The bridges preview in green. |
| Marquee around the 2 corners of a junction (T, Λ under a bar, two touching chevrons, an "e" bar running into the bowl) | Splits the junction into overlapping strokes. The marquee must hold exactly 2 nodes on closed contours, either on one contour or on two (in an "e", one corner is on the counter and one on the outer contour). The contours are cut at the corners, and the pieces are re-linked by extending their edges straight on beyond the corners, so the edge arriving at one corner continues out of the other. Corners on one contour give two overlapping contours. Corners on two contours join them into one, where the bar now overlaps the wall. If the edges are in line, a straight bridge joins them, so a bar's edge runs straight across. If the edges converge, they run on to the point where they meet, however deep, as long as that point is inside the outline, such as the apex of a tapered stem or the tip of a chevron. Otherwise (parallel or diverging edges, or a meeting point that would stick out of the outline) both run on 50% of the way across the stroke they enter, measured along the edge to the stroke's far side, and are joined there with a straight cap: a T's stem goes halfway up into the bar, and an "e" bar halfway into the wall. An edge's direction is taken where it reaches the corner, but a short straight step right at the corner (shorter than a quarter of the distance between the two corners, like the notch at the foot of Source Han Sans' "a" stem) is skipped, so the edge runs on along the curve before it. If an edge would run off into nothing, it falls back to stem cuts. The bridges preview in green. |
| Drag in empty space (marquee) | Cuts the stems inside the rectangle. Nodes of closed contours inside it, on the same or different contours, are paired and cut, closest pair first. A node is used by one cut only. Planned cuts preview in green. |

While you drag, a green line means the cut will work. A red line means it can't be made: an
open contour, an off-curve point, or a degenerate result.

Edits apply to every layer being edited (multi-source editing). A layer is skipped, and a
note goes to the console, if its contours are structured differently from the displayed
glyph.

## Matchmaker

When the tool is active, the glyph changes to a **schematic view**. All masters (glyph
sources) are drawn side by side along a view-angle vector. Each master's outline has its own
colour, shown in the panel's legend. Dashed lines connect corresponding nodes of compatible
contours. Incompatible contours have a red halo.

- **View angle**: drag the blue handle at the glyph origin. Hold Shift to constrain it to
  horizontal or vertical. **Reset view angle** restores the default.
- **Make a segment compatible**:
  1. Draw a free-hand lasso around the matching nodes at one end of the segment across all
     masters. The lasso always closes with a straight line from the pointer back to where
     you started, and it takes at most one node per master (the one nearest the lasso's
     middle). This is the **blue group**.
  2. Do the same at the other end. This is the **orange group**.
  3. When the segment is highlighted in green, click a node of either group, press Enter, or
     use **Match segment**.

  Nodes are added (by splitting the longest segments) until every master has the same node
  count along the segment. Lines are converted to curves where other masters have curves.
  The start points are then aligned relative to the blue nodes (see **Align start
  points**). If the segment's contour has a different contour number in some masters, it
  is moved to the number it has in the selected master, in the same undoable edit.
  Clicking a single node adds it to the current group. Shift-lasso adds nodes to the
  current group. Escape clears both groups.
- **Contour numbers** are drawn at each contour's start node in the schematic view.
- **Set start point**: right-click a node in the schematic view and choose **Set Start
  Point**. The node becomes the start point of its contour in that master only, as an
  undoable edit. The item is checked if the node is already the start point. It's disabled
  for open contours. Right-clicking away from a node shows Fontra's normal menu.

### Matchmaker panel

In the right sidebar. The **selected master** is the reference for every button that lines
masters up: it's never changed itself.

- A green or red **status** circle and a list of issues, then the blue and orange group
  counts.
- **Buttons**:
  - **👁 Matchmaker tool** switches to the Matchmaker tool.
  - **Align start points**: select the corresponding node in every shown master (the blue
    group, or the orange one if blue is incomplete), then click it. In each master, the
    start point moves so it lies as many nodes before the selected node as it does in the
    selected master. Open contours are left alone. One undoable edit.
  - **Match segment** matches the segment between the blue and orange groups (see above).
  - **Reorder contours** only puts each master's contours in the selected master's order,
    by their bounding boxes relative to the whole glyph (so bolder and wider masters
    compare). Nothing else changes: no reversing, start points or nodes. It needs the same
    number of contours in every master. One undoable edit.
  - **Force match masters** makes all masters compatible automatically, so the result
    interpolates without contours swapping places or spinning. In one undoable edit, it:
    1. **reorders** the contours, as **Reorder contours** does. A contour is paired with
       one running the same way when there is one;
    2. **reverses** a contour that still runs the other way from its partner;
    3. **aligns start points**: each closed contour starts at the node from which its
       whole outline, compared inside its own bounding box, best follows the reference's;
    4. **matches nodes**: missing nodes are inserted by relative arc-length position, and
       lines become curves where other masters have curves.

    The message says what was done. It also works on masters that are already compatible,
    to fix order, direction and start points.
  - **Clear groups** and **Reset view angle**.
- **Masters**: each master has an eye icon that shows or hides it in the schematic view.
  Hidden masters are left out of the view, the node groups, **Align start points** and
  **Match segment**. The status, **Reorder contours** and **Force match masters** use all
  masters. Each master keeps its colour.
- **Selected master**: clicking a master also selects that glyph source in the editor,
  like clicking it in Fontra's sources panel. Selecting a source in Fontra selects that
  master in the panel. At an interpolated location the panel keeps its last selection.
  The selected master has a slightly thicker outline in the schematic view.
- **Contours of a master**: the selected master's contours. Drag a row, or use ▲/▼, to
  reorder them by hand. This is an undoable edit of that master's layer. ✓ or ✗ shows
  whether a contour matches the same-numbered contour in the other shown masters.
  Hovering a row highlights that contour in the schematic view.
- **Options**:
  - **Stretch masters width in preview** compensates for width differences in the
    schematic view. It doesn't change the glyphs.
  - **Show incompatible contours in red** turns the red halo on or off.
  - **Highlight hovered contour in all masters** highlights the hovered contour number in
    every shown master.
- A short **help** section at the bottom.

## Curve Point

Anchors (on-curve points) never move: only handles and the smooth/corner state change.

- **Drag a segment**: it bends so the spot you grabbed follows the pointer. A straight
  line becomes a curve. A smooth anchor at either end stays smooth (the next segment's
  handle turns with it), unless the next segment is a line.
- **Drag an anchor**: pull out symmetric handles. The anchor becomes smooth, and a line next
  to it becomes a curve.
- **Click an anchor**: a smooth anchor becomes a corner (its handles retract, and a curve
  whose handles are both retracted becomes a line). A corner becomes smooth: its handles
  turn onto a common direction and keep their lengths. Next to a line, the curve's
  handle turns onto the line. Between two lines, both lines become curves.
- **Drag a handle**: move it on its own. Its anchor becomes a corner.
- **Click a line**: add straight handles. The line becomes a curve whose handles lie on the
  line at ⅓ and ⅔ of its length, so it still looks straight, ready to shape. In cubic mode
  that's two cubic handles; in quadratic mode, two quadratic off-curve points. Clicking a
  curve does nothing.
- **Shift-click a handle or a curve**: remove both handles of the segment, which becomes a
  straight line again. Its two anchors become corners. Shift-clicking a line does nothing.

Like the pen tool, the button has two modes (hold it down to choose):
**Curve Point Tool (cubic)** and **Curve Point Tool (quadratic)**. The mode sets the kind
of curve a line turns into. Existing curves keep their kind.

Drags show the change live and undo in one step. Edits apply to every layer being edited
whose contours have the same structure as the displayed glyph. Each layer gets the same
change, in the same way Fontra moves points in several layers at once.

## Limitations

- Scissors node-to-node and marquee stem cuts close each part with a straight line along
  the cut. Removing mid-line nodes can straighten an edge that was almost straight (within
  5°), such as the slight slant at the foot of an "a" stem. Only the crossing and junction splits extend strokes into overlapping parts.
- The Matchmaker only adds nodes and never removes them: there is no segment clean-up.
- Matchmaker can't fix different contour counts or open/closed mismatches. These are
  reported in the panel. With different contour counts, **Reorder contours** is disabled
  and **Force match masters** skips reordering.
- Cubic segments with more than two off-curve points can't be split.
- The Curve Point tool can't bend quadratic segments with more than one off-curve point.
- Tooltips are in English only, because plug-ins can't extend Fontra's translations.

## Development

```sh
npm test   # node --test: contour geometry, anchor operations and tools
```

## License

MIT. See `LICENSE`.
