import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { marked } from "marked";
import { parse as parseYaml } from "yaml";

export type Visibility = "public" | "private" | "protected";

export interface Post {
  title: string;
  tags: string[];
  category?: string;
  /** 발행(--publish)할 때 적용할 공개 범위. 기본 public. */
  visibility: Visibility;
  /** 티스토리 에디터(HTML 모드)에 넣을 본문 */
  html: string;
  /** 본문에 있는 로컬 이미지 경로 (아직 업로드되지 않음) */
  localImages: string[];
  /** 로컬 이미지 경로의 기준 폴더 (원고 파일이 있는 폴더). loadPost 가 채운다 */
  baseDir?: string;
  warnings: string[];
  /** 원고 파일 내용의 SHA-256 (중복 발행 방지용) */
  sha256: string;
}

export class PostError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join("\n"));
    this.name = "PostError";
  }
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const VISIBILITIES: readonly Visibility[] = ["public", "private", "protected"];
const KNOWN_KEYS = new Set(["title", "tags", "category", "visibility"]);

function splitFrontmatter(text: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const match = FRONTMATTER.exec(text);
  if (!match) return { meta: {}, body: text.replace(/^﻿/, "") };

  let meta: unknown;
  try {
    meta = parseYaml(match[1] ?? "");
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "";
    throw new PostError([
      `맨 위 설정(frontmatter)을 읽을 수 없습니다: ${reason}`,
      '값에 ":" 가 들어가면 따옴표로 감싸세요. 예) title: "리뷰: 좋았던 점"',
    ]);
  }
  if (meta === null || meta === undefined) meta = {};
  if (typeof meta !== "object" || Array.isArray(meta)) {
    throw new PostError([
      "맨 위 설정(frontmatter)은 `키: 값` 형식이어야 합니다.",
    ]);
  }
  return {
    meta: meta as Record<string, unknown>,
    body: text.slice(match[0].length),
  };
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

function parseTags(value: unknown, problems: string[]): string[] {
  if (value === undefined || value === null) return [];
  const raw =
    Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!raw) {
    problems.push("tags는 목록([a, b]) 또는 쉼표로 구분한 글자여야 합니다.");
    return [];
  }
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" && typeof item !== "number") {
      problems.push("tags 안에는 글자만 쓸 수 있습니다.");
      return [];
    }
    const tag = String(item).trim().replace(/^#/, "");
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/** 본문 HTML에서 로컬 이미지(http·https·data 등 스킴이 없는 src)를 찾는다. */
export function findLocalImages(html: string): string[] {
  const found: string[] = [];
  const pattern = /<img\b[^>]*?\ssrc=(["'])(.*?)\1/gi;
  for (const match of html.matchAll(pattern)) {
    const src = match[2];
    if (!src) continue;
    const isRemote = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src);
    if (!isRemote && !found.includes(src)) found.push(src);
  }
  return found;
}

/** 원고 글자(Markdown)를 읽어 Post로 만든다. 파일을 읽지 않는 순수 함수. */
export function parsePostText(text: string): Post {
  const problems: string[] = [];
  const warnings: string[] = [];

  const { meta, body: rawBody } = splitFrontmatter(text);
  let body = rawBody;

  for (const key of Object.keys(meta)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(
        `알 수 없는 설정 "${key}"은(는) 무시합니다 (사용 가능: ${[...KNOWN_KEYS].join(", ")}).`,
      );
    }
  }

  // 제목: frontmatter 우선, 없으면 본문 첫 줄의 `# 제목`
  let title = asText(meta.title);
  if (!title) {
    const heading = /^\s*#\s+(.+?)\s*#*[ \t]*(?:\r?\n|$)/.exec(body);
    if (heading?.[1]) {
      title = heading[1].trim();
      body = body.slice(heading[0].length);
    }
  }
  if (!title) {
    problems.push(
      "제목이 없습니다. 맨 위 설정에 `title:`을 쓰거나 본문 첫 줄을 `# 제목`으로 시작하세요.",
    );
  }

  const tags = parseTags(meta.tags, problems);
  const category = asText(meta.category);

  let visibility: Visibility = "public";
  if (meta.visibility !== undefined) {
    const value = asText(meta.visibility);
    if (value && (VISIBILITIES as readonly string[]).includes(value)) {
      visibility = value as Visibility;
    } else {
      problems.push(
        `visibility는 ${VISIBILITIES.join(" | ")} 중 하나여야 합니다 (입력값: ${String(meta.visibility)}).`,
      );
    }
  }

  if (body.trim() === "") problems.push("본문이 비어 있습니다.");
  if (problems.length > 0) throw new PostError(problems);

  const html = (marked.parse(body, { gfm: true, async: false }) as string).trim();
  const localImages = findLocalImages(html);
  if (localImages.length > 0) {
    warnings.push(
      `로컬 이미지 ${localImages.length}개가 있습니다. 올릴 때 자동으로 업로드합니다.`,
    );
  }

  return {
    title: title as string,
    tags,
    category,
    visibility,
    html,
    localImages,
    warnings,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

/** 파일에서 원고를 읽는다. 로컬 이미지 파일이 실제로 있는지도 확인한다. */
export async function loadPost(file: string): Promise<Post> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PostError([`파일을 찾을 수 없습니다: ${file}`]);
    }
    throw error;
  }

  const post = parsePostText(text);
  const baseDir = path.dirname(path.resolve(file));
  post.baseDir = baseDir;
  for (const src of post.localImages) {
    const clean = decodeURI(src.split(/[?#]/)[0] ?? src);
    const target = path.isAbsolute(clean) ? clean : path.join(baseDir, clean);
    try {
      await access(target);
    } catch {
      post.warnings.push(`이미지 파일을 찾을 수 없습니다: ${src}`);
    }
  }
  return post;
}
