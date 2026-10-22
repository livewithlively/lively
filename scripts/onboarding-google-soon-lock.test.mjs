// #4445 — 구글(드라이브·Gmail)은 서버가 «준비됐다» 고 하기 전엔 **처음부터** 잠겨 있다(catalogSoon 규약).
//
//  원준 2026-09-30 신고: "온보딩할 때 수집처 고르는거에서 구글도 가능한 것처럼 되어있고 비활성화 안돼어있는데".
//  구글의 «준비 중» 은 soonUntilReady — **모르면 잠근다**가 정본(catalogSoon) 규약이다.
//  (#4970) 처음 설정의 «수집처 고르기» 장면은 걷혔다 — 그 장면 배선 검사(E1·E2 connState · E5·E6 고른 목록)도 함께 걷었다.
//   규약 자체와 표의 전제는 [외부 앱 연결] 화면(connect.ts)이 그대로 쓰므로 남긴다.
//
//  엣지 표(사양):
//   E1 서버 답 전 · 구글(soonUntilReady)          → 잠김
//   E2 서버 답 전 · 준비 중 표식 없는 앱(노션 등)   → 모른다(잠그지 않는다)
//   E3 서버 답 · 구글 ready:false / ready 필드 없음 → 잠김
//   E4 서버 답 · 구글 ready:true                   → 연다
//   E5 표가 준비 중(캘린더 — soon, soonUntilReady 아님) → 언제나 잠김
//  주석은 계약이 아니다 — 소스 검사는 주석 줄을 걷어내고 본다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const strip = (raw) => raw.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
const LOGINS = strip(readFileSync(path.join(root, "web/me-logins.ts"), "utf8"));

// connect-axes 는 순수 모듈 — 그대로 컴파일해 규약 자체를 돌려 본다.
const out = mkdtempSync(path.join(tmpdir(), "ob-gsoon-"));
execFileSync(path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/connect-axes.ts"), "--rootDir", path.join(root, "web"),
   "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"], { stdio: "inherit" });
const { catalogSoon } = await import(path.join(out, "lib/connect-axes.js"));

test("배선 · 파일을 실제로 읽었다(vacuous 방지)", () => {
  assert.ok(LOGINS.length > 2000);
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
