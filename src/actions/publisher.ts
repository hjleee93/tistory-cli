import type { BrowserContext, Page } from "playwright";
import { checkSession, describeFailure } from "../auth/session.js";
import { editorUrl } from "../core/config.js";
import { captureDiagnostics } from "../diag/capture.js";
import { CHECKS, runCheck } from "../diag/doctor.js";
import { fetchPostRows } from "../blog/posts.js";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Post } from "../post/post.js";
import { extractImageTokens, replaceImageTags, resolveImagePath, uniqueUploadNames } from "../post/images.js";

export class PublishError extends Error {
  diagnosticsDir?: string;
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

export type Log = (message: string) => void;

export interface DraftResult {
  /** 저장이 성공했다고 판단한 근거 */
  confirmedBy: "count" | "toast";
  /** 실패는 아니지만 확인하지 못한 것들 */
  warnings: string[];
  /** 저장 직후 화면의 주소 (글 번호가 있으면 그 글을 열 수 있다) */
  url: string;
}

/** 선택지 글자 목록을 보여 주고 고른 번호(0부터)를 돌려준다. 고르지 않으면 undefined. */
export type AskCategory = (labels: string[]) => Promise<number | undefined>;

export interface SaveOptions {
  /** 카테고리가 없거나 못 찾았을 때 목록에서 고르게 하는 질문 (터미널에서만 전달) */
  askCategory?: AskCategory;
}

const MODE_CONFIRM = /작성 모드를 변경/;
const normalize = (text: string): string => text.replace(/\r\n/g, "\n").trim();
const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 글을 건드리기 전에 필요한 요소가 모두 있는지 확인한다. 하나라도 없으면 중단. */
async function preflight(page: Page, needCategory: boolean): Promise<void> {
  const ids = [
    "title",
    "editor-mode",
    "tags",
    "save-draft",
    ...(needCategory ? ["category"] : []),
  ];
  const missing: string[] = [];
  for (const check of CHECKS.filter((c) => ids.includes(c.id))) {
    if ((await runCheck(page, check)).status === "missing") {
      missing.push(check.label);
    }
  }
  if (missing.length > 0) {
    throw new PublishError(
      `에디터 화면이 예상과 다릅니다. 찾지 못한 요소: ${missing.join(", ")}. ` +
        "`tistory doctor`로 점검해 보세요.",
    );
  }
}

async function readCodeMirror(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector(".CodeMirror") as unknown as {
      CodeMirror?: { getValue(): string };
    } | null;
    return el?.CodeMirror ? el.CodeMirror.getValue() : null;
  });
}

/** 본문은 HTML 모드(CodeMirror)에 넣는 것이 가장 안정적이다. */
async function ensureHtmlMode(page: Page, log: Log): Promise<void> {
  const codeMirror = page.locator(".CodeMirror").first();
  if (await codeMirror.isVisible().catch(() => false)) return; // 이미 HTML 모드

  log("HTML 모드로 전환");
  const modeCheck = CHECKS.find((c) => c.id === "editor-mode");
  let clicked = false;
  for (const candidate of modeCheck?.candidates ?? []) {
    const button = candidate.make(page).first();
    try {
      await button.waitFor({ state: "visible", timeout: 2_500 });
      await button.click();
      clicked = true;
      break;
    } catch {
      // 다음 후보
    }
  }
  if (!clicked) throw new PublishError("에디터 모드 전환 버튼을 찾지 못했습니다.");

  const htmlItem = page
    .getByRole("menuitem", { name: /^HTML$/ })
    .or(page.locator("#editor-mode-html"))
    .first();
  await htmlItem.click({ timeout: 5_000 });

  try {
    await codeMirror.waitFor({ state: "visible", timeout: 8_000 });
  } catch {
    throw new PublishError("HTML 모드로 전환하지 못했습니다.");
  }
}

/**
 * 로컬 이미지를 하나씩 에디터(기본모드)에 올리고, HTML 모드에서 보이는 `[##_Image|…_##]` 표기를 받아
 * 본문의 <img> 태그를 그 표기로 바꾼 HTML 을 돌려준다. 글은 저장하지 않는다.
 * 반드시 HTML 모드로 바꾸기 전(기본모드)에 호출해야 한다.
 */
async function uploadImages(page: Page, post: Post, log: Log): Promise<string> {
  if (post.localImages.length === 0) return post.html;
  if (await page.locator(".CodeMirror").first().isVisible().catch(() => false)) {
    throw new PublishError("에디터가 이미 HTML 모드라 이미지를 올릴 수 없습니다. 기본모드로 열린 뒤 다시 시도해 주세요.");
  }
  const baseDir = post.baseDir ?? process.cwd();
  const sources = post.localImages.map((src) => ({ src, file: resolveImagePath(baseDir, src) }));
  const names = uniqueUploadNames(sources.map((s) => s.file));
  const tmp = await mkdtemp(path.join(tmpdir(), "tistory-img-"));
  try {
    for (const [i, item] of sources.entries()) {
      const name = names[i] as string;
      const copy = path.join(tmp, name);
      try {
        await copyFile(item.file, copy);
      } catch {
        throw new PublishError(`이미지 파일을 읽을 수 없습니다: ${item.src}`);
      }
      log(`이미지 업로드 (${i + 1}/${sources.length}): ${name}`);
      await page.locator("#mceu_0-open").first().click({ timeout: 5_000 });
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 8_000 });
      await page.locator("#attach-image").first().click({ timeout: 5_000 });
      const chooser = await chooserPromise.catch(() => undefined);
      if (!chooser) throw new PublishError("이미지 선택 창이 열리지 않았습니다. 화면이 바뀌었을 수 있습니다.");
      await chooser.setFiles(copy);

      // 편집기 안에 같은 filename 의 이미지가 나타날 때까지 기다린다 (최대 40초)
      const body = page.frameLocator("#editor-tistory_ifr").locator("body");
      const deadline = Date.now() + 40_000;
      let done = false;
      while (Date.now() < deadline && !done) {
        await page.waitForTimeout(700);
        const html = await body.innerHTML({ timeout: 3_000 }).catch(() => "");
        done = html.includes(`data-filename="${name}"`);
      }
      if (!done) throw new PublishError(`이미지 업로드가 끝났는지 확인하지 못했습니다: ${name}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }

  await ensureHtmlMode(page, log);
  const code = (await readCodeMirror(page)) ?? "";
  const tokens = extractImageTokens(code);
  const map = new Map<string, string>();
  for (const [i, item] of sources.entries()) {
    const found = tokens.find((t) => t.filename === names[i]);
    if (!found) throw new PublishError(`업로드한 이미지의 표기를 찾지 못했습니다: ${item.src}`);
    map.set(item.src, found.token);
  }
  return replaceImageTags(post.html, map);
}

async function writeTitle(page: Page, title: string): Promise<void> {
  const field = page.getByPlaceholder(/제목/).first();
  await field.fill(title);
  if ((await field.inputValue()) !== title) {
    throw new PublishError("제목이 입력되지 않았습니다.");
  }
}

async function writeBody(page: Page, html: string, log: Log): Promise<void> {
  const codeMirror = page.locator(".CodeMirror").first();
  await codeMirror.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(html);

  let value = await readCodeMirror(page);
  if (value !== null && normalize(value) === normalize(html)) return;

  log("키보드 입력이 그대로 반영되지 않아 편집기에 값을 직접 설정합니다");
  await page.evaluate((text) => {
    const el = document.querySelector(".CodeMirror") as unknown as {
      CodeMirror?: { setValue(value: string): void };
    } | null;
    el?.CodeMirror?.setValue(text);
  }, html);

  value = await readCodeMirror(page);
  if (value === null || normalize(value) !== normalize(html)) {
    throw new PublishError(
      "본문이 에디터에 그대로 입력됐는지 확인하지 못했습니다. 저장하지 않고 중단합니다.",
    );
  }
}

/** 태그 칩이 실제로 생겼는지 확인하지 못한 태그 목록을 돌려준다. */
async function writeTags(page: Page, tags: string[]): Promise<string[]> {
  const input = page.getByPlaceholder(/태그/).first();
  for (const tag of tags) {
    await input.click();
    await input.fill(tag);
    await input.press("Enter");
    await page.waitForTimeout(150);
  }
  const unconfirmed: string[] = [];
  for (const tag of tags) {
    if ((await page.getByText(tag, { exact: true }).count()) === 0) {
      unconfirmed.push(tag);
    }
  }
  return unconfirmed;
}

async function selectCategory(page: Page, name: string): Promise<boolean> {
  const trigger = page
    .getByRole("combobox", { name: /카테고리/ })
    .or(page.locator("#category-btn"))
    .first();
  await trigger.click();
  await page.waitForTimeout(400);

  const exact = new RegExp(`^\\s*(?:-\\s*)?${escapeRegExp(name.replace(/^-\s*/, ""))}\\s*$`);
  const candidates = [
    page.getByRole("option", { name: exact }).first(),
    page.locator('[role="option"], li').filter({ hasText: exact }).first(),
  ];
  for (const option of candidates) {
    try {
      await option.waitFor({ state: "visible", timeout: 2_000 });
      await option.click();
      await page.waitForTimeout(300);
      const label = await trigger.innerText().catch(() => "");
      return label.includes(name);
    } catch {
      // 다음 후보
    }
  }

  const visible = await page
    .locator('[role="option"]')
    .allInnerTexts()
    .catch(() => [] as string[]);
  await page.keyboard.press("Escape").catch(() => undefined);
  const list = visible.map((t) => t.trim()).filter(Boolean);
  throw new PublishError(
    `카테고리 "${name}"을(를) 찾지 못했습니다.` +
      (list.length ? ` 보이는 항목: ${list.join(", ")}` : "") +
      " 저장하지 않고 중단합니다.",
  );
}

const OPTION_SELECTORS = ['[role="option"]', '[role="menuitem"]', "li"];

interface VisibleItem {
  index: number;
  label: string;
}

async function visibleItems(page: Page, selector: string): Promise<VisibleItem[]> {
  return page.locator(selector).evaluateAll((els) =>
    els.flatMap((el, index) => {
      const label = ((el as HTMLElement).innerText ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const visible =
        el.getClientRects().length > 0 &&
        getComputedStyle(el).visibility !== "hidden";
      return visible && label && label.length <= 60 ? [{ index, label }] : [];
    }),
  );
}

/** 카테고리 메뉴를 열고 새로 나타난 항목을 읽는다. 메뉴는 열린 채로 둔다. */
async function readCategoryOptions(
  page: Page,
): Promise<{ selector?: string; options: VisibleItem[] }> {
  const trigger = page
    .getByRole("combobox", { name: /카테고리/ })
    .or(page.locator("#category-btn"))
    .first();

  // 열려 있을 수 있는 메뉴를 먼저 닫고, 그때 보이는 항목을 기억해 둔다.
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(300);
  const before = new Map<string, Set<string>>();
  for (const selector of OPTION_SELECTORS) {
    before.set(
      selector,
      new Set((await visibleItems(page, selector)).map((item) => item.label)),
    );
  }

  await trigger.click();
  await page.waitForTimeout(500);

  for (const selector of OPTION_SELECTORS) {
    const known = before.get(selector);
    const fresh = (await visibleItems(page, selector)).filter(
      (item) => !known?.has(item.label),
    );
    if (fresh.length > 0) return { selector, options: fresh };
  }
  return { options: [] };
}

/** 열려 있는 글쓰기 화면에서 내 카테고리 목록만 읽는다. (아무것도 고르지 않음) */
export async function listCategoriesOnPage(page: Page): Promise<string[]> {
  const { options } = await readCategoryOptions(page);
  await page.keyboard.press("Escape").catch(() => undefined);
  return options.map((option) => option.label);
}

export async function listCategories(
  context: BrowserContext,
  blog: string,
): Promise<string[]> {
  const session = await checkSession(context);
  if (!session.ok) {
    throw new PublishError(`${describeFailure(session)} \`tistory login\`을 다시 실행하세요.`);
  }
  const page = await context.newPage();
  try {
    await page.goto(editorUrl(blog), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => undefined);
    return await listCategoriesOnPage(page);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * 카테고리 메뉴를 열어 새로 나타난 항목을 읽고, 터미널에서 하나 고르게 한 뒤 클릭한다.
 * 고른 항목의 글자를 돌려준다. 고르지 않았거나 목록을 못 읽으면 undefined.
 */
async function pickCategoryInteractively(
  page: Page,
  ask: AskCategory,
  log: Log,
  warnings: string[],
): Promise<string | undefined> {
  const trigger = page
    .getByRole("combobox", { name: /카테고리/ })
    .or(page.locator("#category-btn"))
    .first();

  log("카테고리 목록 읽기");
  const { selector, options } = await readCategoryOptions(page);
  if (!selector || options.length === 0) {
    await page.keyboard.press("Escape").catch(() => undefined);
    warnings.push("카테고리 목록을 읽지 못해 지정 없이 저장합니다.");
    return undefined;
  }

  const index = await ask(options.map((option) => option.label));
  const picked = index === undefined ? undefined : options[index];
  if (!picked) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return undefined;
  }

  await page.locator(selector).nth(picked.index).click();
  await page.waitForTimeout(300);
  const shown = await trigger.innerText().catch(() => "");
  if (!shown.includes(picked.label)) {
    warnings.push("카테고리가 선택됐는지 화면에서 확인하지 못했습니다.");
  }
  return picked.label;
}

async function readDraftCount(page: Page): Promise<number | undefined> {
  const label = await page
    .getByRole("button", { name: /임시저장 개수/ })
    .first()
    .getAttribute("aria-label", { timeout: 1_500 })
    .catch(() => null);
  const match = label ? /(\d+)\s*개/.exec(label) : null;
  return match?.[1] ? Number(match[1]) : undefined;
}

async function saveAndConfirm(page: Page): Promise<"count" | "toast"> {
  const before = await readDraftCount(page);
  await page
    .getByRole("button", { name: /^임시저장$/ })
    .first()
    .click({ timeout: 5_000 });

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const after = await readDraftCount(page);
    if (before !== undefined && after !== undefined && after > before) {
      return "count";
    }
    const toast = await page
      .getByText(/저장되었습니다/)
      .first()
      .isVisible()
      .catch(() => false);
    if (toast) return "toast";
    await page.waitForTimeout(300);
  }
  throw new PublishError(
    "임시저장이 되었는지 확인하지 못했습니다 (저장 개수가 늘지 않았고 완료 안내도 보이지 않음).",
  );
}

/** 이미 열려 있는 글쓰기 화면에서 임시저장까지 수행한다. (테스트를 위해 분리) */
/** 모드 변경 확인창은 항상 승인한다. 발행 단계에서는 그 밖의 확인창도 승인한다. */
export function watchDialogs(page: Page, log: Log): { acceptAll: boolean } {
  const state = { acceptAll: false };
  page.on("dialog", (dialog) => {
    const message = dialog.message().replace(/\s+/g, " ").slice(0, 80);
    if (MODE_CONFIRM.test(dialog.message())) {
      void dialog.accept();
    } else if (state.acceptAll) {
      log(`확인창 승인: ${message}`);
      void dialog.accept();
    } else {
      void dialog.dismiss();
    }
  });
  return state;
}

/** 제목·본문·태그·카테고리를 입력한다. (임시저장과 발행이 함께 쓴다) */
async function fillEditor(
  page: Page,
  post: Post,
  log: Log,
  options: SaveOptions,
  warnings: string[],
): Promise<void> {
  log("에디터 요소 확인");
  await preflight(page, Boolean(post.category) || Boolean(options.askCategory));

  const bodyHtml = await uploadImages(page, post, log);
  await ensureHtmlMode(page, log);

  log("제목 입력");
  await writeTitle(page, post.title);

  log("본문 입력");
  await writeBody(page, bodyHtml, log);

  if (post.tags.length > 0) {
    log(`태그 입력 (${post.tags.length}개)`);
    const unconfirmed = await writeTags(page, post.tags);
    if (unconfirmed.length > 0) {
      warnings.push(`태그가 화면에 표시됐는지 확인하지 못했습니다: ${unconfirmed.join(", ")}`);
    }
  }

  if (post.category) {
    log(`카테고리 선택: ${post.category}`);
    try {
      const confirmed = await selectCategory(page, post.category);
      if (!confirmed) warnings.push("카테고리가 선택됐는지 화면에서 확인하지 못했습니다.");
    } catch (error) {
      // 이름이 틀렸을 때: 터미널이면 목록에서 고르게 하고, 아니면 저장 전에 중단한다.
      if (!(error instanceof PublishError) || !options.askCategory) throw error;
      log(`"${post.category}" 카테고리가 없어 목록에서 고르게 합니다`);
      await pickCategoryInteractively(page, options.askCategory, log, warnings);
    }
  } else if (options.askCategory) {
    await pickCategoryInteractively(page, options.askCategory, log, warnings);
  }
}

/** 이미 열려 있는 글쓰기 화면에서 임시저장까지 수행한다. (테스트를 위해 분리) */
export async function saveDraftOnPage(
  page: Page,
  post: Post,
  log: Log,
  options: SaveOptions = {},
): Promise<DraftResult> {
  watchDialogs(page, log);
  const warnings: string[] = [];

  await fillEditor(page, post, log, options, warnings);

  log("임시저장");
  const confirmedBy = await saveAndConfirm(page);
  return { confirmedBy, warnings, url: page.url() };
}

export interface PublishResult {
  /** 글 관리 목록에서 확인한 글 번호 */
  id: number;
  /** 발행된 글의 주소 */
  url: string;
  warnings: string[];
}

export type PublishVisibility = "public" | "private";

/** 발행 설정 창의 공개 범위 라디오 (보호=open15는 비밀번호가 필요해 아직 지원하지 않는다) */
const VISIBILITY_RADIO: Record<PublishVisibility, string> = {
  public: "open20",
  private: "open0",
};

async function chooseVisibility(page: Page, visibility: PublishVisibility): Promise<void> {
  const id = VISIBILITY_RADIO[visibility];
  const radio = page.locator(`#${id}`);
  try {
    await radio.check({ timeout: 3_000 });
  } catch {
    // 라디오가 이름표(label)에 가려져 있으면 이름표를 누른다
    await page.locator(`label[for="${id}"]`).first().click({ timeout: 3_000 });
  }
  if (!(await radio.isChecked().catch(() => false))) {
    throw new PublishError("공개 범위를 선택하지 못했습니다. 발행하지 않고 중단합니다.");
  }
}

const PUBLISH_CONFIRM_TIMEOUT_MS = 30_000;

/**
 * 이미 열려 있는 글쓰기 화면에서 입력 → 발행까지 수행한다. (테스트를 위해 분리)
 * 발행이 됐는지는 화면 이동이 아니라 "글 관리 목록에 같은 제목의 새 글이 생겼는지"로 확인한다.
 */
export async function publishOnPage(
  page: Page,
  post: Post,
  log: Log,
  options: SaveOptions & { blog: string; visibility: PublishVisibility },
): Promise<PublishResult> {
  const dialogs = watchDialogs(page, log);
  const warnings: string[] = [];

  await fillEditor(page, post, log, options, warnings);
  return completePublish(page, post.title, log, options, warnings, dialogs);
}

/**
 * 에디터에 글이 채워진 상태에서 '완료' → 공개 범위 → 발행 → 목록에서 확인까지 수행한다.
 * (원고를 채운 뒤, 또는 임시저장 글을 불러온 뒤 함께 쓴다)
 */
export async function completePublish(
  page: Page,
  title: string,
  log: Log,
  options: { blog: string; visibility: PublishVisibility },
  warnings: string[],
  dialogs: { acceptAll: boolean },
): Promise<PublishResult> {
  // 같은 제목의 예전 글과 구별하려고, 발행 전 가장 큰 글 번호를 기억해 둔다.
  const before = await fetchPostRows(page.context(), options.blog);
  const maxBefore = before.reduce((max, row) => Math.max(max, row.id), 0);

  log("발행 설정 창 열기");
  const complete = page
    .getByRole("button", { name: /^완료$/ })
    .or(page.locator("#publish-layer-btn"))
    .first();
  await complete.click({ timeout: 5_000 });

  const publishButton = page.locator("#publish-btn");
  try {
    await publishButton.waitFor({ state: "visible", timeout: 8_000 });
  } catch {
    throw new PublishError(
      "발행 설정 창이 열리지 않았습니다 (제목이나 본문이 비어 있으면 열리지 않습니다). 발행하지 않았습니다.",
    );
  }

  log(`공개 범위: ${options.visibility === "public" ? "공개" : "비공개"}`);
  await chooseVisibility(page, options.visibility);

  log("발행");
  dialogs.acceptAll = true;
  await publishButton.click({ timeout: 5_000 });

  const deadline = Date.now() + PUBLISH_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_500);
    const rows = await fetchPostRows(page.context(), options.blog).catch(
      () => [] as Awaited<ReturnType<typeof fetchPostRows>>,
    );
    const hit = rows.find((row) => row.id > maxBefore && row.title.trim() === title.trim());
    if (hit) return { id: hit.id, url: hit.url, warnings };
  }
  throw new PublishError(
    "발행이 되었는지 확인하지 못했습니다 (글 관리 목록에 같은 제목의 새 글이 보이지 않음). " +
      "실제로는 발행됐을 수 있으니 티스토리 글 관리에서 확인하세요. 같은 글을 다시 발행하면 중복될 수 있습니다.",
  );
}

export async function saveDraft(
  context: BrowserContext,
  blog: string,
  post: Post,
  log: Log,
  options: SaveOptions = {},
): Promise<DraftResult> {
  const session = await checkSession(context);
  if (!session.ok) {
    throw new PublishError(`${describeFailure(session)} \`tistory login\`을 다시 실행하세요.`);
  }

  const page = await context.newPage();
  try {
    log("글쓰기 화면 열기");
    await page.goto(editorUrl(blog), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => undefined);

    return await saveDraftOnPage(page, post, log, options);
  } catch (error) {
    if (error instanceof PublishError) {
      error.diagnosticsDir = await captureDiagnostics(page, "publish").catch(
        () => undefined,
      );
    }
    throw error;
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function publishPost(
  context: BrowserContext,
  blog: string,
  post: Post,
  log: Log,
  options: SaveOptions & { visibility: PublishVisibility },
): Promise<PublishResult> {
  const session = await checkSession(context);
  if (!session.ok) {
    throw new PublishError(`${describeFailure(session)} \`tistory login\`을 다시 실행하세요.`);
  }

  const page = await context.newPage();
  try {
    log("글쓰기 화면 열기");
    await page.goto(editorUrl(blog), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => undefined);

    return await publishOnPage(page, post, log, { ...options, blog });
  } catch (error) {
    if (error instanceof PublishError) {
      error.diagnosticsDir = await captureDiagnostics(page, "publish").catch(
        () => undefined,
      );
    }
    throw error;
  } finally {
    await page.close().catch(() => undefined);
  }
}
