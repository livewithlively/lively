// org_collector_preset — 커스텀 프리셋 레지스트리(#1419 T2) + **내장 ∪ 커스텀 통합 카탈로그**.
//
//  이 파일이 답하는 질문 하나: "수집기를 만들 때 고를 수 있는 것이 무엇인가."
//  답은 두 출처의 합이다 — 코드가 SoT 인 내장 프리셋(CONNECTOR_SPECS)과 DB 가 SoT 인 커스텀 프리셋.
//  둘을 **한 모양(ResolvedPreset)** 으로 접어 내보내므로, 소비자(수집기 저장·실행·화면)는 어느 쪽인지 모른다.
//
//  ⚠ 이름 충돌 규칙: 커스텀이 내장 key 를 덮지 않는다. 내장을 이기게 두면 'slack' 프리셋을 잘못 정의한
//   순간 기존 슬랙 수집기 전부가 코드 없는 드라이버로 갈아타 조용히 멈춘다. 충돌하는 커스텀은 무시하고 경고한다.
import { itemsPool } from "../../db/client.js";
import { CONNECTOR_SPECS, type ConnectorField } from "../../connectors/config.js";
import { audit } from "./audit.js";
import { logger } from "../../log.js";

export type PresetDriver = "builtin" | "clone" | "http" | "rss" | "webhook";

/** 내장·커스텀을 한 모양으로 접은 프리셋. */
export interface ResolvedPreset {
  key: string;
  label: string;
  driver: PresetDriver;
  /** clone 이면 실제 수집을 수행할 내장 프리셋 key. */
  basePreset?: string | null;
  description?: string | null;
  fields: ConnectorField[];
  driverConfig: Record<string, unknown>;
  guide?: { intro?: string; steps: string[]; url?: string };
  parserScript?: string | null;
  builtin: boolean;
  /** 커스텀만 — 편집·삭제 대상 id. */
  id?: number;
  enabled: boolean;
}

/** 내장 프리셋 → ResolvedPreset. */
function builtinPresets(): ResolvedPreset[] {
  return Object.values(CONNECTOR_SPECS).map((s) => ({
    key: s.system, label: s.label, driver: "builtin" as const, basePreset: null,
    description: null, fields: s.fields, driverConfig: {}, guide: s.guide,
    parserScript: null, builtin: true, enabled: true,
  }));
}

/** DB 행 → ResolvedPreset. clone 은 base 의 필드를 물려받되 자기 정의로 덮는다. */
function rowToPreset(row: Record<string, unknown>, byKey: Map<string, ResolvedPreset>): ResolvedPreset {
  const driver = String(row.driver) as PresetDriver;
  const basePreset = (row.base_preset as string) ?? null;
  const ownFields = Array.isArray(row.fields) ? (row.fields as ConnectorField[]) : [];
  // clone — 자기 fields 가 비면 base 의 것을 그대로 쓴다("라벨·안내만 바꾼 템플릿"이 흔한 용례라
  //  필드를 다시 적게 하면 복제의 의미가 없다). 적었으면 그게 정본이다(항목을 줄이거나 힌트를 바꾼 것).
  const baseFields = driver === "clone" && basePreset ? (byKey.get(basePreset)?.fields ?? []) : [];
  return {
    id: Number(row.id),
    key: String(row.key),
    label: String(row.label),
    driver,
    basePreset,
    description: (row.description as string) ?? null,
    fields: ownFields.length ? ownFields : baseFields,
    driverConfig: (row.driver_config as Record<string, unknown>) ?? {},
    guide: (row.guide as ResolvedPreset["guide"]) ?? undefined,
    parserScript: (row.parser_script as string) ?? null,
    builtin: false,
    enabled: row.enabled !== false,
  };
}

/**
 * 통합 카탈로그 — 내장 + 커스텀. 수집기 생성 화면·저장 검증·실행이 모두 이걸 본다.
 *  DB 가 없거나 테이블이 아직 없으면 내장만 돌려준다(설치 직후·구 배포에서도 종전대로 동작).
 */
export async function collectorPresetCatalog(): Promise<ResolvedPreset[]> {
  const builtins = builtinPresets();
  const byKey = new Map(builtins.map((p) => [p.key, p]));
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = (await itemsPool.query(
      `SELECT id, key, label, driver, base_preset, description, fields, driver_config, guide, parser_script, enabled
         FROM org_collector_preset ORDER BY label, key`)).rows as Array<Record<string, unknown>>;
  } catch { return builtins; } // 테이블 부재 → 내장만
  const out = [...builtins];
  for (const row of rows) {
    const key = String(row.key);
    if (byKey.has(key)) {
      // 내장을 덮지 않는다 — 덮게 두면 오정의 하나로 기존 수집기가 통째로 다른 드라이버를 타게 된다.
      logger.warn({ key }, "커스텀 프리셋 key 가 내장 프리셋과 충돌 — 무시합니다(내장 우선)");
      continue;
    }
    const p = rowToPreset(row, byKey);
    byKey.set(key, p);
    out.push(p);
  }
  return out;
}

/** 프리셋 1건 해소 — 실행 경로(run-sync)가 쓴다. */
export async function resolvePreset(key: string): Promise<ResolvedPreset | null> {
  return (await collectorPresetCatalog()).find((p) => p.key === key) ?? null;
}

/**
 * 이 프리셋이 실제 수집에 쓸 **내장 커넥터 모듈 이름**. 없으면 null(=범용 드라이버로 돈다).
 *  builtin → 자기 자신 · clone → base · http/rss/webhook → null.
 */
export function moduleNameOf(p: ResolvedPreset): string | null {
  if (p.driver === "builtin") return p.key;
  if (p.driver === "clone") return p.basePreset ?? null;
  return null;
}

export interface PresetUpsertInput {
  id?: number;
  key?: string;
  label?: string;
  driver?: PresetDriver;
  base_preset?: string | null;
  description?: string | null;
  fields?: ConnectorField[];
  driver_config?: Record<string, unknown>;
  guide?: { intro?: string; steps: string[]; url?: string } | null;
  parser_script?: string | null;
  enabled?: boolean;
}

function normKey(s: string): string {
  return String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export async function upsertCollectorPreset(
  input: PresetUpsertInput, actor?: string, source?: string,
): Promise<ResolvedPreset> {
  const cur = input.id
    ? (await itemsPool.query(`SELECT * FROM org_collector_preset WHERE id=$1`, [input.id])).rows[0] as Record<string, unknown> | undefined
    : undefined;
  if (input.id && !cur) throw new Error(`프리셋을 찾을 수 없습니다: id=${input.id}`);

  const key = normKey(String(input.key ?? cur?.key ?? ""));
  if (!key) throw new Error("프리셋 식별자(key)가 필요합니다");
  if (CONNECTOR_SPECS[key]) throw new Error(`'${key}' 는 내장 프리셋 이름이라 쓸 수 없습니다 — 다른 식별자를 정하세요`);

  const driver = (input.driver ?? cur?.driver ?? "http") as PresetDriver;
  if (!["clone", "http", "rss", "webhook"].includes(driver)) throw new Error(`알 수 없는 방식: ${driver}`);
  const basePreset = input.base_preset === undefined ? ((cur?.base_preset as string) ?? null) : input.base_preset;
  if (driver === "clone") {
    if (!basePreset) throw new Error("복제 방식은 어떤 내장 프리셋을 복제할지 골라야 합니다");
    if (!CONNECTOR_SPECS[basePreset]) throw new Error(`복제 대상이 내장 프리셋이 아닙니다: ${basePreset}`);
  }
  const label = String(input.label ?? cur?.label ?? "").trim() || key;

  const fields = input.fields ?? ((cur?.fields as ConnectorField[]) ?? []);
  const driverConfig = input.driver_config ?? ((cur?.driver_config as Record<string, unknown>) ?? {});
  const guide = input.guide === undefined ? (cur?.guide ?? null) : input.guide;
  const parserScript = input.parser_script === undefined ? ((cur?.parser_script as string) ?? null) : input.parser_script;
  const enabled = input.enabled ?? (cur ? cur.enabled !== false : true);
  const description = input.description === undefined ? ((cur?.description as string) ?? null) : input.description;

  let id: number;
  if (cur) {
    await itemsPool.query(
      `UPDATE org_collector_preset SET key=$2, label=$3, driver=$4, base_preset=$5, description=$6,
              fields=$7::jsonb, driver_config=$8::jsonb, guide=$9::jsonb, parser_script=$10, enabled=$11,
              version=version+1, updated_at=now(), updated_by=$12
         WHERE id=$1`,
      [cur.id, key, label, driver, basePreset, description, JSON.stringify(fields),
       JSON.stringify(driverConfig), guide == null ? null : JSON.stringify(guide), parserScript, enabled, actor ?? null]);
    id = Number(cur.id);
  } else {
    const ins = await itemsPool.query(
      `INSERT INTO org_collector_preset(key, label, driver, base_preset, description, fields, driver_config,
                                        guide, parser_script, enabled, created_by, updated_by)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$11) RETURNING id`,
      [key, label, driver, basePreset, description, JSON.stringify(fields), JSON.stringify(driverConfig),
       guide == null ? null : JSON.stringify(guide), parserScript, enabled, actor ?? null]);
    id = Number((ins.rows[0] as { id: string | number }).id);
  }

  // 파서 스크립트는 감사 스냅샷에 **본문을 넣지 않는다** — 길고, 바뀐 사실만 알면 된다(길이로 표시).
  const snap = (o: Record<string, unknown> | undefined) => o && ({
    key: o.key, label: o.label, driver: o.driver, base_preset: o.base_preset,
    fields: o.fields, driver_config: o.driver_config, enabled: o.enabled,
    parser_script_len: typeof o.parser_script === "string" ? o.parser_script.length : 0,
  });
  await audit("org_collector_preset", String(id), cur ? "update" : "insert", snap(cur) ?? null,
    { key, label, driver, base_preset: basePreset, fields, driver_config: driverConfig, enabled,
      parser_script_len: parserScript ? parserScript.length : 0 }, actor, source);

  const p = (await collectorPresetCatalog()).find((x) => x.key === key);
  if (!p) throw new Error("저장은 됐지만 카탈로그에서 찾지 못했습니다 — 내장 프리셋과 이름이 겹치는지 확인하세요");
  return p;
}

export async function removeCollectorPreset(id: number, actor?: string, source?: string): Promise<void> {
  const cur = (await itemsPool.query(`SELECT key, label, driver FROM org_collector_preset WHERE id=$1`, [id])).rows[0];
  if (!cur) return;
  // 이 프리셋을 쓰는 수집기가 있으면 막는다 — 지우면 그 수집기들이 '없는 프리셋'을 가리켜 조용히 멈춘다.
  const used = await itemsPool.query(
    `SELECT count(*)::int AS n FROM org_collector WHERE preset_key=$1`, [(cur as { key: string }).key]);
  const n = Number((used.rows[0] as { n: number } | undefined)?.n ?? 0);
  if (n > 0) throw new Error(`이 프리셋으로 만든 수집기가 ${n}개 있습니다 — 먼저 그 수집기들을 지우거나 다른 프리셋으로 옮기세요`);
  await itemsPool.query(`DELETE FROM org_collector_preset WHERE id=$1`, [id]);
  await audit("org_collector_preset", String(id), "delete", cur, null, actor, source);
}
