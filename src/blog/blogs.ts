import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { BrowserContext } from "playwright";
import {
  hasAccountPanel,
  openHome,
  readPanel,
  type RawAnchor,
} from "../auth/account.js";
import {
  DIAG_DIR,
  ensureDir,
  loadConfig,
  normalizeBlogName,
  saveConfig,
  writePrivateFile,
} from "../core/config.js";

export interface BlogInfo {
  name: string;
  title?: string;
}

// 블로그가 아닌 티스토리 서브도메인
const RESERVED = new Set([
  "www",
  "tistory",
  "blog",
  "notice",
  "accounts",
  "oauth",
]);

/**
 * 페이지의 링크들에서 `<이름>.tistory.com` 형태의 블로그를 뽑아낸다.
 * (순수 함수 → 브라우저 없이 테스트 가능)
 * 제목은 블로그 루트("/") 링크의 텍스트일 때만 신뢰한다.
 * 메뉴 링크("글 관리" 등)의 텍스트가 제목으로 오인되는 것을 막기 위해서다.
 */
export function extractBlogs(
  anchors: RawAnchor[],
  currentUrl?: string,
): BlogInfo[] {
  const found = new Map<string, BlogInfo>();

  const add = (href: string, text?: string): void => {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return;
    }
    const match = /^([a-z0-9][a-z0-9-]*)\.tistory\.com$/.exec(url.hostname);
    const name = match?.[1];
    if (!name || RESERVED.has(name)) return;

    const cleaned = text?.replace(/\s+/g, " ").trim();
    const isRoot = url.pathname === "/" || url.pathname === "";
    const title =
      isRoot && cleaned && cleaned.length <= 60 ? cleaned : undefined;

    const prev = found.get(name);
    if (!prev) found.set(name, { name, title });
    else if (!prev.title && title) prev.title = title;
  };

  if (currentUrl) add(currentUrl);
  for (const anchor of anchors) add(anchor.href, anchor.text);
  return [...found.values()];
}

export interface BlogListResult {
  blogs: BlogInfo[];
  /** 최종 도착 위치 (호스트+경로만, 쿼리 제외) */
  location: string;
  /** 홈에서 "내 블로그 카드"를 찾았는지 (못 찾으면 비로그인 가능성) */
  panelFound: boolean;
  anchorCount: number;
  /** 카드 안 링크의 호스트 종류와 개수 */
  hosts: Record<string, number>;
  diagnosticsDir?: string;
}

/**
 * 로그인된 세션으로 티스토리 홈의 "내 블로그 카드"를 읽어 내 블로그 목록을 만든다.
 * 홈 전체 링크를 긁지 않는다: 홈에는 남의 블로그 링크가 잔뜩 있기 때문이다.
 * (읽기 전용)
 */
export async function listBlogs(
  context: BrowserContext,
  options: { debug?: boolean } = {},
): Promise<BlogListResult> {
  const page = await context.newPage();
  try {
    await openHome(page);

    const panelFound = await hasAccountPanel(page);
    const panel = panelFound
      ? await readPanel(page)
      : { anchors: [] as RawAnchor[], title: undefined };

    const hosts: Record<string, number> = {};
    for (const a of panel.anchors) {
      try {
        const host = new URL(a.href).hostname || "(none)";
        hosts[host] = (hosts[host] ?? 0) + 1;
      } catch {
        hosts["(invalid)"] = (hosts["(invalid)"] ?? 0) + 1;
      }
    }

    const blogs = extractBlogs(panel.anchors);
    // 카드 맨 위 이름은 처음 확인된(=현재) 블로그의 제목으로 쓴다.
    const first = blogs[0];
    if (first && !first.title && panel.title) first.title = panel.title;

    const current = new URL(page.url());
    const result: BlogListResult = {
      blogs,
      location: `${current.hostname}${current.pathname}`,
      panelFound,
      anchorCount: panel.anchors.length,
      hosts,
    };

    if (options.debug) {
      // 스크린샷·HTML에는 계정 정보가 담길 수 있어 프로젝트 밖에 0600으로만 저장한다.
      const dir = path.join(
        DIAG_DIR,
        `blogs-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      );
      await ensureDir(dir);
      await writePrivateFile(
        path.join(dir, "page.png"),
        await page.screenshot({ fullPage: true }),
      );
      await writePrivateFile(path.join(dir, "page.html"), await page.content());
      result.diagnosticsDir = dir;
    }
    return result;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** 목록을 보여 주고 번호로 고르게 한 뒤 설정에 저장한다. */
export async function chooseBlog(
  context: BrowserContext,
): Promise<string | undefined> {
  console.log("내 블로그 목록을 불러오는 중...");

  let blogs: BlogInfo[] = [];
  try {
    blogs = (await listBlogs(context)).blogs;
  } catch (error) {
    console.log(
      `목록을 불러오지 못했습니다: ${error instanceof Error ? error.message : error}`,
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let name: string;

    if (blogs.length === 0) {
      console.log("블로그 목록을 찾지 못했습니다.");
      name = normalizeBlogName(
        await rl.question("블로그 이름을 직접 입력하세요 (예: myblog) > "),
      );
    } else if (blogs.length === 1 && blogs[0]) {
      name = blogs[0].name;
      console.log(`블로그가 하나뿐이라 자동 선택합니다: ${name}.tistory.com`);
    } else {
      const current = (await loadConfig()).blog;
      console.log("\n내 블로그:");
      blogs.forEach((blog, index) => {
        const mark = blog.name === current ? " ← 현재 설정" : "";
        const title = blog.title ? `  (${blog.title})` : "";
        console.log(`  ${index + 1}. ${blog.name}.tistory.com${title}${mark}`);
      });

      const answer = (
        await rl.question("\n번호를 선택하세요 (이름 직접 입력도 가능) > ")
      ).trim();

      if (/^\d+$/.test(answer)) {
        const picked = blogs[Number(answer) - 1];
        if (!picked) throw new Error("목록에 없는 번호입니다.");
        name = picked.name;
      } else {
        name = normalizeBlogName(answer);
      }
    }

    await saveConfig({ ...(await loadConfig()), blog: name });
    console.log(`\n블로그를 ${name}.tistory.com 으로 설정했습니다.`);
    return name;
  } finally {
    rl.close();
  }
}
