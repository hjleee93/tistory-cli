import assert from "node:assert/strict";
import test from "node:test";
import { AiError, extractText, parseProvider, resolveAi } from "../src/ai/providers.js";
import { buildPrompts, cleanDraft, slugify } from "../src/ai/draft.js";

test("공급자 이름: gemini/google 만 인식", () => {
  assert.equal(parseProvider("Gemini"), "gemini");
  assert.equal(parseProvider("google"), "gemini");
  assert.equal(parseProvider("chatgpt"), undefined);
});

test("키가 있으면 gemini 선택, 없으면 오류, 모르는 공급자는 오류", () => {
  assert.equal(resolveAi({ GEMINI_API_KEY: "k" }).provider, "gemini");
  assert.throws(() => resolveAi({}), /GEMINI_API_KEY/);
  assert.throws(() => resolveAi({ GEMINI_API_KEY: "k" }, { provider: "claude" }), /gemini만/);
});

test("모델: 옵션 > AI_MODEL > 기본값", () => {
  assert.equal(resolveAi({ GEMINI_API_KEY: "k" }).model, "gemini-3.5-flash-lite");
  assert.equal(resolveAi({ GEMINI_API_KEY: "k", AI_MODEL: "m1" }).model, "m1");
  assert.equal(resolveAi({ GEMINI_API_KEY: "k", AI_MODEL: "m1" }, { model: "m2" }).model, "m2");
});

test("응답에서 글자 꺼내기, 빈 응답은 오류", () => {
  assert.equal(extractText("gemini", { candidates: [{ content: { parts: [{ text: "라" }, { text: "마" }] } }] }), "라마");
  assert.throws(() => extractText("gemini", { candidates: [] }), AiError);
});

test("프롬프트에 주제·분량·추가 요청이 들어간다", () => {
  const { user } = buildPrompts("Playwright 입문", { length: "short", notes: "반말로" });
  assert.match(user, /Playwright 입문/);
  assert.match(user, /800자/);
  assert.match(user, /반말로/);
});

test("코드 펜스로 감싼 초안과 앞말을 정리한다", () => {
  assert.equal(cleanDraft("```markdown\n---\ntitle: A\n---\n본문\n```"), "---\ntitle: A\n---\n본문\n");
  assert.equal(cleanDraft("여기 있습니다.\n---\ntitle: A\n---\n본문"), "---\ntitle: A\n---\n본문\n");
  assert.equal(cleanDraft("---\ntitle: A\n---\n본문"), "---\ntitle: A\n---\n본문\n");
});

test("파일 이름: 한글 유지, 특수문자는 -, 비면 draft", () => {
  assert.equal(slugify("Playwright로 만든 CLI!"), "Playwright로-만든-CLI");
  assert.equal(slugify("???"), "draft");
  assert.ok(slugify("가".repeat(100)).length <= 30);
});
