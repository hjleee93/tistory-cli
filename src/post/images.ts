import path from "node:path";

/** 원고의 이미지 주소(src)를 실제 파일 경로로 바꾼다. (쿼리·해시 제거, %인코딩 해제) */
export function resolveImagePath(baseDir: string, src: string): string {
  const clean = decodeURI(src.split(/[?#]/)[0] ?? src);
  return path.isAbsolute(clean) ? clean : path.join(baseDir, clean);
}

/**
 * 업로드할 파일 이름을 정한다.
 * - 영문·숫자·`._- ` 로만 된 이름이고 겹치지 않으면 원래 이름 그대로.
 * - 겹치면 앞에 번호를, 한글 등 특수문자가 있으면 `image-번호.확장자` 로 바꾼다.
 *   (운영체제·브라우저별 파일 경로 처리 차이를 피하고, 돌려받은 filename 으로 이미지를 구분하기 위함)
 */
export function uniqueUploadNames(files: string[]): string[] {
  const bases = files.map((f) => path.basename(f));
  return bases.map((base, i) => {
    if (!/^[A-Za-z0-9._ -]+$/.test(base)) return `image-${i + 1}${path.extname(base).toLowerCase()}`;
    return bases.filter((b) => b === base).length > 1 ? `${i + 1}-${base}` : base;
  });
}

export interface ImageToken {
  filename: string;
  token: string;
}

/** HTML 모드 본문에서 `[##_Image|…|{json}_##]` 표기를 모두 찾아 filename 과 함께 돌려준다. */
export function extractImageTokens(code: string): ImageToken[] {
  const found: ImageToken[] = [];
  for (const match of code.matchAll(/\[##_Image\|[\s\S]*?_##\]/g)) {
    const token = match[0];
    const jsonStart = token.indexOf("{");
    const jsonEnd = token.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd < jsonStart) continue;
    try {
      const meta = JSON.parse(token.slice(jsonStart, jsonEnd + 1)) as { filename?: unknown };
      if (typeof meta.filename === "string") found.push({ filename: meta.filename, token });
    } catch {
      // 해석할 수 없는 표기는 건너뜀
    }
  }
  return found;
}

/** 본문 HTML 의 `<img src="로컬">` 태그를 업로드 결과 표기로 바꾼다. (map: 원고 src → 표기) */
export function replaceImageTags(html: string, map: Map<string, string>): string {
  return html.replace(/<img\b[^>]*?\ssrc=(["'])(.*?)\1[^>]*>/gi, (whole, _q: string, src: string) =>
    map.get(src) ?? whole,
  );
}
