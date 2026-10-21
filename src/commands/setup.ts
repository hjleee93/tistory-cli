import type { Command } from "commander";
import { installBrowser } from "../core/browser.js";

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("처음 한 번: 자동화에 쓰는 Chromium 브라우저를 설치합니다")
    .action(async () => {
      console.log("Chromium 을 설치합니다. (약 150MB, 처음 한 번만)\n");
      const code = await installBrowser();
      if (code !== 0) {
        console.error("\n설치에 실패했습니다. 직접 실행해 보세요: npx playwright install chromium");
        process.exitCode = 1;
        return;
      }
      console.log("\n설치했습니다. 이제 `tistory login` 으로 로그인하세요.");
    });
}
