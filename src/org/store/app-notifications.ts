// 앱이 보낸 알림의 **이력**(#1891). 지금까지 「확인할 것」은 라이브 세션에서 파생돼 남는 게 없었다 —
//  화면을 안 보고 있으면 그냥 지나갔고, 나중에 "무슨 알림이 왔었지"를 물을 데가 없었다. 그래서 저장한다.
//
// 판정·정규화는 src/apps/notify-policy.ts(순수)가 하고, 여기는 저장·조회만 한다.
import crypto from "node:crypto";
import { itemsPool } from "../../db/client.js";
import { INBOX_HIDDEN_KINDS, type NotifyScope } from "../../apps/notify-policy.js";

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
  /** #4180 — 종류(app · session · liv · comment · mention). 「확인할 것」은 이걸로 거른다(notify-policy). */
  kind: string;
  /** #4180 — 이 알림을 만든 사람(구성원 id). 앱·세션 알림은 없다. */
  actor: string | null;
  /** 조회 때 명부에서 붙인 이름 — 화면 규칙과 같다(닉네임을 쓰기로 켠 사람만 닉네임, 아니면 표시 이름). 저장 안 함. */
  actor_name?: string | null;
}

function row(x: Record<string, unknown>): AppNotificationRow {
  return {
    id: String(x.id), app_id: String(x.app_id), member_id: String(x.member_id),
    title: String(x.title), body: x.body == null ? null : String(x.body),
    href: x.href == null ? null : String(x.href),
    dedupe_key: x.dedupe_key == null ? null : String(x.dedupe_key),
    created_at: String(x.created_at), read_at: x.read_at == null ? null : String(x.read_at),
    kind: x.kind == null ? "app" : String(x.kind),
    actor: x.actor == null ? null : String(x.actor),
    ...(x.actor_name !== undefined ? { actor_name: x.actor_name == null ? null : String(x.actor_name) } : {}),
  };
}

/** 범위 조건 — inbox 면 숨김 종류를 뺀다. `$n` 자리를 받아 파라미터 목록에 종류 배열을 밀어 넣는다. */
function scopeWhere(scope: NotifyScope, params: unknown[], col = "kind"): string {
  if (scope === "all") return "TRUE";
  params.push([...INBOX_HIDDEN_KINDS]);
  return `${col} <> ALL($${params.length}::text[])`;
}
//  actor 의 이름은 화면 규칙(web/lib/person-name.ts)과 같은 판정으로 붙인다 — 닉네임을 쓰기로 켠 사람만 닉네임.
const ACTOR_NAME_SQL = `CASE WHEN m.use_nickname = TRUE AND COALESCE(m.nickname,'') <> '' THEN m.nickname ELSE m.display_name END AS actor_name`;

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
  kind?: string; actor?: string | null;
}): Promise<AppNotificationRow> {
  const id = crypto.randomUUID();
  const r = await itemsPool.query(
    `INSERT INTO org_app_notification(id, app_id, member_id, title, body, href, dedupe_key, kind, actor)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [id, input.appId, input.memberId, input.title, input.body, input.href, input.dedupeKey, input.kind || "app", input.actor ?? null],
  );
  return row(r.rows[0] as Record<string, unknown>);
}

/**
 * 내 알림 이력(최신순). unreadOnly 면 안 읽은 것만.
 *  scope(#4180) — inbox(기본) 는 「확인할 것」 렌즈(세션 대기·완료 제외), all 은 배너 렌즈(전부).
 *  actor 가 있으면 명부에서 이름을 붙여 준다(actor_name) — 화면이 id 만 받으면 «누구» 를 그릴 수 없다.
 */
export async function listNotifications(memberId: string, opts: { limit?: number; unreadOnly?: boolean; scope?: NotifyScope } = {}): Promise<AppNotificationRow[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const params: unknown[] = [memberId];
  const where = ["n.member_id=$1"];
  if (opts.unreadOnly) where.push("n.read_at IS NULL");
  where.push(scopeWhere(opts.scope ?? "inbox", params, "n.kind"));
  const r = await itemsPool.query(
    `SELECT n.*, ${ACTOR_NAME_SQL}
       FROM org_app_notification n
       LEFT JOIN org_member m ON m.id = n.actor
      WHERE ${where.join(" AND ")}
      ORDER BY n.created_at DESC LIMIT ${limit}`,
    params,
  );
  return r.rows.map((x) => row(x as Record<string, unknown>));
}

/** 안 읽은 개수 — 목록과 **같은 렌즈**(scope)로 센다. 렌즈가 갈리면 종이 4 라 하고 목록이 3 이다. */
export async function unreadCount(memberId: string, opts: { scope?: NotifyScope } = {}): Promise<number> {
  const params: unknown[] = [memberId];
  const sw = scopeWhere(opts.scope ?? "inbox", params);
  const r = await itemsPool.query(
    `SELECT COUNT(*)::int AS n FROM org_app_notification WHERE member_id=$1 AND read_at IS NULL AND ${sw}`, params);
  return Number((r.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
}

/**
 * 읽음 처리. ids 를 주면 그것만, 안 주면 그 멤버의 안 읽은 것 전부 — **그 렌즈 안에서**(scope, 기본 inbox).
 *  「모두 읽음」이 보이지 않는 세션 알림까지 읽음으로 돌리는 건 무해하지만, 목록에 보이는 것만 만지는 편이 뜻이 맞다.
 * ⚠ member_id 조건을 항상 건다 — id 만으로 남의 알림을 읽음 처리할 수 없어야 한다.
 */
export async function markRead(memberId: string, ids?: readonly string[], opts: { scope?: NotifyScope } = {}): Promise<number> {
  if (ids && ids.length === 0) return 0;
  if (ids) {
    const r = await itemsPool.query(
      `UPDATE org_app_notification SET read_at=now()
        WHERE member_id=$1 AND read_at IS NULL AND id = ANY($2::text[])`, [memberId, [...ids]]);
    return r.rowCount ?? 0;
  }
  const params: unknown[] = [memberId];
  const sw = scopeWhere(opts.scope ?? "inbox", params);
  const r = await itemsPool.query(
    `UPDATE org_app_notification SET read_at=now() WHERE member_id=$1 AND read_at IS NULL AND ${sw}`, params);
  return r.rowCount ?? 0;
}

/** 앱을 지울 때 그 앱이 남긴 알림도 회수한다(설치 파이프라인의 역순 보상과 같은 결). */
export async function deleteNotificationsForApp(appId: string): Promise<number> {
  const r = await itemsPool.query(`DELETE FROM org_app_notification WHERE app_id=$1`, [appId]);
  return r.rowCount ?? 0;
}
