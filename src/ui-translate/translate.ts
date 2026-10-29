// 화면 글 영어 보기(#5141) — 지금 화면에 보이는 한국어 글을 영어로 바꿔 보여 주는 토글의 서버 쪽.
//  왜: 화면(버튼 · 메뉴 · 지식 제목 · 대화)이 전부 한국어라 영어권 사람에게 보여 줄 수가 없다(영어권 동료 · 투자자 · 데모 영상 —
//   «화면에 보이는 것만 영어로 바꾸는 버튼»). 저장된 데이터는 건드리지 않는다 — 화면이 글 묶음을 보내면 영어를 돌려줄 뿐이다.
//  LLM 은 워크스페이스 API 키로 한 번 부른다(ai-runs/anthropic.singleShot — 키는 그 함수의 헤더에만 붙는다).
//  같은 글은 다시 부르지 않는다: 프로세스 메모리에 원문 → 번역을 남긴다(화면 쪽도 브라우저에 남긴다).
import crypto from "node:crypto";

export const TRANSLATE_TARGETS = ["en"] as const;
export type TranslateTarget = typeof TRANSLATE_TARGETS[number];

/** 한 번에 받는 글 수 · 한 글의 길이 · 묶음 전체 길이 — 화면이 이보다 크게 보내면 잘라서 여러 번 보낸다. */
export const MAX_TEXTS = 120;
export const MAX_TEXT_CHARS = 2000;
export const MAX_TOTAL_CHARS = 24_000;
/** 메모리에 남기는 번역 수 — 넘으면 오래된 것부터 버린다(Map 의 넣은 차례). */
export const CACHE_MAX = 20_000;
/** 깨진 답이 오면 묶음을 반씩 쪼개 다시 묻는다 — 한 요청에서 모델을 부르는 횟수의 상한(1 + 2 + 4: 세 층까지). */
export const SPLIT_CALLS_MAX = 7;

/** 기본 모델 — 짧은 글 번역이라 작은 모델로 충분하다. LIVELY_UI_TRANSLATE_MODEL 로 바꾼다. */
export const DEFAULT_TRANSLATE_MODEL = "claude-haiku-5-5";
export function translateModel(): string { return (process.env.LIVELY_UI_TRANSLATE_MODEL ?? "").trim() || DEFAULT_TRANSLATE_MODEL; }
/**
 * 번역에 생각은 필요 없다 — Haiku 는 기본이 적응형 생각이라 숨은 생각이 max_tokens 를 먹어 답이 잘렸다(실측: 글 한 줄에 823 토큰).
 *  Haiku 는 기본 노력(medium)에서 생각 끄기를 받는다. 끌 수 없는 모델(Opus 5.5 · Sonnet 5.5 — 400)엔 아무것도 보내지 않는다.
 */
export function thinkingFor(model: string): { type: "disabled" } | undefined { return /^claude-haiku-/.test(model) ? { type: "disabled" } : undefined; }

/** 한글(음절 · 자모)이 들어 있나 — 없으면 번역할 것이 없다. */
export const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힣]/;
export function needsTranslation(s: string): boolean { return HANGUL_RE.test(s); }

/** 제품 낱말 — 화면마다 같은 영어로 나오게 한다(«지식» 이 어떤 화면에선 Knowledge, 어떤 화면에선 Wisdom 이 되지 않게). */
export const GLOSSARY: ReadonlyArray<readonly [string, string]> = [
  ["라이블리", "Lively"], ["맥락 저장소", "context store"], ["맥락", "context"], ["지식", "knowledge"], ["자료", "sources"],
  ["수집기", "collector"], ["수집", "collect"], ["증류기", "distiller"], ["증류", "distill"], ["주입", "injection"],
  ["세션", "session"], ["세션 이력", "session history"], ["프로젝트", "project"], ["태스크", "task"], ["위키", "wiki"],
  ["리브", "Liv"], ["앱빌더", "App builder"], ["회의록", "meeting notes"], ["팀 채널", "team channel"], ["홈", "Home"],
  ["분류", "categories"], ["카테고리", "category"], ["곁칸", "side panel"], ["워크스페이스", "workspace"], ["구성원", "member"],
];

export function systemPrompt(target: TranslateTarget): string {
  const lang = target === "en" ? "English" : target;
  return [
    `You translate user-interface text of Lively (a team knowledge / AI workspace product) from Korean to ${lang}.`,
    `You get a JSON array of strings. Reply with ONLY a JSON array of the same length, in the same order — item i is the translation of input i.`,
    `Rules: keep it short and natural, like real app UI. Keep numbers, dates, times, emoji, symbols (· — → «» # @ / ⌘), code, file paths, URLs, IDs, product and people's names as they are (romanize Korean person names). Keep leading/trailing punctuation. If an item has no Korean, return it unchanged. Never add notes.`,
    `The reply must be valid JSON. Inside a translation never write a straight double quote (") — keep 「」 «» as they are, or use “ ”.`,
    `Use these terms consistently: ${GLOSSARY.map(([k, v]) => `${k}=${v}`).join(", ")}.`,
  ].join("\n");
}

export function userPrompt(texts: string[]): string { return JSON.stringify(texts); }

/** (순수) 모델 답 → 글 배열. 앞뒤 설명 · 코드 울타리가 붙어도 첫 «[» 부터 마지막 «]» 까지를 읽는다. 길이가 다르거나 글이 아니면 null. */
export function parseReply(text: string, n: number): Array<string | null> | null {
  const s = String(text ?? "");
  const a = s.indexOf("["), b = s.lastIndexOf("]");
  if (a < 0 || b <= a) return null;
  const raw = s.slice(a, b + 1);
  let v: unknown;
  //  모델이 「」 를 곧은 따옴표로 옮기며 이스케이프를 빠뜨리면 JSON 이 깨진다(매니지드 실측) — 한 번 고쳐 읽는다.
  try { v = JSON.parse(raw); } catch { try { v = JSON.parse(repairStringArray(raw)); } catch { return null; } }
  if (!Array.isArray(v) || v.length !== n) return null;
  return v.map((x) => (typeof x === "string" && x.trim() ? x : null));
}

/** (순수) 글 배열 JSON 의 문자열 안 «"» · 날 줄바꿈을 이스케이프한다. 문자열 안의 «"» 는 뒤에 «]» 나 «, "» 가 올 때만 끝으로 본다. */
export function repairStringArray(raw: string): string {
  const END = /\s*(?:\]|,\s*")/y;
  let out = "", inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!inStr) { out += c; if (c === '"') inStr = true; continue; }
    if (c === "\\") { out += c + (raw[i + 1] ?? ""); i++; continue; }
    if (c === "\n") { out += "\\n"; continue; }
    if (c !== '"') { out += c; continue; }
    END.lastIndex = i + 1;
    if (END.test(raw)) { out += c; inStr = false; } else out += '\\"';
  }
  //  마지막 글을 “ ” 로 닫고 곧은 따옴표를 빠뜨린 답(실측) — 끝 «]» 앞에서 닫아 준다.
  if (inStr) { const k = out.lastIndexOf("]"); if (k > 0) out = out.slice(0, k) + '"' + out.slice(k); }
  return out;
}

/** (순수) 받은 입력 → 정리된 글 목록 · 거절 사유. 빈 글 · 글이 아닌 것은 빼지 않고 그대로 둔다(자리 맞추기는 부르는 쪽 몫이 아니다). */
export function validateTexts(input: unknown): { texts: string[] } | { error: string } {
  if (!Array.isArray(input)) return { error: "texts 는 글 배열이어야 합니다" };
  if (input.length === 0) return { texts: [] };
  if (input.length > MAX_TEXTS) return { error: `한 번에 ${MAX_TEXTS}개까지 보낼 수 있습니다` };
  const texts = input.map((x) => (typeof x === "string" ? x : ""));
  if (texts.some((t) => t.length > MAX_TEXT_CHARS)) return { error: `글 하나는 ${MAX_TEXT_CHARS}자까지입니다` };
  if (texts.reduce((n, t) => n + t.length, 0) > MAX_TOTAL_CHARS) return { error: `한 번에 ${MAX_TOTAL_CHARS}자까지 보낼 수 있습니다` };
  return { texts };
}

/** 원문 → 번역 메모리(넣은 차례로 버린다). 시험이 새로 만든다. */
export class TranslateCache {
  private m = new Map<string, string>();
  constructor(private max = CACHE_MAX) {}
  private key(target: string, s: string): string { return target + ":" + crypto.createHash("sha1").update(s).digest("base64"); }
  get(target: string, s: string): string | undefined {
    const k = this.key(target, s);
    const v = this.m.get(k);
    if (v !== undefined) { this.m.delete(k); this.m.set(k, v); }   // 최근에 쓴 것을 뒤로 — 자주 보는 메뉴 글이 먼저 밀려나지 않게
    return v;
  }
  set(target: string, s: string, v: string): void {
    const k = this.key(target, s);
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.max) { const first = this.m.keys().next().value; if (first === undefined) break; this.m.delete(first); }
  }
  get size(): number { return this.m.size; }
}

export interface TranslateDeps {
  apiKey(): Promise<string | null>;
  workspaceId(): Promise<string | null>;
  /** 모델 한 번 — ok:false 면 error 를 싣는다(키는 싣지 않는다). */
  call(apiKey: string, i: { model: string; system: string; prompt: string; maxTokens: number; workspaceId: string | null; thinking?: { type: "disabled" } }): Promise<{ ok: boolean; text: string; error: string | null; stopReason?: string | null }>;
  cache: TranslateCache;
  model(): string;
  /** 기억을 나누는 칸 — 테넌트(워크스페이스). 한 프로세스가 여러 테넌트를 받아도 한쪽이 오염시킨 번역이 남에게 나가지 않게(격리 리뷰 6). */
  scope(): string;
}

export interface TranslateResult {
  /** 입력과 같은 길이 — 번역 못 한 자리는 null(화면은 원문을 그대로 둔다). */
  translations: Array<string | null>;
  cached: number;
  translated: number;
  failed: number;
  error?: string;
}

/**
 * 글 묶음 번역 — 한글이 없는 글은 그대로 · 메모리에 있는 글은 메모리에서 · 나머지만 모델 한 번(답이 깨지면 쪼개 몇 번 더).
 *  모델이 실패해도 던지지 않는다: 그 자리들을 null 로 돌려주고 error 에 까닭을 적는다(화면은 한글을 그대로 보여 준다).
 *  키가 없으면 501 성격의 오류를 던진다 — 부르는 쪽(능력)이 사람이 읽을 문장으로 바꾼다.
 */
export async function translateTexts(texts: string[], target: TranslateTarget, d: TranslateDeps): Promise<TranslateResult> {
  const out: Array<string | null> = texts.map(() => null);
  const ck = `${d.scope()}|${target}`;
  const todo: number[] = [];
  let cached = 0;
  //  같은 글이 여러 번 오면(«열기» 버튼 열 개) 모델에는 한 번만 보낸다.
  const firstAt = new Map<string, number>();
  texts.forEach((t, i) => {
    if (!needsTranslation(t)) { out[i] = t; return; }
    const hit = d.cache.get(ck, t);
    if (hit !== undefined) { out[i] = hit; cached++; return; }
    if (!firstAt.has(t)) { firstAt.set(t, i); todo.push(i); }
  });
  if (!todo.length) return { translations: out, cached, translated: 0, failed: 0 };

  const key = await d.apiKey();
  if (!key) throw new NoApiKeyError();
  const system = systemPrompt(target), model = d.model(), thinking = thinkingFor(model), workspaceId = await d.workspaceId();
  let calls = 0, translated = 0, failed = 0;
  let error: string | undefined;
  //  묶음 하나를 한 번에 — 답이 깨졌거나 잘렸으면 반씩 쪼개 다시 묻는다(긴 글 하나가 묶음 전체를 실패시키지 않게, 매니지드 실측).
  //  호출 자체의 실패(과부하 등)는 쪼개지 않는다 — 같은 오류를 여러 번 부를 뿐이다.
  const run = async (ids: number[]): Promise<void> => {
    calls++;
    const batch = ids.map((i) => texts[i]);
    const total = batch.reduce((n, t) => n + t.length, 0);
    const r = await d.call(key, {
      model, system, prompt: userPrompt(batch),
      //  영어는 한국어보다 글자가 늘어난다 — 넉넉히. 상한은 쓴 만큼만 과금되니 바닥 2048(생각을 못 끄는 모델의 생각 몫까지).
      maxTokens: Math.min(16_000, Math.max(2_048, Math.ceil(total * 1.5) + batch.length * 16)),
      workspaceId,
      ...(thinking ? { thinking } : {}),
    });
    const parsed = r.ok && r.stopReason !== "max_tokens" ? parseReply(r.text, batch.length) : null;
    if (!parsed && r.ok && ids.length > 1 && calls + 2 <= SPLIT_CALLS_MAX) {
      const h = Math.ceil(ids.length / 2);
      await Promise.all([run(ids.slice(0, h)), run(ids.slice(h))]);
      return;
    }
    ids.forEach((i, k) => {
      const v = parsed?.[k] ?? null;
      if (v) { d.cache.set(ck, texts[i], v); translated++; } else failed++;
      out[i] = v;
    });
    if (!r.ok) error = r.error ?? "번역 호출이 실패했습니다";
    else if (!parsed) error ??= "번역 응답을 읽지 못했습니다";
  };
  await run(todo);
  //  같은 글의 나머지 자리도 채운다.
  texts.forEach((t, i) => { if (out[i] === null && firstAt.has(t)) out[i] = out[firstAt.get(t)!]; });
  const res: TranslateResult = { translations: out, cached, translated, failed };
  if (error) res.error = error;
  return res;
}

export class NoApiKeyError extends Error {
  constructor() { super("워크스페이스에 Anthropic API 키가 없어 화면 번역을 할 수 없습니다 — 관리 ▸ AI 실행 계정에서 키를 등록하세요"); }
}

let liveDeps: TranslateDeps | null = null;
/** 살아 있는 의존 — 워크스페이스 API 키(자격 금고) · Anthropic 단발 · 프로세스 메모리. */
export async function liveTranslateDeps(): Promise<TranslateDeps> {
  if (liveDeps) return liveDeps;
  const live = await import("../ai-runs/live.js");
  const { currentTenant } = await import("../org/tenant-context.js");
  const { singleShot } = await import("../ai-runs/anthropic.js");
  liveDeps = {
    apiKey: live.workspaceApiKey,
    workspaceId: live.workspaceAnthropicWorkspaceId,
    call: async (apiKey, i) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 90_000);
      try {
        const r = await singleShot(apiKey, { model: i.model, system: i.system, prompt: i.prompt, maxTokens: i.maxTokens, workspaceId: i.workspaceId, thinking: i.thinking }, ac.signal);
        return { ok: r.ok, text: r.text, error: r.error, stopReason: r.stopReason };
      } catch (e) {
        return { ok: false, text: "", error: ac.signal.aborted ? "번역 호출이 90초 안에 끝나지 않았습니다" : String((e as Error)?.message ?? e).slice(0, 200) };
      } finally { clearTimeout(t); }
    },
    cache: new TranslateCache(),
    model: translateModel,
    scope: () => currentTenant()?.id ?? "",
  };
  return liveDeps;
}
