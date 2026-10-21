import type { Command } from "commander";
import { withSession } from "../auth/session.js";
import { resolveBlog } from "../core/config.js";
import { askYesNo } from "../ui/open.js";
import { expandInputs, planBatch, runBatch } from "../actions/batch.js";

export function registerBatchCommand(program: Command): void {
  program
    .command("batch <paths...>")
    .description("여러 원고(파일·폴더)를 한 번에 올립니다 (기본: 임시저장, --publish 로 발행)")
    .option("--publish", "임시저장 대신 발행")
    .option("-y, --yes", "시작 전 확인 질문을 건너뜀")
    .option("--force", "이미 올린 원고도 다시 올림")
    .option("--dry-run", "올리지 않고 계획만 출력")
    .option("--headed", "브라우저 창을 띄워서 실행")
    .option("-b, --blog <name>", "올릴 블로그 (기본: 설정값)")
    .action(
      async (
        paths: string[],
        opts: { publish?: boolean; yes?: boolean; force?: boolean; dryRun?: boolean; headed?: boolean; blog?: string },
      ) => {
        const blog = await resolveBlog(opts.blog);
        let files: string[];
        try {
          files = await expandInputs(paths);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
          return;
        }
        if (files.length === 0) {
          console.error("올릴 .md 원고를 찾지 못했습니다.");
          process.exitCode = 1;
          return;
        }
        const publish = Boolean(opts.publish);
        const items = await planBatch(files, blog, { publish, force: Boolean(opts.force) });
        const runnable = items.filter((i) => i.post && i.problems.length === 0 && !i.skipReason);

        console.log(`\n${blog}.tistory.com — ${publish ? "발행" : "임시저장"} 계획 (${items.length}개)`);
        for (const item of items) {
          const mark = item.problems.length ? "✖" : item.skipReason ? "–" : "✔";
          const note = item.problems.length ? item.problems.join("; ") : (item.skipReason ?? item.post?.title ?? "");
          console.log(`  ${mark} ${item.file}  ${note}`);
        }
        console.log(`\n실행 대상 ${runnable.length}개, 건너뜀/오류 ${items.length - runnable.length}개`);
        if (opts.dryRun) return;
        if (runnable.length === 0) {
          process.exitCode = 1;
          return;
        }
        if (!opts.yes) {
          if (!process.stdin.isTTY) {
            console.error("터미널이 아니라서 물을 수 없습니다. 확인했다면 --yes를 붙이세요.");
            process.exitCode = 1;
            return;
          }
          const ok = await askYesNo(`${runnable.length}개 글을 ${publish ? "발행" : "임시저장"}할까요?`);
          if (!ok) {
            console.log("취소했습니다.");
            return;
          }
        }
        const result = await withSession({ headless: !opts.headed }, (ctx) =>
          runBatch(ctx, blog, items, { publish }, (m) => console.log(m)),
        );
        console.log(`\n완료 ${result.done}개 · 실패 ${result.failed}개 · 건너뜀 ${result.skipped}개`);
        if (result.failed > 0) process.exitCode = 1;
      },
    );
}
