import type { Command } from "commander";
import { chooseBlog } from "../blog/blogs.js";
import { checkSession, deleteSession, describeFailure, hasSessionFile, interactiveLogin, withSession } from "../auth/session.js";
import { autoLogin } from "../auth/autologin.js";
import { loadCredentials, permissionWarning } from "../core/credentials.js";

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description("브라우저를 열어 직접 로그인하고 세션을 저장합니다 (--auto: .env 계정으로 창 없이)")
    .option("--auto", ".env(TISTORY_ID·TISTORY_PASSWORD)의 카카오계정으로 창 없이 로그인")
    .action(async (opts: { auto?: boolean }) => {
      if (opts.auto) {
        const credentials = await loadCredentials();
        if (!credentials) {
          console.error("TISTORY_ID / TISTORY_PASSWORD 를 찾지 못했습니다. .env.example 을 .env 로 복사해 채우세요.");
          process.exitCode = 1;
          return;
        }
        if (credentials.source) {
          const warning = await permissionWarning(credentials.source);
          if (warning) console.error(`주의: ${warning}`);
        }
        const result = await autoLogin(credentials);
        console.log(result.message);
        if (!result.ok) {
          process.exitCode = 1;
          return;
        }
        console.log("");
        await withSession({ headless: true }, (ctx) => chooseBlog(ctx));
        return;
      }
      const ok = await interactiveLogin();
      if (!ok) {
        console.error("\n로그인을 확인하지 못해 세션을 저장하지 않았습니다.");
        process.exitCode = 1;
        return;
      }
      // 로그인 직후 내 블로그 목록에서 바로 고르게 한다.
      console.log("");
      await withSession({ headless: true }, (ctx) => chooseBlog(ctx));
    });

  const auth = program.command("auth").description("인증 관리");

  auth
    .command("status")
    .description("저장된 세션으로 실제 로그인 상태를 확인합니다")
    .option("--headed", "브라우저 창을 띄워서 확인")
    .action(async (opts: { headed?: boolean }) => {
      if (!(await hasSessionFile())) {
        console.log("로그인 세션이 없습니다. `tistory login`을 실행하세요.");
        process.exitCode = 1;
        return;
      }
      const check = await withSession({ headless: !opts.headed }, (ctx) =>
        checkSession(ctx),
      );
      if (check.ok) {
        console.log("로그인 상태가 유효합니다.");
      } else {
        console.log(`로그인 상태가 아닙니다. ${describeFailure(check)}`);
        console.log("`tistory login`으로 다시 로그인하세요.");
        process.exitCode = 1;
      }
    });

  auth
    .command("logout")
    .description("로컬에 저장된 로그인 세션을 삭제합니다")
    .action(async () => {
      console.log(
        (await deleteSession())
          ? "로컬 로그인 세션을 삭제했습니다."
          : "삭제할 세션이 없습니다.",
      );
    });
}
