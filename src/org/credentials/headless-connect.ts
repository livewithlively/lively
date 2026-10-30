// 사람 없이 도는 작업의 자격 — **저장 · 상태 · 실패 알림** (#4012 T12 · #4051).
//
//  화면에서 발급한 자격(terminal/headless-login-run)을 멤버 비밀로 저장하고, 워크스페이스 실행 멤버가 **한 번도 정해진 적
//  없으면** 그 사람으로 채운다. 그리고 맥락 잡이 자격 때문에 멈추면 그 사실을 **그 멤버의 화면**으로 올린다 — 종전엔
//  `no_credential` 이 잡 요약 안쪽에만 남고 잡 겉상태는 초록이라(증류·분류·관리 액션은 늘 ok 를 돌려준다), 증류가
//  며칠째 0건이어도 아무도 몰랐다.
//
//  ── 기본 실행 멤버를 누가 채우나 ──
//   · 채우는 것은 **관리자**가 연결했을 때뿐이다. 실행 멤버는 워크스페이스의 모든 맥락 잡이 **그 사람 구독으로** 돈다는
//     뜻이라, 팀 워크스페이스에서 일반 멤버가 먼저 연결했다고 그 사람 계정으로 과금되게 두면 안 된다(그 사람은 되돌릴
//     권한도 없다). 개인 워크스페이스의 주인은 관리자다 — «첫 사용자도 혼자» 가 그대로 성립한다.
//   · **한 번도 정해진 적 없을 때만** 채운다. 관리자가 비워 둔 것(DB 에 명시적 null)은 결정이므로 건드리지 않는다
//     (context-job-policy 머리말 — 비운 것이 되살아나면 사람이 끈 것이 안 꺼진다). env 시드가 있으면 그것이 값이다.
//   · ★ «관리자» 는 헤드리스 경로의 한 벌(headlessAdminFor)로 잰다 — 토큰(세션)의 admin 이거나 **구성원의 실제 역할**이
//     admin 이면 관리자다(데스크톱 기기 토큰엔 admin 이 없다 — 실측 2026-09-17). 정적·앱 토큰은 안 된다.
import { HEADLESS_LABEL, HEADLESS_LOGIN_HARNESSES, HEADLESS_SECRET_KIND, isSetupTokenShaped, type HeadlessLoginHarness } from "../../terminal/headless-login-flow.js";
import { parseCodexAuth } from "./codex-auth.js";

// ── 관리자 판정 ───────────────────────────────────────────────────────────────

/** (순수) 구성원 기록이 «지금» 관리자인가 — 활성 + admin 역할. 모르는 모양이면 아니다. */
export function isActiveAdminMember(m: { state?: unknown; scopes?: unknown } | null | undefined): boolean {
  return !!m && m.state === "active" && Array.isArray(m.scopes) && m.scopes.includes("admin");
}

/**
 * 이 구성원이 지금 관리자인가 — **로그인 토큰의 권한이 아니라 구성원의 실제 역할**(org_member)로 잰다.
 *
 *  ⚠ 왜(실측 2026-09-17, lively-46e3): 관리자인 상민님이 연결했는데 기본 실행 멤버가 안 정해졌다. 같은 조건의 실 DB
 *   재현에서 요청 주체가 비관리자일 때와 결과가 똑같았다(`not-admin`). 데스크톱 앱은 기기 코드 로그인(`lively login`)의
 *   토큰으로 화면을 띄우는데, 그 토큰은 «관리 권한 포함» 을 따로 승인하지 않으면 admin·runtime 을 뺀다
 *   (device-auth grantableScopes). 그래서 **관리자 본인도 데스크톱에서는 관리자가 아니었다** — 첫 사용자가 혼자 못 끝낸다.
 *  이 판정이 여는 것은 하나뿐이다: **자기 자신을, 한 번도 정해진 적 없는 실행 멤버 자리에** 앉히기
 *   (fillContextJobRunnerIfUnset). 기기 토큰이 관리 권한을 빼는 까닭(에이전트가 org_* 관리 기능을 못 쓰게)과 부딪히지
 *   않는다 — 임의 설정 변경이 아니고, 비관리자 구성원은 여전히 안 되며, 이미 정해졌거나 관리자가 비운 자리는 그대로다.
 *  못 읽으면 false(닫힌 쪽 — 저장은 그대로 성공한다).
 */
export async function memberIsAdminNow(
  memberId: string,
  lookup?: (id: string) => Promise<{ state?: unknown; scopes?: unknown } | null>,
): Promise<boolean> {
  try {
    const get = lookup ?? (async (id: string) => (await import("../store/members.js")).getMember(id));
    return isActiveAdminMember(await get(memberId));
  } catch {
    return false;
  }
}

/**
 * 헤드리스 경로의 «관리자인가» — **한 벌**(연결 저장 · 상태 조회 · 화면 정하기가 모두 이것만 부른다).
 *  · 회수할 수 없는 정적 토큰(AUTH_TOKENS_JSON)과 앱 세션 토큰은 이 정책 쓰기를 못 한다 — web.ts 의 B5(정적 토큰의
 *    관리·런타임 변경 금지) · requireAppTool(앱 grant 축소)과 같은 선이다(리뷰 #4051).
 *  · 그 밖에는 **토큰(세션)이 admin 이거나, 구성원의 실제 역할이 admin** 이면 관리자다. 합집합이라 종전(토큰 판정)보다
 *    좁아지지 않는다 — 셀프호스트 다중 워크스페이스의 보조 워크스페이스에선 구성원 조회가 비어 올 수 있어(신원 표는 상수
 *    테넌트에 못박혀 있다) 토큰 판정이 받친다(리뷰 #4051).
 */
export async function headlessAdminFor(
  user: { tokenSource?: unknown; appId?: unknown; scopes?: unknown },
  memberId: string,
  lookup?: (id: string) => Promise<{ state?: unknown; scopes?: unknown } | null>,
): Promise<boolean> {
  return adminFromBasis(headlessAdminBasis(user), memberId, lookup);
}

/**
 * 관리자 판정의 **근거** — 위 판정을 «토큰에서 읽는 부분» 과 «구성원 역할을 읽는 부분» 으로 가른 것(#4067).
 *  CP 로그인 판은 결과를 **사용자 토큰 없이** 넘긴다. 그래서 시작 요청이 근거를 적어 두고(org_login_job.admin_basis)
 *  결과가 올 때 adminFromBasis 로 잰다 — 구성원 역할은 그때 다시 읽는다(시작과 결과 사이에 바뀌었으면 결과 때의 역할).
 *  · none   — 정적·앱 토큰(관리자일 수 없다)
 *  · token  — 토큰(세션)이 admin
 *  · member — 그 밖: 구성원의 실제 역할로 잰다
 */
export type HeadlessAdminBasis = "none" | "token" | "member";
export const HEADLESS_ADMIN_BASES: readonly HeadlessAdminBasis[] = Object.freeze(["none", "token", "member"]);

export function headlessAdminBasis(user: { tokenSource?: unknown; appId?: unknown; scopes?: unknown }): HeadlessAdminBasis {
  if (user.tokenSource === "static" || user.appId) return "none";
  if (Array.isArray(user.scopes) && user.scopes.includes("admin")) return "token";
  return "member";
}

/** 근거로 판정한다. 모르는 근거는 관리자가 아니다(닫힌 쪽). */
export async function adminFromBasis(
  basis: unknown,
  memberId: string,
  lookup?: (id: string) => Promise<{ state?: unknown; scopes?: unknown } | null>,
): Promise<boolean> {
  if (basis === "token") return true;
  if (basis === "member") return memberIsAdminNow(memberId, lookup);
  return false;
}

// ── «연결됨» — 한 벌 ─────────────────────────────────────────────────────────

type SecretRow = { kind: string; scope_key?: string | null; has_secret?: boolean | null };

/** (순수) 이 하네스의 헤드리스 자격 행(기본 칸). 없으면 undefined. */
export function headlessCredentialRow<T extends SecretRow>(rows: readonly T[], h: HeadlessLoginHarness): T | undefined {
  return rows.find((x) => x.kind === HEADLESS_SECRET_KIND[h] && (x.scope_key ?? "") === "");
}

/**
 * (순수) 판(중앙 샌드박스)이 빌릴 헤드리스 자격이 하나라도 있나.
 *  화면의 «연결됨»(버튼이 뜨는 조건)과 서버의 409(자격 없는 멤버를 앉히지 않는다)가 **같은 규칙**이어야 한다 —
 *  둘이 갈리면 버튼은 뜨는데 누르면 거절된다(리뷰 #4051).
 */
export function hasHeadlessCredential(rows: readonly SecretRow[]): boolean {
  return HEADLESS_LOGIN_HARNESSES.some((h) => !!headlessCredentialRow(rows, h)?.has_secret);
}

// ── 저장 ─────────────────────────────────────────────────────────────────────

export type RunnerFill =
  | "filled"        // 비어 있어서 이 사람으로 채웠다
  | "already-set"   // 이미 누군가로 정해져 있다(이 사람일 수도 있다)
  | "cleared"       // 관리자가 비워 둔 상태다 — 결정이므로 두었다
  | "not-admin"     // 관리자가 아니라 워크스페이스 기본값을 바꾸지 않았다
  | "error";        // 설정을 못 읽거나 못 썼다(저장 자체는 성공)

/**
 * (순수) 기본 실행 멤버를 채울지.
 *  source 는 context_job_policy 의 출처(db · env · default) — `default` 만 «한 번도 정해진 적 없음» 이다.
 */
export function decideRunnerFill(o: { current: string | null; source: "db" | "env" | "default"; isAdmin: boolean }): Exclude<RunnerFill, "filled" | "error"> | "fill" {
  if (o.current) return "already-set";
  if (o.source === "db") return "cleared";
  if (!o.isAdmin) return "not-admin";
  return "fill";
}

/** (순수) 저장 직전 검사 — 러너가 잡은 값이 그 하네스 자격의 모양인가. 틀리면 사람에게 보일 한 줄. */
export function validateHeadlessSecret(h: HeadlessLoginHarness, raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const v = String(raw ?? "").trim();
  if (!v) return { ok: false, error: "받은 자격이 비어 있어요." };
  if (h === "claude") {
    return isSetupTokenShaped(v) ? { ok: true, value: v } : { ok: false, error: "받은 토큰의 모양이 예상과 달라요. 다시 시도해 주세요." };
  }
  return parseCodexAuth(v) ? { ok: true, value: v } : { ok: false, error: "받은 ChatGPT 로그인 파일을 읽을 수 없어요. 다시 시도해 주세요." };
}

export interface StoreDeps {
  /** 기존 행(label·meta 보존용). */
  current(owner: string, kind: string): Promise<{ label: string | null; meta: Record<string, unknown> } | null>;
  store(owner: string, kind: string, secret: string, label: string | null, meta: Record<string, unknown>, actor: string): Promise<void>;
  policy(): Promise<{ current: string | null; source: "db" | "env" | "default" }>;
  /** 원자적으로 «정해진 적 없을 때만» 채운다. 채웠으면 true. */
  fillRunner(memberId: string, actor: string): Promise<boolean>;
  now(): Date;
}

async function defaultStoreDeps(): Promise<StoreDeps> {
  const store = await import("./member-secret-store.js");
  const rc = await import("../store/runtime-config.js");
  return {
    current: async (owner, kind) => {
      const row = (await store.listMemberSecretsPublic(owner)).find((c) => c.kind === kind && c.scope_key === "");
      return row ? { label: row.label ?? null, meta: (row.meta ?? {}) as Record<string, unknown> } : null;
    },
    store: async (owner, kind, secret, label, meta, actor) => {
      await store.setMemberSecret(owner, kind, "", { secret, label, meta }, actor);
    },
    policy: async () => ({
      current: (await rc.getRuntimeConfig()).context_job_policy?.runner_member ?? null,
      source: await rc.getContextJobPolicySource(),
    }),
    fillRunner: (memberId, actor) => rc.fillContextJobRunnerIfUnset(memberId, actor, "headless-connect"),
    now: () => new Date(),
  };
}

export type StoreOutcome =
  | { ok: true; kind: string; runner: RunnerFill }
  | { ok: false; error: string };

/**
 * 화면에서 받은 헤드리스 자격을 저장한다. **던지지 않는다** — 실패는 사람에게 보일 한 줄로 돌려준다.
 *  ⚠ 비밀값은 어디에도 로그로 남기지 않는다(오류 문구에도 싣지 않는다).
 */
export async function storeHeadlessCredential(
  o: { memberId: string; harness: HeadlessLoginHarness; secret: string; actor: string; isAdmin: boolean },
  inject: Partial<StoreDeps> = {},
): Promise<StoreOutcome> {
  const checked = validateHeadlessSecret(o.harness, o.secret);
  if (!checked.ok) return checked;
  const complete = inject.current && inject.store && inject.policy && inject.fillRunner && inject.now;
  const d = { ...(complete ? {} : await defaultStoreDeps()), ...inject } as StoreDeps;
  const owner = `member:${o.memberId}`;
  const kind = HEADLESS_SECRET_KIND[o.harness];
  try {
    const cur = await d.current(owner, kind).catch(() => null);
    //  label·meta 는 **보존**한다 — setMemberSecret 은 둘 다 통째로 바꾼다(사람이 붙인 이름이 사라지지 않게).
    //   어디서 왔는지는 meta 에 남긴다(화면 발급 · 시각) — 등록 화면이 «화면에서 연결함» 을 말할 근거다.
    await d.store(owner, kind, checked.value, cur?.label ?? null,
      { ...(cur?.meta ?? {}), issued_via: "screen", issued_at: d.now().toISOString() }, o.actor);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    //  암호화 키 미설정 등 — 그 문장은 비밀을 담지 않는다.
    return { ok: false, error: `자격을 저장하지 못했어요 — ${msg.slice(0, 160)}` };
  }
  let runner: RunnerFill = "error";
  try {
    const p = await d.policy();
    const v = decideRunnerFill({ current: p.current, source: p.source, isAdmin: o.isAdmin });
    runner = v === "fill" ? (await d.fillRunner(o.memberId, o.actor) ? "filled" : "already-set") : v;
  } catch { /* 저장은 끝났다 — 기본값 채우기 실패로 사람을 막지 않는다 */ }
  return { ok: true, kind, runner };
}

export interface ClaimDeps {
  /** 이 멤버에게 판(중앙 샌드박스)이 빌릴 헤드리스 자격이 하나라도 있나(hasHeadlessCredential). */
  hasCredential(memberId: string): Promise<boolean>;
  policy: StoreDeps["policy"];
  fillRunner: StoreDeps["fillRunner"];
}

export type ClaimOutcome =
  | { ok: true; runner: Exclude<RunnerFill, "not-admin" | "error"> }
  | { ok: false; status: 403 | 409; error: string };

/**
 * 화면의 [이 워크스페이스의 실행 멤버로 정하기] — 연결은 됐는데 실행 멤버가 비어 있을 때(예: 예전 판에서 연결했거나
 *  채우기가 실패했을 때) 사람이 스스로 마무리하는 길이다. 연결 저장의 자동 채우기와 **같은 규칙**이다:
 *  · 대상은 언제나 **요청한 본인**이다(다른 멤버 id 를 받지 않는다).
 *  · 관리자여야 한다 — 판정은 요청의 토큰을 보는 경로가 headlessAdminFor 로 해서 넘긴다(정적·앱 토큰 제외).
 *  · 헤드리스 자격이 있어야 한다 — 자격 없는 멤버를 앉히면 모든 맥락 잡이 `no_credential` 로 멈춘다.
 *  · 한 번도 정해진 적 없을 때만 채운다(관리자가 비운 자리 · 이미 정해진 자리는 그대로 — 결과로 말한다).
 */
export async function claimRunnerFromScreen(
  o: { memberId: string; actor: string; isAdmin: boolean },
  inject: Partial<ClaimDeps> = {},
): Promise<ClaimOutcome> {
  if (!o.isAdmin) {
    return { ok: false, status: 403, error: "관리자만 이 워크스페이스의 실행 멤버를 정할 수 있어요." };
  }
  const complete = inject.hasCredential && inject.policy && inject.fillRunner;
  const d = { ...(complete ? {} : await defaultClaimDeps()), ...inject } as ClaimDeps;
  if (!(await d.hasCredential(o.memberId))) {
    return { ok: false, status: 409, error: "먼저 Claude 나 ChatGPT(Codex) 를 연결해 주세요 — 자격이 없는 계정으로 정하면 작업이 멈춥니다." };
  }
  const p = await d.policy();
  const v = decideRunnerFill({ current: p.current, source: p.source, isAdmin: true });
  switch (v) {
    case "fill": return { ok: true, runner: (await d.fillRunner(o.memberId, o.actor)) ? "filled" : "already-set" };
    case "already-set":
    case "cleared": return { ok: true, runner: v };
    default: return { ok: false, status: 403, error: "관리자만 이 워크스페이스의 실행 멤버를 정할 수 있어요." };   // 위에서 걸렀다
  }
}

async function defaultClaimDeps(): Promise<ClaimDeps> {
  const store = await import("./member-secret-store.js");
  const rc = await import("../store/runtime-config.js");
  const base = await defaultStoreDeps();
  return {
    hasCredential: async (id) => hasHeadlessCredential(await store.listMemberSecretsPublic(`member:${id}`)),
    policy: base.policy,
    //  감사 출처를 자동 채우기("headless-connect")와 가른다 — 둘 중 어느 길이 정했는지가 진단의 시작이다(리뷰 #4051).
    fillRunner: (memberId, actor) => rc.fillContextJobRunnerIfUnset(memberId, actor, "headless-claim"),
  };
}

// ── 상태 ─────────────────────────────────────────────────────────────────────

/** 자격 때문에 멈춘 맥락 잡 한 건(가장 최근). */
export interface HeadlessFailure {
  at: string;
  /** no_credential(자격 없음) · auth_failure(인증 실패). */
  reason: "no_credential" | "auth_failure";
  /** 사람에게 보일 한 줄. */
  message: string;
  task_id: number;
}

export interface HeadlessRow {
  key: HeadlessLoginHarness;
  label: string;
  kind: string;
  connected: boolean;
  /** 마지막으로 연결(저장)한 시각. */
  connected_at: string | null;
  /** 화면에서 연결했나(issued_via=screen) · 토큰을 붙여넣었나 · 모름. */
  via: "screen" | "token" | null;
  /** 연결 **이후에** 난 자격 실패(연결 전 실패는 이미 해결된 것이다). */
  failure: HeadlessFailure | null;
}

export interface HeadlessStatus {
  harnesses: HeadlessRow[];
  runner: {
    /** 워크스페이스 실행 멤버(없으면 null — 잡을 만든 사람 명의로 돈다). */
    member: string | null;
    name: string | null;
    source: "db" | "env" | "default";
    is_me: boolean;
  };
  /** 이 사람이 실행 멤버를 바꿀 수 있나(관리자). 화면이 안내 문구를 가른다. */
  can_set_runner: boolean;
}

interface FailureRowRaw { id: number; harness: string | null; finished_at: string | Date | null; reason: string | null; auth_label: string | null }

/** (순수) 실패 행 → 하네스별 가장 최근 실패. 그 하네스 자격을 **그 뒤에** 다시 연결했으면 지운다. */
export function pickFailures(rows: FailureRowRaw[], connectedAt: Partial<Record<string, string | null>>): Partial<Record<HeadlessLoginHarness, HeadlessFailure>> {
  const out: Partial<Record<HeadlessLoginHarness, HeadlessFailure>> = {};
  for (const r of rows) {
    const h = String(r.harness ?? "claude");
    if (!(HEADLESS_LOGIN_HARNESSES as readonly string[]).includes(h)) continue;
    const key = h as HeadlessLoginHarness;
    if (out[key]) continue;                       // 최신순으로 들어온다 — 첫 행이 가장 최근
    const at = r.finished_at ? new Date(r.finished_at) : null;
    if (!at || Number.isNaN(at.getTime())) continue;
    const since = connectedAt[key] ? new Date(String(connectedAt[key])).getTime() : 0;
    if (since && at.getTime() <= since) continue;  // 다시 연결했다 — 지난 실패는 해결됐다
    const reason = r.reason === "no_credential" ? "no_credential" : "auth_failure";
    out[key] = {
      at: at.toISOString(), reason, task_id: r.id,
      message: reason === "no_credential"
        ? `${HEADLESS_LABEL[key]} 자격이 연결돼 있지 않아 사람 없이 도는 작업을 실행하지 못했어요.`
        : `${HEADLESS_LABEL[key]} 인증에 실패해 사람 없이 도는 작업이 멈췄어요${r.auth_label ? ` (${r.auth_label})` : ""}.`,
    };
  }
  return out;
}

/** 이 멤버가 **실행 신원이었던** 맥락 잡의 자격 실패(최근 30일, 최신순). DB 가 없으면 빈 목록. */
async function recentFailures(memberId: string): Promise<FailureRowRaw[]> {
  try {
    const { itemsPool } = await import("../../db/client.js");
    const r = await itemsPool.query(
      `SELECT id, harness, finished_at, result->>'reason' AS reason, result->'auth_failure'->>'label' AS auth_label
         FROM org_task
        WHERE requester = $1 AND status = 'failed'
          AND finished_at > now() - interval '30 days'
          AND (result->>'reason' = 'no_credential' OR result -> 'auth_failure' IS NOT NULL)
        ORDER BY finished_at DESC NULLS LAST, id DESC
        LIMIT 20`, [memberId]);
    return r.rows as FailureRowRaw[];
  } catch {
    return [];   // org_task 부재 등 — 화면이 이것 때문에 죽으면 안 된다
  }
}

/** [내 AI 계정] «사람 없이 도는 작업» 행이 읽는 한 벌. */
export async function headlessStatusFor(user: { memberId: string; isAdmin: boolean }): Promise<HeadlessStatus> {
  const store = await import("./member-secret-store.js");
  const rc = await import("../store/runtime-config.js");
  const creds = await store.listMemberSecretsPublic(`member:${user.memberId}`).catch(() => []);
  const connectedAt: Record<string, string | null> = {};
  const rowsBase = HEADLESS_LOGIN_HARNESSES.map((h) => {
    const c = headlessCredentialRow(creds, h);
    const at = c?.updated_at ? new Date(c.updated_at as unknown as string).toISOString() : null;
    connectedAt[h] = c?.has_secret ? at : null;
    const via = !c?.has_secret ? null : ((c.meta ?? {}) as Record<string, unknown>).issued_via === "screen" ? "screen" : "token";
    return { key: h, label: HEADLESS_LABEL[h], kind: HEADLESS_SECRET_KIND[h], connected: !!c?.has_secret, connected_at: connectedAt[h], via } as const;
  });
  const failures = pickFailures(await recentFailures(user.memberId), connectedAt);
  let member: string | null = null;
  let source: "db" | "env" | "default" = "default";
  try {
    member = (await rc.getRuntimeConfig()).context_job_policy?.runner_member ?? null;
    source = await rc.getContextJobPolicySource();
  } catch { /* 설정을 못 읽었다 — 모르는 것을 지어내지 않는다(null) */ }
  let name: string | null = null;
  if (member) {
    try {
      const { getMember } = await import("../store/members.js");
      const m = await getMember(member);
      name = m ? (m.use_nickname && m.nickname ? m.nickname : m.display_name) || m.id : null;
    } catch { /* 이름은 덤이다 */ }
  }
  return {
    harnesses: rowsBase.map((r) => ({ ...r, failure: failures[r.key] ?? null })),
    runner: { member, name, source, is_me: member === user.memberId },
    can_set_runner: user.isAdmin,
  };
}

// ── 실패 알림 ────────────────────────────────────────────────────────────────

/** 같은 사실을 다시 울리지 않는 간격 — 증류는 10분마다 돈다. 반나절에 한 번이면 «몰랐다» 는 없고 소음도 없다. */
export const HEADLESS_NOTICE_COOLDOWN_MS = 12 * 60 * 60_000;
/** 알림을 싣는 빌트인 앱 — 알림 권한을 선언한 빌트인이다(apps/builtin/ai-session). */
export const HEADLESS_NOTICE_APP = "ai-session";
/** 누르면 갈 곳 — [내 AI 계정] 창(v2 main 이 이 주소를 받아 그 창을 연다). */
export const HEADLESS_NOTICE_HREF = "#/me/ai";

/** (순수) 알림 한 건의 모양. */
export function headlessNotice(o: { harness: string; reason: "no_credential" | "auth_failure"; label?: string | null }): {
  title: string; body: string; href: string; dedupe_key: string;
} {
  const name = (HEADLESS_LABEL as Record<string, string>)[o.harness] ?? o.harness;
  return {
    title: "사람 없이 도는 작업이 멈췄어요",
    body: o.reason === "no_credential"
      ? `증류·점검 같은 자동 작업을 내 ${name} 계정으로 돌려야 하는데, 연결된 자격이 없어 실행하지 못했어요. 내 AI 계정에서 [연결]을 누르면 다시 돕니다.`
      : `증류·점검 같은 자동 작업이 내 ${name} 계정 인증에 실패해 멈췄어요${o.label ? `(${o.label})` : ""}. 내 AI 계정에서 다시 연결해 주세요.`,
    href: HEADLESS_NOTICE_HREF,
    dedupe_key: `headless-cred:${o.harness}:${o.reason}`,
  };
}

type NotifyFn = (input: {
  appId: string; memberId: string; title: string; body: string; href: string; dedupe_key: string; cooldownMs: number;
}) => Promise<{ ok: boolean }>;

/**
 * 실행 멤버에게 «자격 때문에 멈췄다» 를 알린다. **던지지 않는다** — 스케줄러 tick 을 깨면 안 된다.
 *  앱이 꺼져 있거나 권한이 없으면 조용히 넘어간다([내 AI 계정] 행이 같은 사실을 보여 준다).
 */
export async function notifyHeadlessCredentialProblem(
  o: { memberId: string; harness: string; reason: "no_credential" | "auth_failure"; label?: string | null },
  notify?: NotifyFn,
): Promise<boolean> {
  if (!o.memberId) return false;
  try {
    const send: NotifyFn = notify ?? (async (i) => (await import("../../apps/notify.js")).notifyMember(i));
    const n = headlessNotice(o);
    const r = await send({ appId: HEADLESS_NOTICE_APP, memberId: o.memberId, ...n, cooldownMs: HEADLESS_NOTICE_COOLDOWN_MS });
    return !!r.ok;
  } catch {
    return false;
  }
}
