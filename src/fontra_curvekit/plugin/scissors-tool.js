// Scissors tool:
//
// - Click a node: cut the contour there. A closed contour becomes open, an open
//   contour is split in two.
// - Click a segment: insert a node at the click position without cutting.
// - Drag from node to node: first the same two-corner check as the marquee
//   (below): if the two nodes are the corners of a junction, split it by
//   extending the edges. Otherwise cut along a straight line. On one closed contour
//   this splits it in two. Between two closed contours (e.g. the outer contour
//   and a counter of an O or Ø) it joins them through a slit, so a second cut
//   across the same stroke splits the shape. Green feedback means the cut is
//   possible, red that it isn't.
// - Drag in empty space (marquee): if it holds exactly the four inner corners
//   of a crossing (X, +, Ø) on closed contours and the edges run on straight
//   through, split it into two overlapping strokes ("\" and "/"). If it holds
//   exactly two corners (T, Λ under a bar, "e" bar into the bowl), split by
//   extending the edges on beyond the corners: to where they meet if that is
//   inside the outline, else 50% of the way into the stroke they enter.
//   Otherwise cut stems inside the rectangle by pairing up nodes of closed
//   contours that fall inside it, closest pair first.
//
// Edits apply to all layers being edited, as long as their contours have the
// same structure as the displayed glyph.

import {
  canCutBetween,
  contourSignature,
  cutBetweenNodes,
  cutContourAtNode,
  distance,
  extensionSplitContours,
  isOnCurve,
  nearestSegmentPoint,
  parallelSplitContours,
  splitSegment,
} from "./contour-ops.js";
import {
  PluginTool,
  editingGlyphSelector,
  fillRoundNode,
  pointInRect,
  rectFromPoints,
  registerVisualizationLayer,
  setAllContours,
  shouldInitiateDrag,
  strokeLine,
  strokeRoundNode,
  unpackContours,
} from "./editor-glue.js";

const MAX_MARQUEE_CUTS = 100;

export class ScissorsTool extends PluginTool {
  identifier = "curvekit-scissors-tool";
  title = "Scissors Tool";

  constructor(editor, pluginPath) {
    super(editor, pluginPath);
    this.iconPath = new URL("./images/scissors.svg", import.meta.url).href;
    this.feedback = {};
    registerVisualizationLayer(editor, this.visualizationLayer());
  }

  handleHover(event) {
    if (!this.isEditingGlyph) {
      this.pointerTool.handleHover(event);
      return;
    }
    this.setCursor();
    const point = this.glyphPoint(event);
    const contours = this.getInstanceContours();
    const node = findNode(contours, point, this.clickMargin);
    const segmentHit = node
      ? undefined
      : findSegment(contours, point, this.clickMargin);
    this.feedback = { hoverNode: node, hoverSegment: segmentHit };
    this.canvasController.requestUpdate();
  }

  async handleDrag(eventStream, initialEvent) {
    if (!this.isEditingGlyph) {
      await this.pointerTool.handleDrag(eventStream, initialEvent);
      return;
    }
    const startPoint = this.glyphPoint(initialEvent);
    const contours = this.getInstanceContours();
    const startNode = findNode(contours, startPoint, this.clickMargin);

    if (!(await shouldInitiateDrag(eventStream, initialEvent))) {
      await this.handleClick(contours, startPoint, startNode);
      return;
    }

    if (startNode) {
      await this.dragNodeToNode(eventStream, contours, startNode);
    } else {
      await this.dragMarquee(eventStream, contours, startPoint);
    }
  }

  async handleClick(contours, point, node) {
    if (node) {
      const contour = contours[node.contourIndex];
      if (!cutContourAtNode(contour, node.pointIndex)) {
        return; // e.g. the end point of an open contour
      }
      await this.applyOperations(
        [{ kind: "cutAtNode", ...node }],
        contours,
        "Cut contour",
      );
      return;
    }
    const segmentHit = findSegment(contours, point, this.clickMargin);
    if (segmentHit) {
      await this.applyOperations(
        [{ kind: "insertNode", ...segmentHit }],
        contours,
        "Insert point",
      );
    }
  }

  async dragNodeToNode(eventStream, contours, startNode) {
    let target;
    let valid = false;
    let junction;
    for await (const event of eventStream) {
      const point = this.glyphPoint(event);
      if (point?.x === undefined) {
        continue; // non-pointer events, such as key events
      }
      const node = findNode(contours, point, this.clickMargin, startNode);
      target = node;
      // the marquee's two-corner check first, then a straight cut
      // corners in index order, as the marquee finds them, so both give
      // the same result
      junction = node
        ? planExtensionSplitForCorners(
            contours,
            [nodeRef(startNode), nodeRef(node)].sort(
              (a, b) =>
                a.contourIndex - b.contourIndex || a.pointIndex - b.pointIndex,
            ),
          )
        : undefined;
      valid = !!junction || canCutBetween(contours, startNode, node);
      this.feedback = {
        dragFrom: startNode,
        dragTo: node || point,
        dragTargetIsNode: !!node,
        valid,
        cutLines: junction
          ? junction.polylines.map((polyline) => ({ polyline }))
          : undefined,
      };
      this.canvasController.requestUpdate();
    }
    this.feedback = {};
    this.canvasController.requestUpdate();
    if (junction) {
      await this.applyOperations([junction], contours, "Split junction");
    } else if (valid) {
      await this.applyOperations(
        [
          {
            kind: "cutBetweenNodes",
            a: {
              contourIndex: startNode.contourIndex,
              pointIndex: startNode.pointIndex,
            },
            b: {
              contourIndex: target.contourIndex,
              pointIndex: target.pointIndex,
            },
          },
        ],
        contours,
        "Split contour",
      );
    }
  }

  async dragMarquee(eventStream, contours, startPoint) {
    let operations = [];
    for await (const event of eventStream) {
      const point = this.glyphPoint(event);
      if (point?.x === undefined) {
        continue;
      }
      const rect = rectFromPoints(startPoint, point);
      operations = planMarqueeCuts(contours, rect);
      this.feedback = {
        marquee: rect,
        cutLines: operations.flatMap(
          (op) =>
            op.bridges ??
            op.polylines?.map((polyline) => ({ polyline })) ?? [
              [op.pointA, op.pointB],
            ],
        ),
      };
      this.canvasController.requestUpdate();
    }
    this.feedback = {};
    this.canvasController.requestUpdate();
    if (operations.length) {
      const undoLabels = {
        parallelSplit: "Split crossing",
        extensionSplit: "Split junction",
      };
      await this.applyOperations(
        operations,
        contours,
        undoLabels[operations[0].kind] ?? "Cut stems",
      );
    }
  }

  // Apply a list of operations to every editing layer. Operations refer to
  // contour/point indices of the displayed glyph; layers whose contours are
  // structured differently are skipped.
  async applyOperations(operations, instanceContours, undoLabel) {
    const signatures = instanceContours.map(contourSignature);
    this.sceneController.selection = new Set();
    let skippedLayers = [];
    await this.sceneController.editLayersAndRecordChanges((layerGlyphs) => {
      for (const [layerName, layerGlyph] of Object.entries(layerGlyphs)) {
        const path = layerGlyph.path;
        const layerSignatures = unpackContours(path).map(contourSignature);
        if (
          layerSignatures.length !== signatures.length ||
          layerSignatures.some((sig, i) => sig !== signatures[i])
        ) {
          skippedLayers.push(layerName);
          continue;
        }
        let contours = unpackContours(path);
        for (const operation of operations) {
          contours = applyOperation(contours, operation) ?? contours;
        }
        setAllContours(path, contours);
      }
      return undoLabel;
    });
    if (skippedLayers.length) {
      console.log(
        `Scissors: skipped incompatible layer(s): ${skippedLayers.join(", ")}`,
      );
    }
  }

  deactivate() {
    this.feedback = {};
    super.deactivate();
  }

  visualizationLayer() {
    return {
      identifier: "curvekit.scissors.feedback",
      name: "Scissors tool feedback",
      selectionFunc: editingGlyphSelector,
      userSwitchable: false,
      zIndex: 500,
      screenParameters: { strokeWidth: 1, nodeSize: 10, hoverNodeSize: 14 },
      colors: {
        hoverColor: "#3080FF",
        validColor: "#1DA346",
        invalidColor: "#E5484D",
        marqueeColor: "#8888",
      },
      colorsDarkMode: {
        hoverColor: "#50A0FF",
        validColor: "#3DD068",
        invalidColor: "#FF6369",
        marqueeColor: "#AAA8",
      },
      draw: ({ context, parameters }) => {
        if (this.isActive) {
          this.drawFeedback(context, parameters);
        }
      },
    };
  }

  drawFeedback(context, parameters) {
    const f = this.feedback;
    context.lineWidth = parameters.strokeWidth;
    if (f.hoverNode) {
      context.strokeStyle = parameters.hoverColor;
      strokeRoundNode(context, f.hoverNode, parameters.hoverNodeSize);
    }
    if (f.hoverSegment) {
      // a dot on the outline where the cut would happen
      context.fillStyle = parameters.hoverColor;
      fillRoundNode(context, f.hoverSegment, parameters.nodeSize * 0.6);
    }
    if (f.dragFrom) {
      const color = f.valid ? parameters.validColor : parameters.invalidColor;
      context.strokeStyle = color;
      context.lineWidth = parameters.strokeWidth * 2;
      if (f.cutLines) {
        // a junction split: preview its bridges instead of the drag line
        this.drawCutLines(context, parameters, f.cutLines);
      } else {
        strokeLine(context, f.dragFrom, f.dragTo);
      }
      context.lineWidth = parameters.strokeWidth * 2;
      strokeRoundNode(context, f.dragFrom, parameters.hoverNodeSize);
      if (f.dragTargetIsNode) {
        strokeRoundNode(context, f.dragTo, parameters.hoverNodeSize);
      }
    }
    if (f.marquee) {
      const r = f.marquee;
      context.strokeStyle = parameters.marqueeColor;
      context.setLineDash([
        4 * parameters.strokeWidth,
        4 * parameters.strokeWidth,
      ]);
      context.strokeRect(r.xMin, r.yMin, r.xMax - r.xMin, r.yMax - r.yMin);
      context.setLineDash([]);
      context.strokeStyle = parameters.validColor;
      context.lineWidth = parameters.strokeWidth * 2;
      this.drawCutLines(context, parameters, f.cutLines);
    }
  }

  drawCutLines(context, parameters, cutLines) {
    for (const cutLine of cutLines) {
      if (cutLine.polyline) {
        // extension bridge of a junction split
        const [first, ...rest] = cutLine.polyline;
        context.beginPath();
        context.moveTo(first.x, first.y);
        for (const p of rest) {
          context.lineTo(p.x, p.y);
        }
        context.stroke();
        strokeRoundNode(context, first, parameters.hoverNodeSize);
        strokeRoundNode(context, rest.at(-1), parameters.hoverNodeSize);
        continue;
      }
      const [a, b, h1, h2] = cutLine;
      if (h1) {
        // curved bridge of a crossing split
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.bezierCurveTo(h1.x, h1.y, h2.x, h2.y, b.x, b.y);
        context.stroke();
      } else {
        strokeLine(context, a, b);
      }
      strokeRoundNode(context, a, parameters.hoverNodeSize);
      strokeRoundNode(context, b, parameters.hoverNodeSize);
    }
  }
}

// Find the nearest on-curve node within `margin`
function findNode(contours, point, margin, skip = undefined) {
  let best;
  let bestDistance = margin;
  contours.forEach((contour, contourIndex) => {
    contour.points.forEach((p, pointIndex) => {
      if (!isOnCurve(p)) {
        return;
      }
      if (
        skip &&
        skip.contourIndex === contourIndex &&
        skip.pointIndex === pointIndex
      ) {
        return;
      }
      const d = distance(p, point);
      if (d <= bestDistance) {
        bestDistance = d;
        best = { contourIndex, pointIndex, x: p.x, y: p.y };
      }
    });
  });
  return best;
}

function findSegment(contours, point, margin) {
  let best;
  contours.forEach((contour, contourIndex) => {
    const hit = nearestSegmentPoint(contour, point);
    if (
      hit &&
      hit.distance <= margin &&
      (!best || hit.distance < best.distance)
    ) {
      best = { contourIndex, ...hit };
    }
  });
  return best;
}

// Work out the node-to-node cuts for a marquee: repeatedly cut the closest pair
// of nodes inside the rectangle (on the same or on different closed contours)
// until no valid pair is left. A node used by one cut, or any node at the same
// position (cuts duplicate their end nodes), isn't used again, so later cuts
// can't undo or retrace earlier ones. Returns operations to apply in order.
function planMarqueeCuts(contours, rect) {
  const parallelSplit = planParallelSplit(contours, rect);
  if (parallelSplit) {
    return [parallelSplit];
  }
  const extensionSplit = planExtensionSplit(contours, rect);
  if (extensionSplit) {
    return [extensionSplit];
  }
  const operations = [];
  const usedPositions = new Set();
  const positionKey = (p) => `${p.x},${p.y}`;
  while (operations.length < MAX_MARQUEE_CUTS) {
    const inside = [];
    contours.forEach((contour, contourIndex) => {
      if (!contour.isClosed) {
        return;
      }
      contour.points.forEach((p, pointIndex) => {
        if (
          isOnCurve(p) &&
          pointInRect(p, rect) &&
          !usedPositions.has(positionKey(p))
        ) {
          inside.push({ contourIndex, pointIndex, x: p.x, y: p.y });
        }
      });
    });
    let best;
    for (let i = 0; i < inside.length; i++) {
      for (let j = i + 1; j < inside.length; j++) {
        const d = distance(inside[i], inside[j]);
        if (
          d > 0 &&
          (!best || d < best.d) &&
          canCutBetween(contours, inside[i], inside[j])
        ) {
          best = { d, a: inside[i], b: inside[j] };
        }
      }
    }
    if (!best) {
      break;
    }
    const a = {
      contourIndex: best.a.contourIndex,
      pointIndex: best.a.pointIndex,
    };
    const b = {
      contourIndex: best.b.contourIndex,
      pointIndex: best.b.pointIndex,
    };
    operations.push({
      kind: "cutBetweenNodes",
      a,
      b,
      pointA: best.a,
      pointB: best.b,
    });
    usedPositions.add(positionKey(best.a));
    usedPositions.add(positionKey(best.b));
    contours = cutBetweenNodes(contours, a, b);
  }
  return operations;
}

// Exactly four on-curve nodes inside the rectangle, on closed contours (one or
// several, e.g. the outer contour and both counter halves of Ø), with
// continuous edges: split the crossing into overlapping strokes.
function planParallelSplit(contours, rect) {
  const corners = [];
  contours.forEach((contour, contourIndex) => {
    contour.points.forEach((p, pointIndex) => {
      if (isOnCurve(p) && pointInRect(p, rect)) {
        corners.push({ contourIndex, pointIndex });
      }
    });
  });
  if (corners.length !== 4) {
    return undefined;
  }
  const result = parallelSplitContours(contours, corners);
  if (!result) {
    return undefined;
  }
  return {
    kind: "parallelSplit",
    corners,
    pairing: result.pairing,
    bridges: result.bridges,
  };
}

// Exactly two on-curve nodes inside the rectangle, on closed contours (the
// corners of a T, a Λ under a bar, two touching chevrons, an "e" bar running
// into the bowl, where one corner is on the counter and one on the outer
// contour): split by extending the edges on beyond the corners.
function planExtensionSplit(contours, rect) {
  const corners = [];
  contours.forEach((contour, contourIndex) => {
    contour.points.forEach((p, pointIndex) => {
      if (isOnCurve(p) && pointInRect(p, rect)) {
        corners.push({ contourIndex, pointIndex });
      }
    });
  });
  if (corners.length !== 2) {
    return undefined;
  }
  return planExtensionSplitForCorners(contours, corners);
}

function nodeRef(node) {
  return { contourIndex: node.contourIndex, pointIndex: node.pointIndex };
}

// The two-corner junction split for two given nodes (marquee or node-to-node
// drag), or undefined if they aren't the corners of a junction.
function planExtensionSplitForCorners(contours, corners) {
  if (corners.some(({ contourIndex }) => !contours[contourIndex]?.isClosed)) {
    return undefined;
  }
  const result = extensionSplitContours(contours, corners);
  if (!result) {
    return undefined;
  }
  return {
    kind: "extensionSplit",
    corners,
    kinds: result.kinds,
    polylines: result.bridges,
  };
}

// Apply one operation to a list of contours; returns the new list, or
// undefined if the operation doesn't apply.
function applyOperation(contours, operation) {
  if (operation.kind === "cutBetweenNodes") {
    return cutBetweenNodes(contours, operation.a, operation.b);
  }
  if (operation.kind === "extensionSplit") {
    // the bridge kinds were chosen on the displayed glyph; every layer follows
    return extensionSplitContours(contours, operation.corners, {
      kinds: operation.kinds,
    })?.contours;
  }
  if (operation.kind === "parallelSplit") {
    // the pairing was chosen on the displayed glyph; every layer follows it
    return parallelSplitContours(contours, operation.corners, {
      pairing: operation.pairing,
    })?.contours;
  }
  const { contourIndex } = operation;
  const contour = contours[contourIndex];
  let result;
  if (operation.kind === "cutAtNode") {
    result = cutContourAtNode(contour, operation.pointIndex);
  } else if (operation.kind === "insertNode") {
    // only the new node: the contour isn't cut, open or closed
    const split = splitSegment(contour, operation.segmentIndex, operation.t);
    result = split && [split.contour];
  }
  if (!result) {
    return undefined;
  }
  const newContours = [...contours];
  newContours.splice(contourIndex, 1, ...result);
  return newContours;
}
