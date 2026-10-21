import assert from "node:assert/strict";
import test from "node:test";
import { extractImageTokens, replaceImageTags, resolveImagePath, uniqueUploadNames } from "../src/post/images.js";

test("이미지 경로: 상대/절대/인코딩/쿼리", () => {
  assert.equal(resolveImagePath("/a/b", "img/x.png"), "/a/b/img/x.png");
  assert.equal(resolveImagePath("/a/b", "/z/x.png"), "/z/x.png");
  assert.equal(resolveImagePath("/a/b", "my%20pic.png?raw=1"), "/a/b/my pic.png");
});

test("한글 등 특수문자 이름은 image-번호.확장자 로 바꿈", () => {
  assert.deepEqual(uniqueUploadNames(["/a/한글 사진.PNG", "/a/ok.png"]), ["image-1.png", "ok.png"]);
});

test("파일 이름이 겹칠 때만 번호를 붙임", () => {
  assert.deepEqual(uniqueUploadNames(["/a/x.png", "/b/y.png"]), ["x.png", "y.png"]);
  assert.deepEqual(uniqueUploadNames(["/a/x.png", "/b/x.png", "/c/z.png"]), ["1-x.png", "2-x.png", "z.png"]);
});

test("표기에서 filename(한글 포함)을 읽음", () => {
  const code = `<p>[##_Image|kage@a/b/img.png?credential=1&amp;sig=%3D|CDM|1.3|{"originWidth":64,"filename":"사진 1.png"}_##]</p>\n<p>text</p><p>[##_Image|kage@c|CDM|1.3|{"filename":"b.png"}_##]</p>`;
  const tokens = extractImageTokens(code);
  assert.deepEqual(tokens.map((t) => t.filename), ["사진 1.png", "b.png"]);
  assert.ok(tokens[0]?.token.startsWith("[##_Image|kage@a/b/img.png"));
});

test("img 태그 치환: 매핑된 것만, $ 가 있어도 그대로", () => {
  const map = new Map([["a.png", "[##_Image|k$&x|CDM|1.3|{}_##]"]]);
  const out = replaceImageTags('<p><img src="a.png" alt="가"></p><p><img src="https://e.com/r.png"></p>', map);
  assert.equal(out, '<p>[##_Image|k$&x|CDM|1.3|{}_##]</p><p><img src="https://e.com/r.png"></p>');
});
