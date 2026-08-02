// projects/detail-preview.ts — #1405 W1: detail.ts 에서 하강한 미리보기 모달(#1036).
//  ⭐ 하강 이유는 크기가 아니라 **순환**이다 — 읽는 쪽이 detail-terminal.ts 하나뿐인 심볼이라,
//   상세 서브트리의 단일 입구(detail.ts)에 두면 detail-terminal → detail 되짚기가 생긴다.
//   #1313 §1 의 판정 기준('읽는 쪽이 하나뿐인가')대로 소비자 쪽 잎으로 내렸다.
//  본문은 원문 그대로 옮겼다(verbatim).
import { api, el, toast } from '../core.js';
import { overlayBox } from '../learn.js';

// ── 미리보기(#1036) — 작업 중인 화면을 운영 화면·남의 작업과 섞지 않고 이 프로젝트 몫으로 따로 띄워 본다. ──
//  **자리**: 관리탭에만 두면 정작 화면을 확인할 작업자가 만나지 못한다. 그렇다고 프로젝트 상세에 섹션을 하나 더
//  붙이면 그 페이지가 이미 너무 길다 → 터미널 세션 섹션 헤더의 [🖥 미리보기] 버튼 → 모달(세션 기록 #905 C1 과 같은 형태).
//  관리탭 ▸ 미리보기는 조직 전체 목록(운영자 시야)으로 그대로 두고, 이 모달은 '이 프로젝트의 것'만 다룬다.
const PJV_PREVIEW_STATUS = { running: '실행 중', preparing: '준비 중…', error: '문제 있음', stopped: '꺼짐' };

function openProjectPreviewModal(id, projectName, repos0) {
  const repos = (repos0 || []).filter(Boolean);
  const body = el('div', {});
  const addBtn = el('button', { class: 'btn btn-primary btn-sm', text: '＋ 미리보기 만들기', onclick: () => pickRepoThenCreate() });
  // 저장소가 여럿이면 어느 것을 볼지 고르게 한다(하나면 묻지 않는다 — 작업자가 원하는 건 '지금 화면 보기'다).
  const repoSel = repos.length > 1 ? el('select', { style: 'padding:6px 8px;font:inherit;max-width:220px' }) : null;
  if (repoSel) for (const n of repos) repoSel.append(el('option', { value: n, text: n }));
  const back = overlayBox('미리보기' + (projectName ? ' — ' + projectName : ''),
    el('div', { class: 'proj-settings' },
      el('section', { class: 'ps-block' },
        el('p', { class: 'ps-block-hint', text: '작업 중인 화면을 운영 화면이나 다른 사람 작업에 영향 없이 따로 띄워 봅니다. 만들면 주소가 나오고, 그 주소를 팀원에게 보내 확인받을 수 있어요.' }),
        body),
      el('div', { class: 'ps-rules-actions' }, ...(repoSel ? [repoSel] : []), addBtn)));
  let timer: any = null;

  async function load() {
    if (timer) { clearTimeout(timer); timer = null; }
    let envs: any[] = [];
    try { const r = await api('/api/ui/preview-envs'); envs = ((r && r.envs) || []).filter((x) => Number(x.project_id) === Number(id)); }
    catch (e) {
      body.replaceChildren(el('p', { class: 'ps-block-hint', text: e.status === 403
        ? '이 기능을 쓸 권한이 없습니다 — 관리자에게 코드 권한을 요청하세요.'
        : '미리보기를 불러오지 못했습니다 — ' + e.message }));
      addBtn.disabled = true; return;
    }
    if (!envs.length) {
      body.replaceChildren(el('p', { class: 'ps-block-hint', text: repos.length
        ? '아직 만든 미리보기가 없습니다. 아래 ‘＋ 미리보기 만들기’를 누르면 작업 폴더 준비·빌드까지 자동으로 끝내고 주소를 만들어 줍니다.'
        : '이 프로젝트에는 연결된 코드 저장소가 없습니다 — ⚙ 프로젝트 세부 설정에서 관련 레포를 먼저 연결해 주세요.' }));
      if (!repos.length) addBtn.disabled = true;
      return;
    }
    const rows = envs.map((env) => {
      const statusText = PJV_PREVIEW_STATUS[env.status] || (env.status || '알 수 없음');
      const acts = [
        env.status === 'running' ? el('a', { class: 'btn btn-primary btn-sm', href: '/preview/' + encodeURIComponent(env.id) + '/ui/', target: '_blank', text: '화면 열기 ↗' }) : null,
        env.status !== 'preparing' ? el('button', { class: 'btn btn-ghost btn-sm', text: env.status === 'running' ? '새로 만들기' : '띄우기', onclick: (e) => act(e.target, '/ensure', env.id) }) : null,
        (env.status === 'running' || env.status === 'preparing') ? el('button', { class: 'btn btn-ghost btn-sm', text: '끄기', onclick: (e) => act(e.target, '/stop', env.id) }) : null,
      ].filter(Boolean);
      return el('div', { class: 'wikicat-row' },
        el('div', { class: 'wikicat-row-main' },
          el('span', { class: 'wikicat-name', text: env.label || env.id }),
          el('span', { class: 'wikicat-key', text: [env.repo, env.kind === 'stage' ? '여러 작업을 합쳐서 봄' : null].filter(Boolean).join(' · ') }),
          el('span', { class: 'dm-tag', text: env.enabled ? statusText : '꺼둠' }),
          env.last_error ? el('span', { class: 'wikicat-should' }, el('span', { class: 'wikicat-should-label', text: '안내' }), env.last_error) : null),
        el('div', { class: 'wikicat-row-acts' }, ...acts));
    });
    body.replaceChildren(el('div', { class: 'wikicat' }, el('div', { class: 'wikicat-rows' }, ...rows)));
    // 준비 중이면 사람이 새로고침하지 않아도 되게 잠시 뒤 다시 확인한다(모달을 닫으면 스스로 멈춤).
    if (envs.some((x) => x.status === 'preparing')) timer = setTimeout(() => { if (document.body.contains(back)) load(); }, 5000);
  }

  async function act(btn, suffix, envId) {
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/ui/preview-envs/' + encodeURIComponent(envId) + suffix, { method: 'POST' });
      if (suffix === '/stop') toast('껐습니다');
      else if (r && r.status === 'running') toast('준비됐습니다 — ‘화면 열기’로 확인하세요');
      else if (r && r.status === 'preparing') toast('준비를 시작했습니다 — 끝나면 여기에 표시됩니다');
      else toast((r && r.error) || '띄우지 못했습니다', true);
    } catch (e) { toast('실패 — ' + e.message, true); }
    load();
  }

  function pickRepoThenCreate() {
    if (!repos.length) { toast('먼저 ⚙ 프로젝트 세부 설정에서 관련 레포를 연결해 주세요', true); return; }
    create(repoSel ? repoSel.value : repos[0]);
  }

  async function create(repo) {
    addBtn.disabled = true;
    try {
      const saved = await api('/api/ui/preview-envs', { method: 'POST', body: JSON.stringify({ project_id: id, repo, kind: 'work' }) });
      const envId = saved && saved.env && saved.env.id;
      if (envId) await api('/api/ui/preview-envs/' + encodeURIComponent(envId) + '/ensure', { method: 'POST' }).catch(() => { /* 목록에서 다시 시도할 수 있다 */ });
      toast('만들었습니다 — 화면을 준비하고 있습니다');
    } catch (e) { toast('실패 — ' + e.message, true); }
    addBtn.disabled = false;
    load();
  }

  body.replaceChildren(el('p', { class: 'ps-block-hint', text: '불러오는 중…' }));
  load();
  return back;
}

export { openProjectPreviewModal };
