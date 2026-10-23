#!/usr/bin/env node
// 리브 = 세션 하나(#4970 PR3) — 화면 쪽 순수 규칙(web/lib/liv-desk.ts) + 배선(셸 · 곁칸 · 세션 대화창 · 리브 화면 · 연결 문).
//
//  사양: <스크래치패드>/spec-liv-session.md 표 W(W1~W7). 행마다 검사 하나 이상.
//   W1 #/liv 갈 곳: board=1 → board(세션이 있어도) · board=0 + 세션 id → session · board=0 + 세션 없음(null·빈 문자열·공백) → board
//   W2 리브 세션인가: 이름들(id·기록 id·대화 id) 가운데 하나가 리브 id 와 같으면 참 · 리브 id 를 모르면(빈 값·null) 거짓 · 이름이 비어 있으면 거짓
//      + 셸 배선: 프로젝트 없는 세션 화면이고 리브 세션이면 곁칸 맨 앞 «리브» 칸 · 켜짐 / 아니면 종전 그대로
//   W3 물음 자리: 세션 대화창 입력칸 바로 위(liveDock)와 리브 화면 · 오른쪽 «리브» 칸은 한 줄만(물음 카드를 그리지 않는다)
//   W4 연결 문: me_liv_open job:connect · 새로 열었으면 첫 지시를 먼저 그린다 · 못 넣었으면(delivered:false) 입력칸에 돌려 둔다
//   W5 리브 입구 스위치 켜짐(onboarding-single-flow.test E18 이 네 자리를 잰다)
//   W6 외부 앱 상태 말: 여섯 값 + 그 밖(null·모름) → «확인하지 못했어요»
//   W7 이름: 곁칸 livdesk = «리브»(pickable:false) · 옛 liv(프로젝트 대화) = «프로젝트 대화»
//  fail-first: 신규 모듈이라 변경 전 트리는 모듈이 없어 전부 빨갛다. 규칙 돌연변이는 머리말 아래 실행 기록에 남긴다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const code = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const out = mkdtempSync(path.join(tmpdir(), "liv-desk-"));
execFileSync(path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/liv-desk.ts"), "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" });
const L = await import(path.join(out, "liv-desk.js"));

let pass = 0, fail = 0;
const check = (cond, n, why = "기대와 다르다") => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${why}`); } };
const J = (v) => JSON.stringify(v);
const eq = (got, want, n) => check(J(got) === J(want), n, `기대 ${J(want)} · 실제 ${J(got)}`);

// ── W1 #/liv 갈 곳 ──
eq(L.livRoute({ board: true, sessionId: "box-a" }), "board", "W1 board=1 이면 세션이 있어도 리브 화면(로컬 AI 링크)");
eq(L.livRoute({ board: false, sessionId: "box-a" }), "session", "W1 세션이 있으면 그 세션 화면");
for (const none of [null, undefined, "", "   "]) eq(L.livRoute({ board: false, sessionId: none }), "board", `W1 세션 없음(${J(none)}) → 리브 화면`);
eq(L.LIV_BOARD_HASH, "#/liv?board=1", "W1 로컬 AI 에게 줄 주소");

// ── W2 리브 세션인가 ──
check(L.isLivSessionId(["box-a", "uuid-1"], "box-a") === true, "W2 id 가 같으면 참");
check(L.isLivSessionId([null, "uuid-1", undefined], "uuid-1") === true, "W2 대화 id 로도 알아본다(복원·기록 행)");
check(L.isLivSessionId(["box-a"], "box-b") === false, "W2 다르면 거짓");
for (const none of [null, undefined, "", "  "]) check(L.isLivSessionId(["box-a", ""], none) === false, `W2 리브 id 를 모르면(${J(none)}) 거짓 — 빈 이름과 짝지어지지 않는다`);
check(L.isLivSessionId([], "box-a") === false, "W2 이름이 없으면 거짓");
check(L.isLivSessionId([" box-a "], "box-a") === true, "W2 앞뒤 공백은 세지 않는다");

// ── W6 외부 앱 상태 말 ──
const W6 = [["register_app", "앱 등록이 필요해요"], ["ask_admin", "관리자에게 요청해야 해요"], ["preparing", "준비 중이에요"],
  ["connect", "연결할 수 있어요"], ["set_scope", "모을 범위를 정하면 돼요"], ["collecting", "모으고 있어요"]];
for (const [k, want] of W6) eq(L.connectNextText(k), want, `W6 ${k}`);
for (const odd of [null, undefined, "", "nope", 3]) eq(L.connectNextText(odd), "확인하지 못했어요", `W6 모르는 값(${J(odd)})`);
//  서버가 내는 next 값과 말 표가 같은 것을 본다 — 한쪽에만 생기면 «확인하지 못했어요» 가 거짓으로 뜬다.
const NEXT = code(read("src/org/connect-next.ts"));
const union = (NEXT.match(/export type ConnectNext = ([^;]+);/) || [, ""])[1];
const serverNexts = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
check(serverNexts.length > 0, "W6 서버의 next 값 목록을 읽었다(배선 — 비면 아래 비교가 헛돈다)");
eq(serverNexts, W6.map(([k]) => k).sort(), "W6 서버의 next 값 = 화면의 말 표");

// ── 배선 ──
const PANES = code(read("web/v2/panes.ts"));
const PARTS = code(read("web/v2/panes-parts.ts"));
const DESK = code(read("web/v2/panes-liv.ts"));
const CHAT = code(read("web/session-chat.ts"));
const DOCK = code(read("web/liv-ask-dock.ts"));
const BOARD = code(read("web/liv.ts"));
const OPEN = code(read("web/v2/liv-open.ts"));
const OWN = code(read("web/v2/connect-own-ai.ts"));
const SESSIN = code(read("web/v2/sess-input.ts"));
const SW = read("web/lib/liv-entry.ts");

check(/if \(loose && opts\.livSession\) \{ lay = \{ \.\.\.lay, side: \['livdesk', 'sessfiles', 'timeline'\], act: \{ \.\.\.lay\.act, side: 'livdesk' \}, sideOn: true \}; \}/.test(PANES),
  "W2 ★ 리브 세션이면 곁칸 맨 앞에 «리브» 칸을 켜서 세운다(프로젝트 없는 세션 화면)");
check(PANES.indexOf("if (loose) { lay = {") < PANES.indexOf("if (loose && opts.livSession)"), "W2 리브 배치가 자투리 배치 뒤에 온다(앞이면 자투리 배치가 덮는다)");
check(/livSession\?: boolean;/.test(PANES), "W2 셸 옵션이 있다");
check(/\{ type: 'livdesk', name: '리브', icon: 'liv', pickable: false,/.test(PARTS), "W7 곁칸 livdesk = «리브» · [+] 로 못 넣는다");
check(/\{ type: 'liv', name: '프로젝트 대화', icon: 'liv',/.test(PARTS), "W7 ★ 옛 «리브»(프로젝트 대화)의 이름이 그대로다 — «리브» 가 둘이다");
check(/if \(type === 'livdesk'\) return livDeskPart\(ctx\);/.test(PARTS), "W2 livdesk 부품이 만들어진다");

check(/const livDock = opts\.livAsks \? mountLivAskDock\(liveDock, \{/.test(CHAT), "W3 ★ 물음이 입력칸 바로 위(liveDock)에 안 뜬다");
check(/dock\.append\(host\);/.test(DOCK) && /livAskCard\(st\.secretAsk, hooks\)/.test(DOCK), "W3 물음 자리가 그 칸에 물음 카드를 그린다");
check(/if \(livAskTyping\(host\)\) return;/.test(DOCK), "W3 사람이 치는 중이면 다시 그리지 않는다(값이 사라진다)");
check(!/livAskCard/.test(DESK), "W3 ★ 오른쪽 «리브» 칸이 물음 카드를 또 그린다 — 입력칸이 두 자리에 서면 어디에 넣을지 헷갈린다");
check(/askLine\.hidden = !st\.secretAsk;/.test(DESK), "W3 오른쪽 칸은 «입력칸 위에서 기다린다» 한 줄만");
check(/livAskCard\(st\.secretAsk, hooks\)/.test(BOARD), "W3 리브 화면(단독)은 물음 카드를 그린다(로컬 AI 링크로 온 사람이 넣는 자리)");

check(/const r = await openLiv\(\{ job: 'connect' \}\);/.test(OWN), "W4 ★ 연결 문이 리브에게 맡기지 않는다");
check(/if \(r\.created\) \{\s*rememberCreated\(r\.session\);\s*if \(r\.initialPrompt\) rememberFirstPrompt\(id, String\(r\.initialPrompt\)\);/.test(OPEN), "W4 새로 열었으면 첫 지시를 먼저 그린다");
check(/\} else if \(r\.delivered === false && r\.text\) \{\s*rememberUnsentDraft\(id, String\(r\.text\)\);/.test(OPEN), "W4 ★ 못 넣은 말을 입력칸에 안 돌려 둔다(누른 일이 사라진다)");
check(/rememberLivSessionId\(id\);/.test(OPEN), "W4 맡긴 세션을 리브 세션으로 기억한다(곧바로 그 화면을 리브 세션으로 그린다)");

check(/export const LIV_ENTRY_VISIBLE: boolean = true;/.test(SW), "W5 리브 입구 켜짐");

//  W1 배선 — 레일 [리브](#/liv)는 거쳐 가는 문이다: 탭을 고르기 **전에** 리브 세션 주소로 갈아 끼워, 이미 열린 그 세션 탭이 켜진다.
const MAIN = code(read("web/v2/main.ts"));
check(/if \(routeKey\(hash\) === 'liv' && parseRoute\(hash\)\.params\.get\('board'\) !== '1'\) \{\s*const lid = await livSessionId\(\);/.test(MAIN),
  "W1 ★ #/liv 가 탭을 고르기 전에 리브 세션 주소로 안 바뀐다(레일 [리브]를 다시 누르면 같은 세션이 탭 둘로 선다)");
check(MAIN.indexOf("if (routeKey(hash) === 'liv'") > 0 && MAIN.indexOf("if (routeKey(hash) === 'liv'") < MAIN.indexOf("const other = tabsApi.find(hash);"),
  "W1 갈아 끼우기가 탭 찾기(tabsApi.find)보다 먼저다");

//  보내기 다리 — 대화창일 때만 보낸다(터미널에 Enter 까지 쳐 넣지 않는다) · 보낸 쪽이 없으면 거짓(부르는 쪽이 서버 길로).
check(/return e\.send \? e\.send\(text\) : false;/.test(SESSIN), "W3 보내기 다리 — 보낼 수 없는 화면이면 거짓");
check(/if \(destroyed \|\| mode !== 'chat' \|\| view\.input\.disabled\) return false;/.test(CHAT), "W3 ★ 터미널 쪽이어도 보낸다(사람이 고칠 틈 없이 Enter)");
check(/if \(id && sendIntoSession\(\[id\], text\)\) return;[\s\S]*?const r = await openLiv\(\{ text \}\);/.test(DESK), "W3 오른쪽 칸의 말 — 대화창이 있으면 거기로, 없으면 서버가 리브 세션에 넣는다");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
