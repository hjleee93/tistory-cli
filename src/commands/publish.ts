import type { Command } from "commander";
import { withSession } from "../auth/session.js";
import { loadConfig, normalizeBlogName, resolveBlog } from "../core/config.js";
import { addEntry, findEntry } from "../core/history.js";
import { askYesNo, openInBrowser, pickDraftTarget } from "../ui/open.js";
import { PostError, loadPost } from "../post/post.js";
import { PublishError, publishPost, saveDraft } from "../actions/publisher.js";
import { askChoice } from "../ui/prompt.js";
import { viewDrafts } from "../actions/viewer.js";

export function registerPublishCommand(program: Command): void {
  program
    .command("publish <file>")
    .description("Markdown 원고를 티스토리에 올립니다 (기본: 임시저장)")
    .option("--dry-run", "업로드하지 않고 변환 결과만 확인")
    .option("--show-html", "변환된 HTML 전체를 출력 (--dry-run과 함께)")
    .option("--publish", "임시저장 대신 발행 (공개 범위는 원고의 visibility, 기본 public)")
    .option("-y, --yes", "발행 전 확인 질문을 건너뜀 (--publish와 함께)")
    .option("--force", "이미 올린 원고도 다시 올림")
    .option("-c, --category <name>", "카테고리 (원고의 category보다 우선)")
    .option("--open", "저장 후 묻지 않고 브라우저로 열기")
    .option("--no-open", "저장 후 확인 질문을 하지 않음")
    .option("--headed", "브라우저 창을 띄워서 실행")
    .option("-b, --blog <name>", "올릴 블로그 (기본: 설정값)")
    .action(
      async (
        file: string,
        opts: {
          dryRun?: boolean;
          showHtml?: boolean;
          publish?: boolean;
          yes?: boolean;
          force?: boolean;
          category?: string;
          open?: boolean;
          headed?: boolean;
          blog?: string;
        },
      ) => {
        let post;
        try {
          post = await loadPost(file);
        } catch (error) {
          if (error instanceof PostError) {
            console.error("원고를 읽을 수 없습니다:");
            for (const problem of error.problems) console.error(`  - ${problem}`);
            process.exitCode = 1;
            return;
          }
          throw error;
        }

        if (opts.category) post.category = opts.category;

        if (opts.publish && post.visibility === "protected") {
          console.error(
            "보호(비밀번호) 글은 아직 지원하지 않습니다. visibility를 public 또는 private으로 바꿔 주세요.",
          );
          process.exitCode = 1;
          return;
        }

        const configured = opts.blog ?? (await loadConfig()).blog;
        const blog = configured ? `${normalizeBlogName(configured)}.tistory.com` : "(미설정)";

        console.log("[dry-run] 업로드하지 않고 변환 결과만 확인합니다.\n");
        console.log(`파일     : ${file}`);
        console.log(`블로그   : ${blog}`);
        console.log(`제목     : ${post.title}`);
        console.log(`태그     : ${post.tags.length ? post.tags.join(", ") : "(없음)"}`);
        console.log(
          `카테고리 : ${post.category ?? "(지정 안 함 → 업로드할 때 내 카테고리 목록에서 고릅니다)"}`,
        );
        console.log(`공개 범위: ${post.visibility} (발행할 때 적용)`);
        console.log(`본문     : HTML ${post.html.length.toLocaleString()}자`);
        console.log(`해시     : ${post.sha256.slice(0, 12)}…`);

        if (post.warnings.length > 0) {
          console.log("\n경고:");
          for (const warning of post.warnings) console.log(`  - ${warning}`);
        }

        if (opts.showHtml) {
          console.log("\n--- HTML ---");
          console.log(post.html);
        }
        if (opts.dryRun) return;

        // ---- 실제 발행 ----
        if (opts.publish) {
          const blogName = await resolveBlog(opts.blog);
          const previous = await findEntry(post.sha256, blogName);
          if (previous?.mode === "published" && !opts.force) {
            console.error(`\n이미 발행한 원고입니다 (${previous.at}).`);
            console.error("같은 글을 다시 발행하려면 --force를 붙이세요.");
            process.exitCode = 1;
            return;
          }

          const visibility = post.visibility === "private" ? "private" : "public";
          console.log(
            `\n${blogName}.tistory.com 에 ${visibility === "public" ? "공개" : "비공개"}로 발행합니다.`,
          );
          if (!opts.yes) {
            if (!process.stdin.isTTY) {
              console.error("터미널이 아니라서 발행 여부를 물을 수 없습니다. 확인했다면 --yes를 붙이세요.");
              process.exitCode = 1;
              return;
            }
            const ok = await askYesNo(`"${post.title}" 글을 지금 발행할까요?`);
            if (!ok) {
              console.log("발행하지 않았습니다.");
              return;
            }
          }

          try {
            const result = await withSession({ headless: !opts.headed }, (ctx) =>
              publishPost(ctx, blogName, post, (message) => console.log(`  · ${message}`), {
                visibility,
                askCategory: process.stdin.isTTY
                  ? (labels) => askChoice("카테고리를 선택하세요:", labels, "지정 안 함")
                  : undefined,
              }),
            );
            await addEntry({
              sha256: post.sha256,
              blog: blogName,
              mode: "published",
              title: post.title,
              at: new Date().toISOString(),
            });
            console.log(`\n발행했습니다 (글 번호 ${result.id}, 글 관리 목록에서 확인됨).`);
            console.log(`주소: ${result.url}`);
            for (const warning of result.warnings) console.log(`주의: ${warning}`);

            const shouldOpen =
              opts.open ?? (await askYesNo("\n해당 글을 확인하시겠습니까?"));
            if (shouldOpen) {
              const opened = await openInBrowser(result.url);
              console.log(
                opened
                  ? `브라우저로 열었습니다: ${result.url}`
                  : `브라우저를 열지 못했습니다. 직접 여세요: ${result.url}`,
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
          return;
        }

        // ---- 실제 임시저장 ----
        const blogName = await resolveBlog(opts.blog);
        const previous = await findEntry(post.sha256, blogName);
        if (previous && !opts.force) {
          console.error(
            `\n이미 ${previous.mode === "draft" ? "임시저장" : "발행"}한 원고입니다 (${previous.at}).`,
          );
          console.error("같은 글을 다시 올리려면 --force를 붙이세요.");
          process.exitCode = 1;
          return;
        }

        console.log(`\n${blogName}.tistory.com 에 임시저장합니다. (공개되지 않습니다)\n`);
        try {
          const result = await withSession({ headless: !opts.headed }, (ctx) =>
            saveDraft(
              ctx,
              blogName,
              post,
              (message) => console.log(`  · ${message}`),
              {
                // 터미널에서 실행할 때만, 카테고리가 없거나 틀리면 목록에서 고르게 한다.
                askCategory: process.stdin.isTTY
                  ? (labels) =>
                      askChoice("카테고리를 선택하세요:", labels, "지정 안 함")
                  : undefined,
              },
            ),
          );
          await addEntry({
            sha256: post.sha256,
            blog: blogName,
            mode: "draft",
            title: post.title,
            at: new Date().toISOString(),
          });
          console.log(
            `\n임시저장했습니다 (확인 근거: ${result.confirmedBy === "count" ? "임시저장 개수 증가" : "저장 완료 안내"}).`,
          );
          console.log("티스토리 글쓰기 화면의 '임시저장' 목록에서 확인하세요.");
          for (const warning of result.warnings) console.log(`주의: ${warning}`);

          // 저장한 글을 실제 브라우저(평소 쓰는 브라우저)에서 확인
          const shouldOpen =
            opts.open ?? (await askYesNo("\n해당 글을 확인하시겠습니까?"));
          if (shouldOpen) {
            const target = pickDraftTarget(blogName, result.url);
            if (target.exact) {
              const opened = await openInBrowser(target.url);
              console.log(
                opened
                  ? `브라우저로 열었습니다: ${target.url}`
                  : `브라우저를 열지 못했습니다. 직접 여세요: ${target.url}`,
              );
            } else {
              // 임시저장은 공개 주소가 없으므로 '임시저장' 목록을 열어 보여 준다.
              console.log("\n임시저장 글은 주소가 없어, 글쓰기 화면의 임시저장 목록을 엽니다.");
              await viewDrafts(blogName);
            }
          }
        } catch (error) {
          if (error instanceof PublishError) {
            console.error(`\n임시저장하지 못했습니다: ${error.message}`);
            if (error.diagnosticsDir) {
              console.error(`진단 파일: ${error.diagnosticsDir}`);
            }
            process.exitCode = 1;
            return;
          }
          throw error;
        }
      },
    );
}
