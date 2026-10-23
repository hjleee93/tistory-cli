import { readFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../core/config.js";
import { parseEnv } from "../core/credentials.js";

/** 지금은 Gemini만 지원한다. (무료 키로 쓸 수 있고, 직접 확인한 것만 넣는다) */
export type Provider = "gemini";

export const PROVIDERS: Record<Provider, { label: string; keyName: string; defaultModel: string }> = {
  gemini: { label: "Gemini", keyName: "GEMINI_API_KEY", defaultModel: "gemini-3.5-flash-lite" },
};

export class AiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiError";
  }
}

/** 사용자가 쓴 이름을 공급자 이름으로 바꾼다. */
export function parseProvider(name: string | undefined): Provider | undefined {
  const value = name?.trim().toLowerCase();
  return value === "gemini" || value === "google" ? "gemini" : undefined;
}

/** 찾는 순서: 환경변수 → 현재 폴더의 .env → ~/.tistory-cli/.env */
export async function loadAiEnv(cwd = process.cwd()): Promise<Record<string, string | undefined>> {
  const merged: Record<string, string | undefined> = {};
  for (const file of [path.join(DATA_DIR, ".env"), path.join(cwd, ".env")]) {
    try {
      Object.assign(merged, parseEnv(await readFile(file, "utf8")));
    } catch {
      // 파일 없음
    }
  }
  return { ...merged, ...process.env };
}

export interface ResolvedAi {
  provider: Provider;
  apiKey: string;
  model: string;
}

/**
 * 어떤 AI를 쓸지 정한다: --provider > AI_PROVIDER > 키가 하나만 있으면 그것.
 * 모델은 --model > AI_MODEL > 기본값.
 */
export function resolveAi(
  env: Record<string, string | undefined>,
  options: { provider?: string; model?: string } = {},
): ResolvedAi {
  const requested = options.provider ?? env.AI_PROVIDER;
  let provider: Provider | undefined = parseProvider(requested);
  if (requested && !provider) {
    throw new AiError(`알 수 없는 AI입니다: ${requested} (지금은 gemini만 지원합니다)`);
  }
  if (!provider) {
    const withKey = (Object.keys(PROVIDERS) as Provider[]).filter((p) => env[PROVIDERS[p].keyName]);
    if (withKey.length === 1 && withKey[0]) provider = withKey[0];
    else if (withKey.length === 0) {
      throw new AiError(
        "Gemini API 키가 없습니다. .env 에 GEMINI_API_KEY 를 넣으세요. (무료 키: https://aistudio.google.com/apikey)",
      );
    } else {
      throw new AiError(
        `키가 여러 개라 어떤 AI를 쓸지 정할 수 없습니다. --provider (${withKey.join(", ")}) 또는 .env 의 AI_PROVIDER 로 정하세요.`,
      );
    }
  }
  const chosen: Provider = provider;
  const info = PROVIDERS[chosen];
  const apiKey = env[info.keyName];
  if (!apiKey) throw new AiError(`${info.label} 키가 없습니다. .env 에 ${info.keyName} 를 넣으세요.`);
  return { provider: chosen, apiKey, model: options.model ?? env.AI_MODEL ?? info.defaultModel };
}

/** 응답 JSON에서 글자만 꺼낸다. */
export function extractText(provider: Provider, json: unknown): string {
  void provider;
  const data = json as Record<string, unknown>;
  const candidates = data.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
  const text = candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!text || text.trim() === "") throw new AiError("AI가 빈 응답을 돌려줬습니다. (안전 필터나 한도 때문일 수 있습니다)");
  return text;
}

function request(ai: ResolvedAi, system: string, user: string): { url: string; headers: Record<string, string>; body: unknown } {
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model)}:generateContent`,
    headers: { "x-goog-api-key": ai.apiKey },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
    },
  };
}

/** AI에게 글을 쓰게 한다. 키는 요청 헤더로만 보내고 출력·오류 문구에 넣지 않는다. */
export async function generate(ai: ResolvedAi, system: string, user: string): Promise<string> {
  const req = request(ai, system, user);
  let response: Response;
  try {
    response = await fetch(req.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...req.headers },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "시간이 너무 오래 걸렸습니다" : "연결하지 못했습니다";
    throw new AiError(`${PROVIDERS[ai.provider].label} 요청 실패: ${reason}.`);
  }
  const raw = await response.text();
  if (!response.ok) {
    let detail = raw.replace(/\s+/g, " ").slice(0, 200);
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } | string };
      const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
      if (message) detail = message.slice(0, 200);
    } catch {
      // 본문 그대로 사용
    }
    const hint =
      response.status === 401 || response.status === 403
        ? " (키가 맞는지 확인하세요)"
        : response.status === 429
          ? " (무료 한도를 넘었을 수 있습니다. 잠시 뒤 다시 시도하세요)"
          : response.status === 404
            ? ` (모델 이름 ${ai.model} 을 확인하세요. --model 또는 AI_MODEL 로 바꿀 수 있습니다)`
            : "";
    throw new AiError(`${PROVIDERS[ai.provider].label} 오류 ${response.status}: ${detail}${hint}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AiError("AI 응답을 해석하지 못했습니다.");
  }
  return extractText(ai.provider, json);
}
