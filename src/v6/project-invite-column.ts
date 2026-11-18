// project.invite_only 칸이 **이 DB 에 아직 없을 때**를 견디는 가드(#5598 — 롤 창).
//
// ── 왜 ──────────────────────────────────────────────────────────────────────
//  매니지드 롤은 새 게이트웨이를 먼저 띄우고 공용 DB 마이그레이션을 맨 끝에 돌린다(lvly-cloud deploy/roll-tenant-image.sh ② → ⑥ —
//  2026-10-20 에 새 칸을 읽는 인증 경로가 그 몇 분 동안 전부 401 이었다). 프로젝트 초대제는 project.invite_only 를 **모든 프로젝트
//  조회**(행 읽기 묶음 · 공개범위 술어 · 숨은 프로젝트 후보)가 읽는다 — 그대로 롤하면 칸이 생기기 전 몇 분 동안 매니지드 전
//  워크스페이스의 프로젝트 화면 · 세션 목록이 «없는 칸» 으로 실패한다.
//
// ── 어떻게 ──────────────────────────────────────────────────────────────────
//  칸이 있는지 한 번 재고, **없으면 초대제가 없던 때와 똑같이 돈다**: 읽을 때는 `false`, 쓸 때는 그 칸을 빼고, 공개 범위 바꾸기는
//  «배포 중» 으로 거절한다. 칸이 없으면 초대제 프로젝트도 있을 수 없으므로(표시를 찍을 자리가 없다) 이 폴백은 아무것도 열지 않는다.
//  마이그레이션이 칸을 만들면 다음 조회부터(다시 재는 간격 안에) 스스로 켜진다 — 재기동이 필요 없다.
//
// ── 세 상태 ─────────────────────────────────────────────────────────────────
//   null(아직 안 쟀다) → **있다고 본다.** 자체 호스팅 · 시험 · 스크립트는 부팅 때 스키마 체인이 칸을 만든 뒤에 돈다 — 재지 않은
//                        프로세스가 초대제를 끈 채 돌면 닫힌 프로젝트가 그 사이 전원에게 보인다. 모르면 닫는 쪽(있는 칸으로 읽는다).
//   true(있다)         → 다시 재지 않는다(칸은 사라지지 않는다).
//   false(없다)        → REPROBE_MS 마다 다시 잰다.
//  재는 자리: 게이트웨이 부팅 · 프로젝트 공개범위를 뽑는 자리(visibility.projectVisFor · hiddenProjects) · 프로젝트 목록 · 생성 ·
//   공개 범위 바꾸기 · 휴지통 개수 · 세션 초대 맞추기. 동기 코드(SQL 조각을 조립하는 자리)는 잰 값만 읽는다.
import { itemsPool } from "../db/client.js";

const REPROBE_MS = 3_000;
let known: boolean | null = null;
let lastProbe = 0;
let inflight: Promise<boolean> | null = null;

/** (동기) 칸이 있다고 보고 SQL 을 짤까 — 잰 값이 «없다» 일 때만 false. */
export function inviteOnlyColumnExists(): boolean {
  return known !== false;
}

/** SQL 조각 — 칸이 있으면 `<별칭>.invite_only`, 없으면 `false`. 별칭은 식별자여야 한다. */
export function inviteOnlySql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`inviteOnlySql: 별칭이 아니다(${alias})`);
  return inviteOnlyColumnExists() ? `${alias}.invite_only` : "false";
}

async function probe(): Promise<boolean> {
  try {
    // to_regclass 는 search_path 를 따른다(테이블을 스키마 이름 없이 읽는 다른 조회와 같은 표를 본다).
    const r = await itemsPool.query(
      `SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('project') AND attname = 'invite_only' AND NOT attisdropped`);
    known = r.rows.length > 0;
  } catch {
    //  못 쟀다 — 값을 바꾸지 않는다. 처음부터 못 쟀으면 null(= 있다고 본다)로 남는다.
  }
  lastProbe = Date.now();
  return known !== false;
}

/**
 * 칸이 있는지 잰다(이미 «있다» 로 쟀으면 곧바로 true · «없다» 였으면 간격을 두고 다시 잰다). 던지지 않는다.
 *  프로젝트 조회의 SQL 을 짜기 **전에** 부른다 — 그 뒤의 동기 조립(inviteOnlySql · project-store 의 행 읽기 묶음)이 이 값을 읽는다.
 */
export async function ensureInviteOnlyColumn(): Promise<boolean> {
  if (known === true) return true;
  if (known === false && Date.now() - lastProbe < REPROBE_MS) return false;
  if (!inflight) inflight = probe().finally(() => { inflight = null; });
  return inflight;
}

/** 시험용 — 잰 값을 버린다(칸을 잠깐 없앤 시험이 다시 재게 한다). */
export function resetInviteOnlyColumnProbe(): void {
  known = null; lastProbe = 0; inflight = null;
}
