// 앱 AI 실행 — 판정만(순수) (#4488 앱 v2-9). DB · LLM · 작업 컨테이너를 모른다. service.ts 가 사실을 모아 여기 묻는다.
//
//  설계(app-framework-v2-general-web-design §3-E · §4 · §5 · §12 ④·⑤-3·⑤-5):
//   · 입구 하나 `/_lively/ai/runs` — 앱은 작업 단위(프롬프트 · 결과 스키마 · 파일 · 작업 이름)로 보내고 실행 계정을 고르지 않는다.
//   · 실행 계정은 게이트웨이가 **작업별 > 앱별 > 워크스페이스 기본값** 순으로 고른다(resolveAccount).
//   · 실행 자리 = 작업 종류 × 실행 계정: 단발 + API 키 → LLM 프록시(컨테이너 없음) · 그 밖(단발+구독 · 에이전트 전부) → 작업 컨테이너(executorFor).
//   · 구독은 «그 사람 본인(그 세션의 AI 포함) · 그 사람 세션에 초대받아 함께 보는 사람» 의 요청에만(#4423 · 상민 2026-10-19) — subscriptionRefusal.
//     예외 하나 — 공용 시트(#5081 · 상민 2026-10-28): 관리자가 지정하고 그 계정 본인이 동의한 구독은 워크스페이스 구성원 누구의 요청이든 받는다.
//   · 결과 형식: 스키마를 보내면 프롬프트 끝에 형식 지시 → 끝난 출력 규칙 검사 → 어긋나면 «형식에 맞게 다시» 1회 → 그래도 어긋나면 원문 붙여 실패.
//   · 이어받기(#5101): 앱이 끝난 실행 하나의 대화를 이어받아 다시 시킨다(새 실행 행) — resumeRefusal · resumeInputError · resumeHistory(맨 아래).
export type AiRunStatus = "queued" | "running" | "done" | "failed" | "canceled";
export const isEndedRun = (s: string): boolean => s === "done" || s === "failed" || s === "canceled";

export type AiAccount = { kind: "api_key" } | { kind: "subscription"; member: string };

/**
 * 공용 시트 지정 한 줄(#5081) — 관리자 승인과 그 계정 본인의 동의. **둘 다 있어야** 켜진다(남의 개인 구독을 관리자가 혼자 공용으로 못 쓰게).
 *  한쪽이라도 거두면 줄째 지운다(serviceSeatChange) — 다시 켜려면 두 동의를 새로 받는다.
 */
export interface ServiceSeat {
  /** 관리자 승인 — 누가 · 언제(ISO). */
  admin?: { by: string; at: string };
  /** 그 계정 본인의 동의 — 언제(ISO). */
  member?: { at: string };
}

/** 워크스페이스 설정 한 칸(org_runtime_config.app_ai_account) — 기본 실행 계정 + 앱별·작업별 덮어쓰기 + 기본 모델 + 공용 시트. */
export interface AiAccountSettings {
  /** 워크스페이스 기본 실행 계정. 없으면 «API 키가 있으면 API 키» 로 접는다(resolveAccount 의 fallback). */
  default?: AiAccount;
  /** 단발 실행의 기본 모델(앱이 model 을 안 주면). 없으면 DEFAULT_MODEL. */
  default_model?: string;
  apps?: Record<string, { default?: AiAccount; jobs?: Record<string, AiAccount> }>;
  /** #5081 공용 시트 지정 — 구성원 id → 승인 · 동의. */
  service_seats?: Record<string, ServiceSeat>;
}

/** 프롬프트 상한(문자) — 작업 컨테이너의 PROMPT_MAX 와 같다(agent-jobs/plan.ts). */
export const PROMPT_MAX = 100_000;
export const SYSTEM_MAX = 20_000;
export const LABEL_MAX = 120;
export const SCHEMA_MAX_BYTES = 32_768;
export const JOB_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// MCP 입력 스키마 pattern 으로 그대로 나간다 — 클래스 안 [ 를 이스케이프하지 않으면 하네스 요청이 400(mcp-input-schema.test R6).
export const MODEL_RE = /^[a-z0-9][a-z0-9.\-\[\]]{1,63}$/i;
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
  if (isObj(o.service_seats)) {
    const seats: Record<string, ServiceSeat> = {};
    for (const [member, v] of Object.entries(o.service_seats)) {
      if (!member.trim() || !isObj(v)) continue;
      const seat: ServiceSeat = {};
      if (isObj(v.admin) && str(v.admin.by)?.trim() && str(v.admin.at)) seat.admin = { by: String(v.admin.by).trim(), at: String(v.admin.at) };
      if (isObj(v.member) && str(v.member.at)) seat.member = { at: String(v.member.at) };
      if (seat.admin || seat.member) seats[member] = seat;
    }
    if (Object.keys(seats).length) out.service_seats = seats;
  }
  return out;
}

/** (순수) 그 구성원의 공용 시트 지정이 두 동의(관리자 승인 · 본인 동의)를 다 받았나(#5081). */
export function serviceSeatConsented(s: AiAccountSettings, member: string): boolean {
  const seat = s.service_seats?.[member];
  return !!seat?.admin && !!seat?.member;
}

/**
 * 공용 시트 계정이 가져도 되는 권한 — 허용 목록이라 여기서 따로 정한다. 지금은 구성원 기본값(org/store/members.upsertMember)과 같은 셋이지만
 *  기본값이 넓어져도 이 셋은 함께 넓어지지 않는다(넓히려면 여기를 고친다). 그 밖(admin · runtime · db · db:<소스> · code)이 하나라도 있으면
 *  «높은 권한» 이다(seatElevated).
 */
export const SEAT_BASIC_SCOPES: ReadonlySet<string> = new Set(["items", "context", "memory"]);
/** (순수) 기본 권한 밖의 권한이 있나 — 공용 시트로 쓰지 않는 계정. */
export function seatElevated(scopes: readonly string[] | null | undefined): boolean {
  return (scopes ?? []).some((s) => !SEAT_BASIC_SCOPES.has(s));
}

/** 공용 시트 판정에 쓰는 그 계정의 사실 — service 가 설정과 구성원 표에서 모은다. */
export interface SeatFacts {
  /** 관리자 승인 + 본인 동의가 다 있나. */
  consented: boolean;
  /** 이 워크스페이스의 활성 사람 구성원인가. */
  active: boolean;
  /** 기본 권한(SEAT_BASIC_SCOPES) 밖의 권한이 있나(seatElevated). */
  elevated: boolean;
}

/**
 * (순수) 이 구독을 지금 공용으로 쓰나 — 두 동의 · 활성 사람 구성원 · **기본 권한뿐**(관리자 · 실행 · DB · 코드 권한 없음).
 *  높은 권한 계정은 공용으로 쓰지 않는다: 공용 시트 실행은 구성원 누구의 지시든 그 계정의 홈(Claude 로그인 · 그 계정이 사람 세션을 열면
 *  심기는 라이블리 토큰 · git 자격)에서 돈다. 같은 uid 라 운영체제 경계가 없어, 높은 권한 계정이면 지시 한 줄로 누구나 그 권한의 토큰에 닿는다.
 */
export function seatShared(f: SeatFacts | null | undefined): boolean {
  return !!f && f.consented && f.active && !f.elevated;
}

/** 공용 시트 한 줄의 상태 — 화면(관리탭 · 내 AI 계정)과 도구(app_ai_account)가 같은 말을 쓴다. */
export type SeatState = "on" | "admin_pending" | "member_pending" | "elevated" | "inactive" | "unknown";
/**
 * (순수) 공용 시트 한 줄의 상태 — «켜짐» 은 seatShared 와 같은 정의다(화면이 켜졌다는데 실행이 거절하는 어긋남이 없게).
 *  f = 그 계정의 사실(못 읽었으면 null → unknown).
 */
export function seatState(seat: ServiceSeat, f: { active: boolean; elevated: boolean } | null): SeatState {
  if (!f) return "unknown";
  const consented = !!seat.admin && !!seat.member;
  if (seatShared({ consented, active: f.active, elevated: f.elevated })) return "on";
  if (!f.active) return "inactive";
  if (f.elevated) return "elevated";
  return !seat.admin ? "admin_pending" : "member_pending";
}

/** 공용 시트 판정의 입력 — 그 계정의 사실 + 보낸 사람이 이 워크스페이스의 활성 사람 구성원인가(앱 서버가 실은 사람 신원이면 그 사람). */
export interface SeatTerms { facts: SeatFacts; requesterActive: boolean }

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
 *
 *  공용 시트(#5081 · 상민 2026-10-28 — seat 를 주고 seatShared 가 참일 때): 본인 · 초대 조건을 건너뛴다. 남는 조건은 둘이다 — 보낸 사람이 이 워크스페이스의
 *  활성 사람 구성원인가(seat.requesterActive) · 기계 세션에 매이지 않았나(tie). **앱 서버가 사람 신원을 실어 보낸 요청**(서명 신원 · 작업 돌기 신원 ·
 *  앱 선언 도구의 server 실행기)도 받는다 — 보낸 사람은 그 신원의 사람이다. 사람 신원이 없는 앱 서버 자체 호출 · 자동화(#4491)는 보낸 사람이
 *  구성원이 아니라(앱 서버 id) requesterActive 에서 걸린다. 작업 AI 자신의 토큰은 부르는 쪽(service.submitRun)이 그 전에 거절한다.
 *  ⚠ #4491 이 자동화를 «만든 사람 id + 앱 서버» 꼴로 열면 이 판정을 그대로 통과한다 — 그때 자동화 주체를 가르는 표지를 LivelyUser 에 두고
 *   여기서 거절해야 한다(«자동화는 계속 거절» · 상민 2026-10-28).
 */
/** 요청이 매인 세션(ctx.session)의 사실 — 주인 · 보낸 사람이 들어갈 수 있나 · 사람 세션인가(kind human — 위탁·상시·앱·로그인 세션이 아니다). */
export interface SessionTie { owner: string | null; participant: boolean; human: boolean }
const MACHINE_SESSION_REFUSAL = "이 요청이 매인 세션을 확인할 수 없거나 사람이 보는 세션이 아닙니다(위탁 · 상시 · 앱 세션) — 구독은 사람이 보는 세션에서만 쓸 수 있어요. 자동화는 워크스페이스 API 키가 필요합니다";
export function subscriptionRefusal(
  account: AiAccount, requester: { member: string; kind: "member" | "app_server" }, tie: SessionTie | null | undefined, seat?: SeatTerms | null,
): string | null {
  if (account.kind !== "subscription") return null;
  if (seat && seatShared(seat.facts)) {
    if (!seat.requesterActive) return `이 앱의 실행 계정은 공용 시트(${account.member})입니다 — 공용 시트는 이 워크스페이스의 활성 구성원이 보낸 요청에만 쓸 수 있어요(${requester.member} 은(는) 구성원으로 확인되지 않습니다)`;
    if (tie && (tie.owner === null || !tie.human)) return MACHINE_SESSION_REFUSAL;
    return null;
  }
  //  지정은 됐는데 높은 권한 때문에 공용으로 안 쓰는 계정 — 거절 문장에 까닭을 붙인다(그대로 두면 «초대받은 사람만» 으로 읽혀 무엇을 고칠지 모른다).
  const elevatedSeat = seat?.facts.consented && seat.facts.active && seat.facts.elevated
    ? ` ${account.member}님 계정은 공용 시트로 지정됐지만 높은 권한(관리자 · 실행 · DB · 코드)이 있어 공용으로 쓰지 않습니다 — 기본 권한(items · context · memory)만 가진 전용 계정을 공용 시트로 지정하세요.` : "";
  if (requester.kind !== "member") return `이 앱의 실행 계정은 ${account.member}님 구독입니다 — 구독은 사람이 보낸 요청에만 쓸 수 있어요. 앱 서버 · 자동화는 워크스페이스 API 키가 필요합니다(관리자와 그 계정 본인이 공용 시트로 지정한 구독은 앱 서버가 사람 신원을 실어 보낸 요청도 받습니다).${elevatedSeat}`;
  //  세션에 매인 요청인데 그 세션을 모르거나(fail-closed) 사람 세션이 아니면(위탁·크론 헤드리스 task · 상시 managed · 앱 · 로그인) 구독 주인 본인의 토큰이라도 거절 —
  //  사람 없이 구독이 도는 모양(#4423 · 격리 리뷰 blocking 1). 세션 헤더가 없는 본인 토큰은 가릴 길이 없어 본인으로 통과한다(머리말 한계 ③).
  if (tie && (tie.owner === null || !tie.human)) return MACHINE_SESSION_REFUSAL;
  if (requester.member === account.member) return null;
  if (tie && tie.owner === account.member && tie.participant) return null;
  return `이 앱의 실행 계정은 ${account.member}님 구독인데 ${requester.member}님이 보냈습니다 — 구독은 본인, 또는 ${account.member}님 세션에 초대받은 사람이 그 세션에서 보낸 요청에만 쓸 수 있어요(워크스페이스 API 키를 등록하면 누구의 요청이든 돕니다).${elevatedSeat}`;
}

/**
 * (순수) 실행 계정 설정을 바꿀 수 있나 — 바꿀 수 없으면 거절 문장. 두 축이다: **누구의 구독인가**(본인만 — 설계 §12 ④ 조건 ①, 관리자도 남의 구독을
 *  고르지 못한다) 와 **어느 자리를 바꾸나**(워크스페이스 기본값은 관리자만 · 앱별·작업별은 관리자 또는 그 앱의 책임자). 자리 규칙이 없으면 구성원 누구나
 *  워크스페이스 기본값이나 아무 앱의 실행 계정을 자기 구독으로 덮어 다른 모두의 AI 실행을 막을 수 있다(격리 리뷰 blocking 2).
 *  API 키 · 해제도 같은 자리 규칙을 탄다(워크스페이스 = 관리자 · 앱 = 관리자 또는 책임자).
 *  #5081 공용 시트(nextShared — 고르려는 구독이 지금 공용으로 켜져 있나)는 **관리자도** 건다 — 그 계정 본인이 이미 공용으로 동의했다. 앱 책임자는 못 건다
 *   (공용 시트를 어느 앱이 쓰는지는 관리자가 정한다 — 약관 회색 · headless-credential-anthropic-terms-judgment-4423 2c).
 */
export function accountSetRefusal(next: AiAccount | null, actor: { member: string; admin: boolean }, scope: { appId: string | null; appOwner: boolean }, nextShared = false): string | null {
  if (next?.kind === "subscription" && next.member !== actor.member && !(nextShared && actor.admin)) {
    if (nextShared) return `공용 시트(${next.member})를 실행 계정으로 거는 것은 관리자만 할 수 있습니다`;
    return `구독 실행 계정은 그 사람 본인만 걸 수 있습니다 — ${next.member}님이 직접 설정해야 해요(관리자와 그 계정 본인이 공용 시트로 지정한 구독은 관리자도 걸 수 있습니다)`;
  }
  if (!scope.appId) {
    if (!actor.admin) return "워크스페이스 기본 실행 계정은 관리자만 바꿀 수 있습니다 — 구성원은 자기가 책임자인 앱에만 자기 구독을 걸 수 있어요";
    return null;
  }
  if (!actor.admin && !scope.appOwner) return `앱 '${scope.appId}' 의 실행 계정은 관리자나 그 앱의 책임자만 바꿀 수 있습니다`;
  return null;
}

/** 공용 시트로 지정하려는 계정의 사실(구성원 표에서) — elevated = 기본 권한 밖의 권한이 있나(seatElevated). */
export interface SeatTarget { member: string; exists: boolean; active: boolean; human: boolean; elevated: boolean }

/**
 * (순수) 공용 시트 지정 바꾸기(#5081) — 관리자는 승인을, 그 계정 본인은 동의를 적는다. 둘 다 있어야 켜진다(serviceSeatConsented).
 *  · 켜기: 관리자가 남을 → 승인 줄 · 본인이 → 동의 줄(먼저 해도 된다 — 순서는 상관없다). 그 밖의 사람은 거절.
 *    대상은 활성 사람 구성원이어야 하고 **기본 권한뿐이어야** 한다(seatShared 머리말 — 구성원 누구의 지시든 그 홈에서 돈다).
 *    그래서 관리자가 자기 계정을 혼자 지정하는 길은 없다 — 승인과 동의는 늘 다른 두 사람이다.
 *    이미 그 사람의 줄이 있으면(다시 승인 · 다시 동의) 그대로 둔다 — 시각 · 승인한 관리자를 덮지 않고, 감사도 남지 않는다(바뀐 것 없음).
 *  · 끄기: 관리자나 본인 누구든 → 줄째 지운다(두 동의가 다 사라진다 · 다시 켜려면 둘 다 새로). 구성원 표에서 지워진 계정의 줄도 지운다 —
 *    보통은 비활성 · 삭제 때 회수가 지우지만(apps/member-deactivation), 그 전에 지워졌거나 회수가 실패한 줄이 남을 수 있다.
 *  돌려주는 것: 적을 다음 줄(null = 지운다) 또는 거절(HTTP 상태 + 문장).
 */
export function serviceSeatChange(
  cur: ServiceSeat | undefined, actor: { member: string; admin: boolean }, target: SeatTarget, on: boolean, nowIso: string,
): { next: ServiceSeat | null } | { status: number; refusal: string } {
  const self = actor.member === target.member;
  if (!self && !actor.admin) return { status: 403, refusal: "공용 시트 지정은 관리자와 그 계정 본인만 바꿀 수 있습니다" };
  if (!on) return { next: null };
  if (!target.exists) return { status: 404, refusal: `구성원 없음: ${target.member}` };
  if (!target.active || !target.human) return { status: 409, refusal: `${target.member} 은(는) 활성 사람 구성원이 아닙니다 — 공용 시트는 활성 사람 구성원 계정만 될 수 있습니다` };
  if (target.elevated) {
    return { status: 409, refusal: `${target.member} 계정은 높은 권한(관리자 · 실행 · DB · 코드)이 있어 공용 시트로 지정할 수 없습니다 — 공용 시트로 도는 작업은 구성원 누구의 지시든 그 계정의 홈(로그인 · 토큰)에서 돌아, 누구나 그 권한에 닿습니다. 기본 권한(items · context · memory)만 가진 전용 계정을 지정하세요` };
  }
  if (self) return { next: cur?.member ? cur : { ...cur, member: { at: nowIso } } };
  return { next: cur?.admin ? cur : { ...cur, admin: { by: actor.member, at: nowIso } } };
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

// ── 이어받기(#5101 앱 v2-44 · 상민 2026-10-28 «A — app_ai_run 에 resume_run_id») ──
//  앱 서버가 끝난 답을 결정적으로 검사하고(인용한 근거 id 가 조회 결과에 있나 · 숫자가 원문에 있나) 어긋나면 그 대화를 이어받아 사유를 붙여 다시 시킨다.
//  이어받은 실행은 **새 실행 행**이다(앞 실행의 결과는 그대로 남는다) — 어느 실행을 이어받았나(of) · 그 질문의 처음 실행(root) · 몇 번째인가(depth) · 까닭(reason).
//  실행 계정 · 작업 종류 · 실행 자리 · 작업 폴더 · 작업 이름 · system 은 앞 실행 것을 그대로 쓴다(대화가 그 자리에 있다). 횟수는 앱이 정하고(다시 보낼지),
//  게이트웨이는 한 질문(root)당 상한(정책 max_resumes)을 건다. 작업 컨테이너는 앞 대화를 갈라서 잇는다(--fork-session — 앞 대화 파일은 그대로).

/** 이어받는 까닭(실행 기록의 이름표) 상한 — capabilities/soft-cap 의 app_ai_run.reason 과 같은 수. */
export const RESUME_REASON_MAX = 300;

/** 이 실행이 이어받은 실행(of) · 그 질문의 처음 실행(root) · 몇 번째 이어받기인가(depth ≥ 1) · 까닭(앱이 준 이름표 · 없으면 null). */
export interface ResumeLink { of: number; root: number; depth: number; reason: string | null }

/** 이어받기 거절 — HTTP 상태 · 짧은 코드(응답 body.code) · 사람이 읽을 문장. */
export interface ResumeRefusal { status: number; code: string; message: string }

/**
 * (순수) 이 실행을 이어받을 수 있나 — 안 되면 거절, 되면 null.
 *  순서: 없음 · 남이 보낸 실행 · 다른 앱의 실행(404 — 있는지 드러내지 않는다 · 관리자 · 구독 주인도 남의 실행은 못 잇는다) → 꺼짐(정책 0)
 *   → 아직 끝나지 않음 → 취소됨 · 이을 대화가 없음 → 한 질문당 상한.
 *  conversation = 이을 대화가 남아 있나(단발 프록시면 앞 답 글 · 작업이면 작업 행의 대화 id 와 — API 키 작업이면 — 게이트웨이가 보관한 대화 기록).
 *  noConversationWhy = 대화가 없을 때 덧붙일 까닭(예: API 키 작업의 대화 기록 보존 기간).
 */
export function resumeRefusal(
  parent: { status: string; app_id: string; requester: string } | null,
  o: { requester: string; appId: string; conversation: boolean; noConversationWhy?: string | null; resumesOfRoot: number; maxResumes: number },
): ResumeRefusal | null {
  if (!parent || parent.requester !== o.requester || parent.app_id !== o.appId) {
    return { status: 404, code: "resume_not_found", message: "이어받을 실행이 없습니다 — 이 앱에서 내가 보낸 실행만 이어받을 수 있어요" };
  }
  if (!(o.maxResumes > 0)) {
    return { status: 409, code: "resume_disabled", message: "이 워크스페이스는 이어받기를 껐습니다(app_ai_limits 의 max_resumes 가 0) — 새 실행으로 보내세요" };
  }
  if (!isEndedRun(parent.status)) {
    return { status: 409, code: "resume_not_ended", message: `아직 끝나지 않은 실행입니다(지금 ${parent.status}) — 끝난 뒤 이어받으세요` };
  }
  if (parent.status === "canceled") {
    return { status: 409, code: "resume_not_resumable", message: "취소된 실행은 이어받을 수 없습니다 — 새 실행으로 보내세요" };
  }
  if (!o.conversation) {
    return { status: 409, code: "resume_not_resumable", message: `이어받을 대화가 남아 있지 않습니다${o.noConversationWhy ? `(${o.noConversationWhy})` : ""} — 새 실행으로 보내세요` };
  }
  if (o.resumesOfRoot >= o.maxResumes) {
    return { status: 409, code: "resume_limit", message: `이 질문은 이미 ${o.resumesOfRoot}번 이어받았습니다(한 질문당 상한 ${o.maxResumes}번 — app_ai_limits 의 max_resumes) — 새 실행으로 보내세요` };
  }
  return null;
}

/**
 * (순수) 이어받기 요청이 앞 실행과 어긋나나 — 어긋나면 400 문장, 맞으면 null. 이어받기는 앞 실행의 대화 자리를 그대로 쓴다:
 *  작업 이름(실행 계정을 고르는 열쇠) · system(대화의 시스템 지시) · 작업 종류(단발 대화를 에이전트로 바꾸지 않는다) · 작업 폴더(대화 기록이 그 자리에 있다).
 *  같은 값을 다시 보내는 것은 받는다(앱 서버가 같은 요청 꼴에 resume_run_id 만 더해 보내도 되게).
 */
export function resumeInputError(
  input: { job?: unknown; system?: unknown; files?: unknown; project_id?: unknown; cwd?: unknown; agent?: unknown },
  parent: { job_name: string | null; system_prompt: string | null; kind: RunKind },
  parentProjectId: number | null,
): string | null {
  const given = (v: unknown): boolean => v !== undefined && v !== null && v !== "";
  if (given(input.job) && String(input.job).trim() !== (parent.job_name ?? "")) {
    return "job 은 이어받는 실행과 같아야 합니다(이어받기는 앞 실행의 작업 이름 · 실행 계정을 그대로 씁니다) — job 을 빼세요";
  }
  if (typeof input.system === "string" && input.system.trim() && input.system.trim() !== (parent.system_prompt ?? "")) {
    return "system 은 바꿀 수 없습니다(이어받는 대화는 처음 실행의 시스템 지시를 그대로 씁니다) — 고칠 점은 prompt 에 적으세요";
  }
  if (parent.kind === "single" && runKindOf(input) === "agent") {
    return "단발 실행은 에이전트 작업으로 이어받을 수 없습니다 — files · project_id · agent 를 빼세요(에이전트로 다시 하려면 새 실행으로)";
  }
  if (given(input.project_id) && Number(input.project_id) !== parentProjectId) {
    return "이어받기는 앞 실행의 작업 폴더에서 돕니다 — project_id 를 빼세요";
  }
  return null;
}

/** (순수) 이어받은 실행의 기본 이름표 — 앞 실행 이름표 끝의 «(이어받기 n)» 은 떼고 새 번호를 붙인다. */
export function resumeLabel(parentLabel: string | null, rootId: number, depth: number): string {
  const base = (parentLabel ?? "").replace(/\s*\(이어받기 \d+\)\s*$/, "").trim() || `AI 실행 #${rootId}`;
  return `${base} (이어받기 ${depth})`.slice(0, LABEL_MAX);
}

/** 단발(프록시) 대화 한 칸 — Anthropic Messages 의 messages 한 줄. */
export interface ChatTurn { role: "user" | "assistant"; content: string }
/**
 * (순수) 단발 실행을 이어받을 때 앞 대화 — 처음 실행부터 이어받는 실행까지 차례로 «보낸 지시(+형식 지시) → 받은 답» 두 칸씩.
 *  답 글이 없는 실행이 끼면 null(이을 대화가 없다). 형식 재시도(«형식에 맞게 다시») 칸은 넣지 않는다 — 각 실행의 마지막 답이 앱이 검사한 답이다.
 */
export function resumeHistory(chain: ReadonlyArray<{ prompt: string; schema: Record<string, unknown> | null; result: Record<string, unknown> | null }>): ChatTurn[] | null {
  const out: ChatTurn[] = [];
  for (const r of chain) {
    const text = typeof r.result?.text === "string" ? r.result.text : "";
    if (!text.trim()) return null;
    out.push({ role: "user", content: r.prompt + (r.schema ? schemaInstruction(r.schema) : "") }, { role: "assistant", content: text });
  }
  return out.length ? out : null;
}
