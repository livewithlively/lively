// v2/app-studio.ts — **앱 만들기**(#4592 후속, 원준 2026-10-10 «누구나 편하게 앱을 만드는 UX»).
//
//  들어오는 길: 앱 찾기(런치패드) 「워크스페이스 앱」 끝의 「+ 새 앱」 칸 → 런치패드가 닫히고 이 화면이 창 전체에 선다.
//  ① 시작 — 두 가지만 묻는다: «어떤 앱인가»(한 줄 · 예시를 누르면 채워진다) · «어디에서 쓰나»(세션 옆 · 화면 전체 · 둘 다 — 그림 카드).
//  ② 만드는 중 — 가운데(넓게)에 **만들고 있는 앱**이 실제로 뜨고, 옆 칸이 AI 와의 대화다. 업무 세션 화면(대화가 가운데)과 반대라
//     «지금은 일하는 중이 아니라 앱을 만드는 중» 이 배치로 읽힌다. 머리줄은 앱 이름 · 몇 판 · [이전 판으로] · [다 만들었어요].
//
//  새 배관은 없다 — 있는 부품을 엮는다:
//   · 대화 = 일반 세션 하나(spawnSession · 첫 지시에 만드는 규칙을 싣는다)를 대화 보기(renderSession chatHome)로 끼운다.
//   · 앱 = 그 세션의 AI 가 app_save 로 저장하면 워크스페이스에 새 앱이 생긴다. 시작할 때의 앱 목록과 견줘 새로 생긴 id 를 찾는다(폴링),
//     찾으면 mountAppUiFrame 으로 가운데에 띄우고, 'updated' 사건(app_save · app_revert)마다 다시 띄운다.
//   · 판 = fetchAppVersions · revertApp(되돌리기) 그대로.
//  만들던 것은 이 브라우저에 남는다(STUDIO_KEY) — 다시 열면 이어서 만든다.
import { api, el, toast } from '../core.js';
import { spawnSession } from './quick-session.js';
import { mergeSessions, renderSession } from './views.js';
import { takeCreated } from './created-cache.js';
import { mountAppUiFrame, type AppUiFrame } from './app-ui.js';
import { onAppEvent } from './live-sync.js';
import { fetchAppVersions, revertApp } from './app-versions.js';
import type { SessionChatHandle } from '../session-chat.js';

export type StudioPlace = 'side' | 'full' | 'both';
interface StudioRec { sid: string; what: string; place: StudioPlace; appId: string; known: string[]; at: number }

const STUDIO_KEY = 'lively_v2_app_studio';
const PLACE: Record<StudioPlace, { title: string; sub: string; say: string }> = {
  side: { title: '세션 옆에 붙여 쓰는 앱', sub: 'AI 와 일하는 세션 옆에 두고 같이 씁니다', say: '세션 옆(좁은 곁칸, 폭 340px 안팎)에 붙여 쓰는 앱이야. 좁은 폭에서 잘 보이게 만들어 줘.' },
  full: { title: '화면 전체로 여는 앱', sub: '프로젝트 앱처럼 따로 열어 넓게 씁니다', say: '앱 찾기에서 열어 화면 전체로 넓게 쓰는 앱이야. 넓은 화면에 맞게 만들어 줘.' },
  both: { title: '둘 다', sub: '크게도 열고 세션에도 붙입니다', say: '세션 옆 좁은 곁칸에도 붙이고 화면 전체로도 여는 앱이야. 좁을 때와 넓을 때 둘 다 잘 보이게 만들어 줘.' },
};
const EXAMPLES = ['회의 안건을 모으고 정리', '할 일을 적고 끝낸 것 체크', '고객 문의를 기록하고 상태 관리', '읽을 거리 링크를 모아 두기', '주간 보고를 항목별로 적기', '간단한 설문을 받고 결과 보기'];

function readRecs(): StudioRec[] {
  try { const a = JSON.parse(localStorage.getItem(STUDIO_KEY) || '[]'); return Array.isArray(a) ? a.filter((r) => r && r.sid) : []; } catch (_) { return []; }
}
function writeRecs(rs: StudioRec[]): void { try { localStorage.setItem(STUDIO_KEY, JSON.stringify(rs.slice(-12))); } catch (_) { /* noop */ } }
function saveRec(r: StudioRec): void { const rs = readRecs().filter((x) => x.sid !== r.sid); rs.push(r); writeRecs(rs); }
/** 이 브라우저에서 만들던 앱들(앱 찾기가 «만드는 중» 을 보이는 데 쓴다). appId 가 아직 없는 것(첫 판을 기다리는 중)도 든다. */
export function studioDrafts(): Array<{ sid: string; what: string; appId: string }> { return readRecs().map((r) => ({ sid: r.sid, what: r.what, appId: r.appId })); }
export function studioRecForApp(appId: string): { sid: string } | null { const r = readRecs().filter((x) => x.appId === appId).pop(); return r ? { sid: r.sid } : null; }

/** 첫 지시 — 사람이 읽는 말 한 줄 + 만드는 법이 적힌 지식을 가리키는 한 줄. 규칙을 여기 길게 싣지 않는다(대화에 그대로 보인다). */
function brief(what: string, place: StudioPlace): string {
  return `「${what}」 앱을 만들어 줘. ${PLACE[place].say}\n`
    + '(만드는 법은 지식 app-build-quickstart 에 있어. knowledge_get 으로 그것만 읽고, 다른 것을 찾아보지 말고 첫 판을 바로 만들어 저장해 줘. 설명은 쉬운 말로 짧게.)';
}

let root: HTMLElement | null = null;
let teardown: (() => void) | null = null;
export function closeAppStudio(): void { if (teardown) { teardown(); teardown = null; } if (root) { root.remove(); root = null; } }

/** 앱 만들기를 연다. resume 을 주면 만들던 것을 이어서(그 세션 · 그 앱), 없으면 시작 화면부터. */
export function openAppStudio(resume?: { sid: string } | null): void {
  closeAppStudio();
  root = el('div', { class: 'v2-studio', role: 'dialog', 'aria-modal': 'true', 'aria-label': '앱 만들기' });
  document.body.append(root as HTMLElement);
  const rec = resume ? readRecs().find((r) => r.sid === resume.sid) : null;
  if (rec) void build(rec); else start();
}

// ── ① 시작 — 무엇을 · 어디에 ──────────────────────────────────────────────────────────
function start(): void {
  if (!root) return;
  let place: StudioPlace = 'side';
  const input = el('input', { class: 'v2-studio-what', type: 'text', maxlength: '80', placeholder: '예: 회의 안건을 모으고 정리', 'aria-label': '어떤 앱을 만들까요' }) as HTMLInputElement;
  const go = el('button', { class: 'v2-studio-go', type: 'button', text: '만들기 시작' }) as HTMLButtonElement;
  const sync = (): void => { go.disabled = !input.value.trim(); };
  const cards = (Object.keys(PLACE) as StudioPlace[]).map((k) => {
    const b = el('button', { class: 'v2-studio-place' + (k === place ? ' on' : ''), type: 'button', 'data-place': k },
      el('span', { class: 'v2-studio-pic v2-studio-pic--' + k, 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
      el('b', { text: PLACE[k].title }), el('small', { text: PLACE[k].sub }));
    b.onclick = () => { place = k; cards.forEach((c) => c.classList.toggle('on', c === b)); };
    return b;
  });
  const drafts = readRecs().slice().reverse();
  const begin = async (): Promise<void> => {
    const what = input.value.trim(); if (!what || go.disabled) return;
    go.disabled = true; go.textContent = '준비하는 중…';
    //  지금 있는 앱들을 적어 둔다 — 이 뒤에 새로 생기는 앱이 «내가 만들고 있는 앱» 이다.
    let known: string[] = [];
    try { const out: any = await api('/api/ui/apps'); known = (Array.isArray(out?.apps) ? out.apps : []).map((a: any) => String(a.id)); } catch (_) { /* noop */ }
    const s = await spawnSession(brief(what, place));
    if (!s) { go.disabled = false; go.textContent = '만들기 시작'; return; }
    const rec: StudioRec = { sid: s.id, what, place, appId: '', known, at: Date.now() };
    saveRec(rec);
    void api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label: ('앱 만들기 · ' + what).slice(0, 28) }) }).catch(() => { /* 이름은 못 바꿔도 된다 */ });
    void build(rec);
  };
  go.onclick = () => { void begin(); };
  input.addEventListener('input', sync);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); void begin(); } });
  root.replaceChildren(
    el('div', { class: 'v2-studio-top' },
      el('span', { class: 'v2-studio-tag', text: '앱 만들기' }),
      el('span', { class: 'v2-studio-sp' }),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기', onclick: () => closeAppStudio() })),
    el('div', { class: 'v2-studio-start' },
      el('h2', { text: '어떤 앱을 만들까요?' }),
      el('p', { class: 'v2-studio-lead', text: '한 줄이면 됩니다. 만든 뒤에 말로 계속 고칠 수 있어요.' }),
      input,
      el('div', { class: 'v2-studio-ex' }, ...EXAMPLES.map((t) => el('button', { type: 'button', text: t, onclick: () => { input.value = t; sync(); input.focus(); } }))),
      el('h3', { text: '어디에서 쓰는 앱인가요?' }),
      el('div', { class: 'v2-studio-places' }, ...cards),
      el('div', { class: 'v2-studio-act' }, go),
      drafts.length ? el('div', { class: 'v2-studio-drafts' },
        el('h3', { text: '만들던 앱' }),
        ...drafts.slice(0, 5).map((d) => el('button', { type: 'button', class: 'v2-studio-draft', onclick: () => { void build(d); } },
          el('b', { text: d.what }), el('small', { text: d.appId ? '이어서 만들기' : '첫 판을 만드는 중' })))) : null));
  sync(); input.focus();
}

// ── ② 만드는 중 — 가운데 앱 · 옆에 대화 ─────────────────────────────────────────────────
async function build(rec: StudioRec): Promise<void> {
  if (!root) return;
  if (teardown) { teardown(); teardown = null; }
  let dead = false; let frame: AppUiFrame | null = null; let chat: SessionChatHandle | null = null;
  let appTitle = ''; let curVer = 0; let prevVer = 0; let pollT = 0;
  const name = el('b', { class: 'v2-studio-name', text: rec.what });
  const ver = el('span', { class: 'v2-studio-ver', text: '첫 판을 만드는 중' });
  const undo = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '이전 판으로', hidden: true }) as HTMLButtonElement;
  const done = el('button', { class: 'v2-studio-done', type: 'button', text: '다 만들었어요' }) as HTMLButtonElement;
  const band = el('div', { class: 'v2-studio-band', hidden: true });
  const stage = el('div', { class: 'v2-studio-stage v2-studio-stage--' + rec.place });
  const chatHost = el('div', { class: 'v2-studio-chat' });
  const waiting = (): void => {
    stage.replaceChildren(el('div', { class: 'v2-studio-wait' },
      el('span', { class: 'v2-studio-spin', 'aria-hidden': 'true' }),
      el('b', { text: 'AI 가 첫 판을 만들고 있어요' }),
      el('p', { text: '몇 분 걸립니다. 다 되면 여기에 앱이 바로 뜹니다. 이 화면을 닫아도 계속 만들고, 「+ 새 앱」 의 「만들던 앱」 에서 다시 열 수 있어요.' })));
  };
  const paintVer = async (): Promise<void> => {
    if (!rec.appId) return;
    try {
      const vs = await fetchAppVersions(rec.appId); if (dead) return;
      const cur = vs.find((v) => v.is_current) || vs[vs.length - 1];
      curVer = cur ? cur.version_no : 0;
      prevVer = vs.map((v) => v.version_no).filter((n) => n < curVer).sort((a, b) => b - a)[0] || 0;
      ver.textContent = curVer ? curVer + '판' : '';
      undo.hidden = !prevVer; undo.textContent = prevVer ? prevVer + '판으로 되돌리기' : '이전 판으로';
    } catch (_) { /* 판 이력을 못 읽어도 앱은 뜬다 */ }
  };
  const showApp = async (note?: string): Promise<void> => {
    if (dead || !rec.appId) return;
    try {
      const f = await mountAppUiFrame(rec.appId, { sessionId: rec.sid, title: appTitle || rec.what });
      if (dead) { f.destroy(); return; }
      if (frame) frame.destroy();
      frame = f; stage.replaceChildren(f.root);
      await paintVer();
      if (note != null) { band.replaceChildren(el('span', { text: (curVer ? curVer + '판 · ' : '') + (note || '고쳤습니다') })); band.hidden = false; }
    } catch (e: any) {
      stage.replaceChildren(el('div', { class: 'v2-studio-wait' }, el('b', { text: '앱 화면을 띄우지 못했어요' }), el('p', { text: String(e && e.message ? e.message : e) })));
    }
  };
  //  새로 생긴 앱 찾기 — 시작할 때 없던 id. 여럿이면 가장 나중 것.
  const findApp = async (): Promise<void> => {
    if (dead || rec.appId) return;
    try {
      const out: any = await api('/api/ui/apps');
      const fresh = (Array.isArray(out?.apps) ? out.apps : []).filter((a: any) => a && a.status === 'active' && !rec.known.includes(String(a.id)));
      if (fresh.length) {
        const a = fresh[fresh.length - 1]; rec.appId = String(a.id); appTitle = String(a.title || a.id);
        saveRec(rec); name.textContent = appTitle; await showApp('첫 판이 나왔습니다');
        return;
      }
    } catch (_) { /* 다음 차례에 다시 */ }
    pollT = window.setTimeout(() => { void findApp(); }, 4000);
  };
  const off = onAppEvent((ev) => {
    if (dead) return;
    if (!rec.appId) { if (ev.kind === 'updated' || ev.kind === 'attach') { window.clearTimeout(pollT); void findApp(); } return; }
    if (ev.app_id === rec.appId && ev.kind === 'updated') void showApp(ev.note || '고쳤습니다');
  });
  undo.onclick = async () => {
    if (!rec.appId || !prevVer) return;
    undo.disabled = true; const to = await revertApp(rec.appId, prevVer, appTitle); undo.disabled = false;
    if (to != null) await showApp(to + '판으로 되돌렸습니다');
  };
  done.onclick = () => {
    closeAppStudio();
    toast(rec.appId ? `「${appTitle || rec.what}」 앱은 앱 찾기의 「워크스페이스 앱」에 있어요. 다시 고치려면 그 칸의 ⋯ → 「이어서 만들기」.` : '만들던 것은 「+ 새 앱」 → 「만들던 앱」 에서 이어갈 수 있어요.');
  };
  teardown = () => { dead = true; window.clearTimeout(pollT); off(); if (frame) frame.destroy(); if (chat) chat.destroy(); };
  root.replaceChildren(
    el('div', { class: 'v2-studio-top v2-studio-top--build' },
      el('span', { class: 'v2-studio-tag', text: '앱 만드는 중' }), name, ver,
      el('span', { class: 'v2-studio-sp' }), undo, done),
    band,
    el('div', { class: 'v2-studio-body' }, stage, chatHost));
  if (rec.appId) {
    try { const out: any = await api('/api/ui/apps/' + encodeURIComponent(rec.appId)); const a = out?.app || out; if (a && a.title) { appTitle = String(a.title); name.textContent = appTitle; } } catch (_) { /* noop */ }
    await showApp();
  } else { waiting(); void findApp(); }
  //  대화 — 그 세션의 대화 보기를 끼운다(리브와 같은 방식: 목록을 한 번 읽어 그 세션 한 장으로).
  try {
    const [live, logs] = await Promise.all([
      api('/api/ui/terminal/sessions?includeProjects=1').then((d: any) => (d && d.sessions) || []).catch(() => [] as any[]),
      api('/api/ui/v6/sessions?limit=40').then((d: any) => (d && d.sessions) || []).catch(() => [] as any[]),
    ]);
    if (dead) return;
    const made = takeCreated(rec.sid);
    const rows = made ? [made, ...(live as any[])] : (live as any[]);
    chat = renderSession(chatHost, { projects: [], sessions: mergeSessions(rows, logs as any[]), loadedAt: Date.now() } as any, rec.sid, { chatHome: true, solo: true, isVisible: () => !!root && chatHost.isConnected });
  } catch (e: any) {
    chatHost.replaceChildren(el('p', { class: 'v2-muted', text: '대화를 열지 못했어요 — ' + (e && e.message ? e.message : e) }));
  }
}
