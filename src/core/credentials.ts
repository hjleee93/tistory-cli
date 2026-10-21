import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./config.js";

export interface Credentials {
  id: string;
  password: string;
  /** 값을 읽어 온 파일 (환경변수면 undefined) */
  source?: string;
}

/** `.env` 한 줄씩 읽는 아주 단순한 파서: KEY=VALUE, #주석, 따옴표 제거. 외부 패키지 없음. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 찾는 순서: 환경변수 → 현재 폴더의 .env → ~/.tistory-cli/.env */
export async function loadCredentials(cwd = process.cwd()): Promise<Credentials | undefined> {
  const fromEnv = (env: Record<string, string | undefined>): { id?: string; password?: string } => ({
    id: env.TISTORY_ID,
    password: env.TISTORY_PASSWORD,
  });

  let found = fromEnv(process.env);
  if (found.id && found.password) return { id: found.id, password: found.password };

  for (const file of [path.join(cwd, ".env"), path.join(DATA_DIR, ".env")]) {
    try {
      const parsed = parseEnv(await readFile(file, "utf8"));
      found = fromEnv(parsed);
      if (found.id && found.password) return { id: found.id, password: found.password, source: file };
    } catch {
      // 파일 없음
    }
  }
  return undefined;
}

/** .env 가 다른 사용자도 읽을 수 있으면 경고 문구를 돌려준다. (Windows 는 권한 비트가 달라 건너뜀) */
export async function permissionWarning(file: string): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const info = await stat(file).catch(() => undefined);
  if (!info) return undefined;
  if ((info.mode & 0o077) !== 0) {
    return `${file} 을(를) 다른 사용자도 읽을 수 있습니다. \`chmod 600 ${file}\` 로 제한하세요.`;
  }
  return undefined;
}
