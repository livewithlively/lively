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
import { TOKEN_KEY, api, apiUrl, el, relTime, renderMarkdown, sv, toast } from '../core.js';
import { fmtSize, openFileViewer } from '../projects/files.js';
import { upDropZone, upSend, upToast, type UpItem } from '../projects/files-upload.js';
import { mountProjectChat, type ProjectChatHandle } from '../project-chat.js';
import { createTimeline } from '../timeline.js';
import { loadProjectTimeline } from '../timeline-sources.js';
import { makeSplitter } from './split.js';
import { runPrefs } from './run-picker.js';
import { sessText } from './side.js';
import { dotCls, type Sess, type V2Data } from './views.js';

export type PartType = 'sessions' | 'files' | 'knowledge' | 'tasks' | 'timeline' | 'overview' | 'liv';

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
  /** 세션 화면(대화창·터미널·상단바) 통째를 이 자리에 붙인다 — main.ts 가 준다(우패널·이름바꾸기 등 배선을 쥔 쪽). */
  mountSession?: (host: HTMLElement, sid: string) => { destroy(): void } | null;
}

export interface Part {
  root: HTMLElement;
  tick?: () => void;
  destroy?: () => void;
}

export interface PartDef { type: PartType; name: string; icon: string; hint: string }

/** 칸에 넣을 수 있는 것들 — [+] 고르기 목록의 정본. */
export const PART_DEFS: PartDef[] = [
  { type: 'sessions', name: '세션', icon: 'chat', hint: '이 프로젝트에서 도는 AI 세션들과 바로 말하는 자리입니다.' },
  { type: 'files', name: '자료', icon: 'folder', hint: '공유 폴더에 쌓인 파일입니다. 끌어다 놓으면 올라갑니다.' },
  { type: 'knowledge', name: '지식', icon: 'doc', hint: '이 프로젝트에 연결된 지식 문서입니다.' },
  { type: 'tasks', name: '할 일', icon: 'task', hint: '태스크 목록입니다. 눌러서 끝냈다고 표시합니다.' },
  { type: 'timeline', name: '타임라인', icon: 'clock', hint: '이 프로젝트에 남은 활동 기록입니다.' },
  { type: 'overview', name: '개요', icon: 'note', hint: '프로젝트 본문입니다.' },
  { type: 'liv', name: '리브', icon: 'spark', hint: '이 프로젝트를 아는 리브와 대화합니다.' },
];

export const partDef = (t: PartType): PartDef => PART_DEFS.find((d) => d.type === t) || PART_DEFS[0];

// ── 아이콘(스트로크 SVG) ──────────────────────────────────────────────────────
const ICON_PATHS: Record<string, string> = {
  chat: '<path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  task: '<path d="M4 6h12M4 12h12M4 18h8"/><path d="M19 5l2 2-4 4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  note: '<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5"/>',
  img: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>',
  send: '<path d="M4 12l16-8-6 16-2-7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2L5.6 5.6"/>',
  cols: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M15 5v14"/>',
  drop: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 19h14"/>',
};
export function pnIcon(name: string, cls = 'pn-i'): SVGElement {
  const s = sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' });
  s.innerHTML = ICON_PATHS[name] || ICON_PATHS.doc;
  return s;
}

const authHeaders = (): Record<string, string> => {
  const t = ((): string => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } })();
  return t ? { authorization: 'Bearer ' + t } : {};
};
const when = (ms: number): string => (ms ? relTime(new Date(ms).toISOString()) : '');
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


// ── 세션 부품 ────────────────────────────────────────────────────────────────
//  구도(원준 2026-08-20):
//    위 = **지금 보는 세션의 화면 그 자체**(대화창·터미널·세션 상단바 — main.ts 가 mountSession 으로 붙인다).
//    아래 = **세션 서랍** — 곁칸 자료 서랍과 같은 문법의 타일. 누르면 그 세션이 위로 올라오고 주소도 그 세션 것이 된다.
//  ★ 프로젝트 화면과 세션 화면은 더 이상 다른 화면이 아니다 — 같은 셸에서 세션만 갈아 끼운다.
//    그래서 서랍에서 세션을 고를 때 셸(문패·곁칸 자료·지식)은 다시 그리지 않는다. 주소만 바뀐다.
function sessionsPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-sessions' });
  //  이름이 프로젝트명과 같은 세션(자동 이름)은 타일이 전부 같은 글자가 된다 — 그럴 땐 **마지막으로 시킨 말**을
  //  이름 자리에 쓴다. 그게 '이 세션이 무엇이었나'의 답이다. 한 번 찾으면 캐시해 두고 다시 묻지 않는다.
  const askedName = new Set<string>();
  const nameCache = new Map<string, string>();
  let sel: string | null = ctx.sessionId || null;
  let composing = !sel;                               // 세션이 지정되지 않았다 = 새 세션 자리
  let sending = false;
  let mounted: { sid: string; h: { destroy(): void } | null } | null = null;
  let drawerSig = '';

  // ── 위: 세션 화면이 통째로 들어오는 자리 ──
  const stage = el('div', { class: 'pn-stage' });

  // ── 새 세션 자리(세션이 없거나 [＋]를 눌렀을 때만 쓴다) ──
  const ta = el('textarea', { class: 'pn-new-in', rows: '1', placeholder: '무엇이든 시켜 보세요 — 새 세션이 열립니다.', 'aria-label': '새 세션에 시킬 일' }) as HTMLTextAreaElement;
  const sendBtn = el('button', { class: 'pn-new-send', type: 'button', title: '새 세션을 열고 시킵니다', 'aria-label': '보내기', onclick: () => void spawn() }, pnIcon('send', 'pn-i')) as HTMLButtonElement;
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(180, ta.scrollHeight) + 'px'; });
  ta.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault(); void spawn();
  });
  const newPane = (): HTMLElement => el('div', { class: 'pn-newpane' },
    el('div', { class: 'pn-empty' },
      pnIcon('chat', 'pn-i big'),
      el('b', { text: '새 세션을 엽니다.' }),
      el('p', { class: 'pn-fine', text: '시킬 일을 적으면 이 프로젝트에 붙은 AI 세션이 열리고, 아래 서랍에 타일로 쌓입니다.' })),
    el('div', { class: 'pn-sfoot' }, el('div', { class: 'pn-new' }, ta, sendBtn)));

  // ── 아래: 서랍 ──
  const drawerHead = el('div', { class: 'pn-drw-h' });
  const tiles = el('div', { class: 'pn-drw-grid', role: 'listbox', 'aria-label': '이 프로젝트의 세션' });
  const drawer = el('section', { class: 'pn-drw' }, drawerHead, tiles);
  const split = makeSplitter({ axis: 'y', key: 'panes_sessdrawer', cssVar: '--pn-drw-h', target: root, def: 176, min: 104, max: 460, grow: -1, label: '세션 서랍 높이' });
  root.append(stage, split, drawer);

  const mine = (): Sess[] => ctx.data().sessions
    .filter((s) => Number(s.projectId) === ctx.id)
    .sort((a, b) => rank(a) - rank(b) || (b.lastSeen || 0) - (a.lastSeen || 0));

  /** 이 세션을 뭐라고 부를까 — 자동 이름(프로젝트명 되풀이)이면 마지막 지시, 그것도 없으면 세션 꼬리. */
  function titleOf(s: Sess): string {
    const pname = String((ctx.detail()?.project || {}).name || '');
    const t = sessText(s, pname);
    const dup = !!pname && norm(t.main) === norm(pname);
    const tailId = String(s.id).split('-').pop() || String(s.id);
    return nameCache.get(s.id) || (dup ? '' : t.main) || ('세션 ' + tailId.slice(0, 8));
  }

  /** 위 자리를 이 세션으로 채운다. 같은 세션이면 아무것도 하지 않는다(대화·스크롤·터미널 보존). */
  function mountStage(): void {
    if (composing || !sel) {
      if (mounted) { mounted.h?.destroy(); mounted = null; }
      if (!stage.querySelector('.pn-newpane')) stage.replaceChildren(newPane());
      window.setTimeout(() => ta.focus(), 0);
      return;
    }
    if (mounted && mounted.sid === sel) return;
    if (mounted) { mounted.h?.destroy(); mounted = null; }
    stage.replaceChildren();
    const h = ctx.mountSession ? ctx.mountSession(stage, sel) : null;
    if (!ctx.mountSession) stage.replaceChildren(el('p', { class: 'pn-fine', style: 'padding:20px', text: '세션 화면을 붙일 수 없어요.' }));
    mounted = { sid: sel, h };
  }

  function select(id: string | null): void {
    if (id === sel && composing === (id == null)) return;
    sel = id; composing = id == null;
    ctx.onSessionPicked?.(id);            // 주소만 갈아 끼운다 — 셸은 그대로 산다
    drawerSig = '';
    mountStage();
    paintDrawer(mine());
  }

  // ── 새 세션 만들기 ──
  async function spawn(): Promise<void> {
    const text = ta.value.trim();
    if (!text || sending) return;
    sending = true; sendBtn.disabled = true; ta.disabled = true;
    try {
      const p = runPrefs();
      const out: any = await api('/api/ui/terminal/sessions', {
        method: 'POST',
        body: JSON.stringify({
          label: text.replace(/\s+/g, ' ').slice(0, 28),
          harness: p.harness && p.harness !== 'shell' ? p.harness : 'claude',
          flags: p.flags && typeof p.flags === 'object' ? p.flags : {},
          autoApprove: !!p.autoApprove, sessionDir: true, initialPrompt: text,
        }),
      });
      const sid = out?.session?.id ? String(out.session.id) : '';
      if (!sid) throw new Error('세션 id 를 받지 못했습니다');
      if (ctx.id > 0) {
        try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(sid) + '/project', { method: 'POST', body: JSON.stringify({ projectId: ctx.id }) }); }
        catch (_) { toast('세션은 열렸는데 이 프로젝트에 붙이지 못했어요 — 세션 상단바에서 다시 연결할 수 있어요.', true); }
      }
      nameCache.set(sid, text.replace(/\s+/g, ' ').slice(0, 46));
      ta.value = ''; ta.style.height = 'auto';
      ctx.onChanged?.();
      select(sid);
      toast('새 세션을 열었어요.');
    } catch (e: any) {
      toast('세션을 열지 못했어요 — ' + (e?.message || e), true);
    } finally { sending = false; sendBtn.disabled = false; ta.disabled = false; }
  }

  // ── 아래 서랍 그리기 ──
  function tile(s: Sess): HTMLElement {
    const on = !composing && s.id === sel;
    const t = titleOf(s);
    return el('button', {
      class: 'pn-stile' + (on ? ' on' : '') + (s.stateKey === 'waiting' ? ' wait' : ''),
      type: 'button', role: 'option', 'aria-selected': String(on),
      title: t + ' — ' + s.stateLabel + (on ? ' (지금 보는 세션)' : ''),
      onclick: () => select(s.id),
    },
      el('span', { class: 'pn-stile-ic' }, pnIcon('chat', 'pn-i'), el('span', { class: 'pn-stile-dot v2-dot ' + dotCls(s.stateKey), 'aria-hidden': 'true' })),
      el('b', { class: 'pn-stile-n ell2', text: t }),
      el('span', { class: 'pn-stile-m', text: when(s.lastSeen) }));
  }

  // 서랍에 한 번에 눕히는 타일 상한 — 프로젝트 없는 세션 화면은 수백 개가 몰린다(실측 188개). 정렬이 '답 기다림 →
  //  도는 중 → 최근' 순이라 앞쪽이 늘 중요한 것들이고, 나머지는 세는 것으로 충분하다(사이드바가 전체 목록을 쥔다).
  const DRAWER_MAX = 60;
  function paintDrawer(ss: Sess[]): void {
    const live = ss.filter((s) => s.live && s.alive).length;
    const shown = ss.slice(0, DRAWER_MAX);
    const hidden = ss.length - shown.length;
    const sig = (composing ? 'new|' : sel + '|') + shown.map((s) => s.id + s.stateKey + titleOf(s)).join(',');
    if (sig === drawerSig) return;
    drawerSig = sig;
    drawerHead.replaceChildren(
      el('span', { class: 'pn-fine', text: ss.length ? `세션 ${ss.length}` + (live ? ` · 지금 ${live}` : '') : '세션이 아직 없어요' }),
      hidden > 0 ? el('span', { class: 'pn-fine', text: `최근 ${DRAWER_MAX}개만 놓았어요 — 나머지 ${hidden}개는 왼쪽 목록에 있습니다.` }) : null,
      el('span', { class: 'pn-drw-hint pn-fine', text: '타일을 누르면 위에서 그 세션을 봅니다.' }));
    // 지금 보는 세션이 상한 밖이면 그 타일만은 끼워 넣는다 — 켜진 것이 안 보이면 어디 있는지 알 수 없다.
    const selOut = !composing && sel && !shown.some((s) => s.id === sel) ? ss.find((s) => s.id === sel) : null;
    tiles.replaceChildren(...[
      el('button', {
        class: 'pn-stile new' + (composing ? ' on' : ''), type: 'button', title: '새 세션을 엽니다',
        onclick: () => select(null),
      }, el('span', { class: 'pn-stile-ic new' }, pnIcon('plus', 'pn-i')), el('b', { class: 'pn-stile-n', text: '새 세션' })),
      selOut ? tile(selOut) : null,
      ...shown.map(tile),
    ].filter(Boolean) as HTMLElement[]);
  }

  /** 되풀이 이름을 가진 세션의 '마지막으로 시킨 말'을 한 번씩만 찾아 온다. 찾으면 그 타일을 다시 그린다. */
  async function nameLookup(ss: Sess[]): Promise<void> {
    const pname = String((ctx.detail()?.project || {}).name || '');
    if (!pname) return;
    let got = false;
    for (const s of ss) {
      if (askedName.has(s.id) || nameCache.has(s.id)) continue;
      if (norm(sessText(s, pname).main) !== norm(pname)) continue;
      askedName.add(s.id);
      const turns = await fetchTurns(s, 30000);
      if (ctx.dead()) return;
      const last = [...turns].reverse().find((x) => x.who === 'me');
      if (!last) continue;
      nameCache.set(s.id, last.text.replace(/\s+/g, ' ').slice(0, 46));
      got = true;
    }
    if (got && !ctx.dead()) { drawerSig = ''; paintDrawer(mine()); }
  }

  function paint(): void {
    const ss = mine();
    // 지정된 세션이 이 프로젝트에 없으면(다른 프로젝트로 옮겼거나 사라졌다) 맨 위 세션으로.
    if (!composing && sel && !ss.some((s) => s.id === sel)) { sel = ss.length ? ss[0].id : null; composing = !sel; }
    paintDrawer(ss);
    mountStage();
    void nameLookup(ss.slice(0, 10));
  }

  paint();
  return {
    root,
    tick: () => paint(),
    destroy: () => { if (mounted) { mounted.h?.destroy(); mounted = null; } },
  };
}


// ══ 자료 — 공유 폴더에 쌓인 것. 끌어다 놓으면 올라간다 ═══════════════════════════
type AssetFile = { path: string; size: number; mtime: number };
const MACHINE_FILES = new Set(['CLAUDE.md', 'AGENTS.md', '.DS_Store', 'package-lock.json', 'yarn.lock']);
const NOISE_RE = /\/(__pycache__|node_modules|dist|build|\.next|coverage|venv)\//;
const TRASH_DIR = '휴지통';
const isImg = (n: string): boolean => /\.(png|jpe?g|gif|webp|svg)$/i.test(n);
function kindOf(p: string): { kind: string; type: string } {
  if (isImg(p)) return { kind: 'img', type: '그림' };
  if (/\.pdf$/i.test(p)) return { kind: 'pdf', type: 'PDF' };
  if (/\.html?$/i.test(p)) return { kind: 'page', type: '시안' };
  if (/\.(md|txt)$/i.test(p)) return { kind: 'doc', type: '문서' };
  if (/\.(csv|tsv|xlsx?)$/i.test(p)) return { kind: 'file', type: '표' };
  if (/\.(pptx?|key)$/i.test(p)) return { kind: 'file', type: '장표' };
  if (/\.(zip|tar|gz)$/i.test(p)) return { kind: 'file', type: '묶음' };
  return { kind: 'file', type: '파일' };
}

function filesPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-files' });
  const grid = el('div', { class: 'pn-fgrid' });
  const count = el('span', { class: 'pn-fine', text: '' });
  const blobUrls: string[] = [];
  let sig = '';

  const upIn = el('input', { type: 'file', multiple: 'true', hidden: true }) as HTMLInputElement;
  upIn.addEventListener('change', () => {
    const items: UpItem[] = Array.from(upIn.files || []).map((f) => ({ file: f, rel: f.name }));
    upIn.value = '';
    void upload(items);
  });
  const head = el('div', { class: 'pn-head' }, count,
    el('button', { class: 'btn-text', type: 'button', text: '＋ 올리기', title: '컴퓨터에서 파일을 고릅니다', onclick: () => upIn.click() }));
  root.append(upIn, head, grid);

  async function upload(items: UpItem[], emptyDirs: string[] = []): Promise<void> {
    if (!items.length && !emptyDirs.length) return;
    if (!(ctx.id > 0)) { toast('이 화면은 프로젝트 폴더가 없어 파일을 둘 곳이 없어요.', true); return; }
    const ac = new AbortController();
    toast(`${items.length}개를 공유 폴더로 올리는 중이에요…`);
    const r = await upSend({
      items, emptyDirs, signal: ac.signal,
      fileUrl: (rel) => '/api/ui/v6/projects/' + ctx.id + '/file?path=' + encodeURIComponent(rel),
      dirUrl: (d) => '/api/ui/v6/projects/' + ctx.id + '/folder?path=' + encodeURIComponent(d),
    });
    if (ctx.dead()) return;
    upToast(r);
    sig = ''; void paint();
  }
  upDropZone(root, root, (items, emptyDirs) => { void upload(items, emptyDirs); });

  async function files(): Promise<AssetFile[]> {
    const m: any = await api('/api/ui/v6/projects/' + ctx.id + '/shared/manifest').catch(() => null);
    const mf: any[] = (m && m.files) || [];
    return mf
      .filter((f: any) => {
        const p = String(f.path);
        if (p.startsWith(TRASH_DIR + '/')) return false;
        if (MACHINE_FILES.has(base(p))) return false;
        return !NOISE_RE.test('/' + p);
      })
      .map((f: any) => ({ path: String(f.path), size: Number(f.size || 0), mtime: Number(f.mtime || 0) }))
      .sort((a, b) => b.mtime - a.mtime);
  }

  function thumb(f: AssetFile): HTMLElement {
    const k = kindOf(f.path);
    if (k.kind !== 'img') return el('span', { class: 'pn-fic ' + k.kind }, pnIcon(k.kind === 'page' ? 'note' : 'doc', 'pn-i'));
    const img = el('img', { alt: '', loading: 'lazy' }) as HTMLImageElement;
    void fetch(apiUrl('/api/ui/v6/projects/' + ctx.id + '/file?path=' + encodeURIComponent(f.path)), { headers: authHeaders() })
      .then((r) => (r.ok ? r.blob() : null))
      .then((bl) => { if (!bl || ctx.dead()) return; const u = URL.createObjectURL(bl); blobUrls.push(u); img.src = u; })
      .catch(() => { /* 못 받으면 빈 칸으로 둔다 */ });
    return el('span', { class: 'pn-fic img' }, img);
  }

  async function paint(): Promise<void> {
    const fs = await files().catch(() => [] as AssetFile[]);
    if (ctx.dead() || !root.isConnected) return;
    const s2 = fs.map((f) => f.path + f.mtime).join('|');
    if (s2 === sig) return;
    sig = s2;
    count.textContent = fs.length ? fs.length + '개 · 최근 먼저' : '';
    if (!fs.length) {
      grid.replaceChildren(el('div', { class: 'pn-empty' },
        pnIcon('drop', 'pn-i big'),
        el('b', { text: '아직 자료가 없어요.' }),
        el('p', { class: 'pn-fine', text: '파일을 이 칸에 끌어다 놓거나 [＋ 올리기]를 누르세요. 세션이 만든 결과물도 여기 쌓입니다.' })));
      return;
    }
    grid.replaceChildren(...fs.slice(0, 60).map((f) => {
      const k = kindOf(f.path);
      return el('button', {
        class: 'pn-fcard', type: 'button', title: f.path + ' — 엽니다',
        onclick: () => { void openFileViewer(ctx.id, f.path, base(f.path), () => { sig = ''; void paint(); }, '/api/ui/v6/projects/'); },
      }, thumb(f),
        el('b', { class: 'pn-fname ell2', text: base(f.path) }),
        el('span', { class: 'pn-fmeta' }, el('span', { text: k.type }), el('span', { class: 'sep', text: '·' }), el('span', { text: fmtSize(f.size || 0) })));
    }));
  }

  void paint();
  return {
    root,
    tick: () => { void paint(); },
    destroy: () => { blobUrls.forEach((u) => URL.revokeObjectURL(u)); },
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
        el('p', { class: 'pn-fine', text: '프로젝트 설정에서 더하거나, 세션에 "태스크로 나눠 줘"라고 시켜 보세요.' })));
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
        el('button', { class: 'btn-text', type: 'button', text: '프로젝트 설정에서 고치기', onclick: () => ctx.openSettings?.() })));
  }
  paint();
  return { root, tick: paint };
}

// ══ 타임라인 · 리브 ═══════════════════════════════════════════════════════════
function timelinePart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-tl' });
  const tl = createTimeline(root, { scope: '프로젝트 #' + ctx.id, showActors: true, outcomes: true, empty: '아직 남은 것이 없어요.' });
  void loadProjectTimeline(ctx.id, ctx.detail()).then((items) => { if (!ctx.dead()) tl.addAll(items); });
  return { root };
}

function livPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-liv' });
  let chat: ProjectChatHandle | null = null;
  if (ctx.id > 0) chat = mountProjectChat(root, { projectId: ctx.id, onTurnDone: () => ctx.onChanged?.() });
  else root.append(el('p', { class: 'pn-fine', text: '프로젝트가 없는 화면이라 리브 대화는 열 수 없어요.' }));
  return { root, destroy: () => chat?.destroy?.() };
}

export function makePart(type: PartType, ctx: PartCtx): Part {
  if (type === 'sessions') return sessionsPart(ctx);
  if (type === 'files') return filesPart(ctx);
  if (type === 'knowledge') return knowledgePart(ctx);
  if (type === 'tasks') return tasksPart(ctx);
  if (type === 'timeline') return timelinePart(ctx);
  if (type === 'overview') return overviewPart(ctx);
  return livPart(ctx);
}
