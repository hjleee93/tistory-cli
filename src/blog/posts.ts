import type { BrowserContext, Page } from "playwright";

export interface PostRow {
  /** 블로그 안에서의 글 번호 (글 관리 목록의 체크박스 id에서 읽음) */
  id: number;
  title: string;
  url: string;
}

/**
 * 글 관리(글 목록) 화면에서 글 번호·제목·주소를 읽는다. (읽기 전용)
 * 목록은 최신 글이 위에 오고, 한 화면에 15개씩 보인다.
 */
export async function readPostRows(page: Page): Promise<PostRow[]> {
  return page.evaluate(() => {
    const rows: Array<{ id: number; title: string; url: string }> = [];
    let currentId: number | null = null;
    // 문서 순서대로 훑으며 "체크박스 → 글 링크"를 짝지어 읽는다.
    for (const el of Array.from(
      document.querySelectorAll("input.inp_check, a.link_cont"),
    )) {
      if (el instanceof HTMLInputElement) {
        const match = /^inpCheck(\d+)$/.exec(el.id);
        currentId = match?.[1] ? Number(match[1]) : null;
      } else if (currentId !== null) {
        const link = el as HTMLAnchorElement;
        rows.push({
          id: currentId,
          title: link.getAttribute("title") ?? (link.textContent ?? "").trim(),
          url: link.href,
        });
        currentId = null;
      }
    }
    return rows;
  });
}

export function postsUrl(blog: string): string {
  return `https://${blog}.tistory.com/manage/posts/`;
}

/** 새 탭으로 글 목록 첫 화면을 읽고 탭을 닫는다. */
export async function fetchPostRows(
  context: BrowserContext,
  blog: string,
): Promise<PostRow[]> {
  const page = await context.newPage();
  try {
    await page.goto(postsUrl(blog), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => undefined);
    return await readPostRows(page);
  } finally {
    await page.close().catch(() => undefined);
  }
}
