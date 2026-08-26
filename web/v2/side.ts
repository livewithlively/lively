// v2/side.ts — 새 셸 좌측 사이드바(#1883): **열린 앱 인스턴스**가 중심이다.
//  세션·프로젝트·위키 등 모든 화면을 동격의 한 행으로 보여 주고, 소속 프로젝트는 행 아래의 클릭 가능한
//  `스페이스 › 리스트 › 프로젝트` 경로로 보여 준다. 위에는 새 작업만, 나머지 고정 진입점은 아래 도크에 둔다.
//
//  아래 규칙과 구현은 #1883 이전 프로젝트 ▸ 세션 트리의 롤백 비교용이다:
//   · 프로젝트는 워크스페이스 전체가 보인다(내 것만이 아니다). '내 프로젝트만'은 필터 안의 토글.
//   · **고정**은 사람이 고른다(2026-08-19) — 행의 압정을 누르면 맨 위로. 자동으로 뭘 올려 두지 않는다
//     (열린 세션을 자동으로 띄우던 줄은 같은 날 걷었다: 내가 고르지 않은 것이 자리를 차지했다).
//   · 프로젝트 아래엔 도는 세션이 먼저. **멈춘 세션도 사라지지 않는다** — 그 아래 '지난 세션 n' 한 줄로 접혀 있고
//     펴면 그 자리에 그대로 있다(#1808, 원준님 신고: 자동회수로 멈추면 새 셸 어디에서도 못 찾겠다).
//     ⚠ 종전 규칙("끝난 것은 프로젝트 화면·세션 이력에서")의 의도는 **가독성**이었다 — 그건 접어 두는 것으로 지키고,
//     '사라진다'는 부작용만 없앤다. 기본 화면은 종전과 똑같다(도는 세션만 펴져 있다).
//   · 완료 프로젝트는 기본 숨김(살아 있는 세션이 있으면 예외로 보인다). 정렬 = 마지막 작업 시각 내림차순.
//   · **기본 화면은 목록 하나다** — 상태 칩·완료 숨김·내 프로젝트만 같은 필터는 전부 [필터] 버튼 속 팝오버로
//     들어간다(밖에 늘어놓으면 목록보다 조작부가 먼저 읽힌다 — 번잡함의 주범이었다).
//   · **위계가 시각으로 갈린다**: 프로젝트 행 = 폴더 아이콘 + 굵은 글씨 → 누르면 프로젝트 화면.
//     세션 행 = 들여쓴 레일 + 상태점 + 보통 글씨 → 누르면 그 세션의 대화. 서로 다른 곳으로 간다는 게 생김새에서 보인다.
//   · 흐린 회색 본문 금지 — 완료·조용한 프로젝트도 이름은 같은 잉크색이고, 상태는 작은 태그·시각으로만 구분한다
//     (연회색 글씨가 목록의 절반을 차지하면 전체가 바래 보인다).
//   · **위계는 네 층이다**(상민님 2026-08-19 "전반적으로 위계가 잘못된 듯"):
//       ⓪ 워크스페이스 — 여기가 어디인가(맨 위 한 줄, 스위처)
//       ① 늘 있는 곳 — 홈 · 리브
//       ② 내용 — 프로젝트 ▸ 세션
//       ③ 도구·나 — 앱 · 계정
//     ①~③ 은 **같은 모양의 행**이고 기둥도 같다. 층은 구분선과 작은 라벨로만 나눈다 —
//     리브만 알약(테두리·큰 글씨)이면 목록보다 먼저 읽혀 위계가 뒤집힌다.
//  main.ts 가 데이터·활성 키를 넘기고, 필터·펼침 같은 사이드바 자체 상태는 여기 산다(브라우저에 기억).
import { api, el, keepSideScroll, loadPeopleAvatars, navOn, personFace, profileAvatar, relTime, state, sv, toast } from '../core.js';
import { confirmDialog } from '../ui-primitives.js';
import { SESS_STATES } from '../session-status.js';
import { appIcon, openLaunchpad, visibleApps } from './apps.js';
import { dotCls, isArchivedProj, isLiveSess, isLooseTrashedSess, isPastSess, isTrashedProj, isTrashedSess, sessWork, type Proj, type Sess, type V2Data } from './views.js';
import { makeSplitter, readSplit, writeSplit } from './split.js';   // 경계 끌어 조정(#1719) — 나눔선 원형을 재사용한다
import { confirmProjectArchive, confirmProjectTrash, confirmSessionTrash, sessionNames, sessionTrashOp, eulReul } from '../session-actions.js';   // #1851 휴지통·아카이브
import { ctxMenu } from './panes-kit.js';
import { switcherName, switcherTop } from './switcher.js';
import { openSectionMenu, railIsHidden, sectionDef, stackTile, type RailSection } from './rail.js';   // #2016 — 무엇을 그릴지는 레일이 고른 구역이 정한다
import { ICONS, icon } from './icons.js';   // #2016 — 선 아이콘 한 벌
import { openMeModal } from './me-modal.js';   // 발치 [나] 행이 여는 내 프로필·환경설정 창(#1843) — 테마·클래식 전환·로그아웃이 그 안에 있다
//  ⚠ 병합 판단(2026-08-25): main 의 **사이드바 3단 테마 토글**(#1683 themeSeg)은 여기 두지 않는다 — 그 기능은
//   me-modal 안으로 옮겨 갔고(테마 + 열린 탭 적용 + 하네스 동기화까지) 같은 조작을 사이드바 발치에 둘로 두지 않는다.
import { mountDesktopUpdate } from '../desktop-update.js';   // 데스크톱 앱이 받아 둔 업데이트 — 있을 때만 발치에 뜬다(#1838)

// 기본은 **전부 접힘**(상민님 2026-08-18: 선택된 프로젝트 외에는 다 접어둔다) — 사용자가 편 것만 기억한다.
//  지금 보는 프로젝트(선택)는 늘 펼침이 기본이고, 그걸 접은 건 잠깐의 상태라 기억하지 않는다(다음 방문엔 다시 펼쳐 보인다).
const OPEN_KEY = 'lively_v2_opened';
const DONE_KEY = 'lively_v2_side_done';   // '1' = 완료 프로젝트도 보인다(필터 풀림)
const MINE_KEY = 'lively_v2_side_mine';   // '1' = 내 프로젝트만
// ⚠ 「지난 세션」 펼침은 **기억하지 않는다**(원준 2026-08-24 — "난 연 적이 없는데 지멋대로 펼쳐져 있어").
//  종전엔 lively_v2_side_past 로 브라우저에 남겨서, 언젠가 한 번(실수로라도) 편 묶음이 **그 뒤로 영원히**
//  펼쳐진 채 열렸다. 편 사람은 그걸 기억하지 못하니 화면이 저 혼자 펼친 것으로 읽힌다.
//  지난 세션은 배경이지 본문이 아니다 — 기본은 늘 접힘이고, 편 것은 그 페이지 동안만 산다.
//  「전체 프로젝트」가 같은 이유로 같은 처방을 받았다(2026-08-23).
const PAST_KEY_LEGACY = 'lively_v2_side_past';
const SELCLOSED_KEY = 'lively_v2_side_selclosed';   // 선택된 프로젝트인데도 **일부러 접어 둔** 것
// ⚠ 「전체 프로젝트」 펼침은 **기억하지 않는다**(원준 2026-08-23 — "사용자가 변경하기 전에는 디폴트로 접힌 상태").
//  종전엔 lively_v2_side_all 로 브라우저에 남겨, 한 번 편 사람은 그 뒤로 늘 수백 행이 펼쳐진 채 열렸다. 이제 페이지 수명만.
//  ⚠ 병합 판단(2026-08-25): main 쪽엔 ALL_KEY 로 **아직 기억하는** 코드가 남아 있었지만, 같은 파일의 주석이 이미
//   '「전체 프로젝트」가 같은 처방을 받았다(2026-08-23)'고 말하고 있었다 — 주석만 오고 코드가 안 따라온 것이라,
//   실제로 처방을 적용한 이쪽(페이지 수명만)을 취한다.
const ALL_KEY_LEGACY = 'lively_v2_side_all';
const PIN_KEY = 'lively_v2_side_pin';     // 위에 고정한 프로젝트 키('p:123') — 사람이 고른 것만 들어간다
//  앱 인스턴스 핀(#1954)은 키 공간이 달라(sess:/inst:/route:) 따로 둔다 — 한 통에 섞으면 트리를 걷어낼 때 같이 사라진다.
const APP_PIN_STORE = 'lively_v2_app_pin';
const BINS_KEY = 'lively_v2_side_bins';   // '1' = 아카이브·휴지통 두 행을 **발치에 고정**(목록을 내려도 늘 보인다, #1851)
const MAX_SESS = 12;                      // 한 프로젝트 아래 펼쳐 보이는 세션 상한(넘치면 '외 n개' → 프로젝트 화면)

// ══ #2033 — 홈 목록의 **묶는 축**(세션 ↔ 프로젝트) ═══════════════════════════════
//  집합은 그대로 두고 묶는 축만 바꾼다. 행 문법(×·압정·상태 점)도, 목록에 무엇이 있는지도 그대로다.
//  움직임의 원칙 한 줄: **위로 올라가고 펴지는 쪽은 즉시, 아래로 내려가고 접히는 쪽은 안 볼 때.**
//   올라오는 움직임은 정보고(나를 기다리는 게 생겼다), 내려가는 움직임은 소음이다(처리한 것의 뒷정리).
const GROUP_STORE = 'lively_v2_side_group';        // 'proj' = 프로젝트로 묶기 · 없으면 종전 시간·상태 축
const GRPCLOSED_STORE = 'lively_v2_side_grpclosed';   // 사람이 **접어 둔** 프로젝트 그룹
const GRPOPENED_STORE = 'lively_v2_side_grpopened';   // 사람이 **펴 둔** 프로젝트 그룹
let groupProj = false;
let grpClosed = new Set<string>();
let grpOpened = new Set<string>();

//  ⚠ 순서를 여기서 따로 기억하지 않는다. 묶음의 자리도, 펼침 여부도 **지금 사실의 함수**다
//   (순서는 시간축이 준 정렬 그대로, 펼침은 상태·선택 그대로) — 그래서 두 축이 어긋날 자리가 없다.

let openSet = new Set<string>();
const pastSet = new Set<string>();          // '지난 세션'을 펴 둔 프로젝트 — **페이지 수명만**(위 주석)
let allOpen = false;                        // 「전체 프로젝트」 펼침 — 페이지 수명만(새로 열면 늘 접힘)
let binsPinned = false;                     // 아카이브·휴지통 행을 발치에 고정(#1851) — 브라우저에 기억
let pinnedSet = new Set<string>();          // ★고정 = 사람이 고른 프로젝트를 맨 위로(상민님 2026-08-19)
let appPinned = new Set<string>();          // ★고정 = 사람이 고른 앱 인스턴스를 맨 위로(#1954)
// 선택된 프로젝트인데도 사람이 **일부러 접어 둔** 것. ⚠ 종전엔 페이지 수명만 기억했다(new Set 만 두고 저장 안 함)
//  — '선택은 늘 보이는 게 기본'이라는 뜻이었지만, 실제로는 **접어도 새로고침하면 도로 열렸다**(원준 2026-08-24
//  "한 번 닫아둔 지난 세션이 계속 열려서 내가 보는 걸 가린다"). 접는 건 사람이 한 명시적 결정이라 기본값이
//  덮을 값이 아니다. 그래서 브라우저에 남긴다 — 다시 펴면 그 자리에서 지워진다(펴 두는 게 다시 기본이 된다).
let closedSelected = new Set<string>();
// 「정리」 모드(#1719 안 C, 원준 2026-08-24) — 프로젝트를 여러 개 골라 한 번에 아카이브로 보낸다.
//  ⚠ **기억하지 않는다**(페이지 수명만). 모드는 켜 둔 걸 잊으면 평소 클릭이 선택으로 먹히는 함정이라,
//   새로 열면 늘 꺼진 상태여야 한다. 사이드바를 떠나거나 끄면 고른 것도 함께 비운다.
let tidyOn = false;
const tidySel = new Set<string>();          // 고른 프로젝트 키('p:123')
let showDone = false;
let mineOnly = false;
let sideFilter = '';
let findOpen = false;             // 돋보기로 펼친 검색칸. **검색어가 있으면 늘 펼친 상태**로 친다(왜 목록이 짧은지 화면이 말해야 한다)
let keyBound = false;
let stateFilter: string | null = null;    // 상태 칩 — 세션 상태 key(waiting·busy…) 하나. 새로고침하면 풀린다(잠깐 보는 렌즈)
let people: Record<string, any> = {};     // id → 멤버(표시명·아바타). 남의 세션 소유자 이름용
let inited = false;
let last: { host: HTMLElement; data: V2Data; activeKey: () => string } | null = null;

function loadSet(k: string): Set<string> { try { const a = JSON.parse(localStorage.getItem(k) || '[]'); return new Set<string>(Array.isArray(a) ? a : []); } catch (_) { return new Set<string>(); } }
function saveSet(k: string, s: Set<string>): void { try { if (s.size) localStorage.setItem(k, JSON.stringify([...s])); else localStorage.removeItem(k); } catch (_) { /* noop */ } }
function saveFlag(k: string, v: boolean): void { try { if (v) localStorage.setItem(k, '1'); else localStorage.removeItem(k); } catch (_) { /* noop */ } }
function init(): void {
  if (inited) return;
  inited = true;
  openSet = loadSet(OPEN_KEY);
  try { localStorage.removeItem(PAST_KEY_LEGACY); } catch (_) { /* noop */ }   // 예전에 남긴 펼침 기록을 치운다
  closedSelected = loadSet(SELCLOSED_KEY);
  try { localStorage.removeItem(ALL_KEY_LEGACY); binsPinned = localStorage.getItem(BINS_KEY) === '1'; } catch (_) { /* noop */ }
  pinnedSet = loadSet(PIN_KEY);
  appPinned = loadSet(APP_PIN_STORE);
  grpClosed = loadSet(GRPCLOSED_STORE);
  grpOpened = loadSet(GRPOPENED_STORE);
  try { groupProj = localStorage.getItem(GROUP_STORE) === 'proj'; } catch (_) { /* 못 읽어도 종전 축으로 돈다 */ }
  try { showDone = localStorage.getItem(DONE_KEY) === '1'; mineOnly = localStorage.getItem(MINE_KEY) === '1'; } catch (_) { /* noop */ }
  void loadPeopleAvatars().then((m) => { people = m || {}; if (last) redraw(); });
}

/** 도는 세션 = tmux 에 살아 있는 박스. / 지난 세션 = 되살릴 수 있는 것 전부(중단됨·종료됨·메모리 부족·기록만). views.ts 가 정의한다. */
const isLive = isLiveSess;
const isPast = isPastSess;
// 상태 key → 표시어. SESS_STATES 에 없는 'log'(중앙 기록만 남은 대화)까지 덮는다.
const stLabel = (k: string): string => (SESS_STATES[k] ? SESS_STATES[k].label : k === 'log' ? '기록' : k);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
// 하네스가 pane 제목에 자기 이름만 써 둔 것 — '지금 하는 일'이 아니다(정보 0).
const HARNESS_TITLES = new Set(['claude code', 'claude', 'codex', 'opencode', 'antigravity', 'grok', 'shell', 'bash', 'zsh', 'tmux', 'node']);
// 기계가 붙인 세션 이름 — 사람이 읽을 게 없다('이어보기 · 3e1ca8f2', '위탁 #t501ac…').
// 이름 자리에서 걷어낼 자동 생성 이름. ⚠ **id 꼴은 따로 본다**(#1744) — '위탁 #41'·'이어보기 · 3e1ca8f2' 는
//  pane 제목이 없을 때 마지막 폴백으로 쓸 값은 되지만(무슨 세션인지는 말해 준다), `box-yoon-40096683` 은 아무것도
//  말해 주지 않아 폴백으로도 못 쓴다. 이름을 안 주고 만든 세션이 그 꼴이 된다(sessions.ts: label = … || id).
const isIdLabel = (s: string) => /^box-/i.test(s) || /^[0-9a-f-]{20,}$/i.test(s);
const isMachineLabel = (s: string) => /^이어보기\s*[·:]/.test(s) || /^위탁\s*#/.test(s) || isIdLabel(s);

/** 이 이름이 프로젝트명의 되풀이인가. 세 모양을 다 잡는다(실측):
 *   ① 그대로              "APP. lvly. io 셀프서브 방식 와이어프레임"
 *   ② 만들 때 잘린 것      "라이블리 키트, cli, 노드 등록을 지금 다 cli에서 해야하는데, 이거 윈도…"(프로젝트명의 앞부분)
 *   ③ 조각만 이어붙인 변형  "app.lvly.io 와이어프레임" ⊂ "APP. lvly. io 셀프서브 방식 와이어프레임"
 *  ③은 글자·숫자만 남긴 뒤 공통 앞머리 + 공통 꼬리가 이름 전체를 덮으면 되풀이로 본다(우연 일치를 막으려 6자 미만은 제외). */
function echoesProject(label: string, proj: string): boolean {
  const a = norm(label); const b = norm(proj);
  if (!a || !b) return false;
  if (a === b || b.startsWith(a) || a.startsWith(b)) return true;
  const ca = a.replace(/[^\p{L}\p{N}]/gu, ''); const cb = b.replace(/[^\p{L}\p{N}]/gu, '');
  if (ca.length < 6 || !cb) return false;
  let head = 0; while (head < ca.length && head < cb.length && ca[head] === cb[head]) head++;
  let tail = 0; while (tail < ca.length - head && tail < cb.length - head && ca[ca.length - 1 - tail] === cb[cb.length - 1 - tail]) tail++;
  return head + tail >= ca.length;
}

/** 세션 행에 쓸 글 — ★프로젝트명 반복을 걷어낸다.
 *  프로젝트에서 연 세션은 이름이 **프로젝트명 그대로**인 게 대다수(dev 실측 2026-08-18: 25건 중 14건) — 그 이름은 바로 위
 *  프로젝트 행이 이미 말하고 있다. 같은 제목이 한 화면에 대여섯 번 반복돼 목록이 통째로 안 읽히던 원인이라 지운다.
 *  대신 하네스가 pane 제목에 써 두는 '지금 하는 일'이 그 자리를 받는다 — 실제로 세션을 구분해 주던 건 그 줄이었다.
 *  이름이 따로 있는 세션(사람이 지은 것)만 두 줄이 된다. 원래 이름은 툴팁에 남는다(정보를 버리지는 않는다). */
export function sessText(s: Sess, projName: string): { main: string; sub: string } {
  const label = String(s.label || '').trim();
  //  멈춘 세션엔 pane 제목이 없다(박스가 없으니 훔쳐볼 화면도 없다) — 그 자리를 **중앙 기록의 대화 제목**
  //  (= 그 세션에 처음 시킨 말)이 받는다. 없으면 종전대로 이름만 남는다.
  const work = sessWork(s);
  let name = label;
  // '프로젝트명 + 꼬리'(예: "… 와이어프레임 - 3열")면 꼬리만 남기고, 그 밖의 되풀이는 통째로 지운다.
  if (projName && label.startsWith(projName)) name = label.slice(projName.length).replace(/^[\s·:\-–—_/|]+/, '').trim();
  if (projName && name && echoesProject(name, projName)) name = '';
  if (isMachineLabel(name)) name = '';
  const job = work && !HARNESS_TITLES.has(norm(work)) && norm(work) !== norm(name) ? work : '';
  if (name && job) return { main: name, sub: job };
  if (name || job) return { main: name || job, sub: '' };
  return { main: (isIdLabel(label) ? '' : label) || String((s.raw && s.raw.harness) || '') || '이름 없는 세션', sub: '' };
}
// ★내 세션인가 — 얼굴(남의 세션 표시)과 보관(×)이 **같은 판정**을 써야 한다(상민님 2026-08-19:
//  "윤상민 아바타 같은 게 있는데 왜 있는지 모르겠고, 그것 때문인지 x 버튼이 보이질 않음").
//  종전엔 둘 다 s.owned 만 봤는데, 그 값이 한 번이라도 false 로 오면 **내 세션에 내 얼굴이 뜨고
//  보관 단추는 사라지는** 짝이 된다 — 사용자가 본 그림이 정확히 그것이다. 그래서 소유자 id 로도 확인한다.
const meId = (): string => String((state.me && state.me.userId) || '');
const isMine = (s: Sess): boolean => !!s.owned || (!!meId() && String((s.raw && s.raw.owner) || '') === meId());
const rankOf = (k: string) => (SESS_STATES[k] ? SESS_STATES[k].rank : 9);
/** 사이드바 세션 정렬 — 상태 순위(답 기다림이 위) 다음 최근 순. **'맨 위 세션'의 정의는 여기 하나뿐**이다
 *  (라우터가 프로젝트 → 세션으로 보낼 때도 이걸 쓴다 — 사이드바에서 보이는 순서와 어긋나면 안 된다). */
export const bySeen = (a: Sess, b: Sess) => rankOf(a.stateKey) - rankOf(b.stateKey) || b.lastSeen - a.lastSeen;
const when = (ms: number) => (ms ? relTime(new Date(ms).toISOString()) : '');
function ownerName(s: Sess): string {
  if (s.owned) return '나';
  const id = String((s.raw && s.raw.owner) || '');
  const m = people[id];
  return (m && m.display_name) || id || '?';
}

// ── 프로젝트 행 하나의 재료: 도는 세션 · 지난 세션 · 마지막 작업 시각 · 내 것인가 ──
interface Row { key: string; proj: Proj | null; live: Sess[]; past: Sess[]; lastWork: number; mine: boolean; done: boolean; fresh: boolean; archived: boolean; trashed: boolean; }

// ── 방금 만든 프로젝트는 잠깐 맨 위 (원준 2026-08-20 신고) ──────────────────────
//  사이드바 순서는 '마지막 작업 시각'인데 갓 만든 프로젝트는 그 값이 0이다 — 그래서 만들자마자
//  「전체 프로젝트」 접힌 묶음 뒤로 사라져 화면에서 찾을 수가 없었다(신고자는 검색으로 찾아야 했다).
//  생성 시각을 그 자리에 **잠깐** 세워 둔다: 정렬 앞 + 「진행 중」에 노출. 시간이 지나면 스스로 가라앉는다
//  (★고정은 사람이 거는 것이므로 자동으로 건드리지 않는다 — 자동 고정은 목록을 영구히 늘린다).
const FRESH_MS = 2 * 60 * 60 * 1000;
/** 생성 후 FRESH_MS 안이면 그 생성 시각(ms), 아니면 0. */
function freshMs(p: Proj | null): number {
  if (!p || !p.created_at) return 0;
  const t = Date.parse(String(p.created_at));
  if (!(t > 0)) return 0;
  return Date.now() - t < FRESH_MS ? t : 0;
}

function buildRows(data: V2Data): Row[] {
  const me = String((state.me && state.me.userId) || '');
  const byProj = new Map<number, Sess[]>();
  const noProj: Sess[] = [];
  // 휴지통에 있는 세션(#1851)은 트리의 재료가 아니다 — 휴지통 화면에만 있다.
  for (const s of data.sessions) { if (isTrashedSess(s)) continue; if (s.projectId) { const arr = byProj.get(s.projectId) || []; arr.push(s); byProj.set(s.projectId, arr); } else noProj.push(s); }
  const lastOf = (arr: Sess[]) => arr.reduce((m, s) => Math.max(m, s.lastSeen || 0), 0);
  const rows: Row[] = data.projects.map((p) => {
    const all = byProj.get(p.id) || [];
    const fresh = freshMs(p);
    return { key: 'p:' + p.id, proj: p, live: all.filter(isLive).sort(bySeen), past: all.filter(isPast).sort((a, b) => b.lastSeen - a.lastSeen),
      // 갓 만든 프로젝트는 생성 시각을 '마지막 작업'으로 친다 — 세션이 아직 없어도 맨 위에 선다.
      lastWork: Math.max(lastOf(all), fresh), done: p.status_category === 'done', fresh: fresh > 0, archived: isArchivedProj(p), trashed: isTrashedProj(p),
      mine: !!me && (p.created_by === me || (p.member_ids || []).includes(me)) };
  });
  // 프로젝트 없는 세션 — 가짜 프로젝트 한 줄로 같은 정렬에 섞는다(맨 아래 고정이면 프로젝트 수백 개 밑에 묻힌다).
  //  ⚠ 도는 게 하나도 없어도 이 줄은 선다(#1808) — 종전엔 loose.length 로만 세워서, 프로젝트에 안 붙은 세션이
  //   전부 멈추는 순간 그 묶음이 통째로 사라졌다. dev 실측으로 그게 가장 큰 덩어리였다(멈춘 세션 202건 중 183건).
  const loose = noProj.filter(isLive).sort(bySeen);
  const loosePast = noProj.filter(isPast).sort((a, b) => b.lastSeen - a.lastSeen);
  if (loose.length || loosePast.length) rows.push({ key: 'p:0', proj: null, live: loose, past: loosePast, lastWork: lastOf(noProj), done: false, fresh: false, archived: false, trashed: false, mine: true });
  return rows;
}

// ── 사이드바 정렬을 밖에서도(#1749 상단바 프로젝트 연결 드롭다운) — 트리와 **같은 순서**(마지막 작업 시각 ↓ → updated_at ↓).
//  완료 프로젝트는 뒤로 보낸다(트리는 기본 숨김이라 "보이는 순서"가 곧 미완료 순서 — 드롭다운은 숨기는 대신 가라앉힌다).
export function projectOrder(data: V2Data): Array<{ proj: Proj; done: boolean; mine: boolean; lastWork: number }> {
  const byWork = (a: Row, b: Row) => b.lastWork - a.lastWork || String((b.proj && b.proj.updated_at) || '').localeCompare(String((a.proj && a.proj.updated_at) || ''));
  return buildRows(data).filter((r) => r.proj && !r.archived && !r.trashed)   // 보관·버린 프로젝트는 연결 후보가 아니다(#1851)
    .sort((a, b) => Number(a.done) - Number(b.done) || byWork(a, b))
    .map((r) => ({ proj: r.proj as Proj, done: r.done, mine: r.mine, lastWork: r.lastWork }));
}

// ── 그리기 ──
/** 셸이 주는 배선 — 트리 안에서 셸의 일(탭·화면)을 해야 할 때만 쓴다(지금은 [＋ 새 세션] 하나). */
export interface SideHooks {
  onNewSession?: (projectId: number) => void;
  /** 세션 이름 바꾸기(더블클릭 인라인 편집) — 서버 반영 + 탭·대화창·우패널까지 셸이 갱신한다. */
  onRenameSession?: (sessionId: string, label: string) => Promise<void>;
  /** 프로젝트 줄을 더블클릭해 고친 이름 — 세션과 같은 자리·같은 편집기(원준 2026-08-24). */
  onRenameProject?: (projectId: number, name: string) => Promise<void>;
  /** 세션을 '지난 세션'으로 보냄(보관) — tmux 만 내리고 복원 좌표는 남긴다. 목록 재적재는 셸이 한다.
   *  휴지통으로 보내기·프로젝트 아카이브(#1851)도 같은 훅을 쓴다 — 어느 쪽이든 '서버가 바뀌었으니 다시 읽어라'다. */
  onArchived?: (sessionId?: string) => void;   // id 가 오면 그 세션은 **즉시** 지난 세션 취급(보관 ×)
  /** [새 작업] — **늘 새 탭**에 홈(시키는 자리)을 연다. 이미 열린 홈 탭으로 되돌아가지 않는다(그러면 쓰던 걸 덮는다). */
  onNewTask?: () => void;
  /** 통합검색(⌘K) 열기 — 지식·프로젝트·자료·세션·세션이력을 한 칸에서(web/v2/omni.ts). */
  onSearch?: () => void;
  /** 뒤로/앞으로 — 브라우저 히스토리. can* 는 켜짐 판정(셸이 히스토리 위치를 센다). */
  onBack?: () => void;
  onForward?: () => void;
  navState?: () => { back: boolean; forward: boolean };
  /** 상단 탭의 정본 상태를 좌측 '열린 앱' 목록으로 투영한다. */
  instances?: () => SideInstance[];
  onActivateInstance?: (id: string, route?: string) => void;
  onCloseInstance?: (id: string) => void;
  onOpenProject?: (projectId: number) => void;
  /** 뒤로·앞으로·검색 줄을 사이드바 대신 여기(데스크톱 창 맨 윗줄)에 건다 — null 이면 종전대로 사이드바 맨 위(#1954). */
  navHost?: () => HTMLElement | null;
  /** 앱 인스턴스 고정이 바뀌었다 — 목록을 다시 계산해야 한다(정렬은 main 이 안다). */
  onPinChanged?: () => void;
  /** #2016 — 레일이 고른 구역(홈 · 확인할 것 · AI 세션 · 프로젝트 · 위키). 없으면 홈(종전 화면 그대로). */
  section?: () => RailSection;
  /** #2016 — 레일 여닫기. 슬랙처럼 **맨 윗줄 맨 왼쪽**(패널 아이콘)에 선다 — navHost 가 없는 브라우저에서만 여기 그린다
   *  (데스크톱은 창 맨 윗줄의 ☰ 자리가 이미 그 단추다). */
  onToggleRail?: () => void;
  railHidden?: () => boolean;
}

export interface SideInstance {
  id: string;
  title: string;
  active: boolean;
  icon: 'home' | 'chat' | 'inbox' | 'link' | 'archive' | 'trash' | 'liv' | 'proj' | 'wiki' | 'ctx' | 'sys' | 'learn' | 'web' | 'sess' | 'term' | 'app';
  state?: string;
  meta?: string;
  /** 소속 프로젝트 — 이름 하나만. 스페이스 › 리스트 계층은 좁은 줄에서 읽히지 않아 걷었다(#1954). self=이 화면이 그 프로젝트다. */
  project?: { id: number; name: string; self?: boolean } | null;
  /** 이 행이 속한 묶음의 이름 — '지금 볼 것' 또는 날짜(오늘·어제·M월 D일). 목록은 이 순서로 나뉜다(#1954). */
  group?: string;
  /** 상태 점(#1954) — busy·waiting·done 만. 없으면 조용한 행이다. */
  status?: { key: string; label: string } | null;
  /** 사람이 맨 위로 고정했는가(#1954). */
  pinned?: boolean;
  /** 남의 세션이면 그 주인(#2026). 내 것이면 null — 전부 내 얼굴이면 아무것도 구분하지 못한다.
   *  왜 필요한가: 이 목록의 세션 줄기는 `!s.owned` 로 남의 세션을 거르지만, **열어 둔 창**은 소유자를 보지 않는다
   *   (보고 있는 화면이 목록에 없으면 그게 고장이므로 — sideInstances ③). 그래서 남의 세션이 여기 설 길이 있는데
   *   행에는 그걸 말해 주는 표식이 없어 "내가 만들지도 않은 게 왜 뜨지"가 됐다(상민님 2026-08-26).
   *   프로젝트 트리 행은 이미 같은 얼굴을 달고 있다(sessRow) — 두 목록이 같은 사실을 같은 방식으로 말한다. */
  owner?: { id: string; name: string } | null;
  /** 정렬 시각(ms) — main.ts 가 **얼려 둔** 값(#1954 orderPin). 프로젝트 축이 그룹 순서를 이걸로 잰다(#2033). */
  at?: number;
  /** 이 행을 여는 주소. **홈 목록은 안 준다** — 셸이 행 키로 제 표에서 찾는다(sideRowRoute).
   *  홈에 없는 행(=[AI 세션]·[확인할 것]의 세션)만 자기 주소를 들고 온다(#2033). 없으면 셸이 못 열어
   *  아무 데도 안 가는 행이 된다 — 실측으로 밟았다. */
  route?: string;
}
let hooks: SideHooks = {};
export function drawSide(host: HTMLElement, data: V2Data, activeKey: () => string, h?: SideHooks): void {
  init();
  hooks = h || hooks;
  last = { host, data, activeKey };
  render();
}
function redraw(): void { if (last) render(); }

// ★고정 — 사람이 고른 프로젝트를 목록 맨 위로. 자동으로 뭘 올려 두지 않는다(열린 세션을 자동으로 띄우던
//  줄은 2026-08-19 에 걷었다: 내가 고르지 않은 것이 자리를 차지했다). 브라우저에 남는다.
const isPinned = (key: string): boolean => pinnedSet.has(key);
function togglePin(key: string): void {
  if (pinnedSet.has(key)) pinnedSet.delete(key); else pinnedSet.add(key);
  saveSet(PIN_KEY, pinnedSet);
  renderTree();
}

let treeEl: HTMLElement | null = null;
// ── 스크롤을 픽셀이 아니라 **내용**에 붙든다 ──────────────────────────────────
//  픽셀(scrollTop 숫자)만 되돌리면 왜 모자라나: 세션을 누르면 **그 프로젝트가 펴지고 직전에 보던 것은
//  접힌다**(projRow 의 isOpen — '선택된 프로젝트만 펼침'). 접힌 쪽이 화면 위쪽에 있었다면 그 높이만큼
//  아래 내용이 통째로 위로 밀린다. 그때 옛 scrollTop 을 그대로 앉히면 **보던 줄이 저 위로 달아난다** —
//  사람 눈에는 "누를 때마다 맨 위로 팅"으로 보인다(원준 2026-08-21).
//  그래서 다시 그리기 전에 **화면 맨 위에 걸린 행이 무엇이었는지**를 기억했다가, 그린 뒤 그 행을 같은
//  자리에 도로 앉힌다(브라우저의 scroll anchoring 과 같은 발상). 행 하나가 사라져도 되도록 후보를 몇 개 든다.
//  ⚠ 그래서 팀 원시함수 keepSideScroll(#1635 ⓑ)을 여기 쓰지 않는다 — 그건 **픽셀 값**을 되돌리는 장치라,
//   내용이 위에서 늘고 주는 이 트리에서는 되돌릴수록 어긋난다. 대신 아래 lastScroll 이 같은 구멍(트리가
//   아예 없다가 새로 생기는 경우)을 막는다.
type Anchor = { keys: string[]; delta: number };
let lastScroll = 0;                       // 트리가 통째로 사라졌다 다시 생길 때의 마지막 자리

function anchorRead(): Anchor | null {
  if (!treeEl || !treeEl.isConnected) return null;
  const top = treeEl.getBoundingClientRect().top;
  const keys: string[] = [];
  let delta = 0;
  for (const n of Array.from(treeEl.querySelectorAll<HTMLElement>('[data-nav]'))) {
    const b = n.getBoundingClientRect();
    if (b.bottom <= top + 1) continue;                    // 화면 위로 지나간 행
    if (!keys.length) delta = b.top - top;                // 맨 위에 걸린 행의 어긋남을 그대로 보존
    keys.push(String(n.dataset.nav || ''));
    if (keys.length >= 6) break;                          // 그 행이 사라졌을 때를 대비한 후보들
  }
  return keys.length ? { keys, delta } : null;
}

function anchorApply(a: Anchor | null): boolean {
  if (!a || !treeEl) return false;
  for (const k of a.keys) {
    const n = treeEl.querySelector<HTMLElement>(`[data-nav="${(window as any).CSS && CSS.escape ? CSS.escape(k) : k}"]`);
    if (!n) continue;
    treeEl.scrollTop += (n.getBoundingClientRect().top - treeEl.getBoundingClientRect().top) - a.delta;
    return true;
  }
  return false;
}
let countEl: HTMLElement | null = null;
let filterOpen = false;            // [필터] 팝오버 — 열림은 잠깐의 상태라 브라우저에 기억하지 않는다
let outsideBound = false;

// 위계 아이콘 — 프로젝트는 폴더(펼치면 열린 폴더), 세션은 말풍선. 같은 24 뷰박스·현재색 스트로크(붓은 하나).
// 핀 아이콘 경로 — Lucide 의 pin(ISC). **우리가 그리지 않는다.**
//  종전엔 손으로 그린 도형이었는데 가운데 축이 세 개로 갈라져 있었다(원준 2026-08-23 "좌우대칭도 안 맞고
//  그냥 너무 이상해"). 실측: 머리 x 9~15(중심 12) · 몸통 가로대 6.5~16.5(중심 11.5) · 바늘 10~12(중심 11).
//  아이콘은 1px 어긋남이 '뭔가 이상하다'로 읽히는 자리라, 눈대중 대신 검증된 세트의 경로를 그대로 쓴다
//  (서비스 로고를 공식 마크로 바꾼 것과 같은 규율 — svc-logos.ts).
//  ⚠ 바늘과 몸통을 **따로** 둔다: 고정됨(on)일 때 몸통만 채워지고 바늘은 선으로 남아야 핀으로 읽힌다.
const PIN_NEEDLE = 'M12 17v5';
const PIN_BODY = 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4a1 1 0 0 1 1 1z';

function glyph(kind: 'folder' | 'folder-open' | 'chat' | 'home' | 'inbox' | 'link' | 'archive' | 'trash', cls: string): SVGElement {
  const D: Record<string, string[]> = {
    folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
    // 뚜껑이 젖혀진 열린 폴더 — 카드가 열려 있다는 것을 아이콘도 함께 말한다(안 1 '방').
    //  ⚠ 뒤판은 **왼쪽 세로선까지 그린다**(`M3 17V7…`). 종전엔 `M3 7…v1` 이라 (3,7)→(21,10) 으로 위쪽만 긋고
    //   끝나서, 왼쪽 y=7~17 구간이 통째로 비어 있었다 — 앞판이 (3,17) 에서 시작하므로 그 사이가 뚫린 채 남고,
    //   16px 에서는 폴더가 **납작하게 잘려 보인다**(원준 2026-08-20 "폴더 아이콘이 좀 가려짐"). 겹침이 아니라
    //   글리프가 덜 그려진 것이 원인이었다. 접힌 폴더와 같은 자리(x 3~21 · y 5~20)를 쓰면서 왼쪽 변만 채운다.
    'folder-open': ['M3 17V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1', 'M3 17l2.3-6.6A2 2 0 0 1 7.2 9H21l-2.4 7.6a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-1z'],
    chat: ['M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z'],
    inbox: ['M4.6 5h14.8L22 13v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4z', 'M2 13h6a4 4 0 0 0 8 0h6'],
    // 외부 앱 연결 — 고리 둘이 맞물린 모양(연결). 자물쇠·플러그는 '잠금'·'전원'으로 읽혀 뜻이 어긋난다.
    link: ['M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3', 'M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.3-1.3'],
    home: ['M3.5 11.2 12 4.5l8.5 6.7', 'M6 10v9h12v-9'],
    // 아카이브 = 뚜껑 있는 상자, 휴지통 = 통(#1851). 둘 다 '치워 둔 곳'이라 같은 붓(24 뷰박스·스트로크)으로.
    archive: ['M3 6h18v4H3z', 'M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9', 'M10 14h4'],
    trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6M14 11v6'],
  };
  //  #2016 — 모양은 icons.ts 한 벌에서 온다(레일·도크·행이 같은 붓). 위 D 는 그 표에 없을 때의 폴백이다.
  return sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, sv('path', { d: ICONS[kind] || D[kind].join(' ') }));
}

let appListEl: HTMLElement | null = null;


//  아이콘은 **무엇인가**(세션·프로젝트·위키)만 말한다 — 상태는 오른쪽 점이 전담한다(#1954 2차).
//  둘이 같은 사실을 두 번 칠하면 목록이 알록달록해지고 정작 점이 안 읽힌다.
function instanceIcon(inst: SideInstance): SVGElement {
  const cls = 'v2-app-inst-ic';
  if (inst.icon === 'home') return glyph('home', cls);
  if (inst.icon === 'chat') return glyph('chat', cls);
  if (inst.icon === 'inbox') return glyph('inbox', cls);
  if (inst.icon === 'link') return glyph('link', cls);
  if (inst.icon === 'archive' || inst.icon === 'trash') return glyph(inst.icon, cls);
  const k = inst.icon === 'app' ? 'proj' : inst.icon;
  return appIcon(k as 'term' | 'proj' | 'wiki' | 'ctx' | 'sys' | 'learn' | 'liv' | 'sess' | 'web', cls);
}


/**
 * 좌측의 정본은 프로젝트 트리가 아니라 **열린 앱 인스턴스**다(#1883).
 * 상단 탭의 상태 기계는 화면·터미널 DOM 보존을 위해 남겨 두되, 사람이 보는 목록은 이 한 곳으로 합친다.
 */
/** 열린 앱 한 줄. 목록을 그리는 두 자리(첫 렌더 · 검색 중 부분 갱신)가 같은 붓을 쓴다(#1958).
 *  ⚠ `one` = **한 줄 구조**(#2033 상민님). 프로젝트 축에서는 머리글이 이미 프로젝트를 말하므로 둘째 줄이 통째로 빈다 —
 *   정보가 줄었으니 줄도 줄인다. 그때 사라지는 것(소속·주인·시각·상태어)은 툴팁이 받는다. */
interface RowOpts {
  /** 한 줄 구조 — 프로젝트 축(머리글이 소속을 이미 말한다). */
  one?: boolean;
  /** 압정·× 를 그리나. **목록의 성질**이 정한다(아래 renderSessions 머리말) — 행의 성질이 아니다. */
  pin?: boolean;
  close?: boolean;
}
function appRowEl(inst: SideInstance, o: RowOpts = {}): HTMLElement {
  const one = !!o.one, canPin = o.pin !== false, canClose = o.close !== false;
  //  남의 세션이면 주인 얼굴(#2026) — 이름은 이 목록이 이미 쓰는 people 맵이 가장 정확하다(main 은 폴백만 준다).
  const ownerNm = inst.owner ? ((people[inst.owner.id] && people[inst.owner.id].display_name) || inst.owner.name || inst.owner.id) : '';
  const tip = [
    inst.title,
    inst.owner ? `${ownerNm}의 세션 — 내가 열어 둬서 목록에 있습니다` : '',
    one ? [inst.status ? inst.status.label : '', inst.at ? when(inst.at) : ''].filter(Boolean).join(' · ') : '',
  ].filter(Boolean).join('\n');
  return el('div',
    //  ⚠ `--plain` = **행 조작이 없는 목록**(압정·× 안 그림). 그 CSS 가 '상태 점은 호버에도 안 숨는다'를
    //   이미 갖고 있다 — 홈에서 점이 숨는 건 그 자리를 × 가 받기 때문이고, 받을 것이 없으면 숨을 이유도 없다.
    { class: 'v2-app-inst' + (one ? ' v2-app-inst--1' : '') + (!canPin && !canClose ? ' v2-app-inst--plain' : '') + (inst.active ? ' on' : '') + (inst.status ? ' st-' + inst.status.key : '') + (inst.owner ? ' other' : ''), role: 'listitem', 'data-instance': inst.id },
    el('button', { class: 'v2-app-inst-open', type: 'button', title: tip, 'aria-current': inst.active ? 'page' : null,
      onclick: () => hooks.onActivateInstance?.(inst.id, inst.route) },
      instanceIcon(inst), el('span', { class: 'v2-app-inst-title', text: inst.title })),
    //  얼굴은 **둘째 줄 왼쪽 여백**에 선다 — 첫 줄 아이콘 바로 아래 빈자리라 새로 폭을 먹지 않고,
    //   첫 줄 오른쪽에 겹쳐 뜨는 압정·닫기와도 부딪히지 않는다.
    //  ⚠ 한 줄 모드(#2033)에는 얼굴을 안 세운다 — 이 부품은 `grid-row: 2` 에 사는데 그 줄이 없어서,
    //   그리면 빈 둘째 줄이 되살아나 행 높이가 두 축에서 어긋난다. 주인 이름은 위 툴팁이 말한다.
    inst.owner && !one ? personFace(inst.owner.id, 'v2-app-inst-face', ownerNm) : null,
    //  상태 = **점 하나**. 글자는 줄을 먹어 제목이 잘렸다(#1954 2차) — 색으로 가르고 이름은 툴팁·읽어주기에 남긴다.
    //  작업 중(파랑·깜빡임) · 확인 필요(노랑) · 작업 완료(초록). 확인한 완료는 점이 없다.
    inst.status
      ? el('span', { class: 'v2-app-inst-st', 'data-st': inst.status.key, title: inst.status.label,
          role: 'img', 'aria-label': inst.status.label })
      : null,
    //  압정 — 고른 것만 맨 위로(#1954). 호버·고정 상태에서만 보인다(늘 보이면 행마다 단추 둘이 늘어선다).
    !canPin ? null : el('button', { class: 'v2-app-inst-pin' + (inst.pinned ? ' on' : ''), type: 'button', 'aria-pressed': String(!!inst.pinned),
      'aria-label': inst.pinned ? `「${inst.title}」 고정 해제` : `「${inst.title}」 위에 고정`,
      title: inst.pinned ? '고정 해제' : '위에 고정 — 맨 위로 올려 둡니다',
      onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); toggleAppPin(inst.id); } },
      sv('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d: PIN_NEEDLE }), sv('path', { d: PIN_BODY }))),
    //  × 는 **이 목록 안에서는** 어느 행에나 있고 뜻도 하나다 — 목록에서 치우기(#1954).
    !canClose ? null : el('button', { class: 'v2-app-inst-close', type: 'button', 'aria-label': `「${inst.title}」 목록에서 치우기`,
      title: inst.status ? '목록에서 치우기 — 하던 일은 계속되고, 상태가 바뀌면 다시 올라와요.' : '목록에서 치우기',
      onclick: () => hooks.onCloseInstance?.(inst.id) },
      sv('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d: 'M6 6l12 12M18 6L6 18' }))),
    //  ⚠ 한 줄 모드(#2033)에서는 둘째 줄을 **만들지 않는다** — 숨기기(display:none)로 두면 빈 그리드 행이 남아
    //   행 높이가 두 축에서 어긋난다. 소속은 머리글이, 시각·상태어는 툴팁이 말한다.
    one ? null
      : inst.project && !inst.project.self
        ? el('button', { class: 'v2-app-inst-project', type: 'button',
            title: `${inst.project.name}\n프로젝트 페이지를 엽니다`,
            onclick: () => hooks.onOpenProject?.(inst.project!.id) },
            glyph('folder', 'v2-app-inst-project-ic'),
            el('span', { class: 'v2-app-inst-pname', text: inst.project.name }))
        : el('span', { class: 'v2-app-inst-meta', text: inst.meta || '라이블리 앱' })) as HTMLElement;
}

// ══ 프로젝트 축 — 묶기·펼침 (#2033) ══════════════════════════════════════════
/** 한 프로젝트 묶음. rows 는 이미 정렬돼 들어온다(아래 projGroups 머리말). */
interface ProjGrp { key: string; id: number; name: string; bucket: string; rows: SideInstance[]; open: boolean; active: boolean; counts: Record<string, number> }

//  펼칠 상태 = **확인 필요 · 작업 완료(미확인)** 둘뿐(상민님 2026-08-26).
//   작업 중은 「지금 볼 것」에 **서기는 하되 펴지 않는다** — 돌고 있는 건 나를 기다리는 게 아니라 알리기만 하면 되고,
//   그건 머리글의 파란 점이 이미 한다. 묶음에 들어가고 말고(=순서)는 시간축이 정하고, 펴고 접고만 여기서 가른다.
const OPENS: Record<string, true> = { waiting: true, done: true };

/**
 * 행 목록을 프로젝트 묶음으로 접는다(#2033).
 *
 * ★ **순서와 묶음 이름은 시간축이 정한 그대로 쓴다.** main.ts 가 이미 행마다 묶음(고정 · 지금 볼 것 · 오늘 · 어제 …)을
 *  붙이고 그 순서(상태 순위 → 최신순)로 정렬해서 넘긴다. 여기서는 **먼저 나온 순서대로 프로젝트를 묶기만** 한다.
 *  그러면 프로젝트 축의 순서는 **정의상** 세션 축과 같아진다 — 한 프로젝트는 그 안에서 가장 급한 행이 서 있던 자리에 서고,
 *  묶음 이름도 그 행의 묶음이다(그 행이 목록에서 제일 먼저 나오므로).
 *  ⚠ 여기서 순서를 다시 매기지 마라. 종전 판은 '층 + 승급 순서'를 따로 지어냈다가 두 축의 순서가 갈렸다
 *   (상민님: "정렬순서도 시간순정렬일때랑 너무 다른데" · "지금 볼 것 로직은 똑같이 가져가면 되잖아").
 */
function projGroups(rest: SideInstance[], searching: boolean): ProjGrp[] {
  const groups: ProjGrp[] = [];
  const byKey = new Map<string, ProjGrp>();
  for (const r of rest) {
    const id = (r.project && r.project.id) || 0;
    const key = 'p:' + id;
    let g = byKey.get(key);
    if (!g) {
      //  묶음 이름 = **첫 행의 묶음**. 목록이 이미 정렬돼 있으므로 첫 행이 곧 그 프로젝트의 가장 급한 행이다.
      g = { key, id, name: id ? (r.project as { name: string }).name : '프로젝트 없음',
        bucket: r.group || '', rows: [], open: false, active: false, counts: {} };
      byKey.set(key, g); groups.push(g);
    }
    g.rows.push(r);
    if (r.active) g.active = true;
    if (r.status) g.counts[r.status.key] = (g.counts[r.status.key] || 0) + 1;
  }

  for (const g of groups) {
    //  펼침 — 사람의 결정이 언제나 이긴다. 그 위에 자동 두 가지뿐이고, 둘 다 **지금 사실의 함수**다.
    //   ⚠ 선택 때문에 펴진 묶음은 **선택이 풀리면 다시 접힌다**(상민님 2026-08-26). 트리의
    //    「선택된 프로젝트만 펼침」과 같은 규율이다 — 한 번 펴진 걸 계속 붙들면 목록이 하루 종일 자라기만 한다.
    if (searching) g.open = true;                                  // 찾으려고 건 렌즈를 묶음이 가리면 안 된다(#1719)
    else if (grpClosed.has(g.key)) g.open = false;                 // 사람이 접었다 — 확인 필요가 생겨도 시스템이 안 뒤집는다
    else if (grpOpened.has(g.key)) g.open = true;                  // 사람이 폈다
    else g.open = g.rows.some((r) => !!r.status && !!OPENS[r.status.key]) || g.active;
  }
  return groups;
}

/** 머리글 오른쪽의 상태 요약 — 트리의 v2-sums 와 같은 문법(점 + 개수), 볼 일 있는 것만.
 *  ⚠ **개수가 1이면 점만** 그린다. 실측(dev, 살아 있는 세션은 프로젝트마다 대개 하나)에서 머리글이
 *   「● 1  1」 처럼 1을 두 번 쓰고 있었다 — 같은 사실을 두 번 말하면 둘 다 안 읽힌다. */
function grpSums(counts: Record<string, number>): HTMLElement | null {
  const part = (k: string, cls: string) => (counts[k] ? el('span', { class: 'v2-sum ' + cls, title: `${SESS_STATES[k] ? SESS_STATES[k].label : k} ${counts[k]}` },
    el('span', { class: 'v2-dot ' + cls, 'aria-hidden': 'true' }), counts[k] > 1 ? String(counts[k]) : null) : null);
  const w = part('waiting', 'wait'), d = part('done', 'done'), b = part('busy', 'busy');
  if (!w && !d && !b) return null;
  return el('span', { class: 'v2-sums' }, w, d, b);
}

/**
 * 프로젝트 묶음 머리글.
 *  ⚠ 접기 단추와 ＋ 는 **형제 button** 이다 — 단추 안에 단추를 넣으면 유효하지 않은 마크업이고 클릭이 겹친다.
 *  ⚠ ＋ 는 트리의 것을 그대로 재사용하되 **그리드/플렉스 밖(절대위치)** 에 띄운다 — 자리를 차지하면
 *   상태 점·개수가 오른쪽 끝에 못 붙는다(#1954 ⓑ 가 앱 행에서 이미 밟은 함정, 상민님 2026-08-26 재지적).
 */
function projGrpHead(g: ProjGrp): HTMLElement {
  return el('div', { class: 'v2-pg-row' + (g.active && !g.open ? ' act' : '') },
    el('button', { class: 'v2-pg-t', type: 'button', 'aria-expanded': String(g.open),
      title: g.name + (g.id ? `\n#${g.id} · 세션 ${g.rows.length}` : '\n프로젝트에 붙지 않은 세션과 화면'),
      onclick: () => toggleGrp(g.key, g.open) },
      el('span', { class: 'v2-car', 'aria-hidden': 'true', text: '\u203a' }),
      glyph(g.open ? 'folder-open' : 'folder', 'v2-pg-ic'),
      el('span', { class: 'n', text: g.name }),
      grpSums(g.counts),
      //  세션이 하나뿐인 묶음은 개수를 안 쓴다 — 접힌 줄 하나가 곧 그 하나다(위 grpSums 주석과 같은 사유).
      g.rows.length > 1 ? el('span', { class: 'v2-cnt', text: String(g.rows.length) }) : null),
    g.id ? newSessBtn(g.id) : null) as HTMLElement;
}

/** 사람이 묶음을 접거나 폈다. 사람의 결정은 브라우저에 남고, 그 뒤로 자동 판정이 이 묶음을 안 뒤집는다. */
function toggleGrp(key: string, wasOpen: boolean): void {
  if (wasOpen) { grpClosed.add(key); grpOpened.delete(key); }
  else { grpOpened.add(key); grpClosed.delete(key); }
  saveSet(GRPCLOSED_STORE, grpClosed);
  saveSet(GRPOPENED_STORE, grpOpened);
  paintAppList();
}

/** 프로젝트 축의 목록 — 시간축과 **같은 묶음 머리글**(고정 · 지금 볼 것 · 오늘 …) 아래에 프로젝트 카드를 쌓는다. */
function projListKids(shown: SideInstance[], q: string, o: RowOpts = {}): HTMLElement[] {
  const kids: HTMLElement[] = [];
  //  「고정」은 두 축 공통으로 맨 위다(#1954) — 압정한 행이 프로젝트 묶음 안에 갇히면 그 약속이 깨진다.
  //   여기 선 행은 소속을 말해 줄 머리글이 없으므로 **두 줄 그대로**(프로젝트 칩을 남긴다).
  const pinned = shown.filter((r) => r.pinned);
  const rest = shown.filter((r) => !r.pinned);
  let lastBucket = '';
  if (pinned.length) {
    kids.push(el('div', { class: 'v2-app-group', role: 'presentation', text: pinned[0].group || '고정' }) as HTMLElement);
    lastBucket = pinned[0].group || '고정';
    for (const r of pinned) kids.push(appRowEl(r, o));
  }
  for (const g of projGroups(rest, !!q)) {
    if (g.bucket && g.bucket !== lastBucket) {
      kids.push(el('div', { class: 'v2-app-group', role: 'presentation', text: g.bucket }) as HTMLElement);
      lastBucket = g.bucket;
    }
    //  ★펼친 묶음 = 흰 카드 그릇 — 세션이 프로젝트의 **안**에 산다는 걸 면(面)이 말한다.
    //   들여쓰기+세로선만으로는 "목록 둘이 이웃한 그림"으로 읽혔다(상민님 2026-08-18, 트리 .v2-pj.open 과 같은 처방).
    kids.push(el('div', { class: 'v2-pg' + (g.open ? ' open' : '') },
      projGrpHead(g),
      g.open ? el('div', { class: 'v2-pg-list' }, ...g.rows.map((r) => appRowEl(r, { ...o, one: true }))) : null) as HTMLElement);
  }
  return kids;
}

/** 목록 안에 들어갈 것 전부 — 묶음 머리글 + 행, 하나도 없으면 빈 화면 한 장. */
function appListKids(shown: SideInstance[], q: string, o: RowOpts = {}, empty?: { none: string; found: string }): HTMLElement[] {
  const kids: HTMLElement[] = groupProj ? projListKids(shown, q, o) : [];
  if (!groupProj) {
    //  묶음 머리글은 **묶음이 바뀔 때만** 낀다 — 행마다 붙이면 목록이 아니라 표가 된다.
    let lastGroup = '';
    for (const inst of shown) {
      const g = inst.group || '';
      if (g && g !== lastGroup) { kids.push(el('div', { class: 'v2-app-group', role: 'presentation', text: g }) as HTMLElement); lastGroup = g; }
      kids.push(appRowEl(inst, o));
    }
  }
  if (shown.length) return kids;
  return [el('div', { class: 'v2-app-empty' },
    el('p', { text: q ? (empty?.found || '찾는 열린 앱이 없어요.') : (empty?.none || '열린 앱이 없어요.') }),
    q ? el('button', { class: 'btn-text', type: 'button', text: '검색 지우기', onclick: () => { sideFilter = ''; redraw(); } })
      : el('button', { class: 'btn-text', type: 'button', text: '새 작업 열기', onclick: () => hooks.onNewTask?.() })) as HTMLElement];
}

/** 검색어를 칠 때의 갱신 — **목록만** 갈아 끼운다. 검색칸·머리글은 손대지 않는다(살아 있는 노드 = 살아 있는 IME 조합).
 *  머리글의 개수 배지는 거르기 전 전체 수라 검색어로 변하지 않으므로 여기서 손댈 것이 없다. */
function paintAppList(): void {
  if (!appListEl || !hooks.instances) return;
  const q = sideFilter.trim().toLowerCase();
  const shown = hooks.instances().filter((i) => !q || [i.title, i.meta, i.project?.name].filter(Boolean).join(' ').toLowerCase().includes(q));
  appListEl.replaceChildren(...appListKids(shown, q));
  appListEl.scrollTop = 0;   // 거르고 나면 맨 위가 첫 결과다
}

/** 검색칸에서 글자를 조합하는 중(한글 등). 이때 전면 재렌더가 돌면 입력칸이 새로 나 조합이 끊긴다(#1958). */
let findComposing = false;

function render(): void {
  if (!last) return;
  // SideHooks.instances 를 모르는 이전 임베더는 기존 프로젝트 트리를 그대로 받는다.
  if (!hooks.instances) { renderLegacy(); return; }
  // 검색칸에서 한글을 조합하는 중이면 이번 판은 건너뛴다 — 폴링이 입력칸을 새로 만들면 그 글자가 자모로
  //  흩어진다(#1958). 갱신은 **다시 오지만**, 사람이 치던 글자는 다시 오지 않는다.
  if (findComposing) return;
  const wsReg: any = (state.me as any)?.workspace_registry || {};
  const wsKind = (wsReg.active && wsReg.kind) || ((state.me as any)?.workspace?.kind);
  const sideRoot = last.host.closest('.v2-side');
  sideRoot?.classList.toggle('ws-personal', wsKind === 'personal');
  //  #2016 — **무엇을 그릴지는 레일이 고른 구역이 정한다.** 홈은 종전 화면(열린 앱 목록) 그대로이고,
  //   나머지 셋은 그 구역의 렌즈다: AI 세션 = 세션 전체, 프로젝트 = 프로젝트 트리, 위키 = 분류.
  //   ⚠ 구역은 주소를 따라 저절로 바뀌지 않는다(rail.ts 머리말) — 목록에서 뭔가를 여는 순간
  //    사이드바가 갈아엎이면 방금 보던 목록이 사라진다.
  const sec: RailSection = hooks.section?.() || 'home';
  sideRoot?.setAttribute('data-sec', sec);
  if (sec === 'inbox') { renderInboxSide(); return; }
  if (sec === 'sess') { renderSessions(); return; }
  if (sec === 'proj') { renderProjects(); return; }
  if (sec === 'wiki') { renderWiki(); return; }
  renderHomeApps();
}

/** 구역 머리 — 레일이 접혀 있으면 워크스페이스 이름이 여기 선다(슬랙의 「HonestAI ▾」 자리). */
function secHead(title: string, count: number | null, ...acts: Array<HTMLElement | null>): HTMLElement {
  return el('div', { class: 'v2-app-space-head' },
    railIsHidden() ? null : switcherName(),
    el('span', { class: 'v2-k', text: title }),
    count != null ? el('span', { class: 'v2-app-count', text: String(count) }) : null,
    ...acts);
}

/** 켜져 있는 필터 수 — 0이면 요약 줄을 그리지 않는다. */
function fltCount(): number { return (stateFilter ? 1 : 0) + (mineOnly ? 1 : 0) + (showDone ? 1 : 0); }

/** 찾기 칸 — 구역마다 찾는 대상이 달라 안내 문구만 갈린다(입력 상태 `sideFilter` 는 하나다). */
function findInput(ph: string): HTMLInputElement {
  const inp = el('input', { class: 'v2-find-in', type: 'search', placeholder: ph, 'aria-label': ph, value: sideFilter,
    // ⚠ 타이핑 중에는 **목록만** 갈아 끼운다 — 사이드바를 통째로 다시 그리면 이 입력칸도 새로 나고,
    //  그 순간 브라우저의 IME 조합이 끊긴다. 한글은 한 글자가 여러 타건의 조합이라 매 타건이 따로 확정되어
    //  "안녕"이 "ㅇㅏㄴㄴㅕㅇ"로 흩어진다(#1958). 포커스를 복원해도 소용없다 — 조합 상태는 노드에 붙어 있다.
    oninput: (e: any) => { sideFilter = e.target.value; paintAppList(); markFind(); },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 한글 조합 중의 Esc 는 '조합 취소'지 '검색 지우기'가 아니다 — 치던 글자만 물러난다.
      if (e.isComposing || (e as any).keyCode === 229) return;
      e.stopPropagation();
      if (sideFilter) sideFilter = ''; else findOpen = false;
      redraw();
    },
    oncompositionstart: () => { findComposing = true; },
    oncompositionend: () => { findComposing = false; },
    onblur: () => { findComposing = false; if (!sideFilter && findOpen) window.setTimeout(() => { if (!sideFilter) closeFind(); }, 120); } }) as HTMLInputElement;
  if (findFocusWanted) { findFocusWanted = false; window.setTimeout(() => inp.focus(), 0); }
  return inp;
}

/** 레일을 숨겼을 때 사이드바 머리 한 줄(#2016 안 B) — [스택 타일 + 이름 ▾] … [지금 구역 ▾]. 레일이 보이면 그리지 않는다.
 *  왼쪽은 레일 맨 위의 그 문패(같은 팝오버), 오른쪽은 구역 드롭다운(여섯 행 + 레일 펼치기). 앱·나는 발치 한 줄로(secFoot). */
function wsHead(): HTMLElement {
  const sec = hooks.section?.() || 'home';
  const ak = last ? last.activeKey() : '';
  const cur = ak === 'liv' ? { label: '리브', icon: 'liv' } : sectionDef(sec);
  const inboxN = last ? last.data.sessions.filter((s) => isLive(s) && (s.stateKey === 'waiting' || (s.stateKey === 'done' && s.owned))).length : 0;
  return el('div', { class: 'v2-side-wshd' },
    stackTile({ small: true, label: true }),
    el('button', { class: 'v2-secdd', type: 'button', 'aria-haspopup': 'menu', title: '구역 바꾸기 — 홈 · 확인할 것 · AI 세션 · 프로젝트 · 위키 · 리브',
      onclick: (e: Event) => openSectionMenu(e.currentTarget as HTMLElement) },
      icon(cur.icon, 'v2-ic'), el('span', { class: 'v2-secdd-t', text: cur.label }),
      sec === 'inbox' && ak !== 'liv' && inboxN ? el('span', { class: 'v2-rail-bd', text: String(inboxN) }) : null,
      el('span', { class: 'v2-ws-car', 'aria-hidden': 'true', text: '▾' })));
}
/** 사이드바 맨 위 — 뒤로·앞으로·검색 줄(데스크톱은 창 맨 윗줄로 간다) + 레일을 숨겼을 때의 머리 한 줄. */
function topBits(navEl: HTMLElement, navHost: HTMLElement | null): HTMLElement[] {
  return [...(navHost ? [] : [navEl]), ...(railIsHidden() ? [wsHead()] : [])];
}
/** 레일을 숨겼을 때 발치 한 줄 — [⊞ 앱] [아바타 이름 톱니]. 레일이 있기 전 사이드바(#1843)의 그 자리. */
function footRow(): HTMLElement {
  const me: any = state.me || {};
  const name = String(me.display_name || me.email || me.userId || '');
  return el('div', { class: 'v2-foot-row' },
    el('button', { class: 'v2-apps-btn', type: 'button', title: '모든 앱', onclick: () => openLaunchpad() }, icon('apps', 'v2-ic'), el('span', { text: '앱' })),
    el('button', { class: 'v2-me', type: 'button', title: '내 프로필 · 환경설정', 'aria-haspopup': 'dialog', onclick: () => openMeModal({ onSaved: () => redraw() }) },
      profileAvatar(me.avatar, name, me.userId, 'v2-ava', { char: me.avatar_char, color: me.avatar_color }),
      el('span', { class: 'v2-me-name', text: name }), icon('gear', 'v2-me-ic')));
}

/** 구역 발치 — 어느 구역에서나 같다: 데스크톱 업데이트 알림(#1838) + **도크 셋**(아카이브 · 휴지통 · 외부 앱 연결).
 *  원준 2026-08-26: "이전에 아래에 있었던 아카이브랑 휴지통은 어디 감? 거기에 외부 앱 연결도 만들자." — 치워 둔 곳과
 *  바깥으로 나가는 문은 **어느 구역에서든 같은 자리**에 있어야 찾는다. 아이콘 아래 이름을 둔다(아이콘만 늘어선
 *  도크는 무엇인지 안 읽혔다 — 종전 도크 여섯의 교훈). */
function secFoot(...rows: Array<HTMLElement | null>): HTMLElement {
  const data = last ? last.data : null;
  const ak = last ? last.activeKey() : '';
  const me = meId();
  const archivedN = data ? data.projects.filter((p) => isArchivedProj(p) && !isTrashedProj(p)).length : 0;
  const trashedN = data ? data.projects.filter((p) => isTrashedProj(p)).length
    + data.sessions.filter((s) => isLooseTrashedSess(s) && (s.owned || (!!me && String((s.raw && s.raw.owner) || '') === me))).length : 0;
  const dock = (key: 'archive' | 'trash' | 'connect', label: string, n: number, title: string): HTMLElement =>
    el('a', { class: 'v2-dock-btn' + (ak === key ? ' on' : ''), href: '#/' + key, 'data-nav': key, title, 'aria-label': label + (n ? ` ${n}` : '') },
      icon(key === 'connect' ? 'link' : key, 'v2-dock-ic'),
      el('span', { class: 'v2-dock-t', text: label }),
      n ? el('span', { class: 'v2-dock-n', text: String(n) }) : null);
  return el('footer', { class: 'v2-side-foot v2-side-foot--apps' }, updateSlot(), ...rows,
    el('nav', { class: 'v2-app-dock v2-app-dock--3', 'aria-label': '치워 둔 곳 · 연결' },
      dock('archive', '아카이브', archivedN, '아카이브 — 통째로 보관한 프로젝트와 그 아래 세션'),
      dock('trash', '휴지통', trashedN, '휴지통 — 버린 프로젝트·세션을 되돌리거나 완전히 지웁니다'),
      dock('connect', '외부 앱 연결', 0, '외부 앱 연결 — 슬랙·노션·드라이브 같은 바깥 서비스를 잇습니다')),
    //  레일을 숨겼으면 레일 발치의 [앱]·[나]가 여기로 내려온다(안 B).
    railIsHidden() ? footRow() : null);
}

/** 발치의 '갈 곳' 한 줄(세션 이력 · 아카이브 · 휴지통) — 목록의 항목이 아니라 같은 급의 문이다. */
function footLink(href: string, icon: Parameters<typeof glyph>[0], text: string, n?: number | null): HTMLElement {
  //  활성 표시는 걸지 않는다 — activeKey 는 `app:sessions` 꼴이라 해시(`#/app/sessions`)와 축이 달라
  //   비교가 영영 맞지 않는다. 맞지도 않는 판정을 두면 다음 사람이 '왜 활성이 안 되지'를 뒤진다.
  return el('a', { class: 'v2-nav v2-foot-link', href, title: text },
    glyph(icon, 'v2-nav-ic'), el('span', { class: 'n', text }),
    n != null ? el('span', { class: 'v2-cnt', text: String(n) }) : null);
}

function renderHomeApps(): void {
  if (!last) return;
  const { host } = last;
  const instances = hooks.instances!();
  const q = sideFilter.trim().toLowerCase();
  const shown = instances.filter((i) => !q || [i.title, i.meta, i.project?.name].filter(Boolean).join(' ').toLowerCase().includes(q));

  const prevScroll = appListEl ? appListEl.scrollTop : 0;
  const findHad = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('v2-find-in') ? document.activeElement : null;
  const findSel = findHad ? [findHad.selectionStart, findHad.selectionEnd] : null;

  const listEl = el('div', { class: 'v2-app-list', role: 'list', 'aria-label': '열린 앱' }, ...appListKids(shown, q));
  appListEl = listEl;
  listEl.scrollTop = prevScroll;

  const findIn = el('input', { class: 'v2-find-in', type: 'search', placeholder: '열린 앱 찾기', 'aria-label': '열린 앱 찾기', value: sideFilter,
    // ⚠ 타이핑 중에는 **목록만** 갈아 끼운다 — 사이드바를 통째로 다시 그리면 이 입력칸도 새로 나고,
    //  그 순간 브라우저의 IME 조합이 끊긴다. 한글은 한 글자가 여러 타건의 조합이라 매 타건이 따로 확정되어
    //  "안녕"이 "ㅇㅏㄴㄴㅕㅇ"로 흩어진다(#1958). 포커스를 복원해도 소용없다 — 조합 상태는 노드에 붙어 있다.
    oninput: (e: any) => { sideFilter = e.target.value; paintAppList(); markFind(); },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 한글 조합 중의 Esc 는 '조합 취소'지 '검색 지우기'가 아니다 — 치던 글자만 물러난다.
      if (e.isComposing || (e as any).keyCode === 229) return;
      e.stopPropagation();
      if (sideFilter) sideFilter = ''; else findOpen = false;
      redraw();
    },
    oncompositionstart: () => { findComposing = true; },
    oncompositionend: () => { findComposing = false; },
    onblur: () => { findComposing = false; if (!sideFilter && findOpen) window.setTimeout(() => { if (!sideFilter) closeFind(); }, 120); } }) as HTMLInputElement;

  //  데스크톱 앱이면 이 줄은 창 맨 윗줄로 간다(#1954 상민님: 상단 탭이 빠져 그 자리가 비었다).
  //  브라우저에선 navHost 가 null 이라 종전대로 사이드바 맨 위에 남는다.
  const navEl = navRow();
  const navHost = hooks.navHost?.() || null;
  if (navHost) { navHost.querySelector('.v2-side-nav')?.remove(); navHost.prepend(navEl); }

  //  #2016 — 문패 카드와 [나]는 **레일**로 갔다(펼치면 카드, 접히면 타일 / 발치의 나). 여기 사본을 남기지 않는다.
  //   대신 발치 도크에 있던 넷 중 **확인할 것 · 리브 · 외부 앱 연결**이 목록 위 고정 행으로 돌아온다 —
  //   셋 다 '홈에서 늘 가는 곳'이고, 아이콘만 여섯 늘어선 도크에서는 무엇인지 읽히지 않았다.
  //   아카이브 · 휴지통은 [프로젝트] 구역 발치로, 모든 앱은 레일의 [앱]으로 갔다.
  //  #2016 2차 — 확인할 것·리브는 **레일**로 갔다(슬랙의 내 활동 자리). 홈 사이드바는 열린 앱 목록뿐이다.
  //   아카이브·휴지통·외부 앱 연결은 어느 구역에서나 **발치 도크**(secFoot)에 있다.
  host.replaceChildren(
    ...topBits(navEl, navHost),
    el('section', { class: 'v2-app-space', 'aria-label': '앱' },
      secHead('앱', instances.length,
        //  새 작업은 목록 위 큰 버튼이 아니라 머리글의 ＋ 하나다(#1954) — 목록이 세로를 더 쓴다.
        el('button', { class: 'v2-app-new', type: 'button', 'aria-label': '새 작업 열기', title: '새 작업 — 무엇이든 시키거나 앱을 고릅니다',
          onclick: () => hooks.onNewTask?.() },
          sv('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d: 'M12 5v14M5 12h14' }))),
        axisBtn(), findBtn()),
      ...(findShown() ? [el('div', { class: 'v2-find v2-find--apps' }, findIn)] : []),
      listEl),
    secFoot());

  listEl.scrollTop = prevScroll;
  keepSideScroll(listEl, 'v2-app-list');
  if (findHad) { findIn.focus(); if (findSel && findSel[0] != null) findIn.setSelectionRange(findSel[0], findSel[1]); }
  else if (findFocusWanted) { findFocusWanted = false; findIn.focus(); }
  bindFindKey();
}

// ══ [AI 세션] 구역 (#2016) ═══════════════════════════════════════════════════
//  홈이 '열린 것'이라면 여기는 **세션 전체**다 — 이 브라우저에서 안 열었어도 박스에서 돌면 여기 있다.
//  행 생김새는 홈과 같은 문법(.v2-app-inst)이다: 구역이 바뀌었다고 시각 언어까지 바뀌면 같은 화면으로 안 읽힌다.
/**
 * 세션 하나를 목록의 공용 자료형(SideInstance)으로 옮긴다(#2033).
 *  ★ 이렇게 두면 [AI 세션]·[확인할 것]이 홈과 **같은 붓**(appRowEl · appListKids)을 쓴다 — 행 문법도,
 *   묶는 축 토글도, 뒤에 붙는 고침도 한 자리에서 온다. 종전엔 행 그리는 코드가 두 벌이라(sessInstRow)
 *   같은 목록인데 홈에만 있던 것이 조용히 생겼다: 남의 세션 주인 얼굴(#2026)이 여기 없었고, 행을 눌렀을 때
 *   홈은 탭을 재사용하는데 여기는 주소로 곧장 갈아탔다.
 */
function sessAsInst(s: Sess, pastRow: boolean, group: string): SideInstance {
  const p = s.projectId ? last!.data.projects.find((x) => x.id === s.projectId) : null;
  const t = sessText(s, p ? p.name : '');
  const ak = last!.activeKey();
  const st = !pastRow && SESS_STATES[s.stateKey] ? s.stateKey : '';
  const ownerId = String((s.raw && s.raw.owner) || '');
  return {
    id: 'sess:' + s.id,
    route: '#/s/' + encodeURIComponent(s.id),
    title: t.main,
    active: ak === 's:' + s.id || (!!s.logId && ak === 's:' + s.logId),
    icon: 'chat',
    meta: t.sub || when(s.lastSeen),
    project: p ? { id: p.id, name: p.name } : null,
    group,
    status: st ? { key: st, label: stLabel(st) } : null,
    //  남의 세션이면 주인 얼굴 — 홈이 이미 하는 일이다(#2026). 이 구역은 남의 세션이 **더 많이** 서는 곳이라
    //   여기 없던 게 더 이상했다.
    owner: isMine(s) ? null : { id: ownerId, name: ownerName(s) },
    at: s.lastSeen || 0,
  };
}

function renderSessions(): void {
  if (!last) return;
  const { host, data } = last;
  const navEl = navRow();
  const navHost = hooks.navHost?.() || null;
  if (navHost) { navHost.querySelector('.v2-side-nav')?.remove(); navHost.prepend(navEl); }

  const all = data.sessions.filter((s) => !isTrashedSess(s));
  const live = all.filter(isLive).sort(bySeen);
  const past = all.filter(isPast).sort((a, b) => b.lastSeen - a.lastSeen);
  const counts = new Map<string, number>();
  for (const s of live) counts.set(s.stateKey, (counts.get(s.stateKey) || 0) + 1);
  const q = sideFilter.trim().toLowerCase();
  const match = (s: Sess): boolean => {
    if (stateFilter && s.stateKey !== stateFilter) return false;
    if (!q) return true;
    const p = s.projectId ? data.projects.find((x) => x.id === s.projectId) : null;
    return [s.label, p?.name].filter(Boolean).join(' ').toLowerCase().includes(q);
  };
  const liveShown = live.filter(match);
  const pastShown = past.filter((s) => (stateFilter ? false : true) && (!q || s.label.toLowerCase().includes(q)));

  //  상태 칩 — 필터를 팝오버에 숨기지 않는다. 이 구역에서는 '무엇이 나를 기다리나'가 첫 질문이라
  //   숫자가 밖에 나와 있어야 한다(홈 목록에서는 반대로 [필터] 안에 둔다 — 거기선 목록이 주인공이다).
  const chip = (on: boolean, label: string, n: number, dot: string | null, run: () => void): HTMLElement =>
    el('button', { class: 'v2-schip' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on), onclick: run },
      dot ? el('span', { class: 'v2-dot ' + dot }) : null,
      el('span', { text: label }), el('span', { class: 'n', text: String(n) }));
  const chipKeys = ['busy', 'waiting', 'done'].filter((k) => counts.has(k) || stateFilter === k);
  const chips = el('div', { class: 'v2-schips' },
    chip(!stateFilter, '전체', live.length, null, () => { stateFilter = null; redraw(); }),
    ...chipKeys.map((k) => chip(stateFilter === k, stLabel(k), counts.get(k) || 0, dotCls(k),
      () => { stateFilter = stateFilter === k ? null : k; redraw(); })));

  const prevScroll = appListEl ? appListEl.scrollTop : 0;
  //  ★ 홈과 **같은 붓**을 쓴다(#2033) — 행 문법도 묶는 축 토글도 여기서 새로 만들지 않는다.
  //   ⚠ 압정·× 는 안 그린다. 목록의 성질이 다르기 때문이다: 홈은 내가 지금 붙들고 있는 것만 담은 **작업 큐**라
  //    맨 위 고정도, 치우기도 뜻이 있다. 여기는 **전수 명부**고 순서의 정본은 상태(bySeen)다 —
  //    치우면 찾을 곳이 없어지고, 고정은 상태 순서를 흔든다(프로젝트 트리도 프로젝트만 고정하지 세션은 안 한다).
  const rowOpts: RowOpts = { pin: false, close: false };
  const items = [
    ...liveShown.map((s) => sessAsInst(s, false, `돌고 있는 것 · ${liveShown.length}`)),
    ...pastShown.slice(0, 40).map((s) => sessAsInst(s, true, `지난 세션 · ${pastShown.length}`)),
  ];
  const listEl = el('div', { class: 'v2-app-list', role: 'list', 'aria-label': 'AI 세션' },
    ...appListKids(items, q, rowOpts, {
      none: stateFilter ? '조건에 맞는 세션이 없어요.' : '지금 도는 세션이 없어요. 홈에서 무엇이든 시켜 보세요.',
      found: '찾는 세션이 없어요.' }));
  appListEl = listEl;
  listEl.scrollTop = prevScroll;

  host.replaceChildren(
    ...topBits(navEl, navHost),
    el('section', { class: 'v2-app-space', 'aria-label': 'AI 세션' },
      secHead('AI 세션', live.length,
        el('button', { class: 'v2-app-new', type: 'button', 'aria-label': '새 세션', title: '새 세션 — 홈에서 무엇이든 시키면 열려요',
          onclick: () => hooks.onNewTask?.() },
          sv('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d: 'M12 5v14M5 12h14' }))),
        //  묶는 축 토글 — 홈과 **같은 단추·같은 플래그**다(#2033). 묶는 축은 구역의 성질이 아니라
        //   사람의 습관이라, 한 구역에서 바꾸면 다른 구역도 그렇게 열린다.
        axisBtn(), findBtn()),
      ...(findShown() ? [el('div', { class: 'v2-find v2-find--apps' }, findInput('세션 찾기'))] : []),
      chips,
      listEl),
    secFoot(footLink('#/app/sessions', 'chat', '세션 이력')));

  listEl.scrollTop = prevScroll;
  keepSideScroll(listEl, 'v2-app-list');
  bindFindKey();
}

// ══ [확인할 것] 구역 (#2016 2차) — 슬랙 '내 활동'의 자리. 답을 기다리는 것과 끝났는데 아직 안 본 것. ══
function renderInboxSide(): void {
  if (!last) return;
  const { host, data } = last;
  const navEl = navRow();
  const navHost = hooks.navHost?.() || null;
  if (navHost) { navHost.querySelector('.v2-side-nav')?.remove(); navHost.prepend(navEl); }
  const live = data.sessions.filter((s) => isLive(s) && !isTrashedSess(s));
  const waits = live.filter((s) => s.stateKey === 'waiting').sort((a, b) => b.lastSeen - a.lastSeen);
  const dones = live.filter((s) => s.stateKey === 'done' && s.owned).sort((a, b) => b.lastSeen - a.lastSeen);
  //  홈·[AI 세션]과 같은 붓(#2033). 여기도 전수가 아니라 **지금 나를 기다리는 것**만 모인 자리라
  //   압정·× 는 안 그린다 — 확인하면 스스로 빠지는 목록이다.
  const items = [
    ...waits.map((s) => sessAsInst(s, false, `답 기다림 · ${waits.length}`)),
    ...dones.map((s) => sessAsInst(s, false, `작업 완료 · ${dones.length}`)),
  ];
  const prevScroll = appListEl ? appListEl.scrollTop : 0;
  const listEl = el('div', { class: 'v2-app-list', role: 'list', 'aria-label': '확인할 것' },
    ...appListKids(items, '', { pin: false, close: false },
      { none: '지금 확인할 것이 없어요. 답을 기다리거나 막 끝난 세션이 여기 모입니다.', found: '' }));
  appListEl = listEl;
  host.replaceChildren(
    ...topBits(navEl, navHost),
    el('section', { class: 'v2-app-space', 'aria-label': '확인할 것' },
      secHead('확인할 것', waits.length + dones.length,
        el('a', { class: 'v2-app-open', href: '#/inbox', title: '받은 알림까지 한 화면에서', 'aria-label': '확인할 것 화면 열기' }, icon('inbox'))),
      listEl),
    secFoot());
  listEl.scrollTop = prevScroll;
  keepSideScroll(listEl, 'v2-app-list');
}

// ══ [프로젝트] 구역 (#2016) — #1883 이전의 프로젝트 트리를 그대로 되살린다. ══════
//  트리 기계(renderTree·projRow·sessRow·binRows)는 지우지 않고 남아 있었다 — 새 구역은 그 자리를 되찾은 것이다.
function renderProjects(): void {
  if (!last) return;
  const { host, data } = last;
  const navEl = navRow();
  const navHost = hooks.navHost?.() || null;
  if (navHost) { navHost.querySelector('.v2-side-nav')?.remove(); navHost.prepend(navEl); }

  const rows = buildRows(data);
  const liveAll = data.sessions.filter(isLive);
  const doneCount = rows.filter((r) => r.proj && r.done && !r.live.length).length;
  const activeN = rows.filter((r) => r.proj && !r.archived).length;
  countEl = el('span', { class: 'v2-k' });
  treeEl = el('div', { class: 'v2-tree' }) as HTMLElement;

  host.replaceChildren(
    ...topBits(navEl, navHost),
    el('section', { class: 'v2-app-space', 'aria-label': '프로젝트' },
      secHead('프로젝트', null, countEl, newBtn(), findBtn(), filterBtn(activeN, liveAll, doneCount)),
      ...(findShown() ? [el('div', { class: 'v2-find v2-find--apps' }, findInput('프로젝트 찾기'))] : []),
      ...(fltCount() ? [filterSummary(fltCount())] : []),
      ...(newOpen ? [newProjRow()] : []),
      treeEl),
    secFoot());

  renderTree(rows);
  keepSideScroll(treeEl, 'v2-tree');
  bindFindKey();
}

// ══ [위키] 구역 (#2016) ══════════════════════════════════════════════════════
//  지식 트리는 v2 가 아직 안 들고 있어서 여기서 한 번 당긴다(카테고리 목록 하나 — 가벼운 조회).
//  누르면 클래식 WIKI 앱이 그 분류로 열린다(`#/knowledge?category=N` — wiki.ts 가 지키는 URL 계약).
interface WikiCat { id: number; space: string; name: string; key: string; knowledge_count?: number }
let wikiCats: WikiCat[] | null = null;
let wikiLoading = false;
const SPACE_LABEL: Record<string, string> = { product: '제품', business: '사업', system: '시스템' };

function loadWikiCats(): void {
  if (wikiCats || wikiLoading) return;
  wikiLoading = true;
  void api('/api/ui/categories').then((d: any) => {
    wikiCats = ((d && d.categories) || []) as WikiCat[];
    wikiLoading = false;
    if (last && (hooks.section?.() || 'home') === 'wiki') redraw();
  }).catch(() => {
    wikiLoading = false;
    wikiCats = [];
    if (last && (hooks.section?.() || 'home') === 'wiki') redraw();
  });
}

function renderWiki(): void {
  if (!last) return;
  const { host } = last;
  const navEl = navRow();
  const navHost = hooks.navHost?.() || null;
  if (navHost) { navHost.querySelector('.v2-side-nav')?.remove(); navHost.prepend(navEl); }
  loadWikiCats();

  const q = sideFilter.trim().toLowerCase();
  const cats = (wikiCats || []).filter((c) => !q || c.name.toLowerCase().includes(q) || String(c.key || '').toLowerCase().includes(q));
  const total = (wikiCats || []).reduce((n, c) => n + (Number(c.knowledge_count) || 0), 0);
  const rows: HTMLElement[] = [];
  for (const space of ['product', 'business', 'system']) {
    const inSpace = cats.filter((c) => c.space === space).sort((a, b) => (Number(b.knowledge_count) || 0) - (Number(a.knowledge_count) || 0));
    if (!inSpace.length) continue;
    rows.push(el('div', { class: 'v2-app-group', role: 'presentation', text: SPACE_LABEL[space] || space }));
    for (const c of inSpace) {
      rows.push(el('a', { class: 'v2-wcat', href: '#/knowledge?category=' + encodeURIComponent(String(c.id)), title: c.name },
        el('span', { class: 'n', text: c.name }),
        el('span', { class: 'v2-cnt', text: String(Number(c.knowledge_count) || 0) })));
    }
  }
  if (!rows.length) {
    rows.push(el('p', { class: 'v2-empty', text: wikiCats ? (q ? '찾는 분류가 없어요.' : '아직 분류가 없어요.') : '불러오는 중…' }));
  }
  const listEl = el('div', { class: 'v2-app-list', 'aria-label': '분류' }, ...rows);
  appListEl = listEl;

  host.replaceChildren(
    ...topBits(navEl, navHost),
    el('section', { class: 'v2-app-space', 'aria-label': '위키' },
      secHead('위키', total || null,
        el('a', { class: 'v2-app-new', href: '#/knowledge/new', 'aria-label': '새 문서', title: '새 문서 — 지식을 하나 씁니다' },
          sv('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d: 'M12 5v14M5 12h14' }))),
        findBtn()),
      ...(findShown() ? [el('div', { class: 'v2-find v2-find--apps' }, findInput('분류 찾기'))] : []),
      el('div', { class: 'v2-fixed v2-fixed--wiki' },
        el('a', { class: 'v2-nav', href: '#/knowledge?indexed=1', title: 'WIKI 인덱스 — 모두가 항상 보는 핀' },
          glyph('folder', 'v2-nav-ic'), el('span', { class: 'n', text: 'WIKI 인덱스' })),
        el('a', { class: 'v2-nav', href: '#/knowledge', title: '지식 전체' },
          glyph('folder-open', 'v2-nav-ic'), el('span', { class: 'n', text: '지식 전체' }))),
      listEl),
    secFoot());

  keepSideScroll(listEl, 'v2-app-list');
  bindFindKey();
}

/** #1883 이전 프로젝트 ▸ 세션 트리. 롤백 비교를 위해 한동안 남기되 현재 셸에서는 호출하지 않는다. */
function renderLegacy(): void {
  if (!last) return;
  // 이름을 고치는 중이면 이번 판은 건너뛴다 — 20초 폴링이 입력 중인 칸을 지우면 치던 이름이 사라진다.
  //  (편집은 blur·Enter·Esc 로 반드시 끝나고, 끝나면 그 경로가 다시 그린다.)
  if (renaming) return;
  const { host, data } = last;
  // 개인 워크스페이스 = 웜 캔버스(안3 문패의 온도축) — 클래스는 사이드바 뿌리(.v2-side)에 건다.
  const wsReg: any = (state.me as any)?.workspace_registry || {};
  const wsKind = (wsReg.active && wsReg.kind) || ((state.me as any)?.workspace?.kind);
  host.closest('.v2-side')?.classList.toggle('ws-personal', wsKind === 'personal');
  // 문패 얼굴 스택 = **세션을 가진 사람들**(나 먼저) — 멤버 명부 순서 그대로면 dev 처럼 더미 계정이 먼저 잡힌다(실측).
  const faceOwners = [...new Set(data.sessions.map((s) => String((s.raw && s.raw.owner) || '')).filter(Boolean))];
  const me = state.me || {};
  const name = String(me.display_name || me.email || me.userId || '');
  const rows = buildRows(data);
  // [필터]의 '세션 상태' 항목은 **트리에 있는 세션 전부**를 센다 — 지난 세션까지(중단됨만 골라 보는 렌즈가 여기서 생긴다).
  const liveAll = rows.flatMap((r) => [...r.live, ...r.past]);
  const livOn = navOn('liv') !== false;
  // 20초 폴링마다 통째로 다시 그린다 — 스크롤 위치와 검색칸 포커스는 이어져야 한다(수백 행에서 매번 맨 위로 튀면 못 쓴다).
  const hadOld = !!treeEl && treeEl.isConnected;
  const anchor = hadOld ? anchorRead() : null;
  const prevScroll = hadOld ? treeEl!.scrollTop : lastScroll;
  const findHad = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('v2-find-in') ? document.activeElement : null;
  const findSel = findHad ? [findHad.selectionStart, findHad.selectionEnd] : null;
  const newHad = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('v2-npj-in') ? document.activeElement : null;
  const newSel = newHad ? [newHad.selectionStart, newHad.selectionEnd] : null;
  countEl = el('span', { class: 'v2-k' });
  treeEl = el('div', { class: 'v2-tree', role: 'tree', 'aria-label': '프로젝트와 세션' });
  const findIn = el('input', { class: 'v2-find-in', type: 'search', placeholder: '프로젝트 찾기', 'aria-label': '프로젝트 찾기', value: sideFilter,
    // 타이핑 중에는 트리만 다시 그린다(전면 재렌더는 포커스·한글 IME 조합을 깬다) → 아이콘 강조는 클래스만 손댄다
    oninput: (e: any) => {
      sideFilter = e.target.value; renderTree(); if (treeEl) treeEl.scrollTop = 0;
      markFind();
    },
    // Esc = 지우고 접는다(검색어가 있으면 한 번 더 눌러야 접힌다 — 실수로 지운 걸 되돌릴 여지를 준다)
    onkeydown: (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (sideFilter) { sideFilter = ''; renderTree(); (e.currentTarget as HTMLInputElement).value = ''; markFind(); }
      else closeFind();
    },
    // 검색어 없이 다른 곳을 누르면 조용히 접힌다 — 빈 칸이 자리를 계속 차지할 이유가 없다
    onblur: () => { if (!sideFilter && findOpen) window.setTimeout(() => { if (!sideFilter) closeFind(); }, 120); } }) as HTMLInputElement;
  const doneCount = rows.filter((r) => r.done).length;
  const fltN = (stateFilter ? 1 : 0) + (mineOnly ? 1 : 0) + (showDone ? 1 : 0);
  // 확인할 것 = 확인 필요(waiting, 보이는 것 전부 — 프로젝트 세션은 팀 누구든 답할 수 있다) + 작업 완료 미열람(내 것만).
  const inboxN = data.sessions.filter((s) => isLive(s) && (s.stateKey === 'waiting' || (s.stateKey === 'done' && s.owned))).length;
  // ⚠ 바로 가기 칸은 **밖에서 잡아 두어야** 한다 — 아래 나눔선(navSplitter)이 이 칸의 높이를 조정한다.
  //  칸을 인라인으로 두면 손잡이가 가리킬 대상을 못 잡는다.
  const navEl = el('nav', { class: 'v2-fixed', 'aria-label': '바로 가기' },
    // [새 작업](원준 2026-08-20) — 홈은 이제 **고정 탭이 아니라 새 탭으로 여는 화면**이다. 그래서 이 줄은
    //  '홈으로 돌아가기'가 아니라 '새 일을 벌이는 자리'이고, 누를 때마다 빈 탭이 하나 열린다(브라우저 ⌘T 문법).
    //  Alt+클릭·가운데클릭과 결이 어긋나지 않도록 href 는 그대로 두고(주소는 여전히 #/), 기본 이동만 가로챈다.
    el('a', { class: 'v2-nav' + (last.activeKey() === 'home' ? ' on' : ''), href: '#/', 'data-nav': 'home',
      title: '새 작업 — 새 탭을 열어 무엇이든 시킵니다.',
      onclick: (e: MouseEvent) => {
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !hooks.onNewTask) return;   // 새 브라우저 탭·셸 새 탭은 원래 동작 그대로
        e.preventDefault();
        hooks.onNewTask();
      } }, glyph('home', 'v2-nav-ic'), el('span', { class: 'n', text: '새 작업' })),
    // 확인할 것(#1719 사이드바 개편 안2) — 답을 기다리는 세션 + 끝났는데 아직 안 본 세션. **사이드바에서 유일하게
    //  숫자 배지를 가진 행**이라 눈이 먼저 간다(슬랙 읽지 않음 문법). 우리 제품의 루프는 시키다→기다리다→확인이고,
    //  그 병목(확인)이 상시 자리를 가져야 "세션은 받은 편지함"(셀프서브 설계)과 화면이 일치한다. 0건이어도 행은
    //  남는다(자리가 사라지면 있다는 것 자체를 잊는다) — 배지만 조용히 사라진다.
    el('a', { class: 'v2-nav' + (last.activeKey() === 'inbox' ? ' on' : ''), href: '#/inbox', 'data-nav': 'inbox',
      title: '확인할 것 — 내 답·확인을 기다리는 세션' }, glyph('inbox', 'v2-nav-ic'), el('span', { class: 'n', text: '확인할 것' }),
      inboxN ? el('span', { class: 'v2-nav-cnt', text: String(inboxN) }) : null),
    // 외부 앱 연결(#1719 원준) — "AI가 내 노션·슬랙을 쓸 수 있나"는 설정이 아니라 **능력**이다. 시키기 전에
    //  알아야 하고 안 되면 그 자리에서 켜야 해서, 관리탭 안쪽이 아니라 여기 상시 자리로 올렸다.
    el('a', { class: 'v2-nav' + (last.activeKey() === 'connect' ? ' on' : ''), href: '#/connect', 'data-nav': 'connect',
      title: '외부 앱 연결 — AI가 내 계정으로 쓸 수 있는 앱' }, glyph('link', 'v2-nav-ic'), el('span', { class: 'n', text: '외부 앱 연결' })),
    ...(livOn ? [el('a', { class: 'v2-nav' + (last.activeKey() === 'liv' ? ' on' : ''), href: '#/liv', 'data-nav': 'liv',
      title: '리브 — 이 워크스페이스를 맡아 보는 담당자' }, el('span', { class: 'v2-nav-lm', text: 'L' }), el('span', { class: 'n', text: '리브' }))] : [])) as HTMLElement;

  host.replaceChildren(
    navRow(),                                     // 맨 위 — 뒤로/앞으로 + 통합검색(상민님 2026-08-20, 클로드 데스크톱 문법)
    switcherTop({ people, faces: faceOwners }),   // 좌상단 워크스페이스 **문패 카드**(#1750 메뉴 + 얼굴 스택) — 여기가 어느 집인지 말하는 자리
    // ⚠ replaceChildren 은 null 을 글자 "null" 로 그린다(el() 과 다르다) — 조건부 자식은 스프레드로.
    navEl,
    // 리브|진행 중 사이의 가로 구분선 = 끌 수 있는 경계. 위로 올리면 세션 목록이 그만큼 길어진다.
    navSplitter(navEl),
    el('div', { class: 'v2-side-sec' }, countEl,
      findBtn(),
      filterBtn(fltN, liveAll, doneCount),
      // [정리](#1719 안 C) — 프로젝트를 여러 개 골라 한 번에 치운다. 219개 중 「진행 중」은 열 몇 개뿐이라,
      //  하나씩 우클릭해서는 정리가 끝나지 않는다. 이 버튼이 그 일을 '한 번에'로 바꾼다.
      tidyBtn(),
      // ＋도 아이콘으로 — 돋보기가 자리를 차지하면서 글자 버튼까지 두면 헤더가 두 줄로 접힌다(#1067 의 🔍/＋ 문법).
      //  누르면 **바로 아래 목록 맨 위에 이름칸 한 줄**이 돋는다(원준 2026-08-21) — 딴 자리에 창을 띄우지 않는다.
      //  이름은 그 자리에서 받는다(빈 판을 먼저 만들고 이름을 나중에 묻는 건 '이름 없는 프로젝트'만 늘린다).
      newBtn()),
    // 검색칸은 돋보기를 눌렀을 때만(#1067 의 방식). 단 **검색어가 남아 있으면 계속 보인다** —
    //  #1154 가 토글을 폐지했던 사유 중 하나가 '검색 중인 줄 모른 채 짧아진 목록을 본다'였다.
    ...(findShown() ? [el('div', { class: 'v2-find' }, findIn)] : []),
    ...(fltN ? [filterSummary(fltN)] : []),
    // 새 프로젝트 줄은 트리 **밖**·바로 위다 — 안에 두면 목록을 스크롤할 때 치던 칸이 위로 사라진다.
    ...(newOpen ? [newProjRow()] : []),
    treeEl!,
    ...(tidyOn ? [tidyBar()] : []),
    // 아카이브·휴지통 두 행(#1851) — 기본은 트리 맨 아래(renderTree 가 붙인다). 사람이 [아래 고정]을 켜면 여기(트리 밖,
    //  스크롤과 무관한 자리)에 선다 — 목록이 수백 행이어도 늘 닿는다.
    ...(binsPinned ? [el('div', { class: 'v2-bins v2-bins-fixed' }, ...binRows(data))] : []),
    el('div', { class: 'v2-side-foot' },
      // 앱 업데이트(#1838) — 데스크톱 앱이 받아 둔 새 버전이 있을 때만 뜬다(브라우저에선 늘 접혀 있다).
      //  발치에 두는 이유: 이 줄은 '보고 있는 것'이 아니라 **이 앱 자체**에 관한 일이라, 계정·클래식 전환과
      //  같은 층이다. 그리고 사이드바는 접히지 않으므로(v2 규약) 어떤 화면을 보고 있어도 늘 눈에 닿는다.
      updateSlot(),
      // 「도구」 — 앱(런치패드)은 콘텐츠가 아니라 도구다. 계정(신원)과 결을 갈라, 푸터가 잡동사니로 읽히지 않게 한다.
      el('div', { class: 'v2-foot-k', text: '도구' }),
      el('button', { class: 'v2-apps-btn', type: 'button', onclick: () => openLaunchpad(), title: '앱 — 아직 새 화면으로 옮기지 않은 것들' }, appIcon('proj', 'v2-apps-ic'), el('span', { text: '앱' }), el('span', { class: 'v2-cnt', text: String(visibleApps().length) })),
      // [나] — 한 줄 전체가 **내 프로필 · 환경설정**을 여는 단추다(#1843, 원준 2026-08-21).
      //  종전엔 이름 옆에 [로그아웃]만 있었고 그 아래로 테마 3단·클래식 링크가 늘어서, 발치가 '내 것'을 모아 둔
      //  자리가 아니라 잡동사니 줄이 되어 있었다. 슬랙·노션·리니어가 다 그렇듯 개인 설정은 **얼굴을 눌러 여는 창**
      //  하나로 모은다 — 테마·클래식 전환·로그아웃은 전부 그 창 안에 있다(v2/me-modal.ts).
      el('div', { class: 'v2-foot-k', text: '나' }),
      el('button', { class: 'v2-me', type: 'button', title: '내 프로필 · 환경설정', 'aria-haspopup': 'dialog',
        onclick: () => openMeModal({ onSaved: () => redraw() }) },
        profileAvatar(me.avatar, name, me.userId, 'v2-ava', { char: me.avatar_char, color: me.avatar_color }),
        el('span', { class: 'v2-me-name', text: name }),
        sv('svg', { viewBox: '0 0 24 24', class: 'v2-me-ic', 'aria-hidden': 'true' },
          sv('path', { d: 'M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z' }),
          sv('path', { d: 'M19.4 13.6a7.6 7.6 0 0 0 0-3.2l1.9-1.4-1.9-3.3-2.2.9a7.7 7.7 0 0 0-2.8-1.6L14 2.5h-4l-.4 2.5a7.7 7.7 0 0 0-2.8 1.6l-2.2-.9L2.7 9l1.9 1.4a7.6 7.6 0 0 0 0 3.2L2.7 15l1.9 3.3 2.2-.9a7.7 7.7 0 0 0 2.8 1.6l.4 2.5h4l.4-2.5a7.7 7.7 0 0 0 2.8-1.6l2.2.9 1.9-3.3z' })))));
  navFit(navEl);            // 붙고 나서야 실제 높이를 알 수 있다 — 저장값을 지금 줄 수에 맞춰 앉힌다
  renderTree(rows);
  // ⚠ 병합 판단(2026-08-25): main 의 keepSideScroll(#288, 08-21 09:48Z)은 여기서 걷는다 — 뒤에 온 이 앵커 방식
  //  (08-21 10:03Z)이 같은 신고를 더 정확히 고치고, 위 주석이 '픽셀 되돌리기는 이 트리에서 어긋난다'는 사유를 남겼다.
  //  그 처방이 막던 구멍(트리가 통째로 새로 생겨 scrollTop 이 0 인 경우)은 아래 lastScroll 이 그대로 맡는다.
  //  ① 보던 줄을 같은 자리에 → ② 그 줄이 사라졌으면 옛 픽셀값으로(그래도 아무것도 안 하는 것보단 낫다).
  if (!anchorApply(anchor)) treeEl!.scrollTop = prevScroll;
  lastScroll = treeEl!.scrollTop;
  treeEl!.addEventListener('scroll', () => { if (treeEl) lastScroll = treeEl.scrollTop; }, { passive: true });
  if (findHad) { findIn.focus(); if (findSel && findSel[0] != null) findIn.setSelectionRange(findSel[0], findSel[1]); }
  else if (findFocusWanted) { findFocusWanted = false; findIn.focus(); }
  // 새 프로젝트 이름칸도 같은 처리 — 20초 폴링이 치던 이름과 커서를 삼키면 못 쓴다.
  const newIn = host.querySelector<HTMLInputElement>('.v2-npj-in');
  if (newIn) {
    if (newHad) { newIn.focus(); if (newSel && newSel[0] != null) newIn.setSelectionRange(newSel[0], newSel[1]); }
    else if (newFocusWanted) { newFocusWanted = false; newIn.focus(); }
  }
  bindFindKey();
}

/** 사이드바 발치의 업데이트 칸 — 자리만 만들고 내용은 desktop-update 가 채운다(받아 둔 게 없으면 접혀 있다).
 *  drawSide 는 사이드바를 통째로 다시 그리므로 이 자리도 매번 새로 난다 — 모듈이 옛 자리를 스스로 정리한다. */
function updateSlot(): HTMLElement {
  const host = el('div', { hidden: true }) as HTMLElement;
  mountDesktopUpdate(host, 'row');
  return host;
}

// ── 돋보기 = 검색칸 여닫기 (#1067 의 방식을 되살리되 #1154 의 반려 사유 둘을 설계로 막는다) ──
//  ⓐ "있는 줄도 모른다" → 돋보기 **아이콘 자체는 늘 보인다**(헤더 고정 자리) + 어디서든 `/` 키로 열린다 +
//     검색 중이면 아이콘이 켜진 상태로 남고 지우는 [×] 가 붙는다.
//  ⓑ "사이드바를 접으면 닿을 길이 없다" → 새 셸 사이드바는 통째로 접히지 않는다(손잡이 최소 200px).
//     클래식 프로젝트 보드(접힘 레일 없음)와 다른 조건이라 그 사유는 여기 해당하지 않는다.
let findFocusWanted = false;
const findShown = (): boolean => findOpen || !!sideFilter;
// 검색 중이면 돋보기를 켠 색으로 — 전면 재렌더 없이 클래스만(재렌더는 포커스·한글 IME 조합을 깬다)
function markFind(): void { const fb = document.querySelector('.v2-findbtn'); if (fb) fb.classList.toggle('has', !!sideFilter); }
function openFind(): void { findOpen = true; findFocusWanted = true; redraw(); }
function closeFind(): void { if (!findOpen && !sideFilter) return; findOpen = false; sideFilter = ''; redraw(); }
// `/` 한 번으로 열린다 — 글자를 치던 중이면(입력칸·편집영역) 가로채지 않는다.
function bindFindKey(): void {
  if (keyBound) return;
  keyBound = true;
  document.addEventListener('keydown', (e) => {
    // Esc = 정리 끝내기. 모드는 나가는 길이 분명해야 한다 — 버튼 제목이 Esc 를 약속하므로 실제로 되게 한다.
    if (e.key === 'Escape' && tidyOn) { e.preventDefault(); setTidy(false); return; }
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    if (!last) return;
    e.preventDefault();
    openFind();
  });
}
// ── 「정리」 모드 ────────────────────────────────────────────────────────────
//  켜면 프로젝트 행이 **고르는 줄**이 된다(누르면 열리는 대신 체크). 발치에 고른 개수와 [아카이브로]가 뜬다.
//  아이콘은 Lucide 의 list-checks(ISC) — 손으로 그리지 않는다(핀·서비스 로고와 같은 규율).
function tidyBtn(): HTMLElement {
  const b = el('button', {
    class: 'v2-flt-btn v2-tidyb' + (tidyOn ? ' on' : ''), type: 'button', 'aria-pressed': String(tidyOn),
    'aria-label': tidyOn ? '정리 끝내기' : '정리 — 여러 개 골라 한 번에',
    title: tidyOn ? '정리 끝내기 (Esc)' : '정리 — 프로젝트를 여러 개 골라 한 번에 아카이브로 보냅니다',
  }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-flt-ic', 'aria-hidden': 'true' },
    sv('path', { d: 'M13 5h8m-8 7h8m-8 7h8' }), sv('path', { d: 'M3 17l2 2l4-4' }), sv('path', { d: 'M3 7l2 2l4-4' })));
  b.onclick = (e: Event) => { e.preventDefault(); setTidy(!tidyOn); };
  return b;
}

function setTidy(on: boolean): void {
  tidyOn = on;
  if (!on) tidySel.clear();   // 끄면 고른 것도 비운다 — 안 보이는 선택이 남아 있으면 다음에 켤 때 놀란다
  redraw();
}

/** 고른 프로젝트를 한 번에 아카이브로. 확인은 **한 번만** 받는다 — N번 물으면 그건 '한 번에'가 아니다. */
async function tidyArchive(): Promise<void> {
  if (!last || !tidySel.size) return;
  const rows = buildRows(last.data).filter((r) => r.proj && tidySel.has(r.key));
  if (!rows.length) { setTidy(false); return; }
  const myLiveN = rows.reduce((n, r) => n + r.live.filter(isMine).length, 0);
  const names = rows.slice(0, 3).map((r) => r.proj!.name).join(' · ') + (rows.length > 3 ? ` 외 ${rows.length - 3}개` : '');
  if (!await confirmDialog({
    title: `프로젝트 ${rows.length}개를 아카이브로 보낼까요?`, danger: myLiveN > 0,
    confirmText: '아카이브로', cancelText: '취소',
    message: myLiveN > 0
      ? `지금 돌고 있는 내 세션 ${myLiveN}개는 그 자리에서 멈추고 지난 세션이 됩니다.`
      : '고른 프로젝트와 그 아래 세션이 사이드바·보드에서 빠집니다.',
    lines: [names, '태스크·팀원·지식 연결·세션 기록은 전부 그대로예요.', '[아카이브] 화면에서 언제든 되돌릴 수 있어요.'],
    note: '지우는 것이 아닙니다 — 되돌릴 수 있어요.',
  })) return;
  let done = 0;
  const failed: string[] = [];
  for (const r of rows) {
    const p = r.proj!;
    try {
      // 내 도는 세션을 먼저 멈춘다(단건 보관과 같은 순서) — 남의 세션은 건드릴 수 없어 그대로 둔다.
      for (const sx of r.live.filter(isMine)) {
        const q = '?reclaim=1' + (sx.node ? '&node=' + encodeURIComponent(sx.node) : '');
        try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(sx.id) + q, { method: 'DELETE' }); } catch (_) { /* 아래 보관은 계속 */ }
      }
      await api('/api/ui/v6/projects/' + p.id + '/archive', { method: 'POST', body: JSON.stringify({ archived: true }) });
      done++;
    } catch (e: any) { failed.push(p.name); }
  }
  // ⚠ 단건과 달리 **[아카이브] 화면으로 데려가지 않는다** — 정리는 이어서 하는 일이라, 여기 남아야 다음 것을 고른다.
  toast(failed.length
    ? `${done}개를 보냈고 ${failed.length}개는 못 보냈어요 — ${failed[0]}${failed.length > 1 ? ' 외' : ''}`
    : `${done}개를 아카이브로 보냈어요 — 발치 [아카이브]에서 볼 수 있어요`, failed.length > 0);
  setTidy(false);
  hooks.onArchived?.();
}

/** 발치의 정리 막대 — 켜져 있을 때만. 고른 개수와 동작이 늘 눈에 보여야 '모드에 갇힌' 느낌이 안 든다.
 *  ⚠ 고를 때마다 트리 전체를 다시 그리지 않는다(수백 행이다) — 이 막대와 그 행 하나만 제자리에서 고친다. */
let tidyBarEl: HTMLElement | null = null;
function tidyBar(): HTMLElement {
  const bar = el('div', { class: 'v2-tidybar' }) as HTMLElement;
  tidyBarEl = bar;
  paintTidyBar();
  return bar;
}
function paintTidyBar(): void {
  if (!tidyBarEl) return;
  const n = tidySel.size;
  const go = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: n > 1 ? `${n}개를 아카이브로` : '아카이브로' }) as HTMLButtonElement;
  if (!n) go.disabled = true;
  go.onclick = () => void tidyArchive();
  tidyBarEl.replaceChildren(
    el('span', { class: 'v2-tidybar-k', text: n ? `${n}개 선택됨` : '정리할 프로젝트를 고르세요' }),
    go,
    el('button', { class: 'btn-text', type: 'button', text: '끝내기', onclick: () => setTidy(false) }));
}

// ── 바로 가기 칸의 아래 경계 = 끌 수 있는 나눔선(원준 2026-08-24) ────────────────
//  "세션을 보여줄 수 있는 길이를 더 길게 하고 싶다 — 리브와 진행 중 사이 가로 구분선을 잡아 위로 올려서,
//   확인할 것까지 숨겨질 만큼 올라갔다가 자석처럼 착 붙게. 대신 새 작업 버튼은 보일 수 있을 때까지."
//  그래서 범위는 [새 작업 한 줄, 네 줄 전부]다. 아래로 다 내리면 지금 화면 그대로, 위로 다 올리면
//  세션 목록이 그 높이(실측 149px ≈ 세션 네 줄)만큼 길어진다.
//  ⚠ **0(완전히 감추기)까지 가지 않는다** — 다 감추면 되돌릴 손잡이만 남고 여기가 무슨 자리였는지 사라진다.
//   「새 작업」 한 줄이 늘 남으면 그 줄이 곧 '여기가 바로 가기 칸'이라는 표식이자 되돌아오는 길이다.
const NAV_SPLIT_KEY = 'side-nav';
const NAV_MIN = 40;          // 「새 작업」 한 줄(34) + 아래 여백(6)
const NAV_SNAP = 14;         // 손끝이 이 안에 들어오면 착 붙는다(자석)

const navNatural = (nav: HTMLElement): number => (nav.scrollHeight > 0 ? nav.scrollHeight : 149);
const navSnap = (px: number, nat: number): number =>
  (px <= NAV_MIN + NAV_SNAP ? NAV_MIN : px >= nat - 12 ? nat : px);

/** 저장된 값(또는 기본=전부 펼침)을 지금 칸 높이에 맞춰 앉힌다 — 줄 수가 바뀌어도(리브 off) 어긋나지 않게. */
function navFit(nav: HTMLElement): void {
  const nat = navNatural(nav);
  nav.style.setProperty('--v2-navh', Math.min(readSplit(NAV_SPLIT_KEY, nat), nat) + 'px');
}

function navSplitter(nav: HTMLElement): HTMLElement {
  //  ⚠ 제 클래스를 하나 더 붙인다 — 이 손잡이가 앉는 자리(사이드바 패널 안)는 선택자로 집기 어렵고,
  //   자리로 고르면(.v2-side > …) 패널 구조가 바뀌는 순간 조용히 스타일이 빠진다.
  const h = makeSplitter({
    axis: 'y', key: NAV_SPLIT_KEY, cssVar: '--v2-navh', target: nav,
    def: 9999,                                   // 기본 = 전부 펼침(아래 max 가 자연 높이로 깎는다)
    min: NAV_MIN, max: () => navNatural(nav),
    grow: 1,                                     // 손잡이 위쪽 칸이 조정 대상 — 위로 끌면 줄어든다
    label: '바로 가기 칸 높이 — 위로 올리면 세션 목록이 길어집니다',
    // 자석: 끄는 동안에도 붙여 보여 준다(놓고 나서야 붙으면 그건 자석이 아니라 보정이다).
    onDrag: (px) => { const v = navSnap(px, navNatural(nav)); if (v !== px) nav.style.setProperty('--v2-navh', v + 'px'); },
    onEnd: (px) => { writeSplit(NAV_SPLIT_KEY, nav, '--v2-navh', navSnap(px, navNatural(nav))); },
  });
  h.classList.add('v2-navsplit');
  return h;
}
// ── ＋ 새 프로젝트 — **목록 맨 위에 한 줄이 돋는다**(원준 2026-08-21) ──────────────────────
//  종전엔 ＋를 누르면 화면 오른쪽에 팝오버가 떴다. 하는 일은 '이 목록에 줄 하나 더하기'인데 묻는 자리가
//  목록 밖이라, 어디에 무엇이 생기는지가 끊겼다(원준 2026-08-21 "뜬금없이 오른쪽에 팝업"). 그래서 창을 걷고,
//  **프로젝트 줄과 같은 폴더 아이콘·같은 자리**에 빈 이름칸을 세운다 — 치고 Enter 를 누르면 그 줄이 진짜가 된다.
//  안내문·[만들기] 버튼도 걷었다: 줄 하나 만드는 일에 설명 두 줄과 버튼은 과하다(placeholder 가 이미 말한다).
let newOpen = false;          // 잠깐의 상태라 브라우저에 기억하지 않는다(＋를 다시 누르거나 Esc 로 접힌다)
let newDraft = '';            // 20초 폴링 재렌더가 치던 이름을 지우지 않게 — 검색칸과 같은 이유
let newSending = false;
let newErr = '';
let newFocusWanted = false;

function openNew(): void { newOpen = true; newFocusWanted = true; newErr = ''; redraw(); }
function closeNew(): void { if (!newOpen) return; newOpen = false; newDraft = ''; newErr = ''; redraw(); }

function newBtn(): HTMLElement {
  const b = el('button', {
    class: 'v2-add' + (newOpen ? ' on' : ''), type: 'button', 'aria-label': '새 프로젝트', 'aria-expanded': String(newOpen),
    title: newOpen ? '새 프로젝트 줄 접기' : '새 프로젝트 — 목록 맨 위에 이름칸이 생깁니다',
    onclick: (e: Event) => { e.preventDefault(); if (newOpen) closeNew(); else openNew(); },
  }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-add-ic', 'aria-hidden': 'true' }, sv('path', { d: 'M12 5v14M5 12h14' })));
  return b;
}

/** 목록 맨 위의 '새 프로젝트' 줄 — 폴더 아이콘 + 이름칸. Enter 로 만들고 곧바로 그 작업대로 간다. */
function newProjRow(): HTMLElement {
  const errEl = el('p', { class: 'v2-npj-err', hidden: !newErr, text: newErr });
  const inp = el('input', {
    class: 'v2-npj-in', type: 'text', maxlength: '120', value: newDraft,
    placeholder: '새 프로젝트 이름을 적고 Enter', 'aria-label': '새 프로젝트 이름',
    oninput: (e: any) => { newDraft = e.target.value; if (newErr) { newErr = ''; errEl.hidden = true; } },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeNew(); return; }
      // 한글(IME) 조합 중의 Enter 는 **조합 확정**이지 제출이 아니다. 그 확정 Enter 와 뒤이은 진짜 Enter 가
      //  잇달아 들어와 create() 가 두 번 돌았고, 같은 이름의 프로젝트가 **같은 밀리초에 두 개** 만들어졌다
      //  (실측 2026-08-20: #1818/#1819 · #1806/#1807 · #1812/#1813 — 전부 한글로 끝나는 이름).
      //  아래 newSending 가드와 이중 방어(둘 다 실측 사고의 원인).
      if (e.key !== 'Enter' || e.isComposing || (e as unknown as { keyCode?: number }).keyCode === 229) return;
      e.preventDefault(); void create();
    },
    // 빈 칸으로 딴 데를 누르면 조용히 접힌다(검색칸과 같은 규칙) — 치던 이름이 있으면 줄을 남겨 둔다.
    onblur: () => window.setTimeout(() => { if (newOpen && !newSending && !newDraft.trim()) closeNew(); }, 120),
  }) as HTMLInputElement;
  const line = el('div', { class: 'v2-npj-l' + (newSending ? ' sending' : '') },
    el('span', { class: 'v2-car none', 'aria-hidden': 'true' }),
    glyph('folder', 'v2-pj-ic'),
    inp);
  const create = async (): Promise<void> => {
    const name = newDraft.trim();
    // 재진입 가드는 둔다 — 이 줄은 만들면 그 작업대로 **떠나므로** 연달아 적는 줄이 아니다(그래서 잠금이 아니라 가드).
    if (newSending) return;
    if (!name) { inp.focus(); return; }
    newSending = true; newErr = ''; errEl.hidden = true;
    // ⚠ 입력칸을 disabled 로 **잠그지 않는다**(인라인 추가행 규약 — 왕복 350ms 가 그대로 '멈춤'으로 온다).
    //  다시 그리지도 않는다: 여기서 redraw 하면 치던 칸이 새로 나면서 포커스가 끊긴다. 흐리게만 알린다.
    line.classList.add('sending');
    try {
      const np = await api('/api/ui/v6/projects', { method: 'POST', body: JSON.stringify({ name }) }).then((d: any) => (d && d.project) || d);
      if (!np || !np.id) throw new Error('생성 응답에 프로젝트가 없어요');
      newSending = false; newOpen = false; newDraft = ''; newErr = '';
      location.hash = '#/p/' + np.id;       // 그 작업대로(목록 갱신은 라우터가 새 프로젝트를 보고 알아서 당긴다)
      redraw();
    } catch (err: any) {
      newSending = false;
      line.classList.remove('sending');
      newErr = '만들지 못했어요 — ' + (err?.message || err);
      errEl.textContent = newErr; errEl.hidden = false;
      inp.focus();                          // 고쳐 쓸 수 있게 이름칸으로 손을 돌려준다(친 이름은 그대로 남는다)
    }
  };
  return el('div', { class: 'v2-npj' }, line, errEl);
}
// ── 사이드바 맨 윗줄 — [←][→] + [통합검색] (상민님 2026-08-20 "클로드 데스크탑 앱처럼") ──────────────
//  왜 여기인가: 데스크톱 앱에서 맨 위 줄은 이제 **탭 줄**이 가져갔고(창 버튼과 같은 줄), 탐색 도구는
//  내용(프로젝트·세션)보다 위, 문패보다도 위 — '이 워크스페이스 안에서 움직이는 손잡이'라 목록의 일부가 아니다.
//  웹(브라우저)에서도 같은 자리다: 브라우저 뒤로가기와 겹쳐 보여도, 앱 안에서 손이 닿는 자리가 하나 있어야 한다.
//  검색은 **칸처럼 생긴 버튼**이다 — 진짜 입력칸을 두면 사이드바 20초 재렌더가 입력을 끊는다(트리 검색칸이
//  포커스·IME 를 지키느라 치르는 비용을 하나 더 만들지 않는다). 눌리면 화면 가운데 스포트라이트가 뜬다.
function navArrow(dir: 'back' | 'fwd', on: boolean, run?: () => void): HTMLElement {
  const d = dir === 'back' ? 'M14 6l-6 6 6 6' : 'M10 6l6 6-6 6';
  return el('button', {
    class: 'v2-navb', type: 'button', disabled: !on || !run,
    title: dir === 'back' ? '뒤로' : '앞으로', 'aria-label': dir === 'back' ? '뒤로 가기' : '앞으로 가기',
    onclick: () => run?.() },
    sv('svg', { viewBox: '0 0 24 24', class: 'v2-navb-ic', 'aria-hidden': 'true' }, sv('path', { d })));
}
function navRow(): HTMLElement {
  const st = hooks.navState ? hooks.navState() : { back: true, forward: true };
  // 표기는 플랫폼을 따른다 — 맥이 아닌데 ⌘K 라고 적어 두면 눌러도 안 열린다(같은 키를 두 이름으로 배우게 된다).
  //  맥이 아니면 **Alt+K** 를 적는다: Ctrl+K 도 먹지만 터미널이 포커스면 안 먹는다(그건 셸의 kill-line 이다).
  //  '거의 되는 키'를 적어 두면 안 될 때 고장으로 읽히므로, 화면에는 **어디서나 되는 쪽**을 적는다.
  const mac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');
  //  #2016 — 레일 여닫기는 슬랙처럼 **맨 윗줄 맨 왼쪽**의 패널 아이콘이다. 데스크톱(navHost 있음)은 창 맨 윗줄의
  //   그 자리를 mobile.menuBtn 이 이미 차지하고 있어(같은 아이콘, 같은 동작) 여기선 브라우저에서만 그린다.
  const railHid = !!hooks.railHidden?.();
  const railBtn = hooks.onToggleRail && !hooks.navHost?.()
    ? el('button', {
        class: 'v2-navb v2-railtg' + (railHid ? ' hid' : ''), type: 'button', 'aria-expanded': String(!railHid),
        title: (railHid ? '레일 펼치기' : '레일 숨기기') + ' — ⌘⇧S', 'aria-label': railHid ? '레일 펼치기' : '레일 숨기기',
        onclick: () => hooks.onToggleRail?.() },
        icon('panel', 'v2-navb-ic'))
    : null;
  return el('div', { class: 'v2-side-nav' },
    railBtn,
    navArrow('back', st.back, hooks.onBack),
    navArrow('fwd', st.forward, hooks.onForward),
    el('button', {
      class: 'v2-omnib', type: 'button',
      title: mac ? '통합검색 — 지식 · 프로젝트 · 자료 · 세션 · 세션 이력을 한 번에 (⌘K)'
        : '통합검색 — 지식 · 프로젝트 · 자료 · 세션 · 세션 이력을 한 번에 (Alt+K, 터미널 밖에서는 Ctrl+K 도)',
      'aria-label': '통합검색 열기', onclick: () => hooks.onSearch?.() },
      sv('svg', { viewBox: '0 0 24 24', class: 'v2-omnib-ic', 'aria-hidden': 'true' },
        sv('circle', { cx: '11', cy: '11', r: '6.5' }), sv('path', { d: 'M16 16l4.5 4.5' })),
      el('span', { class: 'v2-omnib-t', text: '검색' }),
      el('kbd', { class: 'v2-omnib-k', text: mac ? '⌘K' : 'Alt K' })));
}
/** 화살표 둘의 켜짐만 갱신한다 — 이동할 때마다 사이드바를 통째로 다시 그리지 않게(markFind 와 같은 규칙). */
export function markNav(st: { back: boolean; forward: boolean }): void {
  const row = document.querySelector('.v2-side-nav');
  if (!row) return;
  //  #2016 — 맨 왼쪽의 레일 여닫기(.v2-railtg)는 뒤로·앞으로가 아니다. 같은 붓(.v2-navb)을 쓰지만 여기서 빼지 않으면
  //   첫 단추로 잡혀 '뒤로 갈 곳 없음'에 함께 꺼진다(실측: disabled 가 붙어 눌러도 아무 일도 안 났다).
  const btns = Array.from(row.querySelectorAll<HTMLButtonElement>('.v2-navb:not(.v2-railtg)'));
  if (btns[0]) btns[0].disabled = !st.back || !hooks.onBack;
  if (btns[1]) btns[1].disabled = !st.forward || !hooks.onForward;
}

/**
 * 묶는 축 토글(#2033) — 머리글의 아이콘 하나(폴더 + 그 아래 들여쓴 줄 둘 = '프로젝트 밑으로 묶기').
 *  칩 두 개(「세션」「프로젝트」)로 밖에 내지 않은 이유: 세로 한 줄을 먹는다 — #1954 가 「새 작업」 큰 버튼을
 *  머리글의 ＋ 로 줄인 것과 같은 사유다(목록이 세로를 더 쓰는 게 이 화면의 이득이다).
 */
function axisBtn(): HTMLElement {
  return el('button', {
    class: 'v2-axisbtn' + (groupProj ? ' on' : ''), type: 'button', 'aria-pressed': String(groupProj),
    'aria-label': groupProj ? '세션으로 풀어 보기' : '프로젝트로 묶어 보기',
    title: groupProj ? '지금은 프로젝트로 묶는 중 — 눌러서 세션으로 풀기' : '프로젝트로 묶기 — 같은 목록을 프로젝트별로 접어 봅니다',
    onclick: () => {
      groupProj = !groupProj;
      try { if (groupProj) localStorage.setItem(GROUP_STORE, 'proj'); else localStorage.removeItem(GROUP_STORE); }
      catch (_) { /* 못 남겨도 이번 화면은 된다 */ }
      redraw();
    } },
    //  그림은 하나다 — 켜짐/꺼짐은 **채움**이 말한다(켜지면 파랑을 채운다). 두 얼굴로 바꾸면
    //   '지금 이 상태'인지 '누르면 이렇게 된다'인지가 애매해진다.
    icon('group', 'v2-axisbtn-ic')) as HTMLElement;
}

function findBtn(): HTMLElement {
  const on = findShown();
  return el('span', { class: 'v2-findbtn-wrap' },
    el('button', {
      class: 'v2-findbtn' + (on ? ' on' : '') + (sideFilter ? ' has' : ''), type: 'button',
      'aria-label': on ? '열린 앱 찾기 닫기' : '열린 앱 찾기', 'aria-expanded': String(on),
      title: on ? '닫기 (Esc)' : '열린 앱 찾기 — / 키로도 열려요',
      onclick: () => { if (findShown()) closeFind(); else openFind(); } },
      sv('svg', { viewBox: '0 0 24 24', class: 'v2-findbtn-ic', 'aria-hidden': 'true' },
        sv('circle', { cx: '11', cy: '11', r: '6.5' }), sv('path', { d: 'M16 16l4.5 4.5' }))));
}

// [필터] 버튼 + 팝오버 — 조작부는 여기 다 모인다. 목록 표면에는 필터가 없다(켜져 있으면 요약 한 줄만).
function filterBtn(activeN: number, liveAll: Sess[], doneCount: number): HTMLElement {
  const counts = new Map<string, number>();
  for (const s of liveAll) counts.set(s.stateKey, (counts.get(s.stateKey) || 0) + 1);
  if (stateFilter && !counts.has(stateFilter)) counts.set(stateFilter, 0);   // 켜 둔 상태가 0이 돼도 끌 수 있게 남긴다
  const keys = [...counts.keys()].sort((a, b) => rankOf(a) - rankOf(b));
  const wrap = el('div', { class: 'v2-flt' });
  const btn = el('button', {
    class: 'v2-flt-btn' + (activeN ? ' has' : '') + (filterOpen ? ' open' : ''), type: 'button',
    'aria-haspopup': 'true', 'aria-expanded': String(filterOpen), 'aria-label': '필터 — 보기 조건',
    title: '필터 — 보기 조건(상태·범위·완료)',
    onclick: (e: Event) => { e.stopPropagation(); filterOpen = !filterOpen; redraw(); } },
    sv('svg', { viewBox: '0 0 24 24', class: 'v2-flt-ic', 'aria-hidden': 'true' }, sv('path', { d: 'M4 6h16M7 12h10M10 18h4' })),
    // ⚠ 「필터」 **글자를 두지 않는다**(원준 2026-08-24). 실측: 글자가 있는 이 버튼 하나가 60px 인데 아이콘
    //  버튼은 27px 이다 — 글자 하나 값이 아이콘 둘보다 크다. [정리]를 넷째로 들이려면 이 60px 을 내놓아야
    //  하고, 그러면 넷이 되고도 머리줄이 지금보다 6px 좁아진다(114 → 108).
    //  대신 **켜진 개수는 배지로** 남긴다 — 글자를 빼면서 '지금 걸러져 있다'는 신호까지 잃으면 안 된다.
    activeN ? el('b', { class: 'v2-flt-n', text: String(activeN) }) : null);
  wrap.append(btn);
  if (filterOpen) {
    const opt = (on: boolean, label: string, cnt: string, dot: string | null, onclick: () => void) =>
      el('button', { class: 'v2-fo' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on), onclick },
        dot ? el('span', { class: 'v2-dot ' + dot, 'aria-hidden': 'true' }) : el('span', { class: 'v2-fo-pad', 'aria-hidden': 'true' }),
        el('span', { class: 'n', text: label }), cnt ? el('span', { class: 'v2-cnt', text: cnt }) : null,
        on ? el('span', { class: 'v2-fo-ck', text: '✓', 'aria-hidden': 'true' }) : null);
    wrap.append(el('div', { class: 'v2-flt-pop', role: 'menu', onclick: (e: Event) => e.stopPropagation() },
      el('div', { class: 'v2-flt-k', text: '세션 상태' }),
      opt(!stateFilter, '전체', '', null, () => { stateFilter = null; redraw(); }),
      ...keys.map((k) => opt(stateFilter === k, stLabel(k), String(counts.get(k) || 0), dotCls(k),
        () => { stateFilter = stateFilter === k ? null : k; redraw(); })),
      el('div', { class: 'v2-flt-k', text: '범위' }),
      opt(mineOnly, '내 프로젝트만', '', null, () => { mineOnly = !mineOnly; saveFlag(MINE_KEY, mineOnly); redraw(); }),
      opt(showDone, '완료 프로젝트도 보기', doneCount ? String(doneCount) : '', null, () => { showDone = !showDone; saveFlag(DONE_KEY, showDone); redraw(); }),
      el('div', { class: 'v2-flt-foot' },
        el('button', { class: 'btn-text', type: 'button', text: '전부 지우기', onclick: () => { stateFilter = null; mineOnly = false; showDone = false; saveFlag(MINE_KEY, false); saveFlag(DONE_KEY, false); redraw(); } }),
        el('button', { class: 'btn-text', type: 'button', text: '닫기', onclick: () => { filterOpen = false; redraw(); } }))));
    if (!outsideBound) {
      outsideBound = true;
      document.addEventListener('click', (e) => {
        if (filterOpen && !(e.target as HTMLElement | null)?.closest?.('.v2-flt')) { filterOpen = false; redraw(); }
      });
    }
  }
  return wrap;
}
// 필터가 켜져 있을 때만 나오는 한 줄 — 무엇으로 걸러 보고 있는지 + 한 번에 끄기.
function filterSummary(n: number): HTMLElement {
  const bits: string[] = [];
  if (stateFilter) bits.push(stLabel(stateFilter) + ' 세션만');
  if (mineOnly) bits.push('내 프로젝트만');
  if (showDone) bits.push('완료 포함');
  return el('div', { class: 'v2-flt-sum' }, el('span', { text: bits.join(' · ') }),
    el('button', { class: 'btn-text', type: 'button', text: '지우기', title: `필터 ${n}개를 끕니다`,
      onclick: () => { stateFilter = null; mineOnly = false; showDone = false; saveFlag(MINE_KEY, false); saveFlag(DONE_KEY, false); redraw(); } }));
}

// 트리(프로젝트 ▸ 세션) — 검색은 여기만 다시 그린다(입력칸 포커스를 잃지 않게).
function renderTree(rowsIn?: Row[]): void {
  if (!last || !treeEl) return;
  const rows = rowsIn || buildRows(last.data);
  const activeKey = last.activeKey();
  // 지금 보는 프로젝트 — 프로젝트 화면이면 그것, 세션 화면이면 그 세션이 붙은 프로젝트(없으면 '프로젝트 없는 세션' 묶음).
  let selectedPk = activeKey.startsWith('p:') ? activeKey : '';
  if (activeKey.startsWith('s:')) {
    const sid = activeKey.slice(2);
    const s = last.data.sessions.find((x) => x.id === sid) || last.data.sessions.find((x) => x.logId === sid);
    selectedPk = s ? 'p:' + (s.projectId || 0) : '';
  }
  // ★ 한 번 펴진 프로젝트는 **사람이 접을 때까지** 펴져 있다(원준 2026-08-24: "프로젝트 누르면 자동으로 열렸다가 다른 프로젝트 누르면
  //  다시 사라지는데 너무 불편함"). 종전엔 '선택된 것만 펼침'이라 선택이 옮겨 가는 순간 앞 프로젝트가 접혔다 — 폴더를 오가며
  //  세션을 비교하는 흐름이 매번 끊겼다. 선택으로 펴진 것도 사람이 편 것과 같이 openSet 에 남긴다(접는 건 캐럿뿐).
  //  일부러 접어 둔 선택(closedSelected)은 그대로 존중한다.
  if (selectedPk && !closedSelected.has(selectedPk) && !openSet.has(selectedPk)) {
    const r = rows.find((x) => x.key === selectedPk);
    if (r && (r.live.length || r.past.length)) { openSet.add(selectedPk); saveSet(OPEN_KEY, openSet); }
  }
  const q = sideFilter.trim().toLowerCase();
  const hit = (r: Row) => !q || (r.proj ? (r.proj.name.toLowerCase().includes(q) || String(r.proj.id) === q) : '프로젝트 없는 세션'.includes(q));
  const stateOf = (r: Row) => (stateFilter ? r.live.filter((s) => s.stateKey === stateFilter) : r.live);
  const pastOf = (r: Row) => (stateFilter ? r.past.filter((s) => s.stateKey === stateFilter) : r.past);
  let hiddenDone = 0;
  const shown = rows.filter((r) => {
    if (!hit(r)) return false;
    // 보관한 프로젝트(#1851)는 트리에 없다 — 「아카이브」 화면이 그 자리다. 단 **도는 세션이 있으면** 보인다(완료 프로젝트와
    //  같은 예외): 답을 기다리는 세션을 아카이브가 감추면 그게 곧 사고다(보관 해제 없이 그 세션을 끝낼 길이 있어야 한다).
    if ((r.archived || r.trashed) && !r.live.length) return false;   // 휴지통(#1851)도 같은 예외 — 도는 세션이 남아 있으면(남의 것) 보인다
    if (mineOnly && !r.mine) return false;
    if (stateFilter && !stateOf(r).length && !pastOf(r).length) return false;
    if (r.done && !showDone && !r.live.length && !isPinned(r.key)) { hiddenDone++; return false; }
    return true;
  }).sort((a, b) => Number(isPinned(b.key)) - Number(isPinned(a.key)) || b.lastWork - a.lastWork || String((b.proj && b.proj.updated_at) || '').localeCompare(String((a.proj && a.proj.updated_at) || '')));
  // ── 진행 중 / 전체 프로젝트 (#1719 사이드바 개편 안2) ─────────────────────────
  //  매일 쓰는 화면은 「진행 중」(도는 세션이 있는 프로젝트 + 압정 고정)만이다 — dev 실측으로 4~6개.
  //  나머지 수백 개는 「전체 프로젝트 · N」 한 줄 뒤로 접는다(노션이 Favorites 를 먼저 놓고 전체 트리를 뒤로
  //  미는 문법). ⚠ **검색·필터가 켜져 있으면 가르지 않는다** — 찾으려고 건 렌즈를 묶음이 가리면 안 된다.
  //  그때는 종전처럼 한 목록이다('완료 포함'도 렌즈로 취급).
  const splitting = !q && !stateFilter && !mineOnly && !showDone;
  //  갓 만든 프로젝트(fresh)도 여기 선다 — 아직 도는 세션이 없다고 접힌 묶음에 숨기면 만든 사람이 못 찾는다.
  const isActiveRow = (r: Row) => isPinned(r.key) || r.live.length > 0 || r.fresh;
  const activeRows = splitting ? shown.filter(isActiveRow) : shown;
  const restRows = splitting ? shown.filter((r) => !isActiveRow(r)) : [];
  if (countEl) countEl.textContent = splitting
    ? `진행 중 · ${activeRows.length}`
    : `프로젝트 · ${shown.filter((r) => r.proj).length}${q || mineOnly || stateFilter ? ` / ${rows.filter((r) => r.proj && !r.archived && (showDone || !r.done || r.live.length)).length}` : ''}`;
  const kids: HTMLElement[] = activeRows.map((r) => projRow(r, stateOf(r), pastOf(r), activeKey, selectedPk));
  const firstLoose = activeRows.findIndex((r) => !isPinned(r.key));
  if (firstLoose > 0 && kids[firstLoose]) kids[firstLoose].classList.add('after-pins');
  if (splitting && !activeRows.length && last.data.loadedAt) {
    kids.push(el('p', { class: 'v2-tree-note', text: '지금 도는 세션이 없어요. 아래 전체 프로젝트에서 이어서 하거나, 홈에서 새로 시키세요.' }));
  }
  if (splitting) {
    // 「전체 프로젝트」 머리 — 누르면 그 자리에서 펴진다(기억됨). 완료 프로젝트는 펴도 종전 규칙대로 숨김(맨 아래 more).
    // 카운트는 **펴면 보이는 것만** 센다 — 완료 프로젝트(수백)는 펴도 '숨긴 완료 N개 보기' 뒤에 있으므로
    //  여기 합치면 라벨(539)과 목록(205)이 어긋난다(실측). 완료는 그 버튼이 제 숫자를 말한다.
    const totalN = restRows.length;
    kids.push(el('button', {
      class: 'v2-all-h' + (allOpen ? ' open' : ''), type: 'button', 'aria-expanded': String(allOpen),
      title: allOpen ? '전체 프로젝트 접기' : '진행 중이 아닌 프로젝트까지 모두 폅니다',
      onclick: () => { allOpen = !allOpen; renderTree(); } },
      el('span', { class: 'v2-car', 'aria-hidden': 'true', text: '›' }),
      el('span', { class: 'n', text: '전체 프로젝트' }), el('span', { class: 'v2-cnt', text: String(totalN) })));
    if (allOpen) kids.push(...restRows.map((r) => projRow(r, stateOf(r), pastOf(r), activeKey, selectedPk)));
  }
  if (!kids.length) {
    kids.push(!last.data.loadedAt ? el('p', { class: 'v2-tree-note', text: '불러오는 중…' }) : !last.data.projects.length
      ? el('p', { class: 'v2-tree-note', text: '아직 프로젝트가 없어요. 가운데 입력창에 무엇이든 시키면 세션이 열리고, 프로젝트는 나중에 붙일 수 있어요.' })
      : el('div', { class: 'v2-tree-note' }, el('span', { text: '조건에 맞는 프로젝트가 없어요.' }),
        el('button', { class: 'btn-text', type: 'button', text: '필터 지우기', onclick: () => { sideFilter = ''; stateFilter = null; mineOnly = false; saveFlag(MINE_KEY, false); redraw(); } })));
  }
  // 숨긴 완료 N개 — 전체 묶음이 접혀 있으면 그 안의 일이라 보이지 않는 게 맞다(펴면 맨 아래).
  if (hiddenDone && (!splitting || allOpen)) kids.push(el('button', { class: 'v2-tree-more', type: 'button', text: `숨긴 완료 프로젝트 ${hiddenDone}개 보기`, onclick: () => { showDone = true; saveFlag(DONE_KEY, true); redraw(); } }));
  // 아카이브·휴지통(#1851) — 트리 맨 아래 두 행(검색·필터 중에도 남는다: 치워 둔 것을 찾는 길이 렌즈에 가려지면 안 된다).
  //  발치에 고정해 두었으면 여기엔 없다(render() 가 트리 밖에 세운다).
  //  #2016 — 새 셸(구역이 있는 쪽)에서는 발치 도크가 아카이브·휴지통을 든다. 트리 안에 또 세우면 같은 문이 둘이다.
  if (!binsPinned && !hooks.section) kids.push(el('div', { class: 'v2-bins' }, ...binRows(last.data)));
  treeEl.replaceChildren(...kids);
}

// ── 아카이브 · 휴지통 행(#1851) ───────────────────────────────────────────────
//  두 행은 프로젝트 행과 같은 모양(아이콘 + 이름 + 개수)이되 **폴더가 아니다** — 누르면 오른쪽에 그 화면이 열린다
//  (#/archive: 보관한 프로젝트와 그 아래 세션 목록 · #/trash: 버린 세션·삭제된 프로젝트, 되돌리기·완전 삭제).
//  오른쪽 끝 압정 = [아래 고정] — 켜면 두 행이 트리 밖 발치에 서서 스크롤과 무관하게 늘 보인다(브라우저에 기억).
function binRows(data: V2Data): HTMLElement[] {
  const me = meId();
  const archivedN = data.projects.filter((p) => isArchivedProj(p) && !isTrashedProj(p)).length;
  // 휴지통 개수 = 통째로 버린 프로젝트(각 1) + **따로** 버린 내 세션(묶음 세션은 프로젝트 안에 든 것이라 안 센다). 세션은 소유자 단위.
  const trashedN = data.projects.filter((p) => isTrashedProj(p)).length
    + data.sessions.filter((s) => isLooseTrashedSess(s) && (s.owned || (!!me && String((s.raw && s.raw.owner) || '') === me))).length;
  const ak = last ? last.activeKey() : '';
  const row = (key: 'archive' | 'trash', label: string, n: number, title: string): HTMLElement =>
    el('a', { class: 'v2-bin' + (ak === key ? ' on' : ''), href: '#/' + key, 'data-nav': key, title },
      glyph(key, 'v2-bin-ic'), el('span', { class: 'n', text: label }), n ? el('span', { class: 'v2-cnt', text: String(n) }) : null,
      binPinBtn());
  return [
    row('archive', '아카이브', archivedN, '아카이브 — 통째로 보관한 프로젝트와 그 아래 세션'),
    row('trash', '휴지통', trashedN, '휴지통 — 버린 프로젝트·세션을 되돌리거나 완전히 지웁니다'),
  ];
}
function binPinBtn(): HTMLElement {
  const on = binsPinned;
  return el('button', { class: 'v2-pinb v2-bin-pin' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on),
    'aria-label': on ? '아래 고정 해제' : '아래에 고정', title: on ? '아래 고정 해제 — 목록 맨 아래로 돌아갑니다' : '아래에 고정 — 목록을 내려도 늘 보입니다',
    onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); binsPinned = !binsPinned; saveFlag(BINS_KEY, binsPinned); redraw(); } },
    sv('svg', { viewBox: '0 0 24 24', class: 'v2-pinb-ic', 'aria-hidden': 'true' },
      sv('path', { d: PIN_NEEDLE }), sv('path', { d: PIN_BODY })));
}

function projRow(r: Row, sess: Sess[], past: Sess[], activeKey: string, selectedPk: string): HTMLElement {
  const p = r.proj;
  const pk = r.key;
  // 프로젝트 없는 세션도 **작업대(캔버스)** 로 간다(#/p/0) — 옛 AI 세션 앱이 아니라(원준 2026-08-19).
  //  자투리 세션들이 그 판에 카드로 모여 거기서 바로 대화·열기가 된다.
  const href = p ? '#/p/' + p.id : '#/p/0';
  const isOn = activeKey === pk;
  // 펼침 기본값(#1719 재구성): **선택된 프로젝트만 펼침**, 나머지는 접힘 — 사용자가 편 것만 그대로.
  //  선택을 일부러 접은 건 이 페이지 수명만 기억한다(다음 방문엔 다시 펼쳐 보인다 — 선택은 늘 보이는 게 기본).
  //  ⚠ 상태 필터가 켜져 있으면 편다 — 걸러 놓고 접혀 있으면 "0개"로 보인다(찾으려고 건 필터가 감추는 꼴).
  const isSel = pk === selectedPk;
  const has = sess.length + past.length;
  const isOpen = has > 0 && (stateFilter ? true : (isSel ? !closedSelected.has(pk) : openSet.has(pk)));
  const caret = has
    ? el('button', { class: 'v2-car', type: 'button', 'aria-label': isOpen ? '접기' : '펼치기', 'aria-expanded': String(isOpen), text: '›', onclick: (e: Event) => {
      e.preventDefault(); e.stopPropagation();
      if (isSel) {
        if (isOpen) closedSelected.add(pk); else closedSelected.delete(pk);
        saveSet(SELCLOSED_KEY, closedSelected);   // 접은 결정을 새로고침 너머로 지킨다
      }
      if (isOpen) openSet.delete(pk); else openSet.add(pk);
      saveSet(OPEN_KEY, openSet); renderTree(); } })
    : el('span', { class: 'v2-car none', 'aria-hidden': 'true' });
  // '지난 세션' 묶음 — 도는 세션 아래에 접힌 한 줄. 상태 필터로 지난 상태를 골랐으면 이미 그걸 보러 온 것이니 편다.
  //  ⚠ 필터 때문에 저절로 펴지는 길은 **걸러 놓은 그 상태가 지난 세션 안에 실제로 있을 때**로 좁힌다.
  //   종전엔 '필터가 켜져 있고 도는 세션이 없으면' 이었다 — 그래서 '확인 필요'(도는 상태)로 걸러도
  //   멈춘 세션만 있는 프로젝트들의 묶음이 우수수 펼쳐졌다. 걸러 놓은 것이 그 안에 없으면 펼 이유가 없다.
  const pastHasFiltered = !!stateFilter && past.some((s) => s.stateKey === stateFilter);
  const pastOpen = past.length > 0 && (pastSet.has(pk) || (pastHasFiltered && !sess.length));
  const tipBits = p
    ? [`#${p.id} · ${p.status_category === 'done' ? '완료' : p.status_category === 'unstarted' ? '시작 전' : '진행 중'}`, r.lastWork ? '마지막 작업 ' + when(r.lastWork) : '세션 없음', r.mine ? '내 프로젝트' : (p.created_by ? `${(people[p.created_by] && people[p.created_by].display_name) || p.created_by} 만듦` : '')]
    : ['프로젝트에 붙지 않은 세션 — 이 세션들의 작업대를 엽니다'];
  // 이름은 언제나 같은 잉크색이다 — 완료·조용함은 태그·시각이 말한다(연회색 본문이 목록 절반이면 전체가 바래 보인다).
  const row = el('a', { class: 'v2-pj-row' + (isOn ? ' on' : ''), href, 'data-nav': pk, title: (p ? p.name + '\n' : '') + tipBits.filter(Boolean).join(' · ') + '\n프로젝트 화면을 엽니다' + (p ? '\n이름을 더블클릭하면 그 자리에서 고칠 수 있어요' : '') },
    caret, glyph(isOpen ? 'folder-open' : 'folder', 'v2-pj-ic'), el('span', { class: 'n', text: p ? p.name : '프로젝트 없는 세션' }),
    r.trashed ? el('span', { class: 'v2-tag', text: '휴지통', title: '휴지통에 있는 프로젝트 — 도는 세션이 있어 보입니다' }) : r.archived ? el('span', { class: 'v2-tag', text: '보관됨', title: '아카이브에 있는 프로젝트 — 도는 세션이 있어 보입니다' }) : r.done ? el('span', { class: 'v2-tag', text: '완료' }) : null,
    sumEl(sess, past) || (r.lastWork ? el('span', { class: 'v2-pj-when', text: when(r.lastWork) }) : null),
    p ? newSessBtn(p.id) : null,
    p ? pinBtn(pk) : null);
  // 정리 모드에서는 이 줄이 **여는 줄이 아니라 고르는 줄**이 된다. 링크 자체는 그대로 두고(주소·새 탭 문법 보존)
  //  기본 이동만 가로챈다 — 모드를 끄면 아무 흔적 없이 원래대로 돌아온다.
  //  ⚠ 「프로젝트 없는 세션」(p 없음)은 보관할 대상이 아니라 고를 수 없다 — 체크칸도 만들지 않는다.
  if (p && tidyOn) {
    row.classList.add('v2-pick');
    if (tidySel.has(pk)) row.classList.add('sel');
    row.setAttribute('aria-selected', String(tidySel.has(pk)));
    row.insertBefore(el('span', { class: 'v2-ck', 'aria-hidden': 'true' },
      sv('svg', { viewBox: '0 0 24 24', class: 'v2-ck-ic' }, sv('path', { d: 'M5 12.5l4.5 4.5L19 7.5' }))), row.firstChild);
    row.addEventListener('click', (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey) return;          // ⌘클릭으로 새 탭에 여는 길은 남긴다
      e.preventDefault(); e.stopPropagation();
      if (tidySel.has(pk)) tidySel.delete(pk); else tidySel.add(pk);
      const on = tidySel.has(pk);
      row.classList.toggle('sel', on);
      row.setAttribute('aria-selected', String(on));
      paintTidyBar();                              // 트리는 그대로 두고 이 줄과 막대만 고친다
    });
  }
  // 우클릭 = 이 프로젝트의 조작 메뉴(#1851) — 아카이브로 보내기/해제·고정·새 세션. 행에 단추를 더 얹지 않는다(이미 둘이다).
  if (p) row.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    ctxMenu(e.clientX, e.clientY, [
      { label: '새 세션', run: () => hooks.onNewSession?.(p.id) },
      { label: isPinned(pk) ? '고정 해제' : '위에 고정', run: () => togglePin(pk) },
      { sep: true, label: '' },
      r.archived
        ? { label: '보관 해제 — 원래 자리로', run: () => void setArchived(p, false, 0) }
        : { label: '아카이브로 보내기', run: () => void setArchived(p, true, r.live.filter(isMine).length) },
      // 삭제 = 휴지통으로(#1851 원준 2026-08-24). 폴더 우클릭 메뉴의 맨 아래·위험색 — 파일 탐색기·노션과 같은 자리.
      { sep: true, label: '' },
      { label: '휴지통으로 보내기', danger: true, run: () => void trashProject(p, r) },
    ]);
  });
  // 세션 줄과 같은 손짓 — 더블클릭하면 그 자리에서 이름을 고친다(문패 제목 클릭과 같은 편집).
  if (p) row.addEventListener('dblclick', (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); beginRenameProject(pk, p); });
  const head = sess.slice(0, MAX_SESS);
  const pastHead = past.slice(0, MAX_SESS);
  const list = has ? el('div', { class: 'v2-ss-list', role: 'group', hidden: !isOpen },
    ...head.map((s) => sessRow(s, activeKey, sessText(s, p ? p.name : ''))),
    sess.length > MAX_SESS ? el('a', { class: 'v2-ss-more', href, text: `외 ${sess.length - MAX_SESS}개` }) : null,
    past.length ? pastHead2(pk, past.length, pastOpen) : null,
    ...(pastOpen ? pastHead.map((s) => sessRow(s, activeKey, sessText(s, p ? p.name : ''), true)) : []),
    pastOpen && past.length > MAX_SESS ? el('a', { class: 'v2-ss-more', href, text: `외 ${past.length - MAX_SESS}개` }) : null) : null;
  return el('div', { class: 'v2-pj' + (isOpen ? ' open' : ''), role: 'treeitem', 'aria-expanded': has ? String(isOpen) : null }, row, list);
}

// '지난 세션 n' — 멈춘 세션을 **한 줄로 접어** 둔다. 펴면 그 자리에 그대로 나온다(사라지지 않는다, #1808).
//  도는 세션과 같은 레일·같은 들여쓰기 — 위계가 아니라 묶음이라는 뜻이다.
function pastHead2(pk: string, n: number, open: boolean): HTMLElement {
  return el('button', {
    class: 'v2-ss-past' + (open ? ' open' : ''), type: 'button', 'aria-expanded': String(open),
    title: open ? '지난 세션 접기' : `멈춘 세션 ${n}개 — 열면 그때 대화를 이어서 계속할 수 있어요`,
    onclick: (e: Event) => {
      e.preventDefault(); e.stopPropagation();
      if (pastSet.has(pk)) pastSet.delete(pk); else pastSet.add(pk);
      renderTree();   // 저장하지 않는다 — 이 페이지 동안만 편 채로 둔다
    } },
    el('span', { class: 'v2-car', 'aria-hidden': 'true', text: '›' }),
    el('span', { class: 'n', text: '지난 세션' }), el('span', { class: 'v2-cnt', text: String(n) }));
}

// ＋ 새 세션 — 프로젝트 이름 줄에 손을 얹으면 나타난다(원준 2026-08-20).
//  종전엔 새 세션을 열려면 **먼저 그 프로젝트로 들어가** 문패의 [＋ 세션]을 눌러야 했다. 목록에서 곧장 시작하는 길을
//  하나 더 둔다 — 누르면 그 프로젝트 화면이 '새 세션 자리'로 열린다(들어가서 누르는 것과 같은 자리로 간다).
//  자리는 늘 차지하고 보이기만 토글한다(핀과 같은 규칙 — 나타나며 행을 밀면 목록 전체가 흔들린다).
function newSessBtn(projectId: number): HTMLElement {
  return el('button', {
    class: 'v2-newb', type: 'button', 'aria-label': '이 프로젝트에서 새 세션 열기',
    title: '새 세션 — 이 프로젝트에 붙은 AI 세션을 엽니다',
    onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); hooks.onNewSession?.(projectId); } },
    sv('svg', { viewBox: '0 0 24 24', class: 'v2-newb-ic', 'aria-hidden': 'true' }, sv('path', { d: 'M12 5v14M5 12h14' })));
}

// 고정 단추 — 자리는 늘 차지한다(눌러야 보이는 것이 나타나며 행을 밀면 목록 전체가 흔들린다).
//  고정된 것은 늘 보이고, 아닌 것은 그 행에 손을 얹었을 때만 보인다.
/** 앱 인스턴스 고정 — 사람이 고른 것만 맨 위로. 자동으로 뭘 올려 두지 않는다(#1954). */
export function isAppPinned(key: string): boolean { return appPinned.has(key); }

/** 문패 카드가 쓰는 사람 지도 — side.ts 가 이미 한 번 당겨 둔 것을 레일도 함께 쓴다(두 번 당기지 않는다). */
export function sidePeople(): Record<string, any> { return people; }
function toggleAppPin(key: string): void {
  if (appPinned.has(key)) appPinned.delete(key); else appPinned.add(key);
  saveSet(APP_PIN_STORE, appPinned);
  hooks.onPinChanged?.();
  redraw();
}

function pinBtn(pk: string): HTMLElement {
  const on = isPinned(pk);
  return el('button', { class: 'v2-pinb' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on),
    'aria-label': on ? '고정 해제' : '위에 고정', title: on ? '고정 해제' : '위에 고정 — 맨 위로 올려 둡니다',
    onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); togglePin(pk); } },
    sv('svg', { viewBox: '0 0 24 24', class: 'v2-pinb-ic', 'aria-hidden': 'true' },
      sv('path', { d: PIN_NEEDLE }), sv('path', { d: PIN_BODY })));
}

// 프로젝트 행 오른쪽 — 숫자를 늘어놓지 않는다. **볼 일이 있는 것만**: 확인 필요(호박)·작업 중(파랑).
//  그 밖의 살아 있는 세션은 개수 하나(회색). 상태별 전체 분포는 [필터] 팝오버가 보여 준다.
function sumEl(sess: Sess[], past: Sess[] = []): HTMLElement | null {
  const part = (n: number, cls: string, label: string) => (n ? el('span', { class: 'v2-sum ' + cls, title: `${label} ${n}` }, el('span', { class: 'v2-dot ' + cls, 'aria-hidden': 'true' }), String(n)) : null);
  // 도는 게 하나도 없는 프로젝트 — 오른쪽 자리를 '지난 세션 n'이 받는다(#1808). 종전엔 시각만 떠서 **이어서 할 게
  //  있다는 사실 자체가 화면에 없었다**. 도는 세션이 있으면 종전 그대로(급한 것만) — 숫자를 늘어놓지 않는다.
  if (!sess.length) return past.length ? el('span', { class: 'v2-sums', 'aria-label': `지난 세션 ${past.length}` }, part(past.length, 'past', '지난 세션')) : null;
  const c = { wait: 0, busy: 0, rest: 0 };
  for (const s of sess) { if (s.stateKey === 'waiting') c.wait++; else if (s.stateKey === 'busy') c.busy++; else c.rest++; }
  return el('span', { class: 'v2-sums', 'aria-label': `세션 ${sess.length}` }, part(c.wait, 'wait', '확인 필요'), part(c.busy, 'busy', '작업 중'),
    (!c.wait && !c.busy && c.rest) ? el('span', { class: 'v2-sum idle', title: `살아 있는 세션 ${c.rest}` }, String(c.rest)) : null);
}

// 세션 행 — 상태점 · 세션을 실제로 구분해 주는 글(sessText) · 남의 세션이면 소유자 얼굴 · 상태어.
function sessRow(s: Sess, activeKey: string, text: { main: string; sub: string }, pastRow = false): HTMLElement {
  const st = SESS_STATES[s.stateKey];
  const cls = dotCls(s.stateKey);
  const raw = s.raw || {};
  const owner = ownerName(s);
  // 프로젝트명 반복을 걷어낸 뒤의 이름·'지금 하는 일'(하네스 pane 제목 = 클래식 카드의 💬 줄).
  //  끝난 세션은 트리에 없으니 '마지막으로 하던 일'로 읽어도 틀리지 않는다.
  const main = text.main;
  const sub = text.sub;
  const tip = [s.label, sub || (raw.title && String(raw.title) !== s.label ? String(raw.title) : ''), `${st ? st.label : s.stateLabel}${s.lastSeen ? ' · ' + when(s.lastSeen) : ''}`, s.owned ? '내 세션' : `${owner}의 세션`, raw.harness ? String(raw.harness) : '', s.node ? '노드 ' + s.node : ''].filter(Boolean).join('\n');
  // 이름 자리 — 더블클릭하면 그 자리에서 고친다(원준 2026-08-20). 고친 이름은 서버로 가고 탭·대화창까지 따라온다.
  const nameEl = el('span', { class: 't', text: main });
  const row = el('a', { class: 'v2-ss-row' + (activeKey === 's:' + s.id ? ' on' : '') + (s.owned ? '' : ' other') + (pastRow ? ' past' : ''), href: '#/s/' + encodeURIComponent(s.id), 'data-nav': 's:' + s.id, title: tip + (pastRow ? '\n열면 그때 대화를 읽고 [이어서 대화하기]로 계속할 수 있어요' : '\n세션 대화를 엽니다\n이름을 더블클릭하면 그 자리에서 고칠 수 있어요'), role: 'treeitem' },
    el('span', { class: 'v2-dot ' + cls, 'aria-hidden': 'true' }),
    el('span', { class: 'v2-ss-main' }, nameEl),
    isMine(s) ? null : personFace(String(raw.owner || ''), 'v2-ss-face', owner),
    // 오른쪽 끝은 **한 자리**로 고정한다 — 상태어를 조건부로 넣으면 행마다 길이가 달라 목록이 들쭉날쭉해진다(상민님 2026-08-18).
    //  상태는 왼쪽 점이, 개수는 프로젝트 행이 말한다. 여기는 '누르면 대화로 간다'는 표식만(hover 때 보인다).
    //  ⚠ 지난 세션 묶음은 그 한 자리를 **'언제'**가 받는다 — 멈춘 것들을 고르는 축은 시간이고(어제 것인가 3주 전 것인가),
    //   묶음 안 모든 행이 똑같이 시각을 가지므로 '행마다 길이가 달라진다'는 그 규칙의 사유엔 걸리지 않는다.
    //  ⚠ 돌고 있는 세션의 그 자리엔 **보관(×) 하나만** 둔다 — 종전엔 장식용 말풍선(누르면 대화로 간다)이 ×
    //   바로 옆에 같이 떠서, 뜻 없는 아이콘이 조작 단추와 섞여 보였다(상민님 2026-08-19).
    pastRow ? el('span', { class: 'w', text: when(s.lastSeen) }) : null,
    // 보관(×) — **도는 세션에만**(지난 세션은 이미 거기 있다), **내 세션에만**(서버도 소유자만 허용).
    //  자리는 늘 차지한다(hover 때만 보인다) — 나타나며 행을 밀면 목록이 흔들린다(압정과 같은 규약).
    //  지난 세션의 그 자리엔 **휴지통**(#1851) — 도는 세션 → × → 지난 세션 → 휴지통 → (휴지통 안에서) 완전 삭제의 사슬.
    !pastRow && isMine(s) ? archiveBtn(s) : pastRow && isMine(s) ? trashBtn(s) : null);
  if (isMine(s)) row.addEventListener('dblclick', (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); beginRename(nameEl, s); });
  return row;
}

// ── 이름 인라인 편집 — 세션 줄과 프로젝트 줄이 **같은 편집기**를 쓴다(원준 2026-08-24) ──────
//  ⚠ 세션은 이름 자리에 그려진 글(main)이 **원래 이름이 아닐 수 있다** — sessText 가 프로젝트명 되풀이를 걷어내고
//   pane 제목·첫 지시를 그 자리에 올리기 때문이다(#1808). 그래서 편집칸의 초기값은 화면 글이 아니라
//   **진짜 이름**(세션 s.label · 프로젝트 p.name)이다. 그리지 않은 것을 고치게 하면 사용자는 자기가 안 쓴 글을 지우게 된다.
let renaming = false;
function inlineRename(nameEl: HTMLElement, cfg: { value: string; label: string; save: (next: string) => Promise<void> }): void {
  if (renaming) return;
  renaming = true;
  const shown = nameEl.textContent || '';
  const input = el('input', { class: 'v2-ss-edit', type: 'text', value: cfg.value || shown, 'aria-label': cfg.label }) as HTMLInputElement;
  nameEl.replaceChildren(input);
  input.focus(); input.select();
  let done = false;
  const finish = async (save: boolean): Promise<void> => {
    if (done) return; done = true; renaming = false;
    const next = input.value.trim();
    if (!save || !next || next === cfg.value) { nameEl.replaceChildren(document.createTextNode(shown)); return; }
    nameEl.replaceChildren(document.createTextNode(next));
    try { await cfg.save(next); }
    catch (e: any) { toast((e && e.message) || '이름을 바꾸지 못했습니다', true); nameEl.replaceChildren(document.createTextNode(shown)); }
  };
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    e.stopPropagation();                                   // '/' 검색 단축키·Esc 사이드바 핸들러가 가로채지 않게
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
  });
  input.addEventListener('blur', () => { void finish(true); });
  input.addEventListener('click', (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); });   // 편집 중 클릭이 행 이동으로 새지 않게
}
function beginRename(nameEl: HTMLElement, s: Sess): void {
  inlineRename(nameEl, { value: String(s.label || nameEl.textContent || ''), label: '세션 이름', save: async (next) => { await hooks.onRenameSession?.(s.id, next); } });
}
/** 프로젝트 줄 더블클릭 — 첫 클릭이 그 프로젝트로 **이동시키며 트리를 다시 그리므로**, 잡아 둔 노드가 아니라
 *  지금 화면에 서 있는 그 줄을 다시 찾아 연다(옛 노드에 열면 아무 일도 안 일어난 것처럼 보인다). */
function beginRenameProject(pk: string, p: Proj): void {
  const nameEl = document.querySelector<HTMLElement>('.v2-pj-row[data-nav="' + pk + '"] .n');
  if (!nameEl) return;
  inlineRename(nameEl, { value: String(p.name || ''), label: '프로젝트 이름', save: async (next) => { await hooks.onRenameProject?.(Number(p.id), next); } });
}

// ── 보관(×) — 세션을 '지난 세션'으로 보낸다 ──────────────────────────────────
//  DELETE …?reclaim=1 = tmux 만 내리고 복원 좌표(desired-state)는 남긴다 → 그 프로젝트의 '지난 세션'에 쌓이고
//  열면 [이어서 대화하기] 로 그대로 살아난다. **완전 삭제가 아니다** — 그래서 문구도 '보관'이라고 말한다.
const ARCHIVE_ACK_KEY = 'lively_v2_archive_ack';   // '1' = 안내를 다시 띄우지 않음(사용자가 체크)
function archiveBtn(s: Sess): HTMLElement {
  const btn = el('button', {
    class: 'v2-ss-x', type: 'button', 'aria-label': s.label + ' 보관(지난 세션으로)',
    title: '지난 세션으로 보내기 — 지금 실행만 멈추고, 나중에 열어서 이어서 할 수 있어요',
  }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-ss-x-ic', 'aria-hidden': 'true' }, sv('path', { d: 'M6 6l12 12M18 6L6 18' })));
  btn.addEventListener('click', (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    void doArchive(s);
  });
  return btn;
}
async function doArchive(s: Sess): Promise<void> {
  let ack = false;
  try { ack = localStorage.getItem(ARCHIVE_ACK_KEY) === '1'; } catch (_) { /* noop */ }
  if (!ack) {
    // '다시 보지 않기' 는 **확인을 누른 경우에만** 저장한다 — 취소하고 닫았는데 다음부터 말없이 보관되면 사고다.
    const again = el('input', { type: 'checkbox', id: 'v2-arch-ack' }) as HTMLInputElement;
    const extra = el('label', { class: 'v2-arch-ack', for: 'v2-arch-ack' }, again, el('span', { text: '다시 안내하지 않기' }));
    const ok = await confirmDialog({
      title: '지난 세션으로 보낼까요?',
      message: '지금 돌고 있는 것만 멈춥니다. 대화는 그대로 보관돼요.',
      lines: [
        '이 세션은 프로젝트 아래 [지난 세션] 묶음으로 들어갑니다.',
        '나중에 열어서 [이어서 대화하기] 를 누르면 그때 대화 그대로 다시 시작합니다.',
      ],
      note: '지우는 것이 아닙니다 — 되돌릴 수 있어요.',
      confirmText: '지난 세션으로', extra,
    });
    if (!ok) return;
    if (again.checked) { try { localStorage.setItem(ARCHIVE_ACK_KEY, '1'); } catch (_) { /* noop */ } }
  }
  try {
    const q = '?reclaim=1' + (s.node ? '&node=' + encodeURIComponent(s.node) : '');
    await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + q, { method: 'DELETE' });
    toast('지난 세션으로 보냈어요 — 열면 이어서 할 수 있습니다');
    //  id 를 넘긴다 — 받는 쪽이 **서버 되읽기를 기다리지 않고** 이 세션을 곧바로 지난 세션으로 옮긴다.
    //  종전엔 되읽기만 했는데, tmux 종료가 목록 API 에 반영되기까지 시차가 있어 몇 초 동안 그대로 살아 있는
    //  것처럼 보였다(원준 2026-08-21 "새로고침해야 이동한다").
    hooks.onArchived?.(s.id);
  } catch (e: any) { toast((e && e.message) || '보관하지 못했습니다', true); }
}


// ── 휴지통으로(#1851) — 지난 세션 행의 오른쪽 끝. 잃는 것은 없다(표식만) — 창은 '휴지통으로 보낸다'고 말한다(완전 삭제 창과 다르다). ──
function trashBtn(s: Sess): HTMLElement {
  const btn = el('button', {
    class: 'v2-ss-x v2-ss-trash', type: 'button', 'aria-label': s.label + ' 휴지통으로',
    title: '휴지통으로 보내기 — 목록에서 빠지고, 휴지통에서 되돌리거나 완전히 지울 수 있어요',
  }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-ss-x-ic', 'aria-hidden': 'true' },
    sv('path', { d: 'M4 7h16' }), sv('path', { d: 'M9 7V4h6v3' }), sv('path', { d: 'M6 7l1 13h10l1-13' })));
  btn.addEventListener('click', (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); void doTrash(s); });
  return btn;
}

async function doTrash(s: Sess): Promise<void> {
  const name = sessText(s, '').main || s.label || s.id;
  if (!await confirmSessionTrash({ title: `「${name}」${eulReul(name)} 휴지통으로 보낼까요?` })) return;
  try {
    const r = await sessionTrashOp('trash', sessionNames(s));
    if (r.skipped.length && !r.done.length) { toast(r.skipped[0].why || '휴지통으로 보내지 못했습니다', true); return; }
    toast('휴지통으로 보냈어요 — 휴지통에서 되돌릴 수 있어요');
    hooks.onArchived?.();
  } catch (e: any) { toast((e && e.message) || '휴지통으로 보내지 못했습니다', true); }
}

// ── 프로젝트 휴지통(#1851, 원준 2026-08-24) — 폴더를 버리듯: 프로젝트 + 그 아래 내 세션(도는 것은 멈춰서)이 **한 묶음**으로 휴지통에.
//  서버(project_trash_v6)가 세션을 멈추고 묶음 표식을 달고 프로젝트를 표시한다. 남의 도는 세션이 있으면 서버가 409 로 막는다 —
//  확인창이 그 사실을 미리 말한다(눌러 보고 실패하지 않게). 끝나면 휴지통 화면으로(어디로 갔는지 보이게).
export async function trashProject(p: Proj, r?: { live: Sess[]; past: Sess[] }): Promise<void> {
  const all = last ? last.data.sessions.filter((s) => Number(s.projectId) === p.id && !isTrashedSess(s)) : [];
  const mine = all.filter(isMine);
  const liveMine = mine.filter(isLive).length;
  const othersLive = all.filter((s) => isLive(s) && !isMine(s)).length;
  void r;
  if (!await confirmProjectTrash({ name: p.name, sessN: mine.length, liveN: liveMine, othersLive })) return;
  if (othersLive > 0) return;   // 확인창이 이미 '지금은 안 된다'고 말했다 — 서버 409 를 굳이 맞지 않는다
  try {
    const res: any = await api('/api/ui/v6/projects/' + p.id + '/trash', { method: 'POST', body: JSON.stringify({ trashed: true }) });
    const sk = Array.isArray(res?.sessions?.skipped) ? res.sessions.skipped : [];
    toast('휴지통으로 보냈어요 — 휴지통에서 [복원]하면 세션까지 함께 돌아와요' + (sk.length ? ` (세션 ${sk.length}개는 건너뜀 — ${sk[0].why})` : ''));
    hooks.onArchived?.();
    location.hash = '#/trash';
  } catch (e: any) { toast((e && e.message) || '휴지통으로 보내지 못했습니다', true); }
}

// ── 프로젝트 아카이브(#1851) — 통째로 보관. 내 도는 세션은 먼저 멈춘다(지난 세션으로). 남의 세션은 건드릴 수 없어 그대로 두고,
//  그런 프로젝트는 트리에 '보관됨' 태그를 달고 남는다(renderTree 의 예외). 끝나면 아카이브 화면으로 데려간다(어디로 갔는지 보이게).
async function setArchived(p: Proj, archived: boolean, myLiveN: number): Promise<void> {
  if (archived && !await confirmProjectArchive({ name: p.name, liveN: myLiveN })) return;
  try {
    if (archived && last) {
      const mine = last.data.sessions.filter((s) => Number(s.projectId) === p.id && isLive(s) && isMine(s));
      for (const s of mine) {
        const q = '?reclaim=1' + (s.node ? '&node=' + encodeURIComponent(s.node) : '');
        try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + q, { method: 'DELETE' }); }
        catch (e: any) { toast(`「${sessText(s, p.name).main}」을(를) 멈추지 못했어요 — ${(e && e.message) || e}`, true); }
      }
    }
    await api('/api/ui/v6/projects/' + p.id + '/archive', { method: 'POST', body: JSON.stringify({ archived }) });
    toast(archived ? '아카이브로 보냈어요 — 사이드바 아래 [아카이브]에서 볼 수 있어요' : '보관을 해제했어요 — 원래 자리로 돌아왔어요');
    hooks.onArchived?.();
    if (archived) location.hash = '#/archive';
  } catch (e: any) { toast((e && e.message) || (archived ? '아카이브로 보내지 못했습니다' : '보관을 해제하지 못했습니다'), true); }
}

