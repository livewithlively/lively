// web/v2/panes-console.ts — 곁칸 «콘솔» (#4876, 원준 2026-10-19) — 첫 탭. 세션에 시키는 일을 돕고, 다녀온 사이 생긴 것과 남긴 것을 보여 준다.
//
//  원준: «세션을 열기 전에는 저 사이드바 위젯 애초에 볼 일이 없어 … 지금 이 세션 이탈했다가 다른 세션 가 있다가 다시 돌아올 때 볼만한 게
//   필요한 거야 … 허가를 기다립니다 저런 거 여기 띄울 필요 없음 … 아이콘은 사이드 콘솔 같은 느낌 … 세션의 조작을 도와주는 것임.»
//  때는 둘(lib/console-phase):
//   · A 시작 — 세션을 열고 첫 답 전. «알려 줄 것» 점검표(프로젝트 · 선행 프로젝트 · 지식 · 규칙 · 레포 · 자료 · 태스크 · 실행 설정).
//     여기서 채운 것은 AGENTS.md 가 다시 생성되어 **다음 지시부터** 세션이 안다(src/v6/agents-md.ts · 동적 주입).
//   · B 돌아왔을 때 — 첫 답 뒤 언제나(끝난 세션도). «다녀온 사이»(마지막으로 본 뒤 생긴 것) → 처음 시킨 것 → 알려 준 것(접힘) → 종류 칩 · 찾기 · 남긴 것.
//  조작은 바닥 줄 — [＋ 파일](compose-attach 그대로 · 올라간 경로를 글칸에 넣는다) · [지시 문장 ▾](넣기만 · 보내지 않는다) · [멈추기](keys interrupt).
//  재료는 전부 있는 통로다: 내 질문 `GET …/sessions/:id/prompts` · 남긴 것 = 셸이 세션마다 쥔 발자취(ctx.trailItems) · 프로젝트 상세(ctx.detail) ·
//   추천 `GET /api/ui/v6/projects/:id/recommend-knowledge` · 선행 `POST …/link` · 필요지식 `POST …/knowledge` · 글칸 넣기 sess-input.putIntoSession.
//  ⚠ 부품은 «지금 보는 세션의 것»(#1819) — document 이벤트 금지, 세션이 바뀌면 통째로 갈아 세운다.
import { api, el, relTime, replaceKids, toast } from '../core.js';
import { composerAttach } from './compose-attach.js';
import { putIntoSession } from './sess-input.js';
import { openInViewerPart, pnIcon } from './panes-kit.js';
import { requestOpenRoute } from './ctx-registry.js';
import { knHref } from '../lib/kn-links.js';
import { sessionTaskOrder } from '../lib/task-pane.js';
import { cleanAskText } from '../lib/ask-text.js';
import {
  checklistRows, consoleKind, consolePhase, filterItems, hasReplyIn, KIND_LABEL, kindCounts, phrasesFor, readLeftAt, sinceAway,
  type CheckRow, type ConsoleKind, type ConsolePhase,
} from '../lib/console-phase.js';
import type { TlItem } from '../timeline.js';
import type { Part, PartCtx } from './panes-parts.js';

type Prompt = { text: string; ts: string };
type Rec = { name: string; title: string | null; similarity?: number };
type ProjRow = { id: number; name: string; status?: string | null };
const PROMPTS_EVERY_MS = 20_000;   // 내 질문 목록은 파일을 읽는 길이라 자주 묻지 않는다(틱은 8초)

export function consolePart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-con' });
  const body = el('div', { class: 'pn-con-body' });
  const foot = el('div', { class: 'pn-con-foot' });
  root.append(body, foot);

  // ── 상태 ──
  let sid: string | null = null;
  let prompts: Prompt[] = [];
  let promptsAt = 0;
  let recs: Rec[] | null = null;              // 추천 지식(프로젝트마다 한 번)
  let recsFor = 0;
  let picked = new Set<string>();             // 추천에서 체크한 것
  let knOpen = false;                         // 지식 고르기 펼침
  let priorOpen = false;                      // 선행 고르기 화면
  let projRows: ProjRow[] | null = null;
  let toldOpen = false;                       // B 에서 «알려 준 것» 펼침
  let kind: ConsoleKind | 'all' = 'all';
  let query = '';
  let menuEl: HTMLElement | null = null;
  let destroyed = false;

  const row = (): any => (sid ? (ctx.data().sessions as any[]).find((x) => x.id === sid) : null) || null;
  const ids = (): string[] => { const s = row(); return [sid, s?.id, s?.logId, s?.raw?.claudeSessionId, ...(s?.altIds || [])].filter((x): x is string => !!x); };
  const proj = (): any => { const d = ctx.detail(); return (d && d.project) || d || {}; };
  const edges = (): any => { const d = ctx.detail(); return (d && (d.edges || (d.project && d.project.edges))) || { outgoing: [] }; };
  const priorOf = (): Array<{ id: number; name: string }> => ((edges().outgoing || []) as any[])
    .filter((e) => e && (e.relation === 'follow_up' || e.relation === 'supersedes') && e.project_id)
    .map((e) => ({ id: Number(e.project_id), name: String(e.project_name || '') }));
  const alive = (): boolean => { const s = row(); return !!s && !!s.live && !!s.alive; };
  const working = (): boolean => { const s = row(); return !!s && (s.stateKey === 'busy' || !!s.raw?.working); };

  // ── 파일 넣기 — 새 세션 글칸과 같은 첨부 부품. 올라가면 그 꼬리(좌표)를 글칸에 넣는다. ──
  const att = composerAttach({ projectId: () => ctx.id, onChanged: () => ctx.onChanged?.(), dead: () => destroyed });
  const putBtn = el('button', { class: 'pn-con-put', type: 'button', text: '글칸에 넣기', hidden: true,
    onclick: () => {
      if (att.busy()) { toast('파일을 올리는 중이에요 — 다 올라가면 넣어 주세요.'); return; }
      const tail = att.tail();
      if (!tail) return;
      if (putIntoSession(ids(), tail.trim())) { toast('입력칸에 넣었어요 — 설명을 적고 보내세요.'); att.clear(); putBtn.hidden = true; }
      else toast('이 세션의 입력칸을 찾지 못했어요 — 세션 화면이 떠 있어야 합니다.', true);
    } }) as HTMLButtonElement;
  const attRow = el('div', { class: 'pn-con-att' }, att.chips, putBtn, att.fileIn);
  const attObs = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => { putBtn.hidden = att.chips.hidden; }) : null;
  attObs?.observe(att.chips, { attributes: true, attributeFilter: ['hidden'] });

  function closeMenu(): void { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function openMenu(anchor: HTMLElement, phase: ConsolePhase): void {
    if (menuEl) { closeMenu(); return; }
    const p = proj();
    const tasks: any[] = Array.isArray(p.tasks) ? p.tasks : [];
    const mine = sessionTaskOrder(tasks as any[], ids())[0] as any;
    const list = phrasesFor(phase, { prior: priorOf(), tasks: tasks.length, task: mine ? { id: Number(mine.id) } : null });
    const m = el('div', { class: 'pn-con-menu', role: 'menu' },
      el('div', { class: 'pn-con-menu-h', text: '지시 문장 · 넣기만 하고 보내지 않습니다' }),
      ...list.map((ph) => el('button', { class: 'pn-con-mi', type: 'button', role: 'menuitem',
        onclick: () => { closeMenu(); if (putIntoSession(ids(), ph.text)) toast('입력칸에 넣었어요 — 읽어 보고 보내세요.'); else toast('이 세션의 입력칸을 찾지 못했어요.', true); } },
        el('span', { class: 'pn-con-mi-t', text: ph.text }), el('small', { text: ph.hint }))));
    foot.append(m); menuEl = m;
    anchor.setAttribute('aria-expanded', 'true');
    //  바깥을 누르면 닫는다 — 이 칸 안에서만 듣는다(document 금지 #1819).
    const off = (ev: Event): void => { if (menuEl && !menuEl.contains(ev.target as Node) && ev.target !== anchor) { closeMenu(); anchor.removeAttribute('aria-expanded'); root.removeEventListener('pointerdown', off, true); } };
    root.addEventListener('pointerdown', off, true);
  }

  const phraseBtn = el('button', { class: 'pn-con-fb', type: 'button', text: '지시 문장 ▾', onclick: () => openMenu(phraseBtn, phaseNow) }) as HTMLButtonElement;
  const stopBtn = el('button', { class: 'pn-con-fb warn', type: 'button', text: '멈추기', hidden: true,
    onclick: async () => {
      if (!sid) return;
      try { await api(`/api/ui/terminal/sessions/${encodeURIComponent(sid)}/keys`, { method: 'POST', body: JSON.stringify({ action: 'interrupt' }) }); toast('멈추라고 보냈어요.'); }
      catch (e: any) { toast('멈추지 못했어요 — ' + (e?.message || e), true); }
    } }) as HTMLButtonElement;
  //  첨부 부품의 제 단추(att.btn)는 글칸 줄 모양이라 여기 안 세운다 — 이 칸의 단추가 같은 피커(att.fileIn)를 연다.
  const fileBtn = el('button', { class: 'pn-con-fb pri', type: 'button', text: '＋ 파일', title: '파일·그림을 올리고 그 경로를 입력칸에 넣습니다', onclick: () => (att.fileIn as HTMLInputElement).click() }) as HTMLButtonElement;
  foot.append(fileBtn, phraseBtn, stopBtn);
  let phaseNow: ConsolePhase = 'none';

  // ── 데이터 ──
  async function loadPrompts(force = false): Promise<void> {
    if (!sid) return;
    if (!force && Date.now() - promptsAt < PROMPTS_EVERY_MS) return;
    promptsAt = Date.now();
    const s = sid;
    try {
      const d: any = await api(`/api/ui/terminal/sessions/${encodeURIComponent(s)}/prompts`);
      if (destroyed || s !== sid) return;
      const arr = Array.isArray(d?.prompts) ? d.prompts : [];
      prompts = arr.map((p: any) => ({ text: cleanAskText(String(p.text || '')) || '', ts: String(p.ts || '') })).filter((p: Prompt) => !!p.text);
      paint();
    } catch { /* 기록이 아직 없다(첫 대화 전) — 다음 틱에 다시 */ }
  }
  async function loadRecs(): Promise<void> {
    if (!ctx.id || recsFor === ctx.id) return;
    recsFor = ctx.id;
    try {
      const d: any = await api(`/api/ui/v6/projects/${ctx.id}/recommend-knowledge`);
      if (destroyed) return;
      const arr = Array.isArray(d) ? d : (d?.knowledge || d?.items || d?.rows || []);
      recs = (arr as any[]).slice(0, 6).map((r) => ({ name: String(r.name), title: r.title ?? null, similarity: Number(r.similarity ?? r.score ?? 0) }));
      paint();
    } catch { recs = []; }
  }
  async function loadProjects(): Promise<void> {
    if (projRows) return;
    try {
      const d: any = await api('/api/ui/v6/projects?mine=true&limit=30');
      const arr = Array.isArray(d) ? d : (d?.projects || []);
      projRows = (arr as any[]).filter((p) => Number(p.id) !== ctx.id && String(p.level || 'project') === 'project').map((p) => ({ id: Number(p.id), name: String(p.name || ''), status: p.status ?? null }));
    } catch { projRows = []; }
    paint();
  }
  async function linkPrior(to: number, unlink = false): Promise<void> {
    try {
      await api(`/api/ui/v6/projects/${ctx.id}/link`, { method: 'POST', body: JSON.stringify({ to, relation: 'follow_up', unlink }) });
      toast(unlink ? '선행에서 뺐어요.' : '선행 프로젝트로 이었어요 — 다음 지시부터 세션이 압니다.');
      ctx.onChanged?.();
    } catch (e: any) { toast('잇지 못했어요 — ' + (e?.message || e), true); }
  }
  async function linkKnowledge(): Promise<void> {
    const names = [...picked];
    if (!names.length) { toast('넣을 지식을 하나 이상 고르세요.'); return; }
    let ok = 0;
    for (const name of names) {
      try { await api(`/api/ui/v6/projects/${ctx.id}/knowledge`, { method: 'POST', body: JSON.stringify({ name, relation: 'required' }) }); ok++; }
      catch { /* 하나 실패해도 나머지는 넣는다 */ }
    }
    picked = new Set(); knOpen = false; recsFor = 0; recs = null;
    toast(ok ? `지식 ${ok}건을 넣었어요 — 다음 지시부터 세션이 압니다.` : '넣지 못했어요.', !ok);
    ctx.onChanged?.();
    void loadRecs();
  }

  // ── 그리기 ──
  const dot = (st: CheckRow['st']): HTMLElement => el('span', { class: 'pn-con-st ' + st, 'aria-hidden': 'true' }, st === 'done' ? pnIcon('check', 'pn-i') : null);
  function checkRow(r: CheckRow): HTMLElement {
    const act = r.action ? el('button', { class: 'pn-con-a' + (r.st === 'todo' && r.key === 'prior' ? ' pri' : ''), type: 'button', text: r.action, onclick: () => onCheckAction(r) }) : el('span');
    return el('div', { class: 'pn-con-ck', 'data-key': r.key }, dot(r.st),
      el('div', { class: 'pn-con-ck-b' }, el('div', { class: 'pn-con-ck-n', text: r.name }), el('div', { class: 'pn-con-ck-v' + (r.st === 'todo' ? ' todo' : ''), text: r.value, title: r.value })),
      act);
  }
  function onCheckAction(r: CheckRow): void {
    if (r.key === 'prior') { priorOpen = true; void loadProjects(); paint(); return; }
    if (r.key === 'knowledge') { knOpen = !knOpen; void loadRecs(); paint(); return; }
    if (r.key === 'files') { (att.fileIn as HTMLInputElement).click(); return; }
    if (r.key === 'project' || r.key === 'rules' || r.key === 'repos') { if (ctx.openSettings) ctx.openSettings(); else if (ctx.id) requestOpenRoute('#/p/' + ctx.id); return; }
  }
  function candList(): HTMLElement | null {
    if (!knOpen) return null;
    const kn = proj().knowledge || {};
    const have = new Set<string>(((kn.required || []) as any[]).map((k) => String(k.name)));
    const cands = (recs || []).filter((r) => !have.has(r.name));
    const box = el('div', { class: 'pn-con-cand' });
    if (recs === null) box.append(el('div', { class: 'pn-fine', text: '추천을 찾는 중…' }));
    else if (!cands.length) box.append(el('div', { class: 'pn-fine', text: '추천할 지식이 없어요 — 지식 탭에서 직접 찾아 넣을 수 있어요.' }));
    for (const c of cands) {
      const on = picked.has(c.name);
      box.append(el('label', { class: 'pn-con-cand-l' },
        el('input', { type: 'checkbox', checked: on ? 'checked' : null, onchange: (ev: Event) => { if ((ev.target as HTMLInputElement).checked) picked.add(c.name); else picked.delete(c.name); } }),
        el('span', { class: 'ell1', text: c.title || c.name, title: c.name })));
    }
    if (cands.length) box.append(el('div', { class: 'pn-con-cand-f' },
      el('button', { class: 'pn-con-a pri', type: 'button', text: '고른 것 넣기', onclick: () => void linkKnowledge() }),
      el('button', { class: 'pn-con-a', type: 'button', text: '닫기', onclick: () => { knOpen = false; paint(); } })));
    return box;
  }
  function priorScreen(): HTMLElement {
    const cur = priorOf();
    const curIds = new Set(cur.map((p) => p.id));
    const list = el('div', { class: 'pn-con-list' });
    if (projRows === null) list.append(el('div', { class: 'pn-fine', style: 'padding:8px 14px', text: '프로젝트를 불러오는 중…' }));
    else if (!projRows.length) list.append(el('div', { class: 'pn-fine', style: 'padding:8px 14px', text: '고를 프로젝트가 없어요.' }));
    for (const p of (projRows || []).filter((p) => !curIds.has(p.id)).slice(0, 30)) {
      list.append(el('div', { class: 'pn-con-row' }, pnIcon('proj', 'pn-i sm'),
        el('div', { class: 'pn-con-row-b' }, el('div', { class: 'pn-con-row-q ell1', text: `#${p.id} ${p.name}` }), el('div', { class: 'pn-con-row-m', text: p.status || '' })),
        el('button', { class: 'pn-con-a', type: 'button', text: '선행으로', onclick: () => void linkPrior(p.id) })));
    }
    return el('div', { class: 'pn-con-prior' },
      el('div', { class: 'pn-con-hd' },
        el('div', { class: 'pn-con-t' }, el('button', { class: 'pn-con-back', type: 'button', text: '‹ 알려 줄 것', onclick: () => { priorOpen = false; paint(); } }), el('span', { text: ' 선행 프로젝트' })),
        el('div', { class: 'pn-con-s', text: '이 일이 이어받는 프로젝트를 고릅니다. 세션이 다음 지시부터 그 프로젝트와 남긴 지식을 압니다.' })),
      el('div', { class: 'pn-con-sh' }, el('span', { text: '고른 것' }), el('span', { class: 'n', text: String(cur.length) })),
      ...(cur.length ? cur.map((p) => el('div', { class: 'pn-con-row' }, pnIcon('check', 'pn-i sm ok'),
        el('div', { class: 'pn-con-row-b' }, el('div', { class: 'pn-con-row-q ell1', text: `#${p.id} ${p.name}` })),
        el('button', { class: 'pn-con-a', type: 'button', text: '빼기', onclick: () => void linkPrior(p.id, true) }))) : [el('div', { class: 'pn-fine', style: 'padding:4px 14px 8px', text: '아직 없어요.' })]),
      el('div', { class: 'pn-con-sh' }, el('span', { text: '내 프로젝트' })),
      list);
  }
  function headEl(name: string, sub: string): HTMLElement {
    return el('div', { class: 'pn-con-hd' }, el('div', { class: 'pn-con-t ell1', text: name, title: name }), el('div', { class: 'pn-con-s ell1', text: sub, title: sub }));
  }
  function checklistEl(): HTMLElement[] {
    const p = proj();
    const kn = p.knowledge || {};
    const tasks: any[] = Array.isArray(p.tasks) ? p.tasks : [];
    const mine = sessionTaskOrder(tasks as any[], ids())[0] as any;
    const have = new Set<string>(((kn.required || []) as any[]).map((k) => String(k.name)));
    const rows = checklistRows({
      projectId: ctx.id, projectName: p.name, descriptionChars: String(p.description || '').length, prior: priorOf(),
      required: ((kn.required || []) as any[]).length, recommended: (recs || []).filter((r) => !have.has(r.name)).length,
      rulesLines: null, repos: Array.isArray(p.repos) ? p.repos.map(String) : [], attachments: att.tail() ? att.chips.childElementCount : 0,
      task: mine ? { id: Number(mine.id), name: String(mine.name || ''), status: mine.status ?? null } : null,
      run: '',
    });
    const todo = rows.filter((r) => r.st === 'todo').length;
    const out: HTMLElement[] = [el('div', { class: 'pn-con-sh' }, el('span', { text: '알려 줄 것' }), el('span', { class: 'n' + (todo ? ' warn' : ''), text: todo ? `채울 것 ${todo}` : '다 채웠어요' }))];
    for (const r of rows) {
      out.push(checkRow(r));
      if (r.key === 'knowledge') { const c = candList(); if (c) out.push(c); }
    }
    return out;
  }
  function itemRow(it: TlItem & { ck: ConsoleKind }): HTMLElement {
    const icon = it.ck === 'ask' ? el('span', { class: 'pn-con-num', text: '›' })
      : it.ck === 'file' ? pnIcon('doc', 'pn-i sm') : it.ck === 'knowledge' ? pnIcon('wiki', 'pn-i sm') : it.ck === 'ref' ? pnIcon('wiki', 'pn-i sm dim') : pnIcon('check', 'pn-i sm ok');
    const meta = [KIND_LABEL[it.ck] + (it.verb && it.ck !== 'ask' ? ' ' + it.verb : ''), it.ts ? relTime(it.ts) : ''].filter(Boolean).join(' · ');
    let act: HTMLElement | null = null;
    if (it.ck === 'ask') act = el('button', { class: 'pn-con-a', type: 'button', text: '넣기', title: '이 글을 입력칸에 다시 넣습니다', onclick: () => { if (putIntoSession(ids(), it.full || it.label)) toast('입력칸에 넣었어요 — 고쳐서 보내세요.'); } });
    else if (it.ck === 'file' && it.out?.path) { const path = it.out.path; const s = row(); act = el('button', { class: 'pn-con-a', type: 'button', text: '열기', onclick: () => openInViewerPart(ctx, path, { sid, node: s?.node ?? null }) }); }
    else if (it.ck === 'file' && it.out?.url) { const url = it.out.url; act = el('button', { class: 'pn-con-a', type: 'button', text: '열기', onclick: () => requestOpenRoute(url, true) }); }
    else if ((it.ck === 'knowledge' || it.ck === 'ref') && it.href) { const href = it.href; act = el('button', { class: 'pn-con-a', type: 'button', text: '읽기', onclick: () => requestOpenRoute(href) }); }
    else if ((it.ck === 'knowledge' || it.ck === 'ref') && /^[a-z0-9-]{4,}$/.test(it.label)) { const href = knHref(it.label); act = el('button', { class: 'pn-con-a', type: 'button', text: '읽기', onclick: () => requestOpenRoute(href) }); }
    return el('div', { class: 'pn-con-row', title: it.detail || it.label }, icon,
      el('div', { class: 'pn-con-row-b' }, el('div', { class: 'pn-con-row-q ell1', text: it.label }), el('div', { class: 'pn-con-row-m ell1', text: meta })),
      act || el('span'));
  }
  function listEl(items: TlItem[]): HTMLElement[] {
    const counts = kindCounts(items);
    const chips = el('div', { class: 'pn-con-chips' },
      ...(['all', 'ask', 'file', 'knowledge', 'done', 'ref'] as const).map((k) => el('button', {
        class: 'pn-con-chip' + (kind === k ? ' on' : ''), type: 'button', text: (k === 'all' ? '전체' : KIND_LABEL[k]) + (counts[k] ? ' ' + counts[k] : ''),
        onclick: () => { kind = k; paint(); },
      })));
    const find = el('input', { class: 'pn-con-find', type: 'search', placeholder: '이 세션에서 찾기', value: query, 'aria-label': '이 세션에서 찾기' }) as HTMLInputElement;
    let composing = false;
    find.addEventListener('compositionstart', () => { composing = true; });
    find.addEventListener('compositionend', () => { composing = false; query = find.value; paintList(); });
    find.addEventListener('input', () => { if (composing) return; query = find.value; paintList(); });
    const list = el('div', { class: 'pn-con-list' });
    const paintList = (): void => {
      const rows = filterItems(items, kind, query);
      replaceKids(list, rows.length ? rows.map(itemRow) : [el('div', { class: 'pn-fine', style: 'padding:8px 14px', text: items.length ? '맞는 것이 없어요.' : '아직 남긴 것이 없어요 — 세션이 무언가 하면 여기 쌓입니다.' })]);
    };
    paintList();
    return [el('div', { class: 'pn-con-sh' }, el('span', { text: '남긴 것' })), el('div', { class: 'pn-con-findw' }, find), chips, list];
  }

  function paint(): void {
    if (destroyed) return;
    const s = row();
    const items = ctx.trailItems();
    //  내 질문의 정본은 발자취의 사람 말(say — 얇은 판 되감기라 꺼진 세션도 들어 있다). prompts API 는 박스 파일을 읽어 꺼진 세션엔 비므로 보조로만.
    const says = items.filter((it) => it.kind === 'say').sort((a, b) => Date.parse(a.ts || '') - Date.parse(b.ts || ''));
    const asks: Prompt[] = says.length ? says.map((it) => ({ text: it.full || it.label, ts: it.ts || '' })) : prompts;
    const phase = consolePhase({ sid, prompts: asks.length, hasReply: hasReplyIn(items) });
    phaseNow = phase;
    stopBtn.hidden = !(alive() && working());
    foot.hidden = phase === 'none';
    if (phase === 'none') {
      replaceKids(body, el('div', { class: 'pn-empty' }, pnIcon('console', 'pn-i big'), el('b', { text: '아직 보고 있는 세션이 없어요.' }),
        el('p', { class: 'pn-fine', text: '세션을 하나 열면 그 세션에 알려 줄 것과 남긴 것이 여기 보여요.' })));
      return;
    }
    if (priorOpen) { replaceKids(body, priorScreen()); return; }
    const name = (s && s.label && !/^box-/.test(String(s.label))) ? String(s.label) : '이름 없는 세션';
    const state = !s ? '' : !s.alive ? '끝남' : s.stateKey === 'busy' ? '작업 중' : s.stateKey === 'waiting' ? '확인 필요' : s.stateKey === 'done' ? '작업 완료' : '쉬는 중';
    const kids: Array<HTMLElement | null> = [];
    if (phase === 'start') {
      kids.push(headEl(name, [ctx.id ? `프로젝트 #${ctx.id}` : '프로젝트 없음', asks.length ? '첫 답을 기다리는 중' : '첫 지시 전'].join(' · ')));
      kids.push(el('div', { class: 'pn-con-lead', text: '여기서 채운 것을 세션이 다음 지시부터 압니다.' }));
      kids.push(...checklistEl());
      kids.push(attRow);
    } else {
      const counts = kindCounts(items);
      kids.push(headEl(name, [state, s?.lastActive ? '마지막 활동 ' + relTime(s.lastActive) : '', `질문 ${counts.ask}`, counts.file ? `파일 ${counts.file}` : '', counts.knowledge ? `지식 ${counts.knowledge}` : ''].filter(Boolean).join(' · ')));
      // 다녀온 사이 — 마지막으로 본 때 뒤에 생긴 것(이 브라우저 기억). 처음이거나 계속 보고 있었으면 안 선다.
      const leftAt = sid ? readLeftAt((() => { try { return localStorage; } catch { return null; } })(), sid) : 0;
      const away = sinceAway(items, leftAt).filter((it) => it.kind === 'reply' || consoleKind(it));
      if (away.length) {
        kids.push(el('div', { class: 'pn-con-sh' }, el('span', { text: '다녀온 사이' }), el('span', { class: 'n', text: `${relTime(new Date(leftAt).toISOString())} 떠남 · 새로 생긴 것 ${away.length}` })));
        for (const it of away.slice(-6)) {
          if (it.kind === 'reply') kids.push(el('div', { class: 'pn-con-row new' }, pnIcon('chat', 'pn-i sm'), el('div', { class: 'pn-con-row-b' }, el('div', { class: 'pn-con-row-q ell1', text: it.label }), el('div', { class: 'pn-con-row-m', text: '답 · ' + (it.ts ? relTime(it.ts) : '') })), el('span')));
          else { const ck = consoleKind(it); if (ck) { const r = itemRow(Object.assign({}, it, { ck })); r.classList.add('new'); kids.push(r); } }
        }
      }
      const first = asks[0];
      if (first) kids.push(el('div', { class: 'pn-con-sum' }, el('b', { text: '처음 시킨 것' }), el('div', { class: 'ell3', text: first.text })));
      if (!s?.alive) {
        const last = items.filter((it) => consoleKind(it) && it.kind !== 'say').slice(-3).map((it) => it.label);
        if (last.length) kids.push(el('div', { class: 'pn-con-sum' }, el('b', { text: '마지막으로 남긴 것' }), el('div', { class: 'ell3', text: last.join(' · ') })));
      }
      kids.push(el('button', { class: 'pn-con-sh fold', type: 'button', 'aria-expanded': toldOpen ? 'true' : 'false', onclick: () => { toldOpen = !toldOpen; paint(); } },
        el('span', { text: '알려 준 것' }), el('span', { class: 'n', text: (toldOpen ? '접기 ▴' : `지식 ${((proj().knowledge || {}).required || []).length} · 선행 ${priorOf().length} · 레포 ${(proj().repos || []).length} ▾`) })));
      if (toldOpen) { kids.push(el('div', { class: 'pn-con-lead', text: '여기서 바꾼 것은 다음 지시부터 세션이 압니다.' })); kids.push(...checklistEl().slice(1)); kids.push(attRow); }
      kids.push(...listEl(items));
    }
    replaceKids(body, kids.filter((k): k is HTMLElement => !!k));
  }

  function onSession(next: string | null): void {
    closeMenu();
    if (next !== sid) { sid = next; prompts = []; promptsAt = 0; kind = 'all'; query = ''; toldOpen = false; priorOpen = false; knOpen = false; picked = new Set(); att.clear(); }
    paint();
    void loadPrompts(true);
    void loadRecs();
  }
  const off = ctx.onSession((next) => onSession(next));
  onSession(ctx.curSession());
  return {
    root,
    tick: () => { void loadPrompts(); paint(); },
    reselect: () => { priorOpen = false; knOpen = false; body.scrollTop = 0; paint(); },
    destroy: () => { destroyed = true; off(); closeMenu(); attObs?.disconnect(); att.clear(); },
  };
}
