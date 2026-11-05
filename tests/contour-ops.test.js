import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  alignContourStartsToReference,
  alignFractions,
  alignStartPoints,
  autoMatchContours,
  canCutBetween,
  canCutBetweenNodes,
  canJoinContours,
  redundantLineNodes,
  removeNodes,
  checkCompatibility,
  contourBounds,
  cutBetweenNodes,
  contourSignature,
  cutContourAtNode,
  cutContourBetweenNodes,
  evalBezier,
  extensionSplitContour,
  extensionSplitContours,
  getSegments,
  glyphBounds,
  matchContourOrder,
  matchOuterDirection,
  outerDirection,
  matchSegmentRun,
  minCostAssignment,
  nearestSegmentPoint,
  onCurveIndices,
  parallelSplitContour,
  parallelSplitContours,
  pointAtFraction,
  pointInPolygon,
  reverseContour,
  setContourStartPoint,
  signedArea,
  splitSegment,
} from "../src/fontra_curvekit/plugin/contour-ops.js";

function rect(x0, y0, x1, y1) {
  return {
    points: [
      { x: x0, y: y0 },
      { x: x0, y: y1 },
      { x: x1, y: y1 },
      { x: x1, y: y0 },
    ],
    isClosed: true,
  };
}

// A closed contour: line, then a cubic, then a line back
function cubicShape() {
  return {
    points: [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 50, y: 150, type: "cubic" },
      { x: 150, y: 150, type: "cubic" },
      { x: 200, y: 100 },
      { x: 200, y: 0 },
    ],
    isClosed: true,
  };
}

const xy = (points) => points.map((p) => [p.x, p.y]);

describe("getSegments", () => {
  test("closed rectangle has four line segments, last one wraps", () => {
    const segments = getSegments(rect(0, 0, 100, 100));
    assert.equal(segments.length, 4);
    assert.deepEqual(segments.at(-1), { startIndex: 3, endIndex: 0, offIndices: [] });
  });

  test("closed contour starting with an off-curve", () => {
    const contour = {
      points: [
        { x: 100, y: 50, type: "cubic" },
        { x: 100, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 50, type: "cubic" },
      ],
      isClosed: true,
    };
    const segments = getSegments(contour);
    assert.equal(segments.length, 2);
    assert.deepEqual(segments[1], { startIndex: 2, endIndex: 1, offIndices: [3, 0] });
  });

  test("open contour has no wrapping segment", () => {
    const contour = { ...rect(0, 0, 100, 100), isClosed: false };
    assert.equal(getSegments(contour).length, 3);
  });
});

describe("Scissors: cut at node", () => {
  test("closed contour becomes one open contour starting and ending at the node", () => {
    const result = cutContourAtNode(rect(0, 0, 100, 100), 2);
    assert.equal(result.length, 1);
    assert.equal(result[0].isClosed, false);
    assert.deepEqual(xy(result[0].points), [
      [100, 100],
      [100, 0],
      [0, 0],
      [0, 100],
      [100, 100],
    ]);
  });

  test("open contour splits into two at an inner node", () => {
    const contour = { ...rect(0, 0, 100, 100), isClosed: false };
    const result = cutContourAtNode(contour, 1);
    assert.equal(result.length, 2);
    assert.deepEqual(xy(result[0].points), [
      [0, 0],
      [0, 100],
    ]);
    assert.deepEqual(xy(result[1].points), [
      [0, 100],
      [100, 100],
      [100, 0],
    ]);
  });

  test("open contour end points and off-curves can't be cut", () => {
    const contour = { ...cubicShape(), isClosed: false };
    assert.equal(cutContourAtNode(contour, 0), undefined);
    assert.equal(cutContourAtNode(contour, 5), undefined);
    assert.equal(cutContourAtNode(contour, 2), undefined);
  });

  test("cut end points lose their smooth flag", () => {
    const contour = cubicShape();
    contour.points[1].smooth = true;
    const [open] = cutContourAtNode(contour, 1);
    assert.ok(!open.points[0].smooth && !open.points.at(-1).smooth);
  });
});

describe("Scissors: node to node", () => {
  // An "L"-ish closed contour; cutting from 1 to 4 splits it into two quads
  const lShape = () => ({
    points: [
      { x: 0, y: 0 },
      { x: 0, y: 300 },
      { x: 100, y: 300 },
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 0 },
    ],
    isClosed: true,
  });

  test("splits a closed contour into two closed contours sharing the cut", () => {
    const result = cutContourBetweenNodes(lShape(), 0, 3);
    assert.equal(result.length, 2);
    assert.ok(result.every((c) => c.isClosed));
    assert.deepEqual(xy(result[0].points), [
      [0, 0],
      [0, 300],
      [100, 300],
      [100, 100],
    ]);
    assert.deepEqual(xy(result[1].points), [
      [100, 100],
      [300, 100],
      [300, 0],
      [0, 0],
    ]);
  });

  test("adjacent nodes joined by a line can't be cut (degenerate part)", () => {
    assert.equal(canCutBetweenNodes(lShape(), 0, 1), false);
    assert.equal(cutContourBetweenNodes(lShape(), 0, 1), undefined);
  });

  test("adjacent nodes joined by a curve can be cut", () => {
    assert.equal(canCutBetweenNodes(cubicShape(), 1, 4), true);
  });

  test("open contours and off-curves are rejected", () => {
    assert.equal(canCutBetweenNodes({ ...lShape(), isClosed: false }, 0, 3), false);
    assert.equal(canCutBetweenNodes(cubicShape(), 0, 2), false);
  });
});

describe("Scissors: cutting across contours (O, Ø)", () => {
  // A square ring: outer contour and a counter running the other way
  const ring = () => [
    rect(0, 0, 300, 300),
    {
      points: [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
        { x: 200, y: 200 },
        { x: 100, y: 200 },
      ],
      isClosed: true,
    },
  ];
  const area = (contour) =>
    contour.points.reduce((sum, p, i) => {
      const q = contour.points[(i + 1) % contour.points.length];
      return sum + (p.x * q.y - q.x * p.y) / 2;
    }, 0);
  const totalArea = (contours) => contours.reduce((sum, c) => sum + area(c), 0);
  const outer = (pointIndex) => ({ contourIndex: 0, pointIndex });

  test("one cut joins outer contour and counter through a slit, fill unchanged", () => {
    const contours = ring();
    const joined = cutBetweenNodes(contours, outer(1), { contourIndex: 1, pointIndex: 3 });
    assert.equal(joined.length, 1);
    assert.equal(joined[0].isClosed, true);
    assert.equal(joined[0].points.length, 10); // 4 + 4 points, plus both cut nodes twice
    assert.equal(totalArea(joined), totalArea(contours));
  });

  test("a second cut across the stroke splits the ring into two pieces", () => {
    let contours = ring();
    contours = cutBetweenNodes(contours, outer(1), { contourIndex: 1, pointIndex: 3 });
    // outer (300, 0) and counter (200, 100) are now both on contour 0
    const a = { contourIndex: 0, pointIndex: contours[0].points.findIndex((p) => p.x === 300 && p.y === 0) };
    const b = { contourIndex: 0, pointIndex: contours[0].points.findIndex((p) => p.x === 200 && p.y === 100) };
    const pieces = cutBetweenNodes(contours, a, b);
    assert.equal(pieces.length, 2);
    assert.ok(pieces.every((c) => c.isClosed));
    // two L-shaped halves of equal size and the same winding as the outer contour
    const ringArea = totalArea(ring());
    for (const piece of pieces) {
      assert.ok(Math.abs(area(piece) - ringArea / 2) < 1e-9);
    }
  });

  test("cross-contour cuts need closed contours and on-curve nodes", () => {
    const contours = ring();
    assert.equal(canCutBetween(contours, outer(0), { contourIndex: 1, pointIndex: 0 }), true);
    const open = [{ ...contours[0], isClosed: false }, contours[1]];
    assert.equal(canCutBetween(open, outer(0), { contourIndex: 1, pointIndex: 0 }), false);
    const withOff = [cubicShape(), contours[1]];
    assert.equal(canCutBetween(withOff, outer(2), { contourIndex: 1, pointIndex: 0 }), false);
  });
});

describe("Scissors: parallel split of a crossing", () => {
  const contourFrom = (coords) => ({
    points: coords.map(([x, y]) => ({ x, y })),
    isClosed: true,
  });
  // "+": vertical bar x 100..200, horizontal bar y 100..200; inner corners at
  // indices 2, 5, 8, 11
  const plusCoords = [
    [100, 300], [200, 300], [200, 200], [300, 200], [300, 100], [200, 100],
    [200, 0], [100, 0], [100, 100], [0, 100], [0, 200], [100, 200],
  ];
  const corners = [2, 5, 8, 11];
  const area = (contour) =>
    Math.abs(
      contour.points.reduce((sum, p, i) => {
        const q = contour.points[(i + 1) % contour.points.length];
        return sum + (p.x * q.y - q.x * p.y) / 2;
      }, 0)
    );

  test("splits a + into a horizontal and a vertical bar that overlap", () => {
    const { contours, bridges } = parallelSplitContour(contourFrom(plusCoords), corners);
    assert.equal(contours.length, 2);
    assert.ok(contours.every((c) => c.isClosed));
    // each stroke is a full 300 x 100 bar: the crossing belongs to both
    assert.deepEqual(contours.map(area), [30000, 30000]);
    assert.deepEqual(xy(contours[0].points), [
      [200, 200], [300, 200], [300, 100], [200, 100],
      [100, 100], [0, 100], [0, 200], [100, 200],
    ]);
    assert.equal(bridges.length, 4);
  });

  test("splits an X (the + rotated by 45°) into \ and /", () => {
    const xCoords = plusCoords.map(([x, y]) => [x - y, x + y]);
    const result = parallelSplitContour(contourFrom(xCoords), corners);
    assert.ok(result);
    assert.deepEqual(result.contours.map(area), [60000, 60000]); // scaled by 2
  });

  test("the order of the given corner indices doesn't matter", () => {
    assert.ok(parallelSplitContour(contourFrom(plusCoords), [11, 2, 8, 5]));
  });

  test("refuses when the edges don't continue across the crossing", () => {
    // the bottom arm is offset by a full stem width: the vertical stroke would kink
    const offset = contourFrom([
      [100, 300], [200, 300], [200, 200], [400, 200], [400, 100], [300, 100],
      [300, 0], [200, 0], [200, 100], [0, 100], [0, 200], [100, 200],
    ]);
    assert.equal(parallelSplitContour(offset, corners), undefined);
    assert.ok(parallelSplitContour(offset, corners, 50), "fine with a looser angle");
  });

  test("refuses wrong node counts, open contours and degenerate arms", () => {
    assert.equal(parallelSplitContour(contourFrom(plusCoords), [2, 5, 8]), undefined);
    assert.equal(
      parallelSplitContour({ ...contourFrom(plusCoords), isClosed: false }, corners),
      undefined
    );
    assert.equal(parallelSplitContour(contourFrom(plusCoords), [2, 3, 8, 11]), undefined);
  });
});

describe("Scissors: parallel split of Ø across contours", () => {
  // uni00D8 from Source Han Sans VF, Heavy master: counter right half, counter
  // left half, and the outer contour (ring plus both slash caps). "c" marks a
  // cubic off-curve point.
  const heavy = [
    [[545,456],[550,432,"c"],[552,405,"c"],[552,376],[552,231,"c"],[491,140,"c"],[394,140],[362,140,"c"],[334,150,"c"],[311,167]],
    [[247,273],[239,303,"c"],[235,338,"c"],[235,376],[235,520,"c"],[296,605,"c"],[394,605],[431,605,"c"],[462,593,"c"],[487,570]],
    [[761,723],[669,794],[593,700],[538,738,"c"],[471,758,"c"],[394,758],[191,758,"c"],[53,620,"c"],[53,376],[53,271,"c"],[78,185,"c"],[123,120],[44,22],[136,-49],[207,38],[259,4,"c"],[322,-14,"c"],[394,-14],[596,-14,"c"],[734,132,"c"],[734,376],[734,473,"c"],[712,553,"c"],[673,614]],
  ].map((coords) => ({
    points: coords.map(([x, y, c]) => (c ? { x, y, type: "cubic" } : { x, y })),
    isClosed: true,
  }));
  const at = (contours, x, y) => {
    for (const [contourIndex, contour] of contours.entries()) {
      const pointIndex = contour.points.findIndex((p) => p.x === x && p.y === y && !p.type);
      if (pointIndex >= 0) {
        return { contourIndex, pointIndex };
      }
    }
    throw new Error(`no node at ${x},${y}`);
  };
  const polygonArea = (contour) =>
    contour.points.reduce((sum, p, i) => {
      const q = contour.points[(i + 1) % contour.points.length];
      return sum + (p.x * q.y - q.x * p.y) / 2;
    }, 0);

  test("the top-right junction's corners are on three contours and split", () => {
    const corners = [[593, 700], [673, 614], [545, 456], [487, 570]].map(([x, y]) =>
      at(heavy, x, y)
    );
    assert.deepEqual(new Set(corners.map((c) => c.contourIndex)), new Set([0, 1, 2]));
    const result = parallelSplitContours(heavy, corners);
    assert.ok(result, "continuity check passes");
    // the outer ring continues past the slash; the slash edges continue into the counter
    const bridge = (k) => result.bridges[k].map((p) => [p.x, p.y]);
    // slash edge into the counter: line arrives, line leaves -> straight bridge
    assert.deepEqual(bridge(0), [[593, 700], [487, 570]]);
    // outer ring past the slash: curve on both sides -> curved bridge
    assert.deepEqual(bridge(1).slice(0, 2), [[673, 614], [593, 700]]);
    assert.equal(bridge(1).length, 4);
    // counter arc under the slash: curved too; lower slash edge: straight
    assert.equal(result.bridges[3].length, 4);
    assert.equal(result.bridges[2].length, 2);
    assert.equal(result.contours.length, 2);
  });

  test("curved bridges extend the handles: corners become smooth", () => {
    const corners = [[593, 700], [673, 614], [545, 456], [487, 570]].map(([x, y]) =>
      at(heavy, x, y)
    );
    const { contours, bridges } = parallelSplitContours(heavy, corners);
    const [from, to, h1, h2] = bridges[1]; // (673,614) -> (593,700)
    const cross = (a, b) => a.x * b.y - a.y * b.x;
    const dir = (a, b) => ({ x: b.x - a.x, y: b.y - a.y });
    // h1 continues the incoming handle (712,553) -> (673,614); h2 the outgoing (593,700) -> (538,738)
    assert.ok(Math.abs(cross(dir({ x: 712, y: 553 }, from), dir(from, h1))) / 100 < 50);
    assert.ok(Math.abs(cross(dir(h2, to), dir(to, { x: 538, y: 738 }))) / 100 < 50);
    const ring = contours.find((c) =>
      c.points.some((p) => p.x === 593 && p.y === 700 && p.smooth)
    );
    assert.ok(ring, "corner (593,700) is smooth in the ring contour");
    const straight = parallelSplitContours(heavy, corners, { curveCubic: false });
    assert.ok(straight.bridges.every((b) => b.length === 2));
  });

  test("splitting both junctions separates the O and the slash", () => {
    const first = parallelSplitContours(
      heavy,
      [[593, 700], [673, 614], [545, 456], [487, 570]].map(([x, y]) => at(heavy, x, y))
    ).contours;
    const second = parallelSplitContours(
      first,
      [[123, 120], [207, 38], [247, 273], [311, 167]].map(([x, y]) => at(first, x, y))
    );
    assert.ok(second);
    const areas = second.contours.map(polygonArea);
    assert.equal(second.contours.length, 3);
    // outer ring and slash wind one way, the counter the other way
    assert.equal(areas.filter((a) => a > 0).length, 2);
    assert.equal(areas.filter((a) => a < 0).length, 1);
    const onCurveCounts = second.contours.map((c) => onCurveIndices(c).length).sort((a, b) => a - b);
    assert.deepEqual(onCurveCounts, [8, 8, 12]);
  });
});

describe("Scissors: extension split of a two-corner junction", () => {
  const contourFrom = (coords) => ({
    points: coords.map(([x, y]) => ({ x, y })),
    isClosed: true,
  });
  const polygonArea = (contour) =>
    Math.abs(
      contour.points.reduce((sum, p, i) => {
        const q = contour.points[(i + 1) % contour.points.length];
        return sum + (p.x * q.y - q.x * p.y) / 2;
      }, 0)
    );

  test("T: the bar's edge runs straight on, the stem goes 50% into the bar", () => {
    // bar x 0..300, y 200..300; stem x 100..200 below it; corners at 4 and 7
    const t = contourFrom([
      [0, 200], [0, 300], [300, 300], [300, 200], [200, 200], [200, 0], [100, 0], [100, 200],
    ]);
    const { contours, kinds, bridges } = extensionSplitContour([t], 0, [4, 7]);
    // kinds[k] is the bridge from corner k: from (200,200) along the bar's edge,
    // from (100,200) up the stem
    assert.deepEqual(kinds, ["straight", "cap"]);
    // the bar is 100 thick: the stem runs on 50 into it, not up to its top
    assert.deepEqual(xy(contours[0].points), [
      [200, 200], [200, 0], [100, 0], [100, 200], [100, 250], [200, 250],
    ]);
    assert.deepEqual(contours.map(polygonArea), [25000, 30000]); // stem 100x250, bar 300x100
    assert.equal(bridges[1].length, 4); // from, two cap points, to
  });

  test("tapered stem under a bar: its edges meet in a point inside the bar", () => {
    // bar x 0..400, y 200..350; trapezoid stem, top corners (250,200) and (150,200);
    // the apex (200,300) is two thirds of the way in, deeper than 50%, but inside
    const shape = contourFrom([
      [0, 200], [0, 350], [400, 350], [400, 200], [250, 200], [350, 0], [50, 0], [150, 200],
    ]);
    const { contours, kinds } = extensionSplitContour([shape], 0, [4, 7]);
    assert.deepEqual(kinds, ["straight", "point"]);
    assert.ok(contours[0].points.some((p) => p.x === 200 && p.y === 300), "apex at (200,300)");
  });

  test("an apex that would stick out of the outline is capped at 50% instead", () => {
    // bar 50 thick: the apex (200,300) is outside; cap halfway across, y = 225
    const low = contourFrom([
      [0, 200], [0, 250], [400, 250], [400, 200], [250, 200], [350, 0], [50, 0], [150, 200],
    ]);
    const { kinds, contours } = extensionSplitContour([low], 0, [4, 7]);
    assert.deepEqual(kinds, ["straight", "cap"]);
    assert.deepEqual(xy(contours[0].points).slice(-2), [[162, 225], [237, 225]]);
  });

  test("the depth limit is an option", () => {
    const t = contourFrom([
      [0, 200], [0, 300], [300, 300], [300, 200], [200, 200], [200, 0], [100, 0], [100, 200],
    ]);
    const { contours } = extensionSplitContour([t], 0, [4, 7], { maxDepth: 1 });
    assert.deepEqual(xy(contours[0].points).slice(-2), [[100, 300], [200, 300]]);
  });

  test("two touching chevrons: each closes into a point, overlapping in a diamond", () => {
    // corners L (100,200) and R (300,200); the tips land on the outline: inside
    const bowtie = contourFrom([
      [0, 0], [100, 200], [0, 400], [400, 400], [300, 200], [400, 0],
    ]);
    const { contours, kinds } = extensionSplitContour([bowtie], 0, [1, 4]);
    assert.deepEqual(kinds, ["point", "point"]);
    const tips = contours.map((c) => xy(c.points).at(-1));
    assert.deepEqual(tips, [[200, 0], [200, 400]]); // V pointing down, Λ pointing up
  });

  test("another layer reuses the kinds, with its own geometry", () => {
    const t = (scale) =>
      contourFrom(
        [[0, 200], [0, 300], [300, 300], [300, 200], [200, 200], [200, 0], [100, 0], [100, 200]].map(
          ([x, y]) => [x * scale, y * scale]
        )
      );
    const { kinds } = extensionSplitContour([t(1)], 0, [4, 7]);
    const bold = extensionSplitContour([t(2)], 0, [4, 7], { kinds });
    assert.deepEqual(xy(bold.contours[0].points).slice(-2), [[200, 500], [400, 500]]);
  });

  test("across contours: an 'e' bar is split off the wall it runs into", () => {
    // rectilinear "e": outer contour with the aperture (lower right), and the
    // eye counter (opposite direction). The bar (y 150..200) meets the left wall
    // (x 0..50) at (50,150) on the outer contour and (50,200) on the counter.
    const outer = contourFrom([
      [0, 0], [0, 300], [300, 300], [300, 150], [50, 150], [50, 50], [300, 50], [300, 0],
    ]);
    const counter = contourFrom([[50, 200], [250, 200], [250, 250], [50, 250]]);
    const corners = [
      { contourIndex: 0, pointIndex: 4 },
      { contourIndex: 1, pointIndex: 0 },
    ];
    const { contours, kinds, bridges } = extensionSplitContours([outer, counter], corners);
    // the bar runs on 50% into the 50-wide wall; the wall's inner edge runs
    // straight on across where the bar was
    assert.deepEqual(kinds, ["cap", "straight"]);
    assert.deepEqual(bridges[0].map((p) => [p.x, p.y]), [[50, 150], [25, 150], [25, 200], [50, 200]]);
    assert.equal(contours.length, 1, "the two contours are joined into one");

    // the filled area is unchanged (nonzero winding)
    const winding = (contourList, p) => {
      let w = 0;
      for (const c of contourList) {
        c.points.forEach((a, i) => {
          const b = c.points[(i + 1) % c.points.length];
          if (a.y <= p.y && b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++;
          if (a.y > p.y && b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) w--;
        });
      }
      return w;
    };
    const samples = [
      [25, 100], [25, 175], [25, 275], [150, 175], [150, 275], [275, 225], [150, 25],
      [150, 225], [150, 100], [275, 100], [-10, 100], [350, 175],
    ];
    for (const [x, y] of samples) {
      assert.equal(
        winding(contours, { x, y }) !== 0,
        winding([outer, counter], { x, y }) !== 0,
        `fill at (${x},${y})`
      );
    }
    // where the bar now overlaps the wall, both cover it; it stops short of
    // the wall's outer edge
    assert.equal(Math.abs(winding(contours, { x: 40, y: 175 })), 2);
    assert.equal(Math.abs(winding(contours, { x: 10, y: 175 })), 1);
  });

  test("refuses when an edge runs off into nothing", () => {
    const l = contourFrom([[0, 0], [0, 300], [100, 300], [100, 100], [300, 100], [300, 0]]);
    assert.equal(extensionSplitContour([l], 0, [0, 3]), undefined);
  });
});

describe("splitSegment", () => {
  test("splits a line at t", () => {
    const { contour, pointIndex } = splitSegment(rect(0, 0, 100, 100), 0, 0.25);
    assert.equal(pointIndex, 1);
    assert.deepEqual(contour.points[1], { x: 0, y: 25 });
    assert.equal(contour.points.length, 5);
  });

  test("splits the wrapping line of a closed contour", () => {
    const { contour, pointIndex } = splitSegment(rect(0, 0, 100, 100), 3, 0.5);
    assert.equal(pointIndex, 4);
    assert.deepEqual(contour.points[4], { x: 50, y: 0 });
  });

  test("splits a cubic, preserving the curve", () => {
    const original = cubicShape();
    const { contour, pointIndex } = splitSegment(original, 1, 0.5, false);
    assert.equal(pointIndex, 4);
    const expected = evalBezier(
      [original.points[1], original.points[2], original.points[3], original.points[4]],
      0.5
    );
    assert.deepEqual(contour.points[4], { ...expected, smooth: true });
    assert.equal(contourSignature(contour), "Cooccoccoo");
  });

  test("splits a quadratic spline, making implied on-curves explicit", () => {
    const contour = {
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 100, type: "quad" },
        { x: 100, y: 100, type: "quad" },
        { x: 100, y: 0 },
      ],
      isClosed: false,
    };
    const result = splitSegment(contour, 0, 0.25);
    // first piece split at its middle; the implied on-curve (50, 100) is explicit
    assert.equal(contourSignature(result.contour), "Ooqoqoqo");
    assert.deepEqual(result.contour.points[result.pointIndex].smooth, true);
    assert.ok(result.contour.points.some((p) => p.x === 50 && p.y === 100 && !p.type));
  });

  test("keeps identity of untouched points", () => {
    const original = rect(0, 0, 100, 100);
    const { contour } = splitSegment(original, 1, 0.5);
    assert.equal(contour.points[0], original.points[0]);
    assert.equal(contour.points.at(-1), original.points.at(-1));
  });

  test("refuses t at the segment ends", () => {
    assert.equal(splitSegment(rect(0, 0, 100, 100), 0, 0), undefined);
    assert.equal(splitSegment(rect(0, 0, 100, 100), 0, 1), undefined);
  });
});

describe("nearestSegmentPoint", () => {
  test("finds the nearest segment and parameter", () => {
    const hit = nearestSegmentPoint(rect(0, 0, 100, 100), { x: 103, y: 40 });
    assert.equal(hit.segmentIndex, 2);
    assert.ok(Math.abs(hit.t - 0.6) < 1e-6);
    assert.ok(Math.abs(hit.distance - 3) < 1e-6);
  });
});

describe("setContourStartPoint", () => {
  test("rotates a closed contour to start at the node", () => {
    const result = setContourStartPoint(cubicShape(), 4);
    assert.deepEqual(xy(result.points)[0], [200, 100]);
    assert.equal(contourSignature(result), "Coooocc");
  });

  test("refuses open contours, off-curves and the current start point", () => {
    assert.equal(setContourStartPoint({ ...rect(0, 0, 1, 1), isClosed: false }, 2), undefined);
    assert.equal(setContourStartPoint(cubicShape(), 2), undefined);
    assert.equal(setContourStartPoint(cubicShape(), 0), undefined);
  });
});

describe("alignStartPoints", () => {
  test("start points follow the selected nodes, relative to the reference", () => {
    // the top-right corner is selected in both; it is node 2 in the reference
    // (start at the bottom-left) and node 0 in the other one
    const reference = rect(0, 0, 100, 100);
    const other = setContourStartPoint(rect(0, 0, 200, 200), 2);
    const [a, b] = alignStartPoints([reference, other], [2, 0], 0);
    assert.equal(a, reference, "the reference is untouched");
    assert.deepEqual(xy(b.points), xy(rect(0, 0, 200, 200).points));
  });

  test("works across off-curves and wraps around", () => {
    const reference = cubicShape(); // nodes: 0 1 4 5
    const other = setContourStartPoint(cubicShape(), 5); // nodes: 0(=5) 1(=0) 2(=1) 5(=4)
    // select (200, 100): node 4 (ordinal 2) in the reference, point 5 in the other
    const [, b] = alignStartPoints([reference, other], [4, 5], 0);
    assert.deepEqual(xy(b.points), xy(cubicShape().points));
  });

  test("the reference can be any layer; open contours and off-curves are skipped", () => {
    const moved = setContourStartPoint(rect(0, 0, 100, 100), 1);
    const [a] = alignStartPoints([rect(0, 0, 100, 100), moved], [0, 3], 1);
    // in the reference (0,0) is node 3: the start point is the node after it
    assert.deepEqual(xy(a.points)[0], [0, 100]);
    const open = { ...rect(0, 0, 1, 1), isClosed: false };
    const contours = [rect(0, 0, 1, 1), open];
    assert.equal(alignStartPoints(contours, [1, 2], 0)[1], open);
    const shapes = [cubicShape(), cubicShape()];
    assert.equal(alignStartPoints(shapes, [2, 1], 0), shapes, "off-curve in the reference");
    assert.equal(alignStartPoints(shapes, [1, 1], 0)[1], shapes[1], "already aligned");
  });
});

describe("Force match masters: order, direction, start points", () => {
  const ccw = (contour) => reverseContour(contour); // rect() runs clockwise

  test("signedArea gives the direction; reverseContour flips it, same start", () => {
    assert.ok(signedArea(rect(0, 0, 100, 100)) < 0);
    const reversed = reverseContour(rect(0, 0, 100, 100));
    assert.ok(signedArea(reversed) > 0);
    assert.deepEqual(xy(reversed.points), [[0, 0], [100, 0], [100, 100], [0, 100]]);
    // with a cubic: the handles of the curve swap order with it
    const shape = reverseContour(cubicShape());
    assert.deepEqual(xy(shape.points), [
      [0, 0], [200, 0], [200, 100], [150, 150], [50, 150], [0, 100],
    ]);
    assert.equal(contourSignature(shape), "Cooocco");
    assert.ok(Math.sign(signedArea(shape)) === -Math.sign(signedArea(cubicShape())));
  });

  test("bounds are of the outline, not of the control points", () => {
    const bounds = contourBounds(cubicShape());
    assert.equal(bounds.yMax < 150, true, "the curve peaks below its handles");
    assert.deepEqual(glyphBounds([rect(0, 0, 10, 10), rect(50, -5, 60, 5)]), {
      xMin: 0, yMin: -5, xMax: 60, yMax: 10,
    });
    assert.deepEqual(pointAtFraction(rect(0, 0, 100, 100), 0.5), { x: 100, y: 100 });
  });

  test("minCostAssignment finds the cheapest pairing", () => {
    assert.deepEqual(minCostAssignment([[4, 1, 3], [2, 0, 5], [3, 2, 2]]), [1, 0, 2]);
  });

  test("matchContourOrder: an 8's counters in the other order, bolder and wider", () => {
    const light = [rect(0, 0, 100, 200), ccw(rect(20, 20, 80, 90)), ccw(rect(20, 110, 80, 180))];
    const bold = [ccw(rect(40, 115, 120, 170)), rect(0, 0, 160, 200), ccw(rect(40, 30, 120, 85))];
    assert.deepEqual(matchContourOrder(light, bold), [1, 2, 0]);
    assert.equal(matchContourOrder(light, bold.slice(1)), undefined, "counts differ");
  });

  test("matchContourOrder pairs same-box contours by direction", () => {
    // an O whose ring and counter nearly share a box
    const ring = rect(0, 0, 100, 100);
    const counter = ccw(rect(2, 2, 98, 98));
    assert.deepEqual(matchContourOrder([ring, counter], [counter, ring]), [1, 0]);
  });

  test("matchContourOrder breaks ties by node count", () => {
    // two identical boxes: the one with the same node count wins
    const plain = rect(0, 0, 100, 100);
    const extra = splitSegment(rect(0, 0, 100, 100), 0, 0.5).contour; // 5 nodes
    assert.deepEqual(matchContourOrder([plain, extra], [extra, plain]), [1, 0]);
    assert.deepEqual(matchContourOrder([extra, plain], [extra, plain]), [0, 1]);
    // geometry still comes first
    const far = splitSegment(rect(300, 0, 400, 100), 0, 0.5).contour;
    assert.deepEqual(matchContourOrder([plain, rect(300, 0, 400, 100)], [far, extra]), [1, 0]);
  });

  test("outerDirection: the largest top-level contour", () => {
    const o = [ccw(rect(20, 20, 80, 80)), rect(0, 0, 100, 100)];
    assert.equal(outerDirection(o), Math.sign(signedArea(rect(0, 0, 1, 1))));
    assert.equal(outerDirection([]), 0);
    assert.equal(outerDirection([{ ...rect(0, 0, 9, 9), isClosed: false }]), 0);
  });

  test("matchOuterDirection reverses a whole master drawn the other way", () => {
    const light = [rect(0, 0, 100, 100), ccw(rect(20, 20, 80, 80))];
    const bold = [ccw(rect(0, 0, 200, 100)), rect(30, 20, 170, 80)];
    const flipped = matchOuterDirection(light, bold);
    assert.deepEqual(
      flipped.map((c) => Math.sign(signedArea(c))),
      light.map((c) => Math.sign(signedArea(c))),
    );
    assert.deepEqual(flipped[0].points[0], bold[0].points[0], "keeps the start node");
    assert.equal(matchOuterDirection(light, light), undefined, "same way: unchanged");
  });

  test("alignContourStartsToReference: a spun rectangle in a bold, wide master", () => {
    const light = rect(0, 0, 100, 100);
    const bold = setContourStartPoint(rect(50, 0, 450, 200), 2);
    const [, aligned] = alignContourStartsToReference([light, bold], 0);
    assert.deepEqual(xy(aligned.points)[0], [50, 0]);
  });

  test("compares outlines inside their own boxes, not raw positions", () => {
    // the old nearest-node rule picked (10,-10), the corner nearest to (0,0)
    const light = rect(0, 0, 100, 100);
    const shifted = setContourStartPoint(rect(-400, -10, 10, 300), 1);
    const [, aligned] = alignContourStartsToReference([light, shifted], 0);
    assert.deepEqual(xy(aligned.points)[0], [-400, -10]);
  });

  test("finds the corresponding start with an extra node", () => {
    const light = rect(0, 0, 100, 100);
    const extra = setContourStartPoint(
      splitSegment(rect(0, 0, 200, 200), 1, 0.5).contour,
      3,
    );
    const [, aligned] = alignContourStartsToReference([light, extra], 0);
    assert.deepEqual(xy(aligned.points)[0], [0, 0]);
  });

  test("leaves aligned, open and open-reference contours as they are", () => {
    const light = rect(0, 0, 100, 100);
    const same = rect(0, 0, 300, 300);
    assert.equal(alignContourStartsToReference([light, same], 0)[1], same);
    const open = { ...rect(0, 0, 1, 1), isClosed: false };
    assert.equal(alignContourStartsToReference([light, open], 0)[1], open);
    // an open reference with a closed contour elsewhere doesn't throw
    const mixed = [open, rect(0, 0, 2, 2)];
    assert.equal(alignContourStartsToReference(mixed, 0), mixed);
  });
});

describe("Matchmaker", () => {
  test("checkCompatibility reports node count differences", () => {
    const a = [rect(0, 0, 100, 100)];
    const b = [splitSegment(rect(0, 0, 200, 200), 0, 0.5).contour];
    const report = checkCompatibility([a, b], ["Regular", "Bold"]);
    assert.equal(report.compatible, false);
    assert.equal(report.issues[0].contourIndex, 0);
    assert.match(report.issues[0].message, /4 \/ 5/);
  });

  test("checkCompatibility reports contour count differences", () => {
    const report = checkCompatibility(
      [[rect(0, 0, 1, 1)], [rect(0, 0, 1, 1), rect(2, 2, 3, 3)]],
      ["A", "B"]
    );
    assert.equal(report.compatible, false);
    assert.match(report.issues[0].message, /^B: 2 contours/);
  });

  test("matchSegmentRun adds nodes so the run matches", () => {
    const light = rect(0, 0, 100, 100);
    const bold = splitSegment(splitSegment(rect(0, 0, 200, 200), 1, 0.5).contour, 1, 0.5)
      .contour; // top edge has 2 extra nodes
    // run from node 1 (top-left) to the top-right node
    const boldTopRight = bold.points.findIndex((p) => p.x === 200 && p.y === 200);
    const result = matchSegmentRun([light, bold], [1, 1], [2, boldTopRight]);
    assert.ok(result);
    assert.equal(onCurveIndices(result[0]).length, onCurveIndices(result[1]).length);
    assert.equal(contourSignature(result[0]), contourSignature(result[1]));
  });

  test("matchSegmentRun turns lines into curves where needed", () => {
    const light = rect(0, 0, 200, 100);
    const bold = cubicShape(); // node 1 -> 4 is a cubic
    // light: node 1 (0,100) -> node 2 (200,100) is a line
    const result = matchSegmentRun([light, bold], [1, 1], [2, 4]);
    assert.ok(result);
    assert.equal(result[0].points.filter((p) => p.type === "cubic").length, 2);
  });

  test("autoMatchContours inserts missing nodes", () => {
    const light = rect(0, 0, 100, 100);
    const bold = splitSegment(rect(0, 0, 200, 200), 2, 0.5).contour;
    const result = autoMatchContours([light, bold]);
    assert.ok(result);
    assert.equal(contourSignature(result[0]), contourSignature(result[1]));
    // the new node was inserted on the matching (right) edge of the light rect
    assert.ok(result[0].points.some((p) => p.x === 100 && p.y === 50));
  });

  test("autoMatchContours refuses open/closed mismatches", () => {
    const light = rect(0, 0, 100, 100);
    assert.equal(autoMatchContours([light, { ...light, isClosed: false }]), undefined);
  });

  test("alignFractions is order preserving and pins the start", () => {
    assert.deepEqual(alignFractions([0, 0.5], [0, 0.25, 0.5, 0.75]), [0, 2]);
    assert.deepEqual(alignFractions([0, 0.2], [0, 0.25, 0.5, 1], true), [0, 3]);
  });
});

describe("pointInPolygon", () => {
  // an open "L" path: the closing line from (0,100) back to (0,0) is implied
  const lasso = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 30 },
    { x: 30, y: 30 },
    { x: 30, y: 100 },
    { x: 0, y: 100 },
  ];
  test("inside and outside a concave lasso", () => {
    assert.equal(pointInPolygon({ x: 10, y: 10 }, lasso), true);
    assert.equal(pointInPolygon({ x: 80, y: 10 }, lasso), true);
    assert.equal(pointInPolygon({ x: 10, y: 80 }, lasso), true);
    // inside the bounding box, outside the L
    assert.equal(pointInPolygon({ x: 80, y: 80 }, lasso), false);
    assert.equal(pointInPolygon({ x: 150, y: 10 }, lasso), false);
  });
  test("fewer than 3 points contain nothing", () => {
    assert.equal(pointInPolygon({ x: 0, y: 0 }, [{ x: -1, y: -1 }, { x: 1, y: 1 }]), false);
  });
});

describe("extensionSplitContours: short steps at a corner", () => {
  // Source Han Sans ExtraLight "a": the bowl's outer curve reaches the stem
  // through a 3-unit horizontal step (408,70)-(411,70). The bowl's edge must
  // run on along the curve, not along the step.
  const glif = (coords) => ({
    points: coords.map(([x, y, off]) => (off ? { x, y, type: "cubic" } : { x, y })),
    isClosed: true,
  });
  const outer = glif([
    [218, -13], [288, -13, 1], [354, 26, 1], [408, 70], [411, 70], [416, 0], [446, 0],
    [446, 341], [446, 448, 1], [408, 540, 1], [284, 540], [198, 540, 1], [125, 496, 1],
    [92, 472], [110, 443], [144, 470, 1], [207, 507, 1], [282, 507], [391, 507, 1],
    [413, 414, 1], [410, 329], [173, 302, 1], [66, 247, 1], [66, 130], [66, 30, 1],
    [136, -13, 1],
  ]);
  const counter = glif([
    [221, 20], [157, 20, 1], [103, 50, 1], [103, 131], [103, 220, 1], [181, 273, 1],
    [410, 298], [410, 109], [341, 50, 1], [284, 20, 1],
  ]);
  test("the bowl's tail follows the curve's tangent into the stem", () => {
    const result = extensionSplitContours(
      [outer, counter],
      [
        { contourIndex: 0, pointIndex: 4 },
        { contourIndex: 1, pointIndex: 7 },
      ],
    );
    assert.ok(result);
    assert.deepEqual(result.kinds, ["cap", "straight"]);
    const [, runOn] = result.bridges[0];
    // along the curve's tangent (54,44), not horizontal along the step
    assert.notEqual(runOn.y, 70);
    const slope = (runOn.y - 70) / (runOn.x - 411);
    assert.ok(Math.abs(slope - 44 / 54) < 0.1, `slope ${slope}`);
    assert.ok(runOn.x > 411 && runOn.x < 446, "stays inside the stem");
  });
});

describe("Scissors: joining contours, redundant nodes", () => {
  const square = (x0, y0, x1, y1) => ({
    points: [{ x: x0, y: y0 }, { x: x0, y: y1 }, { x: x1, y: y1 }, { x: x1, y: y0 }],
    isClosed: true,
  });
  const reversed = (contour) => ({ ...contour, points: [...contour.points].reverse() });
  const node = (contourIndex) => ({ contourIndex, pointIndex: 0 });
  test("an 'i' dot and stem (same direction, top level) can't be joined", () => {
    const contours = [square(0, 0, 100, 400), square(0, 500, 100, 600)];
    assert.equal(canJoinContours(contours, 0, 1), false);
    assert.equal(canCutBetween(contours, node(0), node(1)), false);
  });
  test("two overlapping strokes running the same way can't be joined", () => {
    for (const f of [(c) => c, reversed]) {
      const contours = [f(square(0, 0, 300, 100)), f(square(100, -100, 200, 300))];
      assert.equal(canCutBetween(contours, node(0), node(1)), false);
    }
  });
  test("an outer contour and its counter can be joined", () => {
    const contours = [square(0, 0, 300, 300), reversed(square(100, 100, 200, 200))];
    assert.equal(canCutBetween(contours, node(0), node(1)), true);
  });
  test("the two counters of 日 (same direction, inside the outer) can be joined", () => {
    const contours = [
      square(0, 0, 200, 400),
      reversed(square(50, 50, 150, 175)),
      reversed(square(50, 225, 150, 350)),
    ];
    assert.equal(canJoinContours(contours, 1, 2), true);
    const at = (ci, x, y) => ({
      contourIndex: ci,
      pointIndex: contours[ci].points.findIndex((p) => p.x === x && p.y === y),
    });
    // across the middle bar
    assert.equal(canCutBetween(contours, at(1, 50, 175), at(2, 50, 225)), true);
  });
  test("a straight cut along an edge leaves a removable mid-line node", () => {
    const l = {
      points: [[0, 0], [100, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]].map(
        ([x, y]) => ({ x, y }),
      ),
      isClosed: true,
    };
    const cut = cutBetweenNodes([l], { contourIndex: 0, pointIndex: 1 }, { contourIndex: 0, pointIndex: 4 });
    const nodes = redundantLineNodes(cut, [{ x: 100, y: 0 }, { x: 100, y: 100 }]);
    assert.deepEqual(nodes, [{ contourIndex: 1, pointIndex: 0 }]); // (100,100) on the stem
    const cleaned = removeNodes(cut, nodes);
    assert.equal(cleaned[1].points.length, 4);
    assert.equal(cleaned[0], cut[0], "untouched contours are kept as they are");
  });
  test("nodes next to curves are kept", () => {
    const contour = {
      points: [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 150, y: 0, type: "cubic" },
        { x: 200, y: 50, type: "cubic" }, { x: 200, y: 100 }, { x: 0, y: 100 },
      ],
      isClosed: true,
    };
    assert.deepEqual(redundantLineNodes([contour], [{ x: 100, y: 0 }]), []);
  });
});
