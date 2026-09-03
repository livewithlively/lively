// #2592 — 셀프 노드 **집행 배선**. 사양 엣지 표 B·C(스크래치패드 spec.md).
//
//  #2108 은 판정을 세우고 «그 노드로 새로 만들기» 한 자리에만 물렸다. 그래서 판정은 내내 정확했는데도
//  접속·목록 좌표·발견 기록·자기등록 네 구멍이 열린 채였다(2026-09-03 dev 실측: 중앙 세션 10개가 노드
//  데몬의 `tmux -CC attach` 로 서빙 중, 거짓 좌표가 붙은 목록 행 81개, 셀프 발견 행 286개).
//
//  ⇒ 이 파일이 값이 아니라 **소스 구조**를 보는 이유가 그것이다. 값 테스트는 «술어가 맞나»를 재는데,
//   이 프로젝트에서 틀렸던 것은 술어가 아니라 **술어가 안 서 있는 자리들**이다. 그건 배선으로만 잡힌다.
//   (같은 이유로 서 있는 파일: self-node-probe-wiring.test.mjs — 그쪽은 '언제 판정하나'를 잰다.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
// ⚠ 첫 실패에서 멈추지 않는다 — 표 기반 테스트에서 그러면 «몇 행이 실제로 빨간불이 되는지» 를 볼 수 없다.
//  fail-first(red 입증)의 값어치가 그 숫자에 있다: 30행 중 1행만 빨개지는 표는 나머지 29행이 장식이라는 뜻이다.
let pass = 0; const failed = [];
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`ok  ${name}`); return; }
  failed.push(name); console.log(`NOT OK  ${name}`);
};

/** 주석을 걷어 **코드만** 남긴다 — 사연을 적은 주석이 단언에 걸리면 테스트가 문서를 검열하게 된다. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 함수 하나의 본문만 — 파일 전체에서 재면 다른 함수의 줄이 섞인다(순서 단언이 무의미해진다). */
//  함수가 통째로 없으면(변경 전 코드) 던지지 않고 **빈 문자열**을 준다 — 그래야 그 자리의 단언들이
//   «못 찾았다» 하나로 뭉개지지 않고 각자 빨간불이 된다(red 입증에서 몇 행이 실제로 걸리는지 보려면 필요하다).
function body(src, header) {
  const a = src.indexOf(header);
  if (a < 0) return "";
  const b = src.indexOf("\n}", a);
  return b > a ? src.slice(a, b) : "";
}

const REG = code(read("src/node/registry.ts"));
const NSS = code(read("src/terminal/node-session-state.ts"));
const PTY = code(read("src/terminal/terminal-pty-upgrade.ts"));
const NROUTES = code(read("src/node/routes.ts"));
const SSTATE = code(read("src/sessions/session-state.ts"));
const AGENT = code(read("src/node/agent.ts"));
const SHELL = code(read("desktop/main/web-shell.mjs"));

// ── B1. 목록 좌표 — 셀프 노드 행에는 좌표를 안 싣는다 ──────────────────────────
//  좌표는 배지가 아니라 릴레이 지시다: 화면이 그 값으로 `&node=` 를 붙인다. 셀프 좌표를 실으면 목록만
//  고쳐도 화면이 다시 릴레이 경로를 연다.
{
  const f = body(REG, "export function nodeSessionsFor(");
  ok(/isSelfNode\(/.test(f), "B1a nodeSessionsFor 가 셀프 판정을 본다");
  ok(/node:\s*\{\s*id/.test(f), "B1b 원격 노드에는 좌표를 그대로 싣는다(과잉 제거 방지)");
  // 좌표를 싣는 줄이 **판정으로 갈린다** — 조건 없이 항상 실으면 아무것도 안 고친 것이다.
  ok(/self\s*\?/.test(f) || /if\s*\(!?self\)/.test(f), "B1c 좌표를 싣는 자리가 셀프 판정으로 갈린다");
}

// ── B2. 릴레이 대상 해소 — 셀프 노드는 답으로 내놓지 않는다 ────────────────────
//  프롬프트 배달·kill·chatAnswer·meta 가 전부 이 한 자리를 지난다(호출부마다 고치면 하나를 빠뜨린다).
{
  const f = body(REG, "export function nodeOfSession(");
  ok(/isSelfNode\(/.test(f) && /null/.test(f), "B2 nodeOfSession 이 셀프 노드면 null(중앙)을 답한다");
}

// ── B3. attach 릴레이 — 셀프 노드로는 열지 않는다(최종 안전망) ─────────────────
//  호출부가 이미 좌표를 접지만, 여기까지 온 값이 통과하면 그게 바로 이 프로젝트가 닫는 구멍이다.
{
  const f = body(REG, "export function nodeRelayAttach(");
  const iSelf = f.indexOf("isSelfNode(");
  const iOpen = f.indexOf('t: "open"');
  ok(iSelf >= 0, "B3a nodeRelayAttach 가 셀프 판정을 본다");
  ok(iOpen > iSelf, "B3b 판정이 채널 open 보다 **먼저** 온다(통과한 뒤 막으면 이미 열린 것이다)");
}

// ── B4. hello — 이미 판정된 노드는 전용 종결 코드로 끊는다 ─────────────────────
ok(/isSelfNode\(c\.node\.id\)[\s\S]{0,600}?CLOSE_SELF_NODE/.test(REG),
  "B4 hello 가 셀프 노드를 CLOSE_SELF_NODE 로 끊는다(재연결·재부팅 뒤 첫 연결도 이 자리를 지난다)");
ok(/CLOSE_SELF_NODE\s*=\s*4409/.test(code(read("src/node/protocol.ts"))),
  "B4b 종결 코드가 **공유 프로토콜**에 있다 — 끊는 쪽과 끊기는 쪽이 같은 값을 봐야 한다");

// ── B5. 순서 — 발견 기록은 **판정이 끝난 뒤**에 부른다 ─────────────────────────
//  판정은 tmux 왕복이라 늘 늦게 끝난다. 나란히 띄우면 셀프 노드의 **첫 스냅샷**이 판정 전에 DB 로 들어간다
//  (게이트웨이가 재배포될 때마다 그 창이 다시 열린다 — 실측 286행의 출처 중 하나).
{
  const f = body(REG, "function applyState(");
  const m = /probeSelfNodes\(\)\s*\.then\(\s*\(\)\s*=>\s*\{[\s\S]*?nodeSessionsHandler/.test(f);
  ok(m, "B5 applyState 가 판정 완결 뒤에 발견 기록 구독자를 부른다");
}

// ── B6. 발견 기록 — 셀프 노드 스냅샷은 아무것도 적지 않는다 ───────────────────
{
  const f = body(NSS, "export async function discoverNodeSessions(");
  const iSelf = f.indexOf("isSelfNode(nodeId)");
  const iWrite = f.indexOf("insertDiscoveredSessionState");
  ok(iSelf >= 0, "B6a discoverNodeSessions 가 셀프 판정을 본다");
  ok(iWrite > iSelf, "B6b 판정이 **기록보다 먼저** 온다");
  ok(/if\s*\(isSelfNode\(nodeId\)\)\s*return/.test(f), "B6c 셀프 노드면 그 자리에서 돌아선다(부분 기록 없음)");
}
// 복원 목록의 좌표는 라이브 스냅샷이 아니라 DB 에서 온다 — 마이그레이션 전 행·다른 게이트웨이가 쓴 행이 남는다.
{
  const f = body(NSS, "export async function decorateNodeRows(");
  ok(/isSelfNode\(r\.node\.id\)[\s\S]{0,40}delete r\.node/.test(f),
    "B6d 복원 행에 남아 있는 셀프 좌표도 턴다(DB 에서 오는 경로)");
}

// ── B7. `?node=` — 업그레이드에서 정규화한 뒤 분기한다 ─────────────────────────
{
  const f = body(PTY, "export function setupPtyUpgrade(");
  ok(/relayNodeId\(\s*url\.searchParams\.get\("node"\)/.test(f),
    "B7a `?node=` 를 relayNodeId 로 정규화한다(열려 있던 탭의 옛 좌표도 여기서 정정된다)");
  const iNorm = f.indexOf("relayNodeId(");
  const iRelay = f.indexOf("nodeRelayAttach(");
  ok(iRelay > iNorm, "B7b 정규화가 릴레이보다 먼저 온다");
}

// ── B8. 등록 — 박스 프로브가 겹치면 거부한다 ───────────────────────────────────
ok(/looksLikeGatewayBox\(boxProbe\(b\)\)[\s\S]{0,120}?HttpError\(409/.test(NROUTES),
  "B8a 노드 등록이 셀프 박스를 409 로 거부한다");
ok(/"\/api\/ui\/nodes\/self-check"/.test(NROUTES),
  "B8b 프리플라이트 라우트가 있다 — 등록을 건너뛰는 재실행(토큰 재사용)도 막아야 한다");
{
  // 프로브는 응답에 겹친 id 를 싣지 않는다(#2108 규율) — self-check 응답은 불리언 + 사람에게 할 말뿐.
  const f = body(NROUTES, 'app.post("/api/ui/nodes/self-check"');
  ok(/res\.json\(\{\s*self,\s*note/.test(f) && !/boxSessions|sessions:/.test(f.split("res.json")[1] ?? ""),
    "B8c self-check 응답에 세션 id 를 싣지 않는다(테넌트 간 노출 없음)");
}

// ── B11. 기존 행 정리는 **hello 에서도** 재시도된다 ───────────────────────────
//  ★ dev 라이브 검증이 잡은 구멍(2026-09-03): 정리를 «판정이 서는 순간» 한 곳에만 걸었더니, 부팅 경로에서
//   hydrateNodeStates 가 **구독이 걸리기 전에** 판정을 내는 배포에서는 정리가 한 번도 안 돌았다.
//   판정은 sticky 라 두 번 다시 서지 않는다 = 재시도가 영영 없다. 그래서 «그 뒤 반드시 지나는 자리» 에도 건다.
{
  const probe = body(REG, "function probeSelfNodes()");
  const hello = body(REG, "function onNodeControlMsg(");
  ok(/maybeCleanSelfNode\(/.test(probe), "B11a 판정이 서는 순간 정리를 부른다");
  ok(/maybeCleanSelfNode\(/.test(hello), "B11b ★hello 에서도 부른다(부팅 판정이 구독보다 빨랐던 경우의 유일한 재시도)");
  const clean = body(REG, "function maybeCleanSelfNode(");
  ok(/selfNodeCleaned\.has\(/.test(clean), "B11c 프로세스당 한 번으로 접는다(10초 재연결 루프가 SQL 을 반복하지 않게)");
  ok(/selfNodeCleaned\.delete\(/.test(clean), "B11d 실패한 판은 안 한 것으로 되돌린다(다음 연결이 다시 본다)");
  ok(/inTenant\(c,/.test(clean), "B11e 연결의 테넌트 컨텍스트로 연다 — 없으면 공유 게이트웨이에서 RLS 가 조용히 0행을 만든다");
}

// ── B9. 노드 에이전트 — 종결 코드는 재연결하지 않는다 ─────────────────────────
//  이게 없으면 게이트웨이가 초당 한 번씩 인증·판정·거절을 반복한다(attempt 가 open 마다 0 으로 리셋된다).
{
  const f = body(AGENT, "const teardown = (");
  const iSelf = f.indexOf("CLOSE_SELF_NODE");
  const iDelay = f.indexOf("reconnectDelayMs(");
  ok(iSelf >= 0, "B9a teardown 이 종결 코드를 본다");
  ok(iDelay > iSelf, "B9b 종결 판정이 재연결 예약보다 **먼저** 온다");
}
ok(/ws\.once\("close",\s*\(code/.test(AGENT), "B9c close 코드를 실제로 받아 넘긴다(안 받으면 위 판정이 vacuous)");

// ── B10. 데스크톱 — 확답이면 노드 자동 시작을 건너뛴다 ────────────────────────
{
  const f = body(SHELL, "export function nextAfterSetup(");
  ok(/nodeSelfBox\s*===\s*true/.test(f), "B10a 확답(=== true)일 때만 건너뛴다 — 모름은 시작 쪽이다");
  ok(!/managed|lvly\.io|tenant|gatewayUrl/i.test(f),
    "B10b 배포 모양으로 갈라지지 않는다(#2044 결정 — 갈리는 축은 '이 기계에 대한 사실'뿐)");
}

// ── C. 기존 행 정리 — 살아 있는 세션의 행은 지우지 않는다 ─────────────────────
//  이 함수의 위험은 «되살릴 수 없는 죽은 행 청소»가 «살아 있는 세션 삭제»로 번지는 것이다.
//  세 조건(발견 행·좌표 미상·지금 tmux 에 없음)이 전부 붙어 있어야 그 경계가 성립한다.
{
  const f = body(SSTATE, "export async function clearSelfNodeSessionRows(");
  const del = (f.match(/DELETE FROM org_session_state[\s\S]*?`/) ?? [""])[0];
  ok(del.includes("node_id=$1"), "C-a 삭제는 **그 노드의 행만** 본다(진짜 멤버 PC 의 행은 손대지 않는다)");
  ok(del.includes("discovered=true"), "C1a 발견 행만 지운다");
  ok(del.includes("root_key IS NULL"), "C1b 좌표를 모르는 행만 지운다(되살릴 수 있는 행은 남긴다)");
  ok(/NOT\s*\(id\s*=\s*ANY/.test(del), "C2 ★지금 tmux 에 살아 있는 세션의 행은 지우지 않는다");
  const upd = (f.match(/UPDATE org_session_state[\s\S]*?`/) ?? [""])[0];
  ok(/SET node_id=NULL/.test(upd) && upd.includes("node_id=$1"),
    "C3 나머지 행은 좌표만 턴다(라벨·초대·마지막 프롬프트·대화 uuid 를 잃지 않는다)");
}
// 확답 없이 돌면 안 된다 — tmux 를 못 본 판을 '세션 0' 으로 읽으면 살아 있는 행이 전부 삭제 갈래로 몰린다.
{
  const f = body(NSS, "export async function cleanupSelfNodeRows(");
  const iStrict = f.indexOf("strict: true");
  const iCall = f.indexOf("clearSelfNodeSessionRows(");
  ok(iStrict >= 0 && iCall > iStrict, "C4a 살아 있는 세션 목록을 **확답으로** 얻은 뒤에만 정리한다");
  ok(/catch[\s\S]{0,200}?return;/.test(f.slice(0, iCall)), "C4b 못 봤으면 정리하지 않고 물러난다");
}

console.log(`\n${pass} passed, ${failed.length} failed`);
assert.equal(failed.length, 0, `배선이 서 있지 않다:\n  - ${failed.join("\n  - ")}`);
