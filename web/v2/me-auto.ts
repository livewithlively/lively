// v2/me-auto.ts — 내 프로필 창 [AI 주입 문구] 탭 (#1898, 원준 2026-08-25).
//
//  무엇인가: [맥락 관리 ▸ AI에 전달 ▸ 세션 주입] 화면이 하는 일을, 개발자 어휘를 걷고 **세 순간**으로
//   다시 놓은 것이다 — 대화를 시작할 때 · 일하는 동안 · 대화를 끝낼 때. 위에 큰 칸 세 개를 두고 하나를
//   고르면 그 순간의 설정만 아래에 편다(원준 선택: '2안 세 칸 고르기').
//
//  ⚠ **정본은 하나다 — 저 화면과 이 화면은 같은 행을 본다.** 새 테이블도, 사본도, 캐시도 만들지 않는다:
//    · 메모(섹션)  = knowledge(injection='always')  — GET /api/ui/org · POST /api/ui/org/section[/delete]
//                    · POST /api/ui/org/sections/order
//    · 스위치      = org_runtime_config             — POST /api/ui/org/runtime-config (부분 갱신)
//    · 전문 미리보기 = GET /api/ui/org/hooks/preview (게이트웨이 조립물 그대로)
//   그래서 여기서 고치면 맥락 관리 화면이, 거기서 고치면 여기가 **다음에 열 때 그대로 보인다**. 이 탭은
//   처음 펼 때(그리고 저장할 때마다) 서버에서 다시 읽으므로 한쪽이 낡은 값을 들고 있을 창이 없다.
//
//  ⚠ 쉬운 말 규약(#1898): 화면에 'SessionStart'·'너지'·'훅'·'키트' 를 쓰지 않는다. 그 말들은 개발자용
//   접기 안에서만 쓰고, 바깥은 '대화를 시작할 때'·'메모'·'알려주기'·'최신 상태로 유지'로 말한다.
//   ⚠ 예외는 '주입' 하나 — 원준 지시(2026-08-25): 이 화면이 무엇을 하는 자리인지는 그 말이 가장 정확하다
//   ("AI에게 자동으로 매번 입력되는 것을 고치는 자리"). 그래서 **제목에만** 남기고 본문 설명은 쉬운 말로 푼다.
//   ⚠ 말끝은 '합니다'로 통일하고, 대시(—)로 설명을 덧붙이지 않는다(원준: AI가 쓴 티가 난다). 두 문장으로 끊는다.
import { api, busy, el, errorNote, renderMarkdown, toast, uiText } from '../core.js';
import { confirmDialog, overlay, skeleton } from '../ui-primitives.js';

const GUIDE = 'context-ontology-guide';
/** 맥락 관리의 같은 화면 — '더 자세히'는 여기로 보낸다(입구가 둘이어도 집은 하나다). */
const DEEP = '#/context/deliver/injection';

interface Sec { name: string; body_md: string; sort: number; version: number; updated_at?: string | null }

/** 섹션 이름 → 사람이 읽는 제목. 본문 첫 제목(# …)이 있으면 그것을, 없으면 키를 그대로. */
function titleOf(s: Sec): string {
  if (s.name === GUIDE) return '라이블리 사용 설명서';
  const m = (s.body_md || '').match(/^#{1,3}\s+(.+)$/m);
  return (m && m[1].trim()) || s.name;
}

/** 며칠 전 — 목록 meta 용(초 단위까지 필요 없다). */
function ago(iso?: string | null): string {
  if (!iso) return '';
  const d = Date.parse(iso);
  if (!d) return '';
  const day = Math.floor((Date.now() - d) / 86400000);
  if (day <= 0) return '오늘 수정';
  if (day === 1) return '어제 수정';
  if (day < 30) return day + '일 전 수정';
  return Math.floor(day / 30) + '개월 전 수정';
}

export interface AutoPaneDeps {
  /** 창 닫기 — 맥락 관리로 건너갈 때 창을 접는다. */
  close: () => void;
  /** 화면 하나 = [제목 · 한 줄 설명 · 내용] 규격을 창이 쥐고 있어 그대로 받아 쓴다. */
  pane: (title: string, hint: string, ...kids: any[]) => HTMLElement;
}

export function autoPane(deps: AutoPaneDeps): { node: HTMLElement; init: () => void } {
  const host = el('div');
  const node = deps.pane('AI 주입 문구',
    '내가 쓰지 않아도 매 대화에 자동으로 들어가는 내용입니다. 대화를 시작할 때, 일하는 동안, 대화를 끝낼 때로 나뉩니다.',
    host);
  node.classList.add('v2me-pane-wide');
  return { node, init: () => { void load(host, deps); } };
}

// ── 데이터 한 번 읽고 그리기. 저장 뒤에도 이 함수로 되돌아온다(한쪽만 낡는 일이 없게). ──
async function load(host: HTMLElement, deps: AutoPaneDeps): Promise<void> {
  busy(host, skeleton('설정을 불러오는 중'));
  let data: any;
  try { data = await api('/api/ui/org'); }
  catch (e) { host.replaceChildren(errorNote(e, '설정을 불러오지 못했습니다')); return; }
  host.replaceChildren(render(data, () => { void load(host, deps); }, deps));
}

function render(data: any, reload: () => void, deps: AutoPaneDeps): HTMLElement {
  const rc = data.runtimeConfig;                    // 관리자만 non-null — 아니면 읽기 전용 화면이 된다
  const canEdit = !!data.canEdit && !!rc;
  const hooks = (rc && rc.hooks) || {};
  const on = (k: string) => hooks[k] !== false;     // 서버 기본값이 '켜짐'이라 !== false 로 읽는다
  const guideOn = (rc ? rc.inject_ontology_guide : data.injectOntologyGuide) !== false;
  const secs: Sec[] = Object.entries(data.sections || {})
    .map(([name, s]: any) => ({ name, ...(s as any) }))
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || a.name.localeCompare(b.name));
  const mine = secs.filter((s) => s.name !== GUIDE);   // 내가 고칠 수 있는 것
  const guide = secs.find((s) => s.name === GUIDE);

  async function saveRuntime(patch: any, okMsg: string): Promise<void> {
    await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify(patch) });
    toast(okMsg);
  }

  // 스위치 — 켜고 끄면 그 자리에서 저장하고, 실패하면 되돌린다(거짓 안심 금지).
  function sw(getter: () => boolean, save: (v: boolean) => Promise<void>, chip?: HTMLElement): HTMLElement {
    const b = el('button', { class: 'v2a-sw' + (getter() ? '' : ' off'), type: 'button',
      'aria-label': getter() ? '켜짐' : '꺼짐' }) as HTMLButtonElement;
    if (!canEdit) { b.disabled = true; b.classList.add('ro'); b.title = '관리자만 바꿀 수 있습니다'; return b; }
    b.addEventListener('click', async () => {
      const next = b.classList.contains('off');
      b.disabled = true;
      try {
        await save(next);
        b.classList.toggle('off', !next);
        b.setAttribute('aria-label', next ? '켜짐' : '꺼짐');
        if (chip) paintChip(chip, next);
      } catch (e: any) { toast((e && e.message) || '저장하지 못했습니다', true); }
      b.disabled = false;
    });
    return b;
  }
  function chipOf(v: boolean): HTMLElement { const c = el('span', { class: 'v2a-st' }); paintChip(c, v); return c; }

  // ── 위쪽 큰 칸 세 개 — 상태를 여기서 한눈에 보고, 눌러 아래 내용을 바꾼다. ──
  const MOMENTS = [
    { key: 'a', ord: '첫째', title: '대화를 시작할 때', sub: '적어둔 메모를 먼저 읽습니다', hook: 'session_preload' },
    { key: 'b', ord: '둘째', title: '일하는 동안', sub: '일한 흔적을 표시해 둡니다', hook: 'work_flag' },
    { key: 'c', ord: '셋째', title: '대화를 끝낼 때', sub: '기록 남기라고 알려줍니다', hook: 'stop_writeback_gate' },
  ];
  const tiles = el('div', { class: 'v2a-tiles' });
  const bodies = new Map<string, HTMLElement>();
  const chips = new Map<string, HTMLElement>();
  const tileBtns = new Map<string, HTMLElement>();
  const show = (k: string): void => {
    tileBtns.forEach((b, key) => { b.classList.toggle('on', key === k); b.setAttribute('aria-current', String(key === k)); });
    bodies.forEach((b, key) => { b.hidden = key !== k; });
  };
  MOMENTS.forEach((m) => {
    const chip = chipOf(on(m.hook));
    chips.set(m.key, chip);
    const b = el('button', { class: 'v2a-tile', type: 'button', onclick: () => show(m.key) },
      el('span', { class: 'v2a-tile-n', text: m.ord }),
      el('span', { class: 'v2a-tile-t', text: m.title }),
      el('span', { class: 'v2a-tile-s', text: m.sub }),
      el('span', { class: 'v2a-tile-st' }, chip));
    tileBtns.set(m.key, b);
    tiles.append(b);
  });

  // ── ① 대화를 시작할 때 — 메모(섹션)들. 이 탭의 본체다. ──
  const aBody = el('div', { class: 'v2a-detail' },
    el('div', { class: 'v2a-d-h' },
      el('div', {}, el('div', { class: 'v2a-d-t', text: '대화를 시작할 때' }),
        el('p', { class: 'v2a-d-s' }, ...uiText('새 대화를 열면 AI가 아래 메모부터 읽습니다. 매번 같은 설명을 하지 않아도 됩니다.'))),
      sw(() => on('session_preload'),
        (v) => saveRuntime({ hooks: { ...hooks, session_preload: v } },
          v ? '이제 대화를 시작할 때 메모를 읽습니다' : '메모를 읽지 않습니다. 다음 대화부터 적용됩니다'),
        chips.get('a'))));

  mine.forEach((s, i) => aBody.append(memoBlock(s, i)));
  if (guide) {
    aBody.append(el('div', { class: 'v2a-mini' },
      el('div', { class: 'v2a-mini-m' },
        el('div', { class: 'v2a-mini-t' }, el('span', { text: '라이블리 사용 설명서' }),
          el('span', { class: 'v2a-tag lock', text: '기본 제공' })),
        el('div', { class: 'v2a-mini-s' }, ...uiText('AI가 라이블리를 다루는 법입니다. 고칠 수 없고 새 버전이 나오면 자동으로 바뀝니다.'))),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '보기', onclick: () => viewGuide(guide) }),
      sw(() => guideOn, (v) => saveRuntime({ inject_ontology_guide: v },
        v ? '사용 설명서를 함께 읽습니다' : '사용 설명서를 읽지 않습니다. AI가 라이블리 쓰는 법을 모르게 됩니다'))));
  }
  aBody.append(el('div', { class: 'v2a-acts' },
    canEdit ? el('button', { class: 'btn btn-sm', type: 'button', text: '＋ 메모 하나 더', onclick: () => openEditor(null) }) : null,
    el('button', { class: 'btn btn-sm', type: 'button', text: 'AI가 읽는 글 전체 보기', onclick: () => viewPreview() })));
  bodies.set('a', aBody);

  // ── ② 일하는 동안 ──
  const bBody = el('div', { class: 'v2a-detail', hidden: true },
    el('div', { class: 'v2a-d-h' },
      el('div', {}, el('div', { class: 'v2a-d-t', text: '일하는 동안' }),
        el('p', { class: 'v2a-d-s' }, ...uiText('AI가 파일을 고치거나 외부 서비스를 쓰면 이 대화에서 일했다고 표시해 둡니다. 대화를 끝낼 때 알려줄지 판단하는 데만 씁니다.'))),
      sw(() => on('work_flag'),
        (v) => saveRuntime({ hooks: { ...hooks, work_flag: v } }, v ? '일한 흔적을 표시합니다' : '표시하지 않습니다'),
        chips.get('b'))),
    devBox());
  bodies.set('b', bBody);

  // ── ③ 대화를 끝낼 때 ──
  const cBody = el('div', { class: 'v2a-detail', hidden: true },
    el('div', { class: 'v2a-d-h' },
      el('div', {}, el('div', { class: 'v2a-d-t', text: '대화를 끝낼 때' }),
        el('p', { class: 'v2a-d-s' }, ...uiText('일은 했는데 기록 없이 끝내려 하면 AI에게 한 번 알려 줍니다.'))),
      sw(() => on('stop_writeback_gate'),
        (v) => saveRuntime({ hooks: { ...hooks, stop_writeback_gate: v } }, v ? '끝낼 때 알려줍니다' : '알려주지 않습니다'),
        chips.get('c'))),
    el('div', { class: 'v2a-mini' },
      el('div', { class: 'v2a-mini-m' },
        el('div', { class: 'v2a-mini-t' }, el('span', { text: '알려줄 때 쓰는 문구' })),
        el('div', { class: 'v2a-mini-s' }, ...uiText(rc && rc.writeback_notice ? '직접 고친 문구를 씁니다.' : '기본 문구를 씁니다.'))),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '문구 보기', onclick: () => viewNotice() })));
  bodies.set('c', cBody);

  // ── 발치 — 순간에 매이지 않는 것 하나. ──
  const foot = el('div', { class: 'v2a-foot' },
    el('div', { class: 'v2a-mini' },
      el('div', { class: 'v2a-mini-m' },
        el('div', { class: 'v2a-mini-t' }, el('span', { text: '라이블리를 최신 상태로 유지하기' })),
        el('div', { class: 'v2a-mini-s' }, ...uiText('대화를 시작할 때 새 버전이 있는지 확인하고 다음 대화부터 반영합니다.'))),
      sw(() => on('self_update'),
        (v) => saveRuntime({ hooks: { ...hooks, self_update: v } }, v ? '최신 상태로 유지합니다' : '자동 업데이트를 끕니다'))),
    el('div', { class: 'v2a-more' },
      el('button', { class: 'btn-text', type: 'button', text: '맥락 관리에서 더 자세히 보기 →',
        onclick: () => { deps.close(); location.hash = DEEP; } })));

  //  범위 한 줄 — **인원 수를 세지 않는다**. 멤버 명부에는 봇·연동 계정·테스트 계정이 섞여 있어
  //   그대로 세면 사람 수와 어긋난다(v2/switcher.ts 가 같은 이유로 명부 대신 '세션을 가진 사람'을 쓴다).
  //   그래서 숫자 없이, 어느 워크스페이스에서도 참인 문장으로 범위만 말한다.
  const head = el('div', { class: 'v2a-who' },
    ...uiText('여기서 바꾸면 이 워크스페이스에서 여는 모든 대화에 적용됩니다. 팀이면 팀원의 AI도 같이 따릅니다.'));

  const wrap = el('div', {}, head, tiles, aBody, bBody, cBody, foot);
  if (!canEdit) {
    wrap.prepend(el('p', { class: 'v2a-ro' }, ...uiText('보기만 됩니다. 바꾸려면 관리자 권한이 필요합니다.')));
  }
  show('a');
  return wrap;

  // ── 메모 한 덩어리 ──
  function memoBlock(s: Sec, i: number): HTMLElement {
    const acts = el('div', { class: 'v2a-memo-a' });
    if (canEdit) {
      acts.append(el('button', { class: 'btn btn-sm', type: 'button', text: '고치기', onclick: () => openEditor(s) }));
      if (mine.length > 1) {
        acts.append(
          el('button', { class: 'v2a-ico', type: 'button', title: '위로', text: '▲',
            disabled: i === 0, onclick: () => void move(s, -1) }),
          el('button', { class: 'v2a-ico', type: 'button', title: '아래로', text: '▼',
            disabled: i === mine.length - 1, onclick: () => void move(s, +1) }));
      }
      acts.append(el('button', { class: 'btn-text v2a-del', type: 'button', text: '삭제', onclick: () => void del(s) }));
    }
    const meta = [String(s.body_md || '').length.toLocaleString('ko-KR') + '자', ago(s.updated_at)].filter(Boolean).join(' · ');
    return el('div', { class: 'v2a-memo' },
      el('div', { class: 'v2a-memo-h' },
        el('span', { class: 'v2a-memo-t', text: titleOf(s) }),
        el('span', { class: 'v2a-memo-m', text: meta }),
        acts),
      el('div', { class: 'v2a-memo-b', text: s.body_md || '' }),
      hasSlot(s) ? el('p', { class: 'v2a-slot-h' }, ...slotHint(s)) : null);
  }

  // 본문에 쓰인 ${…} 자리 안내 — 사람 말로. (편집기에서도 같은 문장을 쓴다)
  function hasSlot(s: Sec): boolean { return /\$\{(team|categories|wiki)\}/.test(s.body_md || ''); }
  function slotHint(s: Sec): any[] {
    const b = s.body_md || '';
    const names: string[] = [];
    if (b.includes('${team}')) names.push('내 팀 이름');
    if (b.includes('${categories}')) names.push('우리가 쓰는 주제 목록');
    if (b.includes('${wiki}')) names.push('핀 꽂은 문서 제목');
    const last = names[names.length - 1] || '';
    return uiText('메모 안의 표시된 자리에는 대화마다 ' + names.join(', ') + josa(last) + ' 채워집니다.');
  }

  async function move(s: Sec, dir: number): Promise<void> {
    const order = secs.map((x) => x.name);
    const i = order.indexOf(s.name), j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    try { await api('/api/ui/org/sections/order', { method: 'POST', body: JSON.stringify({ order }) }); reload(); }
    catch (e: any) { toast((e && e.message) || '순서를 바꾸지 못했습니다', true); }
  }

  async function del(s: Sec): Promise<void> {
    const ok = await confirmDialog({
      title: '이 메모를 지울까요?',
      message: '‘' + titleOf(s) + '’ 를 지우면 다음 대화부터 AI가 읽지 않습니다. 휴지통에서 되살릴 수 있습니다.',
      confirmText: '지우기', danger: true,
    });
    if (!ok) return;
    try { await api('/api/ui/org/section/delete', { method: 'POST', body: JSON.stringify({ section: s.name }) }); toast('지웠습니다.'); reload(); }
    catch (e: any) { toast((e && e.message) || '지우지 못했습니다', true); }
  }

  // ── 편집 창 — 새로 만들 때만 이름(키)을 받는다. 저장 경로는 관리 화면과 같은 하나. ──
  function openEditor(s: Sec | null): void {
    const isNew = !s;
    const keyIn = el('input', { type: 'text', class: 'v2a-in', placeholder: '영문 소문자·숫자·하이픈 (예: team-rules)' }) as HTMLInputElement;
    const ta = el('textarea', { class: 'v2a-ta', rows: '16',
      placeholder: 'AI가 늘 알아야 할 것을 적습니다.\n\n보고는 결론부터.\n금액은 원 단위로 말한다.\n지우기 전에 먼저 묻는다.' }) as HTMLTextAreaElement;
    ta.value = s ? (s.body_md || '') : '';
    const status = el('span', { class: 'v2me-status' });
    const save = el('button', { class: 'btn btn-primary', type: 'button', text: isNew ? '만들기' : '저장' }) as HTMLButtonElement;
    const body = el('div', { class: 'v2a-editor' },
      isNew ? el('label', { class: 'v2a-f' }, el('span', { class: 'v2a-fl', text: '메모 이름' }), keyIn,
        el('p', { class: 'v2a-fh' }, ...uiText('AI는 이 이름을 읽지 않습니다. 목록에서 찾을 때만 씁니다.'))) : null,
      el('label', { class: 'v2a-f' }, el('span', { class: 'v2a-fl', text: '내용' }), ta),
      el('p', { class: 'v2a-fh' }, ...uiText('비밀번호나 API 키는 적지 마세요. 저장하면 다음 대화부터 적용됩니다.')),
      el('div', { class: 'v2a-editor-a' }, save, status));
    const back = overlay(isNew ? '메모 만들기' : '메모 고치기 · ' + titleOf(s as Sec), body);
    save.addEventListener('click', async () => {
      const section = (isNew ? keyIn.value : (s as Sec).name).trim().toLowerCase();
      if (!section) { toast('메모 이름을 적어주세요', true); return; }
      save.disabled = true; status.textContent = '저장 중…';
      try {
        await api('/api/ui/org/section', { method: 'POST', body: JSON.stringify({ section, body_md: ta.value }) });
        toast('저장했습니다. 다음 대화부터 적용됩니다.');
        back.remove();
        reload();
      } catch (e: any) { toast((e && e.message) || '저장하지 못했습니다', true); save.disabled = false; status.textContent = ''; }
    });
  }

  function viewGuide(g: Sec): void {
    overlay('라이블리 사용 설명서', el('div', { class: 'v2a-read' },
      el('p', { class: 'v2a-fh' }, ...uiText('제품이 관리하는 문서라 고칠 수 없습니다. 새 버전이 나오면 자동으로 바뀝니다.')),
      el('div', { class: 'md-rendered v2a-md' }, renderMarkdown(g.body_md || ''))));
  }

  function viewNotice(): void {
    const text = (rc && rc.writeback_notice) || data.writebackNoticeDefault || '';
    overlay('알려줄 때 쓰는 문구', el('div', { class: 'v2a-read' },
      el('p', { class: 'v2a-fh' }, ...uiText('대화를 끝낼 때 AI에게 이 문장이 한 번 전달됩니다. 문구는 맥락 관리 화면에서 고칩니다.')),
      el('div', { class: 'v2a-notice', text }),
      el('div', { class: 'v2a-editor-a' },
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '맥락 관리에서 고치기 →',
          onclick: () => { deps.close(); location.hash = DEEP; } }))));
  }

  // 실제로 조립돼 나가는 전문 — 게이트웨이가 만든 그대로(우리가 다시 조립하지 않는다).
  function viewPreview(): void {
    const box = el('div', { class: 'v2a-read' }, skeleton('AI가 읽는 글을 불러오는 중'));
    overlay('AI가 읽는 글 전체', box);
    void (async () => {
      try {
        const r: any = await api('/api/ui/org/hooks/preview');
        const sp = ((r && r.hooks) || []).find((h: any) => h.id === 'session-preload');
        box.replaceChildren(sp && sp.message
          ? el('div', { class: 'md-rendered v2a-md' }, renderMarkdown(sp.message))
          : el('p', { class: 'v2a-fh' }, ...uiText('보여줄 내용이 없습니다.')));
      } catch (e) { box.replaceChildren(errorNote(e, 'AI가 읽는 글을 불러오지 못했습니다')); }
    })();
  }

  // 개발자용 — 폴더 경로·툴 이름처럼 사람 말로 옮길 수 없는 것만 여기 둔다(기본 접힘).
  function devBox(): HTMLElement {
    const roots = el('input', { type: 'text', class: 'v2a-in', placeholder: '/Users/이름/폴더 (줄마다 하나)',
      value: (rc && rc.work_roots) || '' }) as HTMLInputElement;
    const pull = el('input', { type: 'text', class: 'v2a-in', placeholder: 'mcp__lively__ext__',
      value: ((rc && rc.pull_tools) || []).join(', ') }) as HTMLInputElement;
    const save = el('button', { class: 'btn btn-sm', type: 'button', text: '저장' }) as HTMLButtonElement;
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await saveRuntime({
          work_roots: roots.value.trim() || null,
          pull_tools: pull.value.split(',').map((x) => x.trim()).filter(Boolean),
        }, '저장했습니다.');
      } catch (e: any) { toast((e && e.message) || '저장하지 못했습니다', true); }
      save.disabled = false;
    });
    const d = el('details', { class: 'v2a-dev' },
      el('summary', { text: '개발자용 설정' }),
      el('div', { class: 'v2a-dev-b' },
        el('label', { class: 'v2a-f' }, el('span', { class: 'v2a-fl', text: '이 폴더에서 연 대화만 ‘일’로 셈하기' }), roots),
        el('label', { class: 'v2a-f' }, el('span', { class: 'v2a-fl', text: '외부에서 가져온 내용 감지 (툴 이름 앞부분)' }), pull),
        el('p', { class: 'v2a-fh' }, ...uiText('직접 만든 자동 동작 ' + ((data.orgHooks || []).length) + '개는 맥락 관리 화면에서 관리합니다.')),
        canEdit ? el('div', { class: 'v2a-editor-a' }, save) : null));
    return d;
  }
}

/** 받침 유무로 '이/가'를 고른다 — 목록 끝 낱말이 무엇이든 문장이 어색해지지 않게. */
function josa(word: string): string {
  const c = (word || '').trim().slice(-1).charCodeAt(0);
  if (!c || c < 0xac00 || c > 0xd7a3) return '가';
  return (c - 0xac00) % 28 ? '이' : '가';
}

function paintChip(c: HTMLElement, v: boolean): void {
  c.classList.toggle('off', !v);
  c.textContent = v ? '켜짐' : '꺼짐';
}
