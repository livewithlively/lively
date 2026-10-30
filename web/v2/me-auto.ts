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
import { ctxPath } from '../lib/ctx-names.js';   // #4233 앱 · 탭 이름은 한 곳에서
import { qmark } from '../lib/qmark.js';

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
    '내가 입력하지 않아도 AI 세션에 자동으로 주입되는 내용과 자동 동작을 설정합니다. AI 세션을 시작할 때, AI 세션이 실행되는 동안, AI 세션이 응답을 마칠 때 각각 무엇을 할지 정합니다.',
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
  //  원준 2026-09-28: 관리자만 보는 화면을 두지 않는다 — 모두 같은 화면이다. 권한이 없는 사람의 저장은 서버가
  //   거절하고, 그 사실을 알림으로 말한다(스위치는 되돌린다). rc 가 없으면 서버 기본값(켜짐)으로 그린다.
  const canEdit = true;
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
    //  ⚠ 셋째는 세션을 닫을 때가 아니다 — 훅(Stop)은 AI 가 응답 한 번을 마칠 때마다 불린다(조건이 맞으면 세션당 한 번 보낸다).
    { key: 'a', ord: '첫째', title: 'AI 세션을 시작할 때', sub: '주입 문구를 AI에 주입합니다', hook: 'session_preload' },
    { key: 'b', ord: '둘째', title: 'AI 세션이 실행되는 동안', sub: '상태와 작업 내역을 기록합니다', hook: 'work_flag' },
    { key: 'c', ord: '셋째', title: 'AI 세션이 응답을 마칠 때', sub: '라이블리에 기록하도록 요청합니다', hook: 'stop_writeback_gate' },
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
      el('div', {}, el('div', { class: 'v2a-d-t', text: 'AI 세션을 시작할 때' }),
        el('p', { class: 'v2a-d-s' }, ...uiText('새 AI 세션을 열면 아래 주입 문구가 AI에 자동으로 주입됩니다. 같은 내용을 AI 세션마다 직접 입력하지 않아도 됩니다.'))),
      sw(() => on('session_preload'),
        (v) => saveRuntime({ hooks: { ...hooks, session_preload: v } },
          v ? 'AI 세션을 시작할 때 주입 문구를 주입합니다.' : '주입 문구를 주입하지 않습니다. 새로 여는 AI 세션부터 적용됩니다.'),
        chips.get('a'))));

  mine.forEach((s, i) => aBody.append(memoBlock(s, i)));
  if (guide) {
    aBody.append(el('div', { class: 'v2a-mini' },
      el('div', { class: 'v2a-mini-m' },
        el('div', { class: 'v2a-mini-t' }, el('span', { text: '라이블리 사용 설명서' }),
          el('span', { class: 'v2a-tag lock', text: '기본 제공' })),
        el('div', { class: 'v2a-mini-s' }, ...uiText('AI가 라이블리를 사용하는 방법을 설명한 문서입니다. 라이블리가 제공하는 문서라 수정할 수 없으며, 새 버전이 나오면 자동으로 바뀝니다.'))),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '보기', onclick: () => viewGuide(guide) }),
      sw(() => guideOn, (v) => saveRuntime({ inject_ontology_guide: v },
        v ? '사용 설명서를 함께 주입합니다.' : '사용 설명서를 주입하지 않습니다. AI가 라이블리 사용 방법을 알 수 없게 됩니다.'))));
  }
  aBody.append(el('div', { class: 'v2a-acts' },
    canEdit ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 주입 문구 추가', onclick: () => openEditor(null) }) : null,
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'AI에 주입되는 전체 내용 보기', onclick: () => viewPreview() })));
  bodies.set('a', aBody);

  // ── ② 일하는 동안 ──
  const bBody = el('div', { class: 'v2a-detail', hidden: true },
    el('div', { class: 'v2a-d-h' },
      //  ⚠ 종전 문구(«…판단하는 데만 씁니다»)는 사실과 달랐다. work-flag.mjs 는 이 값이 false 면 맨 앞에서 끝나서
      //   상태 보고(작업 중·확인 필요·완료, #1221) · 작업 플래그 · 이어 열기용 대화 번호(#1059)가 **모두** 멈춘다.
      el('div', {}, el('div', { class: 'v2a-d-t', text: 'AI 세션이 실행되는 동안' }),
        el('p', { class: 'v2a-d-s' }, ...uiText('AI 세션이 작업 중인지, 확인을 요청했는지, 응답을 마쳤는지를 라이블리에 보고합니다. 또 AI 세션이 파일을 수정했는지, 외부 자료를 가져왔는지, 라이블리에 기록을 남겼는지를 이 컴퓨터에 저장합니다.')),
        el('p', { class: 'v2a-d-s v2a-warn' }, ...uiText('이 스위치를 끄면 사이드바의 AI 세션 상태 표시와 그에 따른 알림이 동작하지 않고, 셋째 칸의 기록 요청도 동작하지 않습니다.'))),
      sw(() => on('work_flag'),
        (v) => saveRuntime({ hooks: { ...hooks, work_flag: v } }, v ? 'AI 세션 상태와 작업 내역을 기록합니다.' : 'AI 세션 상태와 작업 내역을 기록하지 않습니다.'),
        chips.get('b'))),
    devBox());
  bodies.set('b', bBody);

  // ── ③ 대화를 끝낼 때 ──
  const cBody = el('div', { class: 'v2a-detail', hidden: true },
    el('div', { class: 'v2a-d-h' },
      el('div', {}, el('div', { class: 'v2a-d-t', text: 'AI 세션이 응답을 마칠 때' }),
        el('p', { class: 'v2a-d-s' }, ...uiText('AI 세션이 파일을 수정했거나 외부 자료를 가져왔는데 라이블리에 기록을 남기지 않았다면, 응답을 마칠 때 AI에 기록 요청 문구를 한 번 보냅니다. AI는 이 문구를 받은 뒤 작업 내역과 지식을 라이블리에 기록합니다.'))),
      sw(() => on('stop_writeback_gate'),
        (v) => saveRuntime({ hooks: { ...hooks, stop_writeback_gate: v } }, v ? '응답을 마칠 때 기록을 요청합니다.' : '응답을 마칠 때 기록을 요청하지 않습니다.'),
        chips.get('c'))),
    el('div', { class: 'v2a-mini' },
      el('div', { class: 'v2a-mini-m' },
        el('div', { class: 'v2a-mini-t' }, el('span', { text: '기록 요청 문구' })),
        el('div', { class: 'v2a-mini-s' }, ...uiText(rc && rc.writeback_notice ? '직접 수정한 문구를 사용합니다.' : '기본 문구를 사용합니다.'))),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '문구 보기', onclick: () => viewNotice() })));
  bodies.set('c', cBody);

  // ── 발치 — «라이블리 자동 업데이트»는 [계정 · 보안]으로 옮겼다(원준 2026-09-28). 여기엔 건너가는 줄만 남는다. ──
  const foot = el('div', { class: 'v2a-foot' },
    el('div', { class: 'v2a-more' },
      el('button', { class: 'btn-text', type: 'button', text: ctxPath('deliver') + '에서 자세히 보기 →',
        onclick: () => { deps.close(); location.hash = DEEP; } })));

  //  범위 한 줄 — **인원 수를 세지 않는다**. 멤버 명부에는 봇·연동 계정·테스트 계정이 섞여 있어
  //   그대로 세면 사람 수와 어긋난다(v2/switcher.ts 가 같은 이유로 명부 대신 '세션을 가진 사람'을 쓴다).
  //   그래서 숫자 없이, 어느 워크스페이스에서도 참인 문장으로 범위만 말한다.
  const head = el('div', { class: 'v2a-who' },
    ...uiText('여기서 바꾼 설정은 이 워크스페이스의 모든 AI 세션에 적용됩니다. 팀원의 AI 세션에도 똑같이 적용됩니다.'));

  const wrap = el('div', {}, head, tiles, aBody, bBody, cBody, foot);
  show('a');
  return wrap;

  // ── 메모 한 덩어리 ──
  function memoBlock(s: Sec, i: number): HTMLElement {
    const acts = el('div', { class: 'v2a-memo-a' });
    if (canEdit) {
      acts.append(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '수정', onclick: () => openEditor(s) }));
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
    if (b.includes('${categories}')) names.push('카테고리 목록');
    if (b.includes('${wiki}')) names.push('위키에서 핀으로 고정한 지식의 제목 목록');
    const last = names[names.length - 1] || '';
    //  둘이면 «A와 B», 셋이면 «A, B와 C»(받침에 따라 와/과).
    const joined = names.length < 2 ? names.join('')
      : names.slice(0, -1).join(', ') + wagwa(names[names.length - 2]) + ' ' + last;
    return uiText('이 문구에는 AI 세션마다 ' + joined + josa(last) + ' 자동으로 채워집니다.');
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
      title: '이 주입 문구를 삭제할까요?',
      //  #3778 — 이 말이 이제 참이다(서버가 지식과 같은 길로 지워 휴지통 ▸ 지식 탭에 선다).
      message: '‘' + titleOf(s) + '’을 삭제하면 새로 여는 AI 세션부터 주입되지 않습니다. 휴지통 ▸ 지식 탭에서 복원할 수 있습니다.',
      confirmText: '삭제', danger: true,
    });
    if (!ok) return;
    try { await api('/api/ui/org/section/delete', { method: 'POST', body: JSON.stringify({ section: s.name }) }); toast('삭제했습니다.'); reload(); }
    catch (e: any) { toast((e && e.message) || '삭제하지 못했습니다', true); }
  }

  // ── 편집 창 — 새로 만들 때만 이름(키)을 받는다. 저장 경로는 관리 화면과 같은 하나. ──
  function openEditor(s: Sec | null): void {
    const isNew = !s;
    const keyIn = el('input', { type: 'text', class: 'v2a-in', placeholder: '영문 소문자·숫자·하이픈 (예: team-rules)' }) as HTMLInputElement;
    const ta = el('textarea', { class: 'v2a-ta', rows: '16',
      placeholder: 'AI가 항상 알아야 할 내용을 입력합니다.\n\n보고는 결론부터.\n금액은 원 단위로 말한다.\n삭제하기 전에 먼저 묻는다.' }) as HTMLTextAreaElement;
    ta.value = s ? (s.body_md || '') : '';
    const status = el('span', { class: 'v2me-status' });
    const save = el('button', { class: 'btn btn-primary', type: 'button', text: isNew ? '만들기' : '저장' }) as HTMLButtonElement;
    const body = el('div', { class: 'v2a-editor' },
      isNew ? el('label', { class: 'v2a-f' }, el('span', { class: 'v2a-fl', text: '주입 문구 이름' }), keyIn,
        el('p', { class: 'v2a-fh' }, ...uiText('이 이름은 AI에 주입되지 않으며, 목록에서 구분하는 데만 사용합니다.'))) : null,
      el('label', { class: 'v2a-f' }, el('span', { class: 'v2a-fl', text: '내용' }), ta),
      el('p', { class: 'v2a-fh' }, ...uiText('비밀번호나 API 키는 입력하지 마세요. 저장하면 새로 여는 AI 세션부터 적용됩니다.')),
      el('div', { class: 'v2a-editor-a' }, save, status));
    const back = overlay(isNew ? '주입 문구 추가' : '주입 문구 수정 · ' + titleOf(s as Sec), body);
    save.addEventListener('click', async () => {
      const section = (isNew ? keyIn.value : (s as Sec).name).trim().toLowerCase();
      if (!section) { toast('주입 문구 이름을 입력하세요.', true); return; }
      save.disabled = true; status.textContent = '저장 중…';
      try {
        await api('/api/ui/org/section', { method: 'POST', body: JSON.stringify({ section, body_md: ta.value }) });
        toast('저장했습니다. 새로 여는 AI 세션부터 적용됩니다.');
        back.remove();
        reload();
      } catch (e: any) { toast((e && e.message) || '저장하지 못했습니다', true); save.disabled = false; status.textContent = ''; }
    });
  }

  function viewGuide(g: Sec): void {
    overlay('라이블리 사용 설명서', el('div', { class: 'v2a-read' },
      el('p', { class: 'v2a-fh' }, ...uiText('라이블리가 제공하는 문서라 수정할 수 없습니다. 새 버전이 나오면 자동으로 바뀝니다.')),
      el('div', { class: 'md-rendered v2a-md' }, renderMarkdown(g.body_md || ''))));
  }

  function viewNotice(): void {
    const text = (rc && rc.writeback_notice) || data.writebackNoticeDefault || '';
    overlay('기록 요청 문구', el('div', { class: 'v2a-read' },
      el('p', { class: 'v2a-fh' }, ...uiText('조건이 맞으면 AI 세션이 응답을 마칠 때 AI에 이 문구를 한 번 보냅니다. 문구는 ' + ctxPath('deliver') + '에서 수정합니다.')),
      el('div', { class: 'v2a-notice', text }),
      el('div', { class: 'v2a-editor-a' },
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: ctxPath('deliver') + '에서 수정 →',
          onclick: () => { deps.close(); location.hash = DEEP; } }))));
  }

  // 실제로 조립돼 나가는 전문 — 게이트웨이가 만든 그대로(우리가 다시 조립하지 않는다).
  function viewPreview(): void {
    const box = el('div', { class: 'v2a-read' }, skeleton('AI에 주입되는 내용을 불러오는 중'));
    overlay('AI에 주입되는 전체 내용', box);
    void (async () => {
      try {
        const r: any = await api('/api/ui/org/hooks/preview');
        const sp = ((r && r.hooks) || []).find((h: any) => h.id === 'session-preload');
        box.replaceChildren(sp && sp.message
          ? el('div', { class: 'md-rendered v2a-md' }, renderMarkdown(sp.message))
          : el('p', { class: 'v2a-fh' }, ...uiText('보여줄 내용이 없습니다.')));
      } catch (e) { box.replaceChildren(errorNote(e, 'AI에 주입되는 내용을 불러오지 못했습니다')); }
    })();
  }

  // 개발자용 — 폴더 경로·툴 이름처럼 사람 말로 옮길 수 없는 것만 여기 둔다(기본 접힘).
  function devBox(): HTMLElement {
    const roots = el('input', { type: 'text', class: 'v2a-in', placeholder: '/Users/이름/폴더 (한 줄에 하나)',
      value: (rc && rc.work_roots) || '' }) as HTMLInputElement;
    const pull = el('input', { type: 'text', class: 'v2a-in', placeholder: 'mcp__lively__ext__',
      value: ((rc && rc.pull_tools) || []).join(', ') }) as HTMLInputElement;
    const save = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '저장' }) as HTMLButtonElement;
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
        //  개발자용은 정확한 이름을 쓴다(원준 2026-09-28). 동작 설명은 이름 옆 (?) 안에만 둔다.
        el('label', { class: 'v2a-f' }, el('span', { class: 'v2a-fl' }, 'work_roots · 기록 요청을 적용할 작업 폴더',
          qmark('여기 적은 폴더에서 연 AI 세션에 stop-writeback-gate 훅을 적용합니다. 이 폴더 밖에서 연 AI 세션도 라이블리 MCP 도구를 한 번이라도 쓰면 적용됩니다.')), roots),
        el('label', { class: 'v2a-f' }, el('span', { class: 'v2a-fl' }, 'pull_tools · 외부 자료 가져오기로 판정할 도구 이름 접두어',
          qmark('이 접두어로 시작하는 MCP 도구를 호출하면 외부 자료를 가져온 AI 세션으로 기록되어, 응답을 마칠 때 기록 요청 대상이 됩니다.')), pull),
        el('p', { class: 'v2a-fh', text: '워크스페이스에서 직접 만든 훅 ' + ((data.orgHooks || []).length) + '개는 ' + ctxPath('deliver') + '에서 관리합니다.' }),
        canEdit ? el('div', { class: 'v2a-editor-a' }, save) : null));
    return d;
  }
}

/** 받침 유무로 '와/과'를 고른다(«A와 B»). */
function wagwa(word: string): string {
  const c = (word || '').trim().slice(-1).charCodeAt(0);
  if (!c || c < 0xac00 || c > 0xd7a3) return '와';
  return (c - 0xac00) % 28 ? '과' : '와';
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
