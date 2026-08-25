// 알림 설정 (#1842) — **사람 단위**로 저장한다(기기 단위가 아니다).
//
// 왜 사람 단위인가: 처음엔 데스크톱 앱이 자기 파일(`~/.lively/desktop-notify.json`)에 뒀는데, 그러면
//  사무실 맥에서 끈 것이 노트북에선 그대로 뜬다 — 사람은 "껐는데 뜬다"로 읽는다. 읽음 상태를 사람 단위로
//  옮긴 것과 같은 이유다(#1571: "읽음은 사람 단위 사실이지 기기 단위가 아니다").
//  설정하는 자리도 웹 [내 정보 ▸ 알림] 한 곳이고, 앱은 이 값을 **읽기만** 한다.
import { itemsPool, q } from "../db/client.js";

/** 알림 종류 — 앱(desktop/main/notify.mjs)의 NOTIFY 와 같은 문자열이어야 한다. */
export const NOTIFY_KINDS = ["session_waiting", "session_done", "person"] as const;
export type NotifyPrefKind = (typeof NOTIFY_KINDS)[number];
export type NotifyPrefs = Record<NotifyPrefKind, boolean>;

/** 기본값 — 아무것도 저장한 적 없으면 전부 켜짐. 설정을 못 읽었다고 알림이 멎으면 안 된다. */
export const NOTIFY_PREF_DEFAULTS: NotifyPrefs = {
  session_waiting: true,
  session_done: true,
  person: true,
};

/** 모르는 키는 버리고 빠진 키는 기본값으로 — 앱과 웹이 서로 다른 판을 써도 값이 깨지지 않는다. */
function normalize(src: Record<string, unknown> | null | undefined): NotifyPrefs {
  const out = { ...NOTIFY_PREF_DEFAULTS };
  for (const k of NOTIFY_KINDS) {
    const v = src?.[k];
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

/** 이 사람의 알림 설정. 저장한 적 없으면 기본값(전부 켜짐). */
export async function getNotifyPrefs(memberId: string): Promise<NotifyPrefs> {
  const me = String(memberId || "").trim();
  if (!me) return { ...NOTIFY_PREF_DEFAULTS };
  const rows = await q(itemsPool, `SELECT prefs FROM member_notify_pref WHERE member_id = $1`, [me]);
  return normalize(rows.length ? (rows[0].prefs as Record<string, unknown>) : null);
}

/** 부분 갱신(patch) — 보낸 키만 바꾼다. 화면이 스위치 하나만 만져도 나머지를 되보낼 필요가 없다. */
export async function setNotifyPrefs(memberId: string, patch: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
  const me = String(memberId || "").trim();
  if (!me) throw new Error("no member");
  const cur = await getNotifyPrefs(me);
  const next = normalize({ ...cur, ...patch });
  await q(itemsPool,
    `INSERT INTO member_notify_pref(member_id, prefs, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (tenant_id, member_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
    [me, JSON.stringify(next)]);
  return next;
}
