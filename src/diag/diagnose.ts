import { writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserContext } from "playwright";
import { formatReport, runDoctor } from "./doctor.js";
import { inspectAttach, inspectDelete, inspectEditor, inspectPost, inspectPosts } from "./inspect.js";

/**
 * 읽기 전용 점검을 한꺼번에 실행하고, 출력 전체를 파일 하나에 모은다.
 * - 글 저장·발행·삭제는 하지 않는다. (임시저장 글도 만들지 않는다)
 * - 제목·본문·글 주소의 제목 부분은 가려져 있다.
 * 화면이 바뀌어도 사용자는 이 명령 하나만 실행하면 된다.
 */
export async function diagnose(
  context: BrowserContext,
  blog: string,
  outFile: string,
): Promise<boolean> {
  const buffer: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const tee =
    (orig: (...a: unknown[]) => void) =>
    (...args: unknown[]): void => {
      buffer.push(args.map(String).join(" "));
      orig(...args);
    };
  console.log = tee(origLog);
  console.error = tee(origErr);

  let allOk = true;
  const section = async (title: string, fn: () => Promise<boolean | void>) => {
    console.log(`\n\n######## ${title} ########`);
    try {
      const r = await fn();
      if (r === false) allOk = false;
    } catch (error) {
      allOk = false;
      console.log(`(이 구역에서 오류: ${error instanceof Error ? error.message : String(error)})`);
    }
  };

  try {
    console.log(`tistory-cli 진단 보고서 — ${new Date().toISOString()} — 블로그: ${blog}`);
    await section("doctor", async () => {
      const report = await runDoctor(context, blog);
      console.log(formatReport(report));
      return report.outcome === "healthy";
    });
    await section("에디터 구조", () => inspectEditor(context, blog));
    await section("첨부(이미지) 메뉴 구조 (파일은 올리지 않음)", () => inspectAttach(context, blog));
    await section("글 관리(목록) 구조", () =>
      inspectPosts(context, blog, { probeSelection: true }),
    );
    await section("삭제 확인 화면 (쓰기 요청 차단, 취소함)", () => inspectDelete(context, blog));
    await section("최근 글 페이지(⋮ 메뉴) 구조", () => inspectPost(context, blog));
  } finally {
    console.log = origLog;
    console.error = origErr;
  }

  const target = resolve(outFile);
  await writeFile(target, buffer.join("\n") + "\n", { mode: 0o600 });
  await chmod(target, 0o600);
  console.log(`\n보고서를 저장했습니다: ${target}`);
  console.log("Claude에게 이 파일을 읽어 달라고 하시면 됩니다. (글 제목·본문은 가려져 있습니다)");
  return allOk;
}

/** 함수가 console 로 출력한 내용을 파일에도 저장한다. (0600) */
export async function teeToFile<T>(outFile: string, fn: () => Promise<T>): Promise<T> {
  const buffer: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    buffer.push(args.map(String).join(" "));
    origLog(...args);
  };
  console.error = (...args: unknown[]) => {
    buffer.push(args.map(String).join(" "));
    origErr(...args);
  };
  try {
    return await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
    const target = resolve(outFile);
    await writeFile(target, buffer.join("\n") + "\n", { mode: 0o600 });
    await chmod(target, 0o600);
    console.log(`\n출력을 저장했습니다: ${target}`);
  }
}
