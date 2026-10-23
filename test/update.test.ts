import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, updateCheckDisabled, updateNotice } from "../src/core/update.js";

test("버전 비교", () => {
  assert.equal(compareVersions("0.1.1", "0.1.0"), 1);
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), 0);
});

test("확인 건너뛰기: CI, 끄기 환경변수, 터미널 아님", () => {
  assert.equal(updateCheckDisabled({}, true), false);
  assert.equal(updateCheckDisabled({ CI: "true" }, true), true);
  assert.equal(updateCheckDisabled({ TISTORY_NO_UPDATE_CHECK: "1" }, true), true);
  assert.equal(updateCheckDisabled({}, false), true);
});

test("안내 문구에 세 설치 도구의 업데이트 명령이 있음", () => {
  const text = updateNotice("0.1.0", "0.2.0", "0.3.0");
  assert.match(text, /0\.1\.0 → 0\.2\.0/);
  assert.match(text, /npm update -g tistory-cli/);
  assert.match(text, /pnpm add -g tistory-cli@latest/);
  assert.match(text, /yarn global upgrade tistory-cli/);
});
