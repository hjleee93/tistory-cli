import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { editorUrl } from "../core/config.js";

/** *.tistory.com 의 https 주소만 연다. (임의의 주소를 여는 데 쓰이지 않도록) */
export function isTistoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "tistory.com" || url.hostname.endsWith(".tistory.com"))
    );
  } catch {
    return false;
  }
}

export interface OpenTarget {
  url: string;
  /** true면 저장된 글의 주소, false면 글쓰기 화면으로 대신 연다 */
  exact: boolean;
}

/** 쿼리·해시는 버린다. (returnURL 등 불필요한 값이 따라 열리지 않게) */
function stripQuery(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

/**
 * 임시저장 직후의 주소에 글 번호(/manage/post/123 등)가 있으면 그 글을,
 * 없으면 글쓰기 화면을 연다. (임시저장은 공개 주소가 없다)
 */
export function pickDraftTarget(blog: string, savedUrl?: string): OpenTarget {
  const fallback = { url: editorUrl(blog), exact: false };
  if (!savedUrl || !isTistoryUrl(savedUrl)) return fallback;
  const clean = stripQuery(savedUrl);
  const withId = /^https:\/\/[a-z0-9-]+\.tistory\.com\/manage\/(?:post|newpost)\/\d+/;
  return withId.test(clean) ? { url: clean, exact: true } : fallback;
}

/** 평소 쓰는 브라우저로 주소를 연다. 열기에 성공했는지 돌려준다. */
export function openInBrowser(url: string): Promise<boolean> {
  if (!isTistoryUrl(url)) return Promise.resolve(false);

  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

/** y/n 질문. 터미널이 아니면(파이프 등) 묻지 않고 false. */
export async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} (Y/N) `)).trim().toLowerCase();
    return answer === "y" || answer === "yes" || answer === "ㅛ";
  } finally {
    rl.close();
  }
}
