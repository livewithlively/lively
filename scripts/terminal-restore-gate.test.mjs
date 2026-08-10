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
// ⑧⑨ 노드 세션(#869) — 중앙에 desired-state 가 없다. 메타가 복원 가능해 보여도 되살리지 않는다.
eq(goneMode({ restorable: true, canRestore: true, exitedByUser: false }, true), "end",
  "⑧노드 세션은 메타가 복원 가능해 보여도 중앙 복원 대상 아님");
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

console.log(`\n${pass} passed`);
