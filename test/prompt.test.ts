import assert from "node:assert/strict";
import test from "node:test";
import { moveSelection, windowStart } from "../src/ui/prompt.js";

test("커서 이동: 순환, 처음/끝, 페이지", () => {
  assert.equal(moveSelection(0, "up", 5), 4);
  assert.equal(moveSelection(4, "down", 5), 0);
  assert.equal(moveSelection(2, "home", 5), 0);
  assert.equal(moveSelection(2, "end", 5), 4);
  assert.equal(moveSelection(1, "pagedown", 20, 8), 9);
  assert.equal(moveSelection(3, "pageup", 20, 8), 0);
});

test("목록 창: 항상 커서를 포함하고 범위를 벗어나지 않음", () => {
  assert.equal(windowStart(0, 5, 10), 0);
  for (const index of [0, 5, 10, 19]) {
    const start = windowStart(index, 20, 8);
    assert.ok(index >= start && index < start + 8 && start >= 0 && start + 8 <= 20);
  }
});
