// 노션 전체 점검 스윕의 «같은 워크스페이스를 맡은 다른 수집기» 판정(#4059).
//  스윕 SQL(v6/mirror/notion-post.ts)은 «아무 표식도 없는 행» 만 보관한다. 그런데 표식이 없다는 것이 곧
//  «아무도 안 맡는다» 가 되려면, 같은 축(external_instance)을 쓰는 수집기 **모두**가 그 행이 비게 된 뒤에
//  깨끗한 전체 점검을 한 번 마쳤어야 한다(맡았다면 그 점검이 표식을 남겼을 것이다). 이 파일이 그걸 잰다.
//
//  준비(ready) 기록: 수집기가 깨끗한 전체 점검을 마칠 때마다 connector_state(system='notion:sweep',
//   instance=<수집기 표식>) 에 {ready_at: 그 점검의 시작 시각, version: 그 점검이 읽은 수집기 설정 판}을 남긴다.
//   수집기 설정(루트·제외 페이지 등)이 그 뒤 바뀌면 org_collector.version 이 올라가 판이 어긋난다 → 준비 아님.
//   (수집기 커서 행에 싣지 않는 이유: 커서는 planCursorWrite 가 통째로 다시 쓴다 — 다른 칸은 다음 증분에 지워진다.)
import type pg from "pg";
import type { NotionSweepPlan } from "../../v6/connector-mirror.js";

export const SWEEP_STATE_SYSTEM = "notion:sweep";
const NOTION_MODULE = "notion";

/** 같은 축의 다른 수집기 하나 — 준비 판정에 필요한 것만. */
export interface NotionSweepPeer {
  key: string;
  /** 지금 설정 판(org_collector.version) */
  version: number;
  /** 마지막 깨끗한 전체 점검 기록 — 없으면 null */
  ready: { at: string; version: number | null } | null;
}

/**
 * ISO 시각 → 에포크 마이크로초(정수). 형식이 아니면 null.
 *  JS Date 는 밀리초까지만 들고 **아래를 버린다**. 기준 시각을 Date 로 계산하면 같은 밀리초 안에서
 *  «비게 된 시각 < 점검 시작» 의 앞뒤가 뒤집힌다 — 그래서 소수부를 따로 읽어 마이크로초로 비교한다.
 */
export function isoMicros(iso: string): bigint | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/.exec(iso);
  if (!m) return null;
  const sec = Date.parse(`${m[1]}${m[3]}`);
  if (!Number.isFinite(sec)) return null;
  return BigInt(sec) * 1000n + BigInt((m[2] ?? "").padEnd(6, "0").slice(0, 6));
}

/**
 * 스윕 계획(순수) — 보관할지, 한다면 어느 시각 이전에 비게 된 행까지인지.
 *  · selfChanged: 이 run 이 읽은 뒤 내 설정이 바뀌었다 → 이번 관측이 지금 범위를 대표하지 않는다 → 보류.
 *  · 다른 수집기 중 준비 안 된 것(기록 없음·설정이 그 뒤 바뀜)이 하나라도 있으면 보류 — 그 수집기가 맡은 행을
 *    «아무도 안 맡는다» 로 오판할 수 있다.
 *  · 다른 수집기가 없으면 sole — 이번에 내가 뗀 행도 곧바로 보관(종전 지연 유지). cutoff 는 이번 run 시작.
 *  · 있으면 cutoff = min(이번 run 시작, 다른 수집기들의 마지막 깨끗한 점검 시작).
 */
export function planNotionSweep(input: {
  runStartIso: string;
  selfChanged: boolean;
  peers: NotionSweepPeer[] | null;
}): NotionSweepPlan {
  if (input.selfChanged) return { archive: false, reason: "self_changed" };
  if (input.peers == null) return { archive: false, reason: "peers_unknown" };
  const notReady = input.peers
    .filter((p) => !p.ready || p.ready.version !== p.version || isoMicros(p.ready.at) == null)
    .map((p) => p.key);
  if (notReady.length) return { archive: false, reason: "peers_not_ready", notReady };
  // 내 시작 시각을 못 읽으면 비교 자체가 성립 안 한다 — 단일 수집기여도 같다(리뷰: 분기마다 보호가 갈리지 않게).
  let cutoff = isoMicros(input.runStartIso);
  if (cutoff == null) return { archive: false, reason: "peers_unknown" };
  if (!input.peers.length) return { archive: true, sole: true, cutoffIso: input.runStartIso };
  // 기준 = 가장 이른 시각. 값은 **받은 문자열 그대로** 넘긴다(다시 만들면 정밀도가 깎인다 — isoMicros 주석).
  let cutoffIso = input.runStartIso;
  for (const p of input.peers) {
    const at = isoMicros(p.ready!.at)!;
    if (at < cutoff) { cutoff = at; cutoffIso = p.ready!.at; }
  }
  return { archive: true, sole: false, cutoffIso };
}

/** 노션 모듈로 도는 프리셋 key — 내장 'notion' + 그것을 복제한 프리셋. 카탈로그를 못 읽으면 내장만. */
export async function notionPresetKeys(): Promise<{ keys: string[]; clones: Set<string> }> {
  try {
    const { collectorPresetCatalog, moduleNameOf } = await import("../../org/store/collector-presets.js");
    const cat = await collectorPresetCatalog();
    const keys = cat.filter((p) => moduleNameOf(p) === NOTION_MODULE).map((p) => p.key);
    const clones = new Set(keys.filter((k) => k !== NOTION_MODULE));
    return { keys: keys.includes(NOTION_MODULE) ? keys : [NOTION_MODULE, ...keys], clones };
  } catch {
    return { keys: [NOTION_MODULE], clones: new Set() };
  }
}

/**
 * 같은 축의 다른 수집기와 내 설정 판을 읽는다.
 *  · 켜진 수집기만 센다 — 꺼진 수집기는 돌지 않아 준비될 수가 없다. 그 수집기가 표식을 남긴 행은 표식이 지킨다.
 *  · 축은 커넥터와 같은 식으로 구한다(client.loadConfig: `config.instance || NOTION_INSTANCE || 'default'`).
 *    복제 프리셋은 노션 모듈이 자기 설정을 못 읽는 경로라(config.resolveConnectorConfig 가 'notion' 으로 묻는다)
 *    축을 확정할 수 없다 — **같은 축으로 간주**한다(보수: 보관이 늦어질 뿐 남의 것을 지우지 않는다).
 *  · 읽기 실패는 peers=null — 호출부가 보관을 보류한다(모르면 지우지 않는다).
 */
export async function loadNotionSweepPeers(
  db: pg.Pool | pg.PoolClient,
  input: { instance: string; claimKey: string; boundId: number | null; boundVersion: number | null },
  deps: { presetKeys?: typeof notionPresetKeys } = {},
): Promise<{ peers: NotionSweepPeer[] | null; selfChanged: boolean }> {
  try {
    const { keys, clones } = await (deps.presetKeys ?? notionPresetKeys)();
    const r = await db.query(
      `SELECT id, preset_key, instance_key, enabled, version, config->>'instance' AS inst
         FROM org_collector WHERE preset_key = ANY($1::text[])`, [keys]);
    const rows = r.rows as Array<{ id: string | number; preset_key: string; instance_key: string;
      enabled: boolean; version: number; inst: string | null }>;
    let selfChanged = false;
    const peerRows: typeof rows = [];
    for (const row of rows) {
      const key = `${row.preset_key}:${row.instance_key}`;
      if (key === input.claimKey) {
        // 내 설정 판 — 이 run 이 바인딩할 때 읽은 판과 다르면 그 사이 설정이 바뀐 것이다.
        if (input.boundId != null && Number(row.id) === input.boundId && input.boundVersion != null
            && Number(row.version) !== input.boundVersion) selfChanged = true;
        continue;
      }
      if (!row.enabled) continue;
      if (!clones.has(row.preset_key)) {
        const axis = (row.inst && row.inst.length ? row.inst : process.env.NOTION_INSTANCE) || "default";
        if (axis !== input.instance) continue; // 다른 워크스페이스 — 이 축의 행을 맡지 않는다(#1881 N7)
      }
      peerRows.push(row);
    }
    if (!peerRows.length) return { peers: [], selfChanged };
    const peerKeys = peerRows.map((p) => `${p.preset_key}:${p.instance_key}`);
    const st = await db.query(
      `SELECT instance, cursor FROM connector_state WHERE system=$1 AND instance = ANY($2::text[])`,
      [SWEEP_STATE_SYSTEM, peerKeys]);
    const readyByKey = new Map<string, { at: string; version: number | null }>();
    for (const s of st.rows as Array<{ instance: string; cursor: Record<string, unknown> | null }>) {
      const at = s.cursor?.ready_at;
      const v = s.cursor?.version;
      if (typeof at === "string" && at) readyByKey.set(s.instance, { at, version: typeof v === "number" ? v : null });
    }
    return {
      selfChanged,
      peers: peerRows.map((p) => {
        const key = `${p.preset_key}:${p.instance_key}`;
        return { key, version: Number(p.version), ready: readyByKey.get(key) ?? null };
      }),
    };
  } catch {
    return { peers: null, selfChanged: false };
  }
}

/** 깨끗한 전체 점검을 마쳤다는 기록 — 다른 수집기의 스윕이 «이 수집기는 그 시각 이후 안 본 행을 안 맡는다» 로 읽는다. */
export async function recordNotionSweepReady(
  db: pg.Pool | pg.PoolClient,
  input: { claimKey: string; runStartIso: string; boundVersion: number | null },
): Promise<void> {
  await db.query(
    `INSERT INTO connector_state(system, instance, cursor) VALUES($1,$2,$3::jsonb)
     ON CONFLICT (tenant_id, system, instance) DO UPDATE SET cursor=EXCLUDED.cursor, updated_at=now()`,
    [SWEEP_STATE_SYSTEM, input.claimKey,
     JSON.stringify({ ready_at: input.runStartIso, version: input.boundVersion })]);
}
