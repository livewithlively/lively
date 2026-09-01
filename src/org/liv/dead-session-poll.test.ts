// 죽은 세션 화면이 404 를 영원히 되묻지 않는다 (#1631, 2026-08-31 실측)
//
//  실측: 즉사한 리브 세션(box-…-070ca470)의 화면이 `/transcript?from=0` 에 **3초마다** 404 를 받았다.
//   60초를 재는 동안 계속 404 였고, 브라우저 콘솔에 37건이 쌓였다.
//
//  왜 기존 실패 경로로 안 멈추나 — catch 의 notYet 이
//      (st === 404 && src.kind === 'box') || …
//   라 박스 소스의 404 를 **조건 없이** '아직 없음'으로 보고 `fails = 0` 으로 되돌린다.
//   (log 소스에는 `&& !dead()` 가 붙어 있다 — 박스에만 빠져 있었다.)
//   그래서 fails 는 절대 3에 닿지 않고 schedule() 은 영원히 다시 걸린다.
//
//  c101 의 ④(`running && !dead()`)는 **주기**를 늦췄을 뿐(초당 1.4회 → 3초) 멈추게 하진 않았다.
//
//  web/ 은 브라우저 전용이라 실행할 수 없다. 이 저장소 선례(ai-login.test)대로 **그 코드의 모양**을 못 박는다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../../../web/session-chat.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const SCHED = SRC.slice(SRC.indexOf("function schedule()"), SRC.indexOf("function pokePoll()"));

test("① 죽은 세션은 폴링을 멈춘다 — 중앙 기록만이 아니라 박스 파일도", () => {
  assert.match(SCHED, /if \(dead\(\) && !running && \(src\.kind === 'log' \|\| loadedTo === 0\)\) return;/,
    "죽은 박스 세션이 계속 폴링한다 — 생길 일 없는 파일을 3초마다 묻는다");
});

test("② 대화가 **있었던** 세션까지 끊지 않는다(무회귀)", () => {
  //  loadedTo > 0 이면 파일이 실재한다 — 그건 404 가 안 나고, 끊으면 마지막 줄을 못 받는다.
  //  조건에 loadedTo 가 들어 있어야 그 구분이 산다.
  assert.match(SCHED, /loadedTo === 0/, "«한 번도 안 읽었다» 조건이 없다 — 읽던 세션까지 끊긴다");
  assert.doesNotMatch(SCHED, /if \(dead\(\)\) return;/, "죽었다고 무조건 끊는다 — 읽던 것도 끊긴다");
});

test("③ 되살아나면 다시 켜진다 — 404 를 줄이려다 화면을 얼리지 않는다", () => {
  //  ⚠ 죽음 판정은 틀릴 수 있다(#2108: 3초 스냅샷 지연을 죽음으로 읽었다).
  //   멈추기만 하고 되살리는 길이 없으면 그 화면은 영영 멈춘다 — 이게 이 수정의 가장 큰 위험이다.
  const UPD = SRC.slice(SRC.indexOf("const wasDead = dead();"));
  const body = UPD.slice(0, UPD.indexOf("ensureLive();"));
  assert.match(body, /if \(wasDead && !dead\(\) && !pollTimer && src\) schedule\(\);/,
    "죽음→살아남 전이에서 폴링을 다시 켜지 않는다 — 잘못 죽었다고 본 화면이 영영 멈춘다");
});

test("④ 박스 404 를 조건 없이 «아직 없음» 으로 보는 자리가 남아 있다는 사실을 기록한다", () => {
  //  이 줄 자체는 **고치지 않았다** — 살아 있는 세션은 첫 대화 전까지 정말로 404 이고,
  //  그때 fails 를 세면 «진행을 따라가지 못하고 있어요» 가 잘못 뜬다. 멈추는 책임은 schedule() 이 진다.
  //  그러니 이 검사는 «notYet 을 고치라» 가 아니라 «schedule() 이 유일한 제동장치임» 을 못 박는 것이다.
  assert.match(SRC, /const notYet = \(st === 404 && src\.kind === 'box'\)/,
    "notYet 의 모양이 바뀌었다 — 바뀌었다면 제동을 어디가 지는지 다시 따져야 한다");
});
