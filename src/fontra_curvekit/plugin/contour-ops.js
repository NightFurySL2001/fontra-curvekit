// Pure contour operations used by the Scissors, Matchmaker and Curve Point tools.
//
// Fontra plug-ins can't import Fontra's own modules, so everything here works on
// "unpacked contours" as returned by VarPackedPath.getUnpackedContour():
//
//   { points: [{ x, y, type?, smooth?, attrs? }, ...], isClosed }
//
// where `type` is undefined/null for on-curve points, "cubic" or "quad" for
// off-curve points. Functions never mutate their input; they return new contours.

const SAMPLE_STEPS = 24;

export function copyPoint(point) {
  const result = { x: point.x, y: point.y };
  if (point.type) {
    result.type = point.type;
  }
  if (point.smooth) {
    result.smooth = true;
  }
  if (point.attrs) {
    result.attrs = structuredClone(point.attrs);
  }
  return result;
}

export function copyContour(contour) {
  return { points: contour.points.map(copyPoint), isClosed: contour.isClosed };
}

export function isOnCurve(point) {
  return !point.type;
}

export function onCurveIndices(contour) {
  const result = [];
  contour.points.forEach((point, i) => {
    if (isOnCurve(point)) {
      result.push(i);
    }
  });
  return result;
}

// Return the segments of a contour, each as
//   { startIndex, endIndex, offIndices: [...] }
// with indices into contour.points. For closed contours the last segment wraps
// around to the first on-curve point.
export function getSegments(contour) {
  const points = contour.points;
  const onIndices = onCurveIndices(contour);
  const segments = [];
  if (!onIndices.length) {
    return segments;
  }
  for (let k = 0; k < onIndices.length - 1; k++) {
    const startIndex = onIndices[k];
    const endIndex = onIndices[k + 1];
    segments.push({
      startIndex,
      endIndex,
      offIndices: range(startIndex + 1, endIndex),
    });
  }
  if (contour.isClosed) {
    const startIndex = onIndices.at(-1);
    const endIndex = onIndices[0];
    const offIndices = [
      ...range(startIndex + 1, points.length),
      ...range(0, endIndex),
    ];
    if (onIndices.length > 1 || offIndices.length) {
      segments.push({ startIndex, endIndex, offIndices });
    }
  }
  return segments;
}

export function segmentPoints(contour, segment) {
  const points = contour.points;
  return [
    points[segment.startIndex],
    ...segment.offIndices.map((i) => points[i]),
    points[segment.endIndex],
  ];
}

export function segmentType(contour, segment) {
  if (!segment.offIndices.length) {
    return "line";
  }
  return contour.points[segment.offIndices[0]].type;
}

// Decompose a segment into simple bezier pieces (arrays of 2, 3 or 4 points).
// Quadratic splines with multiple off-curves get their implied on-curves.
export function decomposeSegment(pts, type) {
  const numOff = pts.length - 2;
  if (numOff === 0) {
    return [pts];
  }
  if (type === "quad") {
    if (numOff === 1) {
      return [pts];
    }
    const pieces = [];
    let start = pts[0];
    for (let i = 1; i <= numOff; i++) {
      const off = pts[i];
      const end = i === numOff ? pts[i + 1] : midPoint(off, pts[i + 1]);
      pieces.push([start, off, end]);
      start = end;
    }
    return pieces;
  }
  if (numOff === 2) {
    return [pts];
  }
  // Cubic "super bezier" with more than two off-curves: not supported
  return null;
}

export function evalBezier(pts, t) {
  const mt = 1 - t;
  switch (pts.length) {
    case 2:
      return {
        x: mt * pts[0].x + t * pts[1].x,
        y: mt * pts[0].y + t * pts[1].y,
      };
    case 3:
      return {
        x: mt * mt * pts[0].x + 2 * mt * t * pts[1].x + t * t * pts[2].x,
        y: mt * mt * pts[0].y + 2 * mt * t * pts[1].y + t * t * pts[2].y,
      };
    case 4:
      return {
        x:
          mt * mt * mt * pts[0].x +
          3 * mt * mt * t * pts[1].x +
          3 * mt * t * t * pts[2].x +
          t * t * t * pts[3].x,
        y:
          mt * mt * mt * pts[0].y +
          3 * mt * mt * t * pts[1].y +
          3 * mt * t * t * pts[2].y +
          t * t * t * pts[3].y,
      };
  }
  throw new Error(`unsupported bezier degree: ${pts.length - 1}`);
}

// de Casteljau split of a simple bezier at t
export function splitBezier(pts, t) {
  const left = [pts[0]];
  const right = [pts.at(-1)];
  let current = pts;
  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length - 1; i++) {
      next.push(lerpPoint(current[i], current[i + 1], t));
    }
    left.push(next[0]);
    right.unshift(next.at(-1));
    current = next;
  }
  return [left, right];
}

export function bezierLength(pts, steps = SAMPLE_STEPS) {
  if (pts.length === 2) {
    return distance(pts[0], pts[1]);
  }
  let length = 0;
  let prev = pts[0];
  for (let i = 1; i <= steps; i++) {
    const p = evalBezier(pts, i / steps);
    length += distance(prev, p);
    prev = p;
  }
  return length;
}

export function segmentLength(contour, segment) {
  const pieces = decomposeSegment(
    segmentPoints(contour, segment),
    segmentType(contour, segment),
  );
  if (!pieces) {
    return distance(
      contour.points[segment.startIndex],
      contour.points[segment.endIndex],
    );
  }
  return pieces.reduce((sum, piece) => sum + bezierLength(piece), 0);
}

// Find the segment of a contour nearest to `point`. Returns
//   { segmentIndex, t, x, y, distance }
// where t is the parameter along the whole segment (0..1), or undefined.
export function nearestSegmentPoint(contour, point) {
  let best;
  getSegments(contour).forEach((segment, segmentIndex) => {
    const pieces = decomposeSegment(
      segmentPoints(contour, segment),
      segmentType(contour, segment),
    );
    if (!pieces) {
      return;
    }
    pieces.forEach((piece, pieceIndex) => {
      const hit = projectOnBezier(piece, point);
      if (!best || hit.distance < best.distance) {
        best = {
          segmentIndex,
          t: (pieceIndex + hit.t) / pieces.length,
          x: hit.x,
          y: hit.y,
          distance: hit.distance,
        };
      }
    });
  });
  return best;
}

function projectOnBezier(pts, point) {
  let bestT = 0;
  let bestD = Infinity;
  const steps = pts.length === 2 ? 1 : SAMPLE_STEPS;
  if (pts.length === 2) {
    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    const lenSq = dx * dx + dy * dy;
    bestT = lenSq
      ? clamp(
          ((point.x - pts[0].x) * dx + (point.y - pts[0].y) * dy) / lenSq,
          0,
          1,
        )
      : 0;
  } else {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const d = distance(evalBezier(pts, t), point);
      if (d < bestD) {
        bestD = d;
        bestT = t;
      }
    }
    // refine by bisection-like narrowing
    let step = 1 / steps;
    for (let iter = 0; iter < 16; iter++) {
      step /= 2;
      for (const t of [bestT - step, bestT + step]) {
        if (t < 0 || t > 1) {
          continue;
        }
        const d = distance(evalBezier(pts, t), point);
        if (d < bestD) {
          bestD = d;
          bestT = t;
        }
      }
    }
  }
  const p = evalBezier(pts, bestT);
  return { t: bestT, x: p.x, y: p.y, distance: distance(p, point) };
}

// Insert an on-curve node into segment `segmentIndex` at parameter t (0..1 along
// the whole segment). Returns { contour, pointIndex } where pointIndex is the
// index of the new on-curve point, or undefined if the segment can't be split.
// Implied on-curves of a quadratic spline segment become explicit nodes, so the
// shape is preserved. Unchanged points keep their identity (no copies), which
// lets callers track points across edits.
export function splitSegment(contour, segmentIndex, t, round = true) {
  const EPSILON = 1e-9;
  if (!(t > EPSILON && t < 1 - EPSILON)) {
    return undefined;
  }
  const segment = getSegments(contour)[segmentIndex];
  if (!segment) {
    return undefined;
  }
  const pieces = decomposeSegment(
    segmentPoints(contour, segment),
    segmentType(contour, segment),
  );
  if (!pieces) {
    return undefined;
  }
  const scaled = t * pieces.length;
  const pieceIndex = Math.min(Math.floor(scaled), pieces.length - 1);
  const localT = scaled - pieceIndex;
  const splitsPiece = localT > EPSILON;

  const roundPt = round ? roundPoint : (p) => ({ x: p.x, y: p.y });
  const inner = [];
  let newPointInnerIndex;
  pieces.forEach((piece, i) => {
    const subPieces =
      i === pieceIndex && splitsPiece ? splitBezier(piece, localT) : [piece];
    subPieces.forEach((sub, j) => {
      const type = sub.length === 4 ? "cubic" : "quad";
      for (const off of sub.slice(1, -1)) {
        inner.push({ ...roundPt(off), type });
      }
      const isSegmentEnd =
        i === pieces.length - 1 && j === subPieces.length - 1;
      if (isSegmentEnd) {
        return;
      }
      const on = roundPt(sub.at(-1));
      if (sub.length > 2) {
        on.smooth = true;
      }
      const isSplitPoint = splitsPiece
        ? i === pieceIndex && j === 0
        : i === pieceIndex - 1;
      if (isSplitPoint) {
        newPointInnerIndex = inner.length;
      }
      inner.push(on);
    });
  });
  if (newPointInnerIndex === undefined) {
    return undefined;
  }
  return replaceSegmentInner(contour, segment, inner, newPointInnerIndex);
}

// Replace the off-curve points of `segment` with `inner` points. Returns
// { contour, pointIndex } with the new index of inner[innerIndex] (if given).
export function replaceSegmentInner(contour, segment, inner, innerIndex) {
  const { startIndex, endIndex, offIndices } = segment;
  let points;
  let insertIndex;
  if (startIndex < endIndex) {
    points = contour.points.slice();
    points.splice(startIndex + 1, offIndices.length, ...inner);
    insertIndex = startIndex + 1;
  } else {
    // Wrapping segment of a closed contour: drop its trailing and leading
    // off-curves; the start point is then the last point, append after it.
    const offSet = new Set(offIndices);
    points = contour.points.filter((_, i) => !offSet.has(i));
    insertIndex = points.length;
    points.push(...inner);
  }
  return {
    contour: { points, isClosed: contour.isClosed },
    pointIndex: innerIndex !== undefined ? insertIndex + innerIndex : undefined,
  };
}

// Scissors: cut a contour at an on-curve node.
// Closed contour -> one open contour starting and ending at the node.
// Open contour -> two open contours (or undefined when the node is an end point).
export function cutContourAtNode(contour, pointIndex) {
  const points = contour.points;
  if (!isOnCurve(points[pointIndex])) {
    return undefined;
  }
  if (contour.isClosed) {
    const rotated = [
      ...points.slice(pointIndex),
      ...points.slice(0, pointIndex + 1),
    ].map(copyPoint);
    delete rotated[0].smooth;
    delete rotated.at(-1).smooth;
    return [{ points: rotated, isClosed: false }];
  }
  if (pointIndex === 0 || pointIndex === points.length - 1) {
    return undefined;
  }
  const first = points.slice(0, pointIndex + 1).map(copyPoint);
  const second = points.slice(pointIndex).map(copyPoint);
  delete first.at(-1).smooth;
  delete second[0].smooth;
  return [
    { points: first, isClosed: false },
    { points: second, isClosed: false },
  ];
}

// Scissors node-to-node: cut a closed contour along a straight line between two
// on-curve nodes, yielding two closed contours that share the cut edge.
// Returns undefined if the cut is invalid (see canCutBetweenNodes).
export function cutContourBetweenNodes(contour, indexA, indexB) {
  if (!canCutBetweenNodes(contour, indexA, indexB)) {
    return undefined;
  }
  const first = walk(contour.points, indexA, indexB).map(copyPoint);
  const second = walk(contour.points, indexB, indexA).map(copyPoint);
  for (const part of [first, second]) {
    delete part[0].smooth;
    delete part.at(-1).smooth;
  }
  return [
    { points: first, isClosed: true },
    { points: second, isClosed: true },
  ];
}

export function canCutBetweenNodes(contour, indexA, indexB) {
  const points = contour.points;
  if (
    !contour.isClosed ||
    indexA === indexB ||
    !points[indexA] ||
    !points[indexB] ||
    !isOnCurve(points[indexA]) ||
    !isOnCurve(points[indexB])
  ) {
    return false;
  }
  // Each side must have more than a plain straight line, else the resulting
  // contour would be degenerate.
  return [walk(points, indexA, indexB), walk(points, indexB, indexA)].every(
    (run) => run.length > 2,
  );
}

// Scissors node-to-node across contours. `contours` is the glyph's list of
// contours, `a` and `b` are { contourIndex, pointIndex } of on-curve nodes.
//
// - Same contour: split it in two (see cutContourBetweenNodes).
// - Different closed contours (e.g. the outer contour and a counter of an O or
//   Ø): join them into one contour through a zero-width slit along the cut.
//   The fill doesn't change, but a second cut across the same stroke then
//   splits the shape into two pieces.
//
// Returns the new list of contours, or undefined if the cut isn't possible.
// The joined contour takes the place of the lower contour index.
export function cutBetweenNodes(contours, a, b) {
  if (!canCutBetween(contours, a, b)) {
    return undefined;
  }
  const result = [...contours];
  if (a.contourIndex === b.contourIndex) {
    result.splice(
      a.contourIndex,
      1,
      ...cutContourBetweenNodes(
        contours[a.contourIndex],
        a.pointIndex,
        b.pointIndex,
      ),
    );
    return result;
  }
  const joined = joinContoursWithSlit(
    contours[a.contourIndex],
    a.pointIndex,
    contours[b.contourIndex],
    b.pointIndex,
  );
  const [first, second] = [a.contourIndex, b.contourIndex].sort(
    (x, y) => x - y,
  );
  result.splice(second, 1);
  result.splice(first, 1, joined);
  return result;
}

export function canCutBetween(contours, a, b) {
  if (!a || !b) {
    return false;
  }
  if (a.contourIndex === b.contourIndex) {
    const contour = contours[a.contourIndex];
    return (
      !!contour && canCutBetweenNodes(contour, a.pointIndex, b.pointIndex)
    );
  }
  const nodesOk = [a, b].every(({ contourIndex, pointIndex }) => {
    const contour = contours[contourIndex];
    return (
      contour?.isClosed &&
      contour.points[pointIndex] &&
      isOnCurve(contour.points[pointIndex])
    );
  });
  return nodesOk && canJoinContours(contours, a.contourIndex, b.contourIndex);
}

// Can two different closed contours be joined through a slit? Not if they run
// the same way (both clockwise or both anticlockwise) and both are at the top
// level (inside no other contour): those are separate shapes, such as the dot
// and the stem of an "i", or two overlapping strokes, even where they overlap.
// An outer contour and its counter (opposite directions) can be joined, and so
// can two counters inside the same outer contour (the two of 日).
export function canJoinContours(contours, indexA, indexB) {
  const areaA = signedArea(contours[indexA]);
  const areaB = signedArea(contours[indexB]);
  if (!areaA || !areaB) {
    return false;
  }
  if (Math.sign(areaA) !== Math.sign(areaB)) {
    return true;
  }
  const polygons = contours.map((contour) =>
    contour.isClosed ? flattenContour(contour) : undefined,
  );
  return !(isTopLevel(polygons, indexA) && isTopLevel(polygons, indexB));
}

// A contour is at the top level if no other closed contour holds all of it
function isTopLevel(polygons, index) {
  return !polygons.some(
    (polygon, other) =>
      other !== index &&
      polygon &&
      polygons[index].every((p) => pointInPolygon(p, polygon)),
  );
}

// Scissors clean-up: after a cut, the nodes at the given positions that now
// sit in the middle of a straight line (on-curve, both neighbours on-curve,
// the direction changing by at most `straightAngle` degrees) are redundant.
// Checked one after another, each against its current neighbours. Returns
// [{contourIndex, pointIndex}] in the given contours; remove them with
// removeNodes so every layer loses the same nodes.
export function redundantLineNodes(contours, positions, straightAngle = 5) {
  const tolerance = (straightAngle * Math.PI) / 180;
  const isAt = (p) => positions.some((q) => q.x === p.x && q.y === p.y);
  const result = [];
  contours.forEach((contour, contourIndex) => {
    if (!contour.isClosed) {
      return;
    }
    const alive = contour.points.map(() => true);
    const n = contour.points.length;
    const neighbour = (i, step) => {
      for (let k = 1; k < n; k++) {
        const j = (i + step * k + n * k) % n;
        if (alive[j]) {
          return j;
        }
      }
      return undefined;
    };
    contour.points.forEach((p, i) => {
      if (!isOnCurve(p) || !isAt(p)) {
        return;
      }
      if (alive.filter(Boolean).length <= 3) {
        return; // keep at least a triangle
      }
      const prev = contour.points[neighbour(i, -1)];
      const next = contour.points[neighbour(i, 1)];
      if (!prev || !next || !isOnCurve(prev) || !isOnCurve(next)) {
        return;
      }
      const u = subtract(p, prev);
      const v = subtract(next, p);
      if (!Math.hypot(u.x, u.y) || !Math.hypot(v.x, v.y)) {
        return;
      }
      if (angleBetween(u, v) <= tolerance) {
        alive[i] = false;
        result.push({ contourIndex, pointIndex: i });
      }
    });
  });
  return result;
}

// Remove nodes ({contourIndex, pointIndex}) from contours; returns new contours
export function removeNodes(contours, nodes) {
  return contours.map((contour, contourIndex) => {
    const drop = new Set(
      nodes
        .filter((node) => node.contourIndex === contourIndex)
        .map((node) => node.pointIndex),
    );
    if (!drop.size) {
      return contour;
    }
    return {
      ...contour,
      points: contour.points.filter((_, i) => !drop.has(i)).map(copyPoint),
    };
  });
}

// One closed contour: all of A starting and ending at node iA, then all of B
// starting and ending at node iB; the closing edge runs back along the slit.
export function joinContoursWithSlit(contourA, iA, contourB, iB) {
  const loop = (points, i) =>
    [...points.slice(i), ...points.slice(0, i + 1)].map(copyPoint);
  const partA = loop(contourA.points, iA);
  const partB = loop(contourB.points, iB);
  for (const point of [partA[0], partA.at(-1), partB[0], partB.at(-1)]) {
    delete point.smooth;
  }
  return { points: [...partA, ...partB], isClosed: true };
}

// Scissors "parallel split" of a crossing (X, +, the slash of Ø crossing the
// ring): four on-curve nodes, the inner corners of the crossing, on one or more
// closed contours. Each involved contour is cut at the corners into pieces, and
// the pieces are re-linked across the crossing with straight bridges, so that
// every edge runs on straight through it. The result: strokes that overlap in
// the crossing area (e.g. "\" and "/"), no separate crossover contour.
//
// `corners` are { contourIndex, pointIndex }. Each corner's bridge goes to the
// corner that best continues its edge: the pairing (a permutation, no corner to
// itself) with the smallest worst angle is chosen, and every angle between the
// arriving edge, the bridge and the leaving edge must be within `maxAngle`
// degrees. Pass `pairing` to reuse a pairing (e.g. the one chosen on the
// displayed glyph, for the other layers) without checking angles.
//
// Where both sides of a bridge are cubic curves, the bridge is a cubic curve
// extending their handles (`curveCubic: false` keeps all bridges straight).
//
// Returns { contours, bridges, pairing } where `contours` is the full new list
// (the involved contours replaced at the lowest involved index), or undefined.
export function parallelSplitContours(
  contours,
  corners,
  { maxAngle = 40, pairing, curveCubic = true } = {},
) {
  if (!isValidCornerSet(contours, corners, 4)) {
    return undefined;
  }
  const position = (c) => contours[c.contourIndex].points[c.pointIndex];
  if (!pairing) {
    pairing = bestPairing(contours, corners, (maxAngle * Math.PI) / 180);
    if (!pairing) {
      return undefined;
    }
  }

  // A bridge is a straight line, or, where the edge arrives at corner k on a
  // cubic curve and leaves corner pairing[k] on a cubic curve, a cubic curve
  // extending both handles (tangent-continuous: both corners become smooth)
  const bridgeHandles = corners.map((c, k) => {
    const target = corners[pairing[k]];
    const fromPoints = contours[c.contourIndex].points;
    const toPoints = contours[target.contourIndex].points;
    if (!curveCubic) {
      return undefined;
    }
    const n = fromPoints.length;
    const arrivesOnCurve =
      fromPoints[(c.pointIndex - 1 + n) % n].type === "cubic";
    const leavesOnCurve =
      toPoints[(target.pointIndex + 1) % toPoints.length].type === "cubic";
    if (!arrivesOnCurve || !leavesOnCurve) {
      return undefined;
    }
    return curvedBridgeHandles(
      fromPoints[c.pointIndex],
      incomingDirection(fromPoints, c.pointIndex),
      toPoints[target.pointIndex],
      outgoingDirection(toPoints, target.pointIndex),
    );
  });
  const { contours: result } = relinkAtCorners(
    contours,
    corners,
    pairing,
    bridgeHandles.map((handles) => handles ?? []),
    bridgeHandles.map((handles) => !!handles),
  );
  return {
    contours: result,
    // [from, to] or, for curved bridges, [from, to, handle1, handle2]
    bridges: corners.map((c, k) => [
      position(c),
      position(corners[pairing[k]]),
      ...(bridgeHandles[k] ?? []),
    ]),
    pairing,
  };
}

// Scissors "extension split" of a junction with two corners (T, Λ under a bar,
// two chevrons touching, an "e" bar running into the bowl). The corners may be
// on the same closed contour or on two (e.g. the counter and the outer contour
// of an "e"). The contours are cut at the corners into pieces, and the pieces
// are re-linked by extending their edges straight on beyond the corners (along
// their tangents): the edge arriving at one corner continues out of the other.
//
// - "straight": the edges are in line (a bar's edge running on): a straight
//   bridge from corner to corner.
// - "point": the extended edges converge: they run on to where they meet (an
//   apex, a diamond tip), however deep, as long as that point is inside the
//   outline.
// - "cap": otherwise (parallel or diverging edges, or the meeting point would
//   stick out of the outline): both edges run on `maxDepth` (50%) of the way
//   across the stroke they enter, measured along the edge to where it would
//   hit the outline on the other side (e.g. a bar's far edge), and are joined
//   there with a straight cap.
//
// Corners on one contour give two contours that overlap where the junction
// was; corners on two contours join them into one. Pass `kinds` (as returned)
// to build other layers with the same structure.
//
// `corners` are { contourIndex, pointIndex }. Returns { contours, bridges,
// kinds } where `contours` is the full new list and bridges[k] is the polyline
// [corner k, ...extra points, other corner], or undefined.
export function extensionSplitContours(
  contours,
  corners,
  { kinds, straightAngle = 5, maxDepth = 0.5 } = {},
) {
  if (!isValidCornerSet(contours, corners, 2)) {
    return undefined;
  }
  const pairing = [1, 0];
  const tolerance = (straightAngle * Math.PI) / 180;
  const position = (c) => contours[c.contourIndex].points[c.pointIndex];
  // a short straight step right at a corner (a notch, like the 3-unit step
  // at the foot of Source Han Sans' "a" stem) doesn't set the edge's
  // direction: the edge before it does
  const stubLength =
    STUB_FRACTION * distance(position(corners[0]), position(corners[1]));
  const bridges = [];
  for (const [k, from] of corners.entries()) {
    const to = corners[pairing[k]];
    const bridge = extensionBridge(
      contours,
      position(from),
      edgeDirection(contours[from.contourIndex].points, from.pointIndex, -1, stubLength),
      position(to),
      edgeDirection(contours[to.contourIndex].points, to.pointIndex, 1, stubLength),
      kinds?.[k],
      tolerance,
      maxDepth,
    );
    if (!bridge) {
      return undefined;
    }
    bridges.push(bridge);
  }
  const { contours: result, newContours } = relinkAtCorners(
    contours,
    corners,
    pairing,
    bridges.map((bridge) => bridge.extra),
  );
  if (newContours.some((c) => c.points.length < 3)) {
    return undefined;
  }
  return {
    contours: result,
    bridges: corners.map((c, k) => [
      position(c),
      ...bridges[k].extra,
      position(corners[pairing[k]]),
    ]),
    kinds: bridges.map((bridge) => bridge.kind),
  };
}

// Straight steps shorter than this fraction of the corner distance are skipped
// when taking an edge's direction at a corner
const STUB_FRACTION = 0.25;

// Direction of the edge arriving at (step -1) or leaving (step 1)
// points[index] of a closed contour, always pointing forward along the
// contour. Short straight steps (on-curve to on-curve, shorter than
// `stubLength`) are skipped: the direction comes from the edge beyond them.
function edgeDirection(points, index, step, stubLength = 0) {
  const n = points.length;
  let i = index;
  for (let guard = 0; guard < n; guard++) {
    let j = i;
    let other;
    do {
      j = (j + step + n) % n;
      other = points[j];
    } while (j !== i && other.x === points[i].x && other.y === points[i].y);
    if (j === i || j === index) {
      break;
    }
    const isStub =
      isOnCurve(other) && distance(other, points[i]) < stubLength;
    if (!isStub) {
      return step < 0 ? subtract(points[i], other) : subtract(other, points[i]);
    }
    i = j; // skip the stub
  }
  return step < 0
    ? incomingDirection(points, index)
    : outgoingDirection(points, index);
}

// Single-contour convenience wrapper
export function extensionSplitContour(
  contours,
  contourIndex,
  pointIndices,
  options,
) {
  return extensionSplitContours(
    contours,
    pointIndices.map((pointIndex) => ({ contourIndex, pointIndex })),
    options,
  );
}

// Cut the contours that hold the corners into pieces running from corner to
// corner (a contour with one corner becomes one loop), and re-link them: after
// the piece ending at corner k come extras[k] (the bridge's inner points), then
// the piece starting at corner pairing[k]. If smooth[k], the bridge is
// tangent-continuous and both its corners become smooth.
// Returns { contours: the full new list, newContours }; the new contours take
// the place of the lowest involved contour index.
function relinkAtCorners(contours, corners, pairing, extras, smooth = []) {
  const involved = [...new Set(corners.map((c) => c.contourIndex))].sort(
    (a, b) => a - b,
  );
  const pieceStartingAt = new Map(); // corner number -> piece
  for (const contourIndex of involved) {
    const points = contours[contourIndex].points;
    const cornerNumbers = corners
      .map((c, k) => [c, k])
      .filter(([c]) => c.contourIndex === contourIndex)
      .sort(([a], [b]) => a.pointIndex - b.pointIndex)
      .map(([, k]) => k);
    cornerNumbers.forEach((k, i) => {
      const end = cornerNumbers[(i + 1) % cornerNumbers.length];
      const from = corners[k].pointIndex;
      const piecePoints =
        end === k
          ? [...points.slice(from), ...points.slice(0, from + 1)] // whole loop
          : walk(points, from, corners[end].pointIndex);
      pieceStartingAt.set(k, { start: k, end, points: piecePoints });
    });
  }
  const smoothStarts = new Set(
    corners.map((_, k) => (smooth[k] ? pairing[k] : undefined)),
  );

  const newContours = [];
  const used = new Set();
  for (let k = 0; k < corners.length; k++) {
    if (used.has(k)) {
      continue;
    }
    const contourPoints = [];
    let piece = pieceStartingAt.get(k);
    while (!used.has(piece.start)) {
      used.add(piece.start);
      const piecePoints = piece.points.map(copyPoint);
      delete piecePoints[0].smooth;
      delete piecePoints.at(-1).smooth;
      if (smoothStarts.has(piece.start)) {
        piecePoints[0].smooth = true;
      }
      if (smooth[piece.end]) {
        piecePoints.at(-1).smooth = true;
      }
      contourPoints.push(...piecePoints, ...(extras[piece.end] ?? []));
      piece = pieceStartingAt.get(pairing[piece.end]);
    }
    newContours.push({ points: contourPoints, isClosed: true });
  }

  const result = contours.filter((_, i) => !involved.includes(i));
  result.splice(involved[0], 0, ...newContours);
  return { contours: result, newContours };
}

// The extra on-curve points of a bridge from `from` (arriving in direction
// dirIn) to `to` (leaving in direction dirOut); see extensionSplitContour.
function extensionBridge(
  contours,
  from,
  dirIn,
  to,
  dirOut,
  kind,
  tolerance,
  maxDepth,
) {
  const u = dirIn && normalize(dirIn);
  const v = dirOut && normalize(dirOut);
  const chord = subtract(to, from);
  if (!u || !v || !Math.hypot(chord.x, chord.y)) {
    return undefined;
  }
  const backward = { x: -v.x, y: -v.y };
  if (!kind) {
    if (
      angleBetween(u, chord) <= tolerance &&
      angleBetween(chord, v) <= tolerance
    ) {
      kind = "straight";
    } else {
      const meeting = intersectRays(from, u, to, backward);
      const hitFrom = rayHit(contours, from, u);
      const hitTo = rayHit(contours, to, backward);
      const slack = 1; // font units
      if (
        meeting &&
        (!hitFrom || meeting.s <= hitFrom.distance + slack) &&
        (!hitTo || meeting.t <= hitTo.distance + slack)
      ) {
        kind = "point";
      } else if (hitFrom && hitTo) {
        kind = "cap";
      } else {
        return undefined;
      }
    }
  }
  if (kind === "straight") {
    return { kind, extra: [] };
  }
  if (kind === "point") {
    const meeting = intersectLines(from, u, to, backward);
    return meeting && { kind, extra: [roundPoint(meeting.point)] };
  }
  const hitFrom = rayHit(contours, from, u);
  const hitTo = rayHit(contours, to, backward);
  if (!hitFrom || !hitTo) {
    return undefined;
  }
  return {
    kind,
    extra: [
      roundPoint(addScaled(from, u, maxDepth * hitFrom.distance)),
      roundPoint(addScaled(to, backward, maxDepth * hitTo.distance)),
    ],
  };
}

function addScaled(p, u, s) {
  return { x: p.x + u.x * s, y: p.y + u.y * s };
}

// Intersection of lines p + s·u and q + t·w: { point, s, t }, or undefined if
// parallel
function intersectLines(p, u, q, w) {
  const denominator = u.x * w.y - u.y * w.x;
  if (Math.abs(denominator) < 1e-9) {
    return undefined;
  }
  const d = subtract(q, p);
  const s = (d.x * w.y - d.y * w.x) / denominator;
  const t = (d.x * u.y - d.y * u.x) / denominator;
  return { point: { x: p.x + s * u.x, y: p.y + s * u.y }, s, t };
}

// Intersection of rays (s > 0 and t > 0 only)
function intersectRays(p, u, q, w) {
  const meeting = intersectLines(p, u, q, w);
  return meeting && meeting.s > 1e-6 && meeting.t > 1e-6 ? meeting : undefined;
}

// Nearest point where the ray origin + s·dir (s > a small minimum, so the ray
// doesn't hit the outline at its own origin) crosses any contour.
// Returns { point, distance } or undefined.
export function rayHit(contours, origin, dir, minDistance = 0.5) {
  const u = normalize(dir);
  if (!u) {
    return undefined;
  }
  const side = (p) => u.x * (p.y - origin.y) - u.y * (p.x - origin.x);
  const along = (p) => u.x * (p.x - origin.x) + u.y * (p.y - origin.y);
  let best;
  for (const contour of contours) {
    for (const segment of getSegments(contour)) {
      const pieces = decomposeSegment(
        segmentPoints(contour, segment),
        segmentType(contour, segment),
      );
      for (const piece of pieces ?? [segmentPoints(contour, segment)]) {
        const steps = piece.length === 2 ? 1 : SAMPLE_STEPS;
        let t0 = 0;
        let p0 = piece[0];
        for (let i = 1; i <= steps; i++) {
          const t1 = i / steps;
          const p1 = piece.length === 2 ? piece[1] : evalBezier(piece, t1);
          if (side(p0) * side(p1) <= 0 && side(p0) !== side(p1)) {
            // refine the crossing by bisection on the curve parameter
            let [lo, hi] = [t0, t1];
            for (let iter = 0; iter < 40; iter++) {
              const mid = (lo + hi) / 2;
              const pm = evalBezier(piece, mid);
              if (side(evalBezier(piece, lo)) * side(pm) <= 0) {
                hi = mid;
              } else {
                lo = mid;
              }
            }
            const point = evalBezier(piece, (lo + hi) / 2);
            const distance = along(point);
            if (distance > minDistance && (!best || distance < best.distance)) {
              best = { point, distance };
            }
          }
          t0 = t1;
          p0 = p1;
        }
      }
    }
  }
  return best;
}

// Single-contour convenience wrapper: returns { contours: [the new contours],
// bridges } or undefined.
export function parallelSplitContour(contour, pointIndices, maxAngle = 40) {
  const corners = [...new Set(pointIndices)].map((pointIndex) => ({
    contourIndex: 0,
    pointIndex,
  }));
  return parallelSplitContours([contour], corners, { maxAngle });
}

function isValidCornerSet(contours, corners, count) {
  const keys = new Set(corners.map((c) => `${c.contourIndex}/${c.pointIndex}`));
  return (
    corners.length === count &&
    keys.size === count &&
    corners.every(({ contourIndex, pointIndex }) => {
      const contour = contours[contourIndex];
      const point = contour?.points[pointIndex];
      return contour?.isClosed && point && isOnCurve(point);
    })
  );
}

// The corner pairing (pairing[k] = corner bridged to after arriving at corner k)
// whose worst angle is smallest, if within `limit` radians
function bestPairing(contours, corners, limit) {
  const position = (c) => contours[c.contourIndex].points[c.pointIndex];
  const incoming = corners.map((c) =>
    incomingDirection(contours[c.contourIndex].points, c.pointIndex),
  );
  const outgoing = corners.map((c) =>
    outgoingDirection(contours[c.contourIndex].points, c.pointIndex),
  );
  if (incoming.some((d) => !d) || outgoing.some((d) => !d)) {
    return undefined;
  }
  // worst angle of bridging from corner a to corner b
  const cost = (a, b) => {
    const bridge = subtract(position(corners[b]), position(corners[a]));
    return Math.max(
      angleBetween(incoming[a], bridge),
      angleBetween(bridge, outgoing[b]),
    );
  };
  let best;
  let bestCost = Infinity;
  for (const pairing of permutations([0, 1, 2, 3])) {
    if (pairing.some((b, a) => a === b)) {
      continue;
    }
    const worst = Math.max(...pairing.map((b, a) => cost(a, b)));
    if (worst < bestCost) {
      bestCost = worst;
      best = pairing;
    }
  }
  return bestCost <= limit ? best : undefined;
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) {
      yield [items[i], ...perm];
    }
  }
}

// Cubic handles for a bridge from `from` (arriving in direction `tIn`) to `to`
// (leaving in direction `tOut`): along those directions, with the circular-arc
// handle length for the turn between them (a third of the chord when parallel).
function curvedBridgeHandles(from, tIn, to, tOut) {
  const d = distance(from, to);
  const u = normalize(tIn);
  const v = normalize(tOut);
  if (!d || !u || !v) {
    return undefined;
  }
  const theta = angleBetween(u, v);
  const h =
    theta < 1e-6
      ? d / 3
      : Math.min(
          d,
          ((4 / 3) * Math.tan(theta / 4) * d) / (2 * Math.sin(theta / 2)),
        );
  return [
    {
      ...roundPoint({ x: from.x + u.x * h, y: from.y + u.y * h }),
      type: "cubic",
    },
    { ...roundPoint({ x: to.x - v.x * h, y: to.y - v.y * h }), type: "cubic" },
  ];
}

function normalize(v) {
  const length = Math.hypot(v.x, v.y);
  return length ? { x: v.x / length, y: v.y / length } : undefined;
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function angleBetween(u, v) {
  const lengths = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y);
  if (!lengths) {
    return Infinity;
  }
  return Math.acos(
    Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / lengths)),
  );
}

// Direction in which a closed contour arrives at points[index] (from the
// previous point at a different position, on- or off-curve)
function incomingDirection(points, index) {
  for (let k = 1; k < points.length; k++) {
    const prev = points[(index - k + points.length) % points.length];
    if (prev.x !== points[index].x || prev.y !== points[index].y) {
      return subtract(points[index], prev);
    }
  }
  return undefined;
}

// Direction in which a closed contour leaves points[index]
function outgoingDirection(points, index) {
  for (let k = 1; k < points.length; k++) {
    const next = points[(index + k) % points.length];
    if (next.x !== points[index].x || next.y !== points[index].y) {
      return subtract(next, points[index]);
    }
  }
  return undefined;
}

// Points from index `from` to index `to` (inclusive), walking forward with wrap
function walk(points, from, to) {
  const result = [];
  let i = from;
  for (;;) {
    result.push(points[i]);
    if (i === to) {
      break;
    }
    i = (i + 1) % points.length;
  }
  return result;
}

//
// Matchmaker
//

// Make on-curve node `pointIndex` the start point of a closed contour. Returns
// the new contour, or undefined (open contour, off-curve point, or already the
// start point).
export function setContourStartPoint(contour, pointIndex) {
  const points = contour.points;
  if (
    !contour.isClosed ||
    pointIndex <= 0 ||
    !points[pointIndex] ||
    !isOnCurve(points[pointIndex])
  ) {
    return undefined;
  }
  return {
    points: [...points.slice(pointIndex), ...points.slice(0, pointIndex)].map(
      copyPoint,
    ),
    isClosed: true,
  };
}

// Align the start points of corresponding closed contours (one per layer)
// relative to corresponding nodes: `nodeIndices[i]` is the point index of the
// selected node in `contours[i]`. Each contour's start point moves so that it
// lies as many nodes before the selected node as in the reference contour.
// Returns the contours, a new one where the start point moved. Open contours
// and contours whose selected index isn't an on-curve node stay as they are.
export function alignStartPoints(contours, nodeIndices, referenceIndex = 0) {
  // the node's position among the on-curve nodes, or -1
  const nodeOrdinal = (contour, pointIndex) =>
    contour ? onCurveIndices(contour).indexOf(pointIndex) : -1;
  const reference = contours[referenceIndex];
  const offset = nodeOrdinal(reference, nodeIndices[referenceIndex]);
  if (!reference?.isClosed || offset < 0) {
    return contours;
  }
  return contours.map((contour, i) => {
    const ordinal = nodeOrdinal(contour, nodeIndices[i]);
    if (i === referenceIndex || !contour.isClosed || ordinal < 0) {
      return contour;
    }
    const onCurves = onCurveIndices(contour);
    const n = onCurves.length;
    const start = onCurves[(((ordinal - offset) % n) + n) % n];
    return setContourStartPoint(contour, start) || contour;
  });
}

// Compare the contours of several layers (arrays of unpacked contours).
// Returns { compatible, issues: [ { contourIndex?, message } ] }
export function checkCompatibility(layerContours, layerNames) {
  const issues = [];
  if (layerContours.length < 2) {
    return { compatible: true, issues };
  }
  const [reference, ...others] = layerContours;
  others.forEach((contours, k) => {
    const name = layerNames?.[k + 1] ?? `#${k + 1}`;
    if (contours.length !== reference.length) {
      issues.push({
        message: `${name}: ${contours.length} contours, expected ${reference.length}`,
      });
    }
  });
  const numContours = Math.min(
    ...layerContours.map((contours) => contours.length),
  );
  for (let contourIndex = 0; contourIndex < numContours; contourIndex++) {
    const contours = layerContours.map((contours) => contours[contourIndex]);
    const signatures = contours.map(contourSignature);
    if (new Set(contours.map((c) => c.isClosed)).size > 1) {
      issues.push({ contourIndex, message: "open/closed mismatch" });
    } else if (new Set(signatures).size > 1) {
      const counts = contours.map((c) => onCurveIndices(c).length);
      issues.push({
        contourIndex,
        message:
          new Set(counts).size > 1
            ? `node counts differ (${counts.join(" / ")})`
            : "segment types differ",
      });
    }
  }
  return { compatible: !issues.length, issues };
}

export function contourSignature(contour) {
  return (
    (contour.isClosed ? "C" : "O") +
    contour.points.map((p) => p.type?.[0] ?? "o").join("")
  );
}

export function isContourSetCompatible(contours) {
  return new Set(contours.map(contourSignature)).size <= 1;
}

// Indices of the segments that run from node `fromIndex` to node `toIndex`,
// walking forward. For open contours the direction is chosen so that the walk
// doesn't fall off the end. Returns undefined if not possible.
export function segmentRun(contour, fromIndex, toIndex) {
  const segments = getSegments(contour);
  const startSeg = segments.findIndex((s) => s.startIndex === fromIndex);
  if (fromIndex === toIndex) {
    return undefined;
  }
  if (!contour.isClosed && fromIndex > toIndex) {
    return undefined;
  }
  if (startSeg < 0) {
    return undefined;
  }
  const run = [];
  for (let k = 0; k < segments.length; k++) {
    const segIndex = (startSeg + k) % segments.length;
    run.push(segIndex);
    if (segments[segIndex].endIndex === toIndex) {
      return run;
    }
  }
  return undefined;
}

// Insert `count` new on-curve nodes into the segment run between `fromPoint`
// and `toPoint` by repeatedly splitting the longest segment of the run in half.
function addNodesToRun(contour, fromPoint, toPoint, count) {
  for (let n = 0; n < count; n++) {
    const run = segmentRun(
      contour,
      contour.points.indexOf(fromPoint),
      contour.points.indexOf(toPoint),
    );
    if (!run) {
      return undefined;
    }
    const segments = getSegments(contour);
    let longest = run[0];
    let longestLength = -1;
    for (const segIndex of run) {
      const length = segmentLength(contour, segments[segIndex]);
      if (length > longestLength) {
        longestLength = length;
        longest = segIndex;
      }
    }
    const result = splitSegment(contour, longest, 0.5);
    if (!result) {
      return undefined;
    }
    contour = result.contour;
  }
  return contour;
}

// Matchmaker "make segment compatible": for each layer, `contours[i]` is the
// contour and `fromIndices[i]`/`toIndices[i]` the nodes bounding the segment
// run (the blue and orange groups). Nodes are added so every layer has the same
// number of nodes along the run, and segment types are unified where layers
// disagree. Returns the new contours, or undefined.
export function matchSegmentRun(contours, fromIndices, toIndices) {
  const ends = contours.map((contour, i) => {
    let [from, to] = [fromIndices[i], toIndices[i]];
    if (!contour.isClosed && from > to) {
      [from, to] = [to, from];
    }
    return [contour.points[from], contour.points[to]];
  });
  const runOf = (c, i) =>
    segmentRun(c, c.points.indexOf(ends[i][0]), c.points.indexOf(ends[i][1]));
  const runs = contours.map(runOf);
  if (runs.some((run) => !run)) {
    return undefined;
  }
  const target = Math.max(...runs.map((run) => run.length));
  const result = [];
  for (let i = 0; i < contours.length; i++) {
    const missing = target - runs[i].length;
    const contour = missing
      ? addNodesToRun(contours[i], ends[i][0], ends[i][1], missing)
      : contours[i];
    if (!contour) {
      return undefined;
    }
    result.push(contour);
  }
  const newRuns = result.map(runOf);
  if (newRuns.some((run) => !run || run.length !== target)) {
    return undefined;
  }
  return unifySegmentTypes(result, newRuns);
}

// Given contours with equal node counts along corresponding segment index runs,
// convert segments where layers disagree on the type: lines and quadratic
// segments become cubic if any layer is cubic, lines become quadratic if any
// layer is quadratic.
export function unifySegmentTypes(contours, runs) {
  contours = contours.map(copyContour);
  if (!runs) {
    const numSegments = getSegments(contours[0]).length;
    runs = contours.map(() => range(0, numSegments));
  }
  for (let k = 0; k < runs[0].length; k++) {
    const types = contours.map((c, i) =>
      segmentType(c, getSegments(c)[runs[i][k]]),
    );
    if (new Set(types).size === 1) {
      continue;
    }
    const target = types.includes("cubic") ? "cubic" : "quad";
    for (let i = 0; i < contours.length; i++) {
      if (types[i] === target) {
        continue;
      }
      const segment = getSegments(contours[i])[runs[i][k]];
      const converted = convertSegment(contours[i], segment, target);
      if (converted) {
        contours[i] = converted;
      }
    }
  }
  return contours;
}

function convertSegment(contour, segment, targetType) {
  const pts = segmentPoints(contour, segment);
  let inner;
  if (targetType === "quad" && pts.length === 2) {
    inner = [lerpPoint(pts[0], pts[1], 0.5)];
  } else if (targetType === "cubic" && pts.length === 2) {
    inner = [
      lerpPoint(pts[0], pts[1], 1 / 3),
      lerpPoint(pts[0], pts[1], 2 / 3),
    ];
  } else if (targetType === "cubic" && pts.length === 3) {
    // exact quadratic -> cubic degree elevation
    inner = [
      lerpPoint(pts[0], pts[1], 2 / 3),
      lerpPoint(pts[2], pts[1], 2 / 3),
    ];
  } else {
    return undefined;
  }
  return replaceSegmentInner(
    contour,
    segment,
    inner.map((p) => ({ ...roundPoint(p), type: targetType })),
  ).contour;
}

// Matchmaker "Match Masters": try to make the given contours (one per layer)
// compatible automatically. Nodes are aligned by their relative position along
// the contour (arc length), assuming the start points correspond; missing
// nodes are inserted. Returns new contours, or undefined if not possible.
export function autoMatchContours(contours) {
  if (new Set(contours.map((c) => c.isClosed)).size > 1) {
    return undefined;
  }
  if (contours.some((c) => !decomposableContour(c))) {
    return undefined;
  }
  let referenceIndex = 0;
  const nodeCounts = contours.map((c) => onCurveIndices(c).length);
  nodeCounts.forEach((count, i) => {
    if (count > nodeCounts[referenceIndex]) {
      referenceIndex = i;
    }
  });
  const reference = contours[referenceIndex];
  const refFractions = nodeFractions(reference);

  const matched = contours.map((contour, i) => {
    if (i === referenceIndex || nodeCounts[i] === nodeCounts[referenceIndex]) {
      return copyContour(contour);
    }
    return insertNodesToMatch(contour, refFractions);
  });
  if (matched.some((c) => !c)) {
    return undefined;
  }
  if (new Set(matched.map((c) => onCurveIndices(c).length)).size > 1) {
    return undefined;
  }
  return unifySegmentTypes(matched);
}

function decomposableContour(contour) {
  return getSegments(contour).every((s) =>
    decomposeSegment(segmentPoints(contour, s), segmentType(contour, s)),
  );
}

// Relative arc-length position (0..1) of each on-curve node, in node order.
export function nodeFractions(contour) {
  const segments = getSegments(contour);
  const lengths = segments.map((s) => segmentLength(contour, s));
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  const fractions = [0];
  let acc = 0;
  for (let i = 0; i < lengths.length - (contour.isClosed ? 1 : 0); i++) {
    acc += lengths[i];
    fractions.push(acc / total);
  }
  return fractions;
}

function insertNodesToMatch(contour, refFractions) {
  const fractions = nodeFractions(contour);
  const mapping = alignFractions(fractions, refFractions, !contour.isClosed);
  if (!mapping) {
    return undefined;
  }
  // For each of our segments, collect reference fractions that fall between the
  // reference nodes our segment ends are mapped to.
  const segments = getSegments(contour);
  const insertions = []; // [segmentIndex, [t, ...]]
  for (let s = 0; s < segments.length; s++) {
    const refStart = mapping[s];
    const refEnd =
      s + 1 < mapping.length ? mapping[s + 1] : refFractions.length;
    const missing = [];
    for (let r = refStart + 1; r < refEnd; r++) {
      missing.push(refFractions[r]);
    }
    if (!missing.length) {
      continue;
    }
    const f0 = refFractions[refStart];
    const f1 = refEnd < refFractions.length ? refFractions[refEnd] : 1;
    const span = f1 - f0 || 1;
    insertions.push([
      s,
      missing.map((f) => clamp((f - f0) / span, 0.01, 0.99)),
    ]);
  }
  // Insert from the last segment backwards so earlier segment indices stay valid
  for (const [segmentIndex, ts] of insertions.reverse()) {
    // Split from the end of the segment backwards: the left part keeps the
    // segment index, and the remaining t values are rescaled onto it.
    let scale = 1;
    for (const t of [...ts].sort((a, b) => b - a)) {
      const result = splitSegment(contour, segmentIndex, t / scale);
      if (!result) {
        return undefined;
      }
      contour = result.contour;
      scale = t;
    }
  }
  return contour;
}

// Order-preserving alignment of `fractions` (fewer nodes) onto `refFractions`
// minimizing total distance. Node 0 maps to node 0 (and, if `pinEnd`, the last
// node to the last node). Returns an array mapping each of our node indices to a
// reference node index.
export function alignFractions(fractions, refFractions, pinEnd = false) {
  const n = fractions.length;
  const m = refFractions.length;
  if (n > m || n === 0) {
    return undefined;
  }
  // cost[i][j]: best cost mapping first i+1 nodes with node i -> ref j
  const cost = Array.from({ length: n }, () => new Array(m).fill(Infinity));
  const back = Array.from({ length: n }, () => new Array(m).fill(-1));
  cost[0][0] = 0;
  for (let i = 1; i < n; i++) {
    for (let j = i; j <= m - (n - i); j++) {
      const c = Math.abs(fractions[i] - refFractions[j]);
      for (let k = i - 1; k < j; k++) {
        if (cost[i - 1][k] + c < cost[i][j]) {
          cost[i][j] = cost[i - 1][k] + c;
          back[i][j] = k;
        }
      }
    }
  }
  if (n === 1) {
    return [0];
  }
  let bestJ = pinEnd ? m - 1 : n - 1;
  for (let j = n - 1; j < m && !pinEnd; j++) {
    if (cost[n - 1][j] < cost[n - 1][bestJ]) {
      bestJ = j;
    }
  }
  const mapping = new Array(n);
  for (let i = n - 1, j = bestJ; i >= 0; i--) {
    mapping[i] = j;
    j = back[i][j];
  }
  return mapping;
}

//
// Force match masters: contour order, direction and start points
//

// The outline as a polyline: on-curve points plus sampled curve points. For a
// closed contour the first point is not repeated at the end.
function flattenContour(contour, steps = SAMPLE_STEPS) {
  const result = [];
  for (const segment of getSegments(contour)) {
    const pts = segmentPoints(contour, segment);
    const type = segmentType(contour, segment);
    const pieces = decomposeSegment(pts, type) ?? [pts];
    for (const piece of pieces) {
      if (!result.length) {
        result.push(piece[0]);
      }
      if (piece.length === 2) {
        result.push(piece[1]);
      } else {
        for (let i = 1; i <= steps; i++) {
          result.push(evalBezier(piece, i / steps));
        }
      }
    }
  }
  if (contour.isClosed && result.length > 1) {
    result.pop(); // the last point is the start point again
  }
  return result.length ? result : contour.points.filter(isOnCurve);
}

// Bounding box of the outline (not of the control points)
export function contourBounds(contour) {
  return boundsOfPoints(flattenContour(contour));
}

// Bounding box of several contours
export function glyphBounds(contours) {
  return boundsOfPoints(contours.flatMap((c) => flattenContour(c)));
}

function boundsOfPoints(points) {
  if (!points.length) {
    return undefined;
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    xMin: Math.min(...xs),
    yMin: Math.min(...ys),
    xMax: Math.max(...xs),
    yMax: Math.max(...ys),
  };
}

// A function mapping a point to the 0..1 square of `bounds`
function normalizer(bounds) {
  const width = Math.max(bounds.xMax - bounds.xMin, 1);
  const height = Math.max(bounds.yMax - bounds.yMin, 1);
  return (p) => ({
    x: (p.x - bounds.xMin) / width,
    y: (p.y - bounds.yMin) / height,
  });
}

// Signed area of a closed contour (positive: counter-clockwise in y-up font
// coordinates). 0 for open or degenerate contours.
export function signedArea(contour) {
  if (!contour.isClosed) {
    return 0;
  }
  const points = flattenContour(contour);
  let area = 0;
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length];
    area += p.x * q.y - q.x * p.y;
  });
  return area / 2;
}

// The contour drawn the other way round. A closed contour keeps its start
// node; an open contour starts at its old end.
export function reverseContour(contour) {
  const points = contour.points.map(copyPoint);
  return {
    points: contour.isClosed
      ? [points[0], ...points.slice(1).reverse()]
      : points.reverse(),
    isClosed: contour.isClosed,
  };
}

// Direction (sign of signedArea) of the outermost contour: the largest of the
// top-level closed contours (those no other contour holds). 0 if none.
export function outerDirection(contours) {
  const polygons = contours.map((contour) =>
    contour.isClosed ? flattenContour(contour) : undefined,
  );
  let best = 0;
  let bestArea = 0;
  contours.forEach((contour, i) => {
    if (!polygons[i] || !isTopLevel(polygons, i)) {
      return;
    }
    const area = signedArea(contour);
    if (Math.abs(area) > bestArea) {
      bestArea = Math.abs(area);
      best = Math.sign(area);
    }
  });
  return best;
}

// If the outermost contour runs the other way from the reference's, every
// closed contour reversed (each keeps its start node), so the whole master
// follows the reference's direction convention. Otherwise undefined.
export function matchOuterDirection(referenceContours, contours) {
  const a = outerDirection(referenceContours);
  const b = outerDirection(contours);
  if (!a || !b || a === b) {
    return undefined;
  }
  return contours.map((contour) =>
    contour.isClosed ? reverseContour(contour) : contour,
  );
}

// A function mapping a relative arc length f (0..1, from the start point) to
// the point on the outline there. For a closed contour f wraps around.
function arcLengthSampler(contour) {
  const points = flattenContour(contour);
  if (contour.isClosed) {
    points.push(points[0]);
  }
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(lengths[i - 1] + distance(points[i - 1], points[i]));
  }
  const total = lengths.at(-1);
  return (f) => {
    if (!total) {
      return points[0];
    }
    const wrapped = contour.isClosed ? ((f % 1) + 1) % 1 : clamp(f, 0, 1);
    const target = wrapped * total;
    let lo = 0;
    let hi = lengths.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lengths[mid] <= target) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const span = lengths[hi] - lengths[lo] || 1;
    return lerpPoint(points[lo], points[hi], (target - lengths[lo]) / span);
  };
}

// The point at relative arc length f (0..1) from the start point
export function pointAtFraction(contour, f) {
  return arcLengthSampler(contour)(f);
}

// Minimum-cost assignment for a square cost matrix (Hungarian algorithm).
// Returns `assignment` with assignment[row] = column.
export function minCostAssignment(cost) {
  const n = cost.length;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const columnRow = new Array(n + 1).fill(0); // column -> row, 1-based
  const way = new Array(n + 1).fill(0);
  for (let row = 1; row <= n; row++) {
    columnRow[0] = row;
    let column0 = 0;
    const minValue = new Array(n + 1).fill(Infinity);
    const used = new Array(n + 1).fill(false);
    do {
      used[column0] = true;
      const row0 = columnRow[column0];
      let delta = Infinity;
      let column1 = 0;
      for (let column = 1; column <= n; column++) {
        if (used[column]) {
          continue;
        }
        const current = cost[row0 - 1][column - 1] - u[row0] - v[column];
        if (current < minValue[column]) {
          minValue[column] = current;
          way[column] = column0;
        }
        if (minValue[column] < delta) {
          delta = minValue[column];
          column1 = column;
        }
      }
      for (let column = 0; column <= n; column++) {
        if (used[column]) {
          u[columnRow[column]] += delta;
          v[column] -= delta;
        } else {
          minValue[column] -= delta;
        }
      }
      column0 = column1;
    } while (columnRow[column0] !== 0);
    do {
      const column1 = way[column0];
      columnRow[column0] = columnRow[column1];
      column0 = column1;
    } while (column0);
  }
  const assignment = new Array(n);
  for (let column = 1; column <= n; column++) {
    if (columnRow[column]) {
      assignment[columnRow[column] - 1] = column - 1;
    }
  }
  return assignment;
}

const OPEN_CLOSED_PENALTY = 10;
const DIRECTION_PENALTY = 1;
// Per node of difference in node count: small, so it only breaks ties
// between contours the geometry can't tell apart (two identical dots).
const NODE_COUNT_TIE = 0.001;

// Which contour of `contours` corresponds to each contour of
// `referenceContours`, judged by their bounding boxes relative to the whole
// glyph (so masters of different weight and width compare), preferring
// contours that are both open or both closed and that run the same way.
// Ties are broken by the difference in on-curve node count.
// Returns `order` with contours[order[k]] matching referenceContours[k], or
// undefined if the counts differ.
export function matchContourOrder(referenceContours, contours) {
  const n = referenceContours.length;
  if (contours.length !== n) {
    return undefined;
  }
  if (n < 2) {
    return n ? [0] : [];
  }
  const describe = (list) => {
    const normalize = normalizer(glyphBounds(list));
    return list.map((contour) => {
      const bounds = contourBounds(contour);
      const min = normalize({ x: bounds.xMin, y: bounds.yMin });
      const max = normalize({ x: bounds.xMax, y: bounds.yMax });
      return {
        center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 },
        width: max.x - min.x,
        height: max.y - min.y,
        isClosed: contour.isClosed,
        direction: Math.sign(signedArea(contour)),
        nodeCount: onCurveIndices(contour).length,
      };
    });
  };
  const reference = describe(referenceContours);
  const candidates = describe(contours);
  const cost = reference.map((r) =>
    candidates.map(
      (c) =>
        distance(r.center, c.center) +
        Math.abs(r.width - c.width) +
        Math.abs(r.height - c.height) +
        (r.isClosed !== c.isClosed ? OPEN_CLOSED_PENALTY : 0) +
        (r.direction && c.direction && r.direction !== c.direction
          ? DIRECTION_PENALTY
          : 0) +
        NODE_COUNT_TIE * Math.abs(r.nodeCount - c.nodeCount),
    ),
  );
  return minCostAssignment(cost);
}

const START_SAMPLES = 32;

// Rotate each closed contour so its start point corresponds to the reference
// contour's: of all its on-curve nodes, the start is the one for which the
// whole outline, walked from there, stays closest to the reference outline
// walked from its start. Both are compared inside their own bounding boxes,
// so a bolder or wider master doesn't shift the comparison. Returns the
// contours, a new one where the start point moved. Open contours, and all
// contours when the reference isn't closed, stay as they are.
export function alignContourStartsToReference(contours, referenceIndex = 0) {
  const reference = contours[referenceIndex];
  if (!reference?.isClosed || !onCurveIndices(reference).length) {
    return contours;
  }
  const referenceSamples = sampleNormalized(reference, 0);
  const referenceSignature = contourSignature(reference);
  return contours.map((contour, i) => {
    if (i === referenceIndex || !contour?.isClosed) {
      return contour;
    }
    const onCurves = onCurveIndices(contour);
    if (onCurves.length < 2) {
      return contour;
    }
    const sampler = arcLengthSampler(contour);
    const normalize = normalizer(contourBounds(contour));
    const fractions = nodeFractions(contour);
    let best;
    onCurves.forEach((pointIndex, k) => {
      let cost = 0;
      for (let s = 0; s < START_SAMPLES; s++) {
        const p = normalize(sampler(fractions[k] + s / START_SAMPLES));
        cost += distance(p, referenceSamples[s]);
      }
      const rotated = k ? setContourStartPoint(contour, pointIndex) : contour;
      const candidate = {
        k,
        cost,
        contour: rotated,
        sameSignature: contourSignature(rotated) === referenceSignature,
      };
      if (!best || isBetterStart(candidate, best)) {
        best = candidate;
      }
    });
    return best.contour;
  });
}

// Samples of the outline walked from relative arc length `offset`, inside its
// own bounding box
function sampleNormalized(contour, offset) {
  const sampler = arcLengthSampler(contour);
  const normalize = normalizer(contourBounds(contour));
  return range(0, START_SAMPLES).map((s) =>
    normalize(sampler(offset + s / START_SAMPLES)),
  );
}

// Lower cost wins; on a tie, a start giving the reference's segment types,
// then the current start (k = 0)
function isBetterStart(a, b) {
  const tie = 1e-6 * START_SAMPLES;
  if (Math.abs(a.cost - b.cost) > tie) {
    return a.cost < b.cost;
  }
  if (a.sameSignature !== b.sameSignature) {
    return a.sameSignature;
  }
  return a.k === 0;
}

//
// small helpers
//

export function range(start, stop) {
  const result = [];
  for (let i = start; i < stop; i++) {
    result.push(i);
  }
  return result;
}

// Even-odd point-in-polygon test. The polygon is a list of points, closed by
// a straight line from the last point back to the first.
export function pointInPolygon(p, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midPoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function roundPoint(p) {
  return { x: Math.round(p.x) || 0, y: Math.round(p.y) || 0 }; // no -0
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
