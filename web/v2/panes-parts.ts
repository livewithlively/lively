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
import { confirmSessionForget } from '../session-actions.js';
import { fmtSize, openFileViewer } from '../projects/files.js';
import { upDropZone, upSend, upToast, type UpItem } from '../projects/files-upload.js';
import { mountProjectChat, type ProjectChatHandle } from '../project-chat.js';
import { createTimeline } from '../timeline.js';
import { loadProjectTimeline } from '../timeline-sources.js';
import { runPrefs } from './run-picker.js';
import { sessText } from './side.js';
import { type Sess, type V2Data } from './views.js';

export type PartType = 'sessions' | 'files' | 'knowledge' | 'tasks' | 'timeline' | 'overview' | 'liv' | 'archive';

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
  /** 세션 부품만 — 칸의 탭 줄이 '어느 세션을 보나'를 이걸로 갈아 끼운다(null = 새 세션 자리). */
  selectSession?: (sid: string | null) => void;
  /** 세션 부품만 — 지금 보는 세션 id(탭 줄이 어느 탭을 켤지 안다). null = 새 세션 자리. */
  currentSession?: () => string | null;
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
  // 이름을 '보관함'이 아니라 **보관한 세션**으로 둔다(원준 2026-08-20) — 무엇을 보관하는지가 이름에서 바로 읽혀야 한다.
  { type: 'archive', name: '보관한 세션', icon: 'box', hint: '닫아 둔 AI 세션입니다. 대화 그대로 다시 살릴 수 있어요.' },
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
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  cols: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M15 5v14"/>',
  drop: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 19h14"/>',
  box: '<path d="M3 7h18v4H3z"/><path d="M5 11v8h14v-8"/><path d="M10 15h4"/>',
  undo: '<path d="M4 9h11a5 5 0 0 1 0 10h-6"/><path d="M8 5L4 9l4 4"/>',
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
  return nameCache.get(s.id) || (dup ? '' : t.main) || ('세션 ' + tailId.slice(0, 8));
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
  let composing = !sel;                               // 새 세션 자리(탭 줄의 [＋ 새 세션])
  let sending = false;
  let mounted: { sid: string; h: { destroy(): void } | null } | null = null;

  // 위(그리고 전부) — 세션 화면이 통째로 들어오는 자리
  const stage = el('div', { class: 'pn-stage' });
  root.append(stage);

  // 새 세션 자리 — 세션이 없거나 [＋ 새 세션]을 골랐을 때만
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
      el('p', { class: 'pn-fine', text: '시킬 일을 적으면 이 프로젝트에 붙은 AI 세션이 열리고, 위 탭 줄에 그 세션 탭이 생깁니다.' })),
    el('div', { class: 'pn-sfoot' }, el('div', { class: 'pn-new' }, ta, sendBtn)));

  const mine = (): Sess[] => ctx.data().sessions
    .filter((s) => Number(s.projectId) === ctx.id)
    .sort((a, b) => rank(a) - rank(b) || (b.lastSeen || 0) - (a.lastSeen || 0));

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
    mountStage();
  }

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
      seedSessName(sid, text);
      ta.value = ''; ta.style.height = 'auto';
      ctx.onChanged?.();
      select(sid);
      toast('새 세션을 열었어요.');
    } catch (e: any) {
      toast('세션을 열지 못했어요 — ' + (e?.message || e), true);
    } finally { sending = false; sendBtn.disabled = false; ta.disabled = false; }
  }

  function paint(): void {
    const ss = mine();
    // 지정된 세션이 이 프로젝트에 없으면(옮겼거나 사라졌다) 맨 위 세션으로.
    if (!composing && sel && !ss.some((s) => s.id === sel)) { sel = ss.length ? ss[0].id : null; composing = !sel; }
    if (!ss.length && !composing) composing = true;
    mountStage();
  }

  paint();
  return {
    root,
    tick: () => paint(),
    destroy: () => { if (mounted) { mounted.h?.destroy(); mounted = null; } },
    selectSession: (sid) => select(sid),
    currentSession: () => (composing ? null : sel),
  };
}

// ══ 자료 — 공유 폴더에 쌓인 것. 끌어다 놓으면 올라간다 ═══════════════════════════
type AssetFile = { path: string; size: number; mtime: number };
const MACHINE_FILES = new Set(['CLAUDE.md', 'AGENTS.md', '.DS_Store', 'package-lock.json', 'yarn.lock']);
const NOISE_RE = /\/(__pycache__|node_modules|dist|build|\.next|coverage|venv)\//;
const TRASH_DIR = '휴지통';
const isImg = (n: string): boolean => /\.(png|jpe?g|gif|webp|svg)$/i.test(n);
// 아이콘이 아니라 **내용이 보이게**(원준 2026-08-20) — kind 가 미리보기 방식을 정한다.
//  img=그대로 · pdf/page=축소해 실제로 렌더 · text=앞부분을 글자로 · video=첫 프레임 · file=아이콘(렌더할 방법이 없는 것들).
const TEXTY = /\.(md|markdown|txt|log|csv|tsv|json|jsonl|ya?ml|toml|ini|conf|env|sql|sh|bash|zsh|ps1|py|rb|go|rs|java|kt|swift|c|h|cpp|cc|hpp|cs|php|pl|lua|r|ts|tsx|js|jsx|mjs|cjs|css|scss|less|xml|svg|gitignore|dockerfile|makefile)$/i;
function kindOf(p: string): { kind: string; type: string } {
  if (isImg(p)) return { kind: 'img', type: '그림' };
  if (/\.pdf$/i.test(p)) return { kind: 'pdf', type: 'PDF' };
  if (/\.html?$/i.test(p)) return { kind: 'page', type: '시안' };
  if (/\.(mp4|webm|mov|m4v)$/i.test(p)) return { kind: 'video', type: '영상' };
  if (/\.(md|markdown|txt)$/i.test(p)) return { kind: 'text', type: '문서' };
  if (/\.(csv|tsv)$/i.test(p)) return { kind: 'text', type: '표' };
  if (/\.xlsx?$/i.test(p)) return { kind: 'file', type: '표' };
  if (/\.(pptx?|key)$/i.test(p)) return { kind: 'file', type: '장표' };
  if (/\.docx?$|\.hwpx?$/i.test(p)) return { kind: 'file', type: '문서' };
  if (/\.(zip|tar|gz|7z|rar)$/i.test(p)) return { kind: 'file', type: '묶음' };
  if (TEXTY.test(p)) return { kind: 'text', type: '코드' };
  return { kind: 'file', type: '파일' };
}
// 미리보기는 **작은 종이 한 장**(300×246)을 만들어 카드 크기에 맞춰 줄인다 — 글자·표가 뭉개지지 않고 비율이 산다.
const PV_W = 300;   // 종이 폭(높이는 CSS 가 카드 비율로 잡는다)
const PV_MAX = { pdf: 12e6, page: 4e6, text: 512e3, img: 24e6, video: 80e6 } as Record<string, number>;

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

  // ── 미리보기 ──────────────────────────────────────────────────────────────
  //  · **보일 때만** 받는다(IntersectionObserver) — 자료가 수십 개인 칸에서 전부 받으면 화면이 멈춘다.
  //  · 한 번에 세 개까지만 받는다(fetch 큐) — 좁은 칸에서 브라우저가 연결로 막히지 않게.
  //  · 큰 파일은 건너뛰고 아이콘으로 둔다(형식별 상한 PV_MAX) — 미리보기 하나 보자고 100MB 를 내려받지 않는다.
  const seenPv = new WeakSet<HTMLElement>();
  let inflight = 0;
  const queue: Array<() => Promise<void>> = [];
  function pump(): void {
    while (inflight < 3 && queue.length) {
      const job = queue.shift()!;
      inflight++;
      void job().catch(() => { /* 하나 실패해도 나머지는 계속 */ }).then(() => { inflight--; pump(); });
    }
  }
  const io: IntersectionObserver | null = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((ents) => {
      for (const e of ents) {
        const n = e.target as HTMLElement;
        if (!e.isIntersecting || seenPv.has(n)) continue;
        seenPv.add(n);
        io?.unobserve(n);
        const path = n.dataset.pv || '';
        const kind = n.dataset.pvk || '';
        const size = Number(n.dataset.pvs || 0);
        queue.push(() => fillPreview(n, path, kind, size));
        pump();
      }
    }, { rootMargin: '250px' })
    : null;

  /** 카드 폭에 맞춰 종이(300×246)를 줄인다 — 칸 폭이 바뀌면 다시 맞춘다. */
  function fitPaper(box: HTMLElement, paper: HTMLElement): void {
    const w = box.clientWidth || 92;
    paper.style.transform = 'scale(' + (w / PV_W).toFixed(4) + ')';
  }
  const fits: Array<[HTMLElement, HTMLElement]> = [];
  const ro: ResizeObserver | null = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { for (const [b, pp] of fits) fitPaper(b, pp); })
    : null;
  function paper(box: HTMLElement, inner: HTMLElement): void {
    const pp = el('div', { class: 'pn-fpaper' }, inner) as HTMLElement;
    box.replaceChildren(pp);
    fits.push([box, pp]);
    fitPaper(box, pp);
    ro?.observe(box);
  }

  async function fillPreview(box: HTMLElement, path: string, kind: string, size: number): Promise<void> {
    if (ctx.dead() || !box.isConnected) return;
    if (size && size > (PV_MAX[kind] || 4e6)) return;              // 너무 큰 것은 아이콘 그대로
    const url = apiUrl('/api/ui/v6/projects/' + ctx.id + '/file?path=' + encodeURIComponent(path));
    if (kind === 'text' || kind === 'page') {
      // 앞부분만 — Range 를 무시하는 서버여도 글자만 잘라 쓰므로 화면은 같다. 416(범위 거부)이면 통째로 받는다.
      let r = await fetch(url, { headers: { ...authHeaders(), Range: 'bytes=0-' + (kind === 'page' ? 400_000 : 4095) } });
      if (r.status === 416) r = await fetch(url, { headers: authHeaders() });
      if (!r.ok || ctx.dead() || !box.isConnected) return;
      const raw = await r.text();
      if (!raw.trim()) return;
      box.classList.add('has-pv');
      if (kind === 'text') { paper(box, el('pre', { class: 'pn-fpre', text: raw.slice(0, 1400) })); return; }
      // ⚠ 시안(HTML)은 **srcdoc + 빈 sandbox** 로 그린다. blob 주소를 sandbox 프레임에 물리면 그 프레임은
      //  불투명 출처라 blob 을 읽을 권한이 없어 **흰 칸**이 된다(실측 2026-08-20 — 시안 미리보기가 전부 백지였다).
      //  srcdoc 은 내용을 그 자리에 넘기므로 출처 문제가 없고, 빈 sandbox 가 스크립트·폼·상위 접근을 모두 막는다.
      const frame = el('iframe', { class: 'pn-fframe', sandbox: '', loading: 'lazy', tabindex: '-1', 'aria-hidden': 'true' }) as HTMLIFrameElement;
      frame.srcdoc = raw.slice(0, 400_000);
      paper(box, frame);
      return;
    }
    const r = await fetch(url, { headers: authHeaders() });
    if (!r.ok || ctx.dead() || !box.isConnected) return;
    const bl = await r.blob();
    const u = URL.createObjectURL(kind === 'pdf' ? new Blob([bl], { type: 'application/pdf' }) : bl);
    blobUrls.push(u);
    if (ctx.dead() || !box.isConnected) return;
    box.classList.add('has-pv');
    if (kind === 'img') {
      box.replaceChildren(el('img', { alt: '', src: u }));
    } else if (kind === 'video') {
      const v = el('video', { src: u, muted: 'true', playsinline: 'true', preload: 'metadata' }) as HTMLVideoElement;
      v.muted = true;
      box.replaceChildren(v);
      // 첫 프레임을 세운다 — metadata 만으로 검은 칸이 남는 브라우저가 있어 0.1초로 옮겨 한 장을 그린다.
      v.addEventListener('loadedmetadata', () => { try { v.currentTime = Math.min(0.1, (v.duration || 1) / 10); } catch (_) { /* noop */ } }, { once: true });
    } else if (kind === 'pdf') {
      // 크롬·사파리는 PDF 를 프레임 안에서 직접 그린다 — 첫 장만, 도구모음 없이.
      paper(box, el('iframe', { class: 'pn-fframe', src: u + '#page=1&toolbar=0&navpanes=0&scrollbar=0&view=FitH', loading: 'lazy', tabindex: '-1', 'aria-hidden': 'true' }));
    }
  }

  function thumb(f: AssetFile): HTMLElement {
    const k = kindOf(f.path);
    const box = el('span', { class: 'pn-fic ' + k.kind, 'data-pv': f.path, 'data-pvk': k.kind, 'data-pvs': String(f.size || 0) },
      pnIcon(k.kind === 'page' ? 'note' : k.kind === 'video' ? 'img' : 'doc', 'pn-i')) as HTMLElement;
    if (k.kind !== 'file') {
      if (io) io.observe(box);
      else { seenPv.add(box); queue.push(() => fillPreview(box, f.path, k.kind, f.size || 0)); pump(); }
    }
    return box;
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
    destroy: () => { io?.disconnect(); ro?.disconnect(); blobUrls.forEach((u) => URL.revokeObjectURL(u)); },
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
      await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/restore', { method: 'POST' });
      toast('세션을 되살렸어요 — 대화가 이어집니다.');
      ctx.onChanged?.();
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

export function makePart(type: PartType, ctx: PartCtx): Part {
  if (type === 'sessions') return sessionsPart(ctx);
  if (type === 'archive') return archivePart(ctx);
  if (type === 'files') return filesPart(ctx);
  if (type === 'knowledge') return knowledgePart(ctx);
  if (type === 'tasks') return tasksPart(ctx);
  if (type === 'timeline') return timelinePart(ctx);
  if (type === 'overview') return overviewPart(ctx);
  return livPart(ctx);
}
