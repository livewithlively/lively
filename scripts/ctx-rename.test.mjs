// #4233 앱 「맥락 관리」 의 새 이름(원준 2026-09-27, 고르기 검토판 결과).
//  앱 「수집 · 증류」 · 첫 탭 「실시간 현황」 · 탭 「수집기 설정」「증류기 설정」「점검 설정」「AI 주입 설정」 · 「자동 실행 기록」은 그대로.
//  주소(#/context/…) · 키 · 식별자 · 주석은 안 바꾼다. 바뀌는 것은 사람에게 보이는 글이다.
//
//  사양 · 엣지 표(spec-failfirst):
//   N1 따옴표 문자열의 옛 이름 → 잡는다(띄어 쓴 것 · 붙여 쓴 것 둘 다)
//   N2 주석에만 있는 옛 이름 → 안 잡는다
//   N3 템플릿 문자열 조각의 옛 이름 → 잡는다
//   N4 옛 이름 검색어 표(CTX_OLD_NAMES 의 초기값)만 예외다. 같은 파일의 다른 문자열은 잡는다
//   T1 앱 이름 = «수집 · 증류»
//   T2 탭 이름 일곱 개가 고른 그대로다
//   T3 자리 표기: ctxPath('sources') · ctxPath() · ctxPath('distill', '카테고리 붙이기') · ctxTrail('distill')
//   T4 새 값 비었음: ctxPath(undefined) 는 앱 이름만, 뒤 칸을 빈 배열로 줘도 «▸» 가 끝에 안 남는다
//   S1 앱 찾기: 옛 이름(띄어 쓴 것 · 붙여 쓴 것)으로 찾힌다
//   S2 앱 찾기: 새 이름 · 새 이름의 한 단어 · 설명의 «맥락» 으로 찾힌다
//   S3 앱 찾기: 상관없는 검색어는 안 맞고, 빈 검색어 · 공백뿐인 검색어는 전부 맞는다
//   S4 앱 찾기: 대소문자를 안 가린다. 검색어(aka)가 없는 앱도 그대로 돈다
//   S5 순서: 이름이 검색어로 시작(0) < 이름 안(1) < 옛 이름(2) < 설명에만(3)
//   W1 APPS 의 context 줄: 이름 = CTX_APP_NAME · 검색어 = CTX_OLD_NAMES · 설명에 «맥락» 이 있고 긴 줄표가 없다
//   W2 런치패드(apps.ts)와 통합검색(omni.ts)이 같은 잣대(appMatches)로 거른다
//   W3 탭 줄(context.ts STAGES): 탭마다 label 이 CTX_TAB 의 제 키를 읽는다. 머리 문패 · aria-label 이 CTX_APP_NAME 을 읽는다
//   W4 클래식 상단 탭(public/index.html)의 글이 새 이름이다
//   R1 web/ 의 문자열에 옛 이름 0건(있으면 파일:줄을 적어 실패)
//   R2 사람에게 닿는 서버 글(자동화 힌트 · 온보딩 점검표 · 점검 결과 · 능력 설명 · 새 조직 기본 주입문)에 옛 이름 0건
//   C1 칩: 공백이 있어도 짧은 이름(「수집 · 증류」 · 12자까지)은 한 덩어리(nowrap)다
//   C2 칩: 12자를 넘는 공백 있는 라벨은 종전대로 어절 단위로 흐른다. 경계: 12자는 한 덩어리, 13자는 흐른다
//   C3 칩: 공백 없는 라벨은 길어도 한 덩어리(종전 그대로)
//   C4 도움말 피처 카드가 «**제목**: 설명» 의 쌍점을 구분자로 걷는다
//   D1 도움말: context 쪽의 제목이 새 이름이고, 본문이 탭 다섯 개를 새 이름으로 적는다
//   D2 도움말 어디에도 옛 탭 자리 표기(«▸ 전달» · «▸ 증류 ▸» · «▸ 수집]» · «▸ 가져오는 곳»)가 없다
//   H1 화면 제목(h3.cxc-title)이 탭 이름과 같다: 수집기 설정 화면은 CTX_TAB.sources, 증류기 설정 화면은 CTX_TAB.distill 을 읽는다
//   H2 어느 화면 제목도 옛 탭 이름(현황 · 수집기 · 증류기 · 점검 · AI 전달)을 글자로 적지 않는다(수집 · 증류의 화면 파일 전부)
//   H3 제목 옆 수는 무엇의 수인지 적는다(«수집기 8개»). 제목이 «… 설정» 이라 수만 있으면 무엇을 센 것인지 모른다
//   H4 제목이 없는 화면(점검 설정 · AI 주입 설정)은 탭 설명 한 줄이 제목 자리에 선다. 그 글에 긴 줄표가 없다
//   P1 다른 화면의 안내문이 탭 이름을 두 번 잇달아 적지 않는다(자리 표기 바로 뒤에 같은 탭 이름이 또 나오지 않는다)
//   P2 화면 고르기 설명 두 줄(새 화면 · 클래식)에 긴 줄표가 없다
//   P3 화면 글이 탭을 옛 이름 칩([점검] · [수집기] · [증류기] · [현황] · [AI 전달])으로 가리키지 않는다
//  ⚠ 문자열은 TypeScript 파서로 뽑는다. 줄 단위 정규식은 주석 안 따옴표에서 틀린다.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
const OLD = /맥락\s?관리/;

let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${detail ? "\n" + detail : ""}`); } };

/** 문자열 조각 [줄, 값]. exempt 에 든 이름의 변수 초기값 안에 있는 조각은 뺀다. */
function stringsOf(src, name = "x.ts", exempt = []) {
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const inExempt = (n) => { for (let p = n.parent; p; p = p.parent) if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && exempt.includes(p.name.text)) return true; return false; };
  const visit = (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && !inExempt(n)) {
      out.push([sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, n.text]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const hits = (src, name, exempt) => stringsOf(src, name, exempt).filter(([, s]) => OLD.test(s));

// ── N. 잣대 자체 ──────────────────────────────────────────────────────────────
ok(hits(`const a = '맥락 관리 ▸ 수집'; const b = "맥락관리 잡";`).length === 2, "N1 따옴표 문자열의 옛 이름을 잡는다(띄어 쓴 것 · 붙여 쓴 것)");
ok(hits(`// 맥락 관리 탭\n/* 맥락관리\n * 맥락 관리 */\nconst a = 'ok';`).length === 0, "N2 주석은 안 잡는다");
ok(hits("const a = `맥락 관리`; const b = `${x}맥락 관리${y}맥락 관리${z}맥락 관리`;").length === 4, "N3 템플릿의 네 가지 조각을 모두 잡는다");
ok(hits(`export const CTX_OLD_NAMES = ['맥락 관리', '맥락관리']; const t = '맥락 관리';`, "x.ts", ["CTX_OLD_NAMES"]).length === 1, "N4 옛 이름 검색어 표만 예외이고 같은 파일의 다른 문자열은 잡는다");

// ── 잎 모듈을 그 자리에서 transpile 해 값으로 부른다 ─────────────────────────────
function walkTs(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...walkTs(p)); }
    else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const tmp = mkdtempSync(join(tmpdir(), "ctx-rename-"));
async function load(rel) {
  const src = read(rel);
  if (!src) return null;
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const out = join(tmp, rel.replace(/^web\//, "").replace(/\.ts$/, ".js"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, js);
  try { return await import(pathToFileURL(out).href); } catch (e) { return { __error: String(e) }; }
}
const names = await load("web/lib/ctx-names.ts");
const match = await load("web/lib/app-match.ts");
const docs = await load("web/docs-content.ts");

// ── T. 이름 ──────────────────────────────────────────────────────────────────
ok(!!names && !names.__error, "T0 이름 잣대가 잎 모듈(web/lib/ctx-names.ts)에 있다");
if (names && !names.__error) {
  const { CTX_APP_NAME, CTX_TAB, CTX_OLD_NAMES, ctxPath, ctxTrail } = names;
  ok(CTX_APP_NAME === "수집 · 증류", "T1 앱 이름 = «수집 · 증류»", String(CTX_APP_NAME));
  const want = { home: "실시간 현황", runs: "자동 실행 기록", inbox: "확인할 것", sources: "수집기 설정", distill: "증류기 설정", checks: "점검 설정", deliver: "AI 주입 설정" };
  ok(JSON.stringify(CTX_TAB) === JSON.stringify(want), "T2 탭 이름 일곱 개가 고른 그대로다", JSON.stringify(CTX_TAB));
  ok(ctxPath("sources") === "[수집 · 증류 ▸ 수집기 설정]" && ctxPath() === "[수집 · 증류]"
    && ctxPath("distill", "카테고리 붙이기") === "[수집 · 증류 ▸ 증류기 설정 ▸ 카테고리 붙이기]" && ctxTrail("distill") === "수집 · 증류 ▸ 증류기 설정",
    "T3 자리 표기", [ctxPath("sources"), ctxPath(), ctxPath("distill", "카테고리 붙이기"), ctxTrail("distill")].join(" / "));
  ok(ctxPath(undefined) === "[수집 · 증류]" && ctxPath("checks", ...[]) === "[수집 · 증류 ▸ 점검 설정]" && ctxTrail() === "수집 · 증류",
    "T4 새 값 비었음: 뒤 칸이 없으면 «▸» 가 끝에 안 남는다", [ctxPath(undefined), ctxPath("checks", ...[]), ctxTrail()].join(" / "));
  ok(Array.isArray(CTX_OLD_NAMES) && CTX_OLD_NAMES.includes("맥락 관리") && CTX_OLD_NAMES.includes("맥락관리"), "T5 옛 이름 검색어는 띄어 쓴 것 · 붙여 쓴 것 둘 다");
}

// ── S. 앱 찾기 ────────────────────────────────────────────────────────────────
ok(!!match && !match.__error, "S0 앱 찾기 잣대가 잎 모듈(web/lib/app-match.ts)에 있다");
if (match && !match.__error) {
  const { appMatches, appRank } = match;
  const ctx = { title: "수집 · 증류", desc: "여러 원천에서 맥락이 수집되고 증류되는 것을 실시간으로 보고 설정합니다", aka: ["맥락 관리", "맥락관리"] };
  const wiki = { title: "WIKI", desc: "지식 트리 · 문서 · 검토 큐" };
  ok(appMatches(ctx, "맥락 관리") && appMatches(ctx, "맥락관리") && appMatches(ctx, "관리"), "S1 옛 이름으로 찾힌다(띄어 쓴 것 · 붙여 쓴 것 · 한 단어)");
  ok(appMatches(ctx, "수집 · 증류") && appMatches(ctx, "증류") && appMatches(ctx, "수집") && appMatches(ctx, "맥락"), "S2 새 이름 · 새 이름의 한 단어 · 설명의 «맥락» 으로 찾힌다");
  ok(!appMatches(ctx, "프로젝트") && !appMatches(wiki, "맥락 관리") && appMatches(ctx, "") && appMatches(wiki, "   "), "S3 상관없는 검색어는 안 맞고 빈 검색어는 전부 맞는다");
  ok(appMatches(wiki, "wiki") && appMatches(wiki, "Wiki") && appMatches(wiki, "문서") && !appMatches({ title: "A", desc: "" }, "b"), "S4 대소문자를 안 가리고, 검색어(aka)가 없는 앱도 돈다");
  const r = [appRank(ctx, "수집"), appRank(ctx, "증류"), appRank(ctx, "맥락 관리"), appRank(ctx, "실시간")];
  ok(r.join(",") === "0,1,2,3", "S5 순서: 이름 시작 0 · 이름 안 1 · 옛 이름 2 · 설명에만 3", r.join(","));
}

// ── C. 칩 ────────────────────────────────────────────────────────────────────
await load("web/lib/dom.ts");
const uitext = await load("web/lib/uitext.ts");
ok(!!uitext && !uitext.__error && typeof uitext.uiKeyCls === "function", "C0 칩 잣대(web/lib/uitext.ts)를 읽었다", uitext && uitext.__error ? uitext.__error : "");
if (uitext && typeof uitext.uiKeyCls === "function") {
  const solid = (label) => uitext.uiKeyCls("md-uikey-opt", label).split(" ").includes("md-uikey-solid");
  ok(solid("수집 · 증류") && solid("AI 주입 설정") && solid(" 실시간 현황 "), "C1 공백이 있어도 짧은 이름은 한 덩어리다");
  const L12 = "가나 다라 마바 사아자", L13 = "가나 다라 마바 사아자차";
  ok(L12.length === 12 && L13.length === 13 && !solid("수집 · 증류 ▸ 증류기 설정 ▸ 카테고리 붙이기") && solid(L12) && !solid(L13), "C2 12자를 넘는 공백 있는 라벨은 흐른다(경계: 12자 한 덩어리 · 13자 흐름)", [solid(L12), solid(L13)].join(","));
  ok(solid("연결·데이터·자료함·설정값모음") && solid("저장"), "C3 공백 없는 라벨은 길어도 한 덩어리다");
}
ok(/replace\(\/\^\\s\*\[—–:-\]\\s\*\//.test(read("web/guide/render.ts")), "C4 도움말의 «**이름**: 설명» 목록이 쌍점도 구분자로 걷는다(#4179 에서 web/guide/render.ts 로 옮겼다)");

// ── W. 배선(소스) ─────────────────────────────────────────────────────────────
const appsSrc = read("web/v2/apps.ts"), omniSrc = read("web/v2/omni.ts"), ctxSrc = read("web/context.ts");
{
  const line = (appsSrc.split("\n").find((l) => /\{\s*key: 'context'/.test(l)) || "");
  const desc = (line.match(/desc: '([^']*)'/) || [])[1] || "";
  ok(/title: CTX_APP_NAME/.test(line) && /aka: CTX_OLD_NAMES/.test(line) && desc.includes("맥락") && !desc.includes("—") && desc.length > 10,
    "W1 APPS 의 context 줄: 이름 · 옛 이름 검색어 · 설명(«맥락» 있음, 긴 줄표 없음)", line.trim().slice(0, 200));
  ok(/appMatches\(a, q\)/.test(appsSrc) && /appMatches\(a, nq\)/.test(omniSrc) && !/\(a\.title \+ ' ' \+ a\.desc\)\.toLowerCase\(\)\.includes/.test(omniSrc),
    "W2 런치패드와 통합검색이 같은 잣대(appMatches)로 거른다");
}
{
  //  STAGES 배열의 탭마다 { key: 'x', label: CTX_TAB.x }. 파서로 본다(글자 맞추기가 아니라 구조).
  const sf = ts.createSourceFile("context.ts", ctxSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bad = []; let seen = 0;
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "STAGES" && n.initializer && ts.isArrayLiteralExpression(n.initializer)) {
      for (const e of n.initializer.elements) {
        if (!ts.isObjectLiteralExpression(e)) continue;
        const prop = (k) => e.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === k);
        const key = prop("key")?.initializer, label = prop("label")?.initializer;
        const k = key && ts.isStringLiteral(key) ? key.text : "?";
        seen++;
        if (!label || label.getText(sf) !== `CTX_TAB.${k}`) bad.push(`${k}: label = ${label ? label.getText(sf) : "없음"}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  ok(seen === 7 && bad.length === 0, "W3 탭 일곱 개가 CTX_TAB 의 제 키를 읽는다", `본 탭 ${seen}개\n` + bad.map((b) => "  " + b).join("\n"));
  const head = ctxSrc.slice(ctxSrc.indexOf("function buildHeader"), ctxSrc.indexOf("const HEALTH_TAB"));
  ok(/'aria-label': CTX_APP_NAME/.test(head) && /text: CTX_APP_NAME/.test(head) && /text: CTX_TAB\.inbox/.test(head), "W3 머리 문패 · aria-label · 트레이가 이름 잣대를 읽는다");
}
{
  const html = read("public/index.html").replace(/<!--[\s\S]*?-->/g, "");
  ok(/<a href="#\/context" data-tab="context">수집 · 증류<\/a>/.test(html) && !OLD.test(html), "W4 클래식 상단 탭의 글이 새 이름이다");
}

// ── H. 화면 제목 = 탭 이름 ─────────────────────────────────────────────────────
/** 소스에서 h3.cxc-title 마다 [제목 식(첫 span 의 text), 수 식(.cxc-title-n 의 text)] 을 뽑는다. */
function titlesOf(src, name) {
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const prop = (obj, k) => obj && ts.isObjectLiteralExpression(obj) ? obj.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf).replace(/['"]/g, "") === k)?.initializer : undefined;
  const isEl = (n, tag) => ts.isCallExpression(n) && n.expression.getText(sf) === "el" && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === tag;
  const cls = (n) => { const c = prop(n.arguments[1], "class"); return c && ts.isStringLiteral(c) ? c.text : ""; };
  const visit = (n) => {
    if (isEl(n, "h3") && /\bcxc-title\b/.test(cls(n))) {
      const spans = n.arguments.slice(2).filter((a) => isEl(a, "span"));
      const title = spans.find((a) => !/cxc-title-n/.test(cls(a))), count = spans.find((a) => /cxc-title-n/.test(cls(a)));
      const t = title && prop(title.arguments[1], "text"), c = count && prop(count.arguments[1], "text");
      out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, title: t ? t.getText(sf) : "", literal: t && ts.isStringLiteral(t) ? t.text : null, count: c ? c.getText(sf) : "" });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
{
  const col = titlesOf(read("web/context-collectors.ts"), "context-collectors.ts"), dis = titlesOf(read("web/distillers.ts"), "distillers.ts");
  ok(col.length === 1 && col[0].title === "CTX_TAB.sources" && dis.length === 1 && dis[0].title === "CTX_TAB.distill",
    "H1 수집기 설정 · 증류기 설정 화면 제목이 탭 이름을 읽는다", `수집기 화면: ${col.map((t) => t.title).join(", ")} / 증류기 화면: ${dis.map((t) => t.title).join(", ")}`);
  const OLD_TABS = ["현황", "수집기", "증류기", "점검", "AI 전달"];
  const bad = [];
  for (const f of readdirSync(join(root, "web")).filter((n) => /^(context.*|distill.*|admin-injection|review)\.ts$/.test(n))) {
    for (const t of titlesOf(read("web/" + f), f)) if (t.literal != null && OLD_TABS.includes(t.literal.trim())) bad.push(`  web/${f}:${t.line}  ${JSON.stringify(t.literal)}`);
  }
  ok(bad.length === 0, "H2 어느 화면 제목도 옛 탭 이름을 글자로 적지 않는다", bad.join("\n"));
  ok(/수집기 /.test(col[0]?.count || "") && /개/.test(col[0]?.count || "") && /증류기 /.test(dis[0]?.count || "") && /개/.test(dis[0]?.count || ""),
    "H3 제목 옆 수는 무엇의 수인지 적는다", `수집기 화면: ${col[0]?.count} / 증류기 화면: ${dis[0]?.count}`);
  //  탭 설명(STAGES 의 hint) 가운데 화면에 서는 둘. 파서로 key 와 hint 를 짝지어 읽는다.
  const sf = ts.createSourceFile("context.ts", ctxSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hints = {};
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "STAGES" && n.initializer && ts.isArrayLiteralExpression(n.initializer)) {
      for (const e of n.initializer.elements) {
        if (!ts.isObjectLiteralExpression(e)) continue;
        const get = (k) => e.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === k)?.initializer;
        const key = get("key"), hint = get("hint");
        if (key && ts.isStringLiteral(key) && hint && ts.isStringLiteral(hint)) hints[key.text] = hint.text;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const shown = ["checks", "deliver"].map((k) => [k, hints[k] || ""]);
  ok(shown.every(([, h]) => h.length > 10 && !h.includes("—")), "H4 제목 자리에 서는 탭 설명(점검 설정 · AI 주입 설정)에 긴 줄표가 없다", shown.map(([k, h]) => `  ${k}: ${h}`).join("\n"));
}

// ── P. 안내문 ────────────────────────────────────────────────────────────────
{
  const TABS = ["실시간 현황", "수집기 설정", "증류기 설정", "점검 설정", "AI 주입 설정"];
  //  자리 표기(ctxPath · ctxTrail)를 쓰는 파일의 문자열에 탭 이름이 글자로 또 있으면, 표기 바로 뒤에 같은 말이 되풀이된다.
  const dup = [];
  for (const f of walkTs(join(root, "web"))) {
    const src = readFileSync(f, "utf8");
    if (!/ctxPath\(|ctxTrail\(/.test(src) || /lib\/ctx-names\.ts$/.test(f) || /docs-content\.ts$/.test(f)) continue;
    for (const [line, str] of stringsOf(src, f)) if (TABS.some((t) => str.includes(t))) dup.push(`  ${relative(root, f)}:${line}  ${JSON.stringify(str.slice(0, 80))}`);
  }
  ok(dup.length === 0, "P1 자리 표기 뒤에 같은 탭 이름을 또 적지 않는다", dup.join("\n"));
  const mode = stringsOf(read("web/admin-ui-mode.ts"), "admin-ui-mode.ts").filter(([, str]) => /^새 화면 \(기본\)|^클래식[:：—\s]+상단 탭/.test(str) || /^클래식 — /.test(str));
  ok(mode.length >= 2 && mode.every(([, str]) => !str.includes("—")), "P2 화면 고르기 설명 두 줄에 긴 줄표가 없다", mode.map(([l, str]) => `  ${l}: ${str}`).join("\n"));
  const chips = [];
  for (const f of walkTs(join(root, "web"))) {
    const src = readFileSync(f, "utf8");
    if (!/\[(점검|수집기|증류기|현황|AI 전달)\]/.test(src)) continue;
    for (const [line, str] of stringsOf(src, f)) if (/\[(점검|수집기|증류기|현황|AI 전달)\]/.test(str)) chips.push(`  ${relative(root, f)}:${line}  ${JSON.stringify(str.slice(-70))}`);
  }
  ok(chips.length === 0, "P3 화면 글이 탭을 옛 이름 칩으로 가리키지 않는다", chips.join("\n"));
}

// ── R. 저장소 ────────────────────────────────────────────────────────────────
const listOf = (files) => {
  const found = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!OLD.test(src)) continue;
    for (const [line, s] of hits(src, f, ["CTX_OLD_NAMES"])) found.push(`  ${relative(root, f)}:${line}  ${JSON.stringify(s.length > 90 ? s.slice(0, 90) + "…" : s)}`);
  }
  return found;
};
const webFiles = walkTs(join(root, "web"));
ok(webFiles.length > 50, `R0 web/ 의 소스를 찾았다(${webFiles.length}개)`);
const webFound = listOf(webFiles);
ok(webFound.length === 0, `R1 web/ 화면 글에 옛 이름 0건(지금 ${webFound.length}건)`, webFound.join("\n"));

//  사람에게 닿는 서버 글. 로그 · 주석 · 시험 · 자동 생성물(default-content.ts 의 스킬 본문)은 대상이 아니다.
const SERVER = ["src/scheduler/registry.ts", "src/org/delivery/onboarding.ts", "src/org/manage/run-manager.ts", "src/capabilities/delivery/pipeline.ts", "src/capabilities/delivery/runtime-config.ts",
  "deploy/bootstrap-baseline.mjs"];   // 새 조직에 심는 기본 주입문(사람이 [AI 주입 설정]에서 본다)
const srvFound = listOf(SERVER.map((p) => join(root, p)));
ok(srvFound.length === 0, `R2 사람에게 닿는 서버 글에 옛 이름 0건(지금 ${srvFound.length}건)`, srvFound.join("\n"));

// ── D. 도움말 ────────────────────────────────────────────────────────────────
ok(!!docs && !docs.__error && Array.isArray(docs.DOC_PAGES), "D0 도움말 원고를 읽었다", docs && docs.__error ? docs.__error : "");
if (docs && Array.isArray(docs.DOC_PAGES)) {
  const page = docs.DOC_PAGES.find((p) => p.slug === "context");
  const tabs = ["실시간 현황", "수집기 설정", "증류기 설정", "점검 설정", "AI 주입 설정"];
  ok(!!page && page.title === "수집 · 증류" && page.md.startsWith("# 수집 · 증류") && tabs.every((t) => page.md.includes(t)),
    "D1 도움말 context 쪽: 제목이 새 이름이고 탭 다섯 개를 새 이름으로 적는다", page ? page.title + " / 빠진 탭: " + tabs.filter((t) => !page.md.includes(t)).join(", ") : "쪽 없음");
  const stale = [];
  for (const p of docs.DOC_PAGES) for (const m of p.md.matchAll(/▸ (?:⑤ )?전달|▸ 증류 ▸|▸ 수집\]|▸ 가져오는 곳|▸ 분류 ▸/g)) stale.push(`  ${p.slug}: ${m[0]}`);
  ok(stale.length === 0, "D2 도움말에 옛 탭 자리 표기가 없다", stale.join("\n"));
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
