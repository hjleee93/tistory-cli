import assert from "node:assert/strict";
import { test } from "node:test";
import { PostError, findLocalImages, parsePostText } from "../src/post/post.js";

const problemsOf = (text: string): string[] => {
  try {
    parsePostText(text);
  } catch (error) {
    if (error instanceof PostError) return error.problems;
    throw error;
  }
  return [];
};

test("frontmatter의 제목·태그·카테고리·공개범위를 읽는다", () => {
  const post = parsePostText(
    "---\ntitle: 첫 글\ntags: [a, b]\ncategory: 개발\nvisibility: private\n---\n본문입니다",
  );
  assert.equal(post.title, "첫 글");
  assert.deepEqual(post.tags, ["a", "b"]);
  assert.equal(post.category, "개발");
  assert.equal(post.visibility, "private");
  assert.match(post.html, /<p>본문입니다<\/p>/);
});

test("공개 범위 기본값은 public", () => {
  assert.equal(parsePostText("---\ntitle: t\n---\nbody").visibility, "public");
});

test("frontmatter가 없으면 첫 줄 # 제목을 제목으로 쓰고 본문에서 뺀다", () => {
  const post = parsePostText("# 제목입니다\n\n본문");
  assert.equal(post.title, "제목입니다");
  assert.doesNotMatch(post.html, /제목입니다/);
  assert.match(post.html, /본문/);
});

test("frontmatter 제목이 있으면 본문의 # 제목은 그대로 둔다", () => {
  const post = parsePostText("---\ntitle: A\n---\n# B\n\n본문");
  assert.equal(post.title, "A");
  assert.match(post.html, /<h1[^>]*>B<\/h1>/);
});

test("제목이 없으면 오류", () => {
  assert.match(problemsOf("그냥 본문").join("\n"), /제목이 없습니다/);
});

test("본문이 비어 있으면 오류", () => {
  assert.match(problemsOf("---\ntitle: t\n---\n  \n").join("\n"), /본문이 비어/);
});

test("tags를 쉼표 문자열로 써도 되고, # 제거·중복 제거·공백 정리", () => {
  const post = parsePostText("---\ntitle: t\ntags: '#a, b ,, a'\n---\nx");
  assert.deepEqual(post.tags, ["a", "b"]);
});

test("숫자 태그도 글자로 처리", () => {
  const post = parsePostText("---\ntitle: t\ntags: [2024, 일상]\n---\nx");
  assert.deepEqual(post.tags, ["2024", "일상"]);
});

test("잘못된 visibility는 오류", () => {
  assert.match(
    problemsOf("---\ntitle: t\nvisibility: secret\n---\nx").join("\n"),
    /visibility/,
  );
});

test("알 수 없는 설정은 경고만 하고 무시", () => {
  const post = parsePostText("---\ntitle: t\ntag: [a]\n---\nx");
  assert.deepEqual(post.tags, []);
  assert.ok(post.warnings.some((w) => w.includes('"tag"')));
});

test("YAML 오류는 따옴표 안내와 함께 알려 준다", () => {
  const problems = problemsOf("---\ntitle: 리뷰: 좋았던 점\n---\nx");
  assert.ok(problems.length >= 2);
  assert.match(problems.join("\n"), /따옴표/);
});

test("CRLF 줄바꿈과 BOM을 처리한다", () => {
  const post = parsePostText("﻿---\r\ntitle: t\r\n---\r\n본문\r\n");
  assert.equal(post.title, "t");
  assert.match(post.html, /본문/);
});

test("로컬 이미지만 찾고 http·https·data 이미지는 제외", () => {
  const html = [
    '<img src="./a.png">',
    '<img alt="x" src="img/b.jpg">',
    '<img src="https://x.com/c.png">',
    '<img src="//cdn.x.com/d.png">',
    '<img src="data:image/png;base64,AAAA">',
    '<img src="./a.png">',
  ].join("");
  assert.deepEqual(findLocalImages(html), ["./a.png", "img/b.jpg"]);
});

test("로컬 이미지가 있으면 경고", () => {
  const post = parsePostText("---\ntitle: t\n---\n![x](./a.png)");
  assert.deepEqual(post.localImages, ["./a.png"]);
  assert.ok(post.warnings.some((w) => w.includes("로컬 이미지")));
});

test("같은 내용은 같은 해시, 다르면 다른 해시", () => {
  const a = parsePostText("# t\n\nx").sha256;
  assert.equal(a, parsePostText("# t\n\nx").sha256);
  assert.notEqual(a, parsePostText("# t\n\ny").sha256);
});

test("GFM 표와 코드블록이 HTML로 변환된다", () => {
  const post = parsePostText(
    "# t\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```",
  );
  assert.match(post.html, /<table>/);
  assert.match(post.html, /<pre><code class="language-js">/);
});

test("줄바꿈: 기본은 한 번 줄바꿈도 <br>, breaks: false 면 표준 마크다운", () => {
  const withBreaks = parsePostText("---\ntitle: t\n---\n첫 줄\n둘째 줄");
  assert.match(withBreaks.html, /첫 줄<br>\s*둘째 줄/);
  const standard = parsePostText("---\ntitle: t\nbreaks: false\n---\n첫 줄\n둘째 줄");
  assert.doesNotMatch(standard.html, /<br>/);
  assert.ok(!standard.warnings.some((w) => w.includes("breaks")));
});
