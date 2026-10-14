// 공개 판을 깨는 표 변경 찾기(#4483 × #4667, 순수).
//  공개 앱에 «초안으로만» 저장하면 초안을 만든 사람만 새 코드를 보고, 나머지는 공개 판의 옛 코드로 **같은 물리 표**를 계속 쓴다
//  (표는 판마다가 아니라 앱에 한 벌 — install-run keepTables 주석). 그 사이 옛 코드를 깨는 표 변경(칸 지우기·이름·형 바꾸기·
//  제약 조이기·unique 빼기 …)이 깔리면 공개 판이 그 자리에서 깨진다. 그래서 그런 변경은 «바로 공개하며 저장» 할 때만 받는다
//  (그때는 공개 판도 같은 순간 바뀐다). 새 칸·새 표·제약 풀기는 옛 코드를 깨지 않아 초안으로도 된다.
//  견주는 것은 두 매니페스트(공개 판 ↔ 저장할 것) — DB 를 보지 않는다. 모양이 어긋난 옛 매니페스트에도 던지지 않는다.
import { parseColumnType } from "./store-ddl.js";

interface Col {
  name?: unknown; type?: unknown; not_null?: unknown; unique?: unknown; check?: unknown; values?: unknown;
  references?: unknown; default?: unknown; default_expr?: unknown; renamed_from?: unknown;
}
interface Table { name?: unknown; columns?: unknown; checks?: unknown; indexes?: unknown; drop_columns?: unknown }

const tablesOf = (m: unknown): Table[] => {
  const t = (m as { data?: { tables?: unknown } } | null)?.data?.tables;
  return Array.isArray(t) ? t.filter((x): x is Table => !!x && typeof x === "object") : [];
};
const colsOf = (t: Table): Col[] => (Array.isArray(t.columns) ? t.columns.filter((x): x is Col => !!x && typeof x === "object") : []);
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.map((v) => String(v)) : []);
const canon = (type: unknown): string | null => { try { return parseColumnType(String(type)).canonical; } catch { return null; } };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** unique 인덱스 열쇠 — 칸 묶음(순서 그대로). */
const uniqueIndexes = (t: Table): Set<string> => new Set((Array.isArray(t.indexes) ? t.indexes : [])
  .filter((ix): ix is { columns?: unknown; unique?: unknown } => !!ix && typeof ix === "object" && (ix as { unique?: unknown }).unique === true)
  .map((ix) => strs(ix.columns).join(",")));

/** 공개 판(published)을 쓰는 옛 코드를 깨는 표 변경 목록(사람이 읽는 한 줄씩). 없으면 빈 목록. */
export function publishedBreakingChanges(published: unknown, next: unknown): string[] {
  const out: string[] = [];
  const nextTables = new Map(tablesOf(next).map((t) => [String(t.name ?? ""), t]));
  for (const pt of tablesOf(published)) {
    const name = String(pt.name ?? "");
    const nt = nextTables.get(name);
    if (!nt) continue;                                   // 표를 선언에서 빼도 공개 판이 쓰는 동안은 지우지 않는다(keepTables)
    const nextCols = new Map(colsOf(nt).map((c) => [String(c.name ?? ""), c]));
    const dropped = new Set(strs(nt.drop_columns));
    for (const pc of colsOf(pt)) {
      const col = String(pc.name ?? "");
      const at = `${name}.${col}`;
      if (dropped.has(col)) { out.push(`칸 지우기 ${at}`); continue; }
      const renamed = colsOf(nt).find((c) => String(c.renamed_from ?? "") === col && String(c.name ?? "") !== col);
      if (renamed) { out.push(`이름 바꾸기 ${at} → ${String(renamed.name)}`); continue; }
      const nc = nextCols.get(col);
      if (!nc) continue;                                 // 선언에서만 빠진 칸 — 그대로 남는다
      const a = canon(pc.type), b = canon(nc.type);
      if (a && b && a !== b) out.push(`형 바꾸기 ${at} (${a} → ${b})`);
      if (nc.not_null === true && pc.not_null !== true) out.push(`not_null 더하기 ${at}`);
      if (nc.unique === true && pc.unique !== true) out.push(`unique 더하기 ${at}`);
      if (pc.unique === true && nc.unique !== true) out.push(`unique 빼기 ${at}(공개 판의 ON CONFLICT 가 기댄다)`);
      if (nc.check !== undefined && !same(nc.check, pc.check)) out.push(`검사 ${pc.check === undefined ? "더하기" : "바꾸기"} ${at}`);
      const pv = strs(pc.values), nv = new Set(strs(nc.values));
      if (pv.length && nv.size && pv.some((v) => !nv.has(v))) out.push(`enum 값 빼기 ${at}`);
      if (nc.references !== undefined && !same(nc.references, pc.references)) out.push(`외래키 ${pc.references === undefined ? "더하기" : "바꾸기"} ${at}`);
      const hadDefault = pc.default !== undefined || pc.default_expr !== undefined;
      if (hadDefault && (!same(nc.default, pc.default) || !same(nc.default_expr, pc.default_expr))) out.push(`기본값 바꾸기 ${at}`);
    }
    const pChecks = new Set(strs(pt.checks));
    for (const ck of strs(nt.checks)) if (!pChecks.has(ck)) out.push(`표 검사 더하기 ${name}: ${ck}`);
    const pu = uniqueIndexes(pt), nu = uniqueIndexes(nt);
    for (const k of nu) if (!pu.has(k)) out.push(`unique 인덱스 더하기 ${name}(${k})`);
    for (const k of pu) if (!nu.has(k)) out.push(`unique 인덱스 빼기 ${name}(${k})(공개 판의 ON CONFLICT 가 기댄다)`);
  }
  return out;
}

/** 거부 문구 — 무엇이 깨지는지와 대신 할 길. */
export function publishedBreakingMessage(changes: string[], how = "app_save {publish:true}"): string {
  return `공개 판이 쓰는 표를 깨는 변경이라 초안으로만 저장할 수 없습니다: ${changes.join(" · ")} — `
    + `바로 공개하며 저장하세요(${how} · 그때는 공개 판도 같은 순간 바뀝니다). `
    + "공개 판을 그대로 두고 시험하려면 새 칸을 더하는 쪽으로 바꾸세요(옛 칸은 나중에 공개하며 저장할 때 drop_columns 로 지웁니다)";
}
