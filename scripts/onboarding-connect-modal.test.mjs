// 외부 앱 연결 모달 = 스테퍼 계약 (#2232, 2026-09-01).
//
//  원준님 지적 두 개가 이 화면의 사양이다:
//   ① «일부만 고를게요» 는 시작 전의 물음이 아니다 — 가져오기 시작이 기본, 좁히기는 **완료 뒤의 링크**.
//   ② 외부 사이트가 물을 낯선 화면(슬랙 워크스페이스 주소…)은 걸음 안에 **그 화면 그대로** 목업으로 미리 보여 준다.
//  이 파일은 그 두 결정이 소스에서 되돌아가지 않게 잠근다. 주석은 계약이 아니다 — 줄 단위로 주석을 걷어내고 본다
//  (실측: PR #635 에서 주석 속 단어가 금지어 검사에 걸렸다).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const RAW = readFileSync(new URL("../web/v2/onboarding.ts", import.meta.url), "utf8");
const SRC = RAW.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

test("배선 · 파일을 실제로 읽었다(vacuous 방지)", () => {
  assert.ok(SRC.length > 10000);
});

test("★ ① 시작 전 «전부 vs 일부» 물음이 없다 — 좁히기는 완료 띠 아래 링크다", () => {
  //  구판의 세 갈래(scope 걸음의 [전부/일부만] 버튼, 피그마 팀 걸음의 [일부 파일만]) 가 모두 사라졌어야 한다.
  assert.ok(!SRC.includes("일부만 고를게요"), "«일부만 고를게요» 버튼이 되살아났다 — 시작 전 결정 강요는 걷어낸 것(#2232)");
  assert.ok(!SRC.includes('id="scAll"') && !SRC.includes('id="scPick"') && !SRC.includes('id="teamPick"'),
    "구판 scope 걸음 버튼(scAll/scPick/teamPick)이 남아 있다");
  //  대신: 완료 띠(cnOk)가 떠야만 좁히기 링크(cnNarrow)가 그려진다.
  assert.ok(SRC.includes('id="cnNarrow"'), "좁히기 링크(cnNarrow)가 없다");
  assert.match(SRC, /cnOk \? cnOkHtml\(/, "완료 띠는 cnOk 일 때만 그린다는 배선이 사라졌다");
  assert.match(SRC, /몇 개만 모을까요\?/, "좁히기 링크 문구가 사라졌다");
});

test("★ ② 외부 화면 목업 — 그림이지 버튼이 아니다(aria-hidden) · 슬랙 워크스페이스 화면을 미리 그린다", () => {
  assert.match(SRC, /ob-bmock" aria-hidden="true"/, "목업(ob-bmock)이 보조기기에서 버튼처럼 읽힌다 — aria-hidden 이 빠졌다");
  assert.ok(SRC.includes("워크스페이스의 Slack URL"), "슬랙 워크스페이스 주소 화면 목업이 사라졌다");
  assert.ok(SRC.includes("워크스페이스 찾기"), "주소를 모르는 사람의 길(«워크스페이스 찾기») 안내가 사라졌다");
});

test("걸음을 갈아끼우지 않는다 — 판 교체 상태기(tokStep)가 없고, 스테퍼 상태(cnStep·cnOk)로 그린다", () => {
  assert.ok(!/\btokStep\b/.test(SRC), "구판의 판 교체 상태기(tokStep)가 남아 있다");
  assert.match(SRC, /let cnStep = 1/, "스테퍼 걸음 상태(cnStep)가 없다");
  assert.match(SRC, /let cnOk = false/, "완료 상태(cnOk)가 없다");
});

test("슬랙 좁히기는 최상위 channels 로 보낸다 — scope 그릇에 넣으면 서버가 조용히 무시한다", () => {
  //  slack-connect.ts 의 입력 스키마는 channels 를 **최상위**에서 받는다. 이 갈래가 없으면
  //  좁히기 화면은 성공한 척하고 실제로는 전 채널을 계속 모은다(조용한 거짓 성공).
  assert.match(SRC, /id === 'slack'.*Object\.assign\(body, scope\)/s, "슬랙 최상위 channels 갈래가 없다");
  assert.match(SRC, /id === 'slack' \? 'channels'/, "좁히기 키 매핑에 슬랙 channels 가 없다");
});

test("완료 띠의 문구 — 앱마다 «무엇이 들어오기 시작했는지»를 말한다(수집을 못 켜는 사람에겐 약속하지 않는다)", () => {
  for (const key of ["slack", "notion", "figma", "clickup", "github", "gitlab", "linear"]) {
    assert.match(SRC, new RegExp(`${key}: '[^']*(연결됐어요|가져오기 시작)`), `CN_OK.${key} 완료 문구가 없다`);
  }
  assert.match(SRC, /collectMode\(id\) && CN_OK\[id\]/, "수집 문구는 collectMode 로 가려야 한다 — 비관리자에게 «모으기 시작» 은 거짓이다");
});
