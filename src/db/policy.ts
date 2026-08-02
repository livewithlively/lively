// db_query 소스별 정책(#186) — **테이블 allow/deny 는 코어(AGPL), 컬럼 마스킹·언마스크 grant·감사대상
//  컬럼은 Enterprise(src/ee/db/mask-policy.ts).**
//
//  왜 이렇게 갈랐나: "이 테이블은 읽지 마라"는 무료판에도 있어야 하는 **기본 안전장치**다(없으면 무료판이
//   위험한 제품이 된다). 반면 컬럼 마스킹·JIT 언마스크·감사대상 지정은 규제 컴플라이언스의 실체다.
//
//  단일 출처(SoT): DB(org_db_table_policy · org_db_column_mask, 웹 관리). 라이브 스키마 위 오버레이 — 스키마 사본은 저장 안 함.
//  db_query 가 매 호출 refreshPolicy() 로 짧은 TTL 스냅샷을 최신화 → 웹 편집 무재시작 반영(sources.ts 와 동일 패턴).
import { listTablePolicies, listColumnMasks, listSubjectKeys } from "../org/store.js";
import { getSourceConfig } from "./sources.js";
import type { SourcePolicy } from "./firewall.js";
import type { MaskStyle } from "./mask.js";
import { SELF_SOURCE, selfBaseTableMode } from "./self-source.js";
import { ee, assertEnterpriseForCompliance, type Queryable } from "../enterprise/registry.js";

interface PolicySnap {
  tableMode: Map<string, "allow" | "deny">; // lower(table) -> mode
}

let _snap: Map<string, PolicySnap> | null = null;
let _loadedAt = 0;
const TTL_MS = 5000;

// org_db_table_policy 를 TTL 만료 시 재쿼리해 스냅샷 교체. 로드 실패 시 직전 스냅샷 유지(비클로버).
//  EE 가 있으면 이어서 마스킹·감사대상 스냅샷도 갱신한다. 없으면 '집행할 주체 없이 남은 컴플라이언스 설정'을
//  확인해 fail-closed 로 막는다(설정이 없으면 무료판 정상 동작 — 아무 일도 하지 않는다).
export async function refreshPolicy(force = false): Promise<void> {
  const now = Date.now();
  if (!force && _snap && now - _loadedAt < TTL_MS) return;
  if (!process.env.ITEMS_DATABASE_URL) { _snap = _snap ?? new Map(); _loadedAt = now; return; }
  let policies: Awaited<ReturnType<typeof listTablePolicies>>;
  try {
    policies = await listTablePolicies();
  } catch {
    if (!_snap) _snap = new Map();
    return; // 직전 스냅샷 유지(있으면)
  }
  const m = new Map<string, PolicySnap>();
  const of = (src: string): PolicySnap => {
    let s = m.get(src);
    if (!s) { s = { tableMode: new Map() }; m.set(src, s); }
    return s;
  };
  for (const p of policies) of(p.source).tableMode.set(p.table_name.toLowerCase(), p.mode);
  _snap = m;
  _loadedAt = now;

  const h = ee().dbMaskPolicy;
  if (h) { await h.refreshMaskPolicy(force); return; }
  await assertNoOrphanCompliancePolicy();
}

// EE 미탑재인데 마스킹/감사대상 설정이 DB 에 남아 있으면 거부 — 조용히 raw 를 흘리는 것보다 멈추는 편이 안전하다.
//  (조회 실패는 통과시킨다 — 감사 설정 조회 실패로 db_query 전체를 죽이지 않는다.)
async function assertNoOrphanCompliancePolicy(): Promise<void> {
  let masks: Awaited<ReturnType<typeof listColumnMasks>>;
  let subjects: Awaited<ReturnType<typeof listSubjectKeys>>;
  try {
    [masks, subjects] = await Promise.all([listColumnMasks(), listSubjectKeys()]);
  } catch {
    return;
  }
  if (masks.length > 0) assertEnterpriseForCompliance("컬럼 마스킹");
  if (subjects.length > 0) assertEnterpriseForCompliance("감사 대상 컬럼(subject key)");
}

function snapOf(source: string): PolicySnap {
  return _snap?.get(source) ?? { tableMode: new Map() };
}

// db 접근 감사(P5, #746) — 이 소스의 '조회 대상 식별자' 컬럼 집합(`table.col` lower). EE 기능.
export function getSubjectColSet(source: string): Set<string> {
  return ee().dbMaskPolicy?.getSubjectColSet(source) ?? new Set();
}

// ── raw-PII 언마스크 해소(P4, #746) — 요청 멤버·소스의 유효 grant 를 `table.col` 집합으로. ──
//  반환 집합은 getSourcePolicy/getMaskStyleMap/resolveMaskedAttrs 의 unmask 인자로.
export interface UnmaskResolution {
  keys: Set<string>; // `table.col` 언마스크 대상(정책의 실제 마스킹 컬럼만)
  grantsByKey: Map<string, string[]>; // `table.col` -> 그 컬럼을 연 grant id[](감사 정확성: 컬럼별 귀속)
}
const EMPTY_UNMASK: UnmaskResolution = { keys: new Set(), grantsByKey: new Map() };

/** EE 미탑재면 언마스크 개념 자체가 없다(마스킹이 없으므로) — 빈 해소. */
export async function resolveUnmaskKeys(userId: string, source: string): Promise<UnmaskResolution> {
  const h = ee().dbMaskPolicy;
  return h ? h.resolveUnmaskKeys(userId, source) : EMPTY_UNMASK;
}

// P4 감사 정확성용 — 캐시된 pg 카탈로그 base(srcKeyToCol, 언마스크 전 전체)를 조회한다.
export function peekMaskedSrcKeyToCol(source: string): Map<string, string> | undefined {
  return ee().dbMaskPolicy?.peekMaskedSrcKeyToCol(source);
}

// db_schema 컬럼 마스킹 표시용 — `${lower(table)}.${lower(col)}` -> style.
export function getMaskStyleMap(source: string, unmask?: ReadonlySet<string>): Map<string, MaskStyle> {
  return ee().dbMaskPolicy?.getMaskStyleMap(source, unmask) ?? new Map();
}

// 방화벽(게이트1)에 넘길 SourcePolicy 조립 — tableDefault 는 org_db_source(sources 스냅샷)에서.
//  코어는 테이블 모드까지 조립하고, 마스킹 정보(maskedCols·hasMasks)는 EE 오버레이가 얹는다.
//  #604 내장 self 소스 — default-deny 위에 콘텐츠 allow-list 를 베이스로 깔고, 그 위에 web(org_db_table_policy 'self')
//  오버레이를 얹는다(운영자가 웹에서 특정 테이블을 추가 허용/차단 가능 — 운영자 지정이 코드 베이스보다 우선).
export function getSourcePolicy(source: string, unmask?: ReadonlySet<string>): SourcePolicy {
  const s = snapOf(source);
  let tableMode = s.tableMode;
  if (source === SELF_SOURCE) {
    tableMode = selfBaseTableMode();
    for (const [k, v] of s.tableMode) tableMode.set(k, v);
  }
  const base: SourcePolicy = {
    tableDefault: getSourceConfig(source)?.tableDefault ?? "allow",
    tableMode,
    maskedCols: new Set<string>(),
    maskedColNames: new Set<string>(),
    hasMasks: false,
  };
  const h = ee().dbMaskPolicy;
  return h ? h.applyMaskOverlay(base, source, unmask) : base;
}

// ── 게이트2(출처기반 마스킹)용 — 마스킹 (table,col) 을 소스 카탈로그의 (oid,attnum) 로 해석해 style 맵을 만든다. ──
export async function resolveMaskedAttrs(source: string, q: Queryable, unmask?: ReadonlySet<string>): Promise<Map<string, MaskStyle>> {
  const h = ee().dbMaskPolicy;
  return h ? h.resolveMaskedAttrs(source, q, unmask) : new Map();
}

// ── db 접근 감사(P5, #746)용 — subject 컬럼(table.col)을 pg 카탈로그의 (oid,attnum)=srcKey 로 해석. ──
export async function resolveSubjectAttrs(source: string, q: Queryable): Promise<Map<string, string>> {
  const h = ee().dbMaskPolicy;
  return h ? h.resolveSubjectAttrs(source, q) : new Map();
}

// 테스트/즉시반영 — 캐시 무효화.
export function _resetPolicyCacheForTest(): void {
  _snap = null;
  _loadedAt = 0;
  ee().dbMaskPolicy?.resetCacheForTest();
}
