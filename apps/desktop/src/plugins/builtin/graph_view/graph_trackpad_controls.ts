import { MathUtils, type PerspectiveCamera, Vector3 } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/** Keep a point on the target plane under the pointer while changing distance. */
export function zoomGraphAtPointer(
  camera: PerspectiveCamera,
  target: Vector3,
  scale: number,
  pointer: { x: number; y: number },
  minDistance: number,
  maxDistance: number,
): void {
  const distance = camera.position.distanceTo(target);
  if (distance === 0 || !Number.isFinite(scale) || scale <= 0) return;
  const ratio = MathUtils.clamp(distance * scale, minDistance, maxDistance) / distance;
  camera.updateMatrixWorld();
  const halfHeight = distance * Math.tan(MathUtils.degToRad(camera.getEffectiveFOV() / 2));
  const anchor = target
    .clone()
    .addScaledVector(
      new Vector3().setFromMatrixColumn(camera.matrixWorld, 0),
      pointer.x * halfHeight * camera.aspect,
    )
    .addScaledVector(
      new Vector3().setFromMatrixColumn(camera.matrixWorld, 1),
      pointer.y * halfHeight,
    );
  camera.position.sub(anchor).multiplyScalar(ratio).add(anchor);
  target.sub(anchor).multiplyScalar(ratio).add(anchor);
}

function consume(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

type GestureEvent = Event & { scale: number; clientX?: number; clientY?: number };

/** Pixel scrolling pans; pinch zooms; Shift + scrolling or dragging orbits. */
export function attachGraphTrackpadControls(
  element: HTMLElement,
  camera: PerspectiveCamera,
  controls: OrbitControls,
  onInteraction: () => void,
): () => void {
  let gestureScale: number | undefined;
  let lastGestureAt = -Infinity;
  const pointer = (x?: number, y?: number) => {
    const rect = element.getBoundingClientRect();
    return {
      x: x === undefined ? 0 : ((x - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      y: y === undefined ? 0 : 1 - ((y - rect.top) / Math.max(1, rect.height)) * 2,
    };
  };
  const zoom = (scale: number, x?: number, y?: number) => {
    zoomGraphAtPointer(
      camera,
      controls.target,
      scale,
      pointer(x, y),
      controls.minDistance,
      controls.maxDistance,
    );
    controls.update();
  };
  const wheel = (event: WheelEvent) => {
    if (!controls.enabled) return;
    consume(event);
    // WKWebView may deliver both native gesture and Ctrl-wheel for one pinch.
    if (gestureScale !== undefined || (event.ctrlKey && performance.now() - lastGestureAt < 150))
      return;
    onInteraction();
    const height = Math.max(1, element.getBoundingClientRect().height);
    let unit = 1;
    if (event.deltaMode === 1) unit = 16;
    else if (event.deltaMode === 2) unit = height;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (!event.shiftKey && event.deltaMode !== 0)
    ) {
      // Trackpad pinch uses Ctrl-wheel in Chromium. Alt also permits mouse zoom.
      zoom(
        Math.exp(MathUtils.clamp(dy * (event.ctrlKey ? 0.01 : 0.002), -0.5, 0.5)),
        event.clientX,
        event.clientY,
      );
    } else if (event.shiftKey) {
      controls.rotateLeft((2 * Math.PI * dx * controls.rotateSpeed) / height);
      controls.rotateUp((2 * Math.PI * dy * controls.rotateSpeed) / height);
    } else {
      camera.updateMatrixWorld();
      const unitsPerPixel =
        (2 *
          camera.position.distanceTo(controls.target) *
          Math.tan(MathUtils.degToRad(camera.getEffectiveFOV() / 2))) /
        height;
      const offset = new Vector3()
        .setFromMatrixColumn(camera.matrixWorld, 0)
        .multiplyScalar(dx * unitsPerPixel)
        .addScaledVector(
          new Vector3().setFromMatrixColumn(camera.matrixWorld, 1),
          -dy * unitsPerPixel,
        );
      camera.position.add(offset);
      controls.target.add(offset);
      controls.update();
    }
  };
  const gestureStart = (event: Event) => {
    if (!controls.enabled) return;
    consume(event);
    onInteraction();
    gestureScale = 1;
    lastGestureAt = performance.now();
  };
  const gestureChange = (event: Event) => {
    if (!controls.enabled || gestureScale === undefined) return;
    consume(event);
    const gesture = event as GestureEvent;
    if (!Number.isFinite(gesture.scale) || gesture.scale <= 0) return;
    onInteraction();
    zoom(gestureScale / gesture.scale, gesture.clientX, gesture.clientY);
    gestureScale = gesture.scale;
    lastGestureAt = performance.now();
  };
  const gestureEnd = (event: Event) => {
    if (gestureScale === undefined) return;
    consume(event);
    gestureScale = undefined;
    lastGestureAt = performance.now();
  };
  const pointerStart = () => {
    if (controls.enabled) onInteraction();
  };
  element.addEventListener("wheel", wheel, { capture: true, passive: false });
  element.addEventListener("gesturestart", gestureStart, { capture: true, passive: false });
  element.addEventListener("gesturechange", gestureChange, { capture: true, passive: false });
  element.addEventListener("gestureend", gestureEnd, { capture: true, passive: false });
  element.addEventListener("pointerdown", pointerStart, true);
  return () => {
    element.removeEventListener("wheel", wheel, true);
    element.removeEventListener("gesturestart", gestureStart, true);
    element.removeEventListener("gesturechange", gestureChange, true);
    element.removeEventListener("gestureend", gestureEnd, true);
    element.removeEventListener("pointerdown", pointerStart, true);
  };
}
