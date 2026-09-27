// #4179 사용 가이드 원고(web/docs-content.ts)와 주소 · 찾기가 스스로 어긋나지 않는지 본다.
//  원고는 글이라 타입 검사가 잡지 못한다. 문서를 지우거나 절 이름을 바꾸면 링크가 조용히 끊기고, 없는 도식 · 아이콘 이름은 빈자리나 다른 그림으로 나온다.
//
//  사양 · 엣지 표(spec-failfirst):
//   N1 절 나누기가 코드 울타리 · ::: 상자 안의 `## ` 을 제목으로 세지 않는다
//   N2 `## 제목 {#id}` 에서 id 를 떼고, 없으면 순번을 쓴다
//   N3 제목이 하나도 없는 원고는 절 0개다(도입부만 있다)
//   S1 묶음(DOC_GROUPS)의 문서는 전부 있다. 문서는 전부 묶음 하나에만 든다
//   S2 문서 주소(slug)가 겹치지 않는다. 옛 주소 표(DOC_LEGACY)의 도착지는 전부 있는 문서이고, 옛 주소가 지금 문서의 주소와 겹치지 않는다
//   S3 문서마다 제목 · 한 줄 설명(lead)이 있고 원고는 `# 제목` 으로 시작한다(제목과 같은 글자)
//   S4 문서마다 절이 하나 이상 있고, 한 문서 안에서 절의 닻(id)이 겹치지 않는다
//   S5 기준 날짜(DOC_AS_OF)가 날짜 모양이다
//   L1 가이드 안 링크(#/learn/docs/<문서>)가 전부 있는 문서를 가리킨다
//   L2 절까지 가리키는 링크(?h=<절>)는 그 문서에 그 절이 있다
//   L3 옛 주소로 적은 링크가 없다(도착지는 같아도 한 번 더 돈다)
//   F1 원고가 부르는 도식({{fig:이름}})이 전부 guide/figures.ts 에 있다. 도식은 한 줄을 통째로 차지한다
//   F2 원고와 묶음이 부르는 아이콘이 전부 그림 표(lib/icon-paths.ts)에 있다
//   F3 도식(guide/figures.ts)이 부르는 아이콘 이름도 전부 표에 있다(변수 · 배열로 넘기는 이름까지)
//   W1 원고 · 제목 · 설명 · 묶음 글에 긴 줄표가 없다
//   W2 원고에 «곁칸» 이 없다(화면 글은 「우측 사이드바」)
//   W3 원고에 옛 앱 이름을 글자로 적지 않는다(CTX_OLD_NAMES 를 읽는다)
//   W4 설명하는 문장이 명사로 끝나지 않는다: lead 와 묶음 설명(hint)은 «다.» 로 끝난다
//   W5 단추 표기 [ ] 안이 비어 있지 않다(공백뿐인 칩이 없다). 기호 단추([＋] · [■])는 실제 단추라 허용한다
//   P1 주소의 뒤 칸이 없으면 첫 화면이다
//   P2 있는 문서의 주소는 그 문서다
//   P3 없는 문서 · 문서 칸이 빈 주소는 첫 화면이다
//   P4 옛 문서 주소는 지금 문서로 바뀐다
//   P5 「연결된 지식」 도움말의 옛 주소(wiki?focus=required)는 프로젝트 문서의 knowledge 절로 가고, 그 절이 실제로 있다
//   P6 ?h=<절> 이 절로 실린다. h 가 빈 글자면 절이 없다
//   P7 옛 둘러보기 · 설치 주소는 클래식 주소로 넘긴다
//   P8 깨진 % 표기가 와도 던지지 않고 첫 화면이다
//   H1 문서 주소 만들기: 빈 문서 = #/learn · 문서 = #/learn/docs/<문서> · 절이 있으면 ?h= 가 붙는다
//   R1 찾기: 문서 제목 그대로 찾으면 그 문서가 맨 앞에 온다(절 없이)
//   R2 찾기: 절 제목의 낱말로 찾으면 그 절이 결과에 있고 절이 실린다
//   R3 찾기: 빈 검색어 · 공백뿐인 검색어 · 없는 말은 결과가 없다
//   R4 찾기: 낱말 둘은 둘 다 든 곳만 맞는다
//   R5 찾기: 결과 수 상한을 지킨다(상한 3 · 1 · 0)
//  ⚠ 원고와 모듈을 그 자리에서 transpile 해 값으로 부른다. 화면을 그리는 import 는 빈 모듈로 바꿔 싣는다(순수 함수만 부른다).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${detail ? "\n" + detail : ""}`); } };

const tmp = mkdtempSync(join(tmpdir(), "guide-docs-"));
function emit(rel, patch = (s) => s) {
  const js = ts.transpileModule(patch(read(rel)), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const out = join(tmp, rel.replace(/^web\//, "").replace(/\.ts$/, ".js"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, js);
  return out;
}
const load = async (file) => { try { return await import(pathToFileURL(file).href); } catch (e) { return { __error: String(e) }; } };

emit("web/lib/ctx-names.ts");
emit("web/lib/icon-paths.ts");
const docs = await load(emit("web/docs-content.ts"));
const icons = await load(join(tmp, "lib/icon-paths.js"));
writeFileSync(join(tmp, "stub.js"), "const n = () => null;\nexport const el = n, renderMarkdown = n, replaceKids = n, sv = n, copyButton = n, guideFigure = n, guideIcon = n;\n");
const stubImports = (s) => s
  .replace(/from '\.\.\/core\.js'/g, "from '../stub.js'").replace(/from '\.\.\/ui-primitives\.js'/g, "from '../stub.js'")
  .replace(/from '\.\/figures\.js'/g, "from '../stub.js'").replace(/from '\.\/icon\.js'/g, "from '../stub.js'");
const render = await load(emit("web/guide/render.ts", stubImports));
const search = await load(emit("web/guide/search.ts"));
const app = await load(emit("web/guide/app.ts", stubImports));

ok(!!docs && !docs.__error && Array.isArray(docs.DOC_PAGES) && Array.isArray(docs.DOC_GROUPS), "S0 원고를 읽었다", docs && docs.__error ? docs.__error : "");
ok(!!render && !render.__error && typeof render.splitGuideSections === "function", "N0 절 나누기 잣대를 읽었다", render && render.__error ? render.__error : "");
ok(!!search && !search.__error && typeof search.guideSearch === "function", "R0 찾기 잣대를 읽었다", search && search.__error ? search.__error : "");
ok(!!app && !app.__error && typeof app.parseGuideRoute === "function" && typeof app.guideHref === "function", "P0 주소 잣대를 읽었다", app && app.__error ? app.__error : "");
if (fail) { rmSync(tmp, { recursive: true, force: true }); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

const { DOC_PAGES, DOC_GROUPS, DOC_LEGACY, DOC_AS_OF } = docs;
const bySlug = new Map(DOC_PAGES.map((p) => [p.slug, p]));
const bodyOf = (p) => p.md.replace(/^#\s+[^\n]*\n/, "");
const secsOf = (p) => render.splitGuideSections(bodyOf(p)).filter((s) => s.title);

// ── N. 절 나누기 ──────────────────────────────────────────────────────────────
{
  const md = "앞글\n## 하나 {#one}\n```\n## 코드 안\n```\n:::callout\n## 상자 안\n:::\n## 둘\n글\n";
  const s = render.splitGuideSections(md);
  ok(s.length === 3 && s[0].title === null && s[1].title === "하나" && s[2].title === "둘", "N1 코드 울타리 · 상자 안의 `## ` 은 제목이 아니다", JSON.stringify(s.map((x) => x.title)));
  ok(s[1].id === "one" && s[2].id === "s2", "N2 `{#id}` 를 떼어 닻으로 쓰고, 없으면 순번을 쓴다", s.map((x) => x.id).join(","));
  ok(s[1].lines.join("\n").includes("## 코드 안") && s[1].lines.join("\n").includes("## 상자 안"), "N1 절이 아닌 줄은 앞 절의 글로 남는다");
  const none = render.splitGuideSections("글만 있다\n둘째 줄");
  ok(none.length === 1 && none[0].title === null && none[0].lines.length === 2 && render.guideSectionsOf("글만 있다").length === 0, "N3 제목 없는 원고는 절 0개다");
}

// ── S. 짜임 ───────────────────────────────────────────────────────────────────
{
  const grouped = DOC_GROUPS.flatMap((g) => g.slugs);
  const missing = grouped.filter((s) => !bySlug.has(s));
  const orphan = DOC_PAGES.map((p) => p.slug).filter((s) => grouped.filter((x) => x === s).length !== 1);
  ok(DOC_PAGES.length >= 20 && missing.length === 0 && orphan.length === 0, `S1 묶음 ${DOC_GROUPS.length}개 · 문서 ${DOC_PAGES.length}장이 서로 맞는다`,
    `  묶음에만 있는 주소: ${missing.join(", ")}\n  묶음에 없거나 두 번 든 문서: ${orphan.join(", ")}`);
  const dup = DOC_PAGES.map((p) => p.slug).filter((s, i, a) => a.indexOf(s) !== i);
  const badLegacy = Object.entries(DOC_LEGACY).filter(([from, to]) => !bySlug.has(to) || bySlug.has(from));
  ok(dup.length === 0 && badLegacy.length === 0 && Object.keys(DOC_LEGACY).length > 0, "S2 문서 주소가 겹치지 않고 옛 주소의 도착지가 전부 있다",
    `  겹침: ${dup.join(", ")}\n  옛 주소: ${badLegacy.map((x) => x.join("→")).join(", ")}`);
  const badHead = DOC_PAGES.filter((p) => !p.title.trim() || !p.lead.trim() || !p.md.startsWith("# " + p.title + "\n"));
  ok(badHead.length === 0, "S3 문서마다 제목 · 설명이 있고 원고가 `# 제목` 으로 시작한다", badHead.map((p) => "  " + p.slug).join("\n"));
  const badSecs = DOC_PAGES.map((p) => { const ids = secsOf(p).map((s) => s.id); return [p.slug, ids.length, ids.filter((x, i) => ids.indexOf(x) !== i)]; }).filter(([, n, d]) => n === 0 || d.length);
  ok(badSecs.length === 0, "S4 문서마다 절이 있고 닻이 겹치지 않는다", badSecs.map(([s, n, d]) => `  ${s}: 절 ${n}개, 겹친 닻 ${d.join(",")}`).join("\n"));
  ok(/^\d{4}-\d{2}-\d{2}$/.test(DOC_AS_OF) && !Number.isNaN(Date.parse(DOC_AS_OF)), "S5 기준 날짜(DOC_AS_OF)가 날짜 모양이다", String(DOC_AS_OF));
}

// ── L. 링크 ───────────────────────────────────────────────────────────────────
{
  const dead = [], deadSec = [], legacy = [];
  let n = 0;
  for (const p of DOC_PAGES) for (const m of p.md.matchAll(/\]\(#\/learn\/docs\/([a-z0-9-]+)(?:\?h=([a-z0-9-]+))?\)/gi)) {
    n++;
    const to = bySlug.get(m[1]);
    if (m[1] in DOC_LEGACY) legacy.push(`  ${p.slug} → ${m[1]}`);
    else if (!to) dead.push(`  ${p.slug} → ${m[1]}`);
    else if (m[2] && !secsOf(to).some((s) => s.id === m[2])) deadSec.push(`  ${p.slug} → ${m[1]}?h=${m[2]}`);
  }
  ok(n >= 30 && dead.length === 0, `L1 가이드 안 링크 ${n}개가 전부 있는 문서를 가리킨다`, dead.join("\n"));
  ok(deadSec.length === 0, "L2 절을 가리키는 링크는 그 문서에 그 절이 있다", deadSec.join("\n"));
  ok(legacy.length === 0, "L3 옛 주소로 적은 링크가 없다", legacy.join("\n"));
  //  가이드 안 링크인데 위 모양이 아닌 것(#/learn/<다른 칸>)은 첫 화면으로 떨어진다. 그런 링크는 적지 않는다.
  const odd = [];
  for (const p of DOC_PAGES) for (const m of p.md.matchAll(/\]\((#\/learn[^)]*)\)/g)) if (!/^#\/learn\/docs\/[a-z0-9-]+(\?h=[a-z0-9-]+)?$/i.test(m[1]) && m[1] !== "#/learn") odd.push(`  ${p.slug}: ${m[1]}`);
  ok(odd.length === 0, "L1 가이드 안 링크는 문서 주소 모양만 쓴다", odd.join("\n"));
}

// ── F. 도식 · 아이콘 ──────────────────────────────────────────────────────────
{
  const FIG_SRC = read("web/guide/figures.ts");
  const table = FIG_SRC.slice(FIG_SRC.indexOf("const FIGS"), FIG_SRC.indexOf("\n};", FIG_SRC.indexOf("const FIGS")));
  const figs = [...table.matchAll(/^\s+'?([a-z0-9-]+)'?: fig/gm)].map((m) => m[1]);
  const used = [], inline = [];
  for (const p of DOC_PAGES) for (const line of p.md.split("\n")) {
    for (const m of line.matchAll(/\{\{fig:([a-z0-9-]+)\}\}/gi)) { used.push([p.slug, m[1]]); if (line.trim() !== m[0]) inline.push(`  ${p.slug}: ${line.trim().slice(0, 60)}`); }
  }
  const badFig = used.filter(([, n]) => !figs.includes(n));
  ok(figs.length >= 5 && used.length >= 5 && badFig.length === 0 && inline.length === 0, `F1 원고가 부르는 도식 ${used.length}곳이 전부 있고 한 줄을 통째로 쓴다`,
    `  없는 도식: ${badFig.map((x) => x.join(":")).join(", ")}\n${inline.join("\n")}`);
  const ICONS = icons.ICONS || {};
  const badIc = [];
  let icN = 0;
  for (const p of DOC_PAGES) for (const m of p.md.matchAll(/\{\{ic:([a-z0-9-]+)\}\}/gi)) { icN++; if (!(m[1] in ICONS)) badIc.push(`  ${p.slug}: ${m[1]}`); }
  for (const g of DOC_GROUPS) if (!(g.icon in ICONS)) badIc.push(`  묶음 ${g.key}: ${g.icon}`);
  ok(Object.keys(ICONS).length > 20 && icN >= 10 && badIc.length === 0, `F2 원고(${icN}곳)와 묶음이 부르는 아이콘이 전부 그림 표에 있다`, badIc.join("\n"));
  const names = new Set();
  for (const m of FIG_SRC.matchAll(/guideIcon\('([a-zA-Z-]+)'/g)) names.add(m[1]);
  for (const m of FIG_SRC.matchAll(/\bicon: '([a-zA-Z-]+)'/g)) names.add(m[1]);
  for (const m of FIG_SRC.matchAll(/\b(?:place|binStep)\('([a-zA-Z-]+)'/g)) names.add(m[1]);
  for (const m of FIG_SRC.matchAll(/\[((?:'[a-zA-Z-]+',?\s*)+)\]\.map\(\(k\) => guideIcon\(k/g)) for (const x of m[1].matchAll(/'([a-zA-Z-]+)'/g)) names.add(x[1]);
  const badFigIc = [...names].filter((x) => !(x in ICONS));
  ok(names.size >= 15 && badFigIc.length === 0, `F3 도식이 부르는 아이콘 ${names.size}개가 전부 그림 표에 있다`, "  " + badFigIc.join(", "));
}

// ── W. 문장 ───────────────────────────────────────────────────────────────────
{
  const texts = [...DOC_PAGES.flatMap((p) => [[p.slug + " 제목", p.title], [p.slug + " 설명", p.lead], [p.slug + " 원고", p.md]]), ...DOC_GROUPS.flatMap((g) => [[g.key + " 묶음", g.title], [g.key + " 묶음 설명", g.hint]])];
  const dash = texts.filter(([, t]) => /[—–]/.test(t)).map(([k, t]) => `  ${k}: ${(t.match(/.{0,20}[—–].{0,20}/) || [""])[0].replace(/\n/g, " ")}`);
  ok(dash.length === 0, "W1 가이드 글에 긴 줄표가 없다", dash.join("\n"));
  const gyeot = texts.filter(([, t]) => t.includes("곁칸")).map(([k]) => "  " + k);
  ok(gyeot.length === 0, "W2 가이드 글에 «곁칸» 이 없다", gyeot.join("\n"));
  const sf = ts.createSourceFile("d.ts", read("web/docs-content.ts"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lits = [];
  const visit = (n) => { if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) lits.push(n.text); ts.forEachChild(n, visit); };
  visit(sf);
  ok(lits.length > 50 && !lits.some((t) => /맥락\s?관리/.test(t)), "W3 원고에 옛 앱 이름을 글자로 적지 않는다");
  const ending = [...DOC_PAGES.map((p) => [p.slug, p.lead]), ...DOC_GROUPS.map((g) => ["묶음 " + g.key, g.hint])].filter(([, t]) => !/다\.$/.test(t.trim()));
  ok(ending.length === 0, "W4 설명 문장이 어미까지 끝맺는다", ending.map(([k, t]) => `  ${k}: …${t.slice(-16)}`).join("\n"));
  const emptyChip = [];
  for (const p of DOC_PAGES) for (const m of p.md.matchAll(/\[([^\]\n]{0,40})\](?!\()/g)) if (!m[1].trim()) emptyChip.push(`  ${p.slug}: [${m[1]}]`);
  ok(emptyChip.length === 0, "W5 빈 단추 표기가 없다", emptyChip.join("\n"));
}

// ── P · H. 주소 ───────────────────────────────────────────────────────────────
{
  const at = (hash) => { const h = hash.replace(/^#\/?/, ""); const q = h.indexOf("?"); return app.parseGuideRoute((q >= 0 ? h.slice(0, q) : h).split("/").filter(Boolean), new URLSearchParams(q >= 0 ? h.slice(q + 1) : "")); };
  const same = (a, b) => a.slug === b.slug && a.anchor === b.anchor && (a.redirect || "") === (b.redirect || "");
  ok(same(at("#/learn"), { slug: "", anchor: "" }), "P1 뒤 칸이 없으면 첫 화면이다", JSON.stringify(at("#/learn")));
  ok(same(at("#/learn/docs/sessions"), { slug: "sessions", anchor: "" }), "P2 있는 문서의 주소는 그 문서다", JSON.stringify(at("#/learn/docs/sessions")));
  ok(same(at("#/learn/docs/no-such-doc"), { slug: "", anchor: "" }) && same(at("#/learn/docs"), { slug: "", anchor: "" }) && same(at("#/learn/menu"), { slug: "", anchor: "" }),
    "P3 없는 문서 · 문서 칸이 빈 주소 · 모르는 뒤 칸은 첫 화면이다");
  const legacyOk = Object.entries(DOC_LEGACY).every(([from, to]) => at("#/learn/docs/" + from).slug === to);
  ok(legacyOk && at("#/learn/docs/terminal").slug === "sessions", "P4 옛 문서 주소는 지금 문서로 바뀐다", JSON.stringify(Object.keys(DOC_LEGACY).map((k) => [k, at("#/learn/docs/" + k).slug])));
  const req = at("#/learn/docs/wiki?focus=required");
  ok(req.slug === "projects" && req.anchor === "knowledge" && secsOf(bySlug.get("projects")).some((s) => s.id === "knowledge"), "P5 「연결된 지식」 도움말의 옛 주소는 프로젝트 문서의 그 절로 간다", JSON.stringify(req));
  ok(same(at("#/learn/docs/wiki"), { slug: "wiki", anchor: "" }) && same(at("#/learn/docs/wiki?focus=other"), { slug: "wiki", anchor: "" }), "P5 focus 가 없거나 다른 값이면 위키 문서 그대로다");
  ok(same(at("#/learn/docs/projects?h=rules"), { slug: "projects", anchor: "rules" }) && same(at("#/learn/docs/projects?h="), { slug: "projects", anchor: "" }), "P6 ?h=<절> 이 절로 실리고, 빈 h 는 절이 없다");
  ok(at("#/learn/tour").redirect === "#/start/tour" && at("#/learn/install").redirect === "#/start" && !at("#/learn/docs/tour").redirect, "P7 옛 둘러보기 · 설치 주소는 클래식 주소로 넘긴다");
  let threw = false, broken = null;
  try { broken = app.parseGuideRoute(["learn", "docs", "%E0%A4%A"], new URLSearchParams("")); } catch { threw = true; }
  ok(!threw && broken && broken.slug === "", "P8 깨진 % 표기가 와도 던지지 않고 첫 화면이다");
  ok(app.guideHref("") === "#/learn" && app.guideHref("wiki") === "#/learn/docs/wiki" && app.guideHref("wiki", "pin") === "#/learn/docs/wiki?h=pin" && app.guideHref("wiki", "") === "#/learn/docs/wiki",
    "H1 문서 주소를 만든다(첫 화면 · 문서 · 절)", [app.guideHref(""), app.guideHref("wiki"), app.guideHref("wiki", "pin")].join(" "));
  //  만든 주소를 다시 풀면 같은 자리다(왕복).
  const round = DOC_PAGES.every((p) => secsOf(p).every((s) => { const w = at(app.guideHref(p.slug, s.id)); return w.slug === p.slug && w.anchor === s.id; }));
  ok(round, "H1 만든 주소를 다시 풀면 같은 문서 · 같은 절이다");
  ok(app.guideTabTitle(at("#/learn")) === "사용 가이드" && app.guideTabTitle(at("#/learn/docs/wiki")) === bySlug.get("wiki").title, "H2 창 이름은 첫 화면이면 앱 이름, 문서면 문서 제목이다");
}

// ── R. 찾기 ───────────────────────────────────────────────────────────────────
{
  const q = (s, n) => search.guideSearch(s, n);
  const t1 = q("분류체계");
  ok(t1.length > 0 && t1[0].slug === "taxonomy" && !t1[0].secId, "R1 문서 제목으로 찾으면 그 문서가 맨 앞에 온다", JSON.stringify(t1.slice(0, 2).map((h) => [h.slug, h.secId, h.score])));
  const t2 = q("프로젝트 규칙", 50);
  ok(t2.some((h) => h.slug === "projects" && h.secId === "rules"), "R2 절 제목으로 찾으면 그 절이 결과에 있다", JSON.stringify(t2.slice(0, 4).map((h) => [h.slug, h.secId])));
  ok(q("").length === 0 && q("   ").length === 0 && q("없는말없는말없는말").length === 0, "R3 빈 검색어와 없는 말은 결과가 없다");
  const both = q("휴지통 되돌리기", 500), one = q("휴지통", 500);
  ok(both.length > 0 && both.length < one.length && both.every((h) => one.some((o) => o.slug === h.slug && o.secId === h.secId)), "R4 낱말 둘은 둘 다 든 곳만 맞는다", `${both.length} / ${one.length}`);
  ok(q("세션", 3).length === 3 && q("세션", 1).length === 1 && q("세션", 0).length === 0, "R5 결과 수 상한을 지킨다(3 · 1 · 0)", [q("세션", 3).length, q("세션", 1).length, q("세션", 0).length].join(","));
  ok(q("WIKI").length > 0 && q("wiki").length === q("WIKI").length, "R6 대소문자를 가리지 않는다");
  const plain = search.plainOf("앞 {{ic:home}} 글 [단추] 「이름」\n{{fig:loop}}\n| 가 | 나 |\n|---|---|\n[문서](#/learn/docs/wiki) 끝");
  ok(!/[{}[\]「」|#]/.test(plain) && plain.includes("단추") && plain.includes("문서") && !plain.includes("learn") && !plain.includes("loop"), "R7 찾기용 글에서 표기를 걷는다", plain);
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
