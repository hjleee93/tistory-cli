import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { checkSession, describeFailure, judgeUrl } from "../auth/session.js";
import { DIAG_DIR, editorUrl, ensureDir, writePrivateFile } from "../core/config.js";

/**
 * 에디터 화면에서 "있어야 하는" 요소 목록.
 * 클래스명 같은 CSS보다 역할·라벨·문구 기반 로케이터를 먼저 시도하고,
 * 마지막에만 id 기반 후보를 둔다. 대체 후보로 통과하면 경고로 알린다.
 *
 * 실제 에디터 화면(inspect-editor 결과)을 보고 확정했다. 화면이 바뀌면 doctor가 알려 준다.
 */
interface Candidate {
  desc: string;
  make: (page: Page) => Locator;
}
interface Check {
  id: string;
  label: string;
  candidates: Candidate[];
}

export const CHECKS: Check[] = [
  {
    id: "title",
    label: "제목 입력칸",
    candidates: [
      { desc: "placeholder /제목/", make: (p) => p.getByPlaceholder(/제목/) },
      {
        desc: "textbox name /제목/",
        make: (p) => p.getByRole("textbox", { name: /제목/ }),
      },
      { desc: "#post-title-inp", make: (p) => p.locator("#post-title-inp") },
    ],
  },
  {
    id: "editor-mode",
    label: "에디터 모드 전환 (기본모드/HTML)",
    candidates: [
      {
        desc: "button name /기본모드|HTML|마크다운/",
        make: (p) =>
          p.getByRole("button", { name: /기본모드|HTML|마크다운/ }).first(),
      },
      {
        desc: "#editor-mode-layer-btn-open",
        make: (p) => p.locator("#editor-mode-layer-btn-open"),
      },
    ],
  },
  {
    id: "category",
    label: "카테고리 선택",
    candidates: [
      {
        desc: "combobox name /카테고리/",
        make: (p) => p.getByRole("combobox", { name: /카테고리/ }),
      },
      {
        desc: "button name /카테고리/",
        make: (p) => p.getByRole("button", { name: /카테고리/ }).first(),
      },
      { desc: "#category-btn", make: (p) => p.locator("#category-btn") },
    ],
  },
  {
    id: "tags",
    label: "태그 입력칸",
    candidates: [
      { desc: "placeholder /태그/", make: (p) => p.getByPlaceholder(/태그/) },
      { desc: "#tagText", make: (p) => p.locator("#tagText") },
    ],
  },
  {
    id: "save-draft",
    label: "임시저장 버튼",
    candidates: [
      {
        desc: "button name /^임시저장$/",
        make: (p) => p.getByRole("button", { name: /^임시저장$/ }).first(),
      },
    ],
  },
  {
    id: "publish",
    label: "발행(완료) 버튼",
    candidates: [
      {
        desc: "button name /^완료$|발행/",
        make: (p) => p.getByRole("button", { name: /^완료$|발행/ }).first(),
      },
      {
        desc: "#publish-layer-btn",
        make: (p) => p.locator("#publish-layer-btn"),
      },
    ],
  },
];

export type CheckStatus = "ok" | "fallback" | "missing";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  matched?: string;
}

export type DoctorOutcome =
  | "healthy" // 0
  | "session_invalid" // 2
  | "editor_changed"; // 3

export interface DoctorReport {
  outcome: DoctorOutcome;
  results: CheckResult[];
  diagnosticsDir?: string;
  message?: string;
}

const PER_CANDIDATE_TIMEOUT_MS = 2_500;

export async function runCheck(page: Page, check: Check): Promise<CheckResult> {
  for (const [index, candidate] of check.candidates.entries()) {
    try {
      await candidate
        .make(page)
        .first()
        .waitFor({ state: "visible", timeout: PER_CANDIDATE_TIMEOUT_MS });
      return {
        id: check.id,
        label: check.label,
        status: index === 0 ? "ok" : "fallback",
        matched: candidate.desc,
      };
    } catch {
      // 다음 후보 시도
    }
  }
  return { id: check.id, label: check.label, status: "missing" };
}

/**
 * 글을 올리지 않는 읽기 전용 점검.
 * 에디터 화면만 열어 보고, 입력·저장·발행 어느 것도 하지 않는다.
 */
export async function runDoctor(
  context: BrowserContext,
  blog: string,
): Promise<DoctorReport> {
  const session = await checkSession(context);
  if (!session.ok) {
    return {
      outcome: "session_invalid",
      results: [],
      message: describeFailure(session),
    };
  }

  const page = await context.newPage();
  // 에디터가 띄우는 "이어서 작성하시겠습니까?" 같은 confirm은 취소로 닫는다.
  page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));

  try {
    await page.goto(editorUrl(blog), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => undefined);

    const landed = new URL(page.url());
    const judged = judgeUrl(landed);
    if (!judged.ok) {
      return {
        outcome: "session_invalid",
        results: [],
        message: describeFailure(judged),
      };
    }

    const results: CheckResult[] = [];
    for (const check of CHECKS) results.push(await runCheck(page, check));

    const wrongPage = !landed.pathname.includes("/manage/newpost");
    const healthy = !wrongPage && results.every((r) => r.status !== "missing");

    if (healthy) return { outcome: "healthy", results };

    const diagnosticsDir = await saveDiagnostics(page, results, landed);
    return {
      outcome: "editor_changed",
      results,
      diagnosticsDir,
      message: wrongPage
        ? `글쓰기 화면이 아닌 곳으로 이동했습니다 (${landed.hostname}${landed.pathname}). 블로그 이름이 맞는지 확인하세요.`
        : "에디터 화면 구성이 달라졌거나 로케이터가 더 이상 맞지 않습니다.",
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function saveDiagnostics(
  page: Page,
  results: CheckResult[],
  landed: URL,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(DIAG_DIR, stamp);
  await ensureDir(dir);

  // 스크린샷·HTML에는 닉네임, 블로그 주소, 비공개 글 제목이 담길 수 있다.
  // 그래서 프로젝트 밖(~/.tistory-cli)에만 저장하고 권한을 0600으로 제한한다.
  await writePrivateFile(
    path.join(dir, "page.png"),
    await page.screenshot({ fullPage: false }),
  );
  await writePrivateFile(path.join(dir, "page.html"), await page.content());
  await writePrivateFile(
    path.join(dir, "report.json"),
    JSON.stringify(
      { at: new Date().toISOString(), location: landed.pathname, results },
      null,
      2,
    ),
  );
  return dir;
}

const ICON: Record<CheckStatus, string> = {
  ok: "✔",
  fallback: "△",
  missing: "✘",
};

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const r of report.results) {
    const extra =
      r.status === "fallback"
        ? `  (대체 로케이터로 통과: ${r.matched})`
        : r.status === "missing"
          ? "  (찾지 못함)"
          : "";
    lines.push(`  ${ICON[r.status]} ${r.label}${extra}`);
  }
  return lines.join("\n");
}

/** 이슈에 붙여도 되는 요약. 블로그 이름·경로·계정 정보는 포함하지 않는다. */
export function formatShareableSummary(report: DoctorReport): string {
  const rows = report.results.map(
    (r) => `${r.id}: ${r.status}${r.matched ? ` via "${r.matched}"` : ""}`,
  );
  return [`outcome: ${report.outcome}`, ...rows].join("\n");
}
