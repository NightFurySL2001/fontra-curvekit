// Curve Point tool:
//
// - Drag a segment (line or curve): it bends so the grabbed spot follows the
//   pointer. A line becomes a curve.
// - Click a line: it gets straight handles, lying on the line at 1/3 and 2/3
//   (two cubic handles, or two quadratic off-curve points in quadratic mode).
//   It still looks straight, ready to be shaped.
// - Drag an anchor: pull out symmetric handles; the anchor becomes smooth.
// - Click an anchor: a smooth anchor becomes a corner (its handles retract), a
//   corner becomes smooth (its handles line up).
// - Drag a handle: move it on its own; its anchor becomes a corner.
// - Shift-click a handle or a curve: remove the handles of the segment, which
//   becomes a straight line.
//
// Anchors never move. Like the pen tool there are two modes, cubic and
// quadratic, for the curves made out of lines.
//
// Drags edit live: the change is shown while dragging and is one undo step.
// Edits apply to all layers being edited whose contours have the same
// structure as the displayed glyph.

import {
  addStraightHandles,
  bendSegment,
  makeSmooth,
  moveHandle,
  pullHandles,
  retractHandles,
  straightenSegment,
  straightenSegmentAt,
} from "./anchor-ops.js";
import {
  contourSignature,
  distance,
  getSegments,
  isOnCurve,
  nearestSegmentPoint,
  segmentPoints,
} from "./contour-ops.js";
import {
  PluginTool,
  editingGlyphSelector,
  registerVisualizationLayer,
  shouldInitiateDrag,
  strokeRoundNode,
  unpackContours,
} from "./editor-glue.js";

export const CURVE_POINT_TOOL = "curvekit-curve-point-tool";

const MODE_NAMES = { cubic: "cubic", quad: "quadratic" };

class CurvePointToolBase extends PluginTool {
  constructor(editor, pluginPath, shared, curveType) {
    super(editor, pluginPath);
    this.shared = shared;
    this.curveType = curveType;
    this.identifier = `${CURVE_POINT_TOOL}-${curveType}`;
    this.title = `Curve Point Tool (${MODE_NAMES[curveType]})`; // like "Pen Tool (cubic)"
    this.iconPath = new URL(
      `./images/${curveType === "quad" ? "curve-point-quad" : "curve-point"}.svg`,
      import.meta.url,
    ).href;
  }

  get feedback() {
    return this.shared.feedback;
  }

  set feedback(value) {
    this.shared.feedback = value;
  }

  activate() {
    this.shared.activeTool = this;
    super.activate();
  }

  deactivate() {
    if (this.shared.activeTool === this) {
      this.shared.activeTool = null;
    }
    this.feedback = {};
    super.deactivate();
  }

  handleHover(event) {
    if (!this.isEditingGlyph) {
      this.pointerTool.handleHover(event);
      return;
    }
    this.setCursor();
    const contours = this.getInstanceContours();
    const hit = findHit(contours, this.glyphPoint(event), this.clickMargin);
    this.feedback = { hover: hit, contours };
    this.canvasController.requestUpdate();
  }

  async handleDrag(eventStream, initialEvent) {
    if (!this.isEditingGlyph) {
      await this.pointerTool.handleDrag(eventStream, initialEvent);
      return;
    }
    const startPoint = this.glyphPoint(initialEvent);
    const contours = this.getInstanceContours();
    const hit = findHit(contours, startPoint, this.clickMargin);
    const isDrag = await shouldInitiateDrag(eventStream, initialEvent);
    if (!hit) {
      for await (const event of eventStream) {
        // nothing under the pointer: let the drag pass
      }
      return;
    }
    if (!isDrag) {
      if (hit.kind === "anchor") {
        await this.toggleSmooth(contours, hit);
      } else if (hit.kind === "segment" && initialEvent.shiftKey) {
        await this.editLayers(
          contours,
          hit.contourIndex,
          (contour) => straightenSegmentAt(contour, hit.segmentIndex),
          "Straighten segment"
        );
      } else if (hit.kind === "segment") {
        const options = { curveType: this.curveType };
        await this.editLayers(
          contours,
          hit.contourIndex,
          (contour) => addStraightHandles(contour, hit.segmentIndex, options),
          "Add handles"
        );
      } else if (hit.kind === "handle" && initialEvent.shiftKey) {
        await this.editLayers(
          contours,
          hit.contourIndex,
          (contour) => straightenSegment(contour, hit.pointIndex),
          "Straighten segment"
        );
      }
      return;
    }
    const options = { curveType: this.curveType };
    let edit;
    let undoLabel;
    if (hit.kind === "segment") {
      undoLabel = "Bend segment";
      edit = (contour, delta) => bendSegment(contour, hit.segmentIndex, hit.t, delta, options);
    } else if (hit.kind === "anchor") {
      undoLabel = "Pull out handles";
      // the handle vector is the pointer's offset from the anchor; each layer
      // gets the same vector from its own anchor
      edit = (contour, delta) =>
        pullHandles(
          contour,
          hit.pointIndex,
          { x: startPoint.x + delta.x - hit.x, y: startPoint.y + delta.y - hit.y },
          options
        );
    } else {
      undoLabel = "Move handle";
      edit = (contour, delta) => moveHandle(contour, hit.pointIndex, delta);
    }
    this.feedback = { contours };
    await this.liveEdit(contours, hit.contourIndex, edit, eventStream, startPoint, undoLabel);
    this.feedback = {};
    this.canvasController.requestUpdate();
  }

  async toggleSmooth(contours, hit) {
    const isSmooth = !!contours[hit.contourIndex].points[hit.pointIndex].smooth;
    const options = { curveType: this.curveType };
    await this.editLayers(
      contours,
      hit.contourIndex,
      isSmooth
        ? (contour) => retractHandles(contour, hit.pointIndex)
        : (contour) => makeSmooth(contour, hit.pointIndex, options),
      isSmooth ? "Convert to corner" : "Convert to smooth"
    );
  }

  // Apply a one-off operation to a contour in every editing layer with the
  // same structure, as one undo step
  async editLayers(contours, contourIndex, operation, undoLabel) {
    if (!operation(contours[contourIndex])) {
      return; // e.g. the end point of an open contour
    }
    const signatures = contours.map(contourSignature);
    const skipped = [];
    await this.sceneController.editLayersAndRecordChanges((layerGlyphs) => {
      for (const [layerName, layerGlyph] of Object.entries(layerGlyphs)) {
        const path = layerGlyph.path;
        const contour = sameStructure(path, signatures)
          ? operation(path.getUnpackedContour(contourIndex))
          : undefined;
        if (!contour) {
          skipped.push(layerName);
          continue;
        }
        path.setUnpackedContour(contourIndex, contour);
      }
      return undoLabel;
    });
    logSkipped(skipped);
  }

  // Edit one contour in every editing layer while the pointer moves. `edit`
  // makes the new contour from a layer's original contour and the pointer's
  // offset from where the drag started. Changes are sent as plain change
  // objects (deleteContour + insertContour), as Fontra's change recorder would
  // make them; plug-ins can't import it.
  async liveEdit(instanceContours, contourIndex, edit, eventStream, startPoint, undoLabel) {
    const signatures = instanceContours.map(contourSignature);
    const skipped = [];
    this.sceneController.selection = new Set();
    await this.sceneController.editGlyph(async (sendIncrementalChange, glyph) => {
      const layerGlyphs = this.sceneController.getEditingLayerFromGlyphLayers(glyph.layers);
      const layers = [];
      for (const [layerName, layerGlyph] of Object.entries(layerGlyphs)) {
        const path = layerGlyph.path;
        if (!sameStructure(path, signatures)) {
          skipped.push(layerName);
          continue;
        }
        layers.push({
          layerName,
          path,
          original: path.getUnpackedContour(contourIndex),
          originalPacked: path.getContour(contourIndex),
        });
      }
      let forward;
      for await (const event of eventStream) {
        const point = this.glyphPoint(event);
        if (point?.x === undefined) {
          continue; // non-pointer events, such as key events
        }
        const delta = { x: point.x - startPoint.x, y: point.y - startPoint.y };
        forward = {
          c: layers.map((layer) => {
            const contour = edit(layer.original, delta) ?? layer.original;
            layer.path.setUnpackedContour(contourIndex, contour);
            return replaceContourChange(
              layer.layerName,
              contourIndex,
              layer.path.getContour(contourIndex)
            );
          }),
        };
        await sendIncrementalChange(forward, true); // true: may drop
      }
      if (!forward || !layers.length) {
        return undefined;
      }
      const rollback = {
        c: layers.map((layer) =>
          replaceContourChange(layer.layerName, contourIndex, layer.originalPacked)
        ),
      };
      return {
        changes: { hasChange: true, change: forward, rollbackChange: rollback },
        undoLabel,
        broadcast: true,
      };
    });
    logSkipped(skipped);
  }

  drawFeedback(context, parameters) {
    const hover = this.feedback.hover;
    if (!hover) {
      return;
    }
    context.strokeStyle = parameters.hoverColor;
    context.lineWidth = parameters.strokeWidth * 2;
    if (hover.kind === "segment") {
      const contour = this.feedback.contours?.[hover.contourIndex];
      const segment = contour && getSegments(contour)[hover.segmentIndex];
      if (segment) {
        strokeSegment(context, segmentPoints(contour, segment), contour.points[segment.offIndices[0]]?.type);
      }
      return;
    }
    strokeRoundNode(context, hover, parameters.hoverNodeSize);
  }
}

// The toolbar entry: one button with a cubic and a quadratic mode, like
// Fontra's pen tool. Fontra builds sub-tools with `new SubTool(editor)`, so
// the classes are made here to carry the plug-in path.
export function createCurvePointTool(editor, pluginPath) {
  const shared = { feedback: {}, activeTool: null };
  class CurvePointToolCubic extends CurvePointToolBase {
    constructor(editor) {
      super(editor, pluginPath, shared, "cubic");
    }
  }
  class CurvePointToolQuad extends CurvePointToolBase {
    constructor(editor) {
      super(editor, pluginPath, shared, "quad");
    }
  }
  registerVisualizationLayer(editor, {
    identifier: "curvekit.curve-point.feedback",
    name: "Curve Point tool feedback",
    selectionFunc: editingGlyphSelector,
    userSwitchable: false,
    zIndex: 500,
    screenParameters: { strokeWidth: 1, hoverNodeSize: 14 },
    colors: { hoverColor: "#3080FF" },
    colorsDarkMode: { hoverColor: "#50A0FF" },
    draw: ({ context, parameters }) => {
      if (shared.activeTool?.isActive) {
        shared.activeTool.drawFeedback(context, parameters);
      }
    },
  });
  return {
    identifier: CURVE_POINT_TOOL,
    subTools: [CurvePointToolCubic, CurvePointToolQuad],
  };
}

// What is under the pointer: a handle first, then an anchor, then a segment.
export function findHit(contours, point, margin) {
  if (point?.x === undefined) {
    return undefined;
  }
  for (const wantOnCurve of [false, true]) {
    let best;
    let bestDistance = margin;
    contours.forEach((contour, contourIndex) => {
      contour.points.forEach((p, pointIndex) => {
        if (isOnCurve(p) !== wantOnCurve) {
          return;
        }
        const d = distance(p, point);
        if (d <= bestDistance) {
          bestDistance = d;
          best = {
            kind: wantOnCurve ? "anchor" : "handle",
            contourIndex,
            pointIndex,
            x: p.x,
            y: p.y,
          };
        }
      });
    });
    if (best) {
      return best;
    }
  }
  let best;
  contours.forEach((contour, contourIndex) => {
    const hit = nearestSegmentPoint(contour, point);
    if (hit && hit.distance <= margin && (!best || hit.distance < best.distance)) {
      best = { kind: "segment", contourIndex, ...hit };
    }
  });
  return best;
}

function sameStructure(path, signatures) {
  const layerSignatures = unpackContours(path).map(contourSignature);
  return (
    layerSignatures.length === signatures.length &&
    layerSignatures.every((sig, i) => sig === signatures[i])
  );
}

function replaceContourChange(layerName, contourIndex, packedContour) {
  return {
    p: ["layers", layerName, "glyph", "path"],
    c: [
      { f: "deleteContour", a: [contourIndex] },
      { f: "insertContour", a: [contourIndex, packedContour] },
    ],
  };
}

function strokeSegment(context, pts, type) {
  context.beginPath();
  context.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 2) {
    context.lineTo(pts[1].x, pts[1].y);
  } else if (pts.length === 4 && type === "cubic") {
    context.bezierCurveTo(pts[1].x, pts[1].y, pts[2].x, pts[2].y, pts[3].x, pts[3].y);
  } else if (pts.length === 3) {
    context.quadraticCurveTo(pts[1].x, pts[1].y, pts[2].x, pts[2].y);
  } else {
    for (const p of pts.slice(1)) {
      context.lineTo(p.x, p.y);
    }
  }
  context.stroke();
}

function logSkipped(skipped) {
  if (skipped.length) {
    console.log(`Curve Point: skipped incompatible layer(s): ${skipped.join(", ")}`);
  }
}
