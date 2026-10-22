import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, ensureDir } from "./config.js";

const PACKAGE = "tistory-cli";
const CACHE_FILE = path.join(DATA_DIR, "update-check.json");
const DAY_MS = 24 * 60 * 60 * 1000;

interface Cache {
  checkedAt: number;
  latest: string;
}

/** "1.2.3" 형태만 비교한다. (프리릴리스 표기는 무시) 앞이 더 크면 1, 같으면 0, 작으면 -1 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    (v.split(/[-+]/)[0] ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** 확인을 건너뛰어야 하는 환경인가 (CI, 터미널이 아님, 사용자가 끔) */
export function updateCheckDisabled(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  return Boolean(env.TISTORY_NO_UPDATE_CHECK || env.CI || env.NO_UPDATE_NOTIFIER) || !isTTY;
}

export function updateNotice(current: string, latest: string): string {
  return (
    `\n새 버전이 있습니다: ${current} → ${latest}\n` +
    `  npm update -g ${PACKAGE}   (pnpm: pnpm add -g ${PACKAGE}@latest, yarn: yarn global upgrade ${PACKAGE})\n` +
    `  이 안내를 끄려면 환경변수 TISTORY_NO_UPDATE_CHECK=1`
  );
}

async function readCache(): Promise<Cache | undefined> {
  try {
    const data = JSON.parse(await readFile(CACHE_FILE, "utf8")) as Partial<Cache>;
    if (typeof data.checkedAt === "number" && typeof data.latest === "string") {
      return { checkedAt: data.checkedAt, latest: data.latest };
    }
  } catch {
    // 캐시 없음
  }
  return undefined;
}

/**
 * npm 에 올라간 최신 버전을 알아낸다. 하루에 한 번만 npm 저장소에 요청하고(기본 1.5초 제한),
 * 실패하면 조용히 undefined. 보내는 정보는 패키지 이름뿐이다.
 */
export async function fetchLatestVersion(now = Date.now()): Promise<string | undefined> {
  const cache = await readCache();
  if (cache && now - cache.checkedAt < DAY_MS) return cache.latest;
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, {
      signal: AbortSignal.timeout(1_500),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return cache?.latest;
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string") return cache?.latest;
    await ensureDir(DATA_DIR);
    await writeFile(CACHE_FILE, JSON.stringify({ checkedAt: now, latest: body.version }), { mode: 0o600 });
    return body.version;
  } catch {
    return cache?.latest;
  }
}

/** 명령이 끝난 뒤 호출: 새 버전이 있으면 안내 문구를, 없거나 확인할 수 없으면 undefined */
export async function checkForUpdate(current: string, pending: Promise<string | undefined>): Promise<string | undefined> {
  const latest = await Promise.race([
    pending,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1_200)),
  ]);
  if (latest && compareVersions(latest, current) > 0) return updateNotice(current, latest);
  return undefined;
}
