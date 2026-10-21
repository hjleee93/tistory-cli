import assert from "node:assert/strict";
import test from "node:test";
import { parseEnv } from "../src/core/credentials.js";

test(".env 파싱: 주석·따옴표·export·빈 줄·값 안의 =", () => {
  const env = parseEnv(`# 주석\n\nTISTORY_ID="me@example.com"\nexport TISTORY_PASSWORD='p@ss=word #1'\nBAD LINE\nEMPTY=\n`);
  assert.equal(env.TISTORY_ID, "me@example.com");
  assert.equal(env.TISTORY_PASSWORD, "p@ss=word #1");
  assert.equal(env.EMPTY, "");
  assert.equal(env["BAD LINE"], undefined);
});
