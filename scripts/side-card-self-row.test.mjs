// #3870 — 프로젝트로 묶은 홈 목록에서 **카드 안에 그 프로젝트 자신의 화면이 서지 않는다**.
//
//  원준 2026-09-13 신고: "홈 탭이든, 프로젝트 탭이든 사이드바에서 프로젝트로 묶기 켰을 때 프로젝트 폴더 안에는
//   세션만 있어야지. 프로젝트 페이지는 어차피 그 폴더 오른쪽에 화살표로 항상 들어가지는데 한번 화살표로 프로젝트 창
//   들어갔다고 그 프로젝트 창 가는 버튼이 프로젝트 폴더 밑에 세션처럼 추가되는게 말이됨?"
//
//  세 자리가 맞물려 난 증상이다 — 하나만 바뀌어도 조용히 돌아오므로 셋 다 못박는다.
//   ① 카드 머리줄의 [→] 는 `#/app/projects2/p/<id>` 창을 연다(main.ts openProjectPage).
//   ② 그 창은 앱의 깊은 자리라 목록에 설 자격이 있고(row-stands «어디까지 봤나»), 소속이 **자기 자신**이라
//      `project.self` 를 단다(main.ts sideRowFace).
//   ③ 프로젝트 축(projGroups)은 소속 id 만 보고 줄을 카드에 넣었다 — 그래서 그 화면이 제 카드 안에 세션처럼 섰다.
//  고침: 카드에 넣기 전에 자기 화면 줄을 걷는다(lib/sess-fold projCardRows). 날짜 축과 「고정」 층은 그대로 둔다.
//  시나리오 번호(E1~E12)는 사양의 엣지 표 행이다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "card-self-row-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/sess-fold.ts"), "--rootDir", path.join(root, "web"),
   "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { projCardRows } = await import(path.join(out, "lib/sess-fold.js"));

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, why));

//  줄 모양은 main.ts sideInstances 가 내는 그대로 — 세션도 소속이 있으면 `self: false` 를 단다(sideRowFace).
const sess = (id, pid) => ({ id: "sess:" + id, title: id, project: pid ? { id: pid, name: "P" + pid, self: false } : null });
const page = (pid) => ({ id: "route:app/projects2/p/" + pid, title: "P" + pid, project: { id: pid, name: "P" + pid, self: true } });
const app  = (id) => ({ id: "inst:" + id, title: id, project: null });
const ids = (rows) => rows.map((r) => r.id).join(",");
//  정적 배선 검사는 **주석을 걷고** 본다 — 설명 주석에 같은 낱말이 있으면 거짓 빨강·거짓 초록이 난다
//   (실제로 appListKids 머리 주석의 «projCardRows» 한 낱말이 E9 를 거짓 빨강으로 만들었다).
const code = (src) => src.replace(/^[ \t]*\/\/.*$/gm, "");

// ───────────────────────── A. 잣대 — 카드 재료에서 무엇을 걷나

if (typeof projCardRows !== "function") {
  bad("A0 lib/sess-fold 가 projCardRows 를 내보낸다", "없다 — 카드에 넣을 줄을 가르는 잣대가 없다");
} else {
  const e1 = projCardRows([sess("a", 12), page(12), sess("b", 12)]);
  check(ids(e1) === "sess:a,sess:b",
    "E1 ★★ 프로젝트 화면 줄은 카드 재료에서 빠지고, 같은 프로젝트의 세션은 남는다", ids(e1));

  check(projCardRows([page(12)]).length === 0,
    "E2 ★ 화면 줄만 있으면 재료가 빈다 — projGroups 가 받을 줄이 없으니 빈 폴더도 안 선다");

  const e3 = projCardRows([app("브라우저"), sess("c", 0)]);
  check(ids(e3) === "inst:브라우저,sess:c",
    "E3 프로젝트 없는 앱·세션은 그대로 — 「프로젝트 없음」 카드의 재료다", ids(e3));

  const e4 = projCardRows([{ ...page(3), project: { id: 3, name: "P3" } }]);
  check(ids(e4) === "route:app/projects2/p/3",
    "E4 self 표식이 **없는** 줄은 걷지 않는다 — 걷는 사유는 «그 프로젝트 자신» 하나다", ids(e4));

  const e5 = projCardRows([{ ...page(3), project: { id: 3, name: "P3", self: false } }]);
  check(ids(e5) === "route:app/projects2/p/3",
    "E5 self: false 는 걷지 않는다 — 표식의 경계", ids(e5));

  let e6 = null, e6err = "";
  try { e6 = projCardRows([{ id: "inst:x", title: "x", project: null }, { id: "inst:y", title: "y" }]); } catch (e) { e6err = String(e); }
  check(!!e6 && ids(e6) === "inst:x,inst:y",
    "E6 ★ project 가 null·undefined 인 줄도 죽지 않고 남긴다 — 새 잣대의 부재 입력", e6err || ids(e6 || []));

  let e7 = null, e7err = "";
  try { e7 = projCardRows([]); } catch (e) { e7err = String(e); }
  check(Array.isArray(e7) && e7.length === 0,
    "E7 빈 목록이면 빈 배열 — 새 잣대의 빈 입력", e7err || JSON.stringify(e7));

  const e10 = projCardRows([sess("3", 2), page(9), app("1"), sess("2", 5)]);
  check(ids(e10) === "sess:3,inst:1,sess:2",
    "E10 들어온 순서를 지킨다 — 카드 순서는 시간축이 준 그대로다(projGroups 머리말)", ids(e10));

  const input = [sess("x", 1), page(1), app("y")];
  const before = ids(input);
  projCardRows(input);
  check(ids(input) === before,
    "E11 들어온 배열을 건드리지 않는다 — 「고정」 층·빈 화면 판정이 같은 목록을 본다", `입력이 ${ids(input)} 로 바뀌었다`);
}

// ───────────────────────── B. 배선 — 프로젝트 축에서만 거른다

{
  const SIDE = readFileSync(path.join(root, "web/v2/side.ts"), "utf8");
  const kids = code(SIDE.slice(SIDE.indexOf("function projListKids("), SIDE.indexOf("function projGrpCard(")));

  //  #4233 — 「고정」 나누기를 잎 모듈(lib/home-pins splitHomePins)이 한다. rest 는 그 나머지이고, 여전히 projCardRows 를 지난다.
  check(/const rest = projCardRows\(pins\.rest\);/.test(kids) && /const pins = splitHomePins\(shown, projPinnedId\);/.test(kids),
    "E1·B1 ★★ 프로젝트 축은 카드 재료(rest)를 projCardRows 로 거른 뒤 projGroups 에 넘긴다",
    "projListKids 의 rest 가 자기 화면 줄을 안 걷는다 — [→] 로 연 화면이 다시 제 폴더 안에 선다");

  //  #4233 — 꽂은 줄은 이제 「고정」 세션 카드(pinCard) 안에 선다(원준 «V1 의 1안»: 모든 세션 줄이 카드 안에). 원칙은 그대로다:
  //   자동 규칙(projCardRows)이 그 줄을 걷지 않는다.
  check(/const pinnedRows = pins\.pinnedRows;/.test(kids) && !/projCardRows\(pinnedRows|projCardRows\(pins\.pinnedRows/.test(kids),
    "E8 ★ 「고정」 층은 거르지 않는다 — 사람이 꽂은 줄은 「고정」 세션 카드에 서고, 자동 규칙이 걷지 않는다",
    "pinnedRows 가 걸러지고 있다");

  const at = SIDE.indexOf("function appListKids(");
  const list = at < 0 ? "" : code(SIDE.slice(at, SIDE.indexOf("\n}\n", at)));

  check(list.length > 0 && !/projCardRows/.test(list),
    "E9 ★ 날짜 축(묶지 않은 목록)은 거르지 않는다 — 거기엔 카드도 [→] 도 없어 그 줄이 곧 그 화면으로 돌아가는 길이다",
    "appListKids 가 날짜 축에서도 걷고 있다");

  check(/if \(kids\.length\) return kids;/.test(list),
    "E2·B4 ★ 빈 화면은 «그린 것이 없나» 로 가른다 — 화면 줄만 있던 묶음 목록이 말없이 텅 비지 않게",
    "appListKids 가 재료 개수로 빈 화면을 가른다 — 걸러진 줄 때문에 아무것도 안 그렸는데 안내도 없다");
}

// ───────────────────────── C. 걷는 표식이 실제로 달리는가 (main.ts) — E12

{
  const MAIN = readFileSync(path.join(root, "web/v2/main.ts"), "utf8");
  const fnBody = (name) => { const s = MAIN.indexOf(`function ${name}(`); return s < 0 ? "" : code(MAIN.slice(s, MAIN.indexOf("\n}\n", s))); };

  check(/const href = '#\/app\/projects2\/p\/' \+ projectId;/.test(fnBody("openProjectPage")),
    "E12·C1 카드의 [→] 가 여는 창은 app/projects2 프로젝트 화면이다 — C3 의 self 판정이 잡는 주소다",
    "openProjectPage 의 주소가 바뀌었다 — sideRowFace 의 selfProject 판정이 그 주소를 잡는지 같이 봐야 한다");

  check(/onOpenProject: openProjectPage\b/.test(code(MAIN)),
    "E12·C2 사이드바 카드의 [→](hooks.onOpenProject)는 openProjectPage 로 이어진다",
    "onOpenProject 배선이 바뀌었다");

  const face = fnBody("sideRowFace");
  check(/const selfProject = !!base && \(page === 'app' \? segs\[1\] === 'projects2'/.test(face) && /self: selfProject/.test(face),
    "E12·C3 ★★ 그 화면 줄은 project.self 를 단다 — projCardRows 가 걷는 유일한 표식이다",
    "sideRowFace 가 self 를 안 달면 A 의 잣대가 아무것도 못 걷고, 증상이 조용히 돌아온다");
}

console.log(`\nside-card-self-row: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
