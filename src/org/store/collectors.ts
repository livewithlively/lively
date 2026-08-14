// org_collector — **수집기 인스턴스** 레지스트리(#1419 T1). org_connector(system PK = 종류당 1개)의 후계.
//
//  이 파일이 소유하는 것: 목록 뷰(시크릿 값 비노출) · upsert(필드 SoT 검증 + 시크릿 암호화) · 삭제 ·
//   자동 싱크 잡(org_cron) 동기 · **레거시 마이그레이션**.
//  이 파일이 소유하지 않는 것: 런타임 해소(connectors/config.ts) · 실행(run-tracker) · 프리셋 정의(T2).
//
//  ⚠ org_connector 와의 관계 — 지우지 않고 **폴백원으로 남긴다**. 마이그레이션이 그 행을 여기로 복사하되
//   원본을 삭제하지 않으므로, 롤백(구 코드 배포)해도 종전 그대로 동작한다. 이 되돌릴 수 있음이 무중단의 실체다.
import { itemsPool } from "../../db/client.js";
import { CONNECTOR_SPECS, type ConnectorField } from "../../connectors/config.js";
import { encryptSecret, secretsEnabled } from "../credentials/secret-box.js";
import { collectorPresetCatalog, type ResolvedPreset } from "./collector-presets.js";
import { audit } from "./audit.js";

/** 관리탭용 수집기 뷰 — 시크릿 '값'은 절대 담기지 않는다(설정 여부만). */
export interface CollectorView {
  id: number;
  key: string;
  preset_key: string;
  instance_key: string;
  label: string;
  enabled: boolean;
  config: Record<string, string>;
  secretsSet: Record<string, boolean>;
  sync_interval_sec: number;
  output_mode: string;
  output_config: Record<string, unknown>;
  note: string | null;
  sort: number;
  updated_at: string | null;
  /** 프리셋에서 파생 — 폼을 그리는 데 필요한 것들(프론트가 프리셋 표를 따로 안 들고 있게). */
  preset_label: string;
  fields: ConnectorField[];
  guide?: { intro?: string; steps: string[]; url?: string };
  /** 마스터키(CONNECTOR_SECRET_KEY) 설정 여부 — 관리탭 안내용. */
  secrets_enabled: boolean;
  /** 자동 싱크 잡 상태(org_cron). */
  sync_job: { enabled: boolean; interval_sec: number } | null;
  /** 최근 실행(connector_run) 요약 — 목록에서 '도는지'가 바로 보이게. */
  last_run: { id: number; status: string; mode: string; started_at: string; finished_at: string | null } | null;
}

/** 수집기의 자동 싱크 크론 잡 id — 인스턴스마다 하나. 구 `sync-<system>` 과 네임스페이스가 갈린다. */
export function collectorJobId(id: number): string {
  return `collector-${id}`;
}

/**
 * 프리셋 해소 — **내장 ∪ 커스텀** 통합 카탈로그(#1419 T2). 한 번 읽어 Map 으로 넘겨 쓴다
 *  (목록 렌더에서 수집기마다 카탈로그를 다시 읽지 않게).
 */
async function presetMap(): Promise<Map<string, ResolvedPreset>> {
  return new Map((await collectorPresetCatalog()).map((p) => [p.key, p]));
}

export async function listCollectors(): Promise<CollectorView[]> {
  const presets = await presetMap();
  const r = await itemsPool.query(
    `SELECT id, key, preset_key, instance_key, label, enabled, config, secrets,
            sync_interval_sec, output_mode, output_config, sort, note, updated_at
       FROM org_collector ORDER BY sort, id`);

  // 자동 싱크 잡 — 수집기 켬 = 싱크 돎이 화면에서 검증되게 함께 준다(#586 계승).
  const jobs = new Map<string, { enabled: boolean; interval_sec: number }>();
  try {
    const jr = await itemsPool.query(`SELECT id, enabled, interval_sec FROM org_cron WHERE id LIKE 'collector-%'`);
    for (const row of jr.rows as Array<{ id: string; enabled: boolean; interval_sec: number }>) {
      jobs.set(row.id, { enabled: row.enabled, interval_sec: row.interval_sec });
    }
  } catch { /* org_cron 미생성 — 무시 */ }

  // 최근 실행 — 수집기별 1건(DISTINCT ON). connector_run.collector_id 는 마이그레이션 이후 채워진다(구 행은 NULL).
  const lastRuns = new Map<number, CollectorView["last_run"]>();
  try {
    const rr = await itemsPool.query(
      `SELECT DISTINCT ON (collector_id) collector_id, id, status, mode, started_at, finished_at
         FROM connector_run WHERE collector_id IS NOT NULL
        ORDER BY collector_id, started_at DESC`);
    for (const row of rr.rows as Array<Record<string, unknown>>) {
      lastRuns.set(Number(row.collector_id), {
        id: Number(row.id), status: String(row.status), mode: String(row.mode),
        started_at: String(row.started_at), finished_at: row.finished_at ? String(row.finished_at) : null,
      });
    }
  } catch { /* connector_run 미생성(한 번도 안 돈 배포) — 무시 */ }

  const secEnabled = secretsEnabled();
  return r.rows.map((row: Record<string, unknown>) => {
    const spec = presets.get(String(row.preset_key)) ?? null;
    const fields = spec?.fields ?? [];
    const rowConfig = (row.config as Record<string, unknown>) ?? {};
    const rowSecrets = (row.secrets as Record<string, unknown>) ?? {};
    const config: Record<string, string> = {};
    const secretsSet: Record<string, boolean> = {};
    for (const f of fields) {
      if (f.secret) secretsSet[f.key] = Boolean(rowSecrets[f.key]);
      else config[f.key] = String(rowConfig[f.key] ?? "");
    }
    const id = Number(row.id);
    return {
      id, key: String(row.key), preset_key: String(row.preset_key), instance_key: String(row.instance_key),
      // 이름이 비면 프리셋 이름으로 — 목록에 'null' 이 뜨지 않게(비개발자 화면 요구).
      label: String(row.label ?? "") || spec?.label || String(row.preset_key),
      enabled: Boolean(row.enabled), config, secretsSet,
      sync_interval_sec: Number(row.sync_interval_sec ?? 600),
      output_mode: String(row.output_mode ?? "preset"),
      output_config: (row.output_config as Record<string, unknown>) ?? {},
      note: (row.note as string) ?? null, sort: Number(row.sort ?? 0),
      updated_at: row.updated_at ? String(row.updated_at) : null,
      preset_label: spec?.label ?? String(row.preset_key),
      fields, guide: spec?.guide,
      secrets_enabled: secEnabled,
      sync_job: jobs.get(collectorJobId(id)) ?? null,
      last_run: lastRuns.get(id) ?? null,
    };
  });
}

export interface CollectorUpsertInput {
  id?: number;
  key?: string;
  preset_key?: string;
  instance_key?: string;
  label?: string | null;
  enabled?: boolean;
  config?: Record<string, string>;
  secrets?: Record<string, string>;  // 미전송/빈 = 미변경(기존 암호문 유지)
  sync_interval_sec?: number;
  output_mode?: string;
  output_config?: Record<string, unknown>;
  sort?: number;
  note?: string | null;
}

/** key 슬러그 정규화 — URL·잡 id 에 들어가므로 좁게 잡는다. */
function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

/**
 * 이름 미지정 시 자동 key — `slack` · `slack-2` · `slack-3` … (그 프리셋의 첫 인스턴스는 접미 없음).
 *  사람이 읽는 자리(URL·크론 잡 id·로그·감사)에 그대로 박히므로 순번이 타임스탬프보다 낫다.
 */
async function nextAutoKey(presetKey: string): Promise<string> {
  const base = normKey(presetKey) || "collector";
  const taken = new Set((await itemsPool.query<{ key: string }>(
    `SELECT key FROM org_collector WHERE key = $1 OR key LIKE $2`, [base, `${base}-%`])).rows.map((r) => r.key));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${taken.size + 1}`; // 도달 불가에 가까운 백스톱
}

export async function upsertCollector(input: CollectorUpsertInput, actor?: string, source?: string): Promise<CollectorView> {
  const cur = input.id
    ? (await itemsPool.query(
        `SELECT id, key, preset_key, instance_key, label, enabled, config, secrets, sync_interval_sec,
                output_mode, output_config, sort, note FROM org_collector WHERE id=$1`, [input.id])).rows[0] as Record<string, unknown> | undefined
    : undefined;
  if (input.id && !cur) throw new Error(`수집기를 찾을 수 없습니다: id=${input.id}`);

  const presetKey = String(input.preset_key ?? cur?.preset_key ?? "");
  const spec = (await presetMap()).get(presetKey) ?? null;
  if (!spec) throw new Error(`알 수 없는 프리셋: ${presetKey || "(미지정)"}`);
  if (!spec.enabled) throw new Error(`프리셋 '${presetKey}' 가 꺼져 있어 새 수집기를 만들 수 없습니다`);

  // key 자동 생성 — 이름이 한국어면 슬러그가 통째로 비므로(정규화가 a-z0-9 만 남긴다) 프리셋 + 순번으로 짓는다.
  //  타임스탬프를 쓰면 `slack-1785728013251` 같은 게 URL·잡 id·로그에 그대로 박혀 사람이 읽을 수 없다.
  let key = normKey(String(input.key ?? cur?.key ?? ""));
  if (!key) key = await nextAutoKey(presetKey);
  // 커서 네임스페이스는 **만든 뒤 바꾸지 않는다** — 바꾸면 그 수집기가 커서를 잃고 전체 재수집한다.
  //  그래서 신규 생성 시에만 입력을 받고, 기존 행은 저장 페이로드에 뭐가 오든 현재 값을 지킨다.
  const instanceKey = cur
    ? String(cur.instance_key)
    : (String(input.instance_key ?? "").trim() || (key === presetKey ? "_" : key));

  const config: Record<string, unknown> = { ...((cur?.config as Record<string, unknown>) ?? {}) };
  const secrets: Record<string, unknown> = { ...((cur?.secrets as Record<string, unknown>) ?? {}) };
  for (const f of spec.fields) {
    if (f.secret) {
      const v = input.secrets?.[f.key];
      if (v === undefined || v === "") continue; // 미전송/빈 = 미변경(실수로 지우지 않음)
      if (!secretsEnabled()) throw new Error("CONNECTOR_SECRET_KEY 미설정 — 시크릿을 저장하려면 게이트웨이 .env 에 설정하세요 (openssl rand -hex 32).");
      secrets[f.key] = encryptSecret(v);
    } else {
      const v = input.config?.[f.key];
      if (v === undefined) continue;
      if (v === "") delete config[f.key]; else config[f.key] = v;
    }
  }

  const enabled = input.enabled ?? Boolean(cur?.enabled) ?? false;
  const label = input.label === undefined ? ((cur?.label as string) ?? null) : input.label;
  const note = input.note === undefined ? ((cur?.note as string) ?? null) : input.note;
  const interval = Math.min(604_800, Math.max(60, Number(input.sync_interval_sec ?? cur?.sync_interval_sec ?? 600) || 600));
  const outputMode = String(input.output_mode ?? cur?.output_mode ?? "preset");
  const outputConfig = input.output_config ?? ((cur?.output_config as Record<string, unknown>) ?? {});
  const sort = Number(input.sort ?? cur?.sort ?? 0) || 0;

  let id: number;
  if (cur) {
    await itemsPool.query(
      `UPDATE org_collector SET key=$2, label=$3, enabled=$4, config=$5::jsonb, secrets=$6::jsonb,
              sync_interval_sec=$7, output_mode=$8, output_config=$9::jsonb, sort=$10, note=$11,
              version=version+1, updated_at=now(), updated_by=$12
         WHERE id=$1`,
      [cur.id, key, label, enabled, JSON.stringify(config), JSON.stringify(secrets),
       interval, outputMode, JSON.stringify(outputConfig), sort, note, actor ?? null]);
    id = Number(cur.id);
  } else {
    const ins = await itemsPool.query(
      `INSERT INTO org_collector(key, preset_key, instance_key, label, enabled, config, secrets,
                                 sync_interval_sec, output_mode, output_config, sort, note, created_by, updated_by)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb,$11,$12,$13,$13) RETURNING id`,
      [key, presetKey, instanceKey, label, enabled, JSON.stringify(config), JSON.stringify(secrets),
       interval, outputMode, JSON.stringify(outputConfig), sort, note, actor ?? null]);
    id = Number((ins.rows[0] as { id: string | number }).id);
  }

  await syncCollectorJob(id, { presetKey, label: label || spec.label, enabled, interval }, actor);

  // 감사 — 시크릿 '값'은 스냅샷에 넣지 않는다(설정된 키 목록만).
  const auditBefore = cur
    ? { key: cur.key, enabled: cur.enabled, config: cur.config, secretKeys: Object.keys((cur.secrets as object) ?? {}), note: cur.note }
    : null;
  await audit("org_collector", String(id), cur ? "update" : "insert", auditBefore,
    { key, preset_key: presetKey, instance_key: instanceKey, enabled, config, secretKeys: Object.keys(secrets), note }, actor, source);

  const view = (await listCollectors()).find((c) => c.id === id);
  return view as CollectorView;
}

/**
 * 자동 싱크 잡 동기 — 수집기 활성화 = 싱크가 그냥 돈다(#586 계승, 인스턴스별로).
 *  이미 있으면 enabled·주기만 갱신하고 나머지(관리자가 조정한 파라미터)는 보존. 실패는 비치명(저장은 성공).
 */
async function syncCollectorJob(
  id: number, spec: { presetKey: string; label: string; enabled: boolean; interval: number }, actor?: string,
): Promise<void> {
  const jobId = collectorJobId(id);
  try {
    if (spec.enabled) {
      await itemsPool.query(
        `INSERT INTO org_cron(id, label, action, params, interval_sec, enabled, created_by)
           VALUES($1,$2,'connector_sync',$3::jsonb,$4,true,$5)
         ON CONFLICT (tenant_id, id) DO UPDATE SET label=EXCLUDED.label, params=EXCLUDED.params,
           interval_sec=EXCLUDED.interval_sec, enabled=true`,
        [jobId, `${spec.label} 자동 수집`, JSON.stringify({ collector_id: id }), spec.interval, actor ?? null]);
      // 일일 full 스윕(notion) — 증분 델타가 구조적으로 못 보는 것들(댓글 단독 변경·아카이브 전파·
      //  search 인덱싱 장기 지연)의 수렴 경로(#586). 인스턴스마다 따로 돈다.
      if (spec.presetKey === "notion") {
        await itemsPool.query(
          `INSERT INTO org_cron(id, label, action, params, interval_sec, enabled, created_by)
             VALUES($1,$2,'connector_sync',$3::jsonb,86400,true,$4)
           ON CONFLICT (tenant_id, id) DO UPDATE SET label=EXCLUDED.label, params=EXCLUDED.params, enabled=true`,
          [`${jobId}-full`, `${spec.label} 일일 전체 스윕(아카이브·완결성)`,
           JSON.stringify({ collector_id: id, full: true }), actor ?? null]);
      }
    } else {
      await itemsPool.query(`UPDATE org_cron SET enabled=false WHERE id = ANY($1::text[])`, [[jobId, `${jobId}-full`]]);
    }
  } catch (e) {
    console.warn(`[collector] 자동 싱크 잡 등록 실패(비치명) id=${id}:`, (e as Error)?.message);
  }
}

export async function removeCollector(id: number, actor?: string, source?: string): Promise<void> {
  const cur = (await itemsPool.query(
    `SELECT key, preset_key, instance_key, enabled, config, note FROM org_collector WHERE id=$1`, [id])).rows[0];
  if (!cur) return;
  await itemsPool.query(`DELETE FROM org_collector WHERE id=$1`, [id]);
  // 잡도 함께 지운다 — 남으면 없는 수집기를 가리키는 크론이 매 주기 실패한다.
  try {
    await itemsPool.query(`DELETE FROM org_cron WHERE id = ANY($1::text[])`, [[collectorJobId(id), `${collectorJobId(id)}-full`]]);
  } catch { /* 비치명 */ }
  // ⚠ connector_state(커서)는 **남긴다** — 같은 instance_key 로 다시 만들면 이어받는다. 실수 삭제의 복구 여지.
  await audit("org_collector", String(id), "delete", cur, null, actor, source);
}

/**
 * 레거시 마이그레이션 — org_connector 1행/시스템 → org_collector 기본 인스턴스(#1419 T1).
 *
 *  불변식 셋:
 *   ① **멱등** — 이미 옮긴 것(preset_key, instance_key='_')이 있으면 건너뛴다. 부팅마다 불려도 안전.
 *   ② **커서 승계** — instance_key='_' 를 그대로 물려받아 connector_state(system,'_') 를 이어 쓴다.
 *      이게 아니면 마이그레이션 직후 전 커넥터가 전체 재수집을 시작한다(고객사 규모에서 수 시간).
 *   ③ **원본 보존** — org_connector 를 지우지 않는다. 구 코드로 롤백해도 그대로 돌고, 해소 폴백원으로도 산다.
 *
 *  구 크론 잡(sync-<system>)은 끈다 — 새 잡(collector-<id>)과 둘 다 켜져 있으면 같은 소스를 두 번 긁는다.
 *  (run-tracker 의 중복 가드가 겹침 자체는 막지만, 매 주기 헛도는 잡을 남길 이유가 없다.)
 */
export async function migrateConnectorsToCollectors(actor = "system:migration"): Promise<{ migrated: string[] }> {
  const migrated: string[] = [];
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (await itemsPool.query(
      `SELECT system, enabled, config, secrets, note FROM org_connector`)).rows as Array<Record<string, unknown>>;
  } catch { return { migrated }; } // org_connector 부재(신규 설치) — 옮길 것이 없다
  if (!rows.length) return { migrated };

  for (const row of rows) {
    const system = String(row.system);
    // 레거시 행은 언제나 **내장** 커넥터다(org_connector 는 CONNECTOR_SPECS 로만 채워졌다) — 커스텀 카탈로그를
    //  볼 이유가 없고, 보면 안 된다(같은 이름의 커스텀 프리셋이 마이그레이션 대상을 바꿔치기할 여지).
    if (!CONNECTOR_SPECS[system]) continue; // 코드에서 사라진 커넥터의 잔존 행 — 되살리지 않는다
    const exists = await itemsPool.query(
      `SELECT 1 FROM org_collector WHERE preset_key=$1 AND instance_key='_'`, [system]);
    if (exists.rows.length) continue; // ① 멱등

    const enabled = Boolean(row.enabled);
    // 구 주기: notion 만 별도 full 잡을 뒀고 본 잡은 전부 600초였다(upsertConnector). 그 값을 승계한다.
    const prevJob = await itemsPool.query(
      `SELECT interval_sec FROM org_cron WHERE id=$1`, [`sync-${system}`]).catch(() => ({ rows: [] as unknown[] }));
    const interval = Number((prevJob.rows[0] as { interval_sec?: number } | undefined)?.interval_sec ?? 600) || 600;

    const ins = await itemsPool.query(
      `INSERT INTO org_collector(key, preset_key, instance_key, label, enabled, config, secrets,
                                 sync_interval_sec, sort, note, created_by, updated_by)
         VALUES($1,$1,'_',$2,$3,$4::jsonb,$5::jsonb,$6,0,$7,$8,$8)
       ON CONFLICT (tenant_id, preset_key, instance_key) DO NOTHING
       RETURNING id`,
      [system, CONNECTOR_SPECS[system]?.label ?? system, enabled,
       JSON.stringify(row.config ?? {}), JSON.stringify(row.secrets ?? {}), interval, row.note ?? null, actor]);
    const id = Number((ins.rows[0] as { id?: string | number } | undefined)?.id ?? 0);
    if (!id) continue; // 경합(다른 부팅이 먼저 넣음) — 멱등하게 넘어간다

    await syncCollectorJob(id, { presetKey: system, label: CONNECTOR_SPECS[system]?.label ?? system, enabled, interval }, actor);
    // 구 잡 정지 — 새 잡이 같은 일을 한다(원본 행은 ③에 따라 보존하지만, 잡이 둘일 이유는 없다).
    try {
      await itemsPool.query(`UPDATE org_cron SET enabled=false WHERE id = ANY($1::text[])`,
        [[`sync-${system}`, `sync-${system}-full`]]);
    } catch { /* 비치명 */ }
    migrated.push(system);
  }
  if (migrated.length) console.warn(`[collector] 레거시 커넥터 → 수집기 마이그레이션: ${migrated.join(", ")}`);
  return { migrated };
}
