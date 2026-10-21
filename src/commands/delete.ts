import type { Command } from "commander";
import { withSession } from "../auth/session.js";
import { resolveBlog } from "../core/config.js";
import { PublishError } from "../actions/publisher.js";
import { fetchPostRows } from "../blog/posts.js";
import { deletePost, findPostPage } from "../actions/deleter.js";
import { askChoice, askLine } from "../ui/prompt.js";

export function registerDeleteCommand(program: Command): void {
  program
    .command("delete [id]")
    .description("글을 삭제합니다 (글 번호는 `posts` 로 확인, 생략하면 목록에서 고름). 삭제 전에 글 제목을 직접 입력해야 합니다")
    .option("-b, --blog <name>", "블로그 (기본: 설정값)")
    .option("--headed", "브라우저 창을 띄워서 실행")
    .action(async (idArg: string | undefined, opts: { blog?: string; headed?: boolean }) => {
      if (!process.stdin.isTTY) {
        console.error("삭제는 안전을 위해 터미널에서 직접 확인해야 합니다. (파이프·자동 실행 불가)");
        process.exitCode = 1;
        return;
      }
      if (idArg !== undefined && !/^\d+$/.test(idArg)) {
        console.error("글 번호는 숫자여야 합니다. `tistory posts` 로 확인하세요.");
        process.exitCode = 1;
        return;
      }
      const blog = await resolveBlog(opts.blog);
      try {
        await withSession({ headless: !opts.headed }, async (ctx) => {
          let id = idArg === undefined ? undefined : Number(idArg);
          if (id === undefined) {
            const rows = await fetchPostRows(ctx, blog);
            if (rows.length === 0) {
              console.log("글을 찾지 못했습니다.");
              return;
            }
            const pick = await askChoice("삭제할 글을 고르세요.", rows.map((r) => `[${r.id}] ${r.title}`), "취소");
            if (pick === undefined) {
              console.log("취소했습니다.");
              return;
            }
            id = rows[pick]?.id;
          }
          if (id === undefined) return;

          const lookup = await ctx.newPage();
          const found = await findPostPage(lookup, blog, id).finally(() => lookup.close().catch(() => undefined));
          if (!found) {
            console.error(`글 번호 ${id} 을(를) 찾지 못했습니다. 이미 삭제됐거나 번호가 틀렸을 수 있습니다.`);
            process.exitCode = 1;
            return;
          }
          console.log(`\n삭제할 글: [${id}] ${found.row.title}`);
          console.log("※ 삭제한 글은 되돌리기 어려울 수 있습니다.");
          const typed = await askLine("삭제하려면 위 글 제목을 그대로 입력하세요 (Enter = 취소)\n> ");
          if (typed !== found.row.title.trim()) {
            console.log(typed ? "제목이 일치하지 않아 취소했습니다." : "취소했습니다.");
            return;
          }
          await deletePost(ctx, blog, id, found.row.title);
          console.log("삭제했습니다. 글 목록에서 사라진 것을 확인했습니다.");
        });
      } catch (error) {
        if (!(error instanceof PublishError)) throw error;
        console.error(`\n삭제하지 못했습니다: ${error.message}`);
        if (error.diagnosticsDir) console.error(`진단 파일: ${error.diagnosticsDir}`);
        process.exitCode = 1;
      }
    });
}
