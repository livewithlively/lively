// #1631 (원준 2026-09-15) — 처음 설정 뒤 리브 킥오프는 **진짜 세션**(createSession, kind=task)이다.
//
//  왜 되돌렸나: 2026-09-14 에 킥오프를 리브 탭의 헤드리스 «대화 턴»(spawnTaskSession)으로 바꿨는데, 매니지드 게이트웨이는
//  그 로컬 워커의 작업 폴더를 못 만들어 `POST /api/ui/me/liv/turn` 이 500 이 났다(2026-09-15 실측: createSession 은 200,
//  헤드리스 턴은 500). 그래서 킥오프·증류 2턴을 **진짜 세션 + deliverPrompt** 로 되돌린다. task 종류라 이름 짓기·프로젝트
//  자동 생성·승인 프롬프트(session_rename·project_rename_v6)는 그대로 안 뜨고(LIVELY_SESSION_KIND 게이트), 화면(session-chat)
//  이 그 세션을 대화 보기로 열고 첫 지시(서버가 넣은 것)를 숨긴다.
//
//  DB·tmux 에 걸린 배선은 소스 구조로 못박는다(레포 선례).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideSecondTurn } from "./second-turn.js";

const code = (s: string): string => s.replace(/^[ \t]*\/\/.*$/gm, "");
const KICKOFF = code(readFileSync("src/org/liv/kickoff.ts", "utf8"));
const WELCOME = code(readFileSync("src/capabilities/delivery/welcome.ts", "utf8"));
const SWEEP = code(readFileSync("src/org/liv/second-turn-sweep.ts", "utf8"));
const STORE = code(readFileSync("src/org/store/members.ts", "utf8"));
const CHAT = readFileSync("web/session-chat.ts", "utf8");   // 화면 구조는 주석까지 본다(레이블 상수)

test("★★ 킥오프는 진짜 세션 — createSession(kind: \"task\") 로 연다(승인·프로젝트·이름 짓기 훅이 건너뛰는 종류)", () => {
  assert.match(KICKOFF, /const session = await createSession\(user, \{[\s\S]*?kind: "task",/, "★ 킥오프가 아직 kind human(승인·프로젝트가 뜬다) 또는 헤드리스다");
  assert.doesNotMatch(KICKOFF, /kind: "human"/, "kind human 이 남아 있다");
  assert.match(KICKOFF, /href: `#\/s\/\$\{encodeURIComponent\(session\.id\)\}`/, "세션 좌표(#/s/<id>)를 안 돌려준다");
});

test("★★ 처음 설정 반영은 진짜 세션 길만 — 헤드리스 대화 턴(startLivChatTurn)·#/liv 킥오프가 없다", () => {
  const kick = WELCOME.slice(WELCOME.indexOf("export async function kickoffLivAfterWelcome"));
  assert.doesNotMatch(kick, /startLivChatTurn/, "★ 킥오프가 아직 헤드리스 대화 턴을 띄운다(매니지드에서 500)");
  assert.doesNotMatch(kick, /href: "#\/liv"/, "킥오프가 아직 #/liv 로 보낸다(진짜 세션은 #/s/<id>)");
  assert.doesNotMatch(kick, /liv_turn_id|liv_chat_id|priorTurn/, "대화 턴 좌표(liv_turn_id/liv_chat_id/priorTurn)가 남아 있다");
  assert.match(kick, /await livKickoff\(user, \{ prompt: buildFirstTurnPrompt\(\{ \.\.\.turnInput, harness: plan\.harness, surface: "chat" \}\), harness: plan\.harness \}\);/, "진짜 세션(livKickoff) 생성 자리가 없다");
  assert.equal(WELCOME.split("kickoffLivAfterWelcome(").length - 1, 2, "킥오프를 부르는 자리가 하나가 아니다(정의+호출 2)");
});

test("★★ 2턴 스윕은 세션(deliverPrompt) 길만 — 대화 턴(viaChat) 배선이 없다", () => {
  assert.doesNotMatch(SWEEP, /viaChat|startLivChatTurn|livTurnDone|chatTurnState|liv-chat-busy/, "★ 스윕에 대화 킥오프 배선이 남아 있다");
  assert.match(SWEEP, /const sid = String\(c\.welcome\.session_id\);/, "후보 세션 id 를 session_id 에서 안 읽는다");
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
