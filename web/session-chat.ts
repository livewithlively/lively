// session-chat.ts — 세션 화면의 가운데(#1719): 라이브 AI 세션(또는 그 기록)을 **터미널 대신 대화창**으로.
//
//  ── 무엇 ──
//  공용 대화창(web/chat-view.ts — 리브와 같은 그림)에 **세션의 대화 파일**을 실어 준다.
//   · 읽기: 박스 세션은 GET terminal/sessions/:id/transcript(박스의 대화 파일을 창으로, 0.7초 폴링) · 노드 세션·기록만 남은 세션은 중앙 기록
//     (v6/sessions/:uuid/log). **둘 다 공통 ChatLine ndjson**(#1746 — 서버 하네스 어댑터가 claude·grok·agy 원문을 한 모양으로 번역, 이 파일은
//     하네스를 모른다). 창은 서버가 줄 경계로 맞춰 준다(X-Log-From/To 가 다음 경계). 못 읽는 하네스는 409 + 행의 chat.read=false → 터미널 안내.
//   · 보내기: POST terminal/sessions/:id/prompt(#1664 — 터미널에서 치는 것과 같은 주입). Claude Code 는 도는 중에 친
//     글을 **큐에 쌓아** 다음 턴으로 받으므로 도는 동안에도 보낼 수 있다(리브와 다른 점).
//   · 멈춤/승인: POST …/keys {action: interrupt|approve|deny} — 키는 서버 어댑터가 정한다. 못 누르는 하네스(chat.answer=false)엔 버튼을 안 둔다.
//   · 끝난 세션(중단됨·종료됨·기록만): 입력칸 대신 [이어서 대화하기] — 복원(restore)/이어받기(resume)로 새 라이브 세션을 만들어
//     그 화면으로 간다(같은 대화 uuid 를 잇는다).
//
//  ── Claude Code(데스크톱)와 맞추려 한 것 ──
//   턴 = 내 말 + 그 아래 AI 가 한 모든 것 / 도구 호출은 `읽기 src/x.ts` 식 이름+대상 한 줄, 펼치면 입출력 원문 / 생각은 접힌 카드 /
//   돌 때 경과 시간 줄 + Esc 로 멈춤 / 답을 읽고 있으면 스크롤을 뺏지 않음 / 확인(승인) 대기는 배너로 / 긴 기록은 꼬리부터,
//   위로 [이전 대화 불러오기] / 질문 목차 / 코드 복사 / 터미널은 **버리지 않고** 토글(승인 대화상자 등 터미널이 맞는 순간이 있다).
//
//  ── 안 하는 것 ──
//   대화 uuid 를 추측하지 않는다(서버 원칙) — 매핑이 없으면 '기록 아직 없음'으로 말하고 터미널을 권한다.
import { api, apiUrl, TOKEN_KEY, anchoredPopover, el, sv, toast } from './core.js';
import { createChatView, type ChatTurn, type ChatView } from './chat-view.js';
import { toolLabel } from './session-tool-labels.js';
import { classifyToolUse, type TrailWidget } from './session-trail.js';
import { effortKo, findHarness, flagChoices, prettyModel, providerLabel, runCatalog, type RunHarness } from './v2/run-picker.js';
import { rememberCreated } from './v2/created-cache.js';   // #1820 — 되살린 세션을 라우트가 곧바로 그릴 수 있게

export interface SessionChatTarget {
  id: string; label: string; live: boolean; alive: boolean; node: string | null; owned: boolean;
  stateKey: string; stateLabel: string; projectId: number | null; projectName: string;
  raw: any;                                   // 라이브 행(harness·agentState·awaiting·restorable·claudeSessionId) 또는 기록 행
  logId?: string | null; logNode?: string | null;   // 중앙 기록 좌표(대화 uuid) — 라이브 행에 접힌 기록
}
export interface SessionChatHandle {
  /** 이 화면(터미널 프레임 포함)이 붙어 있는 **세션 id** — 마운트 시점에 고정된다.
   *  겉(주소·탭 제목)과 속(프레임)이 어긋난 상태에서 목록 갱신이 남의 세션 정보를 상단바에 덧칠하지 않도록,
   *  update 를 부르는 쪽이 이 값으로 대상을 확인한다(v2/main.ts). */
  id: string;
  update(t: SessionChatTarget): void;
  /** 우패널이 스스로 파일 탐색기를 닫았을 때 상단바 [파일] 불을 맞춘다(#1744 — 토글은 하나여야 한다). */
  setFilesOn(on: boolean): void;
  destroy(): void;
}

const WINDOW = 1_500_000;          // 첫 로드·[이전 불러오기] 한 번에 읽는 바이트(긴 세션은 30MB — 꼬리부터)
const POLL_RUN_MS = 700;           // 도는 중(블록 단위로 즉시 쌓인다 — 이 값이 체감 지연)
const POLL_IDLE_MS = 3000;         // 살아 있고 안 도는 중(다음 지시를 터미널에서 칠 수도 있다)
const POLL_LOG_MS = 8000;          // 중앙 기록(턴 단위 — 자주 봐도 안 늘어난다)
const POLL_LOG_LIVE_MS = 3000;     // 중앙 기록인데 살아서 도는 노드 세션(#1744) — 턴 끝나 올라오는 순간을 놓치지 않게 조금 촘촘히
const INJECTED_RE = /^\s*(<command-name|<local-command-|<command-message|<command-args|<bash-|<task-notification|<system-reminder|Caveat:)/;
const INTERRUPT_RE = /^\s*\[Request interrupted/;
const CONTINUED_RE = /^\s*This session is being continued/;

// ── 원문 읽기(ndjson + 워터마크 헤더) ────────────────────────────────────────────────────────
interface RawChunk { status: number; text: string; bytes: number; from: number; to: number; uuid?: string; prev?: string }
async function rawGet(path: string): Promise<RawChunk> {
  const headers: Record<string, string> = {};
  const tok = localStorage.getItem(TOKEN_KEY); if (tok) headers.Authorization = 'Bearer ' + tok;
  const res = await fetch(apiUrl(path), { headers, credentials: 'same-origin' });
  const text = res.ok ? await res.text() : '';
  if (!res.ok) {
    let msg = ''; let j: any = null; try { j = await res.json(); msg = j?.error || ''; } catch { /* */ }
    const e: any = new Error(msg || `요청 실패 (${res.status})`); e.status = res.status;
    if (j && typeof j === 'object') { if (j.uuid) e.uuid = String(j.uuid); if (j.node) e.node = String(j.node); }   // 409 node(#1744) — 서버가 알려 주면 대화 uuid·노드
    throw e;
  }
  const n = (h: string): number => { const v = Number(res.headers.get(h)); return Number.isFinite(v) ? v : 0; };
  return { status: res.status, text, bytes: n('X-Log-Bytes'), from: n('X-Log-From'), to: n('X-Log-To') || (n('X-Log-From') + text.length), uuid: res.headers.get('X-Session-Uuid') || undefined, prev: res.headers.get('X-Prev-Session') || undefined };
}
type Source = { kind: 'box'; id: string } | { kind: 'log'; sid: string; node: string };
const srcPath = (s: Source, q: Record<string, string | number>): string => {
  const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]));
  return s.kind === 'box'
    ? `/api/ui/terminal/sessions/${encodeURIComponent(s.id)}/transcript?${qs}`
    : `/api/ui/v6/sessions/${encodeURIComponent(s.sid)}/log?node=${encodeURIComponent(s.node)}&fmt=chat&${qs}`;   // fmt=chat: 공통 ChatLine(원본 바이트 아님)
};

// ── 마운트 ────────────────────────────────────────────────────────────────────────────────
// opts.firstPrompt — 홈 입력창(#1719 v2/quick-session)이 방금 연 세션의 첫 지시. 서버가 하네스 입력창이 뜬 뒤 실제로 넣으므로
//  여기서는 **낙관적으로 그 턴을 먼저 그리고**(보낸 것과 같은 모양) 대화 파일에 나타나면 그 턴을 재사용한다(pendingSent 규약).
// opts.onPickProject — [⋯ ▸ 프로젝트] 를 눌렀을 때 검색 드롭다운을 여는 콜백(#1749, v2/main.ts 가 준다).
//  붙이기·떼기의 실행·갱신은 그쪽 몫이고, 여기는 바뀐 target 을 update() 로 받는다(메뉴는 열 때마다 다시 그린다).
// opts.onRename — 제목을 눌러 이름을 고쳤을 때 서버에 반영하는 콜백(#1719). 실패는 throw 로 알려 주면 여기서 말한다.
export interface SessionChatOpts {
  /** [⋯ ▸ 이 세션 보관] — 세션 탭 줄을 없애면서(원준 2026-08-20) 보관의 입구가 여기로 옮겨 왔다. 실행은 main.ts 가 쥔다. */
  onArchive?: () => void;
  terminalSrc?: string | null;
  openHref?: string | null;
  firstPrompt?: string | null;
  trail?: TrailWidget | null;
  onPickProject?: (anchor: HTMLElement) => void;
  onRename?: (label: string) => Promise<void>;
  /** 상단바 [파일] — 우패널을 '타임라인 ↔ 파일 탐색기'로 갈아 끼운다(#1744). 켜진 뒤 상태를 돌려준다. */
  onToggleFiles?: () => boolean;
  /** 팝아웃 창(?solo=1)이면 true — [새 창] 대신 [전체 화면으로]를 둔다(#1744). */
  solo?: boolean;
  /**
   * 열자마자 되살린다 (#1820) — 박스가 없어졌지만 좌표가 남아 있고 내가 주인인 세션. 판정은 호출자가
   *  `shouldRestoreOnOpen`(web/session-status.ts)으로 한다. 실패하면 기록 화면 + [이어서 대화하기]로 되돌아간다.
   */
  autoResume?: boolean;
  /** 이 화면이 지금 사람 눈에 보이나(#1834 후속) — **자동** 복원은 보이는 화면에서만 한다.
   *  셸의 탭은 숨어도 DOM 이 살아 있어(v2/tabs.ts 'DOM 유지형') 프레임이 계속 돈다. 숨은 탭이 스스로
   *  세션을 되살리면 사람이 보지도 않은 채 새 세션이 생기고, 아래 onResumed 가 없던 시절엔 지금 보고 있는
   *  탭의 주소까지 그리로 끌려갔다. 사람이 그 탭을 열 때 되살리면 된다(그때 renderSession 이 다시 판정한다).
   *  미지정이면 종전대로(항상 허용) — 팝아웃 창·단독 페이지는 그 화면이 곧 보이는 화면이다. */
  isVisible?: () => boolean;
  /** 복원으로 **새 세션**이 생겼다 — 라우팅은 호출자(탭)가 한다(#1834 후속).
   *  ⚠ 미지정이면 이 화면이 전역 주소를 바꾼다. 셸 안에서는 그게 곧 **활성 탭의 주소**라, 숨은 탭에서 일어난
   *   복원이 지금 보고 있는 탭을 남의 새 세션으로 끌고 갔다. 셸(v2/main.ts)은 이 콜백으로 **그 탭만** 옮긴다. */
  onResumed?: (newId: string) => void;
}
export function mountSessionChat(host: HTMLElement, first: SessionChatTarget, opts: SessionChatOpts): SessionChatHandle {
  let target = first;
  const isBox = first.live;                     // 라이브 행(박스) — 죽었어도(restorable) 박스다
  const dead = (): boolean => !target.live || !target.alive || !!target.raw?.restorable;
  const canType = (): boolean => !dead();
  const caps = (): { read: boolean; answer: boolean } => (target.raw?.chat && typeof target.raw.chat === 'object') ? { read: target.raw.chat.read !== false, answer: target.raw.chat.answer !== false } : { read: true, answer: true };   // 서버 harness-io 능력(행의 chat) — 없으면(구 서버) 둘 다 있는 것으로
  const canKeys = (): boolean => canType() && !target.node && caps().answer;

  // 헤더 — 이 세션의 **한 줄 신원**(지금 하는 일 · 상태 · 프로젝트 · 하네스)과 **이 세션에 하는 모든 일**이 여기 모인다.
  //  #1744 로 터미널 페이지의 상단바(파일 탐색기 · 질문 · 화면 복구 · 환경 설정 · 사용법 · 프로젝트 페이지)를 여기로
  //  합쳤다 — 종전엔 세션 화면 안에 터미널 프레임이 뜨면 상단바가 위아래로 둘이었다. 터미널 쪽 것은 사라지고
  //  그 기능은 [파일]·[목차]와 [⋯] 메뉴(터미널 조작)로 이 한 줄에 들어온다.
  const dot = el('span', { class: 'v2-dot', 'aria-hidden': 'true' });
  const stateEl = el('span', { class: 'sc-state' });
  // 제목 = **pane 이름**(하네스가 써 두는 '지금 하는 일', 목록의 raw.title) — 상민님 2026-08-19.
  //  화면 안에서 알고 싶은 것은 '이 세션이 지금 뭘 하고 있나'다.
  //
  //  ★ 세션 이름은 이 줄에 따로 두지 않는다(#1744, dev 213건 실측). 이름을 정하는 자리 9곳 중 사람이 정하는 건
  //   사실상 새 세션 폼 하나뿐이고 — 홈 입력창은 첫 지시 앞 27자, 프로젝트에서 열면 프로젝트명이 기본값, 복원·위탁·
  //   이어보기는 시스템 문구, 아무것도 안 주면 id 그대로 — 그 결과 **살아있는 세션의 38%·죽은 세션의 83%가
  //   자동 생성 이름**이다(프로젝트명 에코 58%). 그 원본은 화면에 이미 다 있다: 프로젝트명은 옆 칩, 첫 지시는 대화
  //   맨 위, id 는 주소. 반대로 pane 제목은 살아있는 세션의 88%에서 '지금 하는 일'을 말해 준다 —
  //   실제로 세션을 구분해 주는 축은 그쪽이다(사이드바 side.ts sessText 가 같은 결론으로 먼저 걷어냈다).
  //  ⚠ 이름 고치기(#1719)는 살아 있다 — pane 이름이 없으면(셸·방금 뜬 세션) 제목이 곧 세션 이름이라 **그 자리에서**
  //   고치고, pane 이름이 제목을 차지했으면 [⋯ ▸ 세션 이름 바꾸기]가 같은 편집기를 제목 자리에 연다.
  const titleHost = el('span', { class: 'sc-titlebox' });
  let titleText = target.label;
  let renaming = false;
  const canRename = (): boolean => !!opts.onRename && target.owned && target.live && !target.raw?.restorable;
  const paneTitle = (): string => String(target.raw?.title || '').trim();
  // 이름을 안 주고 만든 세션은 이름이 **id 그대로**다(sessions.ts: label = cleanLabel(input.label) || id).
  //  그건 이름이 아니므로 화면에 쓰지 않는다 — 사이드바(side.ts isIdLabel)와 같은 판정.
  const idLabel = (x: string): boolean => /^box-|^[0-9a-f-]{20,}$/i.test(String(x || '').trim());
  const shownName = (): string => (idLabel(titleText) ? '' : titleText) || String(target.raw?.harness || '') || '(이름 없음)';
  const normTxt = (x: string): string => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
  // 사람이 지은 이름만 남긴다 — 프로젝트명 되풀이(dev 실측 58%)·id 꼴은 이름이 아니다(사이드바 side.ts sessText 와 같은 규칙).
  function cleanName(): string {
    let n = String(titleText || '').trim();
    const proj = String((target as any).projectName || '').trim();
    if (proj && n.startsWith(proj)) n = n.slice(proj.length).replace(/^[\s·:\-–—_/|]+/, '').trim();
    if (proj && n && normTxt(n) === normTxt(proj)) n = '';
    if (idLabel(n)) n = '';
    return n;
  }
  const penIc = (): SVGElement => sv('svg', { viewBox: '0 0 24 24', class: 'sc-title-pen', 'aria-hidden': 'true' }, sv('path', { d: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z' }));
  const penBtn = (): HTMLElement => el('button', {
    class: 'sc-title-penbtn', type: 'button', 'aria-label': '세션 이름 바꾸기',
    title: '세션 이름 바꾸기 — 지금 제목은 이 세션이 하는 일이에요', onclick: () => startRename(),
  }, penIc());
  function paintTitle(): void {
    if (renaming) return;                    // 고치는 중엔 손대지 않는다(20초 폴링이 입력 중인 칸을 지우면 안 된다)
    const tip = [titleText, target.id].filter(Boolean).join(' · ');
    const name = cleanName();
    const pane = paneTitle();
    const job = pane && normTxt(pane) !== normTxt(name) ? pane : '';
    // ★굵은 자리의 임자 — **사람이 지은 이름이 있으면 그 이름**, 없으면 '지금 하는 일'(pane 제목, #1744).
    //  종전엔 pane 제목이 늘 이겨서, 이름을 고쳐도 이 줄이 그대로였다(원준 2026-08-20 "탭에서 고쳤는데 여기는 반영이 안 된다").
    //  #1744 가 막으려던 건 **자동 생성 이름**이 이 자리를 먹는 것이고, cleanName 이 그것들을 그대로 걷어낸다.
    if (name) {
      titleHost.replaceChildren(
        canRename()
          ? el('button', { class: 'sc-title sc-title-btn', type: 'button', title: '세션 이름 — 눌러서 바꿉니다', onclick: () => startRename() },
            el('span', { class: 'sc-title-t', text: name }), penIc())
          : el('b', { class: 'sc-title', title: tip, text: name }),
        // 하는 일은 이름 옆에 조용히 — 사이드바가 이름(굵게) + 하는 일(부제)로 쓰는 것과 같은 문법이다.
        ...(job ? [el('span', { class: 'sc-title-job', title: '이 세션이 지금 하는 일', text: job })] : []));
      return;
    }
    if (job) {
      const b = el('b', { class: 'sc-title', title: canRename() ? tip + ' — 두 번 누르면 세션 이름을 바꿉니다' : tip, text: job });
      if (!canRename()) { titleHost.replaceChildren(b); return; }
      b.addEventListener('dblclick', () => startRename());
      titleHost.replaceChildren(b, penBtn());
      return;
    }
    const t = shownName();
    titleHost.replaceChildren(canRename()
      ? el('button', { class: 'sc-title sc-title-btn', type: 'button', title: '세션 이름 — 눌러서 바꿉니다', onclick: () => startRename() },
        el('span', { class: 'sc-title-t', text: t }),
        // 연필은 손을 올렸을 때만 나타난다 — 늘 보이면 머리줄의 조작부가 하나 늘고, 아예 없으면 고칠 수 있다는 걸 아무도 모른다.
        penIc())
      : el('b', { class: 'sc-title', title: tip, text: t }));
  }
  function startRename(): void {
    if (renaming || !canRename()) return;
    renaming = true;
    const host2 = titleHost;   // 고치는 자리는 언제나 제목 — pane 이름이 떠 있어도 그 자리에 이름 입력칸이 열린다
    const input = el('input', { class: 'sc-title-in', type: 'text', maxlength: '80', value: idLabel(titleText) ? '' : titleText, placeholder: '세션 이름', 'aria-label': '세션 이름', spellcheck: 'false' }) as HTMLInputElement;
    let closed = false;
    const done = (): void => { renaming = false; paintTitle(); };
    const cancel = (): void => { if (closed) return; closed = true; done(); };
    const save = async (): Promise<void> => {
      if (closed) return;
      const to = input.value.replace(/\s+/g, ' ').trim();
      if (!to || to === titleText) { cancel(); return; }
      closed = true;
      input.disabled = true;
      try {
        await opts.onRename!(to);
        titleText = to;
        toast('세션 이름을 바꿨어요.');
      } catch (e: any) {
        toast('이름을 바꾸지 못했습니다 — ' + (e && e.message ? e.message : e), true);
      }
      done();
    };
    input.onkeydown = (e: KeyboardEvent) => {
      if (e.isComposing) return;             // 한글 조합 중의 Enter 는 확정이지 저장이 아니다
      if (e.key === 'Enter') { e.preventDefault(); void save(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    input.onblur = () => { void save(); };   // 다른 데를 누르면 그대로 저장(취소는 Esc)
    host2.replaceChildren(input);
    input.focus();
    input.select();
  }
  paintTitle();
  // 겉에 둘 것 = **터미널을 보다가 손이 자주 가는 것**(화면 복구·환경 설정). 보기 전환·목차처럼 가끔 쓰는 것은 [⋯] 안으로
  //  내린다(상민님 2026-08-19). 종전엔 반대였다 — 화면이 깨졌을 때 복구가 메뉴 두 단계 뒤에 있었다.
  const chatBadge = el('span', { class: 'sc-beta', text: '베타', hidden: true, title: '대화 인터페이스는 베타예요 — 표시가 어긋나면 터미널로 보세요' });
  const fixBtn = el('button', { class: 'btn-text sc-act', type: 'button', text: '화면 복구', title: '화면이 깨지거나 어긋났을 때 재연결로 복구합니다', onclick: () => termAct('reconnect') }) as HTMLButtonElement;
  const setBtn = el('button', { class: 'btn-text sc-act', type: 'button', text: '환경 설정', title: '터미널 글꼴·크기·테마·커서·스크롤 속도', onclick: () => termAct('settings') }) as HTMLButtonElement;
  // 상단바 통합(#1744) — 터미널 페이지가 갖고 있던 것들이 이 줄로 온다: [파일](우패널 탐색기) · 연결 상태 · [⋯](터미널 조작).
  const filesBtn = el('button', { class: 'btn-text sc-act', type: 'button', text: '파일', title: '이 세션의 작업 폴더를 오른쪽 패널에서 봅니다(업로드·다운로드)', onclick: () => {
    const on = opts.onToggleFiles ? opts.onToggleFiles() : false;
    filesBtn.classList.toggle('sc-act-on', on);
  } }) as HTMLButtonElement;
  const termStatusEl = el('span', { class: 'sc-termstat', hidden: true });
  // 런타임 신원 — 하네스 · 모델 · 추론강도 · 노드를 **한 덩어리**로 묶은 알약(#1719, 원준님 2026-08-21).
  //  종전엔 이 넷이 각각 다른 옷을 입고(하네스·모델은 mono, 상태·노드는 sans) 가운뎃점으로만 이어져
  //  '애매하게 다른' 줄이었다. 구분은 글꼴이 아니라 **묶음**으로 한다 — 머리줄에 남는 축은 이제 둘뿐이다:
  //  자주 바뀌는 **상태**(점+라벨)와, 잘 안 바뀌는 **무엇으로 도는가**(이 알약).
  //  ⚠ 여기 것은 **읽기 전용**이다. 바꾸는 자리는 입력창 아래 드롭다운 하나로 둔다 — 같은 조작을 두 자리에 두면
  //   어느 쪽이 진짜인지 묻게 된다(막다른 컨트롤 금지의 뒷면).
  const runEl = el('span', { class: 'sc-run', hidden: true });
  const moreBtn = el('button', { class: 'btn-text sc-act', type: 'button', text: '⋯', title: '이 세션에 할 수 있는 것들', 'aria-label': '더 보기', onclick: () => openMore() }) as HTMLButtonElement;
  // ★ 프로젝트 이름은 이 줄에 두지 않는다(원준님 2026-08-20) — 세션 이름을 걷어낸 것과 **같은 이유**다.
  //  그 이름은 화면에 이미 있다: 왼쪽 사이드바의 고정된 프로젝트 줄과 우패널 머리의 사실 줄(v2-sfacts). 머리줄에
  //  한 번 더 적으면 같은 말이 세 자리를 차지하고, 길면(실측: 40자 넘는 프로젝트명) 조작부까지 밀어냈다.
  //  붙이기·바꾸기·떼기(#1749)는 사라지지 않고 [⋯ ▸ 이 세션] 으로 내려간다 — 세션 이름 바꾸기와 같은 자리다.
  paintTitle();
  const head = el('div', { class: 'sc-head' },
    el('div', { class: 'sc-head-l' },
      dot, titleHost, chatBadge,
      el('span', { class: 'sc-meta' }, stateEl, runEl)),
    el('div', { class: 'sc-head-r' },
      termStatusEl,
      opts.onToggleFiles ? filesBtn : null,
      opts.terminalSrc && isBox ? [fixBtn, setBtn] : null,
      moreBtn));

  const chatHost = el('div', { class: 'sc-chat' });
  const termHost = el('div', { class: 'sc-term', hidden: true });
  const waitBar = el('div', { class: 'sc-wait', hidden: true });
  const wrap = el('div', { class: 'sc-wrap' }, head, waitBar, chatHost) as HTMLElement;
  wrap.append(termHost);
  host.replaceChildren(wrap);

  // 입력칸 아래 바(Claude Desktop 의 '자동 · Opus 5 · 엑스트라' 자리) — 이 세션이 실제로 도는 모드·제공자·모델·추론강도.
  //  트랜스크립트 줄에서 읽어 채운다(user.permissionMode · assistant.message.model · assistant.effort).
  //   · 모드·제공자는 **사실 표시**다. 모드는 터미널에서만 바뀌고, 제공자(어느 회사 모델)는 프로세스가 이미 그 CLI 로
  //     떠 있어 못 바꾼다 — 다른 제공자로 가려면 새 세션을 연다(홈 입력창의 세 칸, #1758).
  //   · 모델·추론강도는 **여기서 바꾼다**(#1758). 단 그 하네스에 인자를 받는 슬래시 명령이 있을 때만 드롭다운이 되고
  //     (서버 catalog.ts runtimeCmd → 카탈로그 runtime), 없으면 종전 그대로 읽기 전용 칩이다 — 눌러도 되는 척하는
  //     컨트롤은 두지 않는다(막다른 컨트롤 금지).
  const chipMode = el('span', { class: 'dt-chip', hidden: true });
  const chipProv = el('span', { class: 'dt-chip', hidden: true });
  const chipModel = el('span', { class: 'dt-chip', hidden: true });
  const chipEffort = el('span', { class: 'dt-chip', hidden: true });
  const selModel = el('select', { class: 'dt-chip dt-chip-sel', hidden: true, 'aria-label': '모델' }) as HTMLSelectElement;
  const selEffort = el('select', { class: 'dt-chip dt-chip-sel', hidden: true, 'aria-label': '추론강도' }) as HTMLSelectElement;
  const chip = (n: HTMLElement, v: string, tip?: string): void => { n.textContent = v; if (tip && tip !== v) n.title = tip; else n.removeAttribute('title'); n.hidden = !v; };
  const MODE_KO: Record<string, string> = { default: '기본', auto: '자동', acceptEdits: '수정 자동승인', bypassPermissions: '전부 자동', plan: '계획', dontAsk: '묻지 않음' };
  // 세션 도중 `/model` 로 모델을 바꾸면 그 사실이 사용자 줄에 남는다("Set model to <b>Opus 5 (1M context)</b> and saved …", ANSI 굵기 포함).
  //  `assistant.message.model` 만 보면 **'마지막 응답에 쓰인 모델'** 이라, 바꾼 뒤 아직 답이 없는 세션은 옛 모델을 가리킨다
  //  (실측 2026-08-18: 한 대화 파일에 claude-fable-5 206줄 + claude-opus-5 233줄 — 터미널은 Opus 인데 칩은 Fable).
  //  줄 순서대로 덮으므로 둘 중 **나중에 나온 사실**이 이긴다. 아래 드롭다운(#1758)의 '지금'도 같은 사실을 따른다 —
  //  내가 방금 고른 값이 여기로 되돌아오는 것이 그 변경이 실제로 먹혔다는 유일한 증거다.
  const SET_MODEL_RE = /Set model to\s+(.+?)(?:\s+and saved\b|$)/i;
  const setModel = (full: string): void => setObserved('model', full.replace(/\s*\([^)]*\)\s*$/, '').trim() || full, full);
  // ⚠ 하네스가 **스스로 만들어 끼운 줄**은 모델이 아니다. Claude Code 는 그런 줄의 model 에 `<synthetic>` 을 적는다 —
  //  실측(2026-08-21, 최근 대화 80개): `<synthetic>` 45줄, 본문은 전부 "You've hit your session limit · resets …"
  //  같은 **자기 안내문**이었다. 그대로 받으면 안내 한 줄이 진짜 모델을 덮어써 머리줄에 '<synthetic>' 이 뜬다
  //  (원준님 신고). 꺾쇠로 감싼 값은 제공자의 모델 id 가 아니라 하네스의 표식이므로 통째로 무시한다 —
  //  이렇게 하면 모르는 제공자(grok·gemini…)의 진짜 id 는 그대로 통과한다(허용목록으로 좁히지 않는 이유).
  //  덮어쓰지 않을 뿐 **지우지도 않는다** — 안내가 떴다고 세션이 쓰던 모델이 바뀐 것은 아니다.
  const realModelId = (m: string): boolean => !!m.trim() && !/^<.*>$/.test(m.trim());

  // 처방전(#1719) — '방금 네 번 주고받은 것, 한 번에 끝낼 수 있었어요'가 앉는 자리. 입력칸 바로 위(askHost).
  const rxHost = el('div', { class: 'sc-rx-host' });

  // 대화창 ————
  const view: ChatView = createChatView(chatHost, {
    who: { me: '나', ai: 'AI' },
    placeholder: target.node ? '이 세션에 보내기(그 컴퓨터로 전달)' : '이 세션에 보내기',
    toolLabel,
    thinking: 'fold',
    sendWhileBusy: true,
    style: 'desktop',
    bar: { right: el('span', { class: 'dt-chips' }, chipMode, chipProv, chipModel, selModel, chipEffort, selEffort) },
    askHost: rxHost,                              // 처방전(#1719) — 스크롤에 떠내려가지 않는 입력칸 바로 위
    onSend: (text) => sendPrompt(text),
    onStop: canKeys() ? () => sendKey('interrupt') : undefined,
    escActive: () => true,
    opening: null,
  });

  // 모델·추론강도 바꾸기(#1758) ————
  //  세션은 이미 argv 로 떠 있어 플래그로는 못 바꾼다 — 서버가 사람이 터미널에서 치는 것과 **같은 슬래시 명령**을
  //  주입한다(POST …/runtime). 어떤 하네스가 그걸 받는지는 서버 카탈로그가 정한다(runtime.model / runtime.effort).
  let hcat: RunHarness | null = null;          // 이 세션의 하네스 카탈로그 행(제공자 이름 · 선택지 · 바꿀 수 있나)
  let obsModel = ''; let obsModelTip = ''; let obsEffort = '';   // 대화 파일이 말한 **실제** 값 — 드롭다운의 '지금'은 이걸 따른다
  let switching = false;
  //  obj = 목적격 조사까지 붙인 형태('모델을'·'추론강도를') — 받침 유무로 갈리는데 축이 둘뿐이라 표에 그대로 적는다.
  const AXIS = {
    model: { flag: '--model', ko: '모델', obj: '모델을' },
    effort: { flag: '--effort', ko: '추론강도', obj: '추론강도를' },
  } as const;
  type Axis = keyof typeof AXIS;
  const canSwitch = (a: Axis): boolean =>
    !!hcat && canType() && !!hcat.runtime?.[a] && flagChoices(hcat, AXIS[a].flag).length > 0;

  //  optLabel = 드롭다운 선택지 문구(모델은 **값 그대로** — 홈 입력창과 같은 말이어야 하고, antigravity 처럼
  //   'claude-…'/'gemini-…' 로 제공자가 갈리는 목록은 접두어를 지우면 무엇인지 알 수 없다).
  //  showLabel = 관측값('지금 · …') 문구 — 하네스가 뱉는 긴 id 라 읽기 좋게 다듬는다.
  function paintAxis(a: Axis, box: HTMLSelectElement, span: HTMLElement, observed: string,
                     optLabel: (v: string) => string, showLabel: (v: string) => string): void {
    const shown = observed ? showLabel(observed) : '';
    if (!canSwitch(a)) { box.hidden = true; chip(span, shown, a === 'model' ? obsModelTip : undefined); return; }
    span.hidden = true;
    const choices = flagChoices(hcat, AXIS[a].flag);
    // 관측값이 선택지 중 하나를 품고 있으면 그 칸을 고른 것으로 본다. 영숫자만 남겨 비교한다 — 관측값은
    //  'claude-opus-4-5-…' 로도 오고 화면용으로 다듬은 'Grok 4.6' 으로도 와서, 하이픈·공백을 그대로 두면 서로 안 닿는다.
    const nz = (x: string): string => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hit = choices.find((c) => observed && nz(observed).includes(nz(c))) || '';
    const keep = box.value;   // 방금 고른 값이 아직 기록에 안 나타났을 수 있다 — 관측이 따라오면 그게 이긴다
    box.replaceChildren(
      el('option', { value: '' }, hit || !shown ? `${AXIS[a].ko} · 지난번 그대로` : `지금 · ${shown}`),
      ...choices.map((c) => el('option', { value: c }, optLabel(c))));
    box.value = hit || (choices.includes(keep) ? keep : '');
    box.hidden = false;
  }
  function paintRun(): void {
    chip(chipProv, hcat ? providerLabel(hcat) : '');
    if (hcat) chipProv.title = `이 세션은 ${providerLabel(hcat)} 의 ${hcat.label} 로 떠 있어요 — 제공자는 새 세션에서만 고를 수 있어요.`;
    paintAxis('model', selModel, chipModel, obsModel, (v) => v, prettyModel);
    paintAxis('effort', selEffort, chipEffort, obsEffort, effortKo, effortKo);
    paintRunHead();
  }
  //  알약 내용 — 왼쪽부터 '무엇이(하네스) · 어떤 모델로 · 어느 강도로 · 어디서(노드)'.
  //   · 모델·추론강도는 **관측된 값만** 적는다. 아직 한 턴도 안 돌아 모르는 세션은 그 칸을 비운다 —
  //     빈 자리가 틀린 값보다 낫다(카탈로그 기본값을 적으면 실제로 도는 것과 어긋난다).
  //   · 그 둘은 **터미널을 보고 있을 때만** 넣는다(대화 모드는 입력창 아래 바가 같은 사실을 이미 말한다).
  //     하네스·노드는 그 바가 말하지 않으므로 두 모드에서 늘 남는다 — 알약이 통째로 사라지지 않는 이유다.
  function paintRunHead(): void {
    const onTerm = !termHost.hidden;
    //  cls: 노드 이름만 줄어드는 칸이다 — 나머지 셋은 짧고 폭이 고정이라 잘리면 '무엇으로 도는지'를 못 읽는다.
    const vals: Array<{ v: string; cls?: string }> = [
      { v: String(target.raw?.harness || '') },
      { v: onTerm && obsModel ? prettyModel(obsModel) : '' },
      { v: onTerm && obsEffort ? effortKo(obsEffort) : '' },
      { v: target.node ? String(target.node) : '', cls: 'sc-run-node' },
    ].filter((x) => !!x.v);
    runEl.replaceChildren(...vals.flatMap((x, i) => {
      const cell = el('span', x.cls ? { class: x.cls, text: x.v, title: x.v } : { text: x.v });
      return i ? [el('span', { class: 'sc-sep', text: '·' }), cell] : [cell];
    }));
    runEl.title = onTerm && (obsModel || obsEffort)
      ? '이 세션이 무엇으로 돌고 있는지예요 — 모델·추론강도를 바꾸려면 [대화]에서 입력창 아래 칸으로 고르거나, 터미널에서 /model · /effort 를 치세요.'
      : '이 세션이 무엇으로 돌고 있는지예요.';
    runEl.hidden = !vals.length;
  }
  //  tip = 칩에 걸 원문(줄인 모델 이름의 전체). 드롭다운이 서는 세션에선 칩이 숨으므로 안 쓰인다.
  function setObserved(a: Axis, v: string, tip?: string): void {
    if (a === 'model') { if (obsModel === v && obsModelTip === (tip || '')) return; obsModel = v; obsModelTip = tip || ''; }
    else { if (obsEffort === v) return; obsEffort = v; }
    paintRun();
  }
  async function switchAxis(a: Axis, box: HTMLSelectElement): Promise<void> {
    const v = box.value;
    if (!v) { paintRun(); return; }                       // '지난번 그대로'(빈 값)는 되돌릴 명령이 없다 — 표시만 원복
    // 앞 변경이 아직 도는 중(확인·재시도까지 몇 초 걸린다) — 조용히 되돌리지 않고 왜 안 먹었는지 말한다.
    if (switching) { paintRun(); view.setNote('앞의 변경을 보내는 중이에요 — 끝나면 다시 골라 주세요.'); return; }
    switching = true; box.disabled = true;
    try {
      const r = await api(`/api/ui/terminal/sessions/${encodeURIComponent(target.id)}/runtime`, { method: 'POST', body: JSON.stringify({ [a]: v }) }) as { pending?: boolean };
      // 값은 「」로 감싼다 — 'sonnet'처럼 한글이 아닌 값에 조사를 직접 붙이면 읽는 소리에 따라 '로/으로'가 갈려
      //  어느 쪽을 써도 어색해진다. 「」 뒤의 '으로'는 그 문제를 안 만든다(session-form 의 「지난번 그대로」와 같은 표기).
      //  pending = 아직 큐에 있다(세션이 로그인·대화상자에 멈춰 있는 경우) — '바꿨다'고 말하지 않는다.
      const said = a === 'model' ? v : effortKo(v);
      const msg = r?.pending
        ? `${AXIS[a].obj} 「${said}」으로 바꾸라고 걸어 뒀어요 — AI 입력창이 뜨면 들어갑니다.`
        : `${AXIS[a].obj} 「${said}」으로 바꿨어요.`;
      view.setNote(msg);
      // 내가 띄운 안내만 지운다 — 그 사이에 다른 안내가 올라왔으면 그걸 지우면 안 된다(먼저 건 타이머가 나중 걸 지웠다).
      window.setTimeout(() => { if (!destroyed && view.noteEl.textContent === msg) view.setNote(''); }, 3000);
    } catch (e: any) {
      view.setNote(e?.message || `${AXIS[a].obj} 바꾸지 못했어요.`);
      paintRun();                                          // 실패했으면 고른 티를 남기지 않는다
    } finally { switching = false; box.disabled = false; }
  }
  selModel.addEventListener('change', () => { void switchAxis('model', selModel); });
  selEffort.addEventListener('change', () => { void switchAxis('effort', selEffort); });
  void runCatalog().then((hs) => { hcat = findHarness(hs, String(target.raw?.harness || '')); paintRun(); });

  // 상태 표시(헤더 점·라벨·확인 대기 배너·끝난 세션 바) ————
  const dotCls = (k: string): string => k === 'busy' ? 'busy' : k === 'waiting' ? 'wait' : (k === 'done' || k === 'idle') ? 'done' : '';
  let running = false;                        // 대화 파일 기준 '지금 턴이 도는 중'
  const paintState = (): void => {
    const k = running && !dead() ? 'busy' : target.stateKey;
    dot.className = 'v2-dot ' + dotCls(k);
    stateEl.textContent = running && !dead() ? '작업 중' : target.stateLabel;
    // ⚠ '대화가 지금 흐르고 있으면' 확인 배너를 내린다 — 훅의 waiting 보고는 사람이 터미널에서 답한 뒤 **다음 훅 보고**
    //  (PostToolUse — 긴 도구면 그 도구가 끝날 때)까지 남는다(실측 2026-08-18: 답했는데 배너가 계속 떠 있음 신고).
    //  트랜스크립트에 새 줄이 흐른다는 건 대화상자가 이미 닫혔다는 뜻이다 — 목록 폴링보다 빠르고 확실한 신호.
    const waiting = !dead() && !running && (!!target.raw?.awaiting || target.raw?.agentState === 'waiting');
    waitBar.hidden = !waiting;
    if (waiting && !waitBar.childElementCount) {
      waitBar.replaceChildren(
        el('span', { class: 'v2-dot wait', 'aria-hidden': 'true' }),
        el('div', { class: 'sc-wait-t' }, el('b', { text: '확인이 필요해요' }), el('span', { text: ' — 세션이 승인이나 선택을 기다리고 있어요. 무엇을 묻는지는 터미널에 떠 있습니다.' })),
        el('div', { class: 'sc-wait-acts' },
          opts.terminalSrc && isBox ? el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '터미널에서 답하기', onclick: () => setMode('term') }) : null,
          canKeys() ? el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: '기본 선택으로 답하기', onclick: () => sendKey('approve') }) : null,
          canKeys() ? el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: '거부', onclick: () => sendKey('deny') }) : null));
    }
    if (dead()) paintDeadFooter();
  };
  let deadFooterOn = false;
  const paintDeadFooter = (): void => {
    if (deadFooterOn) return; deadFooterOn = true;
    const why = target.stateKey === 'exited_user' ? '내가 종료한 세션' : target.stateKey === 'oom_killed' ? '메모리 부족으로 끝난 세션' : target.stateKey === 'restorable' ? '중단된 세션' : '기록만 남은 세션';
    const btn = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '이어서 대화하기' }) as HTMLButtonElement;
    btn.addEventListener('click', () => { void resumeSession(btn); });
    view.setFooter(el('div', { class: 'sc-bar' },
      el('span', { class: 'sc-bar-t', text: `${why}이에요 — 대화는 그대로 이어받을 수 있어요.` }), btn));
    view.busy(false);
    // ★ #1820 — 열면 되살린다. 이 화면에 온 것 자체가 "이 세션을 쓰겠다"는 뜻이라, 버튼을 한 번 더 누르게 하지
    //  않는다. 되살아나면 새 id 로 주소가 옮겨 가고(셸이 라우팅을 쥔다 — 프레임이 몰래 갈아타지 않는다, #1808),
    //  실패하면 이 기록 화면과 버튼이 그대로 남는다(자동이 막다른 길을 만들지 않는다).
    if (opts.autoResume && !resumeAuto && visibleNow()) {
      resumeAuto = true;
      view.setNote('세션을 이어서 여는 중…');
      void resumeSession(btn);
    }
  };

  // 화면 모드 — 기본은 **터미널**(상민님 지시 2026-08-18: 대화창이 미완성이라 공 들이기 전엔 터미널이 정답).
  //  '대화 (베타)' 버튼으로 스왑한다. 스왑이어도 양쪽 다 DOM 에 남는다(터미널 WS·대화 폴링 유지 — 숨겼다 보였다).
  //  터미널이 없는 세션(노드·기록 전용)은 종전대로 대화가 기본이고 버튼도 없다.
  let termFrame: HTMLIFrameElement | null = null;
  let mode: 'term' | 'chat' = 'chat';
  function setMode(m: 'term' | 'chat'): void {
    if (m === 'term' && (!opts.terminalSrc || !isBox)) m = 'chat';
    mode = m;
    if (m === 'term' && !termFrame && opts.terminalSrc) {
      termFrame = el('iframe', { class: 'sc-term-frame', src: opts.terminalSrc, title: '터미널', allow: 'clipboard-read; clipboard-write' }) as HTMLIFrameElement;
      termHost.append(termFrame);
    }
    wrap.classList.toggle('sc-mode-term', m === 'term');
    termHost.hidden = m !== 'term';
    chatHost.hidden = m === 'term';
    chatBadge.hidden = m !== 'chat';
    fixBtn.hidden = m !== 'term'; setBtn.hidden = m !== 'term';        // 터미널 조작은 터미널을 보고 있을 때만 겉에 둔다
    termStatusEl.hidden = m !== 'term' || !termStatusEl.textContent;   // 연결 상태도 마찬가지(#1744)
    paintRunHead();                                                   // 모델·추론강도도 마찬가지 — 터미널을 볼 때만 머리줄에 선다
    if (m === 'chat') { view.scrollToBottom(); view.input.focus(); }
  }

  // ── 터미널 프레임과의 다리(#1744) ────────────────────────────────────────────────────────
  //  상단바를 합쳤으므로 '터미널이 하던 일'을 여기서 눌러 저기서 실행한다. 같은 오리진 프레임이라 postMessage 한 줄이면
  //  된다(프레임 안 코드를 여기로 복제하지 않는다 — 복제하면 두 벌이 갈린다). 프레임은 연결 상태도 되돌려 보내
  //  '연결 중…/연결됨'이 이 한 줄에 뜬다. 오리진·출처(source)를 둘 다 확인한다.
  const TERM_MSG = 'lively-term';
  let termReady = false;                       // 프레임이 첫 신호(상태)를 보냈나 — 그 전에 보낸 명령은 사라진다
  let termQueue: string[] = [];
  let resumeAuto = false;                      // #1820 — 자동 복원을 이미 걸었나(한 화면에서 한 번만)
  /** 지금 이 화면이 보이나 — **자동** 복원의 전제(opts.isVisible 주석). 사람이 버튼을 누른 복원은 이걸 안 본다. */
  const visibleNow = (): boolean => !opts.isVisible || opts.isVisible();
  function termSend(cmd: string): void {
    if (!termFrame || !termFrame.contentWindow) return;
    try { termFrame.contentWindow.postMessage({ type: TERM_MSG, cmd }, location.origin); } catch { /* 프레임이 닫혔다 */ }
  }
  /** 터미널이 있어야 하는 동작 — 닫혀 있으면 먼저 연다(막다른 버튼 금지). 아직 안 뜬 프레임이면 뜰 때까지 담아 둔다. */
  function termAct(cmd: string): void {
    if (!opts.terminalSrc || !isBox) { toast('이 세션에는 터미널이 없어요.'); return; }
    if (mode !== 'term') setMode('term');
    if (termReady) termSend(cmd); else termQueue.push(cmd);
  }
  const onTermMsg = (ev: MessageEvent): void => {
    if (ev.origin !== location.origin || !termFrame || ev.source !== termFrame.contentWindow) return;
    const m: any = ev.data;
    // #1820 — 프레임이 "이 세션 박스가 없다"고 알려 왔다. 되살리기는 **셸이** 한다 — 프레임이 스스로 되살려
    //  자기 주소만 갈아타면 셸 주소·탭 제목·사이드바는 옛 세션 그대로인 어긋난 화면이 된다(#1808 사고).
    //  여기서 부르는 resumeSession 은 [이어서 대화하기]와 같은 경로라 주소(#/s/<새 id>)까지 함께 옮긴다.
    if (m && m.type === 'lively-term-gone' && String(m.id || '') === target.id) {
      if (m.canRestore && !resumeAuto && visibleNow()) { resumeAuto = true; view.setNote('세션을 이어서 여는 중…'); void resumeSession(); }
      return;
    }
    if (!m || m.type !== 'lively-term-status') return;
    if (!termReady) { termReady = true; const q = termQueue; termQueue = []; for (const c of q) termSend(c); }
    termStatusEl.textContent = String(m.text || '');
    termStatusEl.className = 'sc-termstat' + (m.cls ? ' ' + String(m.cls).replace(/[^a-z]/g, '') : '');
    termStatusEl.hidden = termHost.hidden || !termStatusEl.textContent;
  };
  window.addEventListener('message', onTermMsg);

  // ── [⋯] — 겉에 두기엔 가끔 쓰는 것들. 열 때마다 지금 상태로 다시 그린다(보기 전환 라벨이 모드를 따른다). ──
  function openMore(): void {
    const rows: HTMLElement[] = [];
    const row = (label: string, desc: string, onClick: () => void): HTMLElement =>
      el('button', { class: 'sc-more-row', type: 'button', onclick: () => { close(); onClick(); } },
        el('span', { class: 'n', text: label }), el('span', { class: 'm', text: desc }));
    rows.push(el('div', { class: 'sc-more-sec', text: '보기' }));
    if (opts.terminalSrc && isBox) {
      // 상민님 지시(2026-08-18): 대화 인터페이스가 아직 미완성이라 **터미널이 기본**, 대화는 '베타'를 달고 뒤에 둔다.
      rows.push(mode === 'term'
        ? row('대화로 보기 (베타)', '터미널 대신 대화창으로 — 표시가 어긋나면 터미널로 돌아오세요', () => setMode('chat'))
        : row('터미널로 보기', '승인 대화상자·로그인처럼 터미널이 맞는 순간이 있어요', () => setMode('term')));
    }
    rows.push(row('목차', '이 세션에 보낸 질문 목록 — 누르면 그 자리로', () => openIndex()));
    if (opts.terminalSrc && isBox) {
      rows.push(el('div', { class: 'sc-more-sec', text: '터미널' }));
      rows.push(row('사용법 안내', '터미널·단축키 간단 사용법', () => termAct('help')));
    }
    rows.push(el('div', { class: 'sc-more-sec', text: '이 세션' }));
    // 이름은 상단바에 상시로 두지 않는다(위 제목 주석) — 고칠 일이 있을 때만 여기서 연다.
    if (canRename()) rows.push(row('세션 이름 바꾸기', idLabel(titleText) ? '아직 이름이 없어요' : titleText, () => startRename()));
    // 프로젝트도 이름과 같은 이유로 머리줄에서 내려왔다 — 이름은 사이드바·우패널에 이미 있고, 여기는 '바꿀 때' 오는 자리다.
    //  설명줄이 지금 붙은 프로젝트를 말해 주므로 메뉴를 여는 것만으로도 소속을 확인할 수 있다(정보를 잃지 않는다).
    if (opts.onPickProject && target.owned) {
      rows.push(row(target.projectId ? '프로젝트 바꾸기·떼기' : '프로젝트 연결',
        target.projectId ? (target.projectName || '이름 없는 프로젝트') : '이 세션은 아직 프로젝트에 붙어 있지 않아요',
        () => opts.onPickProject!(moreBtn)));
    }
    // 보관 — 터미널만 내려놓고 대화·설정은 남긴다. 살아 있는 내 세션에만(내릴 것이 있어야 보관이다).
    if (opts.onArchive && target.owned && target.live && !target.raw?.restorable)
      rows.push(row('이 세션 보관', '터미널을 내려놓고 대화·설정은 남겨요 — [보관한 세션]에서 되살립니다', () => opts.onArchive!()));
    rows.push(row('링크 복사', '지금 보고 있는 이 화면의 주소', async () => {
      try { await navigator.clipboard.writeText(location.href); toast('링크를 복사했습니다.'); }
      catch { window.prompt('이 링크를 복사하세요:', location.href); }
    }));
    if (opts.openHref) rows.push(el('a', { class: 'sc-more-row', href: opts.openHref, target: '_blank', rel: 'noopener', onclick: () => close() },
      el('span', { class: 'n', text: opts.solo ? '전체 화면으로 열기 ↗' : '새 창으로 열기 ↗' }),
      el('span', { class: 'm', text: opts.solo ? '사이드바까지 있는 라이블리 화면' : '이 세션만 담은 창(대화 + 발자취)' })));
    const panel = el('div', { class: 'dash-pop-panel sc-more' }, ...rows);
    const close = anchoredPopover(moreBtn, panel);
  }

  // ── 대화 파일 → 대화창 ────────────────────────────────────────────────────────────────
  interface Rec { t: ChatTurn; evs: any[] }
  const recs: Rec[] = [];                     // 화면 순서(위→아래)
  let cur: Rec | null = null;
  let src: Source | null = null;
  let loadedFrom = 0; let loadedTo = 0;
  // 노드(멤버 PC) 세션의 중앙 기록 좌표(#1744) — 행이 아는 대화 uuid(logId·claudeSessionId) 또는 서버 409 `node` 응답이 준 uuid(nodeHint).
  //  없으면 null(추측 금지). 노드 세션은 박스 대화 파일이 그 컴퓨터에 있어(409 node) 이 중앙 기록으로만 읽는다 — 박스 경로를 폴링하지 않는다.
  let nodeHint: { uuid: string; node: string } | null = null;
  const logSrc = (): Source | null => {
    const sid = String(target.logId || target.raw?.claudeSessionId || nodeHint?.uuid || '');
    if (!sid) return null;
    return { kind: 'log', sid, node: String(target.logNode ?? nodeHint?.node ?? target.node ?? '') };
  };
  const sameSrc = (a: Source | null, b: Source | null): boolean => !!a && !!b && a.kind === b.kind && (a.kind === 'box' ? a.id === (b as { id: string }).id : a.sid === (b as { sid: string }).sid && a.node === (b as { node: string }).node);
  // 맥락 압축 사슬 — Claude Code 는 압축 때 새 uuid 의 새 파일을 연다(서버 findPrevTranscript 주석). curUuid = 지금 자라는 파일,
  //  oldestUuid/oldestPrev = 화면 맨 위 창이 속한 파일과 그 이전 파일(있으면 [압축 전 대화 불러오기]).
  let curUuid: string | null = null; let oldestUuid: string | null = null; let oldestPrev: string | null = null;
  let carry = '';                             // 잘린 마지막 줄(다음 폴에서 이어 붙인다)
  // 낙관적으로 그린 내 말들 — 서버 아웃박스(#1753)와 짝. 파일에 그 글이 나타나면(에코) 그 턴을 재사용하고 목록에서 뺀다.
  //  obId 로 서버 큐 행과 연결 — 새로고침해도 큐(GET outbox)에서 되살아나 "다 날아감"이 없다. state = 말풍선 밑 상태 줄.
  interface Pending { text: string; t: ChatTurn; obId?: number; state: HTMLElement }
  const pending: Pending[] = [];
  let outboxTimer: number | null = null;
  let firstPrompt: string | null = opts.firstPrompt ? String(opts.firstPrompt) : null;   // 홈 입력창의 첫 지시(한 번만 그린다)
  let pollTimer: number | null = null;
  let destroyed = false;
  let lastLineAt = 0;

  // 낙관 말풍선(원본) ↔ 트랜스크립트 에코(주입본) 매칭 — **정확일치만 믿지 않는다.** 주입은 개행을 공백으로 평탄화하고,
  //  아주 긴 텍스트는 TUI 를 지나며 일부가 뒤섞이기도 한다(실측 2026-08-18: 3천자 프롬프트 꼬리 토막이 자리 이동 →
  //  정확일치 실패 → 같은 말이 두 번 보임 — 상민님 신고). 전 공백 정규화 후 정확일치, 아니면 **접두 64자**로 잇는다.
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const sameSaid = (a: string, b: string): boolean => {
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    return na.length >= 24 && nb.length >= 24 && na.slice(0, 64) === nb.slice(0, 64);
  };
  // 타임라인 장 제목 — 붙여넣은 로그·여러 문단은 **첫 줄(또는 첫 문장)**만. 통째로 이으면 제목이 벽이 된다.
  const firstLine = (t: string): string => {
    const ln = String(t || '').split('\n').map((x) => x.trim()).find((x) => x.length > 1) || '';
    const dot = ln.search(/[.?!。]\s/);
    return (dot > 8 ? ln.slice(0, dot + 1) : ln).trim();
  };
  const cut = (t: string, n: number): string => (t.length > n ? t.slice(0, n - 1).replace(/[\s·,]+$/, '') + '…' : t);
  // 마크다운 부호는 화면 말이 아니다 — 답 한 줄은 '## 결론' 이 아니라 '결론' 이어야 한다.
  const plain = (t: string): string => t.replace(/^\s*(?:[#>]+|[*\-•]\s)\s*/, '').replace(/\*\*|`|~~/g, '').trim();

  // ── 붙여넣은 덩어리 가리기(#1819 원준 2026-08-21) ────────────────────────────
  //  "질문에 내가 복붙한 헤비한 텍스트가 있으면 그건 너무 길게 보이지 않게 적당히 가려서."
  //  로그·문서를 통째로 붙여넣은 지시가 제목이 되면 그 한 장이 타임라인을 다 먹는다. 그래서 **사람이 친 한 줄**만
  //  제목으로 세우고, 나머지는 '붙여넣은 글 N줄' 칩으로 접는다(전문은 항목을 눌러서).
  //  어느 줄이 사람 말인가 — 첫 줄이 짧으면 그것(지시가 앞), 첫 줄부터 길면 짧은 끝 줄(로그를 먼저 붙여넣은 꼴).
  const PASTE_LINES = 8;      // 이 줄 수를 넘으면 '붙여넣었다'로 본다
  const PASTE_CHARS = 400;
  const HUMAN_LINE = 120;     // 사람이 한 줄로 치는 말의 현실적 최대
  function sayParts(raw: string): { label: string; pasteLines?: number; full?: string } {
    const text = String(raw || '');
    const lines = text.split('\n').map((x) => x.trim()).filter((x) => x.length > 0);
    const heavy = lines.length > PASTE_LINES || text.length > PASTE_CHARS;
    const head = lines[0] || '';
    const tail = lines[lines.length - 1] || '';
    const pick = !heavy ? text : (head.length <= HUMAN_LINE ? head : tail.length <= HUMAN_LINE ? tail : head);
    const label = cut(firstLine(pick), 110);
    const rest = lines.length - 1;
    return {
      label: label || '(빈 지시)',
      pasteLines: heavy && rest > 0 ? rest : undefined,
      // 전문은 눌러서 본다. 무한정 들고 있지 않는다 — 여긴 읽는 자리지 원문 보관소가 아니다(원문은 가운데 대화창).
      full: text.trim().length > label.length ? text.slice(0, 4000) : undefined,
    };
  }
  function userText(o: any): { text: string; results: any[] } {
    const c = o?.message?.content;
    if (typeof c === 'string') return { text: c, results: [] };
    if (!Array.isArray(c)) return { text: '', results: [] };
    return { text: c.filter((b: any) => b && b.type === 'text').map((b: any) => String(b.text ?? '')).join('\n'), results: c.filter((b: any) => b && b.type === 'tool_result') };
  }
  const newRec = (text: string | null, ts?: string, at?: 'end' | 'start'): Rec => { const r = { t: view.turn(text, { ts, at }), evs: [] as any[] }; if (at === 'start') recs.unshift(r); else recs.push(r); return r; };

  /** 한 줄을 (끝에) 반영한다. 되그리기·라이브 둘 다 이 함수 하나. */
  function applyLine(o: any): void {
    if (!o || typeof o !== 'object' || o.isSidechain) return;
    if (o.timestamp) { const ms = new Date(o.timestamp).getTime(); if (Number.isFinite(ms)) lastLineAt = ms; }
    if (o.type === 'user') {
      if (o.permissionMode) chip(chipMode, MODE_KO[String(o.permissionMode)] || String(o.permissionMode));
      const { text, results } = userText(o);
      const sm = SET_MODEL_RE.exec(text.replace(/\u001b\[[0-9;]*m/g, ''));   // ANSI 굵기를 걷어내고 본다
      if (sm && sm[1]) setModel(sm[1].trim());
      if (results.length) { if (!cur) cur = newRec(null); cur.evs.push(o); view.event(cur.t, { type: 'user', message: { content: results } }); trailResults(results); }
      if (o.isMeta || !text.trim()) return;
      if (INTERRUPT_RE.test(text)) { if (cur) view.settle(cur.t, { interrupted: true }); running = false; return; }
      if (CONTINUED_RE.test(text)) { view.divider('맥락 압축 — 이전 대화를 요약해 이어감', text); cur = newRec(null); running = true; return; }
      if (INJECTED_RE.test(text)) return;                       // 슬래시 명령·리마인더 — 사람 말이 아니다
      // 내가 보낸(또는 큐에 있던) 말이 파일에 나타났다 → 낙관적으로 그린 그 턴을 그대로 쓴다(두 번 그리지 않는다)
      const pi = pending.findIndex((pd) => sameSaid(pd.text, text));
      if (pi >= 0) {
        const pd = pending[pi]; pending.splice(pi, 1);
        pd.state.remove();                                       // '전달 대기' 줄은 물러난다 — 기록에 적힌 것이 곧 전달이다
        view.setNote('');                                        // '여는 중·아직 안 나타남' 안내도 그 순간 물러난다
        const rec = recs.find((r) => r.t === pd.t);
        if (rec) { cur = rec; rec.t.ts = o.timestamp; running = true; return; }
      }
      cur = newRec(text, o.timestamp); running = true;
      // 타임라인(우패널)의 장(章) 머리 — 이 지시 아래로 그동안의 일이 묶인다(#1719 C안).
      const q = sayParts(text);
      trail?.add({ id: 'turn:' + String(o.uuid || o.timestamp || text.slice(0, 40)), kind: 'say', verb: '지시',
        label: q.label, full: q.full, pasteLines: q.pasteLines,
        key: 'turn|' + String(o.uuid || o.timestamp), ts: o.timestamp }, 'end');
      return;
    }
    if (o.type === 'assistant') {
      if (o.message?.model && realModelId(String(o.message.model))) setModel(prettyModel(String(o.message.model)));
      if (o.effort) setObserved('effort', String(o.effort));
      if (!cur) cur = newRec(null);
      cur.evs.push(o); view.event(cur.t, o); running = true;
      trailMsg(o, 'end');
      return;
    }
    if (o.type === 'system') {
      // 턴의 끝 — turn_duration(소요 시간)·stop_hook_summary(Stop 훅 요약) 둘 다 턴이 끝난 뒤에만 찍힌다(둘 중 하나만 있어도 마감).
      if (o.subtype === 'turn_duration' || o.subtype === 'stop_hook_summary') { if (cur) view.settle(cur.t, { durationMs: Number(o.durationMs) || 0 }); running = false; }
      // 공통 ChatLine(#1746) — 중단(사용자가 끊음)·맥락 압축(어댑터가 system 줄로 올린다. claude 는 위의 사용자 줄 표식으로도 온다).
      else if (o.subtype === 'interrupted') { if (cur) view.settle(cur.t, { interrupted: true }); running = false; }
      else if (o.subtype === 'compact') { view.divider('맥락 압축 — 이전 대화를 요약해 이어감', typeof o.text === 'string' ? o.text : undefined); cur = newRec(null); running = true; }
      return;
    }
  }
  // 발자취(우패널) — 이 세션이 읽고 쓴 것. tool_use → 항목, tool_result → 그 항목의 본문. 대화창과 같은 줄에서 함께 뽑는다.
  const trail = opts.trail || null;
  const trailOut = (b: any): string => typeof b.content === 'string' ? b.content
    : Array.isArray(b.content) ? b.content.map((c: any) => (c && c.type === 'text' ? String(c.text ?? '') : '')).join('\n') : '';
  /** AI 한 줄(assistant) → 타임라인. 도구 사용은 그 장에 **남은 것**으로, 텍스트는 그 장의 **답**으로 간다(#1819).
   *  ⚠ at='start'(되그리기)는 앞으로 밀어 넣으므로 블록을 거꾸로 넣어야 원래 순서가 산다. */
  function trailMsg(o: any, at: 'end' | 'start'): void {
    const w = trail;
    if (!w) return;
    const c = o?.message?.content;
    const blocks: any[] = Array.isArray(c) ? c : (typeof c === 'string' && c.trim() ? [{ type: 'text', text: c }] : []);
    const emit = (b: any, i: number): void => {
      if (b && b.type === 'tool_use' && b.id) {
        const cls = classifyToolUse(String(b.name ?? ''), b.input);
        if (cls) w.add({ ...cls, id: String(b.id), ts: o.timestamp }, at);
        return;
      }
      if (!b || b.type !== 'text') return;
      const t = plain(String(b.text ?? '')).trim();
      if (!t) return;
      // 한 장에 답은 여러 번 온다("확인하겠습니다" → 도구 → … → 최종 답). 렌더러가 **마지막 것**만 세우므로
      //  열쇠를 고유하게 둔다 — 합치면 첫 마디가 굳어 최종 답이 영영 안 보인다.
      const id = 'ans:' + String(o.uuid || o.timestamp || '') + '#' + i;
      w.add({ id, kind: 'reply', verb: '답함', label: cut(firstLine(t), 96), key: id, ts: o.timestamp }, at);
    };
    if (at === 'start') for (let i = blocks.length - 1; i >= 0; i--) emit(blocks[i], i);
    else blocks.forEach(emit);
  }
  function trailResults(results: any[]): void {
    if (!trail) return;
    for (const b of results) if (b?.tool_use_id) trail.result(String(b.tool_use_id), trailOut(b), !!b.is_error);
  }

  // ── 아웃박스(#1753) — 전달 대기·실패의 화면 짝 ─────────────────────────────────────────
  /** 낙관 턴 + 말풍선 밑 상태 줄 한 벌. 서버 큐 행(obId)과 연결되면 새로고침에도 큐에서 되살아난다. */
  function addPending(text: string, obId?: number): Pending {
    const rec = newRec(text, new Date().toISOString());
    const state = el('div', { class: 'dt-qstate' });
    rec.t.ask?.append(state);
    const pd: Pending = { text, t: rec.t, obId, state };
    pending.push(pd);
    cur = rec; running = true;
    view.running(rec.t); view.busy(true);
    watchOutbox();
    return pd;
  }
  const QSTATE_TEXT: Record<string, string> = {
    queued: '전달 대기 중 — AI 입력창이 뜨면 들어갑니다',
    sending: '전달하는 중…',
  };
  function paintQState(pd: Pending, row: { status: string; last_error: string | null; created_at: string } | null): void {
    if (!row) { pd.state.textContent = ''; return; }              // 큐에서 사라짐(delivered/sent) — 에코가 곧 마감한다
    if (row.status === 'failed') {
      const why = row.last_error === 'not-ready' ? '입력창이 끝내 안 떴어요(로그인·오류 화면)'
        : row.last_error === 'session-gone' ? '세션이 그새 닫혔어요' : (row.last_error || '알 수 없는 이유');
      const retry = el('button', { class: 'btn-text dt-qact', type: 'button', text: '다시 보내기', onclick: () => { void outboxAct(pd, 'retry'); } });
      const drop = el('button', { class: 'btn-text dt-qact', type: 'button', text: '지우기', onclick: () => { void outboxAct(pd, 'discard'); } });
      pd.state.replaceChildren(el('span', { class: 'dt-qfail', text: `전달 안 됨 — ${why} ` }), retry, drop);
      if (pd.t === cur?.t) { running = false; view.settle(pd.t); view.busy(false); }
      return;
    }
    // 보냈는데 **기록에서 확인되지 않음**(sent·echo-unconfirmed) — 안 들어갔을 수 있다(antigravity 인증 거부 실측:
    //  거부돼 사라졌는데 화면은 '보낸 걸로' 떠 영영 답을 못 받았다). 사실대로 말하고 재시도·지우기를 준다.
    if (row.status === 'sent') {
      const retry = el('button', { class: 'btn-text dt-qact', type: 'button', text: '다시 보내기', onclick: () => { void outboxAct(pd, 'retry'); } });
      const drop = el('button', { class: 'btn-text dt-qact', type: 'button', text: '지우기', onclick: () => { void outboxAct(pd, 'discard'); } });
      pd.state.replaceChildren(el('span', { class: 'dt-qfail', text: '보냈지만 세션 기록에서 확인되지 않았어요 — 안 들어갔을 수 있어요 ' }), retry, drop);
      if (pd.t === cur?.t) { running = false; view.settle(pd.t); view.busy(false); }
      return;
    }
    // 오래 못 들어가고 있다(로그인·대화상자 의심) — 글자만 두지 않는다: 눌러서 그 화면(터미널)을 바로 연다(막다른 안내 금지).
    //  터미널은 이 페이지 아래 분할로 열리므로 '웹 안에서' 로그인까지 끝낼 수 있다.
    const stuck = row.status === 'queued' && row.last_error === 'not-ready' && Date.now() - Date.parse(row.created_at) > 60_000;
    if (stuck) {
      pd.state.replaceChildren(
        el('span', { text: '전달 대기 중 — 입력창이 아직 안 떠요. 로그인이 필요한 상태일 수 있어요. ' }),
        ...(opts.terminalSrc && isBox ? [el('button', { class: 'btn-text dt-qact', type: 'button', text: '터미널 열기', onclick: () => setMode('term') })] : []));
      maybeAutoOpenTerminal();
      return;
    }
    pd.state.textContent = QSTATE_TEXT[row.status] || '';
  }
  // 세션이 멈춰 있고 **보여줄 대화도 없으면** 터미널 분할을 한 번 자동으로 연다 — 로그인 화면은 터미널에만 있는데,
  //  빈 채팅만 두면 사람이 볼 수 있는 게 없다(실측 신고). 대화가 이미 있으면 자동으로 열지 않는다(읽던 화면을 뺏지 않는다).
  let autoTermOpened = false;
  function maybeAutoOpenTerminal(): void {
    if (autoTermOpened || destroyed || !opts.terminalSrc || !isBox) return;
    if (mode === 'term') { autoTermOpened = true; return; }        // 이미 터미널이 떠 있다 — 로그인 화면이 보인다
    if (curUuid || recs.some((r) => r.evs.length)) return;        // 대화가 보이고 있다 — 알림 줄이면 충분
    autoTermOpened = true;
    setMode('term');
    view.setNote('세션이 입력을 못 받고 있어 터미널을 열었어요 — 로그인 등 필요한 단계를 여기서 끝내면 대기 중인 지시가 이어서 들어갑니다.');
  }
  async function outboxAct(pd: Pending, act: 'retry' | 'discard'): Promise<void> {
    if (!pd.obId) return;
    try {
      await api(`/api/ui/terminal/sessions/${encodeURIComponent(target.id)}/outbox/${pd.obId}/${act}`, { method: 'POST', body: '{}' });
      if (act === 'discard') {
        const i = pending.indexOf(pd); if (i >= 0) pending.splice(i, 1);
        pd.t.root.remove(); const ri = recs.findIndex((r) => r.t === pd.t); if (ri >= 0) recs.splice(ri, 1);
      } else { pd.state.textContent = QSTATE_TEXT.queued; view.running(pd.t); }
      void syncOutbox();
    } catch (e: any) { toast(e?.message || '처리하지 못했습니다.'); }
  }
  /** 서버 큐와 화면을 맞춘다 — 몰랐던 행(다른 탭·홈 첫 지시)은 턴으로 올리고, 아는 행은 상태 줄만 갱신. */
  async function syncOutbox(): Promise<void> {
    if (destroyed || !isBox || target.node) return;
    let items: any[] = [];
    try { items = ((await api(`/api/ui/terminal/sessions/${encodeURIComponent(target.id)}/outbox`)) as any).items || []; }
    catch { return; }
    for (const row of items) {
      let pd = pending.find((x) => x.obId === row.id) || pending.find((x) => !x.obId && sameSaid(x.text, String(row.text)));
      if (!pd) pd = addPending(String(row.text), Number(row.id));
      pd.obId = Number(row.id);
      paintQState(pd, row);
    }
    for (const pd of pending) if (pd.obId && !items.some((r) => Number(r.id) === pd.obId)) paintQState(pd, null);
    if (pending.some((x) => x.obId)) watchOutbox(); else stopWatchOutbox();
  }
  function watchOutbox(): void {
    if (outboxTimer || destroyed) return;
    outboxTimer = window.setInterval(() => { if (!document.hidden) void syncOutbox(); }, 3000);
  }
  function stopWatchOutbox(): void { if (outboxTimer) { clearInterval(outboxTimer); outboxTimer = null; } }

  function applyText(text: string): number {
    const chunk = carry + text;
    const lines = chunk.split('\n');
    carry = lines.pop() ?? '';                 // 마지막 조각(개행 없이 끝남)은 다음에
    let n = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      applyLine(o); n++;
    }
    return n;
  }

  /** 첫 로드 — 어디서 읽을지 정하고 꼬리 창을 그린다. (뒤늦게 대화 uuid 를 알게 되면 update() 가 다시 부른다 — 노드 세션 #1744) */
  let opening = false;
  async function open(): Promise<void> {
    if (opening) return; opening = true;
    try { await openInner(); } finally { opening = false; }
  }
  async function openInner(): Promise<void> {
    view.setNote('');
    view.list.querySelector('.sc-empty')?.remove();     // 다시 여는 경우(대화 uuid 를 뒤늦게 앎, #1744) — 지난 '아직 없음' 안내는 물러난다
    const tries: Source[] = [];
    if (isBox) {
      if (!target.node) tries.push({ kind: 'box', id: target.id });   // 노드 세션은 박스 경로를 묻지 않는다(늘 409 node — 파일이 그 컴퓨터에 있다)
      const ls = logSrc(); if (ls) tries.push(ls);
    } else {
      tries.push({ kind: 'log', sid: target.id, node: String(target.node ?? '') });
    }
    let chunk: RawChunk | null = null; const errs: any[] = [];
    for (const s of tries) {
      try { chunk = await rawGet(srcPath(s, { tail: WINDOW })); src = s; break; }
      catch (e: any) {
        errs.push(e); if (![403, 404, 409].includes(Number(e?.status))) break;   // '없음·권한 아직 없음·딴 컴퓨터' 는 다음 후보로
        if (s.kind === 'box' && Number(e?.status) === 409 && e?.message === 'node' && e?.uuid) {   // 서버가 대화 uuid 를 알려 줬다 — 그 중앙 기록을 후보에 잇는다
          nodeHint = { uuid: String(e.uuid), node: String(e.node || target.node || '') };
          const ls = logSrc(); if (ls && !tries.some((t) => sameSrc(t, ls))) tries.push(ls);
        }
      }
    }
    if (destroyed) return;
    if (!chunk) {
      // 기록이 아직 없다(첫 대화 전) 또는 못 읽는다 — 그 자리에 말한다. 라이브면 입력칸은 살아 있다(첫 지시를 여기서 보낼 수 있다).
      //  박스 후보가 404 였으면 그게 사실(파일이 아직 없다)이다 — 그 뒤 중앙 기록 후보의 403(행이 아직 없다)을 앞세우지 않는다.
      const boxErr = errs.find((e) => tries[errs.indexOf(e)]?.kind === 'box');
      const lastErr = boxErr ?? errs[errs.length - 1];
      const notYet = !errs.length || errs.every((e) => [403, 404].includes(Number(e?.status)));
      const unreadable = Number(lastErr?.status) === 409 && lastErr?.message !== 'node' && !!lastErr?.message;   // 409 = 'node'(그 컴퓨터) 또는 못 읽는 하네스(문장, #1746 — 폴링 무의미)
      // 어디를 지켜볼까 — 박스 세션은 박스 파일, 노드 세션은 중앙 기록(대화 uuid 를 알 때만; 모르면 update() 가 가져올 때).
      //  ⚠ 노드 세션에 박스 경로를 걸면 409 node 가 영원히 반복된다(실측 #1744: '진행을 따라가지 못하고…' 가 그 증상).
      const watch = (): Source | null => target.node ? logSrc() : { kind: 'box', id: target.id };
      // 홈 입력창이 방금 연 세션 — 첫 지시는 서버(또는 노드)가 넣는 중이다. '아직 없음' 대신 그 턴을 도는 모양으로 먼저 그린다.
      if (notYet && firstPrompt && canType()) {
        const pd = addPending(firstPrompt); firstPrompt = null;   // 박스면 서버 큐가 obId 를 붙인다(syncOutbox); 노드면 큐 없이 로컬 주입
        if (target.node) pd.state.textContent = '그 컴퓨터로 전달했어요 — 답은 턴이 끝나면 중앙 기록으로 여기 보여요.';
        view.scrollToBottom();
        view.setNote('세션을 여는 중이에요 — AI 가 뜨면 첫 지시가 들어갑니다.');
        paintState();
        src = watch(); if (src) schedule();
        void syncOutbox();
        return;
      }
      // ⚠ 압축(Compacting) 탓을 하지 않는다 — 압축은 새 uuid 파일로 이어지고 폴링이 그 전환을 따라간다(아래 poll()). 여기 닿는
      //  '기록 없음'의 실제 원인은 대부분 ① 방금 연 세션(하네스 부팅 전) ② 로그인·신뢰 대화상자에 멈춤 — 둘 다 **터미널에만 보인다**.
      //  그래서 문구가 터미널을 가리키고, 버튼도 이 경우에 항상 둔다(막다른 안내 금지 — 확인할 길을 같이 준다).
      const nodeMsg = target.node && canType()
        ? (tries.length ? '아직 중앙 기록이 없어요 — 그 컴퓨터의 세션은 턴이 끝날 때마다 기록이 올라와 여기 보여요. 지금 진행은 터미널로 보세요.'
          : '이 세션의 대화 id 를 아직 몰라요 — 첫 턴이 끝나면 중앙 기록으로 여기 보여요. 지금은 터미널로 보세요.')
        : null;
      const msg = nodeMsg ? nodeMsg
        : !tries.length ? '이 세션의 대화 id 를 아직 몰라 여기서 읽을 수 없어요 — 첫 턴이 끝나면 중앙 기록으로 보입니다. 지금은 터미널로 보세요.'
        : notYet ? (canType() ? '아직 대화 기록이 없어요. 세션이 방금 떴다면 곧 여기 보이고, 계속 비어 있으면 로그인·확인 대화상자에 멈춰 있는 것일 수 있어요 — 터미널로 확인해 보세요.' : '이 세션의 대화 기록을 찾지 못했어요.')
        : unreadable ? String(lastErr.message)
        : lastErr?.status === 409 ? '이 세션의 대화 파일은 그 컴퓨터에 있어 여기서 바로 읽지 못해요. 첫 턴이 끝나면 중앙 기록으로 보입니다.'
        : `대화 기록을 불러오지 못했습니다. ${lastErr?.message || ''}`;
      view.list.append(el('div', { class: 'livc-open sc-empty' }, el('p', { text: msg }),
        opts.terminalSrc && isBox ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '터미널로 보기', onclick: () => setMode('term') }) : null));
      paintState();
      // 라이브면 기록이 생기는 순간을 잡는다 — 박스는 파일, 노드는 중앙 기록(uuid 를 알 때만). 못 읽는 하네스면 기다려도 안 온다(폴링 X).
      if (canType() && !unreadable) { src = watch(); if (src) schedule(); }
      void syncOutbox();   // ⚠ 기록이 아직 없어도 큐엔 내 말이 있을 수 있다(다른 탭에서 보냄·막힌 세션) — 대기 말풍선을 되살린다
      return;
    }
    loadedFrom = chunk.from; loadedTo = chunk.to;      // 서버가 줄 경계로 맞춘 창 — 첫 줄 버리기·조각 이어붙이기가 필요 없다(#1746 window.ts)
    curUuid = chunk.uuid || null; oldestUuid = curUuid; oldestPrev = chunk.from === 0 ? (chunk.prev || null) : null;
    applyText(chunk.text);
    olderBar();
    finishReplay();
    view.scrollToBottom();
    paintState();
    void syncOutbox();   // 큐에 남은 내 말(다른 탭·홈 첫 지시·재시작 전) — 새로고침에도 대기 말풍선으로 되살아난다
    schedule();
  }
  function finishReplay(): void {
    // 창 안에서 끝나지 않은 마지막 턴 — 지금 도는 중이면 라이브 표시, 아니면(죽었거나 오래됐으면) 조용히 마감.
    //  ⚠ 중앙 기록(노드 세션, src.kind==='log')은 **턴 종료 표시(turn_duration·stop_hook_summary)가 안 담긴다** — 그건 claude 가
    //   Stop 훅 캡처 뒤에 .jsonl 에 쓰기 때문(#1744 실측: 중앙 로그에 그 줄이 0개). 그래서 '최근에 줄이 왔으니 도는 중'
    //   휴리스틱(staleMs<120s)을 로그 소스엔 쓰지 않는다 — 세션이 idle(하네스가 markActive 로 보고) 이면 그 턴은 끝난 것이다.
    const staleMs = Date.now() - lastLineAt;
    const busy = !!(target.raw?.working || target.raw?.agentState === 'busy');
    const looksLive = running && !dead() && (busy || (src?.kind !== 'log' && staleMs < 120_000));
    if (cur && looksLive) { view.running(cur.t); view.busy(true); }
    else { running = false; recs.forEach((r) => view.settle(r.t)); view.busy(false); }
    titleFromFirstAsk();
    paintRx();
  }
  function titleFromFirstAsk(): void {
    const q = recs.find((r) => r.t.text)?.t.text;
    // 이름이 자동 생성 id 꼴이면 첫 질문을 이름 자리에 대신 쓴다(고치기 전까지의 임시 이름).
    if (q && /^box-|^[0-9a-f-]{20,}$/i.test(titleText)) { titleText = q.length > 60 ? q.slice(0, 60) + '…' : q; }
    paintTitle();
  }

  // ── 처방전(#1719) — "방금 네 번 주고받은 것, 한 번에 끝낼 수 있었어요" ──────────────────────
  //  왜: 사람이 한 번에 말했으면 끝날 일을 나눠 말하느라 네 턴을 쓴다(실측 흔함). 그 사실은 **일이 끝난 뒤에만**
  //   말할 수 있다 — 결과를 아는 상태라야 "이렇게 했으면 됐다"가 훈수가 아니라 제안이 된다.
  //  ⚠ 이 판정은 **화면에서만** 한다. 대화 본문은 이미 이 브라우저에 있고, 서버로 아무것도 보내지 않는다
  //   (제안엔진 C3 — 서버는 세션 대화를 열지 않는다). 나중에 다듬기를 붙일 때도 그 경계는 세션 안이다.
  //  v0 는 문장을 지어내지 않는다: 나눠 말한 것을 **순서대로 합쳐** 보여줄 뿐이고, 나중에 덧붙인 부분만 표시한다.
  //   숫자(횟수·걸린 시간)도 그 대화에서 실제로 센 값이다 — 예상치를 쓰지 않는다.
  const RX_OFF_KEY = 'lively_rx_off';
  const RX_MIN_ASKS = 3;              // 세 번 이상 나눠 말했을 때만. 두 번은 그냥 대화다.
  const RX_GAP_MS = 20 * 60 * 1000;   // 이만큼 벌어지면 다른 일로 본다(한 묶음의 경계)
  const rxDone = new Set<string>();   // 이 묶음은 닫았다(× ) — 새 묶음이면 다시 뜬다
  let rxKey = '';                     // 지금 그려 둔 묶음
  const rxOff = (): boolean => { try { return localStorage.getItem(RX_OFF_KEY) === '1'; } catch { return false; } };
  const askAt = (t: ChatTurn): number => { const v = t.ts ? Date.parse(t.ts) : NaN; return Number.isFinite(v) ? v : t.startedAt; };

  /** 마지막 '한 묶음' = 끝에서부터 20분 이내로 이어진 사람 말들. 그 사이가 벌어지면 거기서 끊는다. */
  function lastAskCluster(): ChatTurn[] {
    const asks = recs.map((r) => r.t).filter((t) => t.text && t.text.trim());
    if (asks.length < RX_MIN_ASKS) return [];
    const out: ChatTurn[] = [asks[asks.length - 1]!];
    for (let i = asks.length - 2; i >= 0; i--) {
      if (askAt(out[0]!) - askAt(asks[i]!) > RX_GAP_MS) break;
      out.unshift(asks[i]!);
    }
    return out;
  }

  function paintRx(): void {
    // 끝난 세션에서도 뜬다 — 되짚기는 오히려 끝난 뒤가 제일 쓸모 있다(입력칸이 없으면 '넣기' 버튼만 빠진다).
    if (rxOff() || running) { if (!running) rxHost.replaceChildren(); return; }
    const cluster = lastAskCluster();
    if (cluster.length < RX_MIN_ASKS) { rxHost.replaceChildren(); rxKey = ''; return; }
    const key = String(askAt(cluster[0]!)) + '·' + cluster.length + '·' + (cluster[cluster.length - 1]!.text || '').slice(0, 24);
    if (key === rxKey) return;                       // 같은 묶음 — 다시 그리지 않는다(깜빡임 방지)
    rxKey = key;
    if (rxDone.has(key)) { rxHost.replaceChildren(); return; }
    rxHost.replaceChildren(rxCard(cluster, key));
  }

  /** 나눠 말한 것을 순서대로 합친 지시문. 첫 마디는 그대로, 뒤에 덧붙인 것은 표시한다(무엇을 놓쳤는지가 보이게). */
  function rxMerged(cluster: ChatTurn[]): { el: HTMLElement; text: string } {
    const parts = cluster.map((t) => (t.text || '').trim()).filter(Boolean);
    const box = el('div', { class: 'sc-rx-prompt' },
      el('span', { class: 'sc-rx-plabel', text: '나눠 말씀하신 것을 한 덩어리로 합치면' }),
      el('div', { class: 'sc-rx-ptext' },
        ...parts.map((p, i) => i === 0
          ? el('span', { text: p })
          : el('span', { class: 'sc-rx-add', text: ' ' + p }))));
    return { el: box, text: parts.join(' ') };
  }

  function rxCard(cluster: ChatTurn[], key: string): HTMLElement {
    const n = cluster.length;
    const mins = Math.max(1, Math.round((askAt(cluster[n - 1]!) - askAt(cluster[0]!)) / 60000));
    const merged = rxMerged(cluster);
    const close = (): void => { rxDone.add(key); rxHost.replaceChildren(); };

    // 4 → 1 — 숫자를 읽지 않아도 보이게. 뒤쪽(합쳐진 것)에는 예상 시간을 쓰지 않는다(우리는 모른다).
    const dots = el('div', { class: 'sc-rx-fold' },
      el('span', { class: 'sc-rx-grp' }, ...Array.from({ length: Math.min(n, 6) }, () => el('i', { class: 'sc-rx-b' }))),
      el('span', { class: 'sc-rx-arrow', 'aria-hidden': 'true', text: '→' }),
      el('span', { class: 'sc-rx-grp' }, el('i', { class: 'sc-rx-b one' })),
      el('span', { class: 'sc-rx-cap' }, el('b', { text: `${n}번 · ${mins}분` }), document.createTextNode(' 이 한 번으로')));

    const put = canType()
      ? el('button', { class: 'btn-text sc-rx-go', type: 'button', text: '이 지시문 입력칸에 넣기',
        onclick: () => { view.input.value = merged.text; view.input.dispatchEvent(new Event('input')); view.input.focus(); close(); } })
      : null;   // 끝난 세션엔 입력칸이 없다 — 눌러도 되는 척하는 버튼은 두지 않는다
    const copy = el('button', { class: 'btn-text sc-rx-alt', type: 'button', text: '복사',
      onclick: async () => { try { await navigator.clipboard.writeText(merged.text); toast('지시문을 복사했어요.'); } catch { window.prompt('이 지시문을 복사하세요:', merged.text); } } });
    const keep = el('button', { class: 'btn-text sc-rx-alt', type: 'button', text: '이 일을 명령으로 저장해 두기',
      onclick: () => toast('아직 준비 중이에요 — 다음 단계에서 이 지시문을 명령으로 굳힐 수 있게 됩니다.') });
    const never = el('button', { class: 'btn-text sc-rx-never', type: 'button', text: '이런 거 안 볼래요',
      onclick: () => { try { localStorage.setItem(RX_OFF_KEY, '1'); } catch { /* 비치명 */ } rxHost.replaceChildren(); toast('앞으로 이 안내를 띄우지 않습니다.'); } });

    return el('div', { class: 'sc-rx' },
      el('div', { class: 'sc-rx-h' },
        el('span', { class: 'sc-rx-av', 'aria-hidden': 'true', text: 'L' }),
        el('span', { class: 'sc-rx-ht', text: '이번 건, 한 번에 끝낼 수 있었어요' }),
        el('button', { class: 'btn-text sc-rx-x', type: 'button', title: '닫기', 'aria-label': '닫기', text: '×', onclick: close })),
      el('div', { class: 'sc-rx-b-wrap' },
        el('p', { class: 'sc-rx-said' },
          document.createTextNode('나눠서 '), el('b', { text: `${n}번` }), document.createTextNode(' 말씀하시느라 '),
          el('b', { text: `${mins}분` }), document.createTextNode('이 걸렸어요. 아래처럼 처음부터 한 번에 주시면 됩니다.')),
        dots,
        merged.el,
        el('div', { class: 'sc-rx-acts' }, ...(put ? [put] : []), copy, keep, never)));
  }

  // 위로 더 — [from-WINDOW, from) 창을 읽어 **턴 단위로 거꾸로** 앞에 끼운다(보고 있던 자리는 그대로).
  let olderEl: HTMLElement | null = null;
  function olderBar(): void {
    olderEl?.remove();
    if (loadedFrom <= 0 && !oldestPrev) { olderEl = null; return; }
    const kb = Math.round(loadedFrom / 1024);
    const label = loadedFrom > 0 ? `이전 대화 불러오기 (${kb >= 1024 ? (kb / 1024).toFixed(1) + 'MB' : kb + 'KB'} 더 있음)` : '압축 전 대화 불러오기';
    const btn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: label }) as HTMLButtonElement;
    btn.addEventListener('click', () => { void loadOlder(btn); });
    const bar = el('div', { class: 'sc-older' }, btn) as HTMLElement;
    olderEl = bar;
    view.list.prepend(bar);
  }
  async function loadOlder(btn: HTMLButtonElement): Promise<void> {
    if (!src || (loadedFrom <= 0 && !oldestPrev)) return;
    btn.disabled = true; btn.textContent = '불러오는 중…';
    // 같은 파일의 앞 창, 또는(파일 머리에 닿았으면) 압축 전 파일의 꼬리 창.
    const intoPrev = loadedFrom <= 0 && !!oldestPrev;
    const q: Record<string, string | number> = intoPrev ? { uuid: oldestPrev as string, tail: WINDOW } : { from: Math.max(0, loadedFrom - WINDOW), to: loadedFrom };
    if (!intoPrev && src.kind === 'box' && oldestUuid && oldestUuid !== curUuid) q.uuid = oldestUuid;
    let chunk: RawChunk;
    try { chunk = await rawGet(srcPath(src, q)); }
    catch (e: any) { btn.disabled = false; btn.textContent = '다시 시도'; toast(e?.message || '이전 대화를 불러오지 못했습니다.'); return; }
    if (destroyed) return;
    const from = chunk.from;                     // 서버가 줄 경계로 맞춘 창(#1746) — 첫 줄 버리기 없음
    if (intoPrev) { oldestUuid = oldestPrev; oldestPrev = null; }
    if (from === 0) oldestPrev = chunk.prev || null;
    const text = chunk.text;
    // 줄 → 턴 묶음(사람 말 기준). 첫 묶음은 사람 말 없는 이어짐일 수 있다.
    type Bundle = { text: string | null; ts?: string; lines: any[]; kind: 'turn' | 'cont' | 'divider'; raw?: string };
    const bundles: Bundle[] = [];
    let b: Bundle | null = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      if (!o || o.isSidechain) continue;
      if (o.type === 'user') {
        const { text: ut, results } = userText(o);
        if (results.length) { if (!b) { b = { text: null, lines: [], kind: 'cont' }; bundles.push(b); } b.lines.push(o); }
        if (o.isMeta || !ut.trim() || INTERRUPT_RE.test(ut) || INJECTED_RE.test(ut)) { if (INTERRUPT_RE.test(ut) && b) b.lines.push(o); continue; }
        if (CONTINUED_RE.test(ut)) { bundles.push({ text: null, lines: [], kind: 'divider', raw: ut }); b = { text: null, lines: [], kind: 'cont' }; bundles.push(b); continue; }
        b = { text: ut, ts: o.timestamp, lines: [], kind: 'turn' }; bundles.push(b);
      } else if (o.type === 'system' && o.subtype === 'compact') {
        bundles.push({ text: null, lines: [], kind: 'divider', raw: typeof o.text === 'string' ? o.text : undefined }); b = { text: null, lines: [], kind: 'cont' }; bundles.push(b);
      } else if (o.type === 'assistant' || (o.type === 'system' && (o.subtype === 'turn_duration' || o.subtype === 'stop_hook_summary' || o.subtype === 'interrupted'))) {
        if (!b) { b = { text: null, lines: [], kind: 'cont' }; bundles.push(b); }
        b.lines.push(o);
      }
    }
    // 발자취 — 이 창의 **지시·답·도구 사용을 한 줄로** 모았다가 위(오래된 쪽)에 거꾸로 끼운다.
    //  ⚠ #1819 — 종전엔 도구 사용을 전부 넣은 뒤 지시를 그 앞에 몰아넣었다. 결과 목록에선 안 보이던 고장이지만
    //   질문·대답 장(章)에서는 치명적이다: 되그린 창의 지시가 죄다 맨 위로 몰려 묶음이 통째로 깨진다.
    const olderOps: Array<() => void> = []; const olderResults: any[] = [];
    for (const bd of bundles) {
      if (bd.text && bd.text.trim()) {
        const head = bd.lines.find((x: any) => x && x.type === 'user') || {};
        const uuid = String(head.uuid || head.timestamp || bd.text.slice(0, 40));
        const ts = String(head.timestamp || '');
        const q = sayParts(String(bd.text));
        olderOps.push(() => trail?.add({ id: 'turn:' + uuid, kind: 'say', verb: '지시',
          label: q.label, full: q.full, pasteLines: q.pasteLines, key: 'turn|' + uuid, ts }, 'start'));
      }
      for (const o of bd.lines) {
        if (o.type === 'assistant') olderOps.push(() => trailMsg(o, 'start'));
        else if (o.type === 'user') { const { results } = userText(o); if (results.length) olderResults.push(...results); }
      }
    }
    // 화면 맨 위가 '이어짐'(사람 말 없음)이었으면 그 내용은 이 창의 마지막 턴에 속한다 — 합친다.
    const firstRec = recs[0];
    let orphan: Rec | null = null;
    if (firstRec && !firstRec.t.ask && bundles.length && bundles[bundles.length - 1].kind !== 'divider') { orphan = firstRec; }
    view.prependKeepingView(() => {
      const savedCur = cur;
      for (let i = bundles.length - 1; i >= 0; i--) {
        const bd = bundles[i];
        if (bd.kind === 'divider') { view.divider('맥락 압축 — 이전 대화를 요약해 이어감', bd.raw, 'start'); continue; }
        const rec = newRec(bd.text, bd.ts, 'start');
        cur = rec;
        for (const o of bd.lines) {
          if (o.type === 'user') { const { text: ut, results } = userText(o); if (results.length) view.event(rec.t, { type: 'user', message: { content: results } }); if (INTERRUPT_RE.test(ut)) view.settle(rec.t, { interrupted: true }); }
          else if (o.type === 'assistant') view.event(rec.t, o);
          else if (o.type === 'system') view.settle(rec.t, o.subtype === 'interrupted' ? { interrupted: true } : { durationMs: Number(o.durationMs) || 0 });
        }
        if (i === bundles.length - 1 && orphan) {
          // 고아 이어짐의 이벤트를 이 턴 뒤에 다시 그리고 고아는 치운다. 고아가 '지금 도는 턴'이었으면 그 표시(깜빡임·경과 줄)도 옮긴다.
          const wasLive = !!orphan.t.live;
          for (const o of orphan.evs) view.event(rec.t, o);
          orphan.t.root.remove(); recs.splice(recs.indexOf(orphan), 1);
          if (savedCur === orphan) cur = rec;
          if (wasLive) { view.running(rec.t); continue; }   // 도는 턴은 마감하지 않는다
        }
        view.settle(rec.t);
      }
      cur = savedCur && recs.includes(savedCur) ? savedCur : cur;
      loadedFrom = chunk.from;                  // 서버가 맞춘 경계(요청한 from 이 줄 중간이면 다음 줄부터)
      olderBar();
    });
    for (let i = olderOps.length - 1; i >= 0; i--) olderOps[i]();
    trailResults(olderResults);   // 오류 표시는 **항목이 다 들어간 뒤** 얹는다(id 로 찾으므로 순서가 뒤집히면 못 찾는다)
    titleFromFirstAsk();
  }

  // 폴링 — 도는 중이면 촘촘히, 아니면 느슨히. 탭이 숨어 있으면 건너뛴다.
  function schedule(): void {
    if (destroyed || !src) return;
    if (pollTimer) clearTimeout(pollTimer);
    const ms = src.kind === 'log' ? (running && !dead() ? POLL_LOG_LIVE_MS : POLL_LOG_MS) : running ? POLL_RUN_MS : POLL_IDLE_MS;
    if (dead() && src.kind === 'log' && !running) return;   // 죽은 세션의 중앙 기록은 더 안 는다
    pollTimer = window.setTimeout(() => { void poll(); }, ms);
  }
  let fails = 0;
  async function poll(): Promise<void> {
    if (destroyed || !src) return;
    if (document.hidden) { schedule(); return; }
    try {
      let c = await rawGet(srcPath(src, { from: loadedTo }));
      fails = 0;
      if (destroyed) return;
      if (src.kind === 'box' && c.uuid && curUuid && c.uuid !== curUuid) {
        // 맥락 압축 — 박스가 새 uuid 의 새 파일로 넘어갔다. 화면을 비우지 않는다(지금까지가 곧 '압축 전 대화'다). 새 파일을 0 부터 이어 읽는다 —
        //  그 첫 줄(compact_boundary + 요약)이 곧 구분선으로 그려진다.
        curUuid = c.uuid; loadedTo = 0; carry = '';
        c = await rawGet(srcPath(src, { from: 0 }));
        if (destroyed) return;
      } else if (c.bytes < loadedTo) {     // 같은 파일이 줄었다(교체됨) — 처음부터 다시
        clearAll(); await open(); return;
      }
      if (!curUuid && c.uuid) { curUuid = c.uuid; oldestUuid = c.uuid; }   // 열 때는 파일이 없었다가 지금 생겼다
      if (loadedTo === 0 && c.from === 0 && c.prev && !oldestPrev && oldestUuid === c.uuid) { oldestPrev = c.prev; olderBar(); }
      if (c.text) {
        view.list.querySelector('.sc-empty')?.remove();   // 파일이 생겼다 — '아직 없음' 안내는 물러난다
        const wasRunning = running;
        applyText(c.text);
        loadedTo = c.to;
        if (running && cur) { if (!wasRunning || !cur.t.live) view.running(cur.t); view.busy(true); }
        if (!running) { if (cur) view.settle(cur.t); view.busy(false); }
        view.scroll(); paintState(); titleFromFirstAsk();
      } else if (running && cur && !dead()) {
        // 새 줄이 없는데 도는 중 표시 — 마감 조건: 세션이 idle(하네스 보고) + 조용함. 유예는 소스별로 다르다.
        //  · 중앙 기록(노드 세션): 턴 경계로만 자라고 종료 표시가 안 담기므로(#1744), idle 이면 짧게(6초) 기다렸다 마감한다.
        //  · 박스 파일: 스트리밍이라 잠깐 조용할 수 있어 보수적으로 120초(터미널에서 Esc 했거나 죽은 경우 대비).
        const idle = !(target.raw?.working || target.raw?.agentState === 'busy');
        const graceMs = src.kind === 'log' ? 6_000 : 120_000;
        if (idle && Date.now() - lastLineAt > graceMs) { running = false; view.settle(cur.t); view.busy(false); paintState(); }
      }
    } catch (e: any) {
      fails++;
      const st = Number(e?.status);
      // '아직 없음'은 실패가 아니다 — 박스 파일은 첫 대화 뒤 생기고, 중앙 기록은 살아있는 세션이면 첫 턴이 끝나야 올라온다.
      const notYet = (st === 404 && src.kind === 'box') || ((st === 404 || st === 403) && src.kind === 'log' && !dead());
      if (notYet) { fails = 0; }
      else if (st === 409 && src.kind === 'box' && e?.message === 'node') {
        // 노드(그 컴퓨터) 세션(#1744) — 박스 경로는 영원히 409 다. 서버가 준 uuid(또는 행의 것)로 중앙 기록으로 갈아탄다. 모르면 멈춘다
        //  (update() 가 목록에서 uuid 를 가져오면 다시 연다). 종전엔 이 409 를 세 번 세고 '진행을 따라가지 못하고…' 를 영영 띄웠다.
        if (e?.uuid) nodeHint = { uuid: String(e.uuid), node: String(e.node || target.node || '') };
        const ls = logSrc();
        if (!ls) { src = null; return; }
        src = ls; loadedFrom = loadedTo = 0; carry = ''; fails = 0;   // 다른 파일 — 오프셋은 처음부터
      }
      else if (st === 409 && src.kind === 'box' && e?.message) { src = null; return; }   // 못 읽는 하네스 — 더 안 묻는다(#1746)
      else if (fails === 3) view.setNote('진행을 따라가지 못하고 있어요 — 다시 붙는 중…');
    }
    schedule();
  }
  function clearAll(): void {
    recs.splice(0); cur = null; carry = ''; loadedFrom = loadedTo = 0; running = false;
    view.list.replaceChildren(); olderEl = null;
    trail?.clear();
  }

  // ── 보내기·키·이어받기 ──────────────────────────────────────────────────────────────
  async function sendPrompt(text: string): Promise<void> {
    if (!canType()) { toast('끝난 세션이에요 — [이어서 대화하기]로 새 세션을 열어 보내세요.'); return; }
    // 낙관적으로 그리고 **서버 큐에 넣는다**(#1753). 배달자가 입력창을 확인하고 넣고 에코로 delivered 를 확정한다 —
    //  로그인·대화상자에 멈춘 세션이어도 유실되지 않고, 새로고침해도 큐에서 되살아난다. 미제출 Enter 재시도도 배달자 몫.
    view.removeOpening(); view.list.querySelector('.sc-empty')?.remove();
    const pd = addPending(text);
    view.scrollToBottom();
    try {
      const r = await api(`/api/ui/terminal/sessions/${encodeURIComponent(target.id)}/prompt`, { method: 'POST', body: JSON.stringify({ text }) }) as { outbox_id?: number };
      if (r?.outbox_id) pd.obId = Number(r.outbox_id);
      view.setNote('');
      if (!caps().read) {   // 큐엔 들어갔지만(배달자가 전달) 답은 여기 안 온다(파서 전) — 도는 척 두지 않고 그 자리에 말한다
        const i = pending.indexOf(pd); if (i >= 0) pending.splice(i, 1);
        pd.state.textContent = ''; running = false; view.settle(pd.t); view.busy(false);
        view.setNote('보냈어요 — 이 하네스의 답은 아직 여기 안 보여요. 터미널로 보세요.'); return;
      }
      if (target.node) pd.state.textContent = '그 컴퓨터로 전달했어요 — 답은 턴이 끝나면 중앙 기록으로 여기 보여요.';   // 노드 세션(#1744): 큐 없이 곧장 넣었다
      // 어디를 지켜볼까 — 박스 파일, 노드면 중앙 기록(uuid 를 알 때만; 모르면 update() 가 가져올 때). ⚠ 노드에 박스 경로를 걸면 409 반복.
      if (!src) src = target.node ? logSrc() : { kind: 'box', id: target.id };
      if (src) schedule();
      void syncOutbox();
    } catch (e: any) {
      const i = pending.indexOf(pd); if (i >= 0) pending.splice(i, 1);
      pd.state.remove(); running = false;
      view.settle(pd.t); view.busy(false);
      view.error(pd.t, `보내지 못했습니다. ${e?.message || ''}`);
      view.input.value = text;               // 친 글은 돌려준다
    }
  }
  // 동작(승인·거부·중단)을 보낸다 — 어느 키인지는 서버의 하네스 어댑터가 정한다(#1746). 대신 못 누르는 하네스면 서버가 409 로 말한다.
  async function sendKey(action: 'approve' | 'deny' | 'interrupt', quiet = false): Promise<void> {
    try {
      await api(`/api/ui/terminal/sessions/${encodeURIComponent(target.id)}/keys`, { method: 'POST', body: JSON.stringify({ action }) });
      if (quiet) return;
      view.setNote(action === 'interrupt' ? '멈춤을 보냈어요.' : action === 'deny' ? '거부를 보냈어요.' : '승인을 보냈어요.');
      window.setTimeout(() => { if (!destroyed) view.setNote(''); }, 2500);
    } catch (e: any) { if (!quiet) view.setNote(e?.message || '키를 보내지 못했습니다.'); }
  }
  /** 이 세션을 되살려(또는 그 대화를 이어받아) 새 세션으로 간다. btn 없이도 부를 수 있다 — 자동 복원 경로(#1820). */
  async function resumeSession(btn?: HTMLButtonElement | null): Promise<void> {
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '여는 중…'; }
    try {
      let nextId = '';
      if (isBox && target.raw?.restorable) {
        const r: any = await api(`/api/ui/terminal/sessions/${encodeURIComponent(target.id)}/restore`, { method: 'POST', body: '{}' });
        if (r?.session) rememberCreated(r.session);
        nextId = String(r?.session?.id || (r?.already ? target.id : ''));
      } else {
        const sid = !isBox ? target.id : String(target.logId || target.raw?.claudeSessionId || '');
        const node = !isBox ? String(target.node ?? '') : String(target.logNode ?? '');
        if (!sid) throw new Error('이어받을 대화 id 를 모릅니다.');
        const r: any = await api(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/resume?node=${encodeURIComponent(node)}`, { method: 'POST', body: '{}' });
        if (r?.session) rememberCreated(r.session);
        nextId = String(r?.session?.id || '');
        if (r?.mode === 'fallback' && r?.reason) toast(String(r.reason));
      }
      if (!nextId) throw new Error('새 세션 id 를 받지 못했습니다.');
      toast('이어받기 세션을 열었어요.');
      // 라우팅은 호출자(탭)에게 — 전역 주소를 여기서 바꾸면 숨은 탭의 복원이 활성 탭을 끌고 간다(opts.onResumed 주석).
      if (opts.onResumed) opts.onResumed(nextId);
      else location.hash = '#/s/' + encodeURIComponent(nextId);
    } catch (e: any) {
      toast(e?.message || '이어받기 세션을 만들지 못했습니다.');
      // ⚠ **자동** 복원 실패는 잠근 채로 둔다(#1834 후속) — 종전엔 여기서 풀어 줘, 실패가 반복되는 동안
      //  (노드가 잠깐 오프라인인 때 등) 같은 화면이 계속 되살리기를 시도했다. 사람이 버튼을 누르면 다시 된다.
      if (btn) { resumeAuto = false; btn.disabled = false; btn.textContent = orig || '이어서 대화하기'; }
    }
  }

  // 목차 — 이 창에서 읽은 질문들. 누르면 그 턴으로.
  function openIndex(): void {
    const qs = recs.filter((r) => r.t.text);
    // dash-pop-panel — 배경·테두리·그림자는 이 클래스가 준다(anchoredPopover 는 위치만 잡는다). 없으면 글자가 본문 위에 투명하게 겹친다.
    const panel = el('div', { class: 'dash-pop-panel sc-idx' },
      el('div', { class: 'sc-idx-h', text: qs.length ? `질문 ${qs.length}개${loadedFrom > 0 ? ' · 불러온 범위 안' : ''}` : '이 창에 질문이 없어요' }),
      ...qs.map((r, i) => el('button', { class: 'sc-idx-item', type: 'button', title: r.t.text, onclick: () => { close(); r.t.root.scrollIntoView({ behavior: 'smooth', block: 'start' }); r.t.root.classList.add('sc-flash'); setTimeout(() => r.t.root.classList.remove('sc-flash'), 1800); } },
        el('span', { class: 'sc-idx-n', text: String(i + 1) }), el('span', { class: 'sc-idx-t', text: r.t.text.length > 90 ? r.t.text.slice(0, 90) + '…' : r.t.text }))));
    const close = anchoredPopover(moreBtn, panel);   // 목차는 [⋯] 안으로 들어갔다 — 앵커도 그 버튼이다
  }

  setMode('term');   // 기본 = 터미널(터미널 없는 세션은 setMode 가 대화로 되돌린다)

  void open();

  return {
    id: first.id,
    setFilesOn(on) { filesBtn.classList.toggle('sc-act-on', !!on); },
    update(t) {
      const wasDead = dead();
      target = t;
      if (!hcat && t.raw?.harness) { void runCatalog().then((hs) => { hcat = findHarness(hs, String(t.raw.harness)); paintRun(); }); }
      paintRun();                                 // 세션이 끝나면 드롭다운은 물러나고 사실 표시(칩)만 남는다
      if (t.label && !/^box-|^[0-9a-f-]{20,}$/i.test(t.label)) titleText = t.label;
      paintTitle();                               // pane 이름은 턴마다 바뀌고, 살아있음·소유가 바뀌면 '고칠 수 있는 이름'인지도 바뀐다
      paintState();
      if (!wasDead && dead()) { running = false; if (cur) view.settle(cur.t); }
      // 노드 세션(#1744) — 열 때는 대화 uuid 를 몰랐는데 목록 갱신이 가져왔다(행 claudeSessionId·logId): 이제 중앙 기록을 연다.
      //  같은 세션인데 uuid 가 바뀌었으면(/clear·압축) 새 기록으로 갈아탄다.
      const ls = logSrc();
      if (!destroyed && ls) {
        if (!src && !!t.node && canType()) { void open(); }
        else if (src && src.kind === 'log' && isBox && ls.kind === 'log' && src.sid !== ls.sid) { src = ls; loadedFrom = loadedTo = 0; carry = ''; if (pollTimer) clearTimeout(pollTimer); schedule(); }
      }
    },
    destroy() { destroyed = true; if (pollTimer) clearTimeout(pollTimer); stopWatchOutbox(); window.removeEventListener('message', onTermMsg); view.destroy(); },
  };
}
