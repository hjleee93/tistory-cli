import assert from "node:assert/strict";
import { test } from "node:test";
import { isTistoryUrl, pickDraftTarget } from "../src/ui/open.js";

test("tistory.com 주소만 허용", () => {
  assert.equal(isTistoryUrl("https://myblog.tistory.com/manage/newpost/"), true);
  assert.equal(isTistoryUrl("https://tistory.com/"), true);
  assert.equal(isTistoryUrl("http://myblog.tistory.com/"), false); // http 불가
  assert.equal(isTistoryUrl("https://evil.com/?x=.tistory.com"), false);
  assert.equal(isTistoryUrl("https://tistory.com.evil.com/"), false);
  assert.equal(isTistoryUrl("javascript:alert(1)"), false);
  assert.equal(isTistoryUrl("file:///etc/passwd"), false);
  assert.equal(isTistoryUrl("not a url"), false);
});

test("저장 직후 주소에 글 번호가 있으면 그 글을 연다 (쿼리 제거)", () => {
  const t = pickDraftTarget(
    "myblog",
    "https://myblog.tistory.com/manage/post/123?returnURL=https%3A%2F%2Fa",
  );
  assert.deepEqual(t, { url: "https://myblog.tistory.com/manage/post/123", exact: true });
});

test("글 번호가 없으면 글쓰기 화면으로 대신 연다", () => {
  const t = pickDraftTarget("myblog", "https://myblog.tistory.com/manage/newpost/");
  assert.deepEqual(t, { url: "https://myblog.tistory.com/manage/newpost/", exact: false });
});

test("주소를 모르거나 이상하면 글쓰기 화면", () => {
  for (const saved of [undefined, "", "about:blank", "https://evil.com/manage/post/1"]) {
    const t = pickDraftTarget("myblog", saved);
    assert.equal(t.exact, false);
    assert.equal(t.url, "https://myblog.tistory.com/manage/newpost/");
  }
});
