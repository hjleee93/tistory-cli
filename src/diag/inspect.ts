import { existsSync } from "node:fs";
import type { BrowserContext, Locator, Page } from "playwright";
import { checkSession, describeFailure } from "../auth/session.js";
import { CHECKS } from "./doctor.js";
import { editorUrl } from "../core/config.js";
import { fetchPostRows } from "../blog/posts.js";

/**
 * 화면의 "조작 가능한 요소"의 구조만 출력한다. (개발용: 선택자를 확정하기 위한 도구)
 * 입력값(value)은 출력하지 않는다. maskText를 켜면 긴 글자(글 제목 등)도 가린다.
 * 글을 발행하거나 삭제하는 버튼은 절대 누르지 않는다.
 */
interface OutlineOptions {
  extraSelectors?: string[];
  /** true면 8자를 넘는 글자는 ⟨N자⟩로 가린다 (글 제목 노출 방지) */
  maskText?: boolean;
  /** 지정하면 화면 위에서 이 픽셀 안쪽에 있는 요소만 본다 */
  maxTop?: number;
}

async function outline(page: Page, options: OutlineOptions = {}): Promise<string[]> {
  const args = {
    extra: options.extraSelectors ?? [],
    mask: options.maskText ?? false,
    maxTop: options.maxTop ?? -1,
  };
  return page.evaluate(({ extra, mask, maxTop }) => {
    const selector = [
      "button",
      '[role="button"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[role="tab"]',
      '[role="textbox"]',
      '[role="radio"]',
      '[role="checkbox"]',
      "input",
      "textarea",
      "select",
      "iframe",
      '[contenteditable="true"]',
      ".CodeMirror",
      ".cm-editor",
      ".ace_editor",
      '[id^="editor-"]',
      ...extra,
    ].join(",");

    const lines: string[] = [];
    const seen = new Set<string>();

    for (const el of Array.from(document.querySelectorAll(selector))) {
      const rects = el.getClientRects();
      const style = getComputedStyle(el);
      if (rects.length === 0 || style.visibility === "hidden") continue;
      const firstRect = rects[0];
      if (maxTop >= 0 && firstRect && firstRect.top > maxTop) continue;

      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const cls = el.classList.length
        ? "." + Array.from(el.classList).slice(0, 3).join(".")
        : "";
      const attrs: string[] = [];
      for (const name of [
        "role",
        "type",
        "name",
        "for",
        "aria-label",
        "aria-haspopup",
        "aria-expanded",
        "placeholder",
        "title",
      ]) {
        const value = el.getAttribute(name);
        if (!value) continue;
        // 글 제목은 링크의 title 속성에도 들어 있으므로 속성도 같은 기준으로 가린다
        const shown =
          mask && (name === "title" || name === "aria-label") && value.length > 8
            ? `⟨${value.length}자⟩`
            : value.slice(0, 30);
        attrs.push(`${name}="${shown}"`);
      }
      if (tag === "input") {
        const input = el as HTMLInputElement;
        // 값은 출력하지 않지만, 라디오/체크박스의 선택 상태와 value 이름표는 구조 파악에 필요
        if (input.type === "radio" || input.type === "checkbox") {
          attrs.push(`value="${input.value.slice(0, 20)}"`);
          attrs.push(input.checked ? "checked" : "unchecked");
        }
      }
      if (tag === "a") {
        const href = el.getAttribute("href");
        if (href) {
          // 경로의 모양만 남기고 숫자(글 번호)와 쿼리는 가린다
          const shape = href.replace(/^https?:\/\/[^/]+/, "").split(/[?#]/)[0] ?? "";
          attrs.push(`href~"${shape.replace(/\/(entry|category|tag)\/[^/]+/g, "/$1/…").replace(/\d+/g, "N").slice(0, 40)}"`);
        }
      }
      if (tag === "iframe") {
        let editable = "?";
        try {
          const doc = (el as HTMLIFrameElement).contentDocument;
          editable = doc?.body?.isContentEditable ? "editable" : "not-editable";
        } catch {
          editable = "cross-origin";
        }
        attrs.push(`iframe=${editable}`);
      }

      const isField = tag === "input" || tag === "textarea" || tag === "select";
      const full = isField
        ? ""
        : ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
      let text = full.slice(0, 20);
      if (mask && full.length > 8) text = `⟨${full.length}자⟩`;

      const line = `${tag}${id}${cls} ${attrs.join(" ")}${text ? ` "${text}"` : ""}`.trim();
      if (!seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
      if (lines.length >= 150) break;
    }
    return lines;
  }, args);
}

async function firstVisible(
  page: Page,
  makers: Array<(p: Page) => Locator>,
): Promise<Locator | undefined> {
  for (const make of makers) {
    const locator = make(page).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 2_500 });
      return locator;
    } catch {
      // 다음 후보
    }
  }
  return undefined;
}

function printBlock(title: string, lines: string[]): void {
  console.log(`\n===== ${title} (${lines.length}) =====`);
  for (const line of lines) console.log(`  ${line}`);
}

const minus = (a: string[], b: string[]): string[] => {
  const set = new Set(b);
  return a.filter((line) => !set.has(line));
};

export interface InspectEditorOptions {
  /** 제목·본문을 임시로 채우고 '완료'를 눌러 발행 설정 창만 열어 본다 (발행은 하지 않음) */
  publishLayer?: boolean;
}

/** 이미 열려 있는 에디터 페이지를 점검한다. (테스트를 위해 페이지 단위로 분리) */
export async function inspectEditorPage(
  page: Page,
  options: InspectEditorOptions = {},
): Promise<void> {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message().slice(0, 80)}`);
    void dialog.accept().catch(() => undefined);
  });

  const base = await outline(page);
  printBlock("1) 기본 화면의 요소", base);

  // 카테고리 메뉴를 열어 본다 (고르지는 않는다)
  let settled = base;
  const categoryButton = await firstVisible(page, [
    (p) => p.getByRole("combobox", { name: /카테고리/ }),
    (p) => p.locator("#category-btn"),
  ]);
  if (categoryButton) {
    await categoryButton.click();
    await page.waitForTimeout(600);
    const opened = await outline(page);
    printBlock("1-b) 카테고리 메뉴를 열었을 때 새로 보이는 요소", minus(opened, base));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    settled = await outline(page);

    // 카테고리를 골랐을 때 화면 어디에 어떻게 표시되는지 본다. (글은 저장하지 않고, 마지막에 '카테고리 없음'으로 되돌린다)
    const showTrigger = async (label: string): Promise<void> => {
      const info = await page.evaluate(() => {
        const el = document.querySelector("#category-btn");
        if (!el) return "(#category-btn 없음)";
        const active = Array.from(document.querySelectorAll('[role="option"]'))
          .filter((o) => o.classList.contains("mce-active") || o.getAttribute("aria-selected") === "true")
          .map((o) => (o.textContent ?? "").trim());
        return `innerText="${(el as HTMLElement).innerText.trim()}" aria-label="${el.getAttribute("aria-label")}" title="${el.getAttribute("title")}" 활성옵션=${JSON.stringify(active)} html=${el.outerHTML.replace(/\s+/g, " ").slice(0, 260)}`;
      });
      console.log(`  ${label}: ${info}`);
    };
    console.log("\n===== 1-c) 카테고리를 골랐을 때 표시 =====");
    const options = page.locator('[role="option"]');
    for (const index of [1, 3]) {
      await categoryButton.click({ timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(400);
      const option = options.nth(index);
      if ((await option.count()) === 0) continue;
      const text = ((await option.innerText({ timeout: 3_000 }).catch(() => "")) || "").trim();
      await option.click({ timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
      await showTrigger(`옵션 #${index} "${text}" 선택 후`);
    }
    await categoryButton.click({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
    if ((await options.count()) > 0) await options.nth(0).click({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
    await showTrigger("'카테고리 없음'으로 되돌린 뒤");
  }

  // 에디터 모드 전환 메뉴를 열어 본다 (메뉴만 열고 글은 건드리지 않는다)
  const modeCheck = CHECKS.find((check) => check.id === "editor-mode");
  const modeButton = await firstVisible(
    page,
    (modeCheck?.candidates ?? []).map((candidate) => candidate.make),
  );
  if (!modeButton) {
    console.log("\n(모드 전환 버튼을 찾지 못해 이후 단계를 건너뜁니다)");
    return;
  }
  const modeLabel = (await modeButton.innerText().catch(() => "")).trim();
  console.log(`\n모드 전환 버튼의 현재 글자: "${modeLabel}"`);

  await modeButton.click();
  await page.waitForTimeout(600);
  const menu = await outline(page);
  printBlock("2) 모드 메뉴를 열었을 때 새로 보이는 요소", minus(menu, settled));

  // HTML 모드로 전환했을 때 입력창이 어떻게 바뀌는지 본다 (빈 에디터이므로 안전)
  const htmlOption = await firstVisible(page, [
    (p) => p.getByRole("menuitem", { name: /^HTML$/ }),
    (p) => p.getByRole("option", { name: /^HTML$/ }),
    (p) => p.getByText("HTML", { exact: true }),
  ]);
  if (!htmlOption) {
    console.log("\n(HTML 메뉴 항목을 찾지 못했습니다)");
    return;
  }
  await htmlOption.click();
  await page.waitForTimeout(1_000);
  const html = await outline(page);
  printBlock("3) HTML 모드로 바꾼 뒤 새로 보이는 요소", minus(html, menu));
  printBlock("3-b) HTML 모드로 바꾼 뒤 사라진 요소", minus(menu, html));
  const labelAfter = (await modeButton.innerText().catch(() => "")).trim();
  console.log(`\n모드 전환 버튼의 글자(전환 후): "${labelAfter}"`);
  console.log(`확인 대화상자: ${dialogs.length ? dialogs.join(" | ") : "없음"}`);

  if (options.publishLayer) await inspectPublishLayer(page, html, dialogs);
}

/**
 * '완료' 버튼으로 열리는 발행 설정 창의 구조를 본다.
 * 빈 글은 설정 창이 열리지 않을 수 있어 임시 제목·본문을 넣는다.
 * ⚠ 발행 설정 창 안의 발행 버튼은 누르지 않는다. 다만 에디터의 자동 저장으로
 *   'inspect-test'라는 임시저장 글이 생길 수 있으니, 확인 후 지워 주세요.
 */
async function inspectPublishLayer(
  page: Page,
  before: string[],
  dialogs: string[],
): Promise<void> {
  console.log("\n--- 발행 설정 창 점검 (발행은 하지 않습니다) ---");

  await page.getByPlaceholder(/제목/).first().fill("inspect-test");
  const codeMirror = page.locator(".CodeMirror").first();
  if (await codeMirror.isVisible().catch(() => false)) {
    await codeMirror.click();
    await page.keyboard.insertText("<p>inspect-test</p>");
  }

  const completeButton = await firstVisible(page, [
    (p) => p.getByRole("button", { name: /^완료$/ }),
    (p) => p.locator("#publish-layer-btn"),
  ]);
  if (!completeButton) {
    console.log("(완료 버튼을 찾지 못했습니다)");
    return;
  }

  const dialogCount = dialogs.length;
  await completeButton.click();
  await page.waitForTimeout(1_000);

  const layer = await outline(page);
  printBlock("4) '완료'를 눌렀을 때 새로 보이는 요소", minus(layer, before));
  printBlock("4-b) '완료'를 눌렀을 때 사라진 요소", minus(before, layer));
  const newDialogs = dialogs.slice(dialogCount);
  console.log(`\n'완료' 후 대화상자: ${newDialogs.length ? newDialogs.join(" | ") : "없음"}`);

  await page.keyboard.press("Escape");
  console.log(
    "\n발행 설정 창을 닫았습니다. 발행 버튼은 누르지 않았습니다.\n" +
      "※ 자동 저장으로 'inspect-test' 임시저장 글이 생겼을 수 있습니다. 확인 후 지워 주세요.",
  );
}

export async function inspectEditor(
  context: BrowserContext,
  blog: string,
  options: InspectEditorOptions = {},
): Promise<boolean> {
  const session = await checkSession(context);
  if (!session.ok) {
    console.error(describeFailure(session));
    return false;
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
    await inspectEditorPage(page, options);
    return true;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * 글 관리(글 목록) 화면의 구조만 본다. 글 제목은 가리고 링크 주소의 숫자도 가린다.
 * ⚠ 삭제 버튼은 누르지 않는다. 체크박스도 건드리지 않는다.
 */
export interface InspectPostsOptions {
  /** 첫 글의 체크박스를 잠깐 선택해 나타나는 버튼(삭제 등)과 행에 마우스를 올렸을 때의 요소를 본다.
   *  선택은 곧바로 해제하며, 삭제 버튼은 누르지 않는다. */
  probeSelection?: boolean;
}

export async function inspectPostsPage(
  page: Page,
  options: InspectPostsOptions = {},
): Promise<void> {
  const outlineOptions = {
    maskText: true,
    extraSelectors: [
      'input[type="checkbox"]',
      "a[href]",
      "tr",
      '[role="row"]',
      "th",
      "td",
    ],
  };
  const rows = await outline(page, outlineOptions);
  printBlock("글 관리 화면의 요소 (글 제목은 ⟨N자⟩로 가림)", rows);

  if (options.probeSelection) {
    const first = page.locator('input[id^="inpCheck"]:not(#inpAllCheck)').first();
    if ((await first.count()) === 0) {
      console.log("\n(선택할 글이 없어 선택 탐색을 건너뜁니다)");
    } else {
      // 체크박스가 꾸밈용 요소로 가려진 경우가 있어 check()는 상태 확인에서 멈춘다.
      // 상태 확인 없이 label(없으면 체크박스 자체)을 눌러 토글만 한다.
      const toggle = async (): Promise<void> => {
        const id = await first.getAttribute("id");
        const label = page.locator(`label[for="${id}"]`);
        if ((await label.count()) > 0) await label.first().click({ timeout: 5_000 });
        else await first.click({ force: true, timeout: 5_000 });
      };
      await toggle();
      await page.waitForTimeout(600);
      const selected = await outline(page, outlineOptions);
      printBlock("A) 첫 글을 선택했을 때 새로 보이는 요소", minus(selected, rows));
      printBlock("A-b) 첫 글을 선택했을 때 사라진 요소", minus(rows, selected));
      if (await first.isChecked().catch(() => false)) await toggle();
      await page.waitForTimeout(400);

      const link = page.locator("a.link_cont").first();
      await link.hover().catch(() => undefined);
      await page.waitForTimeout(600);
      const hovered = await outline(page, outlineOptions);
      printBlock("B) 첫 글에 마우스를 올렸을 때 새로 보이는 요소", minus(hovered, rows));
      console.log("\n선택은 해제했고 삭제 버튼은 누르지 않았습니다.");
    }
  }
  const counts = await page.evaluate(() => ({
    checkboxes: document.querySelectorAll('input[type="checkbox"]').length,
    rows: document.querySelectorAll("tr, [role='row']").length,
  }));
  console.log(`\n체크박스 ${counts.checkboxes}개, 행 ${counts.rows}개`);
}

export async function inspectPosts(
  context: BrowserContext,
  blog: string,
  options: InspectPostsOptions = {},
): Promise<boolean> {
  const session = await checkSession(context);
  if (!session.ok) {
    console.error(describeFailure(session));
    return false;
  }
  const page = await context.newPage();
  try {
    await page.goto(`https://${blog}.tistory.com/manage/posts/`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => undefined);
    const landed = new URL(page.url());
    console.log(`도착 위치: ${landed.hostname}${landed.pathname}`);
    await inspectPostsPage(page, options);
    return true;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * 글 한 개의 페이지(소유자로 로그인한 상태)에서 `⋮` 관리 메뉴의 구조를 본다.
 * 아무것도 클릭하지 않는다. 숨어 있는 "수정/삭제/공개 변경" 항목도 찾아서 위치를 알려 준다.
 * 글 제목·본문은 가려서 출력한다.
 */
export async function inspectPostPage(page: Page): Promise<void> {
  const top = await outline(page, {
    maskText: true,
    maxTop: 700,
    extraSelectors: ["a[href]"],
  });
  printBlock("글 페이지 위쪽(700px 안)의 클릭 가능한 요소", top);

  const found = await page.evaluate(() => {
    // tsx/esbuild가 화면 안 코드에 끼워 넣는 도우미 함수가 없어서 생기는 오류 방지
    (globalThis as unknown as { __name?: unknown }).__name ??= (f: unknown) => f;
    const words = new Set(["수정", "삭제", "비공개로 변경", "공개로 변경"]);
    const describe = (el: Element): string => {
      const id = el.id ? `#${el.id}` : "";
      const cls = el.classList.length
        ? "." + Array.from(el.classList).slice(0, 2).join(".")
        : "";
      const role = el.getAttribute("role");
      return `${el.tagName.toLowerCase()}${id}${cls}${role ? `[role=${role}]` : ""}`;
    };
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      // 자기 자신의 글자(자식 요소 글자 제외)가 정확히 해당 단어인 요소만
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (!words.has(own)) continue;

      const rects = el.getClientRects();
      const visible =
        rects.length > 0 && getComputedStyle(el).visibility !== "hidden";
      const chain: string[] = [];
      let cursor: Element | null = el.parentElement;
      for (let i = 0; i < 4 && cursor; i++) {
        chain.push(describe(cursor));
        cursor = cursor.parentElement;
      }
      const href = el.getAttribute("href");
      const shape = href
        ? ` href~"${href.replace(/^https?:\/\/[^/]+/, "").split(/[?#]/)[0]?.replace(/\/(entry|category|tag)\/[^/]+/g, "/$1/…").replace(/\d+/g, "N").slice(0, 40)}"`
        : "";
      out.push(
        `${visible ? "보임" : "숨김"}  ${describe(el)}${shape} "${own}"  ← 부모: ${chain.join(" < ")}`,
      );
    }
    return out;
  });
  printBlock("관리 메뉴 항목(수정·삭제·공개 변경) 위치 — 숨겨진 것 포함", found);
  console.log("\n아무것도 클릭하지 않았습니다.");
}

export async function inspectPost(
  context: BrowserContext,
  blog: string,
  urlArg?: string,
): Promise<boolean> {
  const session = await checkSession(context);
  if (!session.ok) {
    console.error(describeFailure(session));
    return false;
  }
  let url = urlArg;
  if (!url) {
    const rows = await fetchPostRows(context, blog);
    const newest = rows.find((r) => r.url);
    if (!newest) {
      console.error("점검할 글을 찾지 못했습니다. 블로그에 공개된 글이 하나는 있어야 합니다.");
      return false;
    }
    url = newest.url;
    console.log("가장 최근 글을 자동으로 골랐습니다. (주소는 가림)");
  }
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => undefined);
    const landed = new URL(page.url());
    console.log(`도착 위치: ${landed.hostname}${landed.pathname.replace(/\/(entry|category|tag)\/[^/]+/g, "/$1/…").replace(/\d+/g, "N")}`);
    await inspectPostPage(page);
    return true;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * 글 목록에서 첫 글의 `삭제`를 눌러 "확인 화면이 어떻게 생겼는지"만 본다.
 * 안전장치 (삭제가 실제로 일어나지 않도록 이중으로 막는다):
 *  1) 이 탭에서 GET/HEAD 가 아닌 요청(삭제 요청 포함)은 전부 차단하고 기록한다.
 *  2) 브라우저 기본 대화상자(confirm)는 내용만 기록하고 '취소'한다.
 *  3) 화면에 뜬 확인 창은 구조만 출력하고 취소/닫기로 닫는다. 확인(삭제) 버튼은 누르지 않는다.
 */
export async function inspectDeletePage(page: Page): Promise<void> {
  const blocked: string[] = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() === "GET" || req.method() === "HEAD") return route.continue();
    const u = new URL(req.url());
    blocked.push(`${req.method()} ${u.hostname}${u.pathname.replace(/\d+/g, "N")}`);
    return route.abort();
  });
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message().replace(/\s+/g, " ")}`);
    void dialog.dismiss().catch(() => undefined);
  });

  const first = page.locator('input[id^="inpCheck"]:not(#inpAllCheck)').first();
  if ((await first.count()) === 0) {
    console.log("(점검할 글이 없습니다)");
    return;
  }
  const id = await first.getAttribute("id");
  const label = page.locator(`label[for="${id}"]`);
  if ((await label.count()) > 0) await label.first().click({ timeout: 5_000 });
  else await first.click({ force: true, timeout: 5_000 });
  await page.waitForTimeout(500);

  // 확인 창의 안내 문구를 읽어야 하므로 글자는 가리지 않는다. (전후 비교로 새 요소만 출력)
  const probeSelectors = ["a.btn_post", "a[href]", "div[class*=layer]", "div[class*=modal]", "div[class*=popup]", "div[role=dialog]", "[class*=confirm]", "[class*=alert]"];
  const before = await outline(page, { maskText: false, extraSelectors: probeSelectors });
  const del = page.locator("a.btn_post", { hasText: /^\s*삭제\s*$/ }).first();
  if ((await del.count()) === 0) {
    console.log("삭제 버튼(a.btn_post)을 찾지 못했습니다.");
    return;
  }
  await del.click({ timeout: 5_000, noWaitAfter: true }).catch((e: Error) => console.log(`클릭 오류: ${e.message.split("\n")[0]}`));
  await page.waitForTimeout(1200);

  const after = await outline(page, { maskText: false, extraSelectors: probeSelectors });
  printBlock("삭제를 눌렀을 때 새로 보이는 요소", minus(after, before));
  printBlock("삭제를 눌렀을 때 사라진 요소", minus(before, after));
  printBlock("브라우저 기본 대화상자(취소함)", dialogs);
  printBlock("차단한 쓰기 요청(실제로는 전송되지 않음)", blocked);

  // 닫기: 취소/닫기 버튼 → Esc 순서
  const cancel = page.getByRole("button", { name: /^(취소|닫기|아니오)$/ }).first();
  if ((await cancel.count()) > 0 && (await cancel.isVisible().catch(() => false))) {
    await cancel.click({ timeout: 3_000 }).catch(() => undefined);
    console.log("\n확인 창의 취소/닫기 버튼으로 닫았습니다.");
  } else {
    await page.keyboard.press("Escape");
    console.log("\nEsc로 닫았습니다.");
  }
  await page.waitForTimeout(300);
  if (await first.isChecked().catch(() => false)) {
    if ((await label.count()) > 0) await label.first().click({ timeout: 3_000 }).catch(() => undefined);
  }
  console.log("삭제는 실행되지 않았습니다. (쓰기 요청 차단 + 확인 창 취소)");
}

export async function inspectDelete(context: BrowserContext, blog: string): Promise<boolean> {
  const session = await checkSession(context);
  if (!session.ok) {
    console.error(describeFailure(session));
    return false;
  }
  const page = await context.newPage();
  try {
    await page.goto(`https://${blog}.tistory.com/manage/posts/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await inspectDeletePage(page);
    return true;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * 에디터의 `첨부` 메뉴 구조와 파일 입력칸(input[type=file])을 본다. (이미지 업로드 준비용)
 * 메뉴만 열고, 파일을 고르거나 올리지 않는다. 파일 선택 창이 뜨면 아무것도 고르지 않고 취소한다.
 */
export async function inspectAttachPage(page: Page): Promise<void> {
  let chooserSeen = 0;
  page.on("filechooser", () => {
    chooserSeen++; // 파일을 지정하지 않으면 선택 창은 열리지 않은 채 무시된다
  });

  const describeFiles = (): Promise<string[]> =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).map((el) => {
        const rects = el.getClientRects();
        const parent = el.parentElement;
        return [
          `input${el.id ? "#" + el.id : ""}${el.name ? ` name="${el.name}"` : ""}`,
          `accept="${el.accept}"`,
          el.multiple ? "multiple" : "single",
          rects.length > 0 ? "보임" : "숨김",
          `부모: ${parent?.tagName.toLowerCase() ?? ""}${parent?.id ? "#" + parent.id : ""}${parent?.className ? "." + String(parent.className).split(" ")[0] : ""}`,
        ].join("  ");
      }),
    );

  printBlock("파일 입력칸 (처음 상태)", await describeFiles());

  const base = await outline(page, { maskText: true });
  // 바깥 div(#mceu_0)는 안쪽 button 에 가려져 클릭이 막히므로 안쪽 button 부터 시도한다.
  const candidates = ["#mceu_0-open", "#attach-layer-btn", "[aria-label='첨부'] button", "[aria-label='첨부']"];
  let clickedWith: string | undefined;
  for (const selector of candidates) {
    const el = page.locator(selector).first();
    if ((await el.count()) === 0) continue;
    const ok = await el.click({ timeout: 3_000 }).then(() => true, () => false);
    if (ok) {
      clickedWith = selector;
      break;
    }
  }
  if (!clickedWith) {
    for (const selector of candidates) {
      const el = page.locator(selector).first();
      if ((await el.count()) === 0) continue;
      const ok = await el.click({ force: true, timeout: 3_000 }).then(() => true, () => false);
      if (ok) {
        clickedWith = `${selector} (force)`;
        break;
      }
    }
  }
  console.log(`첨부 버튼 클릭: ${clickedWith ?? "실패"}`);
  await page.waitForTimeout(700);
  const opened = await outline(page, { maskText: false, extraSelectors: ['[role="menuitem"]', ".mce-menu-item", "[class*=layer] a", "[class*=attach]"] });
  printBlock("첨부 메뉴를 열었을 때 새로 보이는 요소", minus(opened, base));
  printBlock("파일 입력칸 (메뉴를 연 뒤)", await describeFiles());

  // `사진` 항목을 눌러 파일 선택 창이 어떻게 열리는지만 본다. (파일은 지정하지 않으므로 아무것도 올라가지 않는다)
  const photo = page.locator("#attach-image").first();
  if ((await photo.count()) > 0) {
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 4_000 }).catch(() => undefined);
    await photo.click({ timeout: 3_000 }).catch((e: Error) => console.log(`사진 클릭 오류: ${e.message.split("\n")[0]}`));
    const chooser = await chooserPromise;
    if (chooser) {
      const info = await chooser.element().evaluate((el) => {
        const i = el as HTMLInputElement;
        return `id=${i.id || "(없음)"} name=${i.name || "(없음)"} accept="${i.accept}" multiple=${i.multiple}`;
      }).catch(() => "(속성 읽기 실패)");
      console.log(`\n사진 클릭 → 파일 선택 창 열림: ${info}`);
    } else {
      console.log("\n사진 클릭 → 파일 선택 창이 열리지 않았습니다. (자체 업로드 창일 수 있음)");
    }
    await page.waitForTimeout(800);
    const afterPhoto = await outline(page, { maskText: false, extraSelectors: ["[class*=layer]", "[class*=popup]", "[class*=modal]", '[role="dialog"]'] });
    printBlock("사진 클릭 뒤 새로 보이는 요소", minus(afterPhoto, opened));
    printBlock("파일 입력칸 (사진 클릭 뒤)", await describeFiles());
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  console.log(`\n파일 선택 창 감지: ${chooserSeen}회. 파일은 고르지 않았고 아무것도 올리지 않았습니다.`);
}

export async function inspectAttach(context: BrowserContext, blog: string): Promise<boolean> {
  const session = await checkSession(context);
  if (!session.ok) {
    console.error(describeFailure(session));
    return false;
  }
  const page = await context.newPage();
  try {
    await page.goto(editorUrl(blog), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await inspectAttachPage(page);
    return true;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * [개발용] 이미지 한 장을 에디터에 실제로 올려 보고, 올린 뒤 편집기 안이 어떻게 바뀌는지 출력한다.
 * 글은 저장·발행하지 않는다. (이미지 파일은 블로그 저장소에 올라가며, 자동 저장으로 임시저장 글이 생길 수 있다)
 */
export async function inspectUpload(
  context: BrowserContext,
  blog: string,
  imagePath: string,
): Promise<boolean> {
  if (!existsSync(imagePath)) {
    console.error(`이미지 파일을 찾을 수 없습니다: ${imagePath}`);
    return false;
  }
  const session = await checkSession(context);
  if (!session.ok) {
    console.error(describeFailure(session));
    return false;
  }
  const page = await context.newPage();
  try {
    await page.goto(editorUrl(blog), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    page.on("dialog", (d) => void d.dismiss().catch(() => undefined));

    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET" && r.method() !== "HEAD") {
        const u = new URL(r.url());
        requests.push(`${r.method()} ${u.hostname}${u.pathname.replace(/\d+/g, "N")}`);
      }
    });

    const iframeHtml = (): Promise<string> =>
      page.frameLocator("#editor-tistory_ifr").locator("body").innerHTML({ timeout: 5_000 }).catch(() => "(읽기 실패)");
    const shorten = (html: string): string =>
      html.replace(/(src|data-[a-z-]+|href)="([^"]{60})[^"]*"/g, '$1="$2…"').slice(0, 1500);

    await page.locator("#mceu_0-open").first().click({ timeout: 5_000 });
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 8_000 });
    await page.locator("#attach-image").first().click({ timeout: 5_000 });
    const chooser = await chooserPromise;
    await chooser.setFiles(imagePath);
    console.log("이미지를 지정했습니다. 업로드 완료를 기다립니다…");
    await page.waitForTimeout(6_000);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);

    console.log("\n===== 업로드 뒤 기본모드 편집기 본문(HTML, 긴 값은 줄임) =====");
    console.log(shorten(await iframeHtml()));
    printBlock("전송된 쓰기 요청", requests);

    // HTML 모드로 바꿔 같은 내용이 어떻게 보이는지도 본다
    page.removeAllListeners("dialog");
    page.on("dialog", (d) => void d.accept().catch(() => undefined));
    await page.locator("#editor-mode-layer-btn-open").first().click({ timeout: 5_000 }).catch(() => undefined);
    await page.locator("#editor-mode-html").first().click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(1_200);
    const code = await page
      .evaluate(() => (document.querySelector(".CodeMirror") as unknown as { CodeMirror?: { getValue(): string } })?.CodeMirror?.getValue() ?? "(CodeMirror 없음)")
      .catch(() => "(읽기 실패)");
    console.log("\n===== HTML 모드 본문 =====");
    console.log(shorten(code));
    console.log("\n글은 저장하지 않았습니다. 임시저장 목록에 자동 저장 글이 생겼으면 지워 주세요.");
    return true;
  } catch (error) {
    console.error(`업로드 점검 중 오류: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return false;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * [개발용] 로그아웃 상태의 로그인 화면 구조를 본다. 아이디·비밀번호를 입력하지 않는다.
 * 티스토리 로그인 화면 → "카카오" 링크를 눌러 카카오 로그인 화면까지 이동해 입력칸의 구조만 출력한다.
 */
export async function inspectLogin(): Promise<void> {
  const { launchBrowser } = await import("../core/browser.js");
  const { URLS } = await import("../core/config.js");
  const browser = await launchBrowser({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(URLS.login, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2_000);
    const show = async (title: string): Promise<string[]> => {
      const u = new URL(page.url());
      console.log(`\n[${title}] 위치: ${u.hostname}${u.pathname}`);
      const lines = await outline(page, { maskText: false, extraSelectors: ["a[href]", "label"] });
      printBlock(title, lines);
      return lines;
    };
    await show("1) 티스토리 로그인 화면");
    const kakao = page.getByRole("link", { name: /카카오/ }).or(page.getByRole("button", { name: /카카오/ })).first();
    if ((await kakao.count()) === 0) {
      console.log("\n'카카오' 로그인 링크를 찾지 못했습니다.");
      return;
    }
    await kakao.click({ timeout: 5_000 }).catch((e: Error) => console.log(`클릭 오류: ${e.message.split("\n")[0]}`));
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(2_500);
    await show("2) 카카오 로그인 화면");
    console.log("\n아무것도 입력하지 않았습니다.");
  } finally {
    await browser.close().catch(() => undefined);
  }
}
