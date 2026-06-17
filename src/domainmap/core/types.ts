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
// 기본 'lively'(레거시, 불가침 가드레일). SYNC_BLOCKED_REPOS 환경변수(콤마 구분)로 박스별 재정의.
// 가드는 라우트가 아니라 코어 함수 — HTTP·CLI·미래의 다른 진입점이 전부 같은 가드를 통과한다.
// lazy 1회 계산: 모듈 로드 시점의 env 의존(--env-file 순서 사고) 제거.
let blocked: Set<string> | null = null;
export function syncBlockedRepos(): Set<string> {
  if (!blocked) {
    blocked = new Set(
      (process.env.SYNC_BLOCKED_REPOS ?? "lively").split(",").map((s) => s.trim()).filter(Boolean));
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

// editDomainById — after 의 키 5개가 계약(값은 patch/row 패스스루라 unknown).
export interface DomainEditResult {
  id: number; change_id: number;
  after: { name: unknown; description: unknown; cross_cutting: unknown; status: string; origin: string };
}
export type DomainSetResult = { domain: string } & DomainEditResult;

// setDomainState — no-op 은 change_id '키 부재'가 계약(추가 금지): 유니온으로 컴파일 타임 검증.
export type DomainStateResult =
  | { id: number; change_id: number; state: string }
  | { id: number; action: "unchanged"; state: string };

// P6a 신뢰우선: propose_domain 도 proposed 림보 없이 confirmed 로 착지(evidence 는 provenance 로 보존).
export interface ProposeDomainResult { repo: string; id: number; key: string; status: "confirmed"; change_id: number }

// P-V3-4a: 통제어휘 도메인 CRUD. domain_create 는 propose 와 달리 evidence 게이트 없이 통제어휘를
//  채워넣는 경로 — 결과 shape 은 동일 키 집합(repo/id/key/status/change_id). status 'confirmed' 고정.
export interface CreateDomainResult { repo: string; id: number; key: string; status: "confirmed"; change_id: number }
// domain_rename = soft-alias(H3): 물리 key 불변 + (old_key→new_key) 별칭 적재 + 표시명(name) 갱신.
//  aliased=true 면 신규 별칭 행 적재됨, false 면 name-only 변경(별칭 불필요·동일 key). after 는 표시 갱신값.
export interface RenameDomainResult {
  repo: string; id: number; key: string; old_key: string; new_key: string;
  aliased: boolean; change_id: number; after: { name: unknown };
}
// repo CRUD — domainmap 자기완결 엔티티(cross-DB cascade 없음). state 축 active|deprecated.
export interface RepoCreateResult { id: number; name: string; change_id: number }
export interface RepoRenameResult { id: number; old_name: string; new_name: string; change_id: number }
export type RepoStateResult =
  | { id: number; name: string; change_id: number; state: string }
  | { id: number; name: string; action: "unchanged"; state: string };
export interface MergeResult { from_id: number; into_id: number; moved_mappings: number; folded_mappings: number; change_id: number }
export interface ReassignResult {
  id: number; change_id: number;
  after: { domain_id: number; status: string; origin: string };
}
export interface RestoreResult { restored: number; change_id: number; action: "deleted" | "reverted"; table: string; entity_id: number }

// syncProject — unchanged 응답에 change_id 키 부재가 계약(유니온으로 고정).
export type SyncProjectResult =
  | { repo: string; id: number; key: string; action: "insert" | "update"; change_id: number }
  | { repo: string; id: number; key: string; action: "unchanged" };

export interface IngestResult { repo: string; run_id: number; tally: Record<string, number> }
// refresh — tally 는 카운터 + (file granularity 시) aggregation 객체가 섞인다.
export interface RefreshResult { repo: string; run_id: number; base: unknown; head: unknown; tally: Record<string, unknown> }

// 읽기 리스트 아이템(queries.ts 가 구성하는 리터럴) — in-process 소비자(items/mapping-candidates 등)는
// 이 타입에서 Pick 으로 좁혀 쓴다(같은 이름·다른 shape 의 중복 선언 금지).
export interface BestDomainRef { id: number; key: string; name: string; cross_cutting: boolean; status: string }
export interface TouchProjectRef { key: string; name: string; kind: string | null; last_at: Date | null; commit_count: number | null }

export interface DomainListItem {
  id: number; key: string; name: string; description: string | null;
  state: string | null; cross_cutting: boolean; origin: string | null; status: string;
  units: number; entities: number; debts: number; proposed: number;
}

export interface ProjectListItem {
  id: number; key: string; name: string; description: string | null; kind: string | null;
  status: string; origin: string | null; started_at: Date | null; ended_at: Date | null;
  state: string | null; prov_system: string | null; external_url: string | null; last_synced_at: Date | null;
  touched_code: number; touched_entities: number;
}

export interface EntityListItem {
  id: number; name: string; source: string | null; kind: string | null;
  domain: BestDomainRef | null; projects: TouchProjectRef[];
}

export interface CodeListItem {
  id: number; path: string; kind: string | null; label: string; state: string; prev_path: string | null;
  domain: BestDomainRef | null; projects: TouchProjectRef[];
}

export interface DebtListItem {
  id: number; kind: string; title: string; detail: string | null;
  cited_refs: unknown; status: string; origin: string | null;
}
