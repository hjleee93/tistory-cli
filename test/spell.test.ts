import assert from "node:assert/strict";
import test from "node:test";
import { applyFixes, parseFixes, proseForCheck, splitProse } from "../src/ai/spell.js";

test("AI 응답에서 JSON 배열만 읽고 잘못된 항목은 버림", () => {
  const fixes = parseFixes('설명\n```json\n[{"from":"됬다","to":"됐다","reason":"준말"},{"from":"a"},{"from":"x","to":"x"}]\n```');
  assert.deepEqual(fixes, [{ from: "됬다", to: "됐다", reason: "준말" }]);
  assert.deepEqual(parseFixes("[]"), []);
  assert.deepEqual(parseFixes("JSON 아님"), []);
});

test("frontmatter·코드는 보호, 본문만 검사 대상", () => {
  const text = "---\ntitle: 됬다\n---\n본문 됬다 `됬다` 끝\n\n```js\n됬다()\n```\n";
  assert.ok(splitProse(text).filter((s) => s.protectedPart).length >= 3);
  assert.doesNotMatch(proseForCheck(text), /title|js/);
});

test("적용: 본문 모든 곳 바꾸되 코드·frontmatter 는 그대로, 없는 구절은 건너뜀", () => {
  const text = "---\ntitle: 됬다\n---\n본문 됬다, 또 됬다 `됬다`\n\n```js\n됬다()\n```\n";
  const r = applyFixes(text, [
    { from: "됬다", to: "됐다", reason: "" },
    { from: "없는구절", to: "x", reason: "" },
  ]);
  assert.equal(r.text, "---\ntitle: 됬다\n---\n본문 됐다, 또 됐다 `됬다`\n\n```js\n됬다()\n```\n");
  assert.equal(r.applied[0]?.count, 2);
  assert.equal(r.skipped.length, 1);
});

test("코드 안에만 있는 구절은 적용되지 않는다", () => {
  const r = applyFixes("글\n```\n됬다\n```\n", [{ from: "됬다", to: "됐다", reason: "" }]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.skipped.length, 1);
});
