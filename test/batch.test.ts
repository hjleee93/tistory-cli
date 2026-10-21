import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expandInputs } from "../src/actions/batch.js";

test("폴더는 바로 아래 .md만 이름순으로, 숨김·다른 확장자·하위 폴더는 제외, 중복 제거", async () => {
  const dir = await mkdtemp(join(tmpdir(), "batch-"));
  await writeFile(join(dir, "b.md"), "# b");
  await writeFile(join(dir, "a.md"), "# a");
  await writeFile(join(dir, ".hidden.md"), "# h");
  await writeFile(join(dir, "note.txt"), "x");
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "sub", "c.md"), "# c");
  const files = await expandInputs([dir, join(dir, "a.md")]);
  assert.deepEqual(files, [join(dir, "a.md"), join(dir, "b.md")]);
});

test("없는 경로는 오류", async () => {
  await assert.rejects(() => expandInputs(["/no/such/path"]), /찾을 수 없습니다/);
});
