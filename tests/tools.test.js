// Smoke tests driving the tools through a minimal fake of Fontra's editor API
// (only the members the plug-in uses).
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  contourSignature,
  setContourStartPoint,
  splitSegment,
} from "../src/fontra_curvekit/plugin/contour-ops.js";

// --- minimal browser globals --------------------------------------------------
globalThis.Path2D = class {
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  quadraticCurveTo() {}
  closePath() {}
};
globalThis.HTMLElement = class {
  attachShadow() {
    this.shadowRoot = fakeElement();
    return this.shadowRoot;
  }
};
const registry = new Map();
globalThis.customElements = {
  get: (tag) => registry.get(tag),
  define: (tag, cls) => registry.set(tag, cls),
};
function fakeElement() {
  const el = {
    innerHTML: "",
    textContent: "",
    children: [],
    classList: { toggle() {}, add() {}, remove() {} },
    style: {},
    append(...children) {
      el.children.push(...children);
    },
    replaceChildren(...children) {
      el.children = children;
    },
    addEventListener() {},
    querySelector: () => fakeElement(),
  };
  return el;
}
globalThis.document = {
  querySelector: () => fakeElement(),
  createElement: (tag) => (registry.has(tag) ? new (registry.get(tag))() : fakeElement()),
};

const { ScissorsTool } = await import("../src/fontra_curvekit/plugin/scissors-tool.js");
const { MatchmakerTool } = await import("../src/fontra_curvekit/plugin/matchmaker-tool.js");
const { init } = await import("../src/fontra_curvekit/plugin/init.js");
const { createCurvePointTool } = await import(
  "../src/fontra_curvekit/plugin/curve-point-tool.js"
);

// --- fake path / editor -------------------------------------------------------
class FakePath {
  constructor(contours) {
    this.contours = structuredClone(contours);
  }
  get numContours() {
    return this.contours.length;
  }
  getUnpackedContour(i) {
    return structuredClone(this.contours[i]);
  }
  setUnpackedContour(i, c) {
    this.contours[i] = structuredClone(c);
  }
  deleteContour(i) {
    this.contours.splice(i, 1);
  }
  appendUnpackedContour(c) {
    this.contours.push(structuredClone(c));
  }
  insertUnpackedContour(i, c) {
    this.contours.splice(i, 0, structuredClone(c));
  }
  // stands in for the packed contour of Fontra's change objects
  getContour(i) {
    return { packed: structuredClone(this.contours[i]) };
  }
}

const rect = (x0, y0, x1, y1) => ({
  points: [
    { x: x0, y: y0 },
    { x: x0, y: y1 },
    { x: x1, y: y1 },
    { x: x1, y: y0 },
  ],
  isClosed: true,
});

function fakeEditor(layerContours) {
  // layerContours: { layerName: [contour, ...] }
  const layers = Object.fromEntries(
    Object.entries(layerContours).map(([name, contours]) => [
      name,
      { glyph: { path: new FakePath(contours), xAdvance: 500 } },
    ])
  );
  const varGlyph = {
    sources: Object.keys(layers).map((name) => ({ name, layerName: name })),
    layers,
  };
  const firstLayer = Object.keys(layers)[0];
  const sceneSettings = {
    selectedGlyphName: "O",
    fontLocationSourceMapped: {},
    glyphLocation: {},
    editLayerName: null,
  };
  // Sources sit at wght = 0, 100, 200, ...; location strings are the wght value
  const varGlyphController = {
    sources: varGlyph.sources,
    getSparseLocationStringForSourceLocation: (location) => `${location.wght ?? 0}`,
    getSourceIndexForSourceLocationString: (string) => {
      const index = Number(string) / 100;
      return Number.isInteger(index) && index < varGlyph.sources.length ? index : undefined;
    },
  };
  const keyListeners = [];
  const setSceneSetting = (key, value) => {
    sceneSettings[key] = value;
    for (const [keys, listener] of keyListeners) {
      if ([keys].flat().includes(key)) {
        listener({ key, newValue: value });
      }
    }
  };
  const positionedGlyph = {
    varGlyph: { glyph: varGlyph },
    // the displayed instance: the first layer
    get glyph() {
      return { path: layers[firstLayer].glyph.path };
    },
  };
  const undoLabels = [];
  const incrementalChanges = [];
  const editResults = [];
  const sceneModel = {
    selectedGlyph: { isEditing: true },
    getSelectedPositionedGlyph: () => positionedGlyph,
    getSelectedVariableGlyphController: async () => varGlyphController,
  };
  const sceneController = {
    sceneModel,
    selection: new Set(),
    mouseClickMargin: 10,
    onePixelUnit: 1,
    selectedGlyphPoint: (event) => ({ x: event.gx, y: event.gy }),
    editLayersAndRecordChanges: async (fn) => {
      undoLabels.push(
        fn(Object.fromEntries(Object.entries(layers).map(([n, l]) => [n, l.glyph])))
      );
    },
    editGlyphAndRecordChanges: async (fn) => undoLabels.push(fn(varGlyph)),
    getEditingLayerFromGlyphLayers: (glyphLayers) =>
      Object.fromEntries(Object.entries(glyphLayers).map(([n, l]) => [n, l.glyph])),
    // like Fontra: the edit function changes the glyph and sends incremental
    // changes; it returns the final change and its undo label
    editGlyph: async (fn) => {
      const result = await fn(async (change) => incrementalChanges.push(change), varGlyph);
      editResults.push(result);
      if (result?.undoLabel) {
        undoLabels.push(result.undoLabel);
      }
    },
    addCurrentGlyphChangeListener() {},
    setLocationFromSourceIndex: async (sourceIndex) =>
      setSceneSetting("glyphLocation", { wght: sourceIndex * 100 }),
  };
  const definitions = [];
  const editor = {
    canvasController: { canvas: { style: {} }, requestUpdate() {} },
    sceneController,
    sceneSettingsController: {
      addKeyListener: (keys, listener) => keyListeners.push([keys, listener]),
    },
    sceneSettings,
    fontController: { unitsPerEm: 1000 },
    visualizationLayers: { definitions, toggle() {} },
    tools: {},
    addEditTool(tool) {
      this.tools[tool.identifier] = tool;
      for (const subToolClass of tool.subTools || []) {
        const subTool = new subToolClass(this);
        this.tools[subTool.identifier] = subTool;
      }
    },
    addSidebarPanel(panel, side) {
      this.panels = [...(this.panels || []), [panel, side]];
    },
    buildContextMenuItems: () => ["fontra's own menu"],
    setSelectedTool(id) {
      this.selectedToolIdentifier = id;
    },
  };
  return {
    editor,
    layers,
    undoLabels,
    definitions,
    sceneSettings,
    setSceneSetting,
    incrementalChanges,
    editResults,
  };
}

let pageX = 0;
function ev(gx, gy, extra = {}) {
  pageX += 10; // make every event count as movement
  return { gx, gy, x: gx, pageX, pageY: 0, ...extra };
}
// Like Fontra's event stream, breaking out of a for-await loop must not end
// the stream (shouldInitiateDrag consumes the first events, then the tool
// continues iterating), so the iterator has no return() method.
function stream(...events) {
  let index = 0;
  const iterator = {
    next: async () =>
      index < events.length
        ? { value: events[index++], done: false }
        : { value: undefined, done: true },
    [Symbol.asyncIterator]: () => iterator,
  };
  return iterator;
}
const click = (gx, gy) => [stream(), { ...ev(gx, gy), pageX: 0 }];
const drag = (from, ...to) => {
  const initial = ev(...from);
  return [stream(...to.map((p) => ev(...p))), initial];
};

const mockContext = new Proxy(
  {},
  {
    get: (target, key) => (key in target ? target[key] : () => {}),
    set: (target, key, value) => ((target[key] = value), true),
  }
);
function drawLayer(definitions, identifier, context = mockContext) {
  const def = definitions.find((d) => d.identifier === identifier);
  const parameters = { ...def.screenParameters, ...def.colors };
  def.draw({ context, parameters });
  return parameters;
}

// A context recording the stroke style and width of every stroke() call
function recordingContext() {
  const strokes = [];
  const state = {};
  const context = new Proxy(state, {
    get: (target, key) =>
      key === "stroke"
        ? () => strokes.push({ style: target.strokeStyle, width: target.lineWidth })
        : key in target
          ? target[key]
          : () => {},
    set: (target, key, value) => ((target[key] = value), true),
  });
  return { context, strokes };
}

// --- tests --------------------------------------------------------------------
describe("ScissorsTool", () => {
  let f;
  let tool;
  beforeEach(() => {
    f = fakeEditor({
      Light: [rect(0, 0, 100, 100)],
      Bold: [rect(0, 0, 200, 200)],
    });
    tool = new ScissorsTool(f.editor, "/curvekit");
    tool.activate();
  });

  test("registers its visualization layer", () => {
    assert.ok(f.definitions.some((d) => d.identifier === "curvekit.scissors.feedback"));
  });

  test("click on a node opens the contour in every layer", async () => {
    await tool.handleDrag(...click(0, 100));
    for (const layer of Object.values(f.layers)) {
      const [contour] = layer.glyph.path.contours;
      assert.equal(contour.isClosed, false);
      assert.equal(contour.points.length, 5);
    }
    assert.deepEqual(f.undoLabels, ["Cut contour"]);
  });

  test("click on a segment of a closed contour inserts a node; it stays closed", async () => {
    await tool.handleDrag(...click(50, 101));
    const [light] = f.layers.Light.glyph.path.contours;
    assert.equal(light.isClosed, true);
    assert.equal(light.points.length, 5);
    assert.ok(light.points.some((p) => p.x === 50 && p.y === 100));
    const [bold] = f.layers.Bold.glyph.path.contours;
    assert.equal(bold.isClosed, true);
    assert.ok(bold.points.some((p) => p.x === 100 && p.y === 200)); // same t in the Bold layer
    assert.deepEqual(f.undoLabels, ["Insert point"]);
  });

  test("click on a segment of an open contour only inserts a node too", async () => {
    await tool.handleDrag(...click(0, 100)); // open the rectangle at (0,100)
    await tool.handleDrag(...click(50, 101)); // then click its top edge
    const contours = f.layers.Light.glyph.path.contours;
    assert.equal(contours.length, 1);
    assert.equal(contours[0].isClosed, false);
    assert.equal(contours[0].points.length, 6);
    assert.ok(contours[0].points.some((p) => p.x === 50 && p.y === 100));
    assert.deepEqual(f.undoLabels, ["Cut contour", "Insert point"]);
  });

  test("hover and drag feedback draw without errors", async () => {
    tool.handleHover(ev(0, 0));
    drawLayer(f.definitions, "curvekit.scissors.feedback");
    tool.handleHover(ev(50, 99));
    drawLayer(f.definitions, "curvekit.scissors.feedback");
    assert.ok(tool.feedback.hoverSegment);
  });

  test("node-to-node drag on a rectangle is rejected (adjacent) or splits", async () => {
    // opposite corners of a rectangle: valid, two triangles
    await tool.handleDrag(...drag([0, 0], [50, 50], [100, 100]));
    const contours = f.layers.Light.glyph.path.contours;
    assert.equal(contours.length, 2);
    assert.ok(contours.every((c) => c.isClosed && c.points.length === 3));
    assert.equal(f.layers.Bold.glyph.path.contours.length, 2);
  });

  test("marquee cuts a stem", async () => {
    // An "L": the marquee around the inner corner region pairs (0,0)... use a
    // shape where two nodes sit inside the rectangle
    f = fakeEditor({
      Light: [
        {
          points: [
            { x: 0, y: 0 },
            { x: 0, y: 300 },
            { x: 100, y: 300 },
            { x: 100, y: 100 },
            { x: 300, y: 100 },
            { x: 300, y: 0 },
          ],
          isClosed: true,
        },
      ],
    });
    tool = new ScissorsTool(f.editor, "/curvekit");
    tool.activate();
    await tool.handleDrag(...drag([-20, -20], [50, 50], [120, 120]));
    const contours = f.layers.Light.glyph.path.contours;
    assert.equal(contours.length, 2);
    assert.deepEqual(f.undoLabels, ["Cut stems"]);
  });

  test("node-to-node across contours: two cuts split a ring (Ø-style)", async () => {
    const counter = {
      points: [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
        { x: 200, y: 200 },
        { x: 100, y: 200 },
      ],
      isClosed: true,
    };
    f = fakeEditor({ Light: [rect(0, 0, 300, 300), counter] });
    tool = new ScissorsTool(f.editor, "/curvekit");
    tool.activate();
    // outer top-left to counter top-left: joins the contours (green feedback)
    await tool.handleDrag(...drag([0, 300], [50, 250], [100, 200]));
    assert.equal(f.layers.Light.glyph.path.contours.length, 1);
    // outer bottom-right to counter bottom-right: splits the ring in two
    await tool.handleDrag(...drag([300, 0], [250, 50], [200, 100]));
    const contours = f.layers.Light.glyph.path.contours;
    assert.equal(contours.length, 2);
    assert.ok(contours.every((c) => c.isClosed));
    assert.deepEqual(f.undoLabels, ["Split contour", "Split contour"]);
  });

  test("node-to-node between two side-by-side contours (an 'i' dot and stem) is refused", async () => {
    // the line between them crosses white space, so the contours aren't joined
    f = fakeEditor({ Light: [rect(0, 0, 100, 400), rect(0, 500, 100, 600)] });
    tool = new ScissorsTool(f.editor, "/curvekit");
    tool.activate();
    const events = drag([100, 400], [100, 450], [100, 500]);
    await tool.handleDrag(...events);
    assert.deepEqual(f.undoLabels, []);
    assert.equal(f.layers.Light.glyph.path.contours.length, 2);
  });

  test("a split removes the cut nodes left in the middle of a straight line", async () => {
    // an L, drag from the inner corner (100,100) to (100,0): a junction split
    // whose run-on edges continue the stem's and the foot's straight edges
    const l = {
      points: [[0, 0], [100, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]].map(
        ([x, y]) => ({ x, y }),
      ),
      isClosed: true,
    };
    f = fakeEditor({ Light: [l] });
    tool = new ScissorsTool(f.editor, "/curvekit");
    tool.activate();
    await tool.handleDrag(...drag([100, 100], [100, 50], [100, 0]));
    assert.deepEqual(f.undoLabels, ["Split junction"]);
    const contours = f.layers.Light.glyph.path.contours;
    assert.equal(contours.length, 2);
    for (const contour of contours) {
      const n = contour.points.length;
      contour.points.forEach((p, i) => {
        const prev = contour.points[(i - 1 + n) % n];
        const next = contour.points[(i + 1) % n];
        const mid =
          (prev.x - p.x) * (next.y - p.y) === (prev.y - p.y) * (next.x - p.x);
        assert.ok(!mid, `${p.x},${p.y} is in the middle of a straight line`);
      });
    }
  });

  test("marquee pairs nodes across contours and splits the ring", async () => {
    const counter = {
      points: [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
        { x: 200, y: 200 },
        { x: 100, y: 200 },
      ],
      isClosed: true,
    };
    f = fakeEditor({ Light: [rect(0, 0, 300, 300), counter] });
    tool = new ScissorsTool(f.editor, "/curvekit");
    tool.activate();
    // a marquee covering the left stroke: outer (0,0),(0,300); counter (100,100),(100,200)
    await tool.handleDrag(...drag([-10, -10], [50, 150], [110, 310]));
    const contours = f.layers.Light.glyph.path.contours;
    assert.equal(contours.length, 2);
    assert.ok(contours.every((c) => c.isClosed));
  });

  test("marquee around the 4 corners of a crossing splits it into two strokes", async () => {
    const plus = (scale) => ({
      points: [
        [100, 300], [200, 300], [200, 200], [300, 200], [300, 100], [200, 100],
        [200, 0], [100, 0], [100, 100], [0, 100], [0, 200], [100, 200],
      ].map(([x, y]) => ({ x: x * scale, y: y * scale })),
      isClosed: true,
    });
    f = fakeEditor({ Light: [plus(1)], Bold: [plus(2)] });
    tool = new ScissorsTool(f.editor, "/curvekit");
    tool.activate();
    const events = drag([90, 90], [150, 150], [210, 210]);
    await tool.handleDrag(...events);
    assert.deepEqual(f.undoLabels, ["Split crossing"]);
    for (const layer of Object.values(f.layers)) {
      const contours = layer.glyph.path.contours;
      assert.equal(contours.length, 2);
      // two bars; the corners left in the middle of their straight edges are
      // removed
      assert.ok(contours.every((c) => c.isClosed && c.points.length === 4));
    }
  });

  test("marquee around the 2 corners of a T splits it into bar and stem", async () => {
    const t = (scale) => ({
      points: [
        [0, 200], [0, 300], [300, 300], [300, 200], [200, 200], [200, 0], [100, 0], [100, 200],
      ].map(([x, y]) => ({ x: x * scale, y: y * scale })),
      isClosed: true,
    });
    f = fakeEditor({ Light: [t(1)], Bold: [t(2)] });
    tool = new ScissorsTool(f.editor, "/curvekit");
    tool.activate();
    await tool.handleDrag(...drag([90, 190], [150, 200], [210, 210]));
    assert.deepEqual(f.undoLabels, ["Split junction"]);
    for (const layer of Object.values(f.layers)) {
      assert.equal(layer.glyph.path.contours.length, 2);
    }
    // the bar's bottom edge runs straight across: its corners are gone
    for (const layer of Object.values(f.layers)) {
      assert.ok(
        layer.glyph.path.contours.some((c) => c.points.length === 4),
        "the bar is a plain rectangle",
      );
    }
    // the stem runs 50% into the 200-thick bar
    assert.ok(f.layers.Bold.glyph.path.contours[0].points.some((p) => p.x === 400 && p.y === 500));
  });

  test("node-to-node drag between the 2 corners of a T splits the junction like the marquee", async () => {
    const t = (scale) => ({
      points: [
        [0, 200], [0, 300], [300, 300], [300, 200], [200, 200], [200, 0], [100, 0], [100, 200],
      ].map(([x, y]) => ({ x: x * scale, y: y * scale })),
      isClosed: true,
    });
    f = fakeEditor({ Light: [t(1)], Bold: [t(2)] });
    tool = new ScissorsTool(f.editor, "/curvekit");
    tool.activate();
    // corner (100,200) to corner (200,200)
    await tool.handleDrag(...drag([100, 200], [150, 200], [200, 200]));
    assert.deepEqual(f.undoLabels, ["Split junction"]);
    for (const layer of Object.values(f.layers)) {
      assert.equal(layer.glyph.path.contours.length, 2);
    }
    assert.ok(f.layers.Bold.glyph.path.contours[0].points.some((p) => p.x === 400 && p.y === 500));
  });

  test("node-to-node drag between the 2 corners of an 'e' bar joins them like the marquee", async () => {
    const polygon = (coords) => ({ points: coords.map(([x, y]) => ({ x, y })), isClosed: true });
    f = fakeEditor({
      Light: [
        polygon([[0, 0], [0, 300], [300, 300], [300, 150], [50, 150], [50, 50], [300, 50], [300, 0]]),
        polygon([[50, 200], [250, 200], [250, 250], [50, 250]]),
      ],
    });
    tool = new ScissorsTool(f.editor, "/curvekit");
    tool.activate();
    await tool.handleDrag(...drag([50, 150], [50, 175], [50, 200]));
    assert.deepEqual(f.undoLabels, ["Split junction"]);
    const contours = f.layers.Light.glyph.path.contours;
    assert.equal(contours.length, 1);
    assert.ok(contours[0].points.some((p) => p.x === 25 && p.y === 150));
  });

  test("marquee around 2 corners on different contours (an 'e' bar) joins them", async () => {
    const polygon = (coords) => ({ points: coords.map(([x, y]) => ({ x, y })), isClosed: true });
    f = fakeEditor({
      Light: [
        polygon([[0, 0], [0, 300], [300, 300], [300, 150], [50, 150], [50, 50], [300, 50], [300, 0]]),
        polygon([[50, 200], [250, 200], [250, 250], [50, 250]]),
      ],
    });
    tool = new ScissorsTool(f.editor, "/curvekit");
    tool.activate();
    await tool.handleDrag(...drag([40, 140], [45, 170], [60, 210]));
    assert.deepEqual(f.undoLabels, ["Split junction"]);
    const contours = f.layers.Light.glyph.path.contours;
    assert.equal(contours.length, 1);
    assert.ok(contours[0].points.some((p) => p.x === 25 && p.y === 150));
  });

  test("a crossing whose edges don't continue falls back to stem cuts", async () => {
    f = fakeEditor({
      Light: [
        {
          points: [
            [100, 300], [200, 300], [200, 200], [400, 200], [400, 100], [300, 100],
            [300, 0], [200, 0], [200, 100], [0, 100], [0, 200], [100, 200],
          ].map(([x, y]) => ({ x, y })),
          isClosed: true,
        },
      ],
    });
    tool = new ScissorsTool(f.editor, "/curvekit");
    tool.activate();
    await tool.handleDrag(...drag([90, 90], [150, 150], [310, 210]));
    assert.deepEqual(f.undoLabels, ["Cut stems"]);
  });

  test("skips layers with a different structure", async () => {
    f = fakeEditor({
      Light: [rect(0, 0, 100, 100)],
      Bold: [splitSegment(rect(0, 0, 200, 200), 0, 0.5).contour],
    });
    tool = new ScissorsTool(f.editor, "/curvekit");
    tool.activate();
    await tool.handleDrag(...click(0, 100));
    assert.equal(f.layers.Light.glyph.path.contours[0].isClosed, false);
    assert.equal(f.layers.Bold.glyph.path.contours[0].isClosed, true);
  });
});

describe("MatchmakerTool", () => {
  let f;
  let tool;
  beforeEach(() => {
    f = fakeEditor({
      Light: [rect(0, 0, 100, 100)],
      Bold: [splitSegment(rect(0, 0, 200, 200), 2, 0.5).contour], // extra node on right edge
    });
    tool = new MatchmakerTool(f.editor, "/curvekit");
    tool.activate();
    tool.viewVector = { x: 1000, y: 0 }; // Bold drawn 1000 units to the right
  });

  test("reports incompatibility and draws the schematic", () => {
    const report = tool.getReport();
    assert.equal(report.compatible, false);
    drawLayer(f.definitions, "curvekit.matchmaker.schematic");
  });

  test("free-hand lasso, closed back to its start, selects the blue group", async () => {
    // a thin band from Light's top-right (100,100) to Bold's top-right
    // (1200,200); never closed by the pointer, the straight line from the last
    // point back to the start closes it. Bold's (1200,100) is inside the
    // band's bounding box but outside the lasso, and so is Bold's (1000,200).
    await tool.handleDrag(
      ...drag([80, 120], [80, 120], [120, 120], [1190, 215], [1220, 215], [1220, 185], [80, 80]),
    );
    const boldPoints = f.layers.Bold.glyph.path.contours[0].points;
    const pointIndex = (points, x, y) =>
      points.findIndex((p) => p.x === x && p.y === y);
    assert.deepEqual(tool.blueGroup.get(0), {
      contourIndex: 0,
      pointIndex: pointIndex(f.layers.Light.glyph.path.contours[0].points, 100, 100),
    });
    assert.deepEqual(tool.blueGroup.get(1), {
      contourIndex: 0,
      pointIndex: pointIndex(boldPoints, 200, 200),
    });
    assert.equal(tool.activeGroup, "orange");
    assert.deepEqual(tool.feedback, {}, "the lasso is gone after the drag");
  });

  test("a lasso drawn as a line selects nothing", async () => {
    await tool.handleDrag(...drag([90, 90], [90, 90], [1210, 210]));
    assert.equal(tool.blueGroup.size, 0);
    assert.equal(tool.activeGroup, "blue");
  });

  test("blue/orange groups, then click, match the segment", async () => {
    // blue: top-right corners of both masters
    await tool.handleDrag(...drag([90, 90], [1210, 210]));
    // the lasso picks per master the node closest to its center; use clicks
    // to be precise instead
    tool.clearGroups();
    await tool.handleDrag(...click(100, 100)); // Light top-right -> blue
    await tool.handleDrag(...click(1200, 200)); // Bold top-right -> blue, switch
    assert.equal(tool.activeGroup, "orange");
    await tool.handleDrag(...click(100, 0)); // Light bottom-right -> orange
    await tool.handleDrag(...click(1200, 0)); // Bold bottom-right -> orange
    assert.ok(tool.getMatchableRun(tool.getMasters()));
    drawLayer(f.definitions, "curvekit.matchmaker.schematic");
    await tool.handleDrag(...click(100, 100)); // click a group node: match
    assert.deepEqual(f.undoLabels, ["Match segment"]);
    const [light] = f.layers.Light.glyph.path.contours;
    const [bold] = f.layers.Bold.glyph.path.contours;
    assert.equal(contourSignature(light), contourSignature(bold));
    assert.equal(tool.getReport().compatible, true);
  });

  test("Match segment moves the contour to its position in the selected master", async () => {
    // the segment's contour is contour 0 in Light but contour 1 in Bold
    const square = rect(0, 0, 100, 100);
    const other = rect(300, 0, 400, 100);
    const boldSquare = splitSegment(rect(0, 0, 100, 100), 2, 0.5).contour; // extra node
    f = fakeEditor({
      Light: [square, other],
      Bold: [rect(300, 0, 400, 100), boldSquare],
    });
    tool = new MatchmakerTool(f.editor, "/curvekit");
    tool.activate();
    tool.viewVector = { x: 1000, y: 0 };
    await tool.handleDrag(...click(100, 100)); // blue: top-right corners
    await tool.handleDrag(...click(1100, 100));
    await tool.handleDrag(...click(100, 0)); // orange: bottom-right corners
    await tool.handleDrag(...click(1100, 0));
    assert.ok(tool.getMatchableRun(tool.getVisibleMasters()));
    await tool.matchSelectedSegment();
    assert.deepEqual(f.undoLabels, ["Match segment"]);
    const light = f.layers.Light.glyph.path.contours;
    const bold = f.layers.Bold.glyph.path.contours;
    assert.equal(bold[0].points.length, 5, "the matched square is first in Bold too");
    assert.deepEqual(bold[1], other, "the other contour moved down, untouched");
    assert.equal(contourSignature(light[0]), contourSignature(bold[0]));
    assert.match(tool.message, /Moved the contour to position 0 in 1 master/);
    assert.equal(tool.getReport().compatible, true);

    // with Bold selected, Light's contour moves instead
    f = fakeEditor({
      Light: [square, other],
      Bold: [rect(300, 0, 400, 100), boldSquare],
    });
    tool = new MatchmakerTool(f.editor, "/curvekit");
    tool.activate();
    tool.viewVector = { x: 1000, y: 0 };
    await tool.selectMaster("Bold");
    await tool.handleDrag(...click(100, 100));
    await tool.handleDrag(...click(1100, 100));
    await tool.handleDrag(...click(100, 0));
    await tool.handleDrag(...click(1100, 0));
    await tool.matchSelectedSegment();
    assert.deepEqual(f.layers.Light.glyph.path.contours[0].points, other.points);
    assert.equal(f.layers.Light.glyph.path.contours[1].points.length, 5);
    assert.match(tool.message, /Moved the contour to position 1 in 1 master/);
  });

  test("Match segment aligns the start points relative to the blue nodes", async () => {
    // Bold starts at its extra node (right edge) instead of the bottom-left
    const boldContour = f.layers.Bold.glyph.path.contours[0];
    f.layers.Bold.glyph.path.contours[0] = setContourStartPoint(boldContour, 3);
    await tool.handleDrag(...click(100, 100)); // blue: top-right corners
    await tool.handleDrag(...click(1200, 200));
    await tool.handleDrag(...click(100, 0)); // orange: bottom-right corners
    await tool.handleDrag(...click(1200, 0));
    await tool.matchSelectedSegment();
    const [bold] = f.layers.Bold.glyph.path.contours;
    assert.deepEqual(bold.points[0], { x: 0, y: 0 }, "starts at the bottom-left, like Light");
    assert.equal(tool.getReport().compatible, true);
  });

  test("Align start points uses the selected master as the reference", async () => {
    f = fakeEditor({
      Light: [rect(0, 0, 100, 100)],
      Bold: [setContourStartPoint(rect(0, 0, 200, 200), 2)], // starts top-right
    });
    tool = new MatchmakerTool(f.editor, "/curvekit");
    tool.activate();
    tool.viewVector = { x: 1000, y: 0 };
    assert.equal(tool.canAlignStartPoints(), false, "no group yet");
    await tool.handleDrag(...click(0, 100)); // top-left corners
    await tool.handleDrag(...click(1000, 200));
    assert.equal(tool.canAlignStartPoints(), true);
    await tool.selectMaster("Bold");
    await tool.alignStartPointsToGroup();
    assert.deepEqual(f.undoLabels, ["Align start points"]);
    assert.deepEqual(f.layers.Light.glyph.path.contours[0].points[0], { x: 100, y: 100 });
    assert.deepEqual(f.layers.Bold.glyph.path.contours[0].points[0], { x: 200, y: 200 });
    assert.match(tool.message, /aligned in 1 master/);
    assert.equal(tool.blueGroup.size, 0);
  });

  test("Force match masters reorders, reverses and aligns before matching", async () => {
    // Bold: contours swapped, the counter reversed, the outer contour's start
    // moved to another corner, and an extra node on the counter
    const outerLight = rect(0, 0, 100, 100);
    const counterLight = {
      points: [...rect(30, 30, 70, 70).points].reverse(),
      isClosed: true,
    };
    const outerBold = setContourStartPoint(rect(0, 0, 200, 100), 2);
    const counterBold = splitSegment(rect(50, 25, 150, 75), 0, 0.5).contour; // runs clockwise
    f = fakeEditor({
      Light: [outerLight, counterLight],
      Bold: [counterBold, outerBold],
    });
    tool = new MatchmakerTool(f.editor, "/curvekit");
    tool.activate();
    await tool.matchAllMasters();
    assert.deepEqual(f.undoLabels, ["Match masters"]);
    const bold = f.layers.Bold.glyph.path.contours;
    assert.deepEqual(bold[0].points[0], { x: 0, y: 0 }, "outer first, from its bottom-left");
    assert.ok(bold[1].points.every((p) => p.x >= 50 && p.x <= 150), "the counter second");
    assert.equal(tool.getReport().compatible, true);
    assert.match(tool.message, /Reordered contours in 1 master/);
    assert.match(tool.message, /Reversed 1 contour/);
    assert.match(tool.message, /Aligned starts in/);
    assert.match(tool.message, /Matched 1 contour/);
    // Light, the reference, is untouched
    assert.deepEqual(f.layers.Light.glyph.path.contours[0].points, outerLight.points);
  });

  test("Force match masters reverses a master drawn the other way", async () => {
    const reversed = (c) => ({ points: [...c.points].reverse(), isClosed: true });
    f = fakeEditor({
      Light: [rect(0, 0, 100, 100), reversed(rect(30, 30, 70, 70))],
      Bold: [reversed(rect(0, 0, 200, 100)), rect(50, 25, 150, 75)],
    });
    tool = new MatchmakerTool(f.editor, "/curvekit");
    tool.activate();
    await tool.matchAllMasters();
    assert.match(tool.message, /Reversed all contours in 1 master/);
    assert.doesNotMatch(tool.message, /Reversed \d+ contour/, "no per-contour reversal left");
    assert.equal(tool.getReport().compatible, true);
  });

  test("Reorder contours only reorders", async () => {
    const counter = splitSegment(rect(50, 25, 150, 75), 0, 0.5).contour;
    const outer = setContourStartPoint(rect(0, 0, 200, 100), 2);
    f = fakeEditor({
      Light: [rect(0, 0, 100, 100), rect(30, 30, 70, 70)],
      Bold: [counter, outer],
    });
    tool = new MatchmakerTool(f.editor, "/curvekit");
    tool.activate();
    assert.equal(tool.canReorderContours(), true);
    await tool.reorderAllContours();
    assert.deepEqual(f.undoLabels, ["Reorder contours"]);
    const bold = f.layers.Bold.glyph.path.contours;
    // same contours, untouched (start point, direction, nodes), swapped back
    assert.deepEqual(bold, [outer, counter]);
    assert.match(tool.message, /Reordered contours in 1 master/);
    await tool.reorderAllContours();
    assert.equal(f.undoLabels.length, 1, "nothing left to do");
    assert.match(tool.message, /already in the same order/);
  });

  test("Reorder contours needs the same contour count everywhere", () => {
    f = fakeEditor({
      Light: [rect(0, 0, 100, 100), rect(30, 30, 70, 70)],
      Bold: [rect(0, 0, 200, 100)],
    });
    tool = new MatchmakerTool(f.editor, "/curvekit");
    assert.equal(tool.canReorderContours(), false);
  });

  test("Force match masters needs the same contour count everywhere", async () => {
    f = fakeEditor({
      Light: [rect(0, 0, 100, 100), rect(30, 30, 70, 70)],
      Bold: [setContourStartPoint(rect(0, 0, 200, 100), 2)],
    });
    tool = new MatchmakerTool(f.editor, "/curvekit");
    tool.activate();
    assert.equal(tool.canMatchAllMasters(), false);
    await tool.matchAllMasters();
    assert.deepEqual(f.undoLabels, [], "no edit");
  });

  test("Match Masters fixes the glyph automatically", async () => {
    await tool.matchAllMasters();
    assert.equal(tool.getReport().compatible, true);
    assert.match(tool.message, /Matched 1 contour/);
  });

  test("dragging the handle changes the view angle", async () => {
    tool.viewVector = { x: 60, y: 60 };
    await tool.handleDrag(...drag([60, 60], [80, 40], [100, 20]));
    assert.deepEqual(tool.viewVector, { x: 100, y: 20 });
  });

  test("hidden masters leave the schematic view, groups and segment matching", async () => {
    await tool.handleDrag(...click(100, 100)); // Light top-right -> blue
    tool.setLayerVisible("Light", false);
    assert.equal(tool.blueGroup.size, 0, "groups refer to visible positions: cleared");
    assert.deepEqual(tool.getVisibleMasters().map((m) => m.name), ["Bold"]);
    assert.equal(tool.getMasters().length, 2, "the report still uses all masters");
    assert.equal(tool.getReport().compatible, false);
    // Bold is now the only shown master, at the origin, keeping its color
    const [bold] = tool.getVisibleMasters();
    assert.equal(bold.colorIndex, 1);
    assert.deepEqual(tool.masterTransform([bold], 0)({ x: 10, y: 20 }), { x: 10, y: 20 });
    drawLayer(f.definitions, "curvekit.matchmaker.schematic");
    // clicking where Light's node was now hits nothing of Light
    await tool.handleDrag(...click(100, 100));
    assert.equal(tool.blueGroup.size, 0);
    tool.setLayerVisible("Light", true);
    assert.equal(tool.getVisibleMasters().length, 2);
  });

  test("contours can be reordered per master (undoable edit)", async () => {
    f = fakeEditor({
      Light: [rect(0, 0, 100, 100), rect(200, 0, 250, 50)],
      Bold: [rect(200, 0, 300, 100), rect(0, 0, 200, 200)], // order swapped
    });
    tool = new MatchmakerTool(f.editor, "/curvekit");
    tool.activate();
    // both are rects, so signatures match regardless: check positions instead
    await tool.moveContour("Bold", 1, 0);
    const bold = f.layers.Bold.glyph.path.contours;
    assert.deepEqual(bold[0].points[2], { x: 200, y: 200 });
    assert.deepEqual(bold[1].points[0], { x: 200, y: 0 });
    assert.deepEqual(f.undoLabels, ["Reorder contours"]);
    // Light untouched
    assert.deepEqual(f.layers.Light.glyph.path.contours[0].points[2], { x: 100, y: 100 });
    // out of range moves are ignored
    await tool.moveContour("Bold", 0, 5);
    assert.equal(f.undoLabels.length, 1);
  });

  test("right-click on a schematic node sets the start point in that master only", async () => {
    // Bold's node at (200, 200) is its contour point 3 (after the inserted node)
    const items = f.editor.buildContextMenuItems({ gx: 1200, gy: 200 });
    assert.equal(items.length, 1);
    assert.match(items[0].title, /^Set Start Point \(Bold, contour 0\)/);
    assert.equal(items[0].enabled(), true);
    await items[0].callback();
    assert.deepEqual(f.layers.Bold.glyph.path.contours[0].points[0], { x: 200, y: 200 });
    assert.deepEqual(f.layers.Light.glyph.path.contours[0].points[0], { x: 0, y: 0 });
    assert.deepEqual(f.undoLabels, ["Set Start Point"]);
    // the current start point is checked and can't be set again
    const again = f.editor.buildContextMenuItems({ gx: 1200, gy: 200 });
    assert.equal(again[0].checked, true);
    assert.equal(again[0].enabled(), false);
  });

  test("right-click elsewhere, or with the tool inactive, gives Fontra's menu", () => {
    assert.deepEqual(f.editor.buildContextMenuItems({ gx: 600, gy: 600 }), [
      "fontra's own menu",
    ]);
    tool.deactivate();
    assert.deepEqual(f.editor.buildContextMenuItems({ gx: 1200, gy: 200 }), [
      "fontra's own menu",
    ]);
  });

  test("the red incompatibility halo can be turned off", () => {
    let recorder = recordingContext();
    const parameters = drawLayer(f.definitions, "curvekit.matchmaker.schematic", recorder.context);
    assert.ok(recorder.strokes.some((s) => s.style === parameters.errorHaloColor));
    tool.setShowIncompatible(false);
    recorder = recordingContext();
    drawLayer(f.definitions, "curvekit.matchmaker.schematic", recorder.context);
    assert.ok(!recorder.strokes.some((s) => s.style === parameters.errorHaloColor));
  });

  test("hovered contour is highlighted in one master, or in all with the option", () => {
    const thick = (recorder) => recorder.strokes.filter((s) => s.width === 3).length;
    tool.setHighlightedContour("Light", 0);
    let recorder = recordingContext();
    drawLayer(f.definitions, "curvekit.matchmaker.schematic", recorder.context);
    assert.equal(thick(recorder), 1);
    tool.setHighlightAllMasters(true);
    recorder = recordingContext();
    drawLayer(f.definitions, "curvekit.matchmaker.schematic", recorder.context);
    assert.equal(thick(recorder), 2);
  });

  test("selecting a master selects its glyph source in the editor", async () => {
    assert.equal(tool.getSelectedLayerName(), "Light"); // default: first master
    await tool.selectMaster("Bold");
    assert.equal(tool.selectedLayerName, "Bold");
    assert.deepEqual(f.sceneSettings.glyphLocation, { wght: 100 });
    assert.equal(f.sceneSettings.editLayerName, "Bold");
  });

  test("selecting a glyph source in the editor selects the master", async () => {
    f.setSceneSetting("glyphLocation", { wght: 100 }); // e.g. clicked in the sources panel
    await new Promise((resolve) => setTimeout(resolve));
    assert.equal(tool.selectedLayerName, "Bold");
    // an interpolated location keeps the current selection
    f.setSceneSetting("glyphLocation", { wght: 50 });
    await new Promise((resolve) => setTimeout(resolve));
    assert.equal(tool.selectedLayerName, "Bold");
    f.setSceneSetting("glyphLocation", { wght: 0 });
    await new Promise((resolve) => setTimeout(resolve));
    assert.equal(tool.selectedLayerName, "Light");
  });

  test("hovering a contour row highlights it in the schematic", () => {
    tool.setHighlightedContour("Bold", 0);
    assert.deepEqual(tool.highlightedContour, { layerName: "Bold", contourIndex: 0 });
    drawLayer(f.definitions, "curvekit.matchmaker.schematic");
    tool.setHighlightedContour(undefined);
    assert.equal(tool.highlightedContour, undefined);
  });

  test("Escape clears the groups", async () => {
    await tool.handleDrag(...click(100, 100));
    tool.handleKeyDown({ key: "Escape" });
    assert.equal(tool.blueGroup.size, 0);
  });
});

describe("CurvePointTool", () => {
  let f;
  let cubic;
  let quad;
  const anchorsOf = (contour) => contour.points.filter((p) => !p.type).map((p) => [p.x, p.y]);
  beforeEach(() => {
    f = fakeEditor({
      Light: [rect(0, 0, 100, 100)],
      Bold: [rect(0, 0, 200, 200)],
    });
    f.editor.addEditTool(createCurvePointTool(f.editor, "/curvekit"));
    cubic = f.editor.tools["curvekit-curve-point-tool-cubic"];
    quad = f.editor.tools["curvekit-curve-point-tool-quad"];
    cubic.activate();
  });

  test("a multi-tool with a cubic and a quadratic mode", () => {
    assert.equal(f.editor.tools["curvekit-curve-point-tool"].subTools.length, 2);
    assert.match(cubic.iconPath, /curve-point.svg$/);
    assert.match(quad.iconPath, /curve-point-quad.svg$/);
    assert.ok(f.definitions.some((d) => d.identifier === "curvekit.curve-point.feedback"));
  });

  test("clicking a line adds straight handles in every layer", async () => {
    await cubic.handleDrag(...click(0, 50)); // left edge (0,0)-(0,100) of Light
    assert.deepEqual(f.undoLabels, ["Add handles"]);
    const light = f.layers.Light.glyph.path.contours[0].points;
    assert.deepEqual(light.slice(0, 4), [
      { x: 0, y: 0 },
      { x: 0, y: 33, type: "cubic" },
      { x: 0, y: 67, type: "cubic" },
      { x: 0, y: 100 },
    ]);
    // Bold's own line (0,0)-(0,200)
    const bold = f.layers.Bold.glyph.path.contours[0].points;
    assert.deepEqual(bold.slice(1, 3).map((p) => [p.x, p.y]), [[0, 67], [0, 133]]);
  });

  test("clicking a line in quadratic mode adds two quadratic off-curve points", async () => {
    quad.activate();
    await quad.handleDrag(...click(0, 50));
    const light = f.layers.Light.glyph.path.contours[0].points;
    assert.deepEqual(light.slice(1, 3).map((p) => p.type), ["quad", "quad"]);
    assert.equal(light.length, 6);
  });

  test("Shift-clicking a curve turns it back into a plain line", async () => {
    await cubic.handleDrag(...click(0, 50)); // add straight handles first
    await cubic.handleDrag(stream(), { ...ev(0, 50), pageX: 0, shiftKey: true });
    assert.deepEqual(f.undoLabels, ["Add handles", "Straighten segment"]);
    for (const layer of Object.values(f.layers)) {
      const [contour] = layer.glyph.path.contours;
      assert.equal(contour.points.length, 4);
      assert.ok(contour.points.every((p) => !p.type));
    }
    // Shift-clicking a line does nothing
    await cubic.handleDrag(stream(), { ...ev(0, 50), pageX: 0, shiftKey: true });
    assert.equal(f.undoLabels.length, 2);
  });

  test("dragging a line bends it in every layer, live and as one undo step", async () => {
    // left edge (0,0)-(0,100) of Light; grab the middle, drag 30 to the left
    await cubic.handleDrag(...drag([0, 50], [-10, 50], [-20, 50], [-30, 50]));
    for (const [name, layer] of Object.entries(f.layers)) {
      const [contour] = layer.glyph.path.contours;
      assert.equal(contour.points.length, 6, name);
      assert.deepEqual(contour.points.slice(1, 3).map((p) => p.type), ["cubic", "cubic"]);
    }
    assert.deepEqual(
      anchorsOf(f.layers.Light.glyph.path.contours[0]),
      anchorsOf(rect(0, 0, 100, 100))
    );
    assert.deepEqual(
      anchorsOf(f.layers.Bold.glyph.path.contours[0]),
      anchorsOf(rect(0, 0, 200, 200))
    );
    assert.ok(f.incrementalChanges.length >= 2, "sent while dragging");
    assert.deepEqual(f.undoLabels, ["Bend segment"]);
    const { changes } = f.editResults[0];
    assert.equal(changes.change.c.length, 2);
    assert.deepEqual(changes.change.c[0].p, ["layers", "Light", "glyph", "path"]);
    assert.deepEqual(
      changes.rollbackChange.c[0].c.map((c) => c.f),
      ["deleteContour", "insertContour"]
    );
    // the rollback puts back the original contour
    assert.deepEqual(changes.rollbackChange.c[0].c[1].a[1].packed, rect(0, 0, 100, 100));
  });

  test("the quadratic mode makes a quadratic curve", async () => {
    cubic.deactivate();
    quad.activate();
    await quad.handleDrag(...drag([0, 50], [-10, 50], [-30, 50]));
    const [contour] = f.layers.Light.glyph.path.contours;
    assert.equal(contour.points.length, 5);
    assert.equal(contour.points[1].type, "quad");
  });

  test("click a corner: smooth; click again: corner. Anchors don't move", async () => {
    await cubic.handleDrag(...click(0, 100));
    let [contour] = f.layers.Light.glyph.path.contours;
    const smooth = contour.points.find((p) => p.x === 0 && p.y === 100);
    assert.ok(smooth.smooth);
    assert.deepEqual(anchorsOf(contour), anchorsOf(rect(0, 0, 100, 100)));
    assert.ok(f.layers.Bold.glyph.path.contours[0].points.some((p) => p.smooth));
    await cubic.handleDrag(...click(0, 100));
    [contour] = f.layers.Light.glyph.path.contours;
    assert.ok(!contour.points.some((p) => p.smooth));
    assert.deepEqual(anchorsOf(contour), anchorsOf(rect(0, 0, 100, 100)));
    assert.deepEqual(f.undoLabels, ["Convert to smooth", "Convert to corner"]);
  });

  test("dragging an anchor pulls out handles", async () => {
    await cubic.handleDrag(...drag([0, 100], [10, 100], [40, 100]));
    const [contour] = f.layers.Light.glyph.path.contours;
    const i = contour.points.findIndex((p) => p.x === 0 && p.y === 100 && !p.type);
    assert.ok(contour.points[i].smooth);
    assert.deepEqual(contour.points[i + 1], { x: 40, y: 100, type: "cubic" });
    assert.deepEqual(contour.points[i - 1], { x: -40, y: 100, type: "cubic" });
    assert.deepEqual(f.undoLabels, ["Pull out handles"]);
  });

  test("shift-click on a handle turns its segment back into a line", async () => {
    await cubic.handleDrag(...drag([0, 50], [-10, 50], [-30, 50])); // bend the left edge
    let [contour] = f.layers.Light.glyph.path.contours;
    const handle = contour.points.find((p) => p.type);
    await cubic.handleDrag(stream(), { ...ev(handle.x, handle.y), pageX: 0, shiftKey: true });
    for (const [name, layer] of Object.entries(f.layers)) {
      [contour] = layer.glyph.path.contours;
      assert.equal(contour.points.length, 4, name);
      assert.ok(contour.points.every((p) => !p.type && !p.smooth), name);
    }
    assert.deepEqual(f.undoLabels, ["Bend segment", "Straighten segment"]);
  });

  test("a plain click on a handle changes nothing", async () => {
    await cubic.handleDrag(...drag([0, 50], [-10, 50], [-30, 50]));
    const handle = f.layers.Light.glyph.path.contours[0].points.find((p) => p.type);
    await cubic.handleDrag(...click(handle.x, handle.y));
    assert.equal(f.layers.Light.glyph.path.contours[0].points.length, 6);
    assert.deepEqual(f.undoLabels, ["Bend segment"]);
  });

  test("the title is the tool name only, like Fontra's tools", () => {
    assert.equal(cubic.title, "Curve Point Tool (cubic)");
    assert.equal(quad.title, "Curve Point Tool (quadratic)");
  });

  test("dragging a handle moves it alone", async () => {
    await cubic.handleDrag(...drag([0, 100], [10, 100], [40, 100])); // make handles first
    await cubic.handleDrag(...drag([40, 100], [40, 120], [40, 130]));
    const [contour] = f.layers.Light.glyph.path.contours;
    const i = contour.points.findIndex((p) => p.x === 0 && p.y === 100 && !p.type);
    assert.deepEqual(contour.points[i + 1], { x: 40, y: 130, type: "cubic" });
    assert.deepEqual(contour.points[i - 1], { x: -40, y: 100, type: "cubic" });
    assert.ok(!contour.points[i].smooth);
    assert.deepEqual(f.undoLabels, ["Pull out handles", "Move handle"]);
  });

  test("hover feedback draws without errors", () => {
    cubic.handleHover(ev(0, 50));
    assert.equal(cubic.feedback.hover.kind, "segment");
    drawLayer(f.definitions, "curvekit.curve-point.feedback");
    cubic.handleHover(ev(0, 100));
    assert.equal(cubic.feedback.hover.kind, "anchor");
    drawLayer(f.definitions, "curvekit.curve-point.feedback");
  });

  test("skips layers with a different structure", async () => {
    f.layers.Bold.glyph.path = new FakePath([rect(0, 0, 200, 200), rect(0, 0, 10, 10)]);
    await cubic.handleDrag(...drag([0, 50], [-10, 50], [-30, 50]));
    assert.equal(f.layers.Light.glyph.path.contours[0].points.length, 6);
    assert.equal(f.layers.Bold.glyph.path.contours[0].points.length, 4);
  });
});

describe("init", () => {
  test("adds both tools and the Matchmaker panel", () => {
    const f = fakeEditor({ Light: [rect(0, 0, 100, 100)] });
    init(f.editor, "/curvekit");
    assert.ok(f.editor.tools["curvekit-scissors-tool"]);
    assert.ok(f.editor.tools["curvekit-matchmaker-tool"]);
    assert.ok(f.editor.tools["curvekit-curve-point-tool"]);
    assert.equal(f.editor.tools["curvekit-curve-point-tool-cubic"].curveType, "cubic");
    assert.equal(f.editor.tools["curvekit-curve-point-tool-quad"].curveType, "quad");
    assert.equal(f.editor.panels.length, 1);
    assert.equal(f.editor.panels[0][0].identifier, "curvekit-matchmaker");
    assert.equal(f.editor.panels[0][1], "right");
  });

  test("the panel lists masters with eye toggles and the contours of one master", async () => {
    const f = fakeEditor({
      Light: [rect(0, 0, 100, 100), rect(200, 0, 250, 50)],
      Bold: [rect(0, 0, 200, 200)],
    });
    init(f.editor, "/curvekit");
    const panel = f.editor.panels[0][0];
    const tool = f.editor.tools["curvekit-matchmaker-tool"];
    panel.refresh();
    const masterRows = () => panel.elements.masterList.children;
    const contourRows = () => panel.elements.contourList.children;
    assert.deepEqual(masterRows().map((row) => row.children[2].textContent), ["Light", "Bold"]);
    // Light's contours listed: contour 0 matches Bold's contour 0, contour 1 has no partner
    assert.equal(contourRows().length, 2);
    assert.deepEqual(contourRows().map((row) => row.children[3].textContent), ["✓", "✗"]);
    // the eye button hides a master
    masterRows()[1].children[0].onclick({ stopPropagation() {} });
    assert.equal(tool.isLayerVisible("Bold"), false);
    // with no other shown master there is nothing to compare against
    assert.deepEqual(contourRows().map((row) => row.children[3].textContent), ["", ""]);
    // clicking a master row lists its contours and selects that source
    masterRows()[1].onclick();
    assert.equal(contourRows().length, 1);
    await new Promise((resolve) => setTimeout(resolve));
    assert.equal(f.sceneSettings.editLayerName, "Bold");
    // the down button reorders contours
    masterRows()[0].onclick();
    contourRows()[0].children[5].onclick({ stopPropagation() {} });
    await new Promise((resolve) => setTimeout(resolve));
    assert.deepEqual(f.layers.Light.glyph.path.contours[0].points[0], { x: 200, y: 0 });
  });
});
