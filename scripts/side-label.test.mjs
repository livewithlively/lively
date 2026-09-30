// #4233 사이드바의 화면 이름은 **지금 선 쪽**을 따른다(격리 리뷰 #1111 의 막는 지적).
//  «곁칸» 을 «우측 사이드바» 로 바꾼 뒤(원준 2026-09-26), 자리바꿈(v2/side-swap.ts)으로 이 칸이 왼쪽에 서 있는 동안에도
//  단추 · 경계 손잡이 · 접기/펴기 · 탭 메뉴 · 토스트가 «우측» 이라고 말했다. 오른쪽에 있을 땐 «우측 사이드바» 그대로,
//  왼쪽에 서 있으면 자리를 그대로 적는다. 글은 web/lib/side-label.ts 한 곳이 만든다.
//
//  사양 · 엣지 표(spec-failfirst):
//   L1 오른쪽: 칸 이름 = «우측 사이드바»
//   L2 왼쪽: 칸 이름에 «우측» · «오른쪽» 이 없고 «왼쪽» 이 있다
//   L3 sideLabels(왼쪽) 의 모든 글에 «우측» 이 없다 / sideLabels(오른쪽) 의 모든 글에 «우측 사이드바» 가 있다
//   L4 탭 메뉴 받는 칸의 조사: 양쪽 다 «…사이드바로» («사이드바으로» 가 아니다)
//   L5 swapCopy(켜짐 · 꺼짐, 왼쪽) 의 모든 글에 «우측» 이 없다
//   L6 swapCopy(켜짐, 오른쪽) 은 원준의 이름을 쓴다(단추 이름 · 창 제목)
//   L7 swapCopy(켜짐, 왼쪽) 의 토스트는 칸이 왼쪽으로 옮겼다고 말한다(켜는 순간 이미 절반을 넘은 경우)
//   L8 swapCopy(꺼짐, 오른쪽) 토스트 = 고정했다(끄면 칸은 늘 오른쪽으로 돌아간다)
//   W1 side-swap.ts · panes.ts 의 문자열에 «우측» 이 없다(칸 이름은 전부 side-label 을 지난다)
//   W2 side-swap: 단추 붓과 창이 swapCopy(켜짐, **swapped**) 로 고르고, 붓은 자리를 바꾸는 paint() 가 부른다
//   W3 side-swap: 켜고 끈 토스트는 onEnd(자리 판정) **뒤**의 swapped 로 고른다
//   W4 panes: 자리가 바뀌면(onChange, 양쪽) 경계 · 펴기 · 접기 글을 다시 적는다. 탭 메뉴는 열 때 isLeft() 로 고른다
//   W5 단독 터미널: 링크 힌트가 자리를 말하지 않는다(그 번들은 [웹] 탭이 어느 칸 어느 쪽에 있는지 모른다)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };

let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${detail ? " : " + detail : ""}`); } };

/** 문자열 조각만(따옴표 · 템플릿 조각). 주석은 안 본다. */
const strings = (src, name = "x.ts") => {
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
};
/** 함수 하나만 잘라 본다. 못 찾으면 빈 문자열(그 단언이 빨간불이 된다). */
const cut = (src, from, to) => { const a = src.indexOf(from); if (a < 0) return ""; const b = to ? src.indexOf(to, a + 1) : -1; return src.slice(a, b > a ? b : undefined); };

// ── L. 잣대(web/lib/side-label.ts): 그 자리에서 transpile 해 값으로 부른다 ──
let lib = null;
const libSrc = read("web/lib/side-label.ts");
if (libSrc) {
  const js = ts.transpileModule(libSrc, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  lib = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}
ok(!!lib, "L0 칸 이름 잣대가 잎 모듈(web/lib/side-label.ts)에 있다");
const vals = (o) => Object.values(o).filter((v) => typeof v === "string");
if (lib) {
  const { sideName, sideLabels, swapCopy } = lib;
  ok(sideName(false) === "우측 사이드바", "L1 오른쪽이면 «우측 사이드바»", sideName(false));
  const L = sideName(true);
  ok(!/우측|오른쪽/.test(L) && /왼쪽/.test(L), "L2 왼쪽이면 자리를 그대로 적는다", L);
  const lefts = vals(sideLabels(true)), rights = vals(sideLabels(false));
  ok(lefts.length >= 6 && lefts.every((s) => !s.includes("우측")), "L3 왼쪽 글 전부에 «우측» 이 없다", lefts.filter((s) => s.includes("우측")).join(" | "));
  ok(rights.length >= 6 && rights.every((s) => s.includes("우측 사이드바")), "L3 오른쪽 글 전부가 «우측 사이드바» 를 쓴다");
  ok([true, false].every((l) => /사이드바로$/.test(sideLabels(l).sendTo)), "L4 탭 메뉴 조사 «사이드바로»", [sideLabels(true).sendTo, sideLabels(false).sendTo].join(" / "));
  for (const on of [true, false]) {
    const bad = vals(swapCopy(on, true)).filter((s) => s.includes("우측"));
    ok(bad.length === 0, `L5 swapCopy(${on ? "켜짐" : "꺼짐"}, 왼쪽) 에 «우측» 이 없다`, bad.join(" | "));
  }
  const r = swapCopy(true, false);
  ok(r.btnAria.includes("우측 사이드바") && r.popHead.includes("우측 사이드바"), "L6 오른쪽이면 단추 이름 · 창 제목이 «우측 사이드바»");
  ok(/왼쪽으로 옮겼/.test(swapCopy(true, true).toast), "L7 켜는 순간 이미 왼쪽이면 토스트가 그렇게 말한다", swapCopy(true, true).toast);
  ok(/고정/.test(swapCopy(false, false).toast) && swapCopy(false, false).toast.includes("우측 사이드바"), "L8 끄면 «우측 사이드바» 를 고정했다고 말한다");
}

// ── W. 배선(소스) ──
const swapSrc = read("web/v2/side-swap.ts"), panesSrc = read("web/v2/panes.ts");
const woo = (src, name) => strings(src, name).filter((s) => s.includes("우측"));
ok(swapSrc && woo(swapSrc, "side-swap.ts").length === 0, "W1 side-swap.ts 문자열에 «우측» 이 없다", woo(swapSrc, "side-swap.ts").join(" | "));
ok(panesSrc && woo(panesSrc, "panes.ts").length === 0, "W1 panes.ts 문자열에 «우측» 이 없다", woo(panesSrc, "panes.ts").join(" | "));

const paintBtn = cut(swapSrc, "function paintBtn(", "function openPop(");
const openPop = cut(swapSrc, "function openPop(", "function opt(");
const paint = cut(swapSrc, "function paint(", "function setSwapped(");
ok(/swapCopy\(on, swapped\)/.test(paintBtn) && /btn\.title = c\.btnTitle/.test(paintBtn) && /'aria-label', c\.btnAria/.test(paintBtn), "W2 단추 붓이 지금 선 쪽(swapped)으로 글을 고른다");
ok(/swapCopy\(on, swapped\)/.test(openPop) && /c\.popHead/.test(openPop) && /c\.popFixedDesc/.test(openPop), "W2 ⇄ 창도 swapped 로 고른다");
ok(/sw-left', swapped\)/.test(paint) && /paintBtn\(\)/.test(paint), "W2 자리를 바꾸는 paint() 가 단추 붓을 부른다(양쪽 모두)");
const setEnabled = cut(swapSrc, "function setEnabled(", "function showIntroOnce(");
const iEnd = setEnabled.indexOf("onEnd(curSideW())"), iToast = setEnabled.indexOf("swapCopy(on, swapped).toast");
ok(iEnd > 0 && iToast > iEnd, "W3 토스트는 자리 판정(onEnd) 뒤의 swapped 로 고른다");

const mount = cut(panesSrc, "swap = mountSideSwap(", "// ── 탭 ──");
ok(/onChange: \(v\) => \{.*saveView\(\{ sideLeft: v \}\).*paintSideLabels\(v\).*\}/.test(mount), "W4 자리가 바뀌면(onChange) 칸 이름을 다시 적는다");
const psl = cut(panesSrc, "function paintSideLabels(", "// ── 탭 ──");
ok(/splitX\.setAttribute\('aria-label', l\.width\)/.test(psl) && /sideReopen\.title = l\.reopenTitle/.test(psl) && /sideHide\.title = l\.hideTitle/.test(psl), "W4 경계 · 펴기 · 접기 셋을 다 다시 적는다");
ok(/side: sideLabels\(isLeft\(\)\)\.sendTo/.test(cut(panesSrc, "function tabMenu(", "function moreBtn(")), "W4 탭 메뉴는 열 때 isLeft() 로 고른다");
ok(/sideHide = el\('button'[^;]*sideLabels\(isLeft\(\)\)\.hideTitle/.test(cut(panesSrc, "function paintPane(", "function paintAll(")), "W4 접기 단추를 새로 만들 때도 지금 선 쪽으로");

const term = read("web/standalone/terminal.ts");
const hintLine = (term.match(/const openHint = \{[^}]*\}/) || [""])[0];
ok(hintLine && !/우측|왼쪽|오른쪽|곁칸/.test(hintLine) && /pane: '웹 탭'/.test(hintLine), "W5 단독 터미널 링크 힌트는 자리를 말하지 않는다", hintLine);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
