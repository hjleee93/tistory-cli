import readline from "node:readline";
import { createInterface } from "node:readline/promises";

export type NavKey = "up" | "down" | "home" | "end" | "pageup" | "pagedown";

/** 목록에서 커서를 움직인 새 위치. 맨 위에서 위로 가면 맨 아래로(반대도 마찬가지) 순환한다. */
export function moveSelection(index: number, key: NavKey, total: number, page = 8): number {
  if (total <= 0) return 0;
  switch (key) {
    case "up":
      return (index - 1 + total) % total;
    case "down":
      return (index + 1) % total;
    case "home":
      return 0;
    case "end":
      return total - 1;
    case "pageup":
      return Math.max(0, index - page);
    case "pagedown":
      return Math.min(total - 1, index + page);
  }
}

/** 화면에 보일 목록 창의 시작 위치: 커서가 항상 창 안에 들어오게 한다. */
export function windowStart(index: number, total: number, size: number): number {
  if (total <= size) return 0;
  const start = index - Math.floor(size / 2);
  return Math.max(0, Math.min(total - size, start));
}

const KEY_MAP: Record<string, NavKey | undefined> = {
  up: "up",
  down: "down",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
};

/**
 * 키보드로 고르는 질문: ↑/↓(또는 k/j)로 이동, Enter로 선택, Esc 또는 q 는 "고르지 않음".
 * 터미널이 아니면(파이프 등) 묻지 않고 undefined. 마지막 항목은 항상 noneLabel 이다.
 */
export async function askChoice(
  title: string,
  labels: string[],
  noneLabel: string,
): Promise<number | undefined> {
  if (!process.stdin.isTTY) return undefined;
  if (typeof process.stdin.setRawMode !== "function") return askChoiceByNumber(title, labels, noneLabel);

  const items = [...labels, noneLabel];
  const total = items.length;
  const rows = process.stdout.rows ?? 24;
  const size = Math.max(5, Math.min(total, rows - 5));
  let index = 0;
  let drawn = 0;

  const draw = (): void => {
    const start = windowStart(index, total, size);
    const lines: string[] = [];
    if (start > 0) lines.push(`  \x1b[2m↑ ${start}개 더\x1b[0m`);
    for (let i = start; i < Math.min(total, start + size); i++) {
      const label = items[i] as string;
      lines.push(i === index ? `\x1b[36m❯ ${label}\x1b[0m` : `  ${label}`);
    }
    const below = total - (start + size);
    if (below > 0) lines.push(`  \x1b[2m↓ ${below}개 더\x1b[0m`);
    if (drawn > 0) process.stdout.write(`\x1b[${drawn}A`);
    for (const line of lines) process.stdout.write(`\x1b[2K${line}\n`);
    // 이전보다 줄 수가 줄었으면 남은 줄을 지운다
    for (let k = lines.length; k < drawn; k++) process.stdout.write("\x1b[2K\n");
    if (drawn > lines.length) process.stdout.write(`\x1b[${drawn - lines.length}A`);
    drawn = lines.length;
  };

  console.log(`\n${title}`);
  console.log("  ↑/↓ 이동 · Enter 선택 · Esc 건너뛰기\n".replace(/^/, "\x1b[2m").replace(/\n$/, "\x1b[0m\n"));
  process.stdout.write("\x1b[?25l"); // 커서 숨김
  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  draw();

  return new Promise<number | undefined>((resolve) => {
    const finish = (value: number | undefined): void => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h");
      resolve(value);
    };
    const onKey = (_: string | undefined, key: readline.Key | undefined): void => {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        process.stdin.setRawMode(wasRaw);
        process.stdout.write("\x1b[?25h\n");
        process.exit(130);
      }
      if (key.name === "return") return finish(index === total - 1 ? undefined : index);
      if (key.name === "escape" || key.name === "q") return finish(undefined);
      const nav = key.name === "k" ? "up" : key.name === "j" ? "down" : KEY_MAP[key.name ?? ""];
      if (nav) {
        index = moveSelection(index, nav, total, size);
        draw();
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

/** 방향키를 쓸 수 없을 때를 위한 번호 입력 방식. 0 또는 Enter는 "고르지 않음". */
async function askChoiceByNumber(
  title: string,
  labels: string[],
  noneLabel: string,
): Promise<number | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n${title}`);
    labels.forEach((label, index) => console.log(`  ${index + 1}. ${label}`));
    console.log(`  0. ${noneLabel} (Enter)`);

    for (;;) {
      const answer = (await rl.question("번호 > ")).trim();
      if (answer === "" || answer === "0") return undefined;
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= labels.length) return n - 1;
      console.log(`1~${labels.length} 사이의 번호를 입력하세요.`);
    }
  } finally {
    rl.close();
  }
}

/** 한 줄 입력. 터미널이 아니면 undefined. */
export async function askLine(question: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
