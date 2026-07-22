// admin.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { absTime, api, applyReveal, cardHead, el, errorNote, fmtNum, logout, memberCombo, profileAvatar, relTime, renderMarkdown, selectFilter, setPersonAvatar, state, toast, withTip, infoPop, inlineBold } from './core.js';
import { SPACE_SUBS, openCategoryForm } from './category-form.js'; // #764 — knowledge.ts 해체로 이관
import { overlayBox, skeleton } from './learn.js';
import { ingestPolicyPanel, reviewNavBadge } from './review.js'; // #783 지식 검토 게이트 + 검토 큐 (+ #802 nav 대기 배지)
// ════════════════════════════════════════════════════════════════════
// 관리(전달/관리 — workflow-std 흡수). 핵심 원칙: 비개발자가 편집/확인하는 모든 항목 옆에
// '구성원에게 미치는 효과'를 항상 보여준다(meaning 패널). 셸/디자인/라우터는 기존 재사용.
// ════════════════════════════════════════════════════════════════════
// ════════ 관리탭 정보구조 (#837, 2026-07-14) ════════
// 이전 구조(2026-06-20~)의 대분류 5개는 **서로 다른 잣대**로 잘려 있었다 — 빈도(기본 설정)·대상(조직·권한)·
//  대상(분류 체계)·메커니즘(맥락·세션 주입), 그리고 **난이도**('연결·데이터 (고급)'). 마지막은 주제가 아니라
//  형용사여서 기술적인 건 전부 거기로 밀렸다: 소분류 25개 중 17개(권한 체제는 5가지가 뒤섞임). 그 결과
//  나머지 그룹 3개는 소분류가 1개뿐이라 좌측 nav 가 사라졌다 나타났다 했다(구 soloSection 예외).
//
// 그래서 분류축을 **하나**로 통일한다 — "무엇을 관리하는가":
//  조직(누가 쓰나) · AI 맥락(AI에게 뭘 가르치나) · AI 능력(AI가 뭘 할 수 있나) · 데이터 연결(AI가 어디에 닿나) · 운영·감사(무슨 일이 있었나).
// 그리고 **가로 중분류 바를 폐지**하고 좌측 사이드바 하나에 그룹 머리글로 편다(프로젝트 탭 중분류 폐지 #629 와 같은 방향).
//  → 16개 화면이 항상 한눈에 보이고 화면 골격이 바뀌지 않는다.
//
// 병합 원칙(불변식, 2026-06-26 결정 계승): **합치는 건 화면이지 데이터가 아니다 — 새 진실 출처 0.**
//  같은 리소스를 다루던 여러 탭을 한 화면의 서브탭으로 접을 뿐, 저장 경로(API)는 그대로 둔다.
//
// ⚠ 셸(내비 골격)은 #827 이 먼저 바꿨다 — 가로 중분류 바(.admin-cats) + 그룹별 좌측 카드 nav 를
//  '사용 가이드(#/learn)의 docs-side 재사용 + 본문 전폭'으로 통합(main 594feb3). 여기서는 **그 셸을 그대로 쓰고**,
//  #827 이 손대지 않은 **내용**(그룹·섹션 구성, 병합, 용어)을 바꾼다. 그래서 아래 그룹·섹션 정의가 이 파일의 핵심이다.
const ADMIN_GROUPS = [
    // 내 설정 — 축이 다르다(대상이 '나'). 맨 위에 두는 이유: 비관리자에게는 관리탭에서 **실제로 할 수 있는 유일한 일**이다
    //  (나머지는 전부 읽기 전용). 관리자도 호칭·말투는 자주 손본다. GitHub·Slack 도 개인 → 조직 순이다.
    { key: 'me', label: '내 설정' },
    { key: 'org', label: '조직' },
    { key: 'context', label: 'AI 맥락' },
    { key: 'capability', label: 'AI 능력' },
    { key: 'data', label: '데이터 연결' },
    { key: 'ops', label: '운영·감사' },
];
// ════════ 용어 사전 (#837) — 한 단어가 두 가지를 가리키던 것들을 갈랐다 ════════
// 조사 결과 관리탭의 핵심 명사 대부분이 이중 의미였다. 특히 **'커넥터'는 정반대 두 축**에 붙어 있었다:
//   ⓐ 패시브 미러 — 외부 SaaS 를 우리 DB 로 **당겨와 저장**한다. `org_connector` · CONNECTOR_SPECS · sync run.
//   ⓑ 액티브 프록시 — AI 가 **그때그때 호출**하는 외부 MCP 서버. `org_mcp_server`(mode=proxy, oauth).
// 그런데 구 nav 는 ⓐ를 '커넥터(외부 소스)', ⓑ의 로그인을 '자격(커넥터 로그인)' 이라 부르며 아홉 줄 간격으로
// 나란히 뒀다. 결정타: 구 `/api/ui/org/connector-catalog` 는 이름과 달리 **ⓐ와 무관**하고 ⓑ의 프리셋이었다
// (`name: string;  // org_mcp_server.name`) — 그래서 엔드포인트·파일·타입·MCP 툴명을 전부 mcp-server-presets
// 로 개명했다(구 REST 경로는 별칭 유지). 그리고:
//
//   ⓐ → **'외부 자료 수집'**  (데이터 연결 그룹 — 가져와서 쌓는 것)
//   ⓑ → **'AI 도구'** 안의 [외부 도구 서버] 서브탭  (AI 능력 그룹 — 호출하는 것)
//   'connector/커넥터' 라는 말은 **UI 에서 전면 퇴출**한다. 두 축 어느 쪽도 그 이름으로 부르지 않는다.
//
// 그 밖에 갈라 놓은 것:
//   · 세션 — 그냥 '세션' = AI 대화 세션(SessionStart). 구 '상시 세션'은 **'상시 에이전트'**로(충돌 해소).
//            '터미널 세션'은 터미널 탭 소관. 이제 관리탭의 "다음 세션부터 반영"이 모호하지 않다.
//   · 자격/토큰/열쇠 — **'접속 열쇠'** = 우리 게이트웨이 접속(auth_token). **'서비스 로그인'** = 외부 서비스
//            자격(member_secret). 둘을 '토큰'이라 뭉뚱그리지 않는다.
//   · 프로필 — 구 '중앙박스 계정(프로필)'은 **'AI 실행 계정'**([구성원] 안 서브탭). 우상단 '내 프로필'과 안 겹친다.
//   · scope — 구성원 권한은 '권한', 도구 호출에 필요한 건 '필요 권한', OAuth 는 'OAuth 허용범위',
//            수집 대상 고르기는 '수집 범위'(구 '스코프 픽커').
// ※ 서버 식별자(엔드포인트·capability·테이블)는 그대로 둔다 — 이건 화면 용어 정리다(호환 파괴 0).
//   → 개명 완료: `/api/ui/org/mcp-server-presets` (구 경로는 별칭 유지). 파일·타입·상수·MCP 툴명도 함께.
//
// ════════ 이어서 (#859) — 위 목록에서 빠졌던 '자산' ════════
// #837 은 이 섹션의 **라벨만** '스킬 · 훅'으로 고치고 본문을 안 고쳤다(부분 개명). 그 사이 meaning 카드는
// 이미 '자산'을 버렸는데(`MEANING['harness-asset'].label = "스킬 · 서브에이전트 · 슬래시커맨드"`,
// `src/org/meaning.ts` 전체 '자산' 0건) **그 카드를 띄우는 [ⓘ] 버튼 바로 위** 섹션 힌트가 '에이전트 자산'
// 이라 불렀다. 감사로그 라벨맵(OA_ENTITY_LABELS)도 이미 '스킬·에이전트·커맨드'로 피하고 있었다.
//   '자산' 은 한 낱말이 여섯 대상에 붙어 있었다 — 하네스 자산 · 노션 미디어 첨부 · 설치 파일 · 웹 정적 파일 ·
//   디자인 산출물 · 그냥 '재산'(일반명사). 영어 `asset` 은 그 여섯에 균일하게 붙지만 한국어 '자산' 은
//   **번역된 자리에서만** 도메인 개체 행세를 해서, 스킬 편집기 안에선 크롬("+ 자산 추가")과 본문("조직 자산과
//   개인 사생활이 섞여 있다")이 서로 다른 뜻으로 마주 보고 있었다.
//   → **'자산' 이라는 말은 UI 에서 전면 퇴출**한다('커넥터'와 같은 처리). 각각의 이름으로 부른다:
//        하네스 자산 → **'스킬 · 서브에이전트 · 커맨드'** (meaning 카드가 이미 쓰는 이름)
//        노션 미디어 → **'첨부 파일'**   ·   설치 번들 → **'설치 파일'**
//   영문 식별자(`org_harness_asset`·`asset_dir`·`agent-assets`·`assetForm`…)는 그대로 둔다(호환 파괴 0).
//
// ════════ 이어서 (#859) — '회수' ════════
// **영어 코드는 이미 갈려 있었고 한국어 UI 만 뭉갰다.** `reclaim`(디스크 파생물) · `revoke`(접속 열쇠/권한) ·
// `recall`/`retrieval`(지식 검색) · `invalidatePool`(DB 풀) 이 전부 '회수' 한 단어로 번역돼 있었다.
//   증상: [AI 도구 ▸ 기본 제공 도구]는 도구를 **이름순 한 리스트**로 편다. 그래서 한 스크롤 안에
//   "워크스페이스 일괄 회수"(파일 영구삭제) · "토큰 회수"(되돌릴 수 없는 무효화) · "언마스크 grant 회수"
//   (재부여 가능) · "의미로 회수한다"(**아무것도 안 지움**) 가 나란히 놓였다 — 파괴성이 안 읽힌다.
//   또 한 행위(접속 열쇠 무효화)에 이름이 4개였다: 버튼='접속 해제' / 감사배지='회수' / 설치안내="회수" /
//   Windows 언인스톨러="[토큰] 탭"(**없는 탭명** — #837 에서 [구성원 ▸ 접속 열쇠]로 합쳐졌다).
//   → 코드의 구분을 그대로 한국어로 옮긴다(새 어휘 발명 아님):
//        `reclaim` → **'정리'**(다시 만들 수 있는 것만 지움)   ·   `revoke`(auth_token) → **'접속 해제'**
//        `revoke`(grant) → **'권한 해제'**(되돌릴 수 있음)      ·   `recall` → **'검색'**(용어집이 이미 쓰는 말)
//        `invalidatePool` → **'연결 풀 재생성'**
//   도구명·엔드포인트(`org_workspace_reclaim`·`org_token_revoke`…)는 그대로 둔다(호환 파괴 0).
const ADMIN_SECTIONS = [
    // ── 내 설정 (#837 후속) ──
    //  구조상 우상단 [내 프로필] 모달 하나에 필드 15개 + 중첩 모달 2개가 들어 있었다 —
    //  사용자 지적: "개인 설정을 프로필 모달에서 하고있는데 이 경험이 안좋은거같아."
    //  모달은 **빠른 편집(프사·표시 이름)**만 남기고 나머지를 여기로 폈다. 저장 경로는 그대로다 —
    //  서버 me_profile_update 가 **부분 갱신(patch)** 이라(미전송 필드 보존) 화면을 쪼개도 한쪽이 다른쪽을 안 지운다.
    //  전 구성원 노출·전 구성원 편집 가능(내 것이니까) — 아래 어떤 권한 게이트에도 걸지 않는다.
    // '내 정보'(프사·이름·닉네임·비번)는 관리에서 분리 — 우측 상단 프로필 클릭 시 팝업(openMyProfileModal, #762). 여기 nav엔 두지 않는다.
    { key: 'me-ai', label: '내 AI 설정', meaning: null, group: 'me' },
    { key: 'me-logins', label: '외부 서비스 로그인', meaning: null, group: 'me' },
    { key: 'me-assets', label: '내 스킬 · 훅', meaning: null, group: 'me' },
    // ── 조직 ──
    { key: 'profile', label: '조직 정보', meaning: 'gateway-url', group: 'org' },
    // 구성원 — 구 [구성원 관리]+[구성원 추가]+[구성원 토큰 관리]+[중앙박스 계정] 4개 탭을 한 화면(서브탭)으로.
    //  넷 다 "한 사람에 대해 뭘 설정하나"였다. 갈라져 있던 탓에 '구성원 추가' 저장이 location.hash 로 토큰 탭에
    //  점프하고 state.admin.memberAddPreselect 로 선택을 실어 나르는 해킹이 필요했다(#837 에서 제거).
    { key: 'members', label: '구성원', meaning: 'member', group: 'org' },
    { key: 'teams', label: '팀', meaning: 'team', group: 'org' },
    // ── AI 맥락 ──
    //  항상-주입 섹션 문서(injection=always)는 지도에서 직접 추가/편집/삭제/재정렬한다(#335).
    { key: 'injection-map', label: '세션 주입', meaning: null, group: 'context' },
    // 카테고리(분류축) CRUD + 오너 팀 배정. 제품 카테고리 = 도메인. 여기가 정의·범위의 **주인**이다(#837 결정) —
    //  WIKI 탭 카테고리 페이지의 '정의·범위 편집'은 이리로 보내는 링크로 바뀌었다(편집 표면 일원화).
    { key: 'wiki-categories', label: '카테고리 (분류 체계)', meaning: null, group: 'context' },
    // 지식 검토 게이트(#638) — 자동 인입을 auto/confirm/drop 로 조절하는 **정책(밸브)**. 그 밸브가 만든 **대기열**
    //  (구 [검토 큐])은 설정이 아니라 일감이고 권한도 워킹레벨(memory)이라 WIKI 탭으로 옮겼다(#837). 여기선 딥링크만.
    { key: 'ingest-policy', label: '지식 검토 정책', meaning: null, group: 'context' },
    // 벡터 검색(#172) — 의미검색·유사도의 임베딩 provider + 백필. AI가 지식을 '뜻으로' 찾는 능력이라 맥락 그룹.
    { key: 'embeddings', label: '의미 검색', meaning: null, group: 'context' },
    // ── AI 능력 ──
    // 도구 — 구 [AI 도구(MCP)] + [MCP 서버]. 둘 다 이름에 MCP 가 붙어 헷갈렸지만 다른 것이었다:
    //  전자=우리가 정의해 노출하는 도구(사내 API·빌트인), 후자=외부 MCP 서버 등록. 한 화면의 서브탭으로.
    { key: 'tools', label: 'AI 도구', meaning: 'tool', group: 'capability' },
    // 로그인 키 — member_secret vault. 구 라벨 '자격(커넥터 로그인)'은 오해였다: 이 키를 소비하는 건 커넥터가
    //  아니라 **프록시 MCP 서버와 AI 도구**다(커넥터는 org_connector.secrets 라는 자기 테이블을 따로 쓴다).
    //  그래서 커넥터가 아니라 도구 옆에 둔다. 개인용 vault('내 자격')는 [내 프로필]로 이관(#837) → 여기는 조직 키만.
    { key: 'credentials', label: '서비스 로그인', meaning: null, group: 'capability' },
    // 스킬 · 훅 — 구 [커스텀 훅]+[스킬·에이전트·커맨드]. 둘 다 runtime 권한이고 둘 다 '구성원 컴퓨터에서
    //  도는 것'을 정의한다(스킬의 paired_hook_id 가 훅을 참조하기까지 한다). 한 화면의 서브탭으로.
    { key: 'agent-assets', label: '스킬 · 훅', meaning: 'harness-asset', group: 'capability' },
    // 자동화 — 구 [스케줄러]+[상시 세션]. 크론 액션의 param kind 에 'session' 이 1급으로 있고 4개 액션이 상시
    //  세션을 필수 타깃으로 받는다(크론=언제 × 상시세션=어디서·누구로). 떨어뜨려 놓을 이유가 없다.
    { key: 'automation', label: '자동화', meaning: null, group: 'capability' },
    // 미리보기(#1036) — 작업 중인 화면을 운영 화면·다른 사람 작업과 분리해 따로 띄워 본다. 사람이 고르는 건
    //  '무엇을 미리볼지'(프로젝트·레포)뿐이고 작업 폴더 준비·빌드는 서버가 한다. 대개 AI 가 만들어 쓰고 여기선 보고·열고·끈다.
    { key: 'preview-envs', label: '미리보기', meaning: null, group: 'capability' },
    // 세션 공유(#905 C1) — 구성원 AI 세션 대화 기록을 중앙에 모아 환경·멤버 무관 이어보기/이어받기. 프라이버시가
    //  걸린 org 정책이라 admin 전용. 기본 꺼짐(켜기 전엔 수집 안 함).
    { key: 'session-share', label: '세션 공유', meaning: null, group: 'capability' },
    // ── 데이터 연결 ──
    // 커넥터 = **패시브 미러 싱크**(slack/notion/clickup/gmail/drive 를 우리 DB로 당겨온다). AI가 실시간 호출하는
    //  외부 시스템(=MCP 서버·사내 API 도구)과는 다른 것이다 — 그건 [AI 능력 ▸ 도구]에 있다.
    { key: 'connectors', label: '외부 자료 수집', meaning: null, group: 'data' },
    // #976 위키 아웃바운드 — 우리 정본 지식을 외부(노션 등) '지식 피드' DB로 투영. 커넥터(인바운드)의 역방향.
    //  피드 목적지 + 카테고리 N:M 매핑(발행 게이트) 관리. 사람 페이지 불가침 — 전용 피드 DB에만 카드 append.
    { key: 'feed-targets', label: '위키 아웃바운드(피드)', meaning: null, group: 'data' },
    // #975/#978 프로젝트 아웃바운드 — 우리 프로젝트·과업 편집을 외부 PM(ClickUp; GitHub/Jira 예정)에 push. 소스별 on/off.
    { key: 'project-outbound', label: '프로젝트 아웃바운드', meaning: null, group: 'data' },
    // DB 데이터소스 — 등록 + 테이블 정책·컬럼 마스킹 + 감사 대상 식별자(subject-key) + 원본 열람 grant.
    //  subject-key 는 구 [DB 접근 감사] 화면에 잘못 꽂혀 있었다 — 서버는 /org/db-source/* 하위 리소스로 본다(#837 에서 이관).
    { key: 'db-sources', label: 'DB 데이터소스', meaning: 'db-source', group: 'data' },
    // 레포(git) — repo 테이블(=실제 git 레포) 등록·git 연결. 도메인맵 스캔 + 로컬 작업 클론의 단일 소스.
    { key: 'repos', label: '레포(git)', meaning: null, group: 'data' },
    // ── 운영·감사 ──
    // 감사 로그 — 구 [MCP 호출 통계]+[변경 감사 로그]+[DB 접근 감사]. 셋 다 "무슨 일이 있었나"를 묻는 읽기전용
    //  대시보드이고 UI 골격도 이미 동형이었다(oa-* 는 tu-* 복제). 백엔드는 각각 다르므로 서브탭으로만 묶는다.
    { key: 'audit', label: '감사 로그', meaning: null, group: 'ops' },
    // 컴퓨팅 리소스(#813·#1059) — 메모리·저장소(디스크). 서브탭으로 메모리/저장소를 가른다. 디스크가 100% 면 DB 가
    //  죽어 전 기능 500(2026-07-13 사고), 메모리가 마르면 OOM(2026-07 #1059). 고객 박스는 SSH 불가 → 여기가 유일 관측·조절 창구.
    { key: 'storage', label: '컴퓨팅 리소스', meaning: null, group: 'ops' },
    // #1059 — 로그(회전·보관)는 별도 메뉴. 컴퓨팅 리소스(메모리·저장소)와 성격이 달라 분리(사용자 피드백).
    { key: 'logs', label: '로그', meaning: null, group: 'ops' },
    // #1059 F — 세션: 이 박스에서 도는 전 AI 세션 메타뷰 + 수동 회수(idle 누적이 OOM 의 만성 원인. 여기서 보고 회수).
    { key: 'sessions', label: '세션', meaning: null, group: 'ops' },
];
// 구 URL → 새 섹션. 북마크·내부 링크·문서 링크를 깨지 않는다(#837 병합 + 과거 흡수분).
const SECTION_REMAP = {
    // #837 병합
    'member-add': 'members', 'tokens': 'members', 'profiles': 'members',
    'mcp': 'tools',
    'custom-hooks': 'agent-assets', 'harness-assets': 'agent-assets',
    'cron': 'automation', 'managed-sessions': 'automation',
    'tool-usage': 'audit', 'org-audit': 'audit', 'db-audit': 'audit',
    // 과거 흡수분(2026-06-26)
    'hooks-group': 'injection-map', 'hooks-preview': 'injection-map', 'runtime': 'injection-map',
    'safety': 'tools', 'org-defaults': 'injection-map', 'context-ontology-guide': 'injection-map',
};
// 구 [검토 큐]는 관리탭을 떠나 WIKI 탭으로 갔다(#837) — 섹션 리맵이 아니라 탭 밖 리다이렉트라 따로 둔다.
const SECTION_EXIT = { 'review-queue': '#/knowledge/review' };
// admin 권한 전용(쓰기·인프라·감사). #318 호출통계·#549 변경감사는 전 구성원의 변경·before/after 를 노출하므로 admin.
const ADMIN_ONLY = ['credentials', 'connectors', 'feed-targets', 'project-outbound', 'db-sources', 'storage', 'logs', 'sessions', 'embeddings', 'automation', 'audit', 'ingest-policy', 'session-share'];
const RUNTIME_ONLY = ['agent-assets']; // runtime 권한 전용(멤버 머신에서 도는 것의 정의)
// [도구]는 두 권한의 합집합 — 사내 API 도구·빌트인은 runtime, 외부 MCP 서버 등록은 admin. 둘 중 하나라도 있으면
//  섹션을 보여주고, 안에서 각 서브탭을 권한별로 켠다(구조상 한 섹션=한 scope 전제가 깨지는 유일한 자리라 명시한다).
//  [미리보기]도 합집합 — **쓰는 사람은 작업자(code)** 다. 관리자 전용으로 잠그면 정작 화면을 확인해야 할
//   사람이 못 쓴다(실측: 활성 구성원 대다수는 items·context 뿐이고 code 는 개발 구성원에게 부여된다).
//   단 '어떻게 띄울지'(스택 프로필)는 셸 명령을 담으므로 정의는 admin 만 — 사용은 code, 정의는 admin 으로 가른다.
const MIXED_SECTIONS = { tools: ['admin', 'runtime'], 'preview-envs': ['code', 'admin'] };
// V4-P5/J: 어휘(카테고리·레포·팀) CRUD = context 스코프(admin 완화). context 없는 사용자는 읽기 전용(섹션은 노출).
const CONTEXT_EDIT = ['wiki-categories', 'repos', 'teams'];
// 내 설정 — 권한 게이트 없음(전 구성원 노출·편집). 서버도 me/* 엔드포인트라 principal 로 강제된다.
const ME_SECTIONS = ['me-profile', 'me-ai', 'me-logins', 'me-assets'];
// 이 섹션을 **내가** 편집할 수 있나 — 섹션마다 요구 권한이 다르다.
//  ⚠ 전역 '읽기 전용 · 편집은 관리자만' 배지는 **거짓말이었다**(사용자 지적, #837 후속):
//   admin 이 없어도 [카테고리]·[레포]·[팀]은 `context` 권한만으로 편집된다(CONTEXT_EDIT — 패널들이 canContext 로 게이팅).
//   그런데 배지는 모든 섹션에 똑같이 "관리자만"이라 붙었다. 그래서 배지를 **섹션별**로 바꾸고 요구 권한을 정확히 말한다.
function sectionCanEdit(key, data) {
    if (ME_SECTIONS.includes(key))
        return true; // 내 설정 — 내 것이니 항상 편집 가능
    if (CONTEXT_EDIT.includes(key))
        return !!state.admin.canContext;
    if (RUNTIME_ONLY.includes(key))
        return !!data.canRuntime;
    const any = MIXED_SECTIONS[key];
    if (any)
        return any.some((sc) => (sc === 'admin' ? data.canEdit : sc === 'runtime' ? data.canRuntime : hasScope(sc)));
    return !!data.canEdit;
}
// 편집하려면 어떤 권한이 필요한지 — 배지 문구에 그대로 쓴다("관리자만"이라고 뭉뚱그리지 않는다).
function sectionNeedScope(key) {
    if (CONTEXT_EDIT.includes(key))
        return '컨텍스트(context)';
    if (RUNTIME_ONLY.includes(key))
        return '런타임(runtime)';
    return '관리자(admin)';
}
function sectionHidden(key, data) {
    if (ADMIN_ONLY.includes(key) && !data.canEdit)
        return true;
    if (RUNTIME_ONLY.includes(key) && !data.canRuntime)
        return true;
    // 합집합 섹션([도구]) — 요구 권한 중 하나라도 있으면 노출(안에서 서브탭별로 다시 건다).
    const any = MIXED_SECTIONS[key];
    if (any && !any.some((s) => (s === 'admin' ? data.canEdit : s === 'runtime' ? data.canRuntime : hasScope(s))))
        return true;
    return false;
}
// 현재 토큰이 가진 scope 보유 여부(/api/ui/me 의 scopes). 어휘 CRUD 권한(context) 판정에 쓴다.
function hasScope(s) {
    return !!(state.me && Array.isArray(state.me.scopes) && state.me.scopes.includes(s));
}
async function loadAdmin(force) {
    if (!state.admin.data || force)
        state.admin.data = await api('/api/ui/org');
    return state.admin.data;
}
function meaningRow(k, v) {
    return el('div', { class: 'meaning-row' }, el('span', { class: 'meaning-k', text: k }), el('span', { class: 'meaning-v', text: v }));
}
// '이게 뭐예요?' — 기본은 화면에 설명을 깔지 않고 작은 트리거 하나만 둔다. 궁금한 사람이 누르면
//  팝업(overlay)으로 전체 설명(요약·누가/언제/어디·예시)을 보여준다. 예전엔 항상-펼침(이후 한 줄 요약+토글)
//  이라 9개 섹션마다 같은 골격이 반복돼 화면이 무거웠다(윤상민 06-22 지적: "반복·둥둥 뜸"). 단일 함수라
//  모든 섹션에 일괄 적용. tone 색·카피는 팝업 안에서 그대로 보존.
// 두 번째 인자(m)는 옛 meaning 객체 또는 설명 문자열이다. **객체(효과 카드)는 폐기됐으므로 무시**하고,
//  문자열일 때만 설명으로 쓴다(호출부를 한꺼번에 고치지 않아도 되게 인자 자리는 남겨 둔다).
//  ⚠ **페이지 제목의 설명은 ⓘ 로 접지 않는다** — 한 페이지가 무엇을 하는 곳인지는 들어오자마자 보여야 한다
//   (사용자 요구: 큰 페이지 설명은 이전대로). ⓘ 는 박스(카드) 안 섹션 제목 전용(cardHead).
function sectionTitle(titleText, m) {
    const isText = typeof m === 'string';
    return el('div', {}, el('div', { class: 'section-title' }, el('h2', { text: titleText })), isText ? el('p', { class: 'admin-hint' }, ...inlineBold(m)) : null);
}
// System 탭 진입점(#/system) — 기존 관리(전달) 화면을 그대로 흡수 + 지식 종류 레지스트리.
async function renderSystem(view, sub) {
    return renderAdmin(view, sub);
}
async function renderAdmin(view, sub) {
    // #670 FOUC 방지 — loadAdmin(첫 진입 미캐시) 을 기다리기 전에 view 를 스켈레톤으로 먼저 비운다.
    //  안 그러면 라우터가 body[data-route]='system' 을 즉시 바꿔, 이전 탭(대시보드/보드/도메인맵 — 풀스크린 route CSS 의존)
    //  콘텐츠가 그 CSS 를 잃고 '로데이터·텍스트만' 처럼 깨진 채로 로드 시간만큼 잠깐 보인다(renderTerminal 과 동일한 선-스켈레톤 패턴).
    view.replaceChildren(skeleton('관리 데이터를 불러오는 중'));
    let data;
    try {
        data = await loadAdmin();
    }
    catch (e) {
        view.replaceChildren(errorNote(e, '관리 데이터를 불러오지 못했습니다'));
        return;
    }
    const canEdit = !!data.canEdit;
    state.admin.canEdit = canEdit;
    state.admin.canRuntime = !!data.canRuntime;
    // 어휘 CRUD 권한 — 정확히 context 스코프(admin 완화). 서버 도메인맵 CRUD 게이트가 scope:'context' 를
    //  엄격히 요구하므로(admin 자동 함의 없음 — web.ts mw), 버튼 노출도 context 보유로만 판정해 403 오작동을 막는다.
    state.admin.canContext = hasScope('context');
    // 선택 섹션 — 없거나 권한으로 숨으면 첫 노출 섹션으로.
    const visibleSections = ADMIN_SECTIONS.filter((s) => !sectionHidden(s.key, data));
    let sel = sub || state.admin.sel;
    // 관리탭을 떠난 섹션(구 [검토 큐] → WIKI)의 옛 URL — 리다이렉트하고 렌더를 넘긴다(라우터가 다시 돈다).
    if (sel && SECTION_EXIT[sel]) {
        location.replace(SECTION_EXIT[sel]);
        return;
    }
    if (sel && SECTION_REMAP[sel])
        sel = SECTION_REMAP[sel]; // 병합·흡수된 구 섹션 URL → 새 섹션
    if (!sel || !visibleSections.some((s) => s.key === sel))
        sel = (visibleSections[0] || ADMIN_SECTIONS[0]).key;
    state.admin.sel = sel;
    // ── 2단 사이드바(그룹 ▸ 섹션) — 사용 가이드(#/learn)의 docs-side 시각 언어 재사용(#827). ──
    //  위계 2단을 사이드바 하나가 전담한다: 그룹명은 소제목, 섹션은 그 아래 항목. 전 그룹이 항상 펼쳐져 있어
    //  '어디에 뭐가 있는지'가 한눈에 보인다. 권한으로 섹션이 0개인 그룹은 통째로 숨는다.
    const side = el('nav', { class: 'docs-side admin-side', 'aria-label': '관리 섹션' });
    for (const g of ADMIN_GROUPS) {
        const items = visibleSections.filter((s) => s.group === g.key);
        if (!items.length)
            continue;
        const box = el('div', { class: 'docs-side-group' }, el('div', { class: 'docs-side-title', text: g.label }));
        for (const s of items) {
            // 라벨 + 배지. 관리자 전용 섹션(ADMIN_ONLY — 비관리자에겐 sectionHidden 으로 아예 숨는 것)엔 '관리자' 배지를
            //  달아, 관리자가 볼 때 "이건 관리자만 보고 편집한다"가 드러나게 한다(#1010 — #613 회색 부제 폐지 자리에 권한 신호).
            //  '지식 검토 정책'(#802 계승)은 추가로 검토 대기 건수 배지(0건이면 안 그린다) — 큐 자체는 WIKI 로 갔지만(#837),
            //  게이트를 켠 관리자가 "내 밸브에 N건이 밀려 있다"를 여기서 보게 둔다.
            box.append(el('a', { class: 'docs-item' + (s.key === sel ? ' active' : ''), href: '#/system/' + s.key,
                'aria-current': s.key === sel ? 'page' : null }, el('span', { text: s.label }), ADMIN_ONLY.includes(s.key)
                ? el('span', { class: 'admin-only-badge', text: '관리자', title: '관리자(admin) 권한이 있어야 보고 편집할 수 있는 항목입니다.' })
                : null, s.key === 'ingest-policy' ? reviewNavBadge() : null));
        }
        side.append(box);
    }
    const detail = el('div', {});
    renderAdminDetail(detail, sel, data);
    // 페이지 머리('관리' + 부제 + 조직명)는 폐지(#837) — 상단 탭이 이미 '관리'를 켜 두었고 사이드바가 지금 어느
    //  화면인지 말해 준다. 그 위에 화면마다 같은 제목·부제가 반복되면 본문만 아래로 밀린다.
    //  '읽기 전용'은 **이 섹션이 실제로 나에게 읽기 전용일 때만** 붙인다(섹션별 — 위 sectionCanEdit 주석 참조).
    const ro = !sectionCanEdit(sel, data)
        ? el('div', { class: 'admin-ro-note' }, el('span', { class: 'pill', text: '읽기 전용' }), el('span', { text: '이 화면을 편집하려면 ' + sectionNeedScope(sel) + ' 권한이 필요합니다 — 관리자에게 요청하세요.' }))
        : null;
    const body = el('div', { class: 'admin-body' }, ro, detail);
    view.replaceChildren(el('div', { class: 'docs-layout admin-layout' }, side, body));
    applyReveal([body]);
}
// sel 은 두 종류가 들어온다:
//  ① nav 섹션 키(ADMIN_SECTIONS) — 사이드바가 고른 것.
//  ② 서브패널 키 — 병합된 화면 안의 개별 패널이 **자기 자리를 그 자리에서 다시 그릴 때** 쓰는 키.
//     (패널들이 저장·삭제 후 renderAdminDetail(host, 'tokens', …) 식으로 자기를 재렌더한다. 그 host 는 서브탭 본문이라
//      제자리 갱신이 된다. ②는 nav 에 없으므로 URL 로는 도달하지 않는다 — SECTION_REMAP 이 먼저 걸러낸다.)
function renderAdminDetail(detail, sel, data) {
    // ── ① nav 섹션 ──
    // '내 정보'는 관리에서 분리(#762) — 옛 링크(#/system/me-profile) 호환: 팝업 열고 안내만 남긴다.
    if (sel === 'me-profile') {
        openMyProfileModal();
        detail.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: "'내 정보'는 우측 상단 프로필 버튼을 눌러 편집해요." })));
        return;
    }
    if (sel === 'me-ai')
        return void myAiSection(detail);
    if (sel === 'me-logins')
        return void myLoginsSection(detail);
    if (sel === 'me-assets')
        return void myAssetsSection(detail);
    if (sel === 'wiki-categories')
        return wikiCategoriesPanel(detail, data);
    if (sel === 'members')
        return membersSection(detail, data);
    if (sel === 'teams')
        return teamsPanel(detail, data);
    if (sel === 'profile')
        return profileEditor(detail, data);
    if (sel === 'injection-map')
        return injectionMap(detail, data);
    if (sel === 'agent-assets')
        return agentAssetsSection(detail, data);
    if (sel === 'tools')
        return toolsSection(detail, data);
    if (sel === 'audit')
        return auditSection(detail, data);
    if (sel === 'automation')
        return automationSection(detail, data);
    if (sel === 'connectors')
        return connectorEditor(detail, data);
    if (sel === 'feed-targets')
        return feedTargetsEditor(detail, data);
    if (sel === 'project-outbound')
        return projectOutboundEditor(detail, data);
    if (sel === 'db-sources')
        return dbSourceEditor(detail, data);
    if (sel === 'credentials')
        return credentialsEditor(detail);
    if (sel === 'storage')
        return storageEditor(detail, data);
    if (sel === 'logs')
        return logsEditor(detail, data);
    if (sel === 'sessions')
        return sessionsAdminEditor(detail, data);
    if (sel === 'session-share')
        return sessionShareEditor(detail, data);
    if (sel === 'embeddings')
        return embeddingsEditor(detail, data);
    if (sel === 'repos')
        return reposPanel(detail, data);
    if (sel === 'ingest-policy')
        return ingestPolicyPanel(detail, data);
    // ── ② 서브패널 제자리 재렌더 ──
    //  ⚠ 'members'·'tools' 는 ①의 **병합 섹션**(탭 껍데기) 키다 — 그 안의 개별 패널이 자기를 다시 그릴 땐
    //     반드시 아래 전용 키를 써야 한다. 안 그러면 탭 본문 안에 탭 껍데기가 또 렌더돼 중첩된다.
    if (sel === 'members-list')
        return membersEditor(detail, data);
    if (sel === 'tools-proxy')
        return toolsEditor(detail, data);
    if (sel === 'tokens')
        return tokensPanel(detail, data);
    if (sel === 'profiles')
        return void profilesEditor(detail);
    if (sel === 'mcp')
        return mcpEditor(detail, data);
    if (sel === 'custom-hooks')
        return customHookEditor(detail, data);
    if (sel === 'harness-assets')
        return harnessAssetEditor(detail, data);
    if (sel === 'tool-usage')
        return void toolUsagePanel(detail);
    if (sel === 'org-audit')
        return void orgAuditPanel(detail);
    if (sel === 'db-audit')
        return void dbAuditEditor(detail, data);
    if (sel === 'cron')
        return void cronPanel(detail, data);
    if (sel === 'managed-sessions')
        return void managedSessionsPanel(detail, data);
    if (sel === 'preview-envs')
        return void previewEnvsPanel(detail, data);
}
// ════════════════════════════════════════════════════════════════════
// 화면 내 서브탭 (#837) — 여러 탭으로 갈라져 있던 **한 개념**을 한 화면에 접는다.
//  좌측 nav 는 개념 단위로만 두고(16개), 그 개념의 여러 표면은 여기서 가른다. 라우팅은 섹션 단위 그대로라
//  URL 은 안 늘어난다. 선택은 state.admin.tab[sectionKey] 에 남아 패널 자체의 재렌더(목록 갱신 등)에도 살아남는다.
//  고아로 남아 있던 .seg-tabs 스타일을 되살려 쓴다(새 시각 언어 X — styles.css:534).
//  tabs: [{ key, label, show?, render(host) }] — show 가 false 면 권한 없음 → 탭 자체를 안 그린다.
function segTabs(sectionKey, tabs) {
    const live = tabs.filter((t) => t.show !== false);
    const host = el('div', {});
    if (!live.length)
        return host;
    state.admin.tab = state.admin.tab || {};
    let cur = state.admin.tab[sectionKey];
    if (!live.some((t) => t.key === cur))
        cur = live[0].key;
    state.admin.tab[sectionKey] = cur;
    const body = el('div', { class: 'seg-body' }); // 탭 내용 구획(카드)들이 여백 없이 붙지 않게 세로 간격(#req)
    const bar = el('div', { class: 'seg-tabs', role: 'tablist' });
    const paint = () => {
        for (const b of bar.children)
            b.classList.toggle('on', b.dataset.k === state.admin.tab[sectionKey]);
        body.replaceChildren();
        live.find((t) => t.key === state.admin.tab[sectionKey]).render(body);
    };
    for (const t of live) {
        const b = el('button', { type: 'button', role: 'tab', text: t.label });
        b.dataset.k = t.key;
        b.addEventListener('click', () => { state.admin.tab[sectionKey] = t.key; paint(); });
        bar.append(b);
    }
    // 탭이 하나뿐이면(권한으로 나머지가 숨음) 탭 바 자체가 의미 없다 — 본문만.
    if (live.length > 1)
        host.append(bar);
    host.append(body);
    paint();
    return host;
}
// 섹션 머리 — 제목 + 한 줄 설명 + '이게 뭐예요?'. 병합 섹션이 "여기 뭐가 들었나"를 먼저 말해준다.
function sectionHead(title, hint, m) {
    // admin-sechead: 제목 블록 아래 일관 여백. 페이지 설명(hint)은 종전대로 제목 아래 한 줄로 보인다.
    return el('div', { class: 'admin-sechead' }, sectionTitle(title, m || null), hint ? el('p', { class: 'admin-hint', text: hint }) : null);
}
// ── [구성원] — 구 [구성원 관리]+[구성원 추가]+[구성원 토큰 관리]+[중앙박스 계정] 4탭을 하나로. ──
//  넷 다 "한 사람에 대해 뭘 설정하나"였다. 갈라진 탓에 '구성원 추가' 저장이 location.hash 로 토큰 탭에 점프하고
//  state.admin.memberAddPreselect 로 선택을 실어 나르는 해킹이 필요했다 — 한 화면이 되면서 그 해킹이 사라졌다.
function membersSection(detail, data) {
    const admin = !!state.admin.canEdit;
    detail.replaceChildren(sectionHead('구성원', '이 조직을 누가 쓰는지, 각자 무엇으로 접속하는지, AI를 어떤 계정으로 실행하는지 정합니다.', data.meaning['member']), segTabs('members', [
        { key: 'list', label: '구성원', render: (h) => membersEditor(h, data) },
        // 접속 열쇠 = 우리 게이트웨이에 접속하는 bearer 토큰(auth_token). 외부 서비스 로그인과 다른 것 — 용어 사전 참조.
        { key: 'tokens', label: '접속 토큰', show: admin, render: (h) => tokensPanel(h, data) },
        // 'AI 실행 계정' — 구 '중앙박스 계정(프로필)'. '프로필'은 우상단 [내 프로필]과 겹쳐 버렸다(#524 에서 개념도 은퇴).
        { key: 'accounts', label: 'AI 실행 계정', show: admin, render: (h) => { void profilesEditor(h); } },
    ]));
}
// ── [AI 도구] — 구 [AI 도구(MCP)] + [MCP 서버]. ──
//  구 라벨은 거짓말이었다: 'AI 도구(MCP)' 화면에 정작 외부 MCP 서버가 노출하는 도구가 없었다(그건 [MCP 서버] 탭
//  → [발행]로만 관리). 이제 AI 가 실제로 쥐는 세 종류를 한 화면에 모은다.
//  권한이 갈린다 — 사내 API·빌트인은 runtime, 외부 서버 등록은 admin(MIXED_SECTIONS).
function toolsSection(detail, data) {
    const rt = !!state.admin.canRuntime, admin = !!state.admin.canEdit;
    detail.replaceChildren(sectionHead('AI 도구', 'AI가 호출할 수 있는 도구를 관리합니다 — 사내 API 도구, 기본 제공 도구, 외부 도구 서버(MCP).', data.meaning['tool']), segTabs('tools', [
        { key: 'proxy', label: '사내 API 도구', show: rt, render: (h) => toolsEditor(h, data) },
        { key: 'builtin', label: '기본 제공 도구', show: rt, render: (h) => h.append(builtinToggles(data)) },
        // 외부 도구 서버 = 구 [MCP 서버]. 기본 프리셋(mcp-server-presets)이 실제로 채우는 게 바로 이것이다.
        { key: 'mcp', label: '외부 도구 서버 (MCP)', show: admin, render: (h) => mcpEditor(h, data) },
    ]));
}
// ── [스킬 · 훅] — 구 [커스텀 훅]+[스킬·에이전트·커맨드]. ──
//  둘 다 runtime 권한이고 둘 다 '구성원 컴퓨터에서 도는 것'을 정의한다(스킬의 paired_hook_id 가 훅을 참조하기까지).
function agentAssetsSection(detail, data) {
    detail.replaceChildren(sectionHead('스킬 · 훅', '구성원의 AI에 배포할 스킬·서브에이전트·커맨드와, 정해진 시점에 자동 실행되는 훅을 관리합니다.', data.meaning['harness-asset']), segTabs('agent-assets', [
        { key: 'assets', label: '스킬 · 서브에이전트 · 커맨드', render: (h) => harnessAssetEditor(h, data) },
        { key: 'hooks', label: '커스텀 훅 (코드)', render: (h) => customHookEditor(h, data) },
    ]));
}
// ── [자동화] — 구 [스케줄러]+[상시 세션]. ──
//  크론 액션의 param kind 에 'session' 이 1급으로 있고 4개 액션이 상시 에이전트를 필수 타깃으로 받는다
//  (크론=언제 × 상시 에이전트=어디서·누구로). 떨어뜨려 둘 이유가 없었다.
//  '상시 세션' → '상시 에이전트' 로 개명 — 그래야 이 탭 도처의 "다음 세션부터 반영"(=AI 대화)이 모호하지 않다.
function automationSection(detail, data) {
    detail.replaceChildren(sectionHead('자동화', '정해진 시각에 사람 없이 실행되는 작업과, 그 작업을 수행할 상시 에이전트를 관리합니다.'), segTabs('automation', [
        { key: 'cron', label: '스케줄', render: (h) => { void cronPanel(h, data); } },
        { key: 'sessions', label: '상시 에이전트', render: (h) => { void managedSessionsPanel(h, data); } },
    ]));
}
// ── [감사 로그] — 구 [MCP 호출 통계]+[변경 감사 로그]+[DB 접근 감사]. ──
//  셋 다 "무슨 일이 있었나"를 묻는 읽기전용 대시보드이고 UI 골격도 이미 동형이었다(oa-* 스타일은 tu-* 복제).
//  백엔드는 각각 다른 테이블이라 데이터는 안 합친다 — 서브탭으로만 묶는다(새 진실 출처 0).
//  ⚠ 구 [DB 접근 감사] 화면에 있던 '감사 대상 식별자'(subject-key) 설정은 여기 없다 — 그건 감사가 아니라 **설정**이고
//    서버도 /org/db-source/* 하위 리소스로 본다. [DB 데이터소스]로 옮겼다(#837).
function auditSection(detail, data) {
    detail.replaceChildren(sectionHead('감사 로그', '누가 언제 무엇을 했는지 봅니다 — 관리 항목 변경, DB 조회, AI 도구 호출.'), segTabs('audit', [
        { key: 'org', label: '관리 변경', render: (h) => { void orgAuditPanel(h); } },
        { key: 'db', label: 'DB 조회', render: (h) => { void dbAuditEditor(h, data); } },
        { key: 'tools', label: 'AI 도구 호출', render: (h) => { void toolUsagePanel(h); } },
    ]));
}
// ════════ MCP 호출 통계(#318) — 하네스가 어떤 MCP 툴을 어떤 인자로 어느 빈도로 호출했는지 ════════
//  읽기 전용 대시보드(admin). 백엔드=/api/ui/tool-usage(src/capabilities/tool-usage.ts → mcp_call_log 집계).
//  "직접/LLM 쿼리"는 db_query 로 mcp_call_log 를 SELECT(이 화면=사람용 집계 편의 표면). 새 서브탭일 뿐 기존 도구 화면 불변.
const TOOL_USAGE_STATE = { window: '7d', harness: '', tool: '', errorsOnly: false, page: 1 };
const TU_WINDOW_LABELS = { '1h': '최근 1시간', '24h': '최근 24시간', '7d': '최근 7일', '30d': '최근 30일', '90d': '최근 90일', 'all': '전체 기간' };
// 스타일 1회 주입(테마 토큰 사용 → 라이트/다크 자동 적응). innerHTML 없음 — textContent 로만 CSS 삽입(보안 불변식 준수).
function tuEnsureStyles() {
    if (document.getElementById('tu-styles'))
        return;
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
.tu-days{display:flex;gap:4px;height:72px;padding:6px 2px 0;border-bottom:1px solid var(--line)}
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
    if (v == null)
        return '{}';
    try {
        return JSON.stringify(v, null, 2);
    }
    catch {
        return String(v);
    }
}
// 소요시간 표기 — 큰 밀리초 값은 초/분으로 변환해 한눈에 크기를 읽게 한다(#853 UI 감사 114).
function tuFmtDur(ms) {
    if (ms == null)
        return '';
    if (ms < 1000)
        return ms + 'ms';
    if (ms < 60000)
        return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + '분';
}
// 번호 페이지네이션용 페이지 목록(생략 …). 적으면 전부, 많으면 1 … cur-1 cur cur+1 … total.
function tuPageNumbers(cur, total) {
    if (total <= 7) {
        const a = [];
        for (let i = 1; i <= total; i++)
            a.push(i);
        return a;
    }
    const out = [1];
    const lo = Math.max(2, cur - 1);
    const hi = Math.min(total - 1, cur + 1);
    if (lo > 2)
        out.push('…');
    for (let i = lo; i <= hi; i++)
        out.push(i);
    if (hi < total - 1)
        out.push('…');
    out.push(total);
    return out;
}
async function toolUsagePanel(detail) {
    tuEnsureStyles();
    const reload = () => toolUsagePanel(detail);
    const PAGE_SIZE = 50;
    // 현재 필터 → 쿼리스트링(+추가 파라미터). 페이지 이동·CSV·재조회가 공유.
    const filterQs = (extra) => {
        const q = new URLSearchParams({ window: TOOL_USAGE_STATE.window });
        if (TOOL_USAGE_STATE.harness)
            q.set('harness', TOOL_USAGE_STATE.harness);
        if (TOOL_USAGE_STATE.tool)
            q.set('tool', TOOL_USAGE_STATE.tool);
        if (TOOL_USAGE_STATE.errorsOnly)
            q.set('errors', '1');
        for (const k in (extra || {}))
            q.set(k, String(extra[k]));
        return q.toString();
    };
    detail.replaceChildren(el('div', { class: 'card' }, skeleton('호출 통계를 불러오는 중')));
    const page = Math.max(1, TOOL_USAGE_STATE.page || 1);
    let r;
    try {
        r = await api('/api/ui/tool-usage?' + filterQs({ offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }));
    }
    catch (e) {
        detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '호출 통계를 불러오지 못했습니다')));
        return;
    }
    const sum = r.summary || {};
    const byTool = r.byTool || [];
    const byHarness = r.byHarness || [];
    const byDay = (r.byDay || []).slice().reverse(); // 서버는 최신→과거 정렬 → 그래프는 과거→최신으로
    const recent = r.recent || [];
    const total = sum.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    // ── 컨트롤(기간·하네스·툴·결과 필터) — 필터 변경 시 page=1 리셋 ──
    const winSel = el('select', { class: 'tu-sel' });
    for (const w of (r.windows || Object.keys(TU_WINDOW_LABELS)))
        winSel.append(el('option', { value: w, text: TU_WINDOW_LABELS[w] || w }));
    winSel.value = r.window || TOOL_USAGE_STATE.window;
    winSel.onchange = () => { TOOL_USAGE_STATE.window = winSel.value; TOOL_USAGE_STATE.page = 1; reload(); };
    const harnessSel = el('select', { class: 'tu-sel' });
    harnessSel.append(el('option', { value: '', text: '모든 하네스' }));
    const harnessVals = byHarness.map((h) => h.harness).filter((h) => h && h !== '(미상)');
    if (TOOL_USAGE_STATE.harness && !harnessVals.includes(TOOL_USAGE_STATE.harness))
        harnessVals.push(TOOL_USAGE_STATE.harness);
    for (const h of harnessVals)
        harnessSel.append(el('option', { value: h, text: h }));
    harnessSel.value = TOOL_USAGE_STATE.harness;
    harnessSel.onchange = () => { TOOL_USAGE_STATE.harness = harnessSel.value; TOOL_USAGE_STATE.page = 1; reload(); };
    // 툴 필터 = 드롭다운(현재 기간+하네스 내 실제 툴 목록 + 호출수). 이름 타이핑 대신 선택.
    const toolSel = el('select', { class: 'tu-sel' });
    toolSel.append(el('option', { value: '', text: '모든 툴' }));
    const toolOpts = r.toolOptions || [];
    for (const t of toolOpts)
        toolSel.append(el('option', { value: t.tool, text: t.tool + ' (' + (t.calls || 0).toLocaleString() + ')' }));
    if (TOOL_USAGE_STATE.tool && !toolOpts.some((t) => t.tool === TOOL_USAGE_STATE.tool))
        toolSel.append(el('option', { value: TOOL_USAGE_STATE.tool, text: TOOL_USAGE_STATE.tool }));
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
        const rows = [];
        let off = 0;
        const CAP = 5000;
        try {
            while (off < total && rows.length < CAP) {
                const r2 = await api('/api/ui/tool-usage?' + filterQs({ offset: off, limit: 500 }));
                const batch = (r2 && r2.recent) || [];
                if (!batch.length)
                    break;
                rows.push(...batch);
                off += batch.length;
                if (batch.length < 500)
                    break;
            }
        }
        catch (e) {
            toast('CSV 조회 실패');
            return;
        }
        const cols = ['called_at', 'tool', 'harness', 'actor', 'ok', 'duration_ms', 'error', 'args'];
        const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        const lines = [cols.join(',')];
        for (const c of rows)
            lines.push([c.called_at, c.tool, c.harness, c.actor, c.ok, c.duration_ms, c.error, (c.args == null ? '' : JSON.stringify(c.args))].map(esc).join(','));
        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: 'mcp-calls-' + TOOL_USAGE_STATE.window + (TOOL_USAGE_STATE.errorsOnly ? '-errors' : '') + '.csv' });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast(rows.length.toLocaleString() + '행 내려받음' + (rows.length >= CAP ? ' (상한 ' + CAP + ')' : ''));
    };
    const controls = el('div', { class: 'tu-controls' }, el('div', { class: 'tu-field' }, el('label', { text: '기간' }), winSel), el('div', { class: 'tu-field' }, el('label', { text: '하네스' }), harnessSel), el('div', { class: 'tu-field' }, el('label', { text: '툴' }), toolSel), el('div', { class: 'tu-field' }, el('label', { text: '결과' }), errSel), el('button', { class: 'btn btn-ghost btn-sm', text: '새로고침', onclick: reload }), el('button', { class: 'btn btn-ghost btn-sm', text: 'CSV 다운로드', onclick: exportCsv }), (TOOL_USAGE_STATE.harness || TOOL_USAGE_STATE.tool || TOOL_USAGE_STATE.errorsOnly)
        ? el('button', { class: 'btn btn-ghost btn-sm', text: '필터 해제', onclick: () => { TOOL_USAGE_STATE.harness = ''; TOOL_USAGE_STATE.tool = ''; TOOL_USAGE_STATE.errorsOnly = false; TOOL_USAGE_STATE.page = 1; reload(); } })
        : null);
    // ── 요약 스탯 ──
    const stat = (label, value, bad) => el('div', { class: 'tu-stat' + (bad ? ' tu-bad' : '') }, el('b', { text: String(value) }), el('span', { text: label }));
    const stats = el('div', { class: 'tu-stats' }, stat('총 호출', (sum.total || 0).toLocaleString()), stat('툴 종류', sum.tools || 0), stat('하네스', sum.harnesses || 0), stat('오류', (sum.errors || 0).toLocaleString(), (sum.errors || 0) > 0), stat('마지막 호출', sum.last_at ? relTime(sum.last_at) : '—'));
    // ── 일별 막대(KST) ──
    let daysEl = null;
    if (byDay.length) {
        const maxCalls = Math.max(...byDay.map((d) => d.calls), 1);
        const bars = el('div', { class: 'tu-days' });
        const labels = el('div', { class: 'tu-daylabels' });
        for (const d of byDay) {
            const h = Math.max(2, Math.round((d.calls / maxCalls) * 100));
            const allErr = d.calls > 0 && d.errors >= d.calls;
            bars.append(el('div', { class: 'tu-day' }, el('i', { class: allErr ? 'tu-allerr' : '', style: 'height:' + h + '%', title: d.day + ' · ' + d.calls + '회' + (d.errors ? ' (오류 ' + d.errors + ')' : '') })));
            labels.append(el('span', { text: String(d.day).slice(5) }));
        }
        daysEl = el('div', {}, el('div', { class: 'tu-sub', text: '일별 호출 (KST)' }), bars, labels);
    }
    // ── 툴별 표 ──
    const maxToolCalls = Math.max(...byTool.map((t) => t.calls), 1);
    const toolBody = el('tbody');
    for (const t of byTool) {
        const frac = Math.round((t.calls / maxToolCalls) * 100);
        toolBody.append(el('tr', {}, el('td', { class: 'tu-namecell' }, el('span', { class: 'tu-bar', style: 'width:' + frac + '%' }), el('span', { class: 'tu-name mono', text: t.tool })), el('td', { class: 'tu-num', text: (t.calls || 0).toLocaleString() }), el('td', { class: 'tu-num', text: t.errors ? String(t.errors) : '–' }), el('td', { class: 'tu-num', text: t.avg_ms != null ? tuFmtDur(t.avg_ms) : '–' }), el('td', { class: 'tu-num', text: t.max_ms != null ? tuFmtDur(t.max_ms) : '–' }), el('td', { class: 'tu-num', text: t.last_at ? relTime(t.last_at) : '–' })));
    }
    const toolTable = byTool.length
        ? el('table', { class: 'tu-table' }, el('thead', {}, el('tr', {}, el('th', { text: '툴' }), el('th', { class: 'tu-num', text: '호출' }), el('th', { class: 'tu-num', text: '오류' }), el('th', { class: 'tu-num', text: '평균' }), el('th', { class: 'tu-num', text: '최대' }), el('th', { class: 'tu-num', text: '마지막' }))), toolBody)
        : el('div', { class: 'tu-empty', text: '이 조건에 기록된 호출이 없습니다.' });
    // ── 하네스별 칩 ──
    const harnessChips = el('div', { class: 'tu-harness' });
    for (const h of byHarness)
        harnessChips.append(el('span', { class: 'tu-chip' }, el('span', { text: h.harness }), el('b', { text: (h.calls || 0).toLocaleString() }), h.errors ? el('em', { text: '오류 ' + h.errors }) : null));
    // ── 최근 호출(인자 펼침) + 번호 페이지네이션 ──
    const calls = el('div', { class: 'tu-calls' });
    const renderCall = (c) => el('details', { class: 'tu-call' }, el('summary', {}, el('span', { class: 'tu-ctime', text: relTime(c.called_at) }), el('span', { class: 'tu-ctool mono', text: c.tool }), el('span', { class: 'dm-tag', text: c.harness || '미상' }), c.ok ? null : el('span', { class: 'tu-cbad', text: '✗ 오류' }), el('span', { class: 'tu-cdur', text: c.duration_ms != null ? tuFmtDur(c.duration_ms) : '' }), el('span', { class: 'tu-cactor', text: c.actor || '' })), el('pre', { class: 'tu-args mono', text: tuPretty(c.args) }), c.error ? el('pre', { class: 'tu-args mono', text: '⚠ ' + c.error }) : null);
    if (!recent.length)
        calls.append(el('div', { class: 'tu-empty', text: TOOL_USAGE_STATE.errorsOnly ? '이 조건의 오류 호출이 없습니다.' : '최근 호출이 없습니다.' }));
    for (const c of recent)
        calls.append(renderCall(c));
    // 번호 페이지네이션 — 페이지 클릭 시 page 갱신 후 reload(필터·집계 유지). ‹ 1 … 4 5 6 … 20 ›
    const pagerBox = el('div', { class: 'tu-pager' });
    if (totalPages > 1) {
        const cur = Math.min(page, totalPages);
        const pgBtn = (label, n, kind) => el('button', {
            class: 'tu-pg' + (kind === 'on' ? ' tu-pg-on' : '') + (kind === 'off' ? ' tu-pg-off' : ''),
            text: String(label), ...(kind ? {} : { onclick: () => { TOOL_USAGE_STATE.page = n; reload(); } })
        });
        pagerBox.append(pgBtn('‹', cur - 1, cur <= 1 ? 'off' : undefined));
        for (const pn of tuPageNumbers(cur, totalPages)) {
            if (pn === '…')
                pagerBox.append(el('span', { class: 'tu-pg-gap', text: '…' }));
            else
                pagerBox.append(pgBtn(pn, pn, pn === cur ? 'on' : undefined));
        }
        pagerBox.append(pgBtn('›', cur + 1, cur >= totalPages ? 'off' : undefined));
        pagerBox.append(el('span', { class: 'tu-pg-info', text: cur + ' / ' + totalPages + ' 페이지' }));
    }
    const card = el('div', { class: 'card' }, cardHead('툴 호출 기록', '하네스(Claude·Codex 등)가 어떤 MCP 툴을 어떤 인자로 얼마나 자주 호출했는지 보여줍니다. 모든 호출이 기록되며(시크릿은 마스킹, 큰 값은 잘라 저장), AI에게 묻거나 db_query 로 mcp_call_log 를 직접 조회할 수도 있습니다.'), controls, stats, daysEl, el('div', { class: 'tu-sub', text: '툴별 호출' }), toolTable, byHarness.length ? el('div', { class: 'tu-sub', text: '하네스별' }) : null, byHarness.length ? harnessChips : null, el('div', { class: 'tu-sub', text: '최근 호출' + (total ? ' (' + total.toLocaleString() + ')' : '') }), calls, pagerBox);
    detail.replaceChildren(card);
}
// ════════ 조직 변경 감사 로그(#549) — 누가(사람/AI)·언제·무엇을·어디서(mcp/web) 바꿨는지 + before→after ════════
//  읽기 전용(admin). 백엔드=/api/ui/org/audit(src/capabilities/delivery.ts org_audit_list → org_content_audit).
//  에이전트가 MCP 로 관리기능을 만지게 열린 뒤(#549) 'AI 가 관리탭을 바꿨다'를 사람이 확인하는 표면. 필터·페이징은 tool-usage 와 동형.
const ORG_AUDIT_STATE = { scope: 'admin', entity: '', actor_kind: '', channel: '', op: '', page: 1 };
const OA_ENTITY_LABELS = {
    org_member: '구성원', auth_token: '토큰', org_profile: '조직 프로필', org_section: '주입 섹션',
    org_runtime_config: '런타임 설정', org_connector: '외부 자료 수집', org_mcp_server: '외부 도구 서버(MCP)',
    org_hook: '커스텀 훅', org_tool: 'AI 도구', org_harness_asset: '스킬·에이전트·커맨드', org_db_source: 'DB 소스',
    org_db_table_policy: '테이블 정책', org_db_column_mask: '컬럼 마스킹',
};
// op=revoke 는 auth_token 만 쓴다(org/store.ts) — 그래서 '접속 해제'로 못박는다. 언마스크 권한 철회는
//  op=update 로 감사되므로 이 라벨과 섞이지 않는다(#859).
const OA_OP_LABELS = { insert: '생성', update: '수정', delete: '삭제', revoke: '접속 해제', mint: '발급', reorder: '순서변경' };
const OA_CHANNEL_LABELS = { mcp: '에이전트(MCP)', web: '웹 관리탭', connector: '자료 수집기', cli: 'CLI', migration: '마이그레이션', unknown: '미상' };
const OA_KIND_LABELS = { human: '사람', ai: 'AI', system: '시스템', connector: '자료 수집기', unknown: '미상' };
// 스타일 1회 주입(테마 토큰 — 라이트/다크 자동). textContent 로만 삽입(보안 불변식). tool-usage 의 tu-* 를 oa-* 로 복제.
function oaEnsureStyles() {
    if (document.getElementById('oa-styles'))
        return;
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
.oa-key{color:var(--ink-sub);font-size:12px;font-family:ui-monospace,monospace;display:inline-block;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
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
    const out = [];
    for (const k of keys) {
        if (JSON.stringify(b[k]) === JSON.stringify(a[k]))
            continue;
        out.push({ key: k, before: b[k], after: a[k], hadBefore: k in b, hasAfter: k in a });
    }
    return out;
}
function oaVal(v) {
    if (v === undefined)
        return '—';
    if (v === null)
        return '(없음)'; // 감사 before/after 값이 null 이면 문자 'null' 대신 '(없음)'
    if (typeof v === 'string')
        return v.length > 400 ? v.slice(0, 400) + '…' : v;
    try {
        const s = JSON.stringify(v, null, 1);
        return s.length > 600 ? s.slice(0, 600) + '…' : s;
    }
    catch {
        return String(v);
    }
}
async function orgAuditPanel(detail) {
    oaEnsureStyles();
    const reload = () => orgAuditPanel(detail);
    const PAGE_SIZE = 50;
    const filterQs = (extra) => {
        const q = new URLSearchParams();
        if (ORG_AUDIT_STATE.scope)
            q.set('scope', ORG_AUDIT_STATE.scope);
        if (ORG_AUDIT_STATE.entity)
            q.set('entity', ORG_AUDIT_STATE.entity);
        if (ORG_AUDIT_STATE.actor_kind)
            q.set('actor_kind', ORG_AUDIT_STATE.actor_kind);
        if (ORG_AUDIT_STATE.channel)
            q.set('channel', ORG_AUDIT_STATE.channel);
        if (ORG_AUDIT_STATE.op)
            q.set('op', ORG_AUDIT_STATE.op);
        for (const k in (extra || {}))
            q.set(k, String(extra[k]));
        return q.toString();
    };
    detail.replaceChildren(el('div', { class: 'card' }, skeleton('변경 이력을 불러오는 중')));
    const page = Math.max(1, ORG_AUDIT_STATE.page || 1);
    let r;
    try {
        r = await api('/api/ui/org/audit?' + filterQs({ offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }));
    }
    catch (e) {
        detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '변경 이력을 불러오지 못했습니다')));
        return;
    }
    const rows = r.rows || [];
    const total = r.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    // ── 필터 컨트롤 — 변경 시 page=1 리셋 ──
    const mkSel = (labelText, stateKey, opts, allLabel) => {
        const sel = el('select', { class: 'oa-sel' });
        sel.append(el('option', { value: '', text: allLabel }));
        for (const o of opts)
            sel.append(el('option', { value: o.val, text: o.label }));
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
    const controls = el('div', { class: 'oa-controls' }, el('div', { class: 'oa-field' }, el('label', { text: '범위' }), scopeSel), mkSel('종류', 'entity', entityOpts, '모든 종류'), mkSel('행위자', 'actor_kind', kindOpts, '사람·AI 전체'), mkSel('경로', 'channel', chanOpts, '모든 경로'), mkSel('작업', 'op', opOpts, '모든 작업'), el('button', { class: 'btn btn-ghost btn-sm', text: '새로고침', onclick: reload }), anyFilter ? el('button', { class: 'btn btn-ghost btn-sm', text: '필터 해제',
        onclick: () => { ORG_AUDIT_STATE.entity = ''; ORG_AUDIT_STATE.actor_kind = ''; ORG_AUDIT_STATE.channel = ''; ORG_AUDIT_STATE.op = ''; ORG_AUDIT_STATE.page = 1; reload(); } }) : null);
    // ── 행 리스트(펼치면 필드별 이전→이후) ──
    const list = el('div', { class: 'oa-rows' });
    const renderRow = (c) => {
        const kind = c.actor_kind || 'unknown';
        const diff = oaDiff(c.before, c.after);
        const diffBody = el('tbody');
        for (const d of diff)
            diffBody.append(el('tr', {}, el('td', { class: 'oa-f', text: d.key }), el('td', {}, el('div', { class: 'oa-v oa-v-was', text: d.hadBefore ? oaVal(d.before) : '—' })), el('td', {}, el('div', { class: 'oa-v oa-v-now', text: d.hasAfter ? oaVal(d.after) : '(삭제됨)' }))));
        const diffTable = diff.length
            ? el('table', { class: 'oa-diff' }, el('thead', {}, el('tr', {}, el('th', { text: '필드' }), el('th', { text: '이전' }), el('th', { text: '이후' }))), diffBody)
            : el('div', { class: 'oa-empty', text: '내용 변화 없음(메타만).' });
        return el('details', { class: 'oa-row' }, el('summary', {}, el('span', { class: 'oa-time', text: relTime(c.at) }), el('span', { class: 'oa-kind oa-kind-' + kind, text: OA_KIND_LABELS[kind] || kind }), el('span', { class: 'oa-actor', text: c.actor_display || c.actor || '—' }), el('span', { class: 'oa-ent', text: OA_ENTITY_LABELS[c.entity] || c.entity }), c.entity_key ? el('span', { class: 'oa-key', text: c.entity_key, title: c.entity_key }) : null, el('span', { class: 'oa-badge oa-op-' + c.op, text: OA_OP_LABELS[c.op] || c.op }), el('span', { class: 'oa-chan', text: OA_CHANNEL_LABELS[c.channel] || c.channel || '' })), diffTable);
    };
    if (!rows.length)
        list.append(el('div', { class: 'oa-empty', text: '이 조건의 변경 이력이 없습니다.' }));
    for (const c of rows)
        list.append(renderRow(c));
    // ── 페이지네이션(tuPageNumbers 재사용) ──
    const pagerBox = el('div', { class: 'oa-pager' });
    if (totalPages > 1) {
        const cur = Math.min(page, totalPages);
        const pgBtn = (label, n, kind) => el('button', {
            class: 'oa-pg' + (kind === 'on' ? ' oa-pg-on' : '') + (kind === 'off' ? ' oa-pg-off' : ''),
            text: String(label), ...(kind ? {} : { onclick: () => { ORG_AUDIT_STATE.page = n; reload(); } })
        });
        pagerBox.append(pgBtn('‹', cur - 1, cur <= 1 ? 'off' : undefined));
        for (const pn of tuPageNumbers(cur, totalPages)) {
            if (pn === '…')
                pagerBox.append(el('span', { class: 'oa-pg-gap', text: '…' }));
            else
                pagerBox.append(pgBtn(pn, pn, pn === cur ? 'on' : undefined));
        }
        pagerBox.append(pgBtn('›', cur + 1, cur >= totalPages ? 'off' : undefined));
        pagerBox.append(el('span', { class: 'oa-pg-info', text: cur + ' / ' + totalPages + ' 페이지' }));
    }
    const card = el('div', { class: 'card' }, cardHead('관리 변경 이력', '구성원·접속 토큰·런타임·외부 자료 수집·DB 소스·훅·도구 등 관리 항목이 누구에 의해(사람/AI) 어떤 경로(웹/MCP)로 언제 어떻게 바뀌었는지 기록합니다. 각 줄을 펼치면 바뀐 필드의 이전→이후를 볼 수 있습니다(시크릿은 마스킹). AI에게 묻거나 org_audit_list(MCP)로도 조회할 수 있습니다.'), controls, el('div', { class: 'oa-sub', text: '변경 이력' + (total ? ' (' + total.toLocaleString() + ')' : '') }), list, pagerBox);
    detail.replaceChildren(card);
}
// ── 스케줄러(자동화) — org_cron 잡 관리(admin). is 신선화·미매핑 LLM 분류(세션 주입)·sync 를 주기 실행. ──
//  map_unmapped 잡은 '타깃 LLM 세션'(상시 시드 세션)을 골라 거기에 분류 태스크를 주입한다(팀플랜 과금 — headless 토큰 아님).
async function cronPanel(detail, data) {
    const reload = () => cronPanel(detail, data);
    detail.replaceChildren(el('div', { class: 'card' }, skeleton('스케줄 잡을 불러오는 중')));
    let jobs;
    let actions = [];
    let tz = 'Asia/Seoul'; // tz(#778) = cron식을 해석하는 벽시계 기준(조직 시간대)
    try {
        const r = await api('/api/ui/cron');
        jobs = (r && r.jobs) || [];
        actions = (r && r.actions) || [];
        tz = (r && r.timezone) || tz;
    }
    catch (e) {
        detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '스케줄 잡을 불러오지 못했습니다')));
        return;
    }
    // 자동 생성 잡(#837) — [외부 자료 수집]에서 커넥터를 켜면 서버가 `sync-<system>`(노션은 `-full` 도)을
    //  **자동으로 등록/해제**한다(src/org/store.ts:987). 관리자가 만든 게 아닌데 목록에선 구분이 안 돼
    //  "내가 이걸 언제 만들었지?"가 됐고, 손으로 지우면 커넥터는 켜져 있는데 싱크만 안 도는 상태가 됐다.
    const autoSystemOf = (j) => {
        if (j.action !== 'connector_sync')
            return null;
        const sys = j.params && j.params.system;
        if (!sys)
            return null;
        return (j.id === 'sync-' + sys || j.id === 'sync-' + sys + '-full') ? String(sys) : null;
    };
    const rows = el('div', { class: 'wikicat-rows' });
    if (!jobs.length)
        rows.append(el('div', { class: 'wikicat-empty', text: '아직 스케줄 잡이 없습니다.' }));
    for (const j of jobs) {
        const autoSys = autoSystemOf(j);
        // fix#75: 주기 표시만 사람 단위로 — 60 배수는 분, 3600 배수는 시간(원값 괄호 병기). 저장·입력 단위(초)는 그대로.
        const fmtInterval = (s) => (s >= 3600 && s % 3600 === 0) ? ('매 ' + (s / 3600) + '시간(' + s + '초)')
            : (s >= 60 && s % 60 === 0) ? ('매 ' + (s / 60) + '분') : ('매 ' + s + '초');
        const sched = j.run_once ? '한 번만 (1회성)' : (j.cron_expr ? ('cron: ' + j.cron_expr) : fmtInterval(j.interval_sec || 0));
        const sess = (j.params && j.params.session) ? (' → ' + j.params.session) : '';
        const last = j.last_run_at ? (relTime(j.last_run_at) + ' · ' + (j.last_status || '')) : '미실행';
        const main = el('div', { class: 'wikicat-row-main' }, el('span', { class: 'wikicat-name', text: j.label || j.id }), autoSys ? withTip(el('span', { class: 'pill', text: '자동' }), '[외부 자료 수집]에서 ' + autoSys + ' 를 켜서 자동 등록된 잡입니다. 싱크를 멈추려면 이 잡이 아니라 커넥터를 끄세요.') : null, el('span', { class: 'wikicat-key mono', text: j.action + sess }), el('span', { class: 'dm-tag', text: j.enabled ? sched : '꺼짐' }), el('span', { class: 'wikicat-should' }, el('span', { class: 'wikicat-should-label', text: '최근' }), last));
        const acts = el('div', { class: 'wikicat-row-acts' }, el('button', { class: 'btn btn-ghost btn-sm', text: '지금 실행', onclick: () => cronRunNow(j.id, reload) }), el('button', { class: 'btn btn-ghost btn-sm', text: j.enabled ? '끄기' : '켜기', onclick: () => cronToggle(j, reload) }), el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openCronForm(j, actions, reload, tz) }), el('button', { class: 'btn btn-ghost btn-sm btn-ghost-danger', text: '삭제', onclick: () => cronDelete(j.id, reload, autoSys) }));
        rows.append(el('div', { class: 'wikicat-row' }, main, acts));
    }
    const head = el('div', { class: 'wikicat-grouphead' }, el('span', { class: 'wikicat-grouptitle', text: '스케줄 잡' }), el('span', { class: 'wikicat-groupcount', text: String(jobs.length) }), el('button', { class: 'btn btn-ghost btn-sm wikicat-add', text: '+ 잡 추가', onclick: () => openCronForm(null, actions, reload, tz) }));
    const card = el('div', { class: 'card' }, cardHead('정기 실행 잡', '게이트웨이가 정해진 주기마다 실행하는 잡입니다. 실제 코드 의존(is) 최신화(refresh), 미매핑 코드 유닛 LLM 분류(map_unmapped — 타깃 상시 에이전트에 주입, 팀플랜 과금), 외부 자료 수집 싱크 등이 있습니다. 주기는 초 단위 간격 또는 cron식으로 지정합니다. cron식의 시각은 '), el('div', { class: 'wikicat' }, el('div', { class: 'wikicat-group' }, head, rows)));
    detail.replaceChildren(card);
}
// 잡 추가/수정 폼(오버레이) — id·이름·액션·주기(초 또는 cron식)·켬 + 액션별 params(map_unmapped=세션 피커, refresh_repo=repo, connector_sync=system).
// actions = 액션 레지스트리(cron_list 의 actions = CRON_ACTIONS). 드롭다운·파라미터 필드를 여기서 데이터로 생성(하드코딩 X).
async function openCronForm(job, actions, reload, tz) {
    const isNew = !job;
    tz = tz || 'Asia/Seoul'; // cron식 해석 기준(조직 시간대) — 폼에서 명시해 UTC 오해를 막는다(#778).
    const jp = (job && job.params) || {};
    const inputStyle = 'width:100%;padding:6px 8px;font:inherit;box-sizing:border-box';
    const block = (title, hint, ctrl) => el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: title }), hint ? el('p', { class: 'ps-block-hint', text: hint }) : null, ctrl);
    const idInp = el('input', { type: 'text', style: inputStyle, value: job ? job.id : '', placeholder: 'my-job', ...(isNew ? {} : { disabled: true }) });
    const labelInp = el('input', { type: 'text', style: inputStyle, value: (job && job.label) || '', placeholder: '잡 이름' });
    const actionSel = el('select', { style: inputStyle });
    for (const a of (actions || []))
        actionSel.append(el('option', { value: a.key, text: a.label }));
    if (job && job.action)
        actionSel.value = job.action; // 신뢰 가능한 선택(속성 spread 대신 value 할당)
    const intervalInp = el('input', { type: 'number', style: inputStyle, value: String((job && job.interval_sec) || 1800), min: '60' });
    const cronInp = el('input', { type: 'text', style: inputStyle, value: (job && job.cron_expr) || '', placeholder: '예: 0 9 * * 1-5 (비우면 위 주기초 사용)' });
    const enabledChk = el('input', { type: 'checkbox', ...((job ? job.enabled : false) ? { checked: true } : {}) });
    const onceChk = el('input', { type: 'checkbox', ...((job && job.run_once) ? { checked: true } : {}) });
    // 액션별 파라미터 — 레지스트리의 params 스펙에서 동적 생성. kind=session → 상시 세션 피커, 그 외 → 텍스트.
    const paramsWrap = el('div');
    const paramInputs = {};
    let managedSessions = null;
    async function renderParams() {
        const a = (actions || []).find((x) => x.key === actionSel.value);
        paramsWrap.replaceChildren();
        for (const k of Object.keys(paramInputs))
            delete paramInputs[k];
        if (!a)
            return;
        for (const p of (a.params || [])) {
            let inp;
            if (p.kind === 'session') {
                inp = el('select', { style: inputStyle });
                inp.append(el('option', { value: '', text: '(상시 세션 선택)' }));
                if (managedSessions == null) {
                    try {
                        const r = await api('/api/ui/managed-sessions');
                        managedSessions = (r && r.sessions) || [];
                    }
                    catch {
                        managedSessions = [];
                    }
                }
                for (const s of (managedSessions || []))
                    inp.append(el('option', { value: s.id, text: (s.label || s.id) + ' — ' + (s.account || '계정?') + (s.enabled ? '' : ' (꺼짐)') }));
                if (jp[p.name])
                    inp.value = jp[p.name];
            }
            else if (p.kind === 'textarea') {
                // 긴 작업 프롬프트 — 멀티라인 입력(주입 시 백엔드가 개행→공백 평탄화). value 는 속성 아닌 프로퍼티로 설정.
                inp = el('textarea', { style: inputStyle + ';min-height:96px;resize:vertical', placeholder: p.hint || '', rows: '5' });
                inp.value = jp[p.name] || '';
            }
            else {
                inp = el('input', { type: 'text', style: inputStyle, value: jp[p.name] || '', placeholder: p.hint || '' });
            }
            paramInputs[p.name] = inp;
            paramsWrap.append(block(p.label, p.hint || '', inp));
        }
    }
    actionSel.onchange = renderParams;
    await renderParams();
    const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: isNew ? '잡 추가' : '저장' });
    const form = el('div', { class: 'proj-settings' }, block('잡 id', isNew ? '소문자 슬러그(a-z0-9_-). 잡의 고유 키.' : 'id 는 변경 불가.', idInp), block('이름', '관리 목록에 보일 이름.', labelInp), block('액션', '게이트웨이가 실행할 작업(등록된 액션 레지스트리). 액션마다 필요한 인자가 아래에 자동으로 뜹니다.', actionSel), paramsWrap, block('주기 (초)', '이 간격마다 실행(최소 60). cron식이 있으면 그게 우선.', intervalInp), block('cron식 (선택)', '벽시계 스케줄 — 시각은 ' + tz + ' 기준입니다. 예: 0 9 * * 1-5 = 평일 ' + tz + ' 09:00. 비우면 주기초.', cronInp), block('한 번만 실행', '체크 시 주기·cron 무시 → 1회 실행 후 자동으로 꺼짐(반복 안 함). 부트스트랩 등 일회성 잡용.', el('label', { class: 'inline' }, onceChk, el('span', { text: ' run once (1회 실행 후 비활성)' }))), block('켬', '', el('label', { class: 'inline' }, enabledChk, el('span', { text: ' 활성화' }))), el('div', { class: 'ps-rules-actions' }, saveBtn));
    const back = overlayBox(isNew ? '스케줄 잡 추가' : '스케줄 잡 수정 — ' + job.id, form);
    const boxw = back.querySelector('.ov-box');
    if (boxw)
        boxw.classList.add('ov-box-wide');
    saveBtn.onclick = async () => {
        const id = idInp.value.trim();
        if (!id) {
            toast('잡 id 가 필요합니다', true);
            return;
        }
        const p = {};
        for (const k of Object.keys(paramInputs)) {
            const v = String(paramInputs[k].value || '').trim();
            if (v)
                p[k] = v;
        }
        const body = { id, label: labelInp.value.trim() || null, action: actionSel.value, params: p,
            interval_sec: Number(intervalInp.value) || 1800, cron_expr: cronInp.value.trim(), run_once: onceChk.checked, enabled: enabledChk.checked };
        saveBtn.disabled = true;
        try {
            await api('/api/ui/cron', { method: 'POST', body: JSON.stringify(body) });
            toast(isNew ? '잡을 추가했습니다' : '저장했습니다');
            back.remove();
            reload();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            saveBtn.disabled = false;
        }
    };
}
async function cronRunNow(id, reload) {
    try {
        const r = await api('/api/ui/cron/' + encodeURIComponent(id) + '/run', { method: 'POST' });
        toast('실행: ' + ((r && r.status) || 'ok'));
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
async function cronToggle(job, reload) {
    try {
        await api('/api/ui/cron', { method: 'POST', body: JSON.stringify({ id: job.id, enabled: !job.enabled }) });
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
// autoSys 가 있으면 이 잡은 [외부 자료 수집]이 만든 것 — 지워도 커넥터를 다시 켜면 되살아나고(ON CONFLICT DO UPDATE),
//  그 사이엔 "커넥터는 켜져 있는데 싱크는 안 도는" 상태가 된다. 그러니 지우지 말고 커넥터를 끄라고 말해 준다.
async function cronDelete(id, reload, autoSys) {
    const warn = autoSys
        ? '⚠ 이 잡은 [외부 자료 수집 ▸ ' + autoSys + ']이(가) 자동으로 만든 것입니다.\n\n지워도 그 커넥터를 다시 켜면 되살아나고, '
            + '그때까지는 커넥터만 켜져 있고 싱크는 안 도는 상태가 됩니다.\n싱크를 멈추려면 이 잡이 아니라 **커넥터를 끄세요**.\n\n그래도 삭제할까요?'
        : '스케줄 잡 ‘' + id + '’을(를) 삭제할까요?';
    if (!confirm(warn))
        return;
    try {
        await api('/api/ui/cron/' + encodeURIComponent(id) + '/delete', { method: 'POST' });
        toast('삭제했습니다');
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
// 인입 허용선(게이트) · 검토 큐 패널은 web/review.ts 로 분리(#783) — 이 파일은 라우팅만.
// ── 상시 세션(에이전트) — 항상 떠있는 에이전트 세션 CRUD + 격리 워크스페이스 + keep-alive. 크론(map_unmapped 등)이 타깃. ──
//  '에이전트를 위한 프로젝트' — createSession + 공유폴더(managed/<id>) 재사용. account=라이블리 계정/프로필(클로드 로그인, 멀티프로필 대비).
async function managedSessionsPanel(detail, data) {
    const reload = () => managedSessionsPanel(detail, data);
    detail.replaceChildren(el('div', { class: 'card' }, skeleton('상시 에이전트를 불러오는 중')));
    let sessions;
    let live = [];
    try {
        const r = await api('/api/ui/managed-sessions');
        sessions = (r && r.sessions) || [];
    }
    catch (e) {
        detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '상시 에이전트를 불러오지 못했습니다')));
        return;
    }
    try {
        const t = await api('/api/ui/terminal/sessions');
        live = ((t && t.sessions) || []).map((s) => s.id);
    }
    catch { /* 세션목록 실패 무시 */ }
    const rows = el('div', { class: 'wikicat-rows' });
    if (!sessions.length)
        rows.append(el('div', { class: 'wikicat-empty', text: '아직 상시 에이전트가 없습니다. ‘+ 상시 에이전트 추가’로 등록하면 keep-alive 가 항상 실행 상태로 유지합니다.' }));
    for (const m of sessions) {
        const alive = m.session_id && live.includes(m.session_id);
        const main = el('div', { class: 'wikicat-row-main' }, el('span', { class: 'wikicat-name', text: m.label || m.id }), el('span', { class: 'wikicat-key mono', text: (m.account || '계정 미지정') + ' · ' + (m.harness || 'claude') }), el('span', { class: 'dm-tag', text: m.enabled ? (alive ? '실행중' : '대기(재생성 예정)') : '비활성' }), el('span', { class: 'wikicat-should' }, el('span', { class: 'wikicat-should-label', text: '세션' }), m.session_id || '미생성'));
        const acts = el('div', { class: 'wikicat-row-acts' }, el('button', { class: 'btn btn-ghost btn-sm', text: '시작/재생성', onclick: () => managedEnsure(m.id, reload) }), el('button', { class: 'btn btn-ghost btn-sm', text: m.enabled ? '끄기' : '켜기', onclick: () => managedToggle(m, reload) }), el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openManagedSessionForm(m, reload) }), el('button', { class: 'btn btn-ghost btn-sm btn-ghost-danger', text: '삭제', onclick: () => managedDelete(m.id, reload) }));
        rows.append(el('div', { class: 'wikicat-row' }, main, acts));
    }
    const head = el('div', { class: 'wikicat-grouphead' }, el('span', { class: 'wikicat-grouptitle', text: '상시 에이전트' }), el('span', { class: 'wikicat-groupcount', text: String(sessions.length) }), el('button', { class: 'btn btn-ghost btn-sm wikicat-add', text: '+ 상시 에이전트 추가', onclick: () => openManagedSessionForm(null, reload) }));
    const card = el('div', { class: 'card' }, cardHead('상시 실행 에이전트', '항상 실행 상태로 유지되는 에이전트 세션입니다. 격리 워크스페이스(공유폴더)에서 실행되며, keep-alive 점검에서 세션이 없으면 자동으로 다시 만듭니다. 크론 잡(미매핑 분류 등)이 이 세션에 작업을 전달합니다 — 팀플랜 과금. account 는 이 세션을 실행할 라이블리 계정(클로드 로그인)입니다.'), el('div', { class: 'wikicat' }, el('div', { class: 'wikicat-group' }, head, rows)));
    detail.replaceChildren(card);
}
function openManagedSessionForm(m, reload) {
    const isNew = !m;
    const inputStyle = 'width:100%;padding:6px 8px;font:inherit;box-sizing:border-box';
    const block = (title, hint, ctrl) => el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: title }), hint ? el('p', { class: 'ps-block-hint', text: hint }) : null, ctrl);
    const idInp = el('input', { type: 'text', style: inputStyle, value: m ? m.id : '', placeholder: 'box-map-agent', ...(isNew ? {} : { disabled: true }) });
    const labelInp = el('input', { type: 'text', style: inputStyle, value: (m && m.label) || '', placeholder: '도메인 분류 배치 LLM' });
    const account = memberCombo({ value: (m && m.account) || '', placeholder: '구성원 id 선택/검색 (예: daon)' });
    const wsInp = el('input', { type: 'text', style: inputStyle, value: (m && m.workspace_subpath) || '', placeholder: '비우면 managed/<id>' });
    const harnessSel = el('select', { style: inputStyle });
    for (const h of ['claude', 'codex', 'shell'])
        harnessSel.append(el('option', { value: h, text: h, ...((m && m.harness === h) ? { selected: true } : {}) }));
    // 모델·effort = claude 하네스 플래그(--model/--effort) → flags JSONB. 세션 스폰 시 claude argv 로 적용.
    const mflags = (m && m.flags) || {};
    const modelSel = el('select', { style: inputStyle });
    for (const v of ['', 'opus', 'sonnet', 'haiku'])
        modelSel.append(el('option', { value: v, text: v || '(기본)', ...((mflags['--model'] === v) ? { selected: true } : {}) }));
    const effortSel = el('select', { style: inputStyle });
    for (const v of ['', 'low', 'medium', 'high', 'xhigh', 'max'])
        effortSel.append(el('option', { value: v, text: v || '(기본)', ...((mflags['--effort'] === v) ? { selected: true } : {}) }));
    const autoChk = el('input', { type: 'checkbox', ...((m ? m.auto_approve : true) ? { checked: true } : {}) });
    const enabledChk = el('input', { type: 'checkbox', ...((m ? m.enabled : true) ? { checked: true } : {}) });
    const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: isNew ? '상시 세션 추가' : '저장' });
    const form = el('div', { class: 'proj-settings' }, block('세션 id', isNew ? '소문자 슬러그(a-z0-9_-). 고유 키.' : 'id 는 변경 불가.', idInp), block('이름', '관리 목록·세션 탭에 보일 이름.', labelInp), block('라이블리 계정/프로필', '이 세션을 띄울 클로드 로그인(프로필=구성원). 목록에서 고르거나 입력. 각 프로필은 provision + 웹터미널 /login 후 사용.', account.el), block('격리 워크스페이스(하위경로)', '공유폴더 아래 이 세션 전용 작업폴더. 비우면 managed/<id>.', wsInp), block('하네스', '', harnessSel), block('모델 (claude)', '이 세션의 claude 모델. 판단 무거운 작업(부트스트랩·분류)은 opus 권장. 비우면 기본.', modelSel), block('effort (claude)', '추론 강도(low~max). 무거운 판단은 high+ 권장. 비우면 기본.', effortSel), block('자동 승인', '도구 실행을 묻지 않고 진행(무인 작업에 필요).', el('label', { class: 'inline' }, autoChk, el('span', { text: ' --dangerously-skip-permissions' }))), block('항상 켬(keep-alive)', '죽으면 재생성.', el('label', { class: 'inline' }, enabledChk, el('span', { text: ' enabled' }))), el('div', { class: 'ps-rules-actions' }, saveBtn));
    const back = overlayBox(isNew ? '상시 세션 추가' : '상시 세션 수정 — ' + m.id, form);
    const boxw = back.querySelector('.ov-box');
    if (boxw)
        boxw.classList.add('ov-box-wide');
    saveBtn.onclick = async () => {
        const id = idInp.value.trim();
        if (!id) {
            toast('세션 id 가 필요합니다', true);
            return;
        }
        const flags = {};
        if (harnessSel.value === 'claude') { // model/effort 는 claude 플래그 — 다른 하네스엔 flags 미전송(기존 보존)
            if (modelSel.value)
                flags['--model'] = modelSel.value;
            if (effortSel.value)
                flags['--effort'] = effortSel.value;
        }
        const body = { id, label: labelInp.value.trim() || null, account: account.value() || null,
            workspace_subpath: wsInp.value.trim() || null, harness: harnessSel.value,
            auto_approve: autoChk.checked, enabled: enabledChk.checked,
            ...(harnessSel.value === 'claude' ? { flags } : {}) };
        saveBtn.disabled = true;
        try {
            await api('/api/ui/managed-sessions', { method: 'POST', body: JSON.stringify(body) });
            toast(isNew ? '추가했습니다 (켜져 있으면 곧 keep-alive 가 띄웁니다)' : '저장했습니다');
            back.remove();
            reload();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            saveBtn.disabled = false;
        }
    };
}
async function managedEnsure(id, reload) {
    try {
        const r = await api('/api/ui/managed-sessions/' + encodeURIComponent(id) + '/ensure', { method: 'POST' });
        toast('세션: ' + ((r && r.action) || 'ok') + (r && r.session_id ? ' (' + r.session_id + ')' : ''));
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
async function managedToggle(m, reload) {
    try {
        await api('/api/ui/managed-sessions', { method: 'POST', body: JSON.stringify({ id: m.id, enabled: !m.enabled }) });
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
async function managedDelete(id, reload) {
    if (!confirm('상시 세션 등록 ‘' + id + '’을(를) 삭제할까요? (살아있는 터미널 세션은 별도로 종료)'))
        return;
    try {
        await api('/api/ui/managed-sessions/' + encodeURIComponent(id) + '/delete', { method: 'POST' });
        toast('삭제했습니다');
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
// ── 미리보기 — 작업 중인 화면을 운영 화면·남의 작업과 분리해 따로 띄워 본다. ──
//  사람이 고르는 건 '무엇을 미리볼지'(프로젝트·레포)뿐이고, 작업 폴더 준비·빌드는 서버가 알아서 한다(비동기).
//  대개는 AI 가 작업 중 자동으로 만들어 쓰고, 이 화면은 그것을 **보고·열고·끄는** 창구다.
const PREVIEW_STATUS_TEXT = { running: '실행 중', preparing: '준비 중…', error: '문제 있음', stopped: '꺼짐' };
let previewPollTimer = null;
async function previewEnvsPanel(detail, data) {
    const reload = () => previewEnvsPanel(detail, data);
    if (previewPollTimer) {
        clearTimeout(previewPollTimer);
        previewPollTimer = null;
    }
    detail.replaceChildren(el('div', { class: 'card' }, skeleton('미리보기를 불러오는 중')));
    let envs;
    try {
        const r = await api('/api/ui/preview-envs');
        envs = (r && r.envs) || [];
    }
    catch (e) {
        detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '미리보기 목록을 불러오지 못했습니다')));
        return;
    }
    const rows = el('div', { class: 'wikicat-rows' });
    if (!envs.length) {
        rows.append(el('div', { class: 'wikicat-empty', text: '아직 만든 미리보기가 없습니다. 보통은 AI 가 화면을 확인해야 할 때 자동으로 만들어 쓰고, 직접 만들려면 오른쪽 위 ‘+ 미리보기 만들기’를 누르세요.' }));
    }
    for (const p of envs) {
        const statusText = PREVIEW_STATUS_TEXT[p.status] || (p.status || '알 수 없음');
        const where = [
            p.project_name || (p.project_id ? '프로젝트 #' + p.project_id : null),
            p.repo,
            p.kind === 'stage' ? '여러 작업을 합쳐서 봄' : null,
        ].filter(Boolean).join(' · ');
        const mainKids = [
            el('span', { class: 'wikicat-name', text: p.label || p.id }),
            where ? el('span', { class: 'wikicat-key', text: where }) : null,
            el('span', { class: 'dm-tag', text: p.enabled ? statusText : '꺼둠' }),
            p.last_error ? el('span', { class: 'wikicat-should' }, el('span', { class: 'wikicat-should-label', text: '안내' }), p.last_error) : null,
        ].filter(Boolean);
        const acts = [
            (p.status === 'running') ? el('a', { class: 'btn btn-primary btn-sm', href: '/preview/' + encodeURIComponent(p.id) + '/', target: '_blank', text: '화면 열기 ↗' }) : null,
            (p.status !== 'preparing') ? el('button', { class: 'btn btn-ghost btn-sm', text: p.status === 'running' ? '새로 만들기' : '띄우기', onclick: () => previewEnsure(p.id, reload) }) : null,
            (p.status === 'running' || p.status === 'preparing') ? el('button', { class: 'btn btn-ghost btn-sm', text: '끄기', onclick: () => previewStop(p.id, reload) }) : null,
            el('button', { class: 'btn btn-ghost btn-sm', text: '설정', onclick: () => openPreviewEnvForm(p, reload) }),
            el('button', { class: 'btn btn-ghost btn-sm btn-ghost-danger', text: '삭제', onclick: () => previewDelete(p.id, reload) }),
        ].filter(Boolean);
        rows.append(el('div', { class: 'wikicat-row' }, el('div', { class: 'wikicat-row-main' }, ...mainKids), el('div', { class: 'wikicat-row-acts' }, ...acts)));
    }
    const head = el('div', { class: 'wikicat-grouphead' }, el('span', { class: 'wikicat-grouptitle', text: '미리보기' }), el('span', { class: 'wikicat-groupcount', text: String(envs.length) }), el('button', { class: 'btn btn-ghost btn-sm wikicat-add', text: '+ 미리보기 만들기', onclick: () => openPreviewEnvForm(null, reload) }));
    const card = el('div', { class: 'card' }, cardHead('만들어 둔 미리보기'), el('div', { class: 'wikicat' }, el('div', { class: 'wikicat-group' }, head, rows)));
    // 제목·설명은 card 밖 상단으로 — 관리탭 다른 섹션과 같은 자리(#1010).
    detail.replaceChildren(sectionHead('미리보기', '작업 중인 화면을 운영 화면과 따로 띄워 봅니다. 만들어진 주소를 팀원에게 보내 확인받을 수 있습니다.'), card);
    // 준비 중인 게 있으면 잠시 뒤 자동으로 다시 확인한다(사람이 새로고침하지 않아도 되게).
    if (envs.some((x) => x.status === 'preparing')) {
        previewPollTimer = setTimeout(() => { if (document.body.contains(detail))
            reload(); }, 5000);
    }
}
async function openPreviewEnvForm(p, reload) {
    const isNew = !p;
    const inputStyle = 'width:100%;padding:6px 8px;font:inherit;box-sizing:border-box';
    const block = (title, hint, ctrl) => el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: title }), hint ? el('p', { class: 'ps-block-hint', text: hint }) : null, ctrl);
    // 고를 것들을 미리 읽어 둔다 — 사용자가 아이디·경로를 '타이핑'하지 않아도 되게.
    let projects = [], repos = [], profiles = [];
    try {
        const r = await api('/api/ui/v6/projects');
        projects = (r && r.projects) || [];
    }
    catch { /* 목록 못 읽어도 폼은 뜬다 */ }
    try {
        const r = await api('/api/ui/repos');
        repos = (r && r.domainmapRepos) || [];
    }
    catch { /* 위와 동일 */ }
    try {
        const r = await api('/api/ui/stack-profiles');
        profiles = (r && r.profiles) || [];
    }
    catch { /* 고급에서만 쓴다 */ }
    // ── 기본: 무엇을 미리볼까 (이 셋만 채우면 된다) ──
    const projListId = 'prevproj-' + Math.random().toString(36).slice(2, 8);
    const projList = el('datalist', { id: projListId });
    const projLabel = (x) => x.name + ' #' + x.id;
    for (const x of projects.slice(0, 500))
        projList.append(el('option', { value: projLabel(x) }));
    const projInp = el('input', { type: 'text', style: inputStyle, list: projListId, placeholder: '프로젝트 이름으로 검색' });
    if (p && p.project_id) {
        const f = projects.find((x) => x.id === p.project_id);
        projInp.value = f ? projLabel(f) : ('#' + p.project_id);
    }
    const pickProjectId = () => {
        const v = String(projInp.value || '').trim();
        const m = v.match(/#(\d+)\s*$/);
        if (m)
            return Number(m[1]);
        const byName = projects.find((x) => x.name === v);
        return byName ? byName.id : null;
    };
    const repoSel = el('select', { style: inputStyle });
    repoSel.append(el('option', { value: '', text: '— 고르세요 —' }));
    const repoNames = repos.map((r) => r.name).filter(Boolean);
    if (p && p.repo && !repoNames.includes(p.repo))
        repoNames.unshift(p.repo);
    for (const n of repoNames)
        repoSel.append(el('option', { value: n, text: n, ...((p && p.repo === n) ? { selected: true } : {}) }));
    const labelInp = el('input', { type: 'text', style: inputStyle, value: (p && p.label) || '', placeholder: '비우면 자동으로 지어집니다' });
    // ── 고급(보통 그대로 두면 된다) ──
    const kindSel = el('select', { style: inputStyle });
    for (const k of [['work', '내 작업 하나만 본다 (기본)'], ['stage', '여러 작업을 합쳐서 본다']])
        kindSel.append(el('option', { value: k[0], text: k[1], ...((p ? p.kind === k[0] : k[0] === 'work') ? { selected: true } : {}) }));
    const backingSel = el('select', { style: inputStyle });
    for (const b of [['shared-proxy', '화면만 따로 띄운다 (기본·가장 가벼움)'], ['throwaway', '전용 서버까지 새로 띄운다'], ['existing-ref', '이미 떠 있는 주소로 연결한다']])
        backingSel.append(el('option', { value: b[0], text: b[1], ...((p ? p.backing_mode === b[0] : b[0] === 'shared-proxy') ? { selected: true } : {}) }));
    const stackSel = el('select', { style: inputStyle });
    stackSel.append(el('option', { value: '', text: '자동 — 이 레포에 맞는 설정을 씁니다' }));
    for (const sp of profiles)
        stackSel.append(el('option', { value: sp.id, text: sp.label || sp.id, ...((p && p.stack_profile === sp.id) ? { selected: true } : {}) }));
    const backingRefInp = el('input', { type: 'text', style: inputStyle, value: (p && p.backing_ref) || '', placeholder: 'http://localhost:8081' });
    const owner = memberCombo({ value: (p && p.owner_member) || '', placeholder: '구성원 선택 (선택 사항)' });
    const wtInp = el('input', { type: 'text', style: inputStyle, value: (p && p.worktree_path) || '', placeholder: '비워 두면 자동으로 만듭니다' });
    const ttlInp = el('input', { type: 'number', style: inputStyle, value: (p && p.ttl_idle_sec) || '', placeholder: '0 = 계속 켜둠' });
    // 합쳐서 볼 작업(브랜치) — 외워서 타이핑하지 않고 **고른다**. 레포를 고르면 그 레포의 브랜치를 최근 순으로 읽어 온다.
    const picked = new Set((p && Array.isArray(p.member_branches)) ? p.member_branches : []);
    let branchOpts = [], branchState = 'idle', branchRepo = '';
    const branchFilter = el('input', { type: 'search', style: inputStyle + ';margin-bottom:6px', placeholder: '브랜치 검색' });
    const branchList = el('div', { style: 'max-height:210px;overflow:auto;border:1px solid rgba(127,127,127,.22);border-radius:6px;padding:4px' });
    const baseRefSel = el('select', { style: inputStyle });
    const hintRow = (t) => el('div', { class: 'ps-block-hint', style: 'padding:6px 4px', text: t });
    function renderBranchList() {
        const q = branchFilter.value.trim().toLowerCase();
        if (!branchRepo) {
            branchList.replaceChildren(hintRow('먼저 위에서 코드 저장소를 골라 주세요.'));
            return;
        }
        if (branchState === 'loading') {
            branchList.replaceChildren(hintRow('브랜치를 불러오는 중…'));
            return;
        }
        if (branchState === 'error') {
            branchList.replaceChildren(hintRow('브랜치를 불러오지 못했습니다 — 저장소 연결을 확인해 주세요.'));
            return;
        }
        const names = branchOpts.map((b) => b.name);
        const extra = [...picked].filter((n) => !names.includes(n)).map((n) => ({ name: n, missing: true })); // 저장돼 있지만 지금 목록에 없는 것
        const rows = [...extra, ...branchOpts].filter((b) => !q || b.name.toLowerCase().includes(q));
        if (!rows.length) {
            branchList.replaceChildren(hintRow(q ? '검색 결과가 없습니다.' : '이 저장소에 브랜치가 없습니다.'));
            return;
        }
        branchList.replaceChildren(...rows.slice(0, 300).map((b) => {
            const cb = el('input', { type: 'checkbox', ...(picked.has(b.name) ? { checked: true } : {}) });
            cb.onchange = () => { if (cb.checked)
                picked.add(b.name);
            else
                picked.delete(b.name); };
            const meta = [b.missing ? '지금 목록에 없음' : null, b.updated_at ? relTime(b.updated_at) : null, b.author].filter(Boolean).join(' · ');
            return el('label', { class: 'inline', style: 'display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:4px;cursor:pointer' }, cb, el('span', { style: 'flex:1;min-width:0' }, el('span', { class: 'mono', style: 'font-size:12px', text: b.name }), meta ? el('span', { class: 'ps-block-hint', style: 'margin:0 0 0 8px;display:inline', text: meta }) : null));
        }));
    }
    function renderBaseRef() {
        const cur = baseRefSel.value || (p && p.base_ref) || '';
        baseRefSel.replaceChildren(el('option', { value: '', text: '기본 — origin/main' }));
        const seen = new Set(['']);
        for (const b of branchOpts) {
            const v = 'origin/' + b.name;
            if (seen.has(v))
                continue;
            seen.add(v);
            baseRefSel.append(el('option', { value: v, text: v }));
        }
        if (cur && !seen.has(cur))
            baseRefSel.append(el('option', { value: cur, text: cur })); // 저장된 값이 목록에 없어도 유지
        baseRefSel.value = cur;
    }
    async function loadBranches() {
        const repo = repoSel.value.trim();
        if (!repo || repo === branchRepo) {
            renderBranchList();
            return;
        }
        branchRepo = repo;
        branchState = 'loading';
        branchOpts = [];
        renderBranchList();
        try {
            const r = await api('/api/ui/repos/' + encodeURIComponent(repo) + '/branches');
            branchOpts = (r && r.branches) || [];
            branchState = 'ok';
        }
        catch (_) {
            branchState = 'error';
        }
        renderBranchList();
        renderBaseRef();
    }
    branchFilter.addEventListener('input', renderBranchList);
    // 브랜치는 '여러 작업을 합쳐서 본다'일 때만 필요하다 — 그때(또는 저장소를 바꿀 때)만 읽는다.
    repoSel.addEventListener('change', () => { if (kindSel.value === 'stage')
        void loadBranches(); });
    kindSel.addEventListener('change', () => { if (kindSel.value === 'stage')
        void loadBranches(); });
    renderBranchList();
    renderBaseRef();
    if (p && p.kind === 'stage' && repoSel.value)
        void loadBranches();
    const triggerSel = el('select', { style: inputStyle });
    for (const t of [['manual', '내가 누를 때만 다시 합친다 (기본)'], ['auto', '작업이 바뀌면 자동으로 다시 합친다']])
        triggerSel.append(el('option', { value: t[0], text: t[1], ...((p && p.merge_trigger === t[0]) ? { selected: true } : {}) }));
    const enabledChk = el('input', { type: 'checkbox', ...((p ? p.enabled : true) ? { checked: true } : {}) });
    const noteInp = el('input', { type: 'text', style: inputStyle, value: (p && p.note) || '' });
    const advanced = el('details', { class: 'ps-block' }, el('summary', { style: 'cursor:pointer;font-weight:600;padding:6px 0', text: '고급 설정 — 보통은 그대로 두면 됩니다' }), block('보는 방식', '여러 사람의 작업을 한 화면에서 함께 보려면 바꾸세요.', kindSel), block('어떻게 띄울까', '기본은 화면만 따로 띄웁니다. 서버 동작까지 확인해야 하면 전용 서버를, 이미 띄워 둔 게 있으면 그 주소를 쓰세요.', backingSel), block('실행 설정', '‘전용 서버까지 새로 띄운다’일 때 어떤 방식으로 띄울지. 비우면 이 레포에 맞는 설정을 자동으로 씁니다.', stackSel), block('연결할 주소', '‘이미 떠 있는 주소로 연결한다’일 때만 씁니다.', backingRefInp), block('합쳐서 볼 작업들', '이 저장소의 작업(브랜치) 중 함께 볼 것을 고르세요. 서로 충돌하는 작업은 자동으로 빼고 나머지를 합칩니다.', el('div', {}, branchFilter, branchList)), block('합치는 기준', '이 기준 위에 위에서 고른 작업들을 얹습니다.', baseRefSel), block('다시 합치는 시점', '', triggerSel), block('담당자', '이 미리보기의 주인(참고용).', owner.el), block('작업 폴더 경로', '직접 지정할 때만 씁니다. 비우면 프로젝트에 맞춰 자동으로 만듭니다.', wtInp), block('안 보면 자동으로 끄기 (초)', '이 시간 동안 아무도 열지 않으면 자동으로 끕니다. 0이면 계속 켜둡니다.', ttlInp), block('사용', '', el('label', { class: 'inline' }, enabledChk, el('span', { text: ' 이 미리보기를 사용합니다' }))), block('메모', '', noteInp), ...(p ? [block('주소', '팀원에게 이 주소를 보내면 됩니다.', el('div', { class: 'mono', text: '/preview/' + p.id + '/' }))] : []));
    const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: isNew ? '만들고 띄우기' : '저장' });
    const form = el('div', { class: 'proj-settings' }, block('어떤 작업을 미리볼까요?', '작업 중인 프로젝트를 고르세요. 필요한 작업 폴더가 없으면 자동으로 만들어 줍니다.', projInp), projList, block('어느 코드 저장소인가요?', '', repoSel), block('이름 (선택)', '목록에서 알아보기 쉬운 이름. 비우면 자동으로 지어집니다.', labelInp), advanced, el('div', { class: 'ps-rules-actions' }, saveBtn));
    const back = overlayBox(isNew ? '미리보기 만들기' : '미리보기 설정', form);
    const boxw = back.querySelector('.ov-box');
    if (boxw)
        boxw.classList.add('ov-box-wide');
    saveBtn.onclick = async () => {
        const kind = kindSel.value, backing_mode = backingSel.value;
        const repo = repoSel.value.trim();
        const project_id = pickProjectId();
        const branches = kind === 'stage' ? [...picked] : [];
        if (!repo) {
            toast('어느 코드 저장소를 볼지 골라 주세요', true);
            return;
        }
        if (kind === 'work' && !project_id && !wtInp.value.trim()) {
            toast('어떤 작업을 미리볼지(프로젝트) 골라 주세요', true);
            return;
        }
        if (kind === 'stage' && !branches.length) {
            toast('합쳐서 볼 작업을 한 개 이상 골라 주세요 (고급 설정)', true);
            return;
        }
        if (kind === 'work' && backing_mode === 'existing-ref' && !backingRefInp.value.trim()) {
            toast('연결할 주소를 입력해 주세요 (고급 설정)', true);
            return;
        }
        const body = {
            ...(p ? { id: p.id } : {}), kind, backing_mode, repo, project_id,
            label: labelInp.value.trim() || null, owner_member: owner.value() || null,
            worktree_path: wtInp.value.trim() || null, ttl_idle_sec: ttlInp.value ? Number(ttlInp.value) : null,
            enabled: enabledChk.checked, note: noteInp.value.trim() || null,
            stack_profile: stackSel.value || null, backing_ref: backingRefInp.value.trim() || null,
            ...(kind === 'stage' ? { member_branches: branches, base_ref: baseRefSel.value.trim() || null, merge_trigger: triggerSel.value } : {}),
        };
        saveBtn.disabled = true;
        try {
            const saved = await api('/api/ui/preview-envs', { method: 'POST', body: JSON.stringify(body) });
            const id = (saved && saved.env && saved.env.id) || (p && p.id);
            if (isNew && id) {
                // 만들자마자 준비를 시작한다 — 사람이 '띄우기'를 한 번 더 누르지 않아도 되게.
                await api('/api/ui/preview-envs/' + encodeURIComponent(id) + '/ensure', { method: 'POST' }).catch(() => { });
                toast('만들었습니다 — 화면을 준비하고 있습니다');
            }
            else
                toast('저장했습니다');
            back.remove();
            reload();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            saveBtn.disabled = false;
        }
    };
}
async function previewEnsure(id, reload) {
    try {
        const r = await api('/api/ui/preview-envs/' + encodeURIComponent(id) + '/ensure', { method: 'POST' });
        const s = r && r.status;
        if (s === 'running')
            toast('준비됐습니다 — ‘화면 열기’로 확인하세요');
        else if (s === 'preparing')
            toast('준비를 시작했습니다 — 끝나면 목록에 자동으로 표시됩니다');
        else
            toast((r && r.error) || '띄우지 못했습니다', true);
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
async function previewStop(id, reload) {
    try {
        await api('/api/ui/preview-envs/' + encodeURIComponent(id) + '/stop', { method: 'POST' });
        toast('껐습니다');
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
async function previewDelete(id, reload) {
    if (!confirm('이 미리보기를 삭제할까요?\n작업 폴더와 코드는 그대로 남습니다.'))
        return;
    try {
        await api('/api/ui/preview-envs/' + encodeURIComponent(id) + '/delete', { method: 'POST' });
        toast('삭제했습니다');
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
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
    try {
        const r = await api('/api/ui/repos');
        repos = (r && r.domainmapRepos) || [];
    }
    catch (e) {
        detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '레포를 불러오지 못했습니다')));
        return;
    }
    const rows = el('div', { class: 'wikicat-rows' });
    if (!repos.length) {
        rows.append(el('div', { class: 'wikicat-empty', text: '아직 등록된 레포가 없습니다.' }));
    }
    else {
        for (const r of repos) {
            const deprecated = (r.state || 'active') === 'deprecated';
            const t = r.totals || {};
            const meta = r.clone_url
                ? el('span', { class: 'wikicat-should', title: r.clone_url }, el('span', { class: 'wikicat-should-label', text: 'git' }), r.clone_url + ' · ' + (r.default_branch || 'main'))
                : el('span', { class: 'wikicat-should wikicat-should-empty' }, el('span', { class: 'wikicat-should-label', text: 'git' }), canEdit ? 'git 미연결 — 수정에서 연결하세요' : 'git 미연결');
            const main = el('div', { class: 'wikicat-row-main' }, el('span', { class: 'wikicat-name', text: r.name }), el('span', { class: 'wikicat-key mono', text: 'code_unit ' + (t.code_units || 0) + ' · 도메인 ' + (t.domains || 0) }), deprecated ? el('span', { class: 'dm-tag', text: '폐기됨' }) : null, meta);
            const acts = canEdit ? el('div', { class: 'wikicat-row-acts' }, el('button', { class: 'btn btn-ghost btn-sm', text: '⟳ 최신화', title: '이 레포의 공유 클론을 upstream 기준으로 최신화합니다(fetch + fast-forward). 게이트웨이 계정이 가져오므로 모든 구성원이 최신 코드를 읽을 수 있습니다.', onclick: (e) => repoRefreshShared(r.name, e) }), el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openRepoForm(r, reload) }), el('button', { class: 'btn btn-ghost btn-sm', text: deprecated ? '복귀' : '폐기', onclick: () => repoSetDeprecated(r.name, deprecated, reload) }), el('button', { class: 'btn btn-ghost btn-sm repo-del-btn', text: '삭제', onclick: () => repoHardDelete(r.name, reload) })) : null;
            rows.append(el('div', { class: 'wikicat-row' }, main, acts));
        }
    }
    // fix#92: 카드 제목 바로 아래에서 '레포/git/숫자'를 반복하던 그룹 헤더 제거 — 카운트는 제목에, 추가 버튼은 카드 헤더로.
    // null 을 replaceChildren 에 직접 넘기면 DOM 이 "null" 텍스트로 렌더한다 → filter(Boolean) 로 차단(#req).
    detail.replaceChildren(...[
        sectionHead('레포(git) · ' + repos.length + '개', '우리 코드 레포를 등록합니다. 여기 등록한 레포로 도메인맵을 만들고, 프로젝트에서 코드 작업을 할 때 내려받습니다.'),
        canEdit ? null : el('p', { class: 'admin-sub', style: 'margin:-4px 0 12px' }, el('span', { class: 'pill', text: '읽기 전용' }), ' 편집은 context 권한 필요'),
        (canEdit || state.admin.canEdit) ? el('div', { class: 'admin-actions', style: 'margin:0 0 14px' }, canEdit ? el('button', { class: 'btn btn-ghost btn-sm', text: '+ 레포 추가', onclick: () => openRepoForm(null, reload) }) : null, state.admin.canEdit ? el('button', { class: 'btn btn-ghost btn-sm', text: '게이트웨이 git 계정 관리', onclick: () => openGitCredentialManager('gateway') }) : null) : null,
        el('div', { class: 'wikicat' }, el('div', { class: 'wikicat-group' }, rows)),
    ].filter(Boolean));
}
// 레포 공유 클론 최신화(#660 RO) — 선택한 레포의 공유 베이스(workspace/repos/<name>)를 upstream 으로 fast-forward.
//  게이트웨이(클론 소유자)가 서버에서 fetch+ff 하므로 멤버는 group-write 없이도 최신 코드를 읽게 된다(공유 실행코드 변조 불가 → 격리 유지).
//  비파괴: dirty/갈라짐이면 건드리지 않고 사유를 알린다. scope=context(레포 편집 권한과 동일).
async function repoRefreshShared(name, ev) {
    const btn = ev && ev.currentTarget;
    const prev = btn ? btn.textContent : '';
    if (btn) {
        btn.disabled = true;
        btn.textContent = '최신화 중…';
    }
    try {
        const r = await api('/api/ui/repos/' + encodeURIComponent(name) + '/refresh', { method: 'POST' });
        const s7 = (x) => (x ? String(x).slice(0, 7) : '');
        if (r && r.status === 'ok')
            alert('최신화 완료: ' + name + '\n' + s7(r.before) + ' → ' + s7(r.after));
        else if (r && r.status === 'up-to-date')
            alert('이미 최신입니다: ' + name);
        else if (r && r.status === 'dirty')
            alert('로컬 변경이 있어 건너뛰었습니다: ' + name + '\n' + (r.detail || ''));
        else if (r && r.status === 'no-clone')
            alert('공유 클론이 아직 없습니다(이 레포를 쓰는 프로젝트에서 먼저 provision): ' + name);
        else if (r && r.status === 'no-upstream')
            alert('현재 브랜치에 upstream 이 없습니다: ' + name);
        else
            alert('최신화 결과(' + (r && r.status) + '): ' + ((r && r.detail) || ''));
    }
    catch (e) {
        alert('최신화 실패: ' + (e && e.message ? e.message : e));
    }
    finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = prev;
        }
    }
}
// 레포 추가/수정 폼(오버레이) — 이름(신규=생성 / 변경=이름변경) + git_url + default_branch.
//  #825: 3필드를 손으로 치는 대신 [목록에서 선택](저장된 토큰으로 호스트의 레포 조회 → 3필드 프리필) +
//  [연결 확인](저장 전 ls-remote 로 접근·기본브랜치 확인). 둘 다 '제안' 이고, 텍스트 입력은 그대로 살아 있다
//  (토큰 없는 호스트·SSH 전송·미지원 provider 에서도 기존처럼 등록 가능해야 하므로).
function openRepoForm(repo, reload) {
    const isNew = !repo;
    const inputStyle = 'width:100%;padding:6px 8px;font:inherit;box-sizing:border-box';
    const nameInp = el('input', { type: 'text', style: inputStyle, value: repo ? repo.name : '', placeholder: 'context-ontology' });
    const urlInp = el('input', { type: 'text', style: inputStyle, value: (repo && repo.clone_url) || '', placeholder: 'https://github.com/org/repo.git' });
    const branchInp = el('input', { type: 'text', style: inputStyle, value: (repo && repo.default_branch) || 'main', placeholder: 'main' });
    const block = (title, hint, ctrl) => el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: title }), hint ? el('p', { class: 'ps-block-hint', text: hint }) : null, ctrl);
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
        if (!url) {
            toast('git 주소를 먼저 입력하세요', true);
            return;
        }
        checkBtn.disabled = true;
        checkNote.replaceChildren(el('span', { class: 'admin-hint', text: '확인 중…' }));
        try {
            const r = await api('/api/ui/repos/check', { method: 'POST', body: JSON.stringify({ git_url: url }) });
            if (r.ok) {
                const drift = r.default_branch && branchInp.value.trim() && r.default_branch !== branchInp.value.trim();
                checkNote.replaceChildren(el('span', { style: 'color:var(--ok,#16a34a)',
                    text: `✓ 접근 OK — ${r.host} · 브랜치 ${r.branches}개 · 원격 기본 브랜치 ${r.default_branch || '알 수 없음'}` }));
                // 원격의 실제 기본 브랜치가 입력값과 다르면 조용히 넘기지 않는다 — 스캔이 엉뚱한 브랜치를 읽는 사고의 원인.
                if (drift) {
                    const useBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: `‘${r.default_branch}’ 로 맞추기`,
                        onclick: () => { branchInp.value = r.default_branch; checkNote.replaceChildren(el('span', { style: 'color:var(--ok,#16a34a)', text: `✓ 기본 브랜치를 ${r.default_branch} 로 설정했습니다` })); } });
                    checkNote.append(el('span', { text: ` — 입력한 ‘${branchInp.value.trim()}’ 와 다릅니다. ` }), useBtn);
                }
            }
            else {
                checkNote.replaceChildren(el('span', { style: 'color:var(--danger,#dc2626)', text: '✗ ' + (r.detail || '접근 실패') }));
            }
        }
        catch (e) {
            checkNote.replaceChildren(el('span', { style: 'color:var(--danger,#dc2626)', text: '✗ 확인 실패 — ' + e.message }));
        }
        checkBtn.disabled = false;
    };
    const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: isNew ? '레포 추가' : '저장' });
    const form = el('div', { class: 'proj-settings' }, isNew ? el('div', { class: 'conn-pick-row', style: 'margin-bottom:10px' }, el('span', { class: 'admin-hint', style: 'margin:0; flex:1',
        text: '등록된 git 자격으로 레포 목록을 불러와 고를 수 있어요 — 이름·주소·기본 브랜치가 함께 채워집니다.' }), pickBtn) : null, block('레포 이름', isNew ? '실제 git 레포 이름 — code_unit 이 이 이름으로 매핑됩니다. (경로 컴포넌트라 슬래시 불가 — GitLab 서브그룹은 마지막 조각만 들어갑니다)' : '이름을 바꿔도 매핑·도메인은 보존됩니다.', nameInp), block('git 주소 (clone URL)', '도메인맵 스캔과 로컬 작업 클론이 이 주소를 씁니다. 비우면 git 미연결. HTTPS 가 막힌 셀프호스팅(GitLab 등)은 SSH 형(git@호스트:그룹/레포.git)으로 넣으세요.', el('div', {}, el('div', { class: 'conn-pick-row' }, urlInp, checkBtn), checkNote)), block('기본 브랜치', '비우면 main. [연결 확인]으로 원격의 실제 기본 브랜치를 확인할 수 있어요.', branchInp), el('div', { class: 'ps-rules-actions' }, saveBtn));
    const back = overlayBox(isNew ? '레포 추가' : '레포 수정 — ' + repo.name, form);
    const boxw = back.querySelector('.ov-box');
    if (boxw)
        boxw.classList.add('ov-box-wide');
    saveBtn.onclick = async () => {
        const nm = nameInp.value.trim();
        if (!nm) {
            toast('레포 이름이 필요합니다', true);
            return;
        }
        saveBtn.disabled = true;
        try {
            if (isNew)
                await api('/api/ui/domainmap/repo/create', { method: 'POST', body: JSON.stringify({ name: nm }) });
            else if (nm !== repo.name)
                await api('/api/ui/domainmap/repo/rename', { method: 'POST', body: JSON.stringify({ name: repo.name, newName: nm }) });
            await api('/api/ui/domainmap/repo/source', { method: 'POST', body: JSON.stringify({ name: nm, git_url: urlInp.value.trim() || null, default_branch: branchInp.value.trim() || 'main' }) });
            toast(isNew ? '레포를 추가했습니다' : '저장했습니다');
            back.remove();
            reload();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            saveBtn.disabled = false;
        }
    };
}
// 레포 픽커(#825) — 저장된 토큰으로 조회한 레포 목록에서 고른다. 커넥터 스코프 픽커(#586)의 git 판.
//  목록이 비어도(SSH 뿐인 호스트·토큰 없음) 실패가 아니다 — 사유(note)를 보여주고 텍스트 입력으로 돌려보낸다.
async function openRepoPicker(onPick) {
    const box = el('div', {}, el('p', { class: 'admin-hint', text: '등록된 git 자격으로 레포 목록을 조회하는 중…' }));
    const back = overlay('레포 — 목록에서 선택', box);
    try {
        const r = await api('/api/ui/repos/discover', { method: 'POST', body: JSON.stringify({}) });
        const opts = r.options || [];
        const noteEl = r.note ? el('p', { class: 'admin-hint', style: 'white-space:pre-line', text: r.note }) : null;
        if (!opts.length) {
            box.replaceChildren(noteEl || el('p', { class: 'admin-hint', text: '고를 레포가 없습니다 — git 주소를 직접 입력하세요.' }));
            return;
        }
        // 이미 등록된 레포는 회색 처리 — 중복 등록(409)을 누르기 전에 보이게.
        let existing = new Set();
        try {
            const rr = await api('/api/ui/repos');
            existing = new Set(((rr && rr.domainmapRepos) || []).map((x) => x.name));
        }
        catch (_) { /* 목록 못 읽어도 픽커는 동작 */ }
        const search = el('input', { type: 'text', style: 'width:100%;padding:6px 8px;font:inherit;box-sizing:border-box', placeholder: '레포 이름·경로로 검색' });
        const list = el('div', { class: 'conn-pick-list' });
        const render = () => {
            const q = search.value.trim().toLowerCase();
            const hit = opts.filter((o) => !q || (o.full_path + ' ' + o.name).toLowerCase().includes(q));
            list.replaceChildren(...(hit.length ? hit.map((o) => {
                const dup = existing.has(o.name);
                return el('label', { class: 'conn-pick-item', onclick: () => { onPick(o); back.remove(); toast(`‘${o.full_path}’ 를 채웠습니다 — [레포 추가]를 눌러야 등록됩니다`); } }, el('span', { text: o.private ? '🔒' : '🌐' }), el('span', { class: 'conn-pick-label', text: o.full_path }), el('span', { class: 'mini-meta mono', text: (o.default_branch || '?') + (dup ? ' · 이미 등록됨' : '') }));
            }) : [el('p', { class: 'admin-hint', text: '검색 결과가 없습니다.' })]));
        };
        search.oninput = render;
        render();
        box.replaceChildren(noteEl, search, list, el('p', { class: 'admin-hint', text: '고르면 이름·git 주소·기본 브랜치가 폼에 채워집니다(그대로 편집할 수 있어요). 목록에 없어도 주소를 직접 입력해 등록할 수 있습니다.' }));
    }
    catch (e) {
        box.replaceChildren(el('p', { class: 'admin-hint', text: '조회 실패: ' + e.message + ' — git 주소를 직접 입력하세요.' }));
    }
}
async function repoSetDeprecated(name, isDeprecated, reload) {
    try {
        await api('/api/ui/domainmap/repo/deprecate', { method: 'POST', body: JSON.stringify({ name, undo: isDeprecated }) });
        toast(isDeprecated ? '복귀했습니다' : '폐기했습니다');
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
async function repoHardDelete(name, reload) {
    if (!confirm('레포 ‘' + name + '’을(를) 영구삭제할까요?\n\n코드유닛·매핑·도메인 등 하위가 함께 삭제됩니다(되돌릴 수 없음).'))
        return;
    try {
        const r = await api('/api/ui/domainmap/repo/delete', { method: 'POST', body: JSON.stringify({ name }) });
        if (r && r.blocked) {
            const c = r.refs || {};
            if (!confirm('하위가 있습니다 (code ' + (c.code_units || 0) + ' · entities ' + (c.data_entities || 0) + '). 그래도 모두 cascade 삭제할까요?'))
                return;
            await api('/api/ui/domainmap/repo/delete', { method: 'POST', body: JSON.stringify({ name, force: true }) });
        }
        toast('삭제했습니다');
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
// ── WIKI 카테고리 관리 — 지식(위키)의 분류축(사업·제품·시스템 카테고리) CRUD. 제품 카테고리=도메인. ──
//  카테고리 탭(#/categories)과 동일한 category-store(/api/ui/categories) — 여기 변경이 지식·프로젝트 탭 좌측에 반영.
//  space 탭으로 나누지 않고 한 화면에 전부(컴팩트 표 — fields-table 재사용). 편집은 context 스코프(없으면 읽기 전용).
async function wikiCategoriesPanel(detail, data) {
    const canEdit = state.admin.canContext;
    const reload = () => wikiCategoriesPanel(detail, data);
    detail.replaceChildren(el('div', { class: 'card' }, skeleton('카테고리를 불러오는 중')));
    // 전 space 카테고리를 한 번에 — space 별로 묶어 컴팩트 표로(탭 분리 없음). 팀 목록도 함께(오너 드롭다운 옵션).
    let bySpace;
    let teams = [];
    try {
        const [lists, teamList] = await Promise.all([
            Promise.all(SPACE_SUBS.map((s) => api('/api/ui/categories?' + new URLSearchParams({ space: s.key })).then((d) => (d && d.categories) || []))),
            api('/api/ui/teams').then((d) => (d && d.teams) || []).catch(() => []),
        ]);
        bySpace = {};
        SPACE_SUBS.forEach((s, i) => { bySpace[s.key] = lists[i]; });
        teams = teamList;
    }
    catch (e) {
        detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '카테고리를 불러오지 못했습니다')));
        return;
    }
    // calm 리스트(무채·헤어라인·아웃라인 — domain-map 톤). space 별 그룹 + 균일 단일행. 빈 should 열은 두지 않는다.
    const list = el('div', { class: 'wikicat' });
    for (const s of SPACE_SUBS) {
        const items = bySpace[s.key] || [];
        const isProduct = s.key === 'product';
        const head = el('div', { class: 'wikicat-grouphead' }, el('span', { class: 'wikicat-grouptitle', text: s.label }), isProduct ? el('span', { class: 'dm-tag', text: '도메인' }) : null, el('span', { class: 'wikicat-groupcount', text: String(items.length) }));
        if (canEdit)
            head.append(el('button', { class: 'btn btn-ghost btn-sm wikicat-add', text: '+ 추가', onclick: () => openCategoryForm(s.key, null, reload) }));
        const rows = el('div', { class: 'wikicat-rows' });
        if (!items.length) {
            rows.append(el('div', { class: 'wikicat-empty', text: '아직 없습니다.' }));
        }
        else {
            for (const c of items) {
                const should = (c.should || '').trim();
                // 정의·범위·규칙(should) — 수정에 들어가기 전에도 항상 노출. 비었으면 '있고 수정 가능'을 알리는 placeholder.
                const shouldLine = should
                    ? el('span', { class: 'wikicat-should', title: should }, el('span', { class: 'wikicat-should-label', text: '정의·범위·규칙' }), should)
                    : el('span', { class: 'wikicat-should wikicat-should-empty' }, el('span', { class: 'wikicat-should-label', text: '정의·범위·규칙' }), canEdit ? '미설정 — 오른쪽 [수정]에서 입력할 수 있어요' : '미설정');
                // 오너 팀 — 카테고리 소유(표면화·주입의 '우리 팀' 기준). canEdit 면 드롭다운(이양), 아니면 표시만. 오너십=우선순위, 접근제한 아님.
                let ownerEl = null;
                if (canEdit) {
                    const ownerSel = el('select', { class: 'wikicat-owner-sel' }, el('option', { value: '', text: '— 오너 없음 —' }), ...teams.map((t) => el('option', { value: String(t.id), text: t.name || t.key })));
                    ownerSel.value = c.owner_team_id ? String(c.owner_team_id) : '';
                    ownerSel.addEventListener('change', async () => {
                        const prev = c.owner_team_id ? String(c.owner_team_id) : '';
                        try {
                            await api('/api/ui/categories/' + c.id + '/owner', { method: 'POST',
                                body: JSON.stringify({ team_id: ownerSel.value ? Number(ownerSel.value) : null }) });
                            c.owner_team_id = ownerSel.value ? Number(ownerSel.value) : null;
                            toast('오너 팀을 변경했습니다');
                        }
                        catch (e) {
                            toast(e.message, true);
                            ownerSel.value = prev;
                        }
                    });
                    ownerEl = el('span', { class: 'wikicat-owner' }, el('span', { class: 'wikicat-owner-label', text: '오너 팀' }), ownerSel);
                }
                else if (c.owner_team_name) {
                    ownerEl = el('span', { class: 'wikicat-owner' }, el('span', { class: 'wikicat-owner-label', text: '오너 팀' }), el('span', { class: 'wikicat-owner-name', text: c.owner_team_name }));
                }
                const main = el('div', { class: 'wikicat-row-main' }, el('span', { class: 'wikicat-name', text: c.name || c.key }), el('span', { class: 'wikicat-key mono', text: c.key }), c.cross_cutting ? el('span', { class: 'dm-tag', text: '횡단' }) : null, ownerEl, shouldLine);
                const acts = canEdit ? el('div', { class: 'wikicat-row-acts' }, el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openCategoryForm(s.key, c, reload) }), el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: () => deleteWikiCategory(c, reload) })) : null;
                rows.append(el('div', { class: 'wikicat-row' }, main, acts));
            }
        }
        list.append(el('div', { class: 'wikicat-group' }, head, rows));
    }
    // 바깥 .card 제거(#req): .wikicat-rows 가 이미 테두리 있는 구획이라 카드로 더 감싸면 박스-속-박스가 된다.
    //  또 null 을 replaceChildren 에 직접 넘기면 DOM 이 "null" 텍스트로 렌더한다 → 배열 filter(Boolean) 로 차단(el 과 달리 안 걸러짐).
    detail.replaceChildren(...[
        sectionHead('카테고리 (분류 체계)', '지식과 프로젝트를 어떤 갈래로 나눌지 정합니다. 여기서 바꾼 분류는 위키·프로젝트 탭에 그대로 반영됩니다.'),
        canEdit ? null : el('p', { class: 'admin-sub', style: 'margin:-4px 0 12px' }, el('span', { class: 'pill', text: '읽기 전용' }), ' 편집은 context 권한 필요'),
        list,
    ].filter(Boolean));
}
// WIKI 카테고리 삭제(확인 후) — categoryCard 의 삭제 로직과 동일 엔드포인트. reload 로 패널 갱신.
async function deleteWikiCategory(c, reload) {
    if (!confirm('‘' + (c.name || c.key) + '’ 카테고리를 삭제할까요? 이 카테고리에 연결된 지식 매핑과 카테고리 간 연결(엣지)도 함께 삭제됩니다.'))
        return;
    try {
        await api('/api/ui/categories/' + c.id + '/delete', { method: 'POST' });
        toast('삭제했습니다');
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
// ── 섹션(강제규칙·회사맥락) markdown 에디터 — 기본은 구성원에게 보이는 읽기 전용 뷰, 관리자는 [수정]을 눌러야 편집 ──
async function profilesEditor(detail) {
    const reload = () => profilesEditor(detail);
    detail.replaceChildren(el('div', { class: 'card' }, skeleton('프로필 상태를 불러오는 중')));
    let r;
    try {
        r = await api('/api/ui/terminal/profiles');
    }
    catch (e) {
        detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '프로필을 불러오지 못했습니다')));
        return;
    }
    const profiles = r.profiles || [];
    const items = profiles.length ? profiles.map((p) => {
        // OS-유저 격리(#524) — 구성원별 OS 계정(box_<slug>, 홈700). secure-by-default: 인프라 설치된 박스에서 그 멤버가
        //  웹터미널 '첫 세션'을 열면 box_ 가 자동 생성(lazy)되고 그 세션부터 자기 계정으로 격리. 자격증명이 uid 로 상호열람 차단.
        //  #346 멀티프로필은 흡수됨(격리 시 네이티브 ~/.claude) → 프로필 버튼 없음. 아래는 상태 + (선택)미리생성/재프로비저닝.
        const os = p.os || {};
        const kids = [];
        const stateText = !os.ready ? '⚠ 격리 인프라 미설치 — 공유 계정으로 실행됩니다'
            : os.provisioned ? '🔒 격리됨: ' + (os.osUser || '') + ' ✓ · 세션 자동 격리'
                : '⏳ 첫 세션에 자동 격리 (' + (os.osUser || 'box_…') + ')';
        kids.push(el('div', {}, el('strong', { text: p.name }), el('span', { class: 'caption', text: '  ' + p.id + ' · ' + stateText })));
        // #549: 이 멤버가 admin/runtime scope 를 가지면, 프로비저닝 토큰에 그 관리 권한을 실을지 admin 이 선택(기본 off).
        //  멤버 scope 가 상한이라 이 체크박스는 admin/runtime 보유 멤버에만 뜬다. 체크 시 이 계정 세션이 관리 MCP(org_*)를 직접 쓴다.
        const hasCtrl = (p.scopes || []).some((s) => s === 'admin' || s === 'runtime');
        let cpChk = null;
        if (hasCtrl) {
            cpChk = el('input', { type: 'checkbox', style: 'margin-right:6px;vertical-align:middle' });
            kids.push(el('label', { class: 'caption', style: 'display:block;margin:3px 0 7px;cursor:pointer' }, cpChk, el('span', { text: '관리 권한(admin/runtime) 포함 — 이 계정으로 실행된 세션이 관리 탭 기능(구성원·토큰·훅·DB소스)을 MCP로 직접 다룰 수 있습니다. 변경 내역은 감사 로그에 AI 작업으로 기록됩니다.' })));
        }
        const cp = () => !!(cpChk && cpChk.checked);
        if (!os.ready) {
            // fix#59: 카드마다 반복되던 install-isolation.sh 캡션 제거 — 섹션 상단 안내에 이미 1회 서술됨.
        }
        else if (!os.provisioned) {
            // 자동이지만, 첫 세션 지연(수십초) 없이 미리 깔고 싶으면.
            kids.push(el('button', { class: 'btn btn-ghost btn-sm', text: '지금 미리 만들기', onclick: async (ev) => {
                    const btn = ev.currentTarget;
                    btn.disabled = true;
                    btn.textContent = '생성 중… (수십초)';
                    try {
                        await api('/api/ui/terminal/members/provision-os', { method: 'POST', body: JSON.stringify({ member: p.id, includeControlPlane: cp() }) });
                        toast('OS 격리 유저 생성됨 — 이 멤버 세션이 본인 계정으로 격리됩니다' + (cp() ? ' (관리 권한 포함)' : ''));
                        reload();
                    }
                    catch (e) {
                        btn.disabled = false;
                        btn.textContent = '지금 미리 만들기';
                        toast('실패 — ' + e.message, true);
                    }
                } }));
        }
        else {
            kids.push(el('button', { class: 'btn btn-ghost btn-sm', text: '재프로비저닝(격리·토큰 갱신)', onclick: async (ev) => {
                    const btn = ev.currentTarget;
                    btn.disabled = true;
                    btn.textContent = '갱신 중…';
                    try {
                        await api('/api/ui/terminal/members/provision-os', { method: 'POST', body: JSON.stringify({ member: p.id, includeControlPlane: cp() }) });
                        toast('재프로비저닝됨 — 로그인·실행중 세션 유지, 새 세션부터 새 토큰' + (cp() ? ' (관리 권한 포함)' : ''));
                        reload();
                    }
                    catch (e) {
                        btn.disabled = false;
                        btn.textContent = '재프로비저닝(격리·토큰 갱신)';
                        toast('실패 — ' + e.message, true);
                    }
                } }));
        }
        return el('div', { class: 'card' }, ...kids);
    }) : [el('p', { class: 'caption', text: '구성원이 없습니다.' })];
    detail.replaceChildren(el('div', { class: 'card' }, cardHead('AI 실행 계정 격리', '구성원마다 서버에 전용 OS 계정(box_<slug>, 홈 권한 700)이 만들어져 서로 완전히 분리됩니다. 구성원끼리는 Claude 자격증명(.credentials.json)을 열람할 수 없습니다. 격리 인프라(deploy/linux/install-isolation.sh)가 설치된 서버에서는 웹터미널 첫 세션을 열 때 전용 계정이 자동으로 만들어지고(별도 버튼 필요 없음), 그 세션부터 본인 Claude 로그인으로 실행됩니다. 아직 전용 계정이 없는 구성원은 기존과 같이 공유 계정으로 실행됩니다. 첫 세션 지연 없이 미리 만들려면 [지금 미리 만들기]를 누르고, 격리를 끄려면 게이트웨이 환경변수 LIVELY_MEMBER_ISOLATION=off 를 설정하세요.')), ...items);
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
            onclick: () => openMemberModal(m, data, detail) }, profileAvatar(m.avatar || null, m.display_name || m.id, m.id, 'member-ava', { char: m.avatar_char, color: m.avatar_color }), el('div', { class: 'member-row-body' }, el('div', { class: 'mini-title' }, el('span', { class: 'member-name', text: (m.display_name || m.id) }), canEdit ? (m.hasToken ? el('span', { class: 'pill pill-ok', text: '토큰 발급됨' }) : el('span', { class: 'pill', text: '토큰 미발급' })) : null), el('div', { class: 'mini-meta', text: meta, title: meta })));
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
        for (const m of shown)
            listCol.append(memberRow(m));
    };
    renderRows();
    const searchInp = el('input', { type: 'search', class: 'admin-member-search',
        value: state.admin.memberSearch || '', autocomplete: 'off', spellcheck: 'false', 'aria-label': '구성원 검색',
        placeholder: '이름·이메일·아이디로 검색  (총 ' + members.length + '명)',
        oninput: (e) => { state.admin.memberSearch = e.target.value; renderRows(); } });
    // ＋ 추가 — 구 [구성원 추가] 탭을 대신한다(#837). 다른 모든 목록 화면과 같은 관례(＋ 버튼 → 폼)로 통일.
    //  구 탭은 저장 후 location.hash 로 [토큰] 탭에 점프하고 state.admin.memberAddPreselect 로 선택을 실어 날랐다.
    //  이제 같은 화면 안이라 그냥 서브탭을 넘기면 된다 — 전역 상태로 탭 사이를 꿰맬 이유가 없다.
    const addBtn = canEdit ? el('button', { class: 'btn btn-primary btn-sm', text: '＋ 구성원 추가',
        onclick: () => openMemberModal(null, data, detail) }) : null;
    const bar = el('div', { class: 'admin-member-searchbar' }, members.length ? searchInp : el('span', {}), addBtn);
    detail.replaceChildren(el('div', { class: 'card' }, cardHead('구성원 목록'), (members.length || canEdit) ? bar : null, listCol));
}
// ── 구성원 상세/편집 모달(#613 후속) — 카드 클릭 시 그리드 위에 오버레이로 띄운다.
//  2단 collapse 대신 모달: 그리드 맥락을 유지한 채 상세를 보고, 닫으면 그리드로 복귀.
//  보기(memberRead) ↔ 편집(memberForm) 을 모달 안에서 토글하고, 저장/제거 시 모달을 닫고 그리드를 새로고침.
//  m === null 이면 **신규 등록**(구 [구성원 추가] 탭 대체, #837). 등록 뒤엔 곧바로 [접속 열쇠] 탭으로 넘겨
//  발급까지 이어지게 한다 — 구조는 같지만 이제 같은 화면 안이라 전역 상태를 거치지 않는다.
function openMemberModal(m, data, detail) {
    const isNew = !m;
    const body = el('div', { class: 'member-modal-body' });
    let back = null;
    let editing = isNew;
    const refreshGrid = () => renderAdminDetail(detail, 'members-list', state.admin.data);
    const closeModal = () => { if (back) {
        back.remove();
        back = null;
    } };
    const blank = { id: '', kind: 'human', display_name: '', email: '', identities: [], body_md: '', state: 'active', scopes: ['items', 'context'] };
    const rerender = () => {
        if (isNew) {
            memberForm(body, blank, data, detail, true, {
                saveLabel: '구성원 등록', showCancel: false, showRemove: false,
                onSaved: () => {
                    toast('구성원 등록됨 — 접속 토큰을 발급해 전달하세요');
                    closeModal();
                    // 같은 화면의 [접속 열쇠] 서브탭으로 전환하고 섹션을 다시 그린다(구 location.hash 점프 + preselect 해킹 제거).
                    state.admin.tab = state.admin.tab || {};
                    state.admin.tab['members'] = 'tokens';
                    renderAdminDetail(detail.closest('.admin-body') || detail, 'members', state.admin.data);
                },
            });
            return;
        }
        // 저장/리로드 후 최신 멤버 객체를 다시 집는다(이름·권한 변경 반영).
        const cur = ((state.admin.data && state.admin.data.members) || []).find((x) => x.id === m.id) || m;
        if (state.admin.canEdit && editing) {
            memberForm(body, cur, data, detail, false, {
                onSaved: () => { toast('저장됨 — 신원 매칭에 즉시 반영됩니다'); closeModal(); refreshGrid(); },
                onCancel: () => { editing = false; rerender(); }, // 편집 취소 → 모달 안에서 보기로 복귀
                onRemoved: () => { closeModal(); refreshGrid(); },
            });
        }
        else {
            memberRead(body, cur, data, detail, { onEdit: () => { editing = true; rerender(); } });
        }
    };
    rerender();
    back = overlay(isNew ? '구성원 추가' : ('구성원 · ' + (m.display_name || m.id)), body);
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
    overlay('로그인 계정 · ' + dn, el('p', { class: 'admin-hint', text: dn + ' 님의 로그인 계정 정보예요. 아래를 1:1로(슬랙·메신저 DM 등) 전달하세요 — 비밀번호는 지금만 보입니다.' }), field('로그인 주소', el('div', { class: 'admin-ro', text: webUrl })), field('이메일 (로그인 아이디)', el('div', { class: 'admin-ro', text: email || '⚠ 이메일 미설정 — 멤버에 이메일을 넣어야 로그인됩니다' })), el('div', { class: 'deploy-head' }, el('span', { class: 'mini-meta', text: '임시 비밀번호' }), copyButton(() => password, '비밀번호 복사')), el('pre', { class: 'admin-preview', text: password }), el('p', { class: 'admin-hint', text: '받은 분은 위 주소에서 이메일+비밀번호로 로그인 → 첫 로그인 시 새 비밀번호를 설정하게 됩니다 → [사용 가이드 › 시작하기]에서 [설치 명령 만들기]로 설치하면 됩니다.' }));
}
// 외부 계정 연결(identities) 요약 — 읽기 전용 표시 + 매핑 화면 링크(#837).
//  identities 는 "이 슬랙 메시지 쓴 사람 = 우리 윤상민"을 AI 가 알아보는 근거다. 편집 SoT 는
//  [외부 자료 수집 ▸ 멤버 매핑] — 거기선 커넥터가 실제 사용자 목록을 줘서 드롭다운으로 고른다.
//  구성원 화면에서 손타이핑하게 두면 외부 id 를 어디서 찾는지도 모르고 오타가 조용히 매칭을 깨뜨린다.
function idnSummary(identities) {
    const wrap = el('div', { class: 'idn-wrap' });
    if (!identities.length) {
        wrap.append(el('p', { class: 'admin-hint', style: 'margin:0 0 6px', text: '연결된 외부 계정이 없습니다.' }));
    }
    else {
        for (const idn of identities) {
            wrap.append(el('div', { class: 'idn-row idn-ro' }, el('span', { class: 'pill', text: idn.system }), el('span', { class: 'mini-title', text: idn.external_id }), idn.email ? el('span', { class: 'mini-meta', text: idn.email }) : null));
        }
    }
    wrap.append(el('div', { class: 'admin-actions' }, el('a', { class: 'btn btn-ghost btn-sm', href: '#/system/connectors', text: '외부 자료 수집에서 매핑 →' }), el('span', { class: 'admin-hint', style: 'margin:0',
        text: '커넥터별 사용자 목록에서 골라 연결합니다 — 외부 ID를 직접 찾을 필요가 없어요.' })));
    return wrap;
}
// ── 구성원 보기 모드 — [수정]을 누르기 전 기본 화면. 폼이 아니라 읽기 전용 요약을 보여준다. ──
//  권한 있는 사람(canEdit)만 [수정] 버튼이 보이고, 누르면 편집모드로 전환(memberForm). 비-admin 은 버튼 없음.
function memberRead(root, m, data, detail, opts = {}) {
    const canEdit = state.admin.canEdit;
    const roRow = (label, value) => field(label, el('div', { class: 'admin-ro', text: value || '—' }));
    const kids = [
        el('div', { class: 'member-read-head' }, el('h3', { text: m.display_name || m.id }), canEdit ? (m.hasToken ? el('span', { class: 'pill pill-ok', text: '토큰 발급됨' }) : el('span', { class: 'pill', text: '토큰 미발급' })) : null),
    ];
    if (canEdit) {
        const scopeText = (m.scopes || []).map((sk) => MEMBER_SCOPE_LABEL[sk] ? MEMBER_SCOPE_LABEL[sk] + ' (' + sk + ')' : sk).join(', ');
        kids.push(roRow('아이디', m.id), roRow('닉네임 (활동 로그 표시)', m.nickname), roRow('종류', m.kind || 'human'), roRow('대표 이메일', m.email), roRow('상태', (m.state || 'active') === 'active' ? '활성' : '비활성'), roRow('권한 (이 구성원 토큰의 scope)', scopeText), field('외부 계정 연결 (신원 매칭 키)', idnSummary(m.identities || [])), field('개인 레이어', el('div', { class: 'admin-ro admin-ro-pre', text: (m.body_md && m.body_md.trim()) || '—' })));
    }
    else {
        kids.push(el('div', { class: 'mini-meta', text: '종류: ' + (m.kind || 'human') + ' · 상태: ' + (m.state || 'active') }));
    }
    if (canEdit) {
        const acts = el('div', { class: 'admin-actions' }, el('button', { class: 'btn btn-primary', text: '수정',
            // 모달에서 열렸으면 opts.onEdit 로 모달 안에서 폼으로 전환(전체 재렌더 대신). 기본은 기존 흐름.
            onclick: () => { if (opts.onEdit) {
                opts.onEdit();
                return;
            } state.admin.memberEditing = true; renderAdminDetail(detail, 'members-list', data); } }));
        if ((m.kind || 'human') === 'human') {
            acts.append(el('button', { class: 'btn btn-ghost', text: '비밀번호 재설정',
                onclick: async () => {
                    if (!confirm(`'${m.display_name || m.id}' 님의 로그인 비밀번호를 임시 비번으로 재설정할까요?`))
                        return;
                    try {
                        const r = await api('/api/ui/org/member/reset-password', { method: 'POST', body: JSON.stringify({ id: m.id }) });
                        showInitialAccount(m.id, m.display_name, m.email, r.password, data);
                    }
                    catch (e) {
                        toast(e.message, true);
                    }
                } }));
        }
        kids.push(acts);
    }
    root.replaceChildren(...kids);
}
// opts(선택): { saveLabel, onSaved(payload), showCancel(기본 true), onCancel, showRemove(기본 !isNew) }
//  기본 동작은 [구성원 관리] 섹션용(저장 후 보기 모드 복귀). [구성원 추가] 섹션이 onSaved 등으로 재정의해 재사용.
function memberForm(root, m, data, detail, isNew, opts = {}) {
    // 읽기 전용(비-admin): 폼 대신 요약(민감 필드는 서버가 이미 redact). (정상 흐름은 memberRead 가 처리 — 안전망.)
    if (!state.admin.canEdit) {
        memberRead(root, m, data, detail);
        return;
    }
    // 아이디 = 불변 내부키(토큰·세션·활동이력·프로젝트·감사가 참조 — 가변 이메일과 분리). 신규는 서버가 이메일에서
    //  자동·유니크 생성(폼에서 숨김 — 관리자 비관여). 기존 멤버는 표시만(변경 불가).
    const idIn = el('input', { type: 'text', value: m.id, placeholder: '아이디(영문/숫자)', disabled: '' });
    const nameIn = el('input', { type: 'text', value: m.display_name || '', placeholder: '표시 이름' });
    // 닉네임(#762) — 표시 이름과 별개, 활동 로그 등 캐주얼 표기용(비우면 이름 폴백). 개인 프로필 모달에만 있던 걸 관리자 편집에도(#1025).
    const nickIn = el('input', { type: 'text', value: m.nickname || '', placeholder: '닉네임 (비우면 표시 이름으로)' });
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
    // 외부 계정 연결(identities) — **여기선 읽기 전용**(#837).
    //  예전엔 여기서 system·external_id 를 **손으로 타이핑**했다. 그런데 ClickUp 숫자 id 를 어디서 찾는지 알 길이
    //  없고, 시스템명 오타는 조용히 매칭 실패로 끝났다. 매핑의 편집 SoT 는 [외부 자료 수집 ▸ 멤버 매핑]이다 —
    //  거기선 커넥터가 실제 사용자 목록을 주므로 드롭다운으로 고르기만 하면 된다(오타 불가).
    //  ⚠ 저장 시 identities 를 **안 보낸다** → 서버가 보존한다(delivery.org_member_upsert: undefined 면 미변경).
    const idnWrap = idnSummary(m.identities || []);
    const saveBtn = el('button', { class: 'btn btn-primary', text: opts.saveLabel || (isNew ? '추가' : '저장') });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
        const knownScopes = SCOPE_OPTS.map(([sk]) => sk);
        const payload = {
            // 신규는 아이디를 보내지 않는다 — 서버가 이메일/표시이름에서 불변 내부키를 자동·유니크 생성(관리자 비관여).
            id: isNew ? undefined : idIn.value.trim(), kind: kindSel.value, display_name: nameIn.value.trim(), nickname: nickIn.value.trim(),
            // identities 는 **보내지 않는다** — 서버가 보존하고, 편집은 [외부 자료 수집 ▸ 멤버 매핑]에서만 한다(#837).
            email: emailIn.value.trim(), body_md: bodyTa.value, state: stateSel.value,
            // 체크된 권한 + 체크박스에 없는 권한은 보존 — 목록 누락으로 권한이 조용히 드롭되는 것 방지(안전망).
            scopes: [...knownScopes.filter((sk) => scopeChks[sk].checked), ...(m.scopes || []).filter((sk) => !knownScopes.includes(sk))],
        };
        // 사람(human) 구성원은 이메일이 로그인 아이디 → 신규 등록 시 필수(있어야 로그인 계정·초기 비번 발급). agent/system 은 불요.
        if (isNew && kindSel.value === 'human' && !payload.email) {
            toast('이메일을 입력하세요 — 로그인 아이디예요', true);
            return;
        }
        saveBtn.disabled = true;
        try {
            const res = await api('/api/ui/org/member', { method: 'POST', body: JSON.stringify(payload) });
            const savedId = (res && res.member && res.member.id) || payload.id; // 서버가 자동 생성한 아이디 반영
            await loadAdmin(true);
            // 신규 human 멤버면 초기 비밀번호가 1회 반환됨 — 관리자에게 전달용으로 표시(이메일 필수라 항상 발급됨).
            if (res && res.initialPassword)
                showInitialAccount(savedId, payload.display_name, payload.email, res.initialPassword, data);
            if (opts.onSaved) {
                opts.onSaved({ ...payload, id: savedId });
                return;
            }
            state.admin.memberSel = savedId;
            state.admin.memberEditing = false; // 저장 후 보기 모드로 복귀
            toast('저장됨 — 신원 매칭에 즉시 반영됩니다');
            renderAdminDetail(detail, 'members-list', state.admin.data);
        }
        catch (e) {
            toast(e.message, true);
            saveBtn.disabled = false;
        }
    });
    const actions = el('div', { class: 'admin-actions' }, saveBtn);
    // 취소 — 편집을 버리고 보기 모드로(신규는 선택 해제). opts.showCancel=false 면 숨김.
    if (opts.showCancel !== false) {
        actions.append(el('button', { class: 'btn btn-ghost', text: '취소',
            onclick: () => {
                if (opts.onCancel) {
                    opts.onCancel();
                    return;
                }
                state.admin.memberEditing = false;
                if (isNew)
                    state.admin.memberSel = null;
                renderAdminDetail(detail, 'members-list', data);
            } }));
    }
    actions.append(status);
    const showRemove = opts.showRemove !== undefined ? opts.showRemove : !isNew;
    if (showRemove) {
        // 토큰 발급은 [구성원 추가] 탭에서 — 여기(구성원 관리)선 신원/권한 편집만.
        actions.append(el('button', { class: 'btn-text', text: '제거',
            onclick: async () => {
                if (!confirm(`구성원 '${m.display_name || m.id}' 제거?`))
                    return;
                try {
                    await api('/api/ui/org/member/remove', { method: 'POST', body: JSON.stringify({ id: m.id }) });
                    await loadAdmin(true);
                    toast('제거됨');
                    // 모달에서 열렸으면 opts.onRemoved 로 모달 닫고 그리드 새로고침. 기본은 기존 흐름.
                    if (opts.onRemoved) {
                        opts.onRemoved();
                        return;
                    }
                    state.admin.memberSel = null;
                    renderAdminDetail(detail, 'members-list', state.admin.data);
                }
                catch (e) {
                    toast(e.message, true);
                }
            } }));
    }
    root.replaceChildren(isNew ? el('span', { hidden: '' }, idIn) : field('아이디 (내부 식별자 · 변경 불가)', idIn), field('표시 이름', nameIn), field('닉네임 (활동 로그 등 표시 · 비우면 이름)', nickIn), field('종류', kindSel), field('대표 이메일', emailIn), field('상태', stateSel), field('권한 (이 구성원 토큰의 scope)', scopeWrap), el('div', { class: 'field' }, el('label', { class: 'field-label', text: '외부 계정 연결 (신원 매칭 키)' }), idnWrap), field('개인 레이어', bodyTa), actions);
}
// ── 팀 — 구성원을 팀(스쿼드)으로 묶고, 팀이 카테고리를 '소유'한다(표면화·주입의 '우리 팀' 기준). ──
//  오너십 배정 자체는 [카테고리(분류 체계)] 화면(카테고리별 오너 드롭다운)에서. 여기선 팀 CRUD + 팀원(역할) + 소유 현황.
//  ★오너십 = 우선순위이지 접근제한이 아니다. 편집은 context 스코프(canContext).
const TEAM_ROLE_OPTS = [
    ['lead', '리드'], ['pm', 'PO/PM'], ['dev', '개발'], ['design', '디자인'], ['member', '멤버'],
];
const TEAM_ROLE_LABEL = Object.fromEntries(TEAM_ROLE_OPTS);
async function teamsPanel(detail, data) {
    const canEdit = state.admin.canContext;
    detail.replaceChildren(el('div', { class: 'card' }, skeleton('팀을 불러오는 중')));
    let teams;
    try {
        teams = ((await api('/api/ui/teams')) || {}).teams || [];
    }
    catch (e) {
        detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '팀을 불러오지 못했습니다')));
        return;
    }
    // 처음 들어오면 **맨 위 팀이 골라져 있다** — 빈 오른쪽 패널에 '왼쪽에서 고르세요'를 띄우던 걸 대체(사용자 요구).
    const sel = state.admin.teamSel ?? (teams.length ? teams[0].id : null);
    const listCol = el('div', { class: 'admin-sublist' });
    const newTeamBtn = canEdit ? el('button', { class: 'btn btn-ghost btn-sm', text: '+ 새 팀',
        onclick: () => { state.admin.teamSel = '__new__'; state.admin.teamEditing = true; teamsPanel(detail, data); } }) : null;
    for (const t of teams) {
        listCol.append(el('div', { class: 'mini-row' + (String(t.id) === String(sel) ? ' sel' : ''),
            onclick: () => { state.admin.teamSel = t.id; state.admin.teamEditing = false; teamsPanel(detail, data); } }, el('div', { class: 'mini-title', text: (t.name || t.key) }), el('div', { class: 'mini-meta', text: (t.member_count || 0) + '명 · 카테고리 ' + (t.category_count || 0) + '개' })));
    }
    if (!teams.length)
        listCol.append(el('div', { class: 'mini-meta', text: '아직 팀이 없습니다.' }));
    const right = el('div', {});
    // 팀이 하나도 없으면(첫 사용) 바로 생성 폼을 연다 — 빈 패널에서 '구성원이 안 보인다'는 혼선 제거(팀원 picker 가 폼 안에 있으므로).
    const wantCreate = sel === '__new__' || (sel == null && teams.length === 0 && canEdit);
    if (wantCreate && canEdit) {
        teamForm(right, { key: '', name: '', description: '', body_md: '', lead_member_id: '', members: [], categories: [] }, data, detail, true);
    }
    else if (sel != null && sel !== '__new__') {
        right.append(skeleton('팀 정보를 불러오는 중'));
        api('/api/ui/teams/' + sel).then((r) => {
            const team = r && r.team;
            if (!team) {
                right.replaceChildren(el('p', { class: 'admin-hint', text: '팀을 찾을 수 없습니다.' }));
                return;
            }
            if (state.admin.teamEditing && canEdit)
                teamForm(right, team, data, detail, false);
            else
                teamView(right, team, data, detail);
        }).catch((e) => right.replaceChildren(errorNote(e, '팀 정보를 불러오지 못했습니다')));
    }
    else {
        right.classList.add('admin-col-center');
        right.append(el('p', { class: 'admin-hint', text: canEdit ? '왼쪽에서 팀을 고르거나 [+ 새 팀]을 누르세요.' : '읽기 전용 — 편집은 context 권한이 필요합니다.' }));
    }
    // 제목은 다른 탭과 같게 카드 밖 sectionHead 로(카드 안 sectionTitle 은 .card h2=17px 라 제목이 작아 보였다, #req).
    detail.replaceChildren(sectionHead('팀', '구성원을 팀으로 묶고, 팀이 맡는 카테고리를 정합니다. 팀이 맡은 카테고리는 팀원의 화면과 AI 세션에 먼저 나옵니다.', { key: 'team' }), el('div', { class: 'card' }, cardHead('팀 목록과 담당 카테고리', null, null, newTeamBtn), el('div', { class: 'admin-two admin-two-cols' }, listCol, right)));
}
// 팀 보기(수정 전 읽기 요약).
function teamView(root, team, data, detail) {
    const canEdit = state.admin.canContext;
    const roRow = (label, value) => field(label, el('div', { class: 'admin-ro', text: value || '—' }));
    const memberName = (id) => { const m = (data.members || []).find((x) => x.id === id); return m ? (m.display_name || m.id) : id; };
    const owned = (team.categories || []).filter((c) => c.relation === 'owner');
    const stake = (team.categories || []).filter((c) => c.relation !== 'owner');
    const kids = [
        el('div', { class: 'member-read-head' }, el('h3', { text: team.name || team.key }), team.state === 'archived' ? el('span', { class: 'pill', text: '보관됨' }) : null),
        roRow('키(슬러그)', team.key),
        roRow('설명', team.description),
        roRow('리드', team.lead_member_id ? memberName(team.lead_member_id) : ''),
        field('팀원', el('div', { class: 'admin-ro admin-ro-pre', text: (team.members && team.members.length) ? team.members.map((m) => (m.display_name || m.member_id) + ' (' + (TEAM_ROLE_LABEL[m.role] || m.role) + ')').join('\n') : '—' })),
        field('소유 카테고리', el('div', { class: 'admin-ro admin-ro-pre', text: owned.length ? owned.map((c) => (c.name || c.key) + ' [' + c.space + ']').join('\n') : '— ([카테고리(분류 체계)]에서 배정)' })),
    ];
    if (stake.length)
        kids.push(field('이해관계 카테고리', el('div', { class: 'admin-ro admin-ro-pre', text: stake.map((c) => (c.name || c.key) + ' [' + c.space + ']').join('\n') })));
    if (team.body_md && team.body_md.trim())
        kids.push(field('팀 charter (AI 세션 주입)', el('div', { class: 'admin-ro admin-ro-pre', text: team.body_md.trim() })));
    if (canEdit)
        kids.push(el('div', { class: 'admin-actions' }, el('button', { class: 'btn btn-primary', text: '수정', onclick: () => { state.admin.teamEditing = true; teamsPanel(detail, data); } })));
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
    const existing = {};
    (team.members || []).forEach((m) => { existing[m.member_id] = m.role || 'member'; });
    const memberRows = [];
    const membersWrap = el('div', { class: 'team-members-wrap' });
    for (const m of (data.members || [])) {
        if ((m.kind || 'human') !== 'human')
            continue;
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
        if (!key) {
            toast('키(슬러그)를 입력하세요', true);
            return;
        }
        saveBtn.disabled = true;
        try {
            let teamId = team.id;
            const members = memberRows.filter((r) => r.chk.checked).map((r) => ({ member_id: r.id, role: r.roleSel.value }));
            // 리드 = 역할이 '리드'인 팀원에서 파생(별도 필드 없음). 여럿이면 첫 번째.
            const leadM = members.find((m) => m.role === 'lead');
            const payload = { key, name: nameIn.value.trim(), description: descIn.value.trim(), body_md: bodyTa.value, lead_member_id: leadM ? leadM.member_id : null };
            if (isNew) {
                const r = await api('/api/ui/teams', { method: 'POST', body: JSON.stringify(payload) });
                teamId = r && r.team && r.team.id;
            }
            else
                await api('/api/ui/teams/' + team.id, { method: 'POST', body: JSON.stringify(payload) });
            if (teamId)
                await api('/api/ui/teams/' + teamId + '/members', { method: 'POST', body: JSON.stringify({ members }) });
            toast('저장됨');
            state.admin.teamSel = teamId;
            state.admin.teamEditing = false;
            teamsPanel(detail, data);
        }
        catch (e) {
            toast(e.message, true);
            saveBtn.disabled = false;
        }
    });
    const actions = el('div', { class: 'admin-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => { state.admin.teamEditing = false; if (isNew)
            state.admin.teamSel = null; teamsPanel(detail, data); } }));
    if (!isNew)
        actions.append(el('button', { class: 'btn-text', text: '삭제',
            onclick: async () => {
                if (!confirm("팀 '" + (team.name || team.key) + "'을(를) 삭제할까요? (카테고리 오너십이 해제됩니다 — 카테고리 자체는 남습니다)"))
                    return;
                try {
                    await api('/api/ui/teams/' + team.id + '/delete', { method: 'POST' });
                    toast('삭제됨');
                    state.admin.teamSel = null;
                    state.admin.teamEditing = false;
                    teamsPanel(detail, data);
                }
                catch (e) {
                    toast(e.message, true);
                }
            } }));
    root.replaceChildren(field('키 (슬러그 · 영문)', keyIn), field('팀 이름', nameIn), field('설명', descIn), el('div', { class: 'field' }, el('label', { class: 'field-label', text: '팀원 (체크 + 역할 · 리드는 역할에서 지정)' }), membersWrap), field('팀 charter (AI 세션 주입 · 선택)', bodyTa), actions);
}
// ── 조직 · 연결 ──
function profileEditor(detail, data) {
    const canEdit = state.admin.canEdit;
    const p = data.profile;
    const dnIn = el('input', { type: 'text', value: p.display_name || '', placeholder: '조직 표시명' });
    const gwIn = el('input', { type: 'text', value: p.gateway_url || '', placeholder: 'http://게이트웨이:포트' });
    // 조직 시간대(#778) — 비우면 서버가 기본값(Asia/Seoul)으로 되돌린다. 흔한 존은 datalist 로 제안하되 자유 입력 허용(IANA 검증은 서버).
    const tzIn = el('input', { type: 'text', value: p.timezone || '', placeholder: 'Asia/Seoul (비우면 기본값)', list: 'org-tz-list' });
    const tzList = el('datalist', { id: 'org-tz-list' }, ...['Asia/Seoul', 'UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'America/New_York', 'Europe/London'].map((z) => el('option', { value: z })));
    if (!canEdit) {
        dnIn.disabled = true;
        gwIn.disabled = true;
        tzIn.disabled = true;
    }
    const body = [
        fieldWithHelp('조직 표시명', dnIn, data.meaning['display_name']),
        fieldWithHelp('게이트웨이 주소', gwIn, data.meaning['gateway-url']),
        fieldWithHelp('조직 시간대', tzIn, data.meaning['timezone']), tzList,
    ];
    if (canEdit) {
        const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
        const status = el('span', { class: 'admin-status' });
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            try {
                const r = await api('/api/ui/org/profile', { method: 'POST', body: JSON.stringify({ display_name: dnIn.value.trim(), gateway_url: gwIn.value.trim(), timezone: tzIn.value.trim() }) });
                data.profile = r.profile;
                tzIn.value = r.profile.timezone || '';
                toast('저장됨');
                status.textContent = '저장됨';
            }
            catch (e) {
                toast(e.message, true);
            }
            saveBtn.disabled = false;
        });
        body.push(el('div', { class: 'admin-actions' }, saveBtn, status));
    }
    detail.replaceChildren(sectionHead('조직 정보', '조직 이름·접속 주소·시간대처럼 이 조직 전체에 적용되는 기본 정보를 정합니다.'), el('div', { class: 'card admin-form-narrow' }, cardHead('조직 기본 정보'), ...body));
}
// ── 구성원 토큰 관리 — 접속 열쇠(토큰) 발급 + 발급 현황 보기 + 접속 해제. admin 전용. (발급 블록은 [구성원 추가]에서 이관 #613 후속) ──
function tokensPanel(detail, data) {
    const gw = (data.profile.gateway_url || window.location.origin).replace(/\/mcp$/, '').replace(/\/$/, '');
    const tokens = data.tokens || [];
    const active = tokens.filter((t) => !t.revoked_at);
    const revoked = tokens.filter((t) => t.revoked_at);
    const tokenRow = (t, isActive) => {
        const meta = (t.user_id || '') + ((t.scopes || []).length ? ' · ' + (t.scopes || []).join('/') : '')
            + ' · 발급 ' + (t.created_at ? t.created_at.slice(0, 10) : '?')
            + (t.last_used_at ? ' · 마지막 ' + relTime(t.last_used_at) : ' · 미사용');
        const right = isActive
            ? el('button', { class: 'btn btn-ghost btn-sm', text: '접속 해제', onclick: async (e) => {
                    if (!confirm(`'${t.label || t.user_id}' 님의 접속을 해제할까요? 이 토큰은 즉시 무효화됩니다(되돌릴 수 없음).`))
                        return;
                    e.target.disabled = true;
                    try {
                        await api('/api/ui/org/token/revoke', { method: 'POST', body: JSON.stringify({ tokenHash: t.token_hash }) });
                        await loadAdmin(true);
                        toast('접속 해제됨 — 즉시 무효');
                        renderAdminDetail(detail, 'tokens', state.admin.data);
                    }
                    catch (err) {
                        toast(err.message, true);
                        e.target.disabled = false;
                    }
                } })
            : el('span', { class: 'pill', text: t.revoked_at ? '해제 ' + String(t.revoked_at).slice(0, 10) : '해제됨' });
        return el('div', { class: 'token-row' + (isActive ? '' : ' token-revoked') }, el('div', { class: 'token-main' }, el('div', { class: 'token-label', text: t.label || t.user_id || '(무라벨)' }), el('div', { class: 'mini-meta', text: meta })), right);
    };
    // 목록이 수십 줄로 길어져 한 화면을 넘겼다(사용자 지적) → **검색 + 페이지네이션**(페이지당 개수 선택).
    //  발급 폼과 목록은 소제목으로 구분한다 — 전에는 둘이 붙어 어디부터 목록인지 안 보였다.
    const listBox = el('div');
    const q = el('input', { type: 'search', class: 'tok-search', placeholder: '이름·아이디·권한으로 찾기' });
    const perSel = el('select', { class: 'tok-per' }, ...[10, 20, 50, 100].map((n) => el('option', { value: String(n), text: n + '개씩' })));
    perSel.value = String(Number(localStorage.getItem('adm:tokPer')) || 10);
    let page = 1;
    const match = (t) => {
        const k = q.value.trim().toLowerCase();
        if (!k)
            return true;
        return [t.label, t.user_id, (t.scopes || []).join(' ')].some((v) => String(v || '').toLowerCase().includes(k));
    };
    const drawList = () => {
        const per = Number(perSel.value) || 10;
        const act = active.filter(match);
        const rev = revoked.filter(match);
        const rows = [...act.map((t) => ({ t, on: true })), ...rev.map((t) => ({ t, on: false }))];
        const totalPages = Math.max(1, Math.ceil(rows.length / per));
        if (page > totalPages)
            page = totalPages;
        const slice = rows.slice((page - 1) * per, page * per);
        const kids = [];
        if (!rows.length) {
            kids.push(el('p', { class: 'admin-hint', text: tokens.length ? '검색과 맞는 토큰이 없습니다.' : '아직 발급된 접속 토큰이 없습니다 — 위에서 구성원을 골라 발급하세요.' }));
        }
        else {
            let lastOn = null;
            for (const r of slice) {
                if (r.on !== lastOn) {
                    kids.push(el('div', { class: 'token-section-h', text: r.on ? '사용 중 (' + act.length + ')' : '해제됨 (' + rev.length + ')' }));
                    lastOn = r.on;
                }
                kids.push(tokenRow(r.t, r.on));
            }
        }
        const pager = el('div', { class: 'oa-pager' });
        if (totalPages > 1) {
            const pg = (label, n, kind) => el('button', { class: 'oa-pg' + (kind === 'on' ? ' oa-pg-on' : '') + (kind === 'off' ? ' oa-pg-off' : ''),
                text: String(label), ...(kind ? {} : { onclick: () => { page = n; drawList(); } }) });
            pager.append(pg('‹', page - 1, page <= 1 ? 'off' : undefined));
            for (const pn of tuPageNumbers(page, totalPages))
                pager.append(pn === '…' ? el('span', { class: 'oa-pg-gap', text: '…' }) : pg(pn, pn, pn === page ? 'on' : undefined));
            pager.append(pg('›', page + 1, page >= totalPages ? 'off' : undefined));
            pager.append(el('span', { class: 'oa-pg-info', text: rows.length + '개 중 ' + ((page - 1) * per + 1) + '–' + Math.min(page * per, rows.length) }));
        }
        listBox.replaceChildren(...kids, pager);
    };
    q.addEventListener('input', () => { page = 1; drawList(); });
    perSel.addEventListener('change', () => { localStorage.setItem('adm:tokPer', perSel.value); page = 1; drawList(); });
    drawList();
    const children = [
        el('p', { class: 'admin-hint', text: '구성원이 라이블리 게이트웨이에 로그인할 때 쓰는 접속 토큰입니다.' }),
        installMinterBlock(data, gw, { title: '토큰 발급' }),
        el('div', { class: 'tok-listhead' }, el('h4', { class: 'admin-subhead-2', text: '발급된 토큰' }), el('div', { class: 'tok-tools' }, q, perSel)),
        el('p', { class: 'admin-hint', style: 'margin:0 0 8px', text: '지금 누가 게이트웨이에 접속할 수 있는지 보여줍니다. 퇴사·기기 분실처럼 접속을 끊어야 할 때 [접속 해제]를 누르면 그 즉시 막힙니다. 한 번 해제한 토큰은 다시 살릴 수 없고, 필요하면 새로 발급합니다.' }),
        listBox,
    ];
    detail.replaceChildren(el('div', { class: 'card' }, cardHead('접속 토큰'), ...children));
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
    const rc = data.runtimeConfig; // admin 만 non-null. 없으면 토글/편집 숨기고 딥링크+미리보기만.
    const canEdit = !!data.canEdit && !!rc;
    const hooks = (rc && rc.hooks) || {};
    const orgHooks = data.orgHooks || [];
    const customFor = (ev) => orgHooks.filter((h) => h.event === ev);
    const HANDLED = ['SessionStart', 'PostToolUse', 'Stop'];
    // 런타임 설정 부분 저장 — 서버가 patch 병합(제공 필드만 갱신)하므로 바뀐 것만 보낸다.
    async function saveRuntime(patch, okMsg) {
        const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify(patch) });
        if (r && r.runtimeConfig)
            data.runtimeConfig = r.runtimeConfig;
        toast(okMsg || '저장됨 — 구성원 다음 세션부터 반영');
    }
    // 시점 ON/OFF — hooks JSON 전체를 보내 다른 시점 값 보존. label 을 주면 '주입' 외 토글(예: 자동 업데이트)에도 쓴다.
    function momentToggle(hookKey, label, onMsg, offMsg) {
        const chk = el('input', { type: 'checkbox' });
        chk.checked = hooks[hookKey] !== false;
        chk.disabled = !canEdit;
        chk.addEventListener('change', async () => {
            try {
                await saveRuntime({ hooks: { ...hooks, [hookKey]: chk.checked } }, chk.checked ? (onMsg || '주입 켜짐') : (offMsg || '주입 꺼짐'));
                hooks[hookKey] = chk.checked;
            }
            catch (e) {
                toast(e.message, true);
                chk.checked = hooks[hookKey] !== false;
            }
        });
        return el('label', { class: 'admin-check inj-toggle' }, chk, label || ' 주입 켜기');
    }
    // 딥링크 — 정식 편집 집으로 이동(섹션 / WIKI 탭). tab 을 주면 그 화면의 서브탭까지 맞춘다.
    //  (#837 병합 후 필요해졌다: '커스텀 훅 편집 →'이 [스킬·훅] 화면엔 가지만 **스킬 탭**에 떨어지면
    //   사용자는 훅을 못 찾는다 — 링크가 가리킨 곳과 도착지가 달라진다.)
    const jump = (label, hash, tab) => el('button', { class: 'btn btn-ghost btn-sm', text: label, onclick: () => {
            if (tab) {
                state.admin.tab = state.admin.tab || {};
                state.admin.tab[tab.section] = tab.key;
            }
            location.hash = hash;
        } });
    function pieceRow(n, label, sub, editBtn) {
        return el('div', { class: 'inj-piece' }, el('span', { class: 'inj-n', text: n }), el('div', { class: 'inj-piece-body' }, el('div', { class: 'inj-piece-label', text: label }), sub ? el('div', { class: 'admin-hint inj-sub', text: sub }) : null), editBtn || el('span', {}));
    }
    // 커스텀 훅 요약(읽기 전용) + 편집 딥링크.
    function customList(ev) {
        const list = customFor(ev);
        const wrap = el('div', { class: 'inj-custom' });
        if (list.length)
            wrap.append(el('div', { class: 'admin-hint', text: '커스텀 훅' }));
        for (const h of list)
            wrap.append(el('div', { class: 'inj-custom-row' }, el('span', { class: 'mini-title', text: h.id }, h.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null), el('span', { class: 'mini-meta', text: (h.harness || 'all') + (h.matcher ? ' · ' + h.matcher : '') })));
        wrap.append(el('div', { class: 'admin-actions' }, jump(list.length ? '커스텀 ' + ev + ' 훅 편집 →' : '+ 커스텀 ' + ev + ' 훅', '#/system/agent-assets', { section: 'agent-assets', key: 'hooks' })));
        return wrap;
    }
    function momentBlock(title, when, toggleEl, ...children) {
        return el('div', { class: 'inj-moment' }, el('div', { class: 'inj-moment-head' }, el('div', { class: 'inj-moment-h' }, el('h3', { class: 'inj-moment-title', text: title }), el('div', { class: 'admin-hint inj-sub', text: when })), toggleEl || el('span', {})), ...children.filter(Boolean));
    }
    // 줄 단위 텍스트리스트 인라인 편집(work-roots / write_tools). hint 를 주면 라벨 아래 보조 설명으로 분리.
    function listEditor(labelText, initial, fieldKey, ph, hint) {
        const ta = el('textarea', { rows: '3', placeholder: ph || '' });
        ta.value = (initial || []).join('\n');
        ta.disabled = !canEdit;
        const btn = el('button', { class: 'btn btn-primary btn-sm', text: '저장' });
        if (!canEdit)
            btn.disabled = true;
        const st = el('span', { class: 'admin-status' });
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                await saveRuntime({ [fieldKey]: ta.value.split('\n').map((l) => l.trim()).filter(Boolean) });
                st.textContent = '저장됨';
            }
            catch (e) {
                toast(e.message, true);
            }
            btn.disabled = false;
        });
        return field(labelText, el('div', {}, hint ? el('p', { class: 'admin-hint', style: 'margin:0 0 4px', text: hint }) : null, ta, el('div', { class: 'admin-actions' }, btn, st)));
    }
    // #906/#959 pull_tools 전용 편집기 — 게이트웨이 프록시 MCP는 '+추가' 칩(org_mcp tools_snapshot에서 발견)으로,
    //  자체설치 MCP는 그 툴이름 prefix(예: mcp__notion__)를 textarea에 직접. session-preload 가 비-lively prefix로
    //  work-flag matcher를 세션마다 동적 배선(#959)하므로 자체설치도 커버된다 — 게이트웨이 강제 설치 불필요.
    //  textarea = 전체 pull_tools 의 편집 가능한 단일 소스. 칩은 prefix 를 '추가'만(제거는 textarea에서).
    function pullToolsEditor() {
        const proxyServers = (data.mcpServers || []).filter((s) => s.mode === 'proxy' && s.enabled !== false);
        const ta = el('textarea', { rows: '3', placeholder: 'mcp__lively__ext__   (비우면 이 기능 꺼짐)' });
        ta.value = ((rc && rc.pull_tools) || []).join('\n');
        ta.disabled = !canEdit;
        const addPrefix = (p) => {
            const lines = ta.value.split('\n').map((l) => l.trim()).filter(Boolean);
            if (lines.includes(p)) {
                toast(p + ' 는 이미 있습니다');
                return;
            }
            lines.push(p);
            ta.value = lines.join('\n');
            toast(p + ' 추가됨 — [저장]으로 확정');
        };
        const chips = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin:4px 0' });
        chips.append(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ 전체 프록시 (mcp__lively__ext__)', onclick: () => addPrefix('mcp__lively__ext__') }));
        for (const s of proxyServers) {
            const n = (s.tools_snapshot || []).length;
            chips.append(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ ' + s.name + (n ? ' (' + n + '개)' : ''), onclick: () => addPrefix('mcp__lively__ext__' + s.name + '__') }));
        }
        const btn = el('button', { class: 'btn btn-primary btn-sm', text: '저장' });
        if (!canEdit)
            btn.disabled = true;
        const st = el('span', { class: 'admin-status' });
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                await saveRuntime({ pull_tools: ta.value.split('\n').map((l) => l.trim()).filter(Boolean) });
                st.textContent = '저장됨';
            }
            catch (e) {
                toast(e.message, true);
            }
            btn.disabled = false;
        });
        return field('외부 인입 툴(pull_tools) — 외부 맥락을 가져온 세션에 기록 너지', el('div', {}, el('p', { class: 'admin-hint', style: 'margin:0 0 4px', text: '이 MCP 툴 prefix 로 시작하는 툴을 쓰면 "외부 맥락을 가져왔다"로 보고, 라이블리에 기록 없이 세션을 끝내면 너지합니다. 비우면 이 기능이 꺼집니다.' }), canEdit ? el('p', { class: 'admin-hint', style: 'margin:0 0 4px', text: '아래 버튼으로 게이트웨이에 등록된 외부 MCP(프록시)를 추가하세요. 게이트웨이 밖의 자체설치 MCP(예: 구성원이 직접 붙인 Notion MCP)는 그 툴이름 prefix(예: mcp__notion__)를 아래 칸에 직접 적으면 세션 시작 훅이 자동으로 매처를 배선해 커버합니다(#959) — 게이트웨이에 다시 설치할 필요 없습니다.' }) : null, canEdit ? chips : null, ta, el('div', { class: 'admin-actions' }, btn, st)));
    }
    // 세션종료 너지 문구 — 기본값(서버 단일소스 data.writebackNoticeDefault)을 실제로 보여준다(숨은 파일 기본값 X).
    //  비우거나 기본값과 같게 저장하면 null(=기본값 사용)로 저장 → DB 는 'override 있음/없음'만 들고, 화면엔 항상 effective 값이 보임.
    function writebackEditor() {
        const def = (data.writebackNoticeDefault || '').trim();
        const cur = (rc && rc.writeback_notice) || '';
        const ta = el('textarea', { rows: '12', placeholder: def });
        ta.value = cur || def;
        ta.disabled = !canEdit;
        const btn = el('button', { class: 'btn btn-primary btn-sm', text: '저장' });
        if (!canEdit)
            btn.disabled = true;
        const resetBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '기본값으로 되돌리기' });
        if (!canEdit)
            resetBtn.disabled = true;
        const st = el('span', { class: 'admin-status', text: cur ? '커스텀 너지 사용 중' : '기본값 사용 중' });
        resetBtn.addEventListener('click', () => { ta.value = def; st.textContent = '기본값을 불러왔어요 — [저장]으로 확정'; });
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            const v = ta.value.trim();
            const payload = (!v || v === def) ? null : v; // 비었거나 기본값과 동일 → null(기본값 사용)
            try {
                await saveRuntime({ writeback_notice: payload });
                if (rc)
                    rc.writeback_notice = payload;
                st.textContent = payload ? '저장됨 · 커스텀 너지' : '저장됨 · 기본값 사용';
            }
            catch (e) {
                toast(e.message, true);
            }
            btn.disabled = false;
        });
        return field('세션 종료 너지 문구 — 기본값이 채워져 있음(비우거나 기본값과 같으면 기본값 사용)', el('div', {}, ta, el('div', { class: 'admin-actions' }, btn, resetBtn, st)));
    }
    // 실제 주입 전문 미리보기(SessionStart) — 게이트웨이 조립물(byte-identical) 펼침.
    function previewExpander() {
        const box = el('div', { class: 'inj-preview' });
        box.style.display = 'none';
        const btn = el('button', { class: 'btn btn-ghost btn-sm', text: '실제 주입되는 전문 미리보기 ▾' });
        let loaded = false, open = false;
        btn.addEventListener('click', async () => {
            open = !open;
            box.style.display = open ? 'block' : 'none';
            btn.textContent = open ? '미리보기 접기 ▴' : '실제 주입되는 전문 미리보기 ▾';
            if (open && !loaded) {
                loaded = true;
                box.replaceChildren(el('p', { class: 'admin-hint', text: '불러오는 중…' }));
                try {
                    const r = await api('/api/ui/org/hooks/preview');
                    const sp = ((r && r.hooks) || []).find((h) => h.id === 'session-preload');
                    box.replaceChildren(sp && sp.message
                        ? el('div', { class: 'md-rendered admin-md-box', style: 'max-height:340px; overflow:auto' }, renderMarkdown(sp.message))
                        : el('p', { class: 'admin-hint', text: '미리볼 내용이 없습니다.' }));
                }
                catch (e) {
                    box.replaceChildren(errorNote(e, '미리보기를 불러오지 못했습니다(서버 재시작 후 제공)'));
                }
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
        'context-ontology-guide': '⚠ LLM 이 라이블리 시스템(맥락·카테고리·프로젝트·지식) 사용법을 이해하는 핵심 문서 — 삭제·대폭수정 주의. ${categories}/${wiki} 자리표시자를 포함합니다.',
    };
    const subPieceRow = (token, label, sub, btn) => el('div', { class: 'inj-piece inj-subpiece' }, el('code', { class: 'inj-token', text: token }), el('div', { class: 'inj-piece-body' }, el('div', { class: 'inj-piece-label', text: label }), sub ? el('div', { class: 'admin-hint inj-sub', text: sub }) : null), btn || el('span', {}));
    // 섹션 본문 편집/생성 모달 — overlay + textarea. 저장 → POST /api/ui/org/section.
    function openSectionEditor(name, opts) {
        opts = opts || {};
        const isNew = !!opts.isNew;
        const cur = (data.sections && data.sections[name]) || { body_md: '' };
        const nameIn = el('input', { type: 'text', value: name || '', placeholder: '섹션 키 (소문자·숫자·하이픈, 예: company-policy)' });
        if (!isNew)
            nameIn.disabled = true;
        const ta = el('textarea', { class: 'mem-edit-ta', rows: '18', placeholder: 'markdown 본문 — ${team}/${categories}/${wiki} 치환 가능' });
        ta.value = cur.body_md || '';
        const st = el('span', { class: 'admin-status' });
        const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
        const root = el('div', { class: 'mem-modal' }, isNew ? field('섹션 키', nameIn) : null, name === guideKey ? el('p', { class: 'admin-hint', text: '⚠ 시스템 가이드 — LLM 이 라이블리 사용법을 이해하는 핵심 문서입니다. 대폭 수정·삭제 시 AI 가 시스템 사용법을 잃을 수 있어요.' }) : null, field('본문 (markdown)', ta), el('div', { class: 'admin-actions' }, saveBtn, st));
        const back = overlay(isNew ? '섹션 추가' : ('섹션 편집 · ' + name), root);
        saveBtn.onclick = async () => {
            const section = (isNew ? nameIn.value : name).trim().toLowerCase();
            if (!section) {
                toast('섹션 키를 입력하세요', true);
                return;
            }
            saveBtn.disabled = true;
            st.textContent = '저장 중…';
            try {
                await api('/api/ui/org/section', { method: 'POST', body: JSON.stringify({ section, body_md: ta.value }) });
                toast('저장됨 — 구성원 다음 세션부터 반영');
                back.remove();
                await reloadSections();
            }
            catch (e) {
                toast('저장 실패 — ' + e.message, true);
                saveBtn.disabled = false;
                st.textContent = '';
            }
        };
    }
    async function reloadSections() {
        try {
            const r = await api('/api/ui/org');
            if (r && r.sections)
                data.sections = r.sections;
        }
        catch (_) { /* 유지 */ }
        paintSections();
    }
    function orderedSections() {
        return Object.entries(data.sections || {}).map(([name, s]) => ({ name, ...s }))
            .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || a.name.localeCompare(b.name));
    }
    async function moveSection(i, dir) {
        const entries = orderedSections();
        const j = i + dir;
        if (j < 0 || j >= entries.length)
            return;
        const order = entries.map((e) => e.name);
        [order[i], order[j]] = [order[j], order[i]];
        try {
            await api('/api/ui/org/sections/order', { method: 'POST', body: JSON.stringify({ order }) });
            await reloadSections();
        }
        catch (e) {
            toast(e.message, true);
        }
    }
    async function deleteSectionUi(s) {
        const warn = s.name === guideKey ? '⚠ 시스템 가이드입니다 — 삭제하면 AI 가 라이블리 사용법(맥락·카테고리·지식 기록)을 잃습니다.\n\n' : '';
        if (!confirm(warn + "'" + s.name + "' 섹션을 삭제할까요?\n\n매 세션 주입에서 사라집니다(휴지통에서 복원 가능)."))
            return;
        try {
            await api('/api/ui/org/section/delete', { method: 'POST', body: JSON.stringify({ section: s.name }) });
            toast('삭제됨');
            await reloadSections();
        }
        catch (e) {
            toast(e.message, true);
        }
    }
    const sectionsWrap = el('div', { class: 'inj-pieces' });
    function paintSections() {
        const entries = orderedSections();
        const rows = entries.map((s, i) => {
            const isGuide = s.name === guideKey;
            const acts = [];
            if (canEdit) {
                const up = el('button', { class: 'btn btn-ghost btn-sm', text: '▲', title: '위로' });
                up.disabled = i === 0;
                up.onclick = () => moveSection(i, -1);
                const down = el('button', { class: 'btn btn-ghost btn-sm', text: '▼', title: '아래로' });
                down.disabled = i === entries.length - 1;
                down.onclick = () => moveSection(i, +1);
                const ed = el('button', { class: 'btn btn-ghost btn-sm', text: '편집' });
                ed.onclick = () => openSectionEditor(s.name, {});
                const del = el('button', { class: 'btn btn-ghost btn-sm', text: '삭제' });
                del.onclick = () => deleteSectionUi(s);
                acts.push(up, down, ed, del);
            }
            return el('div', { class: 'inj-piece' }, el('span', { class: 'inj-n', text: String(i + 1) }), el('div', { class: 'inj-piece-body' }, el('div', { class: 'inj-piece-label' }, s.name, isGuide ? el('span', { class: 'pill', title: '시스템 가이드 — 수정·삭제 주의', text: ' ⚠ 시스템 가이드' }) : null), el('div', { class: 'admin-hint inj-sub', text: SECTION_HINT[s.name] || ('v' + (s.version || 1) + ' · 갱신 ' + (s.updated_by || '—')) })), el('div', { class: 'admin-actions' }, ...acts));
        });
        sectionsWrap.replaceChildren(...rows, canEdit ? el('div', { class: 'admin-actions inj-add' }, el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 섹션 추가', onclick: () => openSectionEditor('', { isNew: true }) })) : el('span', {}), el('div', { class: 'inj-subpieces' }, el('div', { class: 'admin-hint inj-sub', text: '└ 각 섹션 본문의 ${ } 자리에 매 세션 실제 데이터로 자동 채워짐(편집 불가):' }), subPieceRow('${team}', '우리 팀', '보는 구성원의 팀·소유 카테고리 프리앰블 — 자동', null), subPieceRow('${categories}', '카테고리 지도', '전 카테고리(주제) 목록 — 자동', null), subPieceRow('${wiki}', 'WIKI 인덱스 핀', '핀(is_wiki)한 지식의 제목·소환키만(본문 제외) — 자동', jump('WIKI 인덱스 →', '#/knowledge?indexed=1'))));
    }
    paintSections();
    const ssBlock = momentBlock('세션 시작 — SessionStart', '세션이 시작될 때 조직 컨텍스트를 자동으로 주입합니다 — 맨 위 조직 헤더(자동) 다음에 아래 섹션 문서들이 sort 순으로 조립됩니다. 추가/편집/삭제/재정렬 가능.', momentToggle('session_preload'), sectionsWrap, previewExpander(), customList('SessionStart'));
    const ptuBlock = momentBlock('작업 중 — PostToolUse', '도구 사용 후 라이블리 작업 세션인지 플래그를 남긴다(주입 없음 · 종료 너지 판정에 사용).', momentToggle('work_flag', ' 감지 켜기', '감지 켜짐', '감지 꺼짐'), canEdit ? listEditor('work-roots — 이 폴더에서 켠 세션을 라이블리 작업으로 인식 (줄당 절대경로)', rc.work_roots, 'work_roots', '/Users/you/repo') : null, canEdit ? listEditor('기록 인정 툴(write_tools) — 이 lively 툴을 사용한 세션에는 종료 너지를 보내지 않습니다 · 비우면 기본 목록 사용', rc.write_tools, 'write_tools', 'knowledge_save') : null, 
    // #906 — write_tools 와 시맨틱이 반대(비우면 끔)라 라벨에 명시. 값이 곧 on/off + 범위다.
    pullToolsEditor(), customList('PostToolUse'));
    const stopBlock = momentBlock('세션 종료 — Stop', '작업했는데 기록이 없으면(조건 충족 시 1회) 기록을 권하는 너지 문구를 표시합니다.', momentToggle('stop_writeback_gate', ' 너지 켜기', '너지 켜짐', '너지 꺼짐'), canEdit ? writebackEditor() : null, customList('Stop'));
    // 키트 자동 업데이트(#858) — 주입이 아니라 '전달' 축이지만, 발화 시점이 세션 시작이라 같은 지도에 둔다.
    //  켜져 있으면 구성원은 업데이트 명령을 손으로 돌릴 필요가 없다(새 훅·배선까지 자동으로 따라온다).
    const updBlock = momentBlock('키트 자동 업데이트 — SessionStart(백그라운드)', '구성원 컴퓨터의 라이블리 키트(훅 코드·연결 설정)를 게이트웨이 최신본과 동기화합니다. 세션 시작 시 버전만 비교하고, 다르면 백그라운드로 내려받아 재설치합니다 → 다음 세션부터 적용(현재 세션은 방해하지 않음). 회사 맥락·스킬은 이 토글과 무관하게 매 세션 자동으로 적용됩니다.', momentToggle('self_update', ' 자동 업데이트 켜기', '자동 업데이트 켜짐 — 구성원 다음 세션부터', '자동 업데이트 꺼짐 — 구성원이 직접 업데이트 명령을 실행해야 합니다'), el('p', { class: 'admin-hint inj-sub', text: '끄면 훅 코드·연결 설정 변경이 구성원에게 전달되지 않습니다(구성원이 [내 AI 세션 생성] 화면의 업데이트 명령을 직접 실행해야 함). 구성원 개인이 끄려면 환경변수 LIVELY_NO_AUTO_UPDATE=1 을 설정합니다.' }));
    // 기타 이벤트 — 위 3시점 외 커스텀 훅.
    const otherHooks = orgHooks.filter((h) => !HANDLED.includes(h.event));
    const otherBlock = el('div', { class: 'inj-moment' }, el('div', { class: 'inj-moment-head' }, el('div', { class: 'inj-moment-h' }, el('h3', { class: 'inj-moment-title', text: '기타 이벤트' }), el('div', { class: 'admin-hint inj-sub', text: 'UserPromptSubmit · Pre/PostToolUse 매처 · SubagentStop · Notification 등 — 코드로 정의하는 커스텀 훅.' }))), otherHooks.length
        ? el('div', { class: 'inj-custom' }, ...otherHooks.map((h) => el('div', { class: 'inj-custom-row' }, el('span', { class: 'mini-title', text: h.id }, h.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null), el('span', { class: 'mini-meta', text: h.event + ' · ' + (h.harness || 'all') }))))
        : null, el('div', { class: 'admin-actions' }, jump((data.orgHooks || []).length ? '커스텀 훅 전체 관리 →' : '+ 커스텀 훅 정의', '#/system/agent-assets', { section: 'agent-assets', key: 'hooks' })));
    // 바깥 박스 제거(#req): 각 .inj-moment 가 이미 테두리 있는 '구획'이라 .card 하나로 더 감싸면 박스-속-박스다.
    //  me-logins 처럼 제목(sectionHead)은 박스 밖, 구획들은 스택(admin-stack)으로 바로 나열한다.
    detail.replaceChildren(sectionHead('세션 주입', '이 조직의 AI가 매 세션을 시작할 때 무엇을 자동으로 읽는지 정합니다.'), el('div', { class: 'admin-stack' }, !rc ? el('p', { class: 'admin-hint', text: '※ 주입 시점 ON/OFF·너지 편집은 관리자만 가능합니다. 아래는 보기 전용 + 편집 위치로의 이동만 동작합니다.' }) : null, el('div', { class: 'inj-moments' }, ssBlock, ptuBlock, stopBlock, updBlock, otherBlock)));
}
// 외부 호출·DB 안전범위(allowlist) 카드 — runtime-config 의 SSRF 화이트리스트를 도구/DB 화면 안에 인라인(2026-06-26, 구 safetyEditor 폐기).
//  fields: [{key,label,initial,placeholder,hint}]. 저장은 patch 병합(POST runtime-config, admin 전용 — 아니면 읽기전용 textarea).
function allowlistCard(data, title, intro, fields) {
    const canEdit = !!data.canEdit;
    const tas = {};
    // fix#96: 형제 카드(DB 데이터소스 등)와 같은 h2 위계로 — admin-subhead 는 하위 섹션처럼 보였다.
    const rows = [cardHead(title, intro)];
    for (const f of fields) {
        const ta = el('textarea', { rows: '3', placeholder: f.placeholder || '' });
        ta.value = (f.initial || []).join('\n');
        ta.disabled = !canEdit;
        tas[f.key] = ta;
        rows.push(field(f.label, el('div', {}, f.hint ? el('p', { class: 'admin-hint', style: 'margin:0 0 4px', text: f.hint }) : null, ta)));
    }
    if (canEdit) {
        const btn = el('button', { class: 'btn btn-primary btn-sm', text: '안전범위 저장' });
        const st = el('span', { class: 'admin-status' });
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                const patch = {};
                for (const f of fields)
                    patch[f.key] = tas[f.key].value.split('\n').map((l) => l.trim()).filter(Boolean);
                const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify(patch) });
                if (r && r.runtimeConfig)
                    data.runtimeConfig = r.runtimeConfig;
                st.textContent = '저장됨';
                toast('저장됨 — 구성원 다음 세션부터 반영');
            }
            catch (e) {
                toast(e.message, true);
            }
            btn.disabled = false;
        });
        rows.push(el('div', { class: 'admin-actions' }, btn, st));
    }
    return el('div', { class: 'card' }, ...rows);
}
// [DEPRECATED 2026-06-26] 아래 hooksOverview·runtimeEditor·hooksPreviewPanel 은 '세션 주입 지도'(injectionMap)로
//  대체되어 라우팅에서 분리됨(미참조). 다음 청소 때 제거.
// ── '훅' 그룹 개요(클릭 진입점) — 훅이 무엇인지 설명 + 3 하위(런타임·커스텀·미리보기) 안내/이동. ──
function fmtBytes(n) {
    if (!Number.isFinite(n) || n < 0)
        return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return (i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)) + units[i];
}
function storageEditor(detail, data) {
    const canEdit = !!data.canEdit;
    const body = el('div');
    detail.replaceChildren(sectionHead('저장소 · 로그', '이 서버의 디스크가 얼마나 찼는지 보고, 로그가 무한히 쌓이지 않도록 상한을 정합니다. 디스크가 가득 차면 로그인을 포함한 모든 기능이 멈추므로 미리 확인하는 화면입니다.'), el('div', { class: 'card' }, cardHead('디스크 사용량과 로그 보관'), body));
    body.append(el('p', { class: 'admin-hint', text: '불러오는 중…' }));
    async function load() {
        let st;
        try {
            st = await api('/api/ui/org/storage');
        }
        catch (e) {
            body.replaceChildren(el('p', { class: 'admin-hint', text: '상태를 불러오지 못했습니다: ' + e.message }));
            return;
        }
        build(st);
    }
    function build(st) {
        const p = st.policy || {};
        alertPolicy = p; // 경보 알림 옵션 문구가 실제 임계값을 표기하도록 공유
        // ── 위험 배너(#813 T5) — 무엇이 이미 막히고 있는지 먼저 말한다. 숫자보다 '지금 무슨 일이 벌어지나'가 급하다. ──
        const worst = (st.disks || []).reduce((w, d) => (!w || d.usedPct > w.usedPct ? d : w), null);
        const banner = worst && worst.level === 'critical'
            ? el('div', { class: 'storage-banner storage-banner-critical' }, el('strong', { text: `⚠ 디스크 위험 (${worst.usedPct}%) — 새 세션 · 레포 클론 · 파일 업로드가 차단되고 있습니다.` }), el('p', { text: '아래 워크스페이스에서 [분석] → [정리]로 공간을 확보하세요. 100%에 닿으면 DB가 중단되어 로그인을 포함한 모든 기능이 멈추고, 공간을 비워도 수동 재시작이 필요합니다.' }))
            : worst && worst.level === 'warn'
                ? el('div', { class: 'storage-banner storage-banner-warn' }, el('strong', { text: `디스크 경고 (${worst.usedPct}%) — 아직 정상 동작하지만 정리가 필요합니다.` }), el('p', { text: `${p.disk_critical_pct ?? 95}%를 넘으면 새 세션·클론·업로드가 자동으로 차단됩니다.` }))
                : null;
        // ── ① 지금 상태 — 디스크 게이지 ──
        const LV = { ok: ['여유', 'ok'], warn: ['경고', 'warn'], critical: ['위험', 'critical'] };
        const diskRows = (st.disks || []).map((d) => {
            const [lvLabel, lvKey] = LV[d.level] || LV.ok;
            const fill = el('div', { class: 'gauge-fill gauge-' + lvKey });
            fill.style.width = Math.min(100, Math.max(2, d.usedPct)) + '%';
            return el('div', { class: 'storage-item' }, el('div', { class: 'storage-head' }, el('code', { text: d.path }), el('span', { class: 'storage-lv storage-lv-' + lvKey, text: '사용 ' + d.usedPct + '% · ' + lvLabel })), el('div', { class: 'gauge' }, fill), el('p', { class: 'storage-calc', text: `전체 ${fmtBytes(d.totalBytes)} 중 ${fmtBytes(d.availBytes)} 남음` }));
        });
        if (!diskRows.length)
            diskRows.push(el('p', { class: 'admin-hint', text: '디스크 정보를 읽지 못했습니다.' }));
        // ── ① 지금 상태 — 메모리 게이지(#1059 G1) ── 만성(세션 baseline)·급성(Ollama 스파이크)을 한 눈에.
        const mem = st.memory || null;
        let memBlock = null;
        if (mem) {
            const usedPct = Math.min(100, Math.max(0, Number(mem.used_pct) || 0));
            const mlvKey = usedPct >= 90 ? 'critical' : usedPct >= 75 ? 'warn' : 'ok';
            const mlvLabel = mlvKey === 'critical' ? '위험' : mlvKey === 'warn' ? '경고' : '여유';
            const mfill = el('div', { class: 'gauge-fill gauge-' + mlvKey });
            mfill.style.width = Math.min(100, Math.max(2, usedPct)) + '%';
            const oll = mem.ollama;
            const ollLine = oll
                ? (oll.loaded
                    ? `Ollama 로드 ${oll.mb ? fmtBytes(oll.mb * 1024 * 1024) : ''}${(oll.models || []).length ? ' (' + oll.models.slice(0, 3).join(', ') + ')' : ''}`
                    : 'Ollama 로드 모델 없음')
                : '';
            memBlock = el('div', { class: 'storage-item' }, el('div', { class: 'storage-head' }, el('strong', { text: '메모리' }), el('span', { class: 'storage-lv storage-lv-' + mlvKey, text: '사용 ' + usedPct + '% · ' + mlvLabel })), el('div', { class: 'gauge' }, mfill), el('p', { class: 'storage-calc', text: `전체 ${fmtBytes((mem.total_mb || 0) * 1024 * 1024)} 중 ${fmtBytes((mem.available_mb || 0) * 1024 * 1024)} 가용 · 세션 ${mem.session_count ?? 0}개${ollLine ? ' · ' + ollLine : ''}` }));
        }
        // ── ② 정책 ── (로그 status·보관정책은 별도 '로그' 메뉴 = logsEditor 로 분리 — #1059 사용자 피드백)
        const numIn = (val, min, max) => {
            const i = el('input', { class: 'input input-num', type: 'number', min: String(min), max: String(max) });
            i.value = String(val);
            i.disabled = !canEdit;
            return i;
        };
        const warnIn = numIn(p.disk_warn_pct ?? 85, 1, 99);
        const critIn = numIn(p.disk_critical_pct ?? 95, 1, 100);
        // ── ② 정책 — 공유 빌드 캐시(#813 T3) ──
        const cache = st.cache || { root: '', vars: [], bytes: 0, partial: false };
        const cacheChk = el('input', { type: 'checkbox' });
        cacheChk.checked = p.shared_cache_enabled !== false;
        cacheChk.disabled = !canEdit;
        const homeChk = el('input', { type: 'checkbox' });
        homeChk.checked = !!p.shared_cache_relocate_home;
        homeChk.disabled = !canEdit;
        const cacheState = el('p', { class: 'storage-calc' });
        const syncCacheState = () => {
            homeChk.disabled = !canEdit || !cacheChk.checked;
            cacheState.textContent = cacheChk.checked
                ? `현재 ${fmtBytes(cache.bytes)}${cache.partial ? '+' : ''} 사용 · 세션에 주입되는 변수 ${cache.vars.length}개 (${(cache.vars || []).slice(0, 4).join(', ')}…)`
                : '꺼짐 — 세션마다 의존성을 새로 내려받습니다(디스크·시간 낭비).';
        };
        cacheChk.addEventListener('change', syncCacheState);
        syncCacheState();
        const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '정책 저장' });
        saveBtn.disabled = !canEdit;
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            try {
                // 저장소 정책 = 디스크 임계 + 공유 캐시만. 로그(로그 메뉴)·메모리 임계(메모리 탭)는 각자 저장 —
                //  updateRuntimeConfig 가 storage_policy 를 **병합**하므로 여기서 안 보낸 필드(log_*·mem_*)는 보존된다.
                const storage_policy = {
                    disk_warn_pct: Number(warnIn.value),
                    disk_critical_pct: Number(critIn.value),
                    shared_cache_enabled: cacheChk.checked,
                    shared_cache_relocate_home: homeChk.checked,
                };
                await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ storage_policy }) });
                toast('저장됨 — 즉시 반영됩니다(재시작 불필요).');
                load();
            }
            catch (e) {
                toast(e.message, true);
                saveBtn.disabled = false;
            }
        });
        // 설정 출처 안내 — .env 시드로 도는지, 관리탭 저장값인지(혼동 방지, #688 임베딩과 같은 관례).
        const srcNote = st.policy_source === 'env'
            ? el('p', { class: 'admin-hint', text: '현재 값은 서버 환경변수(.env) 시드입니다 — 여기서 저장하면 관리탭 설정이 우선합니다.' })
            : st.policy_source === 'default'
                ? el('p', { class: 'admin-hint', text: '아직 설정한 적이 없어 기본값으로 동작 중입니다.' })
                : null;
        // 정책 출처 한 줄(#688 관례) — db(관리탭)·env(.env 시드)·default(기본값).
        const srcHint = (source) => source === 'env'
            ? el('p', { class: 'admin-hint', text: '현재 값은 서버 환경변수(.env) 시드입니다 — 여기서 저장하면 관리탭 설정이 우선합니다.' })
            : source === 'default'
                ? el('p', { class: 'admin-hint', text: '아직 설정한 적이 없어 기본값으로 동작 중입니다.' })
                : null;
        // ── ② 정책 — 세션 메모리 상한(#1059 D) ── per-session cgroup(box-cgspawn) 캡. 0=무제한(무회귀). 배포+캡 설정 시 세션이 scope 격리.
        const smp = st.session_memory_policy || {};
        const memHighIn = numIn(smp.per_session_high_mb ?? 0, 0, 1048576);
        const memMaxIn = numIn(smp.per_session_max_mb ?? 0, 0, 1048576);
        const memPolBtn = el('button', { class: 'btn btn-primary btn-sm', text: '세션 메모리 정책 저장' });
        memPolBtn.disabled = !canEdit;
        memPolBtn.addEventListener('click', async () => {
            memPolBtn.disabled = true;
            try {
                await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ session_memory_policy: { per_session_high_mb: Number(memHighIn.value), per_session_max_mb: Number(memMaxIn.value) } }) });
                toast('저장됨 — 새 세션부터 적용됩니다(기존 세션은 재생성 시).');
                load();
            }
            catch (e) {
                toast(e.message, true);
                memPolBtn.disabled = false;
            }
        });
        // ── ② 정책 — idle 세션 자동 회수(#1059 F) ── 그 시간 넘게 idle 인 세션을 회수(desired-state 보존→복원 가능). 0=끔(무회귀).
        const srp = st.session_reclaim_policy || {};
        const idleTtlIn = numIn(srp.idle_ttl_minutes ?? 0, 0, 43200);
        const reclaimBtn = el('button', { class: 'btn btn-primary btn-sm', text: 'idle 회수 정책 저장' });
        reclaimBtn.disabled = !canEdit;
        reclaimBtn.addEventListener('click', async () => {
            reclaimBtn.disabled = true;
            try {
                await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ session_reclaim_policy: { idle_ttl_minutes: Number(idleTtlIn.value) } }) });
                toast('저장됨 — 다음 회수 주기(5분)부터 적용됩니다.');
                load();
            }
            catch (e) {
                toast(e.message, true);
                reclaimBtn.disabled = false;
            }
        });
        // ── 메모리 경보 임계(#1059) — 디스크처럼 사용%가 임계 넘으면 경보 웹훅. 0=끔. 채널은 저장소 탭 ▸ 경보 알림 공용. ──
        const memWarnIn = numIn(p.mem_warn_pct ?? 0, 0, 99);
        const memCritIn = numIn(p.mem_critical_pct ?? 0, 0, 100);
        const memAlertBtn = el('button', { class: 'btn btn-primary btn-sm', text: '메모리 경보 임계 저장' });
        memAlertBtn.disabled = !canEdit;
        memAlertBtn.addEventListener('click', async () => {
            memAlertBtn.disabled = true;
            try {
                await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ storage_policy: { mem_warn_pct: Number(memWarnIn.value), mem_critical_pct: Number(memCritIn.value) } }) });
                toast('저장됨 — 다음 감시 주기(5분)부터 적용됩니다.');
                load();
            }
            catch (e) {
                toast(e.message, true);
                memAlertBtn.disabled = false;
            }
        });
        // ── 서브탭: [메모리] · [저장소] (#1059 — 메모리를 저장소 하위에서 꺼내 대등한 탭으로) ──
        const memoryTab = (host) => host.replaceChildren(el('h3', { class: 'storage-h', text: '지금 상태' }), ...(memBlock
            ? [el('div', { class: 'storage-block' }, memBlock, el('p', { class: 'admin-hint', text: '가용 = 회수 가능한 캐시 포함(지금 새 작업에 내줄 수 있는 양). #1059 다운은 만성(세션 baseline)+급성(Ollama 임베딩 스파이크)이 겹쳐 물리 초과로 일어났습니다 — 세션 수와 Ollama 로드를 함께 봅니다.' }))]
            : [el('div', { class: 'storage-block' }, el('p', { class: 'admin-hint', text: '메모리 정보를 읽지 못했습니다.' }))]), el('h3', { class: 'storage-h', text: '메모리 경보' }), el('div', { class: 'storage-block' }, el('strong', { text: '메모리 경보 임계' }), el('div', { class: 'storage-fields' }, el('label', {}, el('span', { text: '경고 임계(사용%, 0=끔)' }), memWarnIn), el('label', {}, el('span', { text: '위험 임계(사용%, 0=끔)' }), memCritIn)), el('p', { class: 'storage-calc', text: '디스크처럼, 메모리 사용%가 이 값을 넘으면 경보 웹훅으로 알립니다(OOM 임박 사전 경고). 위험 임계는 경고보다 커야 합니다. 0=끔. 제안: 경고 85 · 위험 95.' }), el('p', { class: 'admin-hint', text: '경보를 받을 웹훅 채널은 [저장소] 탭 ▸ 경보 알림 에서 설정합니다(디스크·DB·메모리 공용). 위 게이지의 현재 사용%를 보고 임계를 정하세요.' }), el('div', { class: 'storage-actions' }, memAlertBtn)), 
        // ── 세션 메모리·회수(#1059) — 박스 다운(OOM) 재발 방지의 두 축을 관리탭에서 조절 ──
        el('h3', { class: 'storage-h', text: '세션 메모리 · 회수' }), el('div', { class: 'storage-block' }, el('strong', { text: '세션 메모리 상한 (per-session)' }), ...(srcHint(st.session_memory_policy_source) ? [srcHint(st.session_memory_policy_source)] : []), el('div', { class: 'storage-fields' }, el('label', {}, el('span', { text: 'MemoryHigh(MB, 0=무제한)' }), memHighIn), el('label', {}, el('span', { text: 'MemoryMax(MB, 0=무제한)' }), memMaxIn)), el('p', { class: 'storage-calc', text: 'MemoryMax 를 넘은 세션은 그 세션 안에서만 OOM-kill 되고 박스는 생존합니다(폭주 1개만 죽음). MemoryHigh 는 그 아래 소프트 스로틀. High ≤ Max.' }), el('p', { class: 'admin-hint', text: 'claude 는 네이티브라 힙제한이 안 통해 cgroup 이 유일 수단입니다. 0/0=무제한(무회귀). 캡을 걸면 새 세션이 격리 scope 로 뜹니다(박스에 격리 인프라 배포 필요 — 미설치면 종전대로 무제한). 예: 16GB 박스 High 3072 · Max 4096.' }), el('div', { class: 'storage-actions' }, memPolBtn)), el('div', { class: 'storage-block' }, el('strong', { text: 'idle 세션 자동 회수' }), ...(srcHint(st.session_reclaim_policy_source) ? [srcHint(st.session_reclaim_policy_source)] : []), el('div', { class: 'storage-fields' }, el('label', {}, el('span', { text: 'idle 임계(분, 0=끔)' }), idleTtlIn)), el('p', { class: 'storage-calc', text: '이 시간 넘게 idle 인 세션을 5분 주기로 회수합니다. 작업내용(대화·설정)은 보존돼 목록에 “복원 가능”으로 남고, 열면 이어집니다(admission control 대신 채택).' }), el('p', { class: 'admin-hint', text: '0=끔(무회귀, 기본). 상시(managed)·접속 중·작업 중·확인 대기 세션은 절대 회수하지 않습니다. 예: 16GB 박스 180~1440분.' }), el('div', { class: 'storage-actions' }, reclaimBtn)));
        const storageTab = (host) => {
            host.replaceChildren(...(banner ? [banner] : []), el('h3', { class: 'storage-h', text: '지금 상태' }), el('div', { class: 'storage-block' }, ...diskRows), el('h3', { class: 'storage-h', text: '정책' }), ...(srcNote ? [srcNote] : []), el('div', { class: 'storage-block' }, el('strong', { text: '디스크 경고' }), el('div', { class: 'storage-fields' }, el('label', {}, el('span', { text: '경고 임계(%)' }), warnIn), el('label', {}, el('span', { text: '위험 임계(%)' }), critIn)), el('p', { class: 'storage-calc', text: '경고 → /readyz 가 degraded 로 알립니다(서비스는 정상 동작). 위험 → 신규 세션·클론을 막습니다.' }), el('p', { class: 'admin-hint', text: '경고 임계는 위험 임계보다 낮아야 합니다.' })), el('div', { class: 'storage-block' }, el('strong', { text: '공유 빌드 캐시' }), el('label', { class: 'storage-toggle' }, cacheChk, el('span', { text: ' 의존성 캐시를 서버의 공유 위치 한 곳에 모읍니다 (권장)' })), cacheState, el('p', { class: 'admin-hint', text: 'npm·pnpm·pip·uv·Go·Maven·Yarn·NuGet·Composer 의 다운로드 캐시를 세션마다 따로 받지 않고 공유합니다. 빌드가 빨라지고, 나중에 프로젝트의 빌드 산출물을 정리해도 금방 복구됩니다. 새로 만드는 세션부터 적용됩니다.' }), el('label', { class: 'storage-toggle' }, homeChk, el('span', { text: ' Gradle · Cargo 홈까지 공유 (주의)' })), el('p', { class: 'admin-hint storage-warn', text: '⚠ 이 옵션을 켜면 캐시뿐 아니라 설정·자격증명도 공유 위치로 옮겨갑니다 — ~/.gradle/gradle.properties(서명키·저장소 인증)와 ~/.cargo/credentials.toml(레지스트리 토큰)이 무시됩니다. 그 파일에 의존하는 빌드가 실패할 수 있으니, 해당 파일을 쓰지 않는 것이 확실할 때만 켜세요.' }), el('div', { class: 'storage-actions' }, saveBtn)), el('h3', { class: 'storage-h', text: '경보 알림' }), alertRegion, el('h3', { class: 'storage-h', text: '워크스페이스' }), wsRegion);
            loadAlert();
            loadWorkspace();
        };
        body.replaceChildren(segTabs('storage', [
            { key: 'memory', label: '메모리', render: memoryTab },
            { key: 'storage', label: '저장소', render: storageTab },
        ]));
    }
    // ── 경보 알림(#813) ──
    // 2026-07-13 사고의 본질은 "디스크가 찼다"가 아니라 **"아무도 몰랐다"** 였다. 가드가 있어도 사람에게 닿지 않으면
    //  똑같이 늦게 발견된다. 이 화면은 그 마지막 구멍을 막는다.
    // ⚠ 웹훅 URL 은 시크릿이라 서버가 값을 돌려주지 않는다 → 레포 관례대로 항상 빈칸 + '설정됨' 표시 + 빈 제출=미변경.
    const alertRegion = el('div');
    let alertPolicy = {};
    async function loadAlert() {
        alertRegion.replaceChildren(el('p', { class: 'admin-hint', text: '불러오는 중…' }));
        let a;
        try {
            a = await api('/api/ui/org/alert');
        }
        catch (e) {
            alertRegion.replaceChildren(el('p', { class: 'admin-hint', text: '불러오지 못했습니다: ' + e.message }));
            return;
        }
        const urlIn = el('input', {
            class: 'input', type: 'password', value: '',
            placeholder: a.configured ? '● 설정됨 — 변경할 때만 입력' : 'https://hooks.slack.com/services/…  (슬랙·디스코드 웹훅 또는 임의 JSON 웹훅)',
        });
        urlIn.disabled = !canEdit || !a.encryption_ready;
        const minSel = el('select', { class: 'input' }, el('option', { value: 'warn', text: `경고부터 (경고 임계 ${alertPolicy.disk_warn_pct ?? 85}% 도달 시 알림)` }), el('option', { value: 'critical', text: `위험만 (위험 임계 ${alertPolicy.disk_critical_pct ?? 95}% 도달·DB 연결 불가 시 알림)` }));
        minSel.value = a.min_severity || 'warn';
        minSel.disabled = !canEdit;
        const labelIn = el('input', { class: 'input', type: 'text', placeholder: '예: #ops' });
        labelIn.value = a.label || '';
        labelIn.disabled = !canEdit;
        const saveA = el('button', { class: 'btn btn-primary btn-sm', text: a.configured ? '설정 저장' : '웹훅 등록' });
        saveA.disabled = !canEdit || !a.encryption_ready;
        saveA.addEventListener('click', async () => {
            saveA.disabled = true;
            try {
                await api('/api/ui/org/alert', {
                    method: 'POST',
                    body: JSON.stringify({ url: urlIn.value, min_severity: minSel.value, label: labelIn.value }),
                });
                toast('저장됨 — [테스트 전송]으로 실제로 닿는지 꼭 확인하세요.');
                loadAlert();
            }
            catch (e) {
                toast(e.message, true);
                saveA.disabled = false;
            }
        });
        // 테스트 전송 — 이게 없으면 "저장은 됐는데 정작 장애 때 안 오는" 상황을 못 잡는다(오타·만료·권한).
        const testA = el('button', { class: 'btn btn-sm', text: '테스트 전송' });
        testA.disabled = !canEdit || !a.configured;
        testA.addEventListener('click', async () => {
            testA.disabled = true;
            testA.textContent = '보내는 중…';
            try {
                await api('/api/ui/org/alert/test', { method: 'POST', body: JSON.stringify({}) });
                toast('보냈습니다 — 채널에 도착했는지 확인하세요.');
            }
            catch (e) {
                toast(e.message, true);
            }
            testA.disabled = false;
            testA.textContent = '테스트 전송';
        });
        const delA = el('button', { class: 'btn btn-sm btn-danger', text: '해제' });
        delA.disabled = !canEdit || !a.configured;
        delA.addEventListener('click', async () => {
            if (!confirm('경보 웹훅을 해제합니다. 디스크가 위험해져도 알림이 오지 않습니다. 계속할까요?'))
                return;
            delA.disabled = true;
            try {
                await api('/api/ui/org/alert/delete', { method: 'POST', body: JSON.stringify({}) });
                toast('해제됨');
                loadAlert();
            }
            catch (e) {
                toast(e.message, true);
                delA.disabled = false;
            }
        });
        const status = a.configured
            ? el('p', { class: 'storage-calc', text: `설정됨${a.label ? ' · ' + a.label : ''} — 상태가 바뀔 때만 알립니다(같은 상태를 반복 발송하지 않습니다). 복구되면 해제 알림도 갑니다.` })
            : el('p', { class: 'storage-calc storage-warn', text: '⚠ 미설정 — 디스크가 위험 단계에 들어가거나 DB가 중단되어도 알림이 전송되지 않습니다(로그와 이 화면에서만 확인할 수 있습니다).' });
        const keyNote = a.encryption_ready ? null
            : el('p', { class: 'admin-hint storage-warn', text: '⚠ 시크릿 암호화 키(CONNECTOR_SECRET_KEY)가 설정되지 않아 웹훅을 저장할 수 없습니다. 웹훅 주소는 그 URL만 알면 누구나 글을 쓸 수 있어 평문으로 저장하지 않습니다.' });
        alertRegion.replaceChildren(el('div', { class: 'storage-block' }, status, ...(keyNote ? [keyNote] : []), el('div', { class: 'storage-fields' }, el('label', { style: 'flex:1 1 320px' }, el('span', { text: '웹훅 주소' }), urlIn), el('label', {}, el('span', { text: '알림 기준' }), minSel), el('label', {}, el('span', { text: '이름(선택)' }), labelIn)), el('p', { class: 'admin-hint', text: '슬랙·디스코드의 incoming webhook 주소를 그대로 넣으면 됩니다. 전송되는 알림: 디스크 경고/위험 진입, DB 연결 불가, 그리고 각각의 복구. 저장된 주소는 암호화되어 다시 표시되지 않습니다(변경할 때만 다시 입력).' }), el('div', { class: 'ws-actions' }, a.configured ? el('span', {}, testA, ' ', delA) : el('span', {}), saveA)));
    }
    // ── 워크스페이스(#813 T3-2 백스톱) ──
    // 프로젝트 마무리 루틴이 정리를 하지만 그건 best-effort 다 — 에이전트가 건너뛰거나, 사람이 웹UI 에서 바로 done
    //  처리하거나, 프로젝트가 방치되면 아무도 안 치운다. 여기서 관리자가 보고 **직접** 정리한다.
    //  ⚠ 자동 삭제는 없다. 반드시 [분석](dry-run) → 내용 확인 → [정리] 순서로만 지워진다.
    // ── 워크스페이스 정리 (reclaim — #813 백스톱 · #845 UX 수정) ────────────────────
    //  화면에선 '회수'라 부르지 않는다(#859) — 되돌릴 수 없는 접속 해제·재부여 가능한 권한 해제·아무것도
    //  안 지우는 지식 검색이 전부 '회수'라 불려 파괴성이 안 읽혔다. 여기는 재생성 가능한 파생물만 지운다.
    //  #845 전에는 **목록의 78% 가 눌러봐야 에러**였다(307개 중 레포 없는 껍데기 184 + 고아 57).
    //  그래서 세 가지를 지킨다:
    //   ① **못 하는 일에 버튼을 주지 않는다** — 레포 없는 폴더는 접어두고 [분석] 버튼 자체를 안 만든다.
    //   ② **일괄** — 8GB 가 어디 있는지 알려고 123번 클릭하게 두지 않는다.
    //   ③ **청크로 끊어 부른다** — 한 요청에 전부 넣으면 du 가 수십 초를 먹고 프록시가 504 로 끊는다(#600).
    const wsRegion = el('div');
    // ⚠ 키는 **folder** 다(project_id 아님). 폴더명이 숫자가 아닌 옛 규칙(project/<프로젝트 이름>)이 74개 있고,
    //  그중 12개는 지금도 살아있는 프로젝트다 — id 로 키를 잡으면 이것들이 화면에서 통째로 사라진다.
    const analyzed = new Map(); // folder → 분석 결과(dry-run). 정리는 여기 담긴 것만 대상으로 한다.
    const selected = new Set();
    let wsList = null;
    const ANALYZE_CHUNK = 10; // 요청당 프로젝트 수 — du 비용이 크므로 작게. 서버 상한은 40.
    async function runBatch(path, folders, body, onProgress) {
        const out = [];
        for (let i = 0; i < folders.length; i += ANALYZE_CHUNK) {
            const part = folders.slice(i, i + ANALYZE_CHUNK);
            const res = await api(path, { method: 'POST', body: JSON.stringify({ ...body, folders: part }) });
            out.push(...(res.projects || []));
            onProgress(Math.min(i + ANALYZE_CHUNK, folders.length));
        }
        return out;
    }
    async function loadWorkspace() {
        wsRegion.replaceChildren(el('p', { class: 'admin-hint', text: '워크스페이스 계산 중… (프로젝트가 많으면 몇 초 걸립니다)' }));
        analyzed.clear();
        selected.clear();
        try {
            wsList = await api('/api/ui/org/workspace');
        }
        catch (e) {
            wsRegion.replaceChildren(el('p', { class: 'admin-hint', text: '불러오지 못했습니다: ' + e.message }));
            return;
        }
        renderWorkspace();
    }
    function renderWorkspace() {
        const all = (wsList.projects || []).filter((p) => p.folder);
        // 레포(워크트리)가 있는 것만 정리 대상 — 나머지는 '정리할 것이 없는' 정상 폴더다(에러가 아니다).
        const targets = all.filter((p) => p.repos > 0);
        const empties = all.filter((p) => !p.repos);
        const emptyBytes = empties.reduce((s, p) => s + (p.bytes ?? 0), 0);
        // 이 프로젝트의 워크트리 중 하나라도 작업 중인 세션이 붙어 있나 — 붙어 있으면 정리 대상으로 고르지 않는다.
        const hasActive = (pr) => (pr.results || []).some((r) => r.active_session);
        // ── 상단: 일괄 분석 ──
        const progress = el('span', { class: 'storage-calc', text: '' });
        const analyzeAllBtn = el('button', { class: 'btn btn-sm', text: `전체 분석 (${targets.length}개)` });
        analyzeAllBtn.disabled = !canEdit || !targets.length;
        analyzeAllBtn.addEventListener('click', async () => {
            analyzeAllBtn.disabled = true;
            const folders = targets.map((p) => p.folder);
            try {
                const res = await runBatch('/api/ui/org/workspace/analyze', folders, {}, (done) => { progress.textContent = `  분석 중… ${done}/${folders.length}`; });
                for (const pr of res)
                    if (pr.folder)
                        analyzed.set(pr.folder, pr);
                // 정리할 게 있는 것만 미리 골라둔다 — 관리자가 끄는 게 하나씩 켜는 것보다 빠르다.
                // 작업 중인 세션이 붙은 건 **켜지 않는다**(서버도 거부하지만, 애초에 고르지 않는 게 정직하다).
                for (const pr of res)
                    if (pr.reclaimable_bytes > 0 && !hasActive(pr))
                        selected.add(pr.folder);
                renderWorkspace();
            }
            catch (e) {
                toast(e.message, true);
                analyzeAllBtn.disabled = false;
                progress.textContent = '';
            }
        });
        // ── 상단: 선택 정리 ──
        const selFolders = [...selected].filter((f) => (analyzed.get(f)?.reclaimable_bytes ?? 0) > 0);
        const selBytes = selFolders.reduce((s, f) => s + (analyzed.get(f)?.reclaimable_bytes ?? 0), 0);
        const reclaimSelBtn = el('button', { class: 'btn btn-primary btn-sm', text: `선택 정리 (${selFolders.length}개 · ${fmtBytes(selBytes)})` });
        reclaimSelBtn.disabled = !canEdit || !selFolders.length;
        reclaimSelBtn.addEventListener('click', async () => {
            if (!confirm(`${selFolders.length}개 프로젝트에서 파생물 ${fmtBytes(selBytes)} 를 지웁니다.\n\nnode_modules·빌드 산출물 등 다시 만들 수 있는 것만 지웁니다. 소스·커밋·.env·data/ 는 건드리지 않고, 워크트리도 유지합니다.\n\n계속할까요?`))
                return;
            reclaimSelBtn.disabled = true;
            try {
                const res = await runBatch('/api/ui/org/workspace/reclaim', selFolders, { remove_worktree: false }, (done) => { progress.textContent = `  정리 중… ${done}/${selFolders.length}`; });
                const freed = res.reduce((s, pr) => s + (pr.freed_bytes || 0), 0);
                toast(`정리 완료 — ${fmtBytes(freed)} 확보 (${res.length}개 프로젝트)`);
                loadWorkspace();
            }
            catch (e) {
                toast(e.message, true);
                reclaimSelBtn.disabled = false;
                progress.textContent = '';
            }
        });
        // ── 정리 대상 행 ──
        const rows = targets.map((p) => {
            const pr = analyzed.get(p.folder);
            const detail = el('div');
            const right = [];
            if (p.active_session)
                right.push(el('span', { class: 'storage-lv storage-lv-warn', text: '작업 중' }));
            if (p.orphan)
                right.push(el('span', { class: 'storage-lv storage-lv-warn', text: '고아' }));
            if (p.kind === 'archived')
                right.push(el('span', { class: 'storage-lv storage-lv-ok', text: '완료 보관' }));
            let head;
            if (!pr) {
                const btn = el('button', { class: 'btn btn-sm', text: '분석' });
                btn.disabled = !canEdit;
                btn.addEventListener('click', async () => {
                    btn.disabled = true;
                    detail.replaceChildren(el('p', { class: 'storage-calc', text: '확인 중…' }));
                    try {
                        const res = await api('/api/ui/org/workspace/analyze', { method: 'POST', body: JSON.stringify({ folders: [p.folder] }) });
                        const one = (res.projects || [])[0];
                        if (one)
                            analyzed.set(p.folder, one);
                        if (one?.reclaimable_bytes > 0 && !hasActive(one))
                            selected.add(p.folder);
                        renderWorkspace();
                    }
                    catch (e) {
                        detail.replaceChildren(el('p', { class: 'storage-calc', text: '실패: ' + e.message }));
                        btn.disabled = false;
                    }
                });
                right.push(btn);
                head = el('span', { class: 'storage-calc', text: `  ${fmtBytes(p.bytes ?? 0)} · ${p.last_used ? relTime(p.last_used * 1000) : '—'}` });
            }
            else {
                const chk = el('input', { type: 'checkbox' });
                chk.checked = selected.has(p.folder);
                chk.disabled = !canEdit || !(pr.reclaimable_bytes > 0) || hasActive(pr);
                chk.addEventListener('change', () => {
                    if (chk.checked)
                        selected.add(p.folder);
                    else
                        selected.delete(p.folder);
                    renderWorkspace(); // 상단 [선택 정리] 합계를 다시 그린다
                });
                right.unshift(chk);
                head = el('span', { class: 'storage-calc', text: `  ${fmtBytes(p.bytes ?? 0)} · 정리 가능 ${fmtBytes(pr.reclaimable_bytes || 0)}` });
                for (const r of pr.results || []) {
                    const derived = r.derived || [];
                    detail.append(el('div', { class: 'ws-plan' }, el('p', { class: 'storage-calc', text: `${derived.map((d) => d.path + ' ' + fmtBytes(d.bytes)).join(' · ') || '정리할 파생물 없음'}` }), el('p', { class: 'storage-calc', text: r.worktree_removable ? '워크트리: 제거 가능(푸시 완료·변경 없음) — 여기서는 유지합니다' : `워크트리: 유지 — ${r.worktree_reason}` })));
                }
            }
            return el('div', { class: 'storage-item' }, el('div', { class: 'storage-head' }, el('span', {}, el('strong', { text: p.name || p.folder }), head), el('span', { class: 'ws-badges' }, ...right)), detail);
        });
        // ── 레포 없는 폴더: 접어두고 버튼도 주지 않는다 ──
        const emptyBox = el('div');
        const emptyToggle = el('button', { class: 'btn btn-ghost btn-sm', text: `레포 없는 폴더 ${empties.length}개 보기 (${fmtBytes(emptyBytes)})` });
        let emptyOpen = false;
        emptyToggle.addEventListener('click', () => {
            emptyOpen = !emptyOpen;
            emptyToggle.textContent = emptyOpen ? `레포 없는 폴더 접기` : `레포 없는 폴더 ${empties.length}개 보기 (${fmtBytes(emptyBytes)})`;
            emptyBox.replaceChildren(...(emptyOpen ? empties.map((p) => el('div', { class: 'storage-item' }, el('div', { class: 'storage-head' }, el('span', {}, el('strong', { text: p.name || p.folder }), el('span', { class: 'storage-calc', text: `  ${fmtBytes(p.bytes ?? 0)} · ${p.last_used ? relTime(p.last_used * 1000) : '—'}` })), el('span', { class: 'ws-badges' }, ...(p.orphan ? [el('span', { class: 'storage-lv storage-lv-warn', text: '고아' })] : []))))) : []));
        });
        wsRegion.replaceChildren(el('p', { class: 'storage-calc', text: `${all.length}개 폴더 · 합계 ${fmtBytes(wsList.total_bytes)} — ${wsList.root}` }), el('div', { class: 'ws-actions' }, analyzeAllBtn, reclaimSelBtn, progress), el('p', { class: 'admin-hint', text: '[전체 분석]은 아무것도 지우지 않습니다 — 무엇을 정리할 수 있는지만 계산합니다. 정리 대상은 다시 만들 수 있는 것뿐입니다(node_modules·빌드 산출물 등). 소스·커밋·설정(.env)·데이터는 절대 지우지 않고, 워크트리도 유지합니다. 작업 중인 세션이 있는 프로젝트는 선택되지 않습니다.' }), ...(rows.length ? rows : [el('p', { class: 'admin-hint', text: '정리할 워크트리가 있는 프로젝트가 없습니다.' })]), ...(empties.length ? [
            el('p', { class: 'admin-hint', text: `아래는 git 레포(워크트리)가 없는 폴더입니다 — 정리할 파생물이 없어 정상이며, 지울 것도 없습니다(대부분 12KB 안팎).` }),
            emptyToggle, emptyBox,
        ] : []));
    }
    load();
}
// 로그(#1059 — '컴퓨팅 리소스'에서 분리한 별도 메뉴). 게이트웨이 로그 파일 크기 + 회전(보관) 정책.
//  데이터 출처는 저장소와 같은 /api/ui/org/storage(logs·policy.log_*). 저장은 storage_policy 의 log 필드만(병합 — 디스크·메모리 보존).
function logsEditor(detail, data) {
    const canEdit = !!data.canEdit;
    const body = el('div');
    detail.replaceChildren(sectionHead('로그', '게이트웨이 로그 파일이 얼마나 쌓였는지 확인하고, 무한히 자라지 않도록 회전(보관) 상한을 정합니다. 저장하면 즉시 반영됩니다(재시작 불필요).'), el('div', { class: 'card' }, body));
    body.append(el('p', { class: 'admin-hint', text: '불러오는 중…' }));
    async function load() {
        let st;
        try {
            st = await api('/api/ui/org/storage');
        }
        catch (e) {
            body.replaceChildren(el('p', { class: 'admin-hint', text: '상태를 불러오지 못했습니다: ' + e.message }));
            return;
        }
        build(st);
    }
    function build(st) {
        const p = st.policy || {};
        const logs = st.logs || { files: [], totalBytes: 0, capBytes: 0, dir: '' };
        const current = (logs.files || []).filter((f) => !f.rotated);
        const kept = (logs.files || []).filter((f) => f.rotated);
        const logLine = logs.capBytes > 0
            ? `현재 ${fmtBytes(logs.totalBytes)} — 정책상 최대 ${fmtBytes(logs.capBytes)}로 제한됩니다`
            : `현재 ${fmtBytes(logs.totalBytes)} — ⚠ 회전이 꺼져 있어 상한이 없습니다`;
        const logDetail = (logs.files || []).length
            ? el('p', { class: 'storage-calc', text: `현재 로그 ${current.length}개 · 보관본 ${kept.length}개 (${(logs.files || []).slice(0, 4).map((f) => f.name + ' ' + fmtBytes(f.bytes)).join(' · ')})` })
            : el('p', { class: 'storage-calc', text: '로그 파일 없음' });
        const numIn = (val, min, max) => {
            const i = el('input', { class: 'input input-num', type: 'number', min: String(min), max: String(max) });
            i.value = String(val);
            i.disabled = !canEdit;
            return i;
        };
        const logMaxIn = numIn(p.log_max_mb ?? 50, 0, 10000);
        const logKeepIn = numIn(p.log_keep ?? 3, 0, 50);
        const logCalc = el('p', { class: 'storage-calc' });
        const recalc = () => {
            const mb = Number(logMaxIn.value) || 0;
            const keep = Number(logKeepIn.value) || 0;
            logCalc.textContent = mb <= 0
                ? '⚠ 0 = 회전 끔 — 로그가 무한히 쌓입니다(권장하지 않음).'
                : `→ 로그가 차지할 수 있는 최대 용량: ${fmtBytes(mb * 1024 * 1024 * (keep + 1))} (${mb}MB 씩 현재 1개 + 보관 ${keep}개)`;
        };
        logMaxIn.addEventListener('input', recalc);
        logKeepIn.addEventListener('input', recalc);
        recalc();
        const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '정책 저장' });
        saveBtn.disabled = !canEdit;
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            try {
                // storage_policy 병합 저장 — log 필드만 보낸다(디스크·메모리 임계는 컴퓨팅 리소스 탭에서 관리, 서버가 보존).
                await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ storage_policy: { log_max_mb: Number(logMaxIn.value), log_keep: Number(logKeepIn.value) } }) });
                toast('저장됨 — 즉시 반영됩니다(재시작 불필요).');
                load();
            }
            catch (e) {
                toast(e.message, true);
                saveBtn.disabled = false;
            }
        });
        const srcNote = st.policy_source === 'env'
            ? el('p', { class: 'admin-hint', text: '현재 값은 서버 환경변수(.env) 시드입니다 — 여기서 저장하면 관리탭 설정이 우선합니다.' })
            : st.policy_source === 'default'
                ? el('p', { class: 'admin-hint', text: '아직 설정한 적이 없어 기본값으로 동작 중입니다.' })
                : null;
        body.replaceChildren(el('h3', { class: 'storage-h', text: '지금 상태' }), el('div', { class: 'storage-block' }, el('div', { class: 'storage-head' }, el('strong', { text: '로그' })), el('p', { class: 'storage-calc' }, el('code', { text: logs.dir || '' })), el('p', { class: 'storage-calc', text: logLine }), logDetail), el('h3', { class: 'storage-h', text: '정책' }), ...(srcNote ? [srcNote] : []), el('div', { class: 'storage-block' }, el('strong', { text: '로그 보관' }), el('div', { class: 'storage-fields' }, el('label', {}, el('span', { text: '파일 1개 최대(MB)' }), logMaxIn), el('label', {}, el('span', { text: '보관 개수' }), logKeepIn)), logCalc, el('p', { class: 'admin-hint', text: '상한을 넘으면 자동으로 회전합니다(내용은 보관본으로 넘기고 현재 파일은 비웁니다). 서비스는 멈추지 않습니다.' }), el('div', { class: 'storage-actions' }, saveBtn)));
    }
    load();
}
// 세션(#1059 F b/c) — 이 박스의 전 중앙 세션 메타뷰 + 수동 회수. admin 전용(/api/ui/terminal/admin/sessions).
//  회수(reclaim=1)는 tmux 만 종료하고 desired-state 를 보존 → 사용자가 목록에서 '복원 가능'으로 다시 연다(파괴적 삭제 아님).
//  managed(상시)는 keep-alive 가 되살리므로 회수 버튼을 막고, 접속중·작업중 세션은 admin 이 회수 가능하나(긴급 override) 확인창으로 한번 더.
function sessionsAdminEditor(detail, data) {
    const canEdit = !!data.canEdit; // admin scope
    const body = el('div');
    detail.replaceChildren(sectionHead('세션', '이 박스에서 지금 도는 모든 AI 세션입니다. 안 쓰는 세션이 쌓이면 메모리가 말라 박스가 멈출 수 있어요(#1059) — 여기서 보고 오래 쉬는 세션을 회수하세요. 회수해도 대화·설정은 보존돼 사용자가 다시 열 수 있습니다(파괴적 삭제 아님).'), el('div', { class: 'card' }, body));
    body.append(el('p', { class: 'admin-hint', text: '불러오는 중…' }));
    const memberName = (id) => { const m = (data.members || []).find((x) => x.id === id); return m ? (m.display_name || m.id) : (id || '?'); };
    const shortDir = (d) => { if (!d)
        return '—'; const parts = String(d).split('/').filter(Boolean); return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : d; };
    const STMAP = { busy: ['작업 중', 'busy'], waiting: ['확인 필요', 'waiting'], idle: ['대기 중', 'idle'], exited: ['종료됨', 'exited'], offline: ['연결 끊김', 'offline'] };
    const agoText = (sec) => { if (!sec)
        return '기록 없음'; const dd = Math.floor(Date.now() / 1000) - Number(sec); if (dd < 60)
        return '방금'; if (dd < 3600)
        return Math.floor(dd / 60) + '분 전'; if (dd < 86400)
        return Math.floor(dd / 3600) + '시간 전'; return Math.floor(dd / 86400) + '일 전'; };
    async function load() {
        let d;
        try {
            d = await api('/api/ui/terminal/admin/sessions');
        }
        catch (e) {
            body.replaceChildren(el('p', { class: 'admin-hint', text: '불러오지 못했습니다: ' + e.message }));
            return;
        }
        build((d && d.sessions) || []);
    }
    function build(sessions) {
        // 상태 우선 정렬(작업중·확인필요 = 건드리면 안 되는 것을 위로 인지) → 그 안에서 최근 작업순.
        const rank = { busy: 0, waiting: 1, idle: 2, exited: 3, offline: 4 };
        const rows = [...sessions].sort((a, b) => (rank[a.agentState] ?? 9) - (rank[b.agentState] ?? 9) || (Number(b.lastActive) || 0) - (Number(a.lastActive) || 0));
        const summary = el('p', { class: 'admin-hint', text: `총 ${sessions.length}개 · 접속 중 ${sessions.filter((s) => s.attached).length}개 · 상시 ${sessions.filter((s) => s.managed).length}개. 회수는 tmux 만 종료하고 대화·설정을 보존합니다(사용자가 “복원 가능”으로 다시 엶).` });
        const list = el('div', { class: 'sess-admin-list' });
        if (!rows.length)
            list.append(el('p', { class: 'admin-hint', text: '지금 도는 세션이 없습니다.' }));
        for (const s of rows) {
            const [lbl, cls] = STMAP[s.agentState] || STMAP.offline;
            const headline = (s.title && s.title !== s.label ? s.title : s.label) || '(이름 없음)';
            const reclaimBtn = el('button', { class: 'btn btn-sm btn-danger', text: '회수' });
            reclaimBtn.disabled = !canEdit || !!s.managed;
            if (s.managed)
                reclaimBtn.title = '상시(managed) 세션은 keep-alive 가 되살리므로 회수 대상이 아닙니다.';
            reclaimBtn.addEventListener('click', async () => {
                const inUse = s.attached || s.agentState === 'busy' || s.agentState === 'waiting';
                const warn = inUse ? '\n\n⚠ 지금 사용 중(접속/작업/대기)입니다 — 회수하면 진행 화면이 끊깁니다(대화는 보존, 다시 열 수 있음).' : '';
                if (!confirm(`세션 “${s.label || s.id}”을(를) 회수할까요?\n메모리를 되찾고 “복원 가능” 목록에 남습니다(대화·설정 보존).${warn}`))
                    return;
                reclaimBtn.disabled = true;
                reclaimBtn.textContent = '회수 중…';
                try {
                    await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '?reclaim=1', { method: 'DELETE' });
                    toast('회수했어요 — 복원 가능 목록에 남습니다.');
                    load();
                }
                catch (e) {
                    toast(e.message, true);
                    reclaimBtn.disabled = false;
                    reclaimBtn.textContent = '회수';
                }
            });
            list.append(el('div', { class: 'sess-admin-row' }, el('span', { class: 'sess-admin-dot sess-admin-dot-' + cls, title: lbl }), el('div', { class: 'sess-admin-main' }, el('div', { class: 'sess-admin-title', title: headline, text: headline }), el('div', { class: 'sess-admin-meta', text: `${memberName(s.owner)} · ${s.harness || 'shell'}${s.projectId ? ' · 프로젝트 #' + s.projectId : ''}${s.managed ? ' · 상시' : ''} · 📁 ${shortDir(s.dir)}` })), el('span', { class: 'sess-admin-st sess-admin-st-' + cls, text: lbl }), el('span', { class: 'sess-admin-when', text: (s.attached ? '접속 중 · ' : '') + agoText(s.lastActive) }), reclaimBtn));
        }
        const refresh = el('button', { class: 'btn btn-sm', text: '새로고침' });
        refresh.addEventListener('click', load);
        body.replaceChildren(summary, list, el('div', { class: 'storage-actions' }, refresh));
    }
    load();
}
// 세션 공유(세션이력 캡처) 정책(#905 C1) — 관리탭 ▸ 세션 공유. runtimeConfig.session_share 를 읽고 POST 로 저장.
//  프라이버시가 걸린 설정이라 **무엇이 캡처되는지·기본이 꺼짐인지**를 화면에서 분명히 말한다.
function sessionShareEditor(detail, data) {
    const rc = data.runtimeConfig; // admin 만 non-null
    const canEdit = !!data.canEdit && !!rc;
    const DEF = { enabled: false, harnesses: ['claude'], scope: 'main', store: 'slim', retention_days: 30, view_policy: 'attach', resume_policy: 'owner' };
    const body = el('div');
    detail.replaceChildren(sectionHead('세션 공유', '구성원의 AI 대화 기록을 중앙에 모아, 다른 컴퓨터·다른 사람이 이어서 보고 이어받게 합니다. 대화 전문이 저장되므로 기본은 꺼져 있습니다.'), el('div', { class: 'card' }, cardHead('세션 공유 설정'), body));
    if (!rc) {
        body.append(el('p', { class: 'admin-hint', text: '이 설정은 관리자(admin)만 볼 수 있습니다.' }));
        return;
    }
    build();
    function build() {
        // ⚠ 저장 후 재렌더는 **data.runtimeConfig(최신)** 를 다시 읽는다 — 캡처된 옛 rc 를 쓰면 저장돼도 체크가 풀린다
        //  (save 는 data.runtimeConfig 를 갱신하지 rc 를 안 바꾼다 — 스테일 클로저 버그).
        const rcNow = data.runtimeConfig;
        const ss = { ...DEF, ...((rcNow && rcNow.session_share) || {}) };
        body.replaceChildren();
        // ── 마스터 스위치 ──
        const enChk = el('input', { type: 'checkbox' });
        enChk.checked = ss.enabled === true;
        enChk.disabled = !canEdit;
        const enRow = el('label', { class: 'admin-check' }, enChk, el('span', { text: ' 세션 대화 기록 수집 켜기 — 켜면 아래 하네스의 세션 트랜스크립트가 중앙에 저장됩니다' }));
        // ── 하네스 ──
        const hSet = new Set(Array.isArray(ss.harnesses) ? ss.harnesses : ['claude']);
        const hChk = (key, label, note) => {
            const c = el('input', { type: 'checkbox' });
            c.checked = hSet.has(key);
            c.disabled = !canEdit;
            c.addEventListener('change', () => { if (c.checked)
                hSet.add(key);
            else
                hSet.delete(key); });
            return el('label', { class: 'admin-check' }, c, el('span', { text: ' ' + label }), note ? el('span', { class: 'admin-hint', text: '  ' + note }) : null);
        };
        const harnessRows = el('div', {}, hChk('claude', 'Claude Code', ''), hChk('codex', 'Codex', '구조적으로 별도 처리 필요 — 현재 파이프라인 미지원(실험)'));
        // ── select 헬퍼 ──
        const sel = (opts, val) => {
            const s = el('select', { class: 'input' }, ...opts.map(([v, t]) => el('option', { value: v, text: t })));
            s.value = val;
            s.disabled = !canEdit;
            return s;
        };
        const scopeSel = sel([['main', '주 대화만'], ['tree', '주 대화 + 서브에이전트(트리 전체)']], ss.scope);
        const storeSel = sel([['slim', '슬림 — 서명·툴결과·토큰통계 제거(본문 유지, 용량↓)'], ['raw', '원본 그대로(용량↑)']], ss.store);
        const viewSel = sel([['attach', '세션 입장 가능자'], ['owner', '세션 소유자만']], ss.view_policy);
        const retIn = el('input', { class: 'input input-num', type: 'number', min: '0', max: '3650' });
        retIn.value = String(ss.retention_days ?? 30);
        retIn.disabled = !canEdit;
        const field = (label, ctrl, hint) => el('div', { class: 'admin-field' }, el('label', { class: 'admin-field-label', text: label }), ctrl, hint ? el('p', { class: 'admin-hint', text: hint }) : null);
        const saveBtn = el('button', { class: 'btn btn-primary', text: '저장', disabled: !canEdit });
        saveBtn.addEventListener('click', async () => {
            // 하네스 0개로 켜기 = 무의미(서버가 조용히 기본값으로 되돌린다). 사용자에게 이유를 말하고 막는다(무언 되돌림 방지).
            if (enChk.checked && hSet.size === 0) {
                toast('수집할 하네스를 하나 이상 선택하세요', true);
                return;
            }
            saveBtn.disabled = true;
            try {
                const patch = {
                    enabled: enChk.checked,
                    harnesses: [...hSet],
                    scope: scopeSel.value, store: storeSel.value, view_policy: viewSel.value,
                    retention_days: Math.max(0, Math.min(3650, Math.floor(Number(retIn.value) || 0))),
                };
                const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ session_share: patch }) });
                if (r && r.runtimeConfig)
                    data.runtimeConfig = r.runtimeConfig;
                toast('세션 공유 설정 저장됨 — 구성원 다음 세션부터 반영');
                build();
            }
            catch (e) {
                toast(e.message, true);
                saveBtn.disabled = !canEdit;
            }
        });
        body.append(el('div', { class: 'card-sub' }, enRow), field('수집할 하네스', harnessRows, null), field('수집 범위', scopeSel, null), field('저장 형태', storeSel, null), field('보존 기간(일)', retIn, '0 = 무제한(디스크 주의). 지난 기록은 자동 정리됩니다.'), field('기록 열람 권한', viewSel, '중앙에 모인 대화를 누가 열람·이어받을 수 있는지.'), canEdit ? el('div', { class: 'admin-actions' }, saveBtn)
            : el('p', { class: 'admin-hint', text: '읽기 전용 — 변경은 관리자(admin) 권한이 필요합니다.' }));
    }
}
function embeddingsEditor(detail, data) {
    const canEdit = !!data.canEdit;
    const body = el('div');
    detail.replaceChildren(sectionHead('의미 검색 (임베딩)', 'AI와 사람이 지식을 단어가 아니라 뜻으로 찾게 합니다. 꺼 두면 단어가 그대로 들어간 지식만 찾습니다.'), el('div', { class: 'card' }, cardHead('의미 검색 상태와 설정'), body));
    body.append(el('p', { class: 'admin-hint', text: '불러오는 중…' }));
    let pollTimer = null;
    const stopPoll = () => { if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    } };
    let projPollTimer = null;
    const stopProjPoll = () => { if (projPollTimer) {
        clearTimeout(projPollTimer);
        projPollTimer = null;
    } };
    // #1060 자동 백필 일시중지 컨트롤 — knowledge·project 백필을 함께 지배하므로 두 섹션 위에 한 번만 둔다.
    //  buildOnce 가 region 을 만들어 여기 담고, knowledge 폴링(updateStatus)이 최신 paused 로 재렌더해 상태를 항상 신선하게 유지.
    let pauseRegion = null;
    // 일시중지/재개 토글 + 상태 배너. paused=true 면 코랄 경고(자동·수동 백필 모두 멈춤), false 면 평상 힌트.
    function renderPauseControl(paused, region) {
        if (!region)
            return;
        const btn = el('button', { class: 'btn btn-sm', text: paused ? '자동 백필 재개' : '자동 백필 일시중지' });
        btn.disabled = !canEdit;
        const note = el('div');
        if (paused) {
            note.className = 'admin-warn';
            note.replaceChildren(el('div', { text: '⏸ 자동 임베딩 백필이 일시중지되었습니다.' }), el('div', { text: '자동 스윕(부팅·10분 주기·동기화 후·저장 시)과 수동 백필이 모두 멈춰 있습니다. 새로 쌓이는 미임베딩은 재개할 때까지 채워지지 않습니다(그동안 검색은 grep 폴백으로 동작). 재개하면 그동안 밀린 항목을 이어서 채웁니다. 이 설정은 게이트웨이 재시작 후에도 유지됩니다.' }));
        }
        else {
            note.className = 'admin-hint';
            note.textContent = '자동 백필이 켜져 있습니다(정상 동작). 성능 등의 이유로 멈추려면 일시중지하세요 — 실행 중이던 백필도 곧 멈춥니다.';
        }
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                await api('/api/ui/org/embeddings/backfill/pause', { method: 'POST', body: JSON.stringify({ paused: !paused }) });
                toast(!paused ? '자동 백필을 일시중지했습니다.' : '자동 백필을 재개했습니다 — 밀린 항목을 채웁니다.');
                load(); // paused 상태·양쪽 백필 버튼 게이트를 한번에 재계산
            }
            catch (e) {
                toast(e.message, true);
                btn.disabled = false;
            }
        });
        region.replaceChildren(note, canEdit ? el('div', { class: 'admin-actions' }, btn) : el('p', { class: 'admin-hint', text: '※ 편집은 관리자만 가능합니다.' }));
    }
    async function load() {
        let st;
        try {
            st = await api('/api/ui/org/embeddings');
        }
        catch (e) {
            body.replaceChildren(el('p', { class: 'admin-hint', text: '상태를 불러오지 못했습니다: ' + e.message }));
            return;
        }
        buildOnce(st);
    }
    // 폼(설정 입력)은 한 번만 짓는다 — 폴링은 statusRegion 만 갱신해 입력 중 리셋되지 않게.
    function buildOnce(st) {
        stopPoll();
        stopProjPoll();
        const cfg = st.config || { provider: 'off', base_url: null, model: null, dimensions: 1024, auth_env_ref: null };
        const on = cfg.provider === 'http';
        const provSel = el('select', { class: 'input' }, el('option', { value: 'off', text: '꺼짐 — grep 검색으로 폴백' }), el('option', { value: 'http', text: '켜짐 — HTTP /v1/embeddings' }));
        provSel.value = on ? 'http' : 'off';
        provSel.disabled = !canEdit;
        const baseIn = el('input', { class: 'input', type: 'text', placeholder: 'http://localhost:11434  (로컬 Ollama 사이드카)' });
        baseIn.value = cfg.base_url || '';
        baseIn.disabled = !canEdit;
        const modelIn = el('input', { class: 'input', type: 'text', placeholder: 'bge-m3  (한국어 강화 = KURE-v1, 둘 다 1024차원)' });
        modelIn.value = cfg.model || '';
        modelIn.disabled = !canEdit;
        const dimIn = el('input', { class: 'input emb-num', type: 'number', min: '1', max: '16000', placeholder: '1024' });
        dimIn.value = String(cfg.dimensions || 1024);
        dimIn.disabled = !canEdit;
        const authIn = el('input', { class: 'input', type: 'text', placeholder: '예: OPENAI_API_KEY' });
        authIn.value = cfg.auth_env_ref || '';
        authIn.disabled = !canEdit;
        // 성능 튜닝(#602) — 느린/CPU 백엔드는 배치를 낮춰 요청당 시간을 타임아웃 안으로.
        const batchIn = el('input', { class: 'input emb-num', type: 'number', min: '1', max: '512', placeholder: '8  (CPU 백엔드 권장 4~8)' });
        batchIn.value = String(cfg.batch_size || 8);
        batchIn.disabled = !canEdit;
        const timeoutIn = el('input', { class: 'input emb-num', type: 'number', min: '1000', max: '3600000', placeholder: '300000  (요청당 ms)' });
        timeoutIn.value = String(cfg.request_timeout_ms || 300000);
        timeoutIn.disabled = !canEdit;
        // #1059 G3 — 백필 pre-flight 메모리 게이트: 가용 메모리가 이 값 미만이면 자동 백필 스윕을 건너뛴다(0=끔).
        const backfillMinIn = el('input', { class: 'input emb-num', type: 'number', min: '0', max: '1048576', placeholder: '0  (끔; 16GB 박스 권장 4096~5000)' });
        backfillMinIn.value = String(cfg.backfill_min_available_mb || 0);
        backfillMinIn.disabled = !canEdit;
        const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '설정 저장' });
        saveBtn.disabled = !canEdit;
        const saveSt = el('span', { class: 'admin-status' });
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            saveSt.textContent = '';
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
                    backfill_min_available_mb: Number(backfillMinIn.value) || 0, // #1059 G3 — 백필 pre-flight 메모리 게이트(0=끔)
                };
                const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ embedding_config }) });
                if (r && r.runtimeConfig)
                    data.runtimeConfig = r.runtimeConfig;
                toast(provSel.value === 'http' ? '임베딩 켜짐 — 기존 지식은 아래 [백필]로 채우세요.' : '저장됨 — 임베딩 꺼짐(서버 .env 시드도 무시됩니다)');
                load(); // 상태 새로고침(백로그·백필 버튼 활성 재계산)
            }
            catch (e) {
                toast(e.message, true);
                saveBtn.disabled = false;
            }
        });
        // #688 설정 출처 안내 — env 시드로 도는지 / 명시적 off 인지(관리탭 저장과 .env 의 우선순위 혼동 방지).
        const srcNote = st.config_source === 'env'
            ? el('p', { class: 'admin-hint', text: '현재 설정은 서버 환경변수(.env EMBEDDINGS_*) 시드로 동작 중입니다 — 여기서 저장하면 관리탭(DB) 설정이 우선하게 됩니다.' })
            : st.config_source === 'db-off'
                ? el('p', { class: 'admin-hint', text: '관리탭에서 명시적으로 꺼둔 상태입니다 — 서버 .env 의 EMBEDDINGS_* 시드는 무시됩니다(다시 켜려면 여기서 켜기 저장).' })
                : null;
        const statusRegion = el('div');
        const projectRegion = el('div');
        pauseRegion = el('div'); // #1060 — updateStatus 가 st.backfill_paused 로 채운다(초기·폴링 공통)
        body.replaceChildren(...(srcNote ? [srcNote] : []), field('벡터 임베딩', provSel), field('엔드포인트 base_url', baseIn), el('p', { class: 'admin-hint', text: '로컬 사이드카 또는 외부 API 주소입니다. 경로 /v1/embeddings 는 자동으로 붙습니다.' }), field('모델', modelIn), field('차원', dimIn), el('p', { class: 'admin-hint', text: '모델의 출력 차원과 일치해야 합니다. 변경하면 전체 재임베딩이 필요합니다.' }), field('인증 환경변수 이름 (선택 · 외부 API 용)', authIn), el('p', { class: 'admin-hint', text: '키 값이 아니라 키를 담은 환경변수의 이름을 입력합니다.' }), field('배치 크기', batchIn), el('p', { class: 'admin-hint', text: '요청당 보내는 텍스트 수입니다. 느린 백엔드나 CPU 백엔드에서는 낮추면 타임아웃을 피할 수 있습니다(기본 8).' }), field('요청 타임아웃 (ms)', timeoutIn), el('p', { class: 'admin-hint', text: '초과하면 배치를 반으로 줄여 재시도합니다(기본 300000).' }), field('백필 메모리 게이트 (MB, 0=끔)', backfillMinIn), el('p', { class: 'admin-hint', text: '#1059 — 자동 백필이 임베딩 모델(예: Ollama)을 호출하기 전 가용 메모리를 확인해, 이 값 미만이면 이번 스윕을 건너뜁니다(다음 주기 재시도, 밀린 항목 유실 없음). 모델 로드 스파이크가 세션 baseline 과 겹쳐 박스가 OOM 나는 걸 예방합니다. 0=끔(무회귀). 16GB 박스 권장 4096~5000. 수동 백필 버튼은 게이트하지 않습니다.' }), canEdit ? el('div', { class: 'admin-actions' }, saveBtn, saveSt) : el('p', { class: 'admin-hint', text: '※ 편집은 관리자만 가능합니다.' }), 
        // #1060 자동 백필 일시중지 — knowledge·project 를 함께 지배하므로 두 백필 섹션 위에. 임베딩 켜진 경우에만 노출(꺼지면 백필 자체가 무의미).
        ...(on ? [
            el('div', { class: 'admin-subhead', text: '자동 임베딩 백필' }),
            el('p', { class: 'admin-hint', text: '저장·수정·동기화, 그리고 부팅·10분 주기 스윕으로 쌓이는 미임베딩을 게이트웨이가 백그라운드에서 자동으로 채웁니다. 임베딩 백엔드가 느리거나(CPU) 성능에 영향을 줄 때는 아래에서 일시중지하세요 — 재개할 때까지 자동·수동 백필이 모두 멈추고, 재개하면 그동안 밀린 항목을 이어서 채웁니다.' }),
            pauseRegion,
        ] : []), el('div', { class: 'admin-subhead', text: '기존 지식 임베딩 (임베딩을 나중에 켠 경우)' }), el('p', { class: 'admin-hint', text: '임베딩을 켜도 이미 저장된 지식은 자동으로 임베딩되지 않습니다(켠 이후에 새로 만들거나 수정한 지식만 자동 처리). 기존 지식은 아래 버튼으로 일괄 임베딩하세요 — 중단하거나 다시 실행해도 안전합니다.' }), statusRegion, el('div', { class: 'admin-subhead', text: '프로젝트 임베딩 (프로젝트·태스크·서브태스크 검색용)' }), el('p', { class: 'admin-hint', text: '프로젝트·태스크·서브태스크의 이름/설명을 임베딩합니다. 임베딩을 켠 이후에 생성·수정·동기화된 항목은 텍스트가 실제로 바뀔 때만 자동으로 임베딩되고, 기존 항목은 아래 버튼으로 일괄 임베딩합니다. 지식과 같은 임베딩 설정을 사용합니다.' }), projectRegion);
        updateStatus(st, statusRegion);
        loadProjectStatus(projectRegion);
    }
    // #688 백필 실패 사유별 처방 — 한 줄 reason 만으론 원인 파악이 어려웠던 실사례(어니스트 박스)의 판독표를 UI 로.
    function backfillReasonNotice(reason) {
        if (reason === 'off')
            return '임베딩 설정이 꺼져 있습니다 — 위에서 켠 뒤 저장하세요.';
        if (reason === 'unavailable')
            return '임베딩 엔드포인트 연결/응답 실패 — base_url 과 사이드카(예: Ollama 컨테이너) 상태를 확인하세요. 엔드포인트가 살아 있는데도 반복되면 과부하일 수 있습니다: 배치 크기를 줄이고(예 2) 요청 타임아웃을 늘려(예 600000) 저장 후 재시도하세요.';
        if (reason === 'schema')
            return 'pgvector 스키마가 없습니다 — items-db 컨테이너가 pgvector 이미지인지 확인하세요.';
        if (/timeout|abort/i.test(reason))
            return '임베딩 요청이 요청 타임아웃을 초과했습니다(느린 CPU 백엔드에서 흔함) — 배치 크기를 줄이고(예 2) 요청 타임아웃을 늘려(예 600000) 저장한 뒤 재시도하세요.';
        return '오류가 반복되면 게이트웨이 로그를 확인하세요.';
    }
    // 백로그·잡 진행만 갱신(폼은 그대로). 잡이 돌면 폴링.
    function updateStatus(st, region) {
        const cfg = st.config || { provider: 'off' };
        const on = cfg.provider === 'http';
        const backlog = st.backlog || { total: 0, pending: 0 };
        const job = st.job;
        const paused = !!st.backfill_paused; // #1060 — 일시중지면 수동 백필도 막고 배너를 띄운다
        const embedded = Math.max(0, (backlog.total || 0) - (backlog.pending || 0));
        const running = !!(job && job.running);
        // #1060 — 일시중지 컨트롤을 최신 상태로(초기 렌더·폴링 공통). on 일 때만 pauseRegion 이 존재.
        if (on)
            renderPauseControl(paused, pauseRegion);
        const bfBtn = el('button', { class: 'btn btn-sm', text: running ? '백필 진행 중…' : '기존 지식 임베딩(백필)' });
        bfBtn.disabled = !canEdit || !on || running || (backlog.pending || 0) === 0 || paused;
        const bfSt = el('span', { class: 'admin-status' });
        if (!on)
            bfSt.textContent = '먼저 임베딩을 켜고 저장하세요.';
        else if (paused)
            bfSt.textContent = '일시중지됨 — 위 [자동 임베딩 백필]에서 재개한 뒤 실행하세요.';
        else if ((backlog.pending || 0) === 0 && !running)
            bfSt.textContent = '모두 임베딩됨 ✓';
        bfBtn.addEventListener('click', async () => {
            bfBtn.disabled = true;
            try {
                await api('/api/ui/org/embeddings/backfill', { method: 'POST', body: JSON.stringify({ mode: 'pending' }) });
                toast('백필 시작 — 진행 상황을 표시합니다.');
                poll();
            }
            catch (e) {
                toast(e.message, true);
                bfBtn.disabled = false;
            }
        });
        const jobLine = el('div', { class: 'admin-hint' });
        if (job) {
            if (job.running)
                jobLine.textContent = `백필 진행: ${fmtNum(job.done)}/${fmtNum(job.total)} …`;
            else if (job.reason) {
                // #688 실패 사유 배너 — reason 원문 + 원인별 처방(admin-warn 코랄 박스).
                jobLine.className = 'admin-warn';
                jobLine.replaceChildren(el('div', { text: `⚠ 직전 백필 미완료: ${job.reason}` }), el('div', { text: backfillReasonNotice(String(job.reason)) }));
            }
            else if (job.finishedAt)
                jobLine.textContent = `직전 백필 완료: ${fmtNum(job.embedded)}건 (${absTime(job.finishedAt)}).`;
        }
        region.replaceChildren(el('p', { class: 'admin-hint', text: `기존 지식 ${fmtNum(backlog.total)}건 중 임베딩 ${fmtNum(embedded)}건 · 미임베딩 ${fmtNum(backlog.pending)}건.` }), jobLine, el('div', { class: 'admin-actions' }, bfBtn, bfSt));
        stopPoll();
        if (running)
            poll(region);
    }
    function poll(region) {
        stopPoll();
        pollTimer = setTimeout(async () => {
            if (!body.isConnected) {
                stopPoll();
                return;
            } // 다른 섹션으로 이동 → 폴링 종료(누수 방지)
            try {
                const st = await api('/api/ui/org/embeddings');
                const r = region || body.lastChild;
                // region 이 사라졌으면 전체 재빌드(안전) — 보통은 statusRegion 재갱신.
                if (r && r.replaceChildren)
                    updateStatus(st, r);
                else
                    buildOnce(st);
            }
            catch (_) {
                poll(region);
            } // 일시 실패 → 재시도
        }, 1500);
    }
    // 프로젝트 임베딩(#631/#624) 백필 — 지식 백필과 동형(대상만 project 엔드포인트). 같은 embedding_config 공유·자체 폴링.
    function renderProjectStatus(st, region) {
        const on = (st.config && st.config.provider) === 'http';
        const backlog = st.backlog || { total: 0, pending: 0 };
        const job = st.job;
        const paused = !!st.backfill_paused; // #1060 — knowledge 와 공통 스위치(같은 flag). 일시중지면 프로젝트 백필도 막는다.
        const embedded = Math.max(0, (backlog.total || 0) - (backlog.pending || 0));
        const running = !!(job && job.running);
        const bfBtn = el('button', { class: 'btn btn-sm', text: running ? '프로젝트 백필 진행 중…' : '프로젝트 임베딩(백필)' });
        bfBtn.disabled = !canEdit || !on || running || (backlog.pending || 0) === 0 || paused;
        const bfSt = el('span', { class: 'admin-status' });
        if (!on)
            bfSt.textContent = '먼저 임베딩을 켜고 저장하세요.';
        else if (paused)
            bfSt.textContent = '일시중지됨 — 위 [자동 임베딩 백필]에서 재개한 뒤 실행하세요.';
        else if ((backlog.pending || 0) === 0 && !running)
            bfSt.textContent = '모두 임베딩됨 ✓';
        bfBtn.addEventListener('click', async () => {
            bfBtn.disabled = true;
            try {
                await api('/api/ui/org/project-embeddings/backfill', { method: 'POST', body: JSON.stringify({ mode: 'pending' }) });
                toast('프로젝트 백필 시작 — 진행 상황을 표시합니다.');
                pollProj(region);
            }
            catch (e) {
                toast(e.message, true);
                bfBtn.disabled = false;
            }
        });
        const jobLine = el('div', { class: 'admin-hint' });
        if (job) {
            if (job.running)
                jobLine.textContent = `백필 진행: ${fmtNum(job.done)}/${fmtNum(job.total)} …`;
            else if (job.reason) {
                // #688 실패 사유 배너 — reason 원문 + 원인별 처방(admin-warn 코랄 박스).
                jobLine.className = 'admin-warn';
                jobLine.replaceChildren(el('div', { text: `⚠ 직전 백필 미완료: ${job.reason}` }), el('div', { text: backfillReasonNotice(String(job.reason)) }));
            }
            else if (job.finishedAt)
                jobLine.textContent = `직전 백필 완료: ${fmtNum(job.embedded)}건 (${absTime(job.finishedAt)}).`;
        }
        region.replaceChildren(el('p', { class: 'admin-hint', text: `프로젝트 ${fmtNum(backlog.total)}건 중 임베딩 ${fmtNum(embedded)}건 · 미임베딩 ${fmtNum(backlog.pending)}건.` }), jobLine, el('div', { class: 'admin-actions' }, bfBtn, bfSt));
        stopProjPoll();
        if (running)
            pollProj(region);
    }
    function pollProj(region) {
        stopProjPoll();
        projPollTimer = setTimeout(async () => {
            if (!body.isConnected) {
                stopProjPoll();
                return;
            } // 다른 섹션으로 이동 → 폴링 종료(누수 방지)
            try {
                const st = await api('/api/ui/org/project-embeddings');
                renderProjectStatus(st, region);
            }
            catch (_) {
                pollProj(region);
            } // 일시 실패 → 재시도
        }, 1500);
    }
    async function loadProjectStatus(region) {
        try {
            const st = await api('/api/ui/org/project-embeddings');
            renderProjectStatus(st, region);
        }
        catch (e) {
            region.replaceChildren(el('p', { class: 'admin-hint', text: '프로젝트 임베딩 상태를 불러오지 못했습니다: ' + e.message }));
        }
    }
    load();
}
// ── 훅 주입 미리보기(V4-P5 J절) — 설치된 3 세션 훅이 각자 세션에 실제로 주입하는 최종 메시지를 보여준다. ──
//  데이터 출처: GET /api/ui/org/hooks/preview (scope null = 인증만, REST 전용). 읽기 전용.
//  보안: 모든 데이터 텍스트는 textContent(el text:)/renderMarkdown(createElement+textContent) 로만 — innerHTML 데이터주입 0.
//  드리프트 정직성: 서버가 fidelity(exact/approximate)와 source 를 함께 주므로 그대로 표기(근사면 사유 명시).
function mcpEditor(detail, data) {
    const servers = data.mcpServers || [];
    const sel = state.admin.mcpSel;
    const listCol = el('div', { class: 'admin-sublist' });
    listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ MCP 서버 추가',
        onclick: () => { state.admin.mcpSel = '__new__'; renderAdminDetail(detail, 'mcp', data); } }));
    for (const s of servers) {
        listCol.append(el('div', { class: 'mini-row' + (s.name === sel ? ' sel' : ''),
            onclick: () => { state.admin.mcpSel = s.name; renderAdminDetail(detail, 'mcp', data); } }, el('div', { class: 'mini-title', text: s.name }, s.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null), el('div', { class: 'mini-meta', text: (s.transport || 'http') + ' · ' + (s.transport === 'stdio' ? (s.command || '-') : (s.url || '-')) })));
    }
    const right = el('div', {});
    const editing = sel === '__new__' ? { name: '', transport: 'http', url: '', command: '', auth_env: '', note: '', enabled: true } : servers.find((s) => s.name === sel);
    if (editing)
        mcpForm(right, editing, data, detail, sel === '__new__');
    else
        right.append(el('p', { class: 'admin-hint', text: 'lively 게이트웨이는 기본으로 등록되어 있습니다. 추가로 쓸 외부 도구 서버(MCP)를 여기서 등록합니다. 인증은 환경변수 이름만 적습니다(시크릿 값 입력 금지).' }));
    // 내부 MCP 안전범위(#837) — `allowed_internal_hosts` 는 서버·스키마·감사까지 다 있는데 **편집 UI 만 없었다.**
    //  runtime_config 1행을 5개 화면이 나눠 쓰는데 아무도 그 행 전체를 소유하지 않아 필드 하나가 통째로 샜다.
    //  증상: 내부 MCP 를 등록하면 SSRF 가드에 조용히 막히고, 에러가 "allowed_internal_hosts 등록 필요" 라며
    //  **관리탭에서 도달할 수 없는 필드 이름**을 댔다. 등록하다 막히는 바로 이 화면에 둔다.
    const rcMcp = data.runtimeConfig || { allowed_internal_hosts: [] };
    const mcpSafety = allowlistCard(data, '내부 접속 안전범위 (allowlist)', '사설·localhost 주소로 나가는 접속은 기본 전면 차단입니다(SSRF 방어). 여기 등록한 호스트만 통과합니다 — ①내부 MCP 서버 ②OAuth 브로커 ③내부 경보 웹훅 셋에 공통 적용됩니다. 외부 공인 주소(https)는 등록할 필요가 없습니다.', [
        { key: 'allowed_internal_hosts', label: '허용 내부 호스트 (allowed_internal_hosts)', initial: rcMcp.allowed_internal_hosts,
            placeholder: 'localhost\nmcp.internal.acme.com\n줄당 호스트 한 개(포트·경로 없이)' },
    ]);
    detail.replaceChildren(el('div', { class: 'card' }, cardHead('등록된 외부 도구 서버', '하네스가 호출할 수 있는 외부 MCP 서버입니다. 자료를 우리 DB 로 가져오는 [외부 자료 수집]과 반대로, 여기 등록된 서버는 세션에서 그때그때 호출됩니다.'), el('div', { class: 'admin-two admin-two-cols' }, listCol, right)), mcpSafety);
}
// 프록시 자격 종류 힌트(datalist) — 오타 방지용 제안. 신규 커넥터가 확장 가능(자유입력 허용).
const MCP_AUTH_KINDS = ['notion_oauth', 'slack_oauth', 'google_oauth', 'gitlab_pat', 'slack_user_token', 'notion_token', 'clickup_token', 'prometheus_bearer', 'figma_token'];
function mcpForm(root, s, data, detail, isNew) {
    const nameIn = el('input', { type: 'text', value: s.name, placeholder: '서버 이름(영문/숫자)', disabled: isNew ? null : '' });
    const transSel = el('select', {}, ...['http', 'stdio'].map((t) => el('option', { value: t, text: t })));
    transSel.value = s.transport || 'http';
    const urlIn = el('input', { type: 'text', value: s.url || '', placeholder: 'https://host/mcp' });
    const cmdIn = el('input', { type: 'text', value: s.command || '', placeholder: 'node /path/server.mjs --arg' });
    const authIn = el('input', { type: 'text', value: s.auth_env || '', placeholder: '예: ACME_TOKEN (값 아님)' });
    const noteIn = el('input', { type: 'text', value: s.note || '', placeholder: '설명(선택)' });
    const enChk = el('input', { type: 'checkbox' });
    enChk.checked = s.enabled !== false;
    const urlField = field('URL (http)', urlIn);
    const cmdField = field('command (stdio)', cmdIn);
    // ── 방식(mode) — client(멤버 클라 직접등록, 통제 없음) / proxy(게이트웨이가 대신 호출·통제·재노출, #746) ──
    const modeSel = el('select', {}, el('option', { value: 'client', text: 'client — 멤버 클라에 직접 등록(게이트웨이 통제 없음)' }), el('option', { value: 'proxy', text: 'proxy — 게이트웨이가 대신 호출(권한·PII·감사 통제)' }));
    modeSel.value = s.mode || 'client';
    const scopeSel = el('select', {}, ...['items', 'context', 'db', 'memory', 'code'].map((v) => el('option', { value: v, text: v })));
    scopeSel.value = s.scope || 'items';
    const levelSel = el('select', {}, el('option', { value: 'L0', text: 'L0 — 조회(read)' }), el('option', { value: 'L1', text: 'L1 — 제안(MR·draft)' }), el('option', { value: 'L2', text: 'L2 — 집행(개인 자격 필수)' }));
    levelSel.value = s.level || 'L0';
    const authModeSel = el('select', {}, el('option', { value: 'bearer', text: 'bearer — 정적 토큰(vault 저장)' }), el('option', { value: 'oauth', text: 'oauth — 구성원별 OAuth 연결' }), el('option', { value: 'sigv4', text: 'sigv4 — AWS 요청서명(역할 assume)' }));
    authModeSel.value = s.auth_mode || 'bearer';
    const kindsListId = 'mcp-auth-kinds';
    const kindsList = el('datalist', { id: kindsListId }, ...MCP_AUTH_KINDS.map((k) => el('option', { value: k })));
    const authKindIn = el('input', { type: 'text', value: s.auth_kind || '', placeholder: '예: notion_oauth', list: kindsListId });
    const authScopeIn = el('input', { type: 'text', value: s.auth_scope_key || '', placeholder: '대상 구분(선택 · 예 워크스페이스)' });
    const piiChk = el('input', { type: 'checkbox' });
    piiChk.checked = !!s.pii_scrub;
    // 발행/새로고침 — 상류 tools/list 캡처(핀). 저장된 proxy 서버만.
    const snapN = (s.tools_snapshot && s.tools_snapshot.length) || 0;
    const snapInfo = el('div', { class: 'caption', text: snapN
            ? `발행됨 · 툴 ${snapN}개${s.snapshot_at ? ' · ' + String(s.snapshot_at).slice(0, 16).replace('T', ' ') : ''}`
            : '미발행 — 발행하면 상류 tools/list 를 캡처해 다음 세션부터 구성원에게 노출됩니다.' });
    const refreshBtn = el('button', { class: 'btn btn-ghost btn-sm', text: snapN ? '새로고침(상류 툴 재캡처)' : '발행(상류 툴 캡처)' });
    refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        try {
            const r = await api('/api/ui/org/mcp-server/refresh', { method: 'POST', body: JSON.stringify({ name: s.name }) });
            toast(`발행됨 — 툴 ${r.tool_count}개`);
            await loadAdmin(true);
            renderAdminDetail(detail, 'mcp', state.admin.data);
        }
        catch (e) {
            toast(e.message, true);
            refreshBtn.disabled = false;
        }
    });
    const oauthHint = el('div', { class: 'admin-hint', text: 'OAuth: 구성원이 각자 [자격] 화면(또는 me_oauth_connect)에서 [연결]로 브라우저 인증합니다. 게이트웨이가 토큰을 구성원별로 보관·자동 갱신합니다.' });
    const sigv4Hint = el('div', { class: 'admin-hint', text: 'AWS(sigv4): 자격 종류는 aws_role_arn 으로 두세요. 실제 역할(role ARN·리전·service)과 구성원별 오버라이드는 [자격] 탭 ▸ "AWS 역할"에서 등록·할당합니다. 툴 등급은 자동(describe=조회 / put·delete=집행 컨펌).' });
    // OAuth 클라이언트(선택) — 상류가 자동등록(DCR)을 지원하면 비워둠(게이트웨이가 자동 등록). Google·Slack 등 콘솔 앱은 사전등록 client 를 입력.
    //  저장 시 (gateway,auth_kind,'oauth:client') 슬롯에 시딩 → SDK 가 client_secret 유무로 confidential/public 자동 판정. 비우면 기존 유지.
    const oauthClientIdIn = el('input', { type: 'text', value: '', placeholder: '비우면 자동등록(DCR). Google·Slack 등은 콘솔 client_id 입력' });
    const oauthClientSecretIn = el('input', { type: 'password', autocomplete: 'off', placeholder: 'confidential 앱이면 client_secret (변경할 때만 입력)' });
    const oauthCallback = ((data && data.profile && data.profile.gateway_url) || location.origin).replace(/\/mcp$/, '').replace(/\/$/, '') + '/oauth/callback';
    const oauthClientBox = el('div', { class: 'admin-subcard', style: 'margin-top:8px' }, el('div', { class: 'admin-subhead', text: 'OAuth 클라이언트 (선택 — 자동등록 미지원 상류만)' }), el('div', { class: 'admin-hint', text: '상류 MCP 가 동적 클라이언트 등록(DCR)을 지원하면 비워두세요 — 게이트웨이가 자동 등록합니다. Google·Slack처럼 콘솔에서 앱을 미리 만들어야 하는 상류만 그 client_id/secret 을 입력하고, 콘솔의 redirect URI 에 아래 콜백을 등록하세요. (설정/변경 시 client_id 를 입력 — 비우면 기존 유지)' }), field('client_id', oauthClientIdIn), field('client_secret', oauthClientSecretIn), el('div', { class: 'admin-hint', text: `redirect URI(콜백): ${oauthCallback}  — 이 값을 상류 콘솔(Google/Slack 등)의 허용 redirect URI 에 그대로 등록하세요.` }));
    const authEnvField = field('인증 환경변수 이름 (auth_env)', authIn);
    const proxyBox = el('div', { class: 'admin-subcard' }, el('div', { class: 'admin-subhead', text: '프록시 통제(#746)' }), field('접근 권한 scope', scopeSel), field('권한 등급(기본 · 툴별 자동분류)', levelSel), field('인증 방식', authModeSel), field('자격 종류 (auth_kind)', el('div', {}, authKindIn, kindsList)), field('자격 대상 구분 (선택)', authScopeIn), el('label', { class: 'admin-check' }, piiChk, ' 응답 PII 마스킹(비정형 텍스트)'), oauthHint, oauthClientBox, sigv4Hint, isNew ? el('div', { class: 'caption', text: '저장 후 [발행]으로 상류 툴을 캡처하세요.' }) : el('div', { class: 'admin-actions' }, refreshBtn, snapInfo));
    const syncTransport = () => { urlField.style.display = transSel.value === 'http' ? '' : 'none'; cmdField.style.display = transSel.value === 'stdio' ? '' : 'none'; };
    const syncMode = () => {
        const proxy = modeSel.value === 'proxy';
        proxyBox.style.display = proxy ? '' : 'none';
        // proxy 는 auth_kind(vault)로 인증 → auth_env(client 전용) 숨김. oauth 면 auth_kind 는 vault kind(토큰 슬롯).
        authEnvField.style.display = proxy ? 'none' : '';
        oauthHint.style.display = proxy && authModeSel.value === 'oauth' ? '' : 'none';
        oauthClientBox.style.display = proxy && authModeSel.value === 'oauth' ? '' : 'none';
        sigv4Hint.style.display = proxy && authModeSel.value === 'sigv4' ? '' : 'none';
        if (proxy && authModeSel.value === 'sigv4' && !authKindIn.value.trim())
            authKindIn.value = 'aws_role_arn';
    };
    transSel.addEventListener('change', syncTransport);
    modeSel.addEventListener('change', syncMode);
    authModeSel.addEventListener('change', syncMode);
    const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
        if (!nameIn.value.trim()) {
            toast('이름 필수', true);
            return;
        }
        saveBtn.disabled = true;
        try {
            const http = transSel.value === 'http';
            const proxy = modeSel.value === 'proxy';
            const payload = {
                name: nameIn.value.trim(), transport: transSel.value,
                url: http ? urlIn.value.trim() : null, command: http ? null : cmdIn.value.trim(),
                auth_env: proxy ? null : (authIn.value.trim() || null),
                note: noteIn.value.trim() || null, enabled: enChk.checked,
                mode: modeSel.value,
                scope: proxy ? scopeSel.value : null,
                level: proxy ? levelSel.value : null,
                auth_mode: proxy ? authModeSel.value : null,
                auth_kind: proxy ? (authKindIn.value.trim() || null) : null,
                auth_scope_key: proxy ? (authScopeIn.value.trim() || null) : null,
                pii_scrub: proxy ? piiChk.checked : false,
            };
            await api('/api/ui/org/mcp-server', { method: 'POST', body: JSON.stringify(payload) });
            // OAuth 클라이언트(선택) — client_id 입력 시 (gateway,auth_kind,'oauth:client') 슬롯에 시딩. 비우면 기존 유지(DCR 상류는 불요).
            if (proxy && authModeSel.value === 'oauth' && oauthClientIdIn.value.trim()) {
                const kind = authKindIn.value.trim();
                if (!kind) {
                    toast('OAuth 클라이언트를 저장하려면 자격 종류(auth_kind)가 필요합니다', true);
                }
                else {
                    const seed = { client_id: oauthClientIdIn.value.trim() };
                    if (oauthClientSecretIn.value.trim())
                        seed.client_secret = oauthClientSecretIn.value.trim();
                    await api('/api/ui/org/credential', { method: 'POST', body: JSON.stringify({ kind, scope_key: 'oauth:client', secret: JSON.stringify(seed) }) });
                    oauthClientIdIn.value = '';
                    oauthClientSecretIn.value = '';
                }
            }
            await loadAdmin(true);
            state.admin.mcpSel = payload.name;
            toast('저장됨 — 다음 세션부터 반영');
            renderAdminDetail(detail, 'mcp', state.admin.data);
        }
        catch (e) {
            toast(e.message, true);
            saveBtn.disabled = false;
        }
    });
    const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
    if (!isNew)
        actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
                if (!confirm(`MCP 서버 '${s.name}' 제거?`))
                    return;
                try {
                    await api('/api/ui/org/mcp-server/remove', { method: 'POST', body: JSON.stringify({ name: s.name }) });
                    await loadAdmin(true);
                    state.admin.mcpSel = null;
                    toast('제거됨');
                    renderAdminDetail(detail, 'mcp', state.admin.data);
                }
                catch (e) {
                    toast(e.message, true);
                }
            } }));
    // ── 프리셋 — 신규 등록 시 선택하면 필드 자동 채움(#746 imp#3). 코드 SoT=mcp-server-presets.ts. ──
    const presetSel = el('select', {}, el('option', { value: '', text: '— 직접 입력 —' }));
    const presetHint = el('div', { class: 'admin-hint', style: 'display:none;margin-top:6px' });
    let catalog = [];
    api('/api/ui/org/mcp-server-presets').then((r) => {
        catalog = r.catalog || [];
        for (const c of catalog)
            presetSel.append(el('option', { value: c.name, text: c.label + (c.dcr ? ' · 자동(DCR)' : ' · client 필요') }));
    }).catch(() => { });
    presetSel.addEventListener('change', () => {
        const c = catalog.find((x) => x.name === presetSel.value);
        if (!c) {
            presetHint.style.display = 'none';
            return;
        }
        if (isNew)
            nameIn.value = c.name;
        transSel.value = 'http';
        urlIn.value = c.url;
        modeSel.value = 'proxy';
        authModeSel.value = 'oauth';
        authKindIn.value = c.auth_kind;
        scopeSel.value = c.scope;
        levelSel.value = c.level;
        piiChk.checked = !!c.pii_scrub;
        syncTransport();
        syncMode();
        // 셋업 위저드(imp#1) — DCR이면 0세팅, 아니면 provider 콘솔 체크리스트 + 정확한 콜백 URL.
        const cb = ((data && data.profile && data.profile.gateway_url) || location.origin).replace(/\/mcp$/, '').replace(/\/$/, '') + '/oauth/callback';
        presetHint.replaceChildren();
        if (c.dcr) {
            presetHint.append(el('div', { text: `${c.label}: 자동 클라이언트 등록(DCR) — OAuth client 입력 불필요. 저장 → [발행](연결 테스트) → 구성원이 [연결]하면 끝.` }));
        }
        else {
            presetHint.append(el('div', { style: 'font-weight:600;margin-bottom:4px', text: `${c.label}: 사전등록 OAuth client 필요 — provider 콘솔 셋업:` }), el('ol', { style: 'margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px' }, el('li', { text: 'provider 콘솔에서 "웹 애플리케이션" OAuth 클라이언트 생성' }), el('li', { text: '필요한 스코프 추가(아래 note 참조)' }), el('li', {}, '승인된 redirect URI 에 게이트웨이 콜백 등록 → ', el('code', { text: cb })), el('li', {}, '발급된 client_id/secret 를 아래 ', el('b', { text: 'OAuth 클라이언트' }), ' 필드에 입력'), el('li', { text: '저장 → [발행]로 연결 스모크(막히면 스코프/콜백 재확인)' })));
        }
        if (c.note)
            presetHint.append(el('div', { class: 'caption', style: 'margin-top:4px', text: c.note }));
        presetHint.style.display = '';
    });
    const presetField = field('프리셋(기본 카탈로그)', el('div', {}, presetSel, presetHint));
    root.replaceChildren(...[
        isNew ? presetField : null,
        field('이름', nameIn), field('방식', modeSel), field('전송 방식', transSel), urlField, cmdField,
        authEnvField, field('설명', noteIn),
        el('label', { class: 'admin-check' }, enChk, ' 활성'),
        proxyBox,
        actions,
    ].filter(Boolean));
    syncTransport();
    syncMode();
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
            onclick: () => { state.admin.connectorSel = c.system; renderAdminDetail(detail, 'connectors', data); } }, el('div', { class: 'mini-title', text: c.label }, c.enabled ? el('span', { class: 'pill', text: '자동 싱크' }) : null), el('div', { class: 'mini-meta', text: secTotal ? `토큰 ${setCount}/${secTotal} 등록됨` : '토큰 불필요' })));
    }
    const right = el('div', {});
    const editing = connectors.find((c) => c.system === sel);
    if (editing) {
        connectorStatusCard(right, editing);
        connectorForm(right, editing, data, detail);
    }
    else
        right.append(el('p', { class: 'admin-hint', text: '수집할 외부 소스를 선택하세요.' }));
    // 사람 매핑 패널(#541 → #837 일반화) — 커넥터가 사용자 목록을 줄 수 있으면 붙인다.
    //  서버가 supported:false 로 답하면 패널이 스스로 사라진다(gmail·gdrive 는 개인 OAuth 라 '멤버' 개념이 없다).
    if (editing && editing.system && editing.system !== '__new__') {
        const panel = el('div', { class: 'card', style: 'margin-top:12px' });
        right.append(panel);
        void renderConnectorMemberPanel(panel, editing.system);
    }
    const banner = (editing && editing.secrets_enabled === false)
        ? el('div', { class: 'admin-hint', text: '⚠ CONNECTOR_SECRET_KEY 미설정 — 토큰 암호화 저장이 비활성입니다. 게이트웨이 .env 에 CONNECTOR_SECRET_KEY(openssl rand -hex 32)를 설정하면 여기서 토큰을 저장할 수 있습니다(그 전엔 .env 폴백만 동작).' })
        : null;
    detail.replaceChildren(sectionHead('외부 자료 수집', '슬랙·노션·클릭업 같은 외부 도구의 자료를 주기적으로 가져옵니다.', data.meaning && data.meaning['connector']), el('div', { class: 'card' }, banner, cardHead('연결된 외부 도구'), el('div', { class: 'admin-two admin-two-cols' }, listCol, right)));
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
        : ' · 켜고 저장하면 10분 주기 자동 싱크가 시작됩니다';
    const lastLine = el('div', { class: 'admin-hint', text: '실행 이력 확인 중…' });
    const syncBtn = el('button', { class: 'btn btn-primary btn-sm', text: '지금 싱크',
        title: '백그라운드로 즉시 실행 — 로그 창이 열립니다', onclick: () => startSyncRun(c.system, false) });
    const fullBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '전체 다시 싱크',
        title: '커서를 무시하고 전체 재수집(삭제/보관 전파 포함) — 페이지 수에 비례해 오래 걸립니다',
        onclick: () => { if (confirm('전체를 다시 수집할까요? 원본 규모에 따라 몇 분~수십 분 걸립니다(백그라운드 실행).'))
            startSyncRun(c.system, true); } });
    const runsBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '실행 기록', onclick: () => openConnectorRuns(c) });
    root.append(el('div', { class: 'conn-status' }, el('div', { class: 'conn-status-line' }, dot, el('span', { class: 'mini-meta', text: jobText })), lastLine, el('div', { class: 'admin-actions conn-status-actions' }, syncBtn, fullBtn, runsBtn)));
    (async () => {
        try {
            const r = await api('/api/ui/org/connector/runs?' + new URLSearchParams({ system: c.system, limit: '1' }));
            const run = (r.runs || [])[0];
            if (!run) {
                lastLine.textContent = '아직 실행 이력이 없습니다 — 토큰 저장 후 [지금 싱크]로 시작하세요.';
                return;
            }
            lastLine.replaceChildren(el('span', { text: `최근 실행: ${runStatusLabel(run.status)}${run.stale ? ' ⚠ 추적 끊김' : ''} · ${run.mode === 'full' ? '전체' : '증분'} · ${relTime(run.started_at)}` +
                    (run.finished_at ? ` · ${runDurLabel(run.started_at, run.finished_at)}` : '') }), ' ', el('a', { href: '#', text: '로그 보기', onclick: (e) => { e.preventDefault(); openRunLog(c.system, run.id); } }));
        }
        catch (_) {
            lastLine.textContent = '';
        }
    })();
}
// 비동기 싱크 시작(#586) — run_id 즉시 수신 → 로그 창(진행 폴링). 프록시 타임아웃과 무관.
async function startSyncRun(system, full) {
    try {
        const r = await api('/api/ui/org/connector/sync', { method: 'POST', body: JSON.stringify({ system, full: !!full }) });
        toast(r.already_running ? '이미 실행 중이라 그 실행의 로그를 엽니다' : '싱크를 시작했습니다(백그라운드)');
        openRunLog(system, r.run_id);
    }
    catch (e) {
        toast('싱크 시작 실패 — ' + e.message, true);
    }
}
// 실행 기록(#586) — 최근 20건. 행 클릭 = 로그.
async function openConnectorRuns(c) {
    const listBox = el('div', { class: 'run-list' }, el('p', { class: 'admin-hint', text: '불러오는 중…' }));
    overlay(`실행 기록 · ${c.label}`, listBox);
    try {
        const r = await api('/api/ui/org/connector/runs?' + new URLSearchParams({ system: c.system, limit: '20' }));
        const runs = r.runs || [];
        if (!runs.length) {
            listBox.replaceChildren(el('p', { class: 'admin-hint', text: '실행 이력이 없습니다.' }));
            return;
        }
        listBox.replaceChildren(...runs.map((run) => el('div', { class: 'mini-row', onclick: () => openRunLog(c.system, run.id) }, el('div', { class: 'mini-title', text: `${runStatusLabel(run.status)}${run.stale ? ' ⚠ 추적 끊김' : ''}  ${run.mode === 'full' ? '전체' : '증분'} · ${run.trigger === 'manual' ? '수동' : '자동'}` }), el('div', { class: 'mini-meta', text: `${relTime(run.started_at)}${run.finished_at ? ` · ${runDurLabel(run.started_at, run.finished_at)}` : ' · 진행 중'} · run #${run.id}` }))));
    }
    catch (e) {
        listBox.replaceChildren(el('p', { class: 'admin-hint', text: '로드 실패: ' + e.message }));
    }
}
// run 로그 뷰(#586) — 진행 중이면 2초 폴링으로 청크를 이어붙인다(창 닫으면 중단).
async function openRunLog(system, runId) {
    const status = el('div', { class: 'admin-hint', text: '불러오는 중…' });
    const cancelBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '⏹ 중지', style: 'display:none', onclick: async () => {
            if (!confirm('이 실행을 중지할까요? 커서가 전진하지 않아 데이터 손실은 없고, 다음 실행이 이어서 재수집합니다.'))
                return;
            try {
                const r = await api(`/api/ui/org/connector/runs/${runId}/cancel`, { method: 'POST', body: '{}' });
                toast(r.message || (r.ok === false ? '중지 실패' : '중지 요청됨'), r.ok === false);
            }
            catch (e) {
                toast('중지 실패 — ' + e.message, true);
            }
        } });
    const head = el('div', { class: 'run-log-head' }, status, cancelBtn);
    const pre = el('pre', { class: 'run-log' });
    const back = overlay(`싱크 로그 · ${system} · run #${runId}`, head, pre);
    let offset = 0;
    let timer = null;
    const stop = () => { if (timer) {
        clearInterval(timer);
        timer = null;
    } };
    const tick = async () => {
        if (!document.body.contains(back)) {
            stop();
            return;
        } // 창 닫힘 → 폴링 중단
        try {
            let r;
            // 드레인 루프 — 완료된 긴 로그(청크 64KB 초과)도 한 tick 에 끝까지 이어붙인다(가드 100청크 ≈ 6.5MB).
            for (let i = 0; i < 100; i++) {
                r = await api(`/api/ui/org/connector/runs/${runId}?offset=${offset}`);
                const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
                if (r.skipped > 0)
                    pre.append(document.createTextNode(`\n[…앞부분 ${r.skipped.toLocaleString()}자 잘림(로그 캡)…]\n`));
                if (r.log_chunk)
                    pre.append(document.createTextNode(r.log_chunk));
                if (r.next_offset != null)
                    offset = r.next_offset;
                if (atBottom)
                    pre.scrollTop = pre.scrollHeight;
                if (offset >= (r.log_size ?? 0))
                    break;
            }
            status.textContent = `${runStatusLabel(r.status)} · ${r.mode === 'full' ? '전체' : '증분'} · 시작 ${relTime(r.started_at)}`
                + (r.finished_at ? ` · 소요 ${runDurLabel(r.started_at, r.finished_at)}` : r.stale
                    ? ' · ⚠ 추적 끊김(게이트웨이 재시작 추정) — 곧 자동 정리되며, 재시작 직후라면 새로 싱크를 시작하세요'
                    : ' · 진행 중 — 자동 갱신');
            cancelBtn.style.display = r.status === 'running' ? '' : 'none';
            if (r.status !== 'running')
                stop();
        }
        catch (e) {
            status.textContent = '로그 로드 실패: ' + e.message;
            stop();
        }
    };
    await tick();
    if (!timer)
        timer = setInterval(tick, 2000);
}
// 스코프 픽커(#586) — 저장된 토큰으로 소스의 선택지(discover)를 조회해 체크박스로 고른다. id 복붙 제거.
async function openScopePicker(c, f, inp) {
    const box = el('div', {}, el('p', { class: 'admin-hint', text: `${c.label}에서 목록을 조회하는 중…` }));
    const back = overlay(`${f.label || f.key} — 목록에서 선택`, box);
    try {
        const r = await api('/api/ui/org/connector/discover', { method: 'POST', body: JSON.stringify({ system: c.system }) });
        const opts = (r.fields && r.fields[f.key]) || [];
        if (!opts.length) {
            box.replaceChildren(el('p', { class: 'admin-hint', text: r.note || '고를 항목이 없습니다 — 값을 직접 입력하세요.' }));
            return;
        }
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
            return el('label', { class: 'conn-pick-item' }, cb, el('span', { class: 'conn-pick-label', text: `${icon} ${o.label}` }), el('span', { class: 'mini-meta mono', text: String(o.id).slice(0, 10) + '…' }));
        });
        const apply = el('button', { class: 'btn btn-primary btn-sm', text: '적용', onclick: () => {
                const ids = [...checks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
                inp.value = ids.join(',');
                back.remove();
                toast(ids.length ? `${ids.length}개 선택됨 — [저장]을 눌러야 반영됩니다` : '선택을 비웠습니다 — [저장]을 눌러야 반영됩니다');
            } });
        box.replaceChildren(r.note ? el('p', { class: 'admin-hint', text: r.note }) : null, el('div', { class: 'conn-pick-list' }, ...rows), el('div', { class: 'admin-actions' }, apply));
    }
    catch (e) {
        box.replaceChildren(el('p', { class: 'admin-hint', text: '조회 실패: ' + e.message }));
    }
}
function connectorForm(root, c, data, detail) {
    const inputs = {}; // key → { el, secret }
    const fieldEls = [];
    for (const f of (c.fields || [])) {
        let inp;
        if (f.secret) {
            const isSet = c.secretsSet && c.secretsSet[f.key];
            inp = el('input', { type: 'password', value: '', placeholder: isSet ? '● 설정됨 — 변경할 때만 입력' : (f.hint || '미설정') });
        }
        else {
            inp = el('input', { type: 'text', value: (c.config && c.config[f.key]) || '', placeholder: f.hint || '' });
        }
        inputs[f.key] = { el: inp, secret: !!f.secret };
        const lbl = (f.label || f.key) + (f.required ? ' *' : '') + (f.secret ? ' 🔒' : '');
        // 스코프 픽커(#586) — picker 지정 필드는 입력 옆 [목록에서 선택].
        const ctrl = f.picker
            ? el('div', { class: 'conn-pick-row' }, inp, el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '목록에서 선택',
                title: '저장된 토큰으로 소스에서 목록을 조회해 고릅니다', onclick: () => openScopePicker(c, f, inp) }))
            : inp;
        fieldEls.push(field(lbl, ctrl));
    }
    // 토큰 발급 가이드(#586) — 접이식(처음 설정하는 사람 기준 단계별).
    let guideEl = null;
    if (c.guide && (c.guide.steps || []).length) {
        guideEl = el('details', { class: 'conn-guide', ...(Object.values(c.secretsSet || {}).some(Boolean) ? {} : { open: '' }) }, el('summary', { text: `🔑 ${c.label} 토큰 발급 방법` }));
        if (c.guide.intro)
            guideEl.append(el('p', { class: 'admin-hint', text: c.guide.intro }));
        const ol = el('ol', { class: 'conn-guide-steps' });
        for (const st of (c.guide.steps || []))
            ol.append(el('li', { text: st }));
        guideEl.append(ol);
        if (c.guide.url)
            guideEl.append(el('p', { class: 'conn-guide-link' }, el('a', { href: c.guide.url, target: '_blank', rel: 'noopener noreferrer', text: '발급 페이지 열기 ↗' })));
    }
    const enChk = el('input', { type: 'checkbox' });
    enChk.checked = !!c.enabled;
    const noteIn = el('input', { type: 'text', value: c.note || '', placeholder: '선택 사항 — 이 커넥터에 대한 운영 메모' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
            const config = {}, secrets = {};
            for (const k of Object.keys(inputs)) {
                const { el: inp, secret } = inputs[k];
                const v = inp.value;
                if (secret) {
                    if (v)
                        secrets[k] = v;
                } // 빈=미변경(기존 암호문 유지)
                else
                    config[k] = (v || '').trim();
            }
            const payload = { system: c.system, enabled: enChk.checked, config, secrets, note: noteIn.value.trim() || null };
            await api('/api/ui/org/connector', { method: 'POST', body: JSON.stringify(payload) });
            await loadAdmin(true);
            state.admin.connectorSel = c.system;
            toast(enChk.checked ? '저장됨 — 자동 싱크 등록(10분 주기). [지금 싱크]로 바로 시작할 수 있어요' : '저장됨 — 자동 싱크 꺼짐');
            renderAdminDetail(detail, 'connectors', state.admin.data);
        }
        catch (e) {
            toast(e.message, true);
            saveBtn.disabled = false;
        }
    });
    const actions = el('div', { class: 'admin-actions' }, saveBtn);
    actions.append(el('button', { class: 'btn-text', text: '설정·토큰 삭제(.env 값 사용)', onclick: async () => {
            if (!confirm(`${c.label} 설정·토큰을 제거하고 .env 폴백으로 되돌릴까요?`))
                return;
            try {
                await api('/api/ui/org/connector/remove', { method: 'POST', body: JSON.stringify({ system: c.system }) });
                await loadAdmin(true);
                toast('초기화됨');
                renderAdminDetail(detail, 'connectors', state.admin.data);
            }
            catch (e) {
                toast(e.message, true);
            }
        } }));
    root.append(guideEl, el('label', { class: 'admin-check' }, enChk, ' 싱크 활성 — 저장하면 10분 주기 자동 싱크가 등록됩니다'), ...fieldEls, field('메모', noteIn), el('p', { class: 'admin-hint', text: '🔒 토큰은 게이트웨이 키로 암호화되어 저장됩니다. 값을 비워두면 기존 토큰이 유지됩니다.' }), actions);
}
// ── ClickUp 멤버 매핑(#541) — ClickUp 팀 멤버 ↔ 구성원(org_member) 연결 패널. ──
//  어사이니 해소는 person_identity(system='clickup') → org_member 로 이뤄지고, 수동 매핑의 SoT 는
//  org_member.identities(JSONB) — 저장/해제는 POST /api/ui/org/member(identities 병합) 재사용(서버가
//  person_identity 로 즉시 동기). 매핑 상태는 GET /api/ui/org/connector/clickup/members 가 계산해 준다.
// ── 사람 매핑(#541 clickup → #837 커넥터 일반) ──────────────────────────────────
//  **편집 SoT 는 여기다**(구성원 화면이 아니라). 매핑은 "외부 시스템의 사람 ↔ 우리 구성원"인데,
//  구성원 화면은 외부 목록을 안 가져오므로 관리자가 외부 id 를 손으로 타이핑해야 했다 —
//  ClickUp 숫자 id 를 어디서 찾는지도 모르고, 시스템명 오타는 조용히 매칭 실패로 끝난다.
//  여기선 커넥터가 실제 사용자 목록을 주므로 드롭다운으로 고르기만 하면 된다(오타 불가).
//  → 구성원 화면의 '외부 계정 연결'은 읽기 전용 + 이리로 오는 링크가 됐다(#837).
async function renderConnectorMemberPanel(panel, system) {
    const spec = (state.admin.data && (state.admin.data.connectors || []).find((c) => c.system === system)) || {};
    const label = spec.label || system;
    panel.replaceChildren(el('p', { class: 'admin-hint', text: label + ' 사용자 불러오는 중…' }));
    let res;
    try {
        res = await api('/api/ui/org/connector/' + encodeURIComponent(system) + '/members');
    }
    catch (e) {
        panel.replaceChildren(el('p', { class: 'admin-hint', text: label + ' 사용자 로드 실패: ' + e.message }));
        return;
    }
    // 이 커넥터는 사람 매핑을 지원하지 않는다(gmail·gdrive 등) — 패널을 아예 안 그린다.
    if (res.supported === false) {
        panel.remove();
        return;
    }
    const head = sectionTitle('멤버 매핑 · ' + label, label + ' 사용자를 조직 구성원과 연결합니다 — 연결하면 다음 싱크부터 작성자·담당자가 해당 구성원으로 매칭됩니다. 이메일이 같으면 자동매치 후보가 미리 선택됩니다. **매핑 편집은 이 화면에서 합니다** — 구성원 화면에서는 결과만 표시됩니다.');
    if (res.error) {
        panel.replaceChildren(head, el('p', { class: 'admin-hint', text: '⚠ ' + res.error }));
        return;
    }
    const users = res.users || [];
    if (!users.length) {
        panel.replaceChildren(head, el('p', { class: 'admin-hint', text: label + ' 사용자가 없습니다.' }));
        return;
    }
    const members = (state.admin.data && state.admin.data.members) || [];
    const activeMembers = members.filter((m) => (m.state || 'active') === 'active');
    const nameOf = (id) => { const m = members.find((x) => x.id === id); return m ? (m.display_name || m.id) : id; };
    // 저장/해제 — 대상 구성원의 identities 에 이 시스템 신원을 병합(add)/제거(remove) 후 **부분 페이로드**
    //  { id, identities } 로 POST(다른 필드는 서버가 보존 — 낡은 화면값으로 덮어쓰기 방지).
    //  ⚠ 이 저장이 #697 의 소급 재해소 훅(delivery.org_member_upsert)을 태운다 — 매핑 이전에 raw 로 굳은
    //    미러 데이터까지 되돌려 고쳐 준다. 그래서 매핑은 반드시 이 엔드포인트를 통해야 한다.
    const postIdentities = async (memberId, u, add) => {
        const m = members.find((x) => x.id === memberId);
        if (!m)
            throw new Error('구성원을 찾을 수 없습니다 — 새로고침 후 다시 시도하세요');
        const emailLower = (u.email || '').trim().toLowerCase();
        const isThis = (idn) => idn.system === system
            && (idn.external_id === String(u.id) || (!!emailLower && (idn.external_id || '').toLowerCase() === emailLower));
        const identities = (m.identities || []).filter((idn) => !isThis(idn));
        if (add) {
            identities.push({ system, external_id: String(u.id), email: u.email || undefined, instance: u.instance || res.instance || undefined });
        }
        else if (identities.length === (m.identities || []).length) {
            // 구성원 identities 밖에서 온 신원(게이트웨이 바인딩 파일 등) — 여기선 해제 불가.
            throw new Error('이 연결은 구성원의 외부 계정 목록 밖에서 온 신원이라 여기서 해제할 수 없어요');
        }
        await api('/api/ui/org/member', { method: 'POST', body: JSON.stringify({ id: m.id, identities }) });
        await loadAdmin(true); // members(identities) 최신화 — 패널 재조회 전 로컬 데이터 동기
    };
    const tbl = el('table', { class: 'fields-table cu-map-table' });
    tbl.append(el('tr', {}, el('th', { text: label + ' 사용자' }), el('th', { text: '연결된 구성원' }), el('th', {})));
    for (const r of users) {
        const u = r.user || {};
        // 아바타 — 외부 색은 검증된 hex 일 때만 style 로(외부 데이터 CSS 주입 방지), 이니셜은 textContent.
        const dot = el('span', { class: 'cu-avatar', text: (u.initials || String(u.name || u.id || '?').slice(0, 2)).toUpperCase() });
        if (/^#[0-9a-fA-F]{3,8}$/.test(u.color || '')) {
            dot.style.background = u.color;
            dot.style.color = '#fff';
        }
        const userCell = el('td', { class: u.inactive ? 'cu-inactive' : '' }, el('div', { class: 'cu-user' }, dot, el('div', {}, el('div', { class: 'mini-title' }, el('span', { text: u.name || ('id ' + u.id) }), u.inactive ? el('span', { class: 'pill', text: '비활성' }) : null), el('div', { class: 'mini-meta', text: u.email || ('id ' + u.id) }))));
        if (r.mapped_via === 'identity') {
            const unlink = el('button', { class: 'btn-text', text: '해제' });
            unlink.addEventListener('click', async () => {
                if (!confirm(`'${u.name || u.id}' ↔ '${nameOf(r.mapped_member_id)}' 연결을 해제할까요?`))
                    return;
                unlink.disabled = true;
                try {
                    await postIdentities(r.mapped_member_id, u, false);
                    toast('연결 해제됨 — 다음 싱크부터 반영');
                    void renderConnectorMemberPanel(panel, system);
                }
                catch (e) {
                    toast(e.message, true);
                    unlink.disabled = false;
                }
            });
            tbl.append(el('tr', {}, userCell, el('td', {}, el('span', { class: 'pill pill-ok', text: '연결됨' }), ' ', nameOf(r.mapped_member_id)), el('td', {}, unlink)));
        }
        else {
            const selBox = el('select', { class: 'cu-map-sel' }, el('option', { value: '', text: '구성원 선택…' }), ...activeMembers.map((m) => el('option', { value: m.id, text: (m.display_name || m.id) + (m.email ? ' (' + m.email + ')' : '') })));
            if (r.suggested_member_id)
                selBox.value = r.suggested_member_id;
            const saveB = el('button', { class: 'btn btn-ghost btn-sm', text: '연결' });
            saveB.addEventListener('click', async () => {
                if (!selBox.value) {
                    toast('연결할 구성원을 선택하세요', true);
                    return;
                }
                saveB.disabled = true;
                try {
                    await postIdentities(selBox.value, u, true);
                    toast('연결됨 — 다음 싱크부터 반영');
                    void renderConnectorMemberPanel(panel, system);
                }
                catch (e) {
                    toast(e.message, true);
                    saveB.disabled = false;
                }
            });
            tbl.append(el('tr', {}, userCell, el('td', {}, r.mapped_via === 'email' ? el('span', { class: 'pill', text: '이메일 자동매치' }) : null, ' ', selBox), el('td', {}, saveB)));
        }
    }
    panel.replaceChildren(head, tbl);
}
// #976 위키 아웃바운드(피드) 패널 — 정본 지식 → 노션 등 '지식 피드' DB 카드 투영. 커넥터(인바운드)의 역방향.
//  피드 목적지(feed_target) 목록 + 카테고리 N:M 매핑(발행 게이트) + all_categories + 새 피드 부트스트랩/등록.
//  전용 GET /api/ui/feed-targets 로 자체 조회(연결 패널처럼) — /api/ui/org 페이로드 오염 안 시킴.
async function feedTargetsEditor(detail, data) {
    const meaning = data.meaning && data.meaning['feed-targets'];
    detail.replaceChildren(sectionHead('위키 아웃바운드(피드)', '우리 위키의 지식을 외부 도구로 내보냅니다. 어떤 카테고리를 어디로 보낼지 정합니다.', meaning), el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '피드 목적지 불러오는 중…' })));
    let res;
    try {
        res = await api('/api/ui/feed-targets');
    }
    catch (e) {
        detail.replaceChildren(sectionHead('위키 아웃바운드(피드)', '우리 위키의 지식을 외부 도구로 내보냅니다. 어떤 카테고리를 어디로 보낼지 정합니다.', meaning), el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '로드 실패: ' + e.message })));
        return;
    }
    const targets = res.targets || [];
    const categories = res.categories || [];
    const rerender = () => { void feedTargetsEditor(detail, data); };
    const body = el('div', {});
    // 소개 + 전체 발행(드레인) — 상시 갱신은 cron push-wiki-notion(자동화 탭).
    const drainAll = el('button', { class: 'btn btn-ghost btn-sm', text: '지금 전체 발행' });
    drainAll.addEventListener('click', async () => {
        drainAll.disabled = true;
        try {
            await api('/api/ui/feed-targets/drain', { method: 'POST', body: '{}' });
            toast('발행 시작 — 잠시 후 노션 피드에 반영됩니다(멱등 · 변경분만).');
        }
        catch (e) {
            toast(e.message, true);
        }
        drainAll.disabled = false;
    });
    body.append(el('p', { class: 'admin-hint' }, el('span', { text: '우리 정본 지식(authored)을 노션 등 외부 ‘지식 피드’ DB에 카드로 투영합니다. 읽기전용·단방향 — 전체 내용은 Lively가 정본. 사람 페이지는 건드리지 않고 전용 피드 DB에만 카드를 올립니다. ' }), el('span', { text: '상시 갱신은 스케줄러 잡 ' }), el('b', { text: 'push-wiki-notion' }), el('span', { text: '(관리탭 ▸ 자동화)에서 켭니다.  ' }), drainAll));
    if (!targets.length)
        body.append(el('p', { class: 'admin-hint', text: '아직 등록된 피드가 없습니다. 아래에서 새 피드를 만드세요.' }));
    for (const t of targets)
        body.append(feedTargetCard(t, categories, rerender));
    body.append(newFeedForm(rerender));
    detail.replaceChildren(sectionHead('위키 아웃바운드(피드)', '우리 위키의 지식을 외부 도구로 내보냅니다. 어떤 카테고리를 어디로 보낼지 정합니다.', meaning), body);
}
// 피드 목적지 카드 1개 — 상태·카드수·노션 링크 + all_categories 토글 + 카테고리 매핑 + 삭제.
function feedTargetCard(t, categories, rerender) {
    const notionUrl = 'https://notion.so/' + String(t.target_id || '').replace(/-/g, '');
    const card = el('div', { class: 'card', style: 'margin-top:12px' });
    card.append(el('div', { class: 'mini-title' }, el('span', { text: t.title || ('피드 #' + t.id) }), el('span', { class: 'pill' + (t.state === 'active' ? ' pill-ok' : ''), text: t.state === 'active' ? '활성' : '일시중지' }), el('span', { class: 'pill', text: '카드 ' + (t.card_count || 0) })));
    card.append(el('div', { class: 'mini-meta' }, el('a', { href: notionUrl, target: '_blank', rel: 'noopener', text: '노션에서 열기 ↗' }), el('span', { text: t.exclude_registered ? '  · 인바운드 제외됨(안전)' : '  · ⚠ 인바운드 제외 미등록 — 재수집 위험' })));
    // all_categories 토글
    const allChk = el('input', { type: 'checkbox' });
    allChk.checked = !!t.all_categories;
    allChk.addEventListener('change', async () => {
        try {
            await api('/api/ui/feed-targets/' + t.id, { method: 'POST', body: JSON.stringify({ all_categories: allChk.checked }) });
            toast('저장됨');
            rerender();
        }
        catch (e) {
            toast(e.message, true);
            allChk.checked = !allChk.checked;
        }
    });
    card.append(el('label', { class: 'field-label', style: 'display:block;margin-top:10px' }, allChk, el('span', { text: ' 모든 카테고리 발행(매핑 무시 · 새 카테고리 자동 포함)' })));
    // 카테고리 매핑(all 아닐 때만) — 체크박스 + 저장.
    if (!t.all_categories) {
        const mappedIds = new Set((t.categories || []).map((c) => c.id));
        const boxes = [];
        const grid = el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin:8px 0' });
        for (const c of categories) {
            const cb = el('input', { type: 'checkbox', value: String(c.id) });
            cb.checked = mappedIds.has(c.id);
            boxes.push(cb);
            grid.append(el('label', { class: 'pill' }, cb, el('span', { text: ' ' + (c.name || c.key) })));
        }
        const saveMap = el('button', { class: 'btn btn-ghost btn-sm', text: '매핑 저장' });
        saveMap.addEventListener('click', async () => {
            const ids = boxes.filter((b) => b.checked).map((b) => Number(b.value));
            saveMap.disabled = true;
            try {
                await api('/api/ui/feed-targets/' + t.id + '/categories', { method: 'POST', body: JSON.stringify({ category_ids: ids }) });
                toast('매핑 저장됨 — 다음 발행부터 반영');
                rerender();
            }
            catch (e) {
                toast(e.message, true);
                saveMap.disabled = false;
            }
        });
        card.append(el('div', { class: 'field-label', text: '발행할 카테고리' }), grid, saveMap);
    }
    const del = el('button', { class: 'btn-text', text: '삭제' });
    del.addEventListener('click', async () => {
        if (!confirm('이 피드 등록을 삭제할까요? (노션 DB와 이미 발행된 카드는 남습니다)'))
            return;
        try {
            await api('/api/ui/feed-targets/' + t.id + '/delete', { method: 'POST', body: '{}' });
            toast('삭제됨');
            rerender();
        }
        catch (e) {
            toast(e.message, true);
        }
    });
    card.append(el('div', { style: 'margin-top:10px' }, del));
    return card;
}
// 새 피드 만들기 — 부모 페이지 하위에 DB 생성(부트스트랩) 또는 기존 노션 DB id 등록. 둘 다 exclude_pages 자동 등록.
function newFeedForm(rerender) {
    const wrap = el('div', { class: 'card', style: 'margin-top:14px' }, cardHead('새 피드 만들기'));
    const titleIn = el('input', { class: 'input', type: 'text', value: 'Lively 지식 피드' });
    const parentIn = el('input', { class: 'input', type: 'text', placeholder: '노션 부모 페이지 URL 또는 id — 여기 하위에 피드 DB 생성' });
    const dbIn = el('input', { class: 'input', type: 'text', placeholder: '또는: 이미 만든 노션 DB id 를 등록' });
    const allChk = el('input', { type: 'checkbox' });
    const create = el('button', { class: 'btn', text: '피드 만들기' });
    create.addEventListener('click', async () => {
        const payload = { title: titleIn.value.trim() || undefined, all_categories: allChk.checked };
        if (dbIn.value.trim())
            payload.database_id = dbIn.value.trim();
        else if (parentIn.value.trim())
            payload.parent_page_id = parentIn.value.trim();
        else {
            toast('노션 부모 페이지 또는 기존 DB id 중 하나를 입력하세요', true);
            return;
        }
        create.disabled = true;
        try {
            const r = await api('/api/ui/feed-targets', { method: 'POST', body: JSON.stringify(payload) });
            toast('피드 생성됨' + (r && r.exclude_registered ? ' · 인바운드 제외 등록됨' : ' · ⚠ 인바운드 제외 수동 등록 필요'));
            rerender();
        }
        catch (e) {
            toast(e.message, true);
            create.disabled = false;
        }
    });
    wrap.append(el('div', { class: 'field-label', text: '＋ 새 피드 만들기' }), el('div', { class: 'field' }, el('label', { class: 'field-label', text: '제목' }), titleIn), el('div', { class: 'field' }, el('label', { class: 'field-label', text: '노션 부모 페이지 (새로 만들 때)' }), parentIn), el('div', { class: 'field' }, el('label', { class: 'field-label', text: '기존 DB 등록 (선택)' }), dbIn), el('label', { class: 'field-label', style: 'display:block;margin-top:6px' }, allChk, el('span', { text: ' 모든 카테고리 발행' })), el('div', { style: 'margin-top:10px' }, create));
    return wrap;
}
// #975/#978 프로젝트 아웃바운드 패널 — 우리 프로젝트·과업 편집 → 외부 PM(ClickUp) push, 소스별 on/off.
//  on/off = push-clickup 크론 enabled(cron_set). 컨테이너 리스트는 커넥터 설정(외부 자료 수집 ▸ ClickUp).
//  GitHub Issues·Jira 는 아웃바운드 어댑터 미구현(#975 예정) — 자리만 표시. 스키마·백엔드 변경 없이 기존 엔드포인트 orchestrate.
async function projectOutboundEditor(detail, data) {
    const meaning = data.meaning && data.meaning['project-outbound'];
    const canEdit = !!data.canEdit;
    detail.replaceChildren(sectionHead('프로젝트 아웃바운드', '우리 프로젝트와 과업의 변경을 외부 협업 도구로 내보냅니다.', meaning), el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '불러오는 중…' })));
    let jobs = [];
    try {
        const cron = await api('/api/ui/cron');
        jobs = (cron && cron.jobs) || [];
    }
    catch (e) { /* 크론 로드 실패 — 빈 목록으로 진행 */ }
    const pushClickup = jobs.find((j) => j.id === 'push-clickup');
    const clickup = (data.connectors || []).find((c) => c.system === 'clickup') || {};
    const container = (clickup.config && clickup.config.container_list_id) || '';
    const rerender = () => { void projectOutboundEditor(detail, data); };
    const body = el('div', {});
    body.append(el('p', { class: 'admin-hint', text: '우리 프로젝트·과업 편집(라이블리 웹/MCP)을 외부 PM 도구에 미러로 반영합니다(아웃바운드 push). 커넥터(인바운드 싱크)의 역방향 — 우리 DB가 master, 외부는 미러. 소스별로 켜고 끕니다.' }));
    const table = el('table', { class: 'fields-table' });
    table.append(el('tr', {}, el('th', { text: '소스' }), el('th', { text: '상태' }), el('th', { text: '설정' })));
    // ClickUp — 유일한 구현 소스. on/off = push-clickup 크론.
    const enabled = !!(pushClickup && pushClickup.enabled);
    const toggle = el('button', { class: 'btn btn-ghost btn-sm', text: enabled ? '끄기' : '켜기' });
    if (!canEdit)
        toggle.disabled = true;
    toggle.addEventListener('click', async () => {
        if (!enabled && !container) {
            toast('먼저 컨테이너 리스트를 설정하세요 (외부 자료 수집 ▸ ClickUp)', true);
            return;
        }
        toggle.disabled = true;
        try {
            await api('/api/ui/cron', { method: 'POST', body: JSON.stringify({ id: 'push-clickup', action: 'connector_push', interval_sec: (pushClickup && pushClickup.interval_sec) || 120, params: { system: 'clickup' }, enabled: !enabled }) });
            toast(!enabled ? 'ClickUp push 켜짐 — 로컬 편집이 미러에 반영됩니다' : 'ClickUp push 꺼짐');
            rerender();
        }
        catch (e) {
            toast(e.message, true);
            toggle.disabled = false;
        }
    });
    table.append(el('tr', {}, el('td', {}, el('span', { class: 'mini-title', text: 'ClickUp' })), el('td', {}, el('span', { class: 'pill' + (enabled ? ' pill-ok' : ''), text: enabled ? '켜짐 · 2분마다' : '꺼짐' }), ' ', toggle), el('td', {}, container ? el('span', { class: 'mini-meta', text: '컨테이너 리스트: ' + container }) : el('span', { class: 'pill', text: '⚠ 컨테이너 미설정' }), el('span', { text: '  ' }), el('a', { href: '#/system/connectors', text: '커넥터 설정 →' }))));
    // GitHub Issues · Jira — 아웃바운드 어댑터 미구현.
    for (const s of ['GitHub Issues', 'Jira']) {
        table.append(el('tr', {}, el('td', {}, el('span', { class: 'mini-title', text: s })), el('td', {}, el('span', { class: 'pill', text: '미구현' })), el('td', {}, el('span', { class: 'mini-meta', text: '아웃바운드 어댑터 예정 (#975) — SPI write method + 소스별 매핑' }))));
    }
    body.append(table);
    body.append(el('p', { class: 'admin-hint', style: 'margin-top:10px', text: '※ 인바운드 싱크(외부→우리)와 토큰·컨테이너 설정은 [외부 자료 수집] 탭에 있습니다. 여기는 아웃바운드(우리→외부) on/off 전용입니다.' }));
    detail.replaceChildren(sectionHead('프로젝트 아웃바운드', '우리 프로젝트와 과업의 변경을 외부 협업 도구로 내보냅니다.', meaning), el('div', { class: 'card' }, cardHead('내보내는 항목'), body));
}
function dbSourceEditor(detail, data) {
    const sources = data.dbSources || [];
    const envSources = data.envSources || [];
    const sel = state.admin.dbSrcSel;
    const listCol = el('div', { class: 'admin-sublist' });
    listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ DB 소스 추가',
        onclick: () => { state.admin.dbSrcSel = '__new__'; renderAdminDetail(detail, 'db-sources', data); } }));
    for (const s of sources) {
        listCol.append(el('div', { class: 'mini-row' + (s.name === sel ? ' sel' : ''),
            onclick: () => { state.admin.dbSrcSel = s.name; renderAdminDetail(detail, 'db-sources', data); } }, el('div', { class: 'mini-title', text: s.name }, s.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null), el('div', { class: 'mini-meta', text: (s.host || '-') + ' · ' + (s.auth_mode || 'password') + (s.rls ? ' · RLS' : '') })));
    }
    // env 소스(.env/DB_SOURCES_JSON) — 읽기 전용(여기선 편집 불가).
    for (const s of envSources) {
        listCol.append(el('div', { class: 'mini-row mini-ro' }, el('div', { class: 'mini-title', text: s.name }, el('span', { class: 'pill', text: 'env' })), el('div', { class: 'mini-meta', text: (s.host || '-') + ' · 읽기 전용(.env)' })));
    }
    const right = el('div', {});
    const editing = sel === '__new__'
        ? { name: '', driver: 'postgres', url: '', auth_mode: 'password', auth_ref: '', rls: '', max_rows: '', timeout_ms: '', note: '', enabled: true }
        : sources.find((s) => s.name === sel);
    if (editing)
        dbSourceForm(right, editing, data, detail, sel === '__new__');
    else
        right.append(el('p', { class: 'admin-hint', text: 'db_query/db_schema 가 조회하는 외부 운영 DB 목록입니다. 읽기 전용 role(RLS 적용)로 접속하는 것을 전제로 하며, 접속 비밀번호는 값을 저장하지 않고 환경변수 이름(auth_ref)만 저장합니다. 왼쪽에서 소스를 선택하면 테이블 정책·컬럼 마스킹, 원본 열람 권한, 감사 대상 식별자 설정이 함께 열립니다. .env 로 등록한 소스는 「env」 표시가 붙으며 이 화면에서는 수정할 수 없습니다.' }));
    // 등록된 소스를 고르면 그 소스의 **설정** 3종이 따라 붙는다(라이브 스키마 오버레이, 무재시작):
    //  ① 테이블 정책·컬럼 마스킹 ② 원본 개인정보 열람 권한(unmask grant) ③ 감사 대상 식별자 컬럼(subject-key).
    //  ③은 구 [DB 접근 감사] 화면에 꽂혀 있었지만 그건 **감사가 아니라 설정**이고, 서버도 /org/db-source/subject-key(s)
    //  로 이 소스의 하위 리소스로 본다 — #837 에서 제자리로 옮겼다. 감사 화면엔 '무슨 일이 있었나'만 남는다.
    if (editing && sel !== '__new__') {
        const panel = el('div', { class: 'card', style: 'margin-top:12px' });
        right.append(panel);
        void renderDbPolicyPanel(panel, sel);
        const gpanel = el('div', { class: 'card', style: 'margin-top:12px' });
        right.append(gpanel);
        void renderUnmaskGrantPanel(gpanel, sel, data);
        const spanel = el('div', { class: 'card', style: 'margin-top:12px' });
        right.append(spanel);
        void renderSubjectKeyPanel(spanel, sel, data);
    }
    const rcDb = data.runtimeConfig || { allowed_db_hosts: [], allowed_db_secret_refs: [] };
    const dbSafety = allowlistCard(data, 'DB 접속 안전범위 (allowlist)', 'db_query/db_schema 의 DB 접속을 아래 두 목록으로 제한합니다. 목록에 없는 대상은 차단됩니다.', [
        { key: 'allowed_db_hosts', label: '허용 DB host (allowed_db_hosts)', initial: rcDb.allowed_db_hosts, placeholder: 'localhost\ndb.internal.acme.com\n줄당 host 한 개',
            hint: '접속을 허용할 사설/내부 host 입니다. 목록에 없는 사설망·localhost 접속은 차단됩니다(SSRF 방어). 외부 공인 DB 는 등록하지 않아도 됩니다.' },
        { key: 'allowed_db_secret_refs', label: '허용 비밀번호 환경변수 이름 (allowed_db_secret_refs)', initial: rcDb.allowed_db_secret_refs, placeholder: 'HONEST_RDS_RO_PASSWORD\n줄당 환경변수 이름 한 개(값 금지)',
            hint: 'auth_ref 가 참조할 수 있는 비밀번호 환경변수 이름입니다. 값이 아니라 이름만 적으며, 실제 값은 게이트웨이 프로세스 환경변수에 있어야 합니다.' },
    ]);
    // 메인 카드와 안전범위 카드가 detail 직속으로 붙어 여백 0 이었다 → admin-stack(gap:14px)으로 감싼다(#req).
    detail.replaceChildren(sectionHead('DB 데이터소스', 'AI가 조회할 수 있는 데이터베이스를 등록하고, 어느 테이블까지 어떻게 보여줄지 정합니다.', data.meaning['db-source']), el('div', { class: 'admin-stack' }, el('div', { class: 'card' }, cardHead('등록된 DB 소스'), el('div', { class: 'admin-two admin-two-cols' }, listCol, right)), dbSafety));
}
function dbSourceForm(root, s, data, detail, isNew) {
    const allowed = (data.runtimeConfig && data.runtimeConfig.allowed_db_secret_refs) || [];
    const nameIn = el('input', { type: 'text', value: s.name, placeholder: '소스 이름(영문/숫자)', disabled: isNew ? null : '' });
    const urlIn = el('input', { type: 'text', value: '', placeholder: isNew ? 'postgres://readonly@host:5432/db (비밀번호 제외)' : ('현재 host: ' + (s.host || '-') + ' · 변경 시에만 입력(비밀번호 제외)') });
    // 드라이버(#715) — postgres | mysql(Aurora). mysql 은 RLS 미지원이라 선택 시 rls 입력을 잠근다.
    const drvSel = el('select', {}, el('option', { value: 'postgres', text: 'postgres' }), el('option', { value: 'mysql', text: 'mysql (Aurora MySQL)' }));
    drvSel.value = s.driver === 'mysql' ? 'mysql' : 'postgres';
    const modeSel = el('select', {}, el('option', { value: 'password', text: 'password (env 참조)' }), el('option', { value: 'iam', text: 'iam (후속)', disabled: '' }), el('option', { value: 'mtls', text: 'mtls (후속)', disabled: '' }), el('option', { value: 'vault', text: 'vault (후속)', disabled: '' }));
    modeSel.value = s.auth_mode || 'password';
    const refIn = el('input', { type: 'text', value: s.auth_ref || '', placeholder: '예: ANALYTICS_DB_PW (env 이름, 값 아님)' });
    const refHint = el('p', { class: 'admin-hint', text: allowed.length ? '참조 가능한 env: ' + allowed.join(', ') : '⚠ 비밀번호 있는 DB면 allowed_db_secret_refs 에 환경변수 이름이 등록돼 있어야 합니다(운영자 설정 · 비밀번호 없는 DB면 비워도 됩니다)' });
    const rlsIn = el('input', { type: 'text', value: s.rls || '', placeholder: 'app.current_user (비우면 행수준 격리 없음)' });
    const syncDrv = () => {
        const my = drvSel.value === 'mysql';
        if (isNew)
            urlIn.placeholder = my ? 'mysql://readonly@host:3306/dbname (비밀번호 제외 · 스키마 필수)' : 'postgres://readonly@host:5432/db (비밀번호 제외)';
        rlsIn.disabled = my;
        if (my)
            rlsIn.value = '';
        rlsIn.placeholder = my ? 'mysql 미지원 — 비움 고정' : 'app.current_user (비우면 행수준 격리 없음)';
    };
    drvSel.addEventListener('change', syncDrv);
    syncDrv();
    const maxIn = el('input', { type: 'number', value: (s.max_rows == null ? '' : s.max_rows), placeholder: '기본 1000' });
    const toIn = el('input', { type: 'number', value: (s.timeout_ms == null ? '' : s.timeout_ms), placeholder: '기본 5000' });
    const noteIn = el('input', { type: 'text', value: s.note || '', placeholder: '설명(선택)' });
    const enChk = el('input', { type: 'checkbox' });
    enChk.checked = s.enabled !== false;
    const tdSel = el('select', {}, el('option', { value: 'allow', text: 'deny-list — 기본 허용(명시 차단만 제외)' }), el('option', { value: 'deny', text: 'allow-list — 기본 차단(명시 허용만 조회 · 컴플라이언스 권장)' }));
    tdSel.value = s.table_default || 'allow';
    const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
        if (!nameIn.value.trim()) {
            toast('이름 필수', true);
            return;
        }
        saveBtn.disabled = true;
        try {
            const urlV = urlIn.value.trim();
            if (isNew && !urlV) {
                toast('접속 URL 필수', true);
                saveBtn.disabled = false;
                return;
            }
            const payload = {
                name: nameIn.value.trim(), driver: drvSel.value, auth_mode: modeSel.value,
                auth_ref: refIn.value.trim() || null,
                rls: drvSel.value === 'mysql' ? null : (rlsIn.value.trim() || null),
                max_rows: maxIn.value ? Number(maxIn.value) : null,
                timeout_ms: toIn.value ? Number(toIn.value) : null,
                note: noteIn.value.trim() || null, enabled: enChk.checked, table_default: tdSel.value,
            };
            if (urlV)
                payload.url = urlV; // 빈칸 = url 미변경(수정 시)
            await api('/api/ui/org/db-source', { method: 'POST', body: JSON.stringify(payload) });
            await loadAdmin(true);
            state.admin.dbSrcSel = payload.name;
            toast('저장됨 — 즉시 조회 가능');
            renderAdminDetail(detail, 'db-sources', state.admin.data);
        }
        catch (e) {
            toast(e.message, true);
            saveBtn.disabled = false;
        }
    });
    const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
    if (!isNew)
        actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
                if (!confirm(`DB 소스 '${s.name}' 제거?`))
                    return;
                try {
                    await api('/api/ui/org/db-source/remove', { method: 'POST', body: JSON.stringify({ name: s.name }) });
                    await loadAdmin(true);
                    state.admin.dbSrcSel = null;
                    toast('제거됨');
                    renderAdminDetail(detail, 'db-sources', state.admin.data);
                }
                catch (e) {
                    toast(e.message, true);
                }
            } }));
    root.replaceChildren(field('이름', nameIn), field('드라이버 (driver)', drvSel), field('접속 URL (비밀번호 제외)', urlIn), field('인증 방식 (auth_mode)', modeSel), field('비밀번호 환경변수 이름 (auth_ref)', refIn), refHint, field('RLS GUC (rls)', rlsIn), field('최대 행수 (max_rows)', maxIn), field('타임아웃 ms (timeout_ms)', toIn), field('테이블 기본자세 (table_default)', tdSel), field('설명', noteIn), el('label', { class: 'admin-check' }, enChk, ' 활성'), actions);
}
// ── 테이블 정책 · 컬럼 마스킹 패널(#186) — 라이브 스키마 오버레이. 고객 DB 무수정, 게이트웨이 집행. ──
async function renderDbPolicyPanel(panel, source) {
    panel.replaceChildren(el('p', { class: 'admin-hint', text: '스키마 불러오는 중…' }));
    let ov;
    try {
        ov = await api('/api/ui/org/db-source/schema?source=' + encodeURIComponent(source));
    }
    catch (e) {
        panel.replaceChildren(el('p', { class: 'admin-hint', text: '스키마 로드 실패: ' + e.message }));
        return;
    }
    const openT = state.admin.dbPolTable || null;
    panel.replaceChildren(sectionTitle('테이블 정책 · 컬럼 마스킹', '이 소스에서 조회 가능한 테이블과 개인정보 컬럼 마스킹을 관리합니다 — 고객 DB 무수정, 게이트웨이가 결정론적으로 집행.'), el('p', { class: 'admin-hint', text: '기본자세: ' + (ov.table_default === 'deny'
            ? 'allow-list(기본 차단 — 명시 허용만 조회)' : 'deny-list(기본 허용 — 명시 차단만 제외)') + ' · 위 폼의 table_default 로 변경' }));
    const tbl = el('table', { class: 'fields-table' });
    tbl.append(el('tr', {}, el('th', { text: '테이블' }), el('th', { text: '조회' }), el('th', { text: '마스킹' }), el('th', { text: '컬럼' })));
    for (const t of (ov.tables || [])) {
        if (t.system) { // 게이트웨이 내부 테이블 — 항상 차단(웹 편집 불가), 정직하게 표시
            tbl.append(el('tr', { class: 'mini-ro' }, el('td', { text: t.name }), el('td', {}, el('span', { class: 'pill', text: '시스템 차단' })), el('td', { class: 'mini-meta', text: '잠금' }), el('td', {})));
            continue;
        }
        const allowed = t.mode === 'allow';
        const toggle = el('button', { class: 'btn btn-ghost btn-sm', text: allowed ? '허용' : '차단',
            onclick: async () => { await setTablePolicy(source, t.name, allowed ? 'deny' : 'allow'); void renderDbPolicyPanel(panel, source); } });
        const isOpen = t.name === openT;
        const colsBtn = el('button', { class: 'btn-text', text: (isOpen ? '▾ 컬럼' : '▸ 컬럼') + (t.maskedCount ? ` (${t.maskedCount})` : '') });
        colsBtn.addEventListener('click', () => { state.admin.dbPolTable = isOpen ? null : t.name; void renderDbPolicyPanel(panel, source); });
        tbl.append(el('tr', { class: allowed ? '' : 'mini-ro' }, el('td', { text: t.name }), el('td', {}, toggle), el('td', { class: 'mini-meta', text: t.maskedCount ? (t.maskedCount + ' 컬럼') : '–' }), el('td', {}, colsBtn)));
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
    try {
        ov = await api('/api/ui/org/db-source/schema?source=' + encodeURIComponent(source) + '&table=' + encodeURIComponent(table));
    }
    catch (e) {
        cell.replaceChildren(el('span', { class: 'admin-hint', text: '컬럼 로드 실패: ' + e.message }));
        return;
    }
    const STYLES = [['', '(마스킹 없음)'], ['full', 'full — 전체 ***'], ['partial', 'partial — 앞1·뒤1'], ['email', 'email — 로컬부 가림'], ['hash', 'hash — sha256'], ['null', 'null — 널']];
    const ct = el('table', { class: 'fields-table', style: 'margin:6px 0 0 12px' });
    for (const c of (ov.columns || [])) {
        const box = el('select', {});
        for (const [v, label] of STYLES)
            box.append(el('option', { value: v, text: label }));
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
    try {
        await api('/api/ui/org/db-source/table-policy', { method: 'POST', body: JSON.stringify({ source, table, mode }) });
        toast(mode === 'allow' ? '허용됨' : '차단됨');
    }
    catch (e) {
        toast(e.message, true);
    }
}
async function setColumnMask(source, table, column, style) {
    try {
        await api('/api/ui/org/db-source/column-mask', { method: 'POST', body: JSON.stringify(style ? { source, table, column, style } : { source, table, column, remove: true }) });
        toast(style ? ('마스킹: ' + style) : '마스킹 해제');
    }
    catch (e) {
        toast(e.message, true);
    }
}
// ── [대상 구성원](#860) — 정책(전원 켬/끔/지정) + 구성원별 예외를 한 자리에. 자산·훅 공용. ──
//  #699 가 서버(org_asset_pref_set)·부트스트랩 데이터까지 만들어 두고 UI 만 안 끝냈던 자리다.
//
//  전원 on/off 를 **정책 레이어**(enabled·target_members)에 두는 게 이 화면의 핵심 결정이다. 구성원 전원에게
//  예외 행(org_asset_pref)을 일괄로 박는 방식도 가능하지만, 그러면 그 뒤 합류한 구성원은 행이 없어 정책
//  기본값으로 새고 관리자는 "전원 껐다"고 믿게 된다. 정책은 신규 구성원에게도 자동 적용되므로 그 구멍이 없다.
//  예외 레이어의 일괄 연산은 '전체 기본값 복귀'(예외 일괄 삭제) 하나만 둔다.
//
//  ⚠ 두 레이어는 **저장 시점이 다르다** — 섞이면 사용자가 뭘 눌렀는지 모른다. 상자를 갈라 각각 명시한다:
//   · 정책 = 이 폼의 필드라 아래 [저장] 을 눌러야 반영.
//   · 예외 = 별개 객체(org_asset_pref)라 버튼 클릭 즉시 반영.
//  그래서 정책만 고치고 저장 안 한 동안 아래 표의 실효 상태는 **옛 정책 기준**이다 — 그 사실을 배지로 알린다.
//
//  실효 상태는 서버가 SoT(src/org/asset-visibility.ts)로 계산해 준 값만 그린다. 여기서 재계산하면 그 파일이
//  "세 곳이 똑같이 구현한다 — 드리프트 금지"라고 못박은 규칙의 4번째 사본이 된다(web/ 는 src/ 를 import 못 함).
//  저장 후엔 호출부가 renderAdminDetail 로 폼을 통째로 다시 그리므로, 저장본 반영은 재생성이 담당한다.
function targetMembersField(targetKind, item, isNew) {
    const refId = item.id;
    const modeOf = (enabled, targets) => (enabled === false ? 'off' : (targets && targets.length ? 'some' : 'all'));
    let mode = modeOf(item.enabled, item.target_members);
    const saved = { mode, targets: (item.target_members || []).join(', ') }; // 마지막 저장본 — 표가 '저장 전'인지 판정
    const MODES = [
        ['all', '전원 켬', '지금 있는 구성원과 **앞으로 합류할 구성원**까지 전원에게 갑니다. 개인별 예외는 아래 표에서.'],
        ['off', '전원 끔', '전원에게 차단됩니다 — **아래 개인 예외도 이걸 못 이깁니다**(마스터 스위치).'],
        ['some', '지정한 사람만', '적은 구성원에게만 갑니다. 목록에 없으면 기본값이 «끔» 이고, **나중에 합류하는 구성원도 자동 제외**됩니다.'],
    ];
    const targetIn = el('input', { type: 'text', value: saved.targets, placeholder: '구성원 id 쉼표구분 (예: yoon, jang)' });
    const targetsNow = () => targetIn.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const enabledNow = () => mode !== 'off';
    // 'some' 인데 목록이 비면 서버는 그걸 '전원'으로 읽는다(target_members NULL/빈=전원) — 화면과 어긋나므로 저장 시 막는다.
    //  '전원 끔'은 target_members 를 **안 보낸다**(undefined=보존) — 마스터킬은 타깃팅과 직교하므로, 잠깐 껐다 켜는 동안
    //  애써 지정해 둔 명단을 날리면 안 된다(구 UI 는 [활성] 체크박스와 명단이 별개 필드라 보존됐다 — 그 계약 유지).
    const targetsPayload = () => {
        if (mode === 'off')
            return undefined; // 보존
        if (mode === 'all')
            return null; // 전원 = 명단 비움
        return targetsNow().length ? targetsNow() : null;
    };
    const segBar = el('div', { class: 'tm-seg' });
    const modeHint = el('p', { class: 'tm-hint' });
    const targetRow = el('div', { class: 'field', style: 'margin:10px 0 0' }, el('label', { class: 'field-label', text: '대상 구성원 id' }), targetIn);
    const staleNote = el('div', { class: 'tm-stale' });
    const countEl = el('span', { class: 'tm-count' });
    const openBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '구성원별 조정…' });
    const clearBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '전체 기본값 복귀' });
    let rows = []; // 서버가 준 구성원별 상태(정책 기본값·오버라이드·실효)
    let listHost = null; // 모달이 열려 있는 동안의 행 컨테이너(닫히면 isConnected=false → 자동 폐기)
    const dirty = () => mode !== saved.mode || (mode === 'some' && targetIn.value.trim() !== saved.targets);
    const paintPolicy = () => {
        for (const b of segBar.children) {
            b.classList.toggle('on', b.dataset.m === mode);
            b.setAttribute('aria-pressed', String(b.dataset.m === mode));
        }
        modeHint.replaceChildren(...inlineBold(MODES.find((m) => m[0] === mode)[2]));
        targetRow.style.display = mode === 'some' ? '' : 'none';
        staleNote.textContent = dirty() ? '정책을 바꿨습니다 — [저장] 해야 구성원별 실효 상태에 반영됩니다.' : '';
        staleNote.style.display = dirty() ? '' : 'none';
        if (listHost?.isConnected)
            listHost.classList.toggle('tm-list-stale', dirty());
    };
    for (const [m, label] of MODES) {
        const b = el('button', { type: 'button', class: 'tm-seg-btn', text: label });
        b.dataset.m = m;
        b.addEventListener('click', () => { mode = m; paintPolicy(); });
        segBar.append(b);
    }
    segBar.setAttribute('role', 'group');
    targetIn.addEventListener('input', paintPolicy);
    // 구성원별 예외 — 서버(/api/ui/org/asset-members)가 SoT 로 계산한 byDefault·override·effective 를 그대로 그린다.
    //  seq: 버튼을 빠르게 여러 번 누르면 먼저 띄운 GET 이 나중에 도착해 표를 옛 상태로 덮을 수 있다 — 마지막 요청만 그린다.
    let seq = 0;
    const reload = async () => {
        const mine = ++seq;
        try {
            const d = await api(`/api/ui/org/asset-members?target_kind=${encodeURIComponent(targetKind)}&ref_id=${encodeURIComponent(refId)}`);
            if (mine !== seq)
                return; // 더 최신 요청이 이미 떴다 — 이 응답은 버린다
            rows = d.members || [];
        }
        catch (e) {
            if (mine !== seq)
                return;
            countEl.textContent = '구성원 상태를 불러오지 못했습니다';
            openBtn.disabled = clearBtn.disabled = true;
            if (listHost?.isConnected)
                listHost.replaceChildren(errorNote(e, '구성원 상태를 불러오지 못했습니다'));
            return;
        }
        paintSummary();
        if (listHost?.isConnected)
            paintList(); // 모달이 열려 있으면 같이 갱신
    };
    // 폼에 남는 건 요약 한 줄뿐 — 구성원 42명을 폼에 깔면 [저장] 이 스크롤 저 아래로 밀린다.
    const paintSummary = () => {
        const exceptions = rows.filter((r) => r.override !== null).length;
        const inactive = rows.filter((r) => r.state !== 'active').length;
        countEl.textContent = `구성원 ${rows.length - inactive}명`
            + (inactive ? ` · 비활성 ${inactive}명` : '')
            + (exceptions ? ` · 예외 ${exceptions}명` : ' · 예외 없음');
        openBtn.disabled = !rows.length;
        clearBtn.disabled = !exceptions;
    };
    const paintList = () => {
        const q = String(searchIn?.value || '').trim().toLowerCase();
        const shown = rows.filter((r) => !q || r.id.toLowerCase().includes(q) || String(r.display_name || '').toLowerCase().includes(q));
        const node = (r) => {
            const dead = r.state !== 'active'; // 비활성 = 인증부터 막힌다 → 정책과 무관하게 아무것도 못 받는다
            const stateNow = r.override === null ? 'default' : (r.override ? 'on' : 'off');
            const seg = el('div', { class: 'tm-seg tm-seg-row', role: 'group' });
            for (const [v, label] of [['default', '기본' + (r.byDefault ? '(켬)' : '(끔)')], ['on', '켜기'], ['off', '끄기']]) {
                const on = stateNow === v;
                const b = el('button', { type: 'button', class: 'tm-seg-btn' + (on ? ' on' : ''), text: label, 'aria-pressed': String(on) });
                b.addEventListener('click', async () => {
                    const body = { target_kind: targetKind, ref_id: refId, member_id: r.id };
                    if (v === 'default')
                        body.clear = true;
                    else
                        body.state = (v === 'on');
                    try {
                        await api('/api/ui/org/asset-pref', { method: 'POST', body: JSON.stringify(body) });
                        await reload();
                    }
                    catch (e) {
                        toast((e && e.message) || '실패', true);
                    }
                });
                seg.append(b);
            }
            // 비활성이면 예외 설정은 남겨 둔다(복직 시 되살아나고, 지금 정리할 수도 있어야 하니) — 다만 '적용 중'이라고 말하지 않는다.
            const why = dead ? '비활성 구성원 — 접속 불가'
                : (r.override === null ? '정책 기본값' : (r.override ? '강제 켬 · 예외' : '강제 끔 · 예외'));
            return el('div', { class: 'tm-row' + (r.override !== null ? ' exc' : '') + (dead ? ' dead' : '') }, el('div', { class: 'tm-who' }, el('span', { class: 'tm-name', text: r.display_name || r.id }), el('span', { class: 'tm-id', text: r.id }), dead ? el('span', { class: 'pill', text: '비활성' }) : null, r.kind !== 'human' ? el('span', { class: 'pill', text: r.kind === 'agent' ? 'AI' : '시스템' }) : null), el('div', { class: 'tm-state' }, el('span', { class: 'pill' + (r.effective ? ' tm-on' : ''), text: r.effective ? '적용 중' : '미적용' }), el('span', { class: 'tm-why', text: why })), seg);
        };
        listHost.replaceChildren(...(shown.length ? shown.map(node) : [el('p', { class: 'admin-hint', text: '검색 결과가 없습니다.' })]));
    };
    // 구성원별 예외는 **모달**로 — 폼에 인라인으로 깔면 구성원 수만큼 길어져(현재 42명) [저장] 이 화면 밖으로 밀린다.
    //  폼엔 요약 한 줄(구성원 N명 · 예외 M명)만 남기고, 조정이 필요할 때만 연다.
    let searchIn = null;
    const openModal = () => {
        searchIn = el('input', { type: 'search', class: 'tm-search', placeholder: '이름·id 검색', style: 'width:180px' });
        searchIn.addEventListener('input', () => { if (listHost?.isConnected)
            paintList(); });
        listHost = el('div', { class: 'tm-list' + (dirty() ? ' tm-list-stale' : '') });
        const note = dirty()
            ? el('div', { class: 'tm-stale', text: '정책이 저장 전입니다 — 아래 실효 상태는 아직 옛 정책 기준이에요.' }) : null;
        overlay(`구성원별 예외 — ${item.label || item.id}`, el('p', { class: 'admin-hint', style: 'margin:0 0 10px' }, ...inlineBold('**클릭 즉시 반영**됩니다(구성원 다음 세션부터). 예외를 두지 않으면 위 정책 기본값을 따릅니다.')), el('div', { class: 'tm-members-head' }, searchIn, el('span', { class: 'tm-when', style: 'margin-left:auto', text: '클릭 즉시 반영' })), note, listHost);
        paintList();
    };
    openBtn.addEventListener('click', openModal);
    clearBtn.addEventListener('click', async () => {
        if (!confirm('이 스킬/훅의 구성원 예외를 전부 지울까요? 전원이 위 정책을 따르게 됩니다.'))
            return;
        try {
            const r = await api('/api/ui/org/asset-prefs/clear', { method: 'POST', body: JSON.stringify({ target_kind: targetKind, ref_id: refId }) });
            toast(`예외 ${r.cleared}건 해제됨`);
            await reload();
        }
        catch (e) {
            toast((e && e.message) || '실패', true);
        }
    });
    const membersCard = isNew
        ? el('p', { class: 'admin-hint', style: 'margin:10px 0 0', text: '먼저 저장하면 구성원별로 예외(강제 켬/끔)를 둘 수 있어요.' })
        : el('div', { class: 'tm-members' }, countEl, openBtn, clearBtn);
    if (!isNew) {
        countEl.textContent = '불러오는 중…';
        openBtn.disabled = clearBtn.disabled = true;
        void reload();
    }
    paintPolicy();
    return {
        node: el('div', { class: 'tm' }, el('div', { class: 'tm-policy' }, el('div', { class: 'tm-members-head' }, el('b', { text: '전원 (정책 기본값)' }), el('span', { class: 'tm-when', text: '[저장] 을 눌러야 반영' })), segBar, modeHint, targetRow), staleNote, membersCard),
        enabled: enabledNow,
        targetMembers: targetsPayload,
        // 'some' 인데 목록이 비었으면 저장 거부 — 서버가 빈 배열을 '전원'으로 읽어 화면과 정반대가 된다.
        validate: () => (mode === 'some' && !targetsNow().length ? '‘지정한 사람만’ 을 골랐으면 대상 구성원 id 를 하나 이상 적으세요 (비우면 전원이 됩니다).' : null),
    };
}
// ── 커스텀 훅 — runtime 권한 ──
function customHookEditor(detail, data) {
    const hooks = data.orgHooks || [];
    const sel = state.admin.hookSel;
    const listCol = el('div', { class: 'admin-sublist' });
    listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ 추가',
        onclick: () => { state.admin.hookSel = '__new__'; renderAdminDetail(detail, 'custom-hooks', data); } }));
    for (const h of hooks) {
        const failed = Object.keys(h.health || {}).length; // #892 — 죽은 훅을 목록에서 바로 보이게(조용한 죽음 방지)
        listCol.append(el('div', { class: 'mini-row' + (h.id === sel ? ' sel' : ''),
            onclick: () => { state.admin.hookSel = h.id; renderAdminDetail(detail, 'custom-hooks', data); } }, el('div', { class: 'mini-title', text: h.id }, h.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null, failed ? el('span', { class: 'pill pill-warn', text: '⚠ 실패 ' + failed + '대' }) : null), el('div', { class: 'mini-meta', text: h.event + (h.matcher ? ' · ' + h.matcher : '') + ' · ' + (h.harness || 'all')
                + (h.target_members && h.target_members.length ? ' · 지정 ' + h.target_members.length + '명' : '') })));
    }
    const right = el('div', {});
    const editing = sel === '__new__'
        ? { id: '', label: '', harness: 'all', event: 'PostToolUse', matcher: '', source_code: '', timeout_sec: 10, note: '', target_members: null, enabled: true }
        : hooks.find((h) => h.id === sel);
    if (editing)
        hookForm(right, editing, data, detail, sel === '__new__');
    else
        right.append(
        // origin/main(#968 계열)의 개선된 안내 문구 + #892 의 정책 카드 — 둘 다 유지.
        el('p', { class: 'admin-hint', text: '구성원 머신에서 특정 시점에 자동 실행되는 코드입니다. 본문은 구성원 디스크에 저장되지 않고 매 세션 게이트웨이에서 받아 실행됩니다(비활성화하면 다음 세션부터 실행되지 않습니다). 왼쪽 목록에서 항목을 선택하면 내용을 보고 편집할 수 있습니다.' }), relayPolicyCard(data, detail), gracePolicyCard(data, detail));
    detail.replaceChildren(el('div', { class: 'card' }, cardHead('커스텀 훅'), el('div', { class: 'admin-two admin-two-cols' }, listCol, right)));
}
// PreToolUse 결정 전파 정책(#892) — 러너가 훅의 permissionDecision 중 무엇을 하네스로 넘길지.
//  훅 하나가 아니라 러너 전체에 걸리는 org 정책이라 훅 폼이 아니라 목록 화면(훅 미선택 시)에 둔다.
function relayPolicyCard(data, detail) {
    const rc = data.runtimeConfig;
    if (!rc)
        return el('span', {}); // 비-admin 은 runtimeConfig 를 못 받는다 → 정책 카드 숨김
    const cur = new Set(rc.hook_relay_decisions || ['deny', 'ask', 'defer']);
    const DESC = {
        deny: 'deny — 도구 실행을 막는다(게이트). 훅이 준 사유가 AI 에게 전달된다.',
        ask: 'ask — 사용자에게 권한 프롬프트를 띄운다.',
        defer: 'defer — 비대화형(-p) 실행에서 판단을 미룬다.',
        allow: 'allow — 권한 프롬프트를 건너뛰고 즉시 허용. ⚠ 구성원의 동의 화면이 사라집니다.',
    };
    const boxes = ['deny', 'ask', 'defer', 'allow'].map((d) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = cur.has(d);
        cb.dataset.decision = d;
        return el('label', { class: 'admin-check' }, cb, el('span', { text: DESC[d] }));
    });
    const save = el('button', { class: 'btn btn-primary btn-sm', text: '정책 저장' });
    save.addEventListener('click', async () => {
        const picked = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.dataset.decision);
        // deny 를 빼는 건 allow 를 켜는 것보다 위험하다 — 모든 PreToolUse 게이트가 조용히 무력해진다.
        //  #892 자체가 'deny 가 조용히 전파를 멈춘' 사고였다. 그 상태를 클릭 한 번에 만들 수 있으면 안 된다.
        if (!picked.includes('deny')
            && !confirm(picked.length
                ? 'deny 를 빼면 도구를 막는 훅(게이트)이 전부 무력해집니다 — 훅은 돌지만 아무것도 못 막습니다. 계속할까요?'
                : '전부 해제하면 모든 PreToolUse 훅의 결정이 무시됩니다(게이트 전면 해제). 계속할까요?'))
            return;
        if (picked.includes('allow') && !confirm('allow 를 전파하면 관리자 훅이 구성원의 권한 프롬프트(동의 화면)를 건너뛸 수 있습니다. 계속할까요?'))
            return;
        save.disabled = true;
        try {
            await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ hook_relay_decisions: picked }) });
            await loadAdmin(true);
            toast('저장됨 — 구성원 다음 세션부터');
            renderAdminDetail(detail, 'custom-hooks', state.admin.data);
        }
        catch (e) {
            toast(e.message, true);
            save.disabled = false;
        }
    });
    return el('div', { class: 'admin-subcard' }, el('h4', { text: '도구 게이트 정책 (PreToolUse)' }), el('p', { class: 'admin-hint', text: 'PreToolUse 훅이 내리는 결정 중 러너가 하네스로 실제 전달할 값입니다. 체크 해제하면 그 결정은 무시됩니다(훅은 돌지만 효과 없음). 기본값은 deny·ask·defer — allow 는 구성원의 동의 화면을 없애므로 기본에서 빠져 있습니다.' }), ...boxes, el('div', { class: 'admin-actions' }, save));
}
// 오프라인 캐시 유효기간(#1008) — 게이트웨이에 연결 안 되는 동안 마지막으로 받은 커스텀 훅을 얼마나 오래 계속 실행할지.
//  러너 전체에 걸리는 org 정책이라 relayPolicyCard 와 같은 목록 화면(훅 미선택 시)에 둔다. 무제한(기본) = 마지막 접속 기준
//  영구 실행 → 게이트웨이 없이도 동작하는 로컬 훅(스킬 라우터·품질 게이트)이 오프라인에서 유지된다. 기간을 정하면 회수창.
function gracePolicyCard(data, detail) {
    const rc = data.runtimeConfig;
    if (!rc)
        return el('span', {}); // 비-admin 은 runtimeConfig 를 못 받는다 → 카드 숨김
    // 프리셋: '' = 무제한(null), '0' = 즉시 중단, 그 외는 ms. 현재값이 프리셋에 없으면 아래에서 별도 옵션으로 추가.
    const PRESETS = [
        ['', '무제한 — 마지막 접속 기준 영구 실행 (기본·권장)'],
        ['0', '즉시 중단 — 연결이 끊기면 바로 커스텀 훅 정지 (가장 보수적)'],
        ['600000', '10분 (종전 기본값)'],
        ['3600000', '1시간'],
        ['21600000', '6시간'],
        ['86400000', '1일'],
        ['604800000', '7일'],
    ];
    const curVal = (rc.hook_grace_ms === null || rc.hook_grace_ms === undefined) ? '' : String(rc.hook_grace_ms);
    const sel = el('select', {}, ...PRESETS.map(([v, label]) => el('option', { value: v, text: label })));
    if (!PRESETS.some(([v]) => v === curVal))
        sel.append(el('option', { value: curVal, text: `현재 설정: ${curVal}ms` }));
    sel.value = curVal;
    const save = el('button', { class: 'btn btn-primary btn-sm', text: '정책 저장' });
    save.addEventListener('click', async () => {
        const v = sel.value === '' ? null : Number(sel.value);
        save.disabled = true;
        try {
            await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ hook_grace_ms: v }) });
            await loadAdmin(true);
            toast('저장됨 — 구성원 다음 세션부터');
            renderAdminDetail(detail, 'custom-hooks', state.admin.data);
        }
        catch (e) {
            toast(e.message, true);
            save.disabled = false;
        }
    });
    return el('div', { class: 'admin-subcard' }, el('h4', { text: '오프라인 캐시 유효기간 (게이트웨이 미연결 시)' }), el('p', { class: 'admin-hint', text: '게이트웨이에 연결되지 않는 동안, 마지막으로 받은 커스텀 훅을 얼마나 오래 계속 실행할지입니다. 무제한(기본)이면 마지막 접속 기준으로 계속 실행됩니다 — 게이트웨이 없이 동작하는 로컬 훅(스킬 라우터·품질 게이트 등)이 오프라인에서도 유지됩니다. 기간을 정하면 그 시간이 지난 뒤 커스텀 훅 실행을 멈춥니다(제거한 훅의 회수 목적). 어느 경우든 훅 본문 무결성(content_hash)은 캐시에서도 검증되고, 재연결 시 즉시 갱신·회수됩니다.' }), field('연결 끊긴 뒤 유지 기간', sel), el('div', { class: 'admin-actions' }, save));
}
function hookForm(root, h, data, detail, isNew) {
    const idIn = el('input', { type: 'text', value: h.id, placeholder: '훅 id (소문자/숫자/_-)', disabled: isNew ? null : '' });
    const labelIn = el('input', { type: 'text', value: h.label || '', placeholder: '표시 이름(선택)' });
    // 구성원 화면([내 스킬·훅])에 보이는 쉬운 한 줄(#1085) — 스킬과 같은 규격.
    const hSumIn = el('input', { type: 'text', value: h.summary || '', placeholder: '예: 세션이 끝날 때 기록을 남겼는지 점검합니다' });
    const harnessSel = el('select', {}, ...['all', 'claude', 'codex', 'openclaw'].map((x) => el('option', { value: x, text: x })));
    harnessSel.value = h.harness || 'all';
    const eventSel = el('select', {}, ...['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification'].map((x) => el('option', { value: x, text: x })));
    eventSel.value = h.event || 'PostToolUse';
    const matcherIn = el('input', { type: 'text', value: h.matcher || '', placeholder: '예: Bash (PreToolUse/PostToolUse 의 도구 매처)' });
    const codeTa = el('textarea', { rows: '12', class: 'admin-ta', placeholder: '#!/usr/bin/env node\n// 훅 입력은 stdin(JSON), 응답은 stdout / exit code' });
    codeTa.value = h.source_code || '';
    const timeoutIn = el('input', { type: 'number', value: String(h.timeout_sec || 10), min: '1', max: '120' });
    const tm = targetMembersField('org_hook', h, isNew);
    const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
        if (!idIn.value.trim()) {
            toast('id 필수', true);
            return;
        }
        const bad = tm.validate();
        if (bad) {
            toast(bad, true);
            return;
        }
        if (!confirm('이 코드는 구성원 컴퓨터에서 그들의 권한으로 실제 실행됩니다. 저장할까요?'))
            return;
        saveBtn.disabled = true;
        try {
            const payload = { id: idIn.value.trim(), label: labelIn.value.trim() || null, harness: harnessSel.value, event: eventSel.value, matcher: matcherIn.value.trim() || null, source_code: codeTa.value, timeout_sec: Number(timeoutIn.value) || 10, summary: hSumIn.value, target_members: tm.targetMembers(), enabled: tm.enabled() };
            await api('/api/ui/org/hook', { method: 'POST', body: JSON.stringify(payload) });
            await loadAdmin(true);
            state.admin.hookSel = payload.id;
            toast('저장됨 — 구성원 다음 세션부터');
            renderAdminDetail(detail, 'custom-hooks', state.admin.data);
        }
        catch (e) {
            toast(e.message, true);
            saveBtn.disabled = false;
        }
    });
    const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
    if (!isNew)
        actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
                if (!confirm(`커스텀 훅 '${h.id}' 제거? 다음 세션부터 실행되지 않습니다(미접속 머신은 직전 상태 유지).`))
                    return;
                try {
                    await api('/api/ui/org/hook/remove', { method: 'POST', body: JSON.stringify({ id: h.id }) });
                    await loadAdmin(true);
                    state.admin.hookSel = null;
                    toast('제거됨');
                    renderAdminDetail(detail, 'custom-hooks', state.admin.data);
                }
                catch (e) {
                    toast(e.message, true);
                }
            } }));
    root.replaceChildren(el('div', { class: 'warn-badge', text: '⚠ 이 코드는 구성원 컴퓨터에서 그들의 권한으로 실제 실행됩니다.' }), hookHealthCard(h), field('id', idIn), field('표시 이름', labelIn), field('쉬운 한 줄 (구성원 화면에 보이는 말)', hSumIn), field('하네스', harnessSel), field('이벤트(실행 시점)', eventSel), field('매처(선택 — PreToolUse/PostToolUse 의 도구명)', matcherIn), field('코드 (Node.js)', codeTa), field('타임아웃(초, 1~120)', timeoutIn), field('대상 구성원', tm.node), actions);
}
// 훅 건강(#892) — 구성원 러너가 보고한 마지막 실행 실패. 종전엔 훅이 죽어도 화면상 '활성'이라
//  spec-blind guard/tracker 가 등록 이래 내내 죽은 걸 아무도 몰랐다. 실패가 없으면 아무것도 안 그린다.
function hookHealthCard(h) {
    const health = h.health || {};
    const ids = Object.keys(health);
    if (!ids.length)
        return el('span', {});
    const REASON = {
        crash: '실행 중 오류로 죽음', timeout: '타임아웃(시간 초과)',
        hash_mismatch: '무결성 해시 불일치 — 실행 안 함', spawn_error: '실행 자체 실패',
        // 훅은 정상 종료했지만 출력이 결정으로 안 읽혀 하네스가 통째로 무시한 경우 — 죽은 것과 결과가 같다.
        bad_output: '출력을 결정으로 읽을 수 없음 — 하네스가 무시함(게이트 안 걸림)',
    };
    return el('div', { class: 'admin-subcard warn-badge-soft' }, el('h4', { text: '⚠ 이 훅이 구성원 컴퓨터에서 실패하고 있습니다 (' + ids.length + '대)' }), el('p', { class: 'admin-hint', text: '실패한 훅은 아무 효과가 없습니다 — 화면상 "활성"이어도 실제로는 동작하지 않습니다.' }), ...ids.map((m) => {
        const e = health[m] || {};
        return el('div', { class: 'mini-row' }, el('div', { class: 'mini-title', text: m + ' · ' + (REASON[e.reason] || e.reason || '알 수 없음') }), el('div', { class: 'mini-meta', text: (e.at ? new Date(e.at).toLocaleString() : '') + (e.exit_code != null ? ' · exit ' + e.exit_code : '') }), e.stderr ? el('pre', { class: 'admin-pre', text: String(e.stderr).slice(-400) }) : null);
    }));
}
// ── 스킬 · 서브에이전트 · 슬래시커맨드 (org_harness_asset) — runtime 권한 ──
//  화면에서 '자산'이라 부르지 않는다(#859) — 식별자만 asset. 위 §용어 사전 참조.
function harnessAssetEditor(detail, data) {
    const assets = data.orgHarnessAssets || [];
    const sel = state.admin.assetSel;
    const KIND_LABEL = { skill: '스킬', subagent: '서브에이전트', command: '커맨드' };
    // 멤버 셀프업로드(#990) 초안 = draft- 네임스페이스 + 비활성 + 제출자. 관리자가 [승격]으로 배포한다.
    const isDraft = (a) => a.id && a.id.indexOf('draft-') === 0 && a.enabled === false && a.created_by;
    const listCol = el('div', { class: 'admin-sublist' });
    listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ 추가',
        onclick: () => { state.admin.assetSel = '__new__'; renderAdminDetail(detail, 'harness-assets', data); } }));
    for (const a of assets) {
        listCol.append(el('div', { class: 'mini-row' + (a.id === sel ? ' sel' : ''),
            onclick: () => { state.admin.assetSel = a.id; renderAdminDetail(detail, 'harness-assets', data); } }, el('div', { class: 'mini-title', text: a.id }, isDraft(a) ? el('span', { class: 'pill pill-warn', text: '제출 · ' + a.created_by })
            : (a.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null)), el('div', { class: 'mini-meta', text: (KIND_LABEL[a.kind] || a.kind) + ' · ' + (a.harness || 'all')
                + (a.target_members && a.target_members.length ? ' · 지정 ' + a.target_members.length + '명' : '')
                + (a.paired_hook_id ? ' · 연결 훅:' + a.paired_hook_id : '') })));
    }
    const right = el('div', {});
    const editing = sel === '__new__'
        ? { id: '', kind: 'skill', label: '', harness: 'all', description: '', body: '', frontmatter: {}, target_members: null, paired_hook_id: '', enabled: true }
        : assets.find((a) => a.id === sel);
    if (editing)
        assetForm(right, editing, data, detail, sel === '__new__');
    else
        right.append(el('p', { class: 'admin-hint', text: '스킬(작업 방법서)·서브에이전트(보조 AI)·슬래시커맨드(단축 명령)를 정의해 구성원 하네스에 배포합니다. 저장하면 구성원 세션 시작 때 디스크에 동기화되며, 스킬·커맨드는 진행 중인 세션에도 즉시 반영됩니다. 왼쪽 목록에서 항목을 선택하면 내용을 보고 편집할 수 있습니다.' }));
    detail.replaceChildren(el('div', { class: 'card' }, cardHead('스킬 · 서브에이전트 · 커맨드'), el('div', { class: 'admin-two admin-two-cols' }, listCol, right)));
}
function assetForm(root, a, data, detail, isNew) {
    const idIn = el('input', { type: 'text', value: a.id, placeholder: 'id (소문자/숫자/_-)', disabled: isNew ? null : '' });
    const labelIn = el('input', { type: 'text', value: a.label || '', placeholder: '표시 이름(선택)' });
    const kindSel = el('select', {}, ...[['skill', '스킬'], ['subagent', '서브에이전트'], ['command', '슬래시커맨드']].map(([v, t]) => el('option', { value: v, text: t })));
    kindSel.value = a.kind || 'skill';
    const harnessSel = el('select', {}, ...['all', 'claude', 'codex'].map((x) => el('option', { value: x, text: x })));
    harnessSel.value = a.harness || 'all';
    const descIn = el('input', { type: 'text', value: a.description || '', placeholder: 'AI가 이것을 언제 쓸지 판단하는 한 줄 설명(상시 노출)' });
    // 표시용 한 줄(#1085) — 위 '설명'은 AI 트리거 문장이라 길고 기술적이다. 사람 화면([내 스킬·훅])에는 이걸 보여준다.
    const sumIn = el('input', { type: 'text', value: a.summary || '', placeholder: '예: 코드 변경만 보고 기능을 유추해 문서화 품질을 점검합니다' });
    const bodyTa = el('textarea', { rows: '12', class: 'admin-ta', placeholder: '본문(마크다운) — 스킬 방법서 / 에이전트 시스템 프롬프트 / 커맨드 프롬프트' });
    bodyTa.value = a.body || '';
    const fmTa = el('textarea', { rows: '4', class: 'admin-ta', placeholder: '추가 frontmatter(JSON, 선택) — 예: {"model":"opus","allowed-tools":["Read","Grep"]}' });
    fmTa.value = (a.frontmatter && Object.keys(a.frontmatter).length) ? JSON.stringify(a.frontmatter, null, 2) : '';
    const tm = targetMembersField('harness_asset', a, isNew);
    const pairedIn = el('input', { type: 'text', value: a.paired_hook_id || '', placeholder: '연결 훅 id(선택) — 위험 통제용 커스텀 훅' });
    const codexNote = el('p', { class: 'admin-hint' });
    const syncNote = () => {
        codexNote.textContent = (kindSel.value !== 'skill' && (harnessSel.value === 'codex' || harnessSel.value === 'all'))
            ? '※ 서브에이전트·슬래시커맨드는 Codex 네이티브 미지원 — Codex 세션엔 배포되지 않습니다(스킬만 양 하네스). Claude 에만 적용됩니다.' : '';
    };
    kindSel.addEventListener('change', syncNote);
    harnessSel.addEventListener('change', syncNote);
    syncNote();
    const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
        if (!idIn.value.trim()) {
            toast('id 필수', true);
            return;
        }
        let fm = {};
        if (fmTa.value.trim()) {
            try {
                fm = JSON.parse(fmTa.value);
            }
            catch {
                toast('frontmatter 가 올바른 JSON 이 아닙니다', true);
                return;
            }
        }
        const bad = tm.validate();
        if (bad) {
            toast(bad, true);
            return;
        }
        if (!confirm('구성원 하네스에 배포되어 그들의 AI가 사용합니다. 스킬은 도구·셸을 실행할 수 있습니다. 저장할까요?'))
            return;
        saveBtn.disabled = true;
        try {
            const payload = { id: idIn.value.trim(), kind: kindSel.value, label: labelIn.value.trim() || null, harness: harnessSel.value,
                description: descIn.value, summary: sumIn.value, body: bodyTa.value, frontmatter: fm,
                target_members: tm.targetMembers(), paired_hook_id: pairedIn.value.trim() || null, enabled: tm.enabled() };
            await api('/api/ui/org/harness-asset', { method: 'POST', body: JSON.stringify(payload) });
            await loadAdmin(true);
            state.admin.assetSel = payload.id;
            toast('저장됨 — 구성원 다음 세션부터');
            renderAdminDetail(detail, 'harness-assets', state.admin.data);
        }
        catch (e) {
            toast(e.message, true);
            saveBtn.disabled = false;
        }
    });
    const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
    // #990 멤버 초안 승격 — draft- 네임스페이스 비활성 자산이면 클린 id 로 복제·활성화(초안 제거)하는 [승격] 노출.
    const isDraft = !isNew && a.id && a.id.indexOf('draft-') === 0 && a.enabled === false && a.created_by;
    if (isDraft)
        actions.append(el('button', { class: 'btn btn-primary', text: '승격 →', onclick: async () => {
                const suggested = a.id.replace(/^draft-[0-9a-f]+-/, '');
                const newId = (prompt('조직에 배포할 클린 id (스킬 이름이 됩니다):', suggested) || '').trim().toLowerCase();
                if (!newId)
                    return;
                if (!confirm(`'${a.created_by}' 님의 초안을 '${newId}' 로 승격해 배포합니다(초안은 제거). 계속할까요?`))
                    return;
                try {
                    await api('/api/ui/org/harness-asset/adopt', { method: 'POST', body: JSON.stringify({ draft_id: a.id, new_id: newId, enabled: true }) });
                    await loadAdmin(true);
                    state.admin.assetSel = newId;
                    toast('승격됨 — 구성원 다음 세션부터');
                    renderAdminDetail(detail, 'harness-assets', state.admin.data);
                }
                catch (e) {
                    toast(e.message, true);
                }
            } }));
    if (!isNew)
        actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
                if (!confirm(`'${a.id}' 제거? 다음 세션부터 구성원 하네스에서 제거됩니다(미접속 머신은 직전 상태 유지).`))
                    return;
                try {
                    await api('/api/ui/org/harness-asset/remove', { method: 'POST', body: JSON.stringify({ id: a.id }) });
                    await loadAdmin(true);
                    state.admin.assetSel = null;
                    toast('제거됨');
                    renderAdminDetail(detail, 'harness-assets', state.admin.data);
                }
                catch (e) {
                    toast(e.message, true);
                }
            } }));
    root.replaceChildren(el('div', { class: 'warn-badge', text: '⚠ 여기서 정의한 것은 구성원 하네스에 배포됩니다. 스킬은 도구·셸을 실행할 수 있어 훅과 같은 실행권한입니다 — 위험 통제는 연결 훅으로.' }), field('id', idIn), field('표시 이름', labelIn), field('종류', kindSel), field('하네스', harnessSel), codexNote, field('설명(AI가 언제 쓸지 판단 — 상시 노출)', descIn), field('쉬운 한 줄 (구성원 화면에 보이는 말)', sumIn), field('본문(마크다운)', bodyTa), field('추가 frontmatter (JSON, 선택)', fmTa), field('연결 훅 id(선택 — 위험 통제)', pairedIn), field('대상 구성원', tm.node), actions);
}
// ── AI 도구(MCP 툴) — runtime 권한 ──
function toolsEditor(detail, data) {
    const proxyTools = (data.tools || []).filter((t) => t.kind === 'http_proxy');
    const sel = state.admin.toolSel;
    const listCol = el('div', { class: 'admin-sublist' });
    listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ 도구 추가',
        onclick: () => { state.admin.toolSel = '__new__'; renderAdminDetail(detail, 'tools-proxy', data); } }));
    if (!proxyTools.length)
        listCol.append(el('p', { class: 'admin-hint', text: '아직 등록된 사내 API 도구가 없습니다 — [+ 도구 추가]로 첫 도구를 등록하세요.' }));
    for (const t of proxyTools) {
        listCol.append(el('div', { class: 'mini-row' + (t.name === sel ? ' sel' : ''),
            onclick: () => { state.admin.toolSel = t.name; renderAdminDetail(detail, 'tools-proxy', data); } }, el('div', { class: 'mini-title', text: t.name }, t.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null, t.auto_approve ? el('span', { class: 'pill pill-warn', text: '자동승인' }) : null), el('div', { class: 'mini-meta', text: (t.method || 'GET') + ' · ' + (t.scope || '-') })));
    }
    const right = el('div', {});
    const editing = sel === '__new__'
        ? { name: '', kind: 'http_proxy', enabled: true, auto_approve: false, title: '', description: '', scope: 'items', method: 'GET', url: '', auth_env: '', input_schema: '', note: '' }
        : proxyTools.find((t) => t.name === sel);
    if (editing)
        toolForm(right, editing, data, detail, sel === '__new__');
    // 빌트인 토글은 #837 에서 [기본 제공 도구] 서브탭으로 분리 — 여기서 또 그리면 같은 화면에 두 번 나온다.
    else
        right.append(el('p', { class: 'admin-hint', text: '사내 API를 AI가 호출할 수 있는 도구로 등록합니다. 저장 즉시(재설치 없이) 구성원 AI가 쓸 수 있습니다. 호출은 아래 [외부 호출 안전범위]에 등록한 호스트로만 나가고, 인증은 환경변수 이름으로만 지정합니다.' }));
    const pol = data.toolPolicy || { url_allowlist: [], allowed_auth_envs: [] };
    const toolsSafety = allowlistCard(data, '외부 호출 안전범위 (allowlist)', '사내 API 도구가 호출할 수 있는 외부 호스트 범위 — 이 목록 밖은 차단됩니다(SSRF 방어). 사내 API 도구를 안 쓰면 비워둬도 됩니다.', [
        { key: 'url_allowlist', label: '허용 호스트 (url_allowlist)', initial: pol.url_allowlist, placeholder: 'api.acme.com\n.internal.acme.com (앞에 . = 서브도메인)' },
        { key: 'allowed_auth_envs', label: '허용 인증 환경변수 이름 (allowed_auth_envs)', initial: pol.allowed_auth_envs, placeholder: 'ACME_API_TOKEN\n줄당 환경변수 이름(값 아님)' },
    ]);
    detail.replaceChildren(el('div', { class: 'card' }, cardHead('등록된 AI 도구'), el('div', { class: 'admin-two admin-two-cols' }, listCol, right)), toolsSafety);
}
// MCP inputSchema(JSON Schema)의 properties → 필드 목록(이름:타입·필수여부·제약·설명). 하네스가 tools/list 에서 보는 입력 표면.
function mcpFieldsEl(schema) {
    const props = (schema && schema.properties) || {};
    const req = (schema && schema.required) || [];
    const keys = Object.keys(props);
    if (!keys.length)
        return el('div', { class: 'admin-hint', text: '입력 필드 없음' });
    return el('ul', { style: 'margin:2px 0; padding-left:18px' }, ...keys.map((k) => {
        const p = props[k] || {};
        let t = p.type || (p.anyOf || p.oneOf ? 'union' : '?');
        if (p.enum)
            t = p.enum.join(' | ');
        const c = [];
        if (p.minLength != null)
            c.push('min ' + p.minLength);
        if (p.maxLength != null)
            c.push('max ' + p.maxLength);
        if (p.minimum != null)
            c.push('≥' + p.minimum);
        if (p.maximum != null)
            c.push('≤' + p.maximum);
        return el('li', {}, el('code', { text: k }), el('span', { class: 'mini-meta', text: ' : ' + t + (req.includes(k) ? ' · 필수' : ' · 선택') + (c.length ? ' · ' + c.join(', ') : '') }), p.description ? el('div', { class: 'admin-hint', style: 'margin:0', text: p.description }) : null);
    }));
}
function builtinToggles(data) {
    const byName = {};
    for (const t of (data.tools || []))
        if (t.kind === 'builtin')
            byName[t.name] = t;
    const wrap = el('div', { class: 'builtin-toggles' }, el('div', { class: 'admin-subhead', text: '기본 제공 도구 (MCP 노출)' }), el('p', { class: 'admin-hint', text: '게이트웨이 MCP 도구의 노출을 켜고 끕니다(저장 즉시 반영). 코드 기본값을 덮어쓰므로 「기본 미노출」 도구도 여기서 켤 수 있습니다. 자동승인을 켜면 구성원 AI가 이 도구를 실행할 때 매번 묻는 확인 없이 바로 실행합니다.' }), el('p', { class: 'admin-hint', text: '‘주입’: Claude Code가 이 도구를 세션 시작에 미리 로드할지(항상), 필요할 때 검색해 로드할지(deferred) 정합니다 — Claude Code 전용입니다(Codex는 모든 MCP 도구를 항상 미리 로드합니다).' }));
    // 노출 정렬: 기본 노출 먼저, 기본 미노출(켤 수 있는 후보)을 아래로. 같은 그룹은 이름순.
    const cands = (data.builtins || []).map((c) => (typeof c === 'string' ? { name: c, title: '', defaultExposed: true } : c))
        .slice().sort((a, b) => (a.defaultExposed === b.defaultExposed ? a.name.localeCompare(b.name) : (a.defaultExposed ? -1 : 1)));
    for (const cand of cands) {
        const name = cand.name;
        const def = cand.defaultExposed !== false; // 코드 기본값(expose.mcp)
        const override = byName[name]; // org_tool builtin 행(있으면 운영자 재정의)
        const exposed = override ? override.enabled !== false : def; // 최종 노출
        const enChk = el('input', { type: 'checkbox' });
        enChk.checked = exposed;
        const aaChk = el('input', { type: 'checkbox' });
        aaChk.checked = override ? !!override.auto_approve : false;
        // 주입모드(#187): 코드 기본값(defAlways) + 운영자 override(always_load). '' = 기본, 'always' = 항상, 'deferred' = 검색 시 로드. Claude Code 전용.
        const defAlways = cand.alwaysLoadDefault === true;
        const alSel = el('select', {}, el('option', { value: '', text: '기본(' + (defAlways ? '항상' : 'deferred') + ')' }), el('option', { value: 'always', text: '항상 주입' }), el('option', { value: 'deferred', text: '검색 시 주입 (deferred)' }));
        alSel.value = (override && override.always_load != null) ? (override.always_load ? 'always' : 'deferred') : '';
        const save = async () => {
            try {
                const always_load = alSel.value === '' ? null : (alSel.value === 'always');
                await api('/api/ui/org/tool', { method: 'POST', body: JSON.stringify({ name, kind: 'builtin', enabled: enChk.checked, auto_approve: aaChk.checked, always_load }) });
                await loadAdmin(true);
                toast('저장됨');
            }
            catch (e) {
                toast(e.message, true);
            }
        };
        enChk.addEventListener('change', save);
        aaChk.addEventListener('change', save);
        alSel.addEventListener('change', save);
        // MCP 상세 — 하네스가 보는 description + inputSchema(필드). 접힘 기본, 클릭 시 펼침.
        const detail = el('div', { style: 'display:none; margin:2px 0 8px 14px; padding:6px 10px; border-left:2px solid var(--border, #ddd)' }, cand.description ? el('p', { class: 'admin-hint', style: 'white-space:pre-wrap; margin:0 0 6px', text: cand.description }) : null, el('div', { class: 'admin-subhead', text: '입력 필드 (MCP inputSchema)' }), mcpFieldsEl(cand.inputSchema));
        const expand = el('button', { class: 'btn btn-ghost btn-sm', text: 'MCP 상세 ▾',
            onclick: () => { const open = detail.style.display === 'none'; detail.style.display = open ? 'block' : 'none'; expand.textContent = open ? 'MCP 상세 ▴' : 'MCP 상세 ▾'; } });
        wrap.append(el('div', { class: 'builtin-row' }, el('span', { class: 'builtin-name', text: name }, cand.title ? el('span', { class: 'mini-meta', text: ' · ' + cand.title }) : null, !def ? el('span', { class: 'pill', text: '기본 미노출' }) : null, (override && exposed !== def) ? el('span', { class: 'pill pill-warn', text: '재정의' }) : null, (override && override.always_load != null && override.always_load !== defAlways) ? el('span', { class: 'pill pill-warn', text: '주입 재정의' }) : null), el('label', { class: 'admin-check' }, enChk, ' 노출'), el('label', { class: 'admin-check' }, aaChk, ' 자동승인'), el('label', { class: 'admin-check' }, '주입 ', alSel), expand), detail);
    }
    return wrap;
}
function toolForm(root, t, data, detail, isNew) {
    const policy = data.toolPolicy || { allowed_auth_envs: [], url_allowlist: [] };
    const nameIn = el('input', { type: 'text', value: t.name, placeholder: '도구 이름 (소문자/숫자/_-)', disabled: isNew ? null : '' });
    const titleIn = el('input', { type: 'text', value: t.title || '', placeholder: '표시 이름(선택)' });
    const descTa = el('textarea', { rows: '2', placeholder: 'AI에게 이 도구가 무엇인지 설명(AI가 언제 쓸지 판단)' });
    descTa.value = t.description || '';
    const scopeSel = el('select', {}, ...['items', 'context', 'db', 'memory', 'code'].map((s) => el('option', { value: s, text: s })));
    scopeSel.value = t.scope || 'items';
    const methodSel = el('select', {}, ...['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => el('option', { value: m, text: m })));
    methodSel.value = t.method || 'GET';
    const urlIn = el('input', { type: 'text', value: t.url || '', placeholder: 'https://api.acme.com/v1/search' });
    // 등급(#746 P2) — 이 도구가 하는 일의 성격. L2(집행)는 자동승인에서 강제 제외돼 매번 하네스 확인.
    const levelSel = el('select', {}, el('option', { value: 'L0', text: 'L0 · 조회 (읽기)' }), el('option', { value: 'L1', text: 'L1 · 제안 (MR·초안 만들기)' }), el('option', { value: 'L2', text: 'L2 · 집행 (외부발신·상태변경 — 매번 확인)' }));
    levelSel.value = t.level || 'L0';
    // ── 인증 방식(#746 P1) — 조직 공용(환경변수) vs 구성원 개인 자격(vault). 드롭다운으로 전환. ──
    const authEnvSel = policy.allowed_auth_envs.length
        ? el('select', {}, el('option', { value: '', text: '(선택)' }), ...policy.allowed_auth_envs.map((e) => el('option', { value: e, text: e })))
        : el('input', { type: 'text', placeholder: '아래 「외부 호출 안전범위」에 allowed_auth_envs 를 먼저 등록', disabled: '' });
    if (authEnvSel.tagName === 'SELECT')
        authEnvSel.value = t.auth_env || '';
    const authKindSel = el('select', {}, ...CRED_KINDS.map((k) => el('option', { value: k.kind, text: k.label })));
    if (t.auth_kind)
        authKindSel.value = t.auth_kind;
    const authScopeIn = el('input', { type: 'text', value: t.auth_scope_key || '', placeholder: '대상 구분(선택 · 예 git 호스트)' });
    const initialMode = t.auth_kind ? 'kind' : (t.auth_env ? 'env' : 'none');
    const authModeSel = el('select', {}, el('option', { value: 'none', text: '인증 없음 (공개 API)' }), el('option', { value: 'env', text: '조직 공용 (환경변수) — 전원 같은 자격' }), el('option', { value: 'kind', text: '구성원 개인 자격 (요청자별)' }));
    authModeSel.value = initialMode;
    const envField = field('공용 자격 (auth_env)', authEnvSel);
    const kindField = field('개인 자격 종류 (auth_kind)', el('div', {}, authKindSel, el('p', { class: 'admin-hint', style: 'margin:4px 0 0', text: 'L2(집행)면 개인 자격이 필수예요. L0/L1(읽기·제안)이면 개인 자격이 없을 때 「통합 자격」으로 대신 로그인해요. 구성원은 [내 설정 ▸ 외부 서비스 로그인]에서 자기 로그인을 넣습니다.' })));
    const kindScopeField = field('개인 자격 대상(선택)', authScopeIn);
    const syncAuthMode = () => {
        const m = authModeSel.value;
        envField.style.display = m === 'env' ? '' : 'none';
        kindField.style.display = m === 'kind' ? '' : 'none';
        kindScopeField.style.display = m === 'kind' ? '' : 'none';
    };
    authModeSel.addEventListener('change', syncAuthMode);
    syncAuthMode();
    const schemaTa = el('textarea', { rows: '5', class: 'admin-ta', placeholder: '{ "type":"object", "properties": { "q": {"type":"string"} }, "required":["q"] }' });
    schemaTa.value = typeof t.input_schema === 'string' ? t.input_schema : (t.input_schema ? JSON.stringify(t.input_schema, null, 2) : '');
    const enChk = el('input', { type: 'checkbox' });
    enChk.checked = t.enabled !== false;
    const aaChk = el('input', { type: 'checkbox' });
    aaChk.checked = !!t.auto_approve;
    const piiChk = el('input', { type: 'checkbox' });
    piiChk.checked = !!t.pii_scrub;
    const hostHint = el('p', { class: 'admin-hint', text: policy.url_allowlist.length ? '허용 호스트: ' + policy.url_allowlist.join(', ') : '⚠ 허용 호스트가 없습니다 — 아래 「외부 호출 안전범위」의 url_allowlist 에 먼저 추가해야 호출됩니다.' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
        if (!nameIn.value.trim()) {
            toast('이름 필수', true);
            return;
        }
        let schema;
        if (schemaTa.value.trim()) {
            try {
                schema = JSON.parse(schemaTa.value);
            }
            catch {
                toast('입력 스키마가 올바른 JSON 이 아닙니다', true);
                return;
            }
        }
        saveBtn.disabled = true;
        try {
            const mode = authModeSel.value;
            const payload = {
                name: nameIn.value.trim(), kind: 'http_proxy', enabled: enChk.checked, auto_approve: aaChk.checked,
                title: titleIn.value.trim() || null, description: descTa.value.trim(), scope: scopeSel.value,
                method: methodSel.value, url: urlIn.value.trim(), input_schema: schema,
                level: levelSel.value, pii_scrub: piiChk.checked,
                // 인증 방식 — 배타(서버도 강제). env 모드면 auth_env, kind 모드면 auth_kind(+scope), none 이면 둘 다 비움.
                auth_env: mode === 'env' ? (authEnvSel.value || '').trim() || null : null,
                auth_kind: mode === 'kind' ? authKindSel.value : null,
                auth_scope_key: mode === 'kind' ? (authScopeIn.value.trim() || null) : null,
            };
            await api('/api/ui/org/tool', { method: 'POST', body: JSON.stringify(payload) });
            await loadAdmin(true);
            state.admin.toolSel = payload.name;
            toast('저장됨 — 구성원 다음 대화부터 즉시');
            renderAdminDetail(detail, 'tools-proxy', state.admin.data);
        }
        catch (e) {
            toast(e.message, true);
            saveBtn.disabled = false;
        }
    });
    const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
    if (!isNew)
        actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
                if (!confirm(`도구 '${t.name}' 제거? 구성원 AI 도구 목록에서 즉시 사라집니다.`))
                    return;
                try {
                    await api('/api/ui/org/tool/remove', { method: 'POST', body: JSON.stringify({ name: t.name }) });
                    await loadAdmin(true);
                    state.admin.toolSel = null;
                    toast('제거됨');
                    renderAdminDetail(detail, 'tools-proxy', state.admin.data);
                }
                catch (e) {
                    toast(e.message, true);
                }
            } }));
    root.replaceChildren(field('이름', nameIn), field('표시 이름', titleIn), field('설명 (AI용)', descTa), field('권한 (이 도구를 쓸 수 있는 scope)', scopeSel), field('등급 (하는 일의 성격)', levelSel), field('HTTP 메서드', methodSel), field('URL (https)', urlIn), hostHint, field('인증 방식', authModeSel), envField, kindField, kindScopeField, el('label', { class: 'admin-check' }, piiChk, ' 응답에서 개인정보(PII) 자동 가리기'), field('입력 스키마 (JSON Schema, 선택)', schemaTa), el('label', { class: 'admin-check' }, enChk, ' 활성'), el('label', { class: 'admin-check' }, aaChk, ' 자동 승인 (구성원 확인 없이 실행 — 주의)'), actions);
}
// 설치 한 줄 명령(OS별) — #864 부터 **lively CLI 부트스트랩**이다. 사용 가이드(web/learn.ts)가 쓴다.
//
//  ⚠ 이 줄에는 토큰이 없다. 종전엔 여기서 장기 토큰을 명령줄에 리터럴로 박았고, 그게 그대로
//  ~/.zsh_history 에 영구히 남았다(화면공유·클립보드 매니저 노출). 이제 이 줄은 CLI 를 깔기만 하고,
//  토큰은 CLI 의 `lively login` 이 /dev/tty **가림 입력**으로 받는다(어디에도 안 남음).
//  부트스트랩은 TTY 가 있으면 곧장 `lively setup`(로그인+설치)으로 인계하므로 사용자는 여전히 **한 번만 복사**한다.
//
//  또 하나의 이득: 설치 로직이 CLI(Node) 한 곳으로 모여 mac/win 이 **같은 코드**를 돈다.
//  (종전 PowerShell 판은 1,400자짜리 한 줄이라 사실상 아무도 검증하지 못했다 — 그래서 계속 '미검증' 이었다.)
function installCmd(gw, os) {
    if (os === 'windows')
        return `irm ${gw}/cli.ps1 | iex`;
    return `curl -fsSL ${gw}/cli | sh`;
}
// ── 접속 열쇠(토큰) 발급 — 구성원을 골라 발급하고 설치 한 줄을 건넨다. [구성원 ▸ 접속 열쇠] 안. ──
function installMinterBlock(data, gw, opts = {}) {
    const result = el('div', {});
    const sel = el('select', {}, ...(data.members || []).map((m) => el('option', { value: m.id, text: (m.display_name || m.id) + ' · ' + ((m.scopes || []).join('/') || '-') })));
    if (opts.preselectId && (data.members || []).some((m) => m.id === opts.preselectId))
        sel.value = opts.preselectId;
    const go = el('button', { class: 'btn btn-primary btn-sm', text: '토큰 발급' });
    go.addEventListener('click', async () => {
        const m = (data.members || []).find((x) => x.id === sel.value) || { id: sel.value };
        if (!m.id) {
            toast('구성원을 선택하세요', true);
            return;
        }
        go.disabled = true;
        try {
            const r = await api('/api/ui/org/token', { method: 'POST',
                body: JSON.stringify({ userId: m.id, memberId: m.id, label: m.display_name || m.id }) });
            const name = m.display_name || m.id;
            const webUrl = gw + '/ui/';
            result.replaceChildren(el('p', { class: 'install-ok', text: '✓ ' + name + ' 님 접속 토큰이 발급됐어요 (권한: ' + r.scopes.join('/') + ').' }), el('p', { class: 'admin-hint', text: '아래 토큰을 ' + name + ' 님에게 전달하면 끝이에요 — 받은 분은 이 토큰으로 바로 로그인합니다(설치·명령어 필요 없음).' }), el('div', { class: 'deploy-head' }, el('span', { class: 'mini-meta', text: '발급된 토큰' }), copyButton(() => r.token, '토큰 복사')), el('pre', { class: 'admin-preview', text: r.token }), el('ol', { class: 'minter-steps' }, el('li', {}, el('b', { text: '[토큰 복사]' }), ' 버튼으로 토큰을 복사하세요.'), el('li', {}, name + ' 님에게 ', el('b', { text: '1:1로(슬랙·메신저 DM 등) 전달' }), '하세요 — 토큰은 비밀번호 같은 거라 공개 채널·단톡방엔 올리지 마세요.'), el('li', {}, name + ' 님은 ', el('a', { href: webUrl, target: '_blank', rel: 'noopener', text: webUrl }), ' 에 접속해 ', el('b', { text: '첫 화면에 이 토큰을 붙여넣고 로그인' }), '하면 바로 시작합니다.')), el('p', { class: 'admin-hint', text: '⚠ 이 토큰은 지금 이 화면에서만 보여요 — 닫으면 다시 볼 수 없습니다(잃어버리면 다시 발급하면 돼요).' }), el('p', { class: 'admin-hint', text: '내 컴퓨터 터미널(Claude Code·Codex)에서 직접 쓰실 분은 — 같은 토큰으로 [사용 가이드 › 시작하기] 안내를 따르면 됩니다.' }));
            await loadAdmin(true);
        }
        catch (e) {
            toast(e.message, true);
        }
        go.disabled = false;
    });
    return el('div', { class: 'deploy-block' }, el('h3', { class: 'member-add-step', text: opts.title || '토큰 발급 (새 팀원 추가)' }), el('p', { class: 'admin-hint', text: '구성원을 고르고 [토큰 발급]을 누르면 그 사람 전용 토큰이 만들어집니다. 토큰을 전달받은 구성원이 로그인 화면에 붙여넣으면 바로 로그인됩니다(설치·명령어 불필요).' }), el('div', { class: 'install-minter' }, sel, go), result);
}
// 유지보수 명령 — #864 부터 **OS 무관**이다(lively CLI 가 mac/win 을 흡수). gw/os 는 부트스트랩 폴백 안내에만 쓴다.
//  종전엔 여기 OS별로 갈라진 1,400자 PowerShell 과 sed 범벅 bash 가 각각 들어 있었다.
function deployCommands(gw, os) {
    // `lively` 가 아직 없는 경우(자동 업데이트 전) 어떻게 되찾는지 — 모든 note 의 공통 꼬리.
    const boot = os === 'windows' ? `irm ${gw}/cli.ps1 | iex` : `curl -fsSL ${gw}/cli | sh`;
    const ifMissing = `\n\n※ 'lively: command not found' 가 나오면 — 새 터미널을 열어 보고(설치 직후엔 PATH 가 현 창에 아직 없습니다), 그래도 없으면 아래로 CLI 를 먼저 설치하세요:\n    ${boot}`;
    return [
        { kind: 'install', title: '설치' }, // 설치 블록은 learn.ts 가 직접 렌더(단계 UI)
        {
            kind: 'update',
            title: '업데이트 (보통은 불필요 — 자동입니다)',
            note: '키트는 세션을 켤 때마다 자동으로 최신과 맞춰집니다(백그라운드 설치 → 다음 세션부터 적용). '
                + '이 명령은 ① 자동 업데이트를 껐거나 ② 지금 당장 맞춰야 하거나 '
                + '③ 관리자가 새 MCP 서버를 추가했을 때 씁니다 — ③ 은 자동 업데이트가 할 수 없는 유일한 일입니다'
                + '(백그라운드에서 MCP 재등록을 하다 실패하면 등록이 사라질 수 있어 일부러 빼 뒀습니다).' + ifMissing,
            cmd: 'lively update',
        },
        {
            kind: 'uninstall',
            title: '제거',
            note: '설치 파일을 영구 제거합니다(lively 영역만 — tmux 훅·셸 별칭 등 본인 설정은 그대로 보존). '
                + '미리 보려면 `lively uninstall --dry-run`. '
                + '완전 차단하려면 관리자가 [구성원 ▸ 접속 토큰] 에서 그 토큰의 접속을 해제해야 합니다.' + ifMissing,
            cmd: 'lively uninstall',
        },
    ];
}
// ── 공용 UI 헬퍼 ──
function field(label, control) {
    return el('div', { class: 'field' }, el('label', { class: 'field-label', text: label }), control);
}
// 필드 라벨 바로 옆에 '이게 뭐예요?' 트리거를 붙이는 변형(필드 단위 설명용).
function fieldWithHelp(label, control, m) {
    return el('div', { class: 'field' }, el('div', { class: 'field-label-row' }, el('label', { class: 'field-label', text: label })), control);
}
// 클립보드 복사 — navigator.clipboard 는 보안 컨텍스트(https/localhost)에서만 동작한다.
// http://dev.lvly.io:8080 같은 비보안 origin 에선 undefined 이므로, execCommand('copy') 텍스트영역 폴백을 쓴다.
async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        }
        catch { /* 폴백으로 */ }
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    }
    catch {
        return false;
    }
}
function copyButton(getText, label) {
    const b = el('button', { class: 'btn btn-ghost btn-sm', text: label || '복사' });
    b.addEventListener('click', async () => {
        if (await copyText(getText()))
            toast('복사됨');
        else
            toast('복사 실패 — 명령을 직접 선택해 복사하세요', true);
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
const PROF_TONE = ['친근한 존댓말', '간결한 존댓말', '격식 있는 존댓말', '편한 반말', '위트 있는 존댓말'];
// 사용 언어 — 내 AI 가 답하는 언어. 프리셋 칩 + '직접 입력'(목록 밖 언어). tone/dev 와 달리 언어는 장꼬리라 자유입력을 허용한다.
const PROF_LANG = ['한국어', 'English', '日本語', '中文'];
// 단일 선택 chip 그룹 — selected.v 를 토글(다시 누르면 해제). getVal/getLabel 로 옵션 모양에 무관.
function profChips(opts, selected, getLabel, getVal, onPick) {
    const wrap = el('div', { class: 'prof-chips' });
    const chips = [];
    const repaint = () => chips.forEach((c) => c.el.classList.toggle('on', c.val === selected.v));
    opts.forEach((o) => {
        const val = getVal(o);
        const chip = el('button', { type: 'button', class: 'prof-chip' + (val === selected.v ? ' on' : ''), text: getLabel(o) });
        chip.addEventListener('click', () => {
            selected.v = (selected.v === val) ? '' : val;
            repaint();
            if (onPick)
                onPick(selected.v);
        });
        chips.push({ el: chip, val });
        wrap.append(chip);
    });
    wrap.repaint = repaint; // 외부에서 selected.v 를 바꾼 뒤(예: '직접 입력' 타이핑) 칩 하이라이트를 동기화한다.
    return wrap;
}
// canonical body_md → 선택값 복원. 기본 견본(채워넣기/local.md)은 빈값으로(새로 시작).
function parseMyProfile(md) {
    const r = { role: '', dev: '', address: '', tone: '', lang: '', memo: '' };
    if (!md || /채워넣기|members\/local\.md/.test(md))
        return r;
    const parts = md.split(/^##\s*추가 메모\s*$/m);
    const head = parts[0] || '';
    if (parts[1])
        r.memo = parts[1].trim();
    const grab = (re) => { const m = head.match(re); return m ? m[1].trim() : ''; };
    r.role = grab(/^[-*\s]*\**\s*역할\s*\**\s*[:：]\s*(.+)$/m);
    const dev = grab(/^[-*\s]*\**\s*개발[^:：\n]*\**\s*[:：]\s*(.+)$/m);
    r.dev = (PROF_DEV.find((d) => dev.startsWith(d.label)) || {}).v || '';
    r.address = grab(/^[-*\s]*\**\s*호칭[^:：\n]*\**\s*[:：]\s*(.+)$/m);
    const tone = grab(/^[-*\s]*\**\s*말투\s*\**\s*[:：]\s*(.+)$/m);
    r.tone = PROF_TONE.find((t) => tone.startsWith(t)) || '';
    r.lang = grab(/^[-*\s]*\**\s*사용\s*언어\s*\**\s*[:：]\s*(.+)$/m).split(' — ')[0].trim(); // 뒤에 붙는 지시문(' — 되도록…')을 떼고 언어값만 복원(구 데이터는 지시문 없어 그대로).
    // 응답 길이·담당 영역·자주 쓰는 도구는 #837 에서 제거 — 파싱도 안 한다(다음 저장에 자연 소멸).
    return r;
}
// 업로드 이미지 → 128px 정사각(center-crop) JPEG data URL. 작게 만들어 org_member.avatar 에 인라인 저장.
function fileToAvatarDataUrl(file) {
    return new Promise((resolve, reject) => {
        if (!file || !/^image\//.test(file.type)) {
            reject(new Error('이미지 파일만 올릴 수 있어요'));
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('파일을 읽지 못했습니다'));
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const size = 128;
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    reject(new Error('이미지를 처리하지 못했습니다'));
                    return;
                }
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
    return el('label', { style: 'display:flex; flex-direction:column; gap:5px; margin-bottom:12px;' }, el('span', { style: 'font-size:12.5px; font-weight:600; color:var(--ink-sub);', text: label }), input);
}
function changePasswordModal(o) {
    const forced = !!(o && o.forced);
    const presetCurrent = (o && o.currentPrefill) || '';
    const head = el('div', { class: 'ov-head' }, el('h3', { text: forced ? '새 비밀번호 설정' : '비밀번호 변경' }));
    const box = el('div', { class: 'ov-box', style: 'max-width:440px' }, head);
    const back = el('div', { class: 'ov-back' }, box);
    const close = () => back.remove();
    if (!forced) { // 강제(forced) 모드는 닫기 불가 — 새 비번을 설정해야만 진행.
        head.append(el('button', { class: 'btn btn-ghost btn-sm', text: '닫기', onclick: close }));
        back.addEventListener('click', (e) => { if (e.target === back)
            close(); });
        document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') {
            close();
            document.removeEventListener('keydown', esc);
        } });
    }
    const pwInput = (ph, ac) => el('input', { type: 'password', placeholder: ph, autocomplete: ac, style: PW_INPUT_STYLE });
    const curIn = pwInput('현재 비밀번호', 'current-password');
    const nextIn = pwInput('새 비밀번호 (8자 이상)', 'new-password');
    const confIn = pwInput('새 비밀번호 확인', 'new-password');
    const err = el('p', { class: 'gate-error', hidden: true, style: 'margin:2px 0 10px;' });
    const showErr = (m) => { err.textContent = m; err.hidden = false; };
    const rows = [];
    if (forced)
        rows.push(el('p', { class: 'admin-hint', text: '임시 비밀번호로 로그인했습니다. 계속하려면 새 비밀번호를 설정하세요.' }));
    else
        rows.push(pwFieldRow('현재 비밀번호', curIn));
    rows.push(pwFieldRow('새 비밀번호', nextIn), pwFieldRow('새 비밀번호 확인', confIn));
    const submit = el('button', { class: 'btn btn-primary', type: 'submit', text: forced ? '설정하고 계속' : '변경' });
    const secondary = forced
        ? el('button', { type: 'button', class: 'btn btn-ghost', text: '로그아웃', onclick: () => { close(); logout(); } })
        : el('button', { type: 'button', class: 'btn btn-ghost', text: '취소', onclick: close });
    const actions = el('div', { style: 'display:flex; gap:8px; justify-content:flex-end; margin-top:16px;' }, secondary, submit);
    const form = el('form', { style: 'margin:0;' }, ...rows, err, actions);
    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const current = forced ? presetCurrent : curIn.value;
        const next = nextIn.value;
        const conf = confIn.value;
        if (!forced && !current) {
            showErr('현재 비밀번호를 입력하세요.');
            return;
        }
        if (next.length < 8) {
            showErr('새 비밀번호는 8자 이상이어야 합니다.');
            return;
        }
        if (next !== conf) {
            showErr('새 비밀번호가 일치하지 않습니다.');
            return;
        }
        if (next === current) {
            showErr('현재 비밀번호와 다른 비밀번호를 설정하세요.');
            return;
        }
        submit.disabled = true;
        try {
            await api('/api/ui/password', { method: 'POST', body: JSON.stringify({ current, next }) });
            close();
            toast('비밀번호가 변경되었습니다.');
        }
        catch (e) {
            submit.disabled = false;
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
function openGitCredentialManager(scope) {
    const isGw = scope === 'gateway';
    const base = isGw ? '/api/ui/org/git-credential' : '/api/ui/me/git-credential';
    const body = el('div', { style: 'min-width:520px; max-width:640px;' });
    const back = overlay(isGw ? '게이트웨이 git 계정' : 'git 인증 (레포 접근)', body);
    document.body.append(back);
    const reload = async () => {
        body.replaceChildren(skeleton('불러오는 중'));
        try {
            render(await api(base));
        }
        catch (e) {
            body.replaceChildren(el('p', { class: 'gate-error', text: (e && e.message) || '불러오기 실패' }));
        }
    };
    const credRow = (c) => {
        const head = el('div', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;' }, el('span', { class: 'pill pill-ok', text: String(c.kind || '').toUpperCase() }), el('span', { class: 'mini-meta', text: c.host }), c.kind === 'ssh' && c.ssh_public_key ? copyButton(() => c.ssh_public_key, '공개키 복사') : null, el('button', {
            class: 'btn btn-ghost btn-sm', text: '삭제',
            onclick: async () => {
                if (!confirm(`${c.host} (${c.kind}) 자격을 삭제할까요?`))
                    return;
                try {
                    await api(base + '/delete', { method: 'POST', body: JSON.stringify({ host: c.host }) });
                    toast('삭제됨');
                    reload();
                }
                catch (e) {
                    toast((e && e.message) || '삭제 실패', true);
                }
            },
        }));
        const box = el('div', { class: 'card', style: 'padding:10px 12px; margin:6px 0;' }, head);
        if (c.kind === 'ssh' && c.ssh_public_key) {
            box.append(el('pre', { class: 'admin-preview', style: 'white-space:pre-wrap; word-break:break-all; margin:8px 0 0; font-size:11.5px;', text: c.ssh_public_key }));
            box.append(el('p', { class: 'admin-hint', style: 'margin:6px 0 0', text: '이 공개키를 호스트에 등록하세요 — GitHub: 레포 Settings ▸ Deploy keys · GitLab: 레포 Settings ▸ Repository ▸ Deploy keys(또는 계정 ▸ SSH keys). 셀프호스팅 GitLab 도 동일.' }));
        }
        return box;
    };
    const render = (data) => {
        const rows = [];
        rows.push(el('p', { class: 'admin-hint', style: 'margin:0 0 10px', text: isGw
                ? '조직 머신 git 계정입니다. 프로젝트 provision 클론에서 요청한 구성원 자격이 없을 때 이 자격으로 클론합니다 — private 레포면 여기(또는 각 구성원)에 자격이 있어야 클론됩니다.'
                : '내 git 자격입니다. private 레포 클론과 세션(shell·Claude) 안 git 에 이 자격이 쓰입니다. SSH 는 박스가 키를 만들고 공개키만 호스트(GitHub·GitLab·셀프호스팅)에 등록하면 됩니다(개인키는 박스 밖으로 안 나갑니다).' }));
        if (!data.encryption_ready)
            rows.push(el('p', { class: 'gate-error', style: 'margin:0 0 10px', text: '⚠ 서버에 CONNECTOR_SECRET_KEY 가 설정되지 않아 자격을 저장할 수 없습니다 — 관리자에게 게이트웨이 env(CONNECTOR_SECRET_KEY) 설정을 요청하세요.' }));
        const creds = (data.credentials || []);
        if (creds.length)
            rows.push(...creds.map(credRow));
        else
            rows.push(el('p', { class: 'admin-hint', text: '등록된 자격이 없습니다.' }));
        // ── 새 자격 추가 ──
        rows.push(el('div', { style: 'border-top:1px solid var(--line); margin:14px 0 10px;' }));
        const hostIn = el('input', { type: 'text', value: 'github.com', placeholder: 'github.com' });
        const kindSel = { v: 'ssh' };
        const sshBox = el('div', {}, el('p', { class: 'admin-hint', style: 'margin:0', text: '박스가 ed25519 키페어를 생성합니다. 생성 후 공개키를 호스트(GitHub·GitLab 등)에 Deploy key 로 등록하세요.' }));
        const userIn = el('input', { type: 'text', placeholder: '사용자명(선택 — GitHub PAT 는 비워도 됨, GitLab 은 보통 계정명/oauth2)' });
        const tokenIn = el('input', { type: 'password', placeholder: 'HTTPS 토큰 / PAT', autocomplete: 'off' });
        const httpsBox = el('div', { style: 'display:none' }, field('사용자명(선택)', userIn), field('토큰', tokenIn));
        const kindChips = el('div', { class: 'chips' }, ...['ssh', 'https'].map((k) => {
            const chip = el('button', { type: 'button', class: 'chip' + (kindSel.v === k ? ' on' : ''), text: k === 'ssh' ? 'SSH 키 (박스 생성)' : 'HTTPS 토큰' });
            chip.onclick = () => {
                kindSel.v = k;
                Array.from(kindChips.children).forEach((c, i) => c.classList.toggle('on', ['ssh', 'https'][i] === k));
                sshBox.style.display = k === 'ssh' ? '' : 'none';
                httpsBox.style.display = k === 'https' ? '' : 'none';
                submit.textContent = k === 'ssh' ? 'SSH 키 생성' : '토큰 저장';
            };
            return chip;
        }));
        const submit = el('button', { class: 'btn btn-primary', text: 'SSH 키 생성' });
        const status = el('span', { class: 'admin-status' });
        submit.addEventListener('click', async () => {
            if (!data.encryption_ready) {
                toast('CONNECTOR_SECRET_KEY 미설정 — 저장할 수 없습니다', true);
                return;
            }
            const host = hostIn.value.trim() || 'github.com';
            const payload = { kind: kindSel.v, host };
            if (kindSel.v === 'https') {
                if (!tokenIn.value.trim()) {
                    toast('토큰을 입력하세요', true);
                    return;
                }
                payload.token = tokenIn.value;
                if (userIn.value.trim())
                    payload.username = userIn.value.trim();
            }
            submit.disabled = true;
            status.textContent = kindSel.v === 'ssh' ? '키 생성 중…' : '저장 중…';
            try {
                await api(base, { method: 'POST', body: JSON.stringify(payload) });
                toast(kindSel.v === 'ssh' ? 'SSH 키 생성됨 — 아래 공개키를 호스트에 Deploy key 로 등록하세요' : '토큰 저장됨');
                reload();
            }
            catch (e) {
                status.textContent = '';
                submit.disabled = false;
                toast((e && e.message) || '실패', true);
            }
        });
        rows.push(el('div', { class: 'card', style: 'padding:12px;' }, el('div', { class: 'field-label', style: 'margin-bottom:8px', text: '새 자격 추가' }), kindChips, field('호스트', el('div', {}, hostIn, el('p', { class: 'admin-hint', style: 'margin:4px 0 0', text: 'GitHub·GitLab·셀프호스팅(예: git.honestfund.kr) 모두 지원 — 레포 호스트를 정확히 입력. HTTPS 가 막힌 호스트는 SSH 로 등록하세요.' }))), sshBox, httpsBox, el('div', { class: 'admin-actions', style: 'margin-top:10px' }, submit, status)));
        body.replaceChildren(...rows);
    };
    reload();
}
// ── 자격(커넥터 로그인) vault UI(#746 P1) — 능동 커넥터가 쓰는 per-user 토큰. 텍스트 최소화·드롭다운 위주. ──
//  kind 는 드롭다운(친숙한 라벨), kind 별 필요한 필드만 노출, 헤더 형식은 프리셋(고급 토글 없이 숨김). '내 자격'은 전원,
//  '통합 자격'·AWS 역할은 admin. secret 은 password 입력이고 목록엔 등록됨(✓)만 보인다(값 비노출).
const CRED_KINDS = [
    { kind: 'gitlab_pat', label: 'GitLab 개인 토큰(PAT)', secretLabel: 'GitLab 토큰', secretPh: 'glpat-…', scope: 'GitLab 호스트', scopePh: 'git.honestfund.kr', meta: { auth_header: 'PRIVATE-TOKEN', token_prefix: '' }, help: 'GitLab ▸ 우측상단 프로필 ▸ Preferences ▸ Access Tokens 에서 발급(read_api·read_repository). 여러 GitLab 서버를 쓰면 호스트로 구분하세요. 레포(git) 관리의 [목록에서 선택] 드롭다운도 이 토큰으로 조회합니다 — git 전송을 SSH 로 하더라도 이 토큰만 있으면 목록을 불러올 수 있습니다.' },
    { kind: 'github_pat', label: 'GitHub 토큰(PAT)', secretLabel: 'GitHub 토큰', secretPh: 'ghp_… / github_pat_…', scope: 'GitHub 호스트', scopePh: 'github.com', docUrl: 'https://github.com/settings/tokens', meta: { auth_header: 'Authorization', token_prefix: 'Bearer ' }, help: 'GitHub ▸ Settings ▸ Developer settings ▸ Personal access tokens 에서 발급(classic=repo / fine-grained=Metadata read). 레포(git) 관리의 [목록에서 선택] 드롭다운이 이 토큰으로 조회합니다 — git 전송을 SSH(deploy key)로 하더라도 이 토큰만 있으면 목록을 불러올 수 있습니다.' },
    { kind: 'slack_user_token', label: 'Slack 사용자 토큰(xoxp)', secretLabel: 'xoxp- 토큰', secretPh: 'xoxp-…', help: '메시지 검색(search.messages)은 봇 토큰이 안 되고 사용자 토큰(xoxp)이 필요합니다. 내가 초대된 채널만 검색됩니다.', docUrl: 'https://api.slack.com/apps' },
    // notion_token·google_oauth_refresh 제거(#746) — 이 서비스는 OAuth 커넥터(관리탭 MCP 서버)로 연결. 정적 토큰 슬롯은 중복·미사용(죽은 옵션)이었음.
    { kind: 'clickup_token', label: 'ClickUp 토큰', secretLabel: 'ClickUp 토큰', secretPh: 'pk_…', meta: { token_prefix: '' }, help: 'ClickUp ▸ Settings ▸ Apps 에서 개인 API 토큰(pk_…) 발급.', docUrl: 'https://app.clickup.com/settings/apps' },
    { kind: 'prometheus_bearer', label: 'Prometheus Bearer 토큰', secretLabel: 'Bearer 토큰' },
    { kind: 'figma_token', label: 'Figma 토큰', secretLabel: 'Figma 토큰', secretPh: 'figd_…', meta: { auth_header: 'X-Figma-Token', token_prefix: '' }, help: 'Figma ▸ Settings ▸ Security ▸ Personal access tokens 에서 발급(figd_…).', docUrl: 'https://www.figma.com/settings' },
];
const AWS_REGIONS = ['ap-northeast-2', 'ap-northeast-1', 'us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1'];
// OAuth 커넥터 카드(#746 T2/T3) — 멤버 셀프 연결/해제. 연결은 새 탭에서 인증(브라우저 리다이렉트), 완료 후 새로고침.
function oauthConnectorsCard(conns, reload) {
    const rows = conns.map((c) => {
        const status = el('span', { class: 'pill', text: c.connected ? '연결됨' : '미연결' });
        const connectBtn = el('button', { class: 'btn btn-sm ' + (c.connected ? 'btn-ghost' : 'btn-primary'), text: c.connected ? '재연결' : '연결',
            onclick: async () => {
                try {
                    const r = await api('/api/ui/me/oauth/connect', { method: 'POST', body: JSON.stringify({ server: c.server }) });
                    if (r.authorized) {
                        toast('이미 연결됨');
                        reload();
                        return;
                    }
                    window.open(r.authorization_url, '_blank', 'noopener');
                    toast('새 탭에서 로그인·동의하세요 — 완료 후 [새로고침]');
                }
                catch (e) {
                    toast(e.message, true);
                }
            } });
        const discBtn = c.connected ? el('button', { class: 'btn-text', text: '해제',
            onclick: async () => {
                if (!confirm(`'${c.server}' 연결을 해제할까요?`))
                    return;
                try {
                    await api('/api/ui/me/oauth/disconnect', { method: 'POST', body: JSON.stringify({ server: c.server }) });
                    toast('해제됨');
                    reload();
                }
                catch (e) {
                    toast(e.message, true);
                }
            } }) : null;
        return el('div', { class: 'svc-item' }, el('div', { class: 'svc-item-main' }, el('div', { class: 'mini-title', text: c.server }, status), c.note ? el('div', { class: 'mini-meta', text: c.note }) : null), el('div', { class: 'svc-item-actions' }, connectBtn, discBtn));
    });
    // #762 me-logins 정돈 — '토큰·API 키' 카드(credVaultCard)와 heading·행 스타일을 맞춘다(둘 다 admin-subhead 서브카드 + svc-item 행).
    return el('div', { class: 'card' }, el('h3', { class: 'admin-subhead', text: 'OAuth 로그인' }), el('p', { class: 'admin-hint', style: 'margin:0 0 12px', text: 'Notion·Slack·Google 처럼 OAuth 로그인이 필요한 외부 도구 서버예요. [연결]을 누르면 새 탭에서 로그인·동의하고, 그 뒤 AI가 나로서 그 서비스를 씁니다(토큰은 게이트웨이가 안전 보관·자동 갱신).' }), el('div', { class: 'svc-list' }, ...rows), el('div', { class: 'admin-actions', style: 'margin:12px 0 0' }, el('button', { class: 'btn btn-ghost btn-sm', text: '새로고침', onclick: reload })));
}
// 커넥터 현황(#746 imp#4·#5) — 기본 카탈로그 각 커넥터의 등록/설정 상태 개관(관리자 온보딩 지도).
function catalogStatusCard(catalog, servers) {
    const byName = new Map((servers || []).map((s) => [s.name, s]));
    const rows = [cardHead('기본 제공 도구 서버 상태', '기본 제공되는 외부 도구 서버(MCP) 프리셋의 현재 상태입니다 — 외부 자료 수집(미러)과는 별개 항목입니다. 추가·발행은 [AI 도구 ▸ 외부 도구 서버]에서 하고, 구성원은 각자 [연결]에서 자기 계정을 연결합니다.')];
    for (const c of (catalog || [])) {
        const s = byName.get(c.name);
        let chip;
        let hint = '';
        if (s && s.enabled !== false) {
            chip = el('span', { class: 'pill pill-ok', text: '✓ 등록됨' });
            hint = c.dcr ? '구성원이 [연결]을 마치면 사용할 수 있습니다.' : 'OAuth client 시딩 확인 후 [연결]';
        }
        else if (c.dcr) {
            chip = el('span', { class: 'pill', text: '+ 추가 가능(자동)' });
            hint = 'MCP 서버 ▸ 프리셋에서 추가(DCR — client 불필요)';
        }
        else {
            chip = el('span', { class: 'pill', style: 'background:#faefdd;color:#b45309', text: '⚙ 설정 필요' });
            hint = 'OAuth client 를 만들어 사전 등록한 뒤 프리셋으로 추가하세요.';
        }
        rows.push(el('div', { class: 'card', style: 'padding:9px 12px;margin:6px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, el('span', { style: 'font-weight:650;min-width:150px', text: c.label }), chip, el('span', { class: 'mini-meta', text: hint })));
    }
    if (!(catalog || []).length)
        rows.push(el('p', { class: 'admin-hint', text: '프리셋을 불러오지 못했습니다.' }));
    // 외부 도구 서버(MCP) 기본 프리셋 현황 — org_connector(외부 자료 수집)와 무관하다(#837 에서 엔드포인트도 개명).
    return el('div', { class: 'admin-section', style: 'margin-top:18px' }, el('h3', { class: 'admin-subhead', text: '외부 도구 서버 현황 (기본 프리셋)' }), ...rows);
}
// ── [서비스 로그인] — 조직 자격만(#837). ──
//  개인 vault('내 자격' + OAuth 연결)는 **조직 관리가 아니라 개인 설정**이라 [내 프로필] 모달로 옮겼다.
//  그것 때문에 이 섹션이 권한 게이트 없이 전 구성원에게 열려 있었고(ADMIN_ONLY 밖), 조직 관리 화면에
//  개인 설정이 섞여 있었다. 이제 섹션은 admin 전용이고, 안에 조직 자격·AWS 역할·프리셋 현황만 남는다.
async function credentialsEditor(detail) {
    detail.replaceChildren(el('div', { class: 'card' }, skeleton('자격을 불러오는 중')));
    let mine = { encryption_ready: true };
    let org = { credentials: [] };
    let awsRoles = { credentials: [] };
    let catalog = { catalog: [] };
    let mcpServers = { servers: [] };
    try {
        mine = await api('/api/ui/me/credentials'); // 암호화 키 준비 여부(encryption_ready)만 본다
        org = await api('/api/ui/org/credentials');
        // aws_role_arn 은 전 owner(통합 기본 + 구성원 오버라이드) 개관이 필요 → by-kind 조회
        awsRoles = await api('/api/ui/org/credentials?kind=aws_role_arn').catch(() => ({ credentials: [] }));
        // 외부 도구 서버(MCP) 프리셋 — '외부 자료 수집'(org_connector 미러)과 무관하다.
        catalog = await api('/api/ui/org/mcp-server-presets').catch(() => ({ catalog: [] }));
        mcpServers = await api('/api/ui/org/mcp-servers').catch(() => ({ servers: [] }));
    }
    catch (e) {
        detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '자격을 불러오지 못했습니다')));
        return;
    }
    const encReady = mine.encryption_ready !== false;
    const cards = [
        sectionHead('서비스 로그인 (조직)', 'AI가 외부 서비스를 조직 공용 계정으로 쓸 수 있게 미리 로그인해 둡니다. 개인 계정으로 쓰게 하려면 각자 [외부 서비스 로그인]에서 넣습니다.'),
        encReady ? null : el('p', { class: 'gate-error', text: '⚠ 서버에 암호화 키(CONNECTOR_SECRET_KEY)가 없어 자격을 저장할 수 없습니다 — 관리자에게 요청하세요.' }),
        catalogStatusCard(catalog.catalog || [], mcpServers.servers || []),
        credVaultCard('org', '통합 자격', '개인 로그인이 없는 구성원이 조회(비-PII read)할 때 공용으로 쓰는 로그인입니다. 쓰기·외부 발신·민감정보 접근에는 쓰이지 않습니다 — 이 작업들에는 개인 로그인이 필요합니다.', (org.credentials || []).filter((c) => c.kind !== 'aws_role_arn'), encReady, () => credentialsEditor(detail)),
        awsRoleCard(awsRoles.credentials || [], () => credentialsEditor(detail)),
    ];
    detail.replaceChildren(...cards.filter(Boolean)); // encReady 면 위 항목이 null → 'null' 텍스트 렌더 방지(#req)
}
// ── 내 서비스 로그인 — 서비스별 탭(#762). 방식(OAuth/토큰) 대신 '어떤 서비스'로 묶어 비개발자도 직관적으로. ──
//  탭 = 조직에 등록/연결된 서비스. [＋ 서비스 연결]에서 토큰형 서비스를 셀프 추가(OAuth 미등록 서비스는 관리자 몫).
const LOGIN_SERVICES = [
    // blurb — '무엇을 허용하는 것인지'를 그대로 말한다(#1085). '나로서 …해요' 는 무슨 일이 벌어지는지 모호했다.
    { key: 'notion', label: 'Notion', icon: '📔', oauth: 'notion', blurb: 'AI가 내 Notion 계정에 로그인해서 직접 문서를 읽고 작성할 수 있습니다.' },
    { key: 'linear', label: 'Linear', icon: '📐', oauth: 'linear', blurb: 'AI가 내 Linear 계정에 로그인해서 직접 이슈를 보고 만들 수 있습니다.' },
    { key: 'slack', label: 'Slack', icon: '💬', oauth: 'slack', token: 'slack_user_token', blurb: 'AI가 내 Slack 계정에 로그인해서 직접 메시지를 검색하고 보낼 수 있습니다.' },
    { key: 'google-gmail', label: 'Gmail', icon: '✉️', oauth: 'google-gmail', blurb: 'AI가 내 Gmail 계정에 로그인해서 직접 메일을 읽고 보낼 수 있습니다.' },
    { key: 'google-drive', label: 'Google Drive', icon: '📁', oauth: 'google-drive', blurb: 'AI가 내 Google Drive 계정에 로그인해서 직접 파일을 읽을 수 있습니다.' },
    { key: 'google-calendar', label: 'Google 캘린더', icon: '📅', oauth: 'google-calendar', blurb: 'AI가 내 Google 캘린더 계정에 로그인해서 직접 일정을 확인할 수 있습니다.' },
    { key: 'github', label: 'GitHub', icon: '🐙', token: 'github_pat', blurb: 'AI가 내 GitHub 계정에 로그인해서 직접 이슈·PR·저장소를 다룰 수 있습니다.' },
    { key: 'gitlab', label: 'GitLab', icon: '🦊', token: 'gitlab_pat', blurb: 'AI가 내 GitLab 계정에 로그인해서 직접 MR·저장소를 다룰 수 있습니다.' },
    { key: 'clickup', label: 'ClickUp', icon: '🗂️', token: 'clickup_token', blurb: 'AI가 내 ClickUp 계정에 로그인해서 직접 작업을 확인할 수 있습니다.' },
    { key: 'figma', label: 'Figma', icon: '🎨', token: 'figma_token', blurb: 'AI가 내 Figma 계정에 로그인해서 직접 디자인을 읽을 수 있습니다.' },
    { key: 'prometheus', label: 'Prometheus', icon: '📊', token: 'prometheus_bearer', blurb: 'AI가 내 Prometheus 계정에 로그인해서 직접 지표를 조회할 수 있습니다.' },
];
async function renderServiceTabs(host) {
    host.replaceChildren(el('p', { class: 'admin-hint', style: 'margin:0', text: '불러오는 중…' }));
    let creds = { credentials: [] }, oauth = { connectors: [] };
    try {
        creds = await api('/api/ui/me/credentials');
        oauth = await api('/api/ui/me/oauth/connectors').catch(() => ({ connectors: [] }));
    }
    catch (e) {
        host.replaceChildren(errorNote(e, '내 로그인을 불러오지 못했습니다'));
        return;
    }
    const oauthMap = new Map((oauth.connectors || []).map((c) => [c.server, c]));
    const credMap = new Map((creds.credentials || []).filter((c) => c.kind !== 'aws_role_arn').map((c) => [c.kind, c]));
    const isReg = (s) => !!((s.oauth && oauthMap.has(s.oauth)) || (s.token && credMap.has(s.token)));
    const isOn = (s) => !!((s.oauth && oauthMap.get(s.oauth) && oauthMap.get(s.oauth).connected) || (s.token && credMap.get(s.token) && credMap.get(s.token).has_secret));
    const tabs = LOGIN_SERVICES.filter(isReg);
    const addable = LOGIN_SERVICES.filter((s) => !isReg(s) && s.token); // 토큰형은 셀프 추가 가능
    const reload = () => renderServiceTabs(host);
    if (!tabs.length) {
        host.replaceChildren(el('p', { class: 'admin-hint', style: 'margin:0 0 12px', text: '아직 연결한 서비스가 없어요. 아래에서 골라 연결해요.' }), addPanel(addable, reload));
        return;
    }
    let active = tabs[0].key;
    const tabBar = el('div', { class: 'chips svc-tabs' });
    const body = el('div', { class: 'svc-tab-body' });
    const draw = () => {
        const mkTab = (key, label, icon, ok) => {
            const b = el('button', { type: 'button', class: 'chip svc-tab' + (active === key ? ' on' : '') }, icon ? el('span', { class: 'svc-tab-ic', text: icon }) : null, el('span', { text: label }), ok ? el('span', { class: 'svc-tab-dot', title: '연결됨' }) : null);
            b.onclick = () => { active = key; draw(); };
            return b;
        };
        tabBar.replaceChildren(...tabs.map((s) => mkTab(s.key, s.label, s.icon, isOn(s))), mkTab('__add__', '＋ 서비스 연결', '', false));
        if (active === '__add__')
            body.replaceChildren(addPanel(addable, reload));
        else
            body.replaceChildren(servicePanel(tabs.find((x) => x.key === active) || tabs[0], oauthMap, credMap, reload));
    };
    host.replaceChildren(tabBar, body);
    draw();
}
// 선택한 서비스 패널 — 상태 + 연결/해제(OAuth) 또는 토큰 상태/삭제/입력.
function servicePanel(svc, oauthMap, credMap, reload) {
    const oc = svc.oauth ? oauthMap.get(svc.oauth) : null;
    const cred = svc.token ? credMap.get(svc.token) : null;
    const on = !!((oc && oc.connected) || (cred && cred.has_secret));
    const wrap = el('div', {}, el('div', { class: 'svc-panel-head' }, el('span', { class: 'svc-panel-ic', text: svc.icon }), el('span', { class: 'svc-panel-nm', text: svc.label }), el('span', { class: 'pill' + (on ? ' pill-ok' : ''), text: on ? '연결됨 ✓' : '미연결' })), el('p', { class: 'admin-hint', style: 'margin:6px 0 14px', text: svc.blurb }));
    if (oc) {
        const connectBtn = el('button', { class: 'btn btn-sm ' + (oc.connected ? 'btn-ghost' : 'btn-primary'), text: oc.connected ? '다시 연결' : '연결',
            onclick: async () => {
                try {
                    const r = await api('/api/ui/me/oauth/connect', { method: 'POST', body: JSON.stringify({ server: svc.oauth }) });
                    if (r.authorized) {
                        toast('이미 연결됨');
                        reload();
                        return;
                    }
                    window.open(r.authorization_url, '_blank', 'noopener');
                    toast('새 탭에서 로그인·동의하세요 — 완료 후 [새로고침]');
                }
                catch (e) {
                    toast(e.message, true);
                }
            } });
        const discBtn = oc.connected ? el('button', { class: 'btn-text btn-text-danger', style: 'margin-left:auto', text: '연결 해제',
            onclick: async () => { if (!confirm(svc.label + ' 연결을 해제할까요?'))
                return; try {
                await api('/api/ui/me/oauth/disconnect', { method: 'POST', body: JSON.stringify({ server: svc.oauth }) });
                toast('해제됨');
                reload();
            }
            catch (e) {
                toast(e.message, true);
            } } }) : null;
        wrap.append(el('div', { class: 'admin-actions', style: 'margin:0' }, connectBtn, el('button', { class: 'btn-text', text: '새로고침', onclick: reload }), discBtn));
    }
    if (svc.token) {
        if (cred) {
            wrap.append(el('div', { class: 'svc-item', style: 'margin-top:12px' }, el('span', { class: 'mini-meta', text: '토큰 등록됨 ✓' + (cred.scope_key ? ' · ' + cred.scope_key : '') }), el('span', { class: 'svc-item-actions' }, el('button', { class: 'btn btn-ghost btn-sm', text: '삭제',
                onclick: async () => { if (!confirm(svc.label + ' 토큰을 삭제할까요?'))
                    return; try {
                    await api('/api/ui/me/credential/delete', { method: 'POST', body: JSON.stringify({ kind: svc.token, scope_key: cred.scope_key || '' }) });
                    toast('삭제됨');
                    reload();
                }
                catch (e) {
                    toast((e && e.message) || '삭제 실패', true);
                } } }))));
        }
        else if (!oc) {
            wrap.append(el('div', { style: 'margin-top:12px' }, svcTokenForm(svc.token, reload)));
        }
    }
    return wrap;
}
// 추가 패널 — 지원하지만 아직 연결 안 한 서비스. [연결] 시 그 서비스 토큰 폼을 인라인으로 편다.
function addPanel(addable, reload) {
    const wrap = el('div', {});
    if (!addable.length) {
        wrap.append(el('p', { class: 'admin-hint', style: 'margin:0', text: '추가로 연결할 서비스가 없어요.' }));
        return wrap;
    }
    const list = el('div', { class: 'svc-list' });
    addable.forEach((s) => {
        const btn = el('button', { class: 'btn btn-primary btn-sm', text: '연결' });
        const row = el('div', { class: 'svc-item' }, el('span', { class: 'svc-panel-ic', style: 'font-size:19px', text: s.icon }), el('span', { class: 'svc-item-main' }, el('span', { class: 'mini-title', text: s.label }), el('span', { class: 'mini-meta', text: s.blurb })), el('span', { class: 'svc-item-actions' }, btn));
        btn.onclick = () => {
            const next = row.nextElementSibling;
            if (next && next.classList.contains('svc-inline-form')) {
                next.remove();
                return;
            }
            row.after(el('div', { class: 'svc-inline-form', style: 'margin:-2px 0 2px' }, svcTokenForm(s.token, reload)));
        };
        list.append(row);
    });
    wrap.append(list);
    wrap.append(el('p', { class: 'admin-hint', style: 'margin:12px 0 0', text: 'Google 등 OAuth로만 연결되는 서비스는 관리자가 조직에 등록하면 위 탭에 떠요.' }));
    return wrap;
}
// 특정 종류(kind) 토큰 입력 폼 — CRED_KINDS 스펙 사용.
function svcTokenForm(kind, reload) {
    const spec = CRED_KINDS.find((x) => x.kind === kind);
    if (!spec)
        return el('div', {});
    const scopeIn = el('input', { type: 'text', placeholder: spec.scopePh || '' });
    const secretIn = el('input', { type: 'password', autocomplete: 'off', placeholder: spec.secretPh || '토큰 값 붙여넣기' });
    const submit = el('button', { class: 'btn btn-primary btn-sm', text: '저장' });
    const status = el('span', { class: 'admin-status' });
    submit.addEventListener('click', async () => {
        if (!secretIn.value.trim()) {
            toast('토큰을 입력하세요', true);
            return;
        }
        const payload = { kind: spec.kind, secret: secretIn.value };
        if (spec.scope && scopeIn.value.trim())
            payload.scope_key = scopeIn.value.trim();
        if (spec.meta)
            payload.meta = spec.meta;
        submit.disabled = true;
        status.textContent = '저장 중…';
        try {
            await api('/api/ui/me/credential', { method: 'POST', body: JSON.stringify(payload) });
            toast('저장됨');
            reload();
        }
        catch (e) {
            status.textContent = '';
            submit.disabled = false;
            toast((e && e.message) || '저장 실패', true);
        }
    });
    return el('div', { class: 'card', style: 'padding:14px' }, spec.scope ? field(spec.scope + '(선택)', scopeIn) : null, field(spec.secretLabel, secretIn), spec.help ? el('p', { class: 'admin-hint', style: 'margin:2px 0 0', text: spec.help }) : null, spec.docUrl ? el('a', { class: 'admin-hint', href: spec.docUrl, target: '_blank', rel: 'noopener', style: 'display:inline-block; margin:6px 0 0', text: '토큰 발급 페이지 열기 ↗' }) : null, el('div', { class: 'admin-actions', style: 'margin-top:10px' }, submit, status));
}
// 자격 목록 + 추가 폼 카드(me 또는 org). aws_role_arn 은 별도(awsRoleCard).
function credVaultCard(owner, title, intro, creds, encReady, reload) {
    const base = owner === 'me' ? '/api/ui/me/credential' : '/api/ui/org/credential';
    const kindLabel = (k) => (CRED_KINDS.find((x) => x.kind === k)?.label || k);
    const rows = [cardHead(title, intro)];
    // 등록된 자격 — 균일 보더 행(svc-item). 칩 + scope_key + 삭제(값 비노출).
    if (creds.length) {
        const list = el('div', { class: 'svc-list' });
        for (const c of creds) {
            list.append(el('div', { class: 'svc-item' }, el('span', { class: 'pill pill-ok', text: kindLabel(c.kind) }), c.scope_key ? el('span', { class: 'mini-meta', text: c.scope_key }) : null, el('span', { class: 'mini-meta', text: c.has_secret ? '토큰 등록됨 ✓' : '토큰 없음' }), el('span', { class: 'svc-item-actions' }, el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: async () => {
                    if (!confirm(`${kindLabel(c.kind)}${c.scope_key ? ' (' + c.scope_key + ')' : ''} 자격을 삭제할까요?`))
                        return;
                    try {
                        await api(base + '/delete', { method: 'POST', body: JSON.stringify({ kind: c.kind, scope_key: c.scope_key || '' }) });
                        toast('삭제됨');
                        reload();
                    }
                    catch (e) {
                        toast((e && e.message) || '삭제 실패', true);
                    }
                } }))));
        }
        rows.push(list);
    }
    else
        rows.push(el('p', { class: 'admin-hint', style: 'margin:0', text: '등록된 자격이 없습니다.' }));
    // ── 추가 폼 — kind 드롭다운 → 필요한 필드만 노출 ──
    const kindSel = el('select', {}, ...CRED_KINDS.map((k) => el('option', { value: k.kind, text: k.label })));
    const scopeIn = el('input', { type: 'text', placeholder: '' });
    const scopeField = field('대상 구분(선택)', scopeIn);
    const secretIn = el('input', { type: 'password', autocomplete: 'off', placeholder: '' });
    const secretField = field('토큰', secretIn);
    const helpP = el('p', { class: 'admin-hint', style: 'margin:2px 0 0' });
    const docLink = el('a', { class: 'admin-hint', target: '_blank', rel: 'noopener', style: 'display:none;margin:4px 0 0' });
    const submit = el('button', { class: 'btn btn-primary', text: '저장' });
    const status = el('span', { class: 'admin-status' });
    const syncKind = () => {
        const spec = CRED_KINDS.find((x) => x.kind === kindSel.value);
        scopeField.style.display = spec.scope ? '' : 'none';
        scopeField.querySelector('.field-label').textContent = (spec.scope || '대상 구분') + '(선택)';
        scopeIn.placeholder = spec.scopePh || '';
        secretField.querySelector('.field-label').textContent = spec.secretLabel;
        secretIn.placeholder = spec.secretPh || '토큰 값 붙여넣기';
        helpP.textContent = spec.help || '';
        helpP.style.display = spec.help ? '' : 'none';
        if (spec.docUrl) {
            docLink.setAttribute('href', spec.docUrl);
            docLink.textContent = '토큰 발급 페이지 열기 ↗';
            docLink.style.display = '';
        }
        else {
            docLink.style.display = 'none';
        }
    };
    kindSel.addEventListener('change', syncKind);
    syncKind();
    submit.addEventListener('click', async () => {
        if (!encReady) {
            toast('암호화 키 미설정 — 저장 불가', true);
            return;
        }
        if (!secretIn.value.trim()) {
            toast('토큰을 입력하세요', true);
            return;
        }
        const spec = CRED_KINDS.find((x) => x.kind === kindSel.value);
        const payload = { kind: spec.kind, secret: secretIn.value };
        if (spec.scope && scopeIn.value.trim())
            payload.scope_key = scopeIn.value.trim();
        if (spec.meta)
            payload.meta = spec.meta; // 헤더 형식 프리셋(사용자가 신경 안 써도 됨)
        submit.disabled = true;
        status.textContent = '저장 중…';
        try {
            await api(base, { method: 'POST', body: JSON.stringify(payload) });
            toast('저장됨');
            reload();
        }
        catch (e) {
            status.textContent = '';
            submit.disabled = false;
            toast((e && e.message) || '저장 실패', true);
        }
    });
    rows.push(el('div', { class: 'card', style: 'padding:12px; margin-top:10px;' }, cardHead('새 자격 추가'), field('서비스', kindSel), scopeField, secretField, helpP, docLink, el('div', { class: 'admin-actions', style: 'margin-top:10px' }, submit, status)));
    return el('div', { class: 'admin-section', style: 'margin-top:18px' }, el('h3', { class: 'admin-subhead', text: title }), ...rows);
}
// AWS 역할 카드(통합 자격의 특수형 — secret 없이 role ARN·리전·service). 게이트웨이가 이 역할을 각 구성원 이름으로 가정해 15분 단기자격 발급.
//  owner=gateway → 전원 기본(readonly 권장), owner=member:<id> → 그 구성원 오버라이드(write 포함 가능). #746 P1 오버라이드 체인.
function awsRoleCard(creds, reload) {
    const ownerLabel = (o) => (o && o.startsWith('member:') ? '구성원 ' + o.slice(7) : '전원 기본');
    const ownerMember = (o) => (o && o.startsWith('member:') ? o.slice(7) : ''); // '' = 조직 통합
    const rows = [cardHead('AWS 역할', 'AWS 는 토큰 대신 "역할(role)"을 등록합니다. 게이트웨이가 이 역할을 각 구성원 이름으로 가정(assume)해 15분 동안 유효한 단기 자격을 발급합니다 — 장기 키를 저장하지 않으므로 유출 위험이 없고, 누가 무엇을 했는지 AWS CloudTrail 에 기록됩니다. "전원 기본"은 조회(readonly) 역할로 두고, 쓰기가 필요한 구성원만 개별 오버라이드하세요. (역할·신뢰관계는 AWS 관리자가 먼저 만들어야 합니다.)')];
    // owner 정렬: 전원 기본(gateway) 먼저, 그 다음 구성원 오버라이드.
    const sorted = [...creds].sort((a, b) => (ownerMember(a.owner) ? 1 : 0) - (ownerMember(b.owner) ? 1 : 0) || String(a.owner).localeCompare(String(b.owner)));
    for (const c of sorted) {
        const m = c.meta || {};
        const mem = ownerMember(c.owner);
        rows.push(el('div', { class: 'card', style: 'padding:9px 12px; margin:6px 0; display:flex; gap:10px; align-items:center; flex-wrap:wrap;' }, el('span', { class: mem ? 'pill' : 'pill pill-ok', text: mem ? '오버라이드' : '전원 기본' }), el('span', { class: 'mini-meta', text: ownerLabel(c.owner) }), c.scope_key ? el('span', { class: 'mini-meta', text: c.scope_key }) : null, el('span', { class: 'mini-meta', text: (m.role_arn || '(role_arn 미설정)') + (m.region ? ' · ' + m.region : '') + (m.service ? ' · ' + m.service : '') }), el('button', { class: 'btn btn-ghost btn-sm', style: 'margin-left:auto', text: '삭제', onclick: async () => {
                if (!confirm(ownerLabel(c.owner) + ' AWS 역할 자격을 삭제할까요?'))
                    return;
                const body = { kind: 'aws_role_arn', scope_key: c.scope_key || '' };
                if (mem)
                    body.member = mem;
                try {
                    await api('/api/ui/org/credential/delete', { method: 'POST', body: JSON.stringify(body) });
                    toast('삭제됨');
                    reload();
                }
                catch (e) {
                    toast((e && e.message) || '삭제 실패', true);
                }
            } })));
    }
    if (!creds.length)
        rows.push(el('p', { class: 'admin-hint', text: '등록된 AWS 역할이 없습니다.' }));
    // ── 추가/오버라이드 폼 ──
    const targetSel = el('select', {}, el('option', { value: '', text: '전원 기본 (조직 통합 · readonly 권장)' }), el('option', { value: 'member', text: '특정 구성원 오버라이드' }));
    const member = memberCombo({ placeholder: '구성원 id 선택/검색 (예: daon)' });
    const memberField = field('대상 구성원', member.el);
    const arnIn = el('input', { type: 'text', placeholder: 'arn:aws:iam::123456789012:role/lively-readonly' });
    const regionSel = el('select', {}, ...AWS_REGIONS.map((r) => el('option', { value: r, text: r })));
    const serviceIn = el('input', { type: 'text', placeholder: 'execute-api (기본) — aws-mcp 엔드포인트 서명 대상' });
    const extIn = el('input', { type: 'text', placeholder: '역할 신뢰관계가 ExternalId 를 요구할 때만' });
    const scopeIn = el('input', { type: 'text', placeholder: '여러 역할을 등록할 때 구별할 이름' });
    const submit = el('button', { class: 'btn btn-primary', text: '저장' });
    const status = el('span', { class: 'admin-status' });
    const syncTarget = () => { memberField.style.display = targetSel.value === 'member' ? '' : 'none'; };
    targetSel.addEventListener('change', syncTarget);
    syncTarget();
    submit.addEventListener('click', async () => {
        if (!arnIn.value.trim()) {
            toast('역할 ARN 을 입력하세요', true);
            return;
        }
        const isOverride = targetSel.value === 'member';
        if (isOverride && !member.value()) {
            toast('오버라이드할 구성원을 선택하세요', true);
            return;
        }
        const meta = { role_arn: arnIn.value.trim(), region: regionSel.value };
        if (serviceIn.value.trim())
            meta.service = serviceIn.value.trim();
        if (extIn.value.trim())
            meta.external_id = extIn.value.trim();
        const body = { kind: 'aws_role_arn', scope_key: scopeIn.value.trim() || '', meta };
        if (isOverride)
            body.member = member.value();
        submit.disabled = true;
        status.textContent = '저장 중…';
        try {
            await api('/api/ui/org/credential', { method: 'POST', body: JSON.stringify(body) });
            toast('저장됨');
            reload();
        }
        catch (e) {
            status.textContent = '';
            submit.disabled = false;
            toast((e && e.message) || '저장 실패', true);
        }
    });
    rows.push(el('div', { class: 'card', style: 'padding:12px; margin-top:10px;' }, cardHead('AWS 역할 등록 · 오버라이드'), field('적용 대상', targetSel), memberField, field('역할 ARN (role ARN)', arnIn), field('리전 (region)', regionSel), field('서명 서비스 (선택 · 기본 execute-api)', serviceIn), field('ExternalId (선택)', extIn), field('구분 이름 (선택)', scopeIn), el('div', { class: 'admin-actions', style: 'margin-top:10px' }, submit, status)));
    return el('div', { class: 'admin-section', style: 'margin-top:18px' }, el('h3', { class: 'admin-subhead', text: 'AWS 역할 (단기 자격)' }), ...rows);
}
// ── DB 접근 감사 뷰(#746 P5) — 누가·언제·무엇을 조회했나(위변조 방지). 필터는 드롭다운 위주. admin. ──
const AUDIT_PERIODS = [['1d', '최근 24시간'], ['7d', '최근 7일'], ['30d', '최근 30일'], ['all', '전체 기간']];
function auditSince(period) {
    const now = Date.now();
    const ms = period === '1d' ? 86400000 : period === '7d' ? 7 * 86400000 : period === '30d' ? 30 * 86400000 : 0;
    return ms ? new Date(now - ms).toISOString() : null;
}
async function dbAuditEditor(detail, data) {
    const f = state.admin.dbAuditFilter || (state.admin.dbAuditFilter = { source: '', op: '', result: '', period: '7d', user: '', table: '' });
    const sources = (data.dbSources || []).map((s) => s.name);
    const srcSel = selectFilter([['', '모든 소스'], ...sources.map((n) => [n, n])], f.source);
    const opSel = selectFilter([['', '쿼리+스키마'], ['query', '쿼리(db_query)'], ['schema', '스키마(db_schema)']], f.op);
    const resSel = selectFilter([['', '성공+차단'], ['errors', '차단만']], f.result);
    const perSel = selectFilter(AUDIT_PERIODS, f.period);
    const userIn = el('input', { type: 'text', value: f.user || '', placeholder: '조회자 id(선택)', style: 'max-width:150px' });
    const tableIn = el('input', { type: 'text', value: f.table || '', placeholder: '테이블명(선택)', style: 'max-width:150px' });
    const body = el('div', {});
    const apply = () => {
        f.source = srcSel.value;
        f.op = opSel.value;
        f.result = resSel.value;
        f.period = perSel.value;
        f.user = userIn.value.trim();
        f.table = tableIn.value.trim();
        void loadAuditRows(body, f);
    };
    for (const c of [srcSel, opSel, resSel, perSel])
        c.addEventListener('change', apply);
    const searchBtn = el('button', { class: 'btn btn-sm', text: '조회', onclick: apply });
    const bar = el('div', { class: 'audit-bar' }, srcSel, opSel, resSel, perSel, userIn, tableIn, searchBtn);
    const verifyOut = el('span', { class: 'admin-status' });
    const verifyBtn = el('button', { class: 'btn btn-sm', text: '위변조 검증', onclick: async () => {
            verifyOut.textContent = '검증 중…';
            try {
                const r = await api('/api/ui/db-audit/verify');
                verifyOut.replaceChildren(r.ok
                    ? el('span', { class: 'audit-ok', text: `✓ 무결 (${r.checked}건 검증)` })
                    : el('span', { class: 'audit-bad', text: `⚠ 위변조 의심 — id ${r.broken?.id} (${r.broken?.reason})` }));
            }
            catch (e) {
                verifyOut.replaceChildren(el('span', { class: 'audit-bad', text: e.message }));
            }
        } });
    bar.append(el('div', { class: 'audit-verify' }, verifyBtn, verifyOut));
    const card = el('div', { class: 'card' }, cardHead('DB 조회 기록', "구성원(과 그들의 AI)이 db_query·db_schema 로 어떤 데이터를 조회했는지 전부 기록됩니다 — 조회자·시각·소스·테이블·마스킹/열람 컬럼·대상 식별자. 기록은 해시체인으로 위변조를 방지하며, 신용정보법상 조회 기록 보존에 사용합니다. '누구의 정보인지'를 남길 식별자 컬럼은 [데이터 연결 ▸ DB 데이터소스]에서 지정합니다."), bar, body);
    detail.replaceChildren(card);
    void loadAuditRows(body, f);
}
async function loadAuditRows(body, f) {
    body.replaceChildren(el('p', { class: 'admin-hint', text: '불러오는 중…' }));
    const qs = new URLSearchParams({ limit: '100' });
    if (f.source)
        qs.set('source', f.source);
    if (f.op)
        qs.set('op', f.op);
    if (f.result === 'errors')
        qs.set('errors', '1');
    if (f.user)
        qs.set('user', f.user);
    if (f.table)
        qs.set('table', f.table.toLowerCase());
    const since = auditSince(f.period);
    if (since)
        qs.set('since', since);
    let r;
    try {
        r = await api('/api/ui/db-audit?' + qs.toString());
    }
    catch (e) {
        body.replaceChildren(errorNote(e, '감사 기록을 불러오지 못했습니다'));
        return;
    }
    const rows = r.rows || [];
    if (!rows.length) {
        body.replaceChildren(el('p', { class: 'admin-hint', text: '해당 조건의 조회 기록이 없습니다.' }));
        return;
    }
    const tbl = el('table', { class: 'audit-table' });
    tbl.append(el('tr', {}, ...['시각', '조회자', '구분', '소스', '테이블', '마스킹', '열람(raw)', '행', '결과'].map((h) => el('th', { text: h }))));
    for (const row of rows) {
        const unmasked = (row.unmasked_columns || []);
        const masked = (row.masked_columns || []);
        const subj = row.subject_keys ? Object.keys(row.subject_keys).length : 0;
        tbl.append(el('tr', { class: row.ok ? '' : 'audit-row-bad' }, el('td', { class: 'audit-time', text: relTime(row.at) }), el('td', {}, row.user_id || '-', row.harness ? el('span', { class: 'mini-meta', text: ' · ' + row.harness }) : null), el('td', { text: row.op === 'schema' ? '스키마' : '쿼리' }), el('td', { text: row.source || '-' }), el('td', { class: 'audit-tables' }, (row.tables || []).join(', ') || '-', subj ? el('span', { class: 'mini-meta', text: ` · 대상 ${subj}` }) : null), el('td', { text: masked.length ? String(masked.length) : '-' }), el('td', {}, unmasked.length ? el('span', { class: 'pill pill-warn', text: unmasked.join(', ') }) : el('span', { class: 'mini-meta', text: '-' })), el('td', { class: 'audit-num', text: row.ok ? String(row.row_count) : '-' }), el('td', {}, row.ok ? el('span', { class: 'audit-ok', text: '성공' }) : withTip(el('span', { class: 'audit-bad', text: '차단' }), row.error || '차단됨'))));
    }
    body.replaceChildren(el('p', { class: 'admin-hint', text: `${rows.length}건${r.total > rows.length ? ` (전체 ${r.total}건 중 최근 100건)` : ''} · '열람(raw)' 열은 마스킹을 우회해 원본 값을 조회한 컬럼입니다. 붉은 행은 차단된 조회입니다.` }), el('div', { class: 'audit-scroll' }, tbl));
}
async function renderSubjectKeyPanel(panel, source, data) {
    panel.replaceChildren(el('p', { class: 'admin-hint', text: '식별자 설정 불러오는 중…' }));
    let keys = [];
    let schema = null;
    try {
        const r = await api('/api/ui/org/db-source/subject-keys?source=' + encodeURIComponent(source));
        keys = r.keys || [];
        schema = await api('/api/ui/org/db-source/schema?source=' + encodeURIComponent(source)).catch(() => null);
    }
    catch (e) {
        panel.replaceChildren(errorNote(e, '식별자 설정을 불러오지 못했습니다'));
        return;
    }
    const rows = [
        sectionTitle('대상 식별자 컬럼 — ' + source, "이 소스에서 조회 시 '누구의 정보인지'를 감사에 남길 컬럼을 지정합니다(예: 고객ID). ⚠ 주민번호·계좌 같은 민감 원값 컬럼은 지정하지 마세요 — 감사기록이 개인정보 저장소가 되면 안 됩니다. 서로게이트 키(내부 ID)만 지정하세요."),
    ];
    if (keys.length) {
        for (const k of keys) {
            rows.push(el('div', { class: 'item' }, el('span', { class: 'pill', text: k.table_name + '.' + k.column_name }), el('button', { class: 'btn btn-ghost btn-sm spacer', text: '해제', onclick: async () => {
                    try {
                        await api('/api/ui/org/db-source/subject-key', { method: 'POST', body: JSON.stringify({ source, table: k.table_name, column: k.column_name, remove: true }) });
                        toast('해제됨');
                        renderSubjectKeyPanel(panel, source, data);
                    }
                    catch (e) {
                        toast(e.message, true);
                    }
                } })));
        }
    }
    else
        rows.push(el('p', { class: 'admin-hint', text: '지정된 식별자 컬럼이 없습니다.' }));
    const tables = schema && schema.tables ? schema.tables.filter((t) => t.mode === 'allow' && !t.system).map((t) => t.name) : [];
    const tableSel = tables.length ? selectFilter([['', '테이블 선택'], ...tables.map((t) => [t, t])], '') : el('input', { type: 'text', placeholder: '테이블명' });
    const colInput = el('input', { type: 'text', placeholder: '컬럼명 (예: customer_id)' });
    const addBtn = el('button', { class: 'btn btn-primary btn-sm', text: '식별자로 지정', onclick: async () => {
            const table = tableSel.value.trim();
            const column = colInput.value.trim();
            if (!table || !column) {
                toast('테이블·컬럼을 입력하세요', true);
                return;
            }
            try {
                await api('/api/ui/org/db-source/subject-key', { method: 'POST', body: JSON.stringify({ source, table, column }) });
                toast('지정됨');
                renderSubjectKeyPanel(panel, source, data);
            }
            catch (e) {
                toast(e.message, true);
            }
        } });
    rows.push(el('div', { class: 'addbox', style: 'margin-top:10px' }, el('div', { class: 'admin-actions', style: 'gap:8px; flex-wrap:wrap' }, tableSel, colInput, addBtn)));
    panel.replaceChildren(...rows);
}
// ── raw-PII 언마스크 권한(grant) 패널(#746 P4) — 이 소스의 마스킹을 특정 구성원이 우회(raw 조회)하도록 허가. ──
//  직무상 raw PII 가 필요한 사람(심사역·CS 등)용. 만료(JIT) 드롭다운·승인자 기록(maker-checker). 텍스트 최소.
const GRANT_EXPIRY = [['72h', '3일 (권장)'], ['24h', '1일'], ['7d', '7일'], ['30d', '30일'], ['', '무기한 (지양)']];
async function renderUnmaskGrantPanel(panel, source, data) {
    panel.replaceChildren(el('p', { class: 'admin-hint', text: '언마스크 권한 불러오는 중…' }));
    let grants = [];
    let schema = null;
    try {
        const r = await api('/api/ui/org/db-source/unmask-grants?source=' + encodeURIComponent(source) + '&active=1');
        grants = r.grants || [];
        schema = await api('/api/ui/org/db-source/schema?source=' + encodeURIComponent(source)).catch(() => null);
    }
    catch (e) {
        panel.replaceChildren(errorNote(e, '언마스크 권한을 불러오지 못했습니다'));
        return;
    }
    const rows = [
        sectionTitle('raw-PII 열람 권한 (언마스크)', '기본은 전원 마스킹입니다. 직무상 원본이 꼭 필요한 구성원에게만, 특정 테이블·컬럼을, 기간을 정해 열어줍니다 — 열람 내역은 「DB 접근 감사」에 남습니다.'),
    ];
    if (grants.length) {
        for (const g of grants) {
            const exp = g.expires_at ? relTime(g.expires_at) + ' 만료' : '무기한';
            rows.push(el('div', { class: 'item' }, el('span', { class: 'pill pill-warn', text: g.member_id }), el('span', { class: 'mini-meta', text: g.table_name + '.' + g.column_name }), el('span', { class: 'mini-meta', text: exp }), g.reason ? el('span', { class: 'mini-meta', text: '· ' + g.reason }) : null, el('button', { class: 'btn btn-ghost btn-sm spacer', text: '권한 해제', onclick: async () => {
                    if (!confirm(`${g.member_id} 의 ${g.table_name}.${g.column_name} 언마스크 권한을 해제할까요?`))
                        return;
                    try {
                        await api('/api/ui/org/db-source/unmask-grant/revoke', { method: 'POST', body: JSON.stringify({ id: g.id }) });
                        toast('권한 해제됨');
                        renderUnmaskGrantPanel(panel, source, data);
                    }
                    catch (e) {
                        toast(e.message, true);
                    }
                } })));
        }
    }
    else
        rows.push(el('p', { class: 'admin-hint', text: '부여된 언마스크 권한이 없습니다 (전원 마스킹).' }));
    // 추가 — 구성원(드롭다운)·테이블(마스킹 있는 테이블 드롭다운)·컬럼(그 테이블 마스킹 컬럼 드롭다운, * 포함)·만료·승인자·사유
    const memberC = memberCombo({ placeholder: '구성원 선택' });
    const maskedTables = schema && schema.tables ? schema.tables.filter((t) => (t.maskedCount || 0) > 0).map((t) => t.name) : [];
    const tableSel = maskedTables.length
        ? selectFilter([['', '테이블 선택'], ...maskedTables.map((t) => [t, t])], '')
        : el('input', { type: 'text', placeholder: '테이블명' });
    const colSel = el('select', {}, el('option', { value: '*', text: '* (그 테이블의 마스킹 컬럼 전체)' }));
    const refreshCols = async () => {
        const tv = tableSel.value;
        while (colSel.options.length > 1)
            colSel.remove(1);
        if (!tv)
            return;
        try {
            const sc = await api('/api/ui/org/db-source/schema?source=' + encodeURIComponent(source) + '&table=' + encodeURIComponent(tv));
            for (const c of (sc.rows || []))
                if (c.masked)
                    colSel.append(el('option', { value: c.column_name, text: c.column_name + ' (' + c.masked + ')' }));
        }
        catch { /* graceful — * 만 */ }
    };
    if (tableSel.tagName === 'SELECT')
        tableSel.addEventListener('change', refreshCols);
    const expSel = selectFilter(GRANT_EXPIRY, '72h');
    const approverC = memberCombo({ placeholder: '승인자(선택)' });
    const reasonIn = el('input', { type: 'text', placeholder: '사유(선택 · 예: 대출 심사)' });
    const addBtn = el('button', { class: 'btn btn-primary btn-sm', text: '권한 부여', onclick: async () => {
            const member = memberC.value();
            const table = tableSel.value.trim();
            if (!member || !table) {
                toast('구성원·테이블을 선택하세요', true);
                return;
            }
            const payload = { member, source, table, column: colSel.value || '*' };
            if (expSel.value)
                payload.expires = expSel.value;
            if (approverC.value())
                payload.approved_by = approverC.value();
            if (reasonIn.value.trim())
                payload.reason = reasonIn.value.trim();
            try {
                await api('/api/ui/org/db-source/unmask-grant', { method: 'POST', body: JSON.stringify(payload) });
                toast('부여됨');
                renderUnmaskGrantPanel(panel, source, data);
            }
            catch (e) {
                toast(e.message, true);
            }
        } });
    rows.push(el('div', { class: 'addbox', style: 'margin-top:10px' }, el('div', { class: 'addbox-h', text: '+ 언마스크 권한 부여' }), field('구성원', memberC.el), field('테이블', tableSel), field('컬럼', colSel), field('만료 (JIT)', expSel), field('승인자 (maker-checker)', approverC.el), field('사유', reasonIn), el('div', { class: 'admin-actions', style: 'margin-top:10px' }, addBtn)));
    panel.replaceChildren(...rows);
}
// ════════════════════════════════════════════════════════════════════
// 개인 설정 (#837 후속) — 우상단 [내 프로필] 모달 하나에 필드 15개 + 중첩 모달 2개가 들어 있었다.
//  사용자 지적: "개인 설정을 프로필 모달에서 하고있는데 이 경험이 안좋은거같아. 프로필 모달은 진짜 프사나
//  표시 이름변경정도로 하고 나머지는 관리탭에 개인 설정 대분류 하나 파서 그 안으로 적절히 옮기는게 맞지 않을까?"
//  → 모달 = 빠른 편집(프사·표시이름), 관리탭 [내 설정] = 전체. 저장 경로는 그대로다(서버가 부분 갱신).
// ════════════════════════════════════════════════════════════════════
// 아바타 편집기 — 사진 업로드 / 커스텀 글자·색 / 기본(이니셜+해시색). 모달과 [내 정보]가 공유한다.
//  payload(): undefined 인 필드는 안 보낸다 = 서버가 보존(me_profile_update 는 patch).
function avatarEditor(data, nameInput) {
    let avatarState; // undefined=변경없음 · null=기본으로 · string=새 이미지
    let charState = (data.avatar_char || '');
    let colorState = (data.avatar_color || '');
    const preview = el('span', { class: 'prof-ava-preview' });
    const render = () => {
        const cur = avatarState === undefined ? (data.avatar || null) : avatarState;
        const nm = (nameInput && nameInput.value.trim()) || data.display_name || data.email || data.id || '';
        preview.replaceChildren(profileAvatar(cur, nm, data.id, 'prof-ava-lg', { char: charState, color: colorState }));
    };
    const fileIn = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    const uploadBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '사진 올리기' });
    const removeBtn = el('button', { type: 'button', class: 'btn-text', text: '기본 이미지로' });
    uploadBtn.addEventListener('click', () => fileIn.click());
    fileIn.addEventListener('change', async () => {
        const f = fileIn.files && fileIn.files[0];
        if (!f)
            return;
        try {
            avatarState = await fileToAvatarDataUrl(f);
            render();
        }
        catch (e) {
            toast((e && e.message) || '이미지를 처리하지 못했습니다', true);
        }
        fileIn.value = '';
    });
    removeBtn.addEventListener('click', () => { avatarState = null; render(); });
    if (nameInput)
        nameInput.addEventListener('input', render); // 이름을 바꾸면 폴백 이니셜도 갱신
    const charIn = el('input', { type: 'text', maxlength: '3', value: charState, placeholder: '글자', style: 'width:70px; text-align:center; font-weight:700;' });
    charIn.addEventListener('input', () => { charState = charIn.value; render(); });
    const AVA_COLORS = ['#6c8cff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#64748b', '#0ea5e9', '#14b8a6', '#f97316', '#8b5cf6'];
    const colorRow = el('div', { class: 'pjv-color-swatches' });
    const paintColors = () => {
        const auto = el('button', { type: 'button', class: 'pjv-sw pjv-sw-none' + (colorState ? '' : ' on'), title: '자동(이름 해시색)', text: 'A' });
        auto.onclick = () => { colorState = ''; paintColors(); render(); };
        colorRow.replaceChildren(auto, ...AVA_COLORS.map((c) => {
            const sw = el('button', { type: 'button', class: 'pjv-sw' + (colorState === c ? ' on' : ''), style: 'background:' + c, title: c });
            sw.onclick = () => { colorState = c; paintColors(); render(); };
            return sw;
        }));
    };
    paintColors();
    render();
    const node = el('div', {}, el('div', { class: 'prof-ava-row' }, preview, el('div', { class: 'prof-ava-actions' }, fileIn, uploadBtn, removeBtn, el('p', { class: 'prof-hint', style: 'margin:0', text: '정사각형 이미지를 권장해요. 안 올리면 아래 글자·색(또는 이름 이니셜)으로 자동 생성됩니다.' }))), el('div', { class: 'prof-ava-cc', style: 'margin-top:12px' }, el('div', { style: 'display:flex; align-items:center; gap:12px; flex-wrap:wrap' }, charIn, colorRow), el('p', { class: 'prof-hint', style: 'margin:6px 0 0', text: '사진이 없을 때 아바타에 쓸 글자(비우면 이니셜)와 배경색이에요.' })));
    const payload = () => {
        const out = { avatar_char: charState.trim() || null, avatar_color: colorState || null };
        if (avatarState !== undefined)
            out.avatar = avatarState; // 미변경이면 아예 안 보낸다 → 서버 보존
        return out;
    };
    return { node, payload };
}
// 저장 후 상단바(아바타·이름)·사람 아바타 맵 즉시 갱신 — 모달·[내 정보] 공유.
function applyMyProfileSaved(res, fallbackId) {
    const m = (res && res.member) || {};
    if (state.me) {
        state.me.display_name = m.display_name || null;
        state.me.avatar = m.avatar || null;
        state.me.avatar_char = m.avatar_char || null;
        state.me.avatar_color = m.avatar_color || null;
    }
    setPersonAvatar((state.me && state.me.userId) || fallbackId, m);
    const label = (m.display_name && m.display_name.trim()) || m.email || (state.me && (state.me.email || state.me.userId)) || '';
    const ue = document.getElementById('user-email');
    if (ue)
        ue.replaceChildren(profileAvatar(m.avatar || null, label, (state.me && state.me.userId) || fallbackId, 'topbar-ava', { char: m.avatar_char, color: m.avatar_color }), el('span', { text: label }));
}
// ── '내 정보' 팝업(#762) — 우측 상단 프로필 클릭 시 열림. 관리에서 분리. 아바타 · 이름 · 닉네임 · 이메일(읽기) · 비밀번호. ──
//  닉네임은 표시 이름(이름)과 별개 필드 — 대시보드 활동 로그 등 캐주얼 표기에 쓰인다(비우면 이름 폴백).
export async function openMyProfileModal() {
    const head = el('div', { class: 'ov-head' }, el('h3', { text: '내 정보' }));
    const box = el('div', { class: 'ov-box', style: 'max-width:520px' }, head);
    const back = el('div', { class: 'ov-back' }, box);
    const close = () => back.remove();
    head.append(el('button', { class: 'btn btn-ghost btn-sm', text: '닫기', onclick: close }));
    back.addEventListener('click', (e) => { if (e.target === back)
        close(); });
    document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') {
        close();
        document.removeEventListener('keydown', esc);
    } });
    const bodyWrap = el('div', {}, skeleton('내 정보를 불러오는 중'));
    box.append(bodyWrap);
    document.body.append(back);
    let data;
    try {
        data = await api('/api/ui/me/profile');
    }
    catch (e) {
        bodyWrap.replaceChildren(errorNote(e, '내 정보를 불러오지 못했습니다'));
        return;
    }
    const nameIn = el('input', { type: 'text', value: data.display_name || '', placeholder: '이름 (비우면 이메일/아이디로 표시)' });
    const nickIn = el('input', { type: 'text', value: data.nickname || '', placeholder: '닉네임 (비우면 이름으로 표시)' });
    const ava = avatarEditor(data, nameIn);
    const saveBtn = el('button', { type: 'button', class: 'btn btn-primary', text: '저장' });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        // body_md 는 **안 보낸다** — 서버가 미전송 필드를 보존하므로 [내 AI 설정]이 지워지지 않는다.
        const payload = { display_name: nameIn.value.trim(), nickname: nickIn.value.trim(), ...ava.payload() };
        try {
            const res = await api('/api/ui/me/profile', { method: 'POST', body: JSON.stringify(payload) });
            applyMyProfileSaved(res, data.id);
            toast('저장됨');
            status.textContent = '저장됨';
        }
        catch (e) {
            toast((e && e.message) || '저장하지 못했습니다', true);
        }
        saveBtn.disabled = false;
    });
    bodyWrap.replaceChildren(el('p', { class: 'admin-hint', style: 'margin:0 0 14px', text: '이름·사진은 프로젝트·작업 기록·팀 화면 어디에서나 나를 가리키는 얼굴이에요.' }), field('프로필 사진', ava.node), field('이름', nameIn), field('닉네임 (활동 로그 등에 표시)', nickIn), data.email ? field('이메일 (로그인 아이디 · 변경은 관리자)', el('div', { class: 'admin-ro', text: data.email })) : null, data.email ? field('비밀번호', el('div', { style: 'display:flex; align-items:center; gap:10px; flex-wrap:wrap;' }, el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '비밀번호 변경', onclick: () => changePasswordModal() }), el('span', { class: 'admin-hint', style: 'margin:0', text: '현재 비밀번호를 확인한 뒤 새 비밀번호로 바꿔요.' }))) : null, el('div', { class: 'admin-actions' }, saveBtn, status));
}
// ── [내 설정 ▸ 내 AI 설정] 상단 박스 — 내 AI 계정(#1085). ──
//  아래 박스가 '내 AI 에게 무엇을 알려줄까'(개인 규칙)라면, 이 박스는 '내 AI 가 **무엇으로, 누구 계정으로** 도는가'다.
//  성격이 달라 한 박스에 섞지 않고 위에 별도 카드로 둔다(사용자 요구).
//  · 무엇으로 — 하네스(Claude Code · Codex). 지금 내 세션이 실제로 어느 것으로 떠 있는지 개수로 보여준다.
//  · 누구 계정으로 — 서버가 보는 자격증명 존재 여부(scope=isolated/profile/shared, /api/ui/me/ai-accounts).
//  로그인은 그 AI 를 띄운 **개인 세션**을 새 탭으로 열어 사람이 직접 한다(OAuth 는 브라우저 흐름이라 대행 불가) —
//  AI세션 탭의 [내 계정 로그인]과 같은 경로(loginProfile)를 재사용한다.
const AI_LOGIN_HINT = {
    claude: '열린 세션의 claude 에서 /login 을 실행하세요.',
    codex: '열린 세션에서 codex 를 실행하면 로그인 안내가 나옵니다.',
};
function aiAccountRow(a, mySessions, reload) {
    const mine = (mySessions || []).filter((s) => s.harness === a.key);
    const live = mine.filter((s) => s.agentState && s.agentState !== 'exited' && s.agentState !== 'offline');
    // 공유 계정 = 이 서버의 호스트 홈 자격을 전 구성원이 함께 쓰는 상태. 로그아웃하면 남의 세션까지 끊기므로 잠근다.
    const shared = a.scope === 'shared';
    // 상태는 3-상태다(true/false/null). **배지는 짧게, 사연은 툴팁으로** — 제약 설명(공용 계정·맥 키체인)을
    //  본문에 풀어 쓰면 두세 줄짜리 회색 문단이 되어 정작 '연결됐나?'가 안 읽힌다(사용자 지적).
    const st = a.loggedIn === true
        ? { text: '연결됨', cls: 'pill pill-ok', tip: (shared ? '이 서버 공용 계정으로 연결돼 있습니다' : '내 계정으로 연결돼 있습니다') + ' — ' + a.where }
        : a.loggedIn === false
            ? { text: '연결 안 됨', cls: 'pill', tip: '아직 로그인하지 않았습니다. [로그인] 을 누르면 이 AI 로 세션이 하나 열리고, 거기서 한 번만 로그인하면 됩니다.' }
            : { text: '확인 불가', cls: 'pill', tip: '이 서버가 로그인 여부를 확인하지 못했습니다(자격이 키체인에 있거나 접근할 수 없음). 세션이 잘 돌고 있으면 연결된 것입니다.' };
    const badge = withTip(el('span', { class: st.cls, text: st.text }), st.tip);
    const openLogin = async (ev) => {
        // 공용 계정에서의 로그인은 **남의 것까지 바꾼다** — 이 서버의 그 AI 계정이 통째로 바뀌므로 먼저 알린다.
        if (shared && !confirm(a.label + ' 로그인 세션을 열까요?\n\n이 서버는 구성원별 계정 격리가 없어, 여기서 로그인하면 이 서버의 ' + a.label + ' 계정이 통째로 바뀝니다 — 다른 구성원의 세션도 그 계정을 쓰게 됩니다.'))
            return;
        const btn = ev.currentTarget;
        btn.disabled = true;
        try {
            const out = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify({
                    label: '내 계정 로그인 (' + a.label + ')', rootKey: 'personal', subpath: '', harness: a.key, flags: {}, autoApprove: false, loginProfile: true,
                }) });
            toast('로그인용 세션을 열었습니다 — ' + (AI_LOGIN_HINT[a.key] || '그 세션에서 로그인하세요.'));
            if (out && out.session)
                window.open('/ui/terminal.html?session=' + encodeURIComponent(out.session.id) + '&label=' + encodeURIComponent(out.session.label || ''), '_blank');
        }
        catch (e) {
            toast('로그인 세션을 열지 못했습니다 — ' + ((e && e.message) || e), true);
        }
        btn.disabled = false;
    };
    const logout = async (ev) => {
        if (!confirm(a.label + ' 에서 로그아웃할까요?\n\n내 자격증명만 지웁니다(다시 로그인하면 복구됩니다). 이미 떠 있는 세션의 AI 는 그 자리에서 끊기지 않고, 다음 로그인부터 적용됩니다.'))
            return;
        const btn = ev.currentTarget;
        btn.disabled = true;
        try {
            await api('/api/ui/me/ai-accounts/logout', { method: 'POST', body: JSON.stringify({ harness: a.key }) });
            toast(a.label + ' 로그아웃됨');
        }
        catch (e) {
            toast('로그아웃하지 못했습니다 — ' + ((e && e.message) || e), true);
        }
        void reload();
    };
    // 부제는 **한 줄**만 — 지금 이 AI 로 도는 내 세션이 몇 개인지(이 화면에서 사람이 실제로 궁금해하는 것).
    //  공유 계정 같은 단서는 짧은 꼬리표로만 붙이고 사연은 툴팁에 둔다.
    const sub = live.length ? `내 세션 ${live.length}개가 이 AI로 실행 중` : '이 AI로 실행 중인 내 세션 없음';
    return el('div', { class: 'aiacct' }, el('div', { class: 'aiacct-txt' }, el('div', { class: 'aiacct-head' }, el('span', { class: 'aiacct-name', text: a.label }), badge, shared ? withTip(el('span', { class: 'pill', text: '서버 공용' }), '이 AI 의 계정은 이 서버 전체가 함께 씁니다 — 내가 연결한 것이 아닐 수 있고, 로그아웃하면 다른 구성원 세션까지 끊기므로 잠가 두었습니다.') : null), el('div', { class: 'aiacct-sub', text: sub })), el('div', { class: 'aiacct-act' }, 
    // 로그인 버튼은 '연결 확정'일 때만 감춘다 — 확인 불가에서도 다시 로그인은 언제나 해가 없다.
    a.loggedIn === true ? null : el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '로그인', onclick: openLogin }), a.canLogout ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '로그아웃', onclick: logout }) : null));
}
function myAiAccountsCard() {
    const body = el('div');
    // 제목이 '내 AI 계정'이면 거짓말이 될 수 있다 — 구성원별 격리가 없는 서버에서는 아래 상태가 **서버 공용 계정**의
    //  것이고 내가 연결한 게 아니다(사용자 지적: "Codex는 내가 연결한 적 없"). 중립 제목 + 상황별 배너로 바로잡는다.
    const card = el('div', { class: 'card' }, cardHead('연결된 AI 계정', '내 AI 세션이 이 계정으로 실행됩니다. 계정이 구성원별로 갈리지 않는 서버에서는 \'서버 공용\' 표시가 붙습니다.'), body);
    const load = async () => {
        body.replaceChildren(el('p', { class: 'admin-hint', text: '불러오는 중…' }));
        try {
            // 세션은 실패해도 계정 카드는 보여준다(개수는 부가정보) — 터미널이 없는 배포에서도 로그인 상태는 유효하다.
            const [acc, ses] = await Promise.all([
                api('/api/ui/me/ai-accounts'),
                api('/api/ui/terminal/sessions?includeProjects=1').catch(() => ({ sessions: [] })),
            ]);
            const meId = (state.me && (state.me.userId || state.me.email)) || '';
            const mine = ((ses || {}).sessions || []).filter((s) => s.owner === meId); // 프로젝트 세션은 전원 공개라 소유자로 좁힌다
            const accounts = (acc || {}).accounts || [];
            // 공용 계정이라는 사실은 행의 '서버 공용' 배지(+툴팁)로 충분하다 — 같은 말을 배너로 또 적지 않는다(사용자 요구).
            body.replaceChildren(...(accounts.length
                ? accounts.map((a) => aiAccountRow(a, mine, load))
                : [el('p', { class: 'admin-hint', text: '이 서버에 로그인이 필요한 AI 가 없습니다.' })]));
        }
        catch (e) {
            body.replaceChildren(errorNote(e, '내 AI 계정 상태를 불러오지 못했습니다'));
        }
    };
    void load();
    return card;
}
// ── [내 설정 ▸ 내 AI 설정] — 개인 레이어(org_member.body_md). ──
//  #846 이 배선을 완성했다: previewMemberContext 가 `## 내 개인 규칙 (나에게만 적용 — 팀 공유 아님)` 블록으로
//  **본인 세션에만** 싣는다(memberId = bearer principal — 남의 개인 규칙이 새지 않는다). 그 전엔 저장은 됐지만
//  **어떤 주입 경로도 읽지 않았다** — 그래서 개인 규칙을 올릴 데가 없어 injection='always' 지식(=전원 공유)
//  밖에 선택지가 없었다(남의 세션까지 오염). 이제 진짜로 반영되므로, 여기서 **실제 주입 전문**을 그대로 보여 준다.
//
//  필드는 4개로 줄였다(#837 · 사용자 지적: "응답길이랑 담당영역, 자주쓰는레포는 좀 불필요한거같아").
//   · 응답 길이 — 대화에서 그때그때 말하면 되는 것(고정하면 오히려 방해).
//   · 담당 영역 — 팀·카테고리 오너십(${team})이 이미 주입한다(중복).
//   · 자주 쓰는 도구·레포 — 세션이 열린 폴더·레포가 말해 준다(중복).
async function myAiSection(detail) {
    detail.replaceChildren(el('div', { class: 'card' }, skeleton('내 AI 설정을 불러오는 중')));
    let data;
    try {
        data = await api('/api/ui/me/profile');
    }
    catch (e) {
        detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '불러오지 못했습니다')));
        return;
    }
    const pr = parseMyProfile(data.body_md || '');
    const roleIn = el('input', { type: 'text', value: pr.role, placeholder: '예: 라이블리 공동대표 / 백엔드 개발 / 디자이너' });
    const addressIn = el('input', { type: 'text', value: pr.address, placeholder: '예: 상민님 / 대표님' });
    // 플레이스홀더는 **넣을 것만** 말한다 — 넣지 말 것(시크릿)은 아래 힌트로 따로 뗀다. 한 문장에 뭉쳐 놓으니
    //  '나만의 규칙·선호·맥락(도) 넣지 마세요'로 읽혔다(사용자 지적).
    const memoTa = el('textarea', { class: 'admin-ta admin-ta-prose', rows: '5',
        placeholder: '내 AI 가 알아두면 좋은 규칙·선호·맥락을 자유롭게 적어주세요.\n예: 금액은 항상 원 단위로 / 보고는 결론부터 / 화요일 오전엔 회의라 답이 늦어요' });
    memoTa.value = pr.memo;
    const devSel = { v: pr.dev };
    const devHint = el('p', { class: 'prof-hint' });
    const renderDevHint = () => { const d = PROF_DEV.find((x) => x.v === devSel.v); devHint.textContent = d ? d.hint : '항목을 고르면 AI가 그 수준에 맞춰 기술 설명의 자세한 정도를 조절해요.'; };
    const devChips = profChips(PROF_DEV, devSel, (o) => o.label, (o) => o.v, renderDevHint);
    renderDevHint();
    const toneSel = { v: pr.tone };
    const toneChips = profChips(PROF_TONE.map((t) => ({ v: t })), toneSel, (o) => o.v, (o) => o.v);
    // 사용 언어 — 프리셋 칩과 '직접 입력'이 한 값(langSel.v)을 공유한다. 칩을 고르면 입력칸을 비우고, 직접 입력하면 칩 선택이 풀린다.
    const langSel = { v: pr.lang };
    // 직접 입력 = 칩 줄의 마지막 칸. 칩과 같은 알약 모양·높이로 맞춰 한 줄에 이어 붙인다(#1085).
    const langCustom = el('input', { type: 'text', class: 'prof-chip-input', placeholder: '직접 입력 (예: Français)' });
    if (langSel.v && !PROF_LANG.includes(langSel.v))
        langCustom.value = langSel.v; // 프리셋 밖 값이면 입력칸에 복원
    const langChips = profChips(PROF_LANG.map((t) => ({ v: t })), langSel, (o) => o.v, (o) => o.v, () => { langCustom.value = ''; });
    langChips.append(langCustom); // 칩 wrap(.prof-chips) 안 — 폭이 좁아지면 자연히 다음 줄로 넘어간다
    langCustom.addEventListener('input', () => { langSel.v = langCustom.value.trim(); langChips.repaint(); });
    const saveBtn = el('button', { type: 'button', class: 'btn btn-primary', text: '저장' });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
        // 선택·입력 → canonical markdown(AI가 읽기 좋고 parseMyProfile 로 복원 가능). 빈 항목은 생략.
        const lines = [];
        if (roleIn.value.trim())
            lines.push('- 역할: ' + roleIn.value.trim());
        const d = PROF_DEV.find((x) => x.v === devSel.v);
        if (d)
            lines.push('- 개발 이해도: ' + d.label + ' — ' + d.hint);
        if (addressIn.value.trim())
            lines.push('- 호칭: ' + addressIn.value.trim());
        if (toneSel.v)
            lines.push('- 말투: ' + toneSel.v);
        if (langSel.v)
            lines.push('- 사용 언어: ' + langSel.v + ' — 되도록 이 언어로 답하고, 다른 언어는 쓰지 마세요');
        let body = lines.length ? ('## 내 프로필\n' + lines.join('\n') + '\n') : '';
        const memo = memoTa.value.trim();
        if (memo)
            body += (body ? '\n' : '') + '## 추가 메모\n' + memo + '\n';
        saveBtn.disabled = true;
        // display_name·아바타는 **안 보낸다** — 서버가 보존하므로 [내 정보]가 지워지지 않는다.
        try {
            await api('/api/ui/me/profile', { method: 'POST', body: JSON.stringify({ body_md: body }) });
            toast('저장됨 — 다음 세션부터 내 AI 가 반영합니다');
            status.textContent = '저장됨';
        }
        catch (e) {
            toast((e && e.message) || '저장하지 못했습니다', true);
        }
        saveBtn.disabled = false;
    });
    detail.replaceChildren(
    // 페이지 제목 = 이 화면 전체(계정 + 개인 규칙). 개별 박스 설명은 각 박스의 .caption 이 맡는다.
    //  (설명은 hint 한 줄만 — meaning 인자도 화면에 한 줄로 깔려서 둘 다 주면 같은 말이 두 줄로 겹친다.)
    sectionHead('내 AI 설정', '내 AI 세션이 어떤 계정으로 실행되는지, 그리고 내 AI 가 나에 대해 무엇을 알고 일할지 정합니다. 여기 설정은 나에게만 적용되고 팀에는 공유되지 않습니다.'), 
    // 두 박스는 성격이 다르다 — 붙여 놓으면 한 덩어리로 읽힌다. .admin-stack 으로 간격을 준다(관리탭 공용 규약).
    el('div', { class: 'admin-stack' }, myAiAccountsCard(), // 위 박스 = 내 AI 가 '무엇으로·누구 계정으로' 도는가(#1085)
    el('div', { class: 'card admin-form-narrow' }, 
    // 섹션 제목은 서술문('~할 것')이 아니라 **명사구**로 — 관리탭 다른 섹션(구성원·조직 정보·세션 주입)과 같은 규격.
    //  설명 한 줄은 위 [AI 계정 연결] 박스와 같은 자리(.caption)에 둔다: 박스마다 [제목 · 한 줄 설명 · 내용].
    cardHead('AI 개인 규칙', '내 역할·호칭·말투·사용 언어입니다. 내 AI 가 매 세션을 시작할 때 이 내용을 읽고 따릅니다 — 나에게만 적용되고 팀에는 공유되지 않습니다.'), 
    // 필드는 종전 그대로 — 라벨 + 입력칸 + 회색 힌트(사용자: "필드들은 ⓘ 규격 바꾸지 말고 이전 유지").
    field('역할', roleIn), field('개발 이해도', el('div', {}, devChips, devHint)), field('호칭 (AI가 나를 부르는 말)', addressIn), field('말투', toneChips), 
    // 직접 입력칸은 칩과 **같은 줄**에 칩 모양으로 붙인다(#1085) — '한국어·English·…' 다음에 오는
    //  또 하나의 선택지지, 아래 딸린 별개 입력이 아니다. 실제 배치는 profChips 가 wrap 안에 넣어 준다.
    field('사용 언어 (AI가 답하는 언어)', el('div', {}, langChips, el('p', { class: 'prof-hint', text: '고르거나 직접 적은 언어로 내 AI가 답해요. 비우면 조직 기본값(주로 한국어)을 따릅니다.' }))), field('추가 메모', el('div', {}, memoTa, el('p', { class: 'prof-hint', text: '비밀번호·API 키·개인키 같은 비밀값은 적지 마세요. 토큰으로 보이는 값이 들어 있으면 저장되지 않고 오류로 알려드립니다.' }))), el('div', { class: 'admin-actions' }, saveBtn, status))));
}
// ── [내 설정 ▸ 내 서비스 로그인] — member_secret vault + OAuth 연결 + git 인증 ──
async function myLoginsSection(detail) {
    // #762 서비스별 탭 재설계 — 헤더 + [서비스 로그인(탭)] + [레포 접근(개발자용)]. 방식(OAuth/토큰) 노출 안 함.
    // 제목은 카드에 고정하고, 탭 본문만 안쪽 host 에 그린다 — renderServiceTabs 가 replaceChildren 이라 제목이 같이 지워지면 안 된다.
    const svcHost = el('div');
    const svcCard = el('div', { class: 'card' }, cardHead('서비스 로그인', 'AI 가 나를 대신해 이 서비스를 쓰려면 내 계정을 연결해야 합니다. 연결은 나에게만 적용되고, 토큰 값은 저장 후 다시 볼 수 없습니다.'), svcHost);
    const gitCard = el('div', { class: 'card' }, cardHead('리포지토리 접근', '코드 저장소(GitHub·GitLab)에서 클론·푸시할 때 쓰는 SSH 키·토큰입니다. 코드 작업을 하지 않으면 설정하지 않아도 됩니다.', el('span', { class: 'head-badge head-badge-aud', text: '개발자용' })), el('div', { class: 'admin-actions' }, el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'git 인증 관리', onclick: () => openGitCredentialManager('me') })));
    detail.replaceChildren(sectionHead('외부 서비스 로그인', 'AI가 내 계정으로 외부 서비스를 쓸 수 있게 미리 로그인해 둡니다. 여기에서 로그인해도 나에게만 적용되고 팀에는 공유되지 않습니다.'), el('div', { class: 'admin-stack' }, svcCard, gitCard));
    await renderServiceTabs(svcHost);
}
// ── [내 설정 ▸ 내 스킬·훅] — 라이블리 배포분 opt-on/off(#699) + 내 컴퓨터별 로컬 하네스 조회·토글(#891/893). ──
//  #893: 온보딩(#/start/harness)에 있던 걸 여기로 통합 — 하네스 관리는 상시라 관리탭이 정주소(온보딩은 링크).
const HARNESS_KIND_LABEL = { skill: '스킬', subagent: '서브에이전트', command: '커맨드', hook: '훅' };
// 라이블리가 배포한 스킬·훅 본문(설명 전문 + md)을 모달로 — 로컬 것은 서버에 본문 없음(메타만).
async function showHarnessDetail(kind, id, name) {
    const box = overlay(name || id);
    const body = box.querySelector('.ov-box');
    const slot = el('div', { class: 'md-rendered admin-md-box', style: 'max-height:60vh; overflow:auto; margin-top:8px' }, el('p', { class: 'admin-hint', text: '불러오는 중…' }));
    body?.append(slot);
    try {
        const d = await api(`/api/ui/me/harness/detail?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`);
        const parts = [];
        if (d.description)
            parts.push(el('p', { style: 'color:var(--ink-sub); margin:0 0 10px', text: d.description }));
        if (d.body)
            parts.push(el('div', { class: 'md md-rendered' }, renderMarkdown(String(d.body))));
        if (!parts.length)
            parts.push(el('p', { class: 'admin-hint', text: '(본문이 없습니다)' }));
        slot.replaceChildren(...parts);
    }
    catch (e) {
        slot.replaceChildren(el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + ((e && e.message) || '') }));
    }
}
async function myAssetsSection(detail) {
    const bodyBox = el('div', {});
    detail.replaceChildren(sectionHead('내 스킬 · 훅', '내 AI가 쓰는 스킬·훅이 어느 컴퓨터에 설치됐는지 보고, 켜고 끕니다. 켜고 끈 변경은 다음 세션부터 적용됩니다.'), el('div', { class: 'card' }, cardHead('설치 상태'), bodyBox));
    const reload = async () => {
        bodyBox.replaceChildren(el('p', { class: 'admin-hint', text: '불러오는 중…' }));
        let d;
        try {
            d = await api('/api/ui/me/harness');
        }
        catch (e) {
            bodyBox.replaceChildren(el('p', { class: 'admin-hint', text: (e && e.message) || '불러오지 못했습니다' }));
            return;
        }
        // 관측된 내 컴퓨터들 + 표시 이름/하네스 호환 헬퍼 (라이블리가 준 것이 어느 PC에 깔렸는지 대조에 씀).
        const machines = d.machines || [];
        const machineName = (m) => m.alias || m.host || '내 컴퓨터';
        const compat = (ah, mh) => ah === 'all' || !mh || ah === mh; // 배포분 하네스 vs 머신 하네스
        const mIndex = machines.map((m) => {
            const map = new Map();
            for (const a of (m.assets || []))
                map.set(`${a.kind}:${a.id}`, a);
            return { m, map };
        });
        // 라이블리가 준 것 1건이 각 PC 에 어떻게 있는지 칩으로. 훅=중앙 디스패치(배선된 PC 전부 실행), 스킬=파일 설치 대조.
        const pcChips = (it, kind) => {
            let missing = false;
            if (!it.effective)
                return { row: el('span', { class: 'pc-chip muted', text: '꺼짐 · 어느 PC에도 적용 안 함' }), missing };
            if (!machines.length)
                return { row: el('span', { class: 'admin-hint', text: '아직 관측된 PC 없음' }), missing };
            const chips = [];
            for (const { m, map } of mIndex) {
                const nm = machineName(m);
                if (kind === 'hook') {
                    if (compat(it.harness || 'all', m.harness))
                        chips.push(el('span', { class: 'pc-chip', text: nm }));
                    continue;
                }
                const hit = map.get(`${it.kind}:${it.id}`);
                if (hit && hit.overlap === 'managed')
                    chips.push(el('span', { class: 'pc-chip', text: nm }));
                else if (hit && hit.overlap === 'shadow')
                    chips.push(el('span', { class: 'pc-chip warn', text: nm + ' · 로컬이 가림' }));
                else if (compat(it.harness || 'all', m.harness)) {
                    chips.push(el('span', { class: 'pc-chip warn', text: nm + ' · 미설치' }));
                    missing = true;
                }
            }
            if (!chips.length)
                return { row: el('span', { class: 'admin-hint', text: '적용되는 PC 없음' }), missing };
            return { row: el('div', { class: 'pc-chips' }, ...chips), missing };
        };
        // 항목 한 줄 — [이름 · 상태] + [용도 한 줄] + [설치된 PC 칩] | 오른쪽 [켜기/끄기].
        //  회색 줄에 본문 앞부분을 그대로 잘라 넣었더니 무슨 용도인지가 안 읽혔다(사용자 지적) → **첫 문장만**
        //  요약으로 쓰고 전문은 눌렀을 때 뜨는 팝업에 맡긴다. 종류(스킬/훅)는 이제 그룹 제목이 말하므로 뺀다.
        //  1순위 = summary(관리자가 쓴 '무슨 기능인지' 한 줄, [AI 능력 ▸ 스킬…]에서 편집).
        //  2순위 = description 첫 문장. description 은 하네스가 '언제 이 스킬을 쓸지' 판단하는 트리거 문장이라
        //   길고 기술적이다 — 그대로 깔면 무슨 기능인지 안 읽힌다(사용자 지적). 전문은 눌렀을 때 팝업에서 본다.
        const summarize = (it) => {
            const sum = String(it.summary || '').trim();
            if (sum)
                return sum;
            const t = String(it.description || it.note || '').replace(/\s+/g, ' ').trim();
            if (!t)
                return '';
            const cut = t.search(/[.。!?]\s|—|\s·\s/); // 첫 문장·첫 구획까지만
            const head = (cut > 12 ? t.slice(0, cut) : t).trim();
            return head.length > 64 ? head.slice(0, 64) + '…' : head;
        };
        // 켜기/끄기 2버튼. 조직 기본값을 따르는 중이면 '기본' 배지로 알리고, 내가 바꿔 둔 상태면 되돌릴 링크를 준다
        //  (버튼 3개는 과했다 — 사용자 지적).
        // 켬/끔 컨트롤 — 스위치가 **현재 상태**를, 옆 작은 글이 **그게 기본값인지**를 말한다.
        //  ⚠ 껐다가 다시 켜면 '내가 바꿈'이 남아 원래 상태로 안 돌아간 것처럼 보였다(사용자 지적) →
        //   **기본값과 같은 값으로 되돌리면 개인 설정을 지운다**(clear). 그래서 '되돌리기' 버튼도 필요 없다.
        const onOffSeg = (targetKind, it) => {
            const def = !!it.byDefault;
            const following = it.override === null || it.override === undefined;
            const on = following ? def : !!it.override;
            const set = async (v) => {
                try {
                    const b = { target_kind: targetKind, ref_id: it.id };
                    if (v === def)
                        b.clear = true; // 기본값과 같아짐 = 개인 설정 해제(자동)
                    else
                        b.state = v;
                    await api('/api/ui/me/asset-pref', { method: 'POST', body: JSON.stringify(b) });
                    await reload();
                }
                catch (e) {
                    toast((e && e.message) || '실패', true);
                }
            };
            const sw = el('button', { type: 'button', class: 'sw' + (on ? ' on' : ''), role: 'switch',
                'aria-checked': on ? 'true' : 'false', 'aria-label': on ? '켜짐 — 누르면 끕니다' : '꺼짐 — 누르면 켭니다' });
            sw.addEventListener('click', () => void set(!on));
            // 기본값과 같으면 '기본값', 다르면 기본이 무엇인지만 짧게 알린다(길게 쓰면 과하다는 지적).
            const note = on === def ? '기본값' : (def ? '기본값 켬' : '기본값 끔');
            return el('div', { class: 'hrow-act' }, el('div', { class: 'sw-labels' }, el('span', { class: 'sw-state' + (on ? ' on' : ''), text: on ? '켜짐' : '꺼짐' }), el('span', { class: 'sw-note', text: note })), sw);
        };
        const livelyRow = (targetKind, it, kind) => {
            const titleEl = el('span', { class: 'mini-title' }, el('span', { text: it.label || it.id }), el('span', { class: 'pill' + (it.effective ? ' pill-ok' : ''), text: it.effective ? '적용 중' : '미적용' }));
            const { row: chipRow, missing } = pcChips(it, kind);
            const sum = summarize(it);
            const left = el('div', { class: 'harness-click', style: 'flex:1; min-width:0;', title: '눌러서 내용 보기' }, titleEl, el('div', { class: 'mini-meta', text: sum || '눌러서 내용 보기' }), el('div', { style: 'margin-top:6px' }, chipRow));
            left.addEventListener('click', () => showHarnessDetail(kind, it.id, it.label || it.id));
            return { node: el('div', { class: 'mini-row hrow' }, left, onOffSeg(targetKind, it)), missing };
        };
        // 접이식 그룹 — 목록이 길어 한 화면에 안 들어오던 걸, 제목·개수만 먼저 보이고 눌러서 펼치게(사용자 요구).
        // 그룹 — 통째로 감추면 뭐가 있는지 모른다(사용자 요구: 프로젝트 탭 '연결된 지식'처럼 몇 개는 보이고
        //  나머지는 [더 보기]). 앞 PEEK 개는 항상 보이고, 넘치는 만큼만 접어 둔다.
        const PEEK = 3;
        const group = (title, count, items) => {
            const head = el('div', { class: 'hgroup-head-row' }, el('span', { class: 'hgroup-title', text: title }), el('span', { class: 'hgroup-count', text: String(count) }));
            const shown = items.slice(0, PEEK);
            const rest = items.slice(PEEK);
            const restBox = el('div', { class: 'hgroup-rest' }, ...rest);
            restBox.style.display = 'none';
            const kids = [head, el('div', { class: 'hgroup-body' }, ...shown, restBox)];
            if (rest.length) {
                const lbl = el('span', { class: 'lbl', text: '더 보기 ' + rest.length + '개' });
                const caret = el('span', { class: 'caret', text: '⌄' });
                const btn = el('button', { type: 'button', class: 'proj-detail-body-expand' }, lbl, caret);
                btn.addEventListener('click', () => {
                    const open = restBox.style.display === 'none';
                    restBox.style.display = open ? 'block' : 'none';
                    lbl.textContent = open ? '접기' : '더 보기 ' + rest.length + '개';
                    caret.textContent = open ? '⌃' : '⌄';
                });
                kids.push(el('div', { class: 'hgroup-more' }, btn));
            }
            return el('div', { class: 'hgroup' }, ...kids);
        };
        // 위계는 두 층이다: **위 = 어디서 온 것인가**(조직 배포 / 내 컴퓨터), **아래 = 종류**(스킬 · 커스텀 훅).
        //  전에는 h4/h5 크기 차이만으로 눌러 담아 두 층이 안 읽혔다(사용자 지적) → 층마다 자기 머리를 갖게 한다.
        const rows = [];
        const lskills = d.lively?.skills || [];
        const lhooks = d.lively?.hooks || [];
        let anyMissing = false;
        const skillNodes = lskills.map((sk) => { const r = livelyRow('harness_asset', sk, sk.kind || 'skill'); anyMissing = anyMissing || r.missing; return r.node; });
        const hookNodes = lhooks.map((h) => livelyRow('org_hook', h, 'hook').node);
        rows.push(el('div', { class: 'hlayer' }, el('div', { class: 'hlayer-head' }, el('h4', { class: 'hlayer-title', text: '라이블리 스킬 · 훅' }), infoPop('라이블리가 팀 전체에 배포한 스킬·훅입니다. 내 세션에 적용할지 여기서 켜고 끌 수 있고, 끄면 나에게만 적용되지 않습니다.')), group('스킬', skillNodes.length, skillNodes.length ? skillNodes : [el('p', { class: 'admin-hint', text: '배포된 스킬이 없습니다.' })]), group('커스텀 훅', hookNodes.length, hookNodes.length ? hookNodes : [el('p', { class: 'admin-hint', text: '배포된 커스텀 훅이 없습니다.' })])));
        if (anyMissing)
            rows.unshift(el('div', { class: 'sync-warn' }, el('b', { text: '켜져 있지만 아직 설치되지 않은 PC(‘미설치’ 표시)가 있습니다. ' }), '그 PC에서 claude(또는 codex) 세션을 한 번 열면 자동으로 설치됩니다.'));
        // ── 내 컴퓨터별: 내가 직접 만든 로컬 스킬·훅만 (라이블리가 준 건 위에서 PC 칩으로 봤어요). ──
        if (machines.length) {
            const myLayer = el('div', { class: 'hlayer' }, el('div', { class: 'hlayer-head' }, el('h4', { class: 'hlayer-title', text: '내 로컬 스킬 · 훅' }), infoPop('내가 각 컴퓨터에 직접 만들어 둔 스킬·훅입니다(라이블리 배포분은 위 목록에서 PC 칩으로 확인합니다). 컴퓨터마다 따로 보입니다.')));
            rows.push(myLayer);
            for (const m of machines) {
                const nm = machineName(m);
                const head = el('div', { style: 'display:flex; align-items:center; gap:8px; margin:14px 0 6px; flex-wrap:wrap' }, el('h5', { style: 'margin:0; font-size:14px', text: nm }));
                const editName = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '✎ 이름' });
                editName.addEventListener('click', async () => {
                    const v = prompt(`이 컴퓨터의 별명 (비우면 해제). 관측된 호스트명: ${m.host || '?'}`, m.alias || '');
                    if (v === null)
                        return;
                    try {
                        await api('/api/ui/me/harness/machine-alias', { method: 'POST', body: JSON.stringify({ machine_id: m.machine_id, alias: v }) });
                        toast('이름을 바꿨습니다');
                        await reload();
                    }
                    catch (e) {
                        toast((e && e.message) || '실패', true);
                    }
                });
                head.append(editName);
                if (m.alias && m.host)
                    head.append(el('span', { class: 'mini-meta', text: '· ' + m.host }));
                if (m.at)
                    head.append(el('span', { class: 'mini-meta', text: '· ' + new Date(m.at).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) + ' 마지막 확인' }));
                const del = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', style: 'margin-left:auto', text: '이 컴퓨터 지우기' });
                del.addEventListener('click', async () => {
                    if (!confirm(`'${nm}' 의 하네스 관측을 목록에서 지울까요? (그 컴퓨터에서 다시 세션을 열면 자동으로 다시 나타납니다.)`))
                        return;
                    try {
                        await api('/api/ui/me/harness/machine-remove', { method: 'POST', body: JSON.stringify({ machine_id: m.machine_id }) });
                        toast('지웠습니다');
                        await reload();
                    }
                    catch (e) {
                        toast((e && e.message) || '실패', true);
                    }
                });
                head.append(del);
                myLayer.append(head);
                const own = (m.assets || []).filter((a) => a.overlap === 'local-only');
                if (!own.length) {
                    myLayer.append(el('p', { class: 'admin-hint', text: '이 컴퓨터에 직접 만든 스킬·훅은 없습니다(라이블리 배포분만 있습니다).' }));
                    continue;
                }
                const byKind = {};
                for (const a of own) {
                    const isHook = a.kind === 'hook'; // 훅은 settings.json 항목(파일 아님) — 비파괴 토글 불가라 여기선 표시만.
                    // 종류(스킬/훅)는 이제 그룹 제목이 말한다 — 줄마다 다시 붙이지 않는다.
                    const meta = isHook ? 'settings.json 에 직접 추가한 훅 — 여기서는 켜고 끌 수 없습니다.' : ('내가 이 컴퓨터에서 만든 것' + (a.disabled ? ' · 꺼둠' : ''));
                    let tb = null;
                    if (!isHook) {
                        tb = el('button', { type: 'button', class: 'btn btn-sm btn-ghost', style: 'flex-shrink:0', text: a.disabled ? '켜기' : '끄기' });
                        tb.addEventListener('click', async () => {
                            try {
                                await api('/api/ui/me/harness-local-pref', { method: 'POST', body: JSON.stringify({ machine_id: m.machine_id, kind: a.kind, id: a.id, disabled: !a.disabled }) });
                                toast(a.disabled ? '켬 — 다음 세션부터 적용됩니다' : '끔 — 다음 세션부터 적용됩니다');
                                await reload();
                            }
                            catch (e) {
                                toast((e && e.message) || '실패', true);
                            }
                        });
                    }
                    (byKind[a.kind] ||= []).push(el('div', { class: 'mini-row hrow' }, el('div', { style: 'flex:1; min-width:0;' }, el('span', { class: 'mini-title', text: a.id }), el('div', { class: 'mini-meta', text: meta })), el('div', { class: 'hrow-act' }, tb)));
                }
                for (const [k, list] of Object.entries(byKind))
                    myLayer.append(group(HARNESS_KIND_LABEL[k] || k, list.length, list));
            }
        }
        else {
            rows.push(el('div', { class: 'hlayer' }, el('div', { class: 'hlayer-head' }, el('h4', { class: 'hlayer-title', text: '내 로컬 스킬 · 훅' })), el('p', { class: 'admin-hint', text: '아직 내 컴퓨터의 하네스를 확인하지 못했습니다. 내 컴퓨터에서 claude(또는 codex)를 한 번 켜면 다음 세션에 자동으로 나타납니다. 컴퓨터가 여러 대면 각각 따로 보입니다. (웹 [AI 세션]은 회사 서버에서 돌아 로컬이 보이지 않습니다.)' })));
        }
        bodyBox.replaceChildren(...rows);
    };
    await reload();
}
// 라이블리 확인 다이얼로그 — 브라우저 confirm() 대체(#1062). 파괴적 동작(종료·삭제) 확인은 전부 이걸 쓴다.
//  왜: 브라우저 기본 confirm 은 디자인시스템 밖이고(OS 팝업), 줄바꿈·강조·위험도 표현이 안 되며,
//   포커스가 확인 버튼에 잡혀 엔터 연타로 실수하기 쉽다. 여기선 기본 포커스를 '취소'에 둔다.
//  반환: Promise<boolean> — 확인=true, 취소·Esc·바깥클릭=false. 호출부는 `if (!await confirmDialog(...)) return;`.
function confirmDialog(opts) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (done)
            return; done = true; back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
        const body = el('div', { class: 'ov-confirm-body' });
        if (opts.message)
            body.append(el('p', { class: 'ov-confirm-msg', text: opts.message }));
        for (const l of opts.lines || [])
            body.append(el('p', { class: 'ov-confirm-line', text: l }));
        if (opts.note)
            body.append(el('p', { class: 'ov-confirm-note', text: opts.note }));
        const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: opts.cancelText || '취소', onclick: () => finish(false) });
        const ok = el('button', { class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'), type: 'button', text: opts.confirmText || '확인', onclick: () => finish(true) });
        const box = el('div', { class: 'ov-box ov-confirm' + (opts.danger ? ' danger' : '') }, el('div', { class: 'ov-head' }, el('h3', { text: opts.title })), body, el('div', { class: 'ov-confirm-acts' }, cancel, ok));
        const back = el('div', { class: 'ov-back ov-confirm-back' }, box);
        back.addEventListener('click', (e) => { if (e.target === back)
            finish(false); });
        const onKey = (ev) => {
            if (ev.key === 'Escape')
                finish(false);
            // 엔터는 '포커스된 버튼'을 누른다 — 기본 포커스가 취소라, 무심코 엔터를 쳐도 파괴적 동작이 안 일어난다.
            if (ev.key === 'Enter' && document.activeElement === ok)
                finish(true);
        };
        document.addEventListener('keydown', onKey);
        document.body.append(back);
        cancel.focus();
    });
}
function overlay(title, ...content) {
    const close = el('button', { class: 'btn btn-ghost btn-sm', text: '닫기' });
    const box = el('div', { class: 'ov-box' }, el('div', { class: 'ov-head' }, el('h3', { text: title }), close), ...content);
    const back = el('div', { class: 'ov-back' }, box);
    close.addEventListener('click', () => back.remove());
    back.addEventListener('click', (e) => { if (e.target === back)
        back.remove(); });
    document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') {
        back.remove();
        document.removeEventListener('keydown', esc);
    } });
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
export { changePasswordModal, copyButton, deployCommands, field, hasScope, installCmd, loadAdmin, overlay, confirmDialog, renderSystem, };
