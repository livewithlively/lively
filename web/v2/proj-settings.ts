// v2/proj-settings.ts — **프로젝트 정보** 창(#1719 원준 2026-08-20).
//
//  왜 따로인가: 이름·상태·본문·할 일은 **자주 고치는 것이 아니다**. 그런데 종전 화면들은 그걸 늘 펼쳐 두느라
//  정작 매일 보는 것(세션·자료)의 자리를 빼앗았다. 그래서 기본 뷰는 그것들을 화면에서 빼고 여기 한곳에 모은다 —
//  문패 [정보]와 개요 부품의 [프로젝트 정보에서 고치기]가 같은 창을 연다.
//  이름은 '설정'이 아니라 **정보**(원준 2026-08-20) — 내용물이 동작 옵션이 아니라 프로젝트 그 자체라서다.
//
//  저장은 칸을 떠날 때(blur)·[저장]에서 곧바로 — '적용' 단계를 따로 두지 않는다(사람이 잊는다).
import { api, el, toast } from '../core.js';
import { pnIcon } from './panes-parts.js';
import { confirmProjectArchive } from '../session-actions.js';   // #1851 — [보관] 확인창(사이드바 우클릭과 같은 문구)

export interface ProjSettingsOpts {
  id: number;
  detail: any;
  onChanged?: () => void;
}

const STATES: Array<{ key: string; label: string; status: string }> = [
  { key: 'todo', label: '시작 전', status: 'todo' },
  { key: 'in_progress', label: '진행 중', status: 'in_progress' },
  { key: 'done', label: '끝남', status: 'done' },
];

export function openProjSettings(opts: ProjSettingsOpts): void {
  const id = opts.id;
  const p = (opts.detail && opts.detail.project) || {};
  let closed = false;

  const back = el('div', { class: 'pn-modal-back' });
  const panel = el('section', { class: 'pn-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '프로젝트 정보' });
  const close = (): void => {
    if (closed) return;
    closed = true;
    back.remove(); panel.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', close);

  // ── 이름 ──
  const nameIn = el('input', { class: 'pn-set-name', type: 'text', value: String(p.name || ''), 'aria-label': '프로젝트 이름' }) as HTMLInputElement;
  nameIn.addEventListener('blur', () => {
    const v = nameIn.value.trim();
    if (!v || v === String(p.name || '')) return;
    void api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify({ name: v }) })
      .then(() => { p.name = v; toast('이름을 바꿨어요.'); opts.onChanged?.(); })
      .catch((e: any) => toast('이름을 바꾸지 못했어요 — ' + (e?.message || e), true));
  });

  // ── 상태 ──
  const cur = p.status_category === 'done' ? 'done' : p.status_category === 'unstarted' ? 'todo' : 'in_progress';
  const stateRow = el('div', { class: 'pn-set-states' }, ...STATES.map((s) =>
    el('button', {
      class: 'pn-set-state' + (s.key === cur ? ' on' : ''), type: 'button', 'aria-pressed': String(s.key === cur),
      text: s.label,
      onclick: (e: MouseEvent) => {
        const btn = e.currentTarget as HTMLElement;
        void api('/api/ui/v6/projects/' + id + '/status', { method: 'POST', body: JSON.stringify({ status: s.status, status_raw: s.key }) })
          .then(() => {
            stateRow.querySelectorAll('.pn-set-state').forEach((n) => { n.classList.remove('on'); n.setAttribute('aria-pressed', 'false'); });
            btn.classList.add('on'); btn.setAttribute('aria-pressed', 'true');
            toast('상태를 바꿨어요.'); opts.onChanged?.();
          })
          .catch((err: any) => toast('상태를 바꾸지 못했어요 — ' + (err?.message || err), true));
      },
    })));

  // ── 본문 ──
  const desc = el('textarea', { class: 'pn-set-desc', rows: '10', placeholder: '이 프로젝트가 무엇인지 적어 두면 세션도 그걸 읽고 일합니다.', 'aria-label': '프로젝트 본문' }) as HTMLTextAreaElement;
  desc.value = String(p.description || '');
  const descSave = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '본문 저장', onclick: () => {
    const md = desc.value;
    descSave.disabled = true;
    void api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify({ description: md || null }) })
      .then(() => { p.description = md; toast('본문을 저장했어요.'); opts.onChanged?.(); })
      .catch((e: any) => toast('저장하지 못했어요 — ' + (e?.message || e), true))
      .finally(() => { descSave.disabled = false; });
  } }) as HTMLButtonElement;

  // ── 할 일 ──
  const taskList = el('div', { class: 'pn-set-tasks' });
  const taskIn = el('input', { class: 'pn-set-tin', type: 'text', placeholder: '할 일을 적고 Enter 를 누르세요.', 'aria-label': '새 할 일' }) as HTMLInputElement;
  taskIn.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const name = taskIn.value.trim();
    if (!name) return;
    taskIn.disabled = true;
    void api('/api/ui/v6/projects/' + id + '/tasks', { method: 'POST', body: JSON.stringify({ name }) })
      .then(() => { taskIn.value = ''; toast('할 일을 더했어요.'); opts.onChanged?.(); void reload(); })
      .catch((err: any) => toast('더하지 못했어요 — ' + (err?.message || err), true))
      .finally(() => { taskIn.disabled = false; taskIn.focus(); });
  });

  function paintTasks(tasks: any[]): void {
    if (!tasks.length) { taskList.replaceChildren(el('p', { class: 'pn-fine', text: '할 일이 아직 없어요.' })); return; }
    taskList.replaceChildren(...tasks.map((t) => {
      const isDone = t.status_category === 'done';
      return el('div', { class: 'pn-set-trow' + (isDone ? ' done' : '') },
        el('button', {
          class: 'pn-tcheck' + (isDone ? ' on' : ''), type: 'button', 'aria-pressed': String(isDone),
          title: isDone ? '아직 안 끝난 것으로 되돌립니다' : '끝냈다고 표시합니다',
          onclick: () => {
            void api('/api/ui/v6/tasks/' + t.id, { method: 'POST', body: JSON.stringify({ status: isDone ? 'todo' : 'done' }) })
              .then(() => { opts.onChanged?.(); void reload(); })
              .catch((e: any) => toast('바꾸지 못했어요 — ' + (e?.message || e), true));
          },
        }),
        el('span', { class: 'n ell2', text: t.name || '이름 없는 할 일' }),
        el('a', { class: 'pn-fine', href: '#/t/' + t.id, text: '열기 ↗' }));
    }));
  }
  paintTasks(Array.isArray(p.tasks) ? p.tasks : []);

  async function reload(): Promise<void> {
    try {
      const d: any = await api('/api/ui/v6/projects/' + id);
      if (closed || !d?.project) return;
      paintTasks(Array.isArray(d.project.tasks) ? d.project.tasks : []);
    } catch (_) { /* 목록만 못 갱신한 것이라 창은 그대로 둔다 */ }
  }

  const sec = (title: string, hint: string, ...kids: any[]): HTMLElement =>
    el('section', { class: 'pn-set-sec' }, el('h3', { text: title }), el('p', { class: 'pn-fine', text: hint }), ...kids);

  // ── 보관(#1851) — 통째로 아카이브로 / 해제. 삭제가 아니라 '평소 화면에서 치우기'. ──
  //  도는 세션 수는 셸이 들고 있는 목록이 아니라 상세 응답엔 없으므로 여기선 묻지 않고(0), 사이드바 경로가 그 숫자를 안다.
  //  보내고 나면 창을 닫고 아카이브 화면으로 — 사라진 것이 어디로 갔는지 바로 보여 준다.
  const archived = !!p.archived_at;
  const archBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: archived ? '보관 해제' : '아카이브로 보내기',
    title: archived ? '원래 자리(사이드바·보드)로 되돌립니다' : '사이드바·보드에서 빼고 [아카이브]에 둡니다' }) as HTMLButtonElement;
  archBtn.onclick = () => {
    void (async () => {
      if (!archived && !await confirmProjectArchive({ name: String(p.name || ''), liveN: 0 })) return;
      archBtn.disabled = true;
      try {
        await api('/api/ui/v6/projects/' + id + '/archive', { method: 'POST', body: JSON.stringify({ archived: !archived }) });
        toast(archived ? '보관을 해제했어요 — 원래 자리로 돌아왔어요.' : '아카이브로 보냈어요.');
        p.archived_at = archived ? null : new Date().toISOString();
        opts.onChanged?.();
        close();
        if (!archived) location.hash = '#/archive';
      } catch (e: any) { archBtn.disabled = false; toast((archived ? '보관을 해제하지' : '아카이브로 보내지') + ' 못했어요 — ' + (e?.message || e), true); }
    })();
  };

  panel.replaceChildren(
    el('header', { class: 'pn-modal-h' },
      el('h2', { text: '프로젝트 정보' }),
      el('button', { class: 'pn-modal-x', type: 'button', title: '닫습니다', 'aria-label': '닫기', onclick: close }, pnIcon('x', 'pn-i'))),
    el('div', { class: 'pn-modal-b' },
      sec('이름', '사이드바·탭에 보이는 이름입니다.', nameIn),
      sec('상태', '프로젝트가 지금 어느 단계인지 알려 줍니다.', stateRow),
      sec('본문', '무엇을 하는 프로젝트인지 적어 둡니다. 세션과 리브가 이 글을 읽고 일합니다.', desc, el('div', { class: 'pn-set-foot' }, descSave)),
      sec('할 일', '큰 덩어리만 적어 두면 충분합니다. 자세한 것은 세션이 만들어 줍니다.', taskIn, taskList),
      sec('보관', archived ? '지금 아카이브에 있어요. 해제하면 사이드바·보드에 다시 보입니다.' : '끝났거나 한동안 안 볼 프로젝트는 통째로 치워 둘 수 있어요. 태스크·세션·지식 연결은 그대로 남습니다.', el('div', { class: 'pn-set-foot' }, archBtn))),
    el('footer', { class: 'pn-modal-f' },
      el('a', { class: 'btn-text', href: '#/projects/' + id, onclick: () => close(), text: '전체 프로젝트 화면 열기 ↗' }),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기', onclick: close })));

  document.body.append(back, panel);
  window.setTimeout(() => nameIn.focus(), 0);
}
