// Helpers that talk to Fontra's editor objects. Plug-ins can't import Fontra's
// modules, so the few bits we need (tool base behavior, drag detection, drawing
// helpers, visualization layer registration) are re-implemented here.

import { range } from "./contour-ops.js";

export class PluginTool {
  constructor(editor, pluginPath) {
    this.editor = editor;
    this.pluginPath = pluginPath;
    this.canvasController = editor.canvasController;
    this.sceneController = editor.sceneController;
    this.sceneModel = this.sceneController.sceneModel;
    this.sceneSettingsController = editor.sceneSettingsController;
    this.sceneSettings = editor.sceneSettings;
    this.isActive = false;
  }

  get isEditingGlyph() {
    return !!this.sceneModel.selectedGlyph?.isEditing;
  }

  get pointerTool() {
    return this.editor.tools["pointer-tool"];
  }

  setCursor(cursor = "crosshair") {
    this.canvasController.canvas.style.cursor = this.isEditingGlyph ? cursor : "default";
  }

  activate() {
    this.isActive = true;
    this.setCursor();
    this.canvasController.requestUpdate();
  }

  deactivate() {
    this.isActive = false;
    this.canvasController.requestUpdate();
  }

  handleKeyDown(event) {
    //
  }

  getContextMenuItems() {
    return [];
  }

  // Event position in the selected glyph's coordinate system
  glyphPoint(event) {
    return this.sceneController.selectedGlyphPoint(event);
  }

  get clickMargin() {
    return this.sceneController.mouseClickMargin;
  }

  get onePixelUnit() {
    return this.sceneController.onePixelUnit;
  }

  // The interpolated (displayed) glyph instance's contours, unpacked
  getInstanceContours() {
    const path = this.sceneModel.getSelectedPositionedGlyph()?.glyph?.path;
    return path ? unpackContours(path) : [];
  }
}

export function unpackContours(path) {
  return range(0, path.numContours).map((i) => path.getUnpackedContour(i));
}

// Replace all contours of a VarPackedPath
export function setAllContours(path, contours) {
  for (let i = path.numContours - 1; i >= 0; i--) {
    path.deleteContour(i);
  }
  for (const contour of contours) {
    path.appendUnpackedContour(contour);
  }
}

const MINIMUM_DRAG_DISTANCE = 2;

export async function shouldInitiateDrag(eventStream, initialEvent) {
  // drop events until the pointer moved a minimal distance
  const initialX = initialEvent.pageX;
  const initialY = initialEvent.pageY;
  for await (const event of eventStream) {
    if (
      Math.abs(initialX - event.pageX) > MINIMUM_DRAG_DISTANCE ||
      Math.abs(initialY - event.pageY) > MINIMUM_DRAG_DISTANCE
    ) {
      return true;
    }
  }
  return false;
}

export function registerVisualizationLayer(editor, layerDef) {
  const layers = editor.visualizationLayers;
  const definitions = layers.definitions;
  let index = definitions.findIndex((def) => layerDef.zIndex < def.zIndex);
  if (index < 0) {
    index = definitions.length;
  }
  definitions.splice(index, 0, layerDef);
  // visible layer ids are only computed at construction time, add ours
  layers.toggle(layerDef.identifier, true);
}

// Layer selection function: the glyph currently being edited
export function editingGlyphSelector(visContext) {
  return visContext.glyphsBySelectionMode.editing || [];
}

// Tool buttons get their title from Fontra's translations, which plug-ins can't
// extend, so set it after the fact.
export function setToolButtonTitle(identifier, title) {
  // a tool's own button, or a sub-tool's button in a multi-tool (like the pen tool)
  const button = document.querySelector(
    `.tool-button[data-tool="${identifier}"], .subtool-button[data-tool="${identifier}"]`
  );
  if (button) {
    button.title = title;
  }
}

export function strokeLine(context, a, b) {
  context.beginPath();
  context.moveTo(a.x, a.y);
  context.lineTo(b.x, b.y);
  context.stroke();
}

export function fillRoundNode(context, pt, nodeSize) {
  context.beginPath();
  context.arc(pt.x, pt.y, nodeSize / 2, 0, 2 * Math.PI, false);
  context.fill();
}

export function strokeRoundNode(context, pt, nodeSize) {
  context.beginPath();
  context.arc(pt.x, pt.y, nodeSize / 2, 0, 2 * Math.PI, false);
  context.stroke();
}

export function rectFromPoints(a, b) {
  return {
    xMin: Math.min(a.x, b.x),
    yMin: Math.min(a.y, b.y),
    xMax: Math.max(a.x, b.x),
    yMax: Math.max(a.y, b.y),
  };
}

export function pointInRect(p, rect) {
  return p.x >= rect.xMin && p.x <= rect.xMax && p.y >= rect.yMin && p.y <= rect.yMax;
}

// Append unpacked contours to a canvas path, with an optional point transform
export function addContoursToPath2D(path2d, contours, transform = (p) => p) {
  for (const contour of contours) {
    const pts = contour.points;
    const firstOn = pts.findIndex((p) => !p.type);
    if (firstOn < 0) {
      continue;
    }
    // Closed: rotate to start at an on-curve point and return to it.
    const order = contour.isClosed
      ? [...pts.slice(firstOn), ...pts.slice(0, firstOn + 1)]
      : pts.slice(firstOn);
    const start = transform(order[0]);
    path2d.moveTo(start.x, start.y);
    let offs = [];
    for (const point of order.slice(1)) {
      if (point.type) {
        offs.push(point);
        continue;
      }
      drawSegment(path2d, offs, point, transform);
      offs = [];
    }
    if (offs.length) {
      // trailing off-curves of an open contour: just draw to them
      for (const off of offs) {
        const p = transform(off);
        path2d.lineTo(p.x, p.y);
      }
    }
    if (contour.isClosed) {
      path2d.closePath();
    }
  }
}

function drawSegment(path2d, offs, end, transform) {
  const e = transform(end);
  if (!offs.length) {
    path2d.lineTo(e.x, e.y);
  } else if (offs[0].type === "cubic" && offs.length === 2) {
    const [a, b] = offs.map(transform);
    path2d.bezierCurveTo(a.x, a.y, b.x, b.y, e.x, e.y);
  } else if (offs[0].type === "quad") {
    const t = offs.map(transform);
    for (let i = 0; i < t.length; i++) {
      const target =
        i === t.length - 1
          ? e
          : { x: (t[i].x + t[i + 1].x) / 2, y: (t[i].y + t[i + 1].y) / 2 };
      path2d.quadraticCurveTo(t[i].x, t[i].y, target.x, target.y);
    }
  } else {
    for (const off of offs.map(transform)) {
      path2d.lineTo(off.x, off.y);
    }
    path2d.lineTo(e.x, e.y);
  }
}
