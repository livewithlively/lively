// v2/panes-parts.ts — 기본 뷰(v2/panes.ts)의 **부품**들. 한 부품 = 한 탭에 들어가는 내용 하나.
//
//  캔버스(studio.ts)의 위젯과 무엇이 다른가 — 위젯은 '사람이 판에 올려야 생기는 것'이고, 부품은
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

function sessionsPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-sessions' });
  const open = new Map<string, boolean>();          // 카드 펼침(사람이 누른 것) — 기본은 아래 규칙
  //  이름이 프로젝트명과 같은 세션(자동 이름)은 카드 일곱 개가 전부 같은 글자가 된다 — 그럴 땐 **마지막으로 시킨 말**을
  //  이름 자리에 쓴다. 그게 '이 세션이 무엇이었나'의 답이다. 한 번 찾으면 캐시해 두고 다시 묻지 않는다.
  const askedName = new Set<string>();
  const nameCache = new Map<string, string>();
  const cards = new Map<string, { root: HTMLElement; conv: HTMLElement | null; sig: string }>();
  let listSig = '';
  let sending = false;

  const ta = el('textarea', { class: 'pn-new-in', rows: '1', placeholder: '무엇이든 시켜 보세요 — 새 세션이 열립니다.', 'aria-label': '새 세션에 시킬 일' }) as HTMLTextAreaElement;
  const sendBtn = el('button', { class: 'pn-new-send', type: 'button', title: '새 세션을 열고 시킵니다', 'aria-label': '보내기', onclick: () => void spawn() }, pnIcon('send', 'pn-i')) as HTMLButtonElement;
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; });
  ta.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault(); void spawn();
  });
  const composer = el('div', { class: 'pn-new' }, ta, sendBtn);
  const list = el('div', { class: 'pn-slist' });
  root.append(composer, list);

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
      ta.value = ''; ta.style.height = 'auto';
      open.set(sid, true);
      toast('새 세션을 열어 시켰어요 — 목록 맨 위에 올라옵니다.');
      ctx.onChanged?.();
    } catch (e: any) {
      toast('세션을 열지 못했어요 — ' + (e?.message || e), true);
    } finally { sending = false; sendBtn.disabled = false; ta.disabled = false; ta.focus(); }
  }

  function mine(): Sess[] {
    return ctx.data().sessions
      .filter((s) => Number(s.projectId) === ctx.id)
      .sort((a, b) => rank(a) - rank(b) || (b.lastSeen || 0) - (a.lastSeen || 0));
  }

  /** 기본 펼침 — 살아 있는 세션 위에서 셋까지. 살아 있는 게 하나도 없으면 가장 최근 것 한 건(전부 접힌
   *  화면은 '아무 일도 없었다'로 읽힌다). 사람이 접거나 편 것이 있으면 그게 이긴다. */
  const isOpen = (s: Sess, i: number, anyLive: boolean): boolean => {
    const forced = open.get(s.id);
    if (forced != null) return forced;
    return anyLive ? s.live && s.alive && i < 3 : i === 0;
  };

  function card(s: Sess, i: number, anyLive: boolean): HTMLElement {
    const opened = isOpen(s, i, anyLive);
    const raw = s.raw || {};
    // 이름은 사이드바와 같은 규칙으로 짓는다 — 세션 이름이 프로젝트명과 같으면 같은 말이 화면에 두 번 뜬다(#1754).
    const pname = String((ctx.detail()?.project || {}).name || '');
    const t = sessText(s, pname);
    const dup = !!pname && norm(t.main) === norm(pname);
    // 이름을 끝내 못 찾은 세션(자동 이름 + 남은 대화 없음)은 **세션 꼬리**로 구분한다 —
    //  '세션 · 1일 전'처럼 시각으로 쓰면 같은 날 것끼리 글자가 똑같아져 구분이 안 된다(오른쪽에 시각이 이미 있다).
    const tailId = String(s.id).split('-').pop() || String(s.id);
    const title = nameCache.get(s.id) || (dup ? '' : t.main) || ('세션 ' + tailId.slice(0, 8));
    const work = t.sub || String(raw.title || '').trim();
    const workOk = !!work && !INJ_RE.test(work) && work.toLowerCase() !== String(raw.harness || '').toLowerCase();
    const head = el('div', { class: 'pn-scard-h' },
      el('button', {
        class: 'pn-scard-tw', type: 'button', 'aria-expanded': String(opened),
        title: opened ? '접습니다' : '펼쳐서 대화를 봅니다',
        onclick: () => { open.set(s.id, !opened); listSig = ''; paint(); },
      }, pnIcon('chev', 'pn-i sm pn-chev' + (opened ? ' on' : ''))),
      el('span', { class: 'v2-dot ' + dotCls(s.stateKey), 'aria-hidden': 'true' }),
      el('b', { class: 'pn-sname ell', title: s.label || s.id, text: title }),
      el('span', { class: 'pn-smeta' }, el('span', { text: s.stateLabel }), el('span', { class: 'sep', text: '·' }), el('span', { text: when(s.lastSeen) })),
      el('a', { class: 'pn-sopen', href: '#/s/' + encodeURIComponent(s.id), title: '세션 화면으로 갑니다', text: '열기 ↗' }));
    const box = el('div', { class: 'pn-scard' + (s.stateKey === 'waiting' ? ' wait' : '') + (opened ? ' open' : '') }, head);
    if (workOk) box.append(el('div', { class: 'pn-swork ell', title: work, text: work }));
    return box;
  }

  function convBody(s: Sess, box: HTMLElement): HTMLElement {
    const conv = el('div', { class: 'pn-conv' });
    const inp = el('input', { class: 'pn-sin', type: 'text', placeholder: '이 세션에 이어서 말하기 — Enter', 'aria-label': '이 세션에 이어서 말하기' }) as HTMLInputElement;
    inp.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const text = inp.value.trim();
      if (!text) return;
      inp.disabled = true;
      void api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/prompt', { method: 'POST', body: JSON.stringify({ text }) })
        .then(() => {
          inp.value = '';
          conv.append(el('div', { class: 'pn-msg me pend' }, el('span', { class: 'who', text: '나' }), el('div', { class: 'tx', text })));
          conv.scrollTop = conv.scrollHeight;
        })
        .catch((err: any) => toast('보내지 못했어요 — ' + (err?.message || err), true))
        .finally(() => { inp.disabled = false; inp.focus(); });
    });
    const key = (action: string, label: string, primary?: boolean): HTMLElement =>
      el('button', { class: 'btn btn-sm ' + (primary ? 'btn-primary' : 'btn-ghost'), type: 'button', text: label, onclick: () => {
        void api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/keys', { method: 'POST', body: JSON.stringify({ action }) })
          .then(() => toast(label + ' — 보냈어요.')).catch((err: any) => toast('실패했어요 — ' + (err?.message || err), true));
      } });
    box.append(conv);
    if (s.stateKey === 'waiting') box.append(el('div', { class: 'pn-keys' }, el('span', { class: 'pn-wait-k', text: '확인이 필요해요' }), key('approve', '승인', true), key('deny', '거부'), key('interrupt', '멈춤')));
    box.append(el('div', { class: 'pn-sfoot' }, inp));
    return conv;
  }

  async function fillConv(s: Sess, conv: HTMLElement, ref: { sig: string }): Promise<void> {
    const turns = await fetchTurns(s, 30000);
    if (ctx.dead() || !conv.isConnected) return;
    const shown = turns.slice(-6);
    const sig = shown.map((t) => t.who + t.text.length).join(',');
    if (ref.sig === sig) return;              // 변화 없음 — 스크롤·입력 그대로 둔다
    ref.sig = sig;
    const atBottom = conv.scrollHeight - conv.scrollTop - conv.clientHeight < 40;
    // ⚠ replaceChildren 은 el() 과 달리 null 을 걸러 주지 않는다 — 조건부 자식은 배열로 모아 filter 한다.
    conv.replaceChildren(...[
      shown.length ? null : el('p', { class: 'pn-fine', text: s.live ? '아직 주고받은 말이 없어요.' : '남은 대화 기록이 없어요 — [열기]로 세션 화면에서 봅니다.' }),
      ...shown.map((t) => el('div', { class: 'pn-msg ' + t.who },
        el('span', { class: 'who', text: t.who === 'me' ? '나' : 'AI' }),
        el('div', { class: 'tx', text: t.text.length > 420 ? t.text.slice(0, 420) + '…' : t.text }))),
    ].filter(Boolean) as HTMLElement[]);
    if (atBottom) conv.scrollTop = conv.scrollHeight;
  }

  function paint(): void {
    const ss = mine();
    const anyLive = ss.some((s) => s.live && s.alive);
    const sig = ss.map((s, i) => s.id + s.stateKey + (isOpen(s, i, anyLive) ? '1' : '0') + (s.raw?.title || '')).join('|');
    if (sig === listSig) {                    // 목록 구성은 그대로 — 펼친 카드의 대화만 갱신한다
      ss.forEach((s, i) => { if (!isOpen(s, i, anyLive)) return; const c = cards.get(s.id); if (c?.conv) void fillConv(s, c.conv, c as any); });
      return;
    }
    listSig = sig;
    cards.clear();
    void nameLookup(ss.slice(0, 8));
    if (!ss.length) {
      list.replaceChildren(el('div', { class: 'pn-empty' },
        pnIcon('chat', 'pn-i big'),
        el('b', { text: '아직 세션이 없어요.' }),
        el('p', { class: 'pn-fine', text: '위 칸에 시킬 일을 적으면 이 프로젝트에 붙은 AI 세션이 열리고, 여기 카드로 쌓입니다.' })));
      return;
    }
    const rows: HTMLElement[] = [];
    ss.forEach((s, i) => {
      const box = card(s, i, anyLive);
      const ref = { root: box, conv: null as HTMLElement | null, sig: '' };
      if (isOpen(s, i, anyLive)) { ref.conv = convBody(s, box); void fillConv(s, ref.conv, ref); }
      cards.set(s.id, ref);
      rows.push(box);
    });
    list.replaceChildren(...rows);
  }

  /** 되풀이 이름을 가진 세션의 '마지막으로 시킨 말'을 한 번씩만 찾아 온다. 찾으면 그 카드만 다시 그린다. */
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
    if (got && !ctx.dead()) { listSig = ''; paint(); }
  }

  paint();
  return { root, tick: () => paint() };
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
