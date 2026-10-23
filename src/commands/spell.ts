import { readFile, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { AiError, generate, loadAiEnv, resolveAi } from "../ai/providers.js";
import { applyFixes, buildSpellPrompts, parseFixes, proseForCheck } from "../ai/spell.js";
import { askChoice } from "../ui/prompt.js";

export function registerSpellCommand(program: Command): void {
  program
    .command("check <file>")
    .alias("spellcheck")
    .description("원고의 맞춤법·띄어쓰기·오탈자를 AI(Gemini)로 점검합니다 (코드·frontmatter는 건드리지 않음)")
    .option("--apply", "묻지 않고 모두 적용해 파일에 저장")
    .option("-m, --model <name>", "모델 이름")
    .action(async (file: string, opts: { apply?: boolean; model?: string }) => {
      let original: string;
      try {
        original = await readFile(file, "utf8");
      } catch {
        console.error(`파일을 읽을 수 없습니다: ${file}`);
        process.exitCode = 1;
        return;
      }
      const prose = proseForCheck(original);
      if (prose === "") {
        console.error("점검할 본문이 없습니다.");
        process.exitCode = 1;
        return;
      }

      let fixes;
      try {
        const ai = resolveAi(await loadAiEnv(), { model: opts.model });
        console.log(`Gemini (${ai.model}) 로 점검합니다…`);
        console.log("  · 본문 글이 구글로 전송됩니다. (코드 블록과 frontmatter 는 보내지 않음) 비공개 내용이면 중단하세요.");
        const { system, user } = buildSpellPrompts(prose);
        fixes = parseFixes(await generate(ai, system, user));
      } catch (error) {
        if (error instanceof AiError) {
          console.error(`\n${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }

      const result = applyFixes(original, fixes);
      if (result.applied.length === 0) {
        console.log("\n고칠 곳을 찾지 못했습니다.");
        return;
      }
      console.log(`\n수정 제안 ${result.applied.length}곳:`);
      result.applied.forEach((fix, i) => {
        const times = fix.count > 1 ? ` (${fix.count}곳)` : "";
        console.log(`  ${i + 1}. ${fix.from} → ${fix.to}${times}${fix.reason ? `  — ${fix.reason}` : ""}`);
      });
      if (result.skipped.length > 0) {
        console.log(`\n원문에서 찾지 못해 건너뜀 ${result.skipped.length}건 (AI가 구절을 잘못 옮겼거나 코드 안에 있음)`);
      }
      console.log("\n※ AI 제안입니다. 의미가 바뀌지 않는지 확인하세요.");

      let apply = opts.apply === true;
      if (!apply) {
        if (!process.stdin.isTTY) {
          console.log("적용하려면 --apply 를 붙이세요.");
          return;
        }
        apply = (await askChoice("제안을 적용할까요?", ["모두 적용해 파일에 저장"], "적용 안 함")) === 0;
      }
      if (!apply) {
        console.log("파일은 바꾸지 않았습니다.");
        return;
      }
      await writeFile(file, result.text);
      console.log(`적용해 저장했습니다: ${file}  (git 등으로 변경분을 확인하세요)`);
    });
}
