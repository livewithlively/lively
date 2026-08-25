// v2/panes-parts.ts — 기본 뷰(v2/panes.ts)의 **부품**들. 한 부품 = 한 탭에 들어가는 내용 하나.
//
//  폐기된 캔버스(studio.ts)의 위젯과 무엇이 다른가 — 위젯은 '사람이 판에 올려야 생기는 것'이었고, 부품은
//  '칸에 이미 들어와 있는 것'이다. 그래서 부품은 크기를 스스로 정하지 않고(칸이 정한다) 배치도 갖지 않는다.
//  대신 **칸 폭이 좁아도 읽히도록** 한 열 흐름으로 그린다.
//
//  공통 계약(Part):
//   · root  — 칸 본문에 그대로 붙는 요소.
//   · tick() — 8초 틱. **서명이 같으면 DOM 을 건드리지 않는다**(스크롤·입력 중인 글자 보호).
//   · destroy() — 폴링·구독 정리.
import { api, apiUrl, el, relTime, renderMarkdown, toast } from '../core.js';
import { confirmSessionTrash, sessionNames, sessionTrashOp, eulReul } from '../session-actions.js';   // #1851 — 보관 칸의 × 는 휴지통으로
import { fmtSize } from '../projects/files.js';
import { upDropZone, upFromInput, upSend, upToast, type UpItem } from '../projects/files-upload.js';
import { confirmDialog } from '../ui-primitives.js';
import { mountProjectChat, type ProjectChatHandle } from '../project-chat.js';
import { hasBrowserSurface } from './browser-surface.js';
import { EMBEDDED } from './embed.js';
import { normWebUrl } from './web-url.js';
import { filesPart } from './panes-files.js';
import { NOISE_RE, TRASH_DIR, authHeaders, kindOf, knTitle, pnIcon, pnNote } from './panes-kit.js';
import { composerAttach } from './compose-attach.js';
import { createRunPicker } from './run-picker.js';
import { spawnSession } from './quick-session.js';
import { rememberCreated } from './created-cache.js';   // #1820 — 되살린 세션을 라우트가 곧바로 그릴 수 있게
import { sessText } from './side.js';
import { listSessionApps, openAppSession } from './app-session.js';
import { openInstalledApp } from './app-instance.js';
import { type Sess, type V2Data } from './views.js';

// 아이콘은 곁칸 곳곳(panes.ts · proj-settings.ts)이 여기서 받아 왔다 — 잎으로 옮긴 뒤에도 그 자리를 유지한다.
export { pnIcon } from './panes-kit.js';

/** 사람이 지금 **다른 칸에 손을 대고 있나** — 그렇다면 자동 포커스는 그 손을 밀어내지 않는다.
 *  화면을 처음 세울 때조차, 앞에 열린 창(프로젝트 상세 등)에 커서가 가 있으면 뺏지 않는다. */
function handIsElsewhere(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body) return false;
  const tag = a.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable;
}

export type PartType = 'sessions' | 'files' | 'knowledge' | 'tasks' | 'timeline' | 'liv' | 'archive' | 'web' | 'editor' | 'apps' | 'preview';

export interface PartCtx {
  id: number;
  data: () => V2Data;
  detail: () => any;                 // 최신 GET v6/projects/:id 응답(패널 셸이 쥐고 갱신한다)
  dead: () => boolean;
  onChanged?: () => void;            // 프로젝트 쪽이 바뀌었다 — 셸이 detail·사이드바를 다시 읽는다
  openSettings?: () => void;         // 프로젝트 설정(본문·할 일·상태) — 문패의 [설정]과 같은 곳
  // ── 세션(#1719 원준 2026-08-20: 세션 화면 = 이 화면) ──
  sessionId?: string | null;         // 라우트가 지정한 '지금 보는 세션'(#/s/<sid>)
  /** 서랍에서 다른 세션을 골랐다 — 셸을 다시 그리지 않고 **주소만** 그 세션 것으로 갈아 끼운다. */
  onSessionPicked?: (sid: string | null) => void;
  /** 세션 화면(대화창·터미널·상단바) 통째를 이 자리에 붙인다 — main.ts 가 준다(우패널·이름바꾸기 등 배선을 쥔 쪽).
   *  세션이 아직 목록에 없으면 null 을 돌려준다 — 그때는 부품이 잠시 뒤 다시 붙인다(mountStage 주석). */
  mountSession?: (host: HTMLElement, sid: string) => { destroy(): void } | null;
  /** 새 세션 자리에서 세션을 **방금 만들었다** — 셸이 그 전문을 목록에 즉시 끼워 넣는다(20초 폴링을 기다리지 않게). */
  onSessionCreated?: (row: any) => void;
  // ── ★ 부품은 '이 프로젝트의 것'이 아니라 **'지금 보는 세션의 것'**이다(원준 2026-08-20) ────────────
  //  자료·지식만 프로젝트의 것이고(세션들이 같이 보는 공용물), 나머지 칸에서 한 조작은 같은 프로젝트의 다른
  //  세션으로 새어 나가면 안 된다 — 타임라인은 그 세션의 발자취여야 하고, 웹 칸의 주소·편집기가 열어 둔 파일도
  //  세션마다 따로다. 세션들이 나눠 쓰는 것은 **어떤 칸이 떠 있나(배치)** 뿐이다(panes.ts).
  /** 지금 보는 세션. 서랍에서 갈아 끼우면 이 값이 바뀐다(정적인 sessionId 와 달리 살아 있다). */
  curSession: () => string | null;
  /** 보는 세션이 바뀌면 알려 준다 — 돌려주는 함수를 부르면 구독을 끊는다(부품 destroy 에서). */
  onSession: (fn: (sid: string | null) => void) => (() => void);
  /** 지금 세션의 **발자취 위젯이 사는 자리**. 세션 화면(대화)이 트랜스크립트를 읽으며 여기를 채운다 —
   *  타임라인 칸은 이 자리를 자기 몸에 들이기만 한다(셸이 세션마다 새로 만들어 준다). */
  trailHost: () => HTMLElement;
  /** 그 세션에만 딸리는 값의 저장 열쇠 — 세션이 있으면 세션, 없으면(새 세션 자리) 프로젝트로 떨어진다. */
  memKey: () => string;
  /** **이 곁칸 한 벌의 뿌리**. 부품끼리의 신호는 여기서만 오간다 — `document` 에 뿌리면 열려 있는 **모든
   *  세션 탭**의 곁칸이 함께 받는다(실측 2026-08-21: 미리보기 한 번 눌렀더니 두 세션 탭의 웹 칸이 같이
   *  갈아 끼워지고 저장값에도 두 세션 키가 모두 박혔다). 값은 세션마다 갈라 두었는데 신호를 문서 전체로
   *  뿌리면 그 격리가 그 자리에서 무너진다. */
  paneRoot: () => HTMLElement;
}

export interface Part {
  root: HTMLElement;
  tick?: () => void;
  destroy?: () => void;
  /** 세션 부품만 — 칸의 탭 줄이 '어느 세션을 보나'를 이걸로 갈아 끼운다(null = 새 세션 자리). */
  selectSession?: (sid: string | null) => void;
  /** 세션 부품만 — 지금 보는 세션 id(탭 줄이 어느 탭을 켤지 안다). null = 새 세션 자리. */
  currentSession?: () => string | null;
}

export interface PartDef { type: PartType; name: string; icon: string; hint: string }

/** 칸에 넣을 수 있는 것들 — [+] 고르기 목록의 정본. */
export const PART_DEFS: PartDef[] = [
  { type: 'sessions', name: '세션', icon: 'chat', hint: '이 프로젝트에서 도는 AI 세션들과 바로 말하는 자리입니다.' },
  { type: 'files', name: '자료', icon: 'folder', hint: '이 프로젝트의 모든 세션이 참고하는 자료입니다. 끌어다 놓거나 붙여넣으면 올라갑니다.' },
  { type: 'knowledge', name: '지식', icon: 'doc', hint: '세션들이 쓰고 고치는 글입니다. 워크스페이스 전체가 함께 봐요.' },
  { type: 'tasks', name: '할 일', icon: 'task', hint: '태스크 목록입니다. 눌러서 끝냈다고 표시합니다.' },
  { type: 'timeline', name: '타임라인', icon: 'clock', hint: '이 프로젝트에 남은 활동 기록입니다.' },
  { type: 'liv', name: '리브', icon: 'spark', hint: '이 프로젝트를 아는 리브와 대화합니다.' },
  // 이름을 '보관함'이 아니라 **보관한 세션**으로 둔다(원준 2026-08-20) — 무엇을 보관하는지가 이름에서 바로 읽혀야 한다.
  { type: 'archive', name: '보관한 세션', icon: 'box', hint: '닫아 둔 AI 세션입니다. 대화 그대로 다시 살릴 수 있어요.' },
  { type: 'web', name: '웹', icon: 'globe', hint: '주소를 넣으면 이 칸에서 그 페이지를 봅니다. 문서·레퍼런스를 옆에 띄워 두세요.' },
  { type: 'preview', name: '미리보기', icon: 'globe', hint: '띄워 둔 화면 목록입니다. 누르면 웹 칸에 그 화면이 실립니다.' },
  { type: 'editor', name: '뷰어', icon: 'eye', hint: '자료의 파일을 골라 이 칸에서 봅니다 — 문서·그림·PDF·시안·영상.' },
  { type: 'apps', name: '앱', icon: 'grid', hint: '설치된 앱을 고르면 각 앱이 상단의 자기 탭에서 열립니다.' },
];

export const partDef = (t: PartType): PartDef => PART_DEFS.find((d) => d.type === t) || PART_DEFS[0];

const base = (p: string): string => String(p).split('/').pop() || String(p);

// ══ 세션 — 카드가 세로로 쌓인다(원준 2026-08-20 선택) ════════════════════════════
//  맨 위가 새 세션 입력칸, 그 아래로 이 프로젝트의 세션이 **답 기다리는 것 먼저**.
//  카드는 최근 대화 몇 줄 + 그 자리에서 이어 말하는 입력칸을 가진다 — 세션 화면으로 넘어가지 않아도 되게.
//  펼친 카드만 대화를 당긴다(접힌 카드는 요청 자체를 안 한다).

interface Turn { who: 'me' | 'ai'; text: string }
const INJ_RE = /^\s*(<command-name|<local-command-|<command-message|<command-args|<bash-|<task-notification|<system-reminder|\[Request interrupted|Caveat:|This session is being continued)/;

const tailCache = new Map<string, { turns: Turn[]; at: number }>();

/** 대화 꼬리를 어디서 읽나 — 이 박스에서 도는 세션은 박스의 대화 파일, 노드·끝난 세션은 **중앙 기록**(#1752).
 *  둘 다 공통 ChatLine ndjson 을 준다(src/terminal/harness-io/chat-line.ts) — 아래 파서 하나로 읽힌다. */
function tailUrl(s: Sess, maxBytes: number): string | null {
  if (s.live && !s.node) return '/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/transcript?tail=' + maxBytes;
  const sid = String(s.logId || s.id || '');
  if (!sid) return null;
  return '/api/ui/v6/sessions/' + encodeURIComponent(sid) + '/log?fmt=chat&tail=' + maxBytes + '&node=' + encodeURIComponent(String(s.logNode || s.node || ''));
}

async function fetchTurns(s: Sess, maxBytes: number): Promise<Turn[]> {
  const hit = tailCache.get(s.id);
  if (hit && Date.now() - hit.at < 7000) return hit.turns;
  const turns: Turn[] = [];
  const url = tailUrl(s, maxBytes);
  if (!url) { tailCache.set(s.id, { turns, at: Date.now() }); return turns; }
  try {
    const res = await fetch(apiUrl(url), { headers: authHeaders(), credentials: 'same-origin' });
    if (res.ok) {
      for (const line of (await res.text()).split('\n')) {
        if (!line.trim()) continue;
        let o: any; try { o = JSON.parse(line); } catch { continue; }
        if (!o || o.isSidechain || o.isMeta) continue;
        const c = o.message?.content;
        if (o.type === 'user') {
          const txt = (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text || '')).join(' ') : '').replace(/\s+/g, ' ').trim();
          if (txt && !INJ_RE.test(txt)) turns.push({ who: 'me', text: txt });
        } else if (o.type === 'assistant') {
          const txt = (Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text || '')).join('\n') : '').trim();
          if (!txt) continue;
          const last = turns[turns.length - 1];
          if (last && last.who === 'ai') last.text = txt;
          else turns.push({ who: 'ai', text: txt });
        }
      }
    }
  } catch (_) { /* 못 읽으면 카드는 상태만 보여 준다 */ }
  tailCache.set(s.id, { turns, at: Date.now() });
  return turns;
}

/** 상태 우선순위 — 답을 기다리는 것이 맨 위(내가 풀어야 도는 일), 그다음 도는 것, 조용한 것, 끝난 것. */
const rank = (s: Sess): number => (s.stateKey === 'waiting' ? 0 : s.stateKey === 'busy' ? 1 : s.live && s.alive ? 2 : 3);

const norm = (v: string): string => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ── 세션 이름 (탭 줄이 쓴다) ──────────────────────────────────────────────────
//  세션 이름이 프로젝트명으로 자동 생성되는 일이 잦아, 그대로 쓰면 **탭이 전부 같은 글자**가 된다. 그래서
//   ① 사이드바와 같은 규칙(side.ts sessText)으로 프로젝트명 되풀이를 걷어내고,
//   ② 그래도 비면 **마지막으로 시킨 말**을 쓰고(대화 꼬리에서 한 번만 찾아 캐시),
//   ③ 그것도 없으면 세션 꼬리(`세션 f561ce49`) — 시각으로 쓰면 같은 날 것끼리 또 똑같아진다.
const nameCache = new Map<string, string>();
const askedName = new Set<string>();

export function sessTitle(s: Sess, projectName: string): string {
  const t = sessText(s, projectName);
  const dup = !!projectName && norm(t.main) === norm(projectName);
  const tailId = String(s.id).split('-').pop() || String(s.id);
  // ★ 서버가 들고 있는 이름이 **정본**이다 — 아래 nameCache 보다 먼저 본다(원준 2026-08-20).
  //  새 세션은 첫 지시를 이름 자리에 임시로 넣어 두는데(seedSessName), 잠시 뒤 **그 세션 자신**이 첫 지시 턴에
  //  **짧은 이름**을 지어 등록한다(#1979 — 훅 session-name-ask → MCP session_rename). 캐시를 먼저 보면 그 이름이 도착해도
  //  화면은 영영 첫 지시 앞부분을 그대로 달고 있게 된다.
  if (!dup && t.main) return t.main;
  return nameCache.get(s.id) || ('세션 ' + tailId.slice(0, 8));
}

/** 되풀이 이름을 가진 세션의 '마지막으로 시킨 말'을 한 번씩만 찾아 온다. 하나라도 찾으면 onFound 로 알린다. */
export async function lookupSessNames(list: Sess[], projectName: string, onFound: () => void): Promise<void> {
  if (!projectName) return;
  let got = false;
  for (const s of list) {
    if (askedName.has(s.id) || nameCache.has(s.id)) continue;
    if (norm(sessText(s, projectName).main) !== norm(projectName)) continue;
    askedName.add(s.id);
    const turns = await fetchTurns(s, 30000);
    const last = [...turns].reverse().find((x) => x.who === 'me');
    if (!last) continue;
    nameCache.set(s.id, last.text.replace(/\s+/g, ' ').slice(0, 46));
    got = true;
  }
  if (got) onFound();
}

/** 새 세션을 막 열었을 때 — 첫 지시를 이름으로 미리 넣어 둔다(대화 꼬리를 다시 찾지 않게). */
export function seedSessName(sid: string, text: string): void {
  nameCache.set(sid, text.replace(/\s+/g, ' ').slice(0, 46));
}


// ── 세션 부품 ────────────────────────────────────────────────────────────────
//  이 부품은 **지금 보는 세션의 화면 그 자체**다(대화창·터미널·세션 상단바 — main.ts 가 mountSession 으로 붙인다).
//  ★ 어느 세션을 보나는 **칸의 탭 줄**이 정한다(원준 2026-08-20) — 세션 하나 = 탭 하나, VS Code 에서 파일이
//    탭으로 열리는 것과 같은 문법이다. 종전의 하단 '세션 서랍'은 그 탭 줄로 흡수돼 사라졌다.
//  ★ 프로젝트 화면과 세션 화면은 다른 화면이 아니다 — 같은 셸에서 세션만 갈아 끼운다(셸은 다시 그리지 않는다).
function sessionsPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-sessions' });
  let sel: string | null = ctx.sessionId || null;
  let composing = !sel;                               // 새 세션 자리(문패의 [＋ 세션])
  let sending = false;
  let mounted: { sid: string; h: { destroy(): void } | null; ok: boolean } | null = null;
  let retry = 0;                                      // 방금 만든 세션이 목록에 아직 없을 때 다시 붙여 보는 횟수
  let retryTimer = 0;
  let missSince = 0;                                  // sel 이 목록에서 안 보이기 시작한 시각(0 = 보인다) — paint() 주석

  // 위(그리고 전부) — 세션 화면이 통째로 들어오는 자리
  const stage = el('div', { class: 'pn-stage' });
  root.append(stage);

  // ── 새 세션 자리 = **홈 입력창과 같은 컴포저**(원준 2026-08-20) ──────────────────
  //  종전엔 칸 맨 아래에 붙은 한 줄짜리 입력칸이었다. 같은 '새 세션을 여는 자리'인데 홈과 생김새가 전혀 달라
  //  거기서 그냥 시키면 되는 곳으로 읽히지 않았고, 제공자·모델·추론강도(#1758)를 여기서는 고를 수 없었다.
  //  그래서 홈(v2/views.ts renderHome)의 카드를 **같은 클래스로** 쓴다 — 다른 것은 문구뿐이다(이 프로젝트에 붙는다).
  //  ⚠ 클래스를 베껴 새로 정의하지 않는다: v2-launch* 를 그대로 쓰므로 홈이 바뀌면 여기도 같이 바뀐다.
  const projectName = (): string => {
    const d = ctx.detail();
    return String((d && d.name) || '') || (ctx.id > 0 ? '프로젝트 #' + ctx.id : '');
  };
  const ta = el('textarea', {
    class: 'v2-launch-in', rows: '2', 'aria-label': '새 세션에 시킬 일',
    placeholder: ctx.id > 0 ? '무엇이든 시키세요 — 이 프로젝트에 붙은 새 세션이 열려요.' : '무엇이든 시키세요 — 새 세션이 열려요.',
  }) as HTMLTextAreaElement;
  const send = el('button', { class: 'btn btn-primary v2-launch-send', type: 'button', title: 'Enter 로도 보낼 수 있어요', onclick: () => void spawn() },
    el('span', { text: '시키기' })) as HTMLButtonElement;
  // 제공자·모델·추론강도·실행 노드 — 홈과 같은 부품이고 **같은 기억**을 쓴다(여기서 고른 값이 다음 기본이 된다).
  //  새 세션 자리를 처음 그릴 때만 만든다(서버 /terminal/config 를 한 번 부른다 — 세션을 보고 있을 뿐인 칸이 부를 이유가 없다).
  let runPicker: ReturnType<typeof createRunPicker> | null = null;
  const idle = (): void => { send.disabled = false; ta.disabled = false; runPicker?.disable(false); send.replaceChildren(el('span', { text: '시키기' })); };
  const grow = (): void => { ta.style.height = 'auto'; ta.style.height = Math.min(220, ta.scrollHeight) + 'px'; };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault(); void spawn();
  });

  // ── 첨부(#1819→#1870) — 붙여넣기·드래그앤드롭·[＋] 버튼 모두 홈 입력창과 **한 모듈**(v2/compose-attach.ts).
  //  왜 필요했나: 클로드가 도는 화면(터미널)에는 이 경로가 있는데(dropFileToAgent) 세션을 **여는** 창에는 없어서,
  //  화면을 캡처해 놓고도 세션을 먼저 열고 다시 붙여넣어야 했다(원준 2026-08-20 신고). 프로젝트가 있으면 그
  //  공유 폴더로, 없으면(loose 셸) 내 개인 폴더로 올라가고, 절대경로가 첫 지시 꼬리에 실린다.
  const att = composerAttach({ projectId: () => ctx.id, onChanged: () => ctx.onChanged?.(), dead: () => ctx.dead() });
  att.wirePaste(ta);   // ⚠ 여기 한 번만 — newPane 은 다시 그려질 수 있어 거기서 걸면 붙여넣기가 두 벌씩 올라간다

  function newPane(): HTMLElement {
    if (!runPicker) runPicker = createRunPicker();
    const pane = el('div', { class: 'pn-newpane' },
      el('div', { class: 'pn-launch' },
        el('h1', { class: 'v2-h1', text: '무엇을 할까요?' }),
        el('p', { class: 'v2-home-sub', text: ctx.id > 0 ? '새 세션이 열려요.' : '프로젝트 없이 새 세션이 열려요.' }),
        el('div', { class: 'v2-launch' }, ta, att.chips,
          // 줄 구성은 홈(views.ts)과 같다 — 왼쪽 '무엇으로 열까', 오른쪽 '행동([＋]·[시키기])'.
          el('div', { class: 'v2-launch-row' },
            el('div', { class: 'v2-launch-ctl' }, runPicker.el),
            el('div', { class: 'v2-launch-act' }, att.btn, send)), att.fileIn)));
    att.wireDrop(pane, pane);
    return pane;
  }

  const mine = (): Sess[] => ctx.data().sessions
    .filter((s) => Number(s.projectId) === ctx.id)
    .sort((a, b) => rank(a) - rank(b) || (b.lastSeen || 0) - (a.lastSeen || 0));

  /** 위 자리를 이 세션으로 채운다. 같은 세션이면 아무것도 하지 않는다(대화·스크롤·터미널 보존). */
  function mountStage(): void {
    if (composing || !sel) {
      if (mounted) { mounted.h?.destroy(); mounted = null; }
      // 칸을 **새로 세울 때만** 손을 옮긴다(원준 2026-08-25). paint() 는 주기 갱신마다 여기를 지나므로
      //  포커스를 무조건 걸면 **다른 칸에 쓰던 글이 이 칸으로 새어 들어간다** — [프로젝트 상세] 창의 본문·
      //  할 일을 치던 중에 커서가 이리로 튀어, 친 글자가 '새 세션에 시킬 일'에 찍히던 사고가 그것이다.
      const fresh = !stage.querySelector('.pn-newpane');
      if (fresh) stage.replaceChildren(newPane());
      window.setTimeout(() => { grow(); if (fresh && !handIsElsewhere()) ta.focus(); }, 0);
      return;
    }
    if (mounted && mounted.sid === sel && mounted.ok) return;
    if (mounted) { mounted.h?.destroy(); mounted = null; }
    stage.replaceChildren();
    const h = ctx.mountSession ? ctx.mountSession(stage, sel) : null;
    if (!ctx.mountSession) { stage.replaceChildren(el('p', { class: 'pn-fine', style: 'padding:20px', text: '세션 화면을 붙일 수 없어요.' })); return; }
    // ⚠ 못 붙었다(h === null) = 그 세션이 아직 목록에 없다 — 방금 만든 세션에서 늘 그렇다(목록 폴링은 20초).
    //  종전엔 여기서 "찾을 수 없어요"가 그려진 채 **그대로 굳었다**: 다음 틱은 `mounted.sid === sel` 이라 다시
    //  그리지 않으므로, 목록이 도착해도 화면이 바뀌지 않아 사람이 새로고침을 해야 했다(원준 2026-08-20 신고).
    //  이제 붙었는지(ok)를 기억하고, 못 붙었으면 짧은 간격으로 다시 붙인다.
    mounted = { sid: sel, h, ok: !!h };
    if (!h) {
      stage.replaceChildren(el('div', { class: 'pn-empty' }, el('b', { text: '세션을 여는 중이에요.' }),
        el('p', { class: 'pn-fine', text: '곧 대화가 여기에 나타나요.' })));
      scheduleRetry();
    } else { retry = 0; }
  }

  /** 목록에 아직 안 온 세션을 1초 간격으로 다시 붙여 본다(최대 12초). 붙는 순간 대화창이 그대로 살아난다. */
  function scheduleRetry(): void {
    if (retryTimer || retry >= 12) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = 0; retry++;
      if (!composing && sel) mountStage();
    }, 1000);
  }

  function select(id: string | null): void {
    if (id === sel && composing === (id == null)) return;
    sel = id; composing = id == null;
    retry = 0;
    ctx.onSessionPicked?.(id);            // 주소만 갈아 끼운다 — 셸은 그대로 산다
    mountStage();
  }

  async function spawn(): Promise<void> {
    const text = ta.value.trim();
    if (!text || sending) return;
    // 올리는 중 전송 금지 — 막지 않으면 아직 안 올라간 파일이 지시에서 **조용히** 빠진다(큰 파일에서 실제로 나는 순서).
    if (att.busy()) { toast('파일을 올리는 중이에요 — 다 올라가면 보내주세요.'); return; }
    sending = true; send.disabled = true; ta.disabled = true; runPicker?.disable(true);
    send.replaceChildren(el('span', { text: '여는 중…' }));
    // 생성은 **한 곳**에서만 한다(v2/quick-session.ts spawnSession) — 생성 전문 캐시·첫 지시 낙관 렌더·프로젝트
    //  붙이기가 거기 묶여 있다. 여기서 fetch 를 다시 짜면 그 중 하나가 빠진다(실제로 캐시가 빠져 있었다).
    // 첨부는 지시의 꼬리에 절대경로로 적는다 — 세션이 열리자마자 그 파일을 읽을 수 있게(이름은 사람이 알아보는 단서).
    const prompt = text + att.tail();
    const made = await spawnSession(prompt, { projectId: ctx.id > 0 ? ctx.id : null, projectName: projectName(), run: runPicker?.value() || null });
    sending = false; idle();
    if (!made) { ta.focus(); return; }
    seedSessName(made.id, text);
    // 목록에 **지금** 끼워 넣는다 — 20초 폴링을 기다리면 그 사이 세션 화면이 빈 채로 있는다.
    ctx.onSessionCreated?.(made.session);
    ta.value = ''; ta.style.height = 'auto';
    att.clear();
    ctx.onChanged?.();
    select(made.id);
  }

  /** 목록에서 sel 이 사라졌다고 갈아타기까지 두는 유예.
   *  2분은 넉넉히 잡은 값이다 — 게이트웨이 재배포 후 노드가 다시 붙기까지 **최악 33초**(노드 에이전트 재연결
   *  백오프 상한 30초 + 상태 push 주기 3초, src/node/agent.ts BACKOFF_MAX_MS·STATE_PUSH_MS)이고 그 사이
   *  노드 세션은 목록에서 통째로 빠져 있다(게이트웨이 states 는 인메모리라 재시작 때 리셋된다).
   *  반대로 늦어서 손해 볼 일은 거의 없다: 세션을 다른 프로젝트로 옮기거나 지운 드문 경우에 화면이 잠깐 더
   *  머무를 뿐이고, 그동안에도 터미널은 그 세션에 정상으로 붙어 있다. */
  const MISS_GRACE_MS = 120_000;

  function paint(): void {
    const ss = mine();
    // 지정된 세션이 이 프로젝트에 없으면(옮겼거나 사라졌다) 맨 위 세션으로.
    //  ⚠ 방금 만들어 아직 목록에 안 온 세션(mounted.ok === false)은 예외다 — 여기서 다른 세션으로 튕기면
    //   사람이 방금 연 세션을 잃는다.
    // ★ '목록에 없다' ≠ '사라졌다'(상민님 신고 2026-08-20). 게이트웨이를 재배포하면 /terminal/sessions 가
    //   몇 초간 실패하고, 노드 세션 목록은 게이트웨이 재시작 때 통째로 리셋된다(src/node/registry.ts states —
    //   노드가 다시 붙어 상태를 push 할 때까지 비어 있다). 그 한두 판에 이 폴백이 돌면 **살아 있는 세션이**
    //   맨 위 세션으로 갈아치워졌다: 주소·탭 제목·상단바는 옛 세션 그대로인데 터미널만 남의 세션(대개 다른
    //   탭에서 보고 있던 그 세션)인 화면이 되고, 20초 목록 갱신이 옛 세션 정보를 그 상단바에 계속 덧칠해
    //   새로고침 전까지 어긋난 채로 굳었다. 그래서 셋을 건다 —
    //   ⓐ 목록을 통째로 못 받은 판은 아예 판단하지 않는다(갈아탈 근거가 그 판에는 없다),
    //   ⓑ 30초 넘게 계속 안 보일 때만 갈아탄다(재배포·일시장애는 그 안에 복구된다),
    //   ⓒ 갈아탈 때는 select() 로 간다 — 주소·탭 제목까지 함께 옮겨 **화면과 주소가 어긋나지 않는다**.
    const pending = !!mounted && mounted.sid === sel && !mounted.ok;
    const blind = !ctx.data().sessions.length;        // 목록 자체가 비었다 = 못 받은 판(진짜 0건이어도 갈아탈 곳이 없다)
    const missing = !composing && !!sel && !pending && !blind && !ss.some((s) => s.id === sel);
    if (!missing) missSince = 0;
    else if (!missSince) missSince = Date.now();
    if (missing && Date.now() - missSince >= MISS_GRACE_MS) {
      missSince = 0;
      select(ss.length ? ss[0].id : null);            // 주소·탭 제목까지 함께(onSessionPicked) — mountStage 도 select 안에서 돈다
      return;
    }
    if (!ss.length && !composing && !pending && !sel) composing = true;
    mountStage();
  }

  paint();
  return {
    root,
    tick: () => paint(),
    destroy: () => {
      if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = 0; }
      if (mounted) { mounted.h?.destroy(); mounted = null; }
    },
    selectSession: (sid) => select(sid),
    currentSession: () => (composing ? null : sel),
  };
}

// ══ 지식 — 이 프로젝트에 연결된 문서 ══════════════════════════════════════════
function knowledgePart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-kn' });
  const note = pnNote('lively_pn_kn_note',
    '지식은 세션들이 일하면서 계속 쓰고 고치는 글이고, 이 워크스페이스의 모든 세션이 함께 봅니다. 쌓일수록 맥락이 촘촘해져요.');
  const list = el('div', { class: 'pn-knlist' });
  root.append(note, list);
  let sig = '';

  type KnRow = { name: string; title: string; rel: string; type?: string | null; lifecycle?: string | null };

  function paint(): void {
    const kn = (ctx.detail()?.project || {}).knowledge || {};
    const pick = (arr: any[], rel: string): KnRow[] => (arr || []).map((k: any) => ({
      name: String(k.name), title: String(k.title || ''), rel,
      type: k.type ?? null, lifecycle: k.lifecycle ?? null,
    }));
    const all: KnRow[] = [...pick(kn.required, '필요'), ...pick(kn.produced, '산출')];
    const s2 = all.map((k) => k.rel + k.name + k.title).join('|');
    if (s2 === sig) return;
    sig = s2;
    if (!all.length) {
      list.replaceChildren(el('div', { class: 'pn-empty' },
        pnIcon('doc', 'pn-i big'),
        el('b', { text: '연결된 지식이 아직 없어요.' }),
        el('p', { class: 'pn-fine', text: '세션이 만든 결론을 지식으로 남기면 여기 모입니다.' })));
      return;
    }
    list.replaceChildren(...all.map((k) => {
      // 제목은 **한 줄**만 — 전문은 title 속성과 상세 창이 갖는다(knTitle 머리말 참조).
      const row = el('button', {
        class: 'pn-knrow', type: 'button', title: (k.title || k.name) + '\n눌러서 요약을 봅니다',
        onclick: () => void openKnModal(k),
      }, pnIcon('doc', 'pn-i sm'),
        el('span', { class: 'n ell1', text: knTitle(k.title, k.name) }),
        el('span', { class: 'pn-knrel' + (k.rel === '산출' ? ' prod' : ''), text: k.rel }));
      return row;
    }));
  }

  // ── 상세 창 — 누르면 위키로 튀지 않고 **여기서 먼저 본다**(원준 2026-08-20) ──────────
  //  곁칸에서 지식을 누르는 이유는 대개 "이게 뭐였더라"이지 "정독하겠다"가 아니다. 위키로 보내면 보던 화면
  //  (세션·자료)이 통째로 사라지고 돌아올 길이 뒤로가기뿐이었다. 요약을 그 자리에서 보이고, 정독은 [전체 보기]로.
  async function openKnModal(k: KnRow): Promise<void> {
    const bodyEl = el('div', { class: 'pn-knm-body' }, el('p', { class: 'pn-fine', text: '불러오는 중…' }));
    const back = el('div', { class: 'pn-modal-back' });
    const close = (): void => { back.remove(); box.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    const box = el('div', { class: 'pn-modal pn-knm', role: 'dialog', 'aria-label': '지식 요약' },
      el('div', { class: 'pn-modal-h' },
        el('h2', { text: knTitle(k.title, k.name) }),
        el('button', { class: 'pn-modal-x', type: 'button', 'aria-label': '닫기', onclick: () => close() }, pnIcon('x', 'pn-i sm'))),
      el('div', { class: 'pn-modal-b' }, bodyEl),
      el('div', { class: 'pn-modal-f' },
        el('span', { class: 'pn-fine ell', text: k.name }),
        el('a', { class: 'btn btn-primary btn-sm', href: '#/k/' + encodeURIComponent(k.name), onclick: () => close() }, el('span', { text: '전체 보기' }))));
    back.onclick = () => close();
    document.addEventListener('keydown', onKey);
    document.body.append(back, box);

    const d: any = await api('/api/ui/knowledge/' + encodeURIComponent(k.name)).catch(() => null);
    if (!box.isConnected) return;
    const kd = (d && (d.knowledge || d)) || null;
    if (!kd) { bodyEl.replaceChildren(el('p', { class: 'pn-fine', text: '내용을 불러오지 못했어요 — [전체 보기]로 열어 주세요.' })); return; }
    const meta = el('div', { class: 'pn-knm-meta' },
      el('span', { class: 'pn-knrel' + (k.rel === '산출' ? ' prod' : ''), text: k.rel }),
      ...(kd.type ? [el('span', { class: 'pn-knm-tag', text: String(kd.type) })] : []),
      ...((kd.categories || []).slice(0, 2).map((c: any) => el('span', { class: 'pn-knm-tag', text: String(c.name || c.key) }))),
      ...(kd.updated_at ? [el('span', { class: 'pn-fine', text: relTime(String(kd.updated_at)) + ' 갱신' })] : []));
    // 전문 제목은 한 줄로 줄인 제목 아래에 그대로 — 줄인 것 때문에 원문을 못 보게 되면 안 된다.
    const full = String(kd.title || '');
    const short = knTitle(k.title, k.name);
    // 본문 첫 줄의 H1 은 대개 제목을 되풀이한다 — 창 머리에 이미 있으므로 턴다.
    const md = String(kd.body_md || '').replace(/^\s*#\s+.*\n+/, '');
    bodyEl.replaceChildren(
      ...(full && full !== short ? [el('p', { class: 'pn-knm-full', text: full })] : []),
      meta,
      ...(kd.summary ? [el('p', { class: 'pn-knm-sum', text: String(kd.summary) })] : []),
      el('div', { class: 'pn-md' }, renderMarkdown(md.slice(0, 6000))),
      ...(md.length > 6000 ? [el('p', { class: 'pn-fine', text: '…여기까지만 보여요. 전문은 [전체 보기]에서.' })] : []));
  }

  paint();
  return { root, tick: paint, destroy: () => { document.querySelector('.pn-knm')?.remove(); document.querySelectorAll('.pn-modal-back').forEach((n) => n.remove()); } };
}

// ══ 할 일 — 태스크 목록 ═══════════════════════════════════════════════════════
function tasksPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-tasks' });
  let sig = '';
  function paint(): void {
    const p = ctx.detail()?.project || {};
    const tasks: any[] = Array.isArray(p.tasks) ? p.tasks : [];
    const s2 = tasks.map((t) => t.id + (t.status_category || '') + (t.name || '')).join('|');
    if (s2 === sig) return;
    sig = s2;
    if (!tasks.length) {
      root.replaceChildren(el('div', { class: 'pn-empty' },
        pnIcon('task', 'pn-i big'),
        el('b', { text: '할 일이 아직 없어요.' }),
        el('p', { class: 'pn-fine', text: '프로젝트 정보에서 더하거나, 세션에 "태스크로 나눠 줘"라고 시켜 보세요.' })));
      return;
    }
    const done = tasks.filter((t) => t.status_category === 'done').length;
    root.replaceChildren(
      el('div', { class: 'pn-head' }, el('span', { class: 'pn-fine', text: `${done}/${tasks.length} 끝냈어요` })),
      el('div', { class: 'pn-tlist' }, ...tasks.map((t) => {
        const isDone = t.status_category === 'done';
        return el('div', { class: 'pn-trow' + (isDone ? ' done' : '') },
          el('button', {
            class: 'pn-tcheck' + (isDone ? ' on' : ''), type: 'button',
            'aria-pressed': String(isDone), title: isDone ? '아직 안 끝난 것으로 되돌립니다' : '끝냈다고 표시합니다',
            onclick: () => {
              void api('/api/ui/v6/tasks/' + t.id, { method: 'POST', body: JSON.stringify({ status: isDone ? 'todo' : 'done' }) })
                .then(() => { toast(isDone ? '다시 할 일로 되돌렸어요.' : '끝냈다고 표시했어요.'); ctx.onChanged?.(); })
                .catch((e: any) => toast('바꾸지 못했어요 — ' + (e?.message || e), true));
            },
          }),
          el('span', { class: 'n ell2', title: t.name, text: t.name || '이름 없는 할 일' }));
      })));
  }
  paint();
  return { root, tick: paint };
}

// ══ 타임라인 · 리브 ═══════════════════════════════════════════════════════════
// ══ 타임라인 — **이 세션의 발자취**(원준 2026-08-20) ══════════════════════════════
//  종전엔 프로젝트 한 벌이었다(loadProjectTimeline). 그런데 이 화면에서 사람이 보는 것은 늘 '지금 이 세션'이고,
//  옆 세션이 무엇을 했는지가 같은 자리에 섞이면 지금 시킨 일이 어디 있는지 알 수 없다.
//  대상은 **지금 보는 세션**이고 재료는 두 갈래다:
//   ① 그 세션의 트랜스크립트 — 세션 화면(session-chat)이 대화를 읽으며 흘려 준다. **내가 올린 지시(질문)가 여기 있다.**
//   ② 그 세션이 서버에 남긴 작업 기록(activity_log) — 트랜스크립트와 별개의 정본.
//  ①의 그릇(발자취 위젯)은 셸(panes.ts)이 세션마다 쥔다 — 칸을 닫았다 열어도 그 세션이 한 일이 남아 있으려면
//  그릇이 이 부품보다 오래 살아야 하기 때문이다. 여기서는 그 자리를 몸에 들이고, 세션이 바뀌면 다시 들인다.
function timelinePart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-tl' });
  const empty = el('div', { class: 'pn-empty' },
    pnIcon('clock', 'pn-i big'),
    el('b', { text: '아직 보고 있는 세션이 없어요.' }),
    el('p', { class: 'pn-fine', text: '세션을 하나 열면 그 세션에 시킨 일과 남긴 것이 여기 시간순으로 쌓입니다.' }));
  // 발자취는 **한 벌뿐**이라 자리도 하나다. 같은 타임라인을 두 칸에 놓으면 보이는 칸이 임자고, 나머지 칸은
  //  뺏지 않고 그렇다고 말한다 — 서로 뺏으면 8초마다 발자취가 이 칸 저 칸으로 튄다.
  const elsewhere = el('div', { class: 'pn-empty' },
    pnIcon('clock', 'pn-i big'),
    el('b', { text: '이 세션의 발자취는 다른 칸에 떠 있어요.' }),
    el('p', { class: 'pn-fine', text: '발자취는 한 벌이라 한 칸에만 뜹니다. 그 칸을 닫거나 다른 탭으로 바꾸면 이 자리로 옵니다.' }));
  const show = (node: HTMLElement): void => { if (root.firstChild !== node) root.replaceChildren(node); };
  function paint(): void {
    if (!ctx.curSession()) { show(empty); return; }
    const host = ctx.trailHost();
    if (host.parentElement === root) return;                                 // 내가 들고 있다
    if (host.isConnected && host.offsetParent) { show(elsewhere); return; }   // 보이는 칸이 임자다
    show(host);
  }
  const off = ctx.onSession(() => paint());
  paint();
  return { root, tick: () => paint(), destroy: () => off() };
}

function livPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-liv' });
  let chat: ProjectChatHandle | null = null;
  if (ctx.id > 0) chat = mountProjectChat(root, { projectId: ctx.id, onTurnDone: () => ctx.onChanged?.() });
  else root.append(el('p', { class: 'pn-fine', text: '프로젝트가 없는 화면이라 리브 대화는 열 수 없어요.' }));
  return { root, destroy: () => chat?.destroy?.() };
}

// ══ 보관한 세션 — 닫아 둔 세션을 대화 그대로 되살리는 자리(#1719 원준 2026-08-20) ═══════════
//  세션 탭의 ×(보관)가 여기로 보낸다. 서버는 tmux 만 내리고 좌표·대화 id 를 DB 에 남긴다(DELETE ?reclaim=1) —
//  그 상태가 곧 'restorable' 이고, [되살리기](POST …/restore)가 저장된 설정 그대로 다시 만들어 --resume 으로 대화를 잇는다.
//  ⚠ 세 가지가 섞여 보인다: ① 보관됨(되살릴 수 있음) ② 그냥 끝난 세션 ③ 기록만 남은 대화(중앙 기록).
//   ①만 되살리기가 되고, ②③은 '대화 보기'만 된다 — 버튼을 상태별로 갈라 두어 눌러 보고 실패하는 일이 없게 한다.
function archivePart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-arch' });
  let sig = '';
  let workingId = '';
  const mine = (): Sess[] => ctx.data().sessions
    .filter((s) => (ctx.id > 0 ? Number(s.projectId) === ctx.id : !s.projectId))
    .filter((s) => !(s.live && s.alive))
    .filter((s) => !s.trashedAt)   // 휴지통에 있는 건 여기 없다(#1851) — 휴지통 화면이 그 자리
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  const canRestore = (s: Sess): boolean => !!(s.raw && s.raw.restorable);

  async function restore(s: Sess): Promise<void> {
    if (workingId) return;
    workingId = s.id; sig = ''; paint();
    try {
      const r: any = await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/restore', { method: 'POST' });
      toast('세션을 되살렸어요 — 대화가 이어집니다.');
      ctx.onChanged?.();
      // #1820 — 되살린 세션은 **새 id** 를 받는다. 그 화면으로 데려가지 않으면 "되살렸다는데 어디 있지?"가 된다
      //  (이 목록에서는 사라지고, 사용자는 사이드바를 뒤져야 했다). 생성 응답을 캐시에 남겨 라우트가 곧바로 그린다.
      const ns = r && r.session;
      if (ns && ns.id) { rememberCreated(ns); location.hash = '#/s/' + encodeURIComponent(String(ns.id)); }
      else if (r && r.already) location.hash = '#/s/' + encodeURIComponent(s.id);
    } catch (e: any) {
      toast('되살리지 못했어요 — ' + (e && e.message ? e.message : e), true);
    } finally { workingId = ''; sig = ''; paint(); }
  }
  // 휴지통으로(#1851) — 종전엔 이 × 가 곧바로 '완전 삭제'(desired-state 제거)였다. 완전 삭제는 이제 휴지통 안에서만 한다.
  async function purge(s: Sess, name: string): Promise<void> {
    if (workingId) return;
    if (!await confirmSessionTrash({ title: `「${name}」${eulReul(name)} 휴지통으로 보낼까요?` })) return;
    workingId = s.id; sig = ''; paint();
    try {
      const r = await sessionTrashOp('trash', sessionNames(s));
      if (r.skipped.length && !r.done.length) throw new Error(r.skipped[0].why || '휴지통으로 보내지 못했습니다');
      toast('휴지통으로 보냈어요 — 사이드바 [휴지통]에서 되돌릴 수 있어요.');
      ctx.onChanged?.();
    } catch (e: any) {
      toast('휴지통으로 보내지 못했어요 — ' + (e && e.message ? e.message : e), true);
    } finally { workingId = ''; sig = ''; paint(); }
  }

  function paint(): void {
    const ss = mine();
    const s2 = ss.map((s) => s.id + ':' + (canRestore(s) ? 'r' : '-') + ':' + (s.lastSeen || 0)).join('|') + '#' + workingId;
    if (s2 === sig) return;
    sig = s2;
    if (!ss.length) {
      root.replaceChildren(el('div', { class: 'pn-empty' },
        pnIcon('box', 'pn-i big'),
        el('b', { text: '보관한 세션이 아직 없어요.' }),
        el('p', { class: 'pn-fine', text: '세션 머리줄 [⋯ ▸ 이 세션 보관]으로 담깁니다 — 대화는 그대로 남고, 언제든 되살릴 수 있어요.' })));
      return;
    }
    const rows = ss.map((s) => {
      const t = sessText(s, '').main || s.id;
      const busy = workingId === s.id;
      const keep = canRestore(s);
      return el('div', { class: 'pn-arow' + (busy ? ' busy' : '') },
        el('span', { class: 'v2-dot ' + (keep ? 'idle' : ''), 'aria-hidden': 'true' }),
        el('a', { class: 'n ell', href: '#/s/' + encodeURIComponent(s.id), title: t + ' — 대화를 봅니다' , text: t }),
        el('span', { class: 'pn-fine w', text: keep ? '보관됨' : '끝난 세션' }),
        ...(s.lastSeen ? [el('span', { class: 'pn-fine w', text: relTime(new Date(s.lastSeen).toISOString()) })] : []),
        ...(keep ? [el('button', {
          class: 'btn-text', type: 'button', disabled: busy, text: busy ? '되살리는 중…' : '되살리기',
          title: '저장해 둔 설정 그대로 다시 열고, 대화를 이어 붙입니다.', onclick: () => void restore(s),
        })] : [el('a', { class: 'btn-text', href: '#/s/' + encodeURIComponent(s.id), text: '대화 보기' })]),
        el('button', {
          class: 'pn-arow-x', type: 'button', title: '휴지통으로 보내기 — 휴지통에서 되돌리거나 완전히 지울 수 있어요', 'aria-label': `「${t}」 휴지통으로`,
          onclick: () => void purge(s, t),
        }, pnIcon('x', 'pn-i xs')));
    });
    root.replaceChildren(
      el('div', { class: 'pn-head' }, el('span', { class: 'pn-fine', text: ss.length + '건 · 되살릴 수 있는 것 ' + ss.filter(canRestore).length + '건' })),
      el('div', { class: 'pn-alist' }, ...rows));
  }
  paint();
  return { root, tick: paint };
}

// ══ 웹 — 이 칸을 작은 브라우저로(원준 2026-08-20) ═══════════════════════════════
//  왜 프레임 하나가 아니라 부품인가: 자료·지식과 같은 칸에 얹혀 **세션 옆에서 같이 보기** 위해서다.
//  ⚠ 정직하게 말해 둘 것 — 많은 사이트가 남의 창 안에 뜨는 것을 스스로 막는다(X-Frame-Options·CSP).
//   그건 우리가 뚫을 수 있는 것이 아니고(뚫으려면 서버가 남의 페이지를 대신 받아 오는 프록시가 되어야 하는데,
//   그건 로그인도 깨지고 보안상 열어서는 안 되는 문이다). 그래서 **빈 화면이면 새 탭으로**를 그 자리에 둔다.
/** 웹 칸에 실린 주소의 저장 열쇠 — 세션마다 따로다(webPart 와 같은 규칙을 써야 서로 어긋나지 않는다). */
const WEB_URL_KEY = 'pn_web_url';
/** "이 주소를 웹 칸에 실어라" — 칸이 아직 없으면 셸(panes.ts)이 듣고 칸부터 켠다.
 *  ⚠ 이 신호는 **곁칸 한 벌 안에서만** 돈다(ctx.paneRoot). 문서 전체로 뿌리면 다른 세션 탭까지 물든다. */
const WEB_OPEN_EVT = 'pn:open-web';
/** 밖(다른 부품)에서 웹 칸에 주소를 싣는 유일한 통로.
 *  ⚠ 저장을 **먼저** 한 다음 알린다 — 칸이 아직 없으면 셸이 그때 만드는데, 새로 만들어진 웹 칸은
 *   이벤트를 이미 놓친 뒤라 저장된 값에서 주소를 읽는다(둘 중 하나만 하면 '처음 한 번'이 조용히 안 먹는다).
 *  ⚠ 저장도 알림도 **이 곁칸의 것**으로 끝난다 — 저장은 이 곁칸이 보는 세션 열쇠 하나에만, 알림은
 *   이 곁칸 뿌리 안에만. 둘 중 하나라도 전역이면 옆 세션 탭이 같이 끌려간다. */
export function openInWebPart(ctx: PartCtx, url: string): void {
  const u = normWebUrl(url);
  if (!u) return;
  try {
    const m = JSON.parse(localStorage.getItem(WEB_URL_KEY) || '{}') || {};
    m[ctx.memKey()] = u;
    if (!EMBEDDED) localStorage.setItem(WEB_URL_KEY, JSON.stringify(m));
  } catch (_) { /* 저장이 막혀도 아래 알림으로 지금 떠 있는 칸은 바뀐다 */ }
  ctx.paneRoot().dispatchEvent(new CustomEvent(WEB_OPEN_EVT, { detail: { url: u } }));
}

function webPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-web' });
  const KEY = WEB_URL_KEY;
  // 재우기 상태(아래 '안 보이면 재운다') — 주소를 싣는 모든 길(load·adopt·reload)이 이걸 만지므로 맨 위에 둔다.
  //  ⚠ 아래쪽에 선언하면 adopt() 가 초기화 전에 읽어 TDZ 로 죽는다.
  let hiddenSince = 0;
  let asleep = '';                               // 재우기 전에 보던 주소('' = 깨어 있음)
  // 배율 — 세션마다 따로(곁칸 부품은 그 세션의 것). null = **폭 맞춤**(칸 폭에 맞춰 자동).
  const zooms = new Map<string, number | null>();
  const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  //  폭 맞춤의 기준 폭 — 데스크톱 배치가 통째로 들어오는 폭이다. 이보다 좁은 칸에서는 그만큼 줄여서
  //  **가로가 잘리지 않게** 보여 준다(원준 2026-08-21: "곁칸 가로 폭을 인식해서 가로화면이 잘리지 않게").
  const FIT_BASE = 1280;
  const store = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { return {}; } };
  // 주소는 **세션마다** 따로 기억한다 — 옆 세션에서 열어 둔 페이지가 이 세션 칸에 뜨면 그건 남의 화면이다(원준 2026-08-20).
  const keyOf = (): string => ctx.memKey();
  // 주소 정규화는 web-url.ts 한 곳에서 — 우리 오리진이면 ?embed=1 을 붙여 싣는다(표를 단 판은 탭·배치·주소를
  //  기억하지도 기억되지도 않는다. 안 붙이면 같은 사이트라 localStorage 를 공유해, 칸 안 라이블리가 바깥이
  //  보던 화면을 그대로 복제한다 — 실측 2026-08-21).
  const norm = normWebUrl;
  // 데스크톱 앱(#1829)에서는 <webview> 로 그린다 — 별도 WebContents 라 X-Frame-Options 검사의 대상이 아니다.
  //  능력 감지로 가른다(UA/플랫폼 추측 금지). 없으면 종전 iframe 그대로.
  const live = hasBrowserSurface();
  const frame = (live
    ? el('webview', { class: 'pn-webframe' })
    : el('iframe', { class: 'pn-webframe', referrerpolicy: 'no-referrer-when-downgrade' })) as HTMLElement;
  const input = el('input', { class: 'pn-web-in', type: 'text', placeholder: '주소 또는 검색어 — 예: docs.google.com', 'aria-label': '주소' }) as HTMLInputElement;
  // 주소칸을 누르면 통째로 잡힌다 — 긴 주소 중간에 커서가 꽂히면 다시 치기가 번거롭다(브라우저 관용).
  input.onfocus = () => input.select();

  // ── 다닌 길 — 뒤로·앞으로의 재료 (원준 2026-08-21 요청) ────────────────────────
  //  ⚠ 앱과 웹이 할 수 있는 일이 다르다. 데스크톱 앱의 <webview> 는 **진짜 방문기록**을 가져(별도 WebContents)
  //   사이트 안에서 링크를 눌러 이동한 것까지 뒤로 간다. 브라우저의 iframe 은 남의 사이트라 그 기록을 읽을 수도
  //   조작할 수도 없다(cross-origin) — 그래서 **이 칸이 실은 주소들**만으로 길을 만든다.
  //   못 하는 것을 하는 척하지 않는다: 갈 곳이 없으면 단추를 끈다(회색), 툴팁도 그 뜻으로 갈라 적는다.
  //  길은 **세션마다 따로**다 — 곁칸 부품은 그 세션의 것이라는 규칙 그대로(memKey).
  const trails = new Map<string, { urls: string[]; at: number }>();
  const trail = (): { urls: string[]; at: number } => {
    const k = keyOf();
    let t = trails.get(k);
    if (!t) { t = { urls: [], at: -1 }; trails.set(k, t); }
    return t;
  };
  const pushTrail = (u: string): void => {
    const t = trail();
    if (t.urls[t.at] === u) return;      // 같은 주소를 다시 = 새로고침이지 이동이 아니다
    t.urls.splice(t.at + 1);             // 뒤로 간 뒤 새 곳으로 가면 앞길은 사라진다(브라우저와 같다)
    t.urls.push(u);
    t.at = t.urls.length - 1;
  };
  /** 이 칸에 주소를 싣는 **유일한 자리** — 주소칸·기억·다닌 길·단추 상태가 한 번에 맞는다. */
  const load = (u: string, record: boolean): void => {
    asleep = '';                                 // 사람이 새 주소로 갔다 — 재우기 전 주소로 되돌릴 이유가 없어졌다
    input.value = u;
    frame.setAttribute('src', u);
    if (record) pushTrail(u);
    syncNav();
    // ⚠ 끼워 넣은 판(미리보기 프레임 안)에서는 **기억하지 않는다** — 저장소를 바깥과 공유하므로
    //  여기서 저장하면 바깥 사람이 그 세션에서 보던 주소를 덮어쓴다.
    if (EMBEDDED) return;
    const m = store(); m[keyOf()] = u;
    try { localStorage.setItem(KEY, JSON.stringify(m)); } catch (_) { /* noop */ }
  };
  const go = (raw?: string): void => {
    const u = norm(raw ?? input.value);
    if (!u) return;
    load(u, true);
  };
  const step = (d: -1 | 1): void => {
    if (live) {
      const v = frame as any;
      try { if (d < 0 ? v.canGoBack?.() : v.canGoForward?.()) { if (d < 0) v.goBack(); else v.goForward(); return; } } catch (_) { /* 아래 길로 */ }
    }
    const t = trail();
    const i = t.at + d;
    if (i < 0 || i >= t.urls.length) return;
    t.at = i;
    load(t.urls[i], false);              // 길 위를 걷는 것이지 새 길을 내는 게 아니다
  };
  // 지금 프레임에 실린 **그 주소를 다시** 싣는다 — go() 는 주소칸의 글자로 '가는' 것이라 뜻이 다르다.
  //  같은 주소를 src 에 그대로 넣는 것만으로는 #조각만 다른 주소에서 다시 싣지 않으므로, 남의 사이트면 빈 화면을 한 번 거친다.
  const reload = (): void => {
    if (asleep) { const u0 = asleep; asleep = ''; frame.setAttribute('src', u0); return; }   // 자고 있었다 → 깨우는 것이 곧 다시 싣기다
    const u = frame.getAttribute('src') || norm(input.value);
    if (!u) return;
    // 프레임은 둘 중 하나다(위 live). ⚠ webview 엔 contentWindow 가 없어 iframe 길로 가면 `?.` 가 조용히 빠지고
    //  그대로 return 된다 — '다시 불러오기'가 아무 일도 안 한다(무동작은 오동작보다 찾기 어렵다, desktop 계약 테스트가 이 분기를 지킨다).
    if (live) { try { (frame as any).reload(); return; } catch (_) { /* 아래로 */ } }
    try { (frame as HTMLIFrameElement).contentWindow?.location.reload(); return; } catch (_) { /* 남의 사이트 — 안쪽에 시킬 수 없다. 아래로 */ }
    frame.setAttribute('src', 'about:blank');   // 같은 주소를 그대로 넣으면 #조각만 다른 경우 다시 싣지 않는다
    window.setTimeout(() => { if (frame.isConnected) frame.setAttribute('src', u); }, 0);
  };
  input.onkeydown = (e: KeyboardEvent) => { if (!e.isComposing && e.key === 'Enter') { e.preventDefault(); go(); } };
  // 밖에서 부른 주소 — 미리보기 칸에서 누른 것이 여기로 온다. 칸이 이미 떠 있으면 이 경로로 갈아 끼운다.
  const onOpen = (e: Event): void => { const u = (e as CustomEvent).detail?.url; if (u) go(String(u)); };
  //  ⚠ `document` 가 아니라 **이 곁칸 뿌리**에서 듣는다 — 문서에 달면 열려 있는 모든 세션 탭의 웹 칸이
  //   같은 신호를 받아 다 같이 그 주소로 갈아입는다(그리고 저마다 자기 세션 열쇠에 그걸 저장한다).
  const evtHost = ctx.paneRoot();
  evtHost.addEventListener(WEB_OPEN_EVT, onOpen);
  const openTab = el('a', { class: 'pn-web-btn ic', target: '_blank', rel: 'noopener', title: '지금 주소를 새 탭에서 엽니다.', 'aria-label': '새 탭에서 열기', href: '#' }, pnIcon('ext', 'pn-i sm')) as HTMLAnchorElement;
  openTab.onclick = (e: Event) => { const u = norm(input.value); if (!u) { e.preventDefault(); return; } openTab.href = u; };
  // 뒤로·앞으로·다시 불러오기 — 브라우저와 같은 순서·같은 자리(왼쪽 묶음). 주소칸이 그 오른쪽을 다 쓴다.
  const backBtn = el('button', { class: 'pn-web-btn ic', type: 'button', 'aria-label': '뒤로',
    title: live ? '앞 화면으로 돌아갑니다.' : '이 칸에서 앞서 열었던 주소로 돌아갑니다.',
    onclick: () => step(-1) }, pnIcon('chev', 'pn-i sm')) as HTMLButtonElement;
  backBtn.classList.add('back');
  const fwdBtn = el('button', { class: 'pn-web-btn ic', type: 'button', 'aria-label': '앞으로',
    title: live ? '뒤로 오기 전 화면으로 갑니다.' : '뒤로 오기 전에 보던 주소로 다시 갑니다.',
    onclick: () => step(1) }, pnIcon('chev', 'pn-i sm')) as HTMLButtonElement;
  // 배율 조절 — [－][지금 배율][＋]. 가운데를 누르면 **폭 맞춤 ↔ 100%** 를 오간다(브라우저에서 배율을 눌러 되돌리는 관용).
  //  ⚠ [열기] 단추는 뺐다(원준 2026-08-21 재배치) — 주소칸에서 Enter 가 같은 일을 하고, 좁은 곁칸에서 그 자리는
  //   주소가 보이는 폭이 더 값지다. 밖으로 내보내는 [↗]는 그대로 둔다(그건 Enter 로 못 하는 일이다).
  const zoomOut = el('button', { class: 'pn-web-btn ic', type: 'button', title: '축소합니다.', 'aria-label': '축소', onclick: () => stepZoom(-1) }) as HTMLButtonElement;
  zoomOut.textContent = '−';
  const zoomIn = el('button', { class: 'pn-web-btn ic', type: 'button', title: '확대합니다.', 'aria-label': '확대', onclick: () => stepZoom(1) }) as HTMLButtonElement;
  zoomIn.textContent = '+';
  const zoomLbl = el('button', { class: 'pn-web-btn zl', type: 'button', onclick: () => { setZoom(zooms.get(keyOf()) == null ? 1 : null); } }) as HTMLButtonElement;
  const stage = el('div', { class: 'pn-webstage' }, frame);
  root.append(
    el('div', { class: 'pn-web-bar' },
      el('span', { class: 'pn-web-navs' },
        backBtn, fwdBtn,
        el('button', { class: 'pn-web-btn ic', type: 'button', title: '이 칸만 다시 불러옵니다 — ⌘R(윈도는 Ctrl+R)도 같습니다.', 'aria-label': '다시 불러오기', onclick: () => reload() }, pnIcon('undo', 'pn-i sm'))),
      input,
      el('span', { class: 'pn-web-navs' }, zoomOut, zoomLbl, zoomIn),
      openTab),
    stage,
    live ? null : el('p', { class: 'pn-web-note pn-fine', text: '빈 화면인가요? 그 사이트가 창 안에 뜨는 걸 막은 거예요 — 오른쪽 ↗ 로 새 탭에서 여세요. 데스크톱 앱에서는 이 칸 안에 그대로 뜹니다.' }));
  /** 지금 실제로 걸리는 배율 — 폭 맞춤이면 칸 폭에서 계산한다(1 을 넘겨 키우지는 않는다). */
  function effZoom(): number {
    const z = zooms.get(keyOf());
    if (z != null) return z;
    const w = stage.clientWidth || root.clientWidth || FIT_BASE;
    return Math.max(0.25, Math.min(1, Math.round((w / FIT_BASE) * 100) / 100));
  }
  /** 배율을 화면에 입힌다. 앱은 <webview> 의 진짜 배율, 웹은 프레임을 넓게 잡고 줄여 그린다.
   *  ⚠ 웹(iframe)에서 폭을 그대로 두고 축소만 하면 오른쪽에 빈 자리가 생긴다 — **논리 폭을 1/배율 로 키워야**
   *   사이트가 그만큼 넓은 화면인 줄 알고 데스크톱 배치를 펴고, 그게 칸 안에 통째로 들어온다. */
  function applyZoom(): void {
    const z = effZoom();
    const fit = zooms.get(keyOf()) == null;
    zoomLbl.textContent = fit ? '맞춤' : Math.round(z * 100) + '%';
    zoomLbl.title = fit
      ? '칸 폭에 맞춰 자동으로 줄입니다 — 누르면 100% 로 돌아갑니다.'
      : Math.round(z * 100) + '% 로 보고 있습니다 — 누르면 칸 폭에 맞춥니다.';
    zoomOut.disabled = z <= ZOOM_STEPS[0] + 0.001;
    zoomIn.disabled = z >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.001;
    if (live) {
      try { (frame as any).setZoomFactor?.(z); } catch (_) { /* 아직 안 붙었다 — dom-ready 에서 다시 건다 */ }
      frame.removeAttribute('style');
      return;
    }
    const pct = (100 / z).toFixed(4) + '%';
    frame.setAttribute('style', `width:${pct};height:${pct};transform:scale(${z});`);
  }
  function setZoom(z: number | null): void { zooms.set(keyOf(), z); applyZoom(); }
  function stepZoom(d: -1 | 1): void {
    const cur = effZoom();
    const i = ZOOM_STEPS.findIndex((v) => (d > 0 ? v > cur + 0.001 : v >= cur - 0.001));
    const next = d > 0
      ? (i < 0 ? ZOOM_STEPS[ZOOM_STEPS.length - 1] : ZOOM_STEPS[i])
      : (i <= 0 ? ZOOM_STEPS[0] : ZOOM_STEPS[i - 1]);
    setZoom(next);
  }

  /** 단추가 갈 수 있는지 — 갈 데가 없으면 끈다(눌러도 아무 일 없는 단추를 켜 두지 않는다). */
  function syncNav(): void {
    if (live) {
      const v = frame as any;
      try { backBtn.disabled = !v.canGoBack?.(); fwdBtn.disabled = !v.canGoForward?.(); return; } catch (_) { /* 아직 안 붙었다 — 아래 길로 */ }
    }
    const t = trail();
    backBtn.disabled = t.at <= 0;
    fwdBtn.disabled = t.at < 0 || t.at >= t.urls.length - 1;
  }
  // 앱의 <webview> 는 스스로도 움직인다(사이트 안 링크·리다이렉트·SPA 라우팅) — 그때마다 주소칸과 단추를 맞춘다.
  if (live) {
    const sync = (): void => {
      try { const u = (frame as any).getURL?.(); if (u && u !== 'about:blank') input.value = u; } catch (_) { /* noop */ }
      syncNav();
    };
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'did-finish-load', 'dom-ready']) frame.addEventListener(ev, sync);
  }

  // 이 세션이 보던 주소로 맞춘다 — 세션을 갈아 끼우면 그 세션이 보던 페이지로 갈아입는다(아무것도 없으면 빈 칸).
  //  길도 그 세션의 것으로 바뀐다(trail 이 memKey 로 갈린다) — 옆 세션에서 다닌 길로 뒤로 가면 그게 남의 화면이다.
  function adopt(): void {
    asleep = '';                                 // 세션이 바뀌면 그 세션의 주소가 정답이다(재우기 전 주소는 남의 것)
    const u = store()[keyOf()] || '';
    const t = trail();
    if (u && t.urls[t.at] !== u) pushTrail(u);      // 이 세션의 길이 비어 있으면 지금 주소를 첫 걸음으로
    if (u === (frame.getAttribute('src') || '')) { input.value = u; syncNav(); return; }
    input.value = u;
    if (u) frame.setAttribute('src', u); else frame.removeAttribute('src');
    syncNav();
  }
  adopt();
  applyZoom();
  // 칸 폭이 바뀌면(경계 끌기·곁칸 여닫기·창 크기) 폭 맞춤을 다시 잰다 — '맞춤'은 고정값이 아니라 관계다.
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (zooms.get(keyOf()) == null) applyZoom(); }) : null;
  ro?.observe(stage);
  if (live) frame.addEventListener('dom-ready', () => applyZoom());
  const offSess = ctx.onSession(() => { adopt(); applyZoom(); });

  // ── 안 보이면 재운다 (원준 2026-08-21 신고: "웹에 뭘 띄워 놓으면 그 다음부터 랙이 걸린다") ─────────
  //  프레임 안 페이지는 **칸을 안 보고 있어도 계속 돈다** — 타이머·폴링·애니메이션·영상이 그대로 살아서
  //  같은 화면(같은 렌더러 프로세스)의 자원을 나눠 쓴다. 특히 **라이블리 자신을 띄우면 앱이 한 벌 더 도는 셈**이다
  //  (실측 2026-08-21 dev: 프리뷰를 칸에 띄우자 DOM 1,835→7,119 노드 · 이벤트 리스너 319→1,245 개,
  //   바깥과 안쪽이 같은 API 를 각자 폴링). 셸은 탭을 갈아 끼워도 이전 탭을 살려 두므로(대화 보존이 그 설계의 목적)
  //  띄워 둔 칸이 쌓일수록 그 값이 계속 붙는다.
  //  그래서 **안 보이는 동안만** 프레임을 비우고(about:blank) 다시 보일 때 그 주소로 되돌린다.
  //  ⚠ 곧바로 재우지 않는다 — 탭을 잠깐 오갈 때마다 안쪽 페이지가 다시 로드되면 그게 더 나쁘다(스크롤·입력이 날아간다).
  //   유예를 두고, 그 안에 돌아오면 아무 일도 없던 것처럼 그대로다.
  const SLEEP_AFTER_MS = 30000;
  const visible = (): boolean => !!root.isConnected && root.getClientRects().length > 0;
  const wake = (): void => {
    if (!asleep) return;
    const u = asleep;
    asleep = '';
    frame.setAttribute('src', u);                // 재우기 전 그 주소로 — 다닌 길·주소칸은 그대로였다
  };
  const sleep = (): void => {
    const u = frame.getAttribute('src') || '';
    if (!u || u === 'about:blank') return;
    asleep = u;
    frame.setAttribute('src', 'about:blank');    // 안쪽 페이지를 통째로 내린다(타이머·폴링·소켓이 함께 끊긴다)
  };
  const watch = window.setInterval(() => {
    if (visible()) { hiddenSince = 0; wake(); return; }
    if (asleep) return;
    if (!hiddenSince) { hiddenSince = Date.now(); return; }
    if (Date.now() - hiddenSince >= SLEEP_AFTER_MS) sleep();
  }, 5000);

  // ── ⌘R 은 이 칸만(원준 2026-08-20 신고: "웹을 고른 채 새로고침하면 화면 전체가 다시 실린다") ─────
  //  ⌘R 은 본디 브라우저의 것이다. 이 칸이 열려 있다는 이유만으로 늘 뺏으면 세션·자료를 보던 사람의 새로고침까지 먹는다.
  //  그래서 **마지막으로 만진 칸이 여기일 때만** 가로챈다 — 탭을 눌러 이 칸을 고른 것도 '만진' 것이다(신고된 그 상황이다).
  //  ⇧⌘R 은 일부러 두었다 — 화면 전체를 다시 싣는 탈출구가 하나는 있어야 한다.
  //  ⚠ 못 하는 것을 할 수 있는 척하지 않는다: 프레임 **안**(남의 사이트)을 누른 뒤의 ⌘R 은 그 사이트 문서로 가고
  //   우리에게 오지 않는다(cross-origin 프레임의 키 입력은 부모로 새지 않는다 — 뚫을 수 있는 문이 아니다).
  //   그 때는 주소칸을 한 번 누르고 ⌘R, 또는 왼쪽 ↺ 를 누르면 된다. 전체가 다시 실려도 이 칸 주소는 저장해 두었으니 같은 자리로 돌아온다.
  //  데스크톱 앱의 <webview>(#1829) 안쪽도 같은 한계다 — 별도 WebContents 라 그 안의 키는 우리에게 오지 않는다.
  let mine = false;
  const paneOf = (): HTMLElement => (root.closest('.pn-pane') as HTMLElement | null) || root;
  const mark = (e: Event): void => { const t = e.target; mine = t instanceof Node && paneOf().contains(t); };
  const onKey = (e: KeyboardEvent): void => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (String(e.key).toLowerCase() !== 'r' && e.code !== 'KeyR') return;   // 한글 자판에서도 같게 — e.key 가 늘 'r' 로 오지는 않는다
    if (!mine || root.hidden || !root.offsetParent) return;                 // 다른 칸을 보고 있거나 이 칸이 접혀 있으면 내 차례가 아니다
    e.preventDefault();
    reload();
  };
  document.addEventListener('pointerdown', mark, true);
  document.addEventListener('focusin', mark, true);
  window.addEventListener('keydown', onKey, true);
  return {
    root,
    // 칸이 다시 보이면 셸이 알려 준다 — 5초 감시를 기다리지 않고 그 자리에서 깨운다.
    tick: () => { if (visible()) { hiddenSince = 0; wake(); } },
    destroy: () => {
      offSess();
      ro?.disconnect();
      window.clearInterval(watch);
      evtHost.removeEventListener(WEB_OPEN_EVT, onOpen);
      document.removeEventListener('pointerdown', mark, true);
      document.removeEventListener('focusin', mark, true);
      window.removeEventListener('keydown', onKey, true);
    },
  };
}

// ══ 뷰어 — 자료의 파일을 이 칸에 띄워 본다 (#1819) ══════════════════════════════
//  이름이 '파일 편집'이었을 땐 무엇을 하는 칸인지 이름에서 안 읽혔고(원준 2026-08-20 "뭔지 감이 안 온다"),
//  실제로 고칠 수 있는 형식은 글 파일뿐이라 이름이 하는 약속이 대부분 거짓이었다. **보는 것**으로 좁힌다.
//
//  파일 고르기는 드롭다운이 아니다 — 드롭다운은 200개를 한 줄 구멍으로 보게 하고, 이름만 있고 종류·시각이
//  없어 "그 파일이 어느 거였는지" 못 고른다(원준 신고). 대신 **자료 목록을 그대로 칸에 편다**: 검색 + 최근 먼저 +
//  종류·크기·시각. 파일을 고르면 그 자리에서 미리보기로 바뀌고, [← 자료]로 목록에 돌아온다.
//
//  올리기도 이 칸에서 한다(원준 2026-08-21) — 보려는 파일이 아직 자료에 없으면 [자료] 칸을 따로 띄워 올리고
//  다시 돌아와야 했다. 올린 파일은 **자료와 같은 곳**(프로젝트 공유 폴더)에 그대로 저장된다 — 뷰어만의 사본이나
//  보관함 같은 건 만들지 않는다. 그래서 올리는 즉시 자료 칸에도 뜨고, 이 프로젝트의 세션들도 곧바로 참고한다.
//  올린 뒤엔 그 파일을 이 칸이 바로 펴 준다(올린 이유는 보려는 것이다).
const VIEWER_EVT = 'pn-viewer-open';   // 자료 칸의 우클릭 ▸ [뷰어에서 보기] 가 **그 곁칸에 대고** 쏘는 신호(window 금지)
type FlatFile = { path: string; size: number; mtime: number };   // 뷰어는 폴더를 다루지 않는다 — 평평한 매니페스트 한 줄
function viewerPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-ed' });
  const KEY = 'pn_ed_path';
  const bar = el('div', { class: 'pn-ed-bar' });
  const body = el('div', { class: 'pn-ed-body' });
  root.append(bar, body);
  let list: FlatFile[] = [];
  let path = '';
  let q = '';
  //  덮어쓰기 판정에 쓰는 **실제로 있는 것 전부**(list 는 휴지통·잡동사니를 걸러 낸 화면용이라 이름 자리를 놓친다).
  let taken = new Set<string>();
  const urls: string[] = [];
  const fileUrl = (p2: string): string => apiUrl('/api/ui/v6/projects/' + ctx.id + '/file?path=' + encodeURIComponent(p2));
  // 무엇을 열어 두었나도 **세션마다** 따로 — 자료(파일 자체)는 프로젝트 공용이지만, '내가 지금 뭘 펴 놨나'는 내 세션의 것이다.
  const remember = (p2: string): void => {
    if (EMBEDDED) return;   // 끼워 넣은 판 — 바깥 사람이 펴 둔 파일을 덮어쓰지 않는다
    try { const m = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; m[ctx.memKey()] = p2; localStorage.setItem(KEY, JSON.stringify(m)); } catch (_) { /* noop */ }
  };
  const remembered = (): string => {
    try { return (JSON.parse(localStorage.getItem(KEY) || '{}') || {})[ctx.memKey()] || ''; } catch (_) { return ''; }
  };

  async function loadList(): Promise<void> {
    const m: any = await api('/api/ui/v6/projects/' + ctx.id + '/shared/manifest').catch(() => null);
    const all = (((m && m.files) || []) as any[])
      .map((f) => ({ path: String(f.path), size: Number(f.size || 0), mtime: Number(f.mtime || 0) }));
    taken = new Set(all.map((f) => f.path));
    list = all
      .filter((f) => !f.path.startsWith(TRASH_DIR + '/') && !NOISE_RE.test('/' + f.path))
      .sort((a, b) => b.mtime - a.mtime);
  }

  // ── 올리기 — 받는 곳은 자료 칸과 **같은 API**(프로젝트 공유 폴더)다 ────────────
  //  폴더는 이 칸이 다루지 않지만, 끌어다 놓은 폴더는 그대로 받아 자료에 구조째 넣는다(막을 이유가 없다).
  //  뷰어는 평평한 목록이라 그 안의 파일들이 한 줄씩 보인다.
  const upIn = el('input', { type: 'file', multiple: 'true', hidden: true }) as HTMLInputElement;
  upIn.addEventListener('change', () => { const picked = upFromInput(upIn); upIn.value = ''; void upload(picked); });
  root.append(upIn);
  const UP_TITLE = '컴퓨터에서 파일을 고릅니다 — 자료에 저장되고 이 칸에서 바로 열려요';
  /** 올리기 버튼. 목록에선 글자까지, 파일을 보는 중인 좁은 바에선 아이콘만(할 수 있는 일은 같다). */
  const upBtn = (withText: boolean): HTMLElement => el('button', {
    class: 'pn-web-btn', type: 'button', title: UP_TITLE, 'aria-label': '파일 올리기', onclick: () => upIn.click(),
  }, pnIcon('up', 'pn-i sm'), ...(withText ? [el('span', { text: '올리기' })] : []));

  async function upload(items: UpItem[], emptyDirs: string[] = []): Promise<void> {
    if (!items.length && !emptyDirs.length) return;
    if (!(ctx.id > 0)) { toast('이 화면은 프로젝트 폴더가 없어 파일을 둘 곳이 없어요.', true); return; }
    //  같은 이름이 이미 있으면 **묻고 나서** 덮는다 — 자료는 이 프로젝트의 모든 세션이 읽는 공용물이라
    //  조용히 갈아 끼우면 남의 근거가 소리 없이 바뀐다.
    const over = items.filter((u) => taken.has(u.rel));
    if (over.length && !(await confirmDialog({
      title: over.length === 1 ? `「${base(over[0].rel)}」를 덮어쓸까요?` : `이미 있는 자료 ${over.length}개를 덮어쓸까요?`,
      message: '자료에 같은 이름이 이미 있어요. 덮어쓰면 예전 파일은 되돌릴 수 없습니다.',
      lines: over.slice(0, 8).map((u) => '• ' + u.rel).concat(over.length > 8 ? ['…외 ' + (over.length - 8) + '개'] : []),
      confirmText: '덮어쓰기', danger: true,
    }))) return;
    const ac = new AbortController();
    toast(items.length > 1 ? items.length + '개를 올리는 중이에요…' : '올리는 중이에요…');
    const r = await upSend({
      items, emptyDirs, signal: ac.signal,
      fileUrl: (p2) => '/api/ui/v6/projects/' + ctx.id + '/file?path=' + encodeURIComponent(p2),
      dirUrl: (d) => '/api/ui/v6/projects/' + ctx.id + '/folder?path=' + encodeURIComponent(d),
    });
    if (ctx.dead()) return;
    upToast(r);
    await loadList();
    // 올린 이유는 **보려고**다 — 방금 올라간 것 중 첫 파일을 그 자리에서 편다(여럿이면 목록 맨 위에 모여 있다).
    const first = r.ok ? items.find((u) => list.some((f) => f.path === u.rel)) : null;
    if (first) { void open(first.rel); return; }
    if (!path) paintPicker();
    paintBar();
  }

  function paintBar(): void {
    if (!path) {
      bar.replaceChildren(upBtn(true), el('span', { class: 'pn-fine', text: list.length ? list.length + '개 · 최근 먼저' : '' }));
      return;
    }
    bar.replaceChildren(
      el('button', { class: 'pn-web-btn', type: 'button', text: '← 자료', title: '파일 목록으로 돌아갑니다', onclick: () => void open('') }),
      el('b', { class: 'pn-ed-name ell', text: base(path), title: path }),
      upBtn(false),
      el('a', { class: 'pn-web-btn', href: fileUrl(path) + '&download=1', download: base(path), title: '내려받기' }, pnIcon('drop', 'pn-i sm')));
  }

  /** 자료 목록 — 이 칸이 '무엇을 열까'를 묻는 화면. 검색 한 칸 + 행 목록(종류·크기·시각). */
  function paintPicker(): void {
    const search = el('input', {
      class: 'pn-ed-find', type: 'search', value: q, placeholder: '자료 찾기 — 이름 일부', 'aria-label': '자료 찾기',
    }) as HTMLInputElement;
    // 다시 그리면 IME 조합이 끊긴다 — 목록만 갈아 끼운다.
    const rows = el('div', { class: 'pn-flist' });
    const draw = (): void => {
      const needle = q.trim().toLowerCase();
      const hit = list.filter((f) => !needle || f.path.toLowerCase().includes(needle));
      if (!hit.length) {
        rows.replaceChildren(el('div', { class: 'pn-empty' },
          pnIcon(list.length ? 'doc' : 'up', 'pn-i big'),
          el('b', { text: list.length ? '찾는 자료가 없어요.' : '아직 자료가 없어요.' }),
          el('p', { class: 'pn-fine', text: list.length
            ? '이름 일부로 다시 찾아보세요.'
            : '파일을 이 칸에 끌어다 놓거나 [올리기]를 누르세요 — 올린 파일은 자료에도 그대로 쌓입니다.' }),
          ...(list.length ? [] : [upBtn(true)])));
        return;
      }
      rows.replaceChildren(...hit.slice(0, 300).map((f) => {
        const k = kindOf(f.path);
        return el('button', { class: 'pn-frow2', type: 'button', title: f.path, onclick: () => void open(f.path) },
          el('span', { class: 'pn-fic sm ' + k.kind }, pnIcon(k.kind === 'img' || k.kind === 'video' ? 'img' : 'doc', 'pn-i')),
          el('b', { class: 'pn-fname1', text: base(f.path) }),
          el('span', { class: 'pn-fcol k', text: k.type }),
          el('span', { class: 'pn-fcol s', text: fmtSize(f.size || 0) }),
          el('span', { class: 'pn-fcol d', text: f.mtime ? relTime(new Date(f.mtime).toISOString()) : '' }));
      }));
    };
    search.addEventListener('input', () => { q = search.value; draw(); });
    draw();
    body.replaceChildren(el('div', { class: 'pn-ed-pick2' }, search, rows));
    window.setTimeout(() => { if (q) search.focus(); }, 0);
  }

  async function open(p2: string): Promise<void> {
    path = p2;
    remember(p2);
    paintBar();
    if (!p2) { paintPicker(); return; }
    const k = kindOf(p2);
    body.replaceChildren(el('p', { class: 'pn-fine', style: 'padding:14px', text: '여는 중…' }));
    if (k.kind === 'text' || k.kind === 'page') {
      const r = await fetch(fileUrl(p2), { headers: authHeaders() }).catch(() => null);
      if (!r || !r.ok) { body.replaceChildren(el('p', { class: 'pn-fine', style: 'padding:14px', text: '파일을 읽지 못했어요.' })); return; }
      const txt = await r.text();
      if (path !== p2) return;                       // 그 사이 다른 걸 골랐다
      if (k.kind === 'page') {
        // 시안(HTML)은 격리 프레임(srcdoc)으로 — 스크립트·폼·상위 접근이 모두 막힌 채 그림만 보인다.
        const f = el('iframe', { class: 'pn-ed-pv full', sandbox: '', tabindex: '-1' }) as HTMLIFrameElement;
        f.srcdoc = txt.slice(0, 400_000);
        body.replaceChildren(f);
      } else if (/\.(md|markdown)$/i.test(p2)) {
        body.replaceChildren(el('div', { class: 'pn-md' }, renderMarkdown(txt.slice(0, 200_000))));
      } else {
        body.replaceChildren(el('pre', { class: 'pn-ed-pre', text: txt.slice(0, 400_000) }));
      }
      return;
    }
    if (k.kind === 'img' || k.kind === 'pdf' || k.kind === 'video') {
      const r = await fetch(fileUrl(p2), { headers: authHeaders() }).catch(() => null);
      if (!r || !r.ok) { body.replaceChildren(el('p', { class: 'pn-fine', style: 'padding:14px', text: '파일을 읽지 못했어요.' })); return; }
      const bl = await r.blob();
      if (path !== p2) return;
      const u = URL.createObjectURL(k.kind === 'pdf' ? new Blob([bl], { type: 'application/pdf' }) : bl);
      urls.push(u);
      body.replaceChildren(k.kind === 'img'
        ? el('img', { class: 'pn-ed-img', src: u, alt: base(p2) })
        : k.kind === 'video'
          ? el('video', { class: 'pn-ed-img', src: u, controls: 'true' })
          : el('iframe', { class: 'pn-ed-pv full', src: u + '#toolbar=1&view=FitH' }));
      return;
    }
    // 브라우저가 그릴 방법이 없는 형식 — 할 수 있는 것(내려받기)만 정직하게 말한다.
    body.replaceChildren(el('div', { class: 'pn-empty' },
      pnIcon('doc', 'pn-i big'),
      el('b', { text: '이 형식은 브라우저에서 볼 수 없어요.' }),
      el('p', { class: 'pn-fine', text: '파워포인트·워드·엑셀·한글은 브라우저가 그릴 방법이 없습니다. 위 [내려받기]로 원래 앱에서 여세요.' })));
  }

  if (!(ctx.id > 0)) {
    body.replaceChildren(el('p', { class: 'pn-fine', style: 'padding:14px', text: '이 화면은 프로젝트 폴더가 없어 자료를 열 수 없어요.' }));
    return { root };
  }
  // 컴퓨터에서 끌어다 놓기 — 목록을 보든 파일을 펴 놓았든 이 칸 어디서나 받는다.
  //  (미리보기가 iframe 인 형식(PDF·시안) 위에 놓으면 브라우저가 프레임 쪽으로 보내므로 그때는 바의 [올리기]로 간다.)
  upDropZone(root, root, (dropped, emptyDirs) => void upload(dropped, emptyDirs));

  // 자료 칸에서 [뷰어에서 보기] 로 보낸 파일 — 이 칸이 받아 연다.
  const onSend = (e: Event): void => {
    const d = (e as CustomEvent).detail as { id: number; path: string } | undefined;
    if (!d || Number(d.id) !== ctx.id || !d.path) return;
    if (!list.some((f) => f.path === d.path)) void loadList();
    void open(d.path);
  };
  // ⚠ window 가 아니라 **이 곁칸**에서 듣는다 — 창에 달면 열려 있는 모든 세션 탭의 뷰어가 같이 갈아입는다.
  ctx.paneRoot().addEventListener(VIEWER_EVT, onSend);

  const openRemembered = (): void => {
    const last = remembered();
    void open(last && list.some((f) => f.path === last) ? last : '');
  };
  void loadList().then(() => openRemembered());
  // 세션을 갈아 끼우면 그 세션이 펴 두었던 파일로 — 단 **고치는 중이면 건드리지 않는다**(저장 안 한 글을 뺏지 않는다).
  const offSess = ctx.onSession(() => openRemembered());
  return {
    root,
    tick: () => { void loadList().then(() => { if (!path) paintPicker(); paintBar(); }); },
    destroy: () => { offSess(); ctx.paneRoot().removeEventListener(VIEWER_EVT, onSend); urls.forEach((u) => URL.revokeObjectURL(u)); },
  };
}

// ══ 앱 — 이 칸은 런처, 실제 앱은 AppInstance 상단 탭(#1780 v2.1) ════════════════
//  앱 UI를 이 pane에 직접 끼우면 한 실행이 어떤 때는 top-level 앱, 어떤 때는 세션의 부품이 되어 앱 개념이 다시 둘로 갈린다.
//  그래서 이 칸은 목록만 소유하고, 화면 앱은 AppInstance를 만들어 #/i/:id 탭으로, headless 앱은 앱 세션 탭으로 연다.
function appsPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-apps' });

  const list = async (): Promise<void> => {
    root.replaceChildren(el('p', { class: 'pn-fine', text: '불러오는 중…' }));
    // ai-session은 OS의 기본 새 작업/세션 진입이 이미 정본이다. 설치 앱 목록에 중복 런처로 노출하지 않는다.
    const apps = (await listSessionApps()).filter((a) => a.id !== 'ai-session');
    if (ctx.dead()) return;
    if (!apps.length) {
      root.replaceChildren(el('div', { class: 'pn-empty' },
        el('b', { text: '설치된 앱이 없어요.' }),
        el('p', { class: 'pn-fine', text: '관리자가 앱을 설치하면 여기서 열 수 있어요.' })));
      return;
    }
    root.replaceChildren(el('div', { class: 'pn-apps-grid' }, ...apps.map((a) => {
      const hasUi = a.pages.length > 0 || a.system?.renderer === 'browser';
      const projectId = a.instances.project === 'global' ? null : ctx.id;
      return el('button', { class: 'pn-app', type: 'button',
        title: hasUi ? '상단 탭에서 앱 화면을 엽니다' : '상단 탭에서 이 앱 전용 AI 세션을 엽니다',
        onclick: () => { if (hasUi) void openInstalledApp(a, projectId); else void openAppSession(a.id, { title: a.title, projectId }); } },
        el('span', { class: 'pn-app-ic' }, pnIcon(hasUi ? 'grid' : 'chat', 'pn-i')),
        el('b', { text: a.title }),
        el('span', { class: 'pn-fine', text: hasUi ? '앱 탭' : '앱 세션 탭' }));
    })));
  };

  void list();
  return { root };
}

// ══ 미리보기 — 띄워 둔 화면을 웹 칸으로 보낸다 (원준 2026-08-21) ══════════
//  왜: 미리보기는 지금 앱 밖에서만 볼 수 있다. 주소를 복사해 새 탭에서 열고, 앱으로 돌아오려면 탭을 다시 찾는다.
//   화면을 고치는 동안 이 왕복이 계속 일어난다. 목록을 칸에 두고 누르면 **웹 칸**이 그 화면을 문다 — 곁칸을 새로
//   만들지 않는다(칸은 이미 있다. 없던 것은 '무엇을 띄울지 고르는 목록'뿐이다).
function previewPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-prev' });
  const listEl = el('div', { class: 'pn-prev-list' }, el('div', { class: 'pn-prev-msg', text: '불러오는 중…' }));
  root.append(listEl);
  let cur = '';                          // 지금 웹 칸에 실어 둔 것 — 목록에서 표시해 둔다

  // 상태를 사람 말로. 서버 값(running/preparing/…)을 그대로 두면 뜻을 사람이 해석해야 한다.
  const STATE: Record<string, { t: string; k: string }> = {
    running: { t: '켜져 있어요', k: 'on' }, preparing: { t: '준비 중이에요', k: 'busy' },
    stopped: { t: '꺼져 있어요', k: 'off' }, error: { t: '문제가 생겼어요', k: 'bad' },
  };

  const draw = (rows: any[]): void => {
    if (!rows.length) { listEl.replaceChildren(el('div', { class: 'pn-prev-msg', text: '띄워 둔 미리보기가 없어요.' })); return; }
    listEl.replaceChildren(...rows.map((p) => {
      const st = STATE[String(p.status)] || { t: String(p.status || ''), k: 'off' };
      const name = String(p.label || p.project_name || p.id || '');
      const meta = [p.id, p.branch, p.last_active_at ? relTime(p.last_active_at) : ''].filter(Boolean).join(' · ');
      const row = el('button', {
        class: 'pn-prev-row' + (p.url && p.url === cur ? ' is-on' : ''), type: 'button',
        title: p.url ? '웹 칸에서 엽니다' : '주소가 아직 없어요',
        onclick: () => {
          if (!p.url) { toast('아직 주소가 없어요 — 미리보기가 준비되면 열립니다.'); return; }
          cur = String(p.url);
          openInWebPart(ctx, cur);
          for (const r of Array.from(listEl.querySelectorAll('.pn-prev-row'))) (r as HTMLElement).classList.remove('is-on');
          row.classList.add('is-on');
        },
      },
        el('span', { class: 'pn-prev-dot pn-prev-dot--' + st.k, title: st.t }),
        el('span', { class: 'pn-prev-b' },
          el('span', { class: 'pn-prev-t', text: name }),
          el('span', { class: 'pn-prev-m', text: meta })),
        pnIcon('ext', 'pn-i sm pn-prev-go')) as HTMLElement;
      return row;
    }));
  };

  const load = async (): Promise<void> => {
    if (ctx.dead()) return;
    try {
      const res: any = await api('/api/ui/preview-envs');
      const rows: any[] = (Array.isArray(res) ? res : (res && (res.envs || res.items || res.previews))) || [];
      // 켜진 것 먼저, 그다음 최근에 쓴 순 — 지금 볼 수 있는 것이 위로 온다.
      const rank = (x: any): number => (x.status === 'running' ? 0 : x.status === 'preparing' ? 1 : 2);
      rows.sort((a, b) => rank(a) - rank(b)
        || String(b.last_active_at || b.updated_at || '').localeCompare(String(a.last_active_at || a.updated_at || '')));
      if (!ctx.dead()) draw(rows);
    } catch (_) {
      if (!ctx.dead()) listEl.replaceChildren(el('div', { class: 'pn-prev-msg', text: '목록을 불러오지 못했어요.' }));
    }
  };
  void load();
  return { root, tick: () => void load() };
}

export function makePart(type: PartType, ctx: PartCtx): Part {
  if (type === 'sessions') return sessionsPart(ctx);
  if (type === 'archive') return archivePart(ctx);
  if (type === 'web') return webPart(ctx);
  if (type === 'preview') return previewPart(ctx);
  if (type === 'editor') return viewerPart(ctx);
  if (type === 'files') return filesPart(ctx);
  if (type === 'knowledge') return knowledgePart(ctx);
  if (type === 'tasks') return tasksPart(ctx);
  if (type === 'timeline') return timelinePart(ctx);
  if (type === 'apps') return appsPart(ctx);
  return livPart(ctx);
}
