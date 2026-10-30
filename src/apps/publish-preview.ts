// 공개 미리 보기(#4732) — 「공개하기」(또는 «이 판으로» 되돌려 공개)가 표에 할 일을 사람이 읽는 줄로 만들고, 걸어 보기의 실패를
//  «막힘»(있던 데이터가 새 규칙에 어긋남 — 공개가 409 로 멈춘다)과 «다 못 봄»(잠금 대기 · 시간 초과)으로 가른다.
//  계산은 capabilities/apps.ts previewPublish 가 실제 공개와 같은 표 맞추기(ensureAppTables)를 한 트랜잭션으로 걸어 보고 되돌려서 한다
//  (따로 된 판정기를 두면 표 보장과 규칙이 갈라진다 — #4724 격리 리뷰). 여기는 순수 함수만 둔다.
import type { AppTableFailure, AppTableReport, GoneTablePlan } from "./store-schema.js";
export type { GoneTablePlan };

export interface PublishPreview {
  app_id: string;
  /** publish = 지금 「공개하기」 · revert = 그 판으로 되돌리고 바로 공개(app_revert publish:true) */
  kind: "publish" | "revert";
  /** 공개될 판 번호 */
  version_no: number | null;
  /** 지금 모두가 쓰는 판 번호(나만 보는 앱이면 없음) */
  published_version_no: number | null;
  /** 표에 할 일(사람이 읽는 줄) — 비었으면 묻지 않고 공개해도 된다. */
  changes: string[];
  /** 바뀌는 것은 아니지만 알아 둘 것(새 판에 없지만 값을 지키려고 남겨 둔 칸 · 종류를 못 바꿔 그대로 둔 칸) — 맞출 때마다 나오므로 이것만으로는 묻지 않는다. */
  notes: string[];
  /** 이대로 공개하면 멈추는 까닭(표 · 칸 · 행 수) — 있으면 공개가 409 로 멈추고 어느 표도 바뀌지 않는다. */
  blocked: string[];
  /** 다 보지 못한 까닭(그 표를 지금 쓰는 사람이 있어 잠금을 못 얻음 · 표가 커서 시간 초과 등) — 있으면 잠시 뒤 다시. */
  incomplete: string | null;
  /** 걸어 본 표 보고서(기계용 — 공개 응답의 tables 와 같은 모양). 지운 칸의 보관 자리 이름은 공개할 때 정해지므로 비운다. */
  tables: AppTableReport | null;
  gone_tables: GoneTablePlan[];
}

/** 잠금 대기 초과(55P03) · 문장 시간 초과(57014) — 미리 보기의 짧은 상한을 넘었다는 뜻이지 데이터 문제가 아니다. */
const LIMIT_CODES = new Set(["55P03", "57014"]);

const envMs = (v: string | undefined, dflt: number): number => {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) && n >= 100 ? Math.floor(n) : dflt;
};

/**
 * 미리 보기의 상한 — 잠금을 기다리는 시간(기본 1.5초)과 문장 하나의 시간(기본 5초). 공개(10초 · 5분)보다 짧다:
 *  미리 보기는 누를 때마다 도는데, 그동안 그 표를 쓰려는 사람이 뒤에 줄을 선다. 넘으면 «다 보지 못했다» 로 돌아온다.
 */
export function previewLimits(env: NodeJS.ProcessEnv = process.env): { lockMs: number; statementMs: number; totalMs: number } {
  return {
    lockMs: envMs(env.LIVELY_APP_PREVIEW_LOCK_MS, 1_500), statementMs: envMs(env.LIVELY_APP_PREVIEW_STATEMENT_MS, 5_000),
    //  전체 — 지나면 남은 표는 걸어 보지 않는다(이미 걸어 본 표의 잠금은 되돌릴 때까지 쥐므로, 문장 상한 × 문장 수로 길어지지 않게).
    totalMs: envMs(env.LIVELY_APP_PREVIEW_TOTAL_MS, 8_000),
  };
}

function constraintLine(k: AppTableReport["constraints"][number]): string | null {
  const at = `${k.table} 표:`;
  const col = k.column ? ` ${k.column} 칸` : "";
  switch (k.kind) {
    case "not_null": return `${at}${col || " 칸"}을 ${k.action === "removed" ? "비워도 되게" : "꼭 채워야 하게"} 바꿈`;
    //  보고서의 unique 는 외래키가 가리킬 (tenant_id, id · 칸) 키뿐이다(사람이 선언한 겹침 막기는 색인으로 온다) — 더하기든 걷기든 안쪽 일이라 싣지 않는다.
    //   그 일은 바로 옆 «다른 표의 행을 가리키게 함» 줄이 알린다.
    case "unique": return null;
    case "foreign_key": return k.action === "removed" ? `${at} 다른 표 가리키기 풀기` : `${at}${col}이 다른 표의 행을 가리키게 함(가리킬 행이 없는 값은 막힘)`;
    case "check": return k.action === "removed" ? `${at} 값 검사 빼기` : k.action === "changed" ? `${at} 값 검사 바꾸기` : `${at}${col} 값 검사 더하기`;
    case "default": return k.action === "removed" ? `${at}${col} 기본값 빼기` : k.action === "changed" ? `${at}${col} 기본값 바꾸기` : `${at}${col} 기본값 더하기`;
    case "primary_key": return `${at} 기본 키 바꾸기`;
    default: return `${at}${col} 규칙 ${k.action}`;
  }
}

/**
 * 보고서 → 사람이 읽는 줄. changes = 이번 공개가 실제로 하는 일 — 값이 사라지거나(칸 · 표 지우기 — 행 수 · 보관) 쓰던 값이 막힐 수 있는 일
 *  (조이기 · 새 검사 · 기본값)을 빠짐없이 싣는다. 찾기 색인처럼 쓰는 사람에게 보이지 않는 일은 싣지 않는다(겹치는 값을 막는 색인은 싣는다).
 *  notes = 맞출 때마다 다시 나오는 상태(남겨 둔 칸 · 못 바꾼 종류) — 바뀌는 일이 아니라서 이것만으로는 묻지 않는다(늘 뜨는 창은 습관적으로 넘기게 된다).
 */
export function describeTableChanges(r: AppTableReport | null, gone: GoneTablePlan[]): { changes: string[]; notes: string[] } {
  const changes: string[] = [];
  const notes: string[] = [];
  if (r) {
    for (const t of r.created) changes.push(`새 표 ${t}`);
    for (const c of r.added_columns) changes.push(`${c.table} 표: 새 칸 ${c.column}`);
    for (const c of r.renamed_columns) changes.push(`${c.table} 표: ${c.from} 칸 이름 바꾸기 → ${c.to}`);
    for (const c of r.converted_columns) changes.push(`${c.table} 표: ${c.column} 칸 종류 바꾸기 ${c.from} → ${c.to}`);
    for (const d of r.dropped_columns) {
      changes.push(d.rows > 0 ? `${d.table} 표: ${d.column} 칸 지우기 — 값이 있는 ${d.rows}행은 따로 보관(앱에서는 더 안 보임)` : `${d.table} 표: ${d.column} 칸 지우기(값 없음)`);
    }
    for (const k of r.constraints) { const line = constraintLine(k); if (line) changes.push(line); }
    for (const ix of r.added_indexes) if (ix.unique) changes.push(`${ix.table} 표: 겹치는 값 막기(${ix.columns.join(", ")})${ix.where !== undefined ? ` — 조건 ${ix.where} 에 맞는 행끼리` : ""}`);
    for (const c of r.type_mismatches) notes.push(`${c.table} 표: ${c.column} 칸 종류는 ${c.declared} 로 못 바꿔 그대로(${c.actual})${c.reason ? ` — ${c.reason}` : ""}`);
    for (const c of r.undeclared_columns) notes.push(`${c.table} 표: ${c.column} 칸은 새 판에 없지만 값을 지키려고 남겨 둠`);
  }
  for (const g of gone) {
    changes.push(g.action === "drop" ? `${g.table} 표 지우기 — 새 판에 없고 비어 있음` : `${g.table} 표 따로 보관 — 새 판에 없음 · ${g.rows}행(앱에서는 더 안 보임)`);
  }
  return { changes, notes };
}

/**
 * 걸어 보기의 실패를 가른다 — 데이터가 새 규칙에 어긋남(4xx · 공개가 409 로 멈춘다)은 막힘, 잠금 대기 · 시간 초과는 다 못 봄.
 *  가리키는 표가 먼저 실패해 함께 못 한 표(after)는 그 표를 따른다. 그 밖의 뜻밖의 오류도 다 못 봄으로 둔다(데이터 탓이라 말하지 않는다).
 */
export function splitFailures(failures: AppTableFailure[]): { blocked: string[]; incomplete: string | null } {
  const isData = (f: AppTableFailure): boolean => f.status != null && f.status >= 400 && f.status < 500;
  const dataTables = new Set(failures.filter(isData).map((f) => f.table));
  const blocked: string[] = [];
  let limited = false;
  const other: string[] = [];
  for (const f of failures) {
    if (isData(f)) blocked.push(f.error);
    else if (f.after?.length && f.after.some((t) => dataTables.has(t))) blocked.push(`${f.table} 표도 멈춤 — 가리키는 표(${f.after.join(", ")})가 먼저 막혔음`);
    else if (f.code && LIMIT_CODES.has(f.code)) limited = true;
    else if (!f.after?.length) other.push(`${f.table}: ${f.error}`);
  }
  const parts: string[] = [];
  if (limited) parts.push("그 표를 지금 다른 사람이 쓰고 있거나 표가 커서 다 보지 못했습니다 — 잠시 뒤 다시 보세요");
  if (other.length) parts.push(`미리 보기 중 문제가 생겼습니다: ${other.join(" / ")}`);
  return { blocked, incomplete: parts.length ? parts.join(" · ") : null };
}
