// Anthropic Messages API 로 나가는 한 자리 (#4488 앱 v2-9) — 단발 실행(게이트웨이가 한 번 부름)과 LLM 프록시(앱 · 작업 컨테이너의 요청을 흘려 보냄)가
//  같은 함수로 나간다. 워크스페이스 API 키는 여기서만 헤더에 붙고 밖(앱 코드 · 컨테이너)으로 나가지 않는다(설계 §3-E).
//  SDK 를 쓰지 않고 fetch 로 보낸다 — 프록시는 바이트를 그대로 흘려야 하고(스트리밍 · 베타 헤더 · 앱이 보낸 본문 그대로), 코어에 Anthropic SDK 의존성이 없다.
import { Readable } from "node:stream";

/** Anthropic 주소 — 자가호스팅이 자기 LLM 게이트웨이를 앞에 둘 때 · 시험이 가짜 서버를 둘 때 바꾼다(LIVELY_ANTHROPIC_BASE_URL). 부를 때마다 읽는다. */
export function anthropicBase(): string { return (process.env.LIVELY_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, ""); }
export const ANTHROPIC_VERSION = "2023-06-01";
/** 프록시가 흘려 보내는 경로 — 이 둘만(Claude Code 가 쓰는 것 · SDK 의 기본). 그 밖은 404. */
export const PROXY_PATHS: ReadonlySet<string> = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

export interface Usage { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }
export const zeroUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });

/** (순수) 응답 usage 객체 → 우리 셈. */
export function usageOf(u: unknown): Usage {
  const o = (u && typeof u === "object" ? u : {}) as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { input_tokens: n(o.input_tokens), output_tokens: n(o.output_tokens), cache_read_tokens: n(o.cache_read_input_tokens), cache_write_tokens: n(o.cache_creation_input_tokens) };
}

/**
 * (순수) SSE 본문의 사용량 모으기 — message_start 의 usage(입력 · 캐시) + message_delta 의 usage(출력 누계). 줄마다 먹인다.
 *  스트림이 끊겨도 그때까지의 값이 남는다.
 */
export class SseUsageCollector {
  usage = zeroUsage();
  model: string | null = null;
  private buf = "";
  feed(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === "message_start") {
        const m = (ev.message ?? {}) as Record<string, unknown>;
        const u = usageOf(m.usage);
        this.usage.input_tokens = u.input_tokens; this.usage.cache_read_tokens = u.cache_read_tokens; this.usage.cache_write_tokens = u.cache_write_tokens;
        if (typeof m.model === "string") this.model = m.model;
      } else if (ev.type === "message_delta") {
        const u = usageOf(ev.usage);
        if (u.output_tokens) this.usage.output_tokens = u.output_tokens;
        if (u.input_tokens) this.usage.input_tokens = u.input_tokens;
      }
    }
  }
}

/** Anthropic 워크스페이스 id 모양(콘솔 Settings ▸ Workspaces 의 ID · wrkspc_…). 자격 meta 에서 읽은 값을 헤더에 싣기 전에 거른다. */
export const ANTHROPIC_WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** (순수) 흘려 보낼 요청 헤더만 고른다 — 자격(x-api-key · authorization)은 버리고 워크스페이스 키를 새로 붙인다.
 *  workspaceId — 키가 워크스페이스에 묶이지 않은 것(조직 단위 · 계정 연동 키)이면 Anthropic 이 요청마다 `anthropic-workspace-id` 를 요구한다
 *  (없으면 400 «This API key is not scoped to a workspace»). 자격 meta.workspace_id 에서 온 값만 싣고, 부른 쪽이 보낸 같은 이름 헤더는
 *  버린다 — 어느 Anthropic 워크스페이스로 청구되는지는 자격의 일부라 앱이 고르지 않는다. */
export function forwardHeaders(incoming: Record<string, string | string[] | undefined>, apiKey: string, workspaceId?: string | null): Record<string, string> {
  const pick = (k: string): string | undefined => { const v = incoming[k]; return Array.isArray(v) ? v[0] : v; };
  const out: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": pick("anthropic-version") ?? ANTHROPIC_VERSION,
    "content-type": "application/json",
    accept: pick("accept") ?? "application/json",
  };
  const beta = pick("anthropic-beta"); if (beta) out["anthropic-beta"] = beta;
  if (workspaceId && ANTHROPIC_WORKSPACE_ID_RE.test(workspaceId)) out["anthropic-workspace-id"] = workspaceId;
  return out;
}

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  /** 응답 본문 스트림(그대로 흘려 보낸다). */
  body: Readable | null;
  /** 스트리밍이면 다 흘린 뒤 채워진다 · 아니면 본문을 읽은 뒤. */
  usage: Promise<{ usage: Usage; model: string | null; text?: string }>;
}

/**
 * Anthropic 으로 한 번 보낸다. 본문은 바이트 그대로(앱이 보낸 것). 응답은 스트림으로 돌려주고 사용량은 흘러간 뒤 셈한다.
 *  deps.fetch 는 시험이 바꿔 끼운다.
 */
export async function forwardToAnthropic(
  o: { path: string; headers: Record<string, string>; body: Buffer | string; stream: boolean; signal: AbortSignal },
  f: typeof fetch = fetch,
): Promise<ForwardResult> {
  //  Buffer 는 fetch 의 BodyInit 타입에 없다(값은 받는다) — ArrayBuffer 사본으로 넘긴다.
  const body: BodyInit = typeof o.body === "string" ? o.body : o.body.buffer.slice(o.body.byteOffset, o.body.byteOffset + o.body.byteLength) as ArrayBuffer;
  const res = await f(anthropicBase() + o.path, { method: "POST", headers: o.headers, body, signal: o.signal });
  const headers: Record<string, string> = {};
  for (const k of ["content-type", "request-id", "x-request-id", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-tokens-remaining", "retry-after"]) {
    const v = res.headers.get(k); if (v) headers[k] = v;
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!res.body) return { status: res.status, headers, body: null, usage: Promise.resolve({ usage: zeroUsage(), model: null }) };
  if (o.stream && ct.includes("text/event-stream")) {
    const col = new SseUsageCollector();
    const dec = new TextDecoder();
    const node = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream);
    let done!: (v: { usage: Usage; model: string | null }) => void;
    const usage = new Promise<{ usage: Usage; model: string | null }>((r) => { done = r; });
    node.on("data", (c: Buffer) => col.feed(dec.decode(c, { stream: true })));
    const finish = (): void => done({ usage: col.usage, model: col.model });
    node.on("end", finish); node.on("error", finish); node.on("close", finish);
    return { status: res.status, headers, body: node, usage };
  }
  //  JSON 응답 — 통째로 읽어 사용량을 셈하고 그대로 흘린다(크기는 LLM 답이라 수백 KB 안).
  const text = await res.text();
  let usage = zeroUsage(), model: string | null = null;
  try { const j = JSON.parse(text) as Record<string, unknown>; usage = usageOf(j.usage); if (typeof j.model === "string") model = j.model; } catch { /* 오류 본문 */ }
  return { status: res.status, headers, body: Readable.from([Buffer.from(text, "utf8")]), usage: Promise.resolve({ usage, model, text }) };
}

/** (순수) Anthropic 응답(JSON) → 글 하나(text 블록을 이어 붙임). */
export function textOfMessage(j: unknown): string {
  const content = (j as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("");
}

export interface SingleShotInput { model: string; prompt: string; system: string | null; maxTokens: number; /** 자격 meta.workspace_id — forwardHeaders 참조 */ workspaceId?: string | null; messages?: Array<{ role: "user" | "assistant"; content: string }>; /** 생각 설정 — 주면 그대로 싣는다(화면 번역이 Haiku 의 생각을 끈다) */ thinking?: { type: "disabled" } }
export interface SingleShotOutput { ok: boolean; status: number; text: string; usage: Usage; model: string | null; stopReason: string | null; error: string | null }

/**
 * 단발 한 번 — 프롬프트 하나(또는 짧은 대화)를 보내 글을 받는다. 시간 상한은 signal 로.
 *  Anthropic 오류(4xx·5xx)는 던지지 않고 ok:false 로 돌려준다(부르는 쪽이 실패 문장을 짓는다 · 키는 문장에 안 남긴다).
 */
export async function singleShot(apiKey: string, i: SingleShotInput, signal: AbortSignal, f: typeof fetch = fetch): Promise<SingleShotOutput> {
  const body: Record<string, unknown> = {
    model: i.model, max_tokens: i.maxTokens,
    messages: i.messages ?? [{ role: "user", content: i.prompt }],
  };
  if (i.system) body.system = i.system;
  if (i.thinking) body.thinking = i.thinking;
  const r = await forwardToAnthropic({ path: "/v1/messages", headers: forwardHeaders({}, apiKey, i.workspaceId ?? null), body: JSON.stringify(body), stream: false, signal }, f);
  const u = await r.usage;
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(u.text ?? "{}") as Record<string, unknown>; } catch { /* 빈 응답 */ }
  if (r.status < 200 || r.status >= 300) {
    const e = (j.error ?? {}) as Record<string, unknown>;
    const msg = typeof e.message === "string" ? e.message : `HTTP ${r.status}`;
    return { ok: false, status: r.status, text: "", usage: u.usage, model: u.model, stopReason: null, error: `${typeof e.type === "string" ? e.type + ": " : ""}${msg}`.slice(0, 400) };
  }
  return { ok: true, status: r.status, text: textOfMessage(j), usage: u.usage, model: u.model, stopReason: typeof j.stop_reason === "string" ? j.stop_reason : null, error: null };
}
