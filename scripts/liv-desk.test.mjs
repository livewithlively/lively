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

// ── W8 리브 주소 판정(격리 리뷰 — 셸의 routeKey 는 리브 주소를 'raw:liv' 로 접는다: 그 값과 비교한 갈래는 한 번도 안 돌았다) ──
for (const h of ["#/liv", "#/liv?board=1", "#liv", "#/liv/", "#/liv?x=1"]) check(L.isLivRoute(h) === true, `W8 리브 주소(${h})`);
for (const h of ["#/s/x", "#/livx", "#/", "", null, undefined, "#/p/0", "#/s/liv"]) check(L.isLivRoute(h) === false, `W8 리브 주소 아님(${J(h)})`);
check(L.isLivBoard("#/liv?board=1") === true, "W8 board=1 이면 리브 화면");
for (const h of ["#/liv", "#/liv?board=0", "#/liv?x=1", "", null]) check(L.isLivBoard(h) === false, `W8 board 아님(${J(h)})`);

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
check(/\} else if \(r\.delivered === false && r\.text\) \{\s*if \(!putIntoSession\(\[id\], String\(r\.text\)\)\) rememberUnsentDraft\(id, String\(r\.text\)\);/.test(OPEN), "W4 ★ 못 넣은 말을 입력칸에 안 돌려 둔다(누른 일이 사라진다)");
check(/rememberLivSessionId\(id\);/.test(OPEN), "W4 맡긴 세션을 리브 세션으로 기억한다(곧바로 그 화면을 리브 세션으로 그린다)");
check(/delivered: !!r\.created \|\| r\.delivered !== false/.test(OPEN), "W9 ★ 못 넣은 것을 부르는 쪽이 모른다(«전했어요» 라고 거짓말한다)");
//  W9 — 못 넣은 말은 그 세션 화면이 떠 있으면 지금 그 입력칸에(열린 화면은 다시 그려지지 않아 남겨 둔 글을 안 읽는다), 아니면 남긴다 — 넣기가 먼저.
check(/if \(!putIntoSession\(\[id\], String\(r\.text\)\)\) rememberUnsentDraft\(id, String\(r\.text\)\);/.test(OPEN),
  "W9 ★ 못 넣은 말을 남겨 두기만 한다(그 세션 화면이 이미 떠 있으면 입력칸이 빈 채로 · 다음에 열 때 유령 글)");
check(/\.\.\.\(body\.onlyExisting \? \{ only_existing: true \} : \{\}\)/.test(OPEN), "W9 onlyExisting 이 서버로 안 간다");

check(/export const LIV_ENTRY_VISIBLE: boolean = true;/.test(SW), "W5 리브 입구 켜짐");

//  W1 배선 — 레일 [리브](#/liv)는 거쳐 가는 문이다: 탭을 고르기 **전에** 리브 세션 주소로 갈아 끼워, 이미 열린 그 세션 탭이 켜진다.
const MAIN = code(read("web/v2/main.ts"));
//   ⚠ 판정은 위 W8 의 isLivRoute(실제로 돌려 본 함수)로만 — routeKey 와 비교하면 늘 거짓이라 이 갈래가 죽는다(격리 리뷰가 잡은 자리).
check(/if \(isLivRoute\(hash\) && !isLivBoard\(hash\)\) \{\s*const was = location\.hash;\s*const lid = await livSessionIdWithin\(1500\);/.test(MAIN),
  "W1 ★ #/liv 가 탭을 고르기 전에 리브 세션 주소로 안 바뀐다(레일 [리브]를 다시 누르면 같은 세션이 탭 둘로 선다)");
//  W9 — 기다리는 사이의 다른 이동이 이긴다 · 같은 값이면 hashchange 가 안 나므로 삼킬 수를 세지 않는다.
check(/const lid = await livSessionIdWithin\(1500\);[\s\S]{0,260}?if \(location\.hash !== was\) return;/.test(MAIN), "W9 ★ 늦게 온 리브 id 가 그사이 사람이 한 이동을 덮는다");
check(/if \(location\.hash !== hash\) \{ suppressHash\+\+; location\.replace\(location\.pathname \+ location\.search \+ hash\); \}/.test(MAIN), "W9 같은 주소로 바꿔 끼우며 삼킬 수를 세어 다음 진짜 이동을 삼킨다");
//  W9 — 1.5초 안에 못 받았으면 늦은 답이 판정을 바꿀 때 한 번 다시 그린다.
const late = MAIN.slice(MAIN.indexOf("const drawnLiv = isLiv(sessionId);"), MAIN.indexOf("const drawnLiv = isLiv(sessionId);") + 900);
check(/void livSessionId\(\)\.then\(\(\) => \{\s*if \(seq !== tab\.seq \|\| isLiv\(sessionId\) === drawnLiv\) return;/.test(late) && /\n\s*void renderRoute\(tab\);\s*\}\);/.test(late),
  "W9 늦게 온 리브 id 가 판정을 바꿔도 다시 안 그린다(첫 응답이 느린 날 리브 세션이 끝까지 터미널로 남는다)");
check(/if \(routeKey\(tab\.route\) !== 's:' \+ sessionId\) return;/.test(late), "W9 그사이 서랍에서 다른 세션을 고른 탭을 옛 세션으로 다시 그린다");
check(/if \(tabsApi\?\.current\(\) !== tab\) \{ tab\.rendered = false; return; \}/.test(late) && late.indexOf("tab.rendered = false") < late.indexOf("void renderRoute(tab);"),
  "W9 ★ 숨은 탭을 지금 다시 그린다(보고 있는 다른 탭의 앱 겹창이 닫히고 사이드바 표시가 옮겨 간다)");
//  W9 — 같은 글을 거푸 넣으면 한 번만(멈춘 리브 세션에 [연결 도와줘] 두 번 → 같은 말이 쌓였다).
check(/if \(!cur\.trimEnd\(\)\.endsWith\(text\.trim\(\)\)\) view\.input\.value = /.test(CHAT), "W9 ★ 같은 글을 거푸 넣으면 입력칸에 같은 말이 쌓인다");
check(!/routeKey\(hash\) === 'liv'|routeKey\(tab\.route\) === 'liv'/.test(MAIN), "W1 ★ routeKey 를 'liv' 와 비교한다 — 늘 거짓인 판정(리브 주소는 raw:liv)");
check(MAIN.indexOf("if (isLivRoute(hash)") > 0 && MAIN.indexOf("if (isLivRoute(hash)") < MAIN.indexOf("const other = tabsApi.find(hash);"),
  "W1 갈아 끼우기가 탭 찾기(tabsApi.find)보다 먼저다");
//  W9 — 그 세션 탭이 이미 있으면 그 탭을 켜고 이 탭은 닫는다(저장된 옛 #/liv 탭 복원 · 새 탭으로 연 경우).
check(/const other = tabsApi\?\.find\(to\);\s*if \(other && other !== tab\) \{ tabsApi\?\.activate\(other\); tabsApi\?\.close\(tab\); return; \}/.test(MAIN),
  "W9 ★ 리브 갈래가 이미 열린 리브 세션 탭을 두고 같은 세션 탭을 하나 더 세운다");
//  W9 — 리브 id 물음은 시간을 둔다(빈 화면 금지 · #3537) · 되살린 뒤엔 새로 묻는다 · 팝아웃도 리브 세션으로.
check(/const livId = projectId > 0 \? knownLivSessionId\(\) : await livSessionIdWithin\(1500\);/.test(MAIN), "W9 ★ 세션 화면이 리브 id 물음을 끝없이 기다린다(느리면 빈 화면)");
check(/void livSessionId\(\{ fresh: true \}\);\s*const href = '#\/s\/' \+ encodeURIComponent\(sid\);/.test(MAIN), "W9 되살린 뒤 리브 id 를 새로 안 묻는다(30초 동안 리브 세션을 못 알아본다)");
check(/const soloLiv = isLivSessionId\(/.test(MAIN) && /\.\.\.\(soloLiv \? \{ chatHome: true, livAsks: true \} : \{\}\),/.test(MAIN), "W9 팝아웃 창의 리브 세션이 대화 보기 · 물음 자리로 안 열린다");
check(/if \(inflight\) return inflight;/.test(OPEN), "W9 묻는 중이면 그 답을 기다린다(되살린 뒤 옛 id 로 그리지 않게)");

//  보내기 다리 — 대화창일 때만 보낸다(터미널에 Enter 까지 쳐 넣지 않는다) · 보낸 쪽이 없으면 거짓(부르는 쪽이 서버 길로).
check(/return e\.send \? e\.send\(text\) : false;/.test(SESSIN), "W3 보내기 다리 — 보낼 수 없는 화면이면 거짓");
check(/if \(destroyed \|\| mode !== 'chat' \|\| view\.input\.disabled \|\| view\.input\.value\.trim\(\) \|\| attachments\.busy\(\) \|\| attachments\.tail\(\)\) return false;/.test(CHAT),
  "W3 ★ 터미널 쪽이거나 사람이 쓰던 글이 있어도 보낸다(쓰던 글이 사라진다 · 사람이 고칠 틈 없이 Enter)");
check(/if \(destroyed \|\| sendHere\(text\)\) return;[\s\S]{0,200}?void openLiv\(\{ text, onlyExisting: true \}\)/.test(CHAT), "W9 물음 카드의 한 마디 — 보낼 수 없으면 입력칸을 건드리지 않고 서버로(있는 리브 세션에만) 넣는다");
check(/if \(id && sendIntoSession\(\[id\], text\)\) return;[\s\S]*?const r = await openLiv\(\{ text, onlyExisting: true \}\);/.test(DESK), "W3 오른쪽 칸의 말 — 대화창이 있으면 거기로, 없으면 서버가 리브 세션에 넣는다");
check(/const r = await openLiv\(\{ text, onlyExisting: true \}\);/.test(DESK), "W9 ★ 곁칸 카드의 맞장구가 리브 세션이 사라진 사이 새 리브 세션의 첫 지시가 된다");
check(!/takeUnsentDraft/.test(DESK), "W9 곁칸이 남겨 둔 글을 직접 걷는다(넣기 성공 전에 걷으면 말이 사라진다 — 담기는 openLiv 한 곳에서)");
check(/const r = await openLiv\(\{ text, onlyExisting: true \}\);/.test(BOARD), "W9 ★ 리브 화면 카드의 맞장구가 새 리브 세션의 첫 지시가 된다");
check(/if \(!putIntoSession\(\[sessionId\], text\)\) rememberUnsentDraft\(sessionId, text\);/.test(BOARD), "W9 리브 화면의 담기가 이미 떠 있는 세션 입력칸에 안 들어간다(남겨 두기만 — 유령 글)");
const fillBody = DESK.slice(DESK.indexOf("fill: (t) =>"), DESK.indexOf("refresh: () =>"));
check(fillBody.length > 0 && !/say\(/.test(fillBody), "W9 ★ 담기만 하는 문이 보내기로 떨어진다(고쳐 보내려던 예시 문장이 그대로 간다)");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
