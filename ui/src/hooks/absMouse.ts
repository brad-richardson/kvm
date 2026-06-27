// Pure, side-effect-free helpers for absolute-mode mouse/touch input.
//
// These are split out of `useMouse` so the geometry math and the touch
// tap-vs-drag state machine can be unit-tested without React, the DOM, or the
// HID RPC layer. `useMouse` is a thin adapter that wires these to pointer
// events and forwards the resulting reports over the data channel.

// HID absolute coordinates span 0..ABS_MAX on each axis.
export const ABS_MAX = 32767;

// The synthesized button for touch input (left button). Touch can only ever
// produce a left click/drag.
export const LEFT_BUTTON = 1;

// Movement (in CSS px) a touch must exceed before it's treated as a drag rather
// than a tap. Below this, a touch press/release is synthesized as a clean click
// so fingertip jitter doesn't turn every tap into a drag-select (e.g. in a
// terminal).
export const TOUCH_DRAG_THRESHOLD_PX = 10;

export interface VideoGeometry {
  videoClientWidth: number;
  videoClientHeight: number;
  videoWidth: number;
  videoHeight: number;
}

// The actual displayed picture inside the (possibly larger) video element, plus
// the letterbox/pillarbox offset of that picture within the element.
export interface EffectiveArea {
  offsetX: number;
  offsetY: number;
  effectiveWidth: number;
  effectiveHeight: number;
}

// Compute the displayed picture rectangle for an `object-contain` video,
// accounting for letterboxing (top/bottom bars) and pillarboxing (left/right
// bars) when the element and stream aspect ratios differ.
export function getEffectiveVideoArea(g: VideoGeometry): EffectiveArea {
  const { videoClientWidth, videoClientHeight, videoWidth, videoHeight } = g;
  const videoElementAspectRatio = videoClientWidth / videoClientHeight;
  const videoStreamAspectRatio = videoWidth / videoHeight;

  let effectiveWidth = videoClientWidth;
  let effectiveHeight = videoClientHeight;
  let offsetX = 0;
  let offsetY = 0;

  if (videoElementAspectRatio > videoStreamAspectRatio) {
    // Pillarboxing: bars on the left and right.
    effectiveWidth = videoClientHeight * videoStreamAspectRatio;
    offsetX = (videoClientWidth - effectiveWidth) / 2;
  } else if (videoElementAspectRatio < videoStreamAspectRatio) {
    // Letterboxing: bars on the top and bottom.
    effectiveHeight = videoClientWidth / videoStreamAspectRatio;
    offsetY = (videoClientHeight - effectiveHeight) / 2;
  }

  return { offsetX, offsetY, effectiveWidth, effectiveHeight };
}

// True when an element-space offset falls inside the displayed picture (i.e. not
// in a letterbox/pillarbox bar).
export function isInVideoBounds(offsetX: number, offsetY: number, area: EffectiveArea): boolean {
  return (
    offsetX >= area.offsetX &&
    offsetX <= area.offsetX + area.effectiveWidth &&
    offsetY >= area.offsetY &&
    offsetY <= area.offsetY + area.effectiveHeight
  );
}

// Map an element-space offset to HID absolute coordinates (0..ABS_MAX), clamping
// points in the bars to the nearest picture edge.
export function mapOffsetToAbs(
  offsetX: number,
  offsetY: number,
  area: EffectiveArea,
): { x: number; y: number } {
  const clampedX = Math.min(Math.max(area.offsetX, offsetX), area.offsetX + area.effectiveWidth);
  const clampedY = Math.min(Math.max(area.offsetY, offsetY), area.offsetY + area.effectiveHeight);

  const relativeX = (clampedX - area.offsetX) / area.effectiveWidth;
  const relativeY = (clampedY - area.offsetY) / area.effectiveHeight;

  return {
    x: Math.round(relativeX * ABS_MAX),
    y: Math.round(relativeY * ABS_MAX),
  };
}

// A single absolute-mouse report to emit to the remote.
export interface AbsReport {
  x: number;
  y: number;
  buttons: number;
}

export interface TouchGestureState {
  startOffsetX: number;
  startOffsetY: number;
  startX: number;
  startY: number;
  dragging: boolean;
}

export type TouchGesture = TouchGestureState | null;

export interface TouchPointerEvent {
  type: "pointerdown" | "pointermove" | "pointerup";
  // Element-space offset, used to measure tap-vs-drag distance.
  offsetX: number;
  offsetY: number;
  // Pre-mapped HID absolute coordinates for this event.
  x: number;
  y: number;
}

// Pure reducer for touch tap-vs-drag detection. Given the current gesture and a
// pointer event (already mapped to absolute coords), returns the next gesture
// state and the report(s) to send:
//
//   - pointerdown: position the cursor without pressing (a tap must not press
//     on contact, or jitter would drag-select).
//   - pointermove: once movement exceeds `thresholdPx`, press at the original
//     touch point and then follow; otherwise just track the cursor unpressed.
//   - pointerup: a gesture that never crossed the threshold synthesizes a clean
//     click; a drag is simply released.
export function stepTouchGesture(
  gesture: TouchGesture,
  ev: TouchPointerEvent,
  thresholdPx: number = TOUCH_DRAG_THRESHOLD_PX,
): { gesture: TouchGesture; reports: AbsReport[] } {
  const { type, offsetX, offsetY, x, y } = ev;

  if (type === "pointerdown") {
    return {
      gesture: {
        startOffsetX: offsetX,
        startOffsetY: offsetY,
        startX: x,
        startY: y,
        dragging: false,
      },
      reports: [{ x, y, buttons: 0 }],
    };
  }

  if (type === "pointermove") {
    if (!gesture) {
      return { gesture: null, reports: [{ x, y, buttons: 0 }] };
    }

    let next = gesture;
    const reports: AbsReport[] = [];

    if (!gesture.dragging) {
      const dx = offsetX - gesture.startOffsetX;
      const dy = offsetY - gesture.startOffsetY;
      if (Math.hypot(dx, dy) > thresholdPx) {
        next = { ...gesture, dragging: true };
        // Press at the original touch point first, then move to current.
        reports.push({ x: gesture.startX, y: gesture.startY, buttons: LEFT_BUTTON });
      }
    }

    reports.push({ x, y, buttons: next.dragging ? LEFT_BUTTON : 0 });
    return { gesture: next, reports };
  }

  // pointerup
  if (gesture && !gesture.dragging) {
    // Tap → synthesize a clean click at the original touch-down point, ignoring
    // the few px of release jitter (which may even land in a letterbox bar).
    return {
      gesture: null,
      reports: [
        { x: gesture.startX, y: gesture.startY, buttons: LEFT_BUTTON },
        { x: gesture.startX, y: gesture.startY, buttons: 0 },
      ],
    };
  }

  // End of a drag (or stray up with no gesture) → ensure the button is released.
  return { gesture: null, reports: [{ x, y, buttons: 0 }] };
}
