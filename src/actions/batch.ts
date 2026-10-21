import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { BrowserContext } from "playwright";
import { addEntry, findEntry } from "../core/history.js";
import { PostError, loadPost, type Post } from "../post/post.js";
import { PublishError, publishPost, saveDraft } from "./publisher.js";

/** 파일/폴더 인자를 .md 파일 목록으로 펼친다. 폴더는 바로 아래 .md 만(이름순), 중복 제거. */
export async function expandInputs(inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    const info = await stat(input).catch(() => undefined);
    if (!info) throw new Error(`찾을 수 없습니다: ${input}`);
    if (info.isDirectory()) {
      const names = (await readdir(input))
        .filter((n) => !n.startsWith(".") && [".md", ".markdown"].includes(extname(n).toLowerCase()))
        .sort((a, b) => a.localeCompare(b));
      for (const name of names) files.push(join(input, name));
    } else {
      files.push(input);
    }
  }
  return [...new Set(files)];
}

export interface BatchItem {
  file: string;
  post?: Post;
  problems: string[];
  skipReason?: string;
}

/** 원고를 모두 읽어 계획을 만든다. 아무것도 올리지 않는다. */
export async function planBatch(
  files: string[],
  blog: string,
  opts: { publish: boolean; force: boolean },
): Promise<BatchItem[]> {
  const items: BatchItem[] = [];
  for (const file of files) {
    try {
      const post = await loadPost(file);
      const item: BatchItem = { file, post, problems: [] };
      if (opts.publish && post.visibility === "protected") {
        item.skipReason = "보호(비밀번호) 글은 지원하지 않음";
      } else {
        const previous = await findEntry(post.sha256, blog);
        const duplicate = opts.publish ? previous?.mode === "published" : Boolean(previous);
        if (duplicate && !opts.force) item.skipReason = `이미 올린 원고 (${previous?.at})`;
      }
      items.push(item);
    } catch (error) {
      if (error instanceof PostError) items.push({ file, problems: error.problems });
      else throw error;
    }
  }
  return items;
}

export interface BatchResult {
  done: number;
  failed: number;
  skipped: number;
}

/** 계획을 순서대로 실행한다. 한 건이 실패해도 다음 건을 계속한다. */
export async function runBatch(
  context: BrowserContext,
  blog: string,
  items: BatchItem[],
  opts: { publish: boolean },
  log: (message: string) => void,
): Promise<BatchResult> {
  const result: BatchResult = { done: 0, failed: 0, skipped: 0 };
  const total = items.length;
  let n = 0;
  for (const item of items) {
    n++;
    const tag = `[${n}/${total}] ${item.file}`;
    if (!item.post || item.problems.length > 0) {
      log(`${tag} → 건너뜀: ${item.problems.join("; ")}`);
      result.failed++;
      continue;
    }
    if (item.skipReason) {
      log(`${tag} → 건너뜀: ${item.skipReason}`);
      result.skipped++;
      continue;
    }
    const post = item.post;
    try {
      if (opts.publish) {
        const visibility = post.visibility === "private" ? "private" : "public";
        const r = await publishPost(context, blog, post, () => undefined, { visibility });
        await addEntry({ sha256: post.sha256, blog, mode: "published", title: post.title, at: new Date().toISOString() });
        log(`${tag} → 발행 완료 (글 번호 ${r.id}) ${r.url}`);
        for (const w of r.warnings) log(`    주의: ${w}`);
      } else {
        const r = await saveDraft(context, blog, post, () => undefined, {});
        await addEntry({ sha256: post.sha256, blog, mode: "draft", title: post.title, at: new Date().toISOString() });
        log(`${tag} → 임시저장 완료`);
        for (const w of r.warnings) log(`    주의: ${w}`);
      }
      result.done++;
    } catch (error) {
      if (!(error instanceof PublishError)) throw error;
      result.failed++;
      log(`${tag} → 실패: ${error.message}`);
      if (error.diagnosticsDir) log(`    진단 파일: ${error.diagnosticsDir}`);
    }
  }
  return result;
}
