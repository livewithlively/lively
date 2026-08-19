// #1059 E — 웹터미널이 4410(세션 종료 확정)을 받았을 때의 판정 표를 고정한다.
//  이 갈림길은 눈으로 확인하기 비싸다(재부팅·자동회수로 죽은 세션을 실제로 만들어야 본다). 그런데 틀리면 티가 크다:
//   🔴 자동 복원이 너무 넓으면 — 내가 /exit 로 끝낸 세션이 링크를 열 때마다 되살아난다(사용자 의도 무시).
//   🔴 너무 좁으면 — 재부팅·자동회수로 끊긴 세션이 종전처럼 '종료됨' 배너로 끝나 그 자리에서 복원할 길이 없다
//      (이 변경이 메우려던 갭 그 자체).
//   🔴 서버가 덜 알려줬을 때(권한·exit 여부 필드 부재) 자동으로 되살리면, 남의 세션·의도적 종료를 되살릴 수 있다.
//  판정 함수(goneMode)는 **모듈에서 직접 import** 한다 — 종전엔 브라우저용 클래식 스크립트라 소스에서 선언만
//  잘라 평가했는데(#1313 R51 이전), 페이지가 TS 로 편입되면서 실제 모듈을 그대로 부를 수 있게 됐다.
//  ('전역 의존 없는 순수 함수'라는 성질은 여전히 여기서 강제된다 — 전역을 잡으면 노드 import 에서 터진다.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { importTerminalModule } from "./standalone-terminal-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// 배선(무엇이 무엇을 부르는가)만 소스 텍스트로 확인한다 — 순수 함수 테스트로는 못 잡는 자리(아래 ㉟㉘㉒).
const src = readFileSync(join(root, "web/standalone/terminal.ts"), "utf8");

const { goneMode } = await importTerminalModule();
assert.equal(typeof goneMode, "function", "goneMode 를 모듈에서 가져오지 못했습니다");

let pass = 0;
const eq = (got, want, n) => { assert.equal(got, want, `${n}: '${want}' 여야 하는데 '${got}'`); pass++; console.log(`ok  ${n}`); };

// 표의 11행 — 사양(scratchpad/spec.md)의 행마다 하나씩.
// ① 자동 복원 — 사용자 개입 없이 세션을 되살리는 유일한 칸.
eq(goneMode({ restorable: true, canRestore: true, exitedByUser: false }, false), "auto",
  "①중단됨(재부팅·자동회수) + 내 세션 → 자동 복원");
// ② 내가 끝낸 것은 묻는다.
eq(goneMode({ restorable: true, canRestore: true, exitedByUser: true }, false), "ask",
  "②내가 /exit 로 끝낸 세션 → 되살릴지 물어봄");
// ③④ 복원 권한 없음 — exit 여부와 무관하게 같은 답.
eq(goneMode({ restorable: true, canRestore: false, exitedByUser: false }, false), "notowner",
  "③복원가능하지만 내 세션이 아님(프로젝트 공동 세션) → 복원 불가 안내");
eq(goneMode({ restorable: true, canRestore: false, exitedByUser: true }, false), "notowner",
  "④남의 세션은 exit 여부와 무관하게 복원 불가");
// ⑤⑥⑦ 복원할 근거 없음 → 종전 동작(종료 배너). 여기서 auto 로 새면 없는 세션을 되살리려 든다.
eq(goneMode(null, false), "end", "⑤메타 조회 실패(403·네트워크) → 종료 안내");
eq(goneMode({}, false), "end", "⑥응답은 왔으나 복원 정보 없음 → 종료 안내");
eq(goneMode({ restorable: false, canRestore: true }, false), "end", "⑦restorable=false 는 권한이 있어도 종료 안내");
// ⑧⑨ 노드 세션 — #1791 뒤 노드 세션도 중앙 desired-state(node_id)를 가진다. 판정표는 박스와 **같다**: 메타(GET …?node=)가
//  복원 가능이라 하면 같은 길(auto/ask/notowner)로 가고, 메타가 없으면 종전처럼 종료 안내. (종전 ⑧은 "노드는 무조건 end" —
//  노드 세션엔 desired-state 가 없던 시절의 규칙이라 뒤집는다. 되살리는 실제 동작은 서버가 그 노드에 create 를 릴레이한다.)
eq(goneMode({ restorable: true, canRestore: true, exitedByUser: false }, true), "auto",
  "⑧노드 세션도 메타가 복원 가능(내 세션·중단됨)이면 박스와 같이 자동 복원");
eq(goneMode({ restorable: true, canRestore: false }, true), "notowner", "⑧-b 노드 세션 남의 것 → 복원 불가 안내(박스와 동일)");
eq(goneMode(null, true), "end", "⑨노드 세션 + 메타 없음 → 종료 안내");
// ⑩⑪ 이번에 새로 도입한 필드가 비어 올 때의 기본값 — 불확실하면 자동으로 되살리지 않는다(안전측).
eq(goneMode({ restorable: true }, false), "notowner",
  "⑩권한 정보(canRestore)가 없으면 자동 복원하지 않는다");
eq(goneMode({ restorable: true, canRestore: true }, false), "auto",
  "⑪exit 여부 정보가 없으면 '중단됨'으로 보고 복원한다");

// ── ①-a 자동 복원 게이트: '내가 끝냈다'는 신호와 하네스 ──────────────────────────
// 실측 사고(2026-07-28): **셸 세션에서 exit** 했는데 자동 복원이 되살렸다. 셸엔 claude 훅이 없어 exited_at 을
//  원리적으로 기록할 수 없고, 이어받을 대화도 없다 → 자동 복원은 exit 를 무시하는 셈이 된다. 그리고 이 탭에서
//  키를 눌렀다는 사실 자체가 '내가 만지다 끝냈다'의 신호다(자동 복원의 목적은 '열었더니 죽어 있다'뿐).
const mid = { restorable: true, canRestore: true, exitedByUser: false, harness: "claude" };
eq(goneMode(mid, false, false, false), "auto", "㉙claude + 중단됨 + 입력없음 = 자동 복원(유일한 auto)");
eq(goneMode({ ...mid, harness: "shell" }, false, false, false), "ask",
  "㉚셸 세션은 자동 복원하지 않는다(exit 신호를 얻을 수 없고 이어받을 대화도 없다)");
eq(goneMode({ ...mid, harness: "codex" }, false, false, false), "ask", "㉛claude 가 아닌 하네스 전부 동일");
eq(goneMode(mid, false, false, true), "ask", "㉜이 탭에서 입력이 있었으면 자동 복원하지 않는다");
eq(goneMode({ ...mid, harness: undefined }, false, false, false), "auto",
  "㉞harness 미상(구 응답)은 종전대로 auto — 새 필드 부재가 기능을 죽이지 않는다");

// 배선 단언 — 판정이 옳아도 **신호가 안 들어오면** 기능이 죽는다(userTyped 가 영원히 false → 셸 아닌 세션에서
//  내가 exit 해도 자동 복원됨). 순수 함수 테스트로는 못 잡으니 소스에서 배선을 직접 확인한다.
{
  const i = src.indexOf("term.onData(");
  assert.ok(i > 0, "term.onData 핸들러를 찾지 못했습니다");
  let block = src.slice(i, i + 500);
  // #1117: 핸들러가 최상위 함수로 분리될 수 있다(term.onData(handleTermData) — 회귀 테스트가 실배선을 직접
  //  호출하기 위한 구조). 그 경우 지시자를 따라가 '그 함수 본체'에서 신호를 확인한다 — 단언의 의도(입력 경로가
  //  userTyped 를 세운다)는 동일하고, 신호를 지우면 여전히 빨간불이 된다.
  const ind = block.match(/term\.onData\(\s*([A-Za-z_$][\w$]*)\s*\)/);
  if (ind) {
    const j = src.indexOf(`function ${ind[1]}(`);
    assert.ok(j > 0, `onData 핸들러 본체(${ind[1]})를 찾지 못했습니다`);
    block = src.slice(j, j + 1200);
  }
  assert.ok(/userTyped\s*=\s*true/.test(block),
    "㉟term.onData(핸들러 본체)에서 userTyped 를 세우지 않습니다 — 입력 신호가 죽어 자동 복원이 exit 를 무시합니다");
  pass++; console.log("ok  ㉟키 입력이 userTyped 신호를 세운다(배선)");
}

// ── ①-b 루프 차단: 복원으로 열린 페이지는 다시 자동 복원하지 않는다 ──────────────────
// 실측 사고(2026-07-28): 이어받을 대화가 없는 UUID 로 resume 하면 claude 가 즉시 종료되고, box-spawn 이 exec 라
//  tmux 세션도 함께 사라진다 → 4410 → 자동 복원 → 또 즉사. 화면이 끝없이 새로고침됐다. 그래서 '복원으로 열린
//  세션'은 어떤 상태여도 auto 가 되면 안 된다. 이 세 행이 그 브레이크다.
eq(goneMode({ restorable: true, canRestore: true, exitedByUser: false, harness: "claude" }, false, true), "loop",
  "㉓복원으로 열린 페이지가 (내 조작 없이) 또 끊기면 자동 복원하지 않는다(루프 차단)");
// ⚠ 2026-07-28 정정: 종전엔 이 케이스를 loop 로 잡았는데, 그러면 '복원해서 쓰다가 또 exit 한' 정상 종료에
//  "이어받을 대화를 못 찾았다"는 **틀린 설명**이 떴다(실측 신고). exit 기록은 loop 보다 앞선다.
eq(goneMode({ restorable: true, canRestore: true, exitedByUser: true, harness: "claude" }, false, true), "ask",
  "㉔exit 기록이 있으면 복원 직후여도 loop 가 아니라 ask (문구가 사유를 맞게 말해야 한다)");
eq(goneMode({ restorable: true, canRestore: false, exitedByUser: false }, false, true), "notowner",
  "㉕권한 없음이 loop 보다 앞선다(남의 세션은 애초에 복원 불가)");
eq(goneMode(null, false, true), "end", "㉖복원 직후여도 기록이 없으면 종료 안내");
// 표식이 없으면 종전대로 자동 복원 — 브레이크가 정상 경로를 막지 않는지 확인(이게 없으면 기능이 죽는다).
eq(goneMode({ restorable: true, canRestore: true, exitedByUser: false }, false, false), "auto",
  "㉗표식이 없으면 종전대로 자동 복원");

// 복원이 새 주소에 표식을 붙이는지 — 붙이지 않으면 위 브레이크가 영원히 안 걸린다(소스로 확인).
{
  const line = src.split("\n").find((l) => l.includes("location.replace(apiUrl('/ui/terminal.html?session=')"));
  assert.ok(line, "복원 후 이동 줄을 찾지 못했습니다");
  const blk = src.slice(src.indexOf(line), src.indexOf(line) + 400);
  assert.ok(/restored=1/.test(blk), "㉘복원 후 주소에 restored=1 표식이 없습니다 — 루프 차단이 발동하지 않습니다");
  pass++; console.log("ok  ㉘복원 후 주소에 restored=1 표식을 붙인다");
}
// #1791 — 노드에서 복원된 새 세션은 **그 노드로** 붙어야 한다(서버가 session.node 를 준다). 이걸 안 붙이면 새 주소가 박스로 가서
//  4410(박스엔 그 세션이 없다) → 종료 배너로 끝난다. 배선(주소 조립)만 소스로 확인한다.
{
  const line = src.split("\n").find((l) => l.includes("location.replace(apiUrl('/ui/terminal.html?session=')"));
  const blk = src.slice(src.indexOf(line), src.indexOf(line) + 600);
  assert.ok(/ns\.node\s*&&\s*ns\.node\.id[\s\S]*&node=/.test(blk), "㉙-b 복원 후 주소에 새 세션의 node 를 붙이지 않습니다 — 노드 복원이 박스로 가서 끝납니다");
  pass++; console.log("ok  ㉙-b 노드에서 복원된 세션은 그 노드로 붙는다(배선)");
}
// 노드 세션도 메타를 묻는다(종전엔 !NODE_ID 게이트로 아예 안 물었다 — 그러면 ⑧ 이 영영 발동 못 한다).
{
  const i = src.indexOf("async function onSessionGone()");
  assert.ok(i > 0, "onSessionGone 을 찾지 못했습니다");
  const blk = src.slice(i, i + 900);
  assert.ok(!/if\s*\(\s*!NODE_ID\s*\)\s*\{?\s*try\s*\{\s*meta\s*=/.test(blk), "㉙-c 노드 세션은 메타 조회를 건너뜁니다 — 노드 복원이 발동하지 않습니다");
  assert.ok(/meta\s*=\s*await\s+api\(sUrl\(''\)\)/.test(blk), "㉙-c onSessionGone 이 sUrl('')(node 쿼리 포함)로 메타를 묻지 않습니다");
  pass++; console.log("ok  ㉙-c 노드 세션도 메타를 묻는다(배선)");
}

// ── ② 프리뷰 접두사(API_PREFIX / apiUrl) ─────────────────────────────────────────
// 이 페이지가 프리뷰 서브패스(/preview/<id>/) 아래에서 뜨면 fetch·내비게이션도 그 프리뷰로 가야 한다.
//  이게 없을 때의 증상이 실제로 났다(2026-07-27, 상민님 신고): 프리뷰로 웹터미널을 열면 정적 파일은 새 코드인데
//  API 는 루트 절대경로로 새어 **라이브(구) 백엔드**로 갔고 → 새 API 를 쓰는 기능(#1059 딥링크 자동 복원)이
//  프리뷰에서 조용히 옛 동작('종료됨' 배너)으로 보였다. 잘못된 빨간불·초록불을 만드는 자리라 표로 박는다.
//  location.pathname 이 다른 상태로 모듈을 각각 평가한다 — 실제 모듈의 최상위 판정이 그대로 돌아간다
//  (종전엔 소스에서 블록을 오려 new Function 에 location 을 주입했다. 오려낸 조각이 아니라 진짜 모듈을 본다).
const mk = (pathname) => importTerminalModule({ pathname });

const preview = await mk("/preview/p1059-context-ontology/ui/terminal.html");
const live = await mk("/ui/terminal.html");
eq(preview.API_PREFIX, "/preview/p1059-context-ontology", "⑫프리뷰 경로에서 접두사를 유도한다");
eq(live.API_PREFIX, "", "⑬라이브 경로에선 접두사가 없다");
eq(preview.apiUrl("/api/ui/terminal/sessions/box-x"), "/preview/p1059-context-ontology/api/ui/terminal/sessions/box-x",
  "⑭프리뷰: API 가 자식 백엔드로 간다(이게 안 되면 새 프론트+구 백엔드가 된다)");
eq(live.apiUrl("/api/ui/terminal/sessions/box-x"), "/api/ui/terminal/sessions/box-x", "⑮라이브: 경로 그대로");
eq(preview.apiUrl("/ui/terminal.html?session=box-x"), "/preview/p1059-context-ontology/ui/terminal.html?session=box-x",
  "⑯프리뷰: 내비게이션(복원 후 새 세션 주소)도 프리뷰 안에서 이어진다");
// 유사 경로·빈 id 에 오탐하면 라이브에서 없는 접두사를 붙여 전부 404 가 된다.
eq((await mk("/previewX/y/ui/terminal.html")).API_PREFIX, "", "⑰/previewX/… 는 프리뷰가 아니다(오탐 금지)");
eq((await mk("/preview//ui/terminal.html")).API_PREFIX, "", "⑱id 없는 /preview// 는 접두사 아님");
eq((await mk("/ui/preview/p1/x.html")).API_PREFIX, "", "⑲경로 중간의 preview 는 접두사 아님(선두만)");
// 상대경로·절대 URL 은 건드리지 않는다(접두사를 붙이면 깨진다).
eq(preview.apiUrl("app/core.js"), "app/core.js", "⑳상대경로는 그대로");
eq(preview.apiUrl("https://other.example/x"), "https://other.example/x", "㉑절대 URL 은 그대로");
// WS 와 티켓은 **같은 곳**으로 가야 한다 — 화면이 놓인 오리진+접두사(프리뷰면 프리뷰 자식).
//  ⚠ 이 계약은 한 번 뒤집혔다(#1541). 예전엔 "WS 에 접두사를 붙이면 안 된다(프리뷰가 upgrade 미처리)" 였고
//   이 테스트가 그걸 잠그고 있었다. preview/ws-proxy.ts 로 upgrade 중계가 생기면서 전제가 사라졌고,
//   무엇보다 그 우회는 **노드 세션에서 틀렸다**: 노드는 자기가 등록한 게이트웨이(프리뷰 자식)의 인메모리
//   레지스트리에 붙는데 브라우저 WS 만 본체로 가면 본체는 그 노드를 몰라 4462 → "연결 끊김·재연결" 무한 반복.
//   지금 잠그는 것은 방향이 아니라 **짝**이다: 티켓(인메모리)과 WS 가 갈리면 어느 방향이든 깨진다.
{
  const wsLine = src.split("\n").find((l) => l.includes("new WebSocket("));
  assert.ok(wsLine, "WebSocket 생성 줄을 찾지 못했습니다");
  assert.ok(/apiUrl\(/.test(wsLine), "㉒WS URL 이 화면 접두사를 따라가야 합니다(노드 세션이 4462 로 깨집니다): " + wsLine.trim());
  const ticketLine = src.split("\n").find((l) => l.includes("/api/ui/terminal/ticket"));
  assert.ok(ticketLine, "티켓 발급 줄을 찾지 못했습니다");
  assert.ok(!/mainOrigin/.test(ticketLine),
    "㉒티켓만 본체로 보내면 WS 와 짝이 갈립니다(받는 쪽이 그 티켓을 모릅니다): " + ticketLine.trim());
  pass++; console.log("ok  ㉒WS 와 티켓이 같은 곳으로 간다(짝 불변식)");
}

// ── ㉝ 캡처가 얼어붙는 백엔드(psmux + 앱 팬) 폴백 — 크기 넛지로 앱 재그리기 (#1541 실측) ──────────
// A/B 실측(같은 Windows 노드 hammurabi, 2026-08-11 같은 분): powershell 팬 → 캡처 40줄 정상·블록 정상 종료·
//  이후 리사이즈 %output 정상 / Claude Code 팬 → **`alt=0` 으로 보고되는데도** 캡처 블록이 끝내 안 닫히고
//  제어 스트림이 멈춘다. 그래서 새로고침하면 하얀 화면이 됐다(브라우저 실측 6/6). 입력은 앱에 도달하는데
//  결과가 안 보여 "타이핑이 안 된다 · 클로드가 죽었다" 로 보였다.
// ⚠ 판별축은 alt 가 **아니다** — Windows 는 ConPTY 가 앱 출력을 커서이동+`[K` 로 정규화해 1049h 가 흐르지 않고,
//  psmux 의 alternate_on 은 사실상 항상 0 이다. 포그라운드가 셸인지로 가른다(captureAllowed).
{
  const { nudgeSizes } = preview;   // 모듈에서 export — 순수 계산부만 검증한다
  const ok2 = (cond, n) => { assert.ok(cond, n); pass++; console.log(`ok  ${n}`); };
  // 줄였다 되돌린다: 이 순서가 곧 '앱이 리사이즈를 두 번 받아 전체를 다시 그린다'는 뜻이다.
  eq(JSON.stringify(nudgeSizes(120, 40)), JSON.stringify([{ t: 'r', c: 120, r: 39 }, { t: 'r', c: 120, r: 40 }]),
    "㉝ 넛지는 r-1 로 줄였다가 원래 r 로 되돌린다");
  // 되돌린 값이 원래와 같아야 한다 — 안 그러면 넛지가 크기를 영구히 바꿔버린다.
  const [, back] = nudgeSizes(80, 24);
  eq(back.r === 24 && back.c === 80, true, "㉝ 넛지 후 크기가 원래대로 복원된다");
  // 줄일 수 없는 크기는 넛지하지 않는다(0줄 pane 을 만들지 않는다).
  eq(nudgeSizes(80, 1), null, "㉝ 1줄짜리는 넛지 불가 — null");
  eq(nudgeSizes(0, 40), null, "㉝ 폭 0 은 넛지 불가 — null");
}
// 폴백이 **관측된 사실**로만 열리는지(플랫폼 스니핑 아님) — 소스로 확인.
{
  const ok2 = (cond, n) => { assert.ok(cond, n); pass++; console.log(`ok  ${n}`); };
  // 주석은 걷어내고 **코드만** 본다 — 아래 부정 단언이 설명 주석에 걸려 거짓 실패하지 않게.
  const watch = src.split("function armBackfillWatch")[1].split("\n}")[0]
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  ok2(/if \(!st\) return;/.test(watch), "㉝ 폴백은 '보낸 캡처가 안 돌아왔다'는 사실 하나로 연다");
  // ⚠ 이 부정 단언이 핵심 회귀 방어다. 종전엔 여기서 `|| !st.alt` 로 한 번 더 걸렀는데, psmux 는 alt 를 사실상
  //  항상 0 으로 보고하므로 그 폴백이 **한 번도 발동하지 못했다** — 캡처가 스트림을 멈춘 뒤 복구 시도조차 없었다.
  ok2(!/st\.alt/.test(watch), "㉝ 폴백 게이트는 alt 로 다시 거르지 않는다(psmux 는 alt 를 항상 0 으로 보고한다 — 실측)");
  // (옛 단언 '플랫폼 스니핑 금지' 는 폐기했다: psmux 는 앱이 도는 팬 캡처에서 **제어 스트림이 멈춘다**는 것이
  //  드러나, 사후 회복이 아니라 '그 조합엔 처음부터 안 건다'가 유일한 해법이 됐다. 백엔드 식별이 이제 요건이다.
  //  단, 식별은 서버가 알려준 사실(mux=)이나 관측된 지문이지 클라의 추측이 아니다 — 아래 ㉝ 블록이 그걸 지킨다.)
}

// ── ㉝ psmux alt-screen 에는 capture-pane 을 걸지 않는다 (#1541 실측) ────────────────────────
// 실측 트레이스: alt-screen 팬에 capture 를 걸면 `%begin` 뒤로 **제어 스트림 전체가 멈춘다**(9초 무응답).
//  앱 출력·리사이즈 응답까지 통째로 막혀 새로고침 후 하얀 화면으로 굳는다 — 클라에서 사후 복구가 불가능하다.
//  그래서 '걸고 나서 회복'이 아니라 **처음부터 걸지 않는다**. 판정은 관측(백엔드·alt)만 쓴다.
{
  const { captureAllowed, captureSafeBackend, isShellCmd, nudgeSizes } = preview;
  const ok3 = (c, n) => { assert.ok(c, n); pass++; console.log(`ok  ${n}`); };
  // ── A. 「갓 받은 상태」로 '지금 이 팬에 걸어도 되나' ──
  // ⚠ 판별축은 alt 가 아니라 **포그라운드가 셸인가** 다. 2026-08-11 실기기(hammurabi/psmux) 실측으로 뒤집혔다:
  //  같은 노드·같은 분에 powershell 팬은 40줄 정상 캡처 + 스트림 생존인데, Claude Code 가 도는 팬은
  //  **alt=0 으로 보고되면서도** 캡처 블록이 안 닫히고 제어 스트림이 멈췄다. Windows 는 ConPTY 가 앱 출력을
  //  정규화해 1049h 가 흐르지 않아 psmux 의 alternate_on 이 사실상 항상 0 이다 → alt 게이트는 한 번도 발동 못 했다.
  ok3(captureAllowed({ mux: 'psmux', alt: false, cmd: 'claude' }) === false,
    "㉝A1 psmux + 앱 팬 → 금지 (alt=0 으로 보고돼도 캡처가 스트림을 멈춘다 — 실측)");
  ok3(captureAllowed({ mux: 'psmux', alt: false, cmd: 'powershell' }) === true,
    "㉝A2 psmux + 셸 팬 → 허용 (실측 40줄 정상 · 셸은 리사이즈로 다시 안 그리니 캡처가 유일한 복원 수단)");
  ok3(captureAllowed({ mux: 'psmux', alt: true, cmd: 'powershell.exe' }) === true, "㉝A3 psmux 셸 판별은 .exe 를 벗긴다");
  ok3(captureAllowed({ mux: 'psmux', alt: true, cmd: 'C:\\\\Windows\\\\System32\\\\cmd.exe' }) === true, "㉝A4 psmux 셸 판별은 Windows 경로도 벗긴다");
  ok3(captureAllowed({ mux: 'psmux', cmd: '' }) === false, "㉝A5 psmux + cmd 미상 → 금지(구 서버 degrade 는 안전한 쪽으로)");
  ok3(captureAllowed({ mux: 'tmux', alt: true, cmd: 'nvim' }) === true, "㉝A6 tmux 는 앱 팬·alt-screen 도 캡처가 정상");
  ok3(captureAllowed({ alt: true, flagsMissing: true, cmd: 'claude' }) === false, "㉝A7 mux 미상 + flag 전부 빈 값 = psmux 지문 → 앱 팬이면 금지");
  ok3(captureAllowed({ alt: true, flagsMissing: false, cmd: 'nvim' }) === true, "㉝A8 mux 미상이라도 flag 가 오면 tmux → 허용");
  // ⚠ 미상은 **금지**다(fail-closed). 종전엔 여기서 '허용'을 못 박고 있었는데, 그 fail-open 이 #1541
  //  '새로고침하면 하얀 화면'의 직접 원인이었다 — forceRedraw 는 첫 상태블록보다 **먼저** 도는 경로가
  //  셋(폰트 정착·focus·visibilitychange)이라, 그 창에서 psmux 팬에 캡처가 나가 제어 스트림이 멈췄다.
  ok3(captureAllowed(null) === false, "㉝A9 상태 없음 → 캡처 금지(fail-open 이 #1541 하얀 화면의 원인이었다)");
  ok3(captureAllowed(undefined) === false, "㉝A10 상태 undefined → 캡처 금지");

  // isShellCmd — 두 판정(캡처 허용 · 마우스 flag stale)이 공유하는 축.
  for (const c of ['zsh', '-zsh', '/bin/bash', 'powershell', 'pwsh', 'cmd', 'C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'])
    ok3(isShellCmd(c) === true, `㉝S 셸로 판별: ${c}`);
  for (const c of ['claude', 'claude.exe', 'claude.exe.old', 'nvim', 'node', '', null, undefined])
    ok3(isShellCmd(c) === false, `㉝S 셸이 아님: ${String(c)}`);

  // ── B. 「최근 상태 사본」으로 '즉시 걸어도 되나' — **백엔드 정체만** 본다 ──
  // alt 는 매 순간 변하므로 사본으로 믿으면 안 된다: 셸 프롬프트에서 상태를 받아둔 뒤 사용자가 앱을 띄우면
  //  사본은 alt=0 인데 실제 팬은 alt-screen 이라, 그 사본을 믿고 캡처를 걸면 스트림이 잠긴다(탭 복귀 경로).
  //  정체(tmux/psmux)는 세션 내내 안 변하므로 사본으로 믿어도 된다.
  ok3(captureSafeBackend(null) === false, "㉝B1 백엔드 미상 → 즉시 캡처 금지(상태를 물어보고 판정한다)");
  ok3(captureSafeBackend({ mux: 'psmux', alt: false }) === false, "㉝B2 psmux 는 사본이 normal 이어도 즉시 캡처 금지(alt 는 stale 할 수 있다)");
  ok3(captureSafeBackend({ mux: 'psmux', alt: true }) === false, "㉝B3 psmux + alt → 금지");
  ok3(captureSafeBackend({ mux: 'tmux', alt: false }) === true, "㉝B4 tmux + normal → 허용");
  ok3(captureSafeBackend({ mux: 'tmux', alt: true }) === true, "㉝B5 tmux 는 alt 여도 허용(정체만 본다)");
  ok3(captureSafeBackend({ flagsMissing: true }) === false, "㉝B6 구 번들 지문이 psmux → 금지");
  ok3(captureSafeBackend({ flagsMissing: false }) === true, "㉝B7 구 번들이라도 flag 가 오면 tmux → 허용");
  ok3(captureSafeBackend({ mux: '', flagsMissing: true }) === false, "㉝B8 mux 가 빈 문자열이면 '안 알려준 것' → 지문 경로로 판정");
  // 넛지는 원래 크기로 정확히 복원한다 — 회복하려다 크기를 영구히 바꾸면 안 된다.
  eq(JSON.stringify(nudgeSizes(120, 40)), JSON.stringify([{ t: 'r', c: 120, r: 39 }, { t: 'r', c: 120, r: 40 }]),
    "㉝ 넛지는 r-1 로 줄였다가 원래 r 로 되돌린다");
  eq(nudgeSizes(80, 1), null, "㉝ 1줄짜리는 넛지 불가");
}

console.log(`\n${pass} passed`);
