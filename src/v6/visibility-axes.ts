// #1291 — 맥락 유형별 공개범위 **켜기/끄기**. 조직마다 "우리는 이 축은 안 쓴다"를 고를 수 있게 한다.
//
//  왜: 가시성이 5개 축(프로젝트·지식·자료·공유폴더·세션 기록범위)으로 늘면서, 그 전부가 필요하지 않은
//   조직에는 정보 흐름만 복잡해진다(고객사 A 담당자 의견). 축을 끄면 그 유형은 **종전처럼 전원 공개**로 돌아간다.
//
//  ⚠ **끄기는 중립적인 동작이 아니다.** 그 축에 잠긴 항목이 있으면, 끄는 순간 지금까지 일부만 보던 내용이
//   전원에게 열린다. UI 설정처럼 보이지만 실제로는 정보 공개 사건이다. 그래서 capability 쪽에서
//   ①무엇이 누구에게 공개되는지 미리 보여주고 ②명시적 확인을 받고 ③작업기록에 남긴다(vis-axes.ts capability).
//   이 파일은 '지금 켜져 있나'와 '끄면 무엇이 공개되나'만 답한다.
//
//  기본값은 전부 **켜짐** — 지금 동작 그대로다(끄기 전까지 아무것도 달라지지 않는다).
import { itemsPool } from "../db/client.js";
import { logger } from "../log.js";

/** 공개범위를 걸 수 있는 맥락 유형. 새 축이 생기면 여기에 한 줄 + 강제 지점에서 axisOn 확인. */
export const VIS_AXES = ["project", "knowledge", "source", "shared_folder", "session_cap"] as const;
export type VisAxis = (typeof VIS_AXES)[number];

export const AXIS_LABEL: Record<VisAxis, string> = {
  project: "프로젝트(리스트·스페이스)",
  knowledge: "지식",
  source: "자료",
  shared_folder: "공유폴더",
  session_cap: "세션 기록 범위",
};

const TTL_MS = 30_000;
let cache: { v: Record<VisAxis, boolean>; at: number } | null = null;
const ALL_ON = (): Record<VisAxis, boolean> =>
  Object.fromEntries(VIS_AXES.map((a) => [a, true])) as Record<VisAxis, boolean>;

/** 축 설정 전체. 조회 실패 시 **켜짐(현행 동작)** 으로 답한다 — 설정을 못 읽었다고 잠금이 풀리면 그게 유출이다. */
export async function visAxes(): Promise<Record<VisAxis, boolean>> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.v;
  let v = ALL_ON();
  try {
    const r = await itemsPool.query(`SELECT visibility_axes FROM org_runtime_config WHERE id=1`);
    const raw = (r.rows[0]?.visibility_axes ?? {}) as Record<string, unknown>;
    // 명시적으로 false 인 것만 끈다(키가 없으면 켜짐) — 새 축이 추가돼도 기존 조직에서 자동으로 켜진 채 시작한다.
    for (const a of VIS_AXES) if (raw[a] === false) v[a] = false;
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "[vis-axes] 설정 조회 실패 — 전부 켜짐으로 간주(안전한 쪽)");
    v = ALL_ON();
  }
  cache = { v, at: now };
  return v;
}

/** 이 축의 공개범위 강제가 켜져 있나. 강제 지점들이 이걸 보고 필터를 건너뛴다. */
export async function axisOn(axis: VisAxis): Promise<boolean> {
  return (await visAxes())[axis];
}

export function invalidateVisAxes(): void { cache = null; }

/** 설정 저장. 캐시를 즉시 버려 다음 요청부터 반영된다. */
export async function setVisAxes(patch: Partial<Record<VisAxis, boolean>>): Promise<Record<VisAxis, boolean>> {
  const cur = await visAxes();
  const next = { ...cur, ...patch };
  await itemsPool.query(
    `UPDATE org_runtime_config SET visibility_axes = $1::jsonb, updated_at = now() WHERE id=1`,
    [JSON.stringify(next)]);
  invalidateVisAxes();
  return next;
}

export interface AxisLockSummary {
  axis: VisAxis;
  label: string;
  on: boolean;
  /** 지금 이 축에서 공개범위가 걸려 있는 항목 수 — 끄면 이만큼이 전원 공개된다. */
  locked: number;
  /** 사람이 확인할 수 있게 이름 몇 개(전부는 아니다). */
  samples: string[];
}

/**
 * 축별 '지금 잠겨 있는 것' 요약 — 끄기 확인 화면이 "무엇이 공개되나"를 보여주는 데 쓴다.
 *  ⚠ 이건 관리 판정이라 **뷰어 필터 없이 전수**를 센다(끄는 사람이 대상이 아니어도 규모는 알아야 한다).
 *   내용은 주지 않는다 — 이름과 개수까지가 v2 에서 정한 '거버넌스 메타데이터' 선이다.
 */
export async function axisLockSummary(): Promise<AxisLockSummary[]> {
  const on = await visAxes();
  const count = async (sql: string): Promise<{ n: number; names: string[] }> => {
    try {
      const r = await itemsPool.query(sql);
      return { n: r.rows.length, names: r.rows.slice(0, 5).map((x: any) => String(x.name ?? x.id ?? "")) };
    } catch { return { n: 0, names: [] }; }
  };
  const proj = await count(
    `SELECT name FROM project_list WHERE visibility='members'
     UNION ALL SELECT name FROM project_folder WHERE visibility='members'`);
  const know = await count(`SELECT name FROM knowledge WHERE visibility='members'`);
  const src = await count(`SELECT id::text AS name FROM source WHERE visibility='members'`);
  const sf = await count(`SELECT path AS name FROM shared_folder_acl WHERE visibility='members'`);
  // 세션 기록범위는 '잠긴 항목'이 아니라 좁혀진 세션 수다 — 끈다고 뭔가 공개되진 않고, 앞으로 캡이 안 걸릴 뿐이다.
  const cap = await count(`SELECT id AS name FROM org_session_state WHERE write_vis IS NOT NULL AND write_vis <> 'open'`);
  const rows: Array<[VisAxis, { n: number; names: string[] }]> = [
    ["project", proj], ["knowledge", know], ["source", src], ["shared_folder", sf], ["session_cap", cap],
  ];
  return rows.map(([axis, c]) => ({ axis, label: AXIS_LABEL[axis], on: on[axis], locked: c.n, samples: c.names }));
}
