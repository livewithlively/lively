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
import { confirmSessionForget } from '../session-actions.js';
import { upDropZone } from '../projects/files-upload.js';
import { mountProjectChat, type ProjectChatHandle } from '../project-chat.js';
import { filesPart } from './panes-files.js';
import { NOISE_RE, TRASH_DIR, attachName, authHeaders, kindOf, pnIcon } from './panes-kit.js';
import { createRunPicker } from './run-picker.js';
import { spawnSession } from './quick-session.js';
import { rememberCreated } from './created-cache.js';   // #1820 — 되살린 세션을 라우트가 곧바로 그릴 수 있게
import { sessText } from './side.js';
import { listSessionApps, openAppSession, type SessionApp } from './app-session.js';
import { mountAppUiFrame, type AppUiFrame } from './app-ui.js';
import { type Sess, type V2Data } from './views.js';

// 아이콘은 곁칸 곳곳(panes.ts · proj-settings.ts)이 여기서 받아 왔다 — 잎으로 옮긴 뒤에도 그 자리를 유지한다.
export { pnIcon } from './panes-kit.js';

export type PartType = 'sessions' | 'files' | 'knowledge' | 'tasks' | 'timeline' | 'overview' | 'liv' | 'archive' | 'web' | 'editor' | 'apps';

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
  { type: 'knowledge', name: '지식', icon: 'doc', hint: '이 프로젝트에 연결된 지식 문서입니다.' },
  { type: 'tasks', name: '할 일', icon: 'task', hint: '태스크 목록입니다. 눌러서 끝냈다고 표시합니다.' },
  { type: 'timeline', name: '타임라인', icon: 'clock', hint: '이 프로젝트에 남은 활동 기록입니다.' },
  { type: 'overview', name: '개요', icon: 'note', hint: '프로젝트 본문입니다.' },
  { type: 'liv', name: '리브', icon: 'spark', hint: '이 프로젝트를 아는 리브와 대화합니다.' },
  // 이름을 '보관함'이 아니라 **보관한 세션**으로 둔다(원준 2026-08-20) — 무엇을 보관하는지가 이름에서 바로 읽혀야 한다.
  { type: 'archive', name: '보관한 세션', icon: 'box', hint: '닫아 둔 AI 세션입니다. 대화 그대로 다시 살릴 수 있어요.' },
  { type: 'web', name: '웹', icon: 'globe', hint: '주소를 넣으면 이 칸에서 그 페이지를 봅니다. 문서·레퍼런스를 옆에 띄워 두세요.' },
  { type: 'editor', name: '파일 편집', icon: 'pencil', hint: '자료의 파일을 이 칸에 띄워 놓고 고칩니다. 글 파일은 그 자리에서 저장돼요.' },
  { type: 'apps', name: '앱', icon: 'grid', hint: '설치된 앱을 이 칸에서 엽니다 — 화면 있는 앱은 여기 바로, 세션 앱은 새 세션으로.' },
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
  //  새 세션은 첫 지시를 이름 자리에 임시로 넣어 두는데(seedSessName), 잠시 뒤 서버가 그 지시를 보고
  //  **짧은 이름**을 지어 붙인다(src/terminal/session-name-ai.ts). 캐시를 먼저 보면 그 이름이 도착해도
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
  const send = el('button', { class: 'btn btn-primary v2-launch-send', type: 'button', onclick: () => void spawn() },
    el('span', { text: '시키기' }), el('kbd', { text: '⏎' })) as HTMLButtonElement;
  // 제공자·모델·추론강도·실행 노드 — 홈과 같은 부품이고 **같은 기억**을 쓴다(여기서 고른 값이 다음 기본이 된다).
  //  새 세션 자리를 처음 그릴 때만 만든다(서버 /terminal/config 를 한 번 부른다 — 세션을 보고 있을 뿐인 칸이 부를 이유가 없다).
  let runPicker: ReturnType<typeof createRunPicker> | null = null;
  const idle = (): void => { send.disabled = false; ta.disabled = false; runPicker?.disable(false); send.replaceChildren(el('span', { text: '시키기' }), el('kbd', { text: '⏎' })); };
  const grow = (): void => { ta.style.height = 'auto'; ta.style.height = Math.min(220, ta.scrollHeight) + 'px'; };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault(); void spawn();
  });

  // ── 첨부(#1819) — 그림·파일을 **붙여넣거나 끌어다 놓으면** 프로젝트 자료로 올리고 첫 지시에 딸려 보낸다.
  //  왜 필요했나: 클로드가 도는 화면(터미널)에는 이 경로가 있는데(dropFileToAgent) 세션을 **여는** 창에는 없어서,
  //  화면을 캡처해 놓고도 세션을 먼저 열고 다시 붙여넣어야 했다(원준 2026-08-20 신고).
  //  세션 cwd 는 프로젝트 폴더가 아니라 세션 전용 폴더라 상대경로로는 못 찾는다 → 서버가 준 절대경로를 지시에 적는다.
  const attached: Array<{ name: string; abs: string }> = [];
  const chips = el('div', { class: 'pn-att', hidden: true });
  function paintChips(): void {
    chips.hidden = !attached.length;
    chips.replaceChildren(...attached.map((a) => el('span', { class: 'pn-att-c', title: a.abs },
      pnIcon('doc', 'pn-i sm'), el('span', { class: 'n', text: a.name }),
      el('button', { class: 'pn-att-x', type: 'button', title: '첨부 빼기', 'aria-label': '첨부 빼기', text: '✕',
        onclick: () => { const i = attached.indexOf(a); if (i >= 0) attached.splice(i, 1); paintChips(); } }))));
  }
  async function attachFiles(files: File[]): Promise<void> {
    if (!files.length) return;
    if (!(ctx.id > 0)) { toast('이 화면은 프로젝트 폴더가 없어 파일을 둘 곳이 없어요 — 세션을 연 뒤 붙여넣어 주세요.', true); return; }
    toast(files.length + '개를 자료로 올리는 중이에요…');
    for (const f of files) {
      const nm = attachName(f, attached.map((a) => a.name));
      try {
        const r = await fetch(apiUrl('/api/ui/v6/projects/' + ctx.id + '/file?path=' + encodeURIComponent(nm)),
          { method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' }, body: f });
        const j: any = await r.json().catch(() => null);
        if (!r.ok) throw new Error((j && j.error) || String(r.status));
        attached.push({ name: nm, abs: (j && j.path) || nm });
      } catch (e: any) { toast(nm + ' 올리기 실패 — ' + (e?.message || e), true); }
    }
    if (ctx.dead()) return;
    paintChips();
    ctx.onChanged?.();     // 자료 칸이 같은 화면에 있으면 바로 보이게
    toast('자료에 올렸어요 — 이 세션에 시킬 때 함께 넘어갑니다.');
  }
  ta.addEventListener('paste', (e: ClipboardEvent) => {
    const dt = e.clipboardData; if (!dt) return;
    const files = Array.from(dt.items || []).filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean) as File[];
    if (!files.length) return;          // 글 붙여넣기는 평소대로 입력칸에 들어간다
    e.preventDefault();
    void attachFiles(files);
  });

  function newPane(): HTMLElement {
    if (!runPicker) runPicker = createRunPicker();
    const pane = el('div', { class: 'pn-newpane' },
      el('div', { class: 'pn-launch' },
        el('h1', { class: 'v2-h1', text: '무엇을 할까요?' }),
        el('p', { class: 'v2-home-sub', text: ctx.id > 0 ? '새 세션이 열려요.' : '프로젝트 없이 새 세션이 열려요.' }),
        el('div', { class: 'v2-launch' }, ta, chips,
          el('div', { class: 'v2-launch-row' }, el('div', { class: 'v2-launch-ctl' }, runPicker.el), send))));
    upDropZone(pane, pane, (list) => void attachFiles(list.map((u) => u.file as File)));
    paintChips();
    return pane;
  }

  const mine = (): Sess[] => ctx.data().sessions
    .filter((s) => Number(s.projectId) === ctx.id)
    .sort((a, b) => rank(a) - rank(b) || (b.lastSeen || 0) - (a.lastSeen || 0));

  /** 위 자리를 이 세션으로 채운다. 같은 세션이면 아무것도 하지 않는다(대화·스크롤·터미널 보존). */
  function mountStage(): void {
    if (composing || !sel) {
      if (mounted) { mounted.h?.destroy(); mounted = null; }
      if (!stage.querySelector('.pn-newpane')) stage.replaceChildren(newPane());
      window.setTimeout(() => { grow(); ta.focus(); }, 0);
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
    sending = true; send.disabled = true; ta.disabled = true; runPicker?.disable(true);
    send.replaceChildren(el('span', { text: '여는 중…' }));
    // 생성은 **한 곳**에서만 한다(v2/quick-session.ts spawnSession) — 생성 전문 캐시·첫 지시 낙관 렌더·프로젝트
    //  붙이기가 거기 묶여 있다. 여기서 fetch 를 다시 짜면 그 중 하나가 빠진다(실제로 캐시가 빠져 있었다).
    // 첨부는 지시의 꼬리에 절대경로로 적는다 — 세션이 열리자마자 그 파일을 읽을 수 있게(이름은 사람이 알아보는 단서).
    const prompt = attached.length
      ? text + '\n\n첨부한 자료(이 프로젝트 공유 폴더):\n' + attached.map((a) => '- ' + a.abs).join('\n')
      : text;
    const made = await spawnSession(prompt, { projectId: ctx.id > 0 ? ctx.id : null, projectName: projectName(), run: runPicker?.value() || null });
    sending = false; idle();
    if (!made) { ta.focus(); return; }
    seedSessName(made.id, text);
    // 목록에 **지금** 끼워 넣는다 — 20초 폴링을 기다리면 그 사이 세션 화면이 빈 채로 있는다.
    ctx.onSessionCreated?.(made.session);
    ta.value = ''; ta.style.height = 'auto';
    attached.length = 0; paintChips();
    ctx.onChanged?.();
    select(made.id);
  }

  function paint(): void {
    const ss = mine();
    // 지정된 세션이 이 프로젝트에 없으면(옮겼거나 사라졌다) 맨 위 세션으로.
    //  ⚠ 방금 만들어 아직 목록에 안 온 세션(mounted.ok === false)은 예외다 — 여기서 다른 세션으로 튕기면
    //   사람이 방금 연 세션을 잃는다.
    const pending = !!mounted && mounted.sid === sel && !mounted.ok;
    if (!composing && sel && !pending && !ss.some((s) => s.id === sel)) { sel = ss.length ? ss[0].id : null; composing = !sel; }
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
  let sig = '';
  function paint(): void {
    const kn = (ctx.detail()?.project || {}).knowledge || {};
    const all: Array<{ name: string; rel: string }> = [
      ...(kn.required || []).map((k: any) => ({ name: String(k.name), rel: '필요' })),
      ...(kn.produced || []).map((k: any) => ({ name: String(k.name), rel: '산출' })),
    ];
    const s2 = all.map((k) => k.rel + k.name).join('|');
    if (s2 === sig) return;
    sig = s2;
    if (!all.length) {
      root.replaceChildren(el('div', { class: 'pn-empty' },
        pnIcon('doc', 'pn-i big'),
        el('b', { text: '연결된 지식이 아직 없어요.' }),
        el('p', { class: 'pn-fine', text: '세션이 만든 결론을 지식으로 남기면 여기 모입니다.' })));
      return;
    }
    root.replaceChildren(
      el('div', { class: 'pn-head' }, el('span', { class: 'pn-fine', text: all.length + '건' })),
      el('div', { class: 'pn-knlist' }, ...all.map((k) =>
        el('a', { class: 'pn-knrow', href: '#/k/' + encodeURIComponent(k.name), title: k.name },
          pnIcon('doc', 'pn-i sm'),
          el('span', { class: 'n ell', text: k.name }),
          el('span', { class: 'pn-knrel' + (k.rel === '산출' ? ' prod' : ''), text: k.rel })))));
  }
  paint();
  return { root, tick: paint };
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

// ══ 개요 — 프로젝트 본문 ══════════════════════════════════════════════════════
function overviewPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-ov' });
  let sig = '';
  function paint(): void {
    const md = String((ctx.detail()?.project || {}).description || '').trim();
    if (md === sig) return;
    sig = md;
    root.replaceChildren(
      md ? el('div', { class: 'pn-md' }, renderMarkdown(md))
        : el('div', { class: 'pn-empty' },
          pnIcon('note', 'pn-i big'),
          el('b', { text: '본문이 아직 없어요.' }),
          el('p', { class: 'pn-fine', text: '이 프로젝트가 무엇인지 적어 두면 세션도 그걸 읽고 일합니다.' })),
      el('div', { class: 'pn-head end' },
        el('button', { class: 'btn-text', type: 'button', text: '프로젝트 정보에서 고치기', onclick: () => ctx.openSettings?.() })));
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
  async function purge(s: Sess, name: string): Promise<void> {
    if (workingId) return;
    // 확인창은 #1582 의 단일 정의를 쓴다 — '대화록이 남는지'는 조직 설정·하네스에 따라 달라서,
    //  그 판정을 여기서 흉내 내면 반드시 한쪽이 거짓말을 한다(confirmSessionForget 이 서버에 물어 참인 문장만 쓴다).
    if (!await confirmSessionForget({ title: `「${name}」을 목록에서 지울까요?`, sessions: [{ harness: String((s.raw && s.raw.harness) || '') }] })) return;
    workingId = s.id; sig = ''; paint();
    try {
      await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + (s.node ? '?node=' + encodeURIComponent(s.node) : ''), { method: 'DELETE' });
      toast('보관 목록에서 지웠어요.');
      ctx.onChanged?.();
    } catch (e: any) {
      toast('지우지 못했어요 — ' + (e && e.message ? e.message : e), true);
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
          class: 'pn-arow-x', type: 'button', title: '완전 삭제 — 되살릴 수 없게 됩니다', 'aria-label': `「${t}」 완전 삭제`,
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
function webPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-web' });
  const KEY = 'pn_web_url';
  const store = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { return {}; } };
  // 주소는 **세션마다** 따로 기억한다 — 옆 세션에서 열어 둔 페이지가 이 세션 칸에 뜨면 그건 남의 화면이다(원준 2026-08-20).
  const keyOf = (): string => ctx.memKey();
  const norm = (v: string): string => {
    const t = v.trim();
    if (!t) return '';
    if (/^https?:\/\//i.test(t)) return t;
    if (/^[\w.-]+\.[a-z]{2,}(\/|$|\?)/i.test(t)) return 'https://' + t;
    return 'https://www.google.com/search?q=' + encodeURIComponent(t);   // 주소가 아니면 검색으로 — 막다른 입력칸을 만들지 않는다
  };
  const frame = el('iframe', { class: 'pn-webframe', referrerpolicy: 'no-referrer-when-downgrade' }) as HTMLIFrameElement;
  const input = el('input', { class: 'pn-web-in', type: 'text', placeholder: '주소 또는 검색어 — 예: docs.google.com', 'aria-label': '주소' }) as HTMLInputElement;
  const go = (raw?: string): void => {
    const u = norm(raw ?? input.value);
    if (!u) return;
    input.value = u;
    frame.src = u;
    const m = store(); m[keyOf()] = u;
    try { localStorage.setItem(KEY, JSON.stringify(m)); } catch (_) { /* noop */ }
  };
  // 지금 프레임에 실린 **그 주소를 다시** 싣는다 — go() 는 주소칸의 글자로 '가는' 것이라 뜻이 다르다.
  //  같은 주소를 src 에 그대로 넣는 것만으로는 #조각만 다른 주소에서 다시 싣지 않으므로, 남의 사이트면 빈 화면을 한 번 거친다.
  const reload = (): void => {
    const u = frame.getAttribute('src') || norm(input.value);
    if (!u) return;
    try { frame.contentWindow?.location.reload(); return; } catch (_) { /* 남의 사이트 — 안쪽에 시킬 수 없다. 아래로 */ }
    frame.src = 'about:blank';
    window.setTimeout(() => { if (frame.isConnected) frame.src = u; }, 0);
  };
  input.onkeydown = (e: KeyboardEvent) => { if (!e.isComposing && e.key === 'Enter') { e.preventDefault(); go(); } };
  const openTab = el('a', { class: 'pn-web-btn', target: '_blank', rel: 'noopener', title: '새 탭에서 엽니다', href: '#' }, pnIcon('ext', 'pn-i sm')) as HTMLAnchorElement;
  openTab.onclick = (e: Event) => { const u = norm(input.value); if (!u) { e.preventDefault(); return; } openTab.href = u; };
  root.append(
    el('div', { class: 'pn-web-bar' },
      el('button', { class: 'pn-web-btn', type: 'button', title: '이 칸만 다시 불러옵니다 — ⌘R(윈도는 Ctrl+R)도 같습니다.', 'aria-label': '다시 불러오기', onclick: () => reload() }, pnIcon('undo', 'pn-i sm')),
      input,
      el('button', { class: 'pn-web-btn', type: 'button', text: '열기', onclick: () => go() }),
      openTab),
    frame,
    el('p', { class: 'pn-web-note pn-fine', text: '빈 화면인가요? 그 사이트가 창 안에 뜨는 걸 막은 거예요 — 오른쪽 ↗ 로 새 탭에서 여세요.' }));
  // 이 세션이 보던 주소로 맞춘다 — 세션을 갈아 끼우면 그 세션이 보던 페이지로 갈아입는다(아무것도 없으면 빈 칸).
  function adopt(): void {
    const u = store()[keyOf()] || '';
    if (u === (frame.getAttribute('src') || '')) { input.value = u; return; }
    input.value = u;
    if (u) frame.src = u; else frame.removeAttribute('src');
  }
  adopt();
  const offSess = ctx.onSession(() => adopt());

  // ── ⌘R 은 이 칸만(원준 2026-08-20 신고: "웹을 고른 채 새로고침하면 화면 전체가 다시 실린다") ─────
  //  ⌘R 은 본디 브라우저의 것이다. 이 칸이 열려 있다는 이유만으로 늘 뺏으면 세션·자료를 보던 사람의 새로고침까지 먹는다.
  //  그래서 **마지막으로 만진 칸이 여기일 때만** 가로챈다 — 탭을 눌러 이 칸을 고른 것도 '만진' 것이다(신고된 그 상황이다).
  //  ⇧⌘R 은 일부러 두었다 — 화면 전체를 다시 싣는 탈출구가 하나는 있어야 한다.
  //  ⚠ 못 하는 것을 할 수 있는 척하지 않는다: 프레임 **안**(남의 사이트)을 누른 뒤의 ⌘R 은 그 사이트 문서로 가고
  //   우리에게 오지 않는다(cross-origin 프레임의 키 입력은 부모로 새지 않는다 — 뚫을 수 있는 문이 아니다).
  //   그 때는 주소칸을 한 번 누르고 ⌘R, 또는 왼쪽 ↺ 를 누르면 된다. 전체가 다시 실려도 이 칸 주소는 저장해 두었으니 같은 자리로 돌아온다.
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
    destroy: () => {
      offSess();
      document.removeEventListener('pointerdown', mark, true);
      document.removeEventListener('focusin', mark, true);
      window.removeEventListener('keydown', onKey, true);
    },
  };
}

// ══ 파일 편집 — 자료를 띄워 놓고 그 자리에서 고친다(원준 2026-08-20) ═══════════════
//  형식마다 할 수 있는 일이 다르다. 할 수 없는 것을 할 수 있는 척하지 않는다:
//   · 글 파일(md·txt·csv·json·코드·html) → **고치고 저장**(PUT 으로 같은 경로에 덮어쓴다). html 은 옆에 미리보기.
//   · PDF·그림·영상 → 보기 전용(브라우저가 그려 준다).
//   · 파워포인트·워드·엑셀·한글 → 브라우저에 이걸 여는 방법이 없다. [내려받기]로 원래 앱에서 고치고
//     [고친 파일 올리기]로 같은 자리에 되돌리는 **왕복**을 만들어 둔다 — 그게 지금 정직하게 가능한 '수정'이다.
type FlatFile = { path: string; size: number; mtime: number };   // 파일 편집기는 폴더를 다루지 않는다 — 평평한 매니페스트 한 줄
function editorPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-ed' });
  const KEY = 'pn_ed_path';
  const bar = el('div', { class: 'pn-ed-bar' });
  const body = el('div', { class: 'pn-ed-body' });
  root.append(bar, body);
  let list: FlatFile[] = [];
  let path = '';
  let dirty = false;
  let area: HTMLTextAreaElement | null = null;
  let pv: HTMLIFrameElement | null = null;
  const urls: string[] = [];
  const fileUrl = (p2: string): string => apiUrl('/api/ui/v6/projects/' + ctx.id + '/file?path=' + encodeURIComponent(p2));
  // 무엇을 열어 두었나도 **세션마다** 따로 — 자료(파일 자체)는 프로젝트 공용이지만, '내가 지금 뭘 펴 놨나'는 내 세션의 것이다.
  const remember = (p2: string): void => {
    try { const m = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; m[ctx.memKey()] = p2; localStorage.setItem(KEY, JSON.stringify(m)); } catch (_) { /* noop */ }
  };
  const remembered = (): string => {
    try { return (JSON.parse(localStorage.getItem(KEY) || '{}') || {})[ctx.memKey()] || ''; } catch (_) { return ''; }
  };

  async function loadList(): Promise<void> {
    const m: any = await api('/api/ui/v6/projects/' + ctx.id + '/shared/manifest').catch(() => null);
    list = (((m && m.files) || []) as any[])
      .filter((f) => !String(f.path).startsWith(TRASH_DIR + '/') && !NOISE_RE.test('/' + f.path))
      .map((f) => ({ path: String(f.path), size: Number(f.size || 0), mtime: Number(f.mtime || 0) }))
      .sort((a, b) => b.mtime - a.mtime);
  }

  async function save(): Promise<void> {
    if (!area || !path) return;
    const btn = bar.querySelector('.pn-ed-save') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = '저장 중…'; }
    try {
      const r = await fetch(fileUrl(path), { method: 'PUT', headers: authHeaders(), body: new Blob([area.value]) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      dirty = false;
      toast('저장했어요 — ' + base(path));
      ctx.onChanged?.();
    } catch (e: any) {
      toast('저장하지 못했어요 — ' + (e && e.message ? e.message : e), true);
    } finally { paintBar(); }
  }

  function paintBar(): void {
    const pick = el('select', { class: 'pn-ed-pick', 'aria-label': '고칠 파일' }) as HTMLSelectElement;
    pick.append(el('option', { value: '', text: list.length ? '파일 고르기…' : '자료가 아직 없어요' }));
    for (const f of list.slice(0, 200)) {
      const o = el('option', { value: f.path, text: base(f.path) }) as HTMLOptionElement;
      if (f.path === path) o.selected = true;
      pick.append(o);
    }
    pick.onchange = () => { void open(pick.value); };
    const kids: HTMLElement[] = [pick];
    if (path) {
      const k = kindOf(path);
      if (k.kind === 'text' || k.kind === 'page') {
        kids.push(el('button', { class: 'pn-web-btn pn-ed-save', type: 'button', text: dirty ? '저장 ●' : '저장', title: '⌘S / Ctrl+S 로도 저장됩니다', onclick: () => void save() }));
      }
      kids.push(el('a', { class: 'pn-web-btn', href: fileUrl(path), download: base(path), title: '내려받기' }, pnIcon('drop', 'pn-i sm')));
      const up = el('input', { type: 'file', hidden: true }) as HTMLInputElement;
      up.onchange = async () => {
        const f = up.files && up.files[0];
        up.value = '';
        if (!f) return;
        try {
          const r = await fetch(fileUrl(path), { method: 'PUT', headers: authHeaders(), body: f });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          toast('같은 자리에 올렸어요 — ' + base(path));
          ctx.onChanged?.();
          await open(path);
        } catch (e: any) { toast('올리지 못했어요 — ' + (e && e.message ? e.message : e), true); }
      };
      kids.push(up, el('button', { class: 'pn-web-btn', type: 'button', text: '고친 파일 올리기', title: '원래 앱에서 고친 파일을 같은 자리에 덮어씁니다', onclick: () => up.click() }));
    }
    bar.replaceChildren(...kids);
  }

  async function open(p2: string): Promise<void> {
    path = p2; dirty = false; area = null; pv = null;
    remember(p2);
    paintBar();
    if (!p2) { body.replaceChildren(el('p', { class: 'pn-fine', style: 'padding:14px', text: '위에서 파일을 고르면 이 자리에 띄웁니다.' })); return; }
    const k = kindOf(p2);
    if (k.kind === 'text' || k.kind === 'page') {
      const r = await fetch(fileUrl(p2), { headers: authHeaders() }).catch(() => null);
      if (!r || !r.ok) { body.replaceChildren(el('p', { class: 'pn-fine', style: 'padding:14px', text: '파일을 읽지 못했어요.' })); return; }
      const txt = await r.text();
      const ta = el('textarea', { class: 'pn-ed-ta', spellcheck: 'false' }) as HTMLTextAreaElement;
      ta.value = txt;
      ta.oninput = () => { if (!dirty) { dirty = true; paintBar(); } if (pv) pv.srcdoc = ta.value.slice(0, 400_000); };
      ta.onkeydown = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); } };
      area = ta;
      if (k.kind === 'page') {
        // 고치면서 바로 본다 — 격리 프레임(srcdoc)이라 스크립트는 돌지 않는다(그림만 확인).
        const f = el('iframe', { class: 'pn-ed-pv', sandbox: '', tabindex: '-1' }) as HTMLIFrameElement;
        f.srcdoc = txt.slice(0, 400_000);
        pv = f;
        body.replaceChildren(el('div', { class: 'pn-ed-split' }, ta, f));
      } else body.replaceChildren(ta);
      return;
    }
    if (k.kind === 'img' || k.kind === 'pdf' || k.kind === 'video') {
      const r = await fetch(fileUrl(p2), { headers: authHeaders() }).catch(() => null);
      if (!r || !r.ok) { body.replaceChildren(el('p', { class: 'pn-fine', style: 'padding:14px', text: '파일을 읽지 못했어요.' })); return; }
      const bl = await r.blob();
      const u = URL.createObjectURL(k.kind === 'pdf' ? new Blob([bl], { type: 'application/pdf' }) : bl);
      urls.push(u);
      body.replaceChildren(k.kind === 'img'
        ? el('img', { class: 'pn-ed-img', src: u, alt: base(p2) })
        : k.kind === 'video'
          ? el('video', { class: 'pn-ed-img', src: u, controls: 'true' })
          : el('iframe', { class: 'pn-ed-pv full', src: u + '#toolbar=1&view=FitH' }));
      return;
    }
    body.replaceChildren(el('div', { class: 'pn-empty' },
      pnIcon('doc', 'pn-i big'),
      el('b', { text: '이 형식은 브라우저에서 열 수 없어요.' }),
      el('p', { class: 'pn-fine', text: '파워포인트·워드·엑셀·한글은 브라우저가 그릴 방법이 없습니다. 위 [내려받기]로 원래 앱에서 고친 뒤 [고친 파일 올리기]로 같은 자리에 되돌리면 돼요.' })));
  }

  if (!(ctx.id > 0)) {
    body.replaceChildren(el('p', { class: 'pn-fine', style: 'padding:14px', text: '이 화면은 프로젝트 폴더가 없어 자료를 열 수 없어요.' }));
    return { root };
  }
  const openRemembered = (): void => {
    const last = remembered();
    void open(last && list.some((f) => f.path === last) ? last : '');
  };
  void loadList().then(() => openRemembered());
  // 세션을 갈아 끼우면 그 세션이 펴 두었던 파일로 — 단 **고치는 중이면 건드리지 않는다**(저장 안 한 글을 뺏지 않는다).
  const offSess = ctx.onSession(() => { if (!dirty) openRemembered(); });
  return {
    root,
    tick: () => { if (!dirty) void loadList().then(() => paintBar()); },   // 고치는 중엔 목록도 건드리지 않는다
    destroy: () => { offSess(); urls.forEach((u) => URL.revokeObjectURL(u)); },
  };
}

// ══ 앱 — 설치된 앱을 이 칸에서 연다 (#1780 panes 정합) ═══════════════════════════
//  화면 있는 앱(ui.pages)은 **이 칸 안에** 샌드박스 iframe 으로 연다(모달 아님 — panes 탭 문법). 세션 앱은 새 세션으로.
//  브리지·격리는 app-ui.mountAppUiFrame 이 그대로 — 여러 칸에 앱을 열어도 프레임별 핸들러라 안전.
function appsPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-apps' });
  let frame: AppUiFrame | null = null;
  const drop = (): void => { if (frame) { frame.destroy(); frame = null; } };

  const openInPane = async (a: SessionApp): Promise<void> => {
    drop();
    root.replaceChildren(el('p', { class: 'pn-fine', text: '여는 중…' }));
    try {
      const f = await mountAppUiFrame(a.id, { title: a.title });
      if (ctx.dead()) { f.destroy(); return; }
      frame = f;
      root.replaceChildren(
        el('div', { class: 'pn-apps-bar' },
          el('button', { class: 'btn-text', type: 'button', text: '← 앱 목록', onclick: () => void list() }),
          el('b', { class: 'pn-apps-cur', text: a.title })),
        f.root);
    } catch (e: any) { root.replaceChildren(el('p', { class: 'pn-fine', text: '앱을 열지 못했어요 — ' + (e?.message || e) })); }
  };

  const list = async (): Promise<void> => {
    drop();
    root.replaceChildren(el('p', { class: 'pn-fine', text: '불러오는 중…' }));
    const apps = await listSessionApps();
    if (ctx.dead()) return;
    if (!apps.length) {
      root.replaceChildren(el('div', { class: 'pn-empty' },
        el('b', { text: '설치된 앱이 없어요.' }),
        el('p', { class: 'pn-fine', text: '관리자가 앱을 설치하면 여기서 열 수 있어요.' })));
      return;
    }
    root.replaceChildren(el('div', { class: 'pn-apps-grid' }, ...apps.map((a) => {
      const hasUi = a.pages.length > 0;
      return el('button', { class: 'pn-app', type: 'button',
        title: hasUi ? '이 칸에서 앱 화면을 엽니다' : '이 앱 전용 AI 세션을 엽니다',
        onclick: () => { if (hasUi) void openInPane(a); else void openAppSession(a.id, { title: a.title }); } },
        el('span', { class: 'pn-app-ic' }, pnIcon(hasUi ? 'grid' : 'chat', 'pn-i')),
        el('b', { text: a.title }),
        el('span', { class: 'pn-fine', text: hasUi ? '앱 화면' : '앱 세션' }));
    })));
  };

  void list();
  return { root, destroy: drop };
}

export function makePart(type: PartType, ctx: PartCtx): Part {
  if (type === 'sessions') return sessionsPart(ctx);
  if (type === 'archive') return archivePart(ctx);
  if (type === 'web') return webPart(ctx);
  if (type === 'editor') return editorPart(ctx);
  if (type === 'files') return filesPart(ctx);
  if (type === 'knowledge') return knowledgePart(ctx);
  if (type === 'tasks') return tasksPart(ctx);
  if (type === 'timeline') return timelinePart(ctx);
  if (type === 'overview') return overviewPart(ctx);
  if (type === 'apps') return appsPart(ctx);
  return livPart(ctx);
}
