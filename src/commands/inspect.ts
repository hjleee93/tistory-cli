import type { Command } from "commander";
import { withSession } from "../auth/session.js";
import { resolveBlog } from "../core/config.js";
import { inspectDrafts, inspectEditor, inspectPost, inspectLogin, inspectPosts, inspectUpload } from "../diag/inspect.js";
import { isTistoryUrl } from "../ui/open.js";
import { teeToFile } from "../diag/diagnose.js";

export function registerInspectCommands(program: Command): void {
  program
    .command("inspect-editor")
    .description("[개발용] 에디터의 버튼·입력칸 구조를 출력합니다 (글은 저장하지 않음)")
    .option("-b, --blog <name>", "점검할 블로그 (기본: 설정값)")
    .option("--headed", "브라우저 창을 띄워서 실행")
    .option(
      "--publish-layer",
      "제목·본문을 임시로 채우고 '완료'를 눌러 발행 설정 창 구조도 확인 (발행은 안 함, 임시저장 글이 남을 수 있음)",
    )
    .action(
      async (opts: { blog?: string; headed?: boolean; publishLayer?: boolean }) => {
        const blog = await resolveBlog(opts.blog);
        const ok = await withSession({ headless: !opts.headed }, (ctx) =>
          inspectEditor(ctx, blog, { publishLayer: opts.publishLayer }),
        );
        if (!ok) process.exitCode = 2;
      },
    );

  program
    .command("inspect-posts")
    .description("[개발용] 글 관리(글 목록) 화면의 구조를 출력합니다 (삭제 안 함, 글 제목은 가림)")
    .option("-b, --blog <name>", "점검할 블로그 (기본: 설정값)")
    .option("--headed", "브라우저 창을 띄워서 실행")
    .option(
      "--probe-selection",
      "첫 글을 잠깐 선택해 나타나는 버튼(삭제 등)과 마우스를 올렸을 때의 요소도 확인 (선택은 바로 해제, 삭제는 안 함)",
    )
    .action(
      async (opts: { blog?: string; headed?: boolean; probeSelection?: boolean }) => {
        const blog = await resolveBlog(opts.blog);
        const ok = await withSession({ headless: !opts.headed }, (ctx) =>
          inspectPosts(ctx, blog, { probeSelection: opts.probeSelection }),
        );
        if (!ok) process.exitCode = 2;
      },
    );

  program
    .command("inspect-login")
    .description("[개발용] 로그아웃 상태의 로그인 화면 구조를 출력합니다 (아무것도 입력하지 않음)")
    .option("-o, --out <file>", "출력을 저장할 파일", "login-report.txt")
    .action(async (opts: { out: string }) => {
      await teeToFile(opts.out, () => inspectLogin());
    });

  program
    .command("inspect-upload <image>")
    .option("-o, --out <file>", "출력을 저장할 파일", "upload-report.txt")
    .description("[개발용] 이미지 한 장을 에디터에 올려 보고 편집기 안 변화를 출력합니다 (글은 저장 안 함)")
    .option("-b, --blog <name>", "블로그 (기본: 설정값)")
    .option("--headed", "브라우저 창을 띄워서 실행")
    .action(async (image: string, opts: { blog?: string; headed?: boolean; out: string }) => {
      const blog = await resolveBlog(opts.blog);
      const ok = await teeToFile(opts.out, () =>
        withSession({ headless: !opts.headed }, (ctx) => inspectUpload(ctx, blog, image)),
      );
      if (!ok) process.exitCode = 2;
    });

  program
    .command("inspect-post [url]")
    .description("[개발용] 글 한 개 페이지의 관리 메뉴(⋮) 구조를 출력합니다 (주소를 생략하면 가장 최근 글, 클릭 안 함)")
    .option("-b, --blog <name>", "블로그 (기본: 설정값)")
    .option("--headed", "브라우저 창을 띄워서 실행")
    .action(async (url: string | undefined, opts: { blog?: string; headed?: boolean }) => {
      const blog = await resolveBlog(opts.blog);
      if (url && !isTistoryUrl(url)) {
        console.error("tistory.com 의 https 주소만 점검할 수 있습니다.");
        process.exitCode = 1;
        return;
      }
      const ok = await withSession({ headless: !opts.headed }, (ctx) =>
        inspectPost(ctx, blog, url),
      );
      if (!ok) process.exitCode = 2;
    });

  program
    .command("inspect-drafts")
    .description("[개발용] 임시저장 목록 화면의 구조를 출력합니다 (저장·발행·삭제 안 함, 제목은 가림)")
    .option("-o, --out <file>", "출력을 저장할 파일", "drafts-report.txt")
    .option("-b, --blog <name>", "블로그 (기본: 설정값)")
    .option("--headed", "브라우저 창을 띄워서 실행")
    .option("--open", "첫 임시저장 글을 눌러 불러오는 동작도 확인 (불러오기만 하고 저장은 안 함)")
    .action(async (opts: { out: string; blog?: string; headed?: boolean; open?: boolean }) => {
      const blog = await resolveBlog(opts.blog);
      const ok = await teeToFile(opts.out, () =>
        withSession({ headless: !opts.headed }, (ctx) => inspectDrafts(ctx, blog, { open: opts.open })),
      );
      if (!ok) process.exitCode = 2;
    });
}
