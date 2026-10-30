// #4180 「확인할 것」 다시 설계 — **배선**을 못박는다(회의 2026-09-21 상민·원준).
//
//  ① 세션 알림은 확인할 것에서 뺀다 — 스윕은 kind 'session' 으로 보내고, 화면·종은 inbox 렌즈로 읽고, 배너만 all 렌즈.
//  ② 입구는 레일 구역이 아니라 **홈의 종** — 레일 SECTIONS 에 inbox 가 없고, 홈 머리줄이 notifyBell() 을 세우고, 셸이 그 시계를 켠다.
//  ③ 폰 아래 탭에도 없다 — 대신 [더보기] 판에 한 줄.
//  ④ 알림에 내용이 실린다 — 행의 앞자리(누가·무엇이) · 댓글 스토어가 알림을 부른다 · 리브의 답이 전이 자리에서 남는다.
//
// ⚠ 왜 소스 텍스트를 보나: 이건 값이 아니라 배선의 성질이다(scripts/notification-banner-scope.test.mjs 와 같은 규율).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name, detail) => { assert.ok(cond, detail ? `${name}\n${detail}` : name); pass++; console.log(`ok  ${name}`); };

const RAIL = read("web/v2/rail.ts");
const VIEWS = read("web/v2/views.ts");
const MAIN = read("web/v2/main.ts");
const MOBILE = read("web/v2/mobile.ts");
const NOTI = read("web/v2/notifications.ts");
const BELL = read("web/v2/notify-bell.ts");
const SWEEP = read("src/sessions/awaiting-notifier.ts");
const STORE = read("src/org/store/app-notifications.ts");
const TASKS = read("src/v6/task-detail-store.ts");
const KNOW = read("src/v6/knowledge-comment-store.ts");
const ROUTES = read("src/terminal/routes.ts");

// ① 세션 알림은 확인할 것에서 빠진다
ok(/kind:\s*"session"/.test(SWEEP), "①a ai-session 스윕은 kind 'session' 으로 보낸다(배너 전용)");
ok(/INBOX_HIDDEN_KINDS/.test(STORE) && /scope/.test(STORE), "①b 스토어 목록·개수·읽음이 렌즈(scope)로 거른다");
ok(/scope: 'inbox'/.test(VIEWS), "①c 「확인할 것」 화면은 inbox 렌즈로 읽는다");
ok(/scope: 'inbox'/.test(BELL), "①d 종의 팝오버도 inbox 렌즈");
ok(/limit: 1, scope: 'inbox'/.test(NOTI), "①e 안 읽은 수 시계도 inbox 렌즈 — 종과 목록이 같은 셈");
ok(/scope: 'all'/.test(NOTI.slice(NOTI.indexOf("startNotificationBanners"))), "①f 배너 폴링만 all 렌즈(세션 대기 배너는 남는다)");

// ② 입구는 홈의 종
const secs = RAIL.slice(RAIL.indexOf("const SECTIONS"), RAIL.indexOf("];", RAIL.indexOf("const SECTIONS")));
ok(!/key:\s*'inbox'/.test(secs), "②a 레일 구역 표에 inbox 가 없다");
ok(!/'inbox'/.test(RAIL.slice(RAIL.indexOf("export type RailSection"), RAIL.indexOf("export interface RailHooks"))), "②b RailSection 타입에 inbox 가 없다");
const home = VIEWS.slice(VIEWS.indexOf("export function renderHome"), VIEWS.indexOf("export function renderInbox"));
ok(/notifyBell\(\)/.test(home), "②c 홈 머리줄이 종(notifyBell)을 세운다");
ok(/^\s*startUnreadWatch\(\);/m.test(MAIN), "②d 셸 부팅이 안 읽은 수 시계를 켠다(주석 처리 아님)");
ok(/startLiveSync\(\(\) => \{[^}]*refreshUnread\(\)/.test(MAIN), "②e 실시간 전이 스트림이 종도 깨운다(리브의 답은 전이 직후 알림이 된다)");
ok(!/renderInbox\(at\.center, data\)/.test(MAIN.slice(MAIN.indexOf("async function syncShell"), MAIN.indexOf("function refreshSideSoon"))), "②f 8초 틱은 「확인할 것」을 되그리지 않는다(세션 목록과 무관해졌다)");
ok(/window\.matchMedia\(PHONE_MQ\)\.matches\) \{ location\.hash = '#\/inbox'/.test(BELL), "②g 폰에선 종이 화면(#/inbox)을 연다(팝오버 대신)");
ok(/anchoredPopover\(/.test(BELL) && !/overlayBox|confirmDialog/.test(BELL), "②h 팝오버는 비모달(anchoredPopover) — 모달 다이얼로그를 쓰지 않는다");

// ③ 폰 아래 탭
ok(!/inboxCount/.test(MOBILE) && !/k === 'inbox'/.test(MOBILE), "③a 폰 탭 바에 확인할 것 배지·특례가 없다");
ok(/href: '#\/inbox'/.test(MOBILE), "③b [더보기] 판에 「확인할 것」 한 줄이 있다");

// ④ 알림에 내용이 실린다
ok(/function leadOf\(/.test(NOTI) && /personFace\(/.test(NOTI) && /class: 'v2-noti-mark liv'/.test(NOTI), "④a 행의 앞자리 — 사람 얼굴·리브 L");
ok(/notifyTaskComment\(/.test(TASKS), "④b 태스크 댓글 스토어가 알림을 부른다");
ok(/notifyKnowledgeComment\(/.test(KNOW), "④c 지식 댓글 스토어가 알림을 부른다");
ok(/maybeNotifyLivAnswer\(/.test(ROUTES.slice(ROUTES.indexOf("const notifyPhaseChange"))), "④d 세션 전이 자리(notifyPhaseChange)에서 리브의 답을 남긴다");
ok(/dir: st\.dir/.test(ROUTES), "④e 중앙 보고 경로는 작업 폴더를 넘긴다(리브 판정의 정본)");

console.log(`\ninbox-bell-wiring: ${pass} passed`);

// ⑤ replaceChildren 에 null 을 넘기면 «"null"» 글자가 그려진다(el() 과 다르다) — 매니지드 실측(2026-09-23)에서 안 읽음 0 일 때
//    팝오버 머리에 «null» 이 찍혔다. 머리 단추 묶음은 걸러서(filter) 넘겨야 한다.
ok(/head\.replaceChildren\(\.\.\.headKids\.filter\(/.test(BELL), "⑤ 종 팝오버 머리 — 없는 단추(null)를 걸러서 replaceChildren 에 넘긴다");
console.log(`inbox-bell-wiring(+⑤): ${pass} passed`);
