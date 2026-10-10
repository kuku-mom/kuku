// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { attachGraphTrackpadControls, zoomGraphAtPointer } from "./graph_trackpad_controls";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
function setup() {
  const element = document.createElement("canvas");
  document.body.append(element);
  element.setPointerCapture = vi.fn();
  element.releasePointerCapture = vi.fn();
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 600,
  } as DOMRect);
  const camera = new PerspectiveCamera(60, 800 / 600, 0.1, 100000);
  camera.position.set(0, 0, 780);
  const controls = new OrbitControls(camera, element);
  controls.minDistance = 30;
  controls.maxDistance = 100000;
  const onInteraction = vi.fn();
  const dispose = attachGraphTrackpadControls(element, camera, controls, onInteraction);
  cleanups.push(() => {
    dispose();
    controls.dispose();
    element.remove();
  });
  const wheel = (options: WheelEventInit = {}) => {
    const event = new WheelEvent("wheel", {
      cancelable: true,
      bubbles: true,
      clientX: 400,
      clientY: 300,
      ...options,
    });
    element.dispatchEvent(event);
    return event;
  };
  const gesture = (type: string, scale = 1) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { scale, clientX: 400, clientY: 300 });
    element.dispatchEvent(event);
  };
  return { element, camera, controls, onInteraction, dispose, wheel, gesture };
}

describe("graph trackpad navigation", () => {
  it("pans diagonally without changing distance or orientation, including tiny deltas", () => {
    const { camera, controls, wheel, onInteraction } = setup();
    const rotation = camera.quaternion.clone();
    const origin = camera.position.clone();
    expect(wheel({ deltaX: 0.25, deltaY: 18 }).defaultPrevented).toBe(true);
    expect(camera.position.x).toBeGreaterThan(0);
    expect(camera.position.y).toBeLessThan(0);
    expect(camera.position.clone().sub(origin).distanceTo(controls.target)).toBeLessThan(1e-8);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(780);
    expect(camera.quaternion.angleTo(rotation)).toBeLessThan(1e-8);
    expect(onInteraction).toHaveBeenCalledOnce();
  });
  it("pinches in both directions without also invoking the built-in wheel zoom", () => {
    const { camera, controls, wheel } = setup();
    wheel({ deltaY: -10, ctrlKey: true });
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(780 * Math.exp(-0.1));
    wheel({ deltaY: 10, ctrlKey: true });
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(780);
  });
  it("orbits with Shift-scroll without moving the target or changing distance", () => {
    const { camera, controls, wheel } = setup();
    wheel({ deltaX: 30, deltaY: 20, shiftKey: true });
    expect(Math.abs(camera.position.x)).toBeGreaterThan(1);
    expect(Math.abs(camera.position.y)).toBeGreaterThan(1);
    expect(controls.target.length()).toBe(0);
    expect(camera.position.length()).toBeCloseTo(780);
  });
  it("keeps line-mode mouse wheel and Alt-wheel zoom available", () => {
    const { camera, controls, wheel } = setup();
    wheel({ deltaMode: 1, deltaY: -3 });
    expect(camera.position.distanceTo(controls.target)).toBeLessThan(780);
    const distance = camera.position.length();
    wheel({ deltaY: 10, altKey: true });
    expect(camera.position.length()).toBeGreaterThan(distance);
  });
  it("handles cumulative WebKit pinch scales and suppresses duplicate Ctrl-wheel", () => {
    const { camera, gesture, wheel } = setup();
    gesture("gesturestart");
    gesture("gesturechange", 1.2);
    gesture("gesturechange", 1.5);
    expect(camera.position.length()).toBeCloseTo(780 / 1.5);
    wheel({ deltaY: -10, ctrlKey: true });
    expect(camera.position.length()).toBeCloseTo(780 / 1.5);
    gesture("gestureend");
    wheel({ deltaY: -10, ctrlKey: true });
    expect(camera.position.length()).toBeCloseTo(780 / 1.5);
    wheel({ deltaX: 20 });
    expect(camera.position.x).toBeGreaterThan(0);
  });
  it("stops camera animation on pointer input and removes every custom listener on cleanup", () => {
    const { element, onInteraction, dispose, wheel, gesture } = setup();
    element.dispatchEvent(new Event("pointerdown"));
    expect(onInteraction).toHaveBeenCalledOnce();
    dispose();
    onInteraction.mockClear();
    wheel({ deltaY: 20 });
    gesture("gesturestart");
    gesture("gesturechange", 2);
    element.dispatchEvent(new Event("pointerdown"));
    expect(onInteraction).not.toHaveBeenCalled();
  });
  it("leaves disabled controls untouched", () => {
    const { camera, controls, onInteraction, wheel, gesture } = setup();
    controls.enabled = false;
    expect(wheel({ deltaY: 20 }).defaultPrevented).toBe(false);
    gesture("gesturestart");
    gesture("gesturechange", 2);
    expect(camera.position.length()).toBe(780);
    expect(onInteraction).not.toHaveBeenCalled();
  });
  it("keeps the pointer anchor stationary after zooming an arbitrarily rotated camera", () => {
    const { camera, controls } = setup();
    camera.position.set(200, 400, 800);
    controls.target.set(30, -10, 20);
    controls.update();
    camera.updateMatrixWorld();
    const pointer = { x: 0.45, y: -0.3 };
    const ray = new Vector3(pointer.x, pointer.y, 0.5)
      .unproject(camera)
      .sub(camera.position)
      .normalize();
    const normal = camera.getWorldDirection(new Vector3());
    const anchor = camera.position
      .clone()
      .addScaledVector(ray, camera.position.distanceTo(controls.target) / ray.dot(normal));
    zoomGraphAtPointer(camera, controls.target, 0.6, pointer, 30, 100000);
    controls.update();
    camera.updateMatrixWorld();
    const projected = anchor.project(camera);
    expect(projected.x).toBeCloseTo(pointer.x);
    expect(projected.y).toBeCloseTo(pointer.y);
    zoomGraphAtPointer(camera, controls.target, 1e-8, pointer, 30, 100000);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(30);
    zoomGraphAtPointer(camera, controls.target, 1e8, pointer, 30, 100000);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(100000);
  });
});
