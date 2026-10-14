// 앱 주소 경유(#/app-open)·크게 보기(#/full)는 지나가는 자리다 (#4480, 상민님 실측 2026-10-14) — 값 · 배선 둘로 고정한다.
//
//  무엇이 문제였나:
//   앱 주소(<앱>-<워크스페이스>.lvly.app)로 직접 들어가면 앞단이 라이블리 화면의 `#/app-open/<앱>?…&state=…` 로 보내고,
//   화면은 그 state 로 일회용 코드를 받아 앱 주소로 돌아간다. 셸은 열린 탭을 저장했다 되살리는데(lively_v2_tabs) 이 경유 탭까지
//   저장해서, 사파리에서 다른 탭으로 라이블리를 열자 되살아난 경유 탭이 이미 쓴 state 로 다시 열어 라이블리 대신 앱 주소의
//   «로그인을 마치지 못했습니다. 아래 단추로 다시 시도해주세요.» 로 넘어갔다.
//  고친 것:
//   ① 저장본에서 뺀다(tabs.ts routeSticky — #/welcome 과 같은 자리). 크게 보기(#/full)도 셸을 덮는 따로 연 창이라 같이 뺀다.
//   ② 그런 주소로 들어온 부팅은 되살린 활성 탭을 데려가지 않고 새 탭에 선다(데려가면 보던 탭이 저장본에서 사라진다).
//   ③ 방문 기록 · 자동 완성으로 같은 경유 주소에 다시 와도 앞단이 붙인 exp 로 거른다 — 없으면 곧바로, 지났으면 서버가
//      410 app_open_expired(서버 시계)로 알려 준다. 그때는 앱으로 보내지 않고 경유 탭을 닫아 되살린 화면에 선다.
//   서버 판정(410)은 src/capabilities/app-launch.test.ts F6 이 잰다.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
//  주석은 빼고 코드만 본다 — 걷어낸 식을 주석으로 인용해도 거짓 초록이 나지 않게.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => { const i = l.indexOf("//"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");

let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, `${name}${detail ? " — " + detail : ""}`); pass++; console.log(`ok  ${name}`); };

// ── V 값 — 실제 tabs.ts 의 routeSticky 를 묶어 잰다(셸 의존만 갈아 끼운다 — tab-landing.test.mjs 와 같은 꼴) ──
const STUBS = {
  "../core.js": `export { el, sv } from ${JSON.stringify(path.join(root, "web/lib/dom.ts"))}; export function anchoredPopover() { return function () {}; }`,
  "./shell-prefs.js": "export function deviceStore(base) { return base; }",
  "./embed.js": "export const EMBEDDED = false;",
};
const bundled = await build({
  stdin: { contents: "export { routeKey, routeSticky } from './tabs.ts';", resolveDir: path.join(root, "web/v2"), loader: "ts" },
  bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent",
  plugins: [{
    name: "shell-stubs",
    setup(b) {
      b.onResolve({ filter: /^(\.\.\/core|\.\/shell-prefs|\.\/embed)\.js$/ }, (a) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: STUBS[a.path], loader: "js", resolveDir: root }));
    },
  }],
});
const tmp = mkdtempSync(path.join(tmpdir(), "app-open-transient-"));
try {
  const file = path.join(tmp, "tabs.mjs");
  writeFileSync(file, bundled.outputFiles[0].text);
  const { routeSticky } = await import(pathToFileURL(file).href);

  for (const r of ["#/app-open/addr-check?v=pub&next=%2F&state=" + "s".repeat(43) + "&exp=1791000600", "#/app-open/addr-check", "#/full/addr-check?t=%EC%95%B1", "#/full/addr-check", "#/welcome"]) {
    ok(routeSticky(r) === false, `V1 지나가는 자리는 저장하지 않는다 — ${r.slice(0, 40)}`);
  }
  for (const r of ["#/", "#/s/box-1", "#/p/12", "#/app/knowledge", "#/i/inst-1", "#/sources", "#/app-opener", "#/fullname"]) {
    ok(routeSticky(r) === true, `V2 그 밖은 그대로 저장한다 — ${r}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── W 배선 — 부팅 · 경유 경로가 위 값을 실제로 쓴다 ──
const MAIN = code(read("web/v2/main.ts"));
ok(/import \{[^}]*\brouteSticky\b[^}]*\} from '\.\/tabs\.js';/.test(MAIN), "W1 화면 본체가 routeSticky 를 가져다 쓴다");
ok(/const saved = boot && !routeSticky\(boot\) \? null : tabsApi\.initial\(\);/.test(MAIN),
  "W2 지나가는 주소로 들어온 부팅은 되살린 활성 탭을 데려가지 않는다(새 탭에 선다)");

const at = MAIN.indexOf("} else if (page === 'app-open' && segs[1]) {");
ok(at > 0, "W3 경유 경로 갈래가 있다");
const branch = MAIN.slice(at, MAIN.indexOf("} else if (", at + 10));
const iExp = branch.indexOf("if (!(exp > 0)) { leave(); return; }");
const iApi = branch.indexOf("await api('/api/ui/apps/'");
ok(iExp > 0 && iApi > iExp, "W4 exp 가 없으면(옛 주소) 앱 열기를 부르기 전에 떠난다");
ok(/const exp = Number\(params\.get\('exp'\) \|\| NaN\);/.test(branch), "W5 exp 는 경유 주소의 exp 값이다");
ok(/state: params\.get\('state'\) \|\| '', exp \}/.test(branch), "W6 exp 를 서버에 넘긴다(지났는지는 서버 시계로 본다)");
ok(/if \(e && e\.body && e\.body\.code === 'app_open_expired'\) \{ leave\(\); return; \}/.test(branch), "W7 서버가 지났다고 하면(410 app_open_expired) 오류 화면이 아니라 떠난다");
const leave = branch.slice(branch.indexOf("const leave = (): void => {"), iExp);
ok(/window\.setTimeout\(/.test(leave) && /tabsApi\.close\(tab\)/.test(leave), "W8 떠나기 = 다음 틱에 경유 탭을 닫는다(되살린 화면에 선다)");
ok(/if \(tabsApi\.current\(\) === tab\) history\.replaceState\(null, '', location\.pathname \+ location\.search \+ '#\/'\);/.test(leave),
  "W9 떠날 때 주소에서 경유 칸을 지운다(뒤로 가기로 다시 안 온다)");
ok(/seq !== tab\.seq/.test(leave), "W10 그 사이 다시 그린 탭은 닫지 않는다");

console.log(`\n${pass} passed`);
