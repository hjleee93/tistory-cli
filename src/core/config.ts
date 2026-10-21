import os from "node:os";
import path from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";

// 세션·설정·진단 파일은 모두 프로젝트 밖(홈 디렉터리)에 둔다.
// 그래서 저장소를 공개해도 계정 정보가 섞여 들어갈 일이 없다.
export const DATA_DIR =
  process.env.TISTORY_CLI_HOME ?? path.join(os.homedir(), ".tistory-cli");
export const STATE_FILE = path.join(DATA_DIR, "auth.json");
export const CONFIG_FILE = path.join(DATA_DIR, "config.json");
export const DIAG_DIR = path.join(DATA_DIR, "diagnostics");

export const URLS = {
  home: "https://www.tistory.com/",
  login: "https://www.tistory.com/auth/login",
} as const;

export function editorUrl(blog: string): string {
  return `https://${blog}.tistory.com/manage/newpost/`;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function writePrivateFile(
  file: string,
  data: string | Buffer,
): Promise<void> {
  await ensureDir(path.dirname(file));
  await writeFile(file, data, { mode: 0o600 });
  await chmod(file, 0o600);
}

export interface Config {
  blog?: string;
}

export async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, "utf8")) as Config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await writePrivateFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/** "myblog", "myblog.tistory.com", "https://myblog.tistory.com/" 모두 "myblog"로 정리 */
export function normalizeBlogName(input: string): string {
  let name = input.trim().toLowerCase();
  name = name.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  name = name.replace(/\.tistory\.com$/, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `블로그 이름 형식이 올바르지 않습니다: "${input}" (예: myblog)`,
    );
  }
  return name;
}

export async function resolveBlog(cliOption?: string): Promise<string> {
  const raw = cliOption ?? (await loadConfig()).blog;
  if (!raw) {
    throw new Error(
      "블로그가 설정되지 않았습니다. `tistory config select-blog`(목록에서 선택) 또는 `tistory config set-blog <이름>`을 먼저 실행하세요.",
    );
  }
  return normalizeBlogName(raw);
}
