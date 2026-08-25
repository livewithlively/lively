// ai-session 자동 알림(#1891) — "하네스가 작업을 마치고 **유저의 액션을 필요로 하는 상태**가 되면 알림".
//
// 왜 스윕인가: `awaiting` 은 저장된 상태가 아니라 세션 목록을 읽을 때마다 파생된다(terminal/sessions.ts).
//  그래서 읽기 경로에 발송을 걸면 **누가 화면을 보든** 발화하고(남의 조회에도), 폴링마다 중복된다.
//  전이 판정을 한 곳(이 스윕)에 모아 두고, 그 판정 자체는 순수 모듈(notify-policy)이 한다.
//
// ⚠ 이 스윕은 알림만 만든다. 배너를 띄우는 것은 화면(브라우저·데스크톱)의 몫이다 — 서버는 이력을 남길 뿐이다.
import { logger } from "../log.js";
import { listSessionsRaw } from "../terminal/terminal-sessions.js";
import { pickAwaitingTransitions } from "../apps/notify-policy.js";
import { notifyMember } from "../apps/notify.js";

/** 세션 id → 직전 관측의 awaiting. 프로세스 메모리에만 산다 — 재시작하면 첫 관측이 전이로 잡힌다(놓친 알림을 살리는 쪽). */
let lastSeen = new Map<string, boolean>();

/** ai-session 이 보낸 알림이라고 말할 앱 id. 이 앱 매니페스트가 notifications 권한을 기본 선언한다. */
const AI_SESSION_APP = "ai-session";

/** 테스트·재기동용. */
export function resetAwaitingState(): void { lastSeen = new Map(); }

export async function sweepAwaitingNotifications(deps?: {
  list?: typeof listSessionsRaw;
  notify?: typeof notifyMember;
}): Promise<{ notified: number; suppressed: number; denied: number }> {
  const list = deps?.list ?? listSessionsRaw;
  const notify = deps?.notify ?? notifyMember;

  // 전체 세션(모든 주인)을 한 번 읽고, 알림은 **각 세션의 주인**에게만 보낸다.
  const all = await list();
  const observed = all
    .filter((s) => s.owner)                     // 주인을 모르면 보낼 곳이 없다
    .map((s) => ({ id: s.id, awaiting: !!s.awaiting }));

  const { notify: ids, next } = pickAwaitingTransitions(lastSeen, observed);
  lastSeen = next;

  const byId = new Map(all.map((s) => [s.id, s]));
  let notified = 0, suppressed = 0, denied = 0;

  for (const id of ids) {
    const s = byId.get(id);
    if (!s?.owner) continue;
    const name = (s.label || s.id).slice(0, 80);
    const r = await notify({
      appId: AI_SESSION_APP,
      memberId: s.owner,
      title: `${name} — 답을 기다려요`,
      body: "AI 세션이 내 확인이나 답을 기다리고 있어요.",
      href: `#/s/${encodeURIComponent(s.id)}`,
      // 같은 세션의 같은 대기로는 쿨다운 안에 다시 울리지 않는다(하네스 상태 떨림 방어).
      dedupe_key: `ai-session:awaiting:${s.id}`,
    }).catch((err) => { logger.warn({ err, session: s.id }, "awaiting 알림 실패"); return null; });

    if (!r) { denied++; continue; }
    if (!r.ok) { denied++; continue; }           // 권한·grant 없음 등 — 조용히 넘어가되 세지 않는다
    if ("suppressed" in r) { suppressed++; continue; }
    notified++;
  }

  if (notified) logger.info({ notified, suppressed, denied }, "awaiting 알림 발송");
  return { notified, suppressed, denied };
}
