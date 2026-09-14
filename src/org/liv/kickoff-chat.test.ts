// #1631 — 처음 설정 뒤의 리브 킥오프를 **리브 탭의 대화 턴**으로(원준 2026-09-14).
//
//  신고(2026-09-14): 킥오프가 «홈 탭에 세션을 하나 열어서» 돌았고, 서버가 조립한 지시문(«너는 이 워크스페이스의 담당자 리브다 …»)이
//  사람이 보낸 말처럼 통째로 떴으며, 중간에 터미널의 승인 화면(session_rename · project_rename_v6 «Do you want to proceed?»)이
//  사람 앞에 섰다. 결정: 리브 탭에서 리브와 대화하는 화면으로 · 지시문은 자동으로 들어가되 보이지 않게 · 리브가 워크스페이스를
//  맞추는 중이라는 로딩 화면 · 승인 같은 것은 터미널이 아니라 화면의 단추로.
//
//  길: 리브 탭이 이미 쓰던 헤드리스 대화 턴(spawnTaskSession · 거부 목록 · bypassPermissions:false)에 킥오프·증류 지시를 **숨김 턴**으로
//  싣는다. 헤드리스 task 세션은 이름 짓기·자동 프로젝트 훅이 건너뛰고(#1979 항목4) 승인 프롬프트가 설 자리가 없다.
//
//  순수 판정은 표로, DB·tmux 에 걸린 배선은 소스 구조로 못박는다(레포 선례).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFirstTurnPrompt, type FirstTurnInput } from "./first-turn.js";
import { decideSecondTurn } from "./second-turn.js";

const code = (s: string): string => s.replace(/^[ \t]*\/\/.*$/gm, "");
const WELCOME = code(readFileSync("src/capabilities/delivery/welcome.ts", "utf8"));
const CAP = code(readFileSync("src/capabilities/delivery/liv-chat.ts", "utf8"));
const TURN = code(readFileSync("src/org/liv/chat-turn.ts", "utf8"));
const SWEEP = code(readFileSync("src/org/liv/second-turn-sweep.ts", "utf8"));
const STORE = code(readFileSync("src/org/store/members.ts", "utf8"));
const WEB = code(readFileSync("web/liv-chat.ts", "utf8"));
const WEB_LIV = code(readFileSync("web/liv.ts", "utf8"));

const base: FirstTurnInput = {
  displayName: "테스터1", purpose: "내 사업·프리랜스", work: { asis: "1인·프리랜서로 여러 일을 한다 · 디자인" },
  drawers: [], firstOrder: null, decisions: [],
  uploads: { total: 2, kinds: [{ name: "문서", n: 2 }], names: ["a.md", "b.md"], forms: [] },
  categories: [], collectors: [], aiHarnesses: ["claude"], harness: "claude",
};

test("★★ 대화 표면의 1턴 지시는 «세션» 이 아니라 «대화» 를 말하고, 사람이 쓴 지시가 아님을 리브에게 못박는다", () => {
  const chat = buildFirstTurnPrompt({ ...base, surface: "chat" });
  assert.match(chat, /이 대화는 그 직후에 시작됐다/, "대화 표면 머리말이 없다");
  assert.match(chat, /이 지시문은 사람이 쓴 것이 아니니/, "★ 숨김 턴인데 리브가 «보내 주신 지시대로» 라고 할 수 있다");
  assert.match(chat, /- AI: 이 대화는 claude 로 돈다/, "AI 줄이 아직 «세션» 이다");
  assert.match(chat, /그때 이 대화에서 네가 이어서 알리고/, "다음 단계 안내가 «이 세션으로 다시 지시가 온다» 다 — 사람은 세션을 못 본다");
  assert.doesNotMatch(chat, /이 세션/, "대화 표면 지시에 «이 세션» 이 남아 있다");
  //  기본(세션 표면)은 그대로 — 옛 호출부·시험이 그대로 맞는다.
  const sess = buildFirstTurnPrompt(base);
  assert.match(sess, /이 세션은 그 직후에 열렸다/);
  assert.match(sess, /- AI: 이 세션은 claude 로 돈다/);
  assert.equal(sess, buildFirstTurnPrompt({ ...base, surface: "session" }), "surface 생략과 session 이 다르다");
});

test("★★ 2턴 판정 — 대화 킥오프(liv_turn_id)도 킥오프다: 턴이 도는 중이면 기다리고, 끝났고 수집기가 없으면 쏜다", () => {
  const done_at = new Date(1_000_000).toISOString();
  const now = 1_000_000 + 30 * 60_000;
  const st = (over: Record<string, unknown>) => ({
    welcome: { done_at, liv_turn_id: "t0123456789abcdef" },
    session: { working: false, agentState: "idle" }, outboxPending: 0, collectors: [], now, ...over,
  });
  assert.deepEqual(decideSecondTurn(st({})), { action: "fire", partial: false, waitedMin: 30 });
  assert.deepEqual(decideSecondTurn(st({ session: { working: true, agentState: "busy" } })), { action: "wait", reason: "turn1-running" });
  assert.deepEqual(decideSecondTurn(st({ welcome: { done_at } })), { action: "skip", reason: "no-kickoff" }, "★ 둘 다 없는데 킥오프로 본다");
  assert.deepEqual(decideSecondTurn(st({ welcome: { done_at, liv_turn_id: "t0123456789abcdef", distill_at: done_at } })), { action: "skip", reason: "already-fired" });
});

test("★★ 킥오프는 claude 가 있으면 리브 탭 대화 턴(숨김) — href «#/liv», 좌표는 welcome.liv_turn_id · 다시 눌러도 또 열지 않는다", () => {
  const kick = WELCOME.slice(WELCOME.indexOf("export async function kickoffLivAfterWelcome"));
  assert.match(kick, /if \(o\.priorTurn\) return \{ session_id: null, href: "#\/liv", reused: true, via: "chat", turn_id: o\.priorTurn \};/, "대화 킥오프의 멱등(재사용)이 없다");
  assert.match(kick, /if \(usable\.includes\("claude"\)\) \{/, "claude 가 있을 때 대화 길로 가는 분기가 없다");
  assert.match(kick, /startLivChatTurn\(user, \{\s*text: buildFirstTurnPrompt\(\{ \.\.\.turnInput, harness: "claude", surface: "chat" \}\),\s*hidden: true, kind: "kickoff",/, "★ 숨김 킥오프 턴이 아니다(사람 말풍선으로 뜬다)");
  assert.match(kick, /welcome: \{ \.\.\.cur\.welcome, liv_turn_id: made\.turn_id, liv_chat_id: made\.chat_id \}/, "대화 좌표를 welcome 에 안 남긴다 — 2턴이 못 찾는다");
  assert.match(kick, /return \{ session_id: null, href: "#\/liv", harness: "claude", via: "chat", turn_id: made\.turn_id, chat_id: made\.chat_id \};/, "화면을 리브 탭으로 보내지 않는다(응답에 대화 좌표 turn_id·chat_id 가 있어야 저장본과 같다)");
  //  claude 가 없는 사람(codex 등)은 종전 세션 길 — 대화 턴은 claude 문법이라 그 사람에겐 못 연다.
  assert.match(kick, /const made = await livKickoff\(user, \{ prompt: buildFirstTurnPrompt\(\{ \.\.\.turnInput, harness: plan\.harness, surface: "session" \}\), harness: plan\.harness \}\);/, "세션 길(폴백)이 사라졌다");
  //  반영 창구가 welcome 을 통째로 다시 쓸 때 대화 좌표를 지킨다 — 안 지키면 두 번째 반영이 대화를 또 연다.
  assert.match(WELCOME, /liv_turn_id: priorTurn, liv_chat_id: priorWelcome\?\.liv_chat_id \?\? null/, "welcome 재작성이 대화 좌표를 버린다");
  assert.match(WELCOME, /kickoffLivAfterWelcome\(user, \{ priorSession, priorTurn,/, "이전 대화 턴을 킥오프에 안 넘긴다");
});

test("★★ 스폰은 chat-turn.ts 한 자리 — 창구(me_liv_turn)·킥오프·증류 지시가 같은 문을 지나고, 안전선(거부 목록·승인 우회 없음)이 거기 한 벌이다", () => {
  assert.doesNotMatch(CAP, /spawnTaskSession/, "창구가 아직 직접 스폰한다 — 안전선이 두 벌이 된다");
  assert.match(CAP, /const r = await startLivChatTurn\(user, \{ text, restart: input\.restart === true \}\);/, "창구가 chat-turn 을 안 부른다");
  assert.match(TURN, /extraFlags: livTurnArgs\(\{ sessionId, resume \}\),\s*bypassPermissions: false,/, "★ 안전선이 빠졌다 — 사람 앞에서 승인 없이 돈다");
  assert.match(TURN, /harness: "claude",/, "대화 턴 하네스가 claude 가 아니다(거부 목록·세션 플래그가 claude 문법)");
  //  숨김 턴은 지시문 대신 짧은 표식만 프로필에 남긴다 — 3KB 지시문을 프로필에 복제하지 않고, 화면 API 로 새지 않는다.
  assert.match(TURN, /text: o\.hidden \? `\[리브가 스스로 시작한 턴\]/, "숨김 턴이 지시문 원문을 프로필에 남긴다");
  assert.match(TURN, /\.\.\.\(o\.hidden \? \{ hidden: true as const \} : \{\}\),/, "hidden 표식을 안 남긴다 — 화면이 사람 말로 그린다");
});

test("★★ 같은 사람의 턴 시작은 잠금 한 줄 — 서버가 띄우는 턴(unlessBusy)은 마지막 턴이 도는 중이면 띄우지 않는다(격리 리뷰: 사람 턴과 겹침)", () => {
  assert.match(TURN, /return await withTurnLock\(userId, async \(\) => \{/, "★ 턴 시작이 잠금 밖이다 — 스윕과 [보내기]가 같은 세션을 동시에 --resume 한다");
  const body = TURN.slice(TURN.indexOf("return await withTurnLock(userId"));
  const busy = body.indexOf("if (o.unlessBusy) {"), spawn = body.indexOf("spawnTaskSession({");
  assert.ok(busy > 0 && spawn > busy, "바쁜지 확인이 잠금 안·스폰 앞이 아니다");
  assert.match(body, /const running = await livChatRunningTurn\(user\);\s*if \(running\) throw new LivChatBusyError\(running\);/, "바쁘면 던지지 않는다");
  //  «바쁜가» 는 고정된 킥오프 턴이 아니라 **마지막 턴**이 말한다.
  assert.match(TURN, /const last = turns\.length \? turns\[turns\.length - 1\] : null;\s*return last && \(await livTurnDone\(user, last\.id\)\) === false \? last\.id : null;/, "마지막 턴을 안 본다");
});

test("★★ 2턴 스윕 — 대화 킥오프 후보는 세션 배달이 아니라 같은 대화에 증류 턴을 잇고, 후보 조회가 liv_turn_id 를 본다", () => {
  assert.match(STORE, /WHERE \(welcome->>'session_id' IS NOT NULL OR welcome->>'liv_turn_id' IS NOT NULL\)/, "후보 SQL 이 대화 킥오프를 못 본다 — 그 사람에겐 2턴이 영영 안 간다");
  assert.match(SWEEP, /const viaChat = !!c\.welcome\.liv_turn_id && !c\.welcome\.session_id;/, "스윕에 대화 갈래가 없다");
  assert.match(SWEEP, /const kickoffDone = await livTurnDone\(asUser, kickoffTurnId\);/, "1턴이 끝났는지를 턴 폴더로 안 본다");
  //  ★ 격리 리뷰 — 킥오프 턴 id 는 고정값이라 그것만 보면 첫 턴 뒤로는 영영 «한가함». 사람이 대화 중인지는 마지막 턴이 말한다.
  assert.match(SWEEP, /const running = await livChatRunningTurn\(asUser\);\s*return running \? \{ working: true, agentState: "busy" \} : \{ working: false, agentState: "idle" \};/, "★ 스윕이 마지막 턴을 안 본다 — 대화 중에 증류 턴이 겹친다");
  //  킥오프 턴이 exit 없이 죽으면 배달 상한 뒤 offline 로 넘겨 판정표가 포기한다 — 영원히 wait 에 갇히지 않는다.
  assert.match(SWEEP, /if \(kickoffDone === false\) return waitedMs > TURN1_DELIVERY_TTL_MS \? \{ working: false, agentState: "offline" \} : \{ working: true, agentState: "busy" \};/, "죽은 킥오프 턴에 포기 상한이 없다");
  assert.match(SWEEP, /unlessBusy: true \}\)\);/, "스폰 직전 재확인(unlessBusy)이 없다");
  assert.match(SWEEP, /if \(viaChat && \(err as \{ code\?: string \}\)\?\.code === "liv-chat-busy"\) \{[\s\S]*?out\.waited\+\+;[\s\S]*?continue;/, "바쁨을 실패로 센다(다음 tick 재시도가 아니라 failed)");
  assert.equal((SWEEP.match(/listWorkspaces\(\)/g) ?? []).length, 1, "워크스페이스 표를 후보마다 읽는다");
  assert.match(SWEEP, /if \(viaChat\) await withTenant\(tenant, \(\) => startLivChatTurn\(asUser, \{ text: prompt, hidden: true, kind: "distill",/, "★ 증류 지시가 숨김 대화 턴으로 안 간다");
  assert.match(SWEEP, /else await withTenant\(tenant, \(\) => deliverPrompt\(sid, prompt, \{ owner: c\.id \}\)\);/, "세션 길(옛 킥오프)이 사라졌다");
});

test("★★ 화면 — 숨김 턴은 사람 말풍선 없이 «맞추는 중» 카드로 뜨고, 편지 칸은 그동안 «드릴 말씀이 없습니다» 를 쓰지 않는다", () => {
  assert.match(WEB, /const auto = tt\.hidden \? autoKind\(tt\.kind\) : null;\s*const t = view\.turn\(auto \? null : tt\.text, \{ ts: tt\.at \}\);/, "★ 숨김 턴을 사람 말로 그린다");
  assert.match(WEB, /if \(auto\) autoFace\(t, auto, !tail\.done && ageMs <= 30 \* 60_000\);/, "되그릴 때 «맞추는 중» 카드가 없다");
  assert.match(WEB, /if \(auto\) autoFace\(t, auto, false\);/, "턴이 끝나도 «맞추는 중» 이 안 내려간다");
  assert.match(WEB, /document\.body\.dataset\.livAuto = kind; else delete document\.body\.dataset\.livAuto;/, "편지 칸에 신호를 안 준다");
  assert.match(WEB_LIV, /auto \? livWorking\(auto\) : livQuiet\(\)/, "편지 칸이 리브가 일하는 동안에도 «드릴 말씀이 없습니다» 를 쓴다");
  assert.match(WEB_LIV, /document\.addEventListener\('liv:auto', onAuto\);/, "편지 칸이 신호를 안 듣는다(6초 뒤에야 바뀐다)");
});
