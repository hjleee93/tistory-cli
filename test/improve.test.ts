import assert from "node:assert/strict";
import test from "node:test";
import { cleanBody, countChanges, diffUnits, integrityWarnings, renderDiff, splitFrontmatter, toUnits } from "../src/ai/improve.js";

test("frontmatter 분리", () => {
  const { front, body } = splitFrontmatter("---\ntitle: A\n---\n본문\n");
  assert.equal(front, "---\ntitle: A\n---\n");
  assert.equal(body, "본문\n");
  assert.equal(splitFrontmatter("본문").front, "");
});

test("전체를 감싼 코드 펜스 제거", () => {
  assert.equal(cleanBody("```markdown\n안녕\n```"), "안녕\n");
});

test("문장 단위로 쪼갠 diff: 바뀐 문장만 삭제/추가", () => {
  const a = toUnits("첫째 문장이다. 둘째 문장이다.\n셋째 줄");
  const b = toUnits("첫째 문장이다. 둘째 문장입니다.\n셋째 줄");
  assert.deepEqual(a, ["첫째 문장이다.", "둘째 문장이다.", "셋째 줄"]);
  const ops = diffUnits(a, b);
  assert.deepEqual(countChanges(ops), { added: 1, removed: 1 });
  const out = renderDiff(ops, { context: 0 }) ?? "";
  assert.match(out, /- 둘째 문장이다\./);
  assert.match(out, /\+ 둘째 문장입니다\./);
  assert.doesNotMatch(out, /첫째/);
});

test("변경이 없으면 diff 없음", () => {
  const u = toUnits("같은 글");
  assert.equal(renderDiff(diffUnits(u, u)), undefined);
});

test("코드 블록·이미지 변경, 지나치게 짧아짐을 경고", () => {
  const before = "글입니다 글입니다 글입니다\n\n```js\na()\n```\n\n![x](a.png)\n";
  assert.deepEqual(integrityWarnings(before, before), []);
  assert.ok(integrityWarnings(before, before.replace("a()", "b()")).length > 0);
  assert.ok(integrityWarnings(before, before.replace("a.png", "c.png")).length > 0);
  assert.ok(integrityWarnings(before, "짧").length > 0);
});
