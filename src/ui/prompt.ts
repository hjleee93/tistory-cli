import { createInterface } from "node:readline/promises";

/**
 * 번호로 고르는 질문. 터미널이 아니면(파이프 등) 묻지 않고 undefined.
 * 0 또는 Enter는 "고르지 않음"이다.
 */
export async function askChoice(
  title: string,
  labels: string[],
  noneLabel: string,
): Promise<number | undefined> {
  if (!process.stdin.isTTY) return undefined;

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
