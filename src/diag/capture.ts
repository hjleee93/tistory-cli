import path from "node:path";
import type { Page } from "playwright";
import { DIAG_DIR, ensureDir, writePrivateFile } from "../core/config.js";

/**
 * 실패했을 때 화면 상태를 프로젝트 밖(~/.tistory-cli/diagnostics)에 남긴다.
 * 스크린샷·HTML에는 계정 정보와 작성 중인 글이 담길 수 있어 0600으로만 저장한다.
 */
export async function captureDiagnostics(
  page: Page,
  label: string,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(DIAG_DIR, `${label}-${stamp}`);
  await ensureDir(dir);
  await writePrivateFile(
    path.join(dir, "page.png"),
    await page.screenshot({ fullPage: false }),
  );
  await writePrivateFile(path.join(dir, "page.html"), await page.content());
  return dir;
}
