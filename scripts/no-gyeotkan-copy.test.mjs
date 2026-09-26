// #4233 «곁칸» 은 사용자에게 보이지 않는다(원준 2026-09-26 «곁칸이라는 용어는 사용자한테 노출하지 말고 우측 사이드바에 고정
//  이렇게 문구 바꿔줘»). 화면 글·툴팁·aria-label·토스트·도움말은 «우측 사이드바» 로 쓴다. 주석·식별자·CSS 클래스는 그대로 둔다.
//
//  사양·엣지 표(spec-failfirst):
//   N1 따옴표 문자열에 «곁칸» → 잡는다
//   N2 주석(한 줄 · 여러 줄)에만 «곁칸» → 안 잡는다
//   N3 템플릿 문자열(치환 없음 · 머리 · 가운데 · 꼬리)에 «곁칸» → 잡는다
//   N4 정규식 · 식별자에 비슷한 글자가 있어도 문자열이 아니면 안 잡는다
//   R1 web/ 의 .ts 전부에서 문자열에 «곁칸» 0건(있으면 파일:줄을 적어 실패)
//   R2 앱 만들기 안내(scripts/create-lively-app.mjs)가 쓰는 README 글에도 0건
//   R3 탭 메뉴 «…로 보내기» 는 받침에 맞는 조사를 쓴다(…사이드바로 · 아래 칸으로)
//  ⚠ 문자열은 TypeScript 파서로 뽑는다. 줄 단위 정규식은 주석 안 따옴표·URL 의 // 에서 틀린다.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORD = "곁칸";

let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${detail ? "\n" + detail : ""}`); } };

/** 소스 한 벌에서 문자열 조각(따옴표 · 템플릿 각 조각 · JSX 글)만 [줄, 값] 으로. */
function stringsOf(src, name = "x.ts") {
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, name.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) {
      out.push([sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, n.text]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const hits = (src, name) => stringsOf(src, name).filter(([, s]) => s.includes(WORD));

// ── N. 잣대 자체 ──────────────────────────────────────────────────────────────
ok(hits(`const a = '곁칸 접기';`).length === 1, "N1 따옴표 문자열을 잡는다");
ok(hits(`// 곁칸을 접는다\n/* 곁칸\n * 곁칸 */\nconst a = 'ok';`).length === 0, "N2 주석은 안 잡는다");
ok(hits("const a = `곁칸`; const b = `${x}곁칸${y}곁칸${z}곁칸`;").length === 4, "N3 템플릿의 네 가지 조각을 모두 잡는다");
ok(hits(`const 곁칸폭 = 1; const re = /곁칸/; const u = 'https://x//y';`).length === 0, "N4 식별자 · 정규식은 문자열이 아니다");

// ── R. 저장소 ────────────────────────────────────────────────────────────────
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...walk(p)); }
    else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const webFiles = walk(join(root, "web"));
ok(webFiles.length > 50, `R0 web/ 의 소스를 찾았다(${webFiles.length}개)`);
const found = [];
for (const f of webFiles) {
  const src = readFileSync(f, "utf8");
  if (!src.includes(WORD)) continue;
  for (const [line, s] of hits(src, f)) found.push(`  ${relative(root, f)}:${line}  ${JSON.stringify(s.length > 80 ? s.slice(0, 80) + "…" : s)}`);
}
ok(found.length === 0, `R1 web/ 화면 글에 «${WORD}» 0건`, found.join("\n"));

const tpl = readFileSync(join(root, "scripts/create-lively-app.mjs"), "utf8");
const tplHits = hits(tpl, "create-lively-app.ts");
ok(tplHits.length === 0, "R2 앱 만들기 안내 README 에도 없다", tplHits.map(([l, s]) => `  scripts/create-lively-app.mjs:${l}  ${JSON.stringify(s.slice(0, 80))}`).join("\n"));

const panes = stringsOf(readFileSync(join(root, "web/v2/panes.ts"), "utf8"), "panes.ts").map(([, s]) => s);
//  곁칸 쪽 조사(«…사이드바로») 는 자리에 따라 web/lib/side-label.ts 가 만든다. 그 값은 side-label.test.mjs L4 가 본다.
ok(panes.includes("아래 칸으로") && !panes.includes("으로 보내기") && /side: sideLabels\(isLeft\(\)\)\.sendTo/.test(readFileSync(join(root, "web/v2/panes.ts"), "utf8")),
  "R3 탭 메뉴는 칸 이름마다 맞는 조사를 쓴다(«우측 사이드바으로» 가 나오지 않게)");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
