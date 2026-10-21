import type { Command } from "commander";
import { chooseBlog, listBlogs } from "../blog/blogs.js";
import { withSession } from "../auth/session.js";
import { CONFIG_FILE, STATE_FILE, loadConfig, normalizeBlogName, resolveBlog, saveConfig } from "../core/config.js";
import { PublishError, listCategories } from "../actions/publisher.js";
import { fetchPostRows } from "../blog/posts.js";

export function registerBlogCommands(program: Command): void {
  program
    .command("blogs")
    .description("내 블로그 목록을 조회만 합니다 (선택·저장 없음)")
    .option("--json", "JSON으로 출력 (스크립트용)")
    .option("--headed", "브라우저 창을 띄워서 조회")
    .option("--debug", "화면 스크린샷·HTML을 진단 폴더에 저장하고 요약 출력")
    .action(
      async (opts: { json?: boolean; headed?: boolean; debug?: boolean }) => {
        const result = await withSession({ headless: !opts.headed }, (ctx) =>
          listBlogs(ctx, { debug: opts.debug }),
        );
        const { blogs } = result;
        const current = (await loadConfig()).blog;

        if (opts.json) {
          console.log(
            JSON.stringify(
              blogs.map((b) => ({ ...b, selected: b.name === current })),
              null,
              2,
            ),
          );
        } else if (blogs.length === 0) {
          console.log("블로그 목록을 찾지 못했습니다.");
          console.log("`tistory config set-blog <이름>`으로 직접 지정할 수 있습니다.");
        } else {
          blogs.forEach((b, i) => {
            const title = b.title ? `  (${b.title})` : "";
            const mark = b.name === current ? "  ← 현재 설정" : "";
            console.log(`${i + 1}. ${b.name}.tistory.com${title}${mark}`);
          });
        }

        if (blogs.length === 0 || opts.debug) {
          console.error("\n[진단 요약] (계정 정보 없음, 호스트·경로만)");
          console.error(`  도착 위치     : ${result.location}`);
          console.error(`  내 블로그 카드: ${result.panelFound ? "찾음" : "못 찾음 (비로그인이거나 화면 구조가 다름)"}`);
          console.error(`  카드 안 링크  : ${result.anchorCount}개`);
          console.error(`  링크 호스트   : ${JSON.stringify(result.hosts)}`);
          if (result.diagnosticsDir) {
            console.error(`  진단 파일 : ${result.diagnosticsDir}`);
          }
        }
        if (blogs.length === 0) process.exitCode = 1;
      },
    );

  const config = program.command("config").description("설정");

  config
    .command("set-blog <name>")
    .description("작업할 블로그 지정 (예: myblog 또는 myblog.tistory.com)")
    .action(async (name: string) => {
      const blog = normalizeBlogName(name);
      await saveConfig({ ...(await loadConfig()), blog });
      console.log(`블로그를 ${blog}.tistory.com 으로 설정했습니다.`);
    });

  config
    .command("select-blog")
    .description("내 블로그 목록에서 번호로 선택합니다")
    .option("--headed", "브라우저 창을 띄워서 목록 조회")
    .action(async (opts: { headed?: boolean }) => {
      await withSession({ headless: !opts.headed }, (ctx) => chooseBlog(ctx));
    });

  config
    .command("show")
    .description("현재 설정과 파일 위치를 출력합니다")
    .action(async () => {
      const cfg = await loadConfig();
      console.log(`blog   : ${cfg.blog ?? "(미설정)"}`);
      console.log(`config : ${CONFIG_FILE}`);
      console.log(`session: ${STATE_FILE}`);
    });

  program
    .command("categories")
    .description("내 블로그의 카테고리 목록을 조회합니다 (읽기 전용)")
    .option("-b, --blog <name>", "조회할 블로그 (기본: 설정값)")
    .option("--headed", "브라우저 창을 띄워서 실행")
    .action(async (opts: { blog?: string; headed?: boolean }) => {
      const blog = await resolveBlog(opts.blog);
      try {
        const labels = await withSession({ headless: !opts.headed }, (ctx) =>
          listCategories(ctx, blog),
        );
        if (labels.length === 0) {
          console.log("카테고리 목록을 읽지 못했습니다.");
          console.log("`tistory inspect-editor --headed`로 화면 구조를 확인해 보세요.");
          process.exitCode = 1;
          return;
        }
        labels.forEach((label, index) => console.log(`${index + 1}. ${label}`));
      } catch (error) {
        if (!(error instanceof PublishError)) throw error;
        console.error(error.message);
        process.exitCode = 1;
      }
    });

  program
    .command("posts")
    .description("내 블로그의 최근 글 목록(글 번호·제목)을 조회합니다 (읽기 전용, 최대 15개)")
    .option("-b, --blog <name>", "조회할 블로그 (기본: 설정값)")
    .option("--json", "JSON으로 출력")
    .option("--headed", "브라우저 창을 띄워서 실행")
    .action(async (opts: { blog?: string; json?: boolean; headed?: boolean }) => {
      const blog = await resolveBlog(opts.blog);
      const rows = await withSession({ headless: !opts.headed }, (ctx) =>
        fetchPostRows(ctx, blog),
      );
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else if (rows.length === 0) {
        console.log("글을 찾지 못했습니다.");
        process.exitCode = 1;
      } else {
        for (const row of rows) console.log(`${String(row.id).padStart(5)}  ${row.title}`);
      }
    });
}
