// GitHub 릴레이 완료(#2243 G) 순수 판정 — «설치»와 «인가»가 다른 사건이라는 규칙을 고정한다.
//  실행: npm run build && node dist/capabilities/github-relay-complete.test.js
//  DB 를 쓰지 않는 부분만 본다 — state 귀속·토큰 파싱 규칙. 저장(금고)은 통합 경로에서 확인한다.
process.env.CONNECTOR_SECRET_KEY ||= "0".repeat(64);
import assert from "node:assert/strict";
import { signState, verifyState } from "../org/credentials/oauth-broker.js";
import { parseGithubTokenResponse, GITHUB_APP_SERVER, isGithubAppServer } from "../org/credentials/github-app.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("GR1 state 귀속 — GitHub state 만 GitHub 완료로 받는다(다른 서버 state 는 거부돼야 한다)", () => {
  const st = signState({ m: "jang", s: GITHUB_APP_SERVER, k: "", n: "n1" });
  const p = verifyState(st);
  assert.equal(p.m, "jang");
  assert.ok(isGithubAppServer(p.s), "GitHub state 는 통과");
  const other = verifyState(signState({ m: "jang", s: "linear-app", k: "", n: "n2" }));
  assert.equal(isGithubAppServer(other.s), false, "Linear state 는 GitHub 완료에서 거부된다");
});

t("GR2 ★ GitHub 실패는 HTTP 200 + {error} 로 온다 — 파서가 그걸 잡아야 한다", () => {
  assert.throws(() => parseGithubTokenResponse({ error: "bad_verification_code", error_description: "만료됨" }),
    /bad_verification_code/, "status 만 보면 통과하는 자리 — 본문으로 판정한다");
  assert.throws(() => parseGithubTokenResponse({}), /access_token/, "토큰이 없으면 실패");
});

t("GR3 토큰 파싱 — 만료 있는 앱/없는 앱 둘 다 받는다(expires_in 은 선택)", () => {
  const withExp = parseGithubTokenResponse({ access_token: "gho_x", token_type: "bearer", expires_in: 28800, refresh_token: "ghr_y", scope: "repo" });
  assert.equal(withExp.access_token, "gho_x");
  assert.equal(withExp.expires_in, 28800);
  assert.equal(withExp.refresh_token, "ghr_y");
  const noExp = parseGithubTokenResponse({ access_token: "gho_z" });
  assert.equal(noExp.token_type, "bearer", "token_type 이 없으면 bearer 로 채운다");
  assert.equal(noExp.expires_in, undefined, "만료 없는 앱이면 만료 없음 — 0 으로 채우면 즉시 만료로 오판한다");
});

console.log(`\nok  #2243 GitHub 릴레이 완료 — ${pass}건`);
