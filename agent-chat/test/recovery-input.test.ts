import { expect, test } from "bun:test";
import * as session from "../src/session";

test("the Boss input observer reports draft, paste, image, and control input before submission", () => {
  for (const kind of ["input", "keydown", "compositionstart", "paste", "drop", "change", "pointerdown"]) {
    const target = new EventTarget();
    let inputs = 0;
    const dispose = (session as any).observeBossUserInput(target, () => { inputs += 1; return true; });
    target.dispatchEvent(new Event(kind));
    expect(inputs).toBe(1);
    target.dispatchEvent(new Event(kind));
    expect(inputs).toBe(1);
    dispose();
    target.dispatchEvent(new Event(kind));
    expect(inputs).toBe(1);
  }
});

test("disconnected input is retried, and registering a new connection restores observation", () => {
  const target = new EventTarget();
  let attempts = 0;
  const observe = () => (session as any).observeBossUserInput(target, () => ++attempts > 1);
  const first = observe();
  target.dispatchEvent(new Event("input"));
  target.dispatchEvent(new Event("input"));
  expect(attempts).toBe(2);
  first();
  const second = observe();
  target.dispatchEvent(new Event("input"));
  expect(attempts).toBe(3);
  second();
});
