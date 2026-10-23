import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { withSession } from "../auth/session.js";
import { PROVIDERS, AiError, generate, loadAiEnv, resolveAi } from "../ai/providers.js";
import { buildPrompts, cleanDraft, slugify, type Length } from "../ai/draft.js";
import { resolveBlog } from "../core/config.js";
import { addEntry } from "../core/history.js";
import { PostError, loadPost } from "../post/post.js";
import { PublishError, saveDraft } from "../actions/publisher.js";
import { askChoice } from "../ui/prompt.js";

function freePath(dir: string, base: string): string {
  let file = path.join(dir, `${base}.md`);
  for (let n = 2; existsSync(file); n += 1) file = path.join(dir, `${base}-${n}.md`);
  return file;
}

export function registerWriteCommand(program: Command): void {
  program
    .command("write <topic>")
    .description("주제를 주면 AI(Gemini)가 초안을 써서 파일로 저장하고, 원하면 임시저장까지 합니다")
    .option("-p, --provider <name>", "AI 종류 (지금은 gemini만)")
    .option("-m, --model <name>", "모델 이름 (기본: .env 의 AI_MODEL 또는 공급자 기본값)")
    .option("-l, --length <size>", "short | medium | long", "medium")
    .option("-n, --notes <text>", "추가 요청 (말투, 독자, 포함할 내용 등)")
    .option("-o, --out <file>", "저장할 파일 (기본: drafts/주제.md)")
    .option("--save", "초안을 만든 뒤 묻지 않고 티스토리에 임시저장")
    .option("--no-save", "초안 파일만 만들고 임시저장 질문도 하지 않음")
    .option("--headed", "브라우저 창을 띄워서 실행")
    .option("-b, --blog <name>", "올릴 블로그 (기본: 설정값)")
    .action(
      async (
        topic: string,
        opts: {
          provider?: string;
          model?: string;
          length: string;
          notes?: string;
          out?: string;
          save?: boolean;
          headed?: boolean;
          blog?: string;
        },
      ) => {
        if (!["short", "medium", "long"].includes(opts.length)) {
          console.error("--length 는 short, medium, long 중 하나입니다.");
          process.exitCode = 1;
          return;
        }
        let text: string;
        try {
          const ai = resolveAi(await loadAiEnv(), { provider: opts.provider, model: opts.model });
          console.log(`${PROVIDERS[ai.provider].label} (${ai.model}) 로 초안을 씁니다…`);
          console.log("  · 입력으로 보내는 것은 주제와 추가 요청뿐입니다.");
          const { system, user } = buildPrompts(topic, { length: opts.length as Length, notes: opts.notes });
          text = cleanDraft(await generate(ai, system, user));
        } catch (error) {
          if (error instanceof AiError) {
            console.error(`\n${error.message}`);
            process.exitCode = 1;
            return;
          }
          throw error;
        }

        const file = opts.out ?? freePath("drafts", slugify(topic));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, text, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") throw new Error(`이미 있는 파일입니다: ${file} (다른 이름을 --out 으로 지정하세요)`);
          throw error;
        });

        let post;
        try {
          post = await loadPost(file);
        } catch (error) {
          if (error instanceof PostError) {
            console.error(`\n초안은 ${file} 에 저장했지만 형식에 문제가 있습니다:`);
            for (const problem of error.problems) console.error(`  - ${problem}`);
            console.error("파일을 고친 뒤 `tistory publish` 로 올리세요.");
            process.exitCode = 1;
            return;
          }
          throw error;
        }

        const bodyOnly = text.replace(/^---\n[\s\S]*?\n---\n/, "");
        const preview = bodyOnly.split("\n").filter((l) => l.trim()).slice(0, 8).join("\n");
        console.log(`\n초안을 저장했습니다: ${file}`);
        console.log(`제목: ${post.title}`);
        console.log(`태그: ${post.tags.length ? post.tags.join(", ") : "(없음)"}`);
        console.log(`본문: ${bodyOnly.length.toLocaleString()}자`);
        console.log(`\n--- 미리보기 ---\n${preview}\n…`);
        console.log("\n※ AI가 쓴 글입니다. 사실관계와 문장을 꼭 읽고 고친 뒤 발행하세요.");

        if (opts.save === false) return;
        let doSave = opts.save === true;
        if (!doSave) {
          if (!process.stdin.isTTY) return;
          const choice = await askChoice("이 초안을 어떻게 할까요?", ["티스토리에 임시저장"], "파일만 두기 (고친 뒤 tistory publish)");
          doSave = choice === 0;
        }
        if (!doSave) {
          console.log(`고친 뒤 올리려면: tistory publish ${file}`);
          return;
        }

        try {
          const blog = await resolveBlog(opts.blog);
          console.log(`\n${blog}.tistory.com 에 임시저장합니다. (공개되지 않습니다)\n`);
          const result = await withSession({ headless: !opts.headed }, (ctx) =>
            saveDraft(ctx, blog, post, (m) => console.log(`  · ${m}`), {
              askCategory: process.stdin.isTTY
                ? (labels) => askChoice("카테고리를 선택하세요:", labels, "지정 안 함")
                : undefined,
            }),
          );
          await addEntry({ sha256: post.sha256, blog, mode: "draft", title: post.title, at: new Date().toISOString() });
          console.log(`\n임시저장했습니다. 티스토리 글쓰기 화면의 '임시저장' 목록에서 확인하세요.`);
          for (const warning of result.warnings) console.log(`주의: ${warning}`);
        } catch (error) {
          if (error instanceof PublishError) {
            console.error(`\n임시저장하지 못했습니다: ${error.message}`);
            console.error(`초안 파일은 남아 있습니다: ${file}`);
            process.exitCode = 1;
            return;
          }
          throw error;
        }
      },
    );
}
