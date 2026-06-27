import { useCallback, useRef, useState } from "react";

import { useJsonRpc } from "./useJsonRpc";
import { useHidRpc } from "./useHidRpc";
import { useMouseStore, useSettingsStore } from "./stores";
import {
  getEffectiveVideoArea,
  isInVideoBounds,
  mapOffsetToAbs,
  stepTouchGesture,
  type TouchGesture,
  type TouchPointerEvent,
} from "./absMouse";

const calcDelta = (pos: number) => (Math.abs(pos) < 10 ? pos * 2 : pos);

export interface AbsMouseMoveHandlerProps {
  videoClientWidth: number;
  videoClientHeight: number;
  videoWidth: number;
  videoHeight: number;
}

export default function useMouse() {
  // states
  const { setMousePosition, setMouseMove } = useMouseStore();
  const [blockWheelEvent, setBlockWheelEvent] = useState(false);

  const { mouseMode, scrollThrottling, invertScroll } = useSettingsStore();

  // Track last absolute mouse position for resetMousePosition
  const lastAbsPos = useRef({ x: 0, y: 0 });

  // Active touch gesture for tap-vs-drag detection in absolute mode.
  const touchGesture = useRef<TouchGesture>(null);

  // RPC hooks
  const { send } = useJsonRpc();
  const { reportAbsMouseEvent, reportRelMouseEvent, rpcHidReady } = useHidRpc();
  // Mouse-related

  const sendRelMouseMovement = useCallback(
    (x: number, y: number, buttons: number) => {
      if (mouseMode !== "relative") return;
      // if we ignore the event, double-click will not work
      // if (x === 0 && y === 0 && buttons === 0) return;
      const dx = calcDelta(x);
      const dy = calcDelta(y);
      // Keep L/R/M/X1/X2; drop pen-eraser and any future high bits.
      const b = buttons & 0x1f;
      if (rpcHidReady) {
        reportRelMouseEvent(dx, dy, b);
      } else {
        // kept for backward compatibility
        send("relMouseReport", { dx, dy, buttons: b });
      }
      setMouseMove({ x, y, buttons: b });
    },
    [send, reportRelMouseEvent, setMouseMove, mouseMode, rpcHidReady],
  );

  const getRelMouseMoveHandler = useCallback(
    () => (e: MouseEvent) => {
      if (mouseMode !== "relative") return;

      // Send mouse movement
      const { buttons } = e;
      sendRelMouseMovement(e.movementX, e.movementY, buttons);
    },
    [sendRelMouseMovement, mouseMode],
  );

  const sendAbsMouseMovement = useCallback(
    (x: number, y: number, buttons: number) => {
      if (mouseMode !== "absolute") return;
      // Keep L/R/M/X1/X2; drop pen-eraser and any future high bits.
      const b = buttons & 0x1f;
      if (rpcHidReady) {
        reportAbsMouseEvent(x, y, b);
      } else {
        // kept for backward compatibility
        send("absMouseReport", { x, y, buttons: b });
      }
      // We set that for the debug info bar
      setMousePosition(x, y);
      lastAbsPos.current = { x, y };
    },
    [send, reportAbsMouseEvent, setMousePosition, mouseMode, rpcHidReady],
  );

  const getAbsMouseMoveHandler = useCallback(
    ({ videoClientWidth, videoClientHeight, videoWidth, videoHeight }: AbsMouseMoveHandlerProps) =>
      (e: MouseEvent) => {
        if (!videoClientWidth || !videoClientHeight) return;
        if (mouseMode !== "absolute") return;

        const area = getEffectiveVideoArea({
          videoClientWidth,
          videoClientHeight,
          videoWidth,
          videoHeight,
        });
        const { x, y } = mapOffsetToAbs(e.offsetX, e.offsetY, area);

        const pe = e as PointerEvent;
        if (pe.pointerType !== "touch") {
          // Mouse and pen forward the button state directly (unchanged behavior).
          sendAbsMouseMovement(x, y, e.buttons);
          return;
        }

        // Only the primary finger drives the cursor; ignore additional touch
        // points such as the second finger of a pinch-zoom, which would
        // otherwise corrupt the single tracked gesture.
        if (!pe.isPrimary) return;

        // Ignore touches in the letterbox/pillarbox bars so the dead zone doesn't
        // click the remote. Exceptions: an in-progress drag may cross into a bar,
        // and a pointerup must always finalize an active gesture so an edge tap
        // still clicks and the gesture state is cleared.
        const finalizingGesture = e.type === "pointerup" && touchGesture.current !== null;
        if (
          !finalizingGesture &&
          touchGesture.current?.dragging !== true &&
          !isInVideoBounds(e.offsetX, e.offsetY, area)
        ) {
          return;
        }

        const { gesture, reports } = stepTouchGesture(touchGesture.current, {
          type: e.type as TouchPointerEvent["type"],
          offsetX: e.offsetX,
          offsetY: e.offsetY,
          x,
          y,
        });
        touchGesture.current = gesture;
        for (const report of reports) {
          sendAbsMouseMovement(report.x, report.y, report.buttons);
        }
      },
    [mouseMode, sendAbsMouseMovement],
  );

  const getMouseWheelHandler = useCallback(
    () => (e: WheelEvent) => {
      if (scrollThrottling && blockWheelEvent) {
        return;
      }

      const clampWheel = (delta: number): number => {
        const isAccel = Math.abs(delta) >= 100;
        const scrollValue = isAccel ? delta / 100 : Math.sign(delta);
        return Math.max(-127, Math.min(127, scrollValue));
      };

      // Negate Y: browser deltaY positive = scroll down, HID Wheel positive = scroll up
      const wheelY = (invertScroll ? 1 : -1) * clampWheel(e.deltaY);
      // X conventions already match (positive = right), but macOS Natural Scrolling
      // inverts both axes at OS level, so we negate X to counteract when inverted
      const wheelX = (invertScroll ? -1 : 1) * clampWheel(e.deltaX);

      if (wheelY === 0 && wheelX === 0) return;

      send("wheelReport", { wheelY, wheelX });

      // Apply blocking delay based of throttling settings
      if (scrollThrottling && !blockWheelEvent) {
        setBlockWheelEvent(true);
        setTimeout(() => setBlockWheelEvent(false), scrollThrottling);
      }
    },
    [send, blockWheelEvent, scrollThrottling, invertScroll],
  );

  const resetMousePosition = useCallback(() => {
    touchGesture.current = null;
    sendAbsMouseMovement(lastAbsPos.current.x, lastAbsPos.current.y, 0);
  }, [sendAbsMouseMovement]);

  return {
    getRelMouseMoveHandler,
    getAbsMouseMoveHandler,
    getMouseWheelHandler,
    resetMousePosition,
  };
}
