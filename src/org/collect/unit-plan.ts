// 수집 단위(#4213 T10 #4742)의 **판정만** 모은 순수 모듈 — DB·시계·네트워크가 없다. 저장·조회는 unit-store.ts.
//
//  여기서 정하는 것:
//   ① 담당 고르기 — 단위마다 «지금 누가 모으나» 를 하나로 정한다(같은 단위를 둘이 모으지 않는 첫 겹).
//      라이블리 수집기가 켜져 있으면 수집기가 먼저다(AI 토큰 0 · 읽은 위치가 정확). 구성원 경로는 우선순위대로
//      **건강한 첫 사람**이 모은다 — 1순위가 끊기면 2순위가 이어받고, 1순위가 회복되면 다시 1순위다.
//   ② «다시 로그인» 알림 대상 — 아무도 메우지 못해 멈춘 단위만, 사람이 고칠 수 있는 끊김인 첫 사람에게 한 번.
//   ③ 수집 실행(T11 collect-run) 결과 분류 — 로그인 끊김 · 한도 초과 · 커넥터 끊김 · 정상 · 모름.
//   ④ 자료의 볼 수 있는 사람 — 단위 구성원의 합집합, 조직 공개범위 정책이 있으면 그 안으로.
//   ⑤ 목록 정규화 · 좌표 정규화 · 쪼개기 검사 · 조회/수정 권한 · 수집기 자격 실패 판정.
//
//  ★ 볼 수 있는 구성원은 두 층이다 — **본인 신고(claim)** 와 **확인됨(verified)**. 목록 반영 표면(MCP·REST)으로 «나도 이 채널을
//   본다» 고 적은 것만으로는 후보(뒤 순번)일 뿐이고, 이미 모인 자료는 열리지 않는다. 그 사람 커넥터로 그 단위를 **실제로 읽은 것**
//   (서버가 연 목록 실행 · 그 사람 실행의 저장)이 확인돼야 볼 수 있는 사람이 된다. 아니면 채널 id 하나 아는 구성원이나, 외부 글에 심긴
//   지시를 읽은 그 사람의 AI 가 신고 한 번으로 남의 비공개 채널 자료를 열 수 있다(리뷰 2026-10-16).
//
//  설계 정본: 지식 connect-collect-tobe-claude-connector-4213 §2. 사양·엣지 표: as-built 지식 «수집 단위 표».
import { detectAuthFailure } from "../../node/task-failure.js";

export const COLLECT_ROUTES = ["lively_collector", "member_ai", "liv_direct"] as const;
export type CollectRoute = (typeof COLLECT_ROUTES)[number];
/** 수집기(라이블리 수집기·리브가 만든 수집기)가 모으는 경로 — 담당이 사람이 아니라 수집기 인스턴스다. */
export const isCollectorRoute = (r: CollectRoute): boolean => r === "lively_collector" || r === "liv_direct";

/** candidate = 목록에서 찾았지만 아직 모으지 않음(리브·사람이 정한 뒤 active) · excluded = 모으지 않기로 함. */
export const UNIT_STATES = ["candidate", "active", "excluded"] as const;
export type UnitState = (typeof UNIT_STATES)[number];

export const ASSIGNEE_STATES = ["ok", "login_broken", "connector_missing", "quota"] as const;
export type AssigneeState = (typeof ASSIGNEE_STATES)[number];
/** 건강 칸에서 «Claude 로그인 전체» 를 뜻하는 커넥터 값. */
export const ANY_CONNECTOR = "*";

export const UNIT_KINDS = [
  "channel", "private_channel", "group_dm", "dm", "page", "database", "mailbox", "label",
  "repo", "project", "team", "folder", "file", "other",
] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** 커넥터 이름 비교 키 — 수집 실행은 앱 이름을 대소문자 무시로 맞춘다(collect-run-script run.cjs). 건강 칸도 같은 규칙. */
export function connectorKey(name: string | null | undefined): string {
  const s = String(name ?? "").trim();
  return s === ANY_CONNECTOR ? ANY_CONNECTOR : s.toLowerCase();
}

// ── ① 담당 고르기 ─────────────────────────────────────────────────────────────

export interface PlanCandidate { member_id: string; priority: number; added_at: number; verified: boolean }
export interface PlanHealth {
  member_id: string; connector: string; state: AssigneeState;
  since: number; retry_at: number | null; notified_at: number | null;
}
export interface PlanCollector { id: number; enabled: boolean; broken: boolean }
export interface PlanUnit {
  id: number;
  route: CollectRoute;
  state: UnitState;
  /** 구성원 경로에서 이 단위를 읽는 claude.ai 커넥터 이름(건강 판정 키). */
  connector: string;
  collector: PlanCollector | null;
  candidates: PlanCandidate[];
  /** 공개범위 — «나만(me)» 이면 정한 사람(owner)의 계정으로만 모은다. */
  visibility: UnitVisibility;
  owner: string | null;
}
export type PlanAssignee =
  | { kind: "collector"; collector_id: number }
  | { kind: "member"; member_id: string; rank: number };
export type PlanReason = "ok" | "not_active" | "collector_off" | "no_viewer" | "all_unhealthy";
export interface PlanSkip { member_id: string; state: AssigneeState; connector: string }
export interface UnitPlan {
  unit_id: number;
  assignee: PlanAssignee | null;
  reason: PlanReason;
  /** 건강하지 않아 건너뛴 후보(순서대로) — «왜 2순위가 모으나» 와 알림 대상의 재료. */
  skipped: PlanSkip[];
}
export interface PlanOpts { now: number }

export type HealthIndex = Map<string, PlanHealth>;
const hkey = (member: string, connector: string): string => `${member}\u0000${connectorKey(connector)}`;

export function healthIndex(rows: readonly PlanHealth[]): HealthIndex {
  const m: HealthIndex = new Map();
  for (const r of rows) m.set(hkey(r.member_id, r.connector), r);
  return m;
}

/** 이 사람이 이 커넥터로 지금 모을 수 있나 — 로그인 전체(*)가 먼저, 그다음 그 커넥터. 다시 해 볼 시각이 지났으면 한 번 더 맡긴다. */
export function healthOf(idx: HealthIndex, member: string, connector: string, now: number): { ok: true } | { ok: false; row: PlanHealth } {
  for (const c of [ANY_CONNECTOR, connector]) {
    const h = idx.get(hkey(member, c));
    if (h && h.state !== "ok" && (h.retry_at == null || h.retry_at > now)) return { ok: false, row: h };
  }
  return { ok: true };
}

/**
 * 후보 줄 — **확인된 사람 먼저** → 우선순위(작을수록 먼저) → 들어온 순서 → 구성원 id. 같은 입력이면 늘 같은 줄이다.
 *  확인이 먼저인 이유: 신고만 한 사람이 1순위를 차지하면, 실제로는 못 보는 단위를 «새 글 없음» 으로 붙잡아 정당한 후보의 수집을 막는다.
 */
export function orderCandidates(c: readonly PlanCandidate[]): PlanCandidate[] {
  return [...c].sort((a, b) =>
    (Number(b.verified) - Number(a.verified)) || (a.priority - b.priority) || (a.added_at - b.added_at)
    || (a.member_id < b.member_id ? -1 : a.member_id > b.member_id ? 1 : 0));
}

export function planUnit(unit: PlanUnit, idx: HealthIndex, opts: PlanOpts): UnitPlan {
  const base = { unit_id: unit.id };
  if (unit.state !== "active") return { ...base, assignee: null, reason: "not_active", skipped: [] };
  if (isCollectorRoute(unit.route)) {
    const c = unit.collector;
    //  사람이 끄거나 지운 수집기의 단위를 구성원 AI 계정이 대신 모으지 않는다 — 끈 데엔 이유가 있다.
    if (!c || !c.enabled) return { ...base, assignee: null, reason: "collector_off", skipped: [] };
    if (!c.broken) return { ...base, assignee: { kind: "collector", collector_id: c.id }, reason: "ok", skipped: [] };
    //  켜져 있는데 자격이 끊겼다 → 구성원 후보로 넘어간다(아래).
  }
  //  자료 공개범위 적용을 끈 워크스페이스도 막지 않는다(상민님 2026-10-16) — 거기서는 무엇을 모아도 모두에게 보이고,
  //   그 사실은 수집 전 검토에서 리브가 알린다(collect_units 의 visibility_enforced).
  //  «나만» 단위는 정한 사람의 계정으로만 모은다 — 그 사람만 볼 자료를 남의 로그인으로 모으지 않고,
  //   신고만으로 주인이 된 사람이 남이 모은 자료를 보게 되는 길을 막는다(주인 계정으로 못 읽으면 자료가 없다).
  const pool = unit.visibility === "me" ? unit.candidates.filter((c) => c.member_id === unit.owner) : unit.candidates;
  const ordered = orderCandidates(pool);
  if (!ordered.length) return { ...base, assignee: null, reason: "no_viewer", skipped: [] };
  const skipped: PlanSkip[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const m = ordered[i];
    const h = healthOf(idx, m.member_id, unit.connector, opts.now);
    if (h.ok) return { ...base, assignee: { kind: "member", member_id: m.member_id, rank: i + 1 }, reason: "ok", skipped };
    skipped.push({ member_id: m.member_id, state: h.row.state, connector: h.row.connector });
  }
  return { ...base, assignee: null, reason: "all_unhealthy", skipped };
}

// ── ② «다시 로그인» 알림 대상 ─────────────────────────────────────────────────

export interface NoticeTarget {
  member_id: string;
  /** login = Claude 로그인이 끊김 · connector = 그 앱 커넥터가 Claude 에서 끊김. */
  kind: "login" | "connector";
  connector: string;
  unit_ids: number[];
}

/**
 * 멈춘 단위(담당 없음 · 모두 끊김)마다, 사람이 고칠 수 있는 끊김(로그인·커넥터)인 **가장 앞 후보 한 명**을 고른다.
 *  볼 사람이 한 명뿐이면 그 사람이다(설계 §2). 다른 사람이 메우는 단위는 아무도 부르지 않는다.
 *  한도 초과는 기다리면 풀리므로 부르지 않는다. 이번 끊김에 이미 알린 사람은 다시 고르지 않는다(notified_at ≥ since).
 */
export function noticeTargets(plans: readonly UnitPlan[], idx: HealthIndex): NoticeTarget[] {
  const out = new Map<string, NoticeTarget>();
  for (const p of plans) {
    if (p.reason !== "all_unhealthy") continue;
    const first = p.skipped.find((s) => s.state === "login_broken" || s.state === "connector_missing");
    if (!first) continue;
    const h = idx.get(hkey(first.member_id, first.connector));
    if (h && h.notified_at != null && h.notified_at >= h.since) continue;
    const kind = first.state === "login_broken" ? "login" : "connector";
    const k = `${first.member_id}\u0000${kind}\u0000${connectorKey(first.connector)}`;
    const t = out.get(k) ?? { member_id: first.member_id, kind, connector: first.connector, unit_ids: [] };
    t.unit_ids.push(p.unit_id);
    out.set(k, t);
  }
  return [...out.values()];
}

// ── ③ 수집 실행 결과 분류 ────────────────────────────────────────────────────

export interface CollectRunExit { error?: string | null; code?: number | null }
export interface CollectRunSummary {
  stderrTail?: string | null;
  result?: { subtype?: string | null; error?: unknown; text?: string | null } | null;
  allowed?: string[] | null;
  missing?: string[] | null;
}
export interface HealthChange { connector: string; state: AssigneeState; reason: string | null }
export interface RunVerdict { changes: HealthChange[]; evidence: string | null }

/** 요약(결과 문장)은 짧을 때만 본다 — task-failure.SHORT_OUTPUT_CAP 과 같은 규칙(긴 결과 안의 낱말은 작업 내용이다). */
const SHORT_RESULT_CAP = 600;
/** 한도 초과 — 사람이 고칠 일이 아니라 기다리면 풀린다. 각 문구가 «한도에 걸렸다» 를 그 자체로 말해야 한다. */
const QUOTA_PATTERNS: RegExp[] = [
  /usage\s+limit\s+reached/i,
  /reached\s+your\s+(?:usage\s+)?limit/i,
  /limit\s+reached\s*[∙·•|-]\s*resets/i,
  /rate_limit_error/i,
  /\b429\b[\s\S]{0,80}?rate[\s_-]?limit/i,
];

function quotaEvidence(stderr: string, summary: string): string | null {
  const hay = [stderr, summary.length <= SHORT_RESULT_CAP ? summary : ""];
  for (const t of hay) {
    if (!t) continue;
    for (const re of QUOTA_PATTERNS) {
      const m = re.exec(t);
      if (m) return t.slice(Math.max(0, m.index - 20), m.index + 120).replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

/**
 * 끝난 수집 실행 한 판 → 담당 건강의 변화. 모르면 아무것도 바꾸지 않는다(일시 장애를 끊김으로 적지 않는다).
 *  requested = 그 실행이 요청한 앱(job.apps). 끝 사유(exit.error)와 요약(summary)은 collect-run-script 의 모양 그대로다.
 */
export function classifyCollectRun(input: {
  exit: CollectRunExit | null; summary: CollectRunSummary | null; requested: readonly string[];
}): RunVerdict {
  const none: RunVerdict = { changes: [], evidence: null };
  const exit = input.exit, sum = input.summary;
  if (!exit) return none;
  const stderr = String(sum?.stderrTail ?? "");
  const text = String(sum?.result?.text ?? "");
  const auth = detectAuthFailure({ error: stderr, summary: text });
  if (auth) return { changes: [{ connector: ANY_CONNECTOR, state: "login_broken", reason: auth.label }], evidence: auth.evidence };
  const quota = quotaEvidence(stderr.trim(), text.trim());
  if (quota) return { changes: [{ connector: ANY_CONNECTOR, state: "quota", reason: "한도 초과" }], evidence: quota };
  const err = exit.error ?? null;
  if (err === "no-connector") {
    //  허락할 커넥터가 하나도 없었다 — 앱 연결이 끊겼거나(needs-auth) 로그인이 끊겨 목록이 비었다. 둘 다 그 앱으로는 못 모은다.
    return { changes: input.requested.map((a) => ({ connector: a, state: "connector_missing" as const, reason: "no-connector" })), evidence: null };
  }
  if (err != null || !sum || !sum.result) return none;
  const changes: HealthChange[] = [{ connector: ANY_CONNECTOR, state: "ok", reason: null }];
  for (const a of sum.allowed ?? []) changes.push({ connector: a, state: "ok", reason: null });
  for (const a of sum.missing ?? []) changes.push({ connector: a, state: "connector_missing", reason: "missing" });
  return { changes, evidence: null };
}

const HOUR = 3600_000;
/** 다시 해 볼 때까지 — 끊김은 연속 횟수로 늘리고(1h·4h·12h·24h 상한), 한도 초과는 늘 1시간. fails = 이번까지 연속 횟수. */
export function retryDelayMs(state: AssigneeState, fails: number): number {
  if (state === "quota") return HOUR;
  const steps = [1, 4, 12, 24];
  return steps[Math.min(Math.max(1, Math.floor(fails)), steps.length) - 1] * HOUR;
}

// ── ④ 자료의 볼 수 있는 사람 ──────────────────────────────────────────────────

/**
 * 단위의 공개범위(상민님 2026-10-16) — 수집을 시작하기 전 검토에서 사람이 단위마다 정한다(리브가 종류별로 먼저 제안한다).
 *  · me      — 나만: 그렇게 정한 사람(owner_member) 한 명.
 *  · viewers — 볼 수 있는 사람만: 그 단위의 **확인된** 볼 수 있는 구성원(본인 신고만 한 사람은 빠진다).
 *  · all     — 모두: 워크스페이스 전원(잠그지 않는다).
 *  조직 공개범위 정책이 그 앱·채널을 묶었으면 어느 단계든 그 정책 안으로만이다. 공개범위 적용을 끈 워크스페이스에서는 무엇을 골라도
 *  모두에게 보인다(읽기가 거르지 않는다). 라이블리 수집기가 모은 자료는 수집기 쪽 정책을 따르고, 이 칸은 단위 체계가 저장한 자료에만 쓰인다.
 */
export const UNIT_VISIBILITIES = ["me", "viewers", "all"] as const;
export type UnitVisibility = (typeof UNIT_VISIBILITIES)[number];

const ME_KINDS: ReadonlySet<string> = new Set(["dm", "group_dm", "mailbox", "label"]);
/** 리브의 첫 제안 — 공개 채널은 모두 · DM·메일함은 나만 · 그 밖(비공개 채널·페이지·폴더·저장소…)은 볼 수 있는 사람만. 사람이 검토에서 고친다. */
export function defaultVisibilityForKind(kind: string): UnitVisibility {
  if (kind === "channel") return "all";
  if (ME_KINDS.has(kind)) return "me";
  return "viewers";
}

export interface AudiencePolicy {
  visibility: "open" | "members";
  members: Array<{ subject_kind: "member" | "team"; member_id: string }>;
}

export interface AudienceUnit {
  visibility: UnitVisibility;
  /** 그 단위의 확인된 볼 수 있는 구성원. */
  viewers: readonly string[];
  /** «나만» 으로 정한 사람. */
  owner: string | null;
  policy: AudiencePolicy | null;
}

/**
 * 자료 1건의 볼 수 있는 사람 = 그 자료를 들여온 단위마다 «그 단위의 공개범위 몫(∩ 그 단위에 걸린 조직 정책)» 의 합집합.
 *  · 모두(all) 단위가 하나라도 있고 그 단위에 조직 정책이 없으면 → 잠그지 않는다(open).
 *  · 모두 + 조직 정책(members) → 정책 대상 전원 · 볼 수 있는 사람만 → 확인된 구성원 · 나만 → 정한 사람.
 *  조직 정책을 넘지 않는다. 다 모아 비면 잠긴 채 아무도 못 본다(fail-closed).
 */
export function computeAudience(input: {
  units: ReadonlyArray<AudienceUnit>;
  teamMembers: ReadonlyMap<string, ReadonlySet<string>>;
}): { open: boolean; members: string[] } {
  const out = new Set<string>();
  for (const u of input.units) {
    let allowed: Set<string> | null = null;
    if (u.policy?.visibility === "members") {
      allowed = new Set<string>();
      for (const s of u.policy.members) {
        if (s.subject_kind === "member") allowed.add(s.member_id);
        else for (const m of input.teamMembers.get(s.member_id) ?? []) allowed.add(m);
      }
    }
    if (u.visibility === "all") {
      if (!allowed) return { open: true, members: [] };
      for (const m of allowed) out.add(m);
      continue;
    }
    const mine = u.visibility === "me" ? (u.owner ? [u.owner] : []) : u.viewers;
    for (const v of mine) if (v && (!allowed || allowed.has(v))) out.add(v);
  }
  return { open: false, members: [...out].sort() };
}

/**
 * 공개범위를 바꿀 수 있나 — 고칠 수 있는 사람(canEditUnit)이어야 하고, «나만» 단위는 그렇게 정한 사람만 바꾼다(남이 넓히지 못하게).
 *  예외 하나: 정한 사람이 그 단위를 볼 수 있는 것이 확인되지 않았으면(신고만 · 내보낸 사람) 확인된 구성원이 넘겨받을 수 있다 —
 *   신고만으로 남의 DM 을 먼저 «나만» 으로 잡아 진짜 참여자가 못 모으게 막는 일을 풀려고.
 *  «나만» 으로 정하는 사람은 그 단위의 확인된 볼 수 있는 구성원이어야 한다(못 보는 사람이 자기 것으로 가져가지 못하게).
 */
export function visibilityChangeError(
  u: UnitAccessInput & { visibility: UnitVisibility; owner: string | null }, next: UnitVisibility, member: string, isAdmin: boolean,
): string | null {
  if (!canEditUnit(u, member, isAdmin)) return "이 단위를 고칠 권한이 없습니다";
  const confirmed = (m: string | null): boolean => !!m && u.members.some((x) => x.member_id === m && x.verified && x.active !== false);
  if (u.visibility === "me" && u.owner && u.owner !== member && (confirmed(u.owner) || !confirmed(member))) {
    return "«나만» 으로 정한 사람만 이 단위의 공개범위를 바꿀 수 있습니다";
  }
  if (next === "me" && !confirmed(member)) return "«나만» 은 이 단위를 볼 수 있는 것이 확인된 사람만 고를 수 있습니다";
  return null;
}

// ── ⑤ 목록 · 쪼개기 · 권한 ───────────────────────────────────────────────────

export interface ListingItem { ref: string; name: string | null; kind: UnitKind }
export const LISTING_MAX = 5000;
const REF_MAX = 512, NAME_MAX = 200;

/** 목록 한 벌 정규화 — 빈 ref 버림 · 같은 ref 는 한 건(뒤의 이름이 앞의 빈 이름을 채운다) · 모르는 종류는 other. */
export function normalizeListing(items: ReadonlyArray<{ ref?: unknown; name?: unknown; kind?: unknown }>): ListingItem[] {
  const out = new Map<string, ListingItem>();
  for (const it of items.slice(0, LISTING_MAX)) {
    const ref = String(it?.ref ?? "").trim().slice(0, REF_MAX);
    if (!ref) continue;
    const name = it?.name == null ? null : (String(it.name).trim().slice(0, NAME_MAX) || null);
    const k = String(it?.kind ?? "").trim().toLowerCase();
    const kind = ((UNIT_KINDS as readonly string[]).includes(k) ? k : "other") as UnitKind;
    const prev = out.get(ref);
    if (!prev) out.set(ref, { ref, name, kind });
    else {
      if (!prev.name && name) prev.name = name;
      if (prev.kind === "other" && kind !== "other") prev.kind = kind;
    }
  }
  return [...out.values()];
}

/** 메일이 단위인 앱 — 단위 = 메일함(본인 주소). 같은 메일이 여러 메일함에 들어오는 것이 정상이라 자료 합치기도 허락한다. */
export const MAIL_APPS: ReadonlySet<string> = new Set(["gmail", "outlook"]);

/**
 * 메일함 단위는 본인 주소일 때만 «본인이 볼 수 있다» 로 적는다 — 남의 메일함을 자기 것이라 적어 그 메일을 받아 보는 길을 막는다.
 *  메일함인지는 **좌표(앱)와 저장된 단위의 종류**로 정한다 — 신고하는 쪽이 고른 kind 로 정하면 kind 를 빼거나 바꿔 그냥 지나간다.
 */
export function listingClaimAllowed(
  item: ListingItem, ctx: { app: string; existingKind?: string | null; memberEmails: readonly string[] },
): boolean {
  const mailbox = MAIL_APPS.has(ctx.app) || item.kind === "mailbox" || ctx.existingKind === "mailbox";
  if (!mailbox) return true;
  const ref = item.ref.trim().toLowerCase();
  return ctx.memberEmails.some((e) => e && e.trim().toLowerCase() === ref);
}

/**
 * 단위 좌표 정규화 — 목록 반영·쪼개기·이관·저장이 **같은 함수**로 좌표를 만든다(아니면 같은 단위가 두 행이 되고 자료가 안 합쳐진다).
 *  · 메일(gmail·outlook): 인스턴스는 수집기와 같은 'default', 주소는 소문자.
 *  · 노션: 하이픈 없는 32자 id 는 수집기가 쓰는 하이픈 꼴(8-4-4-4-12, 소문자)로.
 *  · 그 밖: 앞뒤 공백만.
 */
export function canonicalCoord(app: string, instance: unknown, ref: unknown): { instance: string; ref: string } {
  let inst = String(instance ?? "").trim();
  let r = String(ref ?? "").trim();
  if (MAIL_APPS.has(app)) { inst = inst || "default"; r = r.toLowerCase(); }
  else if (app === "notion") {
    const hex = r.replace(/-/g, "").toLowerCase();
    if (/^[0-9a-f]{32}$/.test(hex)) r = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return { instance: inst, ref: r };
}

/** 쪼개기는 좁히기만 한다 — 자식의 볼 수 있는 구성원은 부모의 볼 수 있는 구성원 안에서만. 넘는 사람을 돌려준다(비면 통과). */
export function splitOverreach(parentViewers: readonly string[], childViewers: readonly string[]): string[] {
  const p = new Set(parentViewers);
  return [...new Set(childViewers)].filter((m) => !p.has(m));
}

export interface UnitAccessInput {
  route: CollectRoute;
  /** 볼 수 있는 구성원 — verified=false 는 본인 신고만 한 사람 · active=false 는 내보낸 사람(없으면 활성). */
  members: ReadonlyArray<{ member_id: string; verified: boolean; active?: boolean }>;
}
/**
 * 이 사람이 이 단위를 어디까지 보나.
 *  · full   — 확인된 볼 수 있는 구성원 · 수집기 경로 단위의 관리자(admin). 이름·설명·메타·후보 줄·건강까지.
 *  · coarse — 신고만 한 본인(자기 신고가 어떻게 됐는지) · 수집기 경로 단위의 다른 구성원(수집기 설정 화면이 이미 보여 주는 정도).
 *             후보 줄·건강·설명·메타는 없다 — 누가 어떤 비공개 대화·메일함에 있는지는 member_channel_meta 와 같은 급의 사생활이다.
 *  · none   — 그 밖. 구성원 경로 단위는 관리자도 못 본다(개수만).
 *  ⚠ «워크스페이스를 굴리는 사람»(memory scope)으로 가르면 안 된다 — 기본 구성원이 모두 memory 라 전원이 된다(리뷰 2026-10-16).
 */
export function unitAccess(u: UnitAccessInput, member: string, isAdmin: boolean): "full" | "coarse" | "none" {
  const me = u.members.find((m) => m.member_id === member);
  if (me?.verified) return "full";
  if (isCollectorRoute(u.route)) return isAdmin ? "full" : "coarse";
  return me ? "coarse" : "none";
}

/** 고칠 수 있나 — 구성원 경로는 확인된 볼 수 있는 구성원 · 수집기 경로는 관리자 또는 확인된 볼 수 있는 구성원. */
export function canEditUnit(u: UnitAccessInput, member: string, isAdmin: boolean): boolean {
  const verified = !!u.members.find((m) => m.member_id === member)?.verified;
  return isCollectorRoute(u.route) ? (isAdmin || verified) : verified;
}

/**
 * 라이블리 수집기 실행이 **자격 실패**로 끝났나 — 수집기 로그 꼬리(그 수집기 코드가 쓴 오류 줄)로 판정한다.
 *  Claude CLI 문구(detectAuthFailure)는 수집기가 내지 않는다. 앱마다 실제로 내는 말:
 *   슬랙 `slack <메서드> error: invalid_auth|token_revoked|token_expired|account_inactive|not_authed`(connectors/slack.ts) ·
 *   노션 `401 … API token is invalid.` · 구글 `invalid_grant` · GitHub `Bad credentials` · 그 밖 401+인증 낱말(failure-class.isInvalidCredential 규칙).
 *  ⚠ 권한 부족(missing_scope·403)·한도(ratelimited)·없음(404)은 자격 실패가 아니다 — 그건 사람이 다른 걸 고칠 일이다.
 */
export function collectorAuthFailed(logTail: string | null | undefined): boolean {
  const t = String(logTail ?? "");
  if (!t) return false;
  if (/\berror:\s*(invalid_auth|token_revoked|token_expired|account_inactive|not_authed)\b/.test(t)) return true;
  if (/\binvalid_grant\b/.test(t)) return true;
  if (/\bBad credentials\b/i.test(t)) return true;
  return /(^|[^0-9])401([^0-9]|$)/.test(t) && /unauthorized|invalid[_\s-]*(api[_\s-]*)?token|authentication|api key/i.test(t);
}

/** 읽은 위치를 옮길 수 있나 — 지금 담당만(담당이 아닌 실행의 늦은 보고는 거절. 자료는 좌표로 합쳐지므로 해가 없다). */
export function canAdvanceCursor(plan: UnitPlan, by: { member?: string | null; collector_id?: number | null }): boolean {
  const a = plan.assignee;
  if (!a) return false;
  if (a.kind === "member") return !!by.member && by.member === a.member_id;
  return by.collector_id != null && Number(by.collector_id) === a.collector_id;
}
