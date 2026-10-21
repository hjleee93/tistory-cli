import { chmod } from "node:fs/promises";
import type { BrowserContext, Page } from "playwright";
import { launchBrowser } from "../core/browser.js";
import { checkSession } from "./session.js";
import { STATE_FILE, URLS, ensureDir, DATA_DIR } from "../core/config.js";
import type { Credentials } from "../core/credentials.js";

export type AutoLoginReason =
  | "ok"
  | "form_not_found"
  | "wrong_credentials"
  | "extra_verification"
  | "timeout"
  | "error";

export interface AutoLoginResult {
  ok: boolean;
  reason: AutoLoginReason;
  message: string;
}

const VERIFY_WORDS = /보안문자|자동입력 방지|캡차|captcha|인증번호|2단계|이중 인증|새로운 기기|새로운 환경|본인 확인|본인확인|추가 인증|비정상|잠시 후 다시/i;
const WRONG_WORDS = /비밀번호가 (?:올바르지|맞지)|가입되지 않은|계정 또는 비밀번호|아이디 또는 비밀번호/;

export function classifyPageText(text: string): "wrong_credentials" | "extra_verification" | undefined {
  if (WRONG_WORDS.test(text)) return "wrong_credentials";
  if (VERIFY_WORDS.test(text)) return "extra_verification";
  return undefined;
}

async function firstVisible(page: Page, selectors: string[], timeout: number): Promise<ReturnType<Page["locator"]> | undefined> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const loc = page.locator(selector).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await page.waitForTimeout(300);
  }
  return undefined;
}

const MESSAGES: Record<AutoLoginReason, string> = {
  ok: "자동 로그인에 성공했습니다.",
  form_not_found: "로그인 입력칸을 찾지 못했습니다. 화면이 바뀌었을 수 있습니다. `tistory login` 으로 직접 로그인해 주세요.",
  wrong_credentials: "아이디 또는 비밀번호가 맞지 않다고 나옵니다. .env 의 값을 확인하세요. (반복 시 계정이 잠길 수 있어 재시도하지 않았습니다)",
  extra_verification: "카카오가 추가 인증(보안문자·인증번호 등)을 요구합니다. 자동으로 넘을 수 없습니다. `tistory login` 으로 직접 로그인해 주세요.",
  timeout: "로그인 결과를 확인하지 못했습니다. `tistory login` 으로 직접 로그인해 주세요.",
  error: "자동 로그인 중 오류가 발생했습니다. `tistory login` 으로 직접 로그인해 주세요.",
};

/**
 * 카카오계정 아이디·비밀번호로 창 없이 로그인하고 세션을 저장한다.
 * - 한 번만 시도한다. (실패를 반복하면 계정이 잠길 수 있음)
 * - 보안문자·추가 인증이 나오면 우회하지 않고 멈춘다.
 * - 아이디·비밀번호는 입력칸에만 넣고 어디에도 출력·저장하지 않는다.
 */
export async function autoLogin(
  credentials: Credentials,
  options: { headless?: boolean; /** 테스트용: 새 컨텍스트에 요청 가로채기 등을 설정 */ setup?: (context: BrowserContext) => Promise<void> } = {},
): Promise<AutoLoginResult> {
  const fail = (reason: AutoLoginReason): AutoLoginResult => ({ ok: false, reason, message: MESSAGES[reason] });
  await ensureDir(DATA_DIR);
  const browser = await launchBrowser({ headless: options.headless ?? true });
  try {
    const context = await browser.newContext();
    await options.setup?.(context);
    const page = await context.newPage();
    await page.goto(URLS.login, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // 티스토리 로그인 화면의 "카카오계정으로 로그인"을 누른다 (이미 카카오 화면이면 건너뜀)
    const idSelectors = ['input[name="loginId"]', 'input[type="email"]', 'input[name="email"]'];
    const quick = await firstVisible(page, idSelectors, 1_500);
    if (!quick) {
      const kakao = page.getByRole("link", { name: /카카오/ }).or(page.getByRole("button", { name: /카카오/ })).first();
      await kakao.click({ timeout: 5_000 }).catch(() => undefined);
    }

    const idInput = await firstVisible(page, [...idSelectors, 'input[type="text"]'], 12_000);
    const pwInput = await firstVisible(page, ['input[name="password"]', 'input[type="password"]'], 3_000);
    if (!idInput || !pwInput) return fail("form_not_found");

    await idInput.fill(credentials.id);
    await pwInput.fill(credentials.password);
    await pwInput.press("Enter");

    // 결과 판정 (최대 25초)
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1_000);
      const host = new URL(page.url()).hostname;
      const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      const verdict = classifyPageText(text);
      if (verdict) return fail(verdict);
      if (!/kakao\.com$/.test(host) && !host.endsWith("accounts.kakao.com")) break;
    }
    const check = await checkSession(context);
    if (!check.ok) {
      const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      return fail(classifyPageText(text) ?? "timeout");
    }
    await context.storageState({ path: STATE_FILE });
    await chmod(STATE_FILE, 0o600);
    return { ok: true, reason: "ok", message: MESSAGES.ok };
  } catch {
    return fail("error");
  } finally {
    await browser.close().catch(() => undefined);
  }
}
