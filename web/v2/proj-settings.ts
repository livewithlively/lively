// v2/proj-settings.ts — **프로젝트 정보** 창(#1719 원준 2026-08-20).
//
//  왜 따로인가: 이름·상태·본문·할 일은 **자주 고치는 것이 아니다**. 그런데 종전 화면들은 그걸 늘 펼쳐 두느라
//  정작 매일 보는 것(세션·자료)의 자리를 빼앗았다. 그래서 기본 뷰는 그것들을 화면에서 빼고 여기 한곳에 모은다 —
//  문패 [정보]와 개요 부품의 [프로젝트 정보에서 고치기]가 같은 창을 연다.
//  이름은 '설정'이 아니라 **정보**(원준 2026-08-20) — 내용물이 동작 옵션이 아니라 프로젝트 그 자체라서다.
//
//  저장은 **손대면 곧바로** — 이름·상태는 고른 그 자리에서, 본문은 타자가 멎으면(1.2s) 자동으로.
//  '적용'도 '[본문 저장]'도 두지 않는다(#1719 원준 2026-08-21): 한 창 안에서 어떤 칸은 즉시 남고
//  어떤 칸만 버튼을 요구하면 규칙이 둘로 갈린다 — 사람은 버튼을 못 보고 창을 닫고, 쓴 글이 사라진다.
import { api, el, toast } from '../core.js';
import { pnIcon } from './panes-parts.js';
import { confirmProjectArchive, confirmProjectTrash } from '../session-actions.js';   // #1851 — [보관] 확인창(사이드바 우클릭과 같은 문구)

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
    // 닫기(X·Esc·바깥 클릭)로 빠져나가도 미저장분은 남긴다 — 창은 곧바로 닫히고 저장은 뒤에서 끝난다.
    //  요소가 지워지며 blur 가 안 뜨는 브라우저가 있어 blur 만 믿을 수 없다.
    flushName(); void flushDesc();
    back.remove(); panel.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', close);

  // ── 이름 ──
  const nameIn = el('input', { class: 'pn-set-name', type: 'text', value: String(p.name || ''), 'aria-label': '프로젝트 이름' }) as HTMLInputElement;
  let nameSaved = String(p.name || '');
  // blur 와 close 가 잇달아 부를 수 있으므로 보내기 **전에** 기준값을 옮겨 둔다(중복 전송 방지·실패하면 되돌린다).
  const flushName = (): void => {
    const v = nameIn.value.trim();
    if (!v || v === nameSaved) return;
    const prev = nameSaved; nameSaved = v;
    void api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify({ name: v }) })
      .then(() => { p.name = v; toast('이름을 바꿨어요.'); opts.onChanged?.(); })
      .catch((e: any) => { nameSaved = prev; toast('이름을 바꾸지 못했어요 — ' + (e?.message || e), true); });
  };
  nameIn.addEventListener('blur', flushName);

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
  // 자동저장 — 프로젝트 상세 본문(projects/detail-body.ts)과 같은 박자(1.2s 디바운스 + 칸을 떠날 때·창 닫을 때 flush).
  //  저장했다는 신호는 토스트가 아니라 칸 아래 작은 글씨다 — 타자를 칠 때마다 토스트가 뜨면 그게 방해가 된다.
  const descChip = el('span', { class: 'pn-set-chip' });
  const setChip = (t: string, warn?: boolean): void => { descChip.textContent = t; descChip.classList.toggle('warn', !!warn); };
  let descTimer: number | null = null, descSaving = false, descSaved = desc.value;
  const saveDesc = async (): Promise<void> => {
    if (descSaving) return;
    const md = desc.value;
    if (md === descSaved) { setChip(''); return; }
    descSaving = true; setChip('저장 중…');
    try {
      await api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify({ description: md || null }) });
      descSaved = md; p.description = md;
      setChip('저장했어요.');
      window.setTimeout(() => { if (descChip.textContent === '저장했어요.') setChip(''); }, 1600);
      opts.onChanged?.();
    } catch (e: any) {
      setChip('저장하지 못했어요.', true);
      toast('본문을 저장하지 못했어요 — ' + (e?.message || e), true);
    }
    descSaving = false;
    if (desc.value !== descSaved) queueDesc();   // 저장하는 동안 더 친 글이 있으면 곧바로 다음 저장을 건다
  };
  const queueDesc = (): void => {
    setChip('쓰는 중…');
    if (descTimer !== null) window.clearTimeout(descTimer);
    descTimer = window.setTimeout(() => { descTimer = null; void saveDesc(); }, 1200);
  };
  const flushDesc = (): Promise<void> => {
    if (descTimer !== null) { window.clearTimeout(descTimer); descTimer = null; }
    return desc.value === descSaved ? Promise.resolve() : saveDesc();
  };
  desc.addEventListener('input', queueDesc);
  desc.addEventListener('blur', () => { void flushDesc(); });

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

  // ── 삭제 = 휴지통으로(#1851, 원준 2026-08-24) — 창 맨 아래 '위험 구역'(설정 창의 관례). 프로젝트와 그 아래 내 세션이 한 묶음으로
  //  휴지통에 간다(도는 세션은 멈춤). 세션 수는 셸 목록을 여기서 못 보니 확인창은 개수 대신 '함께 간다'만 말한다 — 사이드바 우클릭 경로가 개수를 안다.
  const trashBtn = el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: '휴지통으로 보내기',
    title: '프로젝트와 그 안의 내 세션을 함께 휴지통으로 보냅니다 — 휴지통에서 복원할 수 있어요' }) as HTMLButtonElement;
  trashBtn.onclick = () => {
    void (async () => {
      if (!await confirmProjectTrash({ name: String(p.name || ''), sessN: Number(p.session_count ?? p.my_session_count ?? 0) || 0, liveN: 0, othersLive: 0 })) return;
      trashBtn.disabled = true;
      try {
        const res: any = await api('/api/ui/v6/projects/' + id + '/trash', { method: 'POST', body: JSON.stringify({ trashed: true }) });
        const sk = Array.isArray(res?.sessions?.skipped) ? res.sessions.skipped : [];
        toast('휴지통으로 보냈어요 — 휴지통에서 [복원]하면 세션까지 함께 돌아와요' + (sk.length ? ` (세션 ${sk.length}개는 건너뜀 — ${sk[0].why})` : ''));
        opts.onChanged?.();
        close();
        location.hash = '#/trash';
      } catch (e: any) { trashBtn.disabled = false; toast('휴지통으로 보내지 못했어요 — ' + (e?.message || e), true); }
    })();
  };

  panel.replaceChildren(
    el('header', { class: 'pn-modal-h' },
      el('h2', { text: '프로젝트 정보' }),
      el('button', { class: 'pn-modal-x', type: 'button', title: '닫습니다', 'aria-label': '닫기', onclick: close }, pnIcon('x', 'pn-i'))),
    el('div', { class: 'pn-modal-b' },
      sec('이름', '사이드바·탭에 보이는 이름입니다.', nameIn),
      sec('상태', '프로젝트가 지금 어느 단계인지 알려 줍니다.', stateRow),
      sec('본문', '무엇을 하는 프로젝트인지 적어 둡니다. 쓰면 저절로 저장되고, 세션과 리브가 이 글을 읽고 일합니다.', desc, el('div', { class: 'pn-set-foot' }, descChip)),
      sec('할 일', '큰 덩어리만 적어 두면 충분합니다. 자세한 것은 세션이 만들어 줍니다.', taskIn, taskList),
      sec('보관', archived ? '지금 아카이브에 있어요. 해제하면 사이드바·보드에 다시 보입니다.' : '끝났거나 한동안 안 볼 프로젝트는 통째로 치워 둘 수 있어요. 태스크·세션·지식 연결은 그대로 남습니다.', el('div', { class: 'pn-set-foot' }, archBtn)),
      sec('삭제', '프로젝트를 폴더째 휴지통으로 보냅니다 — 그 안의 내 세션도 함께 가고, 도는 세션은 멈춥니다. 휴지통에서 복원하면 함께 돌아와요.', el('div', { class: 'pn-set-foot' }, trashBtn))),
    el('footer', { class: 'pn-modal-f' },
      // ⚠ `#/projects/<id>` 가 아니다 — v1 프로젝트 탭 폐기(2026-06-23) 이후 그 경로는 **id 를 버리고** 보드로
      //  리다이렉트한다(web/main.ts). 그래서 이 링크는 그동안 늘 엉뚱한 화면(전체 보드)에 떨어졌다(#2116 에서 발견).
      el('a', { class: 'btn-text', href: '#/projects2/p/' + id, onclick: () => close(), text: '전체 프로젝트 화면 열기 ↗' }),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기', onclick: close })));

  document.body.append(back, panel);
  window.setTimeout(() => nameIn.focus(), 0);
}
