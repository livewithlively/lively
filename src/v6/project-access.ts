// 새 프로젝트 공개 방식(#5598, 상민 2026-11-18) — 워크스페이스마다 «초대제» 와 «전체 공개» 중 하나를 고른다.
//
// ── 두 방식 ─────────────────────────────────────────────────────────────────
//   · **invite — 초대제(기본값)**: 사람이 만드는 프로젝트는 «만든 사람과 초대한 사람만 보는» 표시(project.invite_only)를 달고
//     태어난다. 세션(#1876)과 같은 모델이다 — 비우면 나만 보고, 부른 사람만 함께 본다. 초안이 풀려도 저절로 공개되지 않는다.
//   · **open — 전체 공개**: 이 설정 이전의 동작 그대로다. 프로젝트는 워크스페이스 전원이 본다. 세션 첫 지시로 저절로 생긴 초안만
//     만든 사람과 팀원이 보다가, 무언가를 남기면 풀려 전원에게 보인다(#5522 · v6/project-draft.ts).
//
// ── ★ 이 설정은 «새 프로젝트의 기본값» 이다 ─────────────────────────────────
//  설정을 바꿔도 **이미 있는 프로젝트의 공개 범위는 움직이지 않는다.** 판정(v6/visibility.ts)은 이 설정을 읽지 않고 프로젝트마다
//  찍힌 표시만 본다. 그래서:
//   · 초대제 → 전체 공개로 바꿔도 닫혀 있던 프로젝트가 그 순간 전원에게 열리지 않는다(공개 사건이 아니다).
//   · 전체 공개 → 초대제로 바꿔도 동료가 보던 프로젝트가 그 순간 사라지지 않는다.
//  프로젝트 하나의 공개 범위는 그 프로젝트를 만든 사람이 바꾼다(project-store.setProjectAccess).
//
// ── 못 읽으면 초대제 ────────────────────────────────────────────────────────
//  설정을 못 읽었을 때 «전체 공개» 로 답하면 그 사이에 만든 프로젝트가 전원에게 열린 채 태어난다. 닫는 쪽으로 답한다 —
//  잘못 닫힌 프로젝트는 만든 사람이 한 번 눌러 열 수 있지만, 잘못 열린 프로젝트는 이미 누가 봤는지 알 수 없다.
import { itemsPool } from "../db/client.js";
import { logger } from "../log.js";
import { axisOn } from "./visibility-axes.js";
import { ensureInviteOnlyColumn } from "./project-invite-column.js";

export const PROJECT_ACCESS_MODES = ["invite", "open"] as const;
export type ProjectAccessMode = (typeof PROJECT_ACCESS_MODES)[number];

/** 아무것도 고르지 않은 워크스페이스의 방식. */
export const PROJECT_ACCESS_DEFAULT: ProjectAccessMode = "invite";

export const PROJECT_ACCESS_LABEL: Record<ProjectAccessMode, string> = {
  invite: "초대제",
  open: "전체 공개",
};

/** 저장된 글자 → 방식. 모르는 값 · 빈 값은 기본값(초대제). */
export function parseProjectAccessMode(raw: unknown): ProjectAccessMode {
  return raw === "open" ? "open" : raw === "invite" ? "invite" : PROJECT_ACCESS_DEFAULT;
}

const TTL_MS = 30_000;   // visibility-axes.ts 와 같은 보관 시간 — 다른 프로세스가 바꾼 설정은 이 안에 따라온다
let cache: { v: ProjectAccessMode; at: number } | null = null;

/** 이 워크스페이스의 새 프로젝트 공개 방식. 조회 실패 = 초대제(닫는 쪽 — 머리말). */
export async function projectAccessMode(opts: { fresh?: boolean } = {}): Promise<ProjectAccessMode> {
  const now = Date.now();
  //  fresh — 보관값을 건너뛰고 지금 값을 읽는다. **프로젝트를 만드는 자리**가 쓴다: 관리자가 «전체 공개 → 초대제» 로 바꾼 직후
  //   다른 프로세스가 보관값(30초)으로 프로젝트를 열린 채 만들면 그건 되돌릴 수 없다(누가 봤는지 모른다). 생성은 드물고
  //   한 줄짜리 조회라 매번 읽는 값이 싸다. 화면에 방식을 보여 주는 자리(목록 · 상세 응답)는 보관값으로 충분하다.
  if (!opts.fresh && cache && now - cache.at < TTL_MS) return cache.v;
  let v: ProjectAccessMode = PROJECT_ACCESS_DEFAULT;
  try {
    const r = await itemsPool.query(`SELECT project_access FROM org_runtime_config WHERE id=1`);
    v = parseProjectAccessMode(r.rows[0]?.project_access);
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "[project-access] 설정 조회 실패 — 초대제로 간주(닫는 쪽)");
    return PROJECT_ACCESS_DEFAULT;   // 실패는 보관하지 않는다 — 다음 생성이 다시 읽는다
  }
  cache = { v, at: now };
  return v;
}

export function invalidateProjectAccessMode(): void { cache = null; }

/** 설정 저장. 행이 없는 워크스페이스(처음 저장)면 만든다 — 다른 칸은 컬럼 기본값으로 선다(org/store/runtime-config.ts 의
 *  다른 단일 칸 저장과 같은 문장 꼴). 캐시를 곧바로 버려 이 프로세스의 다음 조회부터 따른다. */
export async function setProjectAccessMode(mode: ProjectAccessMode): Promise<ProjectAccessMode> {
  if (!(PROJECT_ACCESS_MODES as readonly string[]).includes(mode)) throw new Error(`project_access 는 ${PROJECT_ACCESS_MODES.join("|")}`);
  await itemsPool.query(
    `INSERT INTO org_runtime_config(id, project_access, updated_at) VALUES(1, $1, now())
     ON CONFLICT (tenant_id, id) DO UPDATE SET project_access = EXCLUDED.project_access, updated_at = now()`, [mode]);
  invalidateProjectAccessMode();
  return mode;
}

/**
 * 화면 · 도구에 주는 «지금 이 워크스페이스의 프로젝트 공개» 한 벌 — 방식과, 그것이 실제로 강제되는가.
 *  enforced = 프로젝트 공개범위 축이 켜져 있고 **초대제 칸이 이 DB 에 있다**. 축이 꺼졌거나 칸이 아직 없으면(배포가 스키마를
 *  맞추는 몇 분 — project-invite-column.ts) 초대제 표시가 아무것도 가리지 않으므로, 화면은 그때 «나만 봅니다» 라고 말하지 않는다.
 */
export async function projectAccessInfo(): Promise<{ mode: ProjectAccessMode; enforced: boolean }> {
  const [mode, axis, col] = await Promise.all([projectAccessMode(), axisOn("project"), ensureInviteOnlyColumn()]);
  return { mode, enforced: axis && col };
}
