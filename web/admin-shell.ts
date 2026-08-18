// admin-shell.ts — 관리탭 셸 (#1313 R40, admin.ts 에서 verbatim 분리). admin.ts 는 이제 재수출 배럴이다.
//  셸이 소유하는 것은 **정보구조와 판정**뿐이다 — 그룹·섹션 표(ADMIN_GROUPS·ADMIN_SECTIONS), 옛 URL 리맵
//  (SECTION_REMAP·SECTION_EXIT), 권한 표(ADMIN_ONLY·RUNTIME_ONLY·MIXED_SECTIONS)와 그 판정 함수, 그리고
//  사이드바를 그리고 선택된 섹션 자리를 레지스트리에 넘기는 renderAdmin.
//  ⚠ 셸은 '무엇을 그릴지'를 **if-체인이 아니라 표(registerPanel)로** 안다(#1313 R37 이 세운 기반). 그래서
//   패널을 다른 파일로 떼어내도 패널이 셸을 역호출하지 않고, 셸은 패널의 내부를 모른다 — 이 파일의 아래쪽
//   등록 블록이 그 유일한 접점이다. 새 패널을 붙일 땐 여기 한 줄만 늘린다.
//  병합 섹션 껍데기(membersSection·toolsSection…)도 셸이 갖는다 — 그건 패널이 아니라 **화면 구성**이기 때문이다
//   (#837: 합치는 건 화면이지 데이터가 아니다 — 새 진실 출처 0).
import { applyReveal, cardHead, el, errorNote, hasScope, keepSideScroll, state, toast } from './core.js';
import { skeleton } from './ui-primitives.js';
import { visibilityAxesPanel } from './visibility-axes.js';
import { loadAdmin, registerPanel, rerenderPanel } from './admin-rerender.js';         // 패널 재렌더 레지스트리(셸↔패널 순환 절단)
import { sectionHead, segTabs } from './admin-widgets.js';
import { dbAuditEditor, orgAuditPanel, toolUsagePanel } from './admin-audit.js';
import { cronPanel, managedSessionsPanel } from './admin-automation.js';
import { previewEnvsPanel } from './admin-preview.js';
import { credentialsEditor } from './admin-credentials.js';
import { openMyProfileModal } from './me-profile.js';
import { myAiSection } from './me-ai.js';
import { myLoginsSection } from './me-logins.js';
import { myAssetsSection } from './me-assets.js';
import { memberForm, membersEditor, profileEditor, profilesEditor, teamsPanel, tokensPanel } from './admin-members.js';
import { reposPanel } from './admin-repos.js';
import { myNodesPanel, orgNodesPanel } from './admin-nodes.js';
import { injectionMap } from './admin-injection.js';
import { storageEditor } from './admin-storage.js';
import { logsEditor, sessionShareEditor, sessionsAdminEditor } from './admin-ops.js';
import { uiModeSection } from './admin-ui-mode.js'; // #1719 관리탭 ▸ 화면(새 셸/클래식)
import { embeddingsEditor } from './admin-embeddings.js';
import { loginIdpEditor } from './admin-login-idp.js'; // #1520 회사 계정(OIDC) 로그인 설정
// ── #1313 R40 분해 ④ — 도메인 패널 B. 셸은 아래 등록 블록에서만 이들을 부른다. ──
import { mcpEditor } from './admin-mcp-servers.js';
import { feedTargetsEditor, projectOutboundEditor } from './admin-outbound.js';
import { dbSourceEditor } from './admin-db-sources.js';
import { customHookEditor, harnessAssetEditor } from './admin-hooks-assets.js';
import { builtinToggles, toolsEditor } from './admin-tools.js';

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
// `src/org/delivery/meaning.ts` 전체 '자산' 0건) **그 카드를 띄우는 [ⓘ] 버튼 바로 위** 섹션 힌트가 '에이전트 자산'
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
  // #1226 — '로그인'이 아니라 '관리'다. 이 화면이 하는 일이 로그인 하나가 아니게 됐다:
  //  연결·해제에 더해 **연결한 뒤 무엇까지 허용할지**(슬랙 채널별 열람/발송)를 여기서 고른다.
  { key: 'me-logins', label: '외부 서비스 관리', meaning: null, group: 'me' },
  { key: 'me-assets', label: '내 스킬 · 훅', meaning: null, group: 'me' },
  // 내 컴퓨터(노드) — 내가 연결한 컴퓨터를 내가 관리한다. **전 구성원**이 하는 일이라 '내 설정'에 둔다
  //  (조직 전체 목록과 공유 지정은 [운영·감사 ▸ 컴퓨터(노드)] 로 갈랐다 — 개인 행위와 조직 정책은 축이 다르다).
  { key: 'me-nodes', label: '내 컴퓨터', meaning: null, group: 'me' },
  // ── 조직 ──
  { key: 'profile', label: '조직 정보', meaning: 'gateway-url', group: 'org' },
  // 화면(#1719) — 새 1탭 셸 / 클래식 선택. 조직 기본은 관리자, '이 브라우저에서만'은 누구나 → ADMIN_ONLY 에 넣지 않는다.
  { key: 'ui', label: '화면', meaning: null, group: 'org' },
  // 구성원 — 구 [구성원 관리]+[구성원 추가]+[구성원 토큰 관리]+[중앙박스 계정] 4개 탭을 한 화면(서브탭)으로.
  //  넷 다 "한 사람에 대해 뭘 설정하나"였다. 갈라져 있던 탓에 '구성원 추가' 저장이 location.hash 로 토큰 탭에
  //  점프하고 state.admin.memberAddPreselect 로 선택을 실어 나르는 해킹이 필요했다(#837 에서 제거).
  // 구성원 명부와 팀은 '누가 있고 어떻게 묶이나' 한 주제라 한 항목 안 가로탭으로 합친다(#1085 요구).
  { key: 'members', label: '구성원 · 팀', meaning: 'member', group: 'org' },
  // 사람 관리의 '들이기'와 '권한 주기'를 [구성원](명부)에서 떼어 별도 화면으로(#1085 요구).
  //  둘 다 관리자 전용 — ADMIN_ONLY 에 넣어 비관리자에겐 숨고, 관리자에겐 '관리자' 배지가 붙는다.
  { key: 'member-add', label: '구성원 추가', meaning: null, group: 'org' },
  { key: 'member-access', label: '구성원 권한 관리', meaning: null, group: 'org' },
  // 회사 계정 로그인(#1520) — '누가 어떻게 들어오나'라서 구성원 옆에 둔다. 시크릿을 다루므로 ADMIN_ONLY.
  { key: 'login-idp', label: '로그인 · 회사 계정', meaning: null, group: 'org' },
  // ── AI 맥락 ──
  //  ⚠ 이 그룹은 **비었다**(#1618). 세 화면(세션 주입·의미 검색·맥락 공개범위)이 전부 [맥락 관리 ▸ 전달]로
  //   갔다. #1419 가 파이프라인 4단계를 이 탭에서 [맥락 관리]로 옮길 때 이 셋만 남겨 뒀는데, 그래서
  //   **맥락 화면이 두 탭에 갈렸다** — 자료를 지식으로 만드는 구간은 저쪽, 그 지식이 AI 에 닿는 구간은 이쪽.
  //   #1419 가 세운 판단("파이프라인 단계에 속한 설정이 [설정] 탭에도 남아 있으면 입구가 둘이 되고, 그
  //   단계를 보면서 앞뒤를 못 본다")은 이 셋에도 그대로 적용된다. 옛 URL 은 SECTION_EXIT 가 넘긴다.
  //   그룹 키('context')는 남겨 둔다 — 지우면 그룹 표를 읽는 자리마다 분기가 생기고, 나중에 이 축에
  //   맞는 화면이 새로 생겼을 때 되살릴 자리가 없어진다. 항목이 0이면 사이드바에 그려지지 않는다.
  //  (항상-주입 섹션 문서(injection=always)의 추가/편집/삭제/재정렬은 그대로 injectionMap 이 한다 — #335.
  //   화면이 옮겨 갔을 뿐 패널·저장 경로는 그대로다. 합치는 건 화면이지 데이터가 아니다.)
  // 맥락 공개범위(#1291)도 여기서 **뺐다**(#1618) — [맥락 관리 ▸ 전달 ▸ 공개범위]로.
  //  '자료' 축은 이미 #1419 에서 [수집]으로 갔는데(생산 지점) 축 토글만 여기 남아 한 기능이 두 탭에 갈려
  //  있었다. 유형별로 이 기능을 쓸지 말지 정하는 자리라, 맥락이 누구에게 닿는지를 다루는 '전달'이 제자리다.
  // 자료 공개범위(#1291 v4)는 여기서 **뺐다**(#1419) — [맥락 관리 ▸ 수집 ▸ 자료 공개범위]로 옮겼다.
  //  이 정책은 match_system(+채널)으로 매칭해 **자료가 태어날 때**(mirror INSERT) 공개범위를 새긴다 —
  //  생산 지점이 곧 수집이라, 수집기 옆이 제자리다. 편집은 admin 유지(누가 볼 수 있는지를 정하는 보안 경계).
  // #1153 — 카테고리(분류축) CRUD 는 [분류체계] 탭(#/categories)으로 이관됐다. #837 은 정의·범위의 주인을
  //  관리탭으로 일원화했었지만, 분류체계 정립·재정립은 조직 '설정'이 아니라 상시 업무라 탭이 제 자리다.
  //  구 딥링크(#/system/wiki-categories)는 SECTION_EXIT 가 그 탭으로 보낸다.
  // 지식 검토 게이트(#638)도 여기서 **뺐다**(#1419) — [맥락 관리 ▸ 증류 ▸ 지식 검토 정책]으로.
  //  증류가 만든 지식이 통과하는 밸브라 생산 라인 바로 뒤가 제자리다. 대기열은 이미 WIKI 탭에 있다(#837).
  //  조회는 전 구성원(내 지식이 왜 대기에 걸렸는지 알 수 있게), 편집은 admin 유지 — 이 밸브를 누구나
  //  '전역 auto 통과'로 열 수 있으면 게이트 자산이 무력화되고, 파괴 반경이 조직 단위다(증류기와 다른 점).
  // 자료 증류기(#1289)는 여기서 **뺐다**(#1419) — [맥락 관리 ▸ 증류]가 같은 화면(distillersPanel)을 그린다.
  //  입구가 둘이면 둘 중 어느 쪽이 정본인지 아무도 모르고, 한쪽만 고치는 사고가 난다. 파이프라인 순서
  //  (수집→증류→분류→관리) 안에 있어야 '앞뒤로 무엇이 있는지'가 함께 보이므로 그쪽을 남겼다.
  //  옛 URL(#/system/distillers)은 아래 SECTION_EXIT 가 그 자리로 넘긴다 — 북마크가 끊기지 않게.
  // 벡터 검색(#172)도 여기서 **뺐다**(#1618) — [맥락 관리 ▸ 전달 ▸ 의미 검색]으로.
  //  AI 가 지식을 '뜻으로' 찾는 능력이라 맥락 그룹인 건 맞았지만, 그 능력이 켜졌는지는 파이프라인을 보며
  //  판단할 일이다: provider 기본값이 off 라 새 조직은 꺼진 채 출발하고, knowledge_search 는 그때
  //  실패하지 않고 조용히 단어 일치로 폴백한다(사용자에겐 "검색이 좀 안 맞네"로만 보인다).
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
  // 구 [외부 자료 수집(레거시)] 화면은 **삭제했다**(#1419). 중복이 아니라 **효과가 없는 화면**이었다:
  //  org_connector 를 편집하지만, 마이그레이션 후 실제 수집은 전부 수집기 바인딩으로 돌고 레거시
  //  sync-<system> 크론은 꺼진다 — 즉 살아 있어 보이는데 아무 일도 하지 않는다(중복보다 나쁘다).
  //  ⚠ 테이블(org_connector)과 REST/MCP(org_connector_*)는 **남긴다** — 구 코드 롤백 시의 해소 폴백원이다.
  //  지운 것은 화면뿐이고, 옛 URL 은 SECTION_EXIT 가 [맥락 관리 ▸ 수집]으로 넘긴다.
  // 수집 방식(#1419 T7)도 [맥락 관리 ▸ 수집 ▸ 수집 방식]으로 옮겼다. 수집기와 다른 객체(틀 vs 인스턴스)라
  //  중복은 아니었지만, 수집기 화면이 이 자리를 가리키는데 다른 탭이면 정의하러 나갔다 돌아와야 했다.
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
  // 컴퓨터(노드) — 조직에 연결된 컴퓨터 **전체**와 공유 지정(#1540). 개인이 자기 컴퓨터를 관리하는 화면은
  //  [내 설정 ▸ 내 컴퓨터]로 갈랐다: 여기는 "누가 누구 컴퓨터에서 코드를 돌리나"를 정하는 조직 정책이고,
  //  구성원 개인 컴퓨터 목록이 그대로 보이므로 ADMIN_ONLY 다.
  { key: 'nodes', label: '컴퓨터(노드)', meaning: null, group: 'ops' },
];
// 구 URL → 새 섹션. 북마크·내부 링크·문서 링크를 깨지 않는다(#837 병합 + 과거 흡수분).
const SECTION_REMAP = {
  // #837 병합 — ⚠ 'member-add' 는 #1085 에서 **다시 독립 섹션**이 됐으므로 여기서 뺀다(리맵이 남아 있으면
  //  새 섹션이 영영 [구성원]으로 튕긴다). 구 URL 'tokens'·'profiles' 는 이제 [구성원 권한 관리]로 보낸다.
  'tokens': 'member-access', 'profiles': 'member-access', 'teams': 'members',
  'mcp': 'tools',
  'custom-hooks': 'agent-assets', 'harness-assets': 'agent-assets',
  'cron': 'automation', 'managed-sessions': 'automation',
  'tool-usage': 'audit', 'org-audit': 'audit', 'db-audit': 'audit',
  // 과거 흡수분(2026-06-26)
  'hooks-group': 'injection-map', 'hooks-preview': 'injection-map', 'runtime': 'injection-map',
  'safety': 'tools', 'org-defaults': 'injection-map', 'context-ontology-guide': 'injection-map',
};
// 구 [검토 큐]는 관리탭을 떠나 WIKI 탭으로 갔다(#837) — 섹션 리맵이 아니라 탭 밖 리다이렉트라 따로 둔다.
//  #1153 에서 [카테고리(분류 체계)]도 관리탭을 떠나 [분류체계] 탭이 됐다 — 같은 이유로 여기 둔다.
const SECTION_EXIT = { 'review-queue': '#/knowledge/review', 'wiki-categories': '#/categories',
  // #1419 — 파이프라인 단계에 속한 설정을 [맥락 관리]로 모았다. 관리탭에 남겨 두면 입구가 둘이 되고,
  //  그 단계를 보면서 앞뒤를 못 본다. 옛 딥링크·북마크는 여기서 새 자리로 넘긴다(끊지 않는다).
  //  #1584 — 그 단계의 **어느 화면**인지까지 주소가 말한다(단계 안 하위 탭이 좌측 사이드바 항목이 되면서
  //  화면마다 주소가 생겼다). 종전엔 단계까지만 보내 놓고 첫 화면에 떨어뜨렸다.
  'distillers': '#/context/distill/distillers',
  'ingest-policy': '#/context/distill/ingest-policy',
  'connectors': '#/context/collect/collectors',
  'collector-presets': '#/context/collect/presets',
  'source-vis-policy': '#/context/collect/source-vis',
  // #1618 — 구 [설정 ▸ AI 맥락] 3화면이 [맥락 관리 ▸ 전달]로. 같은 이유(입구 이중화 + 앞뒤를 못 봄)에
  //  같은 처방이다. injection-map 은 온보딩·가이드 문서가 '#/system' 으로 보내던 자리라 특히 중요하다.
  'injection-map': '#/context/deliver/injection',
  'embeddings': '#/context/deliver/embeddings',
  'visibility-axes': '#/context/deliver/visibility' };
// admin 권한 전용(쓰기·인프라·감사). #318 호출통계·#549 변경감사는 전 구성원의 변경·before/after 를 노출하므로 admin.
// (증류기는 #1419 에서 [맥락 관리 ▸ 증류]로 이관 — 여기 목록에 없다. 서버 scope 도 memory(워킹레벨)라
//  애초에 관리자 전용이 아니었다: 팀이 자기 채널의 증류 기준을 직접 조절하는 게 그 기능의 취지다.)
const ADMIN_ONLY = ['member-add', 'member-access', 'login-idp', 'credentials', 'feed-targets', 'project-outbound', 'db-sources', 'storage', 'logs', 'sessions', 'embeddings', 'automation', 'audit', 'session-share', 'visibility-axes',
  // 'nodes' = 조직 전체 컴퓨터 + 공유 지정. 구성원 개인 컴퓨터가 그대로 보이고, 공유 지정은 남의 기계를
  //  전체에 여는 결정이라 관리자 전용. (개인용 [내 설정 ▸ 내 컴퓨터]='me-nodes' 는 여기 넣지 않는다.)
  'nodes'];
const RUNTIME_ONLY = ['agent-assets']; // runtime 권한 전용(멤버 머신에서 도는 것의 정의)
// [도구]는 두 권한의 합집합 — 사내 API 도구·빌트인은 runtime, 외부 MCP 서버 등록은 admin. 둘 중 하나라도 있으면
//  섹션을 보여주고, 안에서 각 서브탭을 권한별로 켠다(구조상 한 섹션=한 scope 전제가 깨지는 유일한 자리라 명시한다).
//  [미리보기]도 합집합 — **쓰는 사람은 작업자(code)** 다. 관리자 전용으로 잠그면 정작 화면을 확인해야 할
//   사람이 못 쓴다(실측: 활성 구성원 대다수는 items·context 뿐이고 code 는 개발 구성원에게 부여된다).
//   단 '어떻게 띄울지'(스택 프로필)는 셸 명령을 담으므로 정의는 admin 만 — 사용은 code, 정의는 admin 으로 가른다.
const MIXED_SECTIONS = { tools: ['admin', 'runtime'], 'preview-envs': ['code', 'admin'] };

// 사이드바 권한 배지 — '권한 없으면 목록에 아예 안 보이는' 항목에 붙인다(숨김 규칙 sectionHidden 과 같은 표에서 파생).
//  ⚠ 문구는 **'관리자' 하나로 통일**한다(#1085 사용자 지정) — runtime·code 같은 내부 scope 이름을 배지에 노출하면
//   보는 사람에겐 무슨 말인지 모를 뿐이고, 실제로 그 항목들을 열 수 있는 사람은 관리 권한을 받은 사람이다.
function navPermBadge(key) {
  const gated = ADMIN_ONLY.includes(key) || RUNTIME_ONLY.includes(key) || !!MIXED_SECTIONS[key];
  if (!gated) return null;
  return el('span', { class: 'admin-only-badge', text: '관리자', title: '권한이 있어야 보고 편집할 수 있는 항목입니다.' });
}
// 심플 어드민(#1454 S4) — ui_profile='personal'(노션식 개인 워크스페이스) 때 숨기는 조직 운영 섹션.
//  기준: 조직 규모의 배포·정책·인프라 관측 화면은 접고, 개인이 실제로 쓰는 것(내 설정·구성원·DB 데이터소스·
//  레포·자동화 — 대표 지시로 명시 유지)만 남긴다. 기본 'full' 이면 이 목록은 아예 평가되지 않는 것과 같다
//  (uiProfilePersonal=false) — 셀프호스트 무회귀. 숨김은 sectionHidden 한 곳이라 사이드바·기본선택·딥링크
//  폴백(renderAdmin 의 visibleSections·첫 노출 섹션 선택)이 전부 일관되게 따라온다.
const PERSONAL_HIDDEN = [
  // [로그인 · 회사 계정](#1520 IdP/OIDC) — 개인 워크스페이스에서 **숨기는 게 아니라 막는 것에 가깝다**.
  //  매니지드 배포에서 이 워크스페이스로 들어오는 길은 컨트롤플레인 계정 + SSO 브리지 하나뿐이고,
  //  구성원은 초대로만 늘어난다(운영자가 인원을 통제한다). 워크스페이스가 자기 IdP 를 따로 붙이면
  //  **두 번째 신원 축**이 생기고, 그 화면의 도메인 allowlist 자동 가입을 켜는 순간 그 도메인 사람이
  //  초대 없이 구성원이 된다 = 초대제 우회. 그래서 개인 프로필에서는 입구 자체를 두지 않는다.
  'login-idp',         // 로그인 · 회사 계정(조직 IdP)
  'injection-map',     // 세션 주입
  'visibility-axes',   // 맥락 공개범위
  'embeddings',        // 의미 검색
  'tools',             // AI 도구
  'credentials',       // 서비스 로그인(조직 금고)
  'agent-assets',      // 스킬 · 훅(조직 배포)
  'preview-envs',      // 미리보기
  'session-share',     // 세션 공유
  'feed-targets',      // 위키 아웃바운드(피드)
  'project-outbound',  // 프로젝트 아웃바운드
  'audit',             // 감사 로그
  'storage',           // 컴퓨팅 리소스
  'logs',              // 로그
  'sessions',          // 세션(회수)
];
// ui_profile 판정 — me 응답(#1454 S2~S5 동승) 한 곳만 본다. 값을 못 받았으면(구 서버) 'full'(현행) 취급.
const uiProfilePersonal = () => !!(state.me && state.me.ui_profile === 'personal');
function sectionHidden(key, data) {
  if (uiProfilePersonal() && PERSONAL_HIDDEN.includes(key)) return true; // #1454 S4 — 심플 어드민
  if (ADMIN_ONLY.includes(key) && !data.canEdit) return true;
  if (RUNTIME_ONLY.includes(key) && !data.canRuntime) return true;
  // 합집합 섹션([도구]) — 요구 권한 중 하나라도 있으면 노출(안에서 서브탭별로 다시 건다).
  const any = MIXED_SECTIONS[key];
  if (any && !any.some((s) => (s === 'admin' ? data.canEdit : s === 'runtime' ? data.canRuntime : hasScope(s)))) return true;
  return false;
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
  let data: any;
  try { data = await loadAdmin(); }
  catch (e) { view.replaceChildren(errorNote(e, '관리 데이터를 불러오지 못했습니다')); return; }
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
  if (sel && SECTION_EXIT[sel]) { location.replace(SECTION_EXIT[sel]); return; }
  if (sel && SECTION_REMAP[sel]) sel = SECTION_REMAP[sel]; // 병합·흡수된 구 섹션 URL → 새 섹션
  if (!sel || !visibleSections.some((s) => s.key === sel)) sel = (visibleSections[0] || ADMIN_SECTIONS[0]).key;
  state.admin.sel = sel;

  // ── 2단 사이드바(그룹 ▸ 섹션) — 사용 가이드(#/learn)의 docs-side 시각 언어 재사용(#827). ──
  //  위계 2단을 사이드바 하나가 전담한다: 그룹명은 소제목, 섹션은 그 아래 항목. 전 그룹이 항상 펼쳐져 있어
  //  '어디에 뭐가 있는지'가 한눈에 보인다. 권한으로 섹션이 0개인 그룹은 통째로 숨는다.
  const side = el('nav', { class: 'docs-side admin-side', 'aria-label': '관리 섹션' });
  // 섹션을 고르면 이 화면 전체를 다시 그리므로 사이드바도 새 노드가 된다 → 자체 스크롤이 0 으로 돌아갔다
  //  (실측 #1635: 300→0). 항목이 20개 넘어 늘 스크롤돼 있는 사이드바라 '방금 누른 자리'를 잃었다.
  keepSideScroll(side, 'admin');
  for (const g of ADMIN_GROUPS) {
    const items = visibleSections.filter((s) => s.group === g.key);
    if (!items.length) continue;
    const box = el('div', { class: 'docs-side-group' },
      el('div', { class: 'docs-side-title', text: g.label }));
    for (const s of items) {
      // 라벨 + 배지. 관리자 전용 섹션(ADMIN_ONLY — 비관리자에겐 sectionHidden 으로 아예 숨는 것)엔 '관리자' 배지를
      //  달아, 관리자가 볼 때 "이건 관리자만 보고 편집한다"가 드러나게 한다(#1010 — #613 회색 부제 폐지 자리에 권한 신호).
      //  '지식 검토 정책'(#802 계승)은 추가로 검토 대기 건수 배지(0건이면 안 그린다) — 큐 자체는 WIKI 로 갔지만(#837),
      //  게이트를 켠 관리자가 "내 밸브에 N건이 밀려 있다"를 여기서 보게 둔다.
      box.append(el('a', { class: 'docs-item' + (s.key === sel ? ' active' : ''), href: '#/system/' + s.key,
        'aria-current': s.key === sel ? 'page' : null },
        el('span', { text: s.label }),
        // 배지 = **이 항목을 보려면 필요한 권한**. 전엔 ADMIN_ONLY 에만 달려서, 같은 '권한 없으면 아예 안 보이는'
        //  항목인데도 [스킬 · 훅](runtime 전용)·[AI 도구]·[미리보기](합집합)엔 아무 신호가 없었다(#1085 지적).
        navPermBadge(s.key),
        // (검토 대기 배지는 [지식 검토 정책]이 이 탭에 있을 때 달던 것 — 그 화면이 [맥락 관리 ▸ 증류]로
        //  옮겨갔고, 대기 건수는 WIKI 탭 사이드바가 이미 같은 배지로 보여준다(#837·#802). 여기선 뗀다.)
      ));
    }
    side.append(box);
  }

  const detail = el('div', {});
  rerenderPanel(detail, sel, data);

  // 페이지 머리('관리' + 부제 + 조직명)는 폐지(#837) — 상단 탭이 이미 '관리'를 켜 두었고 사이드바가 지금 어느
  //  화면인지 말해 준다. 그 위에 화면마다 같은 제목·부제가 반복되면 본문만 아래로 밀린다.
  //  '읽기 전용 · 편집하려면 …' 배너도 폐지(#1085) — 편집 못 하는 사람에겐 애초에 편집 버튼·입력칸이 안 보이고,
  //  화면마다 같은 안내가 맨 위를 차지했다. 권한 요건은 사이드바 배지(navPermBadge)가 이미 말한다.
  const body = el('div', { class: 'admin-body' }, detail);
  view.replaceChildren(el('div', { class: 'docs-layout admin-layout' }, side, body));
  applyReveal([body]);
}

// 관리탭 패널 레지스트리 등록(#1313 R37) — 키 → '그 자리를 다시 그리는' 함수.
//  키는 두 종류가 들어온다:
//  ① nav 섹션 키(ADMIN_SECTIONS) — 사이드바가 고른 것.
//  ② 서브패널 키 — 병합된 화면 안의 개별 패널이 **자기 자리를 그 자리에서 다시 그릴 때** 쓰는 키.
//     (패널들이 저장·삭제 후 rerenderPanel(host, 'tokens', …) 식으로 자기를 재렌더한다. 그 host 는 서브탭 본문이라
//      제자리 갱신이 된다. ②는 nav 에 없으므로 URL 로는 도달하지 않는다 — SECTION_REMAP 이 먼저 걸러낸다.)
//  ⚠ 셸도 패널도 이제 이 표만 본다 — 패널이 자기를 다시 그리려고 셸의 디스패처를 역호출할 필요가 없어졌다.
//   그래서 패널을 다른 파일로 떼어내도 그 파일이 admin.ts 를 import 하지 않는다(셸↔패널 순환 절단).
// ── ① nav 섹션 ──
// '내 정보'는 관리에서 분리(#762) — 옛 링크(#/system/me-profile) 호환: 팝업 열고 안내만 남긴다.
registerPanel('me-profile', (detail) => { openMyProfileModal(); detail.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: "'내 정보'는 우측 상단 프로필 버튼을 눌러 편집해요." }))); });
registerPanel('me-ai', (detail) => void myAiSection(detail));
registerPanel('me-logins', (detail) => void myLoginsSection(detail));
registerPanel('me-assets', (detail) => void myAssetsSection(detail));
registerPanel('member-add', (detail, data) => memberAddSection(detail, data));
registerPanel('member-access', (detail, data) => memberAccessSection(detail, data));
registerPanel('members', (detail, data) => membersSection(detail, data));
registerPanel('teams', (detail, data) => teamsPanel(detail, data));
registerPanel('profile', (detail, data) => profileEditor(detail, data));
registerPanel('injection-map', (detail, data) => injectionMap(detail, data));
registerPanel('agent-assets', (detail, data) => agentAssetsSection(detail, data));
registerPanel('tools', (detail, data) => toolsSection(detail, data));
registerPanel('audit', (detail, data) => auditSection(detail, data));
registerPanel('automation', (detail, data) => automationSection(detail, data));
registerPanel('feed-targets', (detail, data) => feedTargetsEditor(detail, data));
registerPanel('project-outbound', (detail, data) => projectOutboundEditor(detail, data));
registerPanel('db-sources', (detail, data) => dbSourceEditor(detail, data));
registerPanel('credentials', (detail) => credentialsEditor(detail));
registerPanel('storage', (detail, data) => storageEditor(detail, data));
registerPanel('logs', (detail, data) => logsEditor(detail, data));
registerPanel('sessions', (detail, data) => sessionsAdminEditor(detail, data));
registerPanel('session-share', (detail, data) => sessionShareEditor(detail, data));
registerPanel('ui', (detail, data) => uiModeSection(detail, data)); // #1719
registerPanel('embeddings', (detail, data) => embeddingsEditor(detail, data));
registerPanel('login-idp', (detail, data) => loginIdpEditor(detail, data));
registerPanel('repos', (detail, data) => reposPanel(detail, data));
registerPanel('me-nodes', (detail, data) => myNodesPanel(detail, data));
registerPanel('nodes', (detail, data) => orgNodesPanel(detail, data));
registerPanel('visibility-axes', (detail) => visibilityAxesPanel(detail));
// ── ② 서브패널 제자리 재렌더 ──
//  ⚠ 'members'·'tools' 는 ①의 **병합 섹션**(탭 껍데기) 키다 — 그 안의 개별 패널이 자기를 다시 그릴 땐
//     반드시 아래 전용 키를 써야 한다. 안 그러면 탭 본문 안에 탭 껍데기가 또 렌더돼 중첩된다.
registerPanel('members-list', (detail, data) => membersEditor(detail, data));
registerPanel('tools-proxy', (detail, data) => toolsEditor(detail, data));
registerPanel('tokens', (detail, data) => tokensPanel(detail, data));
registerPanel('profiles', (detail) => void profilesEditor(detail));
registerPanel('mcp', (detail, data) => mcpEditor(detail, data));
registerPanel('custom-hooks', (detail, data) => customHookEditor(detail, data));
registerPanel('harness-assets', (detail, data) => harnessAssetEditor(detail, data));
registerPanel('tool-usage', (detail) => void toolUsagePanel(detail));
registerPanel('org-audit', (detail) => void orgAuditPanel(detail));
registerPanel('db-audit', (detail, data) => void dbAuditEditor(detail, data));
registerPanel('cron', (detail, data) => void cronPanel(detail, data));
registerPanel('managed-sessions', (detail, data) => void managedSessionsPanel(detail, data));
registerPanel('preview-envs', (detail, data) => void previewEnvsPanel(detail, data));


// ── [구성원] — 구 [구성원 관리]+[구성원 추가]+[구성원 토큰 관리]+[중앙박스 계정] 4탭을 하나로. ──
//  넷 다 "한 사람에 대해 뭘 설정하나"였다. 갈라진 탓에 '구성원 추가' 저장이 location.hash 로 토큰 탭에 점프하고
//  state.admin.memberAddPreselect 로 선택을 실어 나르는 해킹이 필요했다 — 한 화면이 되면서 그 해킹이 사라졌다.
function membersSection(detail, data) {
  // '들이기'는 [구성원 추가], '접속·실행 계정'은 [구성원 권한 관리]로 갈랐고(#1085), 여기엔 **명부와 팀**만 둔다.
  detail.replaceChildren(
    sectionHead('구성원 · 팀', '이 조직에 누가 있는지 보고 고치며, 팀으로 묶습니다.', data.meaning['member']),
    segTabs('members', [
      { key: 'list', label: '구성원', render: (h) => membersEditor(h, data) },
      { key: 'teams', label: '팀', render: (h) => { void teamsPanel(h, data, { embedded: true }); } },
    ]));
}

// ── [구성원 추가] — 사람을 조직에 들이는 한 흐름만 담는다(#1085). ──
//  명부(구성원)에 섞여 있던 [＋ 구성원 추가] 버튼 → 모달 흐름을 화면으로 폈다. 등록하면 임시 비밀번호가 1회
//  뜨고(showInitialAccount), 그 사람이 AI·CLI 도 쓰려면 [구성원 권한 관리 ▸ 접속 토큰]에서 토큰을 발급한다.
function memberAddSection(detail, data) {
  const formBox = el('div', { class: 'admin-form-narrow' });
  const draw = () => {
    const blank = { id: '', kind: 'human', display_name: '', email: '', identities: [], body_md: '', state: 'active', scopes: ['items', 'context'] };
    memberForm(formBox, blank, data, detail, true, {
      saveLabel: '구성원 등록', showCancel: false, showRemove: false,
      onSaved: () => { toast('구성원이 등록됐습니다 — 임시 비밀번호를 전달하세요'); draw(); },
    });
  };
  draw();
  // 화면은 등록 폼 하나로 끝낸다(#1085) — '등록 다음에 할 일'·'최근 등록' 카드는 사용자 요구로 뺐다.
  //  절차 안내는 등록 직후 뜨는 계정 발급 팝업(showInitialAccount)이 이미 한다, 명부는 [구성원] 화면이 맡는다.
  detail.replaceChildren(
    sectionHead('구성원 추가', '새 팀원을 조직에 등록합니다. 등록하면 로그인용 임시 비밀번호가 한 번 표시되니 그 자리에서 전달하세요.'),
    el('div', { class: 'card' },
      cardHead('새 구성원 등록', '이름·이메일·권한을 정해 등록합니다. 아이디는 이메일에서 자동으로 만들어집니다. 등록 직후 임시 비밀번호가 한 번만 보이고, 받은 사람은 첫 로그인에서 새 비밀번호를 정합니다. 그 사람의 AI·CLI 까지 붙이려면 [구성원 권한 관리 ▸ 접속 토큰]에서 토큰을 발급해 전달합니다.'),
      formBox));
}

// ── [구성원 권한 관리] — 접속 토큰 + AI 실행 계정(구 [구성원] 서브탭 둘을 그대로 옮김, #1085). ──
function memberAccessSection(detail, data) {
  detail.replaceChildren(
    sectionHead('구성원 권한 관리', '구성원이 무엇으로 라이블리에 접속하는지, 그 사람의 AI가 어느 계정으로 실행되는지 관리합니다.'),
    segTabs('member-access', [
      // 접속 토큰 = 우리 게이트웨이에 접속하는 bearer 토큰(auth_token). [외부 서비스 관리]의 서비스 로그인과 다른 것 — 용어 사전 참조.
      { key: 'tokens', label: '접속 토큰', render: (h) => tokensPanel(h, data) },
      // 'AI 실행 계정' — 구 '중앙박스 계정(프로필)'. '프로필'은 우상단 [내 프로필]과 겹쳐 버렸다(#524 에서 개념도 은퇴).
      { key: 'accounts', label: 'AI 실행 계정', render: (h) => { void profilesEditor(h); } },
    ]));
}

// ── [AI 도구] — 구 [AI 도구(MCP)] + [MCP 서버]. ──
//  구 라벨은 거짓말이었다: 'AI 도구(MCP)' 화면에 정작 외부 MCP 서버가 노출하는 도구가 없었다(그건 [MCP 서버] 탭
//  → [발행]로만 관리). 이제 AI 가 실제로 쥐는 세 종류를 한 화면에 모은다.
//  권한이 갈린다 — 사내 API·빌트인은 runtime, 외부 서버 등록은 admin(MIXED_SECTIONS).
function toolsSection(detail, data) {
  const rt = !!state.admin.canRuntime, admin = !!state.admin.canEdit;
  detail.replaceChildren(
    sectionHead('AI 도구', 'AI가 호출할 수 있는 도구를 관리합니다 — 사내 API 도구, 기본 제공 도구, 외부 도구 서버(MCP).', data.meaning['tool']),
    segTabs('tools', [
      { key: 'proxy', label: '사내 API 도구', show: rt, render: (h) => toolsEditor(h, data) },
      { key: 'builtin', label: '기본 제공 도구', show: rt, render: (h) => h.append(builtinToggles(data)) },
      // 외부 도구 서버 = 구 [MCP 서버]. 기본 프리셋(mcp-server-presets)이 실제로 채우는 게 바로 이것이다.
      { key: 'mcp', label: '외부 도구 서버 (MCP)', show: admin, render: (h) => mcpEditor(h, data) },
    ]));
}

// ── [스킬 · 훅] — 구 [커스텀 훅]+[스킬·에이전트·커맨드]. ──
//  둘 다 runtime 권한이고 둘 다 '구성원 컴퓨터에서 도는 것'을 정의한다(스킬의 paired_hook_id 가 훅을 참조하기까지).
function agentAssetsSection(detail, data) {
  detail.replaceChildren(
    sectionHead('스킬 · 훅', '구성원의 AI에 배포할 스킬·서브에이전트·커맨드와, 정해진 시점에 자동 실행되는 훅을 관리합니다.', data.meaning['harness-asset']),
    segTabs('agent-assets', [
      { key: 'assets', label: '스킬 · 서브에이전트 · 커맨드', render: (h) => harnessAssetEditor(h, data) },
      { key: 'hooks', label: '커스텀 훅 (코드)', render: (h) => customHookEditor(h, data) },
    ]));
}

// ── [자동화] — 구 [스케줄러]+[상시 세션]. ──
//  크론 액션의 param kind 에 'session' 이 1급으로 있고 4개 액션이 상시 에이전트를 필수 타깃으로 받는다
//  (크론=언제 × 상시 에이전트=어디서·누구로). 떨어뜨려 둘 이유가 없었다.
//  '상시 세션' → '상시 에이전트' 로 개명 — 그래야 이 탭 도처의 "다음 세션부터 반영"(=AI 대화)이 모호하지 않다.
function automationSection(detail, data) {
  detail.replaceChildren(
    sectionHead('자동화', '정해진 시각에 사람 없이 실행되는 작업과, 그 작업을 수행할 상시 에이전트를 관리합니다.'),
    segTabs('automation', [
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
  detail.replaceChildren(
    sectionHead('감사 로그', '누가 언제 무엇을 했는지 봅니다 — 관리 항목 변경, DB 조회, AI 도구 호출.'),
    segTabs('audit', [
      { key: 'org', label: '관리 변경', render: (h) => { void orgAuditPanel(h); } },
      { key: 'db', label: 'DB 조회', render: (h) => { void dbAuditEditor(h, data); } },
      { key: 'tools', label: 'AI 도구 호출', render: (h) => { void toolUsagePanel(h); } },
    ]));
}

// #1153 — [카테고리(분류 체계)] 패널은 [분류체계] 탭(web/categories.ts)으로 이관됐다. 이 자리엔 남기지 않는다 —
//  두 표면이 같은 CRUD 를 갖고 있으면 어느 쪽이 주인인지 사라진다(#837 이 관리탭으로 일원화했던 이유와 같다).

export {
  renderSystem,
};
