import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DispatchCapState, INITIAL_DISPATCH_CAP_STATE, trackDispatch } from "../src/core/dispatchCap";

describe("dispatch cap", () => {
  it("does nothing while under the cap", () => {
    let state: DispatchCapState = INITIAL_DISPATCH_CAP_STATE;
    for (let i = 0; i < 2; i++) {
      const r = trackDispatch(state, "haiku", 3);
      assert.equal(r.raiseTo, undefined);
      state = r.state;
    }
    assert.equal(state.consecutiveCount, 2);
  });

  it("raises the floor one tier once the cap is hit", () => {
    let state: DispatchCapState = INITIAL_DISPATCH_CAP_STATE;
    for (let i = 0; i < 2; i++) state = trackDispatch(state, "haiku", 3).state;
    const hit = trackDispatch(state, "haiku", 3);
    assert.equal(hit.raiseTo, "sonnet");
    assert.equal(hit.state.consecutiveCount, 0, "count resets after raising");
  });

  it("a change of family resets the count instead of raising", () => {
    let state: DispatchCapState = INITIAL_DISPATCH_CAP_STATE;
    state = trackDispatch(state, "haiku", 3).state;
    state = trackDispatch(state, "haiku", 3).state;
    const r = trackDispatch(state, "sonnet", 3);
    assert.equal(r.raiseTo, undefined);
    assert.equal(r.state.consecutiveCount, 1);
    assert.equal(r.state.lastFamily, "sonnet");
  });

  it("never raises past fable, the top tier", () => {
    let state: DispatchCapState = INITIAL_DISPATCH_CAP_STATE;
    for (let i = 0; i < 5; i++) {
      const r = trackDispatch(state, "fable", 3);
      assert.equal(r.raiseTo, undefined);
      state = r.state;
    }
    assert.equal(state.consecutiveCount, 5);
  });

  it("0 (or negative) disables the cap entirely", () => {
    let state: DispatchCapState = INITIAL_DISPATCH_CAP_STATE;
    for (let i = 0; i < 10; i++) {
      const r = trackDispatch(state, "haiku", 0);
      assert.equal(r.raiseTo, undefined);
      state = r.state;
    }
  });

  it("raises again after the next streak reaches the cap", () => {
    let state: DispatchCapState = INITIAL_DISPATCH_CAP_STATE;
    state = trackDispatch(state, "haiku", 2).state;
    const first = trackDispatch(state, "haiku", 2);
    assert.equal(first.raiseTo, "sonnet");
    state = first.state;
    state = trackDispatch(state, "sonnet", 2).state;
    const second = trackDispatch(state, "sonnet", 2);
    assert.equal(second.raiseTo, "opus");
  });
});
