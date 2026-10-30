// #5011 — 설치한 앱(팀 채널 …)도 레일(독)에서 끌어 고정 · 순서 · 빼기가 되고, 그 앱 화면에선 제 칸이 켜진다.
//
//  원준 2026-10-26 신고: "지금 다른건 사이드바 독에서 위치 조절이나 끌어당기면서 하는게 되는데 왜 팀채널 저거는 안되는거같지?"
//  ① 레일의 고정 · 순서 장치(canPin · normalizeOrder · mainEntries)가 앱 표(APPS) 키만 믿었다 — #4769 가 설치 앱을 최근 칸에만 세우고
//     끌기 · 「독에 고정」 을 일부러 막아 두었다.
//  ② 설치 앱 화면(#/i/…)의 활성 키는 'app:' 하나라 레일이 어느 앱인지 몰라 그 칸이 켜지지 않았다.
//  ③ 끌어 놓으면 화면에 선 칸 순서를 그대로 저장해서, 화면에 안 선 고정(목록이 아직 안 온 설치 앱 · 꺼진 앱)이 끌기 한 번에 지워졌다.
//  시나리오 번호(M · L · W)는 사양의 엣지 표 행이다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "rail-installed-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/rail-lit.ts"), "--rootDir", path.join(root, "web"),
   "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const L = await import(path.join(out, "lib/rail-lit.js"));

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, JSON.stringify(why).slice(0, 300)));
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const read = (f) => code(readFileSync(path.join(root, f), "utf8"));
const fnBody = (src, name) => { const i = src.indexOf(`function ${name}(`); return i < 0 ? "" : src.slice(i, src.indexOf("\n}\n", i)); };

// ── M. 끌어 놓은 뒤의 새 순서 — 화면에 안 선 키는 제자리를 지킨다 ──
const M = L.mergeRailOrder;
check(eq(M(["home", "sess", "proj", "wiki"], ["sess", "home", "proj", "wiki"]), ["sess", "home", "proj", "wiki"]), "M1 모두 화면에 서 있으면 화면 순서 그대로");
check(eq(M(["home", "i:talk", "sess", "proj"], ["sess", "home", "proj"]), ["sess", "home", "i:talk", "proj"]),
  "M2 ★★ 아직 안 그려진 고정 설치 앱(i:talk)은 끌기 한 번에 지워지지 않고 앞 이웃(home) 뒤에 남는다", M(["home", "i:talk", "sess", "proj"], ["sess", "home", "proj"]));
check(eq(M(["i:a", "home", "sess"], ["sess", "home"]), ["i:a", "sess", "home"]), "M3 맨 앞의 숨은 키는 맨 앞에 남는다", M(["i:a", "home", "sess"], ["sess", "home"]));
check(eq(M(["home", "i:a", "i:b", "sess"], ["sess", "home"]), ["sess", "home", "i:a", "i:b"]), "M4 이어진 숨은 키는 순서대로 함께 남는다", M(["home", "i:a", "i:b", "sess"], ["sess", "home"]));
check(eq(M(["home", "sess"], ["home", "i:talk", "sess"]), ["home", "i:talk", "sess"]), "M5 ★ 최근 칸에서 끌어 올린 새 고정(i:talk)은 놓은 자리에 선다");
check(eq(M(["home", "sess", "proj"], ["home", "proj"]).length, 3) && M(["home", "sess", "proj"], ["home", "proj"]).includes("sess"),
  "M6 화면 결과에 없던 키는 버리지 않는다(빼기는 끌어내기 갈래가 따로 한다)");
check(eq(M([], ["home"]), ["home"]) && eq(M(["home"], []), ["home"]), "M7 빈 입력에도 안 깨진다");

// ── L. 설치 앱 화면에선 그 앱 칸이 켜진다 ──
const APPS = ["dashboard", "sources", "i:talk"];
check(L.railLitKey(L.installedRecentKey("talk"), "home", ["liv"], APPS, "none") === "i:talk",
  "L1 ★ 설치 앱 키(i:talk)로 물으면 그 칸이 켜진다 — 사이드바 주인이 none 이어도");
check(L.railLitKey("i:gone", "home", ["liv"], APPS, "none") === "", "L2 레일에 없는 설치 앱이면 아무 칸도 안 켠다");

// ── W. 배선 ──
const rail = read("web/v2/rail.ts");
check(/isInstalledRecentKey\(k\)/.test(fnBody(rail, "canPin")), "W1 ★★ canPin 이 설치 앱 키를 받는다 — 저장 순서(normalizeOrder)에서 지워지지 않는다");
check(/appOf\(key\)/.test(fnBody(rail, "mainEntries")) && /installedAppDefs\(\)/.test(fnBody(rail, "appOf")),
  "W2 ★ 메인 줄이 설치 앱 목록에서도 고정 앱을 찾아 그린다");
check(!/isInstalledRecentKey/.test(fnBody(rail, "dockMenu")) && /독에 고정/.test(fnBody(rail, "dockMenu")),
  "W3 ★ 우클릭 메뉴가 설치 앱에도 「독에 고정 · 독에서 빼기」 를 낸다");
check(/^\s*wireDrag\(it, a\.key, kind\);/m.test(fnBody(rail, "drawRail")) && !/\binst\b/.test(fnBody(rail, "drawRail")),
  "W4 ★★ 설치 앱 칸에도 끌기를 건다");
check(/installedAppDefs\(\)\.filter\(\(a\) => !order\.includes\(a\.key\)\)/.test(fnBody(rail, "recentForRail")),
  "W5 독에 고정한 설치 앱은 최근 칸에 또 서지 않는다");
check(/mergeRailOrder\(order, keys\)/.test(fnBody(rail, "finish")), "W6 ★ 끌어 놓은 뒤 저장은 화면 순서가 아니라 mergeRailOrder 결과다");
check(/appOf\(d\.key\)/.test(fnBody(rail, "finish")), "W7 손가락으로 꾹 눌러 그 자리에서 떼면 설치 앱에도 메뉴가 뜬다");
check(/hooks\.installedAppId\?\.\(\)/.test(fnBody(rail, "litKey")) && /installedAppDefs\(\)\.map/.test(fnBody(rail, "litKey")),
  "W8 ★ 켜질 칸 잣대가 설치 앱 화면의 앱 id 와 설치 앱 칸을 안다");
const mainTs = read("web/v2/main.ts");
check(/installedAppId: \(\) => \{ const t = tabsApi\?\.current\(\); return t && \/\^#\\\/i\\\/\/\.test\(t\.route\) \? t\.appId : null; \}/.test(mainTs),
  "W9 셸이 #/i/… 화면에서만 그 탭의 앱 id 를 레일에 알려 준다(세션 화면의 appId 는 넘기지 않는다)");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
