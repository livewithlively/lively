// v2/sess-merge.ts — 세션 목록의 **재료 맞추기** 한 벌: 라이브(terminal/sessions) + 기록(v6/sessions) → Sess 한 목록.
//  v2/views.ts 에서 내려왔다(#4865). 셸(main.ts loadData)과 프로젝트 보드의 리스트 뷰(projects/session-list.ts)가 같은 함수를 쓴다 —
//  views.ts 는 셸 화면 전부(대화창·런처·알림)를 끌고 오는 모듈이라 보드가 직접 들이면 무겁고 순환이 생긴다.
//  ⚠ 사본을 두지 마라: 두 화면이 «같은 세션을 한 줄로 접는 규칙»을 따로 가지면 한쪽에만 같은 이름 두 줄이 선다(#762).
//  views.ts 는 여기 것을 그대로 다시 내보낸다 — 기존 import 자리는 바뀌지 않는다.
import { state } from '../core.js';
import { sessIsDead, sessLabel, sessStateKey, stoppedDotKey, stoppedIsPast } from '../session-status.js';
import { taskMarkOf, type TaskMark } from '../lib/liv-work.js';   // #4551 — 위탁 워커 표식(누가 시켰나)

export interface Sess {
  id: string; label: string; projectId: number | null; node: string | null;
  live: boolean; alive: boolean; owned: boolean; stateKey: string; stateLabel: string; lastSeen: number; raw: any;
  /** 만든 때(ms) — 박스는 `created`(초), 기록만 남은 것은 `first_seen`. 둘 다 있으면 이른 쪽(되살린 박스는 대화가 먼저다).
   *  [AI 세션] 목록의 「만든 때」 열이 읽는다(#4233, 원준 2026-09-26 «생성시각도 하나 열로»). 0 = 모른다. */
  createdAt?: number;
  // 중앙 기록 좌표(대화 uuid) — 라이브 행에 접힌 기록(mergeSessions). 기록만 있는 행은 id 자체가 uuid 라 비어 있다.
  logId?: string | null; logNode?: string | null;
  // 접힌 기록의 **대화 제목**(= 그 세션에 처음 시킨 말). 멈춘 세션은 pane 제목(raw.title)이 비어 있어 이름 자리가
  //  프로젝트명 되풀이로 떨어지는데(dev 실측: 한 프로젝트의 지난 세션 7건 중 5건이 같은 이름), 이 값이 그 자리를 받는다.
  logTitle?: string | null;
  /** 이 줄로 접힌 **옛 박스 id** 들 (#762) — 되살리기가 새 박스를 만들면 그 대화의 옛 주소·핀이 여기 남는다.
   *  찾기(findSess·renderSession)가 이 값도 받아, 옛 주소를 든 탭이 죽은 자리로 떨어지지 않는다. */
  altIds?: string[];
  // #1851 휴지통 — 휴지통에 있는 시각(ISO). 있으면 사이드바 '지난 세션'에서 빠지고 「휴지통」 화면(#/trash)에만 보인다.
  trashedAt?: string | null;
  // #1851 — 프로젝트를 통째로 버릴 때 함께 들어간 세션이면 그 프로젝트 id. 없으면 '지난 세션'에서 따로 버린 것 — 휴지통 화면이 둘을 가른다.
  trashedWith?: number | null;
  /** 위탁 워커이면 «누가 시켰나» 표식(#4551, lib/liv-work). 사람이 연 세션은 없다. */
  task?: TaskMark | null;
  /** 위탁 워커가 사이드바에서 **설** 프로젝트(#4551, lib/liv-work placeLivWork). ⚠ 소속(projectId)이 아니다 — 자리만 정한다. */
  standId?: number | null;
  /**
   * #4783 — 꺼진 세션의 **목록 줄 겉모습**(session-status.ts stoppedDotKey · stoppedIsPast). 도는 세션엔 없다.
   *  stopDot: 점('' · waiting · done · error) — 시스템이 끈 세션은 끄기 직전 모습, 고장은 «오류».
   *  stopPast: «지난 세션» 으로 접나 — 사람이 끝냈다고 아는 판만 참(시스템이 끈 것·고장·사유 모름은 거짓). ⚠ 생사(live·alive)와 다른 축이다 — 터미널을 붙일지는 alive 가 정한다.
   */
  stopDot?: '' | 'waiting' | 'done' | 'error';
  stopPast?: boolean;
}

/**
 * **내 세션인가** — 「확인할 것」 계열이 쓰는 단일 술어(#1875 사용자별 격리).
 *
 * 세션 목록은 내 것만 오지 않는다: 프로젝트 세션은 로그인한 전원에게 공개고(#452), 초대받은 세션도 온다.
 *  그래서 목록을 그냥 세면 **남이 답할 것이 내 「확인할 것」에 선다** — 원준 신고(2026-08-27):
 *  *"다른 사람이 만든 세션에서 그 사람이 확인할 것도 내가 확인할 것중에 하나로 뜬다."* 그 화면의 약속은
 *  "**내** 답을 기다리는 세션"이므로, 세는 자리·긋는 자리·배지가 전부 이 술어를 지나야 한다.
 *
 * `owned` 는 서버가 판정한 정본(terminal/sessions.ts — `d.owner === me`)이고, `raw.owner` 대조는
 *  그 값이 안 실린 행(구 응답·노드 raw 수집)용 폴백이다. 둘 다 없으면 **내 것이 아니다**(fail-closed —
 *  모르는 세션을 내 할 일로 세는 쪽이 더 나쁘다).
 */
export const isMineSess = (s: Pick<Sess, 'owned' | 'raw'>): boolean => {
  if (s.owned) return true;
  const me = String((state.me && (state.me as { userId?: string }).userId) || '');
  return !!me && String((s.raw && s.raw.owner) || '') === me;
};

/** 그 세션이 '하던 일' — 하네스 pane 제목이 정본이고, 없으면(멈춘 세션) 중앙 기록의 대화 제목(= 처음 시킨 말). */
export const sessWork = (s: Sess): string => String((s.raw && s.raw.title) || s.logTitle || '').trim();

// ── 데이터 정규화 — 라이브(terminal/sessions) + 기록(v6/sessions) 를 한 목록으로 ─────────
//  같은 세션이 두 목록에 있으면 한 장으로: 라이브 행의 claudeSessionId(박스가 도는 대화 uuid) == 기록 행의 session_id 면
//  기록 행을 라이브 행에 접는다(logId·logNode). 종전엔 '박스 1장 + 그 대화의 기록 1장'이 나란히 떠 같은 세션이 둘로 보였다.
/** 초·밀리초가 섞여 오는 시각 값을 ms 로 — 자릿수로 가른다(lastSeen 이 쓰는 그 자와 같다). */
const msOf = (v: any): number => {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return String(Math.floor(n)).length > 11 ? n : n * 1000;
};

export function mergeSessions(liveRows: any[], logRows: any[]): Sess[] {
  const now = Date.now();
  const out = new Map<string, Sess>();
  const byUuid = new Map<string, Sess>();
  for (const r of liveRows || []) {
    const k = sessStateKey(r, now);
    const s: Sess = {
      id: String(r.id), label: String(r.label || r.title || r.id), projectId: r.projectId ? Number(r.projectId) : null,
      task: taskMarkOf(r.task),   // #4551 — 위탁 워커 표식. 소속(projectId)은 서버가 준 그대로 둔다
      // 노드 세션의 node 는 {id,name,online} 객체다 — id 만 든다(터미널 URL·중앙 기록 좌표에 문자열로 쓴다).
      node: r.node && typeof r.node === 'object' ? (String(r.node.id || '') || null) : (r.node ? String(r.node) : null),
      //  ⚠ **관측 못 한 행은 «살아 있다» 고도 말하지 않는다**(#2544 후속). 폴백 행은 `restorable` 을 안 실어
      //   `sessIsDead` 가 거짓이 되는데, 그 한 틱에 DB 의 세션 **전량**이 «도는 세션» 으로 서서 사이드바의
      //   날짜 컷(오늘 것만)을 통째로 우회했다. «모른다» 는 위(초록점)로도 아래(중단됨)로도 기울지 않는다 —
      //   점 없는 조용한 행으로 두고, 관측이 돌아오면 그때 제자리를 찾는다.
      //   (직전 관측이 있으면 여기 오기 전에 main.ts keepObserved 가 그 값으로 이어 준다 — 그때는 이 갈래에 안 온다.)
      live: true, alive: r.observed === false ? false : !sessIsDead(r, now), owned: !!r.owned, stateKey: k, stateLabel: sessLabel(r, now),
      lastSeen: Number(r.lastActive || r.created || 0) * (String(r.lastActive || r.created || 0).length > 11 ? 1 : 1000) || 0, raw: r,
      createdAt: msOf(r.created), 
      trashedAt: r.trashedAt ? String(r.trashedAt) : null,   // #1851 — 서버가 내 휴지통 표식을 행에 얹는다
      trashedWith: r.trashedWith != null ? Number(r.trashedWith) : null,
    };
    //  #4783 — 꺼진 박스면 **누가 끝냈나** 로 겉모습을 정한다. 관측 못 한 행(«모름»)은 정하지 않는다 — 꺼졌다는 사실부터 모른다.
    if (!s.alive && r.observed !== false) { s.stopDot = stoppedDotKey(r, now); s.stopPast = stoppedIsPast(r); }
    out.set(s.id, s);
    if (r.claudeSessionId && !byUuid.has(String(r.claudeSessionId))) byUuid.set(String(r.claudeSessionId), s);
  }
  for (const r of logRows || []) {
    const id = String(r.session_id);
    if (out.has(id)) continue;
    const owner = byUuid.get(id);
    if (owner) {                                   // 라이브(또는 복원 가능) 박스가 이 대화를 돌린다 — 그 카드에 접는다
      owner.logId = id; owner.logNode = r.node_id || '';
      //  되살린 박스는 `created` 가 **다시 연 시각**이라 대화가 시작된 때보다 늦다 — 이른 쪽이 「만든 때」다.
      const firstMs = r.first_seen ? new Date(r.first_seen).getTime() : 0;
      if (firstMs && (!owner.createdAt || firstMs < owner.createdAt)) owner.createdAt = firstMs;
      if (r.title) owner.logTitle = String(r.title);   // 이름 자리의 폴백(위 logTitle 주석)
      if (!owner.projectId && r.project_id != null) owner.projectId = Number(r.project_id);
      if (!owner.trashedAt && r.trashed_at) { owner.trashedAt = String(r.trashed_at); owner.trashedWith = r.trashed_with != null ? Number(r.trashed_with) : null; }   // 두 이름 중 한쪽에만 표식이 있어도 그 세션은 휴지통
      continue;
    }
    //  ★ 이름은 `name`(서버가 이름 규칙을 태운 값) — `title`(대화 제목, 첫 지시 120자)이 아니다(#2234).
    //   종전엔 title 을 그대로 label 로 썼다. 그래서 박스가 사라져 기록만 남는 순간 같은 세션의 이름이
    //   짧은 이름에서 **첫 지시 원문 121자**로 늘어났고, 그게 좌측 목록의 이름 자리에 그대로 걸렸다
    //   (실측 2026-08-27: 「업데이트 준비가 완료되었습니다. 새 버전 0.1.358 …」). 제목은 logTitle 로 그대로 남는다.
    out.set(id, {
      id, label: String(r.name || r.title || id), logTitle: r.title ? String(r.title) : undefined,
      projectId: r.project_id != null ? Number(r.project_id) : null, node: r.node_id || null,
      live: false, alive: false, owned: true, stateKey: 'log', stateLabel: '기록', lastSeen: r.last_seen ? new Date(r.last_seen).getTime() : 0, raw: r,
      createdAt: r.first_seen ? new Date(r.first_seen).getTime() : 0,
      trashedAt: r.trashed_at ? String(r.trashed_at) : null,
      trashedWith: r.trashed_with != null ? Number(r.trashed_with) : null,
    });
  }
  // ★ 같은 대화를 **두 박스가** 갖고 있으면 한 줄로 접는다 (#762, 원준 2026-09-04 신고).
  //  되살리기는 **새 박스 id** 를 만들고 옛 박스는 offline 으로 남는다. 둘 다 세우면 목록에 «같은 이름 두 줄»이
  //  서고, 죽은 쪽을 누르면 세션 칸이 그 세션을 못 찾아 **다른 세션으로 조용히 갈아탄다** — 사람 눈엔
  //  "안 누른 동명의 다른 세션이 열린다"(dev 실측: 두 줄 모두 box-yoon-459c2898 로 착지했다).
  //  살아 있는 쪽(같으면 최근 쪽)만 남기고, 접힌 id 는 altIds 로 남겨 옛 주소·핀이 그 줄을 계속 가리키게 한다.
  const byConv = new Map<string, Sess>();
  for (const s of [...out.values()]) {
    const conv = String((s.raw && s.raw.claudeSessionId) || '');
    if (!conv) continue;
    const prev = byConv.get(conv);
    if (!prev) { byConv.set(conv, s); continue; }
    //  이긴 쪽 = 살아 있는 것 우선, 그다음 최근에 쓴 것. 진 쪽은 목록에서 빠지고 id 만 이긴 줄에 남는다.
    const win = (s.alive !== prev.alive) ? (s.alive ? s : prev) : (s.lastSeen >= prev.lastSeen ? s : prev);
    const lose = win === s ? prev : s;
    win.altIds = [...(win.altIds || []), ...(lose.altIds || []), lose.id];
    if (!win.projectId && lose.projectId) win.projectId = lose.projectId;
    if (!win.trashedAt && lose.trashedAt) { win.trashedAt = lose.trashedAt; win.trashedWith = lose.trashedWith ?? null; }
    out.delete(lose.id);
    byConv.set(conv, win);
  }
  return [...out.values()];
}

// 상태 key(web/session-status.ts) → 점 색 클래스. 눈에 띄어야 할 셋만 색이다 — 작업 중(파랑·깜빡)·확인 필요(앰버)·작업 완료(민트 링).
//  나머지 살아 있는 것(대기·오프라인·셸)은 회색 계열로 조용히, 끝난 것(중단됨·종료됨·기록)은 빈 점.
/** (#4865) views.ts 에서 내려왔다 — 세션 표(sess-table.ts)가 액자 문서에서도 같은 점 색을 쓰게. */
export function dotCls(stateKey: string): string {
  if (stateKey === 'busy') return 'busy';
  if (stateKey === 'waiting') return 'wait';
  if (stateKey === 'done') return 'done';
  if (stateKey === 'idle') return 'idle';
  if (stateKey === 'offline') return 'off';
  if (stateKey === 'shell') return 'shell';
  return '';
}
