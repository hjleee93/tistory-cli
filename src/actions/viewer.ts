import { withSession } from "../auth/session.js";
import { editorUrl } from "../core/config.js";

/**
 * 임시저장 글은 공개 주소가 없다. 대신 글쓰기 화면의 '임시저장' 버튼으로 목록을 열어 불러온다.
 * 저장된 로그인 세션으로 눈에 보이는 브라우저 창을 띄우고, 그 목록을 열어 둔 채
 * 사용자가 창을 닫을 때까지 기다린다. (글은 건드리지 않는다)
 */
export async function viewDrafts(blog: string): Promise<void> {
  await withSession({ headless: false }, async (context) => {
    const page = await context.newPage();
    await page.goto(editorUrl(blog), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => undefined);

    try {
      await page
        .getByRole("button", { name: /임시저장 개수/ })
        .first()
        .click({ timeout: 8_000 });
      console.log("임시저장 목록을 열었습니다. 불러올 글을 고르세요.");
    } catch {
      console.log(
        "임시저장 목록을 자동으로 열지 못했습니다. 오른쪽 아래 '임시저장' 옆 숫자를 눌러 주세요.",
      );
    }
    console.log("브라우저 창을 닫으면 종료됩니다.");

    await new Promise<void>((resolve) => {
      context.once("close", () => resolve());
      page.once("close", () => resolve());
    });
  });
}
