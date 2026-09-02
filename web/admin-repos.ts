// admin-repos.ts — 레포(git) 관리 패널 (#1313 R39, admin.ts 에서 verbatim 분리).
//  등록 · git 연결(목록 픽커 · 연결 확인) · 폐기/복귀 · 영구삭제 + 공유 클론 최신화.
//  셸을 역호출하지 않는 자족 패널이다 — 재렌더는 자기 자신(reposPanel)을 다시 부르는 reload 클로저로 끝난다.
//  ⚠ 게이트웨이 git 자격 오버레이(openGitCredentialManager)는 R38 의 admin-credentials 가 소유한다 — 여기선 받아 쓴다.
import { api, busy, el, errorNote, state, toast, uiText } from './core.js';
import { overlay, overlayBox, skeleton } from './ui-primitives.js';
import { embeddedHost, psBlock, psInputStyle, sectionHead } from './admin-widgets.js';
import { openGitCredentialManager } from './admin-credentials.js';

// ── 레포(git) 관리 — repo 테이블(=실제 git 레포)을 등록·git 연결·폐기·삭제. ──
//  레거시('repo 통제어휘 CRUD' = repo>domain vocab 계층, 웹 미와이어)를 폐기하고 git 레포 관리로 대체.
//  repo 는 code_unit 이 매핑되는 실 git 레포다. 여기 설정한 git_url/default_branch 는 도메인맵 스캔(webhook)과
//  '내 컴퓨터에서 작업' 클론이 함께 쓰는 단일 소스. 편집은 context 스코프(없으면 읽기 전용).
async function reposPanel(detail, data) {
  const canEdit = state.admin.canContext;
  const reload = () => reposPanel(detail, data);
  busy(detail, el('div', { class: 'card' }, skeleton('레포를 불러오는 중')));
  let repos;
  try { const r = await api('/api/ui/repos'); repos = (r && r.domainmapRepos) || []; }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '레포를 불러오지 못했습니다'))); return; }

  const rows = el('div', { class: 'wikicat-rows' });
  if (!repos.length) {
    rows.append(el('div', { class: 'wikicat-empty', text: '아직 등록된 레포가 없습니다.' }));
  } else {
    for (const r of repos) {
      const deprecated = (r.state || 'active') === 'deprecated';
      const t = r.totals || {};
      const meta = r.clone_url
        ? el('span', { class: 'wikicat-should', title: r.clone_url },
            el('span', { class: 'wikicat-should-label', text: 'git' }), r.clone_url + ' · ' + (r.default_branch || 'main'))
        : el('span', { class: 'wikicat-should wikicat-should-empty' },
            el('span', { class: 'wikicat-should-label', text: 'git' }),
            canEdit ? 'git 미연결 — 수정에서 연결하세요' : 'git 미연결');
      const main = el('div', { class: 'wikicat-row-main' },
        el('span', { class: 'wikicat-name', text: r.name }),
        el('span', { class: 'wikicat-key mono', text: 'code_unit ' + (t.code_units || 0) + ' · 도메인 ' + (t.domains || 0) }),
        deprecated ? el('span', { class: 'dm-tag', text: '폐기됨' }) : null,
        meta);
      const acts = canEdit ? el('div', { class: 'wikicat-row-acts' },
        el('button', { class: 'btn btn-ghost btn-sm', text: '⟳ 최신화', title: '이 레포의 공유 클론을 upstream 기준으로 최신화합니다(fetch + fast-forward). 게이트웨이 계정이 가져오므로 모든 구성원이 최신 코드를 읽을 수 있습니다.', onclick: (e) => repoRefreshShared(r.name, e) }),
        el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openRepoForm(r, reload) }),
        el('button', { class: 'btn btn-ghost btn-sm', text: deprecated ? '복귀' : '폐기', onclick: () => repoSetDeprecated(r.name, deprecated, reload) }),
        el('button', { class: 'btn btn-ghost btn-sm repo-del-btn', text: '삭제', onclick: () => repoHardDelete(r.name, reload) })) : null;
      rows.append(el('div', { class: 'wikicat-row' }, main, acts));
    }
  }

  // fix#92: 카드 제목 바로 아래에서 '레포/git/숫자'를 반복하던 그룹 헤더 제거 — 카운트는 제목에, 추가 버튼은 카드 헤더로.
  // null 을 replaceChildren 에 직접 넘기면 DOM 이 "null" 텍스트로 렌더한다 → filter(Boolean) 로 차단(#req).
  //  #2556 — 새 셸 [외부 앱 연결] 아래 [코드 저장소] 화면이 이 패널을 자기 칸으로 흡수했다. 그 칸이 이미
  //   제목을 갖고 있으므로 그 자리에서만 머리를 접는다(같은 목록·같은 저장경로 — 사본 없음).
  detail.replaceChildren(...[
    embeddedHost(detail) ? null : sectionHead('레포(git) · ' + repos.length + '개', '우리 코드 레포를 등록합니다. 여기 등록한 레포로 도메인맵을 만들고, 프로젝트에서 코드 작업을 할 때 내려받습니다.'),
    canEdit ? null : el('p', { class: 'admin-sub', style: 'margin:-4px 0 12px' }, el('span', { class: 'pill', text: '읽기 전용' }), ' 편집은 context 권한 필요'),
    (canEdit || state.admin.canEdit) ? el('div', { class: 'admin-actions', style: 'margin:0 0 14px' },
      canEdit ? el('button', { class: 'btn btn-ghost btn-sm', text: '+ 레포 추가', onclick: () => openRepoForm(null, reload) }) : null,
      state.admin.canEdit ? el('button', { class: 'btn btn-ghost btn-sm', text: '게이트웨이 git 계정 관리', onclick: () => openGitCredentialManager('gateway') }) : null) : null,
    el('div', { class: 'wikicat' }, el('div', { class: 'wikicat-group' }, rows)),
  ].filter(Boolean));
}

// 레포 공유 클론 최신화(#660 RO) — 선택한 레포의 공유 베이스(workspace/repos/<name>)를 upstream 으로 fast-forward.
//  게이트웨이(클론 소유자)가 서버에서 fetch+ff 하므로 멤버는 group-write 없이도 최신 코드를 읽게 된다(공유 실행코드 변조 불가 → 격리 유지).
//  비파괴: dirty/갈라짐이면 건드리지 않고 사유를 알린다. scope=context(레포 편집 권한과 동일).
async function repoRefreshShared(name, ev) {
  const btn = ev && ev.currentTarget;
  const prev = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '최신화 중…'; }
  try {
    const r = await api('/api/ui/repos/' + encodeURIComponent(name) + '/refresh', { method: 'POST' });
    const s7 = (x) => (x ? String(x).slice(0, 7) : '');
    if (r && r.status === 'ok') alert('최신화 완료: ' + name + '\n' + s7(r.before) + ' → ' + s7(r.after));
    else if (r && r.status === 'up-to-date') alert('이미 최신입니다: ' + name);
    else if (r && r.status === 'dirty') alert('로컬 변경이 있어 건너뛰었습니다: ' + name + '\n' + (r.detail || ''));
    else if (r && r.status === 'no-clone') alert('공유 클론이 아직 없습니다(이 레포를 쓰는 프로젝트에서 먼저 provision): ' + name);
    else if (r && r.status === 'no-upstream') alert('현재 브랜치에 upstream 이 없습니다: ' + name);
    else alert('최신화 결과(' + (r && r.status) + '): ' + ((r && r.detail) || ''));
  } catch (e) {
    alert('최신화 실패: ' + (e && e.message ? e.message : e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prev; }
  }
}

// 레포 추가/수정 폼(오버레이) — 이름(신규=생성 / 변경=이름변경) + git_url + default_branch.
//  #825: 3필드를 손으로 치는 대신 [목록에서 선택](저장된 토큰으로 호스트의 레포 조회 → 3필드 프리필) +
//  [연결 확인](저장 전 ls-remote 로 접근·기본브랜치 확인). 둘 다 '제안' 이고, 텍스트 입력은 그대로 살아 있다
//  (토큰 없는 호스트·SSH 전송·미지원 provider 에서도 기존처럼 등록 가능해야 하므로).
function openRepoForm(repo, reload) {
  const isNew = !repo;
  const nameInp = el('input', { type: 'text', style: psInputStyle, value: repo ? repo.name : '', placeholder: 'context-ontology' });
  const urlInp = el('input', { type: 'text', style: psInputStyle, value: (repo && repo.clone_url) || '', placeholder: 'https://github.com/org/repo.git' });
  const branchInp = el('input', { type: 'text', style: psInputStyle, value: (repo && repo.default_branch) || 'main', placeholder: 'main' });

  // 선택한 레포를 3필드에 채운다. clone_url 은 서버가 그 호스트의 git 전송 방식(ssh/https)에 맞춰 고른 주소다
  //  — 목록은 API 토큰으로 조회하고 클론은 SSH 로 하는 조합(HTTPS 막힌 셀프호스팅)이 실제로 있기 때문.
  const fill = (o) => {
    nameInp.value = o.name || '';
    urlInp.value = o.clone_url || o.http_url || o.ssh_url || '';
    branchInp.value = o.default_branch || 'main';
    checkNote.replaceChildren(); // 이전 확인 결과는 무효 — 주소가 바뀌었으니.
  };
  const pickBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '목록에서 선택',
    onclick: () => openRepoPicker(fill) });
  const checkBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '연결 확인' });
  const checkNote = el('p', { class: 'ps-block-hint', style: 'margin:6px 0 0' });

  checkBtn.onclick = async () => {
    const url = urlInp.value.trim();
    if (!url) { toast('git 주소를 먼저 입력하세요', true); return; }
    checkBtn.disabled = true;
    checkNote.replaceChildren(el('span', { class: 'admin-hint' }, ...uiText('확인 중…')));
    try {
      const r = await api('/api/ui/repos/check', { method: 'POST', body: JSON.stringify({ git_url: url }) });
      if (r.ok) {
        const drift = r.default_branch && branchInp.value.trim() && r.default_branch !== branchInp.value.trim();
        checkNote.replaceChildren(el('span', { style: 'color:var(--ok)',
          text: `✓ 접근 OK — ${r.host} · 브랜치 ${r.branches}개 · 원격 기본 브랜치 ${r.default_branch || '알 수 없음'}` }));
        // 원격의 실제 기본 브랜치가 입력값과 다르면 조용히 넘기지 않는다 — 스캔이 엉뚱한 브랜치를 읽는 사고의 원인.
        if (drift) {
          const useBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: `‘${r.default_branch}’ 로 맞추기`,
            onclick: () => { branchInp.value = r.default_branch; checkNote.replaceChildren(el('span', { style: 'color:var(--ok)', text: `✓ 기본 브랜치를 ${r.default_branch} 로 설정했습니다` })); } });
          checkNote.append(el('span', { text: ` — 입력한 ‘${branchInp.value.trim()}’ 와 다릅니다. ` }), useBtn);
        }
      } else {
        checkNote.replaceChildren(el('span', { style: 'color:var(--danger)', text: '✗ ' + (r.detail || '접근 실패') }));
      }
    } catch (e) { checkNote.replaceChildren(el('span', { style: 'color:var(--danger)', text: '✗ 확인 실패 — ' + e.message })); }
    checkBtn.disabled = false;
  };

  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: isNew ? '레포 추가' : '저장' });
  const form = el('div', { class: 'proj-settings' },
    isNew ? el('div', { class: 'conn-pick-row', style: 'margin-bottom:10px' },
      el('span', { class: 'admin-hint', style: 'margin:0; flex:1',
        text: '등록된 git 자격으로 레포 목록을 불러와 고를 수 있어요 — 이름·주소·기본 브랜치가 함께 채워집니다.' }), pickBtn) : null,
    psBlock('레포 이름', isNew ? '실제 git 레포 이름 — code_unit 이 이 이름으로 매핑됩니다. (경로 컴포넌트라 슬래시 불가 — GitLab 서브그룹은 마지막 조각만 들어갑니다)' : '이름을 바꿔도 매핑·도메인은 보존됩니다.', nameInp),
    psBlock('git 주소 (clone URL)', '도메인맵 스캔과 로컬 작업 클론이 이 주소를 씁니다. 비우면 git 미연결. HTTPS 가 막힌 셀프호스팅(GitLab 등)은 SSH 형(git@호스트:그룹/레포.git)으로 넣으세요.',
      el('div', {}, el('div', { class: 'conn-pick-row' }, urlInp, checkBtn), checkNote)),
    psBlock('기본 브랜치', '비우면 main. [연결 확인]으로 원격의 실제 기본 브랜치를 확인할 수 있어요.', branchInp),
    el('div', { class: 'ps-rules-actions' }, saveBtn));
  const back = overlayBox(isNew ? '레포 추가' : '레포 수정 — ' + repo.name, form);
  const boxw = back.querySelector('.ov-box'); if (boxw) boxw.classList.add('ov-box-wide');
  saveBtn.onclick = async () => {
    const nm = nameInp.value.trim();
    if (!nm) { toast('레포 이름이 필요합니다', true); return; }
    saveBtn.disabled = true;
    try {
      if (isNew) await api('/api/ui/domainmap/repo/create', { method: 'POST', body: JSON.stringify({ name: nm }) });
      else if (nm !== repo.name) await api('/api/ui/domainmap/repo/rename', { method: 'POST', body: JSON.stringify({ name: repo.name, newName: nm }) });
      await api('/api/ui/domainmap/repo/source', { method: 'POST', body: JSON.stringify({ name: nm, git_url: urlInp.value.trim() || null, default_branch: branchInp.value.trim() || 'main' }) });
      toast(isNew ? '레포를 추가했습니다' : '저장했습니다'); back.remove(); reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
}

// 레포 픽커(#825) — 저장된 토큰으로 조회한 레포 목록에서 고른다. 커넥터 스코프 픽커(#586)의 git 판.
//  목록이 비어도(SSH 뿐인 호스트·토큰 없음) 실패가 아니다 — 사유(note)를 보여주고 텍스트 입력으로 돌려보낸다.
async function openRepoPicker(onPick) {
  const box = el('div', {}, el('p', { class: 'admin-hint' }, ...uiText('등록된 git 자격으로 레포 목록을 조회하는 중…')));
  const back = overlay('레포 — 목록에서 선택', box);
  try {
    const r = await api('/api/ui/repos/discover', { method: 'POST', body: JSON.stringify({}) });
    const opts = r.options || [];
    const noteEl = r.note ? el('p', { class: 'admin-hint', style: 'white-space:pre-line' }, ...uiText(r.note)) : null;
    if (!opts.length) { box.replaceChildren(noteEl || el('p', { class: 'admin-hint' }, ...uiText('고를 레포가 없습니다 — git 주소를 직접 입력하세요.'))); return; }

    // 이미 등록된 레포는 회색 처리 — 중복 등록(409)을 누르기 전에 보이게.
    let existing = new Set();
    try { const rr = await api('/api/ui/repos'); existing = new Set(((rr && rr.domainmapRepos) || []).map((x) => x.name)); } catch (_) { /* 목록 못 읽어도 픽커는 동작 */ }

    const search = el('input', { type: 'text', style: 'width:100%;padding:6px 8px;font:inherit;box-sizing:border-box', placeholder: '레포 이름·경로로 검색' });
    const list = el('div', { class: 'conn-pick-list' });
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const hit = opts.filter((o) => !q || (o.full_path + ' ' + o.name).toLowerCase().includes(q));
      list.replaceChildren(...(hit.length ? hit.map((o) => {
        const dup = existing.has(o.name);
        return el('label', { class: 'conn-pick-item', onclick: () => { onPick(o); back.remove(); toast(`‘${o.full_path}’ 를 채웠습니다 — [레포 추가]를 눌러야 등록됩니다`); } },
          el('span', { text: o.private ? '🔒' : '🌐' }),
          el('span', { class: 'conn-pick-label', text: o.full_path }),
          el('span', { class: 'mini-meta mono', text: (o.default_branch || '?') + (dup ? ' · 이미 등록됨' : '') }));
      }) : [el('p', { class: 'admin-hint' }, ...uiText('검색 결과가 없습니다.'))]));
    };
    search.oninput = render;
    render();
    box.replaceChildren(noteEl, search, list,
      el('p', { class: 'admin-hint' }, ...uiText('고르면 이름·git 주소·기본 브랜치가 폼에 채워집니다(그대로 편집할 수 있어요). 목록에 없어도 주소를 직접 입력해 등록할 수 있습니다.')));
  } catch (e) {
    box.replaceChildren(el('p', { class: 'admin-hint', text: '조회 실패: ' + e.message + ' — git 주소를 직접 입력하세요.' }));
  }
}

async function repoSetDeprecated(name, isDeprecated, reload) {
  try { await api('/api/ui/domainmap/repo/deprecate', { method: 'POST', body: JSON.stringify({ name, undo: isDeprecated }) }); toast(isDeprecated ? '복귀했습니다' : '폐기했습니다'); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}

async function repoHardDelete(name, reload) {
  if (!confirm('레포 ‘' + name + '’을(를) 영구삭제할까요?\n\n코드유닛·매핑·도메인 등 하위가 함께 삭제됩니다(되돌릴 수 없음).')) return;
  try {
    const r = await api('/api/ui/domainmap/repo/delete', { method: 'POST', body: JSON.stringify({ name }) });
    if (r && r.blocked) {
      const c = r.refs || {};
      if (!confirm('하위가 있습니다 (code ' + (c.code_units || 0) + ' · entities ' + (c.data_entities || 0) + '). 그래도 모두 cascade 삭제할까요?')) return;
      await api('/api/ui/domainmap/repo/delete', { method: 'POST', body: JSON.stringify({ name, force: true }) });
    }
    toast('삭제했습니다'); reload();
  } catch (e) { toast('실패 — ' + e.message, true); }
}

export {
  reposPanel,
};
