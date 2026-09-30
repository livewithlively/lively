// #4445 — 처음 설정 «수집처 고르기» 에서 구글(드라이브·Gmail)은 서버가 «준비됐다» 고 하기 전엔 **처음부터** 잠겨 있다.
//
//  원준 2026-09-30 신고: "온보딩할 때 수집처 고르는거에서 구글도 가능한 것처럼 되어있고 비활성화 안돼어있는데".
//  매니지드 실측(헤드리스): 서버는 구글 ready:false 를 정확히 내리는데, 화면이 그 답을 받기 전(CONN===null)엔
//   connState 가 null(모른다)을 돌려 구글 카드를 고를 수 있게 그렸다 — 보통 0.5초, 느린 서버면 그만큼, 자격 목록을 못
//   읽으면 영영. 그 틈에 누른 구글은 저장된 고른 목록에 남아 다음 장면(연결)으로 끌려갔다.
//  구글의 «준비 중» 은 soonUntilReady — **모르면 잠근다**가 정본(catalogSoon) 규약이다. 화면이 그 규약을 따르게 한다.
//
//  엣지 표(사양):
//   E1 서버 답 전 · 구글(soonUntilReady)          → 잠김
//   E2 서버 답 전 · 준비 중 표식 없는 앱(노션 등)   → 모른다(잠그지 않는다)
//   E3 서버 답 · 구글 ready:false / ready 필드 없음 → 잠김
//   E4 서버 답 · 구글 ready:true                   → 연다
//   E5 표가 준비 중(캘린더 — soon, soonUntilReady 아님) → 언제나 잠김
//   E6 잠기기 전에 골라 둔 구글                     → 저장된 고른 목록에서 빠진다
//  주석은 계약이 아니다 — 소스 검사는 주석 줄을 걷어내고 본다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const strip = (raw) => raw.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
const SRC = strip(readFileSync(path.join(root, "web/v2/onboarding.ts"), "utf8"));
const LOGINS = strip(readFileSync(path.join(root, "web/me-logins.ts"), "utf8"));

// connect-axes 는 순수 모듈 — 그대로 컴파일해 규약 자체를 돌려 본다.
const out = mkdtempSync(path.join(tmpdir(), "ob-gsoon-"));
execFileSync(path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/connect-axes.ts"), "--rootDir", path.join(root, "web"),
   "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"], { stdio: "inherit" });
const { catalogSoon } = await import(path.join(out, "lib/connect-axes.js"));

/** connState 함수 본문(다음 function 전까지). */
const connStateBody = (() => {
  const i = SRC.indexOf("function connState(id)");
  assert.ok(i > 0, "connState 를 못 찾았다");
  return SRC.slice(i, SRC.indexOf("\n  function ", i + 10));
})();
/** 수집처 고르기 장면(sources: { … }). */
const sourcesScene = (() => {
  const i = SRC.indexOf("    sources: {");
  assert.ok(i > 0, "sources 장면을 못 찾았다");
  return SRC.slice(i, SRC.indexOf("\n    /*", i));
})();

test("배선 · 파일을 실제로 읽었다(vacuous 방지)", () => {
  assert.ok(SRC.length > 10000 && connStateBody.length > 200 && sourcesScene.length > 1000);
  assert.equal(typeof catalogSoon, "function");
});

test("E1~E5 규약 · catalogSoon — 모르면 구글은 준비 중, 서버가 준비됐다고 해야 연다", () => {
  const google = { soon: "준비 중", soonUntilReady: true };
  assert.equal(catalogSoon(google, null), true, "E1 서버 답 전(커넥터 모름)");
  assert.equal(catalogSoon(google, undefined), true, "E1 커넥터 줄 없음");
  assert.equal(catalogSoon({ oauth: "notion" }, null), false, "E2 준비 중 표식 없는 앱은 모른다고 잠그지 않는다");
  assert.equal(catalogSoon(google, { ready: false }), true, "E3 ready:false");
  assert.equal(catalogSoon(google, {}), true, "E3 ready 필드 없음(옛 게이트웨이)");
  assert.equal(catalogSoon(google, { ready: true }), false, "E4 ready:true 면 연다");
  assert.equal(catalogSoon({ soon: "준비 중" }, { ready: true }), true, "E5 soonUntilReady 아닌 준비 중은 서버 답과 무관");
});

test("E1 전제 · 표의 구글 줄은 soonUntilReady 다(그래야 E1 규약이 구글에 걸린다)", () => {
  assert.match(LOGINS, /key: 'google'[\s\S]{0,400}?soonUntilReady: true/, "LOGIN_SERVICES 구글 줄에 soonUntilReady 가 없다");
});

test("★ E1·E2 connState — 서버에 못 물었어도(!CONN) catalogSoon 인 앱은 'blocked', 그 밖은 null", () => {
  assert.ok(!/if \(!svc \|\| !CONN\) return null/.test(connStateBody), "!CONN 이 곧장 null 로 떨어진다 — 구글이 고를 수 있는 카드로 선다");
  assert.match(connStateBody, /if \(!CONN\) return catalogSoon\(svc, null\) \? 'blocked' : null;/,
    "!CONN 일 때 catalogSoon 으로 잠그는 줄이 없다");
  assert.ok(connStateBody.indexOf("if (!CONN)") < connStateBody.indexOf("CONN.soon"), "!CONN 판정이 CONN 을 읽는 줄보다 뒤에 있다");
  assert.match(SRC, /import \{ catalogSoon \} from '\.\.\/lib\/connect-axes\.js';/, "정본(catalogSoon)을 쓰지 않는다 — 판정이 두 벌이 된다");
});

test("★ E5·E6 수집처 고르기 — 잠김 판정 한 벌로 그리고, 잠긴 것은 저장된 고른 목록에서 뺀다", () => {
  assert.match(SRC, /const srcNotYet = \(it\) => !!it\.soon \|\| connState\(it\.id\) === 'blocked';/, "잠김 판정(srcNotYet)이 없다");
  assert.match(sourcesScene, /const notYet = srcNotYet;/, "그리기가 같은 잠김 판정을 쓰지 않는다");
  const bind = sourcesScene.slice(sourcesScene.indexOf("bind: (el) =>"));
  assert.match(bind, /const lockedIds = new Set\(all\.filter\(srcNotYet\)\.map\(\(it\) => it\.id\)\);/, "E6 잠긴 id 를 모으지 않는다");
  assert.match(bind, /S\.sources = S\.sources\.filter\(\(id\) => !lockedIds\.has\(id\)\); save\(\);/, "E6 잠긴 것을 고른 목록에서 빼고 저장하지 않는다");
  //  빼는 일은 [계속] 이 고른 수를 세기 전에 일어나야 한다.
  assert.ok(bind.indexOf("lockedIds") < bind.indexOf("go.onclick"), "E6 빼기가 [계속] 배선보다 뒤다");
});
