// Pure operations of the Curve Point tool. They work on unpacked contours
// (see contour-ops.js) and return new contours, or undefined when the
// operation doesn't apply.
//
// Anchors (on-curve points) never move: only off-curve points and smooth flags
// change. On-curve points are copied as they are; only computed handles are
// rounded.

import {
  copyContour,
  distance,
  getSegments,
  isOnCurve,
  lerpPoint,
  onCurveIndices,
  replaceSegmentInner,
  roundPoint,
  segmentPoints,
  segmentType,
} from "./contour-ops.js";

const MIN_T = 0.1;
const MAX_T = 0.9;

// --- segment helpers -------------------------------------------------------------

// Segment k starts at the k-th on-curve point. Replacing a segment's off-curve
// points doesn't change the on-curve points or their order, so segment indices
// stay valid across edits.
function setSegmentInner(contour, segmentIndex, inner) {
  const segment = getSegments(contour)[segmentIndex];
  return replaceSegmentInner(contour, segment, inner).contour;
}

// The segments before and after an on-curve point: { incoming, outgoing } with
// segment indices (undefined at the ends of an open contour).
function segmentsAround(contour, pointIndex) {
  const onIndices = onCurveIndices(contour);
  const k = onIndices.indexOf(pointIndex);
  if (k < 0) {
    return undefined;
  }
  const count = getSegments(contour).length;
  let incoming;
  let outgoing;
  if (contour.isClosed) {
    incoming = (k - 1 + onIndices.length) % onIndices.length;
    outgoing = k;
  } else {
    incoming = k > 0 ? k - 1 : undefined;
    outgoing = k < onIndices.length - 1 ? k : undefined;
  }
  if (incoming !== undefined && incoming >= count) {
    incoming = undefined;
  }
  if (outgoing !== undefined && outgoing >= count) {
    outgoing = undefined;
  }
  return { incoming, outgoing };
}

// The segment's points and kind: "line", "cubic" (two off-curves), "quad"
// (one off-curve), or undefined for anything else (super-curves, quadratic
// splines with several off-curves).
function segmentInfo(contour, segmentIndex) {
  const segment = getSegments(contour)[segmentIndex];
  const pts = segmentPoints(contour, segment);
  const type = segmentType(contour, segment);
  let kind;
  if (type === "line") {
    kind = "line";
  } else if (type === "cubic" && pts.length === 4) {
    kind = "cubic";
  } else if (type === "quad" && pts.length === 3) {
    kind = "quad";
  }
  return { segment, pts, kind, type };
}

function handle(p, type) {
  return { ...roundPoint(p), type };
}

function add(p, v, scale = 1) {
  return { x: p.x + v.x * scale, y: p.y + v.y * scale };
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function normalize(v) {
  const length = Math.hypot(v.x, v.y);
  return length ? { x: v.x / length, y: v.y / length } : undefined;
}

// Off-curve points (unrounded) for a line from a to b turned into a curve
// with the same shape
function lineAsCurve(a, b, curveType) {
  return curveType === "quad"
    ? [{ ...lerpPoint(a, b, 0.5), type: "quad" }]
    : [
        { ...lerpPoint(a, b, 1 / 3), type: "cubic" },
        { ...lerpPoint(a, b, 2 / 3), type: "cubic" },
      ];
}

function clearSmooth(contour, pointIndex) {
  const point = contour.points[pointIndex];
  if (point.smooth) {
    contour.points[pointIndex] = { ...point };
    delete contour.points[pointIndex].smooth;
  }
}

function setSmooth(contour, pointIndex) {
  contour.points[pointIndex] = { ...contour.points[pointIndex], smooth: true };
}

// --- bend a segment --------------------------------------------------------------

// Curve drag weighting: how much of the drag goes to the second
// handle. Near the start only the first handle moves, near the end only the
// second.
function dragWeight(t) {
  if (t <= 1 / 6) {
    return 0;
  }
  if (t <= 0.5) {
    return Math.pow((6 * t - 1) / 2, 3) / 2;
  }
  if (t <= 5 / 6) {
    return (1 - Math.pow((6 * (1 - t) - 1) / 2, 3)) / 2 + 0.5;
  }
  return 1;
}

// Drag the point at parameter t of a segment by `delta`: the segment bends so
// that point follows. A line first becomes a curve of `curveType`. Smooth end
// points stay smooth by turning the neighbouring segment's handle.
export function bendSegment(contour, segmentIndex, t, delta, { curveType = "cubic" } = {}) {
  let result = copyContour(contour);
  const info = segmentInfo(result, segmentIndex);
  if (!info.kind) {
    return undefined;
  }
  // a line becomes a straight curve first (not rounded until the drag is added)
  let inner = info.kind === "line" ? lineAsCurve(info.pts[0], info.pts[1], curveType) : info.pts.slice(1, -1);
  t = Math.min(MAX_T, Math.max(MIN_T, t));
  if (inner.length === 2) {
    const w = dragWeight(t);
    const k1 = (1 - w) / (3 * t * (1 - t) * (1 - t));
    const k2 = w / (3 * t * t * (1 - t));
    inner = [
      handle(add(inner[0], delta, k1), inner[0].type),
      handle(add(inner[1], delta, k2), inner[1].type),
    ];
  } else {
    inner = [handle(add(inner[0], delta, 1 / (2 * t * (1 - t))), inner[0].type)];
  }
  result = setSegmentInner(result, segmentIndex, inner);
  keepSmooth(result, segmentIndex, "start");
  keepSmooth(result, segmentIndex, "end");
  return result;
}

// After a segment's handles changed: if its start (or end) anchor is smooth,
// turn the neighbouring segment's handle so the two stay in line. A smooth
// anchor next to a line can't stay smooth this way and becomes a corner.
function keepSmooth(contour, segmentIndex, side) {
  const info = segmentInfo(contour, segmentIndex);
  const anchorIndex = side === "start" ? info.segment.startIndex : info.segment.endIndex;
  if (!contour.points[anchorIndex].smooth) {
    return;
  }
  const around = segmentsAround(contour, anchorIndex);
  const neighbourIndex = side === "start" ? around.incoming : around.outgoing;
  if (neighbourIndex === undefined || neighbourIndex === segmentIndex) {
    return;
  }
  const neighbour = segmentInfo(contour, neighbourIndex);
  if (neighbour.kind === "line" || !neighbour.kind) {
    if (neighbour.kind === "line") {
      clearSmooth(contour, anchorIndex);
    }
    return;
  }
  const anchor = contour.points[anchorIndex];
  const ownHandle = contour.points[side === "start" ? info.segment.offIndices[0] : info.segment.offIndices.at(-1)];
  const direction = normalize(sub(anchor, ownHandle));
  if (!direction) {
    return;
  }
  const otherIndex =
    side === "start" ? neighbour.segment.offIndices.at(-1) : neighbour.segment.offIndices[0];
  const other = contour.points[otherIndex];
  const length = distance(other, anchor);
  contour.points[otherIndex] = handle(add(anchor, direction, length), other.type);
}

// --- pull out handles ------------------------------------------------------------

// Drag from an anchor: its outgoing handle goes to anchor + vector, its
// incoming handle to anchor - vector, and it becomes smooth. A line next to it
// becomes a curve; the line's far handle sits 1/3 along the line from the far
// anchor, so that anchor keeps its direction.
export function pullHandles(contour, pointIndex, vector, { curveType = "cubic" } = {}) {
  if (!contour.points[pointIndex] || !isOnCurve(contour.points[pointIndex])) {
    return undefined;
  }
  let result = copyContour(contour);
  const around = segmentsAround(result, pointIndex);
  if (around.incoming === undefined && around.outgoing === undefined) {
    return undefined;
  }
  if (around.incoming !== undefined && around.incoming === around.outgoing) {
    return undefined; // a closed contour with a single anchor
  }
  const anchor = result.points[pointIndex];
  for (const side of ["outgoing", "incoming"]) {
    const segmentIndex = around[side];
    if (segmentIndex === undefined) {
      continue;
    }
    const info = segmentInfo(result, segmentIndex);
    if (!info.kind) {
      return undefined;
    }
    const target = add(anchor, vector, side === "outgoing" ? 1 : -1);
    let inner;
    if (info.kind === "line") {
      const far = side === "outgoing" ? info.pts.at(-1) : info.pts[0];
      if (curveType === "quad") {
        inner = [handle(target, "quad")];
      } else {
        const farHandle = handle(lerpPoint(far, anchor, 1 / 3), "cubic");
        inner =
          side === "outgoing"
            ? [handle(target, "cubic"), farHandle]
            : [farHandle, handle(target, "cubic")];
      }
    } else {
      inner = info.pts.slice(1, -1).map((p) => ({ ...p }));
      const index = side === "outgoing" ? 0 : inner.length - 1;
      inner[index] = handle(target, inner[index].type);
    }
    result = setSegmentInner(result, segmentIndex, inner);
  }
  if (around.incoming !== undefined && around.outgoing !== undefined) {
    setSmooth(result, result.points.indexOf(anchor)); // its index moved
  }
  return result;
}

// --- corner -> smooth -------------------------------------------------------------

// Click on a corner anchor: make it smooth by lining up its handles. The
// anchor and its neighbours stay where they are.
// - two curves: both handles turn onto the common direction, keeping their
//   lengths;
// - a curve and a line: the curve's handle turns onto the line's direction;
// - two lines: both become curves of `curveType`, with the anchor's handles
//   on the common direction at 1/3 of each segment's length.
export function makeSmooth(contour, pointIndex, { curveType = "cubic" } = {}) {
  if (!contour.points[pointIndex] || !isOnCurve(contour.points[pointIndex])) {
    return undefined;
  }
  let result = copyContour(contour);
  const around = segmentsAround(result, pointIndex);
  if (around.incoming === undefined || around.outgoing === undefined) {
    return undefined; // end point of an open contour
  }
  if (around.incoming === around.outgoing) {
    return undefined;
  }
  const anchor = result.points[pointIndex];
  const before = segmentInfo(result, around.incoming);
  const after = segmentInfo(result, around.outgoing);
  if (!before.kind || !after.kind) {
    return undefined;
  }
  const prevAnchor = before.pts[0];
  const nextAnchor = after.pts.at(-1);
  // the nearest point on each side that isn't on top of the anchor
  const prevRef = [...before.pts.slice(0, -1)].reverse().find((p) => distance(p, anchor) > 0);
  const nextRef = after.pts.slice(1).find((p) => distance(p, anchor) > 0);
  if (!prevRef || !nextRef) {
    return undefined;
  }
  let direction;
  if (before.kind === "line" && after.kind !== "line") {
    direction = normalize(sub(anchor, prevAnchor));
  } else if (after.kind === "line" && before.kind !== "line") {
    direction = normalize(sub(nextAnchor, anchor));
  } else {
    direction = normalize(sub(nextRef, prevRef));
  }
  if (!direction) {
    return undefined;
  }

  if (before.kind !== "line") {
    const inner = before.pts.slice(1, -1).map((p) => ({ ...p }));
    const last = inner.at(-1);
    inner[inner.length - 1] = handle(add(anchor, direction, -distance(last, anchor)), last.type);
    result = setSegmentInner(result, around.incoming, inner);
  } else if (after.kind === "line") {
    const length = distance(prevAnchor, anchor) / 3;
    const near = handle(add(anchor, direction, -length), curveType);
    const inner =
      curveType === "quad"
        ? [near]
        : [handle(lerpPoint(prevAnchor, anchor, 1 / 3), "cubic"), near];
    result = setSegmentInner(result, around.incoming, inner);
  }

  if (after.kind !== "line") {
    const inner = after.pts.slice(1, -1).map((p) => ({ ...p }));
    inner[0] = handle(add(anchor, direction, distance(inner[0], anchor)), inner[0].type);
    result = setSegmentInner(result, around.outgoing, inner);
  } else if (before.kind === "line") {
    const length = distance(nextAnchor, anchor) / 3;
    const near = handle(add(anchor, direction, length), curveType);
    const inner =
      curveType === "quad"
        ? [near]
        : [near, handle(lerpPoint(nextAnchor, anchor, 1 / 3), "cubic")];
    result = setSegmentInner(result, around.outgoing, inner);
  }
  setSmooth(result, result.points.indexOf(anchor)); // its index moved
  return result;
}

// --- smooth -> corner -------------------------------------------------------------

// Click on a smooth anchor: retract its handles. On a cubic segment the
// anchor's handle moves onto the anchor, and when both handles of the segment
// are retracted it becomes a line. A quadratic segment becomes a line.
export function retractHandles(contour, pointIndex) {
  if (!contour.points[pointIndex] || !isOnCurve(contour.points[pointIndex])) {
    return undefined;
  }
  let result = copyContour(contour);
  const around = segmentsAround(result, pointIndex);
  const anchor = result.points[pointIndex];
  const sides = [...new Set([around.incoming, around.outgoing])].filter(
    (s) => s !== undefined
  );
  for (const segmentIndex of sides) {
    const info = segmentInfo(result, segmentIndex);
    if (info.kind === "line") {
      continue;
    }
    if (info.type === "cubic" && info.kind !== "cubic") {
      return undefined; // super-curve
    }
    let inner = [];
    if (info.kind === "cubic") {
      inner = info.pts.slice(1, -1).map((p) => ({ ...p }));
      // compare by identity: indices move as segments are replaced
      if (result.points[info.segment.startIndex] === anchor) {
        inner[0] = { x: anchor.x, y: anchor.y, type: "cubic" };
      }
      if (result.points[info.segment.endIndex] === anchor) {
        inner[1] = { x: anchor.x, y: anchor.y, type: "cubic" };
      }
      const retracted =
        distance(inner[0], info.pts[0]) === 0 && distance(inner[1], info.pts[3]) === 0;
      if (retracted) {
        inner = [];
      }
    }
    result = setSegmentInner(result, segmentIndex, inner);
  }
  clearSmooth(result, result.points.indexOf(anchor));
  return result;
}

// --- move a handle ------------------------------------------------------------------

// Drag a handle on its own: it moves by `delta` and the anchor it belongs to
// becomes a corner (both anchors, for the single handle of a quadratic
// segment).
export function moveHandle(contour, pointIndex, delta) {
  const point = contour.points[pointIndex];
  if (!point || isOnCurve(point)) {
    return undefined;
  }
  const result = copyContour(contour);
  result.points[pointIndex] = handle(add(point, delta), point.type);
  const segment = getSegments(result).find((s) => s.offIndices.includes(pointIndex));
  if (segment) {
    if (segment.offIndices[0] === pointIndex) {
      clearSmooth(result, segment.startIndex);
    }
    if (segment.offIndices.at(-1) === pointIndex) {
      clearSmooth(result, segment.endIndex);
    }
  }
  return result;
}

// --- straight handles on a line ---------------------------------------------------

// Turn line `segmentIndex` into a curve whose handles lie on the line, at 1/3
// and 2/3 of its length, so it still looks straight but can now be shaped.
// Cubic: two cubic handles. Quadratic: two quad off-curve points (with an
// implied on-curve point between them). Rounded to whole units. Returns
// undefined if the segment isn't a line.
export function addStraightHandles(contour, segmentIndex, { curveType = "cubic" } = {}) {
  const info = segmentInfo(contour, segmentIndex);
  if (info.kind !== "line") {
    return undefined;
  }
  const [a, b] = info.pts;
  const type = curveType === "quad" ? "quad" : "cubic";
  const inner = [1 / 3, 2 / 3].map((t) => handle(lerpPoint(a, b, t), type));
  return setSegmentInner(copyContour(contour), segmentIndex, inner);
}

// --- straighten a segment ---------------------------------------------------------

// The same for a segment given by its index: undefined if it's already a line
export function straightenSegmentAt(contour, segmentIndex) {
  const segment = getSegments(contour)[segmentIndex];
  return segment?.offIndices.length
    ? straightenSegment(contour, segment.offIndices[0])
    : undefined;
}

// Remove all off-curve points of the segment that off-curve point
// `pointIndex` belongs to: the segment becomes a straight line. Its two
// anchors become corners.
export function straightenSegment(contour, pointIndex) {
  const point = contour.points[pointIndex];
  if (!point || isOnCurve(point)) {
    return undefined;
  }
  const segment = getSegments(contour).find((s) => s.offIndices.includes(pointIndex));
  if (!segment) {
    return undefined;
  }
  const ends = [contour.points[segment.startIndex], contour.points[segment.endIndex]];
  const result = replaceSegmentInner(contour, segment, []).contour;
  // compare by identity: indices move as off-curves are removed
  for (const end of ends) {
    clearSmooth(result, result.points.indexOf(end));
  }
  return result;
}
