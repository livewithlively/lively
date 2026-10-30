// 하네스 로그인 판의 **작업 행**(org_login_job) — 읽고 쓰기만 한다 (#4012 T13 · #4067).
//  판정(언제 멈추나 · 무엇을 받나)은 login-job.ts 가 쥐고, 이 파일은 SQL 만 안다.
//  ⚠ 모든 조회는 요청 컨텍스트(RLS)의 테넌트로 좁혀진다 — 판의 콜백도 테넌트 호스트로 오므로 남의 작업 행은 안 보인다.
import crypto from "node:crypto";
import { itemsPool, q } from "../db/client.js";
import type { LoginPurpose } from "./login-job-script.js";
import type { HeadlessAdminBasis } from "../org/credentials/headless-connect.js";

export type LoginJobStatus = "starting" | "running" | "done" | "failed" | "cancelled" | "expired";
export const LIVE_STATUSES: readonly LoginJobStatus[] = Object.freeze(["starting", "running"]);

export interface LoginJobRow {
  id: number;
  member_id: string;
  harness: string;
  purpose: LoginPurpose;
  status: LoginJobStatus;
  secret_hash: string;
  /** 헤드리스 결과의 관리자 판정 근거(시작 요청의 토큰에서) — headless-connect.headlessAdminBasis. */
  admin_basis: HeadlessAdminBasis;
  screen: string;
  exit_code: number | null;
  /** 암호화된 붙여넣기 코드(없으면 null). */
  paste: string | null;
  error: string | null;
  unit: string | null;
  reaped: boolean;
  created_at: Date;
  updated_at: Date;
  ui_seen_at: Date;
  unit_seen_at: Date | null;
  finished_at: Date | null;
}

/** 판에 줄 일회용 비밀(원문)과 DB 에 둘 해시. */
export function newJobSecret(): { secret: string; hash: string } {
  const secret = crypto.randomBytes(32).toString("base64url");
  return { secret, hash: hashJobSecret(secret) };
}
export function hashJobSecret(secret: string): string {
  return crypto.createHash("sha256").update(String(secret), "utf8").digest("hex");
}
/** (순수) 비밀 대조 — 상수시간. 행의 해시가 비었거나 모양이 다르면 늘 false(부재를 «통과» 로 접지 않는다). */
export function jobSecretMatches(row: Pick<LoginJobRow, "secret_hash"> | null | undefined, presented: string): boolean {
  const want = String(row?.secret_hash ?? "");
  if (!/^[0-9a-f]{64}$/.test(want) || !presented) return false;
  const got = hashJobSecret(presented);
  return crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(want, "hex"));
}

const COLS = `id, member_id, harness, purpose, status, secret_hash, admin_basis, screen, exit_code, paste, error, unit, reaped,
  created_at, updated_at, ui_seen_at, unit_seen_at, finished_at`;

const norm = (r: Record<string, unknown> | undefined): LoginJobRow | null =>
  r ? ({ ...r, id: Number(r.id) } as unknown as LoginJobRow) : null;

export async function createLoginJob(o: {
  memberId: string; harness: string; purpose: LoginPurpose; secretHash: string; adminBasis: HeadlessAdminBasis;
}): Promise<LoginJobRow> {
  const rows = await q(itemsPool,
    `INSERT INTO org_login_job(member_id, harness, purpose, secret_hash, admin_basis) VALUES($1,$2,$3,$4,$5) RETURNING ${COLS}`,
    [o.memberId, o.harness, o.purpose, o.secretHash, o.adminBasis]);
  return norm(rows[0])!;
}

/** 한 번도 돌지 않은 작업을 지운다 — CP 가 그 판을 모른다고 답해 종전 경로로 갈 때만(login-job.startLoginJob). */
export async function deleteLoginJob(id: number): Promise<void> {
  await q(itemsPool, `DELETE FROM org_login_job WHERE id=$1 AND status='starting'`, [id]);
}

export async function getLoginJob(id: number): Promise<LoginJobRow | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const rows = await q(itemsPool, `SELECT ${COLS} FROM org_login_job WHERE id=$1`, [id]);
  return norm(rows[0]);
}

/** 그 사람·용도·하네스의 **가장 최근** 작업(끝난 것 포함) — 화면 상태와 이어받기의 근거. */
export async function latestLoginJob(memberId: string, purpose: LoginPurpose, harness: string): Promise<LoginJobRow | null> {
  const rows = await q(itemsPool,
    `SELECT ${COLS} FROM org_login_job WHERE member_id=$1 AND purpose=$2 AND harness=$3 ORDER BY id DESC LIMIT 1`,
    [memberId, purpose, harness]);
  return norm(rows[0]);
}

/**
 * 판이 섰다 — 유닛 이름을 **언제나** 적고(한 번만), 아직 starting 이면 running 으로 올린다. 적은 뒤의 상태를 돌려준다
 *  (이미 유닛이 적혀 있었거나 행이 없으면 null).
 *  ⚠ 판을 띄우는 사이(수 초)에 다른 요청이 그 작업을 끝낼 수 있다(취소·다시 시작). 그때도 유닛 이름을 남겨야
 *   치우기가 그 판을 찾는다 — 그래서 끝난 행이면 «안 치움» 으로 되돌려 정리 감시가 다시 보게 한다(리뷰 #4067).
 */
export async function markLoginJobRunning(id: number, unit: string): Promise<LoginJobStatus | null> {
  const rows = await q(itemsPool,
    `UPDATE org_login_job
        SET unit=$2,
            status=CASE WHEN status='starting' THEN 'running' ELSE status END,
            reaped=CASE WHEN status IN ('starting','running') THEN reaped ELSE false END,
            updated_at=now()
      WHERE id=$1 AND unit IS NULL
      RETURNING status`, [id, unit]);
  return rows.length ? (rows[0].status as LoginJobStatus) : null;
}

/** 화면이 물었다 — 판의 «사람이 아직 보고 있나» 판정 근거. */
export async function touchLoginJobUi(id: number): Promise<void> {
  await q(itemsPool, `UPDATE org_login_job SET ui_seen_at=now() WHERE id=$1`, [id]);
}

/**
 * 판의 박동 — 화면을 싣고, 기다리던 붙여넣기를 **꺼내며 지운다**(한 번만 준다). 살아 있는 작업에만.
 *  ⚠ 꺼내기와 지우기가 한 문장이다 — 두 슬롯이 동시에 받아도 코드는 한 번만 나간다.
 */
export async function tickLoginJob(id: number, screen: string): Promise<{ paste: string | null } | null> {
  const rows = await q(itemsPool,
    `WITH old AS (SELECT id, paste FROM org_login_job WHERE id=$1 AND status IN ('starting','running') FOR UPDATE)
     UPDATE org_login_job j SET screen=$2, unit_seen_at=now(), updated_at=now(), paste=NULL
       FROM old WHERE j.id = old.id
     RETURNING old.paste AS paste`,
    [id, screen]);
  if (!rows.length) return null;
  return { paste: (rows[0].paste as string | null) ?? null };
}

export async function setLoginJobPaste(id: number, encrypted: string): Promise<boolean> {
  const rows = await q(itemsPool,
    `UPDATE org_login_job SET paste=$2, updated_at=now() WHERE id=$1 AND status IN ('starting','running') RETURNING id`,
    [id, encrypted]);
  return rows.length > 0;
}

/**
 * 작업을 끝낸다 — **살아 있을 때만**(끝난 작업의 상태는 먼저 온 쪽이 정한다). 바뀌었으면 true.
 *  붙여넣기 코드는 끝나는 순간 지운다.
 */
export async function finishLoginJob(id: number, status: Exclude<LoginJobStatus, "starting" | "running">,
  o: { error?: string | null; exitCode?: number | null; screen?: string | null } = {}): Promise<boolean> {
  const rows = await q(itemsPool,
    `UPDATE org_login_job SET status=$2, error=COALESCE($3, error), exit_code=COALESCE($4, exit_code),
            screen=COALESCE($5, screen), paste=NULL, finished_at=now(), updated_at=now()
      WHERE id=$1 AND status IN ('starting','running') RETURNING id`,
    [id, status, o.error ?? null, o.exitCode ?? null, o.screen ?? null]);
  return rows.length > 0;
}

export async function markLoginJobReaped(id: number): Promise<void> {
  await q(itemsPool, `UPDATE org_login_job SET reaped=true, updated_at=now() WHERE id=$1`, [id]);
}

/** 정리 감시가 볼 행 — 살아 있거나, 끝났는데 판 폴더를 안 치운 것. 이 테넌트 것만(RLS). */
export async function openLoginJobs(limit = 200): Promise<LoginJobRow[]> {
  const rows = await q(itemsPool,
    `SELECT ${COLS} FROM org_login_job WHERE status IN ('starting','running') OR reaped = false ORDER BY id LIMIT $1`, [limit]);
  return rows.map((r) => norm(r)!);
}
