import type { Command } from "commander";
import { withSession } from "../auth/session.js";
import { resolveBlog } from "../core/config.js";
import { addEntry } from "../core/history.js";
import { askYesNo, openInBrowser } from "../ui/open.js";
import { askChoice } from "../ui/prompt.js";
import { PublishError } from "../actions/publisher.js";
import { listDrafts, publishDraft, type DraftEntry } from "../actions/drafts.js";

const log = (message: string): void => console.log(`  · ${message}`);

export function registerDraftsCommands(program: Command): void {
  program
    .command("drafts")
    .description("티스토리에 저장된 임시저장 글 목록을 보여 줍니다 (읽기 전용)")
    .option("-b, --blog <name>", "블로그 (기본: 설정값)")
    .option("--headed", "브라우저 창을 띄워서 실행")
    .action(async (opts: { blog?: string; headed?: boolean }) => {
      const blog = await resolveBlog(opts.blog);
      try {
        const entries = await withSession({ headless: !opts.headed }, (ctx) => listDrafts(ctx, blog, log));
        if (entries.length === 0) {
          console.log("임시저장된 글이 없습니다.");
          return;
        }
        console.log(`\n임시저장 ${entries.length}개`);
        entries.forEach((e, i) => console.log(`  ${i + 1}. ${e.title}  (${e.savedAt})`));
      } catch (error) {
        if (error instanceof PublishError) {
          console.error(`\n${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });

  program
    .command("publish-draft [keyword]")
    .description("티스토리에 이미 임시저장된 글을 골라 발행합니다 (keyword로 제목을 좁힐 수 있음)")
    .option("--private", "비공개로 발행 (기본: 공개)")
    .option("-y, --yes", "발행 전 확인 질문을 건너뜀")
    .option("--open", "발행 후 묻지 않고 브라우저로 열기")
    .option("--no-open", "발행 후 확인 질문을 하지 않음")
    .option("--headed", "브라우저 창을 띄워서 실행")
    .option("-b, --blog <name>", "블로그 (기본: 설정값)")
    .action(
      async (
        keyword: string | undefined,
        opts: { private?: boolean; yes?: boolean; open?: boolean; headed?: boolean; blog?: string },
      ) => {
        const blog = await resolveBlog(opts.blog);
        const visibility = opts.private ? "private" : "public";
        if (!opts.yes && !process.stdin.isTTY) {
          console.error("터미널이 아니라서 발행 여부를 물을 수 없습니다. 확인했다면 --yes를 붙이세요.");
          process.exitCode = 1;
          return;
        }

        const choose = async (entries: DraftEntry[]): Promise<number | undefined> => {
          const matches = entries
            .map((entry, index) => ({ entry, index }))
            .filter(({ entry }) => !keyword || entry.title.includes(keyword));
          if (matches.length === 0) {
            console.error(`제목에 "${keyword}"이(가) 들어간 임시저장 글이 없습니다.`);
            return undefined;
          }
          if (matches.length === 1) return matches[0]!.index;
          if (!process.stdin.isTTY) {
            console.error("임시저장 글이 여러 개입니다. 제목 일부(keyword)로 하나만 남도록 좁혀 주세요.");
            return undefined;
          }
          const picked = await askChoice(
            "발행할 임시저장 글을 선택하세요:",
            matches.map(({ entry }) => `${entry.title}  (${entry.savedAt})`),
            "취소",
          );
          return picked === undefined ? undefined : matches[picked]?.index;
        };

        try {
          const outcome = await withSession({ headless: !opts.headed }, (ctx) =>
            publishDraft(ctx, blog, log, {
              visibility,
              choose,
              confirm: opts.yes
                ? undefined
                : (title) =>
                    askYesNo(
                      `${blog}.tistory.com 에 "${title}" 글을 ${visibility === "public" ? "공개" : "비공개"}로 발행할까요?`,
                    ),
            }),
          );
          if (outcome.kind === "none") {
            console.log("임시저장된 글이 없습니다.");
            return;
          }
          if (outcome.kind === "cancelled") {
            console.log("발행하지 않았습니다.");
            return;
          }
          await addEntry({
            sha256: `draft:${outcome.result.id}`,
            blog,
            mode: "published",
            title: outcome.title,
            at: new Date().toISOString(),
          });
          console.log(`\n발행했습니다 (글 번호 ${outcome.result.id}, 글 관리 목록에서 확인됨).`);
          console.log(`주소: ${outcome.result.url}`);
          const shouldOpen = opts.open ?? (await askYesNo("\n해당 글을 확인하시겠습니까?"));
          if (shouldOpen) {
            const opened = await openInBrowser(outcome.result.url);
            console.log(
              opened
                ? `브라우저로 열었습니다: ${outcome.result.url}`
                : `브라우저를 열지 못했습니다. 직접 여세요: ${outcome.result.url}`,
            );
          }
        } catch (error) {
          if (error instanceof PublishError) {
            console.error(`\n발행하지 못했습니다: ${error.message}`);
            if (error.diagnosticsDir) console.error(`진단 파일: ${error.diagnosticsDir}`);
            process.exitCode = 1;
            return;
          }
          throw error;
        }
      },
    );
}
