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

/**
 * 이 스윕의 **목록 출처**를 정한다 — 주인이 노드로 옮겨간 테넌트는 그 노드 스냅샷에서 읽는다 (#2600 T2 d4).
 *
 * ── 왜 호출부가 아니라 여기인가 (2026-09-08 실측) ────────────────────────────
 * 이 스윕은 **두 자리에서** 돌아간다 — 하우스키핑 30초 타이머(`boot/housekeeping.ts`)와 요청 정비표
 *  (`sessions/outbox-request-sweep.ts`, 매니지드에서 요청에 얹혀 같은 30초 간격). 처음엔 타이머 쪽
 *  **호출부에** 판정을 심었는데, 그러면 나머지 한 자리는 종전대로 게이트웨이 tmux 를 계속 읽는다 —
 *  실제로 그렇게 됐다(계수 실측: 세션 호스트가 붙은 테넌트도 `list-sessions` 가 안 사라졌다).
 *  **판정을 이 함수 안에 두면 호출부가 몇 개든 갈릴 수가 없다.** 이 프로젝트가 지우려는 것이 정확히
 *  «같은 일을 하는 두 벌» 이므로, 고치는 방법도 두 번째 사본을 만드는 것이 아니라 사본을 없애는 것이다.
 *
 * ⚠ 판정은 목록 소유(`terminal/routes.ts`·`project/project-routes.ts`)와 **같은 술어·같은 신선도 자**를
 *  쓴다 — 둘이 갈리면 「목록은 호스트가 답하는데 알림은 게이트웨이가 본다」는 어긋남이 생긴다.
 * ⚠ 동적 import 인 이유: `sessions/` 가 `node/registry` 를 **모듈 로드 시점에** 물면 부팅 순서·의존
 *  그래프가 그만큼 굵어진다. 이 자리는 30초에 한 번 도는 비동기 스윕이라 지연이 무의미하다.
 *  (노드 에이전트 번들에는 이 모듈이 실리지 않는다 — 실린다면 동적 import 로도 못 빠진다.)
 */
async function defaultSessionList(): Promise<typeof listSessionsRaw> {
  try {
    const [{ sessionHostsInScope, nodeSessionsInScope, NODE_STATE_STALE_MS }, { gatewayDefersToSessionHost }] =
      await Promise.all([import("../node/registry.js"), import("../node/self-node.js")]);
    if (!gatewayDefersToSessionHost(sessionHostsInScope(), NODE_STATE_STALE_MS)) return listSessionsRaw;
    return async () => nodeSessionsInScope();
  } catch (err) {
    //  판정을 못 세우면 **종전 경로**다(fail-closed 는 여기선 «게이트웨이가 계속 본다» 쪽이다 — 알림이
    //   빠지는 것보다 낫다). 조용히 삼키지 않고 남긴다: 이 자리가 죽으면 계수가 안 줄어드는 것으로만 보인다.
    logger.warn({ err }, "awaiting 스윕 출처 판정 실패 — 게이트웨이 tmux 로 간다");
    return listSessionsRaw;
  }
}

export async function sweepAwaitingNotifications(deps?: {
  list?: typeof listSessionsRaw;
  notify?: typeof notifyMember;
}): Promise<{ observed: number; awaiting: number; notified: number; suppressed: number; denied: number }> {
  const list = deps?.list ?? await defaultSessionList();
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

  //  ⚠ **observed 를 함께 돌려준다.** 셋(notified·suppressed·denied)만으로는 «0건» 의 뜻이 갈리지 않는다 —
  //   세션 20개를 봤는데 전이가 없어 0인 것과, 볼 세션이 **아예 0개**인 것(중계가 끊겼다·컨텍스트가 틀렸다)이
  //   똑같이 0,0,0 이다. 그 둘을 구별 못 해서 매니지드에서 이 스윕이 죽어 있던 걸 이틀이나 몰랐다(#2246).
  const awaiting = observed.filter((o) => o.awaiting).length;
  if (notified) logger.info({ observed: observed.length, awaiting, notified, suppressed, denied }, "awaiting 알림 발송");
  return { observed: observed.length, awaiting, notified, suppressed, denied };
}
