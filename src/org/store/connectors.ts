// org_connector — 커넥터 설정/토큰 레지스트리(프로젝트 #541) + #586 자동 싱크 잡(org_cron) 등록/해제.
//  (#1313 R18) 구 org/store.ts 에서 verbatim 분리.
import { itemsPool } from "../../db/client.js";
import { CONNECTOR_SPECS, type ConnectorField } from "../../connectors/config.js";
import { encryptSecret, secretsEnabled } from "../credentials/secret-box.js";
import { audit } from "./audit.js";

// ════════ 커넥터 설정/토큰 레지스트리 — org_connector (프로젝트 #541) ════════
//  CONNECTOR_SPECS(connectors/config.ts)가 필드 SoT. config=평문 설정(secret=false), secrets=암호화(secret-box).
//  뷰는 시크릿 '값'을 절대 노출하지 않고 설정 여부(secretsSet)만 준다. 해소(런타임 실사용)는 connectors/config.ts.

/** 관리탭·aggregate 용 커넥터 뷰 — 시크릿 값 없음(설정 여부만). fields 는 프론트 동적 폼용 스펙. */
export interface ConnectorView {
  system: string;
  label: string;
  fields: ConnectorField[];
  enabled: boolean;
  config: Record<string, string>;       // 평문 설정값(secret=false 필드)
  secretsSet: Record<string, boolean>;  // 시크릿 설정 여부(값 노출 안 함)
  note: string | null;
  updated_at: string | null;
  secrets_enabled: boolean;             // 마스터키(CONNECTOR_SECRET_KEY) 설정 여부 — 관리탭 안내용
  guide?: { intro?: string; steps: string[]; url?: string }; // 토큰 발급 가이드(#586 — 폼 상단 안내)
  sync_job?: { enabled: boolean; interval_sec: number } | null; // 자동 싱크 잡 상태(#586)
}

export async function listConnectors(): Promise<ConnectorView[]> {
  const r = await itemsPool.query(`SELECT system, enabled, config, secrets, note, updated_at FROM org_connector`);
  const byId = new Map<string, Record<string, unknown>>(r.rows.map((x) => [x.system as string, x]));
  // 자동 싱크 잡 상태(#586) — sync-<system> 잡을 함께 보여줘 '커넥터 켬=싱크 돎'이 화면에서 검증되게.
  const jobs = new Map<string, { enabled: boolean; interval_sec: number }>();
  try {
    const jr = await itemsPool.query(`SELECT id, enabled, interval_sec FROM org_cron WHERE id LIKE 'sync-%'`);
    for (const row of jr.rows as Array<{ id: string; enabled: boolean; interval_sec: number }>) {
      jobs.set(row.id.replace(/^sync-/, ""), { enabled: row.enabled, interval_sec: row.interval_sec });
    }
  } catch { /* org_cron 미생성 — 무시 */ }
  const secEnabled = secretsEnabled();
  return Object.values(CONNECTOR_SPECS).map((spec) => {
    const row = byId.get(spec.system);
    const rowConfig = (row?.config as Record<string, unknown>) ?? {};
    const rowSecrets = (row?.secrets as Record<string, unknown>) ?? {};
    const config: Record<string, string> = {};
    const secretsSet: Record<string, boolean> = {};
    for (const f of spec.fields) {
      if (f.secret) secretsSet[f.key] = Boolean(rowSecrets[f.key]);
      else config[f.key] = String(rowConfig[f.key] ?? "");
    }
    return {
      system: spec.system, label: spec.label, fields: spec.fields, guide: spec.guide,
      enabled: Boolean(row?.enabled), config, secretsSet,
      note: (row?.note as string) ?? null, updated_at: (row?.updated_at as string) ?? null,
      secrets_enabled: secEnabled,
      sync_job: jobs.get(spec.system) ?? null,
    };
  });
}

export interface ConnectorUpsertInput {
  system: string;
  enabled?: boolean;
  config?: Record<string, string>;   // 평문 설정(secret=false 필드만 반영)
  secrets?: Record<string, string>;  // 시크릿 평문(미전송/빈="미변경", 값=암호화 갱신)
  note?: string | null;
}

export async function upsertConnector(input: ConnectorUpsertInput, actor?: string, source?: string): Promise<ConnectorView> {
  const spec = CONNECTOR_SPECS[input.system];
  if (!spec) throw new Error(`알 수 없는 커넥터: ${input.system}`);
  const cur = await itemsPool.query(`SELECT enabled, config, secrets, note FROM org_connector WHERE system=$1`, [input.system]);
  const before = cur.rows[0] as { enabled: boolean; config: Record<string, unknown>; secrets: Record<string, unknown>; note: string | null } | undefined;

  const config: Record<string, unknown> = { ...(before?.config ?? {}) };
  const secrets: Record<string, unknown> = { ...(before?.secrets ?? {}) };
  for (const f of spec.fields) {
    if (f.secret) {
      const v = input.secrets?.[f.key];
      if (v === undefined || v === "") continue; // 미전송/빈 = 미변경(기존 암호문 유지 — 실수로 지우지 않음)
      if (!secretsEnabled()) throw new Error("CONNECTOR_SECRET_KEY 미설정 — 시크릿을 저장하려면 게이트웨이 .env 에 설정하세요 (openssl rand -hex 32).");
      secrets[f.key] = encryptSecret(v);
    } else {
      const v = input.config?.[f.key];
      if (v === undefined) continue;
      if (v === "") delete config[f.key]; else config[f.key] = v;
    }
  }
  const enabled = input.enabled ?? before?.enabled ?? false;
  const note = input.note === undefined ? (before?.note ?? null) : input.note;

  await itemsPool.query(
    `INSERT INTO org_connector(system, enabled, config, secrets, note, version, updated_at, updated_by)
       VALUES($1,$2,$3::jsonb,$4::jsonb,$5,1,now(),$6)
     ON CONFLICT (tenant_id, system) DO UPDATE SET
       enabled=EXCLUDED.enabled, config=EXCLUDED.config, secrets=EXCLUDED.secrets, note=EXCLUDED.note,
       version=org_connector.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [input.system, enabled, JSON.stringify(config), JSON.stringify(secrets), note, actor ?? null],
  );

  // ── #586 커넥터 활성화 = 싱크 자동 — sync-<system> 크론 잡을 자동 등록/해제(스케줄러 별도 등록 불필요). ──
  //  이미 있으면 enabled 만 토글(관리자가 조정한 주기·파라미터 보존). org_cron 부재 등은 비치명(커넥터 저장은 성공).
  try {
    if (enabled) {
      await itemsPool.query(
        `INSERT INTO org_cron(id, label, action, params, interval_sec, enabled, created_by)
           VALUES($1,$2,'connector_sync',$3::jsonb,600,true,$4)
         ON CONFLICT (tenant_id, id) DO UPDATE SET enabled=true`,
        [`sync-${input.system}`, `${spec.label} 자동 싱크`, JSON.stringify({ system: input.system }), actor ?? null]);
      // 일일 full 스윕(#586, notion) — 증분 델타가 구조적으로 못 보는 것들(댓글 단독 변경·멘션 제목 캐시·
      //  아카이브 전파·search 인덱싱 장기 지연)의 수렴 경로. 주기·활성은 관리자가 조정 가능(DO NOTHING).
      if (input.system === "notion") {
        await itemsPool.query(
          `INSERT INTO org_cron(id, label, action, params, interval_sec, enabled, created_by)
             VALUES($1,$2,'connector_sync',$3::jsonb,86400,true,$4)
           ON CONFLICT (tenant_id, id) DO UPDATE SET enabled=true`, // off→on 사이클에서 되살아나야(리뷰: DO NOTHING 은 영구 비활성)
          [`sync-${input.system}-full`, `${spec.label} 일일 전체 스윕(아카이브·완결성)`, JSON.stringify({ system: input.system, full: true }), actor ?? null]);
      }
    } else {
      await itemsPool.query(`UPDATE org_cron SET enabled=false WHERE id = ANY($1::text[])`, [[`sync-${input.system}`, `sync-${input.system}-full`]]);
    }
  } catch (e) {
    console.warn(`[connector] 자동 싱크 잡 등록 실패(비치명) ${input.system}:`, (e as Error)?.message);
  }
  // 감사 — 시크릿 '값'은 스냅샷에 넣지 않는다(설정된 키 목록만).
  const auditBefore = before ? { enabled: before.enabled, config: before.config, secretKeys: Object.keys(before.secrets ?? {}), note: before.note } : null;
  const auditAfter = { enabled, config, secretKeys: Object.keys(secrets), note };
  await audit("org_connector", input.system, before ? "update" : "insert", auditBefore, auditAfter, actor, source);

  const view = (await listConnectors()).find((c) => c.system === input.system);
  return view as ConnectorView;
}

export async function removeConnector(system: string, actor?: string, source?: string): Promise<void> {
  const cur = await itemsPool.query(`SELECT enabled, config, note FROM org_connector WHERE system=$1`, [system]);
  if (!cur.rows[0]) return;
  await itemsPool.query(`DELETE FROM org_connector WHERE system=$1`, [system]);
  await audit("org_connector", system, "delete", cur.rows[0], null, actor, source);
}
