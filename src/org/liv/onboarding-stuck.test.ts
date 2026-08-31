// 온보딩이 «읽는 중» 에서 멈추지 않는다 (#1631, 2026-08-31 실측)
//
//  신고: 파일 13개를 올렸는데 진행률이 **11 / 13 에서 멈춰 한참** 있었다.
//  원인은 두 축을 같은 것으로 본 것이다:
//    S.upN            = 파일이 **올라간** 수            (13)
//    w.uploads.total  = **자료로 등록된** 수(서버 축)   (11)
//  서버는 등록까지 됐을 때만 응답에 source_id 를 싣는데(terminal-files.ts) 클라이언트가 그 값을 버리고
//  올라간 수를 목표로 삼았다. 그래서 «오지 않는 2건» 을 기다렸고, 그 폴러엔 **상한이 없었다**.
//  (바로 옆 분석 단계엔 ANALYZE_TIMEOUT_MS 가 있다 — 여기만 없었다.)
//
//  web/ 은 브라우저 전용이라 실행할 수 없다. 이 저장소 선례(ai-login.test)대로 **그 코드의 모양**을 못 박는다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../../../web/v2/onboarding.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const READ = SRC.slice(SRC.indexOf("function startReading()"), SRC.indexOf("async function analyzeUploads"));

test("① 업로드 응답의 source_id 를 버리지 않는다 — 등록 여부는 거기서만 알 수 있다", () => {
  assert.match(SRC, /if \(up && up\.source_id\) \{ S\.upIn\+\+; \}/,
    "등록된 수를 안 센다 — 올라간 수만으로는 서버 축과 만나지 않는다");
  assert.match(SRC, /S\.upFail\.push\(/, "등록 안 된 파일을 기억하지 않는다 — 사람에게 말할 수 없다");
});

test("② 읽기 목표가 **등록된 수**다(올라간 수가 아니다)", () => {
  assert.match(READ, /const target = \(\) => Math\.max\(S\.upIn \|\| 0,/,
    "목표가 upIn 이 아니다 — 등록이 하나라도 빠지면 영영 안 끝난다");
});

test("③ 폴러에 상한이 있다 — 없으면 무한히 돈다(이 신고의 본체)", () => {
  assert.match(READ, /READ_MAX_MS/, "상한 상수가 없다");
  assert.match(READ, /Date\.now\(\) - readStarted > READ_MAX_MS/, "상한을 실제로 검사하지 않는다");
  assert.match(READ, /finish\(\);/, "상한을 넘겨도 끝내지 않는다");
});

test("④ 상한을 넘기면 **사실대로 말한다** — 조용히 넘어가지 않는다", () => {
  assert.match(READ, /아직 정리에 안 들어왔어요/, "몇 건이 빠졌는지 말하지 않는다");
  assert.match(READ, /const left = Math\.max\(0, target\(\) - S\.read\.done\)/, "빠진 수를 세지 않는다");
});

test("⑤ 리브가 안 열렸으면 **왜** 안 열렸는지 말한다", () => {
  assert.match(SRC, /applied\.liv\.reason === 'ai-not-connected'/,
    "서버가 준 사유를 안 쓴다 — 시킨 걸 다 한 사람이 «리브는 어디 갔지» 로 남는다");
  assert.match(SRC, /\[외부 앱 연결\]에서 AI 를 이으면/, "사유만 말하고 갈 길을 안 준다");
});

test("⑥ 올린 게 0건이면 기다리지 않는다(무회귀)", () => {
  assert.match(READ, /if \(!target\(\)\) \{ finish\(\); return; \}/, "0건일 때 즉시 끝내는 길이 사라졌다");
});
