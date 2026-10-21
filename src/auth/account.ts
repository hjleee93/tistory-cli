import type { Locator, Page } from "playwright";
import { URLS } from "../core/config.js";

/**
 * 로그인하면 티스토리 홈(www.tistory.com) 오른쪽에
 * "내 블로그 카드"(블로그 제목 · 글쓰기 / 내 블로그 / 관리 버튼)가 나타난다.
 * 비로그인 상태에는 이 카드가 없으므로, 로그인 여부와 내 블로그 목록을
 * 둘 다 이 카드에서 읽는다.
 */

export interface RawAnchor {
  href: string;
  text: string;
}

export interface PanelInfo {
  /** 카드 안의 링크들 (홈 전체가 아니라 내 카드 영역만) */
  anchors: RawAnchor[];
  /** 카드 맨 위에 보이는 이름 (블로그 제목) */
  title?: string;
}

const PANEL_BUTTONS = ["글쓰기", "내 블로그", "관리"] as const;

const textNode = (page: Page, text: string): Locator =>
  page.getByText(text, { exact: true }).first();

export async function openHome(page: Page): Promise<void> {
  await page.goto(URLS.home, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await page
    .waitForLoadState("networkidle", { timeout: 8_000 })
    .catch(() => undefined);
  // 카드는 늦게 그려질 수 있어 잠시 기다린다. 없으면 비로그인으로 본다.
  await textNode(page, "내 블로그")
    .waitFor({ state: "attached", timeout: 6_000 })
    .catch(() => undefined);
}

export async function hasAccountPanel(page: Page): Promise<boolean> {
  return (await textNode(page, "내 블로그").count()) > 0;
}

export async function readPanel(page: Page): Promise<PanelInfo> {
  const anchors: RawAnchor[] = [];

  // 1) 세 버튼의 링크 주소 (각 주소의 호스트가 곧 내 블로그)
  for (const label of PANEL_BUTTONS) {
    const link = textNode(page, label)
      .locator("xpath=ancestor-or-self::a")
      .first();
    const href = await link
      .getAttribute("href", { timeout: 1_500 })
      .catch(() => null);
    if (href) anchors.push({ href: new URL(href, page.url()).href, text: "" });
  }

  // 2) 카드 영역: '내 블로그' 버튼과 '구독자'를 함께 담은 가장 안쪽 div
  const region = page
    .locator("div")
    .filter({ has: textNode(page, "내 블로그") })
    .filter({ hasText: "구독자" })
    .last();

  let title: string | undefined;
  try {
    const text = await region.innerText({ timeout: 1_500 });
    title = text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && line.length <= 60);
  } catch {
    // 제목은 없어도 된다
  }

  // 3) 블로그가 여러 개면 이름 옆 화살표(텍스트 없는 버튼)로 목록이 펼쳐진다.
  //    글씨가 있는 버튼(글쓰기 등)은 절대 누르지 않는다.
  try {
    const toggle = region.locator("button").first();
    if ((await toggle.count()) > 0) {
      const label = (await toggle.innerText({ timeout: 1_000 })).trim();
      if (label === "") {
        await toggle.click({ timeout: 1_500 });
        await page.waitForTimeout(500);
      }
    }
    const extra = await region.locator("a[href]").evaluateAll((els) =>
      els.map((el) => ({ href: (el as HTMLAnchorElement).href, text: "" })),
    );
    anchors.push(...extra);
  } catch {
    // 목록이 안 펼쳐져도 위의 기본 블로그는 이미 확보했다
  }

  return { anchors, title };
}
