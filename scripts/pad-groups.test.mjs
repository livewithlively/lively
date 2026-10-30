// #4554 — 앱 찾기는 묶음 둘(「기본 앱」 · 「워크스페이스 앱」)로 서고, 「홈(클래식)」은 「대시보드」가 되어 기본 앱에서 빠진다.
//
//  원준 2026-10-04: "앱 화면 … 기본 앱과 직접 만든 앱 … 적당히 이름 붙여서 둘로 나눠서 보여줘.
//   그리고 홈(클래식) -> 대시보드로 이름을 바꾸고 얘는 후자에 있는 기본 앱이 아니게 바꿔주고."
//  시나리오 번호는 사양의 엣지 표 행이다.
//   G1~G4  설치된 앱의 묶음: 셸이 그리는 builtin 만 기본 앱 · 그 밖(inline · git · path · 출처 없음)은 워크스페이스 앱
//   G5~G7  #4592(원준 2026-10-07 "이런 장표 수정 앱은 … 워크스페이스 앱에도 나오게"): 제품에 실려 와도 워크스페이스가 고쳐 쓰는 앱
//          (system 선언이 없는 빌트인)은 워크스페이스 앱 · 실은 매니페스트로 보면 그런 앱은 「장표 수정」 하나
//   B1~B5  Enter 로 열릴 칸: 가장 잘 맞은 칸 · 동점은 앞 칸 · 아래 묶음의 이름 일치가 위 묶음의 설명 일치를 이긴다 · 빈 목록 -1
//   D1~D5  대시보드 줄: 이름 · 묶음 · 옛 이름 검색 · 표의 맨 끝 · 키와 주소는 그대로
//   W1~W4  배선: 묶음 제목 둘 · 화면이 같은 잣대를 쓴다 · 표시와 Enter 가 같은 칸 · 가이드 문서
//   K1~K3  배지는 「세션 앱」에만 · 가이드에서 「안녕 앱」과 「앱」 표시를 뺐다
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "pad-groups-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/app-match.ts"), "--rootDir", path.join(root, "web"),
   "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { appMatches, appRank, padBestIndex, padGroupOfInstalled } = await import(path.join(out, "lib/app-match.js"));

let pass = 0, fail = 0;
const check = (cond, n, why = "기대와 다르다") => {
  if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${why}`); }
};
const read = (f) => readFileSync(path.join(root, f), "utf8");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// ───────────────────────── G. 설치된 앱의 묶음
check(padGroupOfInstalled("builtin", true) === "base", "G1 제품에 실려 왔고 셸이 그리는 앱(builtin + system)은 기본 앱");
check(padGroupOfInstalled("inline") === "workspace" && padGroupOfInstalled("inline", true) === "workspace", "G2 세션이 만든 앱(inline)은 워크스페이스 앱 — system 을 선언했어도");
check(padGroupOfInstalled("git") === "workspace" && padGroupOfInstalled("path") === "workspace" && padGroupOfInstalled("git", true) === "workspace", "G3 설치한 앱(git · path)은 워크스페이스 앱");
check(padGroupOfInstalled(undefined) === "workspace" && padGroupOfInstalled(null) === "workspace" && padGroupOfInstalled("") === "workspace" && padGroupOfInstalled(undefined, true) === "workspace",
  "G4 출처를 모르는 앱은 기본 앱이라 부르지 않는다");
check(padGroupOfInstalled("builtin", false) === "workspace" && padGroupOfInstalled("builtin") === "workspace",
  "G5 ★ 제품에 실려 왔어도 워크스페이스가 고쳐 쓰는 앱(system 없음)은 워크스페이스 앱");
{
  //  실은 매니페스트로 본다 — 이름이 아니라 선언이 묶음을 정한다. 새 빌트인을 넣을 때 어느 묶음에 서는지 여기서 드러난다.
  const dir = path.join(root, "apps/builtin");
  const ms = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => JSON.parse(read(`apps/builtin/${d.name}/lively-app.json`)));
  const ws = ms.filter((m) => padGroupOfInstalled("builtin", !!m.system) === "workspace").map((m) => m.id).sort();
  check(JSON.stringify(ws) === JSON.stringify(["deck-edit"]), "G6 ★ 실은 앱 가운데 워크스페이스 앱에 서는 것은 「장표 수정」(deck-edit) 하나", JSON.stringify(ws));
  const de = ms.find((m) => m.id === "deck-edit");
  check(!!de && !de.system && !!de.ui && Array.isArray(de.ui.pages) && de.ui.pages.length > 0,
    "G7 그 앱은 화면 코드가 앱 안에 있다(ui.pages) — 워크스페이스가 app_save 로 고칠 것이 있는 앱이라 워크스페이스 앱이다");
}

// ───────────────────────── B. Enter 로 열릴 칸 (rank: 0 이름 시작 · 1 이름 안 · 2 옛 이름 · 3 설명에만)
check(padBestIndex([3, 0]) === 1, "B1 ★ 위 묶음의 설명 일치(3)보다 아래 묶음의 이름 일치(0)가 열린다");
check(padBestIndex([1, 1, 1]) === 0, "B2 동점은 화면의 앞 칸");
check(padBestIndex([2, 1, 1, 0, 0]) === 3, "B3 가장 잘 맞은 것이 여럿이면 그 가운데 앞 칸");
check(padBestIndex([2]) === 0, "B4 칸이 하나면 그 칸");
check(padBestIndex([]) === -1, "B5 칸이 없으면 -1");

// ───────────────────────── D. 대시보드 줄
const APPS = read("web/v2/apps.ts");
const body = code(APPS);
const table = body.slice(body.indexOf("export const APPS"));
const rows = table.slice(0, table.indexOf("\n];")).split("\n").filter((l) => /^\s*\{\s*key: '/.test(l));
const dash = rows.find((l) => /key: 'dashboard'/.test(l)) || "";
check(/title: '대시보드'/.test(dash) && !rows.some((l) => /title: '[^']*클래식/.test(l)), "D1 이름은 「대시보드」이고 화면 이름에 「클래식」이 남지 않는다");
check(/group: 'workspace'/.test(dash) && rows.filter((l) => /group: 'workspace'/.test(l)).length === 1,
  "D2 앱 표에서 워크스페이스 앱은 대시보드 하나뿐이다(나머지는 기본 앱)");
{
  const old = (APPS.match(/DASH_OLD_NAMES[^=]*=\s*\[([^\]]*)\]/) || [, ""])[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean);
  const title = (dash.match(/title: '([^']*)'/) || [, ""])[1], desc = (dash.match(/desc: '([^']*)'/) || [, ""])[1];
  const app = { title, desc, aka: /aka: DASH_OLD_NAMES/.test(dash) ? old : [] };
  check(appMatches(app, "홈(클래식)") && appMatches(app, "클래식"), "D3 옛 이름 「홈(클래식)」 · 「클래식」으로 대시보드가 찾힌다");
  check(appRank(app, "대시") < appRank(app, "클래식"), "D3 새 이름 일치가 옛 이름 일치보다 앞선다");
}
check(rows.length > 1 && rows[rows.length - 1] === dash, "D4 대시보드는 앱 표의 맨 끝 — 최근 줄을 채울 때 기본 앱이 먼저 선다");
check(/key: 'dashboard'/.test(dash) && /route: 'dashboard'/.test(dash) && /tab: 'dashboard'/.test(dash), "D5 키 · 주소 · 탭 게이트는 그대로다");

// ───────────────────────── W. 배선
{
  const base = APPS.indexOf("key: 'base', title: '기본 앱'"), ws = APPS.indexOf("key: 'workspace', title: '워크스페이스 앱'");
  check(base >= 0 && ws > base, "W1 묶음 제목 둘: 「기본 앱」이 위, 「워크스페이스 앱」이 아래");
}
check(/padGroupOfInstalled\(a\.source\.kind, !!a\.system\)/.test(body) && /padBestIndex\(/.test(body) && /group: a\.group \|\| 'base'/.test(body),
  "W2 화면이 같은 잣대를 쓴다(설치된 앱의 묶음 · Enter 로 열릴 칸 · 표의 기본값은 기본 앱)");
{
  const css = read("public/styles/40-v2.css");
  check(/\n\.v2-pad-item\.is-first \{/.test(css) && /classList\.add\('is-first'\)/.test(body) && /querySelector\('\.v2-pad-item\.is-first'\)/.test(body),
    "W3 Enter 로 열릴 칸의 표시와 Enter 가 같은 칸을 가리킨다");
}
{
  const docs = read("web/docs-content.ts");
  const b = docs.indexOf("{#builtin}"), w = docs.indexOf("## 워크스페이스 앱 {#workspace}");
  check(b >= 0 && w > b && !/\|\s*(홈\(클래식\)|대시보드)\s*\|/.test(docs.slice(b, w)) && /\|\s*대시보드\s*\|/.test(docs.slice(w)),
    "W4 가이드: 대시보드는 「기본으로 들어 있는 앱」 표가 아니라 「워크스페이스 앱」 절에 있다");
}

// ───────────────────────── K. 배지 · 은퇴한 예시 앱 (원준 2026-10-04 "앱 이라고 뱃지 달려있는데 그거 없애줘. 안녕앱은 그냥 지워버려줘")
{
  const badges = [...body.matchAll(/class: 'v2-pad-badge', text: ([^}]*)\}/g)].map((m) => m[1].trim());
  check(badges.length === 1 && badges[0] === "'세션 앱'", "K1 앱 찾기의 배지 글은 「세션 앱」 하나뿐이다(「앱」 배지 없음)", JSON.stringify(badges));
  check(/isScreen \? null : el\('span', \{ class: 'v2-pad-badge'/.test(body), "K2 화면이 뜨는 앱에는 배지를 달지 않는다");
  const docs = read("web/docs-content.ts");
  check(!docs.includes("안녕 앱") && /\|\s*표시 없음\s*\|/.test(docs) && !/\n\| 앱 \| 그 앱의 화면이 열립니다/.test(docs),
    "K3 가이드: 「안녕 앱」 언급이 없고, 표시 표가 「표시 없음 · 세션 앱」 이다");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
