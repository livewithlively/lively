// #1631 (원준 2026-09-15) — 처음 설정 뒤 리브 킥오프는 **진짜 세션**(createSession, kind=task)이다.
//
//  왜 되돌렸나: 2026-09-14 에 킥오프를 리브 탭의 헤드리스 «대화 턴»(spawnTaskSession)으로 바꿨는데, 매니지드 게이트웨이는
//  그 로컬 워커의 작업 폴더를 못 만들어 `POST /api/ui/me/liv/turn` 이 500 이 났다(2026-09-15 실측: createSession 은 200,
//  헤드리스 턴은 500). 그래서 킥오프·증류 2턴을 **진짜 세션 + deliverPrompt** 로 되돌린다. task 종류라 이름 짓기·프로젝트
//  자동 생성·승인 프롬프트(session_rename·project_rename_v6)는 그대로 안 뜨고(LIVELY_SESSION_KIND 게이트), 화면(session-chat)
//  이 그 세션을 대화 보기로 열고 첫 지시(서버가 넣은 것)를 숨긴다.
//
//  (#4032, 상민님 결정 2026-09-16) 그 세션이 곧 **리브 탭의 세션**이다 — 킥오프는 리브 세션 모듈(session.ts openLivSession)로
//  <개인 루트>/liv 에 세션을 열고(리브 부팅 훅 게이트), 화면은 리브 탭(#/liv)으로 간다. 리브 탭이 그 세션 대화창을 붙인다.
//
//  DB·tmux 에 걸린 배선은 소스 구조로 못박는다(레포 선례).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideSecondTurn } from "./second-turn.js";

const code = (s: string): string => s.replace(/^[ \t]*\/\/.*$/gm, "");
const KICKOFF = code(readFileSync("src/org/liv/kickoff.ts", "utf8"));
const SESSION = code(readFileSync("src/org/liv/session.ts", "utf8"));
const WELCOME = code(readFileSync("src/capabilities/delivery/welcome.ts", "utf8"));
const SWEEP = code(readFileSync("src/org/liv/second-turn-sweep.ts", "utf8"));
const STORE = code(readFileSync("src/org/store/members.ts", "utf8"));
const CHAT = readFileSync("web/session-chat.ts", "utf8");   // 화면 구조는 주석까지 본다(레이블 상수)

test("★★ 킥오프는 진짜 세션 — 리브 세션 모듈이 launchSession(kind: \"task\", liv 폴더)으로 연다", () => {
  assert.match(KICKOFF, /await openLivSession\(user, \{ prompt: o\.prompt, label: LIV_SESSION_LABEL,/, "★ 킥오프가 리브 세션 모듈을 안 탄다");
  assert.match(SESSION, /await launchSession\(user, \{\s*kind: "task",[\s\S]*?rootKey: "personal", subpath: LIV_SUBPATH,/, "★ 리브 세션이 task 종류·liv 폴더로 안 열린다(승인·프로젝트가 뜨거나 리브 정체성이 빠진다)");
  assert.doesNotMatch(KICKOFF + SESSION, /kind: "human"|spawnTaskSession/, "kind human 또는 헤드리스 스폰이 남아 있다");
  assert.match(KICKOFF, /return \{ session_id: made\.session_id, href: LIV_HREF,/, "화면을 리브 탭으로 안 보낸다");
  assert.match(KICKOFF, /export const LIV_HREF = "#\/liv";/, "리브 탭 주소가 #/liv 가 아니다");
});

test("★★ 처음 설정 반영은 진짜 세션 길만 — 헤드리스 대화 턴(startLivChatTurn)이 없고, 재사용도 리브 탭으로 보낸다", () => {
  const kick = WELCOME.slice(WELCOME.indexOf("export async function kickoffLivAfterWelcome"));
  assert.doesNotMatch(kick, /startLivChatTurn/, "★ 킥오프가 아직 헤드리스 대화 턴을 띄운다(매니지드에서 500)");
  assert.match(kick, /if \(plan\.action === "reuse"\) return \{ session_id: plan\.sessionId, href: LIV_HREF, reused: true \};/, "재사용 갈래가 리브 탭으로 안 보낸다");
  assert.doesNotMatch(kick, /liv_turn_id|liv_chat_id|priorTurn/, "대화 턴 좌표(liv_turn_id/liv_chat_id/priorTurn)가 남아 있다");
  assert.match(kick, /await livKickoff\(user, \{ prompt: buildFirstTurnPrompt\(\{ \.\.\.turnInput, harness: plan\.harness, surface: "chat" \}\), harness: plan\.harness \}\);/, "진짜 세션(livKickoff) 생성 자리가 없다");
  assert.equal(WELCOME.split("kickoffLivAfterWelcome(").length - 1, 2, "킥오프를 부르는 자리가 하나가 아니다(정의+호출 2)");
});

test("★★ 2턴 스윕은 세션(deliverPrompt) 길만 — 대화 턴(viaChat) 배선이 없다", () => {
  assert.doesNotMatch(SWEEP, /viaChat|startLivChatTurn|livTurnDone|chatTurnState|liv-chat-busy/, "★ 스윕에 대화 킥오프 배선이 남아 있다");
  assert.match(SWEEP, /const kickSid = String\(c\.welcome\.session_id\);/, "후보 세션 id 를 session_id 에서 안 읽는다");
  //  #4032 — 2턴은 **지금의 리브 세션**(복원 이정표를 따라간 id)에 넣는다. 옛 킥오프 id 만 보면 되살린 대화를 두고 새 세션을 또 연다.
  assert.match(SWEEP, /const sid = \(await withTenant\(tenant, \(\) => currentLivSessionId\(c\.id\)\)\.catch\(\(\) => null\)\) \?\? kickSid;/, "★ 2턴이 지금의 리브 세션을 안 본다");
  assert.match(SWEEP, /await withTenant\(tenant, \(\) => deliverPrompt\(sid, prompt, \{ owner: c\.id \}\)\);/, "증류 지시를 세션에 deliverPrompt 로 안 넣는다");
  assert.match(STORE, /WHERE welcome->>'session_id' IS NOT NULL/, "후보 SQL 이 세션만 보지 않는다");
  assert.doesNotMatch(STORE, /liv_turn_id|liv_chat_id/, "LivWelcome 에 대화 턴 좌표가 남아 있다");
});

test("★★ 2턴 판정은 session_id 만 킥오프로 본다(liv_turn_id 제거)", () => {
  const done_at = new Date(1_000_000).toISOString(); const now = 1_000_000 + 30 * 60_000;
  const base = { session: { working: false, agentState: "idle" as string }, outboxPending: 0, collectors: [] as Array<{ enabled: boolean; lastRunAt: string | null }>, now };
  assert.deepEqual(decideSecondTurn({ welcome: { done_at, session_id: "box-a-1" }, ...base }), { action: "fire", partial: false, waitedMin: 30 });
  assert.deepEqual(decideSecondTurn({ welcome: { done_at }, ...base }), { action: "skip", reason: "no-kickoff" }, "★ 세션 없이도 킥오프로 본다");
});

test("★★ 화면 — 킥오프 세션의 첫 지시(서버가 넣은 것)는 숨기고 «맞추는 중» 을 띄운다", () => {
  assert.match(CHAT, /const livKickoff = \(\): boolean => String\(target\.label \|\| ''\) === LIV_KICKOFF_LABEL;/, "livKickoff 판정이 없다");
  assert.match(CHAT, /if \(livKickoff\(\) && !kickoffOpened\) \{/, "★ 킥오프 첫 지시를 숨기는 가드가 없다(지시문이 사람 말풍선으로 뜬다)");
  assert.match(CHAT, /cur\.t\.work\.append\(el\('div', \{ class: 'sc-liv-boot'/, "«맞추는 중» 로딩을 안 그린다");
  assert.match(CHAT, /cur\.t\.work\.querySelector\('\.sc-liv-boot'\)\?\.remove\(\);/, "첫 답이 와도 로딩을 안 걷는다");
  assert.match(CHAT, /livKickoff\(\) && notYet \? \(canType\(\) \? '리브가 워크스페이스를 맞추고 있어요/, "빈 트랜스크립트일 때 킥오프 로딩 문구가 없다(죽은 세션은 «멈췄어요»로 가른다)");
});
