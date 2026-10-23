export interface Fix {
  from: string;
  to: string;
  reason: string;
}

export function buildSpellPrompts(body: string): { system: string; user: string } {
  const system = [
    "당신은 한국어 맞춤법·띄어쓰기·오탈자 교정자입니다.",
    "주어진 마크다운 글에서 명백한 맞춤법, 띄어쓰기, 오탈자, 조사 오류만 찾습니다.",
    "- 문체, 말투(반말/존댓말), 표현 취향, 줄바꿈, 마크다운 문법, 고유명사, 영어·코드·명령어는 고치지 않습니다.",
    "- 의미가 바뀌는 수정, 내용 추가·삭제는 하지 않습니다.",
    "- from 은 원문에 그대로 있는 짧은 구절(오류가 든 단어나 어절 몇 개)로, 원문과 한 글자도 다르면 안 됩니다.",
    '- 출력은 JSON 배열만: [{"from":"원문 구절","to":"고친 구절","reason":"짧은 이유"}]. 고칠 것이 없으면 [] 만 출력합니다.',
  ].join("\n");
  return { system, user: body };
}

/** AI 응답에서 JSON 배열을 꺼내 형식이 맞는 항목만 남긴다. */
export function parseFixes(text: string): Fix[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Fix[] = [];
  for (const item of parsed as Array<Record<string, unknown>>) {
    if (typeof item?.from === "string" && typeof item.to === "string" && item.from !== item.to && item.from.trim() !== "") {
      out.push({ from: item.from, to: item.to, reason: typeof item.reason === "string" ? item.reason : "" });
    }
  }
  return out;
}

const FRONTMATTER = /^(?:﻿)?---\r?\n[\s\S]*?\r?\n---\r?\n/;
const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;

export interface Segment {
  text: string;
  /** true 면 고치지 않는 부분 (frontmatter, 코드) */
  protectedPart: boolean;
}

/** 원고를 frontmatter·코드(보호)와 본문 글(검사 대상)로 나눈다. */
export function splitProse(text: string): Segment[] {
  const segments: Segment[] = [];
  let rest = text;
  const fm = FRONTMATTER.exec(rest);
  if (fm) {
    segments.push({ text: fm[0], protectedPart: true });
    rest = rest.slice(fm[0].length);
  }
  let last = 0;
  for (const match of rest.matchAll(CODE)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ text: rest.slice(last, index), protectedPart: false });
    segments.push({ text: match[0], protectedPart: true });
    last = index + match[0].length;
  }
  if (last < rest.length) segments.push({ text: rest.slice(last), protectedPart: false });
  return segments;
}

export interface ApplyResult {
  text: string;
  applied: Array<Fix & { count: number }>;
  /** 본문에서 찾지 못했거나(코드 안·AI의 착오) 적용하지 않은 것 */
  skipped: Fix[];
}

/** 본문 글(코드·frontmatter 제외)에서만 구절을 바꾼다. 원문에 없는 구절은 건너뛴다. */
export function applyFixes(text: string, fixes: Fix[]): ApplyResult {
  const segments = splitProse(text);
  const applied: ApplyResult["applied"] = [];
  const skipped: Fix[] = [];
  for (const fix of fixes) {
    let count = 0;
    for (const seg of segments) {
      if (seg.protectedPart || !seg.text.includes(fix.from)) continue;
      count += seg.text.split(fix.from).length - 1;
      seg.text = seg.text.split(fix.from).join(fix.to);
    }
    if (count > 0) applied.push({ ...fix, count });
    else skipped.push(fix);
  }
  return { text: segments.map((s) => s.text).join(""), applied, skipped };
}

/** AI에게 보낼 본문: frontmatter 와 코드 블록은 뺀다. */
export function proseForCheck(text: string): string {
  return splitProse(text)
    .map((s) => (s.protectedPart ? "\n" : s.text))
    .join("")
    .trim();
}
