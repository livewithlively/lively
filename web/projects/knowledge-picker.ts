// projects/knowledge-picker.ts — #1405 W2: project-form.ts 에서 하강한 지식 픽커(#317).
//  ⭐ 하강 이유는 크기가 아니라 **순환**이다 — project-form 안에서는 아무도 이걸 쓰지 않고,
//   읽는 쪽은 projects/detail-knowledge.ts 하나뿐이었다. 폼 모듈에 남겨 두면 '지식 흐름' 섹션이
//   project-form → rows → filters/selection 을 되짚어 새 순환 경로가 생긴다.
//   #1313 §1 의 판정 기준('읽는 쪽이 하나뿐인가')대로 소비자 쪽 잎으로 내렸다.
import { api, busy, el, errorNote, toast } from '../core.js';
import { overlayBox } from '../learn.js';
import { debounce } from './files.js';

// 지식 연결(#317) — 위키검색·자동추천 두 모달을 하나로. 열면 추천(관련도순)이 먼저 뜨고, 검색하면 그 너머로 좁힌다.
//  연결 관계(필요/산출)는 칼럼에서 연 기본값을 따르되 라디오로 그 자리서 바꿀 수 있다(멘션 ≠ 항상 필요).
//  추천=project_recommend_knowledge_v6(벡터 #172), 검색=knowledge/semantic(#1133 — 하이브리드 의미검색.
//  구 knowledge/search 는 리터럴 grep 이라 자연어·다른 표현이면 0건 → "검색해도 원하는 지식이 안 나옴").
//  이미 연결된 건 클라이언트에서 제외 — 관계(필요/산출)별로 따로(#1133: required 만 알던 탓에 산출로 바꿔
//  연결하면 이미 연결된 것도 목록에 남아 '연결했습니다' 토스트만 뜨는 무음 no-op 이 있었다).
function openKnowledgePicker(id, relation, linkedNames, onLinked) {
  // linkedNames: {required:[], produced:[]} — 관계별 연결 상태(구 배열 인자는 required 로 흡수).
  const linkedBy = Array.isArray(linkedNames)
    ? { required: new Set(linkedNames), produced: new Set() }
    : { required: new Set((linkedNames && linkedNames.required) || []), produced: new Set((linkedNames && linkedNames.produced) || []) };
  let curRel = relation === 'produced' ? 'produced' : 'required';  // 라디오로 변경 가능.
  const linked = () => linkedBy[curRel];

  const searchIn = el('input', { type: 'search', class: 'proj-file-search', placeholder: '무엇이든 검색해 더 찾기 — 의미로 찾습니다…' });
  const recHead = el('div', { class: 'ps-kn-sec', text: '추천 · 이 프로젝트와 관련도순' });
  const results = el('div', { class: 'ps-kn-pick-results' });

  // 연결 관계 토글 — 기본은 연 칼럼. 바꾸면 이후 [연결]이 그 관계로 들어간다.
  const relName = 'pjk-rel-' + id;
  const mkRadio = (val, label) => {
    const inp = el('input', { type: 'radio', name: relName, value: val });
    if (val === curRel) inp.checked = true;
    // 관계를 바꾸면 목록을 다시 그린다(#1133) — '이미 연결됨' 제외가 관계별이라 필터 기준이 달라진다.
    inp.onchange = () => { if (inp.checked && curRel !== val) { curRel = val; rerender(); } };
    return el('label', { class: 'pjk-rel-opt' }, inp, el('span', { text: label }));
  };
  // '직접 작성'은 칼럼 버튼에서 빼 픽커 안으로 옮김(#317 정리) — 찾는 지식이 없을 때 그 관계 그대로 새 작성 페이지로.
  const createLink = el('a', { href: '#', style: 'margin-left:auto; font-size:12.5px; color:var(--blue); text-decoration:none; white-space:nowrap;', text: '＋ 직접 작성' });
  createLink.onclick = (e) => { e.preventDefault(); location.hash = '#/knowledge/new?project=' + id + '&relation=' + curRel; };
  const relRow = el('div', { class: 'pjk-rel-row' },
    el('span', { class: 'admin-hint', text: '연결 관계' }), mkRadio('required', '필요'), mkRadio('produced', '산출'), createLink);

  overlayBox('지식 연결', el('div', { class: 'ps-kn-pick' }, searchIn, recHead, results, relRow));
  setTimeout(() => searchIn.focus(), 0);

  // 한 줄(추천·검색 공용). isRec 면 유사도/분류 뱃지를 제목 옆에.
  function pickRow(m, isRec) {
    const pct = Math.round((Number(m.similarity) || 0) * 100);
    const addBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 연결' });
    addBtn.onclick = async () => {
      addBtn.disabled = true;
      try { await api('/api/ui/v6/projects/' + id + '/knowledge', { method: 'POST', body: JSON.stringify({ name: m.name, relation: curRel }) });
        linkedBy[curRel].add(m.name); addBtn.textContent = '연결됨'; toast('연결했습니다'); if (onLinked) onLinked(); }
      catch (e) { addBtn.disabled = false; toast('연결 실패 — ' + e.message, true); }
    };
    const tags = isRec ? el('span', { style: 'flex:none; display:inline-flex; gap:6px; align-items:baseline;' },
      m.shares_category ? el('span', { class: 'kn-chip', title: '프로젝트와 같은 분류', text: '📁 같은 분류' }) : null,
      pct > 0 ? el('span', { class: 'admin-hint', title: '의미 유사도(코사인)', text: pct + '%' }) : null) : null;
    const titleEl = isRec
      ? el('div', { class: 'row-title', style: 'display:flex; justify-content:space-between; gap:8px; align-items:baseline;' }, el('span', { text: m.title || m.name }), tags)
      : el('div', { class: 'row-title', text: m.title || m.name });
    return el('div', { class: 'ps-kn-pick-row' },
      el('a', { class: 'ps-kn-pick-main', href: '#/k/' + encodeURIComponent(m.name), target: '_blank', rel: 'noopener', title: '새 탭에서 지식 열기' }, titleEl,
        el('div', { class: 'admin-hint ps-kn-pick-snip', text: (m.snippet || '').slice(0, 90) })),
      addBtn);
  }

  async function loadRecs() {
    recHead.style.display = '';
    busy(results, el('span', { class: 'admin-hint', text: '추천을 불러오는 중…' }));
    let recs: any;
    try { recs = await api('/api/ui/v6/projects/' + id + '/recommend-knowledge?limit=10').then((d) => (d && d.entries) || []); }
    catch (e) { results.replaceChildren(errorNote(e, '추천을 불러오지 못했습니다')); return; }
    const cand = recs.filter((m) => !linked().has(m.name));
    if (!cand.length) {
      recHead.style.display = 'none';
      results.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '아직 추천할 지식이 없어요 — 위에서 제목·내용으로 검색하거나, 직접 작성해 보세요.' }));
      return;
    }
    results.replaceChildren(...cand.map((m) => pickRow(m, true)));
  }

  const runSearch = debounce(async () => {
    const q = searchIn.value.trim();
    if (!q) { loadRecs(); return; }  // 검색어 지우면 추천으로 복귀.
    recHead.style.display = 'none';
    busy(results, el('span', { class: 'admin-hint', text: '검색 중…' }));
    let matches: any;
    // 의미검색(하이브리드 RRF, #1133) — 자연어·다른 표현도 회수. 임베딩 off 환경은 서버가 grep 으로 폴백.
    try { matches = await api('/api/ui/knowledge/semantic?q=' + encodeURIComponent(q) + '&limit=20').then((d) => (d && d.entries) || []); }
    catch (e) { results.replaceChildren(errorNote(e, '검색하지 못했습니다')); return; }
    const cand = matches.filter((m) => !linked().has(m.name));
    if (!cand.length) { results.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '결과가 없거나 모두 이미 연결됨.' })); return; }
    results.replaceChildren(...cand.map((m) => pickRow(m, false)));
  }, 300);
  const rerender = () => { if (searchIn.value.trim()) runSearch(); else loadRecs(); };  // 관계 전환 시 현재 화면 기준 재필터(#1133)

  searchIn.addEventListener('input', runSearch);
  loadRecs();  // 열면 추천 먼저.
}

export { openKnowledgePicker };
