// 앱 AI 실행 — 판정만(순수) (#4488 앱 v2-9). DB · LLM · 작업 컨테이너를 모른다. service.ts 가 사실을 모아 여기 묻는다.
//
//  설계(app-framework-v2-general-web-design §3-E · §4 · §5 · §12 ④·⑤-3·⑤-5):
//   · 입구 하나 `/_lively/ai/runs` — 앱은 작업 단위(프롬프트 · 결과 스키마 · 파일 · 작업 이름)로 보내고 실행 계정을 고르지 않는다.
//   · 실행 계정은 게이트웨이가 **작업별 > 앱별 > 워크스페이스 기본값** 순으로 고른다(resolveAccount).
//   · 실행 자리 = 작업 종류 × 실행 계정: 단발 + API 키 → LLM 프록시(컨테이너 없음) · 그 밖(단발+구독 · 에이전트 전부) → 작업 컨테이너(executorFor).
//   · 구독은 «그 사람 본인(그 세션의 AI 포함) · 그 사람 세션에 초대받아 함께 보는 사람» 의 요청에만(#4423 · 상민 2026-10-19) — subscriptionRefusal.
//   · 결과 형식: 스키마를 보내면 프롬프트 끝에 형식 지시 → 끝난 출력 규칙 검사 → 어긋나면 «형식에 맞게 다시» 1회 → 그래도 어긋나면 원문 붙여 실패.
export type AiRunStatus = "queued" | "running" | "done" | "failed" | "canceled";
export const isEndedRun = (s: string): boolean => s === "done" || s === "failed" || s === "canceled";

export type AiAccount = { kind: "api_key" } | { kind: "subscription"; member: string };

/** 워크스페이스 설정 한 칸(org_runtime_config.app_ai_account) — 기본 실행 계정 + 앱별·작업별 덮어쓰기 + 기본 모델. */
export interface AiAccountSettings {
  /** 워크스페이스 기본 실행 계정. 없으면 «API 키가 있으면 API 키» 로 접는다(resolveAccount 의 fallback). */
  default?: AiAccount;
  /** 단발 실행의 기본 모델(앱이 model 을 안 주면). 없으면 DEFAULT_MODEL. */
  default_model?: string;
  apps?: Record<string, { default?: AiAccount; jobs?: Record<string, AiAccount> }>;
}

/** 프롬프트 상한(문자) — 작업 컨테이너의 PROMPT_MAX 와 같다(agent-jobs/plan.ts). */
export const PROMPT_MAX = 100_000;
export const SYSTEM_MAX = 20_000;
export const LABEL_MAX = 120;
export const SCHEMA_MAX_BYTES = 32_768;
export const JOB_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MODEL_RE = /^[a-z0-9][a-z0-9.\-[\]]{1,63}$/i;
/** 단발 실행 기본 모델 — 설정(app_ai_account.default_model)이 없을 때. 워크스페이스가 바꿀 수 있다. */
export const DEFAULT_MODEL = "claude-opus-5-5";
/** 요청이 `wait` 로 기다릴 수 있는 최대(초) — 앱 주소 앞단(CP 라우터)의 위쪽 무응답 30초보다 짧게. */
export const WAIT_MAX_SEC = 25;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** (순수) 설정 JSON 을 읽는다 — 모양이 틀린 칸은 버린다(잡값으로 던지지 않는다 · 사람 손이 닿는 칸). */
export function parseAccountSettings(raw: unknown): AiAccountSettings {
  const o = isObj(raw) ? raw : {};
  const acct = (v: unknown): AiAccount | undefined => {
    if (!isObj(v)) return undefined;
    if (v.kind === "api_key") return { kind: "api_key" };
    if (v.kind === "subscription" && typeof v.member === "string" && v.member.trim()) return { kind: "subscription", member: v.member.trim() };
    return undefined;
  };
  const out: AiAccountSettings = {};
  const d = acct(o.default); if (d) out.default = d;
  const m = str(o.default_model); if (m && MODEL_RE.test(m)) out.default_model = m;
  if (isObj(o.apps)) {
    out.apps = {};
    for (const [appId, v] of Object.entries(o.apps)) {
      if (!isObj(v)) continue;
      const entry: { default?: AiAccount; jobs?: Record<string, AiAccount> } = {};
      const ad = acct(v.default); if (ad) entry.default = ad;
      if (isObj(v.jobs)) {
        entry.jobs = {};
        for (const [name, jv] of Object.entries(v.jobs)) { const a = acct(jv); if (a && JOB_NAME_RE.test(name)) entry.jobs[name] = a; }
      }
      out.apps[appId] = entry;
    }
  }
  return out;
}

/**
 * (순수) 실행 계정 — 작업별 > 앱별 > 워크스페이스 기본값 > (API 키가 있으면) API 키. 아무것도 없으면 null(«실행 계정 없음»).
 *  hasApiKey = 워크스페이스 API 키(org_credential anthropic_api_key)가 등록돼 있나.
 */
export function resolveAccount(s: AiAccountSettings, appId: string, jobName: string | null, hasApiKey: boolean): { account: AiAccount; from: "job" | "app" | "workspace" | "api_key" } | null {
  const app = s.apps?.[appId];
  if (jobName && app?.jobs?.[jobName]) return { account: app.jobs[jobName]!, from: "job" };
  if (app?.default) return { account: app.default, from: "app" };
  if (s.default) return { account: s.default, from: "workspace" };
  if (hasApiKey) return { account: { kind: "api_key" }, from: "api_key" };
  return null;
}

export type RunKind = "single" | "agent";
/** (순수) 작업 종류 — files · cwd(project_id) · 도구를 밝혔으면 에이전트, 아니면 단발(설계 §12 ⑤-5 «runs 요청에 files·cwd 로 작업 종류를 밝힌다»). */
export function runKindOf(input: { files?: unknown; project_id?: unknown; cwd?: unknown; agent?: unknown }): RunKind {
  if (input.agent === true) return "agent";
  if (Array.isArray(input.files) && input.files.length > 0) return "agent";
  if (input.project_id !== undefined && input.project_id !== null && input.project_id !== "") return "agent";
  if (typeof input.cwd === "string" && input.cwd.trim()) return "agent";
  return "single";
}

export type Executor = "proxy" | "job";
/** (순수) 실행 자리 표(§3-E) — 단발 + API 키만 프록시. */
export function executorFor(kind: RunKind, account: AiAccount): Executor {
  return kind === "single" && account.kind === "api_key" ? "proxy" : "job";
}

/**
 * (순수) 구독 실행을 받을 수 있나 — 받을 수 없으면 거절 문장(403 본문), 받을 수 있으면 null.
 *  구독 주인 S 의 구독으로 도는 요청 = ① S 본인(어느 길이든 — 앱 화면 · S 세션의 AI(MCP) · S 의 토큰) ② S 의 세션에 초대받은 사람이 **그 세션에서** 보낸 요청(tie —
 *  요청이 매인 세션의 주인이 S 이고 보낸 사람이 그 세션에 들어갈 수 있다 · 판정은 chat.send · 앱 붙이기와 같은 requireSessionParticipant 기준).
 *  상민 2026-10-19: «세션의 AI 와 초대된 사람은 내 노트북을 함께 보는 사람이다 — 원준이가 내 마우스로 누르는 게 정책 위반이 아니듯». 종전(10-16)의
 *  «앱 화면(app-ui · app-front)에서 온 요청만» 조건은 뺐다 — 그 조건이 더 막던 길은 S 세션의 AI 와 S 의 토큰뿐이었고 둘 다 S 본인이다.
 *  사람이 아닌 요청자(앱 서버 대리 · 자동화 · 작업 토큰)는 그대로 거절 — 사람 없이 구독이 도는 모양(#4423)이라서. 사람 세션이 아닌 세션(task · managed · app · login)에
 *  매인 요청도 거절(tie.human) — 위탁·크론 헤드리스가 S 의 토큰으로 S 구독을 쓰는 길을 막는다.
 *  한계(알고 가는 것 · 격리 리뷰 non-blocking 4~6): ① tie 는 «그 세션 안에서 눌렀다» 의 증명이 아니라 «세션 id 주장 + 참가자 여부» 다 — 초대받은 사람은
 *  제 토큰과 세션 헤더만으로 세션 밖 스크립트에서도 S 구독을 쓸 수 있다(초대 = 함께 보는 사람이라는 결정의 범위 안). ② 들어갈 수 있나(sessionCanEnter)는
 *  끝난 세션도 참으로 본다 — 수명을 두려면 세션 활성 여부를 더 봐야 한다. ③ 세션 없는 S 본인의 토큰(REST)은 사람 세션인지 가릴 길이 없어 본인으로 통과한다.
 *  ④ 앱 주소(app-front · 새 탭)에서 초대받은 사람이 보내는 것은 세션이 안 실려 거절된다(S 본인은 된다).
 */
/** 요청이 매인 세션(ctx.session)의 사실 — 주인 · 보낸 사람이 들어갈 수 있나 · 사람 세션인가(kind human — 위탁·상시·앱·로그인 세션이 아니다). */
export interface SessionTie { owner: string | null; participant: boolean; human: boolean }
export function subscriptionRefusal(account: AiAccount, requester: { member: string; kind: "member" | "app_server" }, tie: SessionTie | null | undefined): string | null {
  if (account.kind !== "subscription") return null;
  if (requester.kind !== "member") return `이 앱의 실행 계정은 ${account.member}님 구독입니다 — 구독은 사람이 보낸 요청에만 쓸 수 있어요. 앱 서버 · 자동화는 워크스페이스 API 키가 필요합니다`;
  //  세션에 매인 요청인데 그 세션을 모르거나(fail-closed) 사람 세션이 아니면(위탁·크론 헤드리스 task · 상시 managed · 앱 · 로그인) 구독 주인 본인의 토큰이라도 거절 —
  //  사람 없이 구독이 도는 모양(#4423 · 격리 리뷰 blocking 1). 세션 헤더가 없는 본인 토큰은 가릴 길이 없어 본인으로 통과한다(머리말 한계 ③).
  if (tie && (tie.owner === null || !tie.human)) return `이 요청이 매인 세션을 확인할 수 없거나 사람이 보는 세션이 아닙니다(위탁 · 상시 · 앱 세션) — 구독은 사람이 보는 세션에서만 쓸 수 있어요. 자동화는 워크스페이스 API 키가 필요합니다`;
  if (requester.member === account.member) return null;
  if (tie && tie.owner === account.member && tie.participant) return null;
  return `이 앱의 실행 계정은 ${account.member}님 구독인데 ${requester.member}님이 보냈습니다 — 구독은 본인, 또는 ${account.member}님 세션에 초대받은 사람이 그 세션에서 보낸 요청에만 쓸 수 있어요(워크스페이스 API 키를 등록하면 누구의 요청이든 돕니다)`;
}

/**
 * (순수) 실행 계정 설정을 바꿀 수 있나 — 바꿀 수 없으면 거절 문장. 두 축이다: **누구의 구독인가**(본인만 — 설계 §12 ④ 조건 ①, 관리자도 남의 구독을
 *  고르지 못한다) 와 **어느 자리를 바꾸나**(워크스페이스 기본값은 관리자만 · 앱별·작업별은 관리자 또는 그 앱의 책임자). 자리 규칙이 없으면 구성원 누구나
 *  워크스페이스 기본값이나 아무 앱의 실행 계정을 자기 구독으로 덮어 다른 모두의 AI 실행을 막을 수 있다(격리 리뷰 blocking 2).
 *  API 키 · 해제도 같은 자리 규칙을 탄다(워크스페이스 = 관리자 · 앱 = 관리자 또는 책임자).
 */
export function accountSetRefusal(next: AiAccount | null, actor: { member: string; admin: boolean }, scope: { appId: string | null; appOwner: boolean }): string | null {
  if (next?.kind === "subscription" && next.member !== actor.member) return `구독 실행 계정은 그 사람 본인만 걸 수 있습니다 — ${next.member}님이 직접 설정해야 해요`;
  if (!scope.appId) {
    if (!actor.admin) return "워크스페이스 기본 실행 계정은 관리자만 바꿀 수 있습니다 — 구성원은 자기가 책임자인 앱에만 자기 구독을 걸 수 있어요";
    return null;
  }
  if (!actor.admin && !scope.appOwner) return `앱 '${scope.appId}' 의 실행 계정은 관리자나 그 앱의 책임자만 바꿀 수 있습니다`;
  return null;
}

/** (순수) 프롬프트 요지(목록용) — 첫 200자, 줄바꿈은 공백으로. */
export function promptSummary(prompt: string, max = 200): string {
  const s = prompt.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * (순수) 결과 스키마 → 프롬프트 끝에 붙이는 형식 지시. 모델이 JSON 만 내도록 — 설명 · 코드 울타리 없이.
 *  스키마는 JSON Schema(부분집합) 그대로 보여 준다(모델이 가장 잘 따르는 표현).
 */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return [
    "",
    "---",
    "응답 형식: 아래 JSON Schema 에 맞는 JSON **하나만** 출력한다. 설명 · 인사 · 코드 울타리(```)를 붙이지 않는다.",
    JSON.stringify(schema),
  ].join("\n");
}

/** «형식에 맞게 다시» 1회 재요청 문장(설계 §12 ④ «형식»). */
export function retryInstruction(errors: string[], schema: Record<string, unknown>): string {
  return [
    `앞 답은 형식에 맞지 않았습니다(${errors.slice(0, 3).join(" · ")}).`,
    "아래 JSON Schema 에 맞는 JSON 하나만 다시 출력하세요. 설명 · 코드 울타리 없이.",
    JSON.stringify(schema),
  ].join("\n");
}

/**
 * (순수) 모델 출력에서 JSON 하나를 꺼낸다 — 코드 울타리 · 앞뒤 글을 벗긴다. 못 꺼내면 undefined.
 *  첫 `{` 또는 `[` 부터 그 짝까지 균형을 맞춰 자른다(문자열 안의 괄호는 건너뛴다).
 */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  const body = fence ? fence[1]! : t;
  try { return JSON.parse(body); } catch { /* 아래로 */ }
  const start = body.search(/[[{]/);
  if (start < 0) return undefined;
  const open = body[start]!, close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i]!;
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) { if (c !== close) return undefined; try { return JSON.parse(body.slice(start, i + 1)); } catch { return undefined; } } }
  }
  return undefined;
}

/**
 * (순수) JSON Schema 부분집합 검사 — type(여럿 · null 포함) · enum · const · object(properties · required · additionalProperties) ·
 *  array(items · minItems · maxItems) · string(minLength · maxLength · pattern) · number/integer(minimum · maximum) · anyOf/oneOf · nullable.
 *  돌려주는 것: 어긋난 자리 문장 목록(비면 맞음). $ref · format · 그 밖 키워드는 모른 체한다(막지 않는다).
 */
export function validateJsonSchema(value: unknown, schema: unknown, path = "$"): string[] {
  if (!isObj(schema)) return [];
  const errs: string[] = [];
  const typeOf = (v: unknown): string => v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;
  const t = schema.type;
  const types = Array.isArray(t) ? t.map(String) : typeof t === "string" ? [t] : null;
  if (schema.nullable === true && value === null) return [];
  if (types) {
    const actual = typeOf(value);
    const ok = types.some((x) => x === actual || (x === "number" && actual === "integer"));
    if (!ok) { errs.push(`${path}: ${types.join("|")} 이어야 하는데 ${actual}`); return errs; }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errs.push(`${path}: enum 밖의 값`);
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errs.push(`${path}: const 와 다름`);
  const alts = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null;
  if (alts && !alts.some((a) => validateJsonSchema(value, a, path).length === 0)) errs.push(`${path}: anyOf/oneOf 어느 것에도 맞지 않음`);
  if (isObj(value)) {
    const props = isObj(schema.properties) ? schema.properties : {};
    for (const k of Array.isArray(schema.required) ? schema.required.map(String) : []) if (!(k in value)) errs.push(`${path}.${k}: 필수 칸 없음`);
    for (const [k, sub] of Object.entries(props)) if (k in value) errs.push(...validateJsonSchema(value[k], sub, `${path}.${k}`));
    if (schema.additionalProperties === false) for (const k of Object.keys(value)) if (!(k in props)) errs.push(`${path}.${k}: 허용되지 않은 칸`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errs.push(`${path}: 항목이 ${schema.minItems}개 이상이어야 함`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errs.push(`${path}: 항목이 ${schema.maxItems}개 이하여야 함`);
    if (isObj(schema.items)) value.forEach((v, i) => errs.push(...validateJsonSchema(v, schema.items, `${path}[${i}]`)));
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errs.push(`${path}: ${schema.minLength}자 이상이어야 함`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errs.push(`${path}: ${schema.maxLength}자 이하여야 함`);
    if (typeof schema.pattern === "string") { try { if (!new RegExp(schema.pattern).test(value)) errs.push(`${path}: pattern 에 맞지 않음`); } catch { /* 잘못된 pattern 은 검사 안 함 */ } }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errs.push(`${path}: ${schema.minimum} 이상이어야 함`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errs.push(`${path}: ${schema.maximum} 이하여야 함`);
  }
  return errs.slice(0, 20);
}

/** (순수) 앱이 보낸 결과 스키마 검사 — 객체여야 하고 크기 상한 안. 틀리면 거절 문장. */
export function schemaInputError(schema: unknown): string | null {
  if (schema === undefined || schema === null) return null;
  if (!isObj(schema)) return "schema 는 JSON Schema 객체여야 합니다";
  if (JSON.stringify(schema).length > SCHEMA_MAX_BYTES) return `schema 가 너무 큽니다(${SCHEMA_MAX_BYTES.toLocaleString()}자 이하)`;
  return null;
}

export type FormatOutcome = { ok: true; json: unknown } | { ok: false; errors: string[] };
/** (순수) 끝난 출력을 스키마로 판정 — JSON 을 못 꺼내면 그것도 어긋남이다. */
export function judgeOutput(text: string, schema: Record<string, unknown> | null): FormatOutcome {
  if (!schema) return { ok: true, json: undefined };
  const json = extractJson(text);
  if (json === undefined) return { ok: false, errors: ["JSON 을 찾지 못함"] };
  const errors = validateJsonSchema(json, schema);
  return errors.length ? { ok: false, errors } : { ok: true, json };
}

/** (순수) 하루 토큰 상한을 넘었나 — 0 이면 끔. */
export function overDailyBudget(usedToday: number, policyLimit: number): boolean {
  return policyLimit > 0 && usedToday >= policyLimit;
}

/** (순수) 작업 컨테이너 작업 행 상태 → 실행 행 상태. */
export function runStatusOfJob(jobStatus: string): AiRunStatus {
  switch (jobStatus) {
    case "queued": return "queued";
    case "starting": case "running": return "running";
    case "done": return "done";
    case "canceled": return "canceled";
    default: return "failed";   // failed · timeout
  }
}

/** (순수) 요청 `wait` 초 — 숫자가 아니거나 0 이하면 0(기다리지 않음), 상한으로 접는다. */
export function waitSecOf(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), WAIT_MAX_SEC);
}
