import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { AiError, generate, loadAiEnv, resolveAi } from "../ai/providers.js";
import {
  buildImprovePrompts,
  cleanBody,
  countChanges,
  diffUnits,
  integrityWarnings,
  renderDiff,
  splitFrontmatter,
  toUnits,
} from "../ai/improve.js";
import { askChoice } from "../ui/prompt.js";

function siblingPath(file: string): string {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  let candidate = `${base}.improved${ext}`;
  for (let n = 2; existsSync(candidate); n += 1) candidate = `${base}.improved-${n}${ext}`;
  return candidate;
}

export function registerImproveCommand(program: Command): void {
  program
    .command("improve <file>")
    .alias("develop")
    .description("AI(Gemini)가 글을 다듬어 고친 결과를 diff로 보여 주고, 적용 여부를 고릅니다")
    .option("-n, --notes <text>", "수정 방향 (예: 더 간결하게, 초보자 대상으로, 결론을 강조)")
    .option("--apply", "묻지 않고 원본 파일에 덮어써 저장")
    .option("-o, --out <file>", "묻지 않고 이 파일로 저장 (원본은 그대로)")
    .option("-m, --model <name>", "모델 이름")
    .action(async (file: string, opts: { notes?: string; apply?: boolean; out?: string; model?: string }) => {
      let original: string;
      try {
        original = await readFile(file, "utf8");
      } catch {
        console.error(`파일을 읽을 수 없습니다: ${file}`);
        process.exitCode = 1;
        return;
      }
      const { front, body } = splitFrontmatter(original);
      if (body.trim() === "") {
        console.error("다듬을 본문이 없습니다.");
        process.exitCode = 1;
        return;
      }

      let improved: string;
      try {
        const ai = resolveAi(await loadAiEnv(), { model: opts.model });
        console.log(`Gemini (${ai.model}) 로 글을 다듬습니다…`);
        console.log("  · 본문 전체가 구글로 전송됩니다. (frontmatter 는 보내지 않음) 비공개 내용이면 중단하세요.");
        const { system, user } = buildImprovePrompts(body, opts.notes);
        improved = cleanBody(await generate(ai, system, user));
      } catch (error) {
        if (error instanceof AiError) {
          console.error(`\n${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }

      const ops = diffUnits(toUnits(body), toUnits(improved));
      const diff = renderDiff(ops, { color: Boolean(process.stdout.isTTY) });
      if (!diff) {
        console.log("\n바꿀 곳이 없다고 판단했습니다. (원문 그대로)");
        return;
      }
      const { added, removed } = countChanges(ops);
      console.log(`\n변경: 삭제 ${removed} · 추가 ${added} (문장 단위, 빨강 - 삭제 / 초록 + 추가)\n`);
      console.log(diff);
      const warnings = integrityWarnings(body, improved);
      for (const warning of warnings) console.log(`\n⚠ ${warning} 꼭 확인하세요.`);
      console.log("\n※ AI 제안입니다. 사실관계와 글쓴이의 말투가 유지됐는지 확인하세요.");

      const result = `${front}${improved}`;
      if (opts.out) {
        await writeFile(opts.out, result, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
          throw e.code === "EEXIST" ? new Error(`이미 있는 파일입니다: ${opts.out}`) : e;
        });
        console.log(`저장했습니다: ${opts.out}  (원본은 그대로)`);
        return;
      }
      if (opts.apply) {
        await writeFile(file, result);
        console.log(`원본에 적용해 저장했습니다: ${file}  (git 등으로 변경분을 확인하세요)`);
        return;
      }
      if (!process.stdin.isTTY) {
        console.log("저장하려면 --apply(원본 덮어쓰기) 또는 --out 파일 을 붙이세요.");
        return;
      }
      const choice = await askChoice("결과를 어떻게 할까요?", ["새 파일로 저장 (원본은 그대로)", "원본에 덮어쓰기"], "버리기");
      if (choice === 0) {
        const target = siblingPath(file);
        await writeFile(target, result, { flag: "wx" });
        console.log(`저장했습니다: ${target}`);
      } else if (choice === 1) {
        await writeFile(file, result);
        console.log(`원본에 적용해 저장했습니다: ${file}  (git 등으로 변경분을 확인하세요)`);
      } else {
        console.log("저장하지 않았습니다.");
      }
    });
}
