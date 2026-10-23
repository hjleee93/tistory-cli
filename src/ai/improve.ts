export function buildImprovePrompts(body: string, notes?: string): { system: string; user: string } {
  const system = [
    "당신은 한국어 블로그 글을 다듬는 편집자입니다. 주어진 마크다운 본문을 더 읽기 좋게 고쳐 씁니다.",
    "- 글쓴이의 말투(반말/존댓말, 어투)와 의견, 사실, 경험은 유지합니다. 없는 사실·수치·경험을 새로 만들어 넣지 않습니다.",
    "- 문장 흐름, 중복, 어색한 표현, 문단 구성, 맞춤법을 개선합니다. 필요하면 문단 순서를 바꾸거나 소제목(##)을 다듬을 수 있습니다.",
    "- 코드 블록, 인라인 코드, 이미지(![]()) 와 링크 주소, 표는 글자 하나도 바꾸지 않습니다.",
    "- 마크다운 문법을 유지하고, 문단 사이에는 빈 줄을 둡니다.",
    "- 설명이나 인사말, 코드 펜스로 감싸기 없이 고친 본문 전체만 출력합니다. frontmatter 는 출력하지 않습니다.",
  ].join("\n");
  const user = `${notes ? `수정 방향: ${notes}\n\n` : ""}--- 본문 ---\n${body}`;
  return { system, user };
}

const FRONTMATTER = /^(?:﻿)?---\r?\n[\s\S]*?\r?\n---\r?\n/;

export function splitFrontmatter(text: string): { front: string; body: string } {
  const m = FRONTMATTER.exec(text);
  return m ? { front: m[0], body: text.slice(m[0].length) } : { front: "", body: text };
}

/** AI가 전체를 코드 펜스로 감싸 보낸 경우 벗긴다. */
export function cleanBody(text: string): string {
  let out = text.replace(/\r\n/g, "\n").trim();
  const fenced = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(out);
  if (fenced?.[1]) out = fenced[1].trim();
  return `${out}\n`;
}

const codeBlocks = (t: string): string[] => t.match(/```[\s\S]*?```|~~~[\s\S]*?~~~/g) ?? [];
const images = (t: string): string[] => Array.from(t.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g), (m) => m[1] ?? "");

/** 지키기로 한 것(코드 블록·이미지)이 바뀌었는지 검사한다. 문제가 없으면 빈 배열. */
export function integrityWarnings(before: string, after: string): string[] {
  const out: string[] = [];
  const a = codeBlocks(before);
  const b = codeBlocks(after);
  if (a.length !== b.length || a.some((block, i) => block !== b[i])) out.push("코드 블록이 바뀌었거나 순서·개수가 달라졌습니다.");
  const ia = [...images(before)].sort();
  const ib = [...images(after)].sort();
  if (ia.length !== ib.length || ia.some((v, i) => v !== ib[i])) out.push("이미지가 빠지거나 바뀌었습니다.");
  if (after.trim().length < before.trim().length * 0.4) out.push("결과가 원문보다 많이 짧습니다. 내용이 빠졌을 수 있습니다.");
  return out;
}

/** 비교 단위: 줄 → 문장. 긴 한 줄 문단도 문장 단위로 비교해 변경이 보이게 한다. */
export function toUnits(text: string): string[] {
  const units: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split(/(?<=[.!?。…])\s+/).filter((p) => p !== "");
    units.push(...parts);
  }
  return units;
}

export type DiffOp = { kind: "same" | "del" | "add"; text: string };

/** 최장 공통 부분열(LCS)로 단위 비교. */
export function diffUnits(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "del", text: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++]! });
  while (j < m) ops.push({ kind: "add", text: b[j++]! });
  return ops;
}

/** 변경 부분과 앞뒤 `context` 단위만 보여 주는 글자 diff. 변경이 없으면 undefined. */
export function renderDiff(ops: DiffOp[], options: { color?: boolean; context?: number } = {}): string | undefined {
  const context = options.context ?? 1;
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.kind === "same") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k += 1) keep[k] = true;
  });
  if (!keep.some(Boolean)) return undefined;
  const paint = (code: string, s: string): string => (options.color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const lines: string[] = [];
  let skipped = false;
  ops.forEach((op, idx) => {
    if (!keep[idx]) {
      if (!skipped) lines.push(paint("90", "  …"));
      skipped = true;
      return;
    }
    skipped = false;
    if (op.kind === "same") lines.push(paint("90", `  ${op.text}`));
    else if (op.kind === "del") lines.push(paint("31", `- ${op.text}`));
    else lines.push(paint("32", `+ ${op.text}`));
  });
  return lines.join("\n");
}

export function countChanges(ops: DiffOp[]): { added: number; removed: number } {
  return {
    added: ops.filter((o) => o.kind === "add").length,
    removed: ops.filter((o) => o.kind === "del").length,
  };
}
