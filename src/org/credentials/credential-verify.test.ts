// 자격 연결 확인 — 진단 문구 순수 단위 (#1881 F9). 네트워크 불요.
// 실행: npm run build && node dist/org/credentials/credential-verify.test.js
//
//  이 테스트가 지키는 것: 사용자가 보는 건 **한 문장**이고, 그 문장이 다음 행동을 말해 주지 못하면
//  이 기능은 없느니만 못하다("실패했습니다"만 뜨면 사용자는 멈춘다). 그래서 상태코드×본문 표를 그대로 돈다.
//  ★ 표의 첫 행은 2026-08-26 에 **실제로 받은 피그마 응답 원문**이다 — 가상의 문자열이 아니다.
import assert from "node:assert/strict";
import { diagnoseFigma, missingScopesFrom, verifierExists } from "./credential-verify.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// 2026-08-26 실측 원문(팀 열거 403). 앞의 나열은 '내가 가진 스코프', 뒤의 것이 '이 호출에 필요한 스코프'다.
const REAL_403 = '{"status":403,"err":"Invalid scope(s): file_comments:read, file_content:read, folders:read, file_metadata:read, current_user:read. This endpoint requires the projects:read scope"}';

t("★ 실측 원문에서 '필요한 스코프'만 뽑는다 — 앞의 나열(가진 것)에 속지 않는다", () => {
  assert.deepEqual(missingScopesFrom(REAL_403), ["projects:read"]);
});

t("스코프 문구가 없으면 빈 배열 — 없는 것을 지어내지 않는다", () => {
  assert.deepEqual(missingScopesFrom('{"err":"Not found"}'), []);
  assert.deepEqual(missingScopesFrom(""), []);
});

t("★ 스코프 누락은 '무엇을 켜야 하는지'와 '기존 토큰은 못 고친다'를 함께 말한다", () => {
  const msg = diagnoseFigma(403, REAL_403);
  assert.match(msg, /projects:read/, "빠진 스코프 이름이 문장에 없다 — 사용자가 무엇을 켤지 모른다");
  assert.match(msg, /켜/, "다음 행동(켜라)이 없다");
  assert.match(msg, /새로 만들/, "기존 토큰은 범위를 바꿀 수 없다는 사실이 빠졌다 — 사용자가 설정에서 헤맨다");
});

t("401 은 만료·삭제로 읽고 '새로 만들어 붙여넣어라'로 끝난다", () => {
  const msg = diagnoseFigma(401, '{"status":401,"err":"Invalid token"}');
  assert.match(msg, /거부/);
  assert.match(msg, /새로 만들/);
  assert.doesNotMatch(msg, /허용범위/, "만료를 스코프 문제로 오진하면 사용자가 엉뚱한 곳을 고친다");
});

t("본문이 invalid_token 이면 상태코드가 403 이어도 만료로 읽는다(상류가 코드를 흔든다)", () => {
  assert.match(diagnoseFigma(403, '{"err":"invalid_token"}'), /거부/);
});

t("스코프 언급 없는 403 은 current_user:read 를 짚어 준다 — /v1/me 가 막히는 유일한 이유다", () => {
  const msg = diagnoseFigma(403, '{"status":403,"err":"Forbidden"}');
  assert.match(msg, /current_user:read/);
});

t("429 는 '토큰이 틀렸다'로 말하지 않는다 — 멀쩡한 토큰을 지우게 만든다", () => {
  const msg = diagnoseFigma(429, "rate limited");
  assert.match(msg, /다시 시도/);
  assert.doesNotMatch(msg, /허용범위|거부됐/);
});

t("모르는 상태코드도 문장이 되고 코드가 남는다(사람이 물어볼 단서)", () => {
  assert.match(diagnoseFigma(500, "oops"), /500/);
});

t("배선: 확인 경로가 있는 kind 만 supported 로 답한다", () => {
  assert.equal(verifierExists("figma_token"), true);
  assert.equal(verifierExists("FIGMA_TOKEN"), true, "kind 는 대소문자로 갈리면 안 된다");
  assert.equal(verifierExists("prometheus_bearer"), false, "실제로 쳐 보지 않은 kind 를 지원한다고 말하면 이 기능이 거짓말을 한다");
  assert.equal(verifierExists(""), false);
});

console.log(`\ncredential-verify tests: ${pass} passed`);
