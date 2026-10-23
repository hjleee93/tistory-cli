import type { BrowserContext, Page } from "playwright";
import { checkSession, describeFailure } from "../auth/session.js";
import { editorUrl } from "../core/config.js";
import { captureDiagnostics } from "../diag/capture.js";
import {
  PublishError,
  completePublish,
  watchDialogs,
  type Log,
  type PublishResult,
  type PublishVisibility,
} from "./publisher.js";

export interface DraftEntry {
  title: string;
  /** "27분전" 같은 저장 시각 표시 */
  savedAt: string;
}

const ITEM = ".info_editor dd a.link_info";

async function openEditor(context: BrowserContext, blog: string, log: Log): Promise<Page> {
  const session = await checkSession(context);
  if (!session.ok) {
    throw new PublishError(`${describeFailure(session)} \`tistory login\`을 다시 실행하세요.`);
  }
  const page = await context.newPage();
  log("글쓰기 화면 열기");
  await page.goto(editorUrl(blog), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  return page;
}

async function openDraftPanel(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: /임시저장 개수/ }).first();
  try {
    await button.click({ timeout: 8_000 });
  } catch {
    throw new PublishError("임시저장 목록 버튼을 찾지 못했습니다. `tistory doctor`로 점검해 보세요.");
  }
  // 임시저장 글이 없으면 항목이 나타나지 않는다
  await page.locator(ITEM).first().waitFor({ state: "visible", timeout: 4_000 }).catch(() => undefined);
}

async function readEntries(page: Page): Promise<DraftEntry[]> {
  return page.evaluate((selector) => {
    return Array.from(document.querySelectorAll(selector)).map((a) => {
      const dd = a.parentElement;
      const dt = dd?.previousElementSibling;
      return {
        title: (a.textContent ?? "").trim(),
        savedAt: (dt?.textContent ?? "").trim(),
      };
    });
  }, ITEM);
}

/** 임시저장 글 목록을 읽는다. (읽기 전용) */
export async function listDrafts(context: BrowserContext, blog: string, log: Log): Promise<DraftEntry[]> {
  const page = await openEditor(context, blog, log);
  try {
    watchDialogs(page, log);
    await openDraftPanel(page);
    return await readEntries(page);
  } finally {
    await page.close().catch(() => undefined);
  }
}

export interface PublishDraftOptions {
  visibility: PublishVisibility;
  /** 목록을 읽은 뒤 어떤 글을 발행할지 정한다. 0부터의 번호, 취소하면 undefined */
  choose: (entries: DraftEntry[]) => Promise<number | undefined>;
  /** 발행 직전 마지막 확인. false면 발행하지 않는다. */
  confirm?: (title: string) => Promise<boolean>;
}

export type PublishDraftOutcome =
  | { kind: "published"; title: string; result: PublishResult }
  | { kind: "none" }
  | { kind: "cancelled" };

/** 임시저장 글 하나를 불러와 발행한다. 발행 여부는 글 관리 목록에서 확인한다. */
export async function publishDraft(
  context: BrowserContext,
  blog: string,
  log: Log,
  options: PublishDraftOptions,
): Promise<PublishDraftOutcome> {
  const page = await openEditor(context, blog, log);
  try {
    const dialogs = watchDialogs(page, log);
    await openDraftPanel(page);
    const entries = await readEntries(page);
    if (entries.length === 0) return { kind: "none" };

    const index = await options.choose(entries);
    const entry = index === undefined ? undefined : entries[index];
    if (!entry) return { kind: "cancelled" };

    log("임시저장 글 불러오기");
    await page.locator(ITEM).nth(index as number).click({ timeout: 5_000 });
    const titleInput = page.locator("#post-title-inp").first();
    try {
      await page.waitForFunction(
        (expected) => {
          const el = document.querySelector("#post-title-inp") as HTMLInputElement | null;
          return !!el && el.value.trim() === expected;
        },
        entry.title,
        { timeout: 10_000 },
      );
    } catch {
      throw new PublishError(
        "임시저장 글을 불러오지 못했습니다 (제목이 에디터에 채워지지 않음). 발행하지 않았습니다.",
      );
    }
    const title = (await titleInput.inputValue()).trim();

    if (options.confirm && !(await options.confirm(title))) return { kind: "cancelled" };

    const result = await completePublish(page, title, log, { blog, visibility: options.visibility }, [], dialogs);
    return { kind: "published", title, result };
  } catch (error) {
    if (error instanceof PublishError) {
      error.diagnosticsDir = await captureDiagnostics(page, "publish-draft").catch(() => undefined);
    }
    throw error;
  } finally {
    await page.close().catch(() => undefined);
  }
}
