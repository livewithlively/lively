// 앱이 보낸 알림의 **이력**(#1891). 지금까지 「확인할 것」은 라이브 세션에서 파생돼 남는 게 없었다 —
//  화면을 안 보고 있으면 그냥 지나갔고, 나중에 "무슨 알림이 왔었지"를 물을 데가 없었다. 그래서 저장한다.
//
// 판정·정규화는 src/apps/notify-policy.ts(순수)가 하고, 여기는 저장·조회만 한다.
import crypto from "node:crypto";
import { itemsPool } from "../../db/client.js";

export interface AppNotificationRow {
  id: string;
  app_id: string;
  member_id: string;
  title: string;
  body: string | null;
  href: string | null;
  dedupe_key: string | null;
  created_at: string;
  read_at: string | null;
}

function row(x: Record<string, unknown>): AppNotificationRow {
  return {
    id: String(x.id), app_id: String(x.app_id), member_id: String(x.member_id),
    title: String(x.title), body: x.body == null ? null : String(x.body),
    href: x.href == null ? null : String(x.href),
    dedupe_key: x.dedupe_key == null ? null : String(x.dedupe_key),
    created_at: String(x.created_at), read_at: x.read_at == null ? null : String(x.read_at),
  };
}

/**
 * 같은 (앱·멤버·dedupe_key) 의 **가장 최근 발송 시각**(ms). 없으면 null.
 * 중복 억제 판정(shouldSuppressDuplicate)의 입력이다 — 판정 자체는 순수 모듈이 한다.
 */
export async function lastSentAtMs(appId: string, memberId: string, dedupeKey: string): Promise<number | null> {
  const r = await itemsPool.query(
    `SELECT created_at FROM org_app_notification
      WHERE app_id=$1 AND member_id=$2 AND dedupe_key=$3
      ORDER BY created_at DESC LIMIT 1`,
    [appId, memberId, dedupeKey],
  );
  const at = r.rows[0]?.created_at;
  if (!at) return null;
  const ms = new Date(String(at)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export async function insertNotification(input: {
  appId: string; memberId: string; title: string; body: string | null; href: string | null; dedupeKey: string | null;
}): Promise<AppNotificationRow> {
  const id = crypto.randomUUID();
  const r = await itemsPool.query(
    `INSERT INTO org_app_notification(id, app_id, member_id, title, body, href, dedupe_key)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [id, input.appId, input.memberId, input.title, input.body, input.href, input.dedupeKey],
  );
  return row(r.rows[0] as Record<string, unknown>);
}

/** 내 알림 이력(최신순). unreadOnly 면 안 읽은 것만. */
export async function listNotifications(memberId: string, opts: { limit?: number; unreadOnly?: boolean } = {}): Promise<AppNotificationRow[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const where = ["member_id=$1"];
  if (opts.unreadOnly) where.push("read_at IS NULL");
  const r = await itemsPool.query(
    `SELECT * FROM org_app_notification WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
    [memberId],
  );
  return r.rows.map((x) => row(x as Record<string, unknown>));
}

export async function unreadCount(memberId: string): Promise<number> {
  const r = await itemsPool.query(
    `SELECT COUNT(*)::int AS n FROM org_app_notification WHERE member_id=$1 AND read_at IS NULL`, [memberId]);
  return Number((r.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
}

/**
 * 읽음 처리. ids 를 주면 그것만, 안 주면 그 멤버의 안 읽은 것 전부.
 * ⚠ member_id 조건을 항상 건다 — id 만으로 남의 알림을 읽음 처리할 수 없어야 한다.
 */
export async function markRead(memberId: string, ids?: readonly string[]): Promise<number> {
  if (ids && ids.length === 0) return 0;
  const r = ids
    ? await itemsPool.query(
        `UPDATE org_app_notification SET read_at=now()
          WHERE member_id=$1 AND read_at IS NULL AND id = ANY($2::text[])`, [memberId, [...ids]])
    : await itemsPool.query(
        `UPDATE org_app_notification SET read_at=now() WHERE member_id=$1 AND read_at IS NULL`, [memberId]);
  return r.rowCount ?? 0;
}

/** 앱을 지울 때 그 앱이 남긴 알림도 회수한다(설치 파이프라인의 역순 보상과 같은 결). */
export async function deleteNotificationsForApp(appId: string): Promise<number> {
  const r = await itemsPool.query(`DELETE FROM org_app_notification WHERE app_id=$1`, [appId]);
  return r.rowCount ?? 0;
}
