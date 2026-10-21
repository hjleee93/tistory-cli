import type { BrowserContext, Page } from "playwright";
import { captureDiagnostics } from "../diag/capture.js";
import { PublishError } from "./publisher.js";
import { postsUrl, readPostRows, type PostRow } from "../blog/posts.js";

const MAX_PAGES = 10;

async function openList(page: Page, blog: string, pageNo: number): Promise<PostRow[]> {
  const url = pageNo <= 1 ? postsUrl(blog) : `${postsUrl(blog)}?page=${pageNo}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  return readPostRows(page);
}

/** 글 번호가 있는 목록 쪽수를 찾는다. 못 찾으면 undefined. */
export async function findPostPage(
  page: Page,
  blog: string,
  id: number,
): Promise<{ pageNo: number; row: PostRow } | undefined> {
  let previousFirst: number | undefined;
  for (let n = 1; n <= MAX_PAGES; n++) {
    const rows = await openList(page, blog, n);
    if (rows.length === 0) return undefined;
    if (rows[0] && rows[0].id === previousFirst) return undefined; // 쪽수 인자가 무시된 경우
    previousFirst = rows[0]?.id;
    const row = rows.find((r) => r.id === id);
    if (row) return { pageNo: n, row };
  }
  return undefined;
}

/**
 * 글 한 개를 삭제한다.
 * 안전장치: 목록에서 대상 글 하나만 선택됐는지 확인하고, 확인창 문구에 '삭제'가 있을 때만 수락하며,
 * 삭제 뒤에는 목록에 그 글이 사라졌는지로 성공을 판단한다.
 */
export async function deletePost(
  context: BrowserContext,
  blog: string,
  id: number,
  expectedTitle: string,
): Promise<void> {
  const page = await context.newPage();
  try {
    const found = await findPostPage(page, blog, id);
    if (!found) throw new PublishError(`글 번호 ${id} 을(를) 글 목록에서 찾지 못했습니다.`);
    if (found.row.title !== expectedTitle) {
      throw new PublishError("글 제목이 확인한 내용과 달라 중단했습니다.");
    }

    const box = page.locator(`#inpCheck${id}`);
    const label = page.locator(`label[for="inpCheck${id}"]`);
    let clicked = false;
    if ((await label.count()) > 0) {
      clicked = await label.first().click({ timeout: 3_000 }).then(() => true, () => false);
    }
    if (!clicked) await box.click({ force: true, timeout: 5_000 });
    await page.waitForTimeout(400);

    // 선택된 글이 정확히 이 글 하나뿐일 때만 진행
    const checked = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLInputElement>("input.inp_check:checked")).map((e) => e.id),
    );
    if (checked.length !== 1 || checked[0] !== `inpCheck${id}`) {
      throw new PublishError("대상 글 하나만 선택되지 않아 중단했습니다. (아무것도 삭제하지 않았습니다)");
    }

    let sawConfirm = false;
    page.on("dialog", (dialog) => {
      if (!sawConfirm && dialog.type() === "confirm" && /삭제/.test(dialog.message())) {
        sawConfirm = true;
        void dialog.accept().catch(() => undefined);
      } else {
        void dialog.dismiss().catch(() => undefined);
      }
    });

    const del = page.locator("a.btn_post", { hasText: /^\s*삭제\s*$/ });
    if ((await del.count()) === 0) {
      throw new PublishError("삭제 버튼을 찾지 못했습니다. 화면이 바뀌었을 수 있습니다. `tistory diagnose` 를 실행해 보세요.");
    }
    // 선택된 글의 행 안에 있는 삭제 버튼을 우선한다
    const rowDel = page.locator(`li:has(#inpCheck${id}) a.btn_post, tr:has(#inpCheck${id}) a.btn_post`, { hasText: /^\s*삭제\s*$/ });
    const target = (await rowDel.count()) === 1 ? rowDel : del.first();
    await target.click({ timeout: 5_000, noWaitAfter: true });

    // 삭제 확인: 목록에서 글이 사라질 때까지 기다린다 (최대 30초)
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1500);
      const rows = await openList(page, blog, found.pageNo);
      if (!rows.some((r) => r.id === id)) return;
    }
    const dir = await captureDiagnostics(page, "delete-failed").catch(() => undefined);
    const err = new PublishError(
      sawConfirm
        ? "삭제를 눌렀지만 목록에서 글이 사라지지 않았습니다. 블로그 관리에서 직접 확인해 주세요."
        : "삭제 확인창이 나타나지 않았습니다. 화면이 바뀌었을 수 있습니다. 아무것도 삭제되지 않았을 가능성이 큽니다.",
    );
    if (dir) err.diagnosticsDir = dir;
    throw err;
  } finally {
    await page.close().catch(() => undefined);
  }
}
