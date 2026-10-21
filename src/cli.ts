import { readFileSync } from "node:fs";
import { Command } from "commander";
import { NoSessionError } from "./auth/session.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerBlogCommands } from "./commands/blog.js";
import { registerPublishCommand } from "./commands/publish.js";
import { registerInspectCommands } from "./commands/inspect.js";
import { registerDoctorCommands } from "./commands/doctor.js";
import { registerBatchCommand } from "./commands/batch.js";
import { registerDeleteCommand } from "./commands/delete.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const program = new Command();

program
  .name("tistory")
  .description("Unofficial Tistory CLI (비공식 · 브라우저 자동화 기반)")
  .version(version);

registerSetupCommand(program);
registerAuthCommands(program);
registerBlogCommands(program);
registerPublishCommand(program);
registerInspectCommands(program);
registerDoctorCommands(program);
registerBatchCommand(program);
registerDeleteCommand(program);

// `tistory --login`, `tistory --doctor` 처럼 쓰는 습관을 위한 별칭.
// 첫 인자가 알려진 별칭일 때만 하위 명령으로 바꿔 준다.
const FLAG_ALIASES: Record<string, string[]> = {
  "--login": ["login"],
  "--doctor": ["doctor"],
  "--blogs": ["blogs"],
  "--status": ["auth", "status"],
  "--logout": ["auth", "logout"],
};
const argv = [...process.argv];
const alias = argv[2] ? FLAG_ALIASES[argv[2]] : undefined;
if (alias) argv.splice(2, 1, ...alias);

try {
  await program.parseAsync(argv);
} catch (error) {
  if (error instanceof NoSessionError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
}
