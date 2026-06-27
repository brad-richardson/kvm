import { expect, test } from "@playwright/test";

import {
  ABS_MAX,
  getEffectiveVideoArea,
  isInVideoBounds,
  LEFT_BUTTON,
  mapOffsetToAbs,
  stepTouchGesture,
  TOUCH_DRAG_THRESHOLD_PX,
} from "./absMouse";

test.describe("getEffectiveVideoArea", () => {
  test("has no bars when element and stream aspect ratios match", () => {
    const area = getEffectiveVideoArea({
      videoClientWidth: 1920,
      videoClientHeight: 1080,
      videoWidth: 1920,
      videoHeight: 1080,
    });
    expect(area).toEqual({ offsetX: 0, offsetY: 0, effectiveWidth: 1920, effectiveHeight: 1080 });
  });

  test("pillarboxes a narrow stream in a wide element", () => {
    // elementAR 2.0 > streamAR 1.333 → bars on the left/right.
    const area = getEffectiveVideoArea({
      videoClientWidth: 1000,
      videoClientHeight: 500,
      videoWidth: 640,
      videoHeight: 480,
    });
    expect(area.effectiveWidth).toBeCloseTo(666.667, 2);
    expect(area.offsetX).toBeCloseTo(166.667, 2);
    expect(area.effectiveHeight).toBe(500);
    expect(area.offsetY).toBe(0);
  });

  test("letterboxes a wide stream in a tall element", () => {
    // elementAR 0.5 < streamAR 1.778 → bars on the top/bottom.
    const area = getEffectiveVideoArea({
      videoClientWidth: 500,
      videoClientHeight: 1000,
      videoWidth: 1920,
      videoHeight: 1080,
    });
    expect(area.effectiveHeight).toBeCloseTo(281.25, 2);
    expect(area.offsetY).toBeCloseTo(359.375, 2);
    expect(area.effectiveWidth).toBe(500);
    expect(area.offsetX).toBe(0);
  });
});

test.describe("mapOffsetToAbs", () => {
  const full = getEffectiveVideoArea({
    videoClientWidth: 1920,
    videoClientHeight: 1080,
    videoWidth: 1920,
    videoHeight: 1080,
  });

  test("maps corners and center across the full 0..ABS_MAX range", () => {
    expect(mapOffsetToAbs(0, 0, full)).toEqual({ x: 0, y: 0 });
    expect(mapOffsetToAbs(1920, 1080, full)).toEqual({ x: ABS_MAX, y: ABS_MAX });
    expect(mapOffsetToAbs(960, 540, full)).toEqual({ x: 16384, y: 16384 });
  });

  test("clamps points in the pillarbox bars to the picture edge", () => {
    const pillar = getEffectiveVideoArea({
      videoClientWidth: 1000,
      videoClientHeight: 500,
      videoWidth: 640,
      videoHeight: 480,
    });
    expect(mapOffsetToAbs(100, 250, pillar).x).toBe(0); // left bar
    expect(mapOffsetToAbs(900, 250, pillar).x).toBe(ABS_MAX); // right bar
  });
});

test.describe("isInVideoBounds", () => {
  const pillar = getEffectiveVideoArea({
    videoClientWidth: 1000,
    videoClientHeight: 500,
    videoWidth: 640,
    videoHeight: 480,
  });

  test("is true inside the picture", () => {
    expect(isInVideoBounds(500, 250, pillar)).toBe(true);
  });

  test("is false in the side bars", () => {
    expect(isInVideoBounds(100, 250, pillar)).toBe(false);
    expect(isInVideoBounds(900, 250, pillar)).toBe(false);
  });

  test("is true exactly on the boundary", () => {
    expect(isInVideoBounds(pillar.offsetX, 250, pillar)).toBe(true);
  });
});

test.describe("stepTouchGesture", () => {
  test("synthesizes a click for a tap below the drag threshold", () => {
    const down = stepTouchGesture(null, {
      type: "pointerdown",
      offsetX: 100,
      offsetY: 100,
      x: 1000,
      y: 1000,
    });
    expect(down.reports).toEqual([{ x: 1000, y: 1000, buttons: 0 }]);
    expect(down.gesture?.dragging).toBe(false);

    const move = stepTouchGesture(down.gesture, {
      type: "pointermove",
      offsetX: 103,
      offsetY: 102,
      x: 1010,
      y: 1005,
    });
    expect(move.reports).toEqual([{ x: 1010, y: 1005, buttons: 0 }]);
    expect(move.gesture?.dragging).toBe(false);

    // The click is synthesized at the touch-DOWN point (1000,1000), not the
    // jittered release point.
    const up = stepTouchGesture(move.gesture, {
      type: "pointerup",
      offsetX: 104,
      offsetY: 103,
      x: 1012,
      y: 1006,
    });
    expect(up.reports).toEqual([
      { x: 1000, y: 1000, buttons: LEFT_BUTTON },
      { x: 1000, y: 1000, buttons: 0 },
    ]);
    expect(up.gesture).toBeNull();
  });

  test("presses at the origin then follows for a drag above the threshold", () => {
    const down = stepTouchGesture(null, {
      type: "pointerdown",
      offsetX: 100,
      offsetY: 100,
      x: 1000,
      y: 1000,
    });

    const cross = stepTouchGesture(down.gesture, {
      type: "pointermove",
      offsetX: 100 + TOUCH_DRAG_THRESHOLD_PX + 5,
      offsetY: 100,
      x: 1200,
      y: 1000,
    });
    expect(cross.reports).toEqual([
      { x: 1000, y: 1000, buttons: LEFT_BUTTON }, // press at origin
      { x: 1200, y: 1000, buttons: LEFT_BUTTON }, // then move
    ]);
    expect(cross.gesture?.dragging).toBe(true);

    const more = stepTouchGesture(cross.gesture, {
      type: "pointermove",
      offsetX: 140,
      offsetY: 100,
      x: 1300,
      y: 1000,
    });
    expect(more.reports).toEqual([{ x: 1300, y: 1000, buttons: LEFT_BUTTON }]);

    const up = stepTouchGesture(more.gesture, {
      type: "pointerup",
      offsetX: 140,
      offsetY: 100,
      x: 1300,
      y: 1000,
    });
    expect(up.reports).toEqual([{ x: 1300, y: 1000, buttons: 0 }]);
    expect(up.gesture).toBeNull();
  });

  test("does not promote to a drag at exactly the threshold", () => {
    const down = stepTouchGesture(null, {
      type: "pointerdown",
      offsetX: 0,
      offsetY: 0,
      x: 0,
      y: 0,
    });
    const atThreshold = stepTouchGesture(down.gesture, {
      type: "pointermove",
      offsetX: TOUCH_DRAG_THRESHOLD_PX,
      offsetY: 0,
      x: 100,
      y: 0,
    });
    expect(atThreshold.gesture?.dragging).toBe(false);
    expect(atThreshold.reports).toEqual([{ x: 100, y: 0, buttons: 0 }]);
  });

  test("just moves the cursor for a pointermove with no active gesture", () => {
    const move = stepTouchGesture(null, {
      type: "pointermove",
      offsetX: 10,
      offsetY: 10,
      x: 50,
      y: 50,
    });
    expect(move.reports).toEqual([{ x: 50, y: 50, buttons: 0 }]);
    expect(move.gesture).toBeNull();
  });

  test("releases the button for a pointerup that ends a drag", () => {
    const dragging = { startOffsetX: 0, startOffsetY: 0, startX: 0, startY: 0, dragging: true };
    const up = stepTouchGesture(dragging, {
      type: "pointerup",
      offsetX: 200,
      offsetY: 50,
      x: 5000,
      y: 1000,
    });
    expect(up.reports).toEqual([{ x: 5000, y: 1000, buttons: 0 }]);
    expect(up.gesture).toBeNull();
  });
});
