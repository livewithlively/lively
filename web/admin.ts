// admin.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { absTime, api, applyReveal, el, errorNote, fmtNum, logout, memberCombo, pageHead, profileAvatar, relTime, renderMarkdown, setPersonAvatar, state, toast } from './core.js';
import { SPACE_SUBS, openCategoryForm } from './knowledge.js';
import { overlayBox, skeleton } from './learn.js';


// ════════════════════════════════════════════════════════════════════
// 관리(전달/관리 — workflow-std 흡수). 핵심 원칙: 비개발자가 편집/확인하는 모든 항목 옆에
// '구성원에게 미치는 효과'를 항상 보여준다(meaning 패널). 셸/디자인/라우터는 기존 재사용.
// ════════════════════════════════════════════════════════════════════
// 관리 중분류(가로 탭, 2026-06-20) — 비개발자가 섹션에서 길잃지 않게 3분류로 묶는다.
//  ① 기본 설정: 접속·구성원·토큰(굴러가게 하는 기본기) ② 회사·조직: 규칙·맥락·메모리·용어(AI에 가르치는 내용)
//  ③ AI 동작·연결(고급): 훅·도구·MCP·DB(AI가 실제 어떻게 동작/어떤 데이터에 닿나).
//  '지식 종류 레지스트리'·'설치'는 관리에서 빼 #/learn(가이드)로 이관 — 전자=용어설명, 후자=구성원 셋업.
const ADMIN_GROUPS = [
  { key: 'basic', label: '기본 설정' },
  { key: 'access', label: '조직·권한 설정' },
  { key: 'wiki', label: '분류 체계 관리' },
  { key: 'knowledge', label: '맥락·세션 주입' },
  { key: 'ai', label: '연결·데이터 (고급)' },
];
const ADMIN_SECTIONS = [
  // ① 기본 설정 — 한 번 세팅하면 굴러가는 조직 기본 정보(이름·서버 주소).
  { key: 'profile', label: '조직 기본 정보', meaning: 'gateway-url', group: 'basic' },
  // ② 조직·권한 설정 — 누가 함께 쓰나(구성원·팀) + 접속 권한.
  { key: 'members', label: '구성원 관리', meaning: 'member', group: 'access' },
  // 팀(스쿼드/사일로) 관리 — 구성원을 팀으로 묶고, 팀이 카테고리를 '소유'(오너십 배정은 분류체계관리에서). 팀 소유 = 표면화·주입의 '우리 팀' 기준.
  { key: 'teams', label: '팀 관리', meaning: 'team', group: 'access' },
  { key: 'member-add', label: '구성원 추가', meaning: 'member', group: 'access' },
  { key: 'tokens', label: '구성원 토큰 관리', meaning: null, group: 'access' },
  // 중앙박스 계정(프로필) — 멤버별 다른 Claude Code 계정(멀티프로필 #346/#442). config·MCP·훅은 여기서 설치, 로그인은 멤버가 웹터미널에서.
  { key: 'profiles', label: '중앙박스 계정(프로필)', meaning: null, group: 'access' },
  // ②-B WIKI 카테고리 관리 — 지식(위키)의 분류축(사업·제품·시스템 카테고리) CRUD. 제품 카테고리=도메인.
  //  카테고리 탭(#/categories)과 같은 category-store(/api/ui/categories) — 여기 수정이 지식·프로젝트 탭 좌측에 반영.
  { key: 'wiki-categories', label: '카테고리 설정', meaning: null, group: 'wiki' },
  // ③ 맥락·세션 주입 — AI가 매 세션 무엇을 언제 주입받나(단일 지도). nav 엔 '세션 주입 지도'(injection-map) 한 화면만.
  //  항상-주입 섹션 문서(injection=always)는 지도에서 직접 추가/편집/삭제/재정렬한다(#335). 구 #/system/<section> 라우트·SECTION_REMAP 흡수는 호환용 잔존.
  //  WIKI 인덱스는 WIKI 탭, 주제 분류는 '카테고리 설정'으로 일원화(2026-06-24).
  { key: 'injection-map', label: '세션 주입 지도', meaning: null, group: 'knowledge' },
  // ④ 연결·데이터 (고급) — AI가 무엇에 닿나(도구·MCP·DB·레포) + 외부 호출/DB 안전범위 + 커스텀 훅(코드).
  //  훅 개요·런타임 토글·주입 미리보기는 '세션 주입 지도'로 흡수(2026-06-26). 여기엔 연결/데이터/안전범위와 코드 훅만 남는다.
  { key: 'tools', label: 'AI 도구(MCP)', meaning: 'tool', group: 'ai' },
  // MCP 호출 통계(#318) — 하네스가 어떤 MCP 툴을 어떤 인자로 어느 빈도로 호출했는지(mcp_call_log 집계). 읽기 전용 대시보드(admin).
  { key: 'tool-usage', label: 'MCP 호출 통계', meaning: null, group: 'ai' },
  // 조직 변경 감사(#549) — 관리 항목이 누구(사람/AI)에 의해 어떤 경로(웹/MCP)로 언제 바뀌었나. 읽기 전용(admin).
  { key: 'org-audit', label: '변경 감사 로그', meaning: null, group: 'ai' },
  { key: 'mcp', label: 'MCP 서버', meaning: 'mcp', group: 'ai' },
  { key: 'db-sources', label: 'DB 데이터소스', meaning: 'db-source', group: 'ai' },
  // 임베딩(벡터검색 #172) — 의미검색/유사도의 벡터 provider 토글 + 기존 지식 백필. admin 전용(인프라 설정).
  { key: 'embeddings', label: '임베딩(벡터검색)', meaning: null, group: 'ai' },
  // 커넥터(외부 소스) 설정·토큰 — slack/notion/clickup/gmail/drive 별 자격·설정. secrets 암호화 저장(#541).
  { key: 'connectors', label: '커넥터(외부 소스)', meaning: null, group: 'ai' },
  // 인입 허용선 게이트(#638) — 자동 인입(미러/distill)을 auto/confirm/drop 로 조절 + 검토 큐(pending 승인).
  { key: 'ingest-policy', label: '인입 허용선 (게이트)', meaning: null, group: 'ai' },
  { key: 'review-queue', label: '검토 큐 (자동 인입)', meaning: null, group: 'ai' },
  // 레포(git) 관리 — repo 테이블(=실제 git 레포) 등록·git 연결. 도메인맵 스캔 + 로컬 작업 클론의 단일 소스.
  { key: 'repos', label: '레포(git) 관리', meaning: null, group: 'ai' },
  // 스케줄러(자동화) — org_cron 잡. is 신선화(refresh)·미매핑 코드 LLM 분류(map_unmapped, 상시 세션에 주입)·sync 를 주기 실행. admin 전용.
  { key: 'cron', label: '스케줄러 (자동화)', meaning: null, group: 'ai' },
  // 상시 세션(에이전트) — 항상 떠있는 에이전트 세션 CRUD + 격리 워크스페이스 + keep-alive. 크론이 타깃. admin 전용.
  { key: 'managed-sessions', label: '상시 세션 (에이전트)', meaning: null, group: 'ai' },
  // (외부 호출·DB 안전범위 = allowlist 별도 탭 폐기(2026-06-26) → 'AI 도구'·'DB 데이터소스' 화면 안 allowlistCard 로 인라인.)
  // 커스텀 훅(코드) — 특정 이벤트에 실행할 임의 코드. 세션 주입 지도에서 목록·요약을 보고 여기서 정의.
  { key: 'custom-hooks', label: '커스텀 훅 (코드)', meaning: 'custom-hook', group: 'ai' },
  // 하네스 자산(스킬·서브에이전트·슬래시커맨드) — 관리자가 정의해 구성원 하네스에 배포. 훅과 같은 runtime 자산군이나
  //  멤버 디스크(~/.claude|.codex/{skills,agents,commands})에 materialize(하네스가 스캔해야 발견). 위험 통제=짝훅.
  { key: 'harness-assets', label: '스킬·에이전트·커맨드', meaning: 'harness-asset', group: 'ai' },
];
// 구 URL(흡수된 섹션) → 새 섹션 리맵. 북마크·내부 링크 graceful 처리.
// 흡수·폐기된 구 섹션 URL → 새 위치. org-defaults·guide 는 nav 에서 빠졌지만(모달 편집) 직접 URL 은 지도로 보낸다.
const SECTION_REMAP = { 'hooks-group': 'injection-map', 'hooks-preview': 'injection-map', 'runtime': 'injection-map', 'safety': 'tools', 'org-defaults': 'injection-map', 'context-ontology-guide': 'injection-map' };
const ADMIN_ONLY = ['member-add', 'tokens', 'profiles', 'mcp', 'db-sources', 'embeddings', 'connectors', 'cron', 'managed-sessions', 'tool-usage', 'org-audit', 'ingest-policy', 'review-queue']; // admin 권한 전용(쓰기/인프라 · #318 호출통계·#549 변경감사는 전 구성원 변경·before/after 노출이라 admin · #548 embeddings · #638 인입정책=오너 조절, 검토 큐 웹 탭은 MVP admin — 승인 백엔드는 memory scope 라 워킹레벨 MCP/REST 검토는 열림)
const RUNTIME_ONLY = ['custom-hooks', 'harness-assets', 'tools']; // runtime 권한 전용(멤버 머신 실행물 정의)
// V4-P5/J: 어휘(도메인·레포·기능) CRUD = context 스코프(admin 완화). 도메인맵 CRUD 엔드포인트가 scope:'context'
//  이므로 context 권한자면 편집 가능 — admin 전용 잠금 해제. context 없는 사용자는 읽기 전용(섹션 자체는 노출).
const CONTEXT_EDIT = ['wiki-categories', 'repos', 'teams']; // context 스코프면 편집 가능(없으면 읽기 전용으로 표시)
// 컨텍스트 온톨로지 가이드 섹션 — 매 대화에 깔리는 지식 인덱스 전체 템플릿. 잘못 바꾸면 모든 AI 동작이 망가질 수 있어 경고+되돌리기를 단다.
const SCAFFOLD_SECTIONS = ['context-ontology-guide'];
// 플레이스홀더 안내 — 편집창에 보여줄 자동주입 토큰 설명.
const GUIDE_PLACEHOLDER_HINT = '이 글이 매 대화 첫머리의 “지식 인덱스”로 그대로 들어가요. 본문 안의 자리표시자 3개가 실제 데이터로 자동 채워집니다(그 자리에 두세요) — ${rules}=항상-주입 지식(injection=always), ${categories}=카테고리(주제) 지도, ${wiki}=WIKI 인덱스 핀.';
// 비개발자용 경고 — '이게 무엇인지' 한 줄 + 공통 위험 안내(아래 sectionEditor 가 .admin-warn 으로 렌더).
const SCAFFOLD_WARN = {
  'context-ontology-guide': '이 글은 AI에게 "공유 지식이 무엇이고, 주제로 어떻게 찾고, 알게 된 걸 어디에 기록할지"를 알려주는 인덱스 전체 틀이에요.',
};
const SCAFFOLD_WARN_COMMON = '⚠️ 이건 모든 구성원의 AI가 지식을 정리·검색·기록하는 방식의 뼈대예요. 잘못 바꾸면 AI가 지식을 엉뚱하게 다루거나 못 찾을 수 있어요(특히 ${categories} 를 지우면 주제 목록이, ${rules} 를 지우면 항상-주입 규칙·지식이, ${wiki} 를 지우면 핀 인덱스가 사라져요). 평소엔 그대로 두는 게 안전하고, 꼭 바꿔야 하면 뜻을 정확히 아는 사람만 고치세요. 언제든 [기본값으로 되돌리기]로 원래대로 복구할 수 있어요.';
function sectionHidden(key, data) {
  if (ADMIN_ONLY.includes(key) && !data.canEdit) return true;
  if (RUNTIME_ONLY.includes(key) && !data.canRuntime) return true;
  return false;
}
// 현재 토큰이 가진 scope 보유 여부(/api/ui/me 의 scopes). 어휘 CRUD 권한(context) 판정에 쓴다.
function hasScope(s) {
  return !!(state.me && Array.isArray(state.me.scopes) && state.me.scopes.includes(s));
}

async function loadAdmin(force?) {
  if (!state.admin.data || force) state.admin.data = await api('/api/ui/org');
  return state.admin.data;
}

function meaningRow(k, v) {
  return el('div', { class: 'meaning-row' },
    el('span', { class: 'meaning-k', text: k }),
    el('span', { class: 'meaning-v', text: v }));
}
// 비개발자용 카드 카피 — 서버 MEANING(기술적·장황) 위에 클라에서 덮어쓴다(즉시 반복, 서버 재시작 불요).
//  키 = 섹션 meaning 키. 없는 키(고급 훅·MCP·DB·툴 등)는 서버 카피로 폴백.
const MEANING_KO = {
  'org-defaults': {
    label: '회사 소개·규칙·AI 성격',
    what: '회사가 어떤 곳인지, AI가 무조건 지킬 규칙, 어떤 성격·말투로 일하는지, 우리 팀이 일하는 방식이에요. (구 ‘AI 필수 규칙’이 여기로 합쳐졌어요.)',
    reach: '모든 구성원과 그들이 쓰는 AI',
    when: '대화를 시작할 때 가장 먼저 자동으로 깔려요',
    where: 'AI가 답할 때 바탕에 깔리는 기본 규칙·분위기예요',
    example: "'고객 개인정보는 절대 보여주지 않기', '근거 없이 단정하지 않기'를 넣으면, 그때부터 모두의 AI가 그렇게 해요.",
  },
  'memory': {
    label: 'WIKI 인덱스',
    what: '팀이 함께 쌓는 위키(지식)예요. AI가 필요할 때 꺼내 봅니다. 📌 핀한 항목은 제목·분류가 매 대화 첫머리에 깔려요.',
    reach: '모든 구성원과 그들이 쓰는 AI',
    when: '제목은 늘 보이고, 자세한 내용은 AI가 필요할 때 찾아봐요',
    where: "AI가 '우리 팀이 전에 이렇게 정했지'를 떠올려야 할 때 참고해요",
    example: '새로 내린 결정을 메모로 올리면, 모두의 AI가 그 결정을 알고 일관되게 답해요.',
  },
  'member': {
    label: '구성원 정보',
    what: '한 사람(또는 AI·시스템)이 누구인지, 어떤 계정(이메일·슬랙 등)을 쓰는지예요.',
    reach: '그 사람 + 전체 검색·연결',
    when: '저장하면 바로 반영돼요',
    where: "AI가 사람을 찾거나 '담당자에게 맡기기' 할 때 쓰는 정보예요",
    example: '어떤 사람의 슬랙 계정을 연결하면, AI가 그 사람의 슬랙 활동을 한 사람으로 묶어 봐요.',
  },
  'team': {
    label: '팀',
    what: '구성원을 팀(스쿼드)으로 묶고, 팀이 어떤 카테고리(도메인·주제)를 맡는지 정해요. 오너십은 권한 차단이 아니라 우선순위예요.',
    reach: '팀원과 그들이 쓰는 AI',
    when: '팀/오너십을 바꾸면 다음 세션부터 반영돼요',
    where: "프로젝트·위키 탭에서 '우리 팀' 카테고리가 먼저 보이고, AI 세션 첫머리에 '우리 팀' 맥락이 우선 주입돼요",
    example: "어떤 팀이 'agent-gateway' 카테고리를 소유하면, 그 팀원의 화면·AI에 그 도메인의 지식·프로젝트가 먼저 떠요. (다른 팀 맥락도 여전히 다 볼 수 있어요.)",
  },
  'gateway-url': {
    label: '서버 주소',
    what: '구성원의 AI가 실시간 현황을 받아오는 우리 회사 서버 주소예요.',
    reach: '모든 구성원의 AI',
    when: '구성원이 다시 설치한 다음부터 새 주소를 써요',
    where: "대화 첫머리의 '실시간 현황'을 어디서 가져올지 정해요",
    example: '서버를 옮겨 주소를 바꾸면, 재설치 후부터 새 주소에서 현황을 받아요. (연결이 안 되면 기본 내용만 보여서 안전해요.)',
  },
  'display_name': {
    label: '조직 이름',
    what: '이 팀(조직)의 이름이에요.',
    reach: '모든 구성원과 그들이 쓰는 AI',
    when: '구성원이 다시 설치한 다음부터 반영돼요',
    where: '대화 맨 앞 머리말과 현황 제목에 나와요',
    example: '이름을 바꾸면 모두의 대화 머리말이 그 이름으로 바뀌어요.',
  },
};
function meaningOf(m) { return (m && MEANING_KO[m.key]) ? { ...m, ...MEANING_KO[m.key] } : m; }

// '이게 뭐예요?' — 기본은 화면에 설명을 깔지 않고 작은 트리거 하나만 둔다. 궁금한 사람이 누르면
//  팝업(overlay)으로 전체 설명(요약·누가/언제/어디·예시)을 보여준다. 예전엔 항상-펼침(이후 한 줄 요약+토글)
//  이라 9개 섹션마다 같은 골격이 반복돼 화면이 무거웠다(윤상민 06-22 지적: "반복·둥둥 뜸"). 단일 함수라
//  모든 섹션에 일괄 적용. tone 색·카피는 팝업 안에서 그대로 보존.
function meaningCard(m0) {
  if (!m0) return null;
  const m = meaningOf(m0);
  const tag = { critical: '꼭 지킴', identity: '신원', infra: '연결', normal: '' }[m.tone] || '';
  const trigger = el('button', { class: 'meaning-trigger', type: 'button', 'aria-haspopup': 'dialog' },
    el('span', { class: 'meaning-trigger-icon', 'aria-hidden': 'true', text: 'ⓘ' }),
    el('span', { text: '이게 뭐예요?' }));
  trigger.addEventListener('click', () => {
    overlay(m.label || '이게 뭐예요?',
      el('div', { class: 'meaning meaning-' + m.tone + ' meaning-pop' },
        el('div', { class: 'meaning-head' },
          el('span', { class: 'meaning-dot', 'aria-hidden': 'true' }),
          el('span', { class: 'meaning-title', text: '구성원에게 미치는 효과' }),
          tag ? el('span', { class: 'meaning-tag', text: tag }) : null),
        el('p', { class: 'meaning-what', text: m.what }),
        el('div', { class: 'meaning-grid' },
          meaningRow('누가 보나', m.reach),
          meaningRow('언제 적용되나', m.when),
          meaningRow('어디에 쓰이나', m.where)),
        el('div', { class: 'meaning-ex' },
          el('span', { class: 'meaning-ex-label', text: '예를 들면' }),
          el('span', { text: m.example }))));
  });
  return trigger;
}

// 섹션 제목 + 바로 옆 '이게 뭐예요?' 트리거(meaningCard 가 트리거 노드를 돌려준다). 제목 우측에 밋밋하게 붙는다.
function sectionTitle(titleText, m) {
  return el('div', { class: 'section-title' }, el('h2', { text: titleText }), meaningCard(m));
}

// System 탭 진입점(#/system) — 기존 관리(전달) 화면을 그대로 흡수 + 지식 종류 레지스트리.
async function renderSystem(view, sub) {
  return renderAdmin(view, sub);
}

async function renderAdmin(view, sub) {
  let data: any;
  try { data = await loadAdmin(); }
  catch (e) { view.replaceChildren(errorNote(e, '관리 데이터를 불러오지 못했습니다')); return; }
  const canEdit = !!data.canEdit;
  state.admin.canEdit = canEdit;
  state.admin.canRuntime = !!data.canRuntime;
  // 어휘 CRUD 권한 — 정확히 context 스코프(admin 완화). 서버 도메인맵 CRUD 게이트가 scope:'context' 를
  //  엄격히 요구하므로(admin 자동 함의 없음 — web.ts mw), 버튼 노출도 context 보유로만 판정해 403 오작동을 막는다.
  state.admin.canContext = hasScope('context');

  // 선택 섹션 — 없거나 권한으로 숨으면 첫 노출 섹션으로(과거 디폴트 'kinds'는 가이드로 이관돼 제거).
  const visibleSections = ADMIN_SECTIONS.filter((s) => !sectionHidden(s.key, data));
  let sel = sub || state.admin.sel;
  if (sel && SECTION_REMAP[sel]) sel = SECTION_REMAP[sel]; // 흡수된 구 섹션 URL → 새 섹션
  if (!sel || !visibleSections.some((s) => s.key === sel)) sel = (visibleSections[0] || ADMIN_SECTIONS[0]).key;
  state.admin.sel = sel;
  // 활성 중분류 = 선택 섹션이 속한 그룹(URL/선택이 단일 진실 — 별도 상태 불필요).
  const activeGroup = (ADMIN_SECTIONS.find((s) => s.key === sel) || ADMIN_SECTIONS[0]).group;

  // ── 가로 중분류 바 — 클릭 시 그 분류의 첫 노출 섹션으로 이동. 권한으로 그룹 전체가 숨으면 탭도 숨김. ──
  const groupBar = el('div', { class: 'admin-cats', role: 'tablist', 'aria-label': '관리 중분류' });
  for (const g of ADMIN_GROUPS) {
    const first = visibleSections.find((s) => s.group === g.key);
    if (!first) continue;
    const on = g.key === activeGroup;
    groupBar.append(el('a', { class: 'admin-cat' + (on ? ' active' : ''), href: '#/system/' + first.key,
      role: 'tab', 'aria-selected': on ? 'true' : 'false', text: g.label }));
  }

  // 활성 중분류에 실제로 보이는 섹션 — 1개뿐이면 좌측 섹션 nav 가 무의미하므로 생략하고 본문을 전폭으로.
  //  (예: '분류 체계 관리'=카테고리 설정 1개, '기본 설정'=조직 기본 정보 1개.)
  const groupSections = visibleSections.filter((s) => s.group === activeGroup);
  const soloSection = groupSections.length <= 1;

  const list = el('div', { class: 'split-list card admin-nav' });
  for (const s of ADMIN_SECTIONS) {
    if (s.group !== activeGroup) continue; // 활성 중분류 섹션만 좌측 nav 에.
    if (sectionHidden(s.key, data)) continue;
    // 회색 부제(row-meta) 제거 — 라벨만 노출(#613 후속, 장원준 피드백: 모든 탭의 회색 부제가 어색).
    list.append(el('a', { class: 'row' + (s.key === sel ? ' sel' : ''), href: '#/system/' + s.key },
      el('div', { class: 'row-title', text: s.label })));
  }
  const detail = el('div', { class: soloSection ? 'admin-solo-detail' : 'split-detail' });
  renderAdminDetail(detail, sel, data);

  // 섹션 1개 그룹은 좌측 nav 없이 본문만, 여러 개면 좌 nav + 본문 split.
  const body = soloSection ? detail : el('div', { class: 'split admin-split' }, list, detail);

  // 상태 배지(조직명 / 읽기 전용) — 통일 헤더의 우측 액션 자리로. (#367)
  const statusEl = canEdit
    ? el('span', { class: 'admin-sub', text: (data.profile.display_name || '조직') })
    : el('span', { class: 'admin-sub' }, el('span', { class: 'pill', text: '읽기 전용' }), ' ' + (data.profile.display_name || '조직') + ' · 보기 전용(편집은 관리자)');
  view.replaceChildren(el('div', {},
    pageHead('관리', '조직·권한, 분류 체계, 연결·데이터 등 시스템 전반을 설정합니다.', [statusEl], '리'),
    groupBar,
    body));
  applyReveal(soloSection ? [detail] : [list, detail]);
}

function renderAdminDetail(detail, sel, data) {
  if (sel === 'wiki-categories') return wikiCategoriesPanel(detail, data);
  if (sel === 'org-defaults' || SCAFFOLD_SECTIONS.includes(sel)) return sectionEditor(detail, sel, data);
  if (sel === 'members') return membersEditor(detail, data);
  if (sel === 'teams') return teamsPanel(detail, data);
  if (sel === 'member-add') return memberAddPanel(detail, data);
  if (sel === 'tokens') return tokensPanel(detail, data);
  if (sel === 'profiles') return profilesEditor(detail);
  if (sel === 'profile') return profileEditor(detail, data);
  if (sel === 'injection-map') return injectionMap(detail, data);
  if (sel === 'custom-hooks') return customHookEditor(detail, data);
  if (sel === 'harness-assets') return harnessAssetEditor(detail, data);
  if (sel === 'tools') return toolsEditor(detail, data);
  if (sel === 'tool-usage') return toolUsagePanel(detail);
  if (sel === 'org-audit') return orgAuditPanel(detail);
  if (sel === 'mcp') return mcpEditor(detail, data);
  if (sel === 'connectors') return connectorEditor(detail, data);
  if (sel === 'db-sources') return dbSourceEditor(detail, data);
  if (sel === 'embeddings') return embeddingsEditor(detail, data);
  if (sel === 'repos') return reposPanel(detail, data);
  if (sel === 'cron') return cronPanel(detail, data);
  if (sel === 'ingest-policy') return ingestPolicyPanel(detail, data);
  if (sel === 'review-queue') return reviewQueuePanel(detail, data);
  if (sel === 'managed-sessions') return managedSessionsPanel(detail, data);
  if (sel === 'deploy') return deployPanel(detail, data);
}

// ════════ MCP 호출 통계(#318) — 하네스가 어떤 MCP 툴을 어떤 인자로 어느 빈도로 호출했는지 ════════
//  읽기 전용 대시보드(admin). 백엔드=/api/ui/tool-usage(src/capabilities/tool-usage.ts → mcp_call_log 집계).
//  "직접/LLM 쿼리"는 db_query 로 mcp_call_log 를 SELECT(이 화면=사람용 집계 편의 표면). 새 서브탭일 뿐 기존 도구 화면 불변.
const TOOL_USAGE_STATE = { window: '7d', harness: '', tool: '', errorsOnly: false, page: 1 };
const TU_WINDOW_LABELS = { '1h': '최근 1시간', '24h': '최근 24시간', '7d': '최근 7일', '30d': '최근 30일', '90d': '최근 90일', 'all': '전체 기간' };

// 스타일 1회 주입(테마 토큰 사용 → 라이트/다크 자동 적응). innerHTML 없음 — textContent 로만 CSS 삽입(보안 불변식 준수).
function tuEnsureStyles() {
  if (document.getElementById('tu-styles')) return;
  document.head.appendChild(el('style', { id: 'tu-styles', text: `
.tu-controls{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;margin:2px 0 18px}
.tu-field{display:flex;flex-direction:column;gap:4px}
.tu-field>label{font-size:11px;font-weight:700;color:var(--muted)}
.tu-sel,.tu-inp{padding:6px 9px;font:inherit;color:var(--ink);border:1px solid var(--line);border-radius:7px;background:var(--bg)}
.tu-stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.tu-stat{flex:1 1 120px;min-width:104px;padding:12px 14px;border:1px solid var(--line);border-radius:11px;background:var(--bg-tint)}
.tu-stat b{display:block;font-size:23px;font-weight:800;line-height:1.15;color:var(--ink);font-variant-numeric:tabular-nums}
.tu-stat span{font-size:11.5px;color:var(--ink-sub)}
.tu-stat.tu-bad b{color:var(--coral)}
.tu-sub{font-weight:800;font-size:13px;color:var(--ink);margin:22px 0 9px}
.tu-days{display:flex;align-items:flex-end;gap:4px;height:72px;padding:6px 2px 0;border-bottom:1px solid var(--line)}
.tu-day{flex:1 1 0;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;min-width:6px}
.tu-day i{width:100%;max-width:28px;background:var(--blue);border-radius:3px 3px 0 0;min-height:2px;display:block}
.tu-day i.tu-allerr{background:var(--coral)}
.tu-daylabels{display:flex;gap:4px;margin-top:5px}
.tu-daylabels span{flex:1 1 0;text-align:center;font-size:9.5px;color:var(--muted);min-width:6px;overflow:hidden}
.tu-table{width:100%;border-collapse:collapse;font-size:13px}
.tu-table th{text-align:left;padding:6px 9px;font-size:11px;font-weight:700;color:var(--muted);border-bottom:1px solid var(--line)}
.tu-table th.tu-num{text-align:right}
.tu-table td{padding:6px 9px;border-bottom:1px solid var(--line);color:var(--ink)}
.tu-table td.tu-num{text-align:right;font-variant-numeric:tabular-nums;color:var(--ink-sub);white-space:nowrap}
.tu-table tr:hover td{background:var(--bg-tint)}
.tu-namecell{position:relative;min-width:170px}
.tu-bar{position:absolute;left:0;top:4px;bottom:4px;background:var(--bg-tint-2);border-radius:4px;z-index:0}
.tu-namecell .tu-name{position:relative;z-index:1}
.tu-harness{display:flex;gap:8px;flex-wrap:wrap}
.tu-chip{display:inline-flex;align-items:center;gap:7px;padding:5px 12px;border:1px solid var(--line);border-radius:999px;font-size:12px;color:var(--ink);background:var(--bg-tint)}
.tu-chip b{font-variant-numeric:tabular-nums}
.tu-chip em{color:var(--coral);font-style:normal;font-size:11px}
.tu-calls{margin-top:4px}
.tu-call{border-bottom:1px solid var(--line);padding:7px 4px}
.tu-call>summary{display:flex;gap:11px;align-items:center;cursor:pointer;list-style:none}
.tu-call>summary::-webkit-details-marker{display:none}
.tu-call>summary:hover{background:var(--bg-tint)}
.tu-ctime{color:var(--muted);font-size:11.5px;min-width:64px}
.tu-cactor{color:var(--ink-sub);font-size:12px;margin-left:auto}
.tu-cdur{color:var(--muted);font-size:11.5px;font-variant-numeric:tabular-nums}
.tu-cbad{color:var(--coral);font-size:11px;font-weight:700}
.tu-args{background:var(--bg-tint);border:1px solid var(--line);padding:9px 11px;border-radius:7px;font-size:12px;line-height:1.5;color:var(--ink);overflow:auto;max-height:340px;white-space:pre-wrap;word-break:break-word;margin:7px 0 2px}
.tu-empty{color:var(--muted);font-size:13px;padding:18px 4px}
.tu-pager{display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin-top:14px}
.tu-pg{min-width:30px;height:30px;padding:0 9px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);font:inherit;font-size:12.5px;cursor:pointer;font-variant-numeric:tabular-nums}
.tu-pg:hover{background:var(--bg-tint)}
.tu-pg-on{background:var(--blue);border-color:var(--blue);color:#fff;cursor:default}
.tu-pg-off{opacity:.38;cursor:default}
.tu-pg-gap{color:var(--muted);padding:0 2px}
.tu-pg-info{color:var(--muted);font-size:11.5px;margin-left:8px}
` }));
}

function tuPretty(v) {
  if (v == null) return '{}';
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

// 번호 페이지네이션용 페이지 목록(생략 …). 적으면 전부, 많으면 1 … cur-1 cur cur+1 … total.
function tuPageNumbers(cur, total) {
  if (total <= 7) { const a: any[] = []; for (let i = 1; i <= total; i++) a.push(i); return a; }
  const out: any[] = [1];
  const lo = Math.max(2, cur - 1); const hi = Math.min(total - 1, cur + 1);
  if (lo > 2) out.push('…');
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < total - 1) out.push('…');
  out.push(total);
  return out;
}

async function toolUsagePanel(detail) {
  tuEnsureStyles();
  const reload = () => toolUsagePanel(detail);
  const PAGE_SIZE = 50;
  // 현재 필터 → 쿼리스트링(+추가 파라미터). 페이지 이동·CSV·재조회가 공유.
  const filterQs = (extra?) => {
    const q = new URLSearchParams({ window: TOOL_USAGE_STATE.window });
    if (TOOL_USAGE_STATE.harness) q.set('harness', TOOL_USAGE_STATE.harness);
    if (TOOL_USAGE_STATE.tool) q.set('tool', TOOL_USAGE_STATE.tool);
    if (TOOL_USAGE_STATE.errorsOnly) q.set('errors', '1');
    for (const k in (extra || {})) q.set(k, String(extra[k]));
    return q.toString();
  };
  detail.replaceChildren(el('div', { class: 'card' }, skeleton('호출 통계를 불러오는 중')));

  const page = Math.max(1, TOOL_USAGE_STATE.page || 1);
  let r;
  try { r = await api('/api/ui/tool-usage?' + filterQs({ offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE })); }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '호출 통계를 불러오지 못했습니다'))); return; }

  const sum = r.summary || {};
  const byTool = r.byTool || [];
  const byHarness = r.byHarness || [];
  const byDay = (r.byDay || []).slice().reverse(); // 서버는 최신→과거 정렬 → 그래프는 과거→최신으로
  const recent = r.recent || [];
  const total = sum.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── 컨트롤(기간·하네스·툴·결과 필터) — 필터 변경 시 page=1 리셋 ──
  const winSel = el('select', { class: 'tu-sel' });
  for (const w of (r.windows || Object.keys(TU_WINDOW_LABELS))) winSel.append(el('option', { value: w, text: TU_WINDOW_LABELS[w] || w }));
  winSel.value = r.window || TOOL_USAGE_STATE.window;
  winSel.onchange = () => { TOOL_USAGE_STATE.window = winSel.value; TOOL_USAGE_STATE.page = 1; reload(); };

  const harnessSel = el('select', { class: 'tu-sel' });
  harnessSel.append(el('option', { value: '', text: '모든 하네스' }));
  const harnessVals = byHarness.map((h) => h.harness).filter((h) => h && h !== '(미상)');
  if (TOOL_USAGE_STATE.harness && !harnessVals.includes(TOOL_USAGE_STATE.harness)) harnessVals.push(TOOL_USAGE_STATE.harness);
  for (const h of harnessVals) harnessSel.append(el('option', { value: h, text: h }));
  harnessSel.value = TOOL_USAGE_STATE.harness;
  harnessSel.onchange = () => { TOOL_USAGE_STATE.harness = harnessSel.value; TOOL_USAGE_STATE.page = 1; reload(); };

  // 툴 필터 = 드롭다운(현재 기간+하네스 내 실제 툴 목록 + 호출수). 이름 타이핑 대신 선택.
  const toolSel = el('select', { class: 'tu-sel' });
  toolSel.append(el('option', { value: '', text: '모든 툴' }));
  const toolOpts = r.toolOptions || [];
  for (const t of toolOpts) toolSel.append(el('option', { value: t.tool, text: t.tool + ' (' + (t.calls || 0).toLocaleString() + ')' }));
  if (TOOL_USAGE_STATE.tool && !toolOpts.some((t) => t.tool === TOOL_USAGE_STATE.tool)) toolSel.append(el('option', { value: TOOL_USAGE_STATE.tool, text: TOOL_USAGE_STATE.tool }));
  toolSel.value = TOOL_USAGE_STATE.tool;
  toolSel.onchange = () => { TOOL_USAGE_STATE.tool = toolSel.value; TOOL_USAGE_STATE.page = 1; reload(); };

  // 결과 필터(전체/오류만)
  const errSel = el('select', { class: 'tu-sel' });
  errSel.append(el('option', { value: '', text: '전체' }));
  errSel.append(el('option', { value: '1', text: '오류만' }));
  errSel.value = TOOL_USAGE_STATE.errorsOnly ? '1' : '';
  errSel.onchange = () => { TOOL_USAGE_STATE.errorsOnly = errSel.value === '1'; TOOL_USAGE_STATE.page = 1; reload(); };

  // CSV(엑셀) 다운로드 — 현재 필터 전체를 페이지 루프로 모아 CSV(Excel 한글 BOM). 상한 5000행.
  const exportCsv = async () => {
    toast('CSV 준비 중…');
    const rows: any[] = []; let off = 0; const CAP = 5000;
    try {
      while (off < total && rows.length < CAP) {
        const r2 = await api('/api/ui/tool-usage?' + filterQs({ offset: off, limit: 500 }));
        const batch = (r2 && r2.recent) || [];
        if (!batch.length) break;
        rows.push(...batch); off += batch.length;
        if (batch.length < 500) break;
      }
    } catch (e) { toast('CSV 조회 실패'); return; }
    const cols = ['called_at', 'tool', 'harness', 'actor', 'ok', 'duration_ms', 'error', 'args'];
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [cols.join(',')];
    for (const c of rows) lines.push([c.called_at, c.tool, c.harness, c.actor, c.ok, c.duration_ms, c.error, (c.args == null ? '' : JSON.stringify(c.args))].map(esc).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'mcp-calls-' + TOOL_USAGE_STATE.window + (TOOL_USAGE_STATE.errorsOnly ? '-errors' : '') + '.csv' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(rows.length.toLocaleString() + '행 내려받음' + (rows.length >= CAP ? ' (상한 ' + CAP + ')' : ''));
  };

  const controls = el('div', { class: 'tu-controls' },
    el('div', { class: 'tu-field' }, el('label', { text: '기간' }), winSel),
    el('div', { class: 'tu-field' }, el('label', { text: '하네스' }), harnessSel),
    el('div', { class: 'tu-field' }, el('label', { text: '툴' }), toolSel),
    el('div', { class: 'tu-field' }, el('label', { text: '결과' }), errSel),
    el('button', { class: 'btn btn-ghost btn-sm', text: '새로고침', onclick: reload }),
    el('button', { class: 'btn btn-ghost btn-sm', text: 'CSV 다운로드', onclick: exportCsv }),
    (TOOL_USAGE_STATE.harness || TOOL_USAGE_STATE.tool || TOOL_USAGE_STATE.errorsOnly)
      ? el('button', { class: 'btn btn-ghost btn-sm', text: '필터 해제', onclick: () => { TOOL_USAGE_STATE.harness = ''; TOOL_USAGE_STATE.tool = ''; TOOL_USAGE_STATE.errorsOnly = false; TOOL_USAGE_STATE.page = 1; reload(); } })
      : null);

  // ── 요약 스탯 ──
  const stat = (label, value, bad?) => el('div', { class: 'tu-stat' + (bad ? ' tu-bad' : '') }, el('b', { text: String(value) }), el('span', { text: label }));
  const stats = el('div', { class: 'tu-stats' },
    stat('총 호출', (sum.total || 0).toLocaleString()),
    stat('툴 종류', sum.tools || 0),
    stat('하네스', sum.harnesses || 0),
    stat('오류', (sum.errors || 0).toLocaleString(), (sum.errors || 0) > 0),
    stat('마지막 호출', sum.last_at ? relTime(sum.last_at) : '—'));

  // ── 일별 막대(KST) ──
  let daysEl: any = null;
  if (byDay.length) {
    const maxCalls = Math.max(...byDay.map((d) => d.calls), 1);
    const bars = el('div', { class: 'tu-days' });
    const labels = el('div', { class: 'tu-daylabels' });
    for (const d of byDay) {
      const h = Math.max(2, Math.round((d.calls / maxCalls) * 100));
      const allErr = d.calls > 0 && d.errors >= d.calls;
      bars.append(el('div', { class: 'tu-day' },
        el('i', { class: allErr ? 'tu-allerr' : '', style: 'height:' + h + '%', title: d.day + ' · ' + d.calls + '회' + (d.errors ? ' (오류 ' + d.errors + ')' : '') })));
      labels.append(el('span', { text: String(d.day).slice(5) }));
    }
    daysEl = el('div', {}, el('div', { class: 'tu-sub', text: '일별 호출 (KST)' }), bars, labels);
  }

  // ── 툴별 표 ──
  const maxToolCalls = Math.max(...byTool.map((t) => t.calls), 1);
  const toolBody = el('tbody');
  for (const t of byTool) {
    const frac = Math.round((t.calls / maxToolCalls) * 100);
    toolBody.append(el('tr', {},
      el('td', { class: 'tu-namecell' },
        el('span', { class: 'tu-bar', style: 'width:' + frac + '%' }),
        el('span', { class: 'tu-name mono', text: t.tool })),
      el('td', { class: 'tu-num', text: (t.calls || 0).toLocaleString() }),
      el('td', { class: 'tu-num', text: t.errors ? String(t.errors) : '–' }),
      el('td', { class: 'tu-num', text: t.avg_ms != null ? t.avg_ms + 'ms' : '–' }),
      el('td', { class: 'tu-num', text: t.max_ms != null ? t.max_ms + 'ms' : '–' }),
      el('td', { class: 'tu-num', text: t.last_at ? relTime(t.last_at) : '–' })));
  }
  const toolTable = byTool.length
    ? el('table', { class: 'tu-table' },
        el('thead', {}, el('tr', {},
          el('th', { text: '툴' }),
          el('th', { class: 'tu-num', text: '호출' }),
          el('th', { class: 'tu-num', text: '오류' }),
          el('th', { class: 'tu-num', text: '평균' }),
          el('th', { class: 'tu-num', text: '최대' }),
          el('th', { class: 'tu-num', text: '마지막' }))),
        toolBody)
    : el('div', { class: 'tu-empty', text: '이 조건에 기록된 호출이 없습니다.' });

  // ── 하네스별 칩 ──
  const harnessChips = el('div', { class: 'tu-harness' });
  for (const h of byHarness) harnessChips.append(el('span', { class: 'tu-chip' },
    el('span', { text: h.harness }),
    el('b', { text: (h.calls || 0).toLocaleString() }),
    h.errors ? el('em', { text: '오류 ' + h.errors }) : null));

  // ── 최근 호출(인자 펼침) + 번호 페이지네이션 ──
  const calls = el('div', { class: 'tu-calls' });
  const renderCall = (c) => el('details', { class: 'tu-call' },
    el('summary', {},
      el('span', { class: 'tu-ctime', text: relTime(c.called_at) }),
      el('span', { class: 'tu-ctool mono', text: c.tool }),
      el('span', { class: 'dm-tag', text: c.harness || '미상' }),
      c.ok ? null : el('span', { class: 'tu-cbad', text: '✗ 오류' }),
      el('span', { class: 'tu-cdur', text: c.duration_ms != null ? c.duration_ms + 'ms' : '' }),
      el('span', { class: 'tu-cactor', text: c.actor || '' })),
    el('pre', { class: 'tu-args mono', text: tuPretty(c.args) }),
    c.error ? el('pre', { class: 'tu-args mono', text: '⚠ ' + c.error }) : null);
  if (!recent.length) calls.append(el('div', { class: 'tu-empty', text: TOOL_USAGE_STATE.errorsOnly ? '이 조건의 오류 호출이 없습니다.' : '최근 호출이 없습니다.' }));
  for (const c of recent) calls.append(renderCall(c));

  // 번호 페이지네이션 — 페이지 클릭 시 page 갱신 후 reload(필터·집계 유지). ‹ 1 … 4 5 6 … 20 ›
  const pagerBox = el('div', { class: 'tu-pager' });
  if (totalPages > 1) {
    const cur = Math.min(page, totalPages);
    const pgBtn = (label, n, kind?) => el('button', {
      class: 'tu-pg' + (kind === 'on' ? ' tu-pg-on' : '') + (kind === 'off' ? ' tu-pg-off' : ''),
      text: String(label), ...(kind ? {} : { onclick: () => { TOOL_USAGE_STATE.page = n; reload(); } }) });
    pagerBox.append(pgBtn('‹', cur - 1, cur <= 1 ? 'off' : undefined));
    for (const pn of tuPageNumbers(cur, totalPages)) {
      if (pn === '…') pagerBox.append(el('span', { class: 'tu-pg-gap', text: '…' }));
      else pagerBox.append(pgBtn(pn, pn, pn === cur ? 'on' : undefined));
    }
    pagerBox.append(pgBtn('›', cur + 1, cur >= totalPages ? 'off' : undefined));
    pagerBox.append(el('span', { class: 'tu-pg-info', text: cur + ' / ' + totalPages + ' 페이지' }));
  }

  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: 'MCP 호출 통계' })),
    el('p', { class: 'admin-hint', text: '하네스(Claude·Codex 등)가 어떤 MCP 툴을 어떤 인자로 어느 빈도로 호출했는지입니다. 모든 호출이 기록되며(시크릿 마스킹·큰 값 절단), AI에게 묻거나 db_query 로 mcp_call_log 를 직접 조회할 수도 있습니다.' }),
    controls,
    stats,
    daysEl,
    el('div', { class: 'tu-sub', text: '툴별 호출' }), toolTable,
    byHarness.length ? el('div', { class: 'tu-sub', text: '하네스별' }) : null,
    byHarness.length ? harnessChips : null,
    el('div', { class: 'tu-sub', text: '최근 호출' + (total ? ' (' + total.toLocaleString() + ')' : '') }), calls, pagerBox);
  detail.replaceChildren(card);
}

// ════════ 조직 변경 감사 로그(#549) — 누가(사람/AI)·언제·무엇을·어디서(mcp/web) 바꿨는지 + before→after ════════
//  읽기 전용(admin). 백엔드=/api/ui/org/audit(src/capabilities/delivery.ts org_audit_list → org_content_audit).
//  에이전트가 MCP 로 관리기능을 만지게 열린 뒤(#549) 'AI 가 관리탭을 바꿨다'를 사람이 확인하는 표면. 필터·페이징은 tool-usage 와 동형.
const ORG_AUDIT_STATE: any = { scope: 'admin', entity: '', actor_kind: '', channel: '', op: '', page: 1 };
const OA_ENTITY_LABELS: any = {
  org_member: '구성원', auth_token: '토큰', org_profile: '조직 프로필', org_section: '주입 섹션',
  org_runtime_config: '런타임 설정', org_connector: '커넥터', org_mcp_server: 'MCP 서버',
  org_hook: '커스텀 훅', org_tool: 'AI 도구', org_harness_asset: '스킬·에이전트·커맨드', org_db_source: 'DB 소스',
  org_db_table_policy: '테이블 정책', org_db_column_mask: '컬럼 마스킹',
};
const OA_OP_LABELS: any = { insert: '생성', update: '수정', delete: '삭제', revoke: '회수', mint: '발급', reorder: '순서변경' };
const OA_CHANNEL_LABELS: any = { mcp: '에이전트(MCP)', web: '웹 관리탭', connector: '커넥터', cli: 'CLI', migration: '마이그레이션', unknown: '미상' };
const OA_KIND_LABELS: any = { human: '사람', ai: 'AI', system: '시스템', connector: '커넥터', unknown: '미상' };

// 스타일 1회 주입(테마 토큰 — 라이트/다크 자동). textContent 로만 삽입(보안 불변식). tool-usage 의 tu-* 를 oa-* 로 복제.
function oaEnsureStyles() {
  if (document.getElementById('oa-styles')) return;
  document.head.appendChild(el('style', { id: 'oa-styles', text: `
.oa-controls{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;margin:2px 0 18px}
.oa-field{display:flex;flex-direction:column;gap:4px}
.oa-field>label{font-size:11px;font-weight:700;color:var(--muted)}
.oa-sel{padding:6px 9px;font:inherit;color:var(--ink);border:1px solid var(--line);border-radius:7px;background:var(--bg)}
.oa-sub{font-weight:800;font-size:13px;color:var(--ink);margin:22px 0 9px}
.oa-rows{margin-top:4px}
.oa-row{border-bottom:1px solid var(--line);padding:9px 4px}
.oa-row>summary{display:flex;gap:10px;align-items:center;cursor:pointer;list-style:none;flex-wrap:wrap}
.oa-row>summary::-webkit-details-marker{display:none}
.oa-row>summary:hover{background:var(--bg-tint)}
.oa-time{color:var(--muted);font-size:11.5px;min-width:70px}
.oa-ent{font-weight:700;color:var(--ink)}
.oa-key{color:var(--ink-sub);font-size:12px;font-family:ui-monospace,monospace}
.oa-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;border:1px solid var(--line);background:var(--bg-tint);color:var(--ink-sub)}
.oa-badge.oa-op-delete,.oa-badge.oa-op-revoke{color:var(--coral);border-color:var(--coral)}
.oa-badge.oa-op-insert,.oa-badge.oa-op-mint{color:var(--blue);border-color:var(--blue)}
.oa-kind{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700}
.oa-kind-ai{background:var(--blue);color:#fff}
.oa-kind-human{background:var(--bg-tint);color:var(--ink);border:1px solid var(--line)}
.oa-kind-system,.oa-kind-connector,.oa-kind-unknown{background:var(--bg-tint);color:var(--ink-sub);border:1px solid var(--line)}
.oa-actor{color:var(--ink-sub);font-size:12px}
.oa-chan{color:var(--muted);font-size:11.5px;margin-left:auto}
.oa-diff{width:100%;border-collapse:collapse;font-size:12.5px;margin:8px 0 2px}
.oa-diff th{text-align:left;padding:4px 9px;font-size:10.5px;font-weight:700;color:var(--muted);border-bottom:1px solid var(--line)}
.oa-diff td{padding:5px 9px;border-bottom:1px solid var(--line);vertical-align:top;color:var(--ink)}
.oa-diff td.oa-f{font-weight:700;white-space:nowrap;color:var(--ink-sub)}
.oa-v{font-family:ui-monospace,monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-word;max-width:340px;overflow:auto}
.oa-v-was{color:var(--coral)}
.oa-v-now{color:var(--ink)}
.oa-empty{color:var(--muted);font-size:13px;padding:18px 4px}
.oa-pager{display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin-top:14px}
.oa-pg{min-width:30px;height:30px;padding:0 9px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);font:inherit;font-size:12.5px;cursor:pointer;font-variant-numeric:tabular-nums}
.oa-pg:hover{background:var(--bg-tint)}
.oa-pg-on{background:var(--blue);border-color:var(--blue);color:#fff;cursor:default}
.oa-pg-off{opacity:.38;cursor:default}
.oa-pg-gap{color:var(--muted);padding:0 2px}
.oa-pg-info{color:var(--muted);font-size:11.5px;margin-left:8px}
` }));
}

// before/after → 변경된 최상위 필드만(값은 JSON 비교). insert=신규(after만), delete=삭제(before만), update=바뀐 키.
function oaDiff(before, after) {
  const b = (before && typeof before === 'object') ? before : {};
  const a = (after && typeof after === 'object') ? after : {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  const out: any[] = [];
  for (const k of keys) {
    if (JSON.stringify(b[k]) === JSON.stringify(a[k])) continue;
    out.push({ key: k, before: b[k], after: a[k], hadBefore: k in b, hasAfter: k in a });
  }
  return out;
}
function oaVal(v) {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 400 ? v.slice(0, 400) + '…' : v;
  try { const s = JSON.stringify(v, null, 1); return s.length > 600 ? s.slice(0, 600) + '…' : s; } catch { return String(v); }
}

async function orgAuditPanel(detail) {
  oaEnsureStyles();
  const reload = () => orgAuditPanel(detail);
  const PAGE_SIZE = 50;
  const filterQs = (extra?) => {
    const q = new URLSearchParams();
    if (ORG_AUDIT_STATE.scope) q.set('scope', ORG_AUDIT_STATE.scope);
    if (ORG_AUDIT_STATE.entity) q.set('entity', ORG_AUDIT_STATE.entity);
    if (ORG_AUDIT_STATE.actor_kind) q.set('actor_kind', ORG_AUDIT_STATE.actor_kind);
    if (ORG_AUDIT_STATE.channel) q.set('channel', ORG_AUDIT_STATE.channel);
    if (ORG_AUDIT_STATE.op) q.set('op', ORG_AUDIT_STATE.op);
    for (const k in (extra || {})) q.set(k, String(extra[k]));
    return q.toString();
  };
  detail.replaceChildren(el('div', { class: 'card' }, skeleton('변경 이력을 불러오는 중')));

  const page = Math.max(1, ORG_AUDIT_STATE.page || 1);
  let r;
  try { r = await api('/api/ui/org/audit?' + filterQs({ offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE })); }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '변경 이력을 불러오지 못했습니다'))); return; }

  const rows = r.rows || [];
  const total = r.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── 필터 컨트롤 — 변경 시 page=1 리셋 ──
  const mkSel = (labelText, stateKey, opts, allLabel) => {
    const sel = el('select', { class: 'oa-sel' });
    sel.append(el('option', { value: '', text: allLabel }));
    for (const o of opts) sel.append(el('option', { value: o.val, text: o.label }));
    sel.value = ORG_AUDIT_STATE[stateKey] || '';
    sel.onchange = () => { ORG_AUDIT_STATE[stateKey] = sel.value; ORG_AUDIT_STATE.page = 1; reload(); };
    return el('div', { class: 'oa-field' }, el('label', { text: labelText }), sel);
  };
  const entityOpts = (r.entityOptions || []).map((e) => ({ val: e, label: OA_ENTITY_LABELS[e] || e }));
  const kindOpts = (r.actorKindOptions || []).map((k) => ({ val: k, label: OA_KIND_LABELS[k] || k }));
  const chanOpts = (r.channelOptions || []).map((c) => ({ val: c, label: OA_CHANNEL_LABELS[c] || c }));
  const opOpts = (r.opOptions || []).map((o) => ({ val: o, label: OA_OP_LABELS[o] || o }));

  const scopeSel = el('select', { class: 'oa-sel' });
  scopeSel.append(el('option', { value: 'admin', text: '관리 항목만' }));
  scopeSel.append(el('option', { value: 'all', text: '전체(지식·프로젝트 포함)' }));
  scopeSel.value = ORG_AUDIT_STATE.scope || 'admin';
  scopeSel.onchange = () => { ORG_AUDIT_STATE.scope = scopeSel.value; ORG_AUDIT_STATE.page = 1; reload(); };

  const anyFilter = ORG_AUDIT_STATE.entity || ORG_AUDIT_STATE.actor_kind || ORG_AUDIT_STATE.channel || ORG_AUDIT_STATE.op;
  const controls = el('div', { class: 'oa-controls' },
    el('div', { class: 'oa-field' }, el('label', { text: '범위' }), scopeSel),
    mkSel('종류', 'entity', entityOpts, '모든 종류'),
    mkSel('누가', 'actor_kind', kindOpts, '사람·AI 전체'),
    mkSel('경로', 'channel', chanOpts, '모든 경로'),
    mkSel('작업', 'op', opOpts, '모든 작업'),
    el('button', { class: 'btn btn-ghost btn-sm', text: '새로고침', onclick: reload }),
    anyFilter ? el('button', { class: 'btn btn-ghost btn-sm', text: '필터 해제',
      onclick: () => { ORG_AUDIT_STATE.entity = ''; ORG_AUDIT_STATE.actor_kind = ''; ORG_AUDIT_STATE.channel = ''; ORG_AUDIT_STATE.op = ''; ORG_AUDIT_STATE.page = 1; reload(); } }) : null);

  // ── 행 리스트(펼치면 필드별 이전→이후) ──
  const list = el('div', { class: 'oa-rows' });
  const renderRow = (c) => {
    const kind = c.actor_kind || 'unknown';
    const diff = oaDiff(c.before, c.after);
    const diffBody = el('tbody');
    for (const d of diff) diffBody.append(el('tr', {},
      el('td', { class: 'oa-f', text: d.key }),
      el('td', {}, el('div', { class: 'oa-v oa-v-was', text: d.hadBefore ? oaVal(d.before) : '—' })),
      el('td', {}, el('div', { class: 'oa-v oa-v-now', text: d.hasAfter ? oaVal(d.after) : '(삭제됨)' }))));
    const diffTable = diff.length
      ? el('table', { class: 'oa-diff' }, el('thead', {}, el('tr', {}, el('th', { text: '필드' }), el('th', { text: '이전' }), el('th', { text: '이후' }))), diffBody)
      : el('div', { class: 'oa-empty', text: '내용 변화 없음(메타만).' });
    return el('details', { class: 'oa-row' },
      el('summary', {},
        el('span', { class: 'oa-time', text: relTime(c.at) }),
        el('span', { class: 'oa-kind oa-kind-' + kind, text: OA_KIND_LABELS[kind] || kind }),
        el('span', { class: 'oa-actor', text: c.actor_display || c.actor || '—' }),
        el('span', { class: 'oa-ent', text: OA_ENTITY_LABELS[c.entity] || c.entity }),
        c.entity_key ? el('span', { class: 'oa-key', text: c.entity_key }) : null,
        el('span', { class: 'oa-badge oa-op-' + c.op, text: OA_OP_LABELS[c.op] || c.op }),
        el('span', { class: 'oa-chan', text: OA_CHANNEL_LABELS[c.channel] || c.channel || '' })),
      diffTable);
  };
  if (!rows.length) list.append(el('div', { class: 'oa-empty', text: '이 조건의 변경 이력이 없습니다.' }));
  for (const c of rows) list.append(renderRow(c));

  // ── 페이지네이션(tuPageNumbers 재사용) ──
  const pagerBox = el('div', { class: 'oa-pager' });
  if (totalPages > 1) {
    const cur = Math.min(page, totalPages);
    const pgBtn = (label, n, kind?) => el('button', {
      class: 'oa-pg' + (kind === 'on' ? ' oa-pg-on' : '') + (kind === 'off' ? ' oa-pg-off' : ''),
      text: String(label), ...(kind ? {} : { onclick: () => { ORG_AUDIT_STATE.page = n; reload(); } }) });
    pagerBox.append(pgBtn('‹', cur - 1, cur <= 1 ? 'off' : undefined));
    for (const pn of tuPageNumbers(cur, totalPages)) {
      if (pn === '…') pagerBox.append(el('span', { class: 'oa-pg-gap', text: '…' }));
      else pagerBox.append(pgBtn(pn, pn, pn === cur ? 'on' : undefined));
    }
    pagerBox.append(pgBtn('›', cur + 1, cur >= totalPages ? 'off' : undefined));
    pagerBox.append(el('span', { class: 'oa-pg-info', text: cur + ' / ' + totalPages + ' 페이지' }));
  }

  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '조직 변경 감사 로그' })),
    el('p', { class: 'admin-hint', text: '구성원·토큰·런타임·커넥터·DB소스·훅·도구 등 관리 항목이 누구에 의해(사람/AI) 어떤 경로(웹/MCP)로 언제 어떻게 바뀌었는지 기록입니다. 각 줄을 펼치면 바뀐 필드의 이전→이후를 볼 수 있어요(시크릿은 마스킹). AI에게 묻거나 org_audit_list(MCP)로도 조회할 수 있습니다.' }),
    controls,
    el('div', { class: 'oa-sub', text: '변경 이력' + (total ? ' (' + total.toLocaleString() + ')' : '') }),
    list, pagerBox);
  detail.replaceChildren(card);
}

// ── 스케줄러(자동화) — org_cron 잡 관리(admin). is 신선화·미매핑 LLM 분류(세션 주입)·sync 를 주기 실행. ──
//  map_unmapped 잡은 '타깃 LLM 세션'(상시 시드 세션)을 골라 거기에 분류 태스크를 주입한다(팀플랜 과금 — headless 토큰 아님).
async function cronPanel(detail, data) {
  const reload = () => cronPanel(detail, data);
  detail.replaceChildren(el('div', { class: 'card' }, skeleton('스케줄 잡을 불러오는 중')));
  let jobs; let actions: any[] = [];
  try { const r = await api('/api/ui/cron'); jobs = (r && r.jobs) || []; actions = (r && r.actions) || []; }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '스케줄 잡을 불러오지 못했습니다'))); return; }

  const rows = el('div', { class: 'wikicat-rows' });
  if (!jobs.length) rows.append(el('div', { class: 'wikicat-empty', text: '아직 스케줄 잡이 없습니다.' }));
  for (const j of jobs) {
    const sched = j.run_once ? '한 번만 (1회성)' : (j.cron_expr ? ('cron: ' + j.cron_expr) : ('매 ' + (j.interval_sec || 0) + '초'));
    const sess = (j.params && j.params.session) ? (' → ' + j.params.session) : '';
    const last = j.last_run_at ? (relTime(j.last_run_at) + ' · ' + (j.last_status || '')) : '미실행';
    const main = el('div', { class: 'wikicat-row-main' },
      el('span', { class: 'wikicat-name', text: j.label || j.id }),
      el('span', { class: 'wikicat-key mono', text: j.action + sess }),
      el('span', { class: 'dm-tag', text: j.enabled ? sched : '꺼짐' }),
      el('span', { class: 'wikicat-should' }, el('span', { class: 'wikicat-should-label', text: '최근' }), last));
    const acts = el('div', { class: 'wikicat-row-acts' },
      el('button', { class: 'btn btn-ghost btn-sm', text: '지금 실행', onclick: () => cronRunNow(j.id, reload) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: j.enabled ? '끄기' : '켜기', onclick: () => cronToggle(j, reload) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openCronForm(j, actions, reload) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: () => cronDelete(j.id, reload) }));
    rows.append(el('div', { class: 'wikicat-row' }, main, acts));
  }
  const head = el('div', { class: 'wikicat-grouphead' },
    el('span', { class: 'wikicat-grouptitle', text: '스케줄 잡' }),
    el('span', { class: 'wikicat-groupcount', text: String(jobs.length) }),
    el('button', { class: 'btn btn-ghost btn-sm wikicat-add', text: '+ 잡 추가', onclick: () => openCronForm(null, actions, reload) }));
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '스케줄러 (자동화)' })),
    el('p', { class: 'admin-hint', text: '게이트웨이가 주기 실행하는 잡입니다. is 신선화(refresh)·미매핑 코드 LLM 분류(map_unmapped → 타깃 상시 세션에 주입, 팀플랜 과금)·커넥터 sync 등. 주기는 “초” 또는 cron식.' }),
    el('div', { class: 'wikicat' }, el('div', { class: 'wikicat-group' }, head, rows)));
  detail.replaceChildren(card);
}

// 잡 추가/수정 폼(오버레이) — id·이름·액션·주기(초 또는 cron식)·켬 + 액션별 params(map_unmapped=세션 피커, refresh_repo=repo, connector_sync=system).
// actions = 액션 레지스트리(cron_list 의 actions = CRON_ACTIONS). 드롭다운·파라미터 필드를 여기서 데이터로 생성(하드코딩 X).
async function openCronForm(job, actions, reload) {
  const isNew = !job;
  const jp = (job && job.params) || {};
  const inputStyle = 'width:100%;padding:6px 8px;font:inherit;box-sizing:border-box';
  const block = (title, hint, ctrl) => el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: title }),
    hint ? el('p', { class: 'ps-block-hint', text: hint }) : null, ctrl);

  const idInp = el('input', { type: 'text', style: inputStyle, value: job ? job.id : '', placeholder: 'my-job', ...(isNew ? {} : { disabled: true }) });
  const labelInp = el('input', { type: 'text', style: inputStyle, value: (job && job.label) || '', placeholder: '잡 이름' });
  const actionSel = el('select', { style: inputStyle });
  for (const a of (actions || [])) actionSel.append(el('option', { value: a.key, text: a.label }));
  if (job && job.action) actionSel.value = job.action; // 신뢰 가능한 선택(속성 spread 대신 value 할당)
  const intervalInp = el('input', { type: 'number', style: inputStyle, value: String((job && job.interval_sec) || 1800), min: '60' });
  const cronInp = el('input', { type: 'text', style: inputStyle, value: (job && job.cron_expr) || '', placeholder: '예: 0 9 * * 1-5 (비우면 위 주기초 사용)' });
  const enabledChk = el('input', { type: 'checkbox', ...((job ? job.enabled : false) ? { checked: true } : {}) });
  const onceChk = el('input', { type: 'checkbox', ...((job && job.run_once) ? { checked: true } : {}) });

  // 액션별 파라미터 — 레지스트리의 params 스펙에서 동적 생성. kind=session → 상시 세션 피커, 그 외 → 텍스트.
  const paramsWrap = el('div');
  const paramInputs: Record<string, any> = {};
  let managedSessions: any[] | null = null;
  async function renderParams() {
    const a = (actions || []).find((x) => x.key === actionSel.value);
    paramsWrap.replaceChildren();
    for (const k of Object.keys(paramInputs)) delete paramInputs[k];
    if (!a) return;
    for (const p of (a.params || [])) {
      let inp: any;
      if (p.kind === 'session') {
        inp = el('select', { style: inputStyle });
        inp.append(el('option', { value: '', text: '(상시 세션 선택)' }));
        if (managedSessions == null) { try { const r = await api('/api/ui/managed-sessions'); managedSessions = (r && r.sessions) || []; } catch { managedSessions = []; } }
        for (const s of (managedSessions || [])) inp.append(el('option', { value: s.id, text: (s.label || s.id) + ' — ' + (s.account || '계정?') + (s.enabled ? '' : ' (꺼짐)') }));
        if (jp[p.name]) inp.value = jp[p.name];
      } else if (p.kind === 'textarea') {
        // 긴 작업 프롬프트 — 멀티라인 입력(주입 시 백엔드가 개행→공백 평탄화). value 는 속성 아닌 프로퍼티로 설정.
        inp = el('textarea', { style: inputStyle + ';min-height:96px;resize:vertical', placeholder: p.hint || '', rows: '5' });
        inp.value = jp[p.name] || '';
      } else {
        inp = el('input', { type: 'text', style: inputStyle, value: jp[p.name] || '', placeholder: p.hint || '' });
      }
      paramInputs[p.name] = inp;
      paramsWrap.append(block(p.label, p.hint || '', inp));
    }
  }
  actionSel.onchange = renderParams;
  await renderParams();

  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: isNew ? '잡 추가' : '저장' });
  const form = el('div', { class: 'proj-settings' },
    block('잡 id', isNew ? '소문자 슬러그(a-z0-9_-). 잡의 고유 키.' : 'id 는 변경 불가.', idInp),
    block('이름', '관리 목록에 보일 이름.', labelInp),
    block('액션', '게이트웨이가 실행할 작업(등록된 액션 레지스트리). 액션마다 필요한 인자가 아래에 자동으로 뜹니다.', actionSel),
    paramsWrap,
    block('주기 (초)', '이 간격마다 실행(최소 60). cron식이 있으면 그게 우선.', intervalInp),
    block('cron식 (선택)', '벽시계 스케줄. 예: 0 9 * * 1-5 = 평일 09:00. 비우면 주기초.', cronInp),
    block('한 번만 실행', '체크 시 주기·cron 무시 → 1회 실행 후 자동으로 꺼짐(반복 안 함). 부트스트랩 등 일회성 잡용.', el('label', { class: 'inline' }, onceChk, el('span', { text: ' run once (1회 실행 후 비활성)' }))),
    block('켬', '', el('label', { class: 'inline' }, enabledChk, el('span', { text: ' 활성화' }))),
    el('div', { class: 'ps-rules-actions' }, saveBtn));
  const back = overlayBox(isNew ? '스케줄 잡 추가' : '스케줄 잡 수정 — ' + job.id, form);
  const boxw = back.querySelector('.ov-box'); if (boxw) boxw.classList.add('ov-box-wide');
  saveBtn.onclick = async () => {
    const id = idInp.value.trim();
    if (!id) { toast('잡 id 가 필요합니다', true); return; }
    const p: Record<string, string> = {};
    for (const k of Object.keys(paramInputs)) { const v = String(paramInputs[k].value || '').trim(); if (v) p[k] = v; }
    const body = { id, label: labelInp.value.trim() || null, action: actionSel.value, params: p,
      interval_sec: Number(intervalInp.value) || 1800, cron_expr: cronInp.value.trim(), run_once: onceChk.checked, enabled: enabledChk.checked };
    saveBtn.disabled = true;
    try { await api('/api/ui/cron', { method: 'POST', body: JSON.stringify(body) }); toast(isNew ? '잡을 추가했습니다' : '저장했습니다'); back.remove(); reload(); }
    catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
}

async function cronRunNow(id, reload) {
  try { const r = await api('/api/ui/cron/' + encodeURIComponent(id) + '/run', { method: 'POST' }); toast('실행: ' + ((r && r.status) || 'ok')); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}
async function cronToggle(job, reload) {
  try { await api('/api/ui/cron', { method: 'POST', body: JSON.stringify({ id: job.id, enabled: !job.enabled }) }); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}
async function cronDelete(id, reload) {
  if (!confirm('스케줄 잡 ‘' + id + '’을(를) 삭제할까요?')) return;
  try { await api('/api/ui/cron/' + encodeURIComponent(id) + '/delete', { method: 'POST' }); toast('삭제했습니다'); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}

// ════════ 인입 허용선 정책(#638) — 자동 인입(미러/distill)을 auto/confirm/drop 로 조절. ════════
async function ingestPolicyPanel(detail, data) {
  const reload = () => ingestPolicyPanel(detail, data);
  detail.replaceChildren(el('div', { class: 'card' }, skeleton('인입 정책을 불러오는 중')));
  let policies;
  try { const r = await api('/api/ui/org/ingest-policy'); policies = (r && r.policies) || []; }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '인입 정책을 불러오지 못했습니다'))); return; }

  const rows = el('div', { class: 'wikicat-rows' });
  if (!policies.length) rows.append(el('div', { class: 'wikicat-empty', text: '정책 규칙이 없습니다 — 규칙이 없으면 모든 자동 인입은 auto(즉시 지식화)입니다(현행). 특정 출처·카테고리를 검토 큐로 보내려면 규칙을 추가하세요.' }));
  for (const p of policies) {
    const m = [p.match_category && 'category=' + p.match_category, p.match_system && 'system=' + p.match_system,
      p.match_channel && 'channel=' + p.match_channel, p.match_provenance && 'provenance=' + p.match_provenance,
      p.match_sensitive && '민감=' + p.match_sensitive].filter(Boolean).join(' & ') || '전체(모든 자동 인입)';
    const actLabel = p.action === 'drop' ? '🚫 drop (미적재)' : p.action === 'confirm' ? '🔎 confirm (검토대기)' : '✅ auto (자동)';
    const main = el('div', { class: 'wikicat-row-main' },
      el('span', { class: 'wikicat-name', text: actLabel }),
      el('span', { class: 'wikicat-key mono', text: m }),
      el('span', { class: 'dm-tag', text: p.enabled ? ('우선순위 ' + (p.priority || 0)) : '꺼짐' }));
    const acts = el('div', { class: 'wikicat-row-acts' },
      el('button', { class: 'btn btn-ghost btn-sm', text: p.enabled ? '끄기' : '켜기', onclick: () => ingestPolicyToggle(p, reload) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openIngestPolicyForm(p, reload) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: () => ingestPolicyDelete(p.id, reload) }));
    rows.append(el('div', { class: 'wikicat-row' }, main, acts));
  }
  const head = el('div', { class: 'wikicat-grouphead' },
    el('span', { class: 'wikicat-grouptitle', text: '허용선 정책 규칙' }),
    el('span', { class: 'wikicat-groupcount', text: String(policies.length) }),
    el('button', { class: 'btn btn-ghost btn-sm wikicat-add', text: '+ 규칙 추가', onclick: () => openIngestPolicyForm(null, reload) }));
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '인입 허용선 (자동화 게이트)' })),
    el('p', { class: 'admin-hint', text: '자동 인입(커넥터 미러·자료 distill)이 만든 지식을 auto(즉시 반영)·confirm(검토 큐로 격리)·drop(미적재) 중 어디로 보낼지 규칙으로 정합니다. 규칙이 없으면 모두 auto(현행). 여러 규칙에 걸리면 가장 보수적(drop>confirm>auto)이 적용됩니다. confirm 된 지식은 “검토 큐”에서 승인해야 검색·주입에 반영됩니다.' }),
    el('div', { class: 'wikicat' }, el('div', { class: 'wikicat-group' }, head, rows)));
  detail.replaceChildren(card);
}

async function openIngestPolicyForm(pol, reload) {
  const isNew = !pol;
  const inputStyle = 'width:100%;padding:6px 8px;font:inherit;box-sizing:border-box';
  const block = (title, hint, ctrl) => el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: title }),
    hint ? el('p', { class: 'ps-block-hint', text: hint }) : null, ctrl);
  // 카테고리 목록(모든 space) 로드 — 드롭다운용. 실패해도 폼은 뜬다(빈 목록=전체 옵션만).
  let cats: any[] = [];
  try {
    const lists = await Promise.all(SPACE_SUBS.map((s) =>
      api('/api/ui/categories?' + new URLSearchParams({ space: s.key })).then((d) => (d && d.categories) || []).catch(() => [])));
    cats = lists.flat();
  } catch { cats = []; }

  const actSel = el('select', { style: inputStyle });
  for (const o of [['auto', 'auto — 즉시 지식화(active)'], ['confirm', 'confirm — 검토 큐로 격리(pending)'], ['drop', 'drop — 적재 안 함']]) actSel.append(el('option', { value: o[0], text: o[1] }));
  actSel.value = (pol && pol.action) || 'confirm';
  // 카테고리 = 드롭다운(로드된 목록). 미등록 기존값은 옵션 추가해 보존.
  const catSel = el('select', { style: inputStyle });
  catSel.append(el('option', { value: '', text: '전체 (모든 카테고리)' }));
  for (const c of cats) catSel.append(el('option', { value: c.key, text: (c.name || c.key) + ' (' + c.key + ')' }));
  if (pol && pol.match_category) {
    if (!cats.some((c) => c.key === pol.match_category)) catSel.append(el('option', { value: pol.match_category, text: pol.match_category + ' (미등록)' }));
    catSel.value = pol.match_category;
  }
  // 시스템 = 드롭다운(커넥터 고정 목록).
  const sysSel = el('select', { style: inputStyle });
  sysSel.append(el('option', { value: '', text: '전체 (모든 시스템)' }));
  for (const s of ['slack', 'notion', 'clickup', 'gmail', 'gdrive', 'discord']) sysSel.append(el('option', { value: s, text: s }));
  if (pol && pol.match_system) { if (!['slack', 'notion', 'clickup', 'gmail', 'gdrive', 'discord'].includes(pol.match_system)) sysSel.append(el('option', { value: pol.match_system, text: pol.match_system })); sysSel.value = pol.match_system; }
  const chanInp = el('input', { type: 'text', style: inputStyle, value: (pol && pol.match_channel) || '', placeholder: '특정 채널·폴더 id (비우면 시스템 전체)' });
  const provSel = el('select', { style: inputStyle });
  for (const o of [['', '전체'], ['observed', 'observed (커넥터 미러 — 정제문서 직행)'], ['authored', 'authored (자료 distill — LLM 증류)']]) provSel.append(el('option', { value: o[0], text: o[1] }));
  if (pol && pol.match_provenance) provSel.value = pol.match_provenance;
  // 민감 라벨 = 드롭다운(통제어휘).
  const sensSel = el('select', { style: inputStyle });
  for (const o of [['', '전체 (판정 무관)'], ['cooking', 'cooking (쿠킹 중)'], ['planning', 'planning (기획 단계)'], ['unfinished', 'unfinished (미완결·미확정)']]) sensSel.append(el('option', { value: o[0], text: o[1] }));
  if (pol && pol.match_sensitive) sensSel.value = pol.match_sensitive;
  const prioInp = el('input', { type: 'number', style: inputStyle, value: String((pol && pol.priority) || 0) });
  const enabledChk = el('input', { type: 'checkbox', ...((pol ? pol.enabled : true) ? { checked: true } : {}) });

  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: isNew ? '규칙 추가' : '저장' });
  const form = el('div', { class: 'proj-settings' },
    block('동작 (action)', 'auto=즉시 반영 · confirm=검토 큐 격리 · drop=미적재. 여러 규칙에 걸리면 가장 보수적이 이깁니다.', actSel),
    block('카테고리 (선택)', '이 도메인 지식에만 적용. 비우면 모든 카테고리.', catSel),
    block('시스템 (선택)', '출처 커넥터. 비우면 모든 시스템.', sysSel),
    block('출처 채널/폴더 (선택)', '특정 slack 채널·notion 폴더 등(id). 비우면 시스템 전체. (동적 목록 픽커는 후속.)', chanInp),
    block('경로 (선택)', 'observed=커넥터 미러(정제문서 직행) · authored=자료 distill(LLM 증류).', provSel),
    block('민감 라벨 (선택)', 'distill/미러 LLM 이 내용에서 판정. 비우면 판정 무관.', sensSel),
    block('우선순위', '표시·정렬용(평가는 가장 보수적 규칙 우선). 큰 값이 위.', prioInp),
    block('켬', '', el('label', { class: 'inline' }, enabledChk, el('span', { text: ' 활성화' }))),
    el('div', { class: 'ps-rules-actions' }, saveBtn));
  const back = overlayBox(isNew ? '허용선 규칙 추가' : '허용선 규칙 수정', form);
  const boxw = back.querySelector('.ov-box'); if (boxw) boxw.classList.add('ov-box-wide');
  saveBtn.onclick = async () => {
    const body: any = { action: actSel.value,
      match_category: catSel.value || null, match_system: sysSel.value || null,
      match_channel: chanInp.value.trim() || null, match_provenance: provSel.value || null,
      match_sensitive: sensSel.value || null, priority: Number(prioInp.value) || 0, enabled: enabledChk.checked };
    if (pol) body.id = pol.id;
    saveBtn.disabled = true;
    try { await api('/api/ui/org/ingest-policy', { method: 'POST', body: JSON.stringify(body) }); toast(isNew ? '규칙을 추가했습니다' : '저장했습니다'); back.remove(); reload(); }
    catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
}
// 토글은 전체 필드 재전송(upsert 는 미전송 필드를 기본값으로 덮으므로) — enabled 만 반전.
async function ingestPolicyToggle(pol, reload) {
  try { await api('/api/ui/org/ingest-policy', { method: 'POST', body: JSON.stringify({
    id: pol.id, enabled: !pol.enabled, action: pol.action, priority: pol.priority,
    match_category: pol.match_category, match_system: pol.match_system, match_channel: pol.match_channel,
    match_provenance: pol.match_provenance, match_sensitive: pol.match_sensitive }) }); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}
async function ingestPolicyDelete(id, reload) {
  if (!confirm('이 규칙을 삭제할까요?')) return;
  try { await api('/api/ui/org/ingest-policy/remove', { method: 'POST', body: JSON.stringify({ id }) }); toast('삭제했습니다'); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}

// ════════ 검토 큐(#638) — 자동 인입이 정책상 pending 으로 격리한 지식을 승인/반려. ════════
async function reviewQueuePanel(detail, data) {
  const reload = () => reviewQueuePanel(detail, data);
  detail.replaceChildren(el('div', { class: 'card' }, skeleton('검토 대기 지식을 불러오는 중')));
  let items; let obs: any = null;
  try { const r = await api('/api/ui/knowledge?lifecycle=pending&orderBy=updated_at'); items = (r && r.entries) || []; }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '검토 큐를 불러오지 못했습니다'))); return; }
  try { obs = await api('/api/ui/org/ingest-observability?days=30'); } catch { obs = null; }
  const igStat = (label, val, hint) => el('div', { class: 'ig-stat', title: hint, style: 'flex:1 1 110px;min-width:100px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg-tint)' },
    el('b', { style: 'display:block;font-size:22px;font-weight:800;color:var(--ink);font-variant-numeric:tabular-nums', text: String(val) }),
    el('span', { style: 'font-size:11px;color:var(--muted)', text: label }));
  const statBox = obs ? el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin:2px 0 14px' },
    igStat('검토 대기', obs.pending_now, '지금 승인을 기다리는 지식'),
    igStat('최근 승인', obs.approved, obs.days + '일 내 pending→승인'),
    igStat('최근 반려', obs.rejected, obs.days + '일 내 pending 반려(삭제)'),
    igStat('게이트 격리', obs.pending_created, obs.days + '일 내 정책이 검토 큐로 보낸 수'),
    igStat('미러 자동통과', obs.mirror_auto, obs.days + '일 내 커넥터 미러가 즉시 반영')) : null;

  const rows = el('div', { class: 'wikicat-rows' });
  if (!items.length) rows.append(el('div', { class: 'wikicat-empty', text: '검토 대기 중인 지식이 없습니다. (자동 인입이 허용선 정책상 confirm 대상일 때 여기에 쌓입니다.)' }));
  for (const k of items) {
    const prov = k.provenance === 'observed' ? '커넥터 미러' : '자료 distill';
    const main = el('div', { class: 'wikicat-row-main' },
      el('span', { class: 'wikicat-name', text: k.title || k.name }),
      el('span', { class: 'wikicat-key mono', text: (k.type || '지식') + ' · ' + prov + (k.source ? ' · ' + k.source : '') }),
      el('span', { class: 'wikicat-should' }, el('span', { class: 'wikicat-should-label', text: '수집' }), relTime(k.updated_at)));
    const acts = el('div', { class: 'wikicat-row-acts' },
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge/' + encodeURIComponent(k.name), text: '열기' }),
      el('button', { class: 'btn btn-primary btn-sm', text: '✓ 승인', onclick: () => reviewApprove(k.name, reload) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '✕ 반려', onclick: () => reviewReject(k.name, reload) }));
    rows.append(el('div', { class: 'wikicat-row' }, main, acts));
  }
  const head = el('div', { class: 'wikicat-grouphead' },
    el('span', { class: 'wikicat-grouptitle', text: '검토 대기' }),
    el('span', { class: 'wikicat-groupcount', text: String(items.length) }));
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '검토 큐 (자동 인입)' })),
    el('p', { class: 'admin-hint', text: '자동 인입(커넥터 미러·자료 distill)이 허용선 정책상 “검토 대기(pending)”로 격리한 지식입니다. 승인 전에는 검색·세션 주입·목록에 뜨지 않습니다. 열어서 정확성(할루시네이션·최신성)을 확인하고 승인하면 지식이 되고, 반려하면 삭제(휴지통, 복원 가능)됩니다. 승인/반려는 변경 감사에 기록됩니다.' }),
    statBox,
    el('div', { class: 'wikicat' }, el('div', { class: 'wikicat-group' }, head, rows)));
  detail.replaceChildren(card);
}
async function reviewApprove(name, reload) {
  try { await api('/api/ui/knowledge/' + encodeURIComponent(name) + '/lifecycle', { method: 'POST', body: JSON.stringify({ lifecycle: 'active' }) }); toast('승인 — 지식으로 반영했습니다'); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}
async function reviewReject(name, reload) {
  if (!confirm('이 지식을 반려(삭제)할까요? 휴지통으로 이동해 복원할 수 있습니다.')) return;
  try { await api('/api/ui/knowledge/' + encodeURIComponent(name) + '/delete', { method: 'POST' }); toast('반려했습니다'); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}

// ── 상시 세션(에이전트) — 항상 떠있는 에이전트 세션 CRUD + 격리 워크스페이스 + keep-alive. 크론(map_unmapped 등)이 타깃. ──
//  '에이전트를 위한 프로젝트' — createSession + 공유폴더(managed/<id>) 재사용. account=라이블리 계정/프로필(클로드 로그인, 멀티프로필 대비).
async function managedSessionsPanel(detail, data) {
  const reload = () => managedSessionsPanel(detail, data);
  detail.replaceChildren(el('div', { class: 'card' }, skeleton('상시 세션을 불러오는 중')));
  let sessions; let live: string[] = [];
  try { const r = await api('/api/ui/managed-sessions'); sessions = (r && r.sessions) || []; }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '상시 세션을 불러오지 못했습니다'))); return; }
  try { const t = await api('/api/ui/terminal/sessions'); live = ((t && t.sessions) || []).map((s) => s.id); } catch { /* 세션목록 실패 무시 */ }

  const rows = el('div', { class: 'wikicat-rows' });
  if (!sessions.length) rows.append(el('div', { class: 'wikicat-empty', text: '아직 상시 세션이 없습니다. ‘+ 상시 세션 추가’로 등록하면 keep-alive 가 항상 띄워둡니다.' }));
  for (const m of sessions) {
    const alive = m.session_id && live.includes(m.session_id);
    const main = el('div', { class: 'wikicat-row-main' },
      el('span', { class: 'wikicat-name', text: m.label || m.id }),
      el('span', { class: 'wikicat-key mono', text: (m.account || '계정 미지정') + ' · ' + (m.harness || 'claude') }),
      el('span', { class: 'dm-tag', text: m.enabled ? (alive ? '실행중' : '대기(재생성 예정)') : '비활성' }),
      el('span', { class: 'wikicat-should' }, el('span', { class: 'wikicat-should-label', text: '세션' }), m.session_id || '미생성'));
    const acts = el('div', { class: 'wikicat-row-acts' },
      el('button', { class: 'btn btn-ghost btn-sm', text: '띄우기/재생성', onclick: () => managedEnsure(m.id, reload) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: m.enabled ? '끄기' : '켜기', onclick: () => managedToggle(m, reload) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openManagedSessionForm(m, reload) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: () => managedDelete(m.id, reload) }));
    rows.append(el('div', { class: 'wikicat-row' }, main, acts));
  }
  const head = el('div', { class: 'wikicat-grouphead' },
    el('span', { class: 'wikicat-grouptitle', text: '상시 세션' }),
    el('span', { class: 'wikicat-groupcount', text: String(sessions.length) }),
    el('button', { class: 'btn btn-ghost btn-sm wikicat-add', text: '+ 상시 세션 추가', onclick: () => openManagedSessionForm(null, reload) }));
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '상시 세션 (에이전트)' })),
    el('p', { class: 'admin-hint', text: '항상 떠 있는 에이전트 세션입니다. 격리 워크스페이스(공유폴더)에서 돌고, keep-alive 가 죽으면 재생성합니다. 크론(미매핑 분류 등)이 이 세션에 작업을 쏩니다 — 팀플랜 과금. account = 어떤 라이블리 계정(클로드 로그인)으로 띄울지.' }),
    el('div', { class: 'wikicat' }, el('div', { class: 'wikicat-group' }, head, rows)));
  detail.replaceChildren(card);
}

function openManagedSessionForm(m, reload) {
  const isNew = !m;
  const inputStyle = 'width:100%;padding:6px 8px;font:inherit;box-sizing:border-box';
  const block = (title, hint, ctrl) => el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: title }),
    hint ? el('p', { class: 'ps-block-hint', text: hint }) : null, ctrl);
  const idInp = el('input', { type: 'text', style: inputStyle, value: m ? m.id : '', placeholder: 'box-map-agent', ...(isNew ? {} : { disabled: true }) });
  const labelInp = el('input', { type: 'text', style: inputStyle, value: (m && m.label) || '', placeholder: '도메인 분류 배치 LLM' });
  const account = memberCombo({ value: (m && m.account) || '', placeholder: '구성원 id 선택/검색 (예: daon)' });
  const wsInp = el('input', { type: 'text', style: inputStyle, value: (m && m.workspace_subpath) || '', placeholder: '비우면 managed/<id>' });
  const harnessSel = el('select', { style: inputStyle });
  for (const h of ['claude', 'codex', 'shell']) harnessSel.append(el('option', { value: h, text: h, ...((m && m.harness === h) ? { selected: true } : {}) }));
  // 모델·effort = claude 하네스 플래그(--model/--effort) → flags JSONB. 세션 스폰 시 claude argv 로 적용.
  const mflags = (m && m.flags) || {};
  const modelSel = el('select', { style: inputStyle });
  for (const v of ['', 'opus', 'sonnet', 'haiku']) modelSel.append(el('option', { value: v, text: v || '(기본)', ...((mflags['--model'] === v) ? { selected: true } : {}) }));
  const effortSel = el('select', { style: inputStyle });
  for (const v of ['', 'low', 'medium', 'high', 'xhigh', 'max']) effortSel.append(el('option', { value: v, text: v || '(기본)', ...((mflags['--effort'] === v) ? { selected: true } : {}) }));
  const autoChk = el('input', { type: 'checkbox', ...((m ? m.auto_approve : true) ? { checked: true } : {}) });
  const enabledChk = el('input', { type: 'checkbox', ...((m ? m.enabled : true) ? { checked: true } : {}) });
  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: isNew ? '상시 세션 추가' : '저장' });
  const form = el('div', { class: 'proj-settings' },
    block('세션 id', isNew ? '소문자 슬러그(a-z0-9_-). 고유 키.' : 'id 는 변경 불가.', idInp),
    block('이름', '관리 목록·세션 탭에 보일 이름.', labelInp),
    block('라이블리 계정/프로필', '이 세션을 띄울 클로드 로그인(프로필=구성원). 목록에서 고르거나 입력. 각 프로필은 provision + 웹터미널 /login 후 사용.', account.el),
    block('격리 워크스페이스(하위경로)', '공유폴더 아래 이 세션 전용 작업폴더. 비우면 managed/<id>.', wsInp),
    block('하네스', '', harnessSel),
    block('모델 (claude)', '이 세션의 claude 모델. 판단 무거운 작업(부트스트랩·분류)은 opus 권장. 비우면 기본.', modelSel),
    block('effort (claude)', '추론 강도(low~max). 무거운 판단은 high+ 권장. 비우면 기본.', effortSel),
    block('자동 승인', '도구 실행을 묻지 않고 진행(무인 작업에 필요).', el('label', { class: 'inline' }, autoChk, el('span', { text: ' --dangerously-skip-permissions' }))),
    block('항상 켬(keep-alive)', '죽으면 재생성.', el('label', { class: 'inline' }, enabledChk, el('span', { text: ' enabled' }))),
    el('div', { class: 'ps-rules-actions' }, saveBtn));
  const back = overlayBox(isNew ? '상시 세션 추가' : '상시 세션 수정 — ' + m.id, form);
  const boxw = back.querySelector('.ov-box'); if (boxw) boxw.classList.add('ov-box-wide');
  saveBtn.onclick = async () => {
    const id = idInp.value.trim();
    if (!id) { toast('세션 id 가 필요합니다', true); return; }
    const flags: Record<string, string> = {};
    if (harnessSel.value === 'claude') { // model/effort 는 claude 플래그 — 다른 하네스엔 flags 미전송(기존 보존)
      if (modelSel.value) flags['--model'] = modelSel.value;
      if (effortSel.value) flags['--effort'] = effortSel.value;
    }
    const body = { id, label: labelInp.value.trim() || null, account: account.value() || null,
      workspace_subpath: wsInp.value.trim() || null, harness: harnessSel.value,
      auto_approve: autoChk.checked, enabled: enabledChk.checked,
      ...(harnessSel.value === 'claude' ? { flags } : {}) };
    saveBtn.disabled = true;
    try { await api('/api/ui/managed-sessions', { method: 'POST', body: JSON.stringify(body) }); toast(isNew ? '추가했습니다 (켜져 있으면 곧 keep-alive 가 띄웁니다)' : '저장했습니다'); back.remove(); reload(); }
    catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
}

async function managedEnsure(id, reload) {
  try { const r = await api('/api/ui/managed-sessions/' + encodeURIComponent(id) + '/ensure', { method: 'POST' }); toast('세션: ' + ((r && r.action) || 'ok') + (r && r.session_id ? ' (' + r.session_id + ')' : '')); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}
async function managedToggle(m, reload) {
  try { await api('/api/ui/managed-sessions', { method: 'POST', body: JSON.stringify({ id: m.id, enabled: !m.enabled }) }); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}
async function managedDelete(id, reload) {
  if (!confirm('상시 세션 등록 ‘' + id + '’을(를) 삭제할까요? (살아있는 터미널 세션은 별도로 종료)')) return;
  try { await api('/api/ui/managed-sessions/' + encodeURIComponent(id) + '/delete', { method: 'POST' }); toast('삭제했습니다'); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}

// ── 레포(git) 관리 — repo 테이블(=실제 git 레포)을 등록·git 연결·폐기·삭제. ──
//  레거시('repo 통제어휘 CRUD' = repo>domain vocab 계층, 웹 미와이어)를 폐기하고 git 레포 관리로 대체.
//  repo 는 code_unit 이 매핑되는 실 git 레포다. 여기 설정한 git_url/default_branch 는 도메인맵 스캔(webhook)과
//  '내 컴퓨터에서 작업' 클론이 함께 쓰는 단일 소스. 편집은 context 스코프(없으면 읽기 전용).
async function reposPanel(detail, data) {
  const canEdit = state.admin.canContext;
  const reload = () => reposPanel(detail, data);
  detail.replaceChildren(el('div', { class: 'card' }, skeleton('레포를 불러오는 중')));
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
        el('span', { class: 'wikicat-key mono', text: (t.code_units || 0) + ' code · ' + (t.domains || 0) + ' dom' }),
        deprecated ? el('span', { class: 'dm-tag', text: '폐기됨' }) : null,
        meta);
      const acts = canEdit ? el('div', { class: 'wikicat-row-acts' },
        el('button', { class: 'btn btn-ghost btn-sm', text: '⟳ 최신화', title: '이 레포의 공유 클론을 upstream 으로 최신화(fetch + fast-forward). 게이트웨이가 당겨오므로 모든 멤버가 최신 코드를 읽게 됩니다.', onclick: (e) => repoRefreshShared(r.name, e) }),
        el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openRepoForm(r, reload) }),
        el('button', { class: 'btn btn-ghost btn-sm', text: deprecated ? '복귀' : '폐기', onclick: () => repoSetDeprecated(r.name, deprecated, reload) }),
        el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: () => repoHardDelete(r.name, reload) })) : null;
      rows.append(el('div', { class: 'wikicat-row' }, main, acts));
    }
  }

  const head = el('div', { class: 'wikicat-grouphead' },
    el('span', { class: 'wikicat-grouptitle', text: '레포' }),
    el('span', { class: 'dm-tag', text: 'git' }),
    el('span', { class: 'wikicat-groupcount', text: String(repos.length) }));
  if (canEdit) head.append(el('button', { class: 'btn btn-ghost btn-sm wikicat-add', text: '+ 레포 추가', onclick: () => openRepoForm(null, reload) }));

  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '레포(git) 관리' }),
      state.admin.canEdit ? el('button', { class: 'btn btn-ghost btn-sm', text: '게이트웨이 git 계정', onclick: () => openGitCredentialManager('gateway') }) : null,
      canEdit ? null : el('span', { class: 'admin-sub' }, el('span', { class: 'pill', text: '읽기 전용' }), ' 편집은 context 권한 필요')),
    el('p', { class: 'admin-hint', text: '코드 레포(실제 git 레포)를 등록·연결합니다. 여기 설정한 git 주소·기본 브랜치는 도메인맵 스캔과 ‘내 컴퓨터에서 작업’ 클론이 함께 씁니다. 레포는 code_unit 이 매핑되는 단위예요. private 레포 클론 인증은 [게이트웨이 git 계정] 또는 각 구성원의 [내 프로필 ▸ git 인증]에서 설정합니다. HTTPS 가 막힌 셀프호스팅(GitLab 등)은 git 주소를 SSH 형(git@호스트:그룹/레포.git)으로 넣으세요.' }),
    el('div', { class: 'wikicat' }, el('div', { class: 'wikicat-group' }, head, rows)));
  detail.replaceChildren(card);
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
function openRepoForm(repo, reload) {
  const isNew = !repo;
  const inputStyle = 'width:100%;padding:6px 8px;font:inherit;box-sizing:border-box';
  const nameInp = el('input', { type: 'text', style: inputStyle, value: repo ? repo.name : '', placeholder: 'context-ontology' });
  const urlInp = el('input', { type: 'text', style: inputStyle, value: (repo && repo.clone_url) || '', placeholder: 'https://github.com/org/repo.git' });
  const branchInp = el('input', { type: 'text', style: inputStyle, value: (repo && repo.default_branch) || 'main', placeholder: 'main' });
  const block = (title, hint, ctrl) => el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: title }),
    hint ? el('p', { class: 'ps-block-hint', text: hint }) : null, ctrl);
  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: isNew ? '레포 추가' : '저장' });
  const form = el('div', { class: 'proj-settings' },
    block('레포 이름', isNew ? '실제 git 레포 이름 — code_unit 이 이 이름으로 매핑됩니다.' : '이름을 바꿔도 매핑·도메인은 보존됩니다.', nameInp),
    block('git 주소 (clone URL)', '도메인맵 스캔과 로컬 작업 클론이 이 주소를 씁니다. 비우면 git 미연결.', urlInp),
    block('기본 브랜치', '비우면 main.', branchInp),
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
// ── WIKI 카테고리 관리 — 지식(위키)의 분류축(사업·제품·시스템 카테고리) CRUD. 제품 카테고리=도메인. ──
//  카테고리 탭(#/categories)과 동일한 category-store(/api/ui/categories) — 여기 변경이 지식·프로젝트 탭 좌측에 반영.
//  space 탭으로 나누지 않고 한 화면에 전부(컴팩트 표 — fields-table 재사용). 편집은 context 스코프(없으면 읽기 전용).
async function wikiCategoriesPanel(detail, data) {
  const canEdit = state.admin.canContext;
  const reload = () => wikiCategoriesPanel(detail, data);

  detail.replaceChildren(el('div', { class: 'card' }, skeleton('카테고리를 불러오는 중')));

  // 전 space 카테고리를 한 번에 — space 별로 묶어 컴팩트 표로(탭 분리 없음). 팀 목록도 함께(오너 드롭다운 옵션).
  let bySpace: any; let teams: any[] = [];
  try {
    const [lists, teamList] = await Promise.all([
      Promise.all(SPACE_SUBS.map((s) =>
        api('/api/ui/categories?' + new URLSearchParams({ space: s.key })).then((d) => (d && d.categories) || []))),
      api('/api/ui/teams').then((d) => (d && d.teams) || []).catch(() => []),
    ]);
    bySpace = {}; SPACE_SUBS.forEach((s, i) => { bySpace[s.key] = lists[i]; });
    teams = teamList;
  } catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '카테고리를 불러오지 못했습니다'))); return; }

  // calm 리스트(무채·헤어라인·아웃라인 — domain-map 톤). space 별 그룹 + 균일 단일행. 빈 should 열은 두지 않는다.
  const list = el('div', { class: 'wikicat' });
  for (const s of SPACE_SUBS) {
    const items = bySpace[s.key] || [];
    const isProduct = s.key === 'product';
    const head = el('div', { class: 'wikicat-grouphead' },
      el('span', { class: 'wikicat-grouptitle', text: s.label }),
      isProduct ? el('span', { class: 'dm-tag', text: '도메인' }) : null,
      el('span', { class: 'wikicat-groupcount', text: String(items.length) }));
    if (canEdit) head.append(el('button', { class: 'btn btn-ghost btn-sm wikicat-add', text: '+ 추가', onclick: () => openCategoryForm(s.key, null, reload) }));

    const rows = el('div', { class: 'wikicat-rows' });
    if (!items.length) {
      rows.append(el('div', { class: 'wikicat-empty', text: '아직 없습니다.' }));
    } else {
      for (const c of items) {
        const should = (c.should || '').trim();
        // 정의·범위·규칙(should) — 수정에 들어가기 전에도 항상 노출. 비었으면 '있고 수정 가능'을 알리는 placeholder.
        const shouldLine = should
          ? el('span', { class: 'wikicat-should', title: should },
              el('span', { class: 'wikicat-should-label', text: '정의·범위·규칙' }), should)
          : el('span', { class: 'wikicat-should wikicat-should-empty' },
              el('span', { class: 'wikicat-should-label', text: '정의·범위·규칙' }),
              canEdit ? '미설정 — 수정에서 추가할 수 있어요' : '미설정');
        // 오너 팀 — 카테고리 소유(표면화·주입의 '우리 팀' 기준). canEdit 면 드롭다운(이양), 아니면 표시만. 오너십=우선순위, 접근제한 아님.
        let ownerEl: any = null;
        if (canEdit) {
          const ownerSel = el('select', { class: 'wikicat-owner-sel' },
            el('option', { value: '', text: '— 오너 없음 —' }),
            ...teams.map((t) => el('option', { value: String(t.id), text: t.name || t.key }))) as HTMLSelectElement;
          ownerSel.value = c.owner_team_id ? String(c.owner_team_id) : '';
          ownerSel.addEventListener('change', async () => {
            const prev = c.owner_team_id ? String(c.owner_team_id) : '';
            try {
              await api('/api/ui/categories/' + c.id + '/owner', { method: 'POST',
                body: JSON.stringify({ team_id: ownerSel.value ? Number(ownerSel.value) : null }) });
              c.owner_team_id = ownerSel.value ? Number(ownerSel.value) : null;
              toast('오너 팀을 변경했습니다');
            } catch (e) { toast(e.message, true); ownerSel.value = prev; }
          });
          ownerEl = el('span', { class: 'wikicat-owner' }, el('span', { class: 'wikicat-owner-label', text: '오너 팀' }), ownerSel);
        } else if (c.owner_team_name) {
          ownerEl = el('span', { class: 'wikicat-owner' },
            el('span', { class: 'wikicat-owner-label', text: '오너 팀' }),
            el('span', { class: 'wikicat-owner-name', text: c.owner_team_name }));
        }
        const main = el('div', { class: 'wikicat-row-main' },
          el('span', { class: 'wikicat-name', text: c.name || c.key }),
          el('span', { class: 'wikicat-key mono', text: c.key }),
          c.cross_cutting ? el('span', { class: 'dm-tag', text: '횡단' }) : null,
          ownerEl,
          shouldLine);
        const acts = canEdit ? el('div', { class: 'wikicat-row-acts' },
          el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openCategoryForm(s.key, c, reload) }),
          el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: () => deleteWikiCategory(c, reload) })) : null;
        rows.append(el('div', { class: 'wikicat-row' }, main, acts));
      }
    }
    list.append(el('div', { class: 'wikicat-group' }, head, rows));
  }

  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '분류 체계 관리' }),
      canEdit ? null : el('span', { class: 'admin-sub' }, el('span', { class: 'pill', text: '읽기 전용' }), ' 편집은 context 권한 필요')),
    el('p', { class: 'admin-hint', text: '지식(위키)의 분류축입니다. 사업·제품·시스템 카테고리를 한 화면에서 추가·수정·삭제하며, 변경은 지식·프로젝트 탭 좌측 카테고리에 그대로 반영됩니다. (제품 카테고리=도메인)' }),
    list);
  detail.replaceChildren(card);
}

// WIKI 카테고리 삭제(확인 후) — categoryCard 의 삭제 로직과 동일 엔드포인트. reload 로 패널 갱신.
async function deleteWikiCategory(c, reload) {
  if (!confirm('‘' + (c.name || c.key) + '’ 카테고리를 삭제할까요? (연결된 매핑·엣지도 함께 정리됩니다)')) return;
  try { await api('/api/ui/categories/' + c.id + '/delete', { method: 'POST' }); toast('삭제했습니다'); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}


// ── 섹션(강제규칙·회사맥락) markdown 에디터 — 기본은 구성원에게 보이는 읽기 전용 뷰, 관리자는 [수정]을 눌러야 편집 ──
function sectionEditor(detail, key, data) {
  const canEdit = state.admin.canEdit;
  const meaning = data.meaning[key];
  const sec = data.sections[key] || { body_md: '', version: 0 };
  const title = meaning ? meaningOf(meaning).label : key;
  const isScaffold = SCAFFOLD_SECTIONS.includes(key);
  // 골격 섹션 기본값(되돌리기·미편집 프리필) — 서버가 sectionDefaults 로 내려준다. 없으면 현재 본문 폴백(안전).
  const defaultBody = (data.sectionDefaults && data.sectionDefaults[key]) || sec.body_md || '';

  // editing 은 로컬 상태 — 섹션에 진입(renderAdminDetail 재호출)할 때마다 항상 읽기 전용으로 시작.
  //  prefill 지정 시 textarea 를 그 값으로 채운다(되돌리기에서 기본값 프리필 — 저장 전까지 DB 미반영).
  function render(editing?, prefill?) {
    const ta = el('textarea', { rows: '18', class: 'admin-ta', 'aria-label': title });
    ta.value = (prefill != null) ? prefill : (sec.body_md || '');
    ta.readOnly = !editing;

    // 기본값으로 되돌리기 — 골격 섹션은 읽기/수정 모두 상단에 노출(발견성). 클릭=텍스트영역에 기본값 채움(저장은 [저장]으로 확정).
    const resetToDefault = () => {
      toast('기본값을 불러왔어요 — [저장]을 눌러 확정하세요');
      if (editing) { ta.value = defaultBody; ta.focus(); }
      else render(true, defaultBody); // 보기 모드면 기본값 채운 수정 모드로 진입
    };
    // 미리보기 — 가이드 섹션은 '이 편집 부분만'(${area}/${rules} 채워진 인덱스), 그 외는 전체 멤버 컨텍스트.
    const headBtns = el('div', { class: 'card-head-actions' },
      el('button', { class: 'btn btn-ghost btn-sm', text: '미리보기',
        onclick: isScaffold ? (() => showGuidePreview(ta.value)) : showMemberPreview }),
      (canEdit && isScaffold)
        ? el('button', { class: 'btn btn-ghost btn-sm', text: '기본값으로 되돌리기', onclick: resetToDefault })
        : null,
      canEdit
        ? (editing
            ? el('button', { class: 'btn btn-ghost btn-sm', text: '보기', onclick: () => render(false) })
            : el('button', { class: 'btn btn-primary btn-sm', text: '수정', onclick: () => render(true) }))
        : null);

    const body = [
      el('div', { class: 'card-head' },
        el('div', { class: 'section-title' }, el('h2', { text: title }), meaningCard(meaning)),
        headBtns),
    ];
    // 골격 섹션 — 비개발자용 경고 배너(무엇인지 한 줄 + 공통 위험 안내). 읽기/수정 모두 항상 표시.
    if (isScaffold) {
      body.push(el('div', { class: 'admin-warn' },
        el('div', { text: SCAFFOLD_WARN[key] || '' }),
        el('div', { style: 'margin-top:5px;font-weight:500', text: SCAFFOLD_WARN_COMMON })));
    }
    body.push(el('p', { class: 'admin-hint', text: editing
        ? '여기 적은 내용은 [저장]하면 구성원이 다음 설치/업데이트 때 자동으로 받아요(저장 전엔 나만 보는 초안).'
        : (canEdit ? '구성원에게 보이는 모습이에요. 고치려면 [수정]을 누르세요.' : '읽기 전용 — 이 내용이 모든 구성원의 AI에 깔립니다.') }));
    // 가이드 섹션 — 플레이스홀더(${area}/${rules}) 안내. [미리보기]로 채워진 실제 모습을 볼 수 있다고 덧붙임.
    if (isScaffold) {
      body.push(el('p', { class: 'admin-hint', text: GUIDE_PLACEHOLDER_HINT + ' [미리보기]로 실제 채워진 모습을 볼 수 있어요.' }));
    }
    body.push(ta);

    if (editing) {
      const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
      const status = el('span', { class: 'admin-status' });
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          const r = await api('/api/ui/org/section', { method: 'POST', body: JSON.stringify({ section: key, body_md: ta.value }) });
          data.sections[key] = r.section;
          sec.body_md = r.section.body_md; sec.version = r.section.version; // [보기] 전환 시 최신본 노출
          status.textContent = '저장됨 · v' + r.section.version;
          toast('저장됨 — 구성원이 다음 설치/업데이트 때 자동으로 받아요');
        } catch (e) { toast(e.message, true); status.textContent = ''; }
        saveBtn.disabled = false;
      });
      // '기본값으로 되돌리기'는 상단 버튼 줄(headBtns)로 이동 — 읽기/수정 모두에서 보이게(발견성).
      body.push(el('div', { class: 'admin-actions' }, saveBtn, status));
    }

    detail.replaceChildren(el('div', { class: 'card' }, ...body));
  }

  render(false);
}

// 멤버가 실제 읽는 컨텍스트 미리보기(WYSIWYG) — 오버레이.
async function showMemberPreview() {
  try {
    const r = await api('/api/ui/org/preview');
    overlay('구성원의 AI가 매 세션 실제로 읽는 내용',
      el('p', { class: 'admin-hint', text: '아래가 모든 구성원의 대화 첫머리에 주입되는 정적 컨텍스트입니다(라이브 현황은 별도로 매 세션 자동 추가).' }),
      el('div', { class: 'md-rendered admin-md-box', style: 'max-height:70vh; overflow:auto' }, renderMarkdown(r.context || '(비어 있음)')));
  } catch (e) { toast(e.message, true); }
}

// 컨텍스트 온톨로지 가이드 미리보기 — '이 편집 부분만'(${area}/${rules} 채워진 Knowledge Index). 편집 중 textarea 값을 보낸다(미저장 반영).
async function showGuidePreview(bodyMd) {
  try {
    const r = await api('/api/ui/org/guide-preview', { method: 'POST', body: JSON.stringify({ body_md: bodyMd || '' }) });
    overlay('이 가이드가 실제 주입되는 모습 (지식·주제·핀 자동 채움)',
      el('p', { class: 'admin-hint', text: '아래는 이 편집 내용의 ${rules}(항상-주입 지식)·${categories}(카테고리 지도)·${wiki}(WIKI 인덱스 핀) 가 실제 데이터로 채워져 매 대화에 주입되는 부분입니다(회사 소개·규칙 섹션 등 다른 부분은 제외).' }),
      el('div', { class: 'md-rendered admin-md-box', style: 'max-height:70vh; overflow:auto' }, renderMarkdown(r.context || '(비어 있음)')));
  } catch (e) { toast(e.message, true); }
}

// ── 구성원 ──
// 중앙박스 계정 격리(#524) — 구성원별 OS 유저(box_<slug>, 홈700)로 완전 격리. #346 멀티프로필(CLAUDE_CONFIG_DIR)은
//  흡수됨(격리 시 멤버 네이티브 ~/.claude 사용) → '프로필 만들기' 버튼 은퇴. 프로비저닝은 '첫 세션에 자동'(lazy) —
//  여긴 격리 상태 표시 + (선택) 미리 생성·재프로비저닝. provision 엔드포인트(#346)는 비격리 폴백용으로 코드에만 잔존.
async function profilesEditor(detail) {
  const reload = () => profilesEditor(detail);
  detail.replaceChildren(el('div', { class: 'card' }, skeleton('프로필 상태를 불러오는 중')));
  let r;
  try { r = await api('/api/ui/terminal/profiles'); }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '프로필을 불러오지 못했습니다'))); return; }
  const profiles = r.profiles || [];
  const items = profiles.length ? profiles.map((p) => {
    // OS-유저 격리(#524) — 구성원별 OS 계정(box_<slug>, 홈700). secure-by-default: 인프라 설치된 박스에서 그 멤버가
    //  웹터미널 '첫 세션'을 열면 box_ 가 자동 생성(lazy)되고 그 세션부터 자기 계정으로 격리. 자격증명이 uid 로 상호열람 차단.
    //  #346 멀티프로필은 흡수됨(격리 시 네이티브 ~/.claude) → 프로필 버튼 없음. 아래는 상태 + (선택)미리생성/재프로비저닝.
    const os = p.os || {};
    const kids: any[] = [];
    const stateText = !os.ready ? '🔒 인프라 미설치 — 비격리(공유 계정) 폴백'
      : os.provisioned ? '🔒 격리됨: ' + (os.osUser || '') + ' ✓ · 세션 자동 격리'
        : '⏳ 첫 세션에 자동 격리 (' + (os.osUser || 'box_…') + ')';
    kids.push(el('div', {}, el('strong', { text: p.name }), el('span', { class: 'caption', text: '  ' + p.id + ' · ' + stateText })));
    // #549: 이 멤버가 admin/runtime scope 를 가지면, 프로비저닝 토큰에 그 관리 권한을 실을지 admin 이 선택(기본 off).
    //  멤버 scope 가 상한이라 이 체크박스는 admin/runtime 보유 멤버에만 뜬다. 체크 시 이 계정 세션이 관리 MCP(org_*)를 직접 쓴다.
    const hasCtrl = (p.scopes || []).some((s) => s === 'admin' || s === 'runtime');
    let cpChk: any = null;
    if (hasCtrl) {
      cpChk = el('input', { type: 'checkbox', style: 'margin-right:6px;vertical-align:middle' });
      kids.push(el('label', { class: 'caption', style: 'display:block;margin:3px 0 7px;cursor:pointer' },
        cpChk, el('span', { text: '관리 권한(admin/runtime) 포함 — 이 계정으로 뜬 세션이 관리탭 기능(구성원·토큰·훅·DB소스)을 MCP로 직접 다룹니다. 변경은 감사에 AI로 남습니다(#549).' })));
    }
    const cp = () => !!(cpChk && cpChk.checked);
    if (!os.ready) {
      kids.push(el('div', { class: 'caption', text: '박스에서 deploy/linux/install-isolation.sh 실행 시 자동 격리가 켜집니다.' }));
    } else if (!os.provisioned) {
      // 자동이지만, 첫 세션 지연(수십초) 없이 미리 깔고 싶으면.
      kids.push(el('button', { class: 'btn btn-ghost btn-sm', text: '지금 미리 만들기', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '생성 중… (수십초)';
        try { await api('/api/ui/terminal/members/provision-os', { method: 'POST', body: JSON.stringify({ member: p.id, includeControlPlane: cp() }) }); toast('OS 격리 유저 생성됨 — 이 멤버 세션이 본인 계정으로 격리됩니다' + (cp() ? ' (관리 권한 포함)' : '')); reload(); }
        catch (e) { btn.disabled = false; btn.textContent = '지금 미리 만들기'; toast('실패 — ' + e.message, true); }
      } }));
    } else {
      kids.push(el('button', { class: 'btn btn-ghost btn-sm', text: '재프로비저닝(격리·토큰 갱신)', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '갱신 중…';
        try { await api('/api/ui/terminal/members/provision-os', { method: 'POST', body: JSON.stringify({ member: p.id, includeControlPlane: cp() }) }); toast('재프로비저닝됨 — 로그인·실행중 세션 유지, 새 세션부터 새 토큰' + (cp() ? ' (관리 권한 포함)' : '')); reload(); }
        catch (e) { btn.disabled = false; btn.textContent = '재프로비저닝(격리·토큰 갱신)'; toast('실패 — ' + e.message, true); }
      } }));
    }
    return el('div', { class: 'card' }, ...kids);
  }) : [el('p', { class: 'caption', text: '구성원이 없습니다.' })];
  detail.replaceChildren(
    el('div', { class: 'card' },
      el('h3', { text: '중앙박스 계정 격리' }),
      el('p', { class: 'caption', text: '각 구성원은 자기 OS 계정(box_<slug>, 홈 700)으로 완전 격리됩니다 — 구성원 간 Claude 자격증명(.credentials.json) 상호열람 차단(외부상주·금융권). 격리 인프라(deploy/linux/install-isolation.sh)가 깔린 박스에서 구성원이 웹터미널을 처음 열면 격리 유저가 자동 생성되고(별도 버튼 불요), 그 세션부터 본인 Claude 로그인으로 뜹니다. 미프로비저닝 멤버는 공유 계정으로 폴백(무회귀). 첫 세션 지연 없이 미리 깔려면 [지금 미리 만들기], 끄려면 게이트웨이 env LIVELY_MEMBER_ISOLATION=off.' })),
    ...items);
}

// ── 구성원 관리(#613) — 3~40명 규모에서도 훑기 쉽게. 아바타 카드 '그리드'가 항상 전체 폭을 채우고
//  (세로로 죽 늘어지고 오른쪽이 비던 문제 해소), 카드를 누르면 상세/편집을 '모달 오버레이'로 띄운다
//  (#613 후속 — 옛 좌우 2단 collapse 가 어색하다는 피드백. 이 파일의 다른 표면(메모리 그리드·태스크 상세)과 동일한 그리드+팝업 패턴).
//  상단 검색으로 이름·이메일·아이디·종류를 실시간 필터 — 입력은 리스트 컨테이너만 다시 그려(renderRows) 포커스를 잃지 않는다.
function membersEditor(detail, data) {
  const canEdit = state.admin.canEdit;
  const meaning = data.meaning['member'];
  const members = data.members || [];

  // 한 구성원 카드 — 누르면 모달로 상세/편집을 연다(그리드는 그대로 유지).
  const memberRow = (m) => {
    const meta = canEdit
      ? (m.kind || 'human') + (m.email ? ' · ' + m.email : '')
      : (m.kind || 'human') + (m.state && m.state !== 'active' ? ' · ' + m.state : '');
    return el('div', { class: 'mini-row member-row',
      onclick: () => openMemberModal(m, data, detail) },
      profileAvatar(m.avatar || null, m.display_name || m.id, m.id, 'member-ava', { char: m.avatar_char, color: m.avatar_color }),
      el('div', { class: 'member-row-body' },
        el('div', { class: 'mini-title' },
          el('span', { class: 'member-name', text: (m.display_name || m.id) }),
          canEdit ? (m.hasToken ? el('span', { class: 'pill pill-ok', text: '설치됨' }) : el('span', { class: 'pill', text: '미설치' })) : null),
        el('div', { class: 'mini-meta', text: meta })));
  };

  // 리스트 영역 — 검색 시 이 컨테이너만 replaceChildren 해서 입력 포커스를 보존한다.
  const listCol = el('div', { class: 'admin-sublist admin-sublist-row' });
  const renderRows = () => {
    const q = (state.admin.memberSearch || '').trim().toLowerCase();
    const shown = q
      ? members.filter((m) => [m.display_name, m.id, m.email, m.kind].filter(Boolean).join(' ').toLowerCase().includes(q))
      : members;
    listCol.replaceChildren();
    if (!shown.length) {
      listCol.append(el('p', { class: 'admin-member-empty',
        text: members.length ? '‘' + (state.admin.memberSearch || '') + '’ 검색 결과가 없어요.' : '구성원이 없습니다.' }));
      return;
    }
    for (const m of shown) listCol.append(memberRow(m));
  };
  renderRows();

  const searchInp = el('input', { type: 'search', class: 'admin-member-search',
    value: state.admin.memberSearch || '', autocomplete: 'off', spellcheck: 'false', 'aria-label': '구성원 검색',
    placeholder: '이름·이메일·아이디로 검색  (총 ' + members.length + '명)',
    oninput: (e) => { state.admin.memberSearch = e.target.value; renderRows(); } });
  const searchBar = el('div', { class: 'admin-member-searchbar' }, searchInp);

  detail.replaceChildren(el('div', { class: 'card' },
    sectionTitle('구성원 관리', meaning),
    members.length ? searchBar : null,
    listCol));
}

// ── 구성원 상세/편집 모달(#613 후속) — 카드 클릭 시 그리드 위에 오버레이로 띄운다.
//  2단 collapse 대신 모달: 그리드 맥락을 유지한 채 상세를 보고, 닫으면 그리드로 복귀.
//  보기(memberRead) ↔ 편집(memberForm) 을 모달 안에서 토글하고, 저장/제거 시 모달을 닫고 그리드를 새로고침.
function openMemberModal(m, data, detail) {
  const body = el('div', { class: 'member-modal-body' });
  let back: any = null;
  let editing = false;
  const refreshGrid = () => renderAdminDetail(detail, 'members', state.admin.data);
  const closeModal = () => { if (back) { back.remove(); back = null; } };
  const rerender = () => {
    // 저장/리로드 후 최신 멤버 객체를 다시 집는다(이름·권한 변경 반영).
    const cur = ((state.admin.data && state.admin.data.members) || []).find((x) => x.id === m.id) || m;
    if (state.admin.canEdit && editing) {
      memberForm(body, cur, data, detail, false, {
        onSaved: () => { toast('저장됨 — 신원 매칭에 즉시 반영됩니다'); closeModal(); refreshGrid(); },
        onCancel: () => { editing = false; rerender(); }, // 편집 취소 → 모달 안에서 보기로 복귀
        onRemoved: () => { closeModal(); refreshGrid(); },
      });
    } else {
      memberRead(body, cur, data, detail, { onEdit: () => { editing = true; rerender(); } });
    }
  };
  rerender();
  back = overlay('구성원 · ' + (m.display_name || m.id), body);
}

// 구성원 권한(scope) 옵션 — 보기/편집 공유. 서버 SCOPES(capabilities/scopes.ts) 전체와 일치시킨다.
const MEMBER_SCOPE_OPTS = [
  ['items', '아이템 조회'], ['context', '컨텍스트'], ['memory', '지식·메모리'],
  ['db', 'DB 조회'], ['code', '코드 도구'],
  ['admin', '관리자(편집·적용)'], ['runtime', '런타임(훅·툴 정의)'],
];
const MEMBER_SCOPE_LABEL = Object.fromEntries(MEMBER_SCOPE_OPTS);

// 멤버 계정 발급/재설정 시 — 로그인 주소·이메일·임시 비번을 1회 표시(관리자가 1:1 전달). overlay 재사용.
function showInitialAccount(id, name, email, password, data) {
  const gw = ((data && data.profile && data.profile.gateway_url) || location.origin).replace(/\/mcp$/, '').replace(/\/$/, '');
  const webUrl = gw + '/ui/';
  const dn = name || id;
  overlay('로그인 계정 · ' + dn,
    el('p', { class: 'admin-hint', text: dn + ' 님의 로그인 계정 정보예요. 아래를 1:1로(슬랙·메신저 DM 등) 전달하세요 — 비밀번호는 지금만 보입니다.' }),
    field('로그인 주소', el('div', { class: 'admin-ro', text: webUrl })),
    field('이메일 (로그인 아이디)', el('div', { class: 'admin-ro', text: email || '⚠ 이메일 미설정 — 멤버에 이메일을 넣어야 로그인됩니다' })),
    el('div', { class: 'deploy-head' }, el('span', { class: 'mini-meta', text: '임시 비밀번호' }), copyButton(() => password, '비밀번호 복사')),
    el('pre', { class: 'admin-preview', text: password }),
    el('p', { class: 'admin-hint', text: '받은 분은 위 주소에서 이메일+비밀번호로 로그인 → 첫 로그인 시 새 비밀번호를 설정하게 됩니다 → [사용 가이드 › 시작하기]에서 [설치 명령 만들기]로 설치하면 됩니다.' }));
}

// ── 구성원 보기 모드 — [수정]을 누르기 전 기본 화면. 폼이 아니라 읽기 전용 요약을 보여준다. ──
//  권한 있는 사람(canEdit)만 [수정] 버튼이 보이고, 누르면 편집모드로 전환(memberForm). 비-admin 은 버튼 없음.
function memberRead(root, m, data, detail, opts: any = {}) {
  const canEdit = state.admin.canEdit;
  const roRow = (label, value) => field(label, el('div', { class: 'admin-ro', text: value || '—' }));
  const kids = [
    el('div', { class: 'member-read-head' },
      el('h3', { text: m.display_name || m.id }),
      canEdit ? (m.hasToken ? el('span', { class: 'pill pill-ok', text: '설치됨' }) : el('span', { class: 'pill', text: '미설치' })) : null),
  ];
  if (canEdit) {
    const idnText = (m.identities && m.identities.length)
      ? m.identities.map((idn) => idn.system + ':' + idn.external_id + (idn.email ? ' (' + idn.email + ')' : '')).join('\n')
      : '';
    const scopeText = (m.scopes || []).map((sk) => MEMBER_SCOPE_LABEL[sk] ? MEMBER_SCOPE_LABEL[sk] + ' (' + sk + ')' : sk).join(', ');
    kids.push(
      roRow('아이디', m.id),
      roRow('종류', m.kind || 'human'),
      roRow('대표 이메일', m.email),
      roRow('상태', (m.state || 'active') === 'active' ? '활성' : '비활성'),
      roRow('권한 (이 구성원 토큰의 scope)', scopeText),
      field('외부 계정 연결 (신원 매칭 키)', el('div', { class: 'admin-ro admin-ro-pre', text: idnText || '—' })),
      field('개인 레이어', el('div', { class: 'admin-ro admin-ro-pre', text: (m.body_md && m.body_md.trim()) || '—' })));
  } else {
    kids.push(el('div', { class: 'mini-meta', text: '종류: ' + (m.kind || 'human') + ' · 상태: ' + (m.state || 'active') }));
  }
  if (canEdit) {
    const acts = el('div', { class: 'admin-actions' },
      el('button', { class: 'btn btn-primary', text: '수정',
        // 모달에서 열렸으면 opts.onEdit 로 모달 안에서 폼으로 전환(전체 재렌더 대신). 기본은 기존 흐름.
        onclick: () => { if (opts.onEdit) { opts.onEdit(); return; } state.admin.memberEditing = true; renderAdminDetail(detail, 'members', data); } }));
    if ((m.kind || 'human') === 'human') {
      acts.append(el('button', { class: 'btn btn-ghost', text: '비밀번호 재설정',
        onclick: async () => {
          if (!confirm(`'${m.display_name || m.id}' 님의 로그인 비밀번호를 임시 비번으로 재설정할까요?`)) return;
          try {
            const r = await api('/api/ui/org/member/reset-password', { method: 'POST', body: JSON.stringify({ id: m.id }) });
            showInitialAccount(m.id, m.display_name, m.email, r.password, data);
          } catch (e) { toast(e.message, true); }
        } }));
    }
    kids.push(acts);
  }
  root.replaceChildren(...kids);
}

// opts(선택): { saveLabel, onSaved(payload), showCancel(기본 true), onCancel, showRemove(기본 !isNew) }
//  기본 동작은 [구성원 관리] 섹션용(저장 후 보기 모드 복귀). [구성원 추가] 섹션이 onSaved 등으로 재정의해 재사용.
function memberForm(root, m, data, detail, isNew, opts: any = {}) {
  // 읽기 전용(비-admin): 폼 대신 요약(민감 필드는 서버가 이미 redact). (정상 흐름은 memberRead 가 처리 — 안전망.)
  if (!state.admin.canEdit) { memberRead(root, m, data, detail); return; }
  // 아이디 = 불변 내부키(토큰·세션·활동이력·프로젝트·감사가 참조 — 가변 이메일과 분리). 신규는 서버가 이메일에서
  //  자동·유니크 생성(폼에서 숨김 — 관리자 비관여). 기존 멤버는 표시만(변경 불가).
  const idIn = el('input', { type: 'text', value: m.id, placeholder: '아이디(영문/숫자)', disabled: '' });
  const nameIn = el('input', { type: 'text', value: m.display_name || '', placeholder: '표시 이름' });
  const emailIn = el('input', { type: 'email', value: m.email || '', placeholder: '대표 이메일(로그인 아이디)' });
  const kindSel = el('select', {}, ...['human', 'agent', 'system'].map((k) => el('option', { value: k, text: k })));
  kindSel.value = m.kind || 'human';
  const stateSel = el('select', {}, ...['active', 'inactive'].map((k) => el('option', { value: k, text: k === 'active' ? '활성' : '비활성' })));
  stateSel.value = m.state || 'active';
  const bodyTa = el('textarea', { rows: '4', placeholder: '개인 레이어(역할/호칭/담당 — 선택)' });
  bodyTa.value = m.body_md || '';

  // 권한(scopes) — 이 구성원이 받는 토큰의 권한. 변경 시 활성 토큰에도 즉시 반영(서버).
  //  체크박스에 없는 권한은 저장 시 보존(아래 보존 로직이 안전망).
  const SCOPE_OPTS = MEMBER_SCOPE_OPTS;
  const scopeChks = {};
  const scopeWrap = el('div', { class: 'scope-wrap' });
  for (const [sk, label] of SCOPE_OPTS) {
    const chk = el('input', { type: 'checkbox' });
    chk.checked = (m.scopes || []).includes(sk);
    scopeChks[sk] = chk;
    scopeWrap.append(el('label', { class: 'admin-check scope-opt' }, chk, ' ' + label + ' (' + sk + ')'));
  }

  // 외부 계정 연결(identities) — 신원 매칭 키. 구조화 행 + 추가/삭제.
  const idnWrap = el('div', { class: 'idn-wrap' });
  const idnRows: any[] = [];
  function addIdn(idn) {
    const sysIn = el('input', { type: 'text', value: (idn && idn.system) || '', placeholder: 'slack / discord / notion …', class: 'idn-sys' });
    const extIn = el('input', { type: 'text', value: (idn && idn.external_id) || '', placeholder: '외부 계정 ID', class: 'idn-ext' });
    const emIn = el('input', { type: 'text', value: (idn && idn.email) || '', placeholder: '이메일(선택)', class: 'idn-em' });
    const rm = el('button', { class: 'btn-text', text: '✕', title: '삭제' });
    const row = el('div', { class: 'idn-row' }, sysIn, extIn, emIn, rm);
    const rec = { row, sysIn, extIn, emIn };
    rm.addEventListener('click', () => { row.remove(); const i = idnRows.indexOf(rec); if (i >= 0) idnRows.splice(i, 1); });
    idnRows.push(rec);
    idnWrap.append(row);
  }
  (m.identities || []).forEach(addIdn);

  const saveBtn = el('button', { class: 'btn btn-primary', text: opts.saveLabel || (isNew ? '추가' : '저장') });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    const identities = idnRows.map((r) => ({ system: r.sysIn.value.trim(), external_id: r.extIn.value.trim(), email: r.emIn.value.trim() || undefined }))
      .filter((x) => x.system && x.external_id);
    const knownScopes = SCOPE_OPTS.map(([sk]) => sk);
    const payload = {
      // 신규는 아이디를 보내지 않는다 — 서버가 이메일/표시이름에서 불변 내부키를 자동·유니크 생성(관리자 비관여).
      id: isNew ? undefined : idIn.value.trim(), kind: kindSel.value, display_name: nameIn.value.trim(),
      email: emailIn.value.trim(), identities, body_md: bodyTa.value, state: stateSel.value,
      // 체크된 권한 + 체크박스에 없는 권한은 보존 — 목록 누락으로 권한이 조용히 드롭되는 것 방지(안전망).
      scopes: [...knownScopes.filter((sk) => scopeChks[sk].checked), ...(m.scopes || []).filter((sk) => !knownScopes.includes(sk))],
    };
    // 사람(human) 구성원은 이메일이 로그인 아이디 → 신규 등록 시 필수(있어야 로그인 계정·초기 비번 발급). agent/system 은 불요.
    if (isNew && kindSel.value === 'human' && !payload.email) { toast('이메일을 입력하세요 — 로그인 아이디예요', true); return; }
    saveBtn.disabled = true;
    try {
      const res = await api('/api/ui/org/member', { method: 'POST', body: JSON.stringify(payload) });
      const savedId = (res && res.member && res.member.id) || payload.id; // 서버가 자동 생성한 아이디 반영
      await loadAdmin(true);
      // 신규 human 멤버면 초기 비밀번호가 1회 반환됨 — 관리자에게 전달용으로 표시(이메일 필수라 항상 발급됨).
      if (res && res.initialPassword) showInitialAccount(savedId, payload.display_name, payload.email, res.initialPassword, data);
      if (opts.onSaved) { opts.onSaved({ ...payload, id: savedId }); return; }
      state.admin.memberSel = savedId;
      state.admin.memberEditing = false; // 저장 후 보기 모드로 복귀
      toast('저장됨 — 신원 매칭에 즉시 반영됩니다');
      renderAdminDetail(detail, 'members', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });

  const actions = el('div', { class: 'admin-actions' }, saveBtn);
  // 취소 — 편집을 버리고 보기 모드로(신규는 선택 해제). opts.showCancel=false 면 숨김.
  if (opts.showCancel !== false) {
    actions.append(el('button', { class: 'btn btn-ghost', text: '취소',
      onclick: () => {
        if (opts.onCancel) { opts.onCancel(); return; }
        state.admin.memberEditing = false;
        if (isNew) state.admin.memberSel = null;
        renderAdminDetail(detail, 'members', data);
      } }));
  }
  actions.append(status);
  const showRemove = opts.showRemove !== undefined ? opts.showRemove : !isNew;
  if (showRemove) {
    // 토큰 발급은 [구성원 추가] 탭에서 — 여기(구성원 관리)선 신원/권한 편집만.
    actions.append(el('button', { class: 'btn-text', text: '제거',
      onclick: async () => {
        if (!confirm(`구성원 '${m.display_name || m.id}' 제거?`)) return;
        try { await api('/api/ui/org/member/remove', { method: 'POST', body: JSON.stringify({ id: m.id }) });
          await loadAdmin(true); toast('제거됨');
          // 모달에서 열렸으면 opts.onRemoved 로 모달 닫고 그리드 새로고침. 기본은 기존 흐름.
          if (opts.onRemoved) { opts.onRemoved(); return; }
          state.admin.memberSel = null; renderAdminDetail(detail, 'members', state.admin.data); }
        catch (e) { toast(e.message, true); }
      } }));
  }

  root.replaceChildren(
    isNew ? el('span', { hidden: '' }, idIn) : field('아이디 (내부 식별자 · 변경 불가)', idIn), field('표시 이름', nameIn), field('종류', kindSel),
    field('대표 이메일', emailIn), field('상태', stateSel),
    field('권한 (이 구성원 토큰의 scope)', scopeWrap),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '외부 계정 연결 (신원 매칭 키)' }), idnWrap,
      el('button', { class: 'btn-text', text: '+ 계정 추가', onclick: () => addIdn(null) })),
    field('개인 레이어', bodyTa),
    actions);
}

// ── 구성원 추가 — 새 팀원 등록 + 접속 열쇠(토큰) 발급을 한 곳에서. admin 전용([구성원 관리]에서 분리). ──
function memberAddPanel(detail, data) {
  // 토큰 발급(구 ② 접속 열쇠 발급)은 [구성원 토큰 관리] 탭으로 이관(#613 후속) — 여기선 새 구성원 등록만.
  //  ①/② 넘버링 제거. 등록 성공 시 그 구성원을 미리선택한 채 [구성원 토큰 관리] 탭으로 이동해 발급으로 자연스럽게 이어진다.
  const card = el('div', { class: 'card' },
    sectionTitle('구성원 추가', data.meaning['member']),
    el('p', { class: 'admin-hint', text: '새 팀원을 등록하세요. 등록하면 [구성원 토큰 관리] 탭으로 넘어가 그 사람의 접속 열쇠(토큰)를 발급·전달할 수 있어요.' }));

  const formHost = el('div', {});
  const blank = { id: '', kind: 'human', display_name: '', email: '', identities: [], body_md: '', state: 'active', scopes: ['items', 'context'] };
  memberForm(formHost, blank, data, detail, true, {
    saveLabel: '구성원 등록',
    showCancel: false,
    showRemove: false,
    onSaved: (payload) => {
      state.admin.memberAddPreselect = payload.id; // [구성원 토큰 관리] 탭에서 이 구성원 미리선택
      toast('구성원 등록됨 — 접속 열쇠를 발급해 전달하세요');
      location.hash = '#/system/tokens'; // route() 재실행 → tokensPanel 렌더(발급 블록에서 미리선택)
    },
  });
  card.append(formHost);

  detail.replaceChildren(card);
}

// ── 팀 관리 — 구성원을 팀(스쿼드/사일로)으로 묶고, 팀이 카테고리를 '소유'(표면화·주입의 '우리 팀' 기준). ──
//  오너십 배정 자체는 '분류 체계 관리'(카테고리별 오너 드롭다운)에서. 여기선 팀 CRUD + 팀원(역할) + 소유 현황 표시.
//  membersEditor 2단 패턴 동형(좌: 팀 리스트, 우: 보기/수정). 편집은 context 스코프(canContext). ★오너십=우선순위, 접근제한 아님.
const TEAM_ROLE_OPTS = [
  ['lead', '리드'], ['pm', 'PO/PM'], ['dev', '개발'], ['design', '디자인'], ['member', '멤버'],
];
const TEAM_ROLE_LABEL = Object.fromEntries(TEAM_ROLE_OPTS);

async function teamsPanel(detail, data) {
  const canEdit = state.admin.canContext;
  detail.replaceChildren(el('div', { class: 'card' }, skeleton('팀을 불러오는 중')));
  let teams;
  try { teams = ((await api('/api/ui/teams')) || {}).teams || []; }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '팀을 불러오지 못했습니다'))); return; }

  const sel = state.admin.teamSel;
  const listCol = el('div', { class: 'admin-sublist' });
  if (canEdit) listCol.append(el('button', { class: 'btn btn-ghost btn-sm', text: '+ 새 팀',
    onclick: () => { state.admin.teamSel = '__new__'; state.admin.teamEditing = true; teamsPanel(detail, data); } }));
  for (const t of teams) {
    listCol.append(el('div', { class: 'mini-row' + (String(t.id) === String(sel) ? ' sel' : ''),
      onclick: () => { state.admin.teamSel = t.id; state.admin.teamEditing = false; teamsPanel(detail, data); } },
      el('div', { class: 'mini-title', text: (t.name || t.key) }),
      el('div', { class: 'mini-meta', text: (t.member_count || 0) + '명 · 카테고리 ' + (t.category_count || 0) })));
  }
  if (!teams.length) listCol.append(el('div', { class: 'mini-meta', text: '아직 팀이 없습니다.' }));

  const right = el('div', {});
  // 팀이 하나도 없으면(첫 사용) 바로 생성 폼을 연다 — 빈 패널에서 '구성원이 안 보인다'는 혼선 제거(팀원 picker 가 폼 안에 있으므로).
  const wantCreate = sel === '__new__' || (sel == null && teams.length === 0 && canEdit);
  if (wantCreate && canEdit) {
    teamForm(right, { key: '', name: '', description: '', body_md: '', lead_member_id: '', members: [], categories: [] }, data, detail, true);
  } else if (sel != null && sel !== '__new__') {
    right.append(skeleton('팀 정보를 불러오는 중'));
    api('/api/ui/teams/' + sel).then((r) => {
      const team = r && r.team;
      if (!team) { right.replaceChildren(el('p', { class: 'admin-hint', text: '팀을 찾을 수 없습니다.' })); return; }
      if (state.admin.teamEditing && canEdit) teamForm(right, team, data, detail, false);
      else teamView(right, team, data, detail);
    }).catch((e) => right.replaceChildren(errorNote(e, '팀 정보를 불러오지 못했습니다')));
  } else {
    right.append(el('p', { class: 'admin-hint', text: canEdit ? '왼쪽에서 팀을 고르거나 [+ 새 팀]을 누르세요.' : '읽기 전용 — 편집은 context 권한이 필요합니다.' }));
  }

  detail.replaceChildren(el('div', { class: 'card' },
    sectionTitle('팀 관리', { key: 'team' }),
    el('p', { class: 'admin-hint', text: '구성원을 팀으로 묶고, 팀이 맡는 카테고리(도메인)를 정합니다. 카테고리 오너 배정은 [분류 체계 관리]에서, 여기선 팀과 팀원을 관리합니다. 팀 소유 카테고리는 팀원의 프로젝트·위키 탭과 AI 세션에 먼저 노출됩니다(오너십=우선순위, 접근제한 아님).' }),
    el('div', { class: 'admin-two admin-two-cols' }, listCol, right)));
}

// 팀 보기(수정 전 읽기 요약).
function teamView(root, team, data, detail) {
  const canEdit = state.admin.canContext;
  const roRow = (label, value) => field(label, el('div', { class: 'admin-ro', text: value || '—' }));
  const memberName = (id) => { const m = (data.members || []).find((x) => x.id === id); return m ? (m.display_name || m.id) : id; };
  const owned = (team.categories || []).filter((c) => c.relation === 'owner');
  const stake = (team.categories || []).filter((c) => c.relation !== 'owner');
  const kids: any[] = [
    el('div', { class: 'member-read-head' }, el('h3', { text: team.name || team.key }),
      team.state === 'archived' ? el('span', { class: 'pill', text: '보관됨' }) : null),
    roRow('키(슬러그)', team.key),
    roRow('설명', team.description),
    roRow('리드', team.lead_member_id ? memberName(team.lead_member_id) : ''),
    field('팀원', el('div', { class: 'admin-ro admin-ro-pre', text:
      (team.members && team.members.length) ? team.members.map((m) => (m.display_name || m.member_id) + ' (' + (TEAM_ROLE_LABEL[m.role] || m.role) + ')').join('\n') : '—' })),
    field('소유 카테고리', el('div', { class: 'admin-ro admin-ro-pre', text: owned.length ? owned.map((c) => (c.name || c.key) + ' [' + c.space + ']').join('\n') : '— (분류 체계 관리에서 배정)' })),
  ];
  if (stake.length) kids.push(field('이해관계 카테고리', el('div', { class: 'admin-ro admin-ro-pre', text: stake.map((c) => (c.name || c.key) + ' [' + c.space + ']').join('\n') })));
  if (team.body_md && team.body_md.trim()) kids.push(field('팀 charter (AI 세션 주입)', el('div', { class: 'admin-ro admin-ro-pre', text: team.body_md.trim() })));
  if (canEdit) kids.push(el('div', { class: 'admin-actions' },
    el('button', { class: 'btn btn-primary', text: '수정', onclick: () => { state.admin.teamEditing = true; teamsPanel(detail, data); } })));
  root.replaceChildren(...kids);
}

// 팀 수정/생성 폼.
function teamForm(root, team, data, detail, isNew) {
  const keyIn = el('input', { type: 'text', value: team.key || '', placeholder: '키(영문 슬러그, 예: product-core)' });
  const nameIn = el('input', { type: 'text', value: team.name || '', placeholder: '팀 이름(예: 프로덕트 코어)' });
  const descIn = el('input', { type: 'text', value: team.description || '', placeholder: '한 줄 설명(선택)' });
  const bodyTa = el('textarea', { rows: '4', placeholder: '팀 charter — 이 팀 AI 세션 첫머리에 주입될 팀 규칙/컨벤션(선택)' });
  bodyTa.value = team.body_md || '';
  // 팀원 — 멤버별 체크 + 역할 select(역할에 '리드' 포함 → 별도 리드 필드 불필요, 역할에서 파생). 기존 멤버는 체크/역할 프리필.
  const existing: any = {}; (team.members || []).forEach((m) => { existing[m.member_id] = m.role || 'member'; });
  const memberRows: any[] = [];
  const membersWrap = el('div', { class: 'team-members-wrap' });
  for (const m of (data.members || [])) {
    if ((m.kind || 'human') !== 'human') continue;
    const chk = el('input', { type: 'checkbox' });
    chk.checked = existing[m.id] != null;
    const roleSel = el('select', { class: 'team-role-sel' }, ...TEAM_ROLE_OPTS.map(([rk, rl]) => el('option', { value: rk, text: rl })));
    roleSel.value = existing[m.id] || 'member';
    memberRows.push({ id: m.id, chk, roleSel });
    membersWrap.append(el('label', { class: 'team-member-opt' }, chk, el('span', { class: 'team-member-name', text: ' ' + (m.display_name || m.id) }), roleSel));
  }

  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '만들기' : '저장' });
  saveBtn.addEventListener('click', async () => {
    const key = keyIn.value.trim().toLowerCase();
    if (!key) { toast('키(슬러그)를 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      let teamId = team.id;
      const members = memberRows.filter((r) => r.chk.checked).map((r) => ({ member_id: r.id, role: r.roleSel.value }));
      // 리드 = 역할이 '리드'인 팀원에서 파생(별도 필드 없음). 여럿이면 첫 번째.
      const leadM = members.find((m) => m.role === 'lead');
      const payload = { key, name: nameIn.value.trim(), description: descIn.value.trim(), body_md: bodyTa.value, lead_member_id: leadM ? leadM.member_id : null };
      if (isNew) { const r = await api('/api/ui/teams', { method: 'POST', body: JSON.stringify(payload) }); teamId = r && r.team && r.team.id; }
      else await api('/api/ui/teams/' + team.id, { method: 'POST', body: JSON.stringify(payload) });
      if (teamId) await api('/api/ui/teams/' + teamId + '/members', { method: 'POST', body: JSON.stringify({ members }) });
      toast('저장됨');
      state.admin.teamSel = teamId; state.admin.teamEditing = false;
      teamsPanel(detail, data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });

  const actions = el('div', { class: 'admin-actions' }, saveBtn,
    el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => { state.admin.teamEditing = false; if (isNew) state.admin.teamSel = null; teamsPanel(detail, data); } }));
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '삭제',
    onclick: async () => {
      if (!confirm("팀 '" + (team.name || team.key) + "'을(를) 삭제할까요? (카테고리 오너십이 해제됩니다 — 카테고리 자체는 남습니다)")) return;
      try { await api('/api/ui/teams/' + team.id + '/delete', { method: 'POST' }); toast('삭제됨'); state.admin.teamSel = null; state.admin.teamEditing = false; teamsPanel(detail, data); }
      catch (e) { toast(e.message, true); }
    } }));

  root.replaceChildren(
    field('키 (슬러그 · 영문)', keyIn), field('팀 이름', nameIn), field('설명', descIn),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '팀원 (체크 + 역할 · 리드는 역할에서 지정)' }), membersWrap),
    field('팀 charter (AI 세션 주입 · 선택)', bodyTa),
    actions);
}

// ── 조직 · 연결 ──
function profileEditor(detail, data) {
  const canEdit = state.admin.canEdit;
  const p = data.profile;
  const dnIn = el('input', { type: 'text', value: p.display_name || '', placeholder: '조직 표시명' });
  const gwIn = el('input', { type: 'text', value: p.gateway_url || '', placeholder: 'http://게이트웨이:포트' });
  if (!canEdit) { dnIn.disabled = true; gwIn.disabled = true; }
  const body = [
    el('h2', { text: '조직 기본 정보' }),
    fieldWithHelp('조직 표시명', dnIn, data.meaning['display_name']),
    fieldWithHelp('게이트웨이 주소', gwIn, data.meaning['gateway-url']),
  ];
  if (canEdit) {
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        const r = await api('/api/ui/org/profile', { method: 'POST', body: JSON.stringify({ display_name: dnIn.value.trim(), gateway_url: gwIn.value.trim() }) });
        data.profile = r.profile; toast('저장됨'); status.textContent = '저장됨';
      } catch (e) { toast(e.message, true); }
      saveBtn.disabled = false;
    });
    body.push(el('div', { class: 'admin-actions' }, saveBtn, status));
  }
  detail.replaceChildren(el('div', { class: 'card' }, ...body));
}

// ── 구성원 토큰 관리 — 접속 열쇠(토큰) 발급 + 발급 현황 보기 + 접속 해제. admin 전용. (발급 블록은 [구성원 추가]에서 이관 #613 후속) ──
function tokensPanel(detail, data) {
  const gw = (data.profile.gateway_url || window.location.origin).replace(/\/mcp$/, '').replace(/\/$/, '');
  const tokens = data.tokens || [];
  const active = tokens.filter((t) => !t.revoked_at);
  const revoked = tokens.filter((t) => t.revoked_at);
  const tokenRow = (t, isActive) => {
    const meta = (t.user_id || '') + ' · ' + ((t.scopes || []).join('/') || '-')
      + ' · 발급 ' + (t.created_at ? t.created_at.slice(0, 10) : '?')
      + (t.last_used_at ? ' · 마지막 ' + relTime(t.last_used_at) : ' · 미사용');
    const right = isActive
      ? el('button', { class: 'btn btn-ghost btn-sm', text: '접속 해제', onclick: async (e) => {
          if (!confirm(`'${t.label || t.user_id}' 님의 접속을 해제할까요? 이 열쇠는 즉시 무효화됩니다(되돌릴 수 없음).`)) return;
          e.target.disabled = true;
          try {
            await api('/api/ui/org/token/revoke', { method: 'POST', body: JSON.stringify({ tokenHash: t.token_hash }) });
            await loadAdmin(true); toast('접속 해제됨 — 즉시 무효'); renderAdminDetail(detail, 'tokens', state.admin.data);
          } catch (err) { toast(err.message, true); e.target.disabled = false; }
        } })
      : el('span', { class: 'pill', text: '해제됨' });
    return el('div', { class: 'token-row' + (isActive ? '' : ' token-revoked') },
      el('div', { class: 'token-main' },
        el('div', { class: 'token-label', text: t.label || t.user_id || '(무라벨)' }),
        el('div', { class: 'mini-meta', text: meta })),
      right);
  };
  const children = [
    el('h2', { text: '구성원 토큰 관리' }),
    el('p', { class: 'admin-hint', text: '구성원의 접속 열쇠(토큰)를 발급해 전달하고, 발급된 열쇠의 사용 현황을 보거나 더 이상 필요 없는 접속을 해제하는 곳입니다.' }),
    // 발급 — 구성원을 골라 토큰 발급([구성원 추가]에서 이관). 등록 직후 넘어오면 그 구성원이 미리선택된다.
    installMinterBlock(data, gw, { title: '접속 열쇠(토큰) 발급', preselectId: state.admin.memberAddPreselect }),
    el('div', { class: 'meaning-grid', style: 'margin:16px 0 12px' },
      meaningRow('발급된 열쇠는', '지금 누가 회사 게이트웨이에 연결할 수 있는지 보여줘요. 사용 현황을 살펴보고, 필요할 때 특정 구성원의 접속을 해제(차단)합니다.'),
      meaningRow('언제 정리하나', '퇴사·기기 분실 등 그 사람의 접속을 끊어야 할 때. 해제하면 서버를 다시 켤 필요 없이 그 즉시 막힙니다(되돌릴 수 없음).')),
  ];
  state.admin.memberAddPreselect = null; // 1회성 미리선택 소진(다음 렌더에 잔류 방지)
  if (active.length) children.push(el('div', { class: 'token-section' }, el('div', { class: 'token-section-h', text: '사용 중 (' + active.length + ')' }), ...active.map((t) => tokenRow(t, true))));
  else children.push(el('p', { class: 'admin-hint', text: '아직 발급된 접속 열쇠가 없습니다 — 위에서 구성원을 골라 발급하세요.' }));
  if (revoked.length) children.push(el('div', { class: 'token-section' }, el('div', { class: 'token-section-h', text: '해제됨 (' + revoked.length + ')' }), ...revoked.map((t) => tokenRow(t, false))));
  detail.replaceChildren(el('div', { class: 'card' }, ...children));
}

// ── 런타임 · 훅 (훅 on/off · work-roots · 너지 문구) — admin 전용 ──
// 섹션(org-defaults·context-ontology-guide) 편집은 WIKI 지식 페이지(#/k/<name>)로 일원화(2026-06-26) — 모달 editSectionModal 폐기.
//  이 섹션들은 injection=always knowledge 레코드라 WIKI 상세에서 직접 편집(openKnowledgeEditor). 섹션단위 미리보기도 불필요(허브 통합 미리보기로 충분).

// ════════════════════════════════════════════════════════════════════
// 세션 주입 지도(2026-06-26) — 구 '훅' 그룹(개요·런타임 토글·주입 미리보기)을 흡수한 단일 허브.
//  AI가 매 세션 자동으로 [무엇을·언제] 받고 수행하나를 주입 시점(SessionStart·PostToolUse·Stop·기타)별로 모은다.
//  맥락 조각의 편집은 정식 집(규칙·소개 섹션 / WIKI 탭)으로 딥링크 — 새 진실 출처를 만들지 않는다(맥락의 집은 그대로).
//  여기서 인라인 편집하는 건 '전달' 설정뿐: 시점 ON/OFF · writeback 너지 · work-roots · 기록인정 툴.
//  allowlist(SSRF) 는 'AI 도구'·'DB 데이터소스' 화면 안(allowlistCard)으로, 임의 코드 훅은 '커스텀 훅'으로 분리.
// ════════════════════════════════════════════════════════════════════
function injectionMap(detail, data) {
  const rc = data.runtimeConfig;                 // admin 만 non-null. 없으면 토글/편집 숨기고 딥링크+미리보기만.
  const canEdit = !!data.canEdit && !!rc;
  const hooks = (rc && rc.hooks) || {};
  const orgHooks = data.orgHooks || [];
  const customFor = (ev) => orgHooks.filter((h) => h.event === ev);
  const HANDLED = ['SessionStart', 'PostToolUse', 'Stop'];

  // 런타임 설정 부분 저장 — 서버가 patch 병합(제공 필드만 갱신)하므로 바뀐 것만 보낸다.
  async function saveRuntime(patch, okMsg?) {
    const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify(patch) });
    if (r && r.runtimeConfig) data.runtimeConfig = r.runtimeConfig;
    toast(okMsg || '저장됨 — 구성원 다음 세션부터 반영');
  }

  // 시점 ON/OFF — hooks JSON 전체를 보내 다른 시점 값 보존.
  function momentToggle(hookKey) {
    const chk = el('input', { type: 'checkbox' }); chk.checked = hooks[hookKey] !== false; chk.disabled = !canEdit;
    chk.addEventListener('change', async () => {
      try { await saveRuntime({ hooks: { ...hooks, [hookKey]: chk.checked } }, chk.checked ? '주입 켜짐' : '주입 꺼짐'); hooks[hookKey] = chk.checked; }
      catch (e) { toast(e.message, true); chk.checked = hooks[hookKey] !== false; }
    });
    return el('label', { class: 'admin-check inj-toggle' }, chk, ' 주입 켜기');
  }

  // 딥링크 — 정식 편집 집으로 이동(섹션 / WIKI 탭).
  const jump = (label, hash) => el('button', { class: 'btn btn-ghost btn-sm', text: label, onclick: () => { location.hash = hash; } });

  function pieceRow(n, label, sub, editBtn) {
    return el('div', { class: 'inj-piece' },
      el('span', { class: 'inj-n', text: n }),
      el('div', { class: 'inj-piece-body' },
        el('div', { class: 'inj-piece-label', text: label }),
        sub ? el('div', { class: 'admin-hint inj-sub', text: sub }) : null),
      editBtn || el('span', {}));
  }

  // 커스텀 훅 요약(읽기 전용) + 편집 딥링크.
  function customList(ev) {
    const list = customFor(ev);
    const wrap = el('div', { class: 'inj-custom' });
    for (const h of list) wrap.append(el('div', { class: 'inj-custom-row' },
      el('span', { class: 'mini-title', text: h.id }, h.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null),
      el('span', { class: 'mini-meta', text: (h.harness || 'all') + (h.matcher ? ' · ' + h.matcher : '') })));
    wrap.append(el('div', { class: 'admin-actions' }, jump(list.length ? '커스텀 ' + ev + ' 훅 편집 →' : '+ 커스텀 ' + ev + ' 훅', '#/system/custom-hooks')));
    return wrap;
  }

  function momentBlock(title, when, toggleEl, ...children) {
    return el('div', { class: 'inj-moment' },
      el('div', { class: 'inj-moment-head' },
        el('div', { class: 'inj-moment-h' }, el('h3', { class: 'inj-moment-title', text: title }), el('div', { class: 'admin-hint inj-sub', text: when })),
        toggleEl || el('span', {})),
      ...children.filter(Boolean));
  }

  // 줄 단위 텍스트리스트 인라인 편집(work-roots / write_tools).
  function listEditor(labelText, initial, fieldKey, ph) {
    const ta = el('textarea', { rows: '3', placeholder: ph || '' }); ta.value = (initial || []).join('\n'); ta.disabled = !canEdit;
    const btn = el('button', { class: 'btn btn-primary btn-sm', text: '저장' }); if (!canEdit) btn.disabled = true;
    const st = el('span', { class: 'admin-status' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await saveRuntime({ [fieldKey]: ta.value.split('\n').map((l) => l.trim()).filter(Boolean) }); st.textContent = '저장됨'; }
      catch (e) { toast(e.message, true); }
      btn.disabled = false;
    });
    return field(labelText, el('div', {}, ta, el('div', { class: 'admin-actions' }, btn, st)));
  }

  // 세션종료 너지 문구 — 기본값(서버 단일소스 data.writebackNoticeDefault)을 실제로 보여준다(숨은 파일 기본값 X).
  //  비우거나 기본값과 같게 저장하면 null(=기본값 사용)로 저장 → DB 는 'override 있음/없음'만 들고, 화면엔 항상 effective 값이 보임.
  function writebackEditor() {
    const def = (data.writebackNoticeDefault || '').trim();
    const cur = (rc && rc.writeback_notice) || '';
    const ta = el('textarea', { rows: '6', placeholder: def }); ta.value = cur || def; ta.disabled = !canEdit;
    const btn = el('button', { class: 'btn btn-primary btn-sm', text: '저장' }); if (!canEdit) btn.disabled = true;
    const resetBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '기본값으로 되돌리기' }); if (!canEdit) resetBtn.disabled = true;
    const st = el('span', { class: 'admin-status', text: cur ? '커스텀 너지 사용 중' : '기본값 사용 중' });
    resetBtn.addEventListener('click', () => { ta.value = def; st.textContent = '기본값을 불러왔어요 — [저장]으로 확정'; });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const v = ta.value.trim();
      const payload = (!v || v === def) ? null : v; // 비었거나 기본값과 동일 → null(기본값 사용)
      try { await saveRuntime({ writeback_notice: payload }); if (rc) rc.writeback_notice = payload; st.textContent = payload ? '저장됨 · 커스텀 너지' : '저장됨 · 기본값 사용'; }
      catch (e) { toast(e.message, true); }
      btn.disabled = false;
    });
    return field('세션 종료 너지 문구 — 기본값이 채워져 있음(비우거나 기본값과 같으면 기본값 사용)',
      el('div', {}, ta, el('div', { class: 'admin-actions' }, btn, resetBtn, st)));
  }

  // 실제 주입 전문 미리보기(SessionStart) — 게이트웨이 조립물(byte-identical) 펼침.
  function previewExpander() {
    const box = el('div', { class: 'inj-preview' }); box.style.display = 'none';
    const btn = el('button', { class: 'btn btn-ghost btn-sm', text: '실제 주입 전문 미리보기 ▾' });
    let loaded = false, open = false;
    btn.addEventListener('click', async () => {
      open = !open; box.style.display = open ? 'block' : 'none'; btn.textContent = open ? '미리보기 접기 ▴' : '실제 주입 전문 미리보기 ▾';
      if (open && !loaded) {
        loaded = true; box.replaceChildren(el('p', { class: 'admin-hint', text: '불러오는 중…' }));
        try {
          const r = await api('/api/ui/org/hooks/preview');
          const sp = ((r && r.hooks) || []).find((h) => h.id === 'session-preload');
          box.replaceChildren(sp && sp.message
            ? el('div', { class: 'md-rendered admin-md-box', style: 'max-height:340px; overflow:auto' }, renderMarkdown(sp.message))
            : el('p', { class: 'admin-hint', text: '미리볼 내용이 없습니다.' }));
        } catch (e) { box.replaceChildren(errorNote(e, '미리보기를 불러오지 못했습니다(서버 재시작 후 제공)')); }
      }
    });
    return el('div', {}, el('div', { class: 'admin-actions' }, btn), box);
  }

  // ── 블록 조립 ──
  // 세션 시작 조각(#335) — 항상-주입 '섹션 문서'(injection='always' 행)를 N개 관리(추가/편집/삭제/재정렬). sort 순으로 조립.
  //  실제 순서(publish.ts): 조직 헤더(자동) → [섹션들 sort 순]. 각 섹션 본문의 ${team}/${categories}/${wiki} 는 매 세션 실데이터로 치환.
  const guideKey = 'context-ontology-guide';
  const SECTION_HINT = {
    'org-defaults': '회사 배경 + 항상 지킬 규칙 + AI 말투 (회사 소개·규칙·성격)',
    'context-ontology-guide': '⚠ LLM 이 라이블리 시스템(맥락·카테고리·프로젝트·지식) 사용법을 이해하는 핵심 문서 — 삭제·대폭수정 주의. ${categories}/${wiki} 자리표시자 골격.',
  };
  const subPieceRow = (token, label, sub, btn) => el('div', { class: 'inj-piece inj-subpiece' },
    el('code', { class: 'inj-token', text: token }),
    el('div', { class: 'inj-piece-body' },
      el('div', { class: 'inj-piece-label', text: label }),
      sub ? el('div', { class: 'admin-hint inj-sub', text: sub }) : null),
    btn || el('span', {}));

  // 섹션 본문 편집/생성 모달 — overlay + textarea. 저장 → POST /api/ui/org/section.
  function openSectionEditor(name, opts) {
    opts = opts || {};
    const isNew = !!opts.isNew;
    const cur = (data.sections && data.sections[name]) || { body_md: '' };
    const nameIn = el('input', { type: 'text', value: name || '', placeholder: '섹션 키 (소문자·숫자·하이픈, 예: company-policy)' });
    if (!isNew) nameIn.disabled = true;
    const ta = el('textarea', { class: 'mem-edit-ta', rows: '18', placeholder: 'markdown 본문 — ${team}/${categories}/${wiki} 치환 가능' });
    ta.value = cur.body_md || '';
    const st = el('span', { class: 'admin-status' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
    const root = el('div', { class: 'mem-modal' },
      isNew ? field('섹션 키', nameIn) : null,
      name === guideKey ? el('p', { class: 'admin-hint', text: '⚠ 시스템 가이드 — LLM 이 라이블리 사용법을 이해하는 핵심 문서입니다. 대폭 수정·삭제 시 AI 가 시스템 사용법을 잃을 수 있어요.' }) : null,
      field('본문 (markdown)', ta),
      el('div', { class: 'admin-actions' }, saveBtn, st));
    const back = overlay(isNew ? '섹션 추가' : ('섹션 편집 · ' + name), root);
    saveBtn.onclick = async () => {
      const section = (isNew ? nameIn.value : name).trim().toLowerCase();
      if (!section) { toast('섹션 키를 입력하세요', true); return; }
      saveBtn.disabled = true; st.textContent = '저장 중…';
      try {
        await api('/api/ui/org/section', { method: 'POST', body: JSON.stringify({ section, body_md: ta.value }) });
        toast('저장됨 — 구성원 다음 세션부터 반영'); back.remove(); await reloadSections();
      } catch (e) { toast('저장 실패 — ' + e.message, true); saveBtn.disabled = false; st.textContent = ''; }
    };
  }
  async function reloadSections() {
    try { const r = await api('/api/ui/org'); if (r && r.sections) data.sections = r.sections; } catch (_) { /* 유지 */ }
    paintSections();
  }
  function orderedSections() {
    return Object.entries(data.sections || {}).map(([name, s]) => ({ name, ...(s as any) }))
      .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || a.name.localeCompare(b.name));
  }
  async function moveSection(i, dir) {
    const entries = orderedSections(); const j = i + dir;
    if (j < 0 || j >= entries.length) return;
    const order = entries.map((e) => e.name);
    [order[i], order[j]] = [order[j], order[i]];
    try { await api('/api/ui/org/sections/order', { method: 'POST', body: JSON.stringify({ order }) }); await reloadSections(); }
    catch (e) { toast(e.message, true); }
  }
  async function deleteSectionUi(s) {
    const warn = s.name === guideKey ? '⚠ 시스템 가이드입니다 — 삭제하면 AI 가 라이블리 사용법(맥락·카테고리·지식 기록)을 잃습니다.\n\n' : '';
    if (!confirm(warn + "'" + s.name + "' 섹션을 삭제할까요?\n\n매 세션 주입에서 사라집니다(휴지통에서 복원 가능).")) return;
    try { await api('/api/ui/org/section/delete', { method: 'POST', body: JSON.stringify({ section: s.name }) }); toast('삭제됨'); await reloadSections(); }
    catch (e) { toast(e.message, true); }
  }
  const sectionsWrap = el('div', { class: 'inj-pieces' });
  function paintSections() {
    const entries = orderedSections();
    const rows = entries.map((s, i) => {
      const isGuide = s.name === guideKey;
      const acts: any[] = [];
      if (canEdit) {
        const up = el('button', { class: 'btn btn-ghost btn-sm', text: '▲', title: '위로' }); up.disabled = i === 0; up.onclick = () => moveSection(i, -1);
        const down = el('button', { class: 'btn btn-ghost btn-sm', text: '▼', title: '아래로' }); down.disabled = i === entries.length - 1; down.onclick = () => moveSection(i, +1);
        const ed = el('button', { class: 'btn btn-ghost btn-sm', text: '편집' }); ed.onclick = () => openSectionEditor(s.name, {});
        const del = el('button', { class: 'btn btn-ghost btn-sm', text: '삭제' }); del.onclick = () => deleteSectionUi(s);
        acts.push(up, down, ed, del);
      }
      return el('div', { class: 'inj-piece' },
        el('span', { class: 'inj-n', text: String(i + 1) }),
        el('div', { class: 'inj-piece-body' },
          el('div', { class: 'inj-piece-label' }, s.name, isGuide ? el('span', { class: 'pill', title: '시스템 가이드 — 수정·삭제 주의', text: ' ⚠ 시스템 가이드' }) : null),
          el('div', { class: 'admin-hint inj-sub', text: SECTION_HINT[s.name] || ('v' + (s.version || 1) + ' · 갱신 ' + (s.updated_by || '—')) })),
        el('div', { class: 'admin-actions' }, ...acts));
    });
    sectionsWrap.replaceChildren(
      ...rows,
      canEdit ? el('div', { class: 'admin-actions inj-add' }, el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 섹션 추가', onclick: () => openSectionEditor('', { isNew: true }) })) : el('span', {}),
      el('div', { class: 'inj-subpieces' },
        el('div', { class: 'admin-hint inj-sub', text: '└ 각 섹션 본문의 ${ } 자리에 매 세션 실제 데이터로 자동 채워짐(편집 불가):' }),
        subPieceRow('${team}', '우리 팀', '보는 구성원의 팀·소유 카테고리 프리앰블 — 자동', null),
        subPieceRow('${categories}', '카테고리 지도', '전 카테고리(주제) 목록 — 자동', null),
        subPieceRow('${wiki}', 'WIKI 인덱스 핀', '핀(is_wiki)한 지식의 제목·소환키만(본문 제외) — 자동', jump('WIKI 인덱스 →', '#/knowledge?indexed=1'))));
  }
  paintSections();

  const ssBlock = momentBlock('세션 시작 — SessionStart', '대화가 열릴 때 조직 컨텍스트를 자동으로 깔아준다 — 맨 위 조직 헤더(자동) 다음, 아래 섹션 문서들을 sort 순으로 조립. 추가/편집/삭제/재정렬 가능.',
    momentToggle('session_preload'),
    sectionsWrap,
    previewExpander(),
    customList('SessionStart'));

  const ptuBlock = momentBlock('작업 중 — PostToolUse', '도구 사용 후 라이블리 작업 세션인지 플래그를 남긴다(주입 없음 · 종료 너지 판정에 사용).',
    momentToggle('work_flag'),
    canEdit ? listEditor('work-roots — 이 폴더에서 켠 세션을 라이블리 작업으로 인식 (줄당 절대경로)', rc.work_roots, 'work_roots', '/Users/you/repo') : null,
    canEdit ? listEditor('기록 인정 툴(write_tools) — 이 lively 툴을 쓰면 종료 너지 안 함 · 비우면 기본 목록', rc.write_tools, 'write_tools', 'knowledge_save') : null,
    customList('PostToolUse'));

  const stopBlock = momentBlock('세션 종료 — Stop', '작업했는데 기록을 안 남겼으면(조건 충족 시 1회) 기록하라고 너지한다.',
    momentToggle('stop_writeback_gate'),
    canEdit ? writebackEditor() : null,
    customList('Stop'));

  // 기타 이벤트 — 위 3시점 외 커스텀 훅.
  const otherHooks = orgHooks.filter((h) => !HANDLED.includes(h.event));
  const otherBlock = el('div', { class: 'inj-moment' },
    el('div', { class: 'inj-moment-head' }, el('div', { class: 'inj-moment-h' },
      el('h3', { class: 'inj-moment-title', text: '기타 이벤트' }),
      el('div', { class: 'admin-hint inj-sub', text: 'UserPromptSubmit · Pre/PostToolUse 매처 · SubagentStop · Notification 등 — 코드로 정의하는 커스텀 훅.' }))),
    otherHooks.length
      ? el('div', { class: 'inj-custom' }, ...otherHooks.map((h) => el('div', { class: 'inj-custom-row' },
          el('span', { class: 'mini-title', text: h.id }, h.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null),
          el('span', { class: 'mini-meta', text: h.event + ' · ' + (h.harness || 'all') }))))
      : null,
    el('div', { class: 'admin-actions' }, jump((data.orgHooks || []).length ? '커스텀 훅 전체 관리 →' : '+ 커스텀 훅 정의', '#/system/custom-hooks')));

  detail.replaceChildren(el('div', { class: 'card' },
    sectionTitle('세션 주입 지도', null),
    el('p', { class: 'admin-hint', text: '이 조직의 AI가 매 세션 자동으로 [무엇을·언제] 받고 수행하나를 한곳에 모았습니다. 항상-주입 섹션 문서(맨 위 자동 헤더 다음에 sort 순으로 깔림)는 여기서 직접 추가·편집·삭제·재정렬합니다.' }),
    !rc ? el('p', { class: 'admin-hint', text: '※ 주입 시점 ON/OFF·너지 편집은 관리자만 가능합니다. 아래는 보기 전용 + 편집 위치로의 이동만 동작합니다.' }) : null,
    el('div', { class: 'inj-moments' }, ssBlock, ptuBlock, stopBlock, otherBlock)));
}

// 외부 호출·DB 안전범위(allowlist) 카드 — runtime-config 의 SSRF 화이트리스트를 도구/DB 화면 안에 인라인(2026-06-26, 구 safetyEditor 폐기).
//  fields: [{key,label,initial,placeholder,hint}]. 저장은 patch 병합(POST runtime-config, admin 전용 — 아니면 읽기전용 textarea).
function allowlistCard(data, title, intro, fields) {
  const canEdit = !!data.canEdit;
  const tas = {};
  const rows = [el('div', { class: 'admin-subhead', text: title }), el('p', { class: 'admin-hint', text: intro })];
  for (const f of fields) {
    const ta = el('textarea', { rows: '3', placeholder: f.placeholder || '' }); ta.value = (f.initial || []).join('\n'); ta.disabled = !canEdit;
    tas[f.key] = ta;
    rows.push(field(f.label, el('div', {}, f.hint ? el('p', { class: 'admin-hint', style: 'margin:0 0 4px', text: f.hint }) : null, ta)));
  }
  if (canEdit) {
    const btn = el('button', { class: 'btn btn-primary btn-sm', text: '안전범위 저장' });
    const st = el('span', { class: 'admin-status' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const patch = {}; for (const f of fields) patch[f.key] = tas[f.key].value.split('\n').map((l) => l.trim()).filter(Boolean);
        const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify(patch) });
        if (r && r.runtimeConfig) data.runtimeConfig = r.runtimeConfig;
        st.textContent = '저장됨'; toast('저장됨 — 구성원 다음 세션부터 반영');
      } catch (e) { toast(e.message, true); }
      btn.disabled = false;
    });
    rows.push(el('div', { class: 'admin-actions' }, btn, st));
  }
  return el('div', { class: 'card' }, ...rows);
}

// [DEPRECATED 2026-06-26] 아래 hooksOverview·runtimeEditor·hooksPreviewPanel 은 '세션 주입 지도'(injectionMap)로
//  대체되어 라우팅에서 분리됨(미참조). 다음 청소 때 제거.
// ── '훅' 그룹 개요(클릭 진입점) — 훅이 무엇인지 설명 + 3 하위(런타임·커스텀·미리보기) 안내/이동. ──
function hooksOverview(detail, data) {
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '훅 (Hooks)' })),
    el('p', { class: 'admin-hint', text: '훅은 구성원의 AI 세션 중 특정 시점(이벤트)에 게이트웨이가 자동으로 끼어들어 실행하는 코드·설정입니다. 세션이 시작될 때 조직 컨텍스트를 주입하거나, 지금 작업 중인 폴더를 라이블리 작업으로 인식하거나, 세션이 끝날 때 기록을 남기도록 너지하는 식으로 동작합니다 — 사람이 매번 챙기지 않아도 AI가 조직의 방식대로 일하게 만드는 자동 장치입니다.' }),
    el('p', { class: 'admin-hint', text: '구성원 머신은 매 세션 게이트웨이에서 훅을 내려받아 실행하므로(runner fetch), 여기서 바꾸면 재설치 없이 다음 세션부터 자동 반영됩니다. 주요 주입 시점: 세션 시작(SessionStart) · 프롬프트 제출(UserPromptSubmit) · 도구 사용 전후(Pre/PostToolUse) · 세션 종료(Stop). 아래 세 가지로 관리합니다.' }),
  );
  const items = [
    ['runtime', '런타임 훅 (빌트인 리플렉스)', '게이트웨이가 기본 제공하는 세션 훅(컨텍스트 주입·작업 플래그·종료 기록 너지)을 코딩 없이 켜고 끕니다. 작업 폴더(work-roots)와 AI 도구의 외부 호출 안전범위도 여기서 정합니다.'],
    ['custom-hooks', '커스텀 훅 (코드 정의)', '특정 이벤트에 실행할 임의의 코드를 직접 정의합니다. 본문은 멤버 디스크에 저장되지 않고 매 세션 게이트웨이에서 받아 실행됩니다(끄면 다음 세션부터 무효).'],
    ['hooks-preview', '주입 미리보기 (세션 주입물 확인)', '설치된 세션 훅이 실제 세션에 무엇을 주입하는지 그 최종 메시지 전문을 읽기 전용으로 확인합니다(정확/근사 충실도 표기).'],
  ];
  const list = el('div', { class: 'hooks-ov-list' });
  for (const [key, title, desc] of items) {
    if (sectionHidden(key, data)) continue; // 권한으로 숨은 하위는 안내에서도 제외(404 유도 방지).
    list.append(el('a', { class: 'hooks-ov-card', href: '#/system/' + key },
      el('div', { class: 'hooks-ov-title', text: title }),
      el('div', { class: 'hooks-ov-desc', text: desc })));
  }
  if (list.childNodes.length) card.append(list);
  detail.replaceChildren(card);
}

function runtimeEditor(detail, data) {
  const rc = data.runtimeConfig || { hooks: { session_preload: true, work_flag: true, stop_writeback_gate: true }, writeback_notice: '', work_roots: [] };
  const HOOK_OPTS = [
    ['session_preload', '세션 시작 컨텍스트 주입 (session-preload)'],
    ['work_flag', '작업 플래그 (work-flag)'],
    ['stop_writeback_gate', '종료 시 기록 너지 (writeback-gate)'],
  ];
  const chks = {};
  const hookWrap = el('div', { class: 'scope-wrap' });
  for (const [k, label] of HOOK_OPTS) {
    const chk = el('input', { type: 'checkbox' }); chk.checked = rc.hooks[k] !== false; chks[k] = chk;
    hookWrap.append(el('label', { class: 'admin-check scope-opt' }, chk, ' ' + label));
  }
  const noticeTa = el('textarea', { rows: '3', placeholder: '비우면 기본 안내문 사용' }); noticeTa.value = rc.writeback_notice || '';
  const wrTa = el('textarea', { rows: '4', placeholder: '/Users/you/repo\n줄당 절대경로 한 개' }); wrTa.value = (rc.work_roots || []).join('\n');
  // http_proxy 툴 안전 화이트리스트(B15) — 툴은 이 목록 안에서만 외부 호출/시크릿 참조 가능.
  const envTa = el('textarea', { rows: '3', placeholder: 'ACME_API_TOKEN\n줄당 환경변수 이름 한 개(값 아님)' }); envTa.value = (rc.allowed_auth_envs || []).join('\n');
  const hostTa = el('textarea', { rows: '3', placeholder: 'api.acme.com\n.internal.acme.com (앞에 . = 서브도메인 허용)' }); hostTa.value = (rc.url_allowlist || []).join('\n');
  // DB 데이터소스 안전 화이트리스트 — db_query/db_schema 소스가 접속 허용될 사설/내부 host(외부 공인 DB 는 등록 불요).
  const dbHostTa = el('textarea', { rows: '3', placeholder: 'localhost\ndb.internal.acme.com\n줄당 host 한 개(사설/localhost 만 — 외부 공인 DB 는 불요)' }); dbHostTa.value = (rc.allowed_db_hosts || []).join('\n');
  // 기록 인정 툴(write_tools) — 이 lively MCP 툴을 쓰면 '기록함'으로 보고 종료 너지를 안 띄운다. 비우면 훅 내장 v6 기본목록.
  const writeToolsTa = el('textarea', { rows: '4', placeholder: '비우면 기본 목록 사용\n줄당 lively MCP 툴 이름 한 개 (예: knowledge_save)' }); writeToolsTa.value = (rc.write_tools || []).join('\n');
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const hooks = {}; for (const [k] of HOOK_OPTS) hooks[k] = chks[k].checked;
      const work_roots = wrTa.value.split('\n').map((l) => l.trim()).filter(Boolean);
      const allowed_auth_envs = envTa.value.split('\n').map((l) => l.trim()).filter(Boolean);
      const url_allowlist = hostTa.value.split('\n').map((l) => l.trim()).filter(Boolean);
      const allowed_db_hosts = dbHostTa.value.split('\n').map((l) => l.trim()).filter(Boolean);
      const write_tools = writeToolsTa.value.split('\n').map((l) => l.trim()).filter(Boolean);
      const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ hooks, writeback_notice: noticeTa.value.trim() || null, work_roots, allowed_auth_envs, url_allowlist, allowed_db_hosts, write_tools }) });
      data.runtimeConfig = r.runtimeConfig; status.textContent = '저장됨'; toast('저장됨 — 구성원 다음 세션부터 반영');
    } catch (e) { toast(e.message, true); status.textContent = ''; }
    saveBtn.disabled = false;
  });
  detail.replaceChildren(el('div', { class: 'card' },
    sectionTitle('런타임 훅 (기본 리플렉스)', data.meaning['runtime']),
    el('p', { class: 'admin-hint', text: '게이트웨이가 제공하는 기본 세션 훅(리플렉스)의 ON/OFF 와 작업 폴더를 중앙에서 제어합니다. 구성원 머신은 매 세션 게이트웨이에서 훅을 받아 실행하므로(runner fetch), 변경은 다음 세션에 자동 반영됩니다(재설치 불요). 전체 끄기는 구성원이 LIVELY_OFF=1 로. ※ 코드까지 직접 정의하는 사내 훅은 ‘커스텀 훅’에서, 각 훅이 실제로 주입하는 메시지는 ‘훅 주입 미리보기’에서.' }),
    field('기본 리플렉스 훅 ON/OFF', hookWrap),
    field('writeback 너지 문구 (선택)', noticeTa),
    field('기록 인정 툴 (write_tools) — 이 lively 툴을 쓰면 종료 너지 안 함 · 비우면 기본 목록', writeToolsTa),
    field('work-roots — 이 폴더에서 켠 세션은 라이블리 작업으로 인식 (줄당 절대경로)', wrTa),
    el('div', { class: 'admin-subhead', text: 'AI 도구(http_proxy) 안전 화이트리스트' }),
    el('p', { class: 'admin-hint', text: 'AI 도구가 외부를 호출할 수 있는 범위 — 이 목록 밖은 전부 차단됩니다(SSRF 방어).' }),
    field('허용 인증 환경변수 이름 (allowed_auth_envs)', envTa),
    field('허용 호스트 (url_allowlist)', hostTa),
    el('div', { class: 'admin-subhead', text: 'DB 데이터소스 안전 화이트리스트' }),
    el('p', { class: 'admin-hint', text: 'db_query/db_schema 데이터소스가 접속할 수 있는 사설/내부 host — 이 목록 밖의 사설/localhost 는 차단됩니다(SSRF 방어). 외부 공인 DB 는 등록 불요.' }),
    field('허용 DB host (allowed_db_hosts)', dbHostTa),
    el('div', { class: 'admin-actions' }, saveBtn, status)));
}

// ════════ 임베딩(벡터검색 #172) — provider 토글 + 기존 지식 백필 ════════
//  config SoT = org_runtime_config.embedding_config(DB, 무재시작). 저장 = POST runtime-config{embedding_config}.
//  "뒤늦게 켜기": provider 를 켠다고 이미 저장된 지식이 자동 임베딩되진 않는다(쓰기훅은 신규·수정분만) →
//   [백필] 버튼(POST /api/ui/org/embeddings/backfill)으로 기존 지식을 일괄 임베딩(재실행 안전, 진행 폴링).
function embeddingsEditor(detail, data) {
  const canEdit = !!data.canEdit;
  const body = el('div');
  detail.replaceChildren(el('div', { class: 'card' },
    sectionTitle('임베딩 (벡터검색)', null),
    el('p', { class: 'admin-hint', text: '지식 의미검색·유사도·중복감지가 쓰는 벡터 임베딩을 켜고 끕니다. 기본은 꺼짐(정확 grep 검색으로 폴백). 켜면 OpenAI-compatible /v1/embeddings 엔드포인트(로컬 Ollama 사이드카 또는 외부 API)로 임베딩합니다. 설정은 게이트웨이 재시작 없이 즉시 반영됩니다.' }),
    body));
  body.append(el('p', { class: 'admin-hint', text: '불러오는 중…' }));

  let pollTimer: any = null;
  const stopPoll = () => { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } };
  let projPollTimer: any = null;
  const stopProjPoll = () => { if (projPollTimer) { clearTimeout(projPollTimer); projPollTimer = null; } };

  async function load() {
    let st;
    try { st = await api('/api/ui/org/embeddings'); }
    catch (e: any) { body.replaceChildren(el('p', { class: 'admin-hint', text: '상태를 불러오지 못했습니다: ' + e.message })); return; }
    buildOnce(st);
  }

  // 폼(설정 입력)은 한 번만 짓는다 — 폴링은 statusRegion 만 갱신해 입력 중 리셋되지 않게.
  function buildOnce(st) {
    stopPoll();
    stopProjPoll();
    const cfg = st.config || { provider: 'off', base_url: null, model: null, dimensions: 1024, auth_env_ref: null };
    const on = cfg.provider === 'http';

    const provSel = el('select', { class: 'input' },
      el('option', { value: 'off', text: '꺼짐 — grep 검색으로 폴백' }),
      el('option', { value: 'http', text: '켜짐 — HTTP /v1/embeddings' }));
    provSel.value = on ? 'http' : 'off'; provSel.disabled = !canEdit;
    const baseIn = el('input', { class: 'input', type: 'text', placeholder: 'http://localhost:11434  (로컬 Ollama 사이드카)' });
    baseIn.value = cfg.base_url || ''; baseIn.disabled = !canEdit;
    const modelIn = el('input', { class: 'input', type: 'text', placeholder: 'bge-m3  (한국어 강화 = KURE-v1, 둘 다 1024차원)' });
    modelIn.value = cfg.model || ''; modelIn.disabled = !canEdit;
    const dimIn = el('input', { class: 'input', type: 'number', min: '1', max: '16000', placeholder: '1024' });
    dimIn.value = String(cfg.dimensions || 1024); dimIn.disabled = !canEdit;
    const authIn = el('input', { class: 'input', type: 'text', placeholder: '(선택) 키를 담은 환경변수 이름 — 예: OPENAI_API_KEY (키 값 아님)' });
    authIn.value = cfg.auth_env_ref || ''; authIn.disabled = !canEdit;
    // 성능 튜닝(#602) — 느린/CPU 백엔드는 배치를 낮춰 요청당 시간을 타임아웃 안으로.
    const batchIn = el('input', { class: 'input', type: 'number', min: '1', max: '512', placeholder: '8  (CPU 백엔드 권장 4~8)' });
    batchIn.value = String(cfg.batch_size || 8); batchIn.disabled = !canEdit;
    const timeoutIn = el('input', { class: 'input', type: 'number', min: '1000', max: '3600000', placeholder: '300000  (요청당 ms)' });
    timeoutIn.value = String(cfg.request_timeout_ms || 300000); timeoutIn.disabled = !canEdit;

    const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '설정 저장' }); saveBtn.disabled = !canEdit;
    const saveSt = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true; saveSt.textContent = '';
      try {
        const dims = Number(dimIn.value) || 1024;
        const embedding_config = {
          provider: provSel.value,
          base_url: baseIn.value.trim() || null,
          model: modelIn.value.trim() || null,
          dimensions: dims,
          auth_env_ref: authIn.value.trim() || null,
          batch_size: Number(batchIn.value) || 8,
          request_timeout_ms: Number(timeoutIn.value) || 300000,
        };
        const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ embedding_config }) });
        if (r && r.runtimeConfig) data.runtimeConfig = r.runtimeConfig;
        toast(provSel.value === 'http' ? '임베딩 켜짐 — 기존 지식은 아래 [백필]로 채우세요.' : '저장됨 — 임베딩 꺼짐(서버 .env 시드도 무시됩니다)');
        load(); // 상태 새로고침(백로그·백필 버튼 활성 재계산)
      } catch (e: any) { toast(e.message, true); saveBtn.disabled = false; }
    });

    // #688 설정 출처 안내 — env 시드로 도는지 / 명시적 off 인지(관리탭 저장과 .env 의 우선순위 혼동 방지).
    const srcNote = st.config_source === 'env'
      ? el('p', { class: 'admin-hint', text: '현재 설정은 서버 환경변수(.env EMBEDDINGS_*) 시드로 동작 중입니다 — 여기서 저장하면 관리탭(DB) 설정이 우선하게 됩니다.' })
      : st.config_source === 'db-off'
        ? el('p', { class: 'admin-hint', text: '관리탭에서 명시적으로 꺼둔 상태입니다 — 서버 .env 의 EMBEDDINGS_* 시드는 무시됩니다(다시 켜려면 여기서 켜기 저장).' })
        : null;

    const statusRegion = el('div');
    const projectRegion = el('div');
    body.replaceChildren(
      ...(srcNote ? [srcNote] : []),
      field('벡터 임베딩', provSel),
      field('엔드포인트 base_url (로컬 사이드카 또는 외부 API — 경로 /v1/embeddings 자동 부착)', baseIn),
      field('모델', modelIn),
      field('차원 (모델과 일치해야 함 · 변경 시 전체 재임베딩)', dimIn),
      field('인증 환경변수 이름 (선택 · 외부 API 용 · 시크릿 값 아님)', authIn),
      field('배치 크기 (요청당 텍스트 수 · 느린/CPU 백엔드는 낮춰 타임아웃 회피 · 기본 8)', batchIn),
      field('요청 타임아웃 ms (초과 시 배치를 반으로 줄여 재시도 · 기본 300000)', timeoutIn),
      canEdit ? el('div', { class: 'admin-actions' }, saveBtn, saveSt) : el('p', { class: 'admin-hint', text: '※ 편집은 관리자만 가능합니다.' }),
      el('div', { class: 'admin-subhead', text: '기존 지식 임베딩 (뒤늦게 켠 경우)' }),
      el('p', { class: 'admin-hint', text: '임베딩을 켜도 이미 저장된 지식은 자동으로 채워지지 않습니다(켠 이후의 신규·수정분만 자동). 아래로 기존 지식을 일괄 임베딩하세요 — 중단/재실행해도 안전합니다.' }),
      statusRegion,
      el('div', { class: 'admin-subhead', text: '프로젝트 임베딩 (프로젝트·태스크·서브태스크 검색용 · #631/#624)' }),
      el('p', { class: 'admin-hint', text: '프로젝트·태스크·서브태스크의 이름/설명을 임베딩합니다. 임베딩 켠 이후의 생성·수정·동기화분은 자동(텍스트가 실제 바뀔 때만), 기존분은 아래로 일괄. 지식과 같은 임베딩 설정을 씁니다.' }),
      projectRegion);
    updateStatus(st, statusRegion);
    loadProjectStatus(projectRegion);
  }

  // #688 백필 실패 사유별 처방 — 한 줄 reason 만으론 원인 파악이 어려웠던 실사례(어니스트 박스)의 판독표를 UI 로.
  function backfillReasonNotice(reason: string): string {
    if (reason === 'off') return '임베딩 설정이 꺼져 있습니다 — 위에서 켠 뒤 저장하세요.';
    if (reason === 'unavailable') return '임베딩 엔드포인트 연결/응답 실패 — base_url 과 사이드카(예: Ollama 컨테이너) 상태를 확인하세요. 엔드포인트가 살아 있는데도 반복되면 과부하일 수 있습니다: 배치 크기를 줄이고(예 2) 요청 타임아웃을 늘려(예 600000) 저장 후 재시도하세요.';
    if (reason === 'schema') return 'pgvector 스키마가 없습니다 — items-db 컨테이너가 pgvector 이미지인지 확인하세요.';
    if (/timeout|abort/i.test(reason)) return '임베딩 요청이 요청 타임아웃을 초과했습니다(느린 CPU 백엔드에서 흔함) — 배치 크기를 줄이고(예 2) 요청 타임아웃을 늘려(예 600000) 저장한 뒤 재시도하세요.';
    return '오류가 반복되면 게이트웨이 로그를 확인하세요.';
  }

  // 백로그·잡 진행만 갱신(폼은 그대로). 잡이 돌면 폴링.
  function updateStatus(st, region) {
    const cfg = st.config || { provider: 'off' };
    const on = cfg.provider === 'http';
    const backlog = st.backlog || { total: 0, pending: 0 };
    const job = st.job;
    const embedded = Math.max(0, (backlog.total || 0) - (backlog.pending || 0));
    const running = !!(job && job.running);

    const bfBtn = el('button', { class: 'btn btn-sm', text: running ? '백필 진행 중…' : '기존 지식 임베딩(백필)' });
    bfBtn.disabled = !canEdit || !on || running || (backlog.pending || 0) === 0;
    const bfSt = el('span', { class: 'admin-status' });
    if (!on) bfSt.textContent = '먼저 임베딩을 켜고 저장하세요.';
    else if ((backlog.pending || 0) === 0 && !running) bfSt.textContent = '모두 임베딩됨 ✓';
    bfBtn.addEventListener('click', async () => {
      bfBtn.disabled = true;
      try {
        await api('/api/ui/org/embeddings/backfill', { method: 'POST', body: JSON.stringify({ mode: 'pending' }) });
        toast('백필 시작 — 진행 상황을 표시합니다.');
        poll();
      } catch (e: any) { toast(e.message, true); bfBtn.disabled = false; }
    });

    const jobLine = el('div', { class: 'admin-hint' });
    if (job) {
      if (job.running) jobLine.textContent = `백필 진행: ${fmtNum(job.done)}/${fmtNum(job.total)} …`;
      else if (job.reason) {
        // #688 실패 사유 배너 — reason 원문 + 원인별 처방(admin-warn 코랄 박스).
        jobLine.className = 'admin-warn';
        jobLine.replaceChildren(
          el('div', { text: `⚠ 직전 백필 미완료: ${job.reason}` }),
          el('div', { text: backfillReasonNotice(String(job.reason)) }));
      }
      else if (job.finishedAt) jobLine.textContent = `직전 백필 완료: ${fmtNum(job.embedded)}건 (${absTime(job.finishedAt)}).`;
    }

    region.replaceChildren(
      el('p', { class: 'admin-hint', text: `기존 지식 ${fmtNum(backlog.total)}건 중 임베딩 ${fmtNum(embedded)}건 · 미임베딩 ${fmtNum(backlog.pending)}건.` }),
      jobLine,
      el('div', { class: 'admin-actions' }, bfBtn, bfSt));

    stopPoll();
    if (running) poll(region);
  }

  function poll(region?) {
    stopPoll();
    pollTimer = setTimeout(async () => {
      if (!body.isConnected) { stopPoll(); return; } // 다른 섹션으로 이동 → 폴링 종료(누수 방지)
      try {
        const st = await api('/api/ui/org/embeddings');
        const r = region || (body.lastChild as any);
        // region 이 사라졌으면 전체 재빌드(안전) — 보통은 statusRegion 재갱신.
        if (r && r.replaceChildren) updateStatus(st, r); else buildOnce(st);
      } catch (_) { poll(region); } // 일시 실패 → 재시도
    }, 1500);
  }

  // 프로젝트 임베딩(#631/#624) 백필 — 지식 백필과 동형(대상만 project 엔드포인트). 같은 embedding_config 공유·자체 폴링.
  function renderProjectStatus(st, region) {
    const on = (st.config && st.config.provider) === 'http';
    const backlog = st.backlog || { total: 0, pending: 0 };
    const job = st.job;
    const embedded = Math.max(0, (backlog.total || 0) - (backlog.pending || 0));
    const running = !!(job && job.running);

    const bfBtn = el('button', { class: 'btn btn-sm', text: running ? '프로젝트 백필 진행 중…' : '프로젝트 임베딩(백필)' });
    bfBtn.disabled = !canEdit || !on || running || (backlog.pending || 0) === 0;
    const bfSt = el('span', { class: 'admin-status' });
    if (!on) bfSt.textContent = '먼저 임베딩을 켜고 저장하세요.';
    else if ((backlog.pending || 0) === 0 && !running) bfSt.textContent = '모두 임베딩됨 ✓';
    bfBtn.addEventListener('click', async () => {
      bfBtn.disabled = true;
      try {
        await api('/api/ui/org/project-embeddings/backfill', { method: 'POST', body: JSON.stringify({ mode: 'pending' }) });
        toast('프로젝트 백필 시작 — 진행 상황을 표시합니다.');
        pollProj(region);
      } catch (e: any) { toast(e.message, true); bfBtn.disabled = false; }
    });

    const jobLine = el('div', { class: 'admin-hint' });
    if (job) {
      if (job.running) jobLine.textContent = `백필 진행: ${fmtNum(job.done)}/${fmtNum(job.total)} …`;
      else if (job.reason) {
        // #688 실패 사유 배너 — reason 원문 + 원인별 처방(admin-warn 코랄 박스).
        jobLine.className = 'admin-warn';
        jobLine.replaceChildren(
          el('div', { text: `⚠ 직전 백필 미완료: ${job.reason}` }),
          el('div', { text: backfillReasonNotice(String(job.reason)) }));
      }
      else if (job.finishedAt) jobLine.textContent = `직전 백필 완료: ${fmtNum(job.embedded)}건 (${absTime(job.finishedAt)}).`;
    }

    region.replaceChildren(
      el('p', { class: 'admin-hint', text: `프로젝트 ${fmtNum(backlog.total)}건 중 임베딩 ${fmtNum(embedded)}건 · 미임베딩 ${fmtNum(backlog.pending)}건.` }),
      jobLine,
      el('div', { class: 'admin-actions' }, bfBtn, bfSt));

    stopProjPoll();
    if (running) pollProj(region);
  }

  function pollProj(region) {
    stopProjPoll();
    projPollTimer = setTimeout(async () => {
      if (!body.isConnected) { stopProjPoll(); return; } // 다른 섹션으로 이동 → 폴링 종료(누수 방지)
      try { const st = await api('/api/ui/org/project-embeddings'); renderProjectStatus(st, region); }
      catch (_) { pollProj(region); } // 일시 실패 → 재시도
    }, 1500);
  }

  async function loadProjectStatus(region) {
    try { const st = await api('/api/ui/org/project-embeddings'); renderProjectStatus(st, region); }
    catch (e: any) { region.replaceChildren(el('p', { class: 'admin-hint', text: '프로젝트 임베딩 상태를 불러오지 못했습니다: ' + e.message })); }
  }

  load();
}

// ── 훅 주입 미리보기(V4-P5 J절) — 설치된 3 세션 훅이 각자 세션에 실제로 주입하는 최종 메시지를 보여준다. ──
//  데이터 출처: GET /api/ui/org/hooks/preview (scope null = 인증만, REST 전용). 읽기 전용.
//  보안: 모든 데이터 텍스트는 textContent(el text:)/renderMarkdown(createElement+textContent) 로만 — innerHTML 데이터주입 0.
//  드리프트 정직성: 서버가 fidelity(exact/approximate)와 source 를 함께 주므로 그대로 표기(근사면 사유 명시).
function hooksPreviewPanel(detail, data) {
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '훅 주입 미리보기 (읽기 전용)' })),
    el('p', { class: 'admin-hint', text: '구성원 머신에 설치된 세션 훅이 각자 세션 컨텍스트에 실제로 무엇을 주입하는지, 그 최종 메시지를 보여줍니다. 훅을 고르면 그 훅이 넣는 메시지 전문을 미리볼 수 있습니다. exact=게이트웨이/설치파일이 단일 출처(드리프트 없음), approximate=멤버 머신이 세션마다 동적으로 덧붙이는 부분이 있어 일부만 재현됩니다.' }));
  detail.replaceChildren(card);

  const loading = el('p', { class: 'admin-hint', text: '불러오는 중…' });
  card.append(loading);
  api('/api/ui/org/hooks/preview').then((r) => {
    loading.remove();
    const hooks = (r && r.hooks) || [];
    if (!hooks.length) { card.append(el('p', { class: 'empty', text: '미리볼 세션 훅이 없습니다.' })); return; }
    let sel = state.admin.hookPreviewSel;
    if (!hooks.some((h) => h.id === sel)) sel = hooks[0].id;
    state.admin.hookPreviewSel = sel;

    const listCol = el('div', { class: 'admin-sublist admin-sublist-row' }); // 훅 목록은 가로 카드 배치
    for (const h of hooks) {
      const fidLabel = h.fidelity === 'exact' ? '정확' : '근사';
      listCol.append(el('div', { class: 'mini-row' + (h.id === sel ? ' sel' : ''),
        onclick: () => { state.admin.hookPreviewSel = h.id; renderHookPreviewDetail(); } },
        el('div', { class: 'mini-title', text: h.title || h.id },
          el('span', { class: 'pill', text: h.event })),
        el('div', { class: 'mini-meta' },
          el('span', { class: 'src-status' }, el('span', { class: 'dot6 ' + (h.fidelity === 'exact' ? 'ok' : 'dim'), 'aria-hidden': 'true' }), fidLabel), ' · ' + h.id)));
    }
    const right = el('div', {});
    card.append(el('div', { class: 'admin-two' }, listCol, right));

    function renderHookPreviewDetail() {
      for (const row of listCol.querySelectorAll('.mini-row')) row.classList.remove('sel');
      const idx = hooks.findIndex((h) => h.id === state.admin.hookPreviewSel);
      const rows = listCol.querySelectorAll('.mini-row');
      if (rows[idx]) rows[idx].classList.add('sel');
      const h = hooks[idx] || hooks[0];

      const metaTable = el('table', { class: 'fields-table' });
      const metaRows = [
        ['훅 id', h.id],
        ['이벤트(주입 시점)', h.event],
        ['충실도', (h.fidelity === 'exact' ? '정확(exact) — 게이트웨이/설치파일이 단일 출처, 드리프트 없음' : '근사(approximate) — 일부는 멤버 머신이 세션마다 동적 생성, 미포함')],
        ['출처', h.source],
      ];
      for (const [k, v] of metaRows) metaTable.append(el('tr', {}, el('td', { text: k }), el('td', { text: v })));

      const msg = h.message || '';
      const detailBody = el('div', {},
        el('h3', { text: h.title || h.id }),
        metaTable,
        el('div', { class: 'sec-label', style: 'margin-top:14px' }, '세션에 주입되는 최종 메시지'));

      if (!msg) {
        // work-flag 처럼 주입 메시지가 없는 훅 — provably empty 임을 명시(빈 pre 대신 안내).
        detailBody.append(el('p', { class: 'admin-hint', text: '이 훅은 컨텍스트를 주입하지 않습니다(세션 플래그만 기록). 주입 메시지 없음.' }));
      } else {
        // 메시지 전문 — 서식(마크다운 안전 렌더)/원문 토글. 마크다운 본문 뷰어 재사용(innerHTML 미사용).
        let showRaw = false;
        const rendered = el('div', { class: 'md-rendered admin-md-box' }, renderMarkdown(msg));
        const raw = el('pre', { class: 'admin-preview' }); raw.textContent = msg; raw.hidden = true;
        const toggle = el('button', { class: 'btn btn-ghost btn-sm', text: '원문 보기' });
        toggle.addEventListener('click', () => {
          showRaw = !showRaw; rendered.hidden = showRaw; raw.hidden = !showRaw;
          toggle.textContent = showRaw ? '서식 보기' : '원문 보기';
        });
        detailBody.append(el('div', { class: 'admin-actions' }, toggle), rendered, raw);
      }
      right.replaceChildren(detailBody);
    }
    renderHookPreviewDetail();
  }).catch((e) => {
    // 라이브가 구 빌드면 404(엔드포인트 next-restart) — 정직하게 안내.
    loading.remove();
    card.append(errorNote(e, '훅 미리보기를 불러오지 못했습니다(서버 재시작 후 제공)'));
  });
}

// ── MCP 서버 레지스트리 — admin 전용 ──
function mcpEditor(detail, data) {
  const servers = data.mcpServers || [];
  const sel = state.admin.mcpSel;
  const listCol = el('div', { class: 'admin-sublist' });
  listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ MCP 서버 추가',
    onclick: () => { state.admin.mcpSel = '__new__'; renderAdminDetail(detail, 'mcp', data); } }));
  for (const s of servers) {
    listCol.append(el('div', { class: 'mini-row' + (s.name === sel ? ' sel' : ''),
      onclick: () => { state.admin.mcpSel = s.name; renderAdminDetail(detail, 'mcp', data); } },
      el('div', { class: 'mini-title', text: s.name }, s.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null),
      el('div', { class: 'mini-meta', text: (s.transport || 'http') + ' · ' + (s.transport === 'stdio' ? (s.command || '-') : (s.url || '-')) })));
  }
  const right = el('div', {});
  const editing = sel === '__new__' ? { name: '', transport: 'http', url: '', command: '', auth_env: '', note: '', enabled: true } : servers.find((s) => s.name === sel);
  if (editing) mcpForm(right, editing, data, detail, sel === '__new__');
  else right.append(el('p', { class: 'admin-hint', text: 'lively 게이트웨이는 기본 등록됩니다. 여기엔 추가 도구(MCP 서버)를 둡니다. 인증은 환경변수 이름만(시크릿 값 금지).' }));
  detail.replaceChildren(el('div', { class: 'card' }, sectionTitle('MCP 서버', data.meaning['mcp']), el('div', { class: 'admin-two' }, listCol, right)));
}

function mcpForm(root, s, data, detail, isNew) {
  const nameIn = el('input', { type: 'text', value: s.name, placeholder: '서버 이름(영문/숫자)', disabled: isNew ? null : '' });
  const transSel = el('select', {}, ...['http', 'stdio'].map((t) => el('option', { value: t, text: t })));
  transSel.value = s.transport || 'http';
  const urlIn = el('input', { type: 'text', value: s.url || '', placeholder: 'http://host:port/mcp' });
  const cmdIn = el('input', { type: 'text', value: s.command || '', placeholder: 'node /path/server.mjs --arg' });
  const authIn = el('input', { type: 'text', value: s.auth_env || '', placeholder: '예: ACME_TOKEN (값 아님)' });
  const noteIn = el('input', { type: 'text', value: s.note || '', placeholder: '설명(선택)' });
  const enChk = el('input', { type: 'checkbox' }); enChk.checked = s.enabled !== false;
  const urlField = field('URL (http)', urlIn);
  const cmdField = field('command (stdio)', cmdIn);
  const syncTransport = () => { urlField.style.display = transSel.value === 'http' ? '' : 'none'; cmdField.style.display = transSel.value === 'stdio' ? '' : 'none'; };
  transSel.addEventListener('change', syncTransport);
  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    if (!nameIn.value.trim()) { toast('이름 필수', true); return; }
    saveBtn.disabled = true;
    try {
      const http = transSel.value === 'http';
      const payload = { name: nameIn.value.trim(), transport: transSel.value, url: http ? urlIn.value.trim() : null, command: http ? null : cmdIn.value.trim(), auth_env: authIn.value.trim() || null, note: noteIn.value.trim() || null, enabled: enChk.checked };
      await api('/api/ui/org/mcp-server', { method: 'POST', body: JSON.stringify(payload) });
      await loadAdmin(true); state.admin.mcpSel = payload.name; toast('저장됨 — 다음 설치/업데이트 시 등록'); renderAdminDetail(detail, 'mcp', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
    if (!confirm(`MCP 서버 '${s.name}' 제거?`)) return;
    try { await api('/api/ui/org/mcp-server/remove', { method: 'POST', body: JSON.stringify({ name: s.name }) }); await loadAdmin(true); state.admin.mcpSel = null; toast('제거됨'); renderAdminDetail(detail, 'mcp', state.admin.data); }
    catch (e) { toast(e.message, true); }
  } }));
  root.replaceChildren(
    field('이름', nameIn), field('전송 방식', transSel), urlField, cmdField,
    field('인증 환경변수 이름 (auth_env)', authIn), field('설명', noteIn),
    el('label', { class: 'admin-check' }, enChk, ' 활성'),
    actions);
  syncTransport();
}

// ── 커넥터(외부 소스) — admin 전용 (프로젝트 #541 · #586 UX 개편). ──
//  #586: 활성화=자동 싱크(sync-<system> 크론 자동 등록/해제 — 스케줄러 별도 등록 불필요),
//  [지금 싱크]=비동기 run(connector_run 엔티티 — 로그·진행상황 폴링, 프록시 타임아웃 없음),
//  스코프 픽커([목록에서 선택] — discover API 로 노션 페이지/클릭업 리스트 조회), 토큰 발급 가이드.
function connectorEditor(detail, data) {
  const connectors = data.connectors || [];
  const sel = state.admin.connectorSel || (connectors[0] && connectors[0].system);
  const listCol = el('div', { class: 'admin-sublist' });
  for (const c of connectors) {
    const setCount = Object.values(c.secretsSet || {}).filter(Boolean).length;
    const secTotal = (c.fields || []).filter((f) => f.secret).length;
    listCol.append(el('div', { class: 'mini-row' + (c.system === sel ? ' sel' : ''),
      onclick: () => { state.admin.connectorSel = c.system; renderAdminDetail(detail, 'connectors', data); } },
      el('div', { class: 'mini-title', text: c.label }, c.enabled ? el('span', { class: 'pill', text: '자동 싱크' }) : null),
      el('div', { class: 'mini-meta', text: secTotal ? `토큰 ${setCount}/${secTotal} 설정` : '설정' })));
  }
  const right = el('div', {});
  const editing = connectors.find((c) => c.system === sel);
  if (editing) {
    connectorStatusCard(right, editing);
    connectorForm(right, editing, data, detail);
  } else right.append(el('p', { class: 'admin-hint', text: '커넥터를 선택하세요.' }));
  // ClickUp 멤버 매핑 패널(#541) — clickup 선택 시에만(db-sources 의 renderDbPolicyPanel 패턴).
  if (editing && editing.system === 'clickup') {
    const panel = el('div', { class: 'card', style: 'margin-top:12px' });
    right.append(panel);
    void renderClickupMemberPanel(panel);
  }
  const banner = (editing && editing.secrets_enabled === false)
    ? el('div', { class: 'admin-hint', text: '⚠ CONNECTOR_SECRET_KEY 미설정 — 토큰 암호화 저장이 비활성입니다. 게이트웨이 .env 에 CONNECTOR_SECRET_KEY(openssl rand -hex 32)를 설정하면 여기서 토큰을 저장할 수 있습니다(그 전엔 .env 폴백만 동작).' })
    : null;
  detail.replaceChildren(el('div', { class: 'card' }, sectionTitle('커넥터(외부 소스)', data.meaning && data.meaning['connector']), banner,
    el('div', { class: 'admin-two' }, listCol, right)));
}

// 실행 상태 라벨/소요 — run 카드·기록·로그 공용.
function runStatusLabel(st) { return st === 'ok' ? '✅ 성공' : st === 'running' ? '⏳ 진행 중' : st === 'canceled' ? '⏹ 중지됨' : '❌ 실패'; }
function runDurLabel(a, b) {
  const s = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
}

// 상태 카드(#586) — 자동 싱크 상태 + 최근 실행 + [지금 싱크]/[전체 다시 싱크]/[실행 기록].
function connectorStatusCard(root, c) {
  const dot = el('span', { class: c.enabled ? 'st ok' : 'st dim', text: c.enabled ? '자동 싱크 켬' : '자동 싱크 꺼짐' });
  const jobText = c.enabled
    ? (c.sync_job && c.sync_job.enabled
        ? ` · ${Math.max(1, Math.round((c.sync_job.interval_sec || 600) / 60))}분마다 자동 실행`
        : ' · 저장하면 자동 싱크가 등록됩니다')
    : ' · 켜고 저장하면 자동 싱크가 시작됩니다';
  const lastLine = el('div', { class: 'admin-hint', text: '실행 이력 확인 중…' });
  const syncBtn = el('button', { class: 'btn btn-primary btn-sm', text: '지금 싱크',
    title: '백그라운드로 즉시 실행 — 로그 창이 열립니다', onclick: () => startSyncRun(c.system, false) });
  const fullBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '전체 다시 싱크',
    title: '커서를 무시하고 전체 재수집(삭제/보관 전파 포함) — 페이지 수에 비례해 오래 걸립니다',
    onclick: () => { if (confirm('전체를 다시 수집할까요? 원본 규모에 따라 몇 분~수십 분 걸립니다(백그라운드 실행).')) startSyncRun(c.system, true); } });
  const runsBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '실행 기록', onclick: () => openConnectorRuns(c) });
  root.append(el('div', { class: 'conn-status' },
    el('div', { class: 'conn-status-line' }, dot, el('span', { class: 'mini-meta', text: jobText })),
    lastLine,
    el('div', { class: 'admin-actions conn-status-actions' }, syncBtn, fullBtn, runsBtn)));
  (async () => {
    try {
      const r = await api('/api/ui/org/connector/runs?' + new URLSearchParams({ system: c.system, limit: '1' }));
      const run = (r.runs || [])[0];
      if (!run) { lastLine.textContent = '아직 실행 이력이 없습니다 — 토큰 저장 후 [지금 싱크]로 시작하세요.'; return; }
      lastLine.replaceChildren(
        el('span', { text: `최근 실행: ${runStatusLabel(run.status)}${run.stale ? ' ⚠ 추적 끊김' : ''} · ${run.mode === 'full' ? '전체' : '증분'} · ${relTime(run.started_at)}` +
          (run.finished_at ? ` · ${runDurLabel(run.started_at, run.finished_at)}` : '') }),
        ' ',
        el('a', { href: '#', text: '로그 보기', onclick: (e) => { e.preventDefault(); openRunLog(c.system, run.id); } }));
    } catch (_) { lastLine.textContent = ''; }
  })();
}

// 비동기 싱크 시작(#586) — run_id 즉시 수신 → 로그 창(진행 폴링). 프록시 타임아웃과 무관.
async function startSyncRun(system, full) {
  try {
    const r = await api('/api/ui/org/connector/sync', { method: 'POST', body: JSON.stringify({ system, full: !!full }) });
    toast(r.already_running ? '이미 실행 중이라 그 실행의 로그를 엽니다' : '싱크를 시작했습니다(백그라운드)');
    openRunLog(system, r.run_id);
  } catch (e) { toast('싱크 시작 실패 — ' + e.message, true); }
}

// 실행 기록(#586) — 최근 20건. 행 클릭 = 로그.
async function openConnectorRuns(c) {
  const listBox = el('div', { class: 'run-list' }, el('p', { class: 'admin-hint', text: '불러오는 중…' }));
  overlay(`실행 기록 · ${c.label}`, listBox);
  try {
    const r = await api('/api/ui/org/connector/runs?' + new URLSearchParams({ system: c.system, limit: '20' }));
    const runs = r.runs || [];
    if (!runs.length) { listBox.replaceChildren(el('p', { class: 'admin-hint', text: '실행 이력이 없습니다.' })); return; }
    listBox.replaceChildren(...runs.map((run) => el('div', { class: 'mini-row', onclick: () => openRunLog(c.system, run.id) },
      el('div', { class: 'mini-title', text: `${runStatusLabel(run.status)}${run.stale ? ' ⚠ 추적 끊김' : ''}  ${run.mode === 'full' ? '전체' : '증분'} · ${run.trigger === 'manual' ? '수동' : '자동'}` }),
      el('div', { class: 'mini-meta', text: `${relTime(run.started_at)}${run.finished_at ? ` · ${runDurLabel(run.started_at, run.finished_at)}` : ' · 진행 중'} · run #${run.id}` }))));
  } catch (e) { listBox.replaceChildren(el('p', { class: 'admin-hint', text: '로드 실패: ' + e.message })); }
}

// run 로그 뷰(#586) — 진행 중이면 2초 폴링으로 청크를 이어붙인다(창 닫으면 중단).
async function openRunLog(system, runId) {
  const status = el('div', { class: 'admin-hint', text: '불러오는 중…' });
  const cancelBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '⏹ 중지', style: 'display:none', onclick: async () => {
    if (!confirm('이 실행을 중지할까요? 커서가 전진하지 않아 데이터 손실은 없고, 다음 실행이 이어서 재수집합니다.')) return;
    try { const r = await api(`/api/ui/org/connector/runs/${runId}/cancel`, { method: 'POST', body: '{}' }); toast(r.message || (r.ok === false ? '중지 실패' : '중지 요청됨'), r.ok === false); }
    catch (e) { toast('중지 실패 — ' + e.message, true); }
  } });
  const head = el('div', { class: 'run-log-head' }, status, cancelBtn);
  const pre = el('pre', { class: 'run-log' });
  const back = overlay(`싱크 로그 · ${system} · run #${runId}`, head, pre);
  let offset = 0;
  let timer: any = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const tick = async () => {
    if (!document.body.contains(back)) { stop(); return; } // 창 닫힘 → 폴링 중단
    try {
      let r;
      // 드레인 루프 — 완료된 긴 로그(청크 64KB 초과)도 한 tick 에 끝까지 이어붙인다(가드 100청크 ≈ 6.5MB).
      for (let i = 0; i < 100; i++) {
        r = await api(`/api/ui/org/connector/runs/${runId}?offset=${offset}`);
        const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
        if (r.skipped > 0) pre.append(document.createTextNode(`\n[…앞부분 ${r.skipped.toLocaleString()}자 잘림(로그 캡)…]\n`));
        if (r.log_chunk) pre.append(document.createTextNode(r.log_chunk));
        if (r.next_offset != null) offset = r.next_offset;
        if (atBottom) pre.scrollTop = pre.scrollHeight;
        if (offset >= (r.log_size ?? 0)) break;
      }
      status.textContent = `${runStatusLabel(r.status)} · ${r.mode === 'full' ? '전체' : '증분'} · 시작 ${relTime(r.started_at)}`
        + (r.finished_at ? ` · 소요 ${runDurLabel(r.started_at, r.finished_at)}` : r.stale
          ? ' · ⚠ 추적 끊김(게이트웨이 재시작 추정) — 곧 자동 정리되며, 재시작 직후라면 새로 싱크를 시작하세요'
          : ' · 진행 중 — 자동 갱신');
      cancelBtn.style.display = r.status === 'running' ? '' : 'none';
      if (r.status !== 'running') stop();
    } catch (e) { status.textContent = '로그 로드 실패: ' + e.message; stop(); }
  };
  await tick();
  if (!timer) timer = setInterval(tick, 2000);
}

// 스코프 픽커(#586) — 저장된 토큰으로 소스의 선택지(discover)를 조회해 체크박스로 고른다. id 복붙 제거.
async function openScopePicker(c, f, inp) {
  const box = el('div', {}, el('p', { class: 'admin-hint', text: `${c.label}에서 목록을 조회하는 중…` }));
  const back = overlay(`${f.label || f.key} — 목록에서 선택`, box);
  try {
    const r = await api('/api/ui/org/connector/discover', { method: 'POST', body: JSON.stringify({ system: c.system }) });
    const opts = (r.fields && r.fields[f.key]) || [];
    if (!opts.length) { box.replaceChildren(el('p', { class: 'admin-hint', text: r.note || '고를 항목이 없습니다 — 값을 직접 입력하세요.' })); return; }
    const multi = f.key !== 'container_list_id'; // 컨테이너는 1개(라디오)
    // 기존 입력값(URL/슬러그/id 혼재 가능)과 옵션 id 매칭 — 끝 32hex 정규화 비교(노션), 그 외 원문 비교.
    const normId = (v) => { const h = String(v).toLowerCase().replace(/[^0-9a-f]/g, ''); return h.length >= 32 ? h.slice(-32) : String(v).trim(); };
    const selected = new Set(String(inp.value || '').split(',').map((x) => normId(x)).filter(Boolean));
    const checks = new Map();
    const rows = opts.map((o) => {
      const cb = el('input', { type: multi ? 'checkbox' : 'radio', name: 'conn-scope-pick' });
      cb.checked = selected.has(normId(o.id));
      checks.set(o.id, cb);
      const icon = o.kind === 'database' ? '🗄' : o.kind === 'root_page' ? '📄' : o.kind === 'list' ? '📋' : '·';
      return el('label', { class: 'conn-pick-item' }, cb,
        el('span', { class: 'conn-pick-label', text: `${icon} ${o.label}` }),
        el('span', { class: 'mini-meta mono', text: String(o.id).slice(0, 10) + '…' }));
    });
    const apply = el('button', { class: 'btn btn-primary btn-sm', text: '적용', onclick: () => {
      const ids = [...checks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
      inp.value = ids.join(',');
      back.remove();
      toast(ids.length ? `${ids.length}개 선택됨 — [저장]을 눌러야 반영됩니다` : '선택을 비웠습니다 — [저장]을 눌러야 반영됩니다');
    } });
    box.replaceChildren(
      r.note ? el('p', { class: 'admin-hint', text: r.note }) : null,
      el('div', { class: 'conn-pick-list' }, ...rows),
      el('div', { class: 'admin-actions' }, apply));
  } catch (e) { box.replaceChildren(el('p', { class: 'admin-hint', text: '조회 실패: ' + e.message })); }
}

function connectorForm(root, c, data, detail) {
  const inputs: Record<string, { el: any; secret: boolean }> = {}; // key → { el, secret }
  const fieldEls: any[] = [];
  for (const f of (c.fields || [])) {
    let inp;
    if (f.secret) {
      const isSet = c.secretsSet && c.secretsSet[f.key];
      inp = el('input', { type: 'password', value: '', placeholder: isSet ? '● 설정됨 — 변경할 때만 입력' : (f.hint || '미설정') });
    } else {
      inp = el('input', { type: 'text', value: (c.config && c.config[f.key]) || '', placeholder: f.hint || '' });
    }
    inputs[f.key] = { el: inp, secret: !!f.secret };
    const lbl = (f.label || f.key) + (f.required ? ' *' : '') + (f.secret ? ' 🔒' : '');
    // 스코프 픽커(#586) — picker 지정 필드는 입력 옆 [목록에서 선택].
    const ctrl = f.picker
      ? el('div', { class: 'conn-pick-row' }, inp,
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '목록에서 선택',
            title: '저장된 토큰으로 소스에서 목록을 조회해 고릅니다', onclick: () => openScopePicker(c, f, inp) }))
      : inp;
    fieldEls.push(field(lbl, ctrl));
  }
  // 토큰 발급 가이드(#586) — 접이식(처음 설정하는 사람 기준 단계별).
  let guideEl: any = null;
  if (c.guide && (c.guide.steps || []).length) {
    guideEl = el('details', { class: 'conn-guide', ...(Object.values(c.secretsSet || {}).some(Boolean) ? {} : { open: '' }) },
      el('summary', { text: `🔑 ${c.label} 토큰 발급 방법` }));
    if (c.guide.intro) guideEl.append(el('p', { class: 'admin-hint', text: c.guide.intro }));
    const ol = el('ol', { class: 'conn-guide-steps' });
    for (const st of (c.guide.steps || [])) ol.append(el('li', { text: st }));
    guideEl.append(ol);
    if (c.guide.url) guideEl.append(el('p', { class: 'conn-guide-link' },
      el('a', { href: c.guide.url, target: '_blank', rel: 'noopener noreferrer', text: '발급 페이지 열기 ↗' })));
  }
  const enChk = el('input', { type: 'checkbox' }); enChk.checked = !!c.enabled;
  const noteIn = el('input', { type: 'text', value: c.note || '', placeholder: '메모(선택)' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const config: Record<string, string> = {}, secrets: Record<string, string> = {};
      for (const k of Object.keys(inputs)) {
        const { el: inp, secret } = inputs[k];
        const v = inp.value;
        if (secret) { if (v) secrets[k] = v; } // 빈=미변경(기존 암호문 유지)
        else config[k] = (v || '').trim();
      }
      const payload = { system: c.system, enabled: enChk.checked, config, secrets, note: noteIn.value.trim() || null };
      await api('/api/ui/org/connector', { method: 'POST', body: JSON.stringify(payload) });
      await loadAdmin(true); state.admin.connectorSel = c.system;
      toast(enChk.checked ? '저장됨 — 자동 싱크 등록(10분 주기). [지금 싱크]로 바로 시작할 수 있어요' : '저장됨 — 자동 싱크 꺼짐');
      renderAdminDetail(detail, 'connectors', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn);
  actions.append(el('button', { class: 'btn-text', text: '초기화(.env 폴백)', onclick: async () => {
    if (!confirm(`${c.label} 설정·토큰을 제거하고 .env 폴백으로 되돌릴까요?`)) return;
    try { await api('/api/ui/org/connector/remove', { method: 'POST', body: JSON.stringify({ system: c.system }) }); await loadAdmin(true); toast('초기화됨'); renderAdminDetail(detail, 'connectors', state.admin.data); }
    catch (e) { toast(e.message, true); }
  } }));
  root.append(
    guideEl,
    el('label', { class: 'admin-check' }, enChk, ' 싱크 활성 — 켜고 저장하면 자동 싱크(10분 주기)가 함께 등록됩니다'),
    ...fieldEls,
    field('메모', noteIn),
    el('p', { class: 'admin-hint', text: '🔒 토큰은 게이트웨이 키로 암호화되어 저장됩니다. 값을 비워두면 기존 토큰이 유지됩니다.' }),
    actions);
}

// ── ClickUp 멤버 매핑(#541) — ClickUp 팀 멤버 ↔ 구성원(org_member) 연결 패널. ──
//  어사이니 해소는 person_identity(system='clickup') → org_member 로 이뤄지고, 수동 매핑의 SoT 는
//  org_member.identities(JSONB) — 저장/해제는 POST /api/ui/org/member(identities 병합) 재사용(서버가
//  person_identity 로 즉시 동기). 매핑 상태는 GET /api/ui/org/connector/clickup/members 가 계산해 준다.
async function renderClickupMemberPanel(panel) {
  panel.replaceChildren(el('p', { class: 'admin-hint', text: 'ClickUp 멤버 불러오는 중…' }));
  let res;
  try { res = await api('/api/ui/org/connector/clickup/members'); }
  catch (e) { panel.replaceChildren(el('p', { class: 'admin-hint', text: 'ClickUp 멤버 로드 실패: ' + e.message })); return; }
  const head = sectionTitle('ClickUp 멤버 매핑', null);
  const intro = el('p', { class: 'admin-hint', text: 'ClickUp 담당자(어사이니)를 구성원으로 연결합니다 — 연결하면 다음 싱크부터 태스크 담당자가 해당 구성원으로 매칭돼요. 이메일이 같으면 자동매치 후보가 미리 선택됩니다.' });
  if (res.error) { panel.replaceChildren(head, el('p', { class: 'admin-hint', text: '⚠ ' + res.error })); return; }
  const users = res.users || [];
  if (!users.length) { panel.replaceChildren(head, intro, el('p', { class: 'admin-hint', text: 'ClickUp 팀 멤버가 없습니다.' })); return; }
  const members = (state.admin.data && state.admin.data.members) || [];
  const activeMembers = members.filter((m) => (m.state || 'active') === 'active');
  const nameOf = (id) => { const m = members.find((x) => x.id === id); return m ? (m.display_name || m.id) : id; };
  // 저장/해제 공통 — 대상 구성원의 identities 에 clickup 신원을 병합(add)/제거(remove) 후 부분 페이로드
  //  { id, identities } 로 POST(다른 필드는 서버가 보존 — 낡은 화면값으로 덮어쓰기 방지).
  const postIdentities = async (memberId, cu, add) => {
    const m = members.find((x) => x.id === memberId);
    if (!m) throw new Error('구성원을 찾을 수 없습니다 — 새로고침 후 다시 시도하세요');
    const emailLower = (cu.email || '').trim().toLowerCase();
    const isCu = (idn) => idn.system === 'clickup'
      && (idn.external_id === String(cu.id) || (!!emailLower && (idn.external_id || '').toLowerCase() === emailLower));
    const identities = (m.identities || []).filter((idn) => !isCu(idn));
    if (add) {
      identities.push({ system: 'clickup', external_id: String(cu.id), email: cu.email || undefined, instance: res.teamId || undefined });
    } else if (identities.length === (m.identities || []).length) {
      // 구성원 identities 에 해당 행이 없는 매핑(게이트웨이 바인딩 파일 등 다른 경로) — 여기선 해제 불가.
      throw new Error('이 연결은 구성원의 외부 계정 목록 밖에서 온 신원이라 여기서 해제할 수 없어요 — 구성원 관리에서 확인하세요');
    }
    await api('/api/ui/org/member', { method: 'POST', body: JSON.stringify({ id: m.id, identities }) });
    await loadAdmin(true); // members(identities) 최신화 — 패널 재조회 전 로컬 데이터 동기
  };
  const tbl = el('table', { class: 'fields-table cu-map-table' });
  tbl.append(el('tr', {}, el('th', { text: 'ClickUp 멤버' }), el('th', { text: '연결된 구성원' }), el('th', {})));
  for (const r of users) {
    const cu = r.clickup || {};
    // 아바타 — ClickUp 프로필 색은 검증된 hex 일 때만 style 로(외부 데이터 CSS 주입 방지), 이니셜은 textContent.
    const dot = el('span', { class: 'cu-avatar', text: (cu.initials || String(cu.username || '?').slice(0, 2)).toUpperCase() });
    if (/^#[0-9a-fA-F]{3,8}$/.test(cu.color || '')) { dot.style.background = cu.color; dot.style.color = '#fff'; }
    const userCell = el('td', {}, el('div', { class: 'cu-user' }, dot,
      el('div', {},
        el('div', { class: 'mini-title', text: cu.username || ('id ' + cu.id) }),
        el('div', { class: 'mini-meta', text: cu.email || ('id ' + cu.id) }))));
    if (r.mapped_via === 'identity') {
      // ① 매핑됨(identities 명시 행) — 표시명 + 해제.
      const unlink = el('button', { class: 'btn-text', text: '해제' });
      unlink.addEventListener('click', async () => {
        if (!confirm(`'${cu.username || cu.id}' ↔ '${nameOf(r.mapped_member_id)}' 연결을 해제할까요?`)) return;
        unlink.disabled = true;
        try { await postIdentities(r.mapped_member_id, cu, false); toast('연결 해제됨 — 다음 싱크부터 반영'); void renderClickupMemberPanel(panel); }
        catch (e) { toast(e.message, true); unlink.disabled = false; }
      });
      tbl.append(el('tr', {}, userCell,
        el('td', {}, el('span', { class: 'pill pill-ok', text: '연결됨' }), ' ', nameOf(r.mapped_member_id)),
        el('td', {}, unlink)));
    } else {
      // ② 미매핑(또는 이메일 자동매치만) — 활성 구성원 드롭다운(+자동매치 미리 선택) + 연결 저장.
      const selBox = el('select', { class: 'cu-map-sel' }, el('option', { value: '', text: '구성원 선택…' }),
        ...activeMembers.map((m) => el('option', { value: m.id, text: (m.display_name || m.id) + (m.email ? ' (' + m.email + ')' : '') })));
      if (r.suggested_member_id) selBox.value = r.suggested_member_id;
      const saveB = el('button', { class: 'btn btn-ghost btn-sm', text: '연결' });
      saveB.addEventListener('click', async () => {
        if (!selBox.value) { toast('연결할 구성원을 선택하세요', true); return; }
        saveB.disabled = true;
        try { await postIdentities(selBox.value, cu, true); toast('연결됨 — 다음 싱크부터 담당자에 반영'); void renderClickupMemberPanel(panel); }
        catch (e) { toast(e.message, true); saveB.disabled = false; }
      });
      tbl.append(el('tr', {}, userCell,
        el('td', {}, r.mapped_via === 'email' ? el('span', { class: 'pill', text: '이메일 자동매치' }) : null, ' ', selBox),
        el('td', {}, saveB)));
    }
  }
  panel.replaceChildren(head, intro, tbl);
}

// ── DB 데이터소스 — admin 전용. db_query/db_schema 가 읽는 외부 운영 DB(읽기전용). ──
function dbSourceEditor(detail, data) {
  const sources = data.dbSources || [];
  const envSources = data.envSources || [];
  const sel = state.admin.dbSrcSel;
  const listCol = el('div', { class: 'admin-sublist' });
  listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ DB 소스 추가',
    onclick: () => { state.admin.dbSrcSel = '__new__'; renderAdminDetail(detail, 'db-sources', data); } }));
  for (const s of sources) {
    listCol.append(el('div', { class: 'mini-row' + (s.name === sel ? ' sel' : ''),
      onclick: () => { state.admin.dbSrcSel = s.name; renderAdminDetail(detail, 'db-sources', data); } },
      el('div', { class: 'mini-title', text: s.name }, s.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null),
      el('div', { class: 'mini-meta', text: (s.host || '-') + ' · ' + (s.auth_mode || 'password') + (s.rls ? ' · RLS' : '') })));
  }
  // env 소스(.env/DB_SOURCES_JSON) — 읽기 전용(여기선 편집 불가).
  for (const s of envSources) {
    listCol.append(el('div', { class: 'mini-row mini-ro' },
      el('div', { class: 'mini-title', text: s.name }, el('span', { class: 'pill', text: 'env' })),
      el('div', { class: 'mini-meta', text: (s.host || '-') + ' · 읽기 전용(.env)' })));
  }
  const right = el('div', {});
  const editing = sel === '__new__'
    ? { name: '', driver: 'postgres', url: '', auth_mode: 'password', auth_ref: '', rls: '', max_rows: '', timeout_ms: '', note: '', enabled: true }
    : sources.find((s) => s.name === sel);
  if (editing) dbSourceForm(right, editing, data, detail, sel === '__new__');
  else right.append(
    el('p', { class: 'admin-hint', text: 'db_query/db_schema 가 읽는 외부 운영 DB(읽기전용)입니다. 접속 비밀번호는 저장하지 않고 환경변수 이름(auth_ref)으로만 참조합니다 — 읽기전용 role + RLS 전제. env(.env)로 설정한 소스는 읽기 전용으로 표시됩니다.' }));
  // 테이블 정책 · 컬럼 마스킹 — 기존(등록된) 소스 선택 시에만(라이브 스키마 오버레이, 무재시작).
  if (editing && sel !== '__new__') {
    const panel = el('div', { class: 'card', style: 'margin-top:12px' });
    right.append(panel);
    void renderDbPolicyPanel(panel, sel);
  }
  const rcDb = data.runtimeConfig || { allowed_db_hosts: [] };
  const dbSafety = allowlistCard(data, 'DB 접속 안전범위 (allowlist)',
    'db_query/db_schema 데이터소스가 접속할 수 있는 사설/내부 host — 이 목록 밖의 사설/localhost 는 차단(SSRF 방어). 외부 공인 DB 는 등록 불요.',
    [
      { key: 'allowed_db_hosts', label: '허용 DB host (allowed_db_hosts)', initial: rcDb.allowed_db_hosts, placeholder: 'localhost\ndb.internal.acme.com\n줄당 host 한 개' },
    ]);
  detail.replaceChildren(
    el('div', { class: 'card' }, sectionTitle('DB 데이터소스', data.meaning['db-source']), el('div', { class: 'admin-two' }, listCol, right)),
    dbSafety);
}

function dbSourceForm(root, s, data, detail, isNew) {
  const allowed = (data.runtimeConfig && data.runtimeConfig.allowed_db_secret_refs) || [];
  const nameIn = el('input', { type: 'text', value: s.name, placeholder: '소스 이름(영문/숫자)', disabled: isNew ? null : '' });
  const urlIn = el('input', { type: 'text', value: '', placeholder: isNew ? 'postgres://readonly@host:5432/db (비번 제외)' : ('현재 host: ' + (s.host || '-') + ' · 변경 시에만 입력(비번 제외)') });
  // 드라이버(#715) — postgres | mysql(Aurora). mysql 은 RLS 미지원이라 선택 시 rls 입력을 잠근다.
  const drvSel = el('select', {},
    el('option', { value: 'postgres', text: 'postgres' }),
    el('option', { value: 'mysql', text: 'mysql (Aurora MySQL)' }));
  drvSel.value = s.driver === 'mysql' ? 'mysql' : 'postgres';
  const modeSel = el('select', {},
    el('option', { value: 'password', text: 'password (env 참조)' }),
    el('option', { value: 'iam', text: 'iam (후속)', disabled: '' }),
    el('option', { value: 'mtls', text: 'mtls (후속)', disabled: '' }),
    el('option', { value: 'vault', text: 'vault (후속)', disabled: '' }));
  modeSel.value = s.auth_mode || 'password';
  const refIn = el('input', { type: 'text', value: s.auth_ref || '', placeholder: '예: ANALYTICS_DB_PW (env 이름, 값 아님)' });
  const refHint = el('p', { class: 'admin-hint', text: allowed.length ? '참조 가능한 env: ' + allowed.join(', ') : '⚠ 비번 있는 DB면 allowed_db_secret_refs 에 env 이름이 등록돼 있어야 합니다(운영자 설정 · 비번 없는 DB면 비워도 됩니다)' });
  const rlsIn = el('input', { type: 'text', value: s.rls || '', placeholder: 'app.current_user (비우면 행수준 격리 없음)' });
  const syncDrv = () => {
    const my = drvSel.value === 'mysql';
    if (isNew) urlIn.placeholder = my ? 'mysql://readonly@host:3306/dbname (비번 제외 · 스키마 필수)' : 'postgres://readonly@host:5432/db (비번 제외)';
    rlsIn.disabled = my;
    if (my) rlsIn.value = '';
    rlsIn.placeholder = my ? 'mysql 미지원 — 비움 고정' : 'app.current_user (비우면 행수준 격리 없음)';
  };
  drvSel.addEventListener('change', syncDrv);
  syncDrv();
  const maxIn = el('input', { type: 'number', value: (s.max_rows == null ? '' : s.max_rows), placeholder: '기본 1000' });
  const toIn = el('input', { type: 'number', value: (s.timeout_ms == null ? '' : s.timeout_ms), placeholder: '기본 5000' });
  const noteIn = el('input', { type: 'text', value: s.note || '', placeholder: '설명(선택)' });
  const enChk = el('input', { type: 'checkbox' }); enChk.checked = s.enabled !== false;
  const tdSel = el('select', {},
    el('option', { value: 'allow', text: 'deny-list — 기본 허용(명시 차단만 제외)' }),
    el('option', { value: 'deny', text: 'allow-list — 기본 차단(명시 허용만 조회 · 컴플라이언스 권장)' }));
  tdSel.value = s.table_default || 'allow';
  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    if (!nameIn.value.trim()) { toast('이름 필수', true); return; }
    saveBtn.disabled = true;
    try {
      const urlV = urlIn.value.trim();
      if (isNew && !urlV) { toast('접속 URL 필수', true); saveBtn.disabled = false; return; }
      const payload: any = {
        name: nameIn.value.trim(), driver: drvSel.value, auth_mode: modeSel.value,
        auth_ref: refIn.value.trim() || null,
        rls: drvSel.value === 'mysql' ? null : (rlsIn.value.trim() || null),
        max_rows: maxIn.value ? Number(maxIn.value) : null,
        timeout_ms: toIn.value ? Number(toIn.value) : null,
        note: noteIn.value.trim() || null, enabled: enChk.checked, table_default: tdSel.value,
      };
      if (urlV) payload.url = urlV; // 빈칸 = url 미변경(수정 시)
      await api('/api/ui/org/db-source', { method: 'POST', body: JSON.stringify(payload) });
      await loadAdmin(true); state.admin.dbSrcSel = payload.name; toast('저장됨 — 즉시 조회 가능'); renderAdminDetail(detail, 'db-sources', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
    if (!confirm(`DB 소스 '${s.name}' 제거?`)) return;
    try { await api('/api/ui/org/db-source/remove', { method: 'POST', body: JSON.stringify({ name: s.name }) }); await loadAdmin(true); state.admin.dbSrcSel = null; toast('제거됨'); renderAdminDetail(detail, 'db-sources', state.admin.data); }
    catch (e) { toast(e.message, true); }
  } }));
  root.replaceChildren(
    field('이름', nameIn), field('드라이버 (driver)', drvSel), field('접속 URL (비번 제외)', urlIn), field('인증 방식 (auth_mode)', modeSel),
    field('비번 환경변수 이름 (auth_ref)', refIn), refHint,
    field('RLS GUC (rls)', rlsIn), field('최대 행수 (max_rows)', maxIn), field('타임아웃 ms (timeout_ms)', toIn),
    field('테이블 기본자세 (table_default)', tdSel),
    field('설명', noteIn), el('label', { class: 'admin-check' }, enChk, ' 활성'),
    actions);
}

// ── 테이블 정책 · 컬럼 마스킹 패널(#186) — 라이브 스키마 오버레이. 고객 DB 무수정, 게이트웨이 집행. ──
async function renderDbPolicyPanel(panel, source) {
  panel.replaceChildren(el('p', { class: 'admin-hint', text: '스키마 불러오는 중…' }));
  let ov;
  try { ov = await api('/api/ui/org/db-source/schema?source=' + encodeURIComponent(source)); }
  catch (e) { panel.replaceChildren(el('p', { class: 'admin-hint', text: '스키마 로드 실패: ' + e.message })); return; }
  const openT = state.admin.dbPolTable || null;
  panel.replaceChildren(
    sectionTitle('테이블 정책 · 컬럼 마스킹', '이 소스에서 조회 가능한 테이블과 개인정보 컬럼 마스킹을 관리합니다 — 고객 DB 무수정, 게이트웨이가 결정론적으로 집행.'),
    el('p', { class: 'admin-hint', text: '기본자세: ' + (ov.table_default === 'deny'
      ? 'allow-list(기본 차단 — 명시 허용만 조회)' : 'deny-list(기본 허용 — 명시 차단만 제외)') + ' · 위 폼의 table_default 로 변경' }));
  const tbl = el('table', { class: 'fields-table' });
  tbl.append(el('tr', {}, el('th', { text: '테이블' }), el('th', { text: '조회' }), el('th', { text: '마스킹' }), el('th', { text: '컬럼' })));
  for (const t of (ov.tables || [])) {
    if (t.system) { // 게이트웨이 내부 테이블 — 항상 차단(웹 편집 불가), 정직하게 표시
      tbl.append(el('tr', { class: 'mini-ro' },
        el('td', { text: t.name }),
        el('td', {}, el('span', { class: 'pill', text: '시스템 차단' })),
        el('td', { class: 'mini-meta', text: '잠금' }),
        el('td', {})));
      continue;
    }
    const allowed = t.mode === 'allow';
    const toggle = el('button', { class: 'btn btn-ghost btn-sm', text: allowed ? '허용' : '차단',
      onclick: async () => { await setTablePolicy(source, t.name, allowed ? 'deny' : 'allow'); void renderDbPolicyPanel(panel, source); } });
    const isOpen = t.name === openT;
    const colsBtn = el('button', { class: 'btn-text', text: (isOpen ? '▾ 컬럼' : '▸ 컬럼') + (t.maskedCount ? ` (${t.maskedCount})` : '') });
    colsBtn.addEventListener('click', () => { state.admin.dbPolTable = isOpen ? null : t.name; void renderDbPolicyPanel(panel, source); });
    tbl.append(el('tr', { class: allowed ? '' : 'mini-ro' },
      el('td', { text: t.name }), el('td', {}, toggle),
      el('td', { class: 'mini-meta', text: t.maskedCount ? (t.maskedCount + ' 컬럼') : '–' }),
      el('td', {}, colsBtn)));
    if (isOpen) {
      const cell = el('td', { colspan: '4' });
      tbl.append(el('tr', {}, cell));
      void renderColumnMasks(cell, panel, source, t.name);
    }
  }
  panel.append(tbl);
}

async function renderColumnMasks(cell, panel, source, table) {
  cell.replaceChildren(el('span', { class: 'admin-hint', text: '컬럼 불러오는 중…' }));
  let ov;
  try { ov = await api('/api/ui/org/db-source/schema?source=' + encodeURIComponent(source) + '&table=' + encodeURIComponent(table)); }
  catch (e) { cell.replaceChildren(el('span', { class: 'admin-hint', text: '컬럼 로드 실패: ' + e.message })); return; }
  const STYLES = [['', '(마스킹 없음)'], ['full', 'full — 전체 ***'], ['partial', 'partial — 앞1·뒤1'], ['email', 'email — 로컬부 가림'], ['hash', 'hash — sha256'], ['null', 'null — 널']];
  const ct = el('table', { class: 'fields-table', style: 'margin:6px 0 0 12px' });
  for (const c of (ov.columns || [])) {
    const box = el('select', {});
    for (const [v, label] of STYLES) box.append(el('option', { value: v, text: label }));
    box.value = c.masked || '';
    box.addEventListener('change', async () => {
      await setColumnMask(source, table, c.column_name, box.value);
      void renderDbPolicyPanel(panel, source); // 마스킹 수 즉시 반영
    });
    ct.append(el('tr', {}, el('td', { text: c.column_name }), el('td', { class: 'mini-meta', text: c.data_type }), el('td', {}, box)));
  }
  cell.replaceChildren(ct);
}

async function setTablePolicy(source, table, mode) {
  try { await api('/api/ui/org/db-source/table-policy', { method: 'POST', body: JSON.stringify({ source, table, mode }) }); toast(mode === 'allow' ? '허용됨' : '차단됨'); }
  catch (e) { toast(e.message, true); }
}
async function setColumnMask(source, table, column, style) {
  try {
    await api('/api/ui/org/db-source/column-mask', { method: 'POST', body: JSON.stringify(style ? { source, table, column, style } : { source, table, column, remove: true }) });
    toast(style ? ('마스킹: ' + style) : '마스킹 해제');
  } catch (e) { toast(e.message, true); }
}

// ── 커스텀 훅 — runtime 권한 ──
function customHookEditor(detail, data) {
  const hooks = data.orgHooks || [];
  const sel = state.admin.hookSel;
  const listCol = el('div', { class: 'admin-sublist' });
  listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ 커스텀 훅 추가',
    onclick: () => { state.admin.hookSel = '__new__'; renderAdminDetail(detail, 'custom-hooks', data); } }));
  for (const h of hooks) {
    listCol.append(el('div', { class: 'mini-row' + (h.id === sel ? ' sel' : ''),
      onclick: () => { state.admin.hookSel = h.id; renderAdminDetail(detail, 'custom-hooks', data); } },
      el('div', { class: 'mini-title', text: h.id }, h.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null),
      el('div', { class: 'mini-meta', text: h.event + (h.matcher ? ' · ' + h.matcher : '') + ' · ' + (h.harness || 'all')
        + (h.target_members && h.target_members.length ? ' · 지정 ' + h.target_members.length + '명' : '') })));
  }
  const right = el('div', {});
  const editing = sel === '__new__'
    ? { id: '', label: '', harness: 'all', event: 'PostToolUse', matcher: '', source_code: '', timeout_sec: 10, note: '', target_members: null, enabled: true }
    : hooks.find((h) => h.id === sel);
  if (editing) hookForm(right, editing, data, detail, sel === '__new__');
  else right.append(
    el('p', { class: 'admin-hint', text: '구성원 머신에서 특정 시점에 자동 실행되는 코드입니다. 본문은 멤버 디스크에 저장되지 않고 매 세션 게이트웨이에서 받아 실행됩니다(끄면 다음 세션부터 무효).' }));
  detail.replaceChildren(el('div', { class: 'card' }, sectionTitle('커스텀 훅 (코드 정의)', data.meaning['custom-hook']), el('div', { class: 'admin-two' }, listCol, right)));
}

function hookForm(root, h, data, detail, isNew) {
  const idIn = el('input', { type: 'text', value: h.id, placeholder: '훅 id (소문자/숫자/_-)', disabled: isNew ? null : '' });
  const labelIn = el('input', { type: 'text', value: h.label || '', placeholder: '표시 이름(선택)' });
  const harnessSel = el('select', {}, ...['all', 'claude', 'codex', 'openclaw'].map((x) => el('option', { value: x, text: x })));
  harnessSel.value = h.harness || 'all';
  const eventSel = el('select', {}, ...['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification'].map((x) => el('option', { value: x, text: x })));
  eventSel.value = h.event || 'PostToolUse';
  const matcherIn = el('input', { type: 'text', value: h.matcher || '', placeholder: '예: Bash (PreToolUse/PostToolUse 의 도구 매처)' });
  const codeTa = el('textarea', { rows: '12', class: 'admin-ta', placeholder: '#!/usr/bin/env node\n// 훅 입력은 stdin(JSON), 응답은 stdout / exit code' });
  codeTa.value = h.source_code || '';
  const timeoutIn = el('input', { type: 'number', value: String(h.timeout_sec || 10), min: '1', max: '120' });
  const targetIn = el('input', { type: 'text', value: (h.target_members || []).join(', '), placeholder: '비우면 전원 · 특정 구성원만: id 쉼표구분(예: yoon, charles)' });
  const enChk = el('input', { type: 'checkbox' }); enChk.checked = h.enabled !== false;
  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    if (!idIn.value.trim()) { toast('id 필수', true); return; }
    if (!confirm('이 코드는 구성원 컴퓨터에서 그들의 권한으로 실제 실행됩니다. 저장할까요?')) return;
    saveBtn.disabled = true;
    try {
      const targets = targetIn.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const payload = { id: idIn.value.trim(), label: labelIn.value.trim() || null, harness: harnessSel.value, event: eventSel.value, matcher: matcherIn.value.trim() || null, source_code: codeTa.value, timeout_sec: Number(timeoutIn.value) || 10, target_members: targets.length ? targets : null, enabled: enChk.checked };
      await api('/api/ui/org/hook', { method: 'POST', body: JSON.stringify(payload) });
      await loadAdmin(true); state.admin.hookSel = payload.id; toast('저장됨 — 구성원 다음 세션부터'); renderAdminDetail(detail, 'custom-hooks', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
    if (!confirm(`커스텀 훅 '${h.id}' 제거? 다음 세션부터 실행되지 않습니다(미접속 머신은 직전 상태 유지).`)) return;
    try { await api('/api/ui/org/hook/remove', { method: 'POST', body: JSON.stringify({ id: h.id }) }); await loadAdmin(true); state.admin.hookSel = null; toast('제거됨'); renderAdminDetail(detail, 'custom-hooks', state.admin.data); }
    catch (e) { toast(e.message, true); }
  } }));
  root.replaceChildren(
    el('div', { class: 'warn-badge', text: '⚠ 이 코드는 구성원 컴퓨터에서 그들의 권한으로 실제 실행됩니다.' }),
    field('id', idIn), field('표시 이름', labelIn),
    field('하네스', harnessSel), field('이벤트(실행 시점)', eventSel),
    field('매처(선택 — PreToolUse/PostToolUse 의 도구명)', matcherIn),
    field('코드 (Node.js)', codeTa),
    field('타임아웃(초, 1~120)', timeoutIn),
    field('대상 구성원(비우면 전원 · 구성원이 본인 것 opt-in/out 가능)', targetIn),
    el('label', { class: 'admin-check' }, enChk, ' 활성'),
    actions);
}

// ── 하네스 자산(스킬·서브에이전트·슬래시커맨드) — runtime 권한 ──
function harnessAssetEditor(detail, data) {
  const assets = data.orgHarnessAssets || [];
  const sel = state.admin.assetSel;
  const KIND_LABEL = { skill: '스킬', subagent: '서브에이전트', command: '커맨드' };
  const listCol = el('div', { class: 'admin-sublist' });
  listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ 자산 추가',
    onclick: () => { state.admin.assetSel = '__new__'; renderAdminDetail(detail, 'harness-assets', data); } }));
  for (const a of assets) {
    listCol.append(el('div', { class: 'mini-row' + (a.id === sel ? ' sel' : ''),
      onclick: () => { state.admin.assetSel = a.id; renderAdminDetail(detail, 'harness-assets', data); } },
      el('div', { class: 'mini-title', text: a.id }, a.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null),
      el('div', { class: 'mini-meta', text: (KIND_LABEL[a.kind] || a.kind) + ' · ' + (a.harness || 'all')
        + (a.target_members && a.target_members.length ? ' · 지정 ' + a.target_members.length + '명' : '')
        + (a.paired_hook_id ? ' · 짝훅:' + a.paired_hook_id : '') })));
  }
  const right = el('div', {});
  const editing = sel === '__new__'
    ? { id: '', kind: 'skill', label: '', harness: 'all', description: '', body: '', frontmatter: {}, target_members: null, paired_hook_id: '', enabled: true }
    : assets.find((a) => a.id === sel);
  if (editing) assetForm(right, editing, data, detail, sel === '__new__');
  else right.append(el('p', { class: 'admin-hint', text: '스킬(작업 방법서)·서브에이전트(보조 AI)·슬래시커맨드(단축 명령)를 정의해 구성원 하네스에 배포합니다. 세션 시작 때 디스크에 동기화되며 스킬/커맨드는 같은 세션 내 즉시 반영됩니다.' }));
  detail.replaceChildren(el('div', { class: 'card' }, sectionTitle('스킬 · 서브에이전트 · 슬래시커맨드', data.meaning['harness-asset']), el('div', { class: 'admin-two' }, listCol, right)));
}

function assetForm(root, a, data, detail, isNew) {
  const idIn = el('input', { type: 'text', value: a.id, placeholder: '자산 id (소문자/숫자/_-)', disabled: isNew ? null : '' });
  const labelIn = el('input', { type: 'text', value: a.label || '', placeholder: '표시 이름(선택)' });
  const kindSel = el('select', {}, ...[['skill', '스킬'], ['subagent', '서브에이전트'], ['command', '슬래시커맨드']].map(([v, t]) => el('option', { value: v, text: t })));
  kindSel.value = a.kind || 'skill';
  const harnessSel = el('select', {}, ...['all', 'claude', 'codex'].map((x) => el('option', { value: x, text: x })));
  harnessSel.value = a.harness || 'all';
  const descIn = el('input', { type: 'text', value: a.description || '', placeholder: 'AI가 이 자산을 언제 쓸지 판단하는 한 줄 설명(상시 노출)' });
  const bodyTa = el('textarea', { rows: '12', class: 'admin-ta', placeholder: '자산 본문(마크다운) — 스킬 방법서 / 에이전트 시스템 프롬프트 / 커맨드 프롬프트' });
  bodyTa.value = a.body || '';
  const fmTa = el('textarea', { rows: '4', class: 'admin-ta', placeholder: '추가 frontmatter(JSON, 선택) — 예: {"model":"opus","allowed-tools":["Read","Grep"]}' });
  fmTa.value = (a.frontmatter && Object.keys(a.frontmatter).length) ? JSON.stringify(a.frontmatter, null, 2) : '';
  const targetIn = el('input', { type: 'text', value: (a.target_members || []).join(', '), placeholder: '비우면 전원 · 특정 구성원만: id 쉼표구분(예: yoon, charles)' });
  const pairedIn = el('input', { type: 'text', value: a.paired_hook_id || '', placeholder: '짝훅 id(선택) — 위험 통제용 커스텀 훅' });
  const enChk = el('input', { type: 'checkbox' }); enChk.checked = a.enabled !== false;
  const codexNote = el('p', { class: 'admin-hint' });
  const syncNote = () => { codexNote.textContent = (kindSel.value !== 'skill' && (harnessSel.value === 'codex' || harnessSel.value === 'all'))
    ? '※ 서브에이전트·슬래시커맨드는 Codex 네이티브 미지원 — Codex 세션엔 배포되지 않습니다(스킬만 양 하네스). Claude 에만 적용됩니다.' : ''; };
  kindSel.addEventListener('change', syncNote); harnessSel.addEventListener('change', syncNote); syncNote();
  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    if (!idIn.value.trim()) { toast('id 필수', true); return; }
    let fm = {};
    if (fmTa.value.trim()) { try { fm = JSON.parse(fmTa.value); } catch { toast('frontmatter 가 올바른 JSON 이 아닙니다', true); return; } }
    const targets = targetIn.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!confirm('이 자산은 구성원 하네스에 배포되어 그들의 AI가 사용합니다. 스킬은 도구·셸을 실행할 수 있습니다. 저장할까요?')) return;
    saveBtn.disabled = true;
    try {
      const payload = { id: idIn.value.trim(), kind: kindSel.value, label: labelIn.value.trim() || null, harness: harnessSel.value,
        description: descIn.value, body: bodyTa.value, frontmatter: fm,
        target_members: targets.length ? targets : null, paired_hook_id: pairedIn.value.trim() || null, enabled: enChk.checked };
      await api('/api/ui/org/harness-asset', { method: 'POST', body: JSON.stringify(payload) });
      await loadAdmin(true); state.admin.assetSel = payload.id; toast('저장됨 — 구성원 다음 세션부터'); renderAdminDetail(detail, 'harness-assets', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
    if (!confirm(`자산 '${a.id}' 제거? 다음 세션부터 구성원 하네스에서 제거됩니다(미접속 머신은 직전 상태 유지).`)) return;
    try { await api('/api/ui/org/harness-asset/remove', { method: 'POST', body: JSON.stringify({ id: a.id }) }); await loadAdmin(true); state.admin.assetSel = null; toast('제거됨'); renderAdminDetail(detail, 'harness-assets', state.admin.data); }
    catch (e) { toast(e.message, true); }
  } }));
  root.replaceChildren(
    el('div', { class: 'warn-badge', text: '⚠ 이 자산은 구성원 하네스에 배포됩니다. 스킬은 도구·셸을 실행할 수 있어 훅과 같은 실행권한입니다 — 위험 통제는 짝훅으로.' }),
    field('id', idIn), field('표시 이름', labelIn),
    field('종류', kindSel), field('하네스', harnessSel),
    codexNote,
    field('설명(AI가 언제 쓸지 판단 — 상시 노출)', descIn),
    field('본문(마크다운)', bodyTa),
    field('추가 frontmatter (JSON, 선택)', fmTa),
    field('대상 구성원(비우면 전원)', targetIn),
    field('짝훅 id(선택 — 위험 통제)', pairedIn),
    el('label', { class: 'admin-check' }, enChk, ' 활성'),
    actions);
}

// ── AI 도구(MCP 툴) — runtime 권한 ──
function toolsEditor(detail, data) {
  const proxyTools = (data.tools || []).filter((t) => t.kind === 'http_proxy');
  const sel = state.admin.toolSel;
  const listCol = el('div', { class: 'admin-sublist' });
  listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ 도구 추가',
    onclick: () => { state.admin.toolSel = '__new__'; renderAdminDetail(detail, 'tools', data); } }));
  for (const t of proxyTools) {
    listCol.append(el('div', { class: 'mini-row' + (t.name === sel ? ' sel' : ''),
      onclick: () => { state.admin.toolSel = t.name; renderAdminDetail(detail, 'tools', data); } },
      el('div', { class: 'mini-title', text: t.name },
        t.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null,
        t.auto_approve ? el('span', { class: 'pill pill-warn', text: '자동승인' }) : null),
      el('div', { class: 'mini-meta', text: (t.method || 'GET') + ' · ' + (t.scope || '-') })));
  }
  const right = el('div', {});
  const editing = sel === '__new__'
    ? { name: '', kind: 'http_proxy', enabled: true, auto_approve: false, title: '', description: '', scope: 'items', method: 'GET', url: '', auth_env: '', input_schema: '', note: '' }
    : proxyTools.find((t) => t.name === sel);
  if (editing) toolForm(right, editing, data, detail, sel === '__new__');
  else right.append(
    el('p', { class: 'admin-hint', text: '사내 API를 AI 도구로 래핑합니다. 저장 즉시(재설치 없이) 구성원 AI가 씁니다. 호출은 런타임 설정의 화이트리스트 안에서만, 인증은 환경변수 이름으로만.' }),
    builtinToggles(data));
  const pol = data.toolPolicy || { url_allowlist: [], allowed_auth_envs: [] };
  const toolsSafety = allowlistCard(data, '외부 호출 안전범위 (allowlist)',
    'AI 도구(http_proxy)가 외부를 호출할 수 있는 범위 — 이 목록 밖은 차단(SSRF 방어). 사내 API 도구를 안 쓰면 비워둬도 됩니다.',
    [
      { key: 'url_allowlist', label: '허용 호스트 (url_allowlist)', initial: pol.url_allowlist, placeholder: 'api.acme.com\n.internal.acme.com (앞에 . = 서브도메인)' },
      { key: 'allowed_auth_envs', label: '허용 인증 환경변수 이름 (allowed_auth_envs)', initial: pol.allowed_auth_envs, placeholder: 'ACME_API_TOKEN\n줄당 환경변수 이름(값 아님)' },
    ]);
  detail.replaceChildren(
    el('div', { class: 'card' }, sectionTitle('AI 도구(MCP)', data.meaning['tool']), el('div', { class: 'admin-two' }, listCol, right)),
    toolsSafety);
}

// MCP inputSchema(JSON Schema)의 properties → 필드 목록(이름:타입·필수여부·제약·설명). 하네스가 tools/list 에서 보는 입력 표면.
function mcpFieldsEl(schema) {
  const props = (schema && schema.properties) || {};
  const req = (schema && schema.required) || [];
  const keys = Object.keys(props);
  if (!keys.length) return el('div', { class: 'admin-hint', text: '입력 필드 없음' });
  return el('ul', { style: 'margin:2px 0; padding-left:18px' }, ...keys.map((k) => {
    const p = props[k] || {};
    let t = p.type || (p.anyOf || p.oneOf ? 'union' : '?');
    if (p.enum) t = p.enum.join(' | ');
    const c: any[] = [];
    if (p.minLength != null) c.push('min ' + p.minLength);
    if (p.maxLength != null) c.push('max ' + p.maxLength);
    if (p.minimum != null) c.push('≥' + p.minimum);
    if (p.maximum != null) c.push('≤' + p.maximum);
    return el('li', {},
      el('code', { text: k }),
      el('span', { class: 'mini-meta', text: ' : ' + t + (req.includes(k) ? ' · 필수' : ' · 선택') + (c.length ? ' · ' + c.join(', ') : '') }),
      p.description ? el('div', { class: 'admin-hint', style: 'margin:0', text: p.description }) : null);
  }));
}

function builtinToggles(data) {
  const byName = {}; for (const t of (data.tools || [])) if (t.kind === 'builtin') byName[t.name] = t;
  const wrap = el('div', { class: 'builtin-toggles' },
    el('div', { class: 'admin-subhead', text: '빌트인 도구 (MCP 노출)' }),
    el('p', { class: 'admin-hint', text: '게이트웨이 MCP 도구의 노출을 켜고 끕니다(즉시). 코드 기본값을 덮어쓰며, 「기본 미노출」 도구도 여기서 켤 수 있습니다. 자동승인을 켜면 구성원 설치 시 확인 없이 실행됩니다.' }),
    el('p', { class: 'admin-hint', text: '‘주입’: Claude Code가 이 도구를 세션 시작에 항상 로드(항상)할지, 필요 시 검색해 로드(Deferred)할지 정합니다 — Claude Code 전용입니다(Codex는 모든 MCP 도구를 항상 upfront 주입).' }));
  // 노출 정렬: 기본 노출 먼저, 기본 미노출(켤 수 있는 후보)을 아래로. 같은 그룹은 이름순.
  const cands = (data.builtins || []).map((c) => (typeof c === 'string' ? { name: c, title: '', defaultExposed: true } : c))
    .slice().sort((a, b) => (a.defaultExposed === b.defaultExposed ? a.name.localeCompare(b.name) : (a.defaultExposed ? -1 : 1)));
  for (const cand of cands) {
    const name = cand.name;
    const def = cand.defaultExposed !== false;       // 코드 기본값(expose.mcp)
    const override = byName[name];                    // org_tool builtin 행(있으면 운영자 재정의)
    const exposed = override ? override.enabled !== false : def;  // 최종 노출
    const enChk = el('input', { type: 'checkbox' }); enChk.checked = exposed;
    const aaChk = el('input', { type: 'checkbox' }); aaChk.checked = override ? !!override.auto_approve : false;
    // 주입모드(#187): 코드 기본값(defAlways) + 운영자 override(always_load). '' = 기본, 'always' = 항상, 'deferred' = 검색 시 로드. Claude Code 전용.
    const defAlways = cand.alwaysLoadDefault === true;
    const alSel = el('select', {},
      el('option', { value: '', text: '기본(' + (defAlways ? '항상' : 'deferred') + ')' }),
      el('option', { value: 'always', text: '항상 주입' }),
      el('option', { value: 'deferred', text: 'Deferred' }));
    alSel.value = (override && override.always_load != null) ? (override.always_load ? 'always' : 'deferred') : '';
    const save = async () => {
      try { const always_load = alSel.value === '' ? null : (alSel.value === 'always'); await api('/api/ui/org/tool', { method: 'POST', body: JSON.stringify({ name, kind: 'builtin', enabled: enChk.checked, auto_approve: aaChk.checked, always_load }) }); await loadAdmin(true); toast('저장됨'); }
      catch (e) { toast(e.message, true); }
    };
    enChk.addEventListener('change', save); aaChk.addEventListener('change', save); alSel.addEventListener('change', save);
    // MCP 상세 — 하네스가 보는 description + inputSchema(필드). 접힘 기본, 클릭 시 펼침.
    const detail = el('div', { style: 'display:none; margin:2px 0 8px 14px; padding:6px 10px; border-left:2px solid var(--border, #ddd)' },
      cand.description ? el('p', { class: 'admin-hint', style: 'white-space:pre-wrap; margin:0 0 6px', text: cand.description }) : null,
      el('div', { class: 'admin-subhead', text: '입력 필드 (MCP inputSchema)' }),
      mcpFieldsEl(cand.inputSchema));
    const expand = el('button', { class: 'btn btn-ghost btn-sm', text: 'MCP 상세 ▾',
      onclick: () => { const open = detail.style.display === 'none'; detail.style.display = open ? 'block' : 'none'; expand.textContent = open ? 'MCP 상세 ▴' : 'MCP 상세 ▾'; } });
    wrap.append(el('div', { class: 'builtin-row' },
      el('span', { class: 'builtin-name', text: name },
        cand.title ? el('span', { class: 'mini-meta', text: ' · ' + cand.title }) : null,
        !def ? el('span', { class: 'pill', text: '기본 미노출' }) : null,
        (override && exposed !== def) ? el('span', { class: 'pill pill-warn', text: '재정의' }) : null,
        (override && override.always_load != null && override.always_load !== defAlways) ? el('span', { class: 'pill pill-warn', text: '주입 재정의' }) : null),
      el('label', { class: 'admin-check' }, enChk, ' 노출'),
      el('label', { class: 'admin-check' }, aaChk, ' 자동승인'),
      el('label', { class: 'admin-check' }, '주입 ', alSel),
      expand), detail);
  }
  return wrap;
}

function toolForm(root, t, data, detail, isNew) {
  const policy = data.toolPolicy || { allowed_auth_envs: [], url_allowlist: [] };
  const nameIn = el('input', { type: 'text', value: t.name, placeholder: '도구 이름 (소문자/숫자/_-)', disabled: isNew ? null : '' });
  const titleIn = el('input', { type: 'text', value: t.title || '', placeholder: '표시 이름(선택)' });
  const descTa = el('textarea', { rows: '2', placeholder: 'AI에게 이 도구가 무엇인지 설명(AI가 언제 쓸지 판단)' }); descTa.value = t.description || '';
  const scopeSel = el('select', {}, ...['items', 'context', 'db', 'memory', 'code'].map((s) => el('option', { value: s, text: s })));
  scopeSel.value = t.scope || 'items';
  const methodSel = el('select', {}, ...['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => el('option', { value: m, text: m })));
  methodSel.value = t.method || 'GET';
  const urlIn = el('input', { type: 'text', value: t.url || '', placeholder: 'https://api.acme.com/v1/search' });
  let authEl: any;
  if (policy.allowed_auth_envs.length) {
    authEl = el('select', {}, el('option', { value: '', text: '(인증 없음)' }), ...policy.allowed_auth_envs.map((e) => el('option', { value: e, text: e })));
    authEl.value = t.auth_env || '';
  } else {
    authEl = el('input', { type: 'text', value: '', placeholder: '아래 「외부 호출 안전범위」에 allowed_auth_envs 를 먼저 등록하세요', disabled: '' });
  }
  const schemaTa = el('textarea', { rows: '5', class: 'admin-ta', placeholder: '{ "type":"object", "properties": { "q": {"type":"string"} }, "required":["q"] }' });
  schemaTa.value = typeof t.input_schema === 'string' ? t.input_schema : (t.input_schema ? JSON.stringify(t.input_schema, null, 2) : '');
  const enChk = el('input', { type: 'checkbox' }); enChk.checked = t.enabled !== false;
  const aaChk = el('input', { type: 'checkbox' }); aaChk.checked = !!t.auto_approve;
  const hostHint = el('p', { class: 'admin-hint', text: policy.url_allowlist.length ? '허용 호스트: ' + policy.url_allowlist.join(', ') : '⚠ 허용 호스트가 없습니다 — 아래 「외부 호출 안전범위」의 url_allowlist 에 먼저 추가해야 호출됩니다.' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    if (!nameIn.value.trim()) { toast('이름 필수', true); return; }
    let schema: any;
    if (schemaTa.value.trim()) { try { schema = JSON.parse(schemaTa.value); } catch { toast('입력 스키마가 올바른 JSON 이 아닙니다', true); return; } }
    saveBtn.disabled = true;
    try {
      const payload = { name: nameIn.value.trim(), kind: 'http_proxy', enabled: enChk.checked, auto_approve: aaChk.checked, title: titleIn.value.trim() || null, description: descTa.value.trim(), scope: scopeSel.value, method: methodSel.value, url: urlIn.value.trim(), auth_env: (authEl.value || '').trim() || null, input_schema: schema };
      await api('/api/ui/org/tool', { method: 'POST', body: JSON.stringify(payload) });
      await loadAdmin(true); state.admin.toolSel = payload.name; toast('저장됨 — 구성원 다음 대화부터 즉시'); renderAdminDetail(detail, 'tools', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
    if (!confirm(`도구 '${t.name}' 제거? 구성원 AI 도구 목록에서 즉시 사라집니다.`)) return;
    try { await api('/api/ui/org/tool/remove', { method: 'POST', body: JSON.stringify({ name: t.name }) }); await loadAdmin(true); state.admin.toolSel = null; toast('제거됨'); renderAdminDetail(detail, 'tools', state.admin.data); }
    catch (e) { toast(e.message, true); }
  } }));
  root.replaceChildren(
    field('이름', nameIn), field('표시 이름', titleIn), field('설명 (AI용)', descTa),
    field('권한 (이 도구를 쓸 수 있는 scope)', scopeSel),
    field('HTTP 메서드', methodSel), field('URL (https)', urlIn), hostHint,
    field('인증 환경변수 (auth_env)', authEl),
    field('입력 스키마 (JSON Schema, 선택)', schemaTa),
    el('label', { class: 'admin-check' }, enChk, ' 활성'),
    el('label', { class: 'admin-check' }, aaChk, ' 자동 승인 (구성원 확인 없이 실행 — 주의)'),
    actions);
}

// ── 설치 · 업데이트 · 제거 (OS별 명령 복붙) — 모든 멤버에게 보임(자가 업데이트/제거) ──
function deployPanel(detail, data) {
  const gw = (data.profile.gateway_url || window.location.origin).replace(/\/mcp$/, '').replace(/\/$/, '');
  const canEdit = state.admin.canEdit;
  const os = state.admin.deployOs || 'mac';
  state.admin.deployOs = os;
  const osTabs = el('div', { class: 'os-tabs' },
    ...[['mac', 'macOS'], ['windows', 'Windows']].map(([o, label]) => el('button', {
      class: 'btn btn-sm ' + (o === os ? 'btn-primary' : 'btn-ghost'), text: label,
      onclick: () => { state.admin.deployOs = o; renderAdminDetail(detail, 'deploy', data); } })));
  const staticBlock = (c) => el('div', { class: 'deploy-block' },
    el('div', { class: 'deploy-head' }, el('h3', { text: c.title }),
      c.cmd !== '(준비 중)' ? copyButton(() => c.cmd, '복사') : null),
    el('p', { class: 'admin-hint', text: c.note }),
    el('pre', { class: 'admin-preview', text: c.cmd }));
  // 설치 블록: 본인 토큰 자가발급(어드민·비어드민 동일). 업데이트·제거는 설치된 토큰 자동 읽기.
  const blocks = deployCommands(gw, os).map((c) =>
    c.kind === 'install' ? installSelfBlock(gw, os) : staticBlock(c));
  detail.replaceChildren(el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '설치 · 업데이트 · 제거' }), osTabs),
    el('p', { class: 'admin-hint', text: '본인 머신에 설치/업데이트/제거하는 명령입니다. 업데이트·제거는 설치된 토큰을 자동으로 읽어 토큰 재입력이 필요 없습니다. (다른 구성원에게 배포할 토큰은 [구성원 추가] 탭에서.)' }),
    ...blocks));
}

// OS별 설치 명령(토큰 박음).
function installCmd(gw, os, token) {
  if (os === 'windows') {
    // 맥과 동일: 번들 기반 설치(git clone 없음·토큰 프롬프트 없음) + 설치된 하네스 감지(claude/codex) → --harness.
    //  claude 면 mcp add, codex 면 현재 세션 $env:LIVELY_TOKEN + PowerShell $PROFILE 에 "파일→env 수화" 블록
    //  (Mac rc 패턴과 동일·토큰 리터럴은 ~/.lively/token 한 곳만 · setx 레지스트리 리터럴 제거). 새 PowerShell 부터 적용.
    return `$T="${token}"; $G="${gw}"; $h=@(); if(Get-Command claude -EA 0){$h+="claude"}; if(Get-Command codex -EA 0){$h+="codex"}; if($h.Count -eq 0){$h=@("claude")}; $tmp="$env:TEMP\\lvin"; Remove-Item -Recurse -Force $tmp -EA 0; New-Item -ItemType Directory -Force $tmp|Out-Null; Invoke-WebRequest -Headers @{Authorization="Bearer $T"} "$G/install" -OutFile "$tmp\\b.tgz"; tar -xzf "$tmp\\b.tgz" -C $tmp; New-Item -ItemType Directory -Force "$HOME\\.lively"|Out-Null; Set-Content "$HOME\\.lively\\token" $T -NoNewline; Set-Content "$HOME\\.lively\\gateway-url" $G -NoNewline; if($h -contains "claude"){ claude mcp remove lively *>$null; claude mcp add --transport http --scope user lively "$G/mcp" --header "Authorization: Bearer $T" }; if($h -contains "codex"){ $env:LIVELY_TOKEN=$T; [Environment]::SetEnvironmentVariable('LIVELY_TOKEN',$null,'User'); $pf=$PROFILE.CurrentUserAllHosts; New-Item -ItemType Directory -Force (Split-Path $pf) *>$null; if(-not (Test-Path $pf)){ New-Item -ItemType File -Force $pf *>$null }; $m="# lively-managed (codex LIVELY_TOKEN)"; if(-not (Select-String -Path $pf -SimpleMatch $m -Quiet -EA 0)){ Add-Content $pf ""; Add-Content $pf $m; Add-Content $pf 'if(Test-Path "$HOME\\.lively\\token"){ $env:LIVELY_TOKEN=(Get-Content "$HOME\\.lively\\token" -Raw).Trim() }' } }; node "$tmp\\setup\\user-install.mjs" --clone-root $tmp --harness ($h -join ",")`;
  }
  return `T=${token}; curl -fsSL -H "Authorization: Bearer $T" "${gw}/install" -o /tmp/lv.tgz && mkdir -p /tmp/lv && tar -xzf /tmp/lv.tgz -C /tmp/lv && LIVELY_TOKEN=$T LIVELY_GATEWAY=${gw}/mcp bash /tmp/lv/setup/setup-mac.sh`;
}

// 설치(본인) — 자가발급으로 본인 토큰 → 본인 설치 명령. admin/비admin 동일.
function installSelfBlock(gw, os) {
  const result = el('div', {});
  // #632: admin/runtime 보유자만 — 이 설치 토큰에 관리 권한을 실을지 opt-in(기본 off). 멤버 scope 가 상한.
  const canCp = hasScope('admin') || hasScope('runtime');
  const cpChk = el('input', { type: 'checkbox', style: 'margin-right:6px;vertical-align:middle' });
  const cpLabel = canCp ? el('label', { class: 'caption', style: 'display:block;margin:3px 0 7px;cursor:pointer' },
    cpChk, el('span', { text: '관리 권한(admin/runtime) 포함 — 이 토큰으로 설치한 로컬 세션이 관리탭 기능(구성원·토큰·훅·DB소스)을 MCP로 직접 다룹니다. 변경은 감사에 AI로 남습니다(#632).' })) : null;
  const go = el('button', { class: 'btn btn-primary btn-sm', text: '내 토큰 발급 → 설치 명령' });
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const r = await api('/api/ui/org/token/self', { method: 'POST', body: JSON.stringify({ includeControlPlane: canCp && cpChk.checked }) });
      const cmd = installCmd(gw, os, r.token);
      result.replaceChildren(
        el('p', { class: 'admin-hint', text: '✓ 본인 토큰 발급됨(scope: ' + (r.scopes || []).join('/') + '). 본인 머신에서 아래를 실행하세요 — 토큰은 지금만 보입니다.' }),
        el('div', { class: 'deploy-head' }, el('span', {}), copyButton(() => cmd, '명령 복사')),
        el('pre', { class: 'admin-preview', text: cmd }));
    } catch (e) { toast(e.message, true); }
    go.disabled = false;
  });
  return el('div', { class: 'deploy-block' },
    el('h3', { text: '설치 (본인 머신)' }),
    el('p', { class: 'admin-hint', text: '본인 토큰을 발급해 본인 머신에 설치합니다(git 불필요). 새 기기/재설치 시 사용.' }),
    cpLabel,
    el('div', { class: 'install-minter' }, go),
    result);
}

// 설치 미니터 — 구성원 선택 + 발급 → 그 사람 토큰이 박힌 완성형 설치 명령(복사).
function installMinterBlock(data, gw, opts: any = {}) {
  const result = el('div', {});
  const sel = el('select', {}, ...(data.members || []).map((m) =>
    el('option', { value: m.id, text: (m.display_name || m.id) + ' · ' + ((m.scopes || []).join('/') || '-') })));
  if (opts.preselectId && (data.members || []).some((m) => m.id === opts.preselectId)) sel.value = opts.preselectId;
  const go = el('button', { class: 'btn btn-primary btn-sm', text: '토큰 발급' });
  go.addEventListener('click', async () => {
    const m = (data.members || []).find((x) => x.id === sel.value) || { id: sel.value };
    if (!m.id) { toast('구성원을 선택하세요', true); return; }
    go.disabled = true;
    try {
      const r = await api('/api/ui/org/token', { method: 'POST',
        body: JSON.stringify({ userId: m.id, memberId: m.id, label: m.display_name || m.id }) });
      const name = m.display_name || m.id;
      const webUrl = gw + '/ui/';
      result.replaceChildren(
        el('p', { class: 'install-ok', text: '✓ ' + name + ' 님 접속 토큰이 발급됐어요 (권한: ' + r.scopes.join('/') + ').' }),
        el('p', { class: 'admin-hint', text: '아래 토큰을 ' + name + ' 님에게 전달하면 끝이에요 — 받은 분은 이 토큰으로 바로 로그인합니다(설치·명령어 필요 없음).' }),
        el('div', { class: 'deploy-head' }, el('span', { class: 'mini-meta', text: '발급된 토큰' }), copyButton(() => r.token, '토큰 복사')),
        el('pre', { class: 'admin-preview', text: r.token }),
        el('ol', { class: 'minter-steps' },
          el('li', {}, el('b', { text: '[토큰 복사]' }), ' 버튼으로 토큰을 복사하세요.'),
          el('li', {}, name + ' 님에게 ', el('b', { text: '1:1로(슬랙·메신저 DM 등) 전달' }), '하세요 — 토큰은 비밀번호 같은 거라 공개 채널·단톡방엔 올리지 마세요.'),
          el('li', {}, name + ' 님은 ', el('a', { href: webUrl, target: '_blank', rel: 'noopener', text: webUrl }), ' 에 접속해 ', el('b', { text: '첫 화면에 이 토큰을 붙여넣고 로그인' }), '하면 바로 시작합니다.')),
        el('p', { class: 'admin-hint', text: '⚠ 이 토큰은 지금 이 화면에서만 보여요 — 닫으면 다시 볼 수 없습니다(잃어버리면 다시 발급하면 돼요).' }),
        el('p', { class: 'admin-hint', text: '내 컴퓨터 터미널(Claude Code·Codex)에서 직접 쓰실 분은 — 같은 토큰으로 [사용 가이드 › 시작하기] 안내를 따르면 됩니다.' }));
      await loadAdmin(true);
    } catch (e) { toast(e.message, true); }
    go.disabled = false;
  });
  return el('div', { class: 'deploy-block' },
    el('h3', { class: 'member-add-step', text: opts.title || '토큰 발급 (새 팀원 추가)' }),
    el('p', { class: 'admin-hint', text: '구성원을 고르고 [토큰 발급]을 누르면 그 사람 전용 토큰이 나옵니다. 그 토큰만 전달하면 — 받은 분이 첫 화면에 붙여넣고 로그인합니다(설치·명령어 불필요).' }),
    el('div', { class: 'install-minter' }, sel, go),
    result);
}

function deployCommands(gw, os) {
  if (os === 'windows') {
    return [
      { kind: 'install', title: '설치 (PowerShell)' }, // 설치 블록은 installSelfBlock 가 렌더(자가발급)
      { kind: 'update', title: '업데이트 (PowerShell)', note: '설치된 토큰을 읽어 최신 묶음 재설치(설치된 하네스 자동 감지). ⚠ Windows 미검증 — 테스트 후 사용.',
        cmd: `$T=(Get-Content "$HOME\\.lively\\token" -Raw).Trim(); $G=((Get-Content "$HOME\\.lively\\gateway-url" -Raw).Trim() -replace '/mcp$',''); $h=@(); if(Get-Command claude -EA 0){$h+="claude"}; if(Get-Command codex -EA 0){$h+="codex"}; if($h.Count -eq 0){$h=@("claude")}; $tmp="$env:TEMP\\lvup"; Remove-Item -Recurse -Force $tmp -EA 0; New-Item -ItemType Directory -Force $tmp|Out-Null; Invoke-WebRequest -Headers @{Authorization="Bearer $T"} "$G/install" -OutFile "$tmp\\b.tgz"; tar -xzf "$tmp\\b.tgz" -C $tmp; if($h -contains "claude"){ claude mcp remove lively *>$null; claude mcp add --transport http --scope user lively "$G/mcp" --header "Authorization: Bearer $T" }; if($h -contains "codex"){ $env:LIVELY_TOKEN=$T; [Environment]::SetEnvironmentVariable('LIVELY_TOKEN',$null,'User'); $pf=$PROFILE.CurrentUserAllHosts; New-Item -ItemType Directory -Force (Split-Path $pf) *>$null; if(-not (Test-Path $pf)){ New-Item -ItemType File -Force $pf *>$null }; $m="# lively-managed (codex LIVELY_TOKEN)"; if(-not (Select-String -Path $pf -SimpleMatch $m -Quiet -EA 0)){ Add-Content $pf ""; Add-Content $pf $m; Add-Content $pf 'if(Test-Path "$HOME\\.lively\\token"){ $env:LIVELY_TOKEN=(Get-Content "$HOME\\.lively\\token" -Raw).Trim() }' } }; node "$tmp\\setup\\user-install.mjs" --clone-root $tmp --harness ($h -join ",")` },
      { kind: 'uninstall', title: '제거 (PowerShell)', note: '설치 자산 제거(lively 영역만). 완전 차단은 관리자가 [구성원 토큰 관리] 탭에서 접속 해제. ⚠ Windows 미검증.',
        cmd: `$T=(Get-Content "$HOME\\.lively\\token" -Raw).Trim(); $G=((Get-Content "$HOME\\.lively\\gateway-url" -Raw).Trim() -replace '/mcp$',''); $tmp="$env:TEMP\\lvun"; Remove-Item -Recurse -Force $tmp -EA 0; New-Item -ItemType Directory -Force $tmp|Out-Null; Invoke-WebRequest -Headers @{Authorization="Bearer $T"} "$G/install" -OutFile "$tmp\\b.tgz"; tar -xzf "$tmp\\b.tgz" -C $tmp; node "$tmp\\setup\\user-uninstall.mjs"` },
    ];
  }
  return [
    { kind: 'install', title: '설치', note: '구성원 토큰 필요 — 아래에서 구성원을 골라 발급하면 토큰 박힌 완성형 명령이 나옵니다. (아래는 템플릿: <TOKEN> 교체)',
      cmd: `T=<TOKEN>; curl -fsSL -H "Authorization: Bearer $T" "${gw}/install" -o /tmp/lv.tgz && mkdir -p /tmp/lv && tar -xzf /tmp/lv.tgz -C /tmp/lv && LIVELY_TOKEN=$T LIVELY_GATEWAY=${gw}/mcp bash /tmp/lv/setup/setup-mac.sh` },
    { kind: 'update', title: '업데이트', note: '설치된 토큰을 읽어 최신 묶음으로 멱등 재설치. 콘텐츠(강제규칙·회사맥락·메모리)는 매 세션 자동이라, 훅/설정 변경 시에만 필요합니다.',
      cmd: `T="$(cat ~/.lively/token)"; G="$(sed 's#/mcp$##' ~/.lively/gateway-url)"; curl -fsSL -H "Authorization: Bearer $T" "$G/install" -o /tmp/lv.tgz && rm -rf /tmp/lv && mkdir -p /tmp/lv && tar -xzf /tmp/lv.tgz -C /tmp/lv && LIVELY_TOKEN="$T" LIVELY_GATEWAY="$G/mcp" bash /tmp/lv/setup/setup-mac.sh` },
    { kind: 'uninstall', title: '제거', note: '설치 자산을 영구 제거(lively-managed 영역만 — tmux 훅·셸 별칭 등 사용자 설정은 보존). 완전 차단하려면 관리자가 [구성원 토큰 관리] 탭에서 접속을 해제해야 합니다.',
      cmd: `T="$(cat ~/.lively/token)"; G="$(sed 's#/mcp$##' ~/.lively/gateway-url)"; curl -fsSL -H "Authorization: Bearer $T" "$G/install" -o /tmp/lv.tgz && rm -rf /tmp/lv && mkdir -p /tmp/lv && tar -xzf /tmp/lv.tgz -C /tmp/lv && bash /tmp/lv/setup/uninstall-mac.sh` },
  ];
}

// ── 공용 UI 헬퍼 ──
function field(label, control) {
  return el('div', { class: 'field' }, el('label', { class: 'field-label', text: label }), control);
}
// 필드 라벨 바로 옆에 '이게 뭐예요?' 트리거를 붙이는 변형(필드 단위 설명용).
function fieldWithHelp(label, control, m) {
  return el('div', { class: 'field' },
    el('div', { class: 'field-label-row' }, el('label', { class: 'field-label', text: label }), meaningCard(m)),
    control);
}
// 클립보드 복사 — navigator.clipboard 는 보안 컨텍스트(https/localhost)에서만 동작한다.
// http://dev.lvly.io:8080 같은 비보안 origin 에선 undefined 이므로, execCommand('copy') 텍스트영역 폴백을 쓴다.
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* 폴백으로 */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.left = '0'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
function copyButton(getText, label) {
  const b = el('button', { class: 'btn btn-ghost btn-sm', text: label || '복사' });
  b.addEventListener('click', async () => {
    if (await copyText(getText())) toast('복사됨');
    else toast('복사 실패 — 명령을 직접 선택해 복사하세요', true);
  });
  return b;
}
// 우측 상단 '내 프로필' — 인증된 구성원이 자기 표시 이름·개인 레이어를 직접 편집(셀프 서비스, 선택형).
//  관리자 경로(관리▸구성원) 없이 본인이 채운다. 권한·이메일·상태·계정연결·내부 아이디는 admin 전용(여기 없음).
//  개인 레이어는 자유 텍스트(body_md)로 저장되지만 편집 UI 는 '고르기' — 항목별 선택지를 제시하고 선택을
//  canonical markdown 으로 직렬화한다. 다시 열면 그 markdown 을 파싱해 선택을 복원한다(parseMyProfile).
//  데이터: GET /api/ui/me/profile 1회 → 저장 POST /api/ui/me/profile(id 는 서버가 principal 로 강제 — 타인 편집 불가).
const PROF_DEV = [
  { v: '비개발', label: '비개발', hint: '코드는 직접 안 봐요 — 기술용어는 풀어서, 결론·근거 위주로' },
  { v: '기초', label: '기초', hint: '코드를 읽고 따라갈 수 있어요 — 핵심 코드는 보여주되 설명을 곁들여' },
  { v: '능숙', label: '능숙', hint: '직접 짜고 방향도 제시해요 — 코드 중심으로 적당히 깊게' },
  { v: '전문', label: '전문', hint: '아키텍처·리뷰까지 깊게 봐요 — 군더더기 없이 기술적으로' },
];
const PROF_TONE = ['친근한 존댓말', '간결한 존댓말', '격식 있는 존댓말', '편한 반말', '발랄·위트 있게'];
const PROF_LEN = [
  { v: '짧게', hint: '핵심만 — 군더더기 없이' },
  { v: '보통', hint: '적당한 설명과 함께' },
  { v: '자세히', hint: '배경·근거·대안까지 충분히' },
];

// 단일 선택 chip 그룹 — selected.v 를 토글(다시 누르면 해제). getVal/getLabel 로 옵션 모양에 무관.
function profChips(opts, selected, getLabel, getVal, onPick?) {
  const wrap = el('div', { class: 'prof-chips' });
  const chips: any[] = [];
  opts.forEach((o) => {
    const val = getVal(o);
    const chip = el('button', { type: 'button', class: 'prof-chip' + (val === selected.v ? ' on' : ''), text: getLabel(o) });
    chip.addEventListener('click', () => {
      selected.v = (selected.v === val) ? '' : val;
      chips.forEach((c) => c.el.classList.toggle('on', c.val === selected.v));
      if (onPick) onPick(selected.v);
    });
    chips.push({ el: chip, val });
    wrap.append(chip);
  });
  return wrap;
}

// canonical body_md → 선택값 복원. 기본 견본(채워넣기/local.md)은 빈값으로(새로 시작).
function parseMyProfile(md) {
  const r = { role: '', dev: '', address: '', tone: '', len: '', area: '', tools: '', memo: '' };
  if (!md || /채워넣기|members\/local\.md/.test(md)) return r;
  const parts = md.split(/^##\s*추가 메모\s*$/m);
  const head = parts[0] || '';
  if (parts[1]) r.memo = parts[1].trim();
  const grab = (re) => { const m = head.match(re); return m ? m[1].trim() : ''; };
  r.role = grab(/^[-*\s]*\**\s*역할\s*\**\s*[:：]\s*(.+)$/m);
  const dev = grab(/^[-*\s]*\**\s*개발[^:：\n]*\**\s*[:：]\s*(.+)$/m);
  r.dev = (PROF_DEV.find((d) => dev.startsWith(d.label)) || ({} as any)).v || '';
  r.address = grab(/^[-*\s]*\**\s*호칭[^:：\n]*\**\s*[:：]\s*(.+)$/m);
  const tone = grab(/^[-*\s]*\**\s*말투\s*\**\s*[:：]\s*(.+)$/m);
  r.tone = PROF_TONE.find((t) => tone.startsWith(t)) || '';
  const len = grab(/^[-*\s]*\**\s*응답\s*길이\s*\**\s*[:：]\s*(.+)$/m);
  r.len = (PROF_LEN.find((l) => len.startsWith(l.v)) || ({} as any)).v || '';
  r.area = grab(/^[-*\s]*\**\s*담당[^:：\n]*\**\s*[:：]\s*(.+)$/m);
  r.tools = grab(/^[-*\s]*\**\s*자주[^:：\n]*\**\s*[:：]\s*(.+)$/m);
  return r;
}

// 업로드 이미지 → 128px 정사각(center-crop) JPEG data URL. 작게 만들어 org_member.avatar 에 인라인 저장.
function fileToAvatarDataUrl(file): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) { reject(new Error('이미지 파일만 올릴 수 있어요')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('파일을 읽지 못했습니다'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = 128;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('이미지를 처리하지 못했습니다')); return; }
        const s = Math.min(img.width, img.height); // 짧은 변 기준 정사각 center-crop
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('이미지를 불러오지 못했습니다'));
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

// ── 비밀번호 변경 모달 (#444) ──
// 두 진입: (a) 임시 비번(must_change) 로그인 직후 강제 변경(forced=닫기 불가, 현재 비번은 방금 임시 비번 자동),
//  (b) '내 프로필' 모달의 [비밀번호 변경](상시, 취소 가능). 백엔드 POST /api/ui/password(현재→새, 8자+).
//  보안: el()/textContent 만(innerHTML 금지). 모달 셸은 .ov-* 재사용.
const PW_INPUT_STYLE = 'width:100%; box-sizing:border-box; padding:9px 11px; border:1px solid var(--line); border-radius:9px; font-size:14px; background:var(--bg); color:var(--ink);';
function pwFieldRow(label, input) {
  return el('label', { style: 'display:flex; flex-direction:column; gap:5px; margin-bottom:12px;' },
    el('span', { style: 'font-size:12.5px; font-weight:600; color:var(--ink-sub);', text: label }), input);
}
function changePasswordModal(o?: { forced?: boolean; currentPrefill?: string | null }): void {
  const forced = !!(o && o.forced);
  const presetCurrent = (o && o.currentPrefill) || '';

  const head = el('div', { class: 'ov-head' }, el('h3', { text: forced ? '새 비밀번호 설정' : '비밀번호 변경' }));
  const box = el('div', { class: 'ov-box', style: 'max-width:440px' }, head);
  const back = el('div', { class: 'ov-back' }, box);
  const close = () => back.remove();
  if (!forced) { // 강제(forced) 모드는 닫기 불가 — 새 비번을 설정해야만 진행.
    head.append(el('button', { class: 'btn btn-ghost btn-sm', text: '닫기', onclick: close }));
    back.addEventListener('click', (e: any) => { if (e.target === back) close(); });
    document.addEventListener('keydown', function esc(ev: any) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  }

  const pwInput = (ph, ac) => el('input', { type: 'password', placeholder: ph, autocomplete: ac, style: PW_INPUT_STYLE });
  const curIn = pwInput('현재 비밀번호', 'current-password');
  const nextIn = pwInput('새 비밀번호 (8자 이상)', 'new-password');
  const confIn = pwInput('새 비밀번호 확인', 'new-password');
  const err = el('p', { class: 'gate-error', hidden: true, style: 'margin:2px 0 10px;' });
  const showErr = (m) => { err.textContent = m; (err as any).hidden = false; };

  const rows: any[] = [];
  if (forced) rows.push(el('p', { class: 'admin-hint', text: '임시 비밀번호로 로그인했습니다. 계속하려면 새 비밀번호를 설정하세요.' }));
  else rows.push(pwFieldRow('현재 비밀번호', curIn));
  rows.push(pwFieldRow('새 비밀번호', nextIn), pwFieldRow('새 비밀번호 확인', confIn));

  const submit = el('button', { class: 'btn btn-primary', type: 'submit', text: forced ? '설정하고 계속' : '변경' });
  const secondary = forced
    ? el('button', { type: 'button', class: 'btn btn-ghost', text: '로그아웃', onclick: () => { close(); logout(); } })
    : el('button', { type: 'button', class: 'btn btn-ghost', text: '취소', onclick: close });
  const actions = el('div', { style: 'display:flex; gap:8px; justify-content:flex-end; margin-top:16px;' }, secondary, submit);

  const form = el('form', { style: 'margin:0;' }, ...rows, err, actions);
  form.addEventListener('submit', async (ev: any) => {
    ev.preventDefault();
    const current = forced ? presetCurrent : curIn.value;
    const next = nextIn.value;
    const conf = confIn.value;
    if (!forced && !current) { showErr('현재 비밀번호를 입력하세요.'); return; }
    if (next.length < 8) { showErr('새 비밀번호는 8자 이상이어야 합니다.'); return; }
    if (next !== conf) { showErr('새 비밀번호가 일치하지 않습니다.'); return; }
    if (next === current) { showErr('현재 비밀번호와 다른 비밀번호를 설정하세요.'); return; }
    (submit as any).disabled = true;
    try {
      await api('/api/ui/password', { method: 'POST', body: JSON.stringify({ current, next }) });
      close();
      toast('비밀번호가 변경되었습니다.');
    } catch (e: any) {
      (submit as any).disabled = false;
      showErr((e && e.message) || '비밀번호 변경에 실패했습니다.');
    }
  });
  box.append(form);
  document.body.append(back);
  setTimeout(() => (forced ? nextIn : curIn).focus(), 0);
}

// git 자격 관리 오버레이(#540) — 레포 클론·세션 git 용 SSH/HTTPS 자격. scope='me'(본인 자가등록) | 'gateway'(조직 머신계정·admin).
//  SSH 는 박스가 키페어를 만들고 **공개키만** 보여준다(사용자가 GitHub 에 등록 — 개인키는 박스 밖으로 안 나감). HTTPS 는 토큰 저장.
//  provision 클론은 요청 멤버 자격(없으면 gateway)을 주입, 세션 안 git 은 멤버 자격을 멤버 홈에 materialize(Slice 2).
function openGitCredentialManager(scope: 'me' | 'gateway') {
  const isGw = scope === 'gateway';
  const base = isGw ? '/api/ui/org/git-credential' : '/api/ui/me/git-credential';
  const body = el('div', { style: 'min-width:520px; max-width:640px;' });
  const back = overlay(isGw ? '게이트웨이 git 계정' : 'git 인증 (레포 접근)', body);
  document.body.append(back);

  const reload = async () => {
    body.replaceChildren(skeleton('불러오는 중'));
    try { render(await api(base)); }
    catch (e: any) { body.replaceChildren(el('p', { class: 'gate-error', text: (e && e.message) || '불러오기 실패' })); }
  };

  const credRow = (c: any) => {
    const head = el('div', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;' },
      el('span', { class: 'pill pill-ok', text: String(c.kind || '').toUpperCase() }),
      el('span', { class: 'mini-meta', text: c.host }),
      c.kind === 'ssh' && c.ssh_public_key ? copyButton(() => c.ssh_public_key, '공개키 복사') : null,
      el('button', {
        class: 'btn btn-ghost btn-sm', text: '삭제',
        onclick: async () => {
          if (!confirm(`${c.host} (${c.kind}) 자격을 삭제할까요?`)) return;
          try { await api(base + '/delete', { method: 'POST', body: JSON.stringify({ host: c.host }) }); toast('삭제됨'); reload(); }
          catch (e: any) { toast((e && e.message) || '삭제 실패', true); }
        },
      }));
    const box = el('div', { class: 'card', style: 'padding:10px 12px; margin:6px 0;' }, head);
    if (c.kind === 'ssh' && c.ssh_public_key) {
      box.append(el('pre', { class: 'admin-preview', style: 'white-space:pre-wrap; word-break:break-all; margin:8px 0 0; font-size:11.5px;', text: c.ssh_public_key }));
      box.append(el('p', { class: 'admin-hint', style: 'margin:6px 0 0', text: '이 공개키를 호스트에 등록하세요 — GitHub: 레포 Settings ▸ Deploy keys · GitLab: 레포 Settings ▸ Repository ▸ Deploy keys(또는 계정 ▸ SSH keys). 셀프호스팅 GitLab 도 동일.' }));
    }
    return box;
  };

  const render = (data: any) => {
    const rows: any[] = [];
    rows.push(el('p', { class: 'admin-hint', style: 'margin:0 0 10px', text: isGw
      ? '조직 머신 git 계정입니다. 프로젝트 provision 클론에서 요청한 구성원 자격이 없을 때 이 자격으로 클론합니다 — private 레포면 여기(또는 각 구성원)에 자격이 있어야 클론됩니다.'
      : '내 git 자격입니다. private 레포 클론과 세션(shell·Claude) 안 git 에 이 자격이 쓰입니다. SSH 는 박스가 키를 만들고 공개키만 호스트(GitHub·GitLab·셀프호스팅)에 등록하면 됩니다(개인키는 박스 밖으로 안 나갑니다).' }));
    if (!data.encryption_ready) rows.push(el('p', { class: 'gate-error', style: 'margin:0 0 10px', text: '⚠ 서버에 CONNECTOR_SECRET_KEY 가 설정되지 않아 자격을 저장할 수 없습니다 — 관리자에게 게이트웨이 env(CONNECTOR_SECRET_KEY) 설정을 요청하세요.' }));

    const creds = (data.credentials || []) as any[];
    if (creds.length) rows.push(...creds.map(credRow));
    else rows.push(el('p', { class: 'admin-hint', text: '등록된 자격이 없습니다.' }));

    // ── 새 자격 추가 ──
    rows.push(el('div', { style: 'border-top:1px solid var(--line); margin:14px 0 10px;' }));
    const hostIn = el('input', { type: 'text', value: 'github.com', placeholder: 'github.com' });
    const kindSel = { v: 'ssh' as 'ssh' | 'https' };
    const sshBox = el('div', {}, el('p', { class: 'admin-hint', style: 'margin:0', text: '박스가 ed25519 키페어를 생성합니다. 생성 후 공개키를 호스트(GitHub·GitLab 등)에 Deploy key 로 등록하세요.' }));
    const userIn = el('input', { type: 'text', placeholder: '사용자명(선택 — GitHub PAT 는 비워도 됨, GitLab 은 보통 계정명/oauth2)' });
    const tokenIn = el('input', { type: 'password', placeholder: 'HTTPS 토큰 / PAT', autocomplete: 'off' });
    const httpsBox = el('div', { style: 'display:none' }, field('사용자명(선택)', userIn), field('토큰', tokenIn));
    const kindChips = el('div', { class: 'chips' },
      ...(['ssh', 'https'] as const).map((k) => {
        const chip = el('button', { type: 'button', class: 'chip' + (kindSel.v === k ? ' on' : ''), text: k === 'ssh' ? 'SSH 키 (박스 생성)' : 'HTTPS 토큰' });
        chip.onclick = () => {
          kindSel.v = k;
          Array.from(kindChips.children).forEach((c: any, i) => c.classList.toggle('on', (['ssh', 'https'] as const)[i] === k));
          sshBox.style.display = k === 'ssh' ? '' : 'none';
          httpsBox.style.display = k === 'https' ? '' : 'none';
          submit.textContent = k === 'ssh' ? 'SSH 키 생성' : '토큰 저장';
        };
        return chip;
      }));
    const submit = el('button', { class: 'btn btn-primary', text: 'SSH 키 생성' });
    const status = el('span', { class: 'admin-status' });
    submit.addEventListener('click', async () => {
      if (!data.encryption_ready) { toast('CONNECTOR_SECRET_KEY 미설정 — 저장할 수 없습니다', true); return; }
      const host = hostIn.value.trim() || 'github.com';
      const payload: any = { kind: kindSel.v, host };
      if (kindSel.v === 'https') {
        if (!tokenIn.value.trim()) { toast('토큰을 입력하세요', true); return; }
        payload.token = tokenIn.value; if (userIn.value.trim()) payload.username = userIn.value.trim();
      }
      (submit as any).disabled = true; status.textContent = kindSel.v === 'ssh' ? '키 생성 중…' : '저장 중…';
      try {
        await api(base, { method: 'POST', body: JSON.stringify(payload) });
        toast(kindSel.v === 'ssh' ? 'SSH 키 생성됨 — 아래 공개키를 호스트에 Deploy key 로 등록하세요' : '토큰 저장됨');
        reload();
      } catch (e: any) { status.textContent = ''; (submit as any).disabled = false; toast((e && e.message) || '실패', true); }
    });
    rows.push(el('div', { class: 'card', style: 'padding:12px;' },
      el('div', { class: 'field-label', style: 'margin-bottom:8px', text: '새 자격 추가' }),
      kindChips, field('호스트', el('div', {}, hostIn, el('p', { class: 'admin-hint', style: 'margin:4px 0 0', text: 'GitHub·GitLab·셀프호스팅(예: git.honestfund.kr) 모두 지원 — 레포 호스트를 정확히 입력. HTTPS 가 막힌 호스트는 SSH 로 등록하세요.' }))), sshBox, httpsBox,
      el('div', { class: 'admin-actions', style: 'margin-top:10px' }, submit, status)));

    body.replaceChildren(...rows);
  };
  reload();
}

async function openMyProfile() {
  let data;
  try { data = await api('/api/ui/me/profile'); }
  catch (e) { toast((e && e.message) || '프로필을 불러오지 못했습니다', true); return; }
  const p = parseMyProfile(data.body_md || '');

  const nameIn = el('input', { type: 'text', value: data.display_name || '', placeholder: '표시 이름 (비우면 이메일/아이디로 표시)' });
  const roleIn = el('input', { type: 'text', value: p.role, placeholder: '예: 라이블리 공동대표 / 백엔드 개발 / 디자이너' });
  const addressIn = el('input', { type: 'text', value: p.address, placeholder: '예: 원준님 / 대표님 / 원준' });
  const areaIn = el('input', { type: 'text', value: p.area, placeholder: '예: 컨텍스트 저장소, GTM, 프론트엔드' });
  const toolsIn = el('input', { type: 'text', value: p.tools, placeholder: '예: context-ontology, Cursor, Figma' });
  const memoTa = el('textarea', { class: 'admin-ta', rows: '4', placeholder: 'AI가 더 알면 좋은 것을 자유롭게. 비밀번호·토큰은 넣지 마세요.' });
  memoTa.value = p.memo;

  // ── 아바타 — 업로드 이미지(없으면 커스텀 글자·색 또는 이니셜+해시색). undefined=변경없음, null=기본으로, string=새 이미지. ──
  let avatarState: string | null | undefined;
  let charState = (data.avatar_char || '');   // 커스텀 글자(빈=이니셜)
  let colorState = (data.avatar_color || '');  // 커스텀 배경색 #rrggbb(빈=해시색)
  const avaPreview = el('span', { class: 'prof-ava-preview' });
  const renderAva = () => {
    const cur = avatarState === undefined ? (data.avatar || null) : avatarState;
    const nm = nameIn.value.trim() || data.display_name || data.email || data.id || '';
    avaPreview.replaceChildren(profileAvatar(cur, nm, data.id, 'prof-ava-lg', { char: charState, color: colorState }));
  };
  const fileIn = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
  const uploadBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '사진 올리기' });
  const removeBtn = el('button', { type: 'button', class: 'btn-text', text: '기본 이미지로' });
  uploadBtn.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0]; if (!f) return;
    try { avatarState = await fileToAvatarDataUrl(f); renderAva(); }
    catch (e) { toast((e && e.message) || '이미지를 처리하지 못했습니다', true); }
    fileIn.value = '';
  });
  removeBtn.addEventListener('click', () => { avatarState = null; renderAva(); });
  nameIn.addEventListener('input', renderAva); // 이름 바꾸면 폴백 이니셜도 갱신
  // 커스텀 글자 — 최대 3자(비우면 이름 이니셜). 이미지가 있으면 이미지가 우선.
  const charIn = el('input', { type: 'text', maxlength: '3', value: charState, placeholder: '글자', style: 'width:70px; text-align:center; font-weight:700;' });
  charIn.addEventListener('input', () => { charState = charIn.value; renderAva(); });
  // 커스텀 배경색 — 팔레트(‘A’=자동 해시색). 리스트/폴더 색 스와치(.pjv-sw) 재사용.
  const AVA_COLORS = ['#6c8cff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#64748b', '#0ea5e9', '#14b8a6', '#f97316', '#8b5cf6'];
  const colorRow = el('div', { class: 'pjv-color-swatches' });
  const paintColors = () => {
    const auto = el('button', { type: 'button', class: 'pjv-sw pjv-sw-none' + (colorState ? '' : ' on'), title: '자동(이름 해시색)', text: 'A' });
    auto.onclick = () => { colorState = ''; paintColors(); renderAva(); };
    colorRow.replaceChildren(auto, ...AVA_COLORS.map((c) => {
      const s = el('button', { type: 'button', class: 'pjv-sw' + (colorState === c ? ' on' : ''), style: 'background:' + c, title: c });
      s.onclick = () => { colorState = c; paintColors(); renderAva(); };
      return s;
    }));
  };
  paintColors();
  renderAva();
  const avaRow = el('div', { class: 'prof-ava-row' }, avaPreview,
    el('div', { class: 'prof-ava-actions' }, fileIn, uploadBtn, removeBtn,
      el('p', { class: 'prof-hint', style: 'margin:0', text: '정사각형 이미지를 권장해요. 안 올리면 아래 글자·색(또는 이름 이니셜)으로 자동 생성됩니다.' })));
  const avaCharColor = el('div', { class: 'prof-ava-cc', style: 'margin-top:12px' },
    el('div', { style: 'display:flex; align-items:center; gap:12px; flex-wrap:wrap' }, charIn, colorRow),
    el('p', { class: 'prof-hint', style: 'margin:6px 0 0', text: '사진이 없을 때 아바타에 쓸 글자(비우면 이니셜)와 배경색이에요.' }));

  const devSel = { v: p.dev };
  const devHint = el('p', { class: 'prof-hint' });
  const renderDevHint = () => { const d = PROF_DEV.find((x) => x.v === devSel.v); devHint.textContent = d ? d.hint : '항목을 고르면 AI가 기술 답변 깊이를 맞춰요.'; };
  const devChips = profChips(PROF_DEV, devSel, (o) => o.label, (o) => o.v, renderDevHint);
  renderDevHint();

  const toneSel = { v: p.tone };
  const toneChips = profChips(PROF_TONE.map((t) => ({ v: t })), toneSel, (o) => o.v, (o) => o.v);

  const lenSel = { v: p.len };
  const lenHint = el('p', { class: 'prof-hint' });
  const renderLenHint = () => { const l = PROF_LEN.find((x) => x.v === lenSel.v); lenHint.textContent = l ? l.hint : ''; };
  const lenChips = profChips(PROF_LEN, lenSel, (o) => o.v, (o) => o.v, renderLenHint);
  renderLenHint();

  const saveBtn = el('button', { type: 'button', class: 'btn btn-primary', text: '저장' });
  const status = el('span', { class: 'admin-status' });

  const back = overlay('내 프로필',
    el('p', { class: 'admin-hint', style: 'margin:0 0 16px',
      text: '아래에서 고르면 당신의 AI가 매 세션 첫머리에 그대로 반영합니다 — 호칭·말투·답변 길이·기술 깊이 등. 비밀번호·토큰 같은 시크릿은 넣지 마세요(자동 차단).' }),
    field('프로필 사진', el('div', {}, avaRow, avaCharColor)),
    field('표시 이름', nameIn),
    data.email ? field('이메일 (로그인 아이디 · 관리자 전용)', el('div', { class: 'admin-ro', text: data.email })) : null,
    data.email ? field('비밀번호', el('div', { style: 'display:flex; align-items:center; gap:10px; flex-wrap:wrap;' },
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '비밀번호 변경', onclick: () => changePasswordModal() }),
      el('span', { class: 'admin-hint', style: 'margin:0', text: '현재 비밀번호를 확인한 뒤 새 비밀번호로 바꿔요.' }))) : null,
    field('git 인증 (레포 접근)', el('div', { style: 'display:flex; align-items:center; gap:10px; flex-wrap:wrap;' },
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'git 인증 관리', onclick: () => openGitCredentialManager('me') }),
      el('span', { class: 'admin-hint', style: 'margin:0', text: 'private 레포 클론·세션(shell·Claude) 안 git 에 쓸 SSH 키/토큰을 등록해요.' }))),
    field('내 스킬·훅 (#699)', el('div', { style: 'display:flex; align-items:center; gap:10px; flex-wrap:wrap;' },
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '내 스킬·훅 설정', onclick: () => openMyAssets() }),
      el('span', { class: 'admin-hint', style: 'margin:0', text: '관리자가 배포한 스킬·훅 중 본인에게 적용되는 것을 직접 켜고 끌 수 있어요.' }))),
    field('역할', roleIn),
    field('개발 이해도', el('div', {}, devChips, devHint)),
    field('호칭 (AI가 나를 부르는 말)', addressIn),
    field('말투', toneChips),
    field('응답 길이', el('div', {}, lenChips, lenHint)),
    field('담당 영역', areaIn),
    field('자주 쓰는 도구·레포', toolsIn),
    field('추가 메모', memoTa),
    el('div', { class: 'admin-actions' }, saveBtn, status));

  saveBtn.addEventListener('click', async () => {
    // 선택·입력 → canonical markdown(AI가 읽기 좋고 parseMyProfile 로 복원 가능). 빈 항목은 생략.
    const lines: string[] = [];
    if (roleIn.value.trim()) lines.push('- 역할: ' + roleIn.value.trim());
    const d = PROF_DEV.find((x) => x.v === devSel.v);
    if (d) lines.push('- 개발 이해도: ' + d.label + ' — ' + d.hint);
    if (addressIn.value.trim()) lines.push('- 호칭: ' + addressIn.value.trim());
    if (toneSel.v) lines.push('- 말투: ' + toneSel.v);
    const l = PROF_LEN.find((x) => x.v === lenSel.v);
    if (l) lines.push('- 응답 길이: ' + l.v + ' — ' + l.hint);
    if (areaIn.value.trim()) lines.push('- 담당 영역: ' + areaIn.value.trim());
    if (toolsIn.value.trim()) lines.push('- 자주 쓰는 도구·레포: ' + toolsIn.value.trim());
    let body = lines.length ? ('## 내 프로필\n' + lines.join('\n') + '\n') : '';
    const memo = memoTa.value.trim();
    if (memo) body += (body ? '\n' : '') + '## 추가 메모\n' + memo + '\n';

    const payload: any = { display_name: nameIn.value.trim(), body_md: body };
    if (avatarState !== undefined) payload.avatar = avatarState; // null=기본으로, string=새 이미지(미변경이면 생략→보존)
    payload.avatar_char = charState.trim() || null;  // 커스텀 글자(빈=이니셜 자동)
    payload.avatar_color = colorState || null;        // 커스텀 배경색(빈=해시색 자동)

    saveBtn.disabled = true;
    try {
      const res = await api('/api/ui/me/profile', { method: 'POST', body: JSON.stringify(payload) });
      const m = (res && res.member) || {};
      if (state.me) { state.me.display_name = m.display_name || null; state.me.avatar = m.avatar || null; state.me.avatar_char = m.avatar_char || null; state.me.avatar_color = m.avatar_color || null; }
      setPersonAvatar((state.me && state.me.userId) || data.id, m); // 사람 아바타 맵 즉시 갱신 → 다른 곳 칩/얼굴도 다음 렌더부터 반영
      // 상단 버튼 갱신(아바타 + 표시 이름) — 이름은 표시이름 우선, 없으면 이메일/아이디(main.ts boot 과 동일 규칙).
      const label = (m.display_name && m.display_name.trim()) || m.email
        || (state.me && (state.me.email || state.me.userId)) || '';
      const ue = document.getElementById('user-email');
      if (ue) ue.replaceChildren(profileAvatar(m.avatar || null, label, (state.me && state.me.userId) || data.id, 'topbar-ava', { char: m.avatar_char, color: m.avatar_color }), el('span', { text: label }));
      toast('저장됨 — 다음 세션부터 AI가 이 프로필을 반영합니다');
      back.remove();
    } catch (e) { toast((e && e.message) || '저장하지 못했습니다', true); saveBtn.disabled = false; }
  });
}

// ── 내 스킬·훅 셀프 설정(#699) — 멤버가 본인에게 배포되는 스킬·훅을 기본(관리자)/켜기/끄기로 조정. me/* 엔드포인트, principal 강제. ──
async function openMyAssets() {
  const KIND_LABEL: Record<string, string> = { skill: '스킬', subagent: '서브에이전트', command: '커맨드' };
  const back = overlay('내 스킬·훅',
    el('p', { class: 'admin-hint', style: 'margin:0 0 12px',
      text: '관리자가 배포한 스킬·훅 중 본인에게 적용되는 것을 직접 켜고 끌 수 있어요. “기본”은 관리자 설정을 따르고, “켜기/끄기”는 본인 세션에만 강제 적용됩니다(다른 구성원엔 영향 없음). 다음 세션부터 반영돼요.' }));
  const bodyBox = el('div', {});
  (back.querySelector('.ov-box') as HTMLElement).append(bodyBox);

  const reload = async () => {
    bodyBox.replaceChildren(el('p', { class: 'admin-hint', text: '불러오는 중…' }));
    let data: any;
    try { data = await api('/api/ui/me/assets'); }
    catch (e: any) { bodyBox.replaceChildren(el('p', { class: 'admin-hint', text: (e && e.message) || '불러오지 못했습니다' })); return; }

    const mkRow = (targetKind: string, it: any, kindLabel: string) => {
      const stateNow = it.override === null ? 'default' : (it.override ? 'on' : 'off');
      const effPill = el('span', { class: 'pill', text: it.effective ? '적용 중' : '미적용' });
      const seg = el('div', { style: 'display:flex; gap:4px; flex-shrink:0;' });
      const opt = (v: string, label: string) => {
        const b = el('button', { type: 'button', class: 'btn btn-sm ' + (stateNow === v ? 'btn-primary' : 'btn-ghost'), text: label });
        b.addEventListener('click', async () => {
          try {
            const b2 = { target_kind: targetKind, ref_id: it.id } as any;
            if (v === 'default') b2.clear = true; else b2.state = (v === 'on');
            await api('/api/ui/me/asset-pref', { method: 'POST', body: JSON.stringify(b2) });
            await reload();
          } catch (e: any) { toast((e && e.message) || '실패', true); }
        });
        return b;
      };
      seg.append(opt('default', '기본' + (it.byDefault ? '(켬)' : '(끔)')), opt('on', '켜기'), opt('off', '끄기'));
      const desc = String(it.description || it.note || '');
      return el('div', { class: 'mini-row', style: 'display:flex; align-items:center; gap:12px;' },
        el('div', { style: 'flex:1; min-width:0;' },
          el('div', { class: 'mini-title' }, el('span', { text: it.label || it.id }), effPill),
          el('div', { class: 'mini-meta', text: kindLabel + (desc ? ' · ' + (desc.length > 90 ? desc.slice(0, 90) + '…' : desc) : '') })),
        seg);
    };

    const rows: any[] = [];
    const skills = (data.skills || []); const hooks = (data.hooks || []);
    rows.push(el('h4', { style: 'margin:14px 0 6px', text: '스킬 · 에이전트 · 커맨드' }));
    if (skills.length) skills.forEach((s: any) => rows.push(mkRow('harness_asset', s, KIND_LABEL[s.kind] || s.kind)));
    else rows.push(el('p', { class: 'admin-hint', text: '배포된 스킬이 없어요.' }));
    rows.push(el('h4', { style: 'margin:16px 0 6px', text: '커스텀 훅' }));
    if (hooks.length) hooks.forEach((h: any) => rows.push(mkRow('org_hook', h, h.event)));
    else rows.push(el('p', { class: 'admin-hint', text: '배포된 훅이 없어요.' }));
    bodyBox.replaceChildren(...rows);
  };
  reload();
}

function overlay(title, ...content) {
  const close = el('button', { class: 'btn btn-ghost btn-sm', text: '닫기' });
  const box = el('div', { class: 'ov-box' }, el('div', { class: 'ov-head' }, el('h3', { text: title }), close), ...content);
  const back = el('div', { class: 'ov-back' }, box);
  close.addEventListener('click', () => back.remove());
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc); } });
  document.body.append(back);
  return back;
}

// ==== [task-detail-modal] 아래는 클릭업형 태스크 상세 모달(append-only 반영) ====
// ════════════════════════════════════════════
// 태스크 상세 모달(클릭업형 팝업) — 태스크 행 클릭 시 2-pane 팝업.
//  좌: 타입/제목/필드그리드(상태·기간·시간추적·담당자·우선순위·태그)·설명(MD)·하위·의존성·체크리스트·첨부.
//  우: Activity(댓글 + 시스템이벤트 피드 + 작성기).
//  데이터: GET /api/ui/v6/tasks/:id/detail 1회 페치, 각 편집은 전용 엔드포인트 패치 후 모달만 refresh.
//  닫을 때 변경 있었으면 페이지 reload() 로 리스트 반영. 보안: el()/textContent/renderMarkdown 만.
// ════════════════════════════════════════════

export {
  changePasswordModal,
  copyButton,
  deployCommands,
  field,
  hasScope,
  installCmd,
  loadAdmin,
  openMyProfile,
  overlay,
  renderSystem,
};
