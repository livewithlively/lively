// 화면 앱 판정(web/lib/app-screen.ts · #4485 후속) — 서버가 화면을 만드는 앱(web.server)도 화면 앱이다. 서버 짝(serverDeclOf)과 같은 표로 본다.
//  컴파일된 모듈(public/app/lib/app-screen.js · dist/apps/app-server-config.js)을 돌린다 — 빌드가 없으면 건너뛰고 그 사실을 적는다(CI 의 run-tests --build 가 돈다).
//  이게 틀리면: 화면 파일 없는 서버 앱이 앱 찾기 · 곁칸 앱 · 독 · 서랍에서 «앱 세션» 으로 열리거나(그 앱 전용 AI 세션이 뜬다) 붙일 목록에서 빠지고,
//   웹과 서버가 «서버 선언» 을 다르게 읽어 한쪽만 화면 앱으로 본다.
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "public/app/lib/app-screen.js");
const srv = join(root, "dist/apps/app-server-config.js");
if (!existsSync(web) || !existsSync(srv)) { console.log("app-screen: 빌드 없음(public/app/lib/app-screen.js · dist/apps/app-server-config.js) — 건너뜀"); process.exit(0); }
const { declaresServer, hasAppScreen } = await import(web);
const { serverDeclOf } = await import(srv);

let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };

//  S1 서버 선언 — 웹과 서버가 같은 값을 같게 읽는다(true · 객체 · 빈 객체는 선언 · 배열 · 거짓 값 · 글 · 숫자는 아님)
const table = [
  [{ web: { server: true } }, true], [{ web: { server: {} } }, true], [{ web: { server: { start: "node s.mjs" } } }, true],
  [{ web: { server: [] } }, false], [{ web: { server: false } }, false], [{ web: { server: null } }, false], [{ web: { server: "yes" } }, false],
  [{ web: { server: 1 } }, false], [{ web: {} }, false], [{ web: null }, false], [{}, false], [null, false], [undefined, false], ["web", false],
];
for (const [m, want] of table) {
  assert.equal(declaresServer(m), want, `웹 ${JSON.stringify(m)}`);
  assert.equal(serverDeclOf(m) !== null, want, `서버 ${JSON.stringify(m)}`);
}
ok(`S1 서버 선언 — 웹 · 서버 같은 표 ${table.length}행`);

//  S2 화면 앱 — 화면 파일이 있거나 서버가 화면을 만든다
assert.equal(hasAppScreen({ pages: [{ key: "main" }] }), true, "화면 파일");
assert.equal(hasAppScreen({ pages: [], server: true }), true, "서버만");
assert.equal(hasAppScreen({ pages: [{ key: "main" }], server: true }), true, "둘 다");
assert.equal(hasAppScreen({ pages: [] }), false, "둘 다 없음 — 세션 앱");
assert.equal(hasAppScreen({ pages: [], server: false }), false);
ok("S2 화면 앱 — 화면 파일 · 서버만 · 둘 다 · 없음");

console.log(`\n${pass} passed`);
