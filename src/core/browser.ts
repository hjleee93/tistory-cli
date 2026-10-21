import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium, type Browser } from "playwright";

export class BrowserMissingError extends Error {
  constructor() {
    super("Chromium 브라우저가 설치되어 있지 않습니다. `tistory setup` 을 한 번 실행하세요.");
    this.name = "BrowserMissingError";
  }
}

export function isMissingBrowser(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Executable doesn't exist|playwright install/i.test(message);
}

/** 모든 브라우저 실행은 여기를 거친다. 브라우저가 없으면 안내 문구가 있는 오류로 바꿔 준다. */
export async function launchBrowser(options: { headless: boolean }): Promise<Browser> {
  try {
    return await chromium.launch({ headless: options.headless });
  } catch (error) {
    if (isMissingBrowser(error)) throw new BrowserMissingError();
    throw error;
  }
}

/** Playwright 가 쓰는 Chromium 을 내려받는다. 종료 코드를 돌려준다. */
export function installBrowser(): Promise<number> {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("playwright/package.json");
  const cli = path.join(path.dirname(pkg), "cli.js");
  if (!existsSync(cli)) return Promise.resolve(1);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
