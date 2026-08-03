// org_runtime_config — 런타임 설정 단일행(훅 on/off·화이트리스트·정책 seam 들).
//  (#1313 R18) 구 org/store.ts 에서 verbatim 분리. ⚠ #688 '원본 재조회' 분기·정책 seam import 는 그대로(단순화 금지).
import { itemsPool } from "../../db/client.js";
// 임베딩(벡터검색 #172) config seam — embedding_config 정규화/병합(env 시드 + DB 우선). 무순환(provider 모듈은 store 미import).
import {
  type EmbeddingConfig, type EmbeddingConfigPatch, resolveEmbeddingConfig, normalizeEmbeddingConfig,
  isExplicitEmbeddingOff, embeddingConfigSource, EMBEDDING_OFF,
} from "../../v6/embedding-provider.js";
// 박스 저장소 정책(#813) — 로그 상한·디스크 임계치. embedding_config 와 같은 seam(env 시드 + DB 우선).
import {
  type StoragePolicy, type StoragePolicyPatch, resolveStoragePolicy, normalizeStoragePolicy,
  storagePolicySource, invalidateStoragePolicyCache,
} from "../policies/storage-policy.js";
// MCP 호출 감사로그 보관 정책(#1082) — 보존일수. storage_policy 와 같은 seam(env 시드 + DB 우선).
import {
  type CallLogPolicy, type CallLogPolicyPatch, resolveCallLogPolicy, normalizeCallLogPolicy, callLogPolicySource,
} from "../policies/call-log-policy.js";
// 세션 공유(세션이력 캡처) 정책(#905 C1) — 관리탭 ▸ 세션 공유. storage_policy 와 같은 seam(DB 우선, 비면 기본값).
import { type SessionShareConfig, type SessionSharePatch, resolveSessionShare, normalizeSessionShare } from "../../sessions/session-share.js";
// per-session cgroup 메모리 격리 정책(#1059 D) — 세션당 MemoryHigh/Max(MB). storage_policy 와 같은 seam(DB 우선, 비면 env 시드).
import {
  type SessionMemoryPolicy, type SessionMemoryPolicyPatch, resolveSessionMemoryPolicy, normalizeSessionMemoryPolicy,
  sessionMemoryPolicySource, invalidateSessionMemoryPolicyCache,
} from "../../sessions/session-memory-policy.js";
// idle 세션 자동 회수(reaper) 정책(#1059 F) — idle TTL(분). storage/session-memory 와 같은 seam(DB 우선, 비면 env 시드).
import {
  type SessionReclaimPolicy, type SessionReclaimPolicyPatch, resolveSessionReclaimPolicy, normalizeSessionReclaimPolicy,
  sessionReclaimPolicySource, invalidateSessionReclaimPolicyCache,
} from "../../sessions/session-reclaim-policy.js";
// 위탁 태스크 정책(#1101) — 무출력 stall 상한(ms). 같은 seam(DB 우선, 비면 env 시드 → 코드 기본값).
import {
  type DelegatePolicy, type DelegatePolicyPatch, resolveDelegatePolicy, normalizeDelegatePolicy,
  delegatePolicySource, invalidateDelegatePolicyCache,
} from "../policies/delegate-policy.js";
import { audit } from "./audit.js";

// ════════ 런타임 설정(훅 on/off · work-roots · writeback 너지) — org_runtime_config 단일행 ════════
export interface OrgRuntimeConfig {
  // self_update(#858): 멤버 키트(훅 코드·배선) 자동 업데이트. 끄면 멤버는 수동 업데이트 명령이 유일한 경로.
  hooks: { session_preload: boolean; work_flag: boolean; stop_writeback_gate: boolean; self_update: boolean };
  writeback_notice: string | null;
  work_roots: string[];
  allowed_auth_envs: string[]; // http_proxy 툴이 참조 가능한 환경변수 '이름' 화이트리스트(B15)
  url_allowlist: string[];     // http_proxy 호출 허용 호스트(소문자, deny-all 기본)
  allowed_db_secret_refs: string[]; // db 소스가 참조 가능한 시크릿 env '이름' 화이트리스트(deny-all 기본)
  allowed_db_hosts: string[]; // db 소스가 접속 가능한 host 화이트리스트(소문자, deny-all 기본) — 사설/localhost SSRF 면제 대상
  allowed_internal_hosts: string[]; // MCP 프록시가 접속 가능한 내부(사설/localhost) host 화이트리스트(소문자, deny-all 기본) — #746 T1
  write_tools: string[]; // work-flag 가 '기록함(writeback)'으로 인정할 lively MCP 툴 목록(비면 훅 내장 v6 기본)
  pull_tools: string[]; // work-flag 가 '외부 맥락 인입'으로 볼 MCP 툴 이름 prefix 목록(#906) — write_tools 와 달리 **비면 끔**
  embedding_config: EmbeddingConfig; // 벡터검색(#172) 추론 seam 설정 — 기본 off(현행 grep/ILIKE). DB 우선, 비면 env(EMBEDDINGS_*) 시드
  storage_policy: StoragePolicy; // 박스 저장소 정책(#813) — 로그 상한·디스크 임계치. DB 우선, 비면 env 시드 → 기본값
  call_log_policy: CallLogPolicy; // MCP 호출 감사로그 보관(#1082) — 보존일수. DB 우선, 비면 env 시드 → 90일. 0=무기한
  session_memory_policy: SessionMemoryPolicy; // per-session cgroup 메모리 격리(#1059 D) — 세션당 MemoryHigh/Max(MB). 0=무제한(무회귀). DB 우선, 비면 env 시드
  session_reclaim_policy: SessionReclaimPolicy; // idle 세션 자동 회수(#1059 F) — idle TTL(분). 0=끔(무회귀). DB 우선, 비면 env 시드
  delegate_policy: DelegatePolicy; // 위탁 태스크 정책(#1101) — 무출력 stall 상한(ms). 0=가드 끔. DB 우선, 비면 env 시드 → 5분
  hook_relay_decisions: HookRelayDecision[]; // 러너가 PreToolUse 에서 전파할 결정(#892). 기본 deny/ask/defer — allow 는 명시 opt-in
  session_share: SessionShareConfig; // 세션이력 캡처 정책(#905 C1). 기본 enabled=false(롤아웃 꺼둠). 관리탭 ▸ 세션 공유.
  hook_grace_ms: number | null; // #1008 — run-custom 이 게이트웨이 미도달 시 최근 캐시를 쓸 유효기간(ms). NULL=무제한(기본). 양수=그 ms 후 fail-CLOSED.
  embedding_backfill_paused: boolean; // #1060 — 자동 임베딩 백필 스윕 일시중지. true=부팅·주기·sync후·nudge 스윕 no-op + 실행 중 잡 중단. DB 영속(재시작에도 유지).
  inject_ontology_guide: boolean; // #1245 — 온톨로지 가이드(제품 소유 섹션, 코드 단일 출처) 주입 여부. 본문 편집은 불가 — 이 토글만 org 가 정한다.
  ui_nav: UiNavConfig; // #1454 S2 — 상단 탭 게이팅. {} = 전부 노출(현행). tabs 에 **명시적 false 인 탭만** 숨김(프론트 navOn 이 해석).
  announcement: UiAnnouncement | null; // #1454 S3 — 조직 공지 배너. null = 미표시(현행).
  ui_profile: UiProfile; // #1454 S4 — 관리탭 프로파일. 'full'(현행) | 'personal'(개인 워크스페이스 — 조직 운영 섹션 숨김).
  usage_url: string | null; // #1454 S5 — 상단바 '사용량' 칩 링크. null = 칩 미노출(현행).
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

const strArrSafe = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

// PreToolUse 결정 전파 정책(#892) — Claude Code 의 permissionDecision 값 집합.
export const HOOK_RELAY_DECISIONS = ["deny", "defer", "ask", "allow"] as const;
export type HookRelayDecision = (typeof HOOK_RELAY_DECISIONS)[number];
export const DEFAULT_HOOK_RELAY_DECISIONS: HookRelayDecision[] = ["deny", "ask", "defer"];
// 컬럼 부재(구 DB)·잡값이면 기본값으로 접는다 — 빈 배열은 '전파 안 함'이라는 의도된 상태라 그대로 둔다.
const relayDecisionsSafe = (v: unknown): HookRelayDecision[] => {
  if (!Array.isArray(v)) return DEFAULT_HOOK_RELAY_DECISIONS;
  return v.filter((x): x is HookRelayDecision => HOOK_RELAY_DECISIONS.includes(x as HookRelayDecision));
};

// #1008 — run-custom 캐시 유효기간(ms). NULL/미설정/음수/잡값 = null(무제한: 마지막 접속 기준 영구 실행).
//  0 이상 정수만 유효 grace(0 = 캐시 즉시 만료 = 가장 보수적). 컬럼 부재(구 DB)면 undefined → null 로 접힌다.
const graceMsSafe = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : null;
};

// ── 매니지드 표면 노브(#1454 S2~S5) 타입 + 안전 fold — 넷 다 '잡값/부재 = 기본값(현행 동작)' 규약. ──
//  ui_nav 의 해석 주체는 프론트(web/lib/state.ts navOn)다 — 서버는 형태만 보존해 실어 나른다(강제 아님).
export interface UiNavConfig { tabs?: Record<string, boolean> }
export interface UiAnnouncement { text: string; href: string | null; tone: "info" | "warn" }
export type UiProfile = "full" | "personal";
const uiNavSafe = (v: unknown): UiNavConfig => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const tabsRaw = (v as Record<string, unknown>).tabs;
  if (!tabsRaw || typeof tabsRaw !== "object" || Array.isArray(tabsRaw)) return {};
  const tabs: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(tabsRaw as Record<string, unknown>)) {
    if (typeof val === "boolean") tabs[k] = val;
  }
  return { tabs };
};
const announcementSafe = (v: unknown): UiAnnouncement | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  const text = typeof a.text === "string" ? a.text.trim() : "";
  if (!text) return null; // 본문 없는 배너는 배너가 아니다 — 미표시로 접는다
  return {
    text,
    href: typeof a.href === "string" && a.href.trim() ? a.href.trim() : null,
    tone: a.tone === "warn" ? "warn" : "info",
  };
};
const uiProfileSafe = (v: unknown): UiProfile => (v === "personal" ? "personal" : "full");
const usageUrlSafe = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function getRuntimeConfig(): Promise<OrgRuntimeConfig> {
  const r = await itemsPool.query(
    `SELECT hooks, writeback_notice, work_roots, allowed_auth_envs, url_allowlist, allowed_db_secret_refs, allowed_db_hosts, allowed_internal_hosts, write_tools, pull_tools, embedding_config, storage_policy, call_log_policy, session_memory_policy, session_reclaim_policy, delegate_policy, hook_relay_decisions, session_share, hook_grace_ms, embedding_backfill_paused, inject_ontology_guide, ui_nav, announcement, ui_profile, usage_url, version, updated_at, updated_by
       FROM org_runtime_config WHERE id=1`,
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  const hooksRaw = (row?.hooks ?? {}) as Record<string, unknown>;
  return {
    hooks: {
      session_preload: hooksRaw.session_preload !== false,
      work_flag: hooksRaw.work_flag !== false,
      stop_writeback_gate: hooksRaw.stop_writeback_gate !== false,
      // 기존 org 행엔 이 키가 없다 — `!== false` 규약이 곧 '없으면 켜짐'이라 마이그레이션 없이 전원 활성.
      self_update: hooksRaw.self_update !== false,
    },
    writeback_notice: (row?.writeback_notice as string) ?? null,
    work_roots: strArrSafe(row?.work_roots),
    allowed_auth_envs: strArrSafe(row?.allowed_auth_envs),
    url_allowlist: strArrSafe(row?.url_allowlist).map((s) => s.toLowerCase()),
    allowed_db_secret_refs: strArrSafe(row?.allowed_db_secret_refs),
    allowed_db_hosts: strArrSafe(row?.allowed_db_hosts).map((s) => s.toLowerCase()),
    allowed_internal_hosts: strArrSafe(row?.allowed_internal_hosts).map((s) => s.toLowerCase()),
    write_tools: strArrSafe(row?.write_tools),
    // #906 — 컬럼 부재(구 DB)면 [] = 꺼짐. 마이그레이션이 ADD COLUMN DEFAULT 로 기존 행까지 켜준다.
    pull_tools: strArrSafe(row?.pull_tools),
    embedding_config: resolveEmbeddingConfig(row?.embedding_config), // DB 우선, off/미설정이면 env(EMBEDDINGS_*) 시드
    storage_policy: resolveStoragePolicy(row?.storage_policy), // DB 우선, 비면 env 시드 → 코드 기본값(#813)
    call_log_policy: resolveCallLogPolicy(row?.call_log_policy), // #1082 — 구 DB(컬럼 부재)면 기본값(90일)
    session_memory_policy: resolveSessionMemoryPolicy(row?.session_memory_policy), // #1059 D — DB 우선, 비면 env 시드 → 0/0(무제한, 무회귀)
    session_reclaim_policy: resolveSessionReclaimPolicy(row?.session_reclaim_policy), // #1059 F — DB 우선, 비면 env 시드 → 0(회수 끔, 무회귀)
    delegate_policy: resolveDelegatePolicy(row?.delegate_policy), // #1101 — DB 우선, 비면 env 시드 → 300000(5분)
    hook_relay_decisions: relayDecisionsSafe(row?.hook_relay_decisions), // #892 — 구 DB(컬럼 부재)면 기본값
    session_share: resolveSessionShare(row?.session_share), // #905 C1 — 구 DB(컬럼 부재)면 기본값(enabled=false)
    hook_grace_ms: graceMsSafe(row?.hook_grace_ms), // #1008 — 컬럼 부재/NULL 이면 null(무제한)
    embedding_backfill_paused: row?.embedding_backfill_paused === true, // #1060 — 컬럼 부재(구 DB)면 undefined → false(평소대로 자동 백필)
    inject_ontology_guide: row?.inject_ontology_guide !== false, // #1245 — 컬럼 부재(구 DB)면 켜짐(hooks 와 같은 '없으면 on' 규약)
    ui_nav: uiNavSafe(row?.ui_nav), // #1454 S2 — 잡값/부재면 {} = 전부 노출(현행)
    announcement: announcementSafe(row?.announcement), // #1454 S3 — 잡값/부재면 null = 미표시(현행)
    ui_profile: uiProfileSafe(row?.ui_profile), // #1454 S4 — 잡값/부재면 'full'(현행)
    usage_url: usageUrlSafe(row?.usage_url), // #1454 S5 — 빈값/부재면 null = 칩 미노출(현행)
    version: (row?.version as number) ?? 1,
    updated_at: (row?.updated_at as string) ?? null,
    updated_by: (row?.updated_by as string) ?? null,
  };
}

export async function updateRuntimeConfig(
  patch: {
    hooks?: Partial<OrgRuntimeConfig["hooks"]>;
    writeback_notice?: string | null;
    work_roots?: string[];
    allowed_auth_envs?: string[];
    url_allowlist?: string[];
    allowed_db_secret_refs?: string[];
    allowed_db_hosts?: string[];
    allowed_internal_hosts?: string[];
    write_tools?: string[];
    pull_tools?: string[];
    embedding_config?: EmbeddingConfigPatch;
    storage_policy?: StoragePolicyPatch;
    call_log_policy?: CallLogPolicyPatch;
    session_memory_policy?: SessionMemoryPolicyPatch;
    session_reclaim_policy?: SessionReclaimPolicyPatch;
    delegate_policy?: DelegatePolicyPatch;
    hook_relay_decisions?: HookRelayDecision[];
    session_share?: SessionSharePatch;
    hook_grace_ms?: number | null;
    embedding_backfill_paused?: boolean;
    inject_ontology_guide?: boolean;
    ui_nav?: UiNavConfig;
    announcement?: UiAnnouncement | null;
    ui_profile?: UiProfile;
    usage_url?: string | null;
  },
  actor?: string,
  source?: string,
  meta?: { tokenHashPrefix?: string | null; ip?: string | null },
): Promise<OrgRuntimeConfig> {
  const before = await getRuntimeConfig();
  const hooks = { ...before.hooks, ...(patch.hooks ?? {}) };
  const writebackNotice = patch.writeback_notice !== undefined ? patch.writeback_notice : before.writeback_notice;
  const workRoots = patch.work_roots !== undefined ? patch.work_roots : before.work_roots;
  const allowedAuthEnvs = patch.allowed_auth_envs !== undefined ? patch.allowed_auth_envs : before.allowed_auth_envs;
  const urlAllowlist = patch.url_allowlist !== undefined ? patch.url_allowlist.map((s) => s.toLowerCase()) : before.url_allowlist;
  const allowedDbSecretRefs = patch.allowed_db_secret_refs !== undefined ? patch.allowed_db_secret_refs : before.allowed_db_secret_refs;
  const allowedDbHosts = patch.allowed_db_hosts !== undefined ? patch.allowed_db_hosts.map((s) => s.toLowerCase()) : before.allowed_db_hosts;
  const allowedInternalHosts = patch.allowed_internal_hosts !== undefined ? patch.allowed_internal_hosts.map((s) => s.toLowerCase()) : before.allowed_internal_hosts;
  const writeTools = patch.write_tools !== undefined ? patch.write_tools : before.write_tools;
  const pullTools = patch.pull_tools !== undefined ? patch.pull_tools : before.pull_tools;
  // #892 — before 는 이미 resolve 된 값이라 되써도 기본값이 굳는 문제가 없다(embedding/storage 와 달리
  //  '미설정' 과 '기본값' 을 구분할 이유가 없는 단순 화이트리스트).
  const relayDecisions = patch.hook_relay_decisions !== undefined ? patch.hook_relay_decisions : before.hook_relay_decisions;
  // #1008 — run-custom 캐시 유효기간(ms). null=무제한. before 는 이미 정규화된 값이라 되써도 안전(화이트리스트 idiom, relay 와 동일).
  const hookGraceMs = patch.hook_grace_ms !== undefined ? patch.hook_grace_ms : before.hook_grace_ms;
  // #1060 — 자동 백필 일시중지 플래그. before 는 이미 정규화된 boolean 이라 되써도 안전(relay/grace 와 동일 화이트리스트 idiom).
  const embeddingBackfillPaused = patch.embedding_backfill_paused !== undefined ? patch.embedding_backfill_paused : before.embedding_backfill_paused;
  // #1245 — 온톨로지 가이드 주입 토글. 단순 boolean(되쓰기 안전 — relay/grace/backfill 과 동일 idiom).
  const injectOntologyGuide = patch.inject_ontology_guide !== undefined ? patch.inject_ontology_guide : before.inject_ontology_guide;
  // #1454 S2~S5 — 매니지드 표면 노브 4종. before 는 이미 safe-fold 된 값이고 fold(기본값) == 컬럼 DEFAULT 라
  //  되써도 '미설정'이 굳지 않는다(화이트리스트 idiom — relay/grace 와 동일. embedding 류의 env 시드 구분이 없다).
  const uiNav = patch.ui_nav !== undefined ? uiNavSafe(patch.ui_nav) : before.ui_nav;
  const announcement = patch.announcement !== undefined ? announcementSafe(patch.announcement) : before.announcement;
  const uiProfile = patch.ui_profile !== undefined ? uiProfileSafe(patch.ui_profile) : before.ui_profile;
  const usageUrl = patch.usage_url !== undefined ? usageUrlSafe(patch.usage_url) : before.usage_url;
  // 임베딩 설정 — 저장 시 정규화(잡값/알 수 없는 provider → off). 시크릿 미저장(auth_env_ref=env 이름만).
  //  #688 두 가지 보존: ① '명시적 끄기'({provider:'off',explicit:true})는 normalize 로 마커를 벗기지 않고 그대로 저장
  //  (env 시드 부활 금지). ② embedding_config 를 안 건드린 저장은 DB '원본'을 유지 — before(resolved)를 되쓰면
  //  env 시드 값이 DB 로 굳고(미설정→영구화) 명시적 off 마커도 소실된다(둘 다 실제로 겪은 함정).
  let embeddingConfig: unknown;
  if (patch.embedding_config !== undefined) {
    embeddingConfig = isExplicitEmbeddingOff(patch.embedding_config)
      ? { ...EMBEDDING_OFF, explicit: true }
      : normalizeEmbeddingConfig(patch.embedding_config);
  } else {
    const raw = await itemsPool.query(`SELECT embedding_config FROM org_runtime_config WHERE id=1`);
    embeddingConfig = (raw.rows[0] as { embedding_config?: unknown } | undefined)?.embedding_config ?? null;
  }
  // 저장소 정책(#813) — embedding_config 와 같은 규칙: **안 건드린 저장은 DB 원본을 그대로 둔다.**
  //  before(resolved)를 되쓰면 env 시드/기본값이 DB 로 굳어 '미설정' 상태가 영구히 사라진다(#688 에서 겪은 함정).
  let storagePolicy: unknown;
  if (patch.storage_policy !== undefined) {
    storagePolicy = normalizeStoragePolicy({ ...before.storage_policy, ...patch.storage_policy });
  } else {
    const raw = await itemsPool.query(`SELECT storage_policy FROM org_runtime_config WHERE id=1`);
    storagePolicy = (raw.rows[0] as { storage_policy?: unknown } | undefined)?.storage_policy ?? {};
  }
  // 호출 감사로그 보관 정책(#1082) — storage_policy 와 동일 규칙: **안 건드린 저장은 DB 원본을 그대로 둔다**(before 되쓰기 금지).
  let callLogPolicy: unknown;
  if (patch.call_log_policy !== undefined) {
    callLogPolicy = normalizeCallLogPolicy({ ...before.call_log_policy, ...patch.call_log_policy });
  } else {
    const raw = await itemsPool.query(`SELECT call_log_policy FROM org_runtime_config WHERE id=1`);
    callLogPolicy = (raw.rows[0] as { call_log_policy?: unknown } | undefined)?.call_log_policy ?? {};
  }
  // per-session 메모리 정책(#1059 D) — storage_policy 와 동일 규칙: **안 건드린 저장은 DB 원본을 그대로 둔다**
  //  (before(resolved) 되쓰면 env 시드/기본값이 DB 로 굳어 '미설정' 이 사라진다 — #688 함정).
  let sessionMemoryPolicy: unknown;
  if (patch.session_memory_policy !== undefined) {
    sessionMemoryPolicy = normalizeSessionMemoryPolicy({ ...before.session_memory_policy, ...patch.session_memory_policy });
  } else {
    const raw = await itemsPool.query(`SELECT session_memory_policy FROM org_runtime_config WHERE id=1`);
    sessionMemoryPolicy = (raw.rows[0] as { session_memory_policy?: unknown } | undefined)?.session_memory_policy ?? {};
  }
  // idle 회수 정책(#1059 F) — storage/session-memory 와 동일 규칙: **안 건드린 저장은 DB 원본을 그대로 둔다**(before 되쓰기 금지).
  let sessionReclaimPolicy: unknown;
  if (patch.session_reclaim_policy !== undefined) {
    sessionReclaimPolicy = normalizeSessionReclaimPolicy({ ...before.session_reclaim_policy, ...patch.session_reclaim_policy });
  } else {
    const raw = await itemsPool.query(`SELECT session_reclaim_policy FROM org_runtime_config WHERE id=1`);
    sessionReclaimPolicy = (raw.rows[0] as { session_reclaim_policy?: unknown } | undefined)?.session_reclaim_policy ?? {};
  }
  // 위탁 태스크 정책(#1101) — 위와 동일 규칙: **안 건드린 저장은 DB 원본을 그대로 둔다**(before 되쓰기 금지).
  let delegatePolicy: unknown;
  if (patch.delegate_policy !== undefined) {
    delegatePolicy = normalizeDelegatePolicy({ ...before.delegate_policy, ...patch.delegate_policy });
  } else {
    const raw = await itemsPool.query(`SELECT delegate_policy FROM org_runtime_config WHERE id=1`);
    delegatePolicy = (raw.rows[0] as { delegate_policy?: unknown } | undefined)?.delegate_policy ?? {};
  }
  // 세션 공유(#905 C1) — storage_policy 와 동일 규칙: **안 건드린 저장은 DB 원본을 그대로 둔다**(before 되쓰기 금지).
  //  건드리면 before(resolved) 위에 patch 를 얹어 정규화(잡값·미지원 하네스·범위초과 방어).
  let sessionShare: unknown;
  if (patch.session_share !== undefined) {
    sessionShare = normalizeSessionShare(before.session_share, patch.session_share);
  } else {
    const raw = await itemsPool.query(`SELECT session_share FROM org_runtime_config WHERE id=1`);
    sessionShare = (raw.rows[0] as { session_share?: unknown } | undefined)?.session_share ?? null;
  }
  await itemsPool.query(
    `INSERT INTO org_runtime_config(id, hooks, writeback_notice, work_roots, allowed_auth_envs, url_allowlist, allowed_db_secret_refs, allowed_db_hosts, allowed_internal_hosts, write_tools, pull_tools, embedding_config, storage_policy, call_log_policy, session_memory_policy, session_reclaim_policy, delegate_policy, hook_relay_decisions, session_share, hook_grace_ms, embedding_backfill_paused, inject_ontology_guide, ui_nav, announcement, ui_profile, usage_url, version, updated_at, updated_by)
       VALUES(1,$1::jsonb,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$20::jsonb,$18::jsonb,$19::jsonb,$22::jsonb,$14::jsonb,$15::jsonb,$16,$17,$21,$23::jsonb,$24::jsonb,$25,$26,1,now(),$13)
     ON CONFLICT (id) DO UPDATE SET hooks=EXCLUDED.hooks, writeback_notice=EXCLUDED.writeback_notice,
       work_roots=EXCLUDED.work_roots, allowed_auth_envs=EXCLUDED.allowed_auth_envs, url_allowlist=EXCLUDED.url_allowlist,
       allowed_db_secret_refs=EXCLUDED.allowed_db_secret_refs, allowed_db_hosts=EXCLUDED.allowed_db_hosts,
       allowed_internal_hosts=EXCLUDED.allowed_internal_hosts,
       write_tools=EXCLUDED.write_tools, pull_tools=EXCLUDED.pull_tools, embedding_config=EXCLUDED.embedding_config,
       storage_policy=EXCLUDED.storage_policy, call_log_policy=EXCLUDED.call_log_policy,
       session_memory_policy=EXCLUDED.session_memory_policy, session_reclaim_policy=EXCLUDED.session_reclaim_policy,
       delegate_policy=EXCLUDED.delegate_policy, hook_relay_decisions=EXCLUDED.hook_relay_decisions,
       session_share=EXCLUDED.session_share, hook_grace_ms=EXCLUDED.hook_grace_ms,
       embedding_backfill_paused=EXCLUDED.embedding_backfill_paused,
       inject_ontology_guide=EXCLUDED.inject_ontology_guide,
       ui_nav=EXCLUDED.ui_nav, announcement=EXCLUDED.announcement, ui_profile=EXCLUDED.ui_profile, usage_url=EXCLUDED.usage_url,
       version=org_runtime_config.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [JSON.stringify(hooks), writebackNotice, JSON.stringify(workRoots),
     JSON.stringify(allowedAuthEnvs), JSON.stringify(urlAllowlist), JSON.stringify(allowedDbSecretRefs), JSON.stringify(allowedDbHosts), JSON.stringify(allowedInternalHosts), JSON.stringify(writeTools), JSON.stringify(pullTools), JSON.stringify(embeddingConfig), JSON.stringify(storagePolicy), actor ?? null, JSON.stringify(relayDecisions), JSON.stringify(sessionShare), hookGraceMs, embeddingBackfillPaused, JSON.stringify(sessionMemoryPolicy), JSON.stringify(sessionReclaimPolicy), JSON.stringify(callLogPolicy), injectOntologyGuide, JSON.stringify(delegatePolicy),
     // #1454 S2~S5 — announcement 는 null 이면 SQL NULL(json 'null' 이 아니라 컬럼 NULL — 미표시의 정본 표현).
     JSON.stringify(uiNav), announcement === null ? null : JSON.stringify(announcement), uiProfile, usageUrl],
  );
  // 저장 즉시 반영 — /readyz 임계치·로그 재니터가 캐시를 들고 있다(게이트웨이 재시작 없이 먹어야 한다).
  if (patch.storage_policy !== undefined) invalidateStoragePolicyCache();
  if (patch.session_memory_policy !== undefined) invalidateSessionMemoryPolicyCache(); // #1059 D — 저장 즉시 다음 세션 생성이 새 캡을 본다
  if (patch.session_reclaim_policy !== undefined) invalidateSessionReclaimPolicyCache(); // #1059 F — 저장 즉시 다음 reaper tick 이 새 TTL 을 본다
  if (patch.delegate_policy !== undefined) invalidateDelegatePolicyCache(); // #1101 — 저장 즉시 다음 스케줄러 tick 이 새 stall 상한을 본다
  const after = await getRuntimeConfig();
  await audit("org_runtime_config", "1", "update", before, after, actor, source, meta);
  return after;
}

// #688 유효 임베딩 설정의 출처(관리 UI 안내) — db(관리탭 on)·db-off(명시적 끄기)·env(.env 시드)·off(미설정).
//  getRuntimeConfig 는 resolved 만 주므로 출처 판정은 DB 원본으로 별도 조회.
export async function getEmbeddingConfigSource(): Promise<"db" | "db-off" | "env" | "off"> {
  try {
    const r = await itemsPool.query(`SELECT embedding_config FROM org_runtime_config WHERE id=1`);
    return embeddingConfigSource((r.rows[0] as { embedding_config?: unknown } | undefined)?.embedding_config ?? null);
  } catch {
    return embeddingConfigSource(null); // 테이블 부재(부트스트랩 전) — env/off 로 판정
  }
}

// 노브 정책 출처 판정(#1313 R47) — 5벌이 컬럼명만 다른 같은 코드였다.
//  getRuntimeConfig 는 resolved 만 주므로 출처 판정은 DB 원본으로 별도 조회한다(임베딩과 같은 방식).
//  ⚠ column 은 **코드 리터럴만** 온다(아래 5개 래퍼) — 사용자 입력이 들어오는 자리가 아니다.
//  ⚠ 테이블 부재(부트스트랩 전)면 조회가 던진다 → null 로 판정해 env/default 를 답한다(throw 금지).
async function policySourceOf(
  column: string,
  judge: (dbRaw: unknown) => "db" | "env" | "default",
): Promise<"db" | "env" | "default"> {
  try {
    const r = await itemsPool.query(`SELECT ${column} FROM org_runtime_config WHERE id=1`);
    return judge((r.rows[0] as Record<string, unknown> | undefined)?.[column] ?? null);
  } catch {
    return judge(null); // 테이블 부재(부트스트랩 전)
  }
}

// 저장소 정책(#813)의 출처(관리 UI 안내) — db(관리탭 저장)·env(.env 시드)·default(코드 기본값).
export function getStoragePolicySource(): Promise<"db" | "env" | "default"> {
  return policySourceOf("storage_policy", storagePolicySource);
}

// 호출 감사로그 보관 정책(#1082)의 출처(관리 UI 안내) — db(관리탭 저장)·env(.env 시드)·default(코드 기본값 90일).
export function getCallLogPolicySource(): Promise<"db" | "env" | "default"> {
  return policySourceOf("call_log_policy", callLogPolicySource);
}

// per-session 메모리 정책(#1059 D)의 출처(관리 UI 안내) — db(관리탭 저장)·env(.env 시드)·default(코드 기본값).
export function getSessionMemoryPolicySource(): Promise<"db" | "env" | "default"> {
  return policySourceOf("session_memory_policy", sessionMemoryPolicySource);
}

// idle 회수 정책(#1059 F)의 출처(관리 UI 안내) — db(관리탭 저장)·env(.env 시드)·default(코드 기본값).
export function getSessionReclaimPolicySource(): Promise<"db" | "env" | "default"> {
  return policySourceOf("session_reclaim_policy", sessionReclaimPolicySource);
}

// 위탁 태스크 정책(#1101)의 출처(관리 UI 안내) — db(관리탭 저장)·env(.env 시드)·default(코드 기본값).
export function getDelegatePolicySource(): Promise<"db" | "env" | "default"> {
  return policySourceOf("delegate_policy", delegatePolicySource);
}

// ── 매니지드 표면 노브 4종만 경량 조회(#1454 S2~S5) — /api/ui/me 전용. ──
//  me 는 모든 화면이 부팅마다 부르는 핫패스라 getRuntimeConfig(정책 resolve 전량)를 태우지 않고 4컬럼만 읽는다.
//  **fail-open**: 테이블/컬럼 부재(구 DB·부트스트랩 전)·조회 실패에도 me 는 살아야 하므로 기본값(= 기존 동작:
//  전탭 노출·배너 없음·full 프로파일·칩 없음)으로 접는다 — me 핸들러의 다른 보강 조회들과 같은 규약.
export interface UiSurfaceConfig {
  ui_nav: UiNavConfig;
  announcement: UiAnnouncement | null;
  ui_profile: UiProfile;
  usage_url: string | null;
}
export async function getUiSurface(): Promise<UiSurfaceConfig> {
  try {
    const r = await itemsPool.query(`SELECT ui_nav, announcement, ui_profile, usage_url FROM org_runtime_config WHERE id=1`);
    const row = r.rows[0] as Record<string, unknown> | undefined;
    return {
      ui_nav: uiNavSafe(row?.ui_nav),
      announcement: announcementSafe(row?.announcement),
      ui_profile: uiProfileSafe(row?.ui_profile),
      usage_url: usageUrlSafe(row?.usage_url),
    };
  } catch {
    return { ui_nav: {}, announcement: null, ui_profile: "full", usage_url: null };
  }
}
