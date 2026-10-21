import { access, chmod, unlink } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import type { Browser, BrowserContext } from "playwright";
import { launchBrowser } from "../core/browser.js";
import { hasAccountPanel, openHome } from "./account.js";
import { autoLogin } from "./autologin.js";
import { DATA_DIR, STATE_FILE, URLS, ensureDir } from "../core/config.js";
import { loadCredentials } from "../core/credentials.js";

export type SessionReason =
  | "ok"
  | "redirected_to_login"
  | "not_logged_in"
  | "unexpected_page"
  | "error";

export interface SessionCheck {
  ok: boolean;
  reason: SessionReason;
  /** 개인정보 노출을 피하려고 호스트와 경로만 담는다 (쿼리스트링 제외). */
  location: string;
  detail?: string;
}

export class NoSessionError extends Error {
  constructor(message = "로그인 세션이 없습니다. `tistory login`을 먼저 실행하세요.") {
    super(message);
  }
}

/** 최종 도착 URL만 보고 로그인 여부를 판정한다. (순수 함수 → 단위 테스트 가능) */
export function judgeUrl(url: URL): SessionCheck {
  const location = `${url.hostname}${url.pathname}`;
  const host = url.hostname;

  if (host.endsWith("kakao.com") || url.pathname.startsWith("/auth")) {
    return { ok: false, reason: "redirected_to_login", location };
  }
  if (host === "tistory.com" || host.endsWith(".tistory.com")) {
    return { ok: true, reason: "ok", location };
  }
  return { ok: false, reason: "unexpected_page", location };
}

/**
 * 세션 파일이 있다는 것과 로그인이 유효하다는 것은 다르다.
 * 티스토리 홈을 열어 로그인했을 때만 나타나는 "내 블로그 카드"가
 * 실제로 보이는지로 판정한다. (읽기 전용: 아무것도 저장하거나 클릭하지 않는다.)
 */
export async function checkSession(
  context: BrowserContext,
): Promise<SessionCheck> {
  try {
    const page = await context.newPage();
    try {
      await openHome(page);
      const url = new URL(page.url());
      const location = `${url.hostname}${url.pathname}`;

      if (await hasAccountPanel(page)) {
        return { ok: true, reason: "ok", location };
      }
      const judged = judgeUrl(url);
      if (!judged.ok) return judged; // 로그인/카카오 페이지로 튕김
      return { ok: false, reason: "not_logged_in", location };
    } finally {
      await page.close().catch(() => undefined);
    }
  } catch (error) {
    return {
      ok: false,
      reason: "error",
      location: "",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function hasSessionFile(): Promise<boolean> {
  try {
    await access(STATE_FILE);
    return true;
  } catch {
    return false;
  }
}

/** 저장된 세션으로 브라우저 컨텍스트를 열고 fn을 실행한 뒤 반드시 닫는다. */
export async function withSession<T>(
  options: { headless: boolean },
  fn: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  // .env(또는 환경변수)에 계정이 있으면 세션이 없거나 만료됐을 때 자동으로 로그인한다.
  const credentials = await loadCredentials();
  let hasFile = await hasSessionFile();
  if (!hasFile) {
    if (!credentials) throw new NoSessionError();
    console.log("저장된 세션이 없어 .env 계정으로 자동 로그인합니다…");
    const result = await autoLogin(credentials);
    if (!result.ok) throw new NoSessionError(result.message);
    hasFile = true;
  }

  const browser: Browser = await launchBrowser({ headless: options.headless });
  try {
    let context = await browser.newContext({ storageState: STATE_FILE });
    if (credentials) {
      const check = await checkSession(context);
      if (!check.ok && (check.reason === "not_logged_in" || check.reason === "redirected_to_login")) {
        console.log("세션이 만료되어 .env 계정으로 자동 로그인합니다…");
        await context.close().catch(() => undefined);
        const result = await autoLogin(credentials);
        if (!result.ok) throw new NoSessionError(result.message);
        context = await browser.newContext({ storageState: STATE_FILE });
      }
    }
    return await fn(context);
  } finally {
    await browser.close();
  }
}

export function describeFailure(check: SessionCheck): string {
  switch (check.reason) {
    case "redirected_to_login":
      return "로그인 페이지로 이동했습니다. 세션이 만료되었거나 로그인이 완료되지 않았습니다.";
    case "not_logged_in":
      return "로그인된 상태가 아닙니다 (홈에서 내 블로그 카드가 보이지 않음).";
    case "unexpected_page":
      return `예상하지 못한 페이지입니다 (${check.location}).`;
    case "error":
      return `확인 중 오류가 발생했습니다: ${check.detail ?? "알 수 없음"}`;
    default:
      return "";
  }
}

const MAX_LOGIN_ATTEMPTS = 3;

/**
 * 브라우저를 띄워 사람이 직접 로그인하게 한다.
 * 비밀번호는 다루지 않고, 로그인이 실제로 확인될 때만 세션을 저장한다.
 */
export async function interactiveLogin(): Promise<boolean> {
  await ensureDir(DATA_DIR);

  const browser = await launchBrowser({ headless: false });
  const context = await browser.newContext();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const page = await context.newPage();
    await page.goto(URLS.login);

    console.log("열린 브라우저에서 티스토리에 로그인해 주세요.");
    console.log("카카오 추가 인증이 나오면 그것까지 직접 마무리하세요.\n");

    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
      await rl.question("로그인을 마쳤으면 Enter를 누르세요 > ");

      const check = await checkSession(context);
      if (check.ok) {
        await context.storageState({ path: STATE_FILE });
        await chmod(STATE_FILE, 0o600);
        console.log("\n로그인을 확인하고 세션을 저장했습니다.");
        console.log(`저장 경로: ${STATE_FILE}`);
        return true;
      }

      console.log(`\n로그인이 확인되지 않았습니다. ${describeFailure(check)}`);
      if (attempt < MAX_LOGIN_ATTEMPTS) {
        console.log(
          `(${attempt}/${MAX_LOGIN_ATTEMPTS}) 로그인을 마무리한 뒤 다시 Enter를 누르세요.\n`,
        );
      }
    }
    return false;
  } finally {
    rl.close();
    await browser.close().catch(() => undefined);
  }
}

export async function deleteSession(): Promise<boolean> {
  try {
    await unlink(STATE_FILE);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
