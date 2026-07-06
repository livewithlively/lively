// db_query 소스별 정책(#186) — 테이블 allow/deny + 컬럼 마스킹의 런타임 로더.
//  단일 출처(SoT): DB(org_db_table_policy · org_db_column_mask, 웹 관리). 라이브 스키마 위 오버레이 — 스키마 사본은 저장 안 함.
//  db_query 가 매 호출 refreshPolicy() 로 짧은 TTL 스냅샷을 최신화 → 웹 편집 무재시작 반영(sources.ts 와 동일 패턴).
import { listTablePolicies, listColumnMasks } from "../org/store.js";
import { getSourceConfig } from "./sources.js";
import type { SourcePolicy } from "./firewall.js";
import type { MaskStyle } from "./mask.js";
import { SELF_SOURCE, selfBaseTableMode } from "./self-source.js";

interface PolicySnap {
  tableMode: Map<string, "allow" | "deny">; // lower(table) -> mode
  maskStyle: Map<string, MaskStyle>; // `${lower(table)}.${lower(col)}` -> style
}

let _snap: Map<string, PolicySnap> | null = null;
let _loadedAt = 0;
const TTL_MS = 5000;

// org_db_table_policy · org_db_column_mask 를 TTL 만료 시 재쿼리해 스냅샷 교체. 로드 실패 시 직전 스냅샷 유지(비클로버).
export async function refreshPolicy(force = false): Promise<void> {
  const now = Date.now();
  if (!force && _snap && now - _loadedAt < TTL_MS) return;
  if (!process.env.ITEMS_DATABASE_URL) { _snap = _snap ?? new Map(); _loadedAt = now; return; }
  let policies: Awaited<ReturnType<typeof listTablePolicies>>;
  let masks: Awaited<ReturnType<typeof listColumnMasks>>;
  try {
    [policies, masks] = await Promise.all([listTablePolicies(), listColumnMasks()]);
  } catch {
    if (!_snap) _snap = new Map();
    return; // 직전 스냅샷 유지(있으면)
  }
  const m = new Map<string, PolicySnap>();
  const of = (src: string): PolicySnap => {
    let s = m.get(src);
    if (!s) { s = { tableMode: new Map(), maskStyle: new Map() }; m.set(src, s); }
    return s;
  };
  for (const p of policies) of(p.source).tableMode.set(p.table_name.toLowerCase(), p.mode);
  for (const c of masks) of(c.source).maskStyle.set(`${c.table_name.toLowerCase()}.${c.column_name.toLowerCase()}`, c.style);
  _snap = m;
  _loadedAt = now;
}

function snapOf(source: string): PolicySnap {
  return _snap?.get(source) ?? { tableMode: new Map(), maskStyle: new Map() };
}

// db_schema 컬럼 마스킹 표시용 — `${lower(table)}.${lower(col)}` -> style.
export function getMaskStyleMap(source: string): Map<string, MaskStyle> {
  return snapOf(source).maskStyle;
}

// 방화벽(게이트1)에 넘길 SourcePolicy 조립 — tableDefault 는 org_db_source(sources 스냅샷)에서.
export function getSourcePolicy(source: string): SourcePolicy {
  const s = snapOf(source);
  const maskedCols = new Set(s.maskStyle.keys());
  const maskedColNames = new Set<string>();
  for (const k of maskedCols) maskedColNames.add(k.slice(k.indexOf(".") + 1));
  // #604 내장 self 소스 — default-deny 위에 콘텐츠 allow-list 를 베이스로 깔고, 그 위에 web(org_db_table_policy 'self')
  //  오버레이를 얹는다(운영자가 웹에서 특정 테이블을 추가 허용/차단 가능 — 운영자 지정이 코드 베이스보다 우선).
  let tableMode = s.tableMode;
  if (source === SELF_SOURCE) {
    tableMode = selfBaseTableMode();
    for (const [k, v] of s.tableMode) tableMode.set(k, v);
  }
  return {
    tableDefault: getSourceConfig(source)?.tableDefault ?? "allow",
    tableMode,
    maskedCols,
    maskedColNames,
    hasMasks: s.maskStyle.size > 0,
  };
}

// ── 게이트2(출처기반 마스킹)용 — 마스킹 (table,col) 을 소스 카탈로그의 (oid,attnum) 로 해석해 style 맵을 만든다. ──
//  캐시(소스별 짧은 TTL). 스키마 쉬프트로 oid 가 바뀌어도 fail-closed 카운트 교차검증(tools/db.ts)이 유출 대신 deny 로 막는다.
interface AttrEntry { attr: Map<string, MaskStyle>; at: number }
const _attrCache = new Map<string, AttrEntry>();

interface Queryable { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }

export async function resolveMaskedAttrs(source: string, q: Queryable): Promise<Map<string, MaskStyle>> {
  const now = Date.now();
  const cached = _attrCache.get(source);
  if (cached && now - cached.at < TTL_MS) return cached.attr;

  const styleMap = snapOf(source).maskStyle;
  const attr = new Map<string, MaskStyle>();
  if (styleMap.size === 0) { _attrCache.set(source, { attr, at: now }); return attr; }

  const tables = [...new Set([...styleMap.keys()].map((k) => k.slice(0, k.indexOf("."))))];
  const r = await q.query(
    `SELECT c.oid::int8 AS oid, c.relname, a.attnum, a.attname
       FROM pg_class c
       JOIN pg_attribute a ON a.attrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped`,
    [tables],
  );
  for (const row of r.rows) {
    const style = styleMap.get(`${String(row.relname).toLowerCase()}.${String(row.attname).toLowerCase()}`);
    if (style) attr.set(`${Number(row.oid)}:${Number(row.attnum)}`, style);
  }
  _attrCache.set(source, { attr, at: now });
  return attr;
}

// 테스트/즉시반영 — 캐시 무효화.
export function _resetPolicyCacheForTest(): void {
  _snap = null;
  _loadedAt = 0;
  _attrCache.clear();
}
