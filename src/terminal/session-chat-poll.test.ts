// 죽은 세션에 촘촘한 폴링을 쓰지 않는다 (#1631) — 화면 코드의 구조 불변식.
//
//  왜 텍스트로 재나: `web/session-chat.ts` 는 브라우저 전용(DOM·fetch)이라 여기서 실행할 수 없다.
//   그래서 이 저장소의 선례(ai-login.test 가 profiles.ts 원문을 읽는 방식)를 따라 **그 한 줄의 모양**을 못 박는다.
//
//  실측(2026-08-31 dev): 온보딩 킥오프 세션이 첫 실행 프롬프트에 즉사해 대화가 **한 번도** 없었다.
//   `running` 은 대화 파일이 자라야 마감되는데 그 마감 경로는 `cur`(현재 턴 레코드)을 요구하므로,
//   대화가 없던 세션은 거기 못 들어가 404 를 **초당 1.4회로 영원히** 되물었다(8초에 11회·콘솔 에러 200+).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../../web/session-chat.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");

test("폴링 주기 계산이 **살아 있음**을 조건에 넣는다 — 죽은 세션에 700ms 를 쓰지 않는다", () => {
  const line = SRC.split("\n").find((l) => l.includes("POLL_RUN_MS") && l.includes("POLL_IDLE_MS"));
  assert.ok(line, "주기를 고르는 줄을 못 찾았다");
  assert.match(line!, /running && !dead\(\)\s*\)?\s*\?\s*POLL_RUN_MS/,
    "박스 세션이 dead 여도 촘촘한 주기를 쓴다 — 즉사한 세션의 화면이 404 를 영원히 되묻는다(#1631)");
});

test("'아직 없음'(404/403)을 실패로 세지 않는다 — 그건 오류가 아니라 상태다", () => {
  assert.match(SRC, /const notYet = \(st === 404 && src\.kind === 'box'\)/,
    "notYet 판정이 사라졌다 — 첫 대화 전 세션에 «진행을 따라가지 못하고…» 가 뜬다");
  assert.match(SRC, /if \(notYet\) \{ fails = 0; \}/, "notYet 인데 실패로 센다");
});

test("죽은 세션에도 «터미널에서 이유 보기» 길을 준다 — 안내만 하고 길이 없으면 막다른 길이다", () => {
  //  래퍼는 하네스가 죽어도 pane 에 사유를 적고 세션을 살려 둔다(catalog.ts harnessExitNotice).
  //   실측 2026-08-31: 킥오프가 «폴더를 신뢰합니까?» 에 걸려 죽었고 그 물음이 pane 에 떠 있었는데,
  //   화면은 «대화 기록을 찾지 못했어요» 로 끝내고 그리로 갈 버튼조차 주지 않았다.
  assert.match(SRC, /주고받은 말이 없이 끝났어요/,
    "죽은 세션의 빈 화면이 «찾지 못했어요» 로 끝난다 — 사유가 어디 있는지 말하지 않는다");
  assert.match(SRC, /canType\(\) \? '터미널로 보기' : '터미널에서 이유 보기'/,
    "죽은 세션엔 터미널 버튼이 없다 — 안내가 가리키는 곳으로 갈 길이 없다");
});
