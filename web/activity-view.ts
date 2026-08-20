// activity-view.ts — 작업(activity) 표시 컴포넌트 3종의 소유 모듈(#1313 R49 에서 dashboard.ts 개명 —
//  '대시보드'라는 이름이 실체(작업 렌더러)와 어긋났고, 홈 대시보드인 dashboard-home.ts 와도 헷갈렸다).
//   · activityTimelineRow — 접힘/펼침 한 줄(목록용, 상세는 첫 펼침 때 lazy 생성)
//   · activityDetailView  — 유형 8종을 하나로 담는 상세 범용 템플릿(#852)
//   · activityHasDetail   — 펼칠 상세가 있는지의 단일 판정
//  소비자: 프로젝트 상세의 전체 작업 로그·작업 타임라인(projects/detail-sections.ts) ·
//   홈 대시보드의 팀 작업 로그 위젯(dash/widget-tasks-review-log.ts).
//  import 방향: core(프리미티브) ← 이 모듈. projects.ts 에서 fmtDateTime 하나를 되받는 역엣지가 남아 있다
//   (check-imports 의 ALLOWED_CYCLES 등재 — 그 심볼이 내려오면 사라진다). 새 역엣지를 늘리지 마라.
import { ACTIVITY_TYPE_LABEL, api, el, fmtNum, relTime, renderMarkdown, sv } from './core.js';
import { sessionTermUrl } from './lib/session-open.js';   // #1820 — 세션 주소는 한 곳에서만 만든다
import { fmtDateTime } from './projects.js';


// ════════════════════════════════════════════
// 유형별 점 색(스캔용 — §0.5: 채운 필 금지, 6px 점 + 무채 라벨). 성격축 8종(프로젝트 #182).
//  feature=민트, fix=코랄, decision=파랑, docs=틸, research=바이올렛, review=앰버, chore/other=중립.
const ACT_TYPE_TONE = { feature: 'mint', fix: 'coral', decision: 'blue', docs: 'teal', research: 'violet', review: 'amber', chore: 'muted', other: 'muted' };
function actTypeTag(type) {
  return el('span', { class: 'act-type tone-' + (ACT_TYPE_TONE[type] || 'muted') },
    el('span', { class: 'act-type-dot', 'aria-hidden': 'true' }),
    ACTIVITY_TYPE_LABEL[type] || type);
}

// 펼칠(=보여 줄) 상세가 있는가 — 행의 캐럿 표시와 팝업의 '내용 없음' 안내를 가르는 하나의 기준.
function activityHasDetail(a) {
  return !!((a.title && a.title !== (a.summary || '')) || a.body || (a.tasks && a.tasks.length) || (a.refs && a.refs.length)
    || a.commit_sha || a.touchCount || a.external_url || a.session_id
    || (a.is_review && a.is_review !== 'na') || (a.should_review && a.should_review !== 'na'));
}

// ── 연결 항목 아이콘 — 라인 1.7 단일 스타일(이모지 금지). 24 viewBox 를 17px 로 그린다. ──
//  종류를 아이콘으로도 말하는 이유: 예전엔 '만든 것 / 참고한 것' 아래 파란 링크만 줄줄이 있어
//  그게 지식인지 프로젝트인지 화면 어디에도 안 적혀 있었다(#1610 신고).
const ACT_LNK_ICON = {
  knowledge: ['M6.6 3.9h6.2l4.6 4.6v11.6H6.6z', 'M12.8 3.9v4.6h4.6', 'M9.1 13.3h6.1', 'M9.1 16.5h4'],
  project: ['M12 3.9a8.1 8.1 0 1 1 0 16.2 8.1 8.1 0 0 1 0-16.2z', 'M8.7 12.2l2.4 2.4 4.3-4.9'],
  code: ['M9.2 8.4 5.6 12l3.6 3.6', 'M14.8 8.4 18.4 12l-3.6 3.6', 'M13.3 6.7l-2.6 10.6'],
  session: ['M4.5 5.5h15v13h-15z', 'M8.1 10.2l2.6 2.3-2.6 2.3', 'M13.2 14.8h3.5'],
  external: ['M13.9 5.3h4.8v4.8', 'M18.7 5.3 11.4 12.6', 'M16.7 13.9v3.9a1.4 1.4 0 0 1-1.4 1.4H6.6a1.4 1.4 0 0 1-1.4-1.4V9.1a1.4 1.4 0 0 1 1.4-1.4h3.9'],
};
// 오른쪽 끝 어포던스 — 이 링크가 '새 탭에서 읽고 돌아오는 것(tab)'인지 '지금 화면을 옮기는 것(nav)'인지.
const ACT_GO_ICON = { tab: ['M6.6 13.4 13.4 6.6', 'M8.6 6.6h4.8v4.8'], nav: ['M5.2 10h9.6', 'M10.8 6l4 4-4 4'] };
function actGlyph(paths, box, size, cls) {
  return sv('svg', { class: cls, viewBox: '0 0 ' + box + ' ' + box, width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
    ...paths.map((d) => sv('path', { d, stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })));
}

// 위키 제목은 실측 평균 84자·최장 200자를 넘는다(#1600 — 요지 칸이 없어 제목이 요약문으로 부풀었다).
//  그 현실 위에서 읽히게 만든다: 제목 관례(`이름 — 부연 / 부연`)의 첫 구분자에서 갈라
//  앞은 이름(굵게·2줄), 뒤는 부연(회색·2줄)으로 내린다. 자를 데가 없으면 통째로 이름이다.
function splitRefTitle(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/\s[—–]\s|\s\/\s|\s-\s/);
  // 앞동강이 너무 짧으면(‘as-built(#1601):’ 류) 갈라 봐야 이름이 안 된다 — 그럴 땐 통째로 둔다.
  if (!m || m.index == null || m.index < 8) return { name: s, sub: '' };
  return { name: s.slice(0, m.index).trim(), sub: s.slice(m.index + m[0].length).trim() };
}

// 연결 항목 한 줄 — [종류 아이콘] [관계 라벨 / 이름 / 부연] [이동 어포던스].
//  href 가 없으면(코드 커밋) 링크가 아니라 정보 행이다.
function actLinkRow(icon, kind, name, sub, href?, newTab?) {
  const go = href ? actGlyph(ACT_GO_ICON[newTab ? 'tab' : 'nav'], 20, '14', 'act-lnk-go') : null;
  const attrs: any = { class: 'act-lnk' + (href ? '' : ' act-lnk-static') };
  // 이름·부연은 2줄에서 잘린다 — 전문을 툴팁으로 함께 준다(잘린 채로만 남지 않게).
  //  hover 전용 정보는 아니다: 링크를 열면 같은 내용을 제자리에서 다 읽는다.
  attrs.title = [kind, [name, sub].filter(Boolean).join(' — ')].join(': ');
  if (href) { attrs.href = href; if (newTab) { attrs.target = '_blank'; attrs.rel = 'noopener'; } }
  return el(href ? 'a' : 'div', attrs,
    el('span', { class: 'act-lnk-ico' }, actGlyph(ACT_LNK_ICON[icon], 24, '17', null)),
    el('span', { class: 'act-lnk-main' },
      el('span', { class: 'act-lnk-kind', text: kind }),
      el('span', { class: 'act-lnk-name' + (icon === 'code' ? ' mono' : ''), text: name }),
      sub ? el('span', { class: 'act-lnk-sub', text: sub }) : null),
    go);
}

// ── 작업(activity) 상세 — 하나의 범용 템플릿(#852). 목록의 인라인 펼침과 단건 팝업이 **같은 함수**를 쓴다. ──
//  왜: 유형(기능·수정·결정·문서·리서치·검토·운영·기타)이 8가지인데 기록의 재료는 늘 같다 —
//  그래서 유형별 특수 서식 대신, 사람이 읽는 글 하나의 구조로 모든 유형을 담는다:
//    머리(무슨 일인가·누가·언제) → 리드(기술 제목) → 본문 → 연결된 기록 → (인라인일 때) 정확한 시각
//
//  #1610 재설계 — 그전 판의 실패를 세 가지 고친다.
//   ① 위계가 없었다: 겉요약(15px)·기술제목(13px 굵게)·본문이 거의 같은 무게라 무엇이 제목인지 안 보였고,
//      기술제목이 더 길어 오히려 그쪽이 제목처럼 읽혔다 → 겉요약을 19px 제목으로 올리고 기술제목은
//      라벨 없는 리드 문단으로 내렸다(글의 구조: 제목 → 리드 → 본문).
//   ② 링크의 정체가 없었다: '만든 것/참고한 것' 아래 파란 제목만 나열돼 지식인지 프로젝트인지 몰랐고,
//      부풀어 있는 위키 제목이 통째로 박혀 파란 글자 벽이 됐다 → 종류를 말하는 라벨(‘만든 지식’)·아이콘·
//      이름/부연 분리·새 탭 여부 어포던스를 갖춘 한 벌의 연결 목록으로 통합.
//   ③ 터미널 세션 버튼이 제목과 본문 사이에 홀로 떠 있었다 → 버튼이 아니라 '연결된 기록'의 한 항목으로.
//  (body 는 마크다운이라 반드시 renderMarkdown — raw 로 박으면 '## …' 가 글자로 보인다.)
function activityDetailView(a, nameOf, opts?) {
  const when = a.committed_at || a.created_at;
  const box = el('div', { class: 'act-doc' });
  const headed = !!(opts && opts.head);

  // 바뀐 것 — '점검했으나 변화 없음'은 굳이 알릴 게 아니다. **바뀐 것만** 사람 말로.
  const changed: string[] = [];
  if (a.is_review === 'changed') changed.push('코드 구조가 바뀜');
  if (a.should_review === 'changed') changed.push('설계 의도가 바뀜');

  // 머리(팝업 전용) — 목록 행은 이미 자기 헤드가 있어 생략한다(변경 태그도 거기 이미 있다).
  if (headed) {
    box.append(el('div', { class: 'act-doc-head' },
      el('div', { class: 'act-doc-kicker' }, actTypeTag(a.type),
        ...changed.map((c) => el('span', { class: 'act-doc-tag', text: c }))),
      el('h3', { class: 'act-doc-title', text: a.summary || a.title || '(제목 없음)' }),
      el('div', { class: 'act-doc-by' },
        el('span', { class: 'act-doc-who', text: nameOf(a.author_person) || '미상' }),
        a.author_agent ? el('span', { class: 'act-doc-agent', text: a.author_agent }) : null,
        el('span', { class: 'act-doc-when', title: relTime(when), text: fmtDateTime(when) }))));
  }

  // 리드 + 본문 — 라벨을 없앴다. 제목 바로 아래 굵은 한 문단이 곧 '무엇을 했나'다.
  const readable = el('div', { class: 'act-doc-read' });
  if (a.title && a.title !== (a.summary || '')) {
    readable.append(el('p', { class: 'act-doc-lead', text: a.title }));
  }
  if (a.body) readable.append(el('div', { class: 'md-rendered act-doc-md' }, renderMarkdown(a.body)));
  if (readable.childNodes.length) box.append(readable);

  // 연결된 기록 — 지식·프로젝트·코드·세션·원본을 한 벌의 목록으로. 세션은 입장 가능할 때만
  //  비동기로 늦게 붙으므로(권한 판정이 서버에 있다) 섹션을 미리 만들어 두고 항목이 생길 때 연다.
  const lnks = el('div', { class: 'act-lnks' });
  const linkSec = el('div', { class: 'act-doc-sec', hidden: true },
    el('div', { class: 'act-doc-label', text: '연결된 기록' }), lnks);
  const addLink = (row) => { lnks.append(row); linkSec.hidden = false; };

  // 지식 — '읽고 돌아오는' 참조라 새 탭(#804·#811). 관계를 종류와 함께 말한다.
  const REL_TEXT = { produced: '만든 지식', references: '참고한 지식', decided: '결정한 지식' };
  for (const rel of ['produced', 'references', 'decided']) {
    for (const rf of (a.refs || []).filter((r) => r.relation === rel)) {
      const t = splitRefTitle(rf.title || rf.name);
      addLink(actLinkRow('knowledge', REL_TEXT[rel], t.name, t.sub, '#/k/' + encodeURIComponent(rf.name), true));
    }
  }
  // 프로젝트/태스크 — 참조가 아니라 이동이라 같은 탭.
  for (const t of (a.tasks || [])) {
    const s = splitRefTitle(t.title || ('#' + t.id));
    addLink(actLinkRow('project', t.level === 'project' ? '진척시킨 프로젝트' : '진척시킨 태스크',
      s.name, s.sub, '#/projects2/p/' + t.id, false));
  }
  // 코드 — 갈 곳이 없는 사실이라 링크가 아니다.
  if (a.commit_sha) {
    addLink(actLinkRow('code', '코드 커밋', [a.repo, a.commit_sha.slice(0, 7)].filter(Boolean).join(' · '),
      a.touchCount ? '코드 ' + fmtNum(a.touchCount) + '곳을 건드렸습니다.' : ''));
  }
  box.append(linkSec);
  attachSessionLink(addLink, a.session_id);
  if (a.external_url) {
    addLink(actLinkRow('external', '외부 원본', a.external_url, '', a.external_url, true));
  }

  // 인라인 펼침에는 머리가 없다 — 정확한 시각을 여기서 알린다(행에는 상대시간만 있다).
  if (!headed) box.append(el('div', { class: 'act-doc-foot', text: fmtDateTime(when) }));
  return box;
}

// 이 작업이 실행된 터미널 세션(#852) — '연결된 기록'의 한 항목으로 붙인다. 판정은 서버에 맡긴다:
//  GET /terminal/sessions/:id 는 canAttach(소유자·초대된 멤버, 프로젝트 폴더 세션은 로그인한 전원 #452)를
//  통과해야 200 을 준다. 그래서 **비공개 세션이면 403, 이미 끝난 세션이면 404/403** → 항목을 아예 안 붙인다.
//  (세션 목록 API 는 프로젝트 세션을 일부러 빼고 주므로 목록으로 판정하면 안 된다 — src/terminal/routes.ts:128.)
//  상세(1건)에서만 부르므로 목록 N+1 이 없다.
async function attachSessionLink(addLink, sessionId) {
  if (!sessionId) return;
  let s: any;
  try { s = await api('/api/ui/terminal/sessions/' + encodeURIComponent(sessionId)); }
  catch { return; }   // 비공개(403) 또는 종료됨 → 들어갈 수 없으니 항목 없음
  if (!s || !s.id) return;
  const url = sessionTermUrl(s.id, { label: s.label });
  addLink(actLinkRow('session', '이 작업을 한 AI 세션', s.label || s.id, '새 탭에서 세션에 들어갑니다.', url, true));
}

// 작업(activity) 한 줄 — 회사 전체 타임라인(#/projects2)·작업 현황(#/dash) 공용.
//  접힘: 캐럿 + 유형칩 + 요약(굵게) / 사람·AI·상대시간(+ 구조·의도 변경 태그).
//  펼침(클릭): activityDetailView — 단건 팝업과 같은 범용 템플릿. 처음 펼칠 때 한 번만 만든다(lazy) —
//   목록이 수백 행이라 안 볼 상세의 마크다운까지 미리 렌더하면 무겁다.
function activityTimelineRow(a, nameOf) {
  const when = a.committed_at || a.created_at;
  const hasDetail = activityHasDetail(a);

  const caret = el('span', { class: 'act-row-caret' + (hasDetail ? '' : ' act-row-caret-empty'), 'aria-hidden': 'true', text: hasDetail ? '▸' : '' });

  // 변경 태그 — 이번 작업이 코드구조(is)/도메인 의도(should)를 바꾼 경우만 작게 표기.
  const tags: any[] = [];
  if (a.is_review === 'changed') tags.push(el('span', { class: 'act-row-tag', text: '구조 변경' }));
  if (a.should_review === 'changed') tags.push(el('span', { class: 'act-row-tag', text: '의도 변경' }));

  const head = el('div', { class: 'act-row-head',
    role: hasDetail ? 'button' : null, tabindex: hasDetail ? '0' : null, 'aria-expanded': hasDetail ? 'false' : null },
    caret,
    actTypeTag(a.type),
    el('div', { class: 'act-row-body' },
      el('div', { class: 'act-row-title', text: a.summary || a.title || '(제목 없음)' }),
      el('div', { class: 'act-row-meta' },
        el('span', { class: 'act-row-who', text: nameOf(a.author_person) }),
        a.author_agent ? el('span', { class: 'act-row-agent', text: ' · ' + a.author_agent }) : null,
        el('span', { class: 'act-row-time', text: ' · ' + relTime(when) }),
        ...tags)));

  const row = el('div', { class: 'act-row' + (hasDetail ? ' act-row-expandable' : '') }, head);
  if (!hasDetail) return row;

  const detail = el('div', { class: 'act-row-detail', hidden: true });
  let built = false;
  let open = false;
  const toggle = () => {
    if (!built) { built = true; detail.append(activityDetailView(a, nameOf)); }
    open = !open; detail.hidden = !open; row.classList.toggle('open', open);
    caret.textContent = open ? '▾' : '▸';
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
  row.append(detail);
  return row;
}

// ════════════════════════════════════════════

export {
  activityDetailView,
  activityHasDetail,
  activityTimelineRow,
};
