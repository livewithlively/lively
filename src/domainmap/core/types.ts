// domainmap 코어 공유 타입·환경 헬퍼·에러 규약 — store-core.mjs 에서 이식.
// 원칙: 에러는 e.status 가 붙은 plain Error(httpErr) — capability 계층이 HttpError 로 번역하거나
// 구 HTTP 엔벨로프('domainmap <status> <path>: <msg>')로 감싼다. 코어는 표면을 모른다.
export type { Db } from "../db.js";

export interface Actor {
  type: "human" | "agent";
  id: string;
}

// e.status 붙은 plain Error 팩토리 — store-core 의 `const e = new Error(msg); e.status = N; throw e`
// 패턴 그대로(메시지 byte 동일이 계약).
export function httpErr(status: number, msg: string): Error & { status: number } {
  const e = new Error(msg) as Error & { status: number };
  e.status = status;
  return e;
}

// limit 을 [1, max] 정수로 강제 — 비숫자/NaN/범위 밖은 def 폴백(NaN 이 pg 에 닿아 500 나는 것 방지).
// store-core.saneLimit verbatim.
export function saneLimit(limit: unknown, def = 50, max = 500): number {
  const n = Number(limit);
  if (!Number.isFinite(n)) return def;
  const i = Math.trunc(n);
  if (i < 1) return def;
  return Math.min(i, max);
}

// 싱크 보호 리포 deny-list — 커넥터 싱크/도메인 authoring 이 절대 쓰면 안 되는 리포.
// 기본은 빈 set(보호 대상 없음). 보호할 리포는 SYNC_BLOCKED_REPOS 환경변수(콤마 구분)로만 지정한다.
// 가드는 라우트가 아니라 코어 함수 — HTTP·CLI·미래의 다른 진입점이 전부 같은 가드를 통과한다.
// lazy 1회 계산: 모듈 로드 시점의 env 의존(--env-file 순서 사고) 제거.
let blocked: Set<string> | null = null;
export function syncBlockedRepos(): Set<string> {
  if (!blocked) {
    blocked = new Set(
      (process.env.SYNC_BLOCKED_REPOS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  }
  return blocked;
}

// repo 인자 해소 — 구 domainmap/client.ts 에서 이주(에러 문구 byte 동일 — wrap() 의 '미지정' 400 토큰).
export function resolveRepo(repo?: string): string {
  const r = repo ?? (process.env.DOMAINMAP_DEFAULT_REPO ?? "");
  if (!r) throw new Error("repo 미지정 — 인자로 주거나 DOMAINMAP_DEFAULT_REPO 를 설정하세요");
  return r;
}

// ── 결과/리스트 타입 — 코어가 '직접 구성해 반환하는' 리터럴 객체의 키 집합을 컴파일 타임에 고정한다.
// (byte-compat 의 본질 = 키 집합 불변. 내부 SQL row 처리는 원본 .mjs 와 동일하게 동적(any) 유지 —
//  값 타입이 동적 row 에서 흘러오는 필드는 unknown 으로 정직하게 둔다.)
// pg 런타임 현실: timestamptz 는 Date, jsonb 는 객체로 돌아온다(직렬화 표면은 동일 ISO).

// 단순 큐레이션 쓰기의 공통 결과 — confirm{Domain,Mapping,Project}/rejectMapping/setDebtStatus.
export interface CurationResult { id: number; change_id: number }

// v6 은퇴(2026-06-24): 도메인 authoring 결과타입(DomainEdit/Set/State·Propose/Create/RenameDomainResult) 제거 — domain authoring 은 category_* 로 대체됨.
// repo CRUD — domainmap 자기완결 엔티티. state 축 active|deprecated.
export interface RepoCreateResult { id: number; name: string; change_id: number }
export interface RepoRenameResult { id: number; old_name: string; new_name: string; change_id: number }
// hard-delete(영구삭제) — deprecate(숨김 보존)와 구분. 가드 모드(연결 있으면 거부+카운트)는 별 shape:
//  blocked=true 면 삭제 안 함(refs 카운트만 반환), force 로 재호출하면 cascade 실행(deleted=true).
export interface RepoDeleteBlocked {
  blocked: true; id: number; name: string;
  refs: { code_units: number; data_entities: number }; // v6: category 는 repo-free라 repo 삭제 차단/카운트에서 제외
}
export interface RepoDeleteDone {
  deleted: true; id: number; name: string;
  removed: { code_units: number; data_entities: number; mappings: number; debts: number };
}
export type RepoDeleteResult = RepoDeleteBlocked | RepoDeleteDone;
export type RepoStateResult =
  | { id: number; name: string; change_id: number; state: string }
  | { id: number; name: string; action: "unchanged"; state: string };
export interface RestoreResult { restored: number; change_id: number; action: "deleted" | "reverted"; table: string; entity_id: number }

export interface IngestResult { repo: string; run_id: number; tally: Record<string, number> }
// refresh — tally 는 카운터 + (file granularity 시) aggregation 객체가 섞인다.
export interface RefreshResult { repo: string; run_id: number; base: unknown; head: unknown; tally: Record<string, unknown> }

// 읽기 리스트 아이템(queries.ts 가 구성하는 리터럴).
export interface DomainListItem {
  id: number; key: string; name: string; description: string | null;
  should: string | null; // P5: 의도(당위) 스펙 — is(units)와 별 축. 괴리=domain-debt(should_no_is).
  state: string | null; cross_cutting: boolean; origin: string | null; status: string;
  // V4-P1 area 2단(B): space — 'product'(코드앵커 도메인) | 'business'(vocab-only 비즈니스 기능). 항상 방출(?? 'product').
  space: string;
  units: number; entities: number; debts: number; proposed: number;
}

export interface DebtListItem {
  id: number; kind: string; title: string; detail: string | null;
  cited_refs: unknown; status: string; origin: string | null;
}
