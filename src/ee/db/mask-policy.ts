// ⚠ Lively Enterprise Edition — 이 디렉터리(src/ee)는 상용 라이센스다. src/ee/LICENSE 참조.
//   유효한 구독 없이 프로덕션에서 사용할 수 없다(열람·개발·테스트는 허용).
//
// 컬럼 마스킹 정책 · raw-PII 언마스크 grant · 감사대상 컬럼(#186 · #746 P4/P5).
//  SoT = DB(org_db_column_mask · org_db_subject_key · org_db_unmask_grant, 웹 관리). 짧은 TTL 스냅샷으로
//  무재시작 반영. 테이블 allow/deny(기본 안전장치)는 코어 db/policy.ts 가 담당하고, 여기서는 그 위에
//  마스킹 정보를 얹는(applyMaskOverlay) 구조다.
import { listColumnMasks, listSubjectKeys, listActiveUnmaskGrants } from "../../org/store.js";
import type { SourcePolicy } from "../../db/firewall.js";
import type { MaskStyle } from "../../db/mask.js";
import type { UnmaskResolution } from "../../db/policy.js";
import type { Queryable } from "../../enterprise/registry.js";

interface MaskSnap {
  maskStyle: Map<string, MaskStyle>; // `${lower(table)}.${lower(col)}` -> style
  subjectCols: Set<string>; // `${lower(table)}.${lower(col)}` — 감사 대상 식별자 컬럼(P5, #746)
}

let _snap: Map<string, MaskSnap> | null = null;
let _loadedAt = 0;
const TTL_MS = 5000;

export async function refreshMaskPolicy(force: boolean): Promise<void> {
  const now = Date.now();
  if (!force && _snap && now - _loadedAt < TTL_MS) return;
  if (!process.env.ITEMS_DATABASE_URL) { _snap = _snap ?? new Map(); _loadedAt = now; return; }
  let masks: Awaited<ReturnType<typeof listColumnMasks>>;
  let subjects: Awaited<ReturnType<typeof listSubjectKeys>>;
  try {
    [masks, subjects] = await Promise.all([listColumnMasks(), listSubjectKeys()]);
  } catch {
    if (!_snap) _snap = new Map();
    return; // 직전 스냅샷 유지(있으면)
  }
  const m = new Map<string, MaskSnap>();
  const of = (src: string): MaskSnap => {
    let s = m.get(src);
    if (!s) { s = { maskStyle: new Map(), subjectCols: new Set() }; m.set(src, s); }
    return s;
  };
  for (const c of masks) of(c.source).maskStyle.set(`${c.table_name.toLowerCase()}.${c.column_name.toLowerCase()}`, c.style);
  for (const s of subjects) of(s.source).subjectCols.add(`${s.table_name.toLowerCase()}.${s.column_name.toLowerCase()}`);
  _snap = m;
  _loadedAt = now;
}

function snapOf(source: string): MaskSnap {
  return _snap?.get(source) ?? { maskStyle: new Map(), subjectCols: new Set() };
}

/** 이 박스에 컴플라이언스 정책이 실제로 설정돼 있는가(진단·fail-closed 판정 보조). */
export function hasComplianceConfig(): boolean {
  if (!_snap) return false;
  for (const s of _snap.values()) if (s.maskStyle.size > 0 || s.subjectCols.size > 0) return true;
  return false;
}

export function getSubjectColSet(source: string): Set<string> {
  return snapOf(source).subjectCols;
}

// ── raw-PII 언마스크 해소(P4) — '*' 컬럼 grant 는 그 테이블의 모든 마스킹 컬럼으로 확장. userId+source 짧은 TTL 캐시.
//  해소 실패는 빈 집합(fail-safe — 전부 마스킹 유지).
interface UnmaskEntry extends UnmaskResolution { at: number }
const _unmaskCache = new Map<string, UnmaskEntry>();
const EMPTY_UNMASK: UnmaskResolution = { keys: new Set(), grantsByKey: new Map() };

export async function resolveUnmaskKeys(userId: string, source: string): Promise<UnmaskResolution> {
  const snap = snapOf(source);
  if (snap.maskStyle.size === 0) return EMPTY_UNMASK; // 마스킹 없는 소스 — 언마스크 무의미
  const cacheKey = `${userId}:${source}`;
  const now = Date.now();
  const cached = _unmaskCache.get(cacheKey);
  if (cached && now - cached.at < TTL_MS) return { keys: cached.keys, grantsByKey: cached.grantsByKey };

  const keys = new Set<string>();
  const grantsByKey = new Map<string, string[]>(); // `table.col` -> grant id[](컬럼별 — 감사에 실제 관여 grant 만 귀속)
  const addKey = (mk: string, gid: string): void => {
    keys.add(mk);
    const arr = grantsByKey.get(mk); if (arr) { if (!arr.includes(gid)) arr.push(gid); } else grantsByKey.set(mk, [gid]);
  };
  try {
    const grants = await listActiveUnmaskGrants(userId, source);
    const maskedKeys = [...snap.maskStyle.keys()]; // `table.col`
    for (const g of grants) {
      const tbl = g.table_name.toLowerCase();
      const col = g.column_name.toLowerCase();
      const gid = String(g.id);
      if (col === "*") {
        for (const mk of maskedKeys) if (mk.slice(0, mk.indexOf(".")) === tbl) addKey(mk, gid);
      } else if (maskedKeys.includes(`${tbl}.${col}`)) {
        addKey(`${tbl}.${col}`, gid); // 실제 마스킹 컬럼을 연 grant 만(무효/스테일 grant 는 감사 잡음 배제)
      }
    }
  } catch {
    // fail-safe — 해소 실패 시 언마스크 0(전부 마스킹 유지). 다음 TTL 에 재시도.
    return EMPTY_UNMASK;
  }
  _unmaskCache.set(cacheKey, { keys, grantsByKey, at: now });
  return { keys, grantsByKey };
}

// P4 감사 정확성용 — 캐시된 pg 카탈로그 base(srcKeyToCol, 언마스크 전 전체)를 조회한다.
//  db_query 가 이 쿼리 출력(out.fields)의 srcKey 를 `table.col` 로 되돌려 '실제 반환된 언마스크 컬럼'만 감사에 남기게 한다.
//  resolveMaskedAttrs 가 먼저 불려 base 가 캐시돼 있어야 한다(마스킹 있는 pg 소스면 db_query 가 이미 호출).
export function peekMaskedSrcKeyToCol(source: string): Map<string, string> | undefined {
  return _attrCache.get(source)?.srcKeyToCol;
}

// db_schema 컬럼 마스킹 표시용 — `${lower(table)}.${lower(col)}` -> style. unmask 를 주면 그 키를 뺀 맵(언마스크 반영).
export function getMaskStyleMap(source: string, unmask?: ReadonlySet<string>): Map<string, MaskStyle> {
  const full = snapOf(source).maskStyle;
  if (!unmask || unmask.size === 0) return full;
  const out = new Map<string, MaskStyle>();
  for (const [k, v] of full) if (!unmask.has(k)) out.set(k, v);
  return out;
}

// 코어가 조립한 SourcePolicy(테이블 모드까지)에 마스킹 정보를 얹는다.
//  unmask(P4): 이 집합의 `table.col` 은 마스킹 대상에서 제외 → Gate1 파생차단·Gate2 값마스킹·minMaskedOutputs 가
//  요청자 기준으로 자연 정합(언마스크 권한자는 그 컬럼을 raw 로 WHERE/JOIN/파생 가능).
export function applyMaskOverlay(base: SourcePolicy, source: string, unmask?: ReadonlySet<string>): SourcePolicy {
  const effMask = getMaskStyleMap(source, unmask);
  const maskedCols = new Set(effMask.keys());
  const maskedColNames = new Set<string>();
  for (const k of maskedCols) maskedColNames.add(k.slice(k.indexOf(".") + 1));
  return { ...base, maskedCols, maskedColNames, hasMasks: maskedCols.size > 0 };
}

// ── 게이트2(출처기반 마스킹)용 — 마스킹 (table,col) 을 소스 카탈로그의 (oid,attnum) 로 해석해 style 맵을 만든다. ──
//  캐시(소스별 짧은 TTL). 스키마 쉬프트로 oid 가 바뀌어도 fail-closed 카운트 교차검증(tools/db.ts)이 유출 대신 deny 로 막는다.
interface AttrEntry { attr: Map<string, MaskStyle>; at: number; srcKeyToCol?: Map<string, string> }
const _attrCache = new Map<string, AttrEntry>();

//  unmask(P4): 이 `table.col` 집합은 결과 마스킹에서 제외한다(per-user 언마스크). 캐시는 언마스크 전(원본)을
//  소스별로 두고, 언마스크는 그 위에서 매 호출 필터 — 사용자마다 다른 언마스크가 캐시를 오염시키지 않게 한다.
export async function resolveMaskedAttrs(source: string, q: Queryable, unmask?: ReadonlySet<string>): Promise<Map<string, MaskStyle>> {
  const now = Date.now();
  let base = _attrCache.get(source);
  if (!base || now - base.at >= TTL_MS) {
    const styleMap = snapOf(source).maskStyle;
    const attr = new Map<string, MaskStyle>(); // srcKey(oid:attnum) -> style
    const srcKeyToCol = new Map<string, string>(); // srcKey -> `table.col`(언마스크 필터용)
    if (styleMap.size > 0) {
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
        const col = `${String(row.relname).toLowerCase()}.${String(row.attname).toLowerCase()}`;
        const style = styleMap.get(col);
        if (style) {
          const srcKey = `${Number(row.oid)}:${Number(row.attnum)}`;
          attr.set(srcKey, style);
          srcKeyToCol.set(srcKey, col);
        }
      }
    }
    base = { attr, at: now, srcKeyToCol } as AttrEntry;
    _attrCache.set(source, base);
  }
  if (!unmask || unmask.size === 0) return base.attr;
  const out = new Map<string, MaskStyle>();
  for (const [srcKey, style] of base.attr) {
    const col = base.srcKeyToCol?.get(srcKey);
    if (col && unmask.has(col)) continue; // 언마스크 컬럼 — 마스킹 대상에서 제외
    out.set(srcKey, style);
  }
  return out;
}

// ── db 접근 감사(P5, #746)용 — subject 컬럼(table.col)을 pg 카탈로그의 (oid,attnum)=srcKey 로 해석. ──
//  resolveMaskedAttrs 미러(전용 캐시). mysql 은 srcKey 가 이미 table.col 이라 해석 불요(tools/db.ts 직접 매칭).
interface SubjEntry { attr: Map<string, string>; at: number } // srcKey(oid:attnum) -> `table.col`
const _subjCache = new Map<string, SubjEntry>();

export async function resolveSubjectAttrs(source: string, q: Queryable): Promise<Map<string, string>> {
  const now = Date.now();
  const cached = _subjCache.get(source);
  if (cached && now - cached.at < TTL_MS) return cached.attr;

  const subjectCols = snapOf(source).subjectCols;
  const attr = new Map<string, string>();
  if (subjectCols.size === 0) { _subjCache.set(source, { attr, at: now }); return attr; }

  const tables = [...new Set([...subjectCols].map((k) => k.slice(0, k.indexOf("."))))];
  const r = await q.query(
    `SELECT c.oid::int8 AS oid, c.relname, a.attnum, a.attname
       FROM pg_class c
       JOIN pg_attribute a ON a.attrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped`,
    [tables],
  );
  for (const row of r.rows) {
    const key = `${String(row.relname).toLowerCase()}.${String(row.attname).toLowerCase()}`;
    if (subjectCols.has(key)) attr.set(`${Number(row.oid)}:${Number(row.attnum)}`, key);
  }
  _subjCache.set(source, { attr, at: now });
  return attr;
}

// 테스트/즉시반영 — 캐시 무효화.
export function resetCacheForTest(): void {
  _snap = null;
  _loadedAt = 0;
  _attrCache.clear();
  _subjCache.clear();
  _unmaskCache.clear();
}
