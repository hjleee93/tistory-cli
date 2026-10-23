export type Length = "short" | "medium" | "long";

const LENGTH_HINT: Record<Length, string> = {
  short: "A4 반 장 정도(약 800자)",
  medium: "A4 한 장 정도(약 1,500자)",
  long: "A4 두 장 정도(약 3,000자)",
};

export function buildPrompts(
  topic: string,
  options: { length?: Length; notes?: string } = {},
): { system: string; user: string } {
  const system = [
    "당신은 한국어 블로그 글을 쓰는 작가입니다. 티스토리 블로그에 올릴 마크다운 글 한 편을 씁니다.",
    "출력 형식(반드시 지킬 것):",
    "- 맨 앞에 YAML frontmatter 를 둡니다: title(글 제목), tags(쉼표로 구분한 태그 3~6개 배열 [a, b, c]). 다른 설정은 쓰지 않습니다.",
    "- frontmatter 다음에 본문을 씁니다. 본문에는 제목(# )을 다시 쓰지 말고, 소제목은 ## 부터 씁니다.",
    "- 문단 사이에는 빈 줄을 둡니다. 코드가 있으면 언어를 지정한 코드 블록을 씁니다.",
    "- 설명이나 인사말, 코드 펜스(```markdown)로 전체를 감싸는 일 없이 글 내용만 출력합니다.",
    "- 모르는 사실을 지어내지 않습니다. 확실하지 않은 수치나 출처는 쓰지 않습니다.",
    "- 이미지는 넣지 않습니다.",
  ].join("\n");
  const user = [
    `주제: ${topic}`,
    `분량: ${LENGTH_HINT[options.length ?? "medium"]}`,
    options.notes ? `추가 요청: ${options.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user };
}

/** AI가 전체를 코드 펜스로 감싸 보내는 경우를 벗겨 내고, frontmatter 가 맨 앞에 오게 한다. */
export function cleanDraft(text: string): string {
  let out = text.replace(/\r\n/g, "\n").trim();
  const fenced = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(out);
  if (fenced?.[1]) out = fenced[1].trim();
  const start = out.indexOf("---\n");
  if (start > 0 && /^[\s\S]{0,200}$/.test(out.slice(0, start)) && out.indexOf("\n---", start + 4) > 0) {
    out = out.slice(start);
  }
  return `${out}\n`;
}

/** 주제로 파일 이름을 만든다. (한글·영문·숫자만 남기고 공백은 -) */
export function slugify(topic: string): string {
  const slug = topic
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  return slug || "draft";
}
