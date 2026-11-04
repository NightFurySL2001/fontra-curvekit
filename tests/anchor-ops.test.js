import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  bendSegment,
  makeSmooth,
  moveHandle,
  pullHandles,
  retractHandles,
  straightenSegment,
} from "../src/fontra_curvekit/plugin/anchor-ops.js";
import { evalBezier } from "../src/fontra_curvekit/plugin/contour-ops.js";

const square = () => ({
  points: [
    { x: 0, y: 0 },
    { x: 0, y: 300 },
    { x: 300, y: 300 },
    { x: 300, y: 0 },
  ],
  isClosed: true,
});

const anchors = (contour) =>
  contour.points.filter((p) => !p.type).map((p) => [p.x, p.y]);

// A smooth anchor at (100, 0) between two cubic curves
const wave = () => ({
  points: [
    { x: 0, y: 0 },
    { x: 30, y: 60, type: "cubic" },
    { x: 70, y: 60, type: "cubic" },
    { x: 100, y: 0, smooth: true },
    { x: 130, y: -60, type: "cubic" },
    { x: 170, y: -60, type: "cubic" },
    { x: 200, y: 0 },
  ],
  isClosed: false,
});

function collinear(a, b, c) {
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(cross) <= 2 * Math.hypot(c.x - a.x, c.y - a.y); // rounding slack
}

describe("bendSegment", () => {
  test("a line becomes a cubic through the dragged point; anchors stay", () => {
    const before = square();
    // segment 0: (0,0) -> (0,300); grab the middle and drag 90 to the left
    const after = bendSegment(before, 0, 0.5, { x: -90, y: 0 });
    assert.deepEqual(anchors(after), anchors(before));
    assert.equal(after.points.length, 6);
    const pts = after.points.slice(0, 4);
    assert.deepEqual(pts.slice(1, 3).map((p) => p.type), ["cubic", "cubic"]);
    const mid = evalBezier(pts, 0.5);
    assert.ok(Math.abs(mid.x + 90) < 1 && Math.abs(mid.y - 150) < 1, JSON.stringify(mid));
    assert.deepEqual(before, square(), "input untouched");
  });

  test("quad mode gives one quadratic off-curve through the dragged point", () => {
    const after = bendSegment(square(), 0, 0.5, { x: -60, y: 0 }, { curveType: "quad" });
    assert.equal(after.points.length, 5);
    assert.equal(after.points[1].type, "quad");
    const mid = evalBezier(after.points.slice(0, 3), 0.5);
    assert.ok(Math.abs(mid.x + 60) < 1, JSON.stringify(mid));
    assert.deepEqual(anchors(after), anchors(square()));
  });

  test("the wrapping segment of a closed contour bends too", () => {
    const after = bendSegment(square(), 3, 0.5, { x: 0, y: -50 });
    assert.deepEqual(anchors(after), anchors(square()));
    assert.equal(after.points.length, 6);
    assert.deepEqual(after.points.slice(4).map((p) => p.type), ["cubic", "cubic"]);
  });

  test("a smooth end anchor stays smooth: the neighbour handle turns", () => {
    const after = bendSegment(wave(), 0, 0.5, { x: 0, y: 40 });
    assert.deepEqual(anchors(after), anchors(wave()));
    const [h, a, k] = [after.points[2], after.points[3], after.points[4]];
    assert.ok(a.smooth);
    assert.ok(collinear(h, a, k), JSON.stringify([h, a, k]));
    // the turned handle keeps its length
    const length = Math.hypot(k.x - a.x, k.y - a.y);
    assert.ok(Math.abs(length - Math.hypot(30, 60)) < 1.5);
  });

  test("a smooth anchor next to a line becomes a corner", () => {
    const contour = {
      points: [
        { x: 0, y: 0 },
        { x: 30, y: 60, type: "cubic" },
        { x: 70, y: 60, type: "cubic" },
        { x: 100, y: 0, smooth: true },
        { x: 200, y: 0 },
      ],
      isClosed: false,
    };
    const after = bendSegment(contour, 0, 0.5, { x: 0, y: 40 });
    assert.ok(!after.points[3].smooth);
  });

  test("unsupported segments are refused", () => {
    const spline = {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 50, type: "quad" },
        { x: 50, y: 60, type: "quad" },
        { x: 100, y: 0 },
      ],
      isClosed: false,
    };
    assert.equal(bendSegment(spline, 0, 0.5, { x: 0, y: 10 }), undefined);
  });
});

describe("pullHandles", () => {
  test("a corner between two lines gets symmetric handles and turns smooth", () => {
    const after = pullHandles(square(), 1, { x: 50, y: 0 });
    assert.deepEqual(anchors(after), anchors(square()));
    const i = after.points.findIndex((p) => p.x === 0 && p.y === 300 && !p.type);
    assert.ok(after.points[i].smooth);
    assert.deepEqual(after.points[i - 1], { x: -50, y: 300, type: "cubic" });
    assert.deepEqual(after.points[i + 1], { x: 50, y: 300, type: "cubic" });
    // far handles on the lines keep the far anchors' directions
    assert.deepEqual(after.points[i - 2], { x: 0, y: 100, type: "cubic" });
    assert.deepEqual(after.points[i + 2], { x: 200, y: 300, type: "cubic" });
  });

  test("quad mode gives one off-curve per side", () => {
    const after = pullHandles(square(), 1, { x: 50, y: 0 }, { curveType: "quad" });
    assert.equal(after.points.length, 6);
    assert.ok(after.points.filter((p) => p.type).every((p) => p.type === "quad"));
  });
});

describe("makeSmooth", () => {
  test("two lines: handles on the common direction at 1/3, anchors unchanged", () => {
    const after = makeSmooth(square(), 1);
    assert.deepEqual(anchors(after), anchors(square()));
    const i = after.points.findIndex((p) => p.x === 0 && p.y === 300 && !p.type);
    const [h, a, k] = [after.points[i - 1], after.points[i], after.points[i + 1]];
    assert.ok(a.smooth);
    assert.ok(collinear(h, a, k));
    // direction from (0,0) to (300,300): 45 degrees; length 100
    assert.deepEqual([h.x, h.y], [-71, 229]);
    assert.deepEqual([k.x, k.y], [71, 371]);
  });

  test("two lines in quad mode", () => {
    const after = makeSmooth(square(), 1, { curveType: "quad" });
    assert.deepEqual(anchors(after), anchors(square()));
    assert.equal(after.points.length, 6);
    assert.ok(after.points.filter((p) => p.type).every((p) => p.type === "quad"));
  });

  test("two curves: handles line up and keep their lengths", () => {
    const corner = wave();
    corner.points[3] = { x: 100, y: 0 };
    corner.points[4] = { x: 100, y: -80, type: "cubic" }; // a kink
    const after = makeSmooth(corner, 3);
    assert.deepEqual(anchors(after), anchors(corner));
    const [h, a, k] = [after.points[2], after.points[3], after.points[4]];
    assert.ok(a.smooth && collinear(h, a, k));
    assert.ok(Math.abs(Math.hypot(h.x - 100, h.y) - Math.hypot(30, 60)) < 1.5);
    assert.ok(Math.abs(Math.hypot(k.x - 100, k.y) - 80) < 1.5);
  });

  test("a curve and a line: the curve's handle turns onto the line", () => {
    const contour = {
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 150, y: 50, type: "cubic" },
        { x: 200, y: 100, type: "cubic" },
        { x: 200, y: 200 },
      ],
      isClosed: false,
    };
    const after = makeSmooth(contour, 1);
    assert.deepEqual(anchors(after), anchors(contour));
    assert.deepEqual(after.points[2], { x: 171, y: 0, type: "cubic" });
    assert.equal(after.points.length, contour.points.length);
  });

  test("the end of an open contour can't be smooth", () => {
    assert.equal(makeSmooth(wave(), 0), undefined);
  });
});

describe("retractHandles", () => {
  test("a smooth anchor between curves loses its handles; anchors unchanged", () => {
    const after = retractHandles(wave(), 3);
    assert.deepEqual(anchors(after), anchors(wave()));
    assert.ok(!after.points[3].smooth);
    assert.deepEqual(after.points[2], { x: 100, y: 0, type: "cubic" });
    assert.deepEqual(after.points[4], { x: 100, y: 0, type: "cubic" });
  });

  test("a curve with both handles retracted becomes a line", () => {
    const after = retractHandles(retractHandles(wave(), 3), 0);
    assert.deepEqual(after.points.slice(0, 2), [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  test("pull out, then retract, gives back the square", () => {
    const pulled = pullHandles(square(), 1, { x: 50, y: 0 });
    const i = pulled.points.findIndex((p) => p.x === 0 && p.y === 300 && !p.type);
    const back = retractHandles(pulled, i);
    // the far handles (1/3 along the lines) stay: still curves, but straight
    assert.deepEqual(anchors(back), anchors(square()));
  });

  test("a quadratic segment becomes a line", () => {
    const quad = makeSmooth(square(), 1, { curveType: "quad" });
    const i = quad.points.findIndex((p) => p.x === 0 && p.y === 300 && !p.type);
    assert.deepEqual(retractHandles(quad, i), square());
  });
});

describe("moveHandle", () => {
  test("moves one handle and makes its anchor a corner", () => {
    const after = moveHandle(wave(), 4, { x: 10, y: -10 });
    assert.deepEqual(after.points[4], { x: 140, y: -70, type: "cubic" });
    assert.ok(!after.points[3].smooth);
    assert.deepEqual(after.points[2], wave().points[2], "the other handle stays");
    assert.deepEqual(anchors(after), anchors(wave()));
  });

  test("refuses an anchor", () => {
    assert.equal(moveHandle(wave(), 3, { x: 1, y: 1 }), undefined);
  });
});

describe("straightenSegment", () => {
  test("either handle of a cubic removes both; the anchors become corners", () => {
    for (const handleIndex of [4, 5]) {
      const after = straightenSegment(wave(), handleIndex);
      assert.deepEqual(after.points.slice(3), [{ x: 100, y: 0 }, { x: 200, y: 0 }]);
      assert.deepEqual(after.points.slice(0, 3), wave().points.slice(0, 3), "other segment stays");
      assert.deepEqual(anchors(after), anchors(wave()));
    }
  });

  test("a quadratic segment, and the segment wrapping around a closed contour", () => {
    const quad = {
      points: [{ x: 0, y: 0 }, { x: 50, y: 80, type: "quad" }, { x: 100, y: 0 }],
      isClosed: false,
    };
    assert.deepEqual(straightenSegment(quad, 1).points, [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    const closed = {
      points: [
        { x: 0, y: 0, smooth: true },
        { x: 0, y: 100 },
        { x: 100, y: 100 },
        { x: 100, y: -30, type: "cubic" },
        { x: 30, y: -30, type: "cubic" },
      ],
      isClosed: true,
    };
    const after = straightenSegment(closed, 4);
    assert.deepEqual(after.points, [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ]);
    assert.ok(closed.points[0].smooth, "the input is not changed");
  });

  test("refuses an anchor", () => {
    assert.equal(straightenSegment(wave(), 3), undefined);
  });
});
