import type { Command } from "commander";
import { chooseBlog } from "../blog/blogs.js";
import { withSession } from "../auth/session.js";
import { loadConfig, resolveBlog } from "../core/config.js";
import { diagnose } from "../diag/diagnose.js";
import { formatReport, formatShareableSummary, runDoctor } from "../diag/doctor.js";

export function registerDoctorCommands(program: Command): void {
  program
    .command("diagnose")
    .description("화면 구조 점검(doctor·에디터·글 목록·최근 글)을 한 번에 실행해 보고서 파일로 저장합니다 (읽기 전용)")
    .option("-b, --blog <name>", "점검할 블로그 (기본: 설정값)")
    .option("-o, --out <file>", "보고서 파일 경로", "diagnose-report.txt")
    .option("--headed", "브라우저 창을 띄워서 실행")
    .action(async (opts: { blog?: string; out: string; headed?: boolean }) => {
      const blog = await resolveBlog(opts.blog);
      const ok = await withSession({ headless: !opts.headed }, (ctx) =>
        diagnose(ctx, blog, opts.out),
      );
      if (!ok) process.exitCode = 2;
    });

  program
    .command("doctor")
    .description("글을 올리지 않고 세션과 에디터 화면을 읽기 전용으로 점검합니다")
    .option("-b, --blog <name>", "점검할 블로그 (기본: 설정값)")
    .option("--headed", "브라우저 창을 띄워서 점검")
    .option("--share", "이슈에 붙일 수 있는 요약(개인정보 제외)을 함께 출력")
    .action(
      async (opts: { blog?: string; headed?: boolean; share?: boolean }) => {
        const headless = !opts.headed;
        const configured = opts.blog ?? (await loadConfig()).blog;
        let blog: string | undefined;
        if (configured) {
          blog = await resolveBlog(opts.blog);
        } else if (process.stdin.isTTY) {
          blog = await withSession({ headless }, (ctx) => chooseBlog(ctx));
        } else {
          blog = await resolveBlog(); // 설정이 없으면 안내 메시지와 함께 실패
        }
        if (!blog) return;

        const target = blog;
        const report = await withSession({ headless }, (ctx) =>
          runDoctor(ctx, target),
        );

        if (report.results.length > 0) console.log(formatReport(report));

        switch (report.outcome) {
          case "healthy":
            console.log("\n모든 점검을 통과했습니다.");
            break;
          case "session_invalid":
            console.log(`\n[세션 문제] ${report.message}`);
            console.log("에디터 변경이 아니라 로그인 문제입니다. `tistory login`을 다시 실행하세요.");
            process.exitCode = 2;
            break;
          case "editor_changed":
            console.log(`\n[에디터 변경 의심] ${report.message}`);
            console.log(`진단 파일: ${report.diagnosticsDir}`);
            process.exitCode = 3;
            break;
        }

        if (opts.share) {
          console.log("\n--- 이슈용 요약 (개인정보 제외) ---");
          console.log(formatShareableSummary(report));
        }
      },
    );
}
