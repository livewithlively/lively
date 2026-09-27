// #4233 아이콘 개편(원준 2026-09-27 「아이콘 · 이름 고르기」에서 고른 것).
//  선 아이콘의 그림은 web/lib/icon-paths.ts 한 벌이고, 부르는 쪽(icon · pnIcon · appIcon · appGlassIcon · 우측 사이드바 부품)은
//  그 표에 있는 이름만 쓴다. 표에 없는 이름은 다른 그림으로 떨어진다: 사이드바의 리스트 줄이 「앱」 그림(사각 넷)으로 나오던 것이 그 예다.
//
//  사양 · 엣지 표(spec-failfirst):
//   V1 고른 그림: 표의 path 가 고른 path 와 글자까지 같다(홈 · 위키 · 자료 · 분류체계 · 맥락 관리 · 세션 이력 · 홈(클래식) ·
//      사용 가이드 · 앱 · 사이드바 접기 · 알림 · 지난 세션 · 휴지통 · 외부 앱 연결 · 세션 앱 · 리스트)
//   V2 「지금」을 고른 그림은 종전 path 그대로다(말풍선 · 프로젝트 · 리브 · 톱니 · 묶음 · 압정 · 반짝임 · 연필)
//   V3 우측 사이드바 부품 12개가 고른 그림의 이름을 쓴다(세션 = chat · 지식 = wiki · 리브 = liv · 지난 세션 = archive · 앱 = apps …)
//   V4 우측 사이드바에서 같은 그림을 쓰던 두 쌍이 갈린다(자료 ≠ 세션 파일, 웹 ≠ 미리보기)
//   V5 설정(sys)과 톱니(gear)는 같은 그림이다
//   G1 web/ 에서 icon('이름') · lineIcon('이름') 으로 부르는 이름이 전부 표에 있다(고치기 전: list 가 없다)
//   G2 pnIcon('이름') 으로 부르는 이름이 전부 표에 닿는다(고치기 전: search 가 없다)
//   G3 우측 사이드바 부품(PART_DEFS)의 icon 이 전부 표에 닿는다
//   G4 앱 표(APPS)의 icon 이 전부 appIcon 의 표와 앱 아이콘 이름에 있다
//   G5 우클릭 메뉴 줄의 icon: '이름' 이 전부 표에 있다
//   G6 그림 표가 한 곳뿐이다(panes-kit · connect · side 에 path 표가 없다)
//   G6 사이드바 「세션 이력」 줄도 표의 그림을 쓴다
//   H1 앱 화면 머리: 「수집 · 증류」 머리는 표의 ctx 를 그리고 획은 토큰(--ic-stroke)을 읽는다. 「사용 가이드」 머리는 표의 learn 을 그린다
//   H2 통합검색의 종류 아이콘(프로젝트 · 지식 · 자료 · 세션 · 세션 이력)이 표의 그림이다
//   H3 종(알림): [나] 창의 「알림」 · 태스크 창의 활동 구독이 표의 bell 이다
//   H4 휴지통: 사이드바의 휴지통 단추 둘 · 세션 설정 창 「정리」 · 프로젝트 · 대시보드의 휴지통이 표의 trash 다
//   H5 증류기 카드의 「모든 자료」 그림 · 클래식 AI 세션의 「세션 기록」 단추 · 가이드의 집과 책이 표의 그림이다
//   H6 손으로 그린 옛 그림(집 · 깔때기 · 상자 · 휴지통 · 가로 고리 · 종 · 책 · 태그 묶음)이 web/ 에 남아 있지 않다
//   P1 앱 아이콘: 타일 하나 + 그 앱의 선 그림 + 그 앱의 색 토큰
//   P2 앱 아이콘: 앱 이름 → 선 그림 이름(홈(클래식) = dashboard, 설정 = gear, 나머지는 같은 이름)
//   P3 앱 아이콘: 모르는 이름 · 빈 이름은 apps 로 떨어진다(던지지 않는다)
//   P4 타일: 모서리 반지름이 한 변의 26%(±1%)이고, 유리 겹침 그림의 흔적(GLASS_ART · 기울기 · 흐림)이 없다
//   P5 색 토큰: 이름 14개가 라이트(01-base) · 다크(90-dark 두 블록)에 전부 있다
//   P6 대비(경계 3:1): 색 선이 타일 위에서 3:1 이상이다. 라이트는 앱 화면의 타일과 흰 종이 위의 타일, 다크는 앱 화면의 타일과 어두운 종이 위의 타일
//   P7 다크에서 뒤 화면이 흰색일 때(문서 미리보기)에도 3:1 이상이다
//   B1 설치한 앱 가운데 우리가 만든 것: 확인할 것(inbox) = 종(bell) · 웹 브라우저(browser) = 지구본(web)
//   B2 그 밖의 앱(남이 만든 앱 · 그림을 정하지 않은 빌트인)은 기본 그림: 화면이 있으면 liv, 없으면 term
//   B3 새 값 비었음: 앱 id 가 비었거나 표의 열쇠가 아닌 이름(constructor)이어도 기본 그림이다(던지지 않는다)
//   F1 사이드바 glyph() · 외부 앱 연결 icon() · icon(): 표에 없는 이름이면 「앱」 그림을 그린다(d 가 빈 path 를 그리지 않는다)
//   F2 표에 있는 이름은 그 그림을 그린다(예비 그림이 제 그림을 덮지 않는다)
//   L1 표지 카드의 빈 글: 칸이 세 칸 격자(30px)여도 빈 글은 한 줄 폭을 다 쓴다(모든 폭). 글에 긴 줄표가 없다
//   L2 「AI 주입 설정」의 커스텀 훅 줄: 띄어쓰기 없는 긴 글도 칸 안에서 줄을 바꾼다(390 에서 가로로 넘치지 않는다)
//   S1 획: --ic-stroke 가 1.7 이고, 아이콘 클래스(.v2-ic · .v2-rail-ic · .pn-i · .v2-mtab-ic · .v2-ptl-ic · .v2-dock-ic · .v2-gi-glyph)가 그 토큰을 읽는다
//   S2 획: 아이콘 클래스에 1.8 · 1.7 을 숫자로 적은 자리가 없다(그래프 선 · 상태 고리 둘은 아이콘이 아니라 뺀다)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${detail ? " : " + detail : ""}`); } };

const tsFiles = (dir) => {
  const out = [];
  for (const n of readdirSync(join(root, dir))) {
    const rel = dir + "/" + n, st = statSync(join(root, rel));
    if (st.isDirectory()) { if (n !== "standalone") out.push(...tsFiles(rel)); }
    else if (n.endsWith(".ts") && !n.endsWith(".test.ts")) out.push(rel);
  }
  return out;
};
const transpile = (src) => ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const load = async (js) => import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

// ── 표를 값으로 읽는다. 없으면(고치기 전) 옛 자리(web/v2/icons.ts)의 표를 읽어 같은 단언을 돌린다 ──
const PATHS_SRC = read("web/lib/icon-paths.ts");
let ICONS = {};
{
  const src = PATHS_SRC || read("web/v2/icons.ts");
  const a = src.indexOf("export const ICONS"), b = src.indexOf("\n};", a);
  if (a >= 0 && b > a) ICONS = new Function("return " + src.slice(src.indexOf("= {", a) + 2, b + 2))();
}
ok(!!PATHS_SRC && Object.keys(ICONS).length > 60, "G0 그림 표가 잎 모듈(web/lib/icon-paths.ts)에 있다");
ok(!!PATHS_SRC && !/^import /m.test(PATHS_SRC), "G0 그 모듈은 아무것도 물지 않는다(import 0)");

// ── V. 값 ──
const dot = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
const RING = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z";
const PICKED = {
  home: "M3 11 12 4l9 7 M5 10v10h14V10",
  wiki: "M12 7 4 5v13l8 2 8-2V5z M12 7v13",
  src: "M6 3h8l5 5v13H6z M14 3v5h5",
  tags: "M2.5 5h6.5l8 8-6 6-8.5-8.5z M6.5 9h.01 M13 5l8 8-5.5 5.5",
  ctx: "M3 5h5l4 7h9 M3 12h9 M3 19h5l4-7 M18 9l3 3-3 3",
  sess: "M3 4h12v9H8l-5 4z M18 8h3v13l-4-3H9v-2",
  dashboard: "M4 4h7v9H4z M13 4h7v5h-7z M13 11h7v9h-7z M4 15h7v5H4z",
  learn: RING + " M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1 1-1.1 1.8 M12 17h.01",
  apps: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z",
  panel: "M4 4h16v16H4z M9 4v16",
  bell: "M6 17v-7a6 6 0 0 1 12 0v7 M4 17h16 M10 20.5h4",
  archive: "M3 4h18v4H3z M5 8v12h14V8 M10 12h4",
  trash: "M4 7h16 M6 7l1 13h10l1-13 M9 7V4h6v3 M10 11v6 M14 11v6",
  link: "M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5 M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5",
  term: "M3 4h18v16H3z M7 9l3 3-3 3 M12.5 15h4.5",
  list: "M8 6h13 M8 12h13 M8 18h13 M3.5 6h.01 M3.5 12h.01 M3.5 18h.01",
  sessfiles: "M3 5h6l2 2.5h10V19H3z M9.5 11l2 2-2 2 M13.5 15h3",
  task: "M3.5 7 5 8.5 8 5.5 M11 7h9 M3.5 16 5 17.5 8 14.5 M11 16h9",
  timeline: "M7 3v1.5 M7 7.5v3 M7 13.5v3 M7 19.5V21 " + [6, 12, 18].map((y) => dot(7, y, 1.5)).join(" ") + " M11.5 6h8.5 M11.5 12h6 M11.5 18h8.5",
  preview: "M3 4h18v16H3z M10 9l5 3-5 3z",
};
for (const [k, d] of Object.entries(PICKED)) ok(ICONS[k] === d, `V1 고른 그림 ${k}`, String(ICONS[k]).slice(0, 40));
const KEPT = {
  chat: "M7.9 20A9 9 0 1 0 4 16.1L2 22z",
  proj: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z M8 10v4 M12 10v2 M16 10v6",
  liv: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  layers: "M12 2 2.6 6.6a.7.7 0 0 0 0 1.26L12 12.4l9.4-4.54a.7.7 0 0 0 0-1.26z M2.5 16.5 12 21l9.5-4.5 M2.5 12 12 16.5 21.5 12",
  spark: "M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z M18.5 16v4 M16.5 18h4",
  pen: "M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  web: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z",
  eye: "M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z M12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z",
};
for (const [k, d] of Object.entries(KEPT)) ok(ICONS[k] === d, `V2 「지금」을 고른 그림 ${k} 는 그대로`, String(ICONS[k]).slice(0, 40));
ok(/^M12 17v5 M9 10\.76/.test(ICONS.pin || "") && /^M12\.22 2h-\.44/.test(ICONS.gear || ""), "V2 압정 · 톱니는 종전 그림");
ok(!!ICONS.sys && ICONS.sys === ICONS.gear, "V5 설정(sys)과 톱니(gear)는 같은 그림");

// ── 부르는 이름 ──
const files = tsFiles("web");
const srcOf = Object.fromEntries(files.map((f) => [f, read(f)]));
const KIT = srcOf["web/v2/panes-kit.ts"] || "", PARTS = srcOf["web/v2/panes-parts.ts"] || "";
// pnIcon 이 이름을 잇는 법을 그 파일에서 읽는다(없으면 이름 그대로)
const pnMap = (() => { const m = KIT.match(/const PN_NAME[^=]*=\s*(\{[\s\S]*?\n\});/); try { return m ? new Function("return " + m[1])() : {}; } catch { return {}; } })();
const pnName = (n) => pnMap[n] || n;
// 고치기 전에는 pnIcon 이 제 표(ICON_PATHS)를 읽는다. 그 표의 이름도 «닿는 이름»으로 친다.
const oldPn = (() => { const a = KIT.indexOf("const ICON_PATHS"); if (a < 0) return null; const b = KIT.indexOf("\n};", a); try { return new Function("return " + KIT.slice(KIT.indexOf("= {", a) + 2, b + 2))(); } catch { return null; } })();
const pnHas = (n) => (oldPn ? n in oldPn : pnName(n) in ICONS);

/** 호출 `fn('이름'` 의 첫 인자가 글자일 때 그 이름. 삼항(`a ? 'x' : 'y'`)이면 양쪽 다. */
const namesCalled = (src, fns) => {
  const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const lits = (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? [n.text]
    : ts.isConditionalExpression(n) ? [...lits(n.whenTrue), ...lits(n.whenFalse)]
    : ts.isParenthesizedExpression(n) ? lits(n.expression) : []);
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && fns.includes(n.expression.text) && n.arguments.length) out.push(...lits(n.arguments[0]));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
};
/** 이 파일이 v2/icons.js 의 icon 을 어떤 이름으로 들였나(icon · lineIcon …). 안 들였으면 빈 배열. */
const iconAliases = (src) => {
  const m = src.match(/import \{([^}]*)\} from '(?:\.\/|\.\.\/v2\/|\.\/v2\/)icons\.js'/);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim()).filter((s) => /^icon\b/.test(s)).map((s) => (s.includes(" as ") ? s.split(" as ")[1].trim() : "icon"));
};
const miss1 = [];
for (const [f, src] of Object.entries(srcOf)) {
  const al = iconAliases(src); if (!al.length) continue;
  for (const n of namesCalled(src, al)) if (!(n in ICONS)) miss1.push(`${f}: ${n}`);
}
ok(miss1.length === 0, "G1 icon('이름') 으로 부르는 이름이 전부 표에 있다", miss1.join(" | "));
const miss2 = [];
for (const [f, src] of Object.entries(srcOf)) {
  if (!/\bpnIcon\b/.test(src) || f === "web/v2/panes-kit.ts" && false) continue;
  for (const n of namesCalled(src, ["pnIcon"])) if (!pnHas(n)) miss2.push(`${f}: ${n}`);
}
ok(miss2.length === 0, "G2 pnIcon('이름') 으로 부르는 이름이 전부 표에 닿는다", miss2.join(" | "));

const partIcons = [...PARTS.matchAll(/\{ type: '([a-z]+)', name: '([^']+)', icon: '([a-z-]+)'/g)].map((m) => ({ type: m[1], name: m[2], icon: m[3] }));
ok(partIcons.length >= 12 && partIcons.every((p) => pnHas(p.icon)), "G3 우측 사이드바 부품의 icon 이 전부 표에 닿는다", partIcons.filter((p) => !pnHas(p.icon)).map((p) => p.name + "=" + p.icon).join(" | "));
const WANT = { sessions: "chat", files: "folder", sessfiles: "sessfiles", knowledge: "wiki", tasks: "task", timeline: "timeline", liv: "liv", archive: "archive", web: "web", preview: "preview", editor: "eye", apps: "apps" };
for (const [type, want] of Object.entries(WANT)) {
  const p = partIcons.find((x) => x.type === type);
  ok(!!p && pnName(p.icon) === want && !oldPn, `V3 우측 사이드바 ${type} 의 그림 = ${want}`, p ? p.icon : "없음");
}
const partPath = (type) => { const p = partIcons.find((x) => x.type === type); return p ? (oldPn ? oldPn[p.icon] : ICONS[pnName(p.icon)]) : ""; };
ok(!!partPath("files") && partPath("files") !== partPath("sessfiles"), "V4 자료와 세션 파일은 다른 그림");
ok(!!partPath("web") && partPath("web") !== partPath("preview"), "V4 웹과 미리보기는 다른 그림");

const APPS_SRC = srcOf["web/v2/apps.ts"] || "", GLASS_SRC = srcOf["web/v2/glass-icon.ts"] || "";
const appIcons = [...new Set([...APPS_SRC.matchAll(/\bicon: '([a-z]+)'/g)].map((m) => m[1]))];
const appIconMap = (APPS_SRC.match(/const ICON_PATHS[^=]*=\s*\{([\s\S]*?)\n\};/) || [, ""])[1];
const glassNames = (() => { const m = GLASS_SRC.match(/APP_ICON_NAMES\s*=\s*\[([^\]]*)\]/); return m ? [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]) : []; })();
ok(appIcons.length >= 10 && appIcons.every((n) => new RegExp("\\b" + n + ":\\s*ICONS\\.").test(appIconMap)), "G4 앱 표의 icon 이 전부 appIcon 의 표에 있다", appIcons.filter((n) => !new RegExp("\\b" + n + ":\\s*ICONS\\.").test(appIconMap)).join(","));
ok(appIcons.every((n) => glassNames.includes(n)), "G4 앱 표의 icon 이 전부 앱 아이콘 이름에 있다", appIcons.filter((n) => !glassNames.includes(n)).join(","));
const appIconRefs = [...appIconMap.matchAll(/ICONS\.([A-Za-z]+)/g)].map((m) => m[1]);
ok(appIconRefs.length >= 10 && appIconRefs.every((n) => n in ICONS), "G4 appIcon 의 표가 가리키는 이름이 전부 그림 표에 있다", appIconRefs.filter((n) => !(n in ICONS)).join(","));
{
  // 레일 · 구역 메뉴는 앱의 icon 을 그대로 부르지 않는다. 그대로 부르면 「홈(클래식)」이 「홈」과 같은 집 그림이 된다.
  const RAIL = srcOf["web/v2/rail.ts"] || "";
  ok(!/\b(item|row)\(a\.key, a\.title, a\.icon\b/.test(RAIL) && (RAIL.match(/appGlyphName\(a\.icon\)/g) || []).length >= 2, "G4 레일 · 구역 메뉴의 앱 줄이 앱 화면과 같은 그림 이름을 쓴다(홈(클래식) = dashboard)");
  const m = PATHS_SRC.match(/const APP_GLYPH[^=]*=\s*(\{[^}]*\})/); let g = {}; try { g = m ? new Function("return " + m[1])() : {}; } catch { /* 빨간불 */ }
  ok(g.home === "dashboard" && g.sys === "gear" && ICONS.home !== ICONS.dashboard, "P2 앱 이름 → 그림 이름: home = dashboard · sys = gear, 나머지는 같은 이름");
}

// 우클릭 메뉴 줄: { label: '…', icon: '이름' … } (ctx-menu.ts 가 lineIcon 으로 그린다)
const miss5 = [];
for (const [f, src] of Object.entries(srcOf)) {
  if (!f.startsWith("web/v2/") && !/ctxMenu|showCtxMenu/.test(src)) continue;
  for (const m of src.matchAll(/\{\s*label: [^{}\n]*?\bicon: '([A-Za-z-]+)'/g)) if (!(m[1] in ICONS)) miss5.push(`${f}: ${m[1]}`);
}
ok(miss5.length === 0, "G5 우클릭 메뉴 줄의 icon 이 전부 표에 있다", [...new Set(miss5)].join(" | "));

const SIDE = srcOf["web/v2/side.ts"] || "", CONNECT = srcOf["web/v2/connect.ts"] || "";
{
  ok(/footLink\('#\/app\/sessions', 'sess',/.test(SIDE), "G6 사이드바 「세션 이력」 줄이 세션 이력 앱과 같은 그림(sess)을 쓴다");
}
ok(!/const ICON_PATHS\b/.test(KIT) && /from '\.\.\/lib\/icon-paths\.js'/.test(KIT), "G6 우측 사이드바(panes-kit)에 제 그림 표가 없고 한 벌을 읽는다");
ok(!/const ICON_PATH\b/.test(CONNECT) && /from '\.\.\/lib\/icon-paths\.js'/.test(CONNECT), "G6 외부 앱 연결(connect)에 제 그림 표가 없고 한 벌을 읽는다");
{
  const a = SIDE.indexOf("function glyph("), g = a >= 0 ? SIDE.slice(a, SIDE.indexOf("\n}\n", a)) : "";
  ok(!!g && !/\bD\[kind\]|const D:/.test(g) && /iconPath\(kind\)/.test(g), "G6 사이드바 glyph() 에 제 표가 없다(표에 없는 이름은 F1 이 본다)");
}

// ── H. 손으로 그린 사본 ──
{
  const fn = (src, name) => { const i = src.indexOf("function " + name + "("); return i < 0 ? "" : src.slice(i, src.indexOf("\n}\n", i)); };
  const C = srcOf["web/context.ts"] || "", LEARN = srcOf["web/learn.ts"] || "";
  const hd = fn(C, "ctxAppIcon");
  ok(/d: ICONS\.ctx\b/.test(hd), "H1 「수집 · 증류」 화면 머리: 표의 ctx");
  ok(!!hd && !/stroke-width/.test(hd) && /\.ctx-crumb-ic \{[^}]*stroke-width: var\(--ic-stroke\)/.test(read("public/styles/31-context-pipeline.css").replace(/\/\*[\s\S]*?\*\//g, "")), "H1 그 머리의 획은 숫자로 적지 않고 토큰을 읽는다");
  ok(/tabIcon\('help', 'pjv-crumb-ic lg-crumb-ic'\)/.test(LEARN) && /\bhelp: \[\['path', \{ d: ICONS\.learn \}\]\]/.test(LEARN), "H1 「사용 가이드」 화면 머리: 표의 learn");
  const OMNI = srcOf["web/v2/omni.ts"] || "", kp = OMNI.slice(OMNI.indexOf("const KIND_PATH"), OMNI.indexOf("};", OMNI.indexOf("const KIND_PATH")));
  const want = { proj: "folder", know: "wiki", src: "src", sess: "chat", hist: "sess" };
  for (const [k, n] of Object.entries(want)) ok(new RegExp("\\b" + k + ": \\[ICONS\\." + n + "\\]").test(kp), `H2 통합검색 ${k} = 표의 ${n}`);
  ok(/key: 'notify', label: '알림', icon: \[ICONS\.bell\]/.test(srcOf["web/v2/me-modal.ts"] || ""), "H3 [나] 창 「알림」 = 표의 bell");
  ok(/PJV_TM_ICONS\.bell = \{ p: \[\['path', \{ d: ICONS\.bell \}\]\] \}/.test(srcOf["web/taskmodal/composer.ts"] || ""), "H3 태스크 창 활동 구독 = 표의 bell");
  ok(((srcOf["web/v2/side.ts"] || "").match(/sv\('path', \{ d: ICONS\.trash \}\)/g) || []).length >= 2, "H4 사이드바의 휴지통 단추 둘 = 표의 trash");
  // 「정리」 절은 그 창이 있는 가지에만 있다. 있으면 표의 그림이어야 한다.
  { const SC = srcOf["web/session-chat.ts"] || ""; ok(!/key: 'tidy'/.test(SC) || /key: 'tidy', label: '정리', icon: \[ICONS\.trash\]/.test(SC), "H4 세션 설정 창 「정리」가 있으면 표의 trash"); }
  ok(((srcOf["web/projects/icons.ts"] || "").match(/d: ICONS\.trash\b/g) || []).length >= 2 && /d: ICONS\.trash\b/.test(srcOf["web/projects/selection.ts"] || "") && /d: ICONS\.trash\b/.test(srcOf["web/dash/icons.ts"] || ""), "H4 프로젝트(셋) · 대시보드의 휴지통 = 표의 trash");
  ok(/d: ICONS\.ctx\b/.test(fn(srcOf["web/distillers.ts"] || "", "allSourcesIcon")) && !/funnelIcon/.test(srcOf["web/distillers.ts"] || ""), "H5 증류기 카드의 「모든 자료」 그림 = 표의 ctx");
  ok(/d: ICONS\.sess\b/.test(fn(srcOf["web/terminal/routes.ts"] || "", "tsessHistoryIcon")), "H5 클래식 AI 세션의 「세션 기록」 단추 = 표의 sess");
  ok(/'book-open': \[\['path', \{ d: ICONS\.wiki \}\]\]/.test(LEARN), "H5 가이드의 책 = 표의 wiki");
  {
    // 가이드가 부르는 이름은 전부 제 표에 있고, 아무도 안 부르는 집(home)은 표에 없다
    const gi = LEARN.slice(LEARN.indexOf("const GUIDE_ICONS"), LEARN.indexOf("\n};", LEARN.indexOf("const GUIDE_ICONS")));
    const keys = [...gi.matchAll(/^  '?([a-z0-9-]+)'?: \[/gm)].map((m) => m[1]);
    const called = [...namesCalled(LEARN, ["tabIcon", "flowStep"])];
    ok(called.length >= 6 && called.every((n) => keys.includes(n)), "H5 가이드가 부르는 아이콘 이름이 전부 제 표에 있다", called.filter((n) => !keys.includes(n)).join(","));
    ok(!keys.includes("home"), "H5 아무도 부르지 않는 집(home)은 가이드 표에 없다");
  }
  // 옛 그림의 조각. 그림 표 밖에 남아 있으면 그 자리는 옛 그림을 그린다.
  const OLD = {
    "집": [/M15 21v-8a1/, /M3\.5 11\.2 12 4\.5/, /M4 11l8-7 8 7/, /M3 9l9-7 9 7v11/],
    "깔때기": [/l-6\.2 7\.2V18/, /M22 3H2l8 9\.46/],
    "상자": [/M3 6h18v4H3z/, /M3 3h18a1 1 0 0 1 1 1v3a1 1/],
    "휴지통": [/M9 7V4h6v3/, /M6 7l1 13h10l1-13/, /M19 6v14a2 2 0 0 1-2 2H7/, /M6\.4 6\.6l\.83 12\.5/, /M6 7l1 12a2 2 0 0 0 2 2h6/, /M6\.5 7l1 12\.5h9l1-12\.5/],
    "가로 고리": [/M9 17H7A5 5 0 0 1 7 7h2/, /M10\.5 13\.5a4 4 0 0 0 5\.7 0/],
    "종": [/M6 8a6 6 0 0 1 12 0c0 7/, /M18 8a6 6 0 0 0-12 0c0 7/, /M12 4\.2a5 5 0 0 0-5 5v3\.1/],
    "책": [/M12 7v14 M3 18a1 1/, /M2 3h6a4 4 0 0 1 4 4v14/, /M4 5a2 2 0 0 1 2-2h12v16H6/],
    "태그 묶음": [/M9\.586 5\.586A2 2/],
  };
  const left = [];
  for (const [f, src] of Object.entries(srcOf)) {
    if (f === "web/lib/icon-paths.ts") continue;
    for (const [name, pats] of Object.entries(OLD)) if (pats.some((re) => re.test(src))) left.push(`${name} ${f}`);
  }
  ok(left.length === 0, "H6 손으로 그린 옛 그림이 web/ 에 남아 있지 않다", left.join(" | "));
}

// ── P. 앱 아이콘을 값으로 부른다 ──
const fakeDoc = () => {
  const mk = (tag) => ({ tag, attrs: {}, kids: [], innerHTML: "", setAttribute(k, v) { this.attrs[k] = String(v); }, append(...k) { this.kids.push(...k); } });
  return { createElementNS: (_ns, tag) => mk(tag) };
};
globalThis.document = fakeDoc();
let glass = null;
if (GLASS_SRC && PATHS_SRC) {
  const paths = await load(transpile(PATHS_SRC)).catch(() => null);
  if (paths) {
    globalThis.__ICONS = paths.ICONS;
    globalThis.__appGlyphName = paths.appGlyphName; globalThis.__iconPath = paths.iconPath;
    const js = transpile(GLASS_SRC).replace(/import \{[^}]*\} from '[^']*icon-paths\.js';/, "const ICONS = globalThis.__ICONS, appGlyphName = globalThis.__appGlyphName, iconPath = globalThis.__iconPath;");
    glass = await load(js).catch(() => null);
  }
} else if (GLASS_SRC) {
  glass = await load(transpile(GLASS_SRC)).catch(() => null);
}
ok(!!glass && typeof glass.appGlassIcon === "function" && typeof glass.appGlassMarkup === "function", "P0 앱 아이콘 모듈이 값으로 읽힌다(appGlassIcon · appGlassMarkup)");
const markup = (n) => { try { return glass && glass.appGlassMarkup ? glass.appGlassMarkup(n) : ""; } catch { return "!throw"; } };
const GLYPH_OF = { home: "dashboard", sys: "gear" };
// ── B. 설치한 앱의 그림 ──
{
  const f = glass && glass.builtinAppIcon;
  const call = (id, ui) => { try { return f ? f(id, ui) : "!none"; } catch { return "!throw"; } };
  ok(call("inbox", false) === "bell" && call("inbox", true) === "bell", "B1 확인할 것(inbox) = bell", call("inbox", false));
  ok(call("browser", false) === "web", "B1 웹 브라우저(browser) = web", call("browser", false));
  ok(call("hello", true) === "liv" && call("some-third-party", false) === "term", "B2 그 밖의 앱은 기본 그림(화면이 있으면 liv, 없으면 term)", call("hello", true) + "," + call("some-third-party", false));
  for (const bad of ["", "constructor", "__proto__", "toString"]) ok(call(bad, false) === "term" && call(bad, true) === "liv", `B3 앱 id ${JSON.stringify(bad)} 는 기본 그림`, call(bad, false));
  ok(/appGlassIcon\(builtinAppIcon\(a\.id, hasUi\)\)/.test(srcOf["web/v2/apps.ts"] || "") && !/const BUILTIN_ICON\b/.test(srcOf["web/v2/apps.ts"] || ""), "B1 앱 화면이 그 함수로 그림을 고른다(apps.ts 에 제 표가 없다)");
}
// ── F. 표에 없는 이름 ──
{
  const fakeSv = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids });
  //  그리는 함수들은 표의 iconPath 로 그림을 찾는다. 그 함수를 표 모듈에서 값으로 받아 넣어 준다(없으면 옛 코드다).
  const pathsMod = PATHS_SRC ? await load(transpile(PATHS_SRC)).catch(() => null) : null;
  const iconPathFn = pathsMod && pathsMod.iconPath;
  ok(typeof iconPathFn === "function" && iconPathFn("wiki") === ICONS.wiki && iconPathFn("nope") === ICONS.apps && iconPathFn("constructor") === ICONS.apps && iconPathFn("nope", "pn-doc") === ICONS["pn-doc"], "F0 표의 iconPath: 있는 이름은 그 그림, 없는 이름은 예비 그림");
  const dOf = (n) => (n && n.kids && n.kids[0] && n.kids[0].attrs ? n.kids[0].attrs.d : undefined);
  const evalFn = (src, from, to, name) => {
    const i = src.indexOf(from); if (i < 0) return null;
    const j = src.indexOf(to, i); if (j < 0) return null;
    try { return new Function("sv", "ICONS", "iconPath", transpile(src.slice(i, j + to.length)) + "\nreturn " + name + ";")(fakeSv, ICONS, iconPathFn); } catch { return null; }
  };
  const cases = [
    ["사이드바 glyph()", evalFn(srcOf["web/v2/side.ts"] || "", "function glyph(", "\n}\n", "glyph"), "archive", ICONS.archive],
    ["외부 앱 연결 icon()", evalFn(srcOf["web/v2/connect.ts"] || "", "const icon = (k: string): SVGElement =>", ";\n", "icon"), "key", ICONS["cn-key"]],
    ["icon()", evalFn((srcOf["web/v2/icons.ts"] || "").replace("export function icon(", "function icon("), "function icon(", "\n}\n", "icon"), "wiki", ICONS.wiki],
  ];
  for (const [label, fn, known, want] of cases) {
    ok(typeof fn === "function", `F0 ${label} 를 값으로 부를 수 있다`);
    if (typeof fn !== "function") continue;
    for (const bad of ["nope", "", "constructor"]) { let d = "!throw"; try { d = dOf(fn(bad, "c")); } catch { /* 빨간불 */ } ok(!!ICONS.apps && d === ICONS.apps, `F1 ${label}: 표에 없는 이름 ${JSON.stringify(bad)} 는 「앱」 그림`, String(d).slice(0, 30)); }
    ok(dOf(fn(known, "c")) === want, `F2 ${label}: 표에 있는 이름(${known})은 그 그림`);
  }
}
// ── L. 넘침 · 줄 바꿈(글과 CSS 규칙으로 본다. 실제 줄 수 · 넘침 폭은 브라우저로 따로 쟀다) ──
{
  const noC = (f) => read("public/styles/" + f).replace(/\/\*[\s\S]*?\*\//g, "");
  const top = (css) => { let d = 0, out = ""; for (const ch of css) { if (ch === "{") d++; if (d <= 1) out += ch; if (ch === "}") d--; } return out; };   // @media 안은 뺀다
  const CTX = noC("31-context-pipeline.css");
  ok(/\.cxm-svts:has\(\.cxm-empty\) \{[^}]*display: flex/.test(top(CTX).replace(/@media[^{]*\{[^}]*\}/g, "")), "L1 빈 글이 든 칸은 격자가 아니라 한 줄 폭을 다 쓴다(모든 폭)");
  const MAP = srcOf["web/context-map.ts"] || "";
  const empties = [...MAP.matchAll(/class: 'cxm-empty', text: '([^']*)'/g)].map((m) => m[1]);
  ok(empties.length >= 3 && empties.every((t) => !t.includes("\u2014")), "L1 표지 카드의 빈 글에 긴 줄표가 없다", empties.filter((t) => t.includes("\u2014")).join(" | "));
  const BOARD = noC("16-projects-board.css");
  ok(/\.inj-custom-row \.mini-meta \{[^}]*min-width: 0[^}]*overflow-wrap: anywhere/.test(BOARD), "L2 커스텀 훅 줄의 설명 글이 칸 안에서 줄을 바꾼다");
}
// ── T. 시험 도구 ──
{
  const T = read("scripts/ctx-rename.test.mjs");
  const defs = [...T.matchAll(/^function (walk\w*)\(/gm)].map((m) => m[1]);
  ok(defs.length === 1, "T1 ctx-rename 시험의 파일 훑기 도구가 하나다", defs.join(","));
}
const NAMES = ["home", "term", "chat", "proj", "wiki", "src", "tags", "ctx", "sess", "sys", "web", "learn", "liv", "apps", "bell"];
for (const n of NAMES) {
  const mk = markup(n), d = ICONS[GLYPH_OF[n] || n];
  ok(!!d && mk.includes(`d="${d}"`) && mk.includes(`var(--gi-c-${n})`) && (mk.match(/class="v2-gi-tile"/g) || []).length === 1, `P1 · P2 앱 아이콘 ${n}: 타일 하나 + 그 선 그림 + 그 색 토큰`);
}
for (const bad of ["nope", "", "constructor", "__proto__"]) {
  const mk = markup(bad);
  ok(mk !== "!throw" && !!ICONS.apps && mk.includes(`d="${ICONS.apps}"`) && mk.includes("var(--gi-c-apps)"), `P3 모르는 이름(${JSON.stringify(bad)})은 apps 로 떨어진다`);
}
for (const bad of ["nope", "", "constructor"]) {
  let d = "!throw";
  try { d = glass && glass.appGlyphPath ? glass.appGlyphPath(bad) : ""; } catch { /* 던지면 빨간불 */ }
  ok(!!ICONS.apps && d === ICONS.apps, `P3 선 그림만 물어도(${JSON.stringify(bad)}) apps 의 그림이 온다`, String(d).slice(0, 30));
}
{
  let el = null, threw = false;
  try { el = glass ? glass.appGlassIcon("chat", "x-cls") : null; } catch { threw = true; }
  ok(!threw && !!el && el.attrs.viewBox === "0 0 64 64" && /\bv2-gi\b/.test(el.attrs.class) && /\bx-cls\b/.test(el.attrs.class) && el.attrs["aria-hidden"] === "true", "P1 appGlassIcon: 64 뷰박스 · 클래스 v2-gi 와 받은 클래스 · aria-hidden");
  const mk = markup("chat"), r = mk.match(/<rect class="v2-gi-tile"[^>]*width="([\d.]+)"[^>]*rx="([\d.]+)"/);
  const ratio = r ? Number(r[2]) / Number(r[1]) : 0;
  ok(ratio >= 0.25 && ratio <= 0.27, "P4 타일 모서리 반지름이 한 변의 26%", String(ratio));
  ok(!!GLASS_SRC && !/GLASS_ART|linearGradient|feGaussianBlur/.test(GLASS_SRC), "P4 유리 겹침 그림의 흔적이 없다");
}

// ── P5 · P6. 색 토큰과 대비 ──
const BASE = read("public/styles/01-base.css"), DARK = read("public/styles/90-dark.css");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const decls = (css) => { const m = new Map(); for (const x of strip(css).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) m.set(x[1], x[2].trim()); return m; };
const blockAt = (css, from) => { const i = css.indexOf("{", css.indexOf(from)); let d = 0; for (let j = i; j < css.length; j++) { if (css[j] === "{") d++; else if (css[j] === "}" && --d === 0) return css.slice(i + 1, j); } return ""; };
const L = decls(blockAt(BASE, ":root"));
const D1 = decls(blockAt(DARK, ':root[data-theme="dark"]')), D2 = decls(blockAt(DARK, ':root:not([data-theme="light"])'));
const need = NAMES.map((n) => "--gi-c-" + n).concat(["--gi-tile", "--gi-tile-line"]);
ok(need.every((k) => L.has(k)), "P5 색 토큰이 라이트에 전부 있다", need.filter((k) => !L.has(k)).join(","));
ok(need.every((k) => D1.has(k) && D2.has(k) && D1.get(k) === D2.get(k)), "P5 색 토큰이 다크 두 블록에 같은 값으로 있다", need.filter((k) => !D1.has(k) || !D2.has(k)).join(","));
{
  const V2 = strip(read("public/styles/40-v2.css"));
  ok(/\n\.v2-gi-tile \{[^}]*fill: var\(--bg-tint\)[^}]*stroke: var\(--line-net\)[^}]*vector-effect: non-scaling-stroke/.test(V2), "P5 종이 위의 타일: 옅은 바탕색 · 가는 테두리(크기와 상관없이 1px)");
  ok(/\n\.v2-pad \.v2-gi-tile \{[^}]*fill: var\(--gi-tile\)[^}]*stroke: var\(--gi-tile-line\)/.test(V2), "P5 앱 화면의 타일: 반투명 타일 토큰");
}

const hex = (h) => { const m = /^#([0-9a-f]{6})$/i.exec(h || ""); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
const rgba = (v) => { const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v || ""); return m ? { c: [+m[1], +m[2], +m[3]], a: m[4] == null ? 1 : +m[4] } : null; };
const over = (top, a, bot) => top.map((t, i) => t * a + bot[i] * (1 - a));
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** 타일의 색 둘. 앱 화면: 흐린 앱 화면에 잉크 28% 를 덮은 바탕(.v2-pad) 위의 반투명 타일(--gi-tile). 종이: 옅은 바탕색(--bg-tint) 타일. */
const check = (T, label, paper, ink) => {
  const tile = rgba(T.get("--gi-tile")), tint = hex(T.get("--bg-tint"));
  const bad = [];
  if (!tile || !tint) return [label + ": --gi-tile · --bg-tint 을 못 읽음"];
  for (const [gname, bg] of Object.entries({ "앱 화면": over(tile.c, tile.a, over(ink, 0.28, paper)), "종이": tint })) {
    for (const n of NAMES) { const c = hex(T.get("--gi-c-" + n)); if (!c) { bad.push(`${label} ${n}: 색을 못 읽음`); continue; } const r = ratio(c, bg); if (r < 3) bad.push(`${label} ${gname} ${n} ${r.toFixed(2)}`); }
  }
  return bad;
};
{
  const bad = check(L, "라이트", [255, 255, 255], [21, 35, 59]);
  ok(bad.length === 0, "P6 라이트: 색 선이 타일 위에서 3:1 이상", bad.join(" | "));
  const badD = check(D1, "다크", [11, 16, 27], [234, 240, 250]);
  ok(badD.length === 0, "P6 다크: 색 선이 타일 위에서 3:1 이상", badD.join(" | "));
  // 다크에서 뒤 화면이 밝을 때(문서 미리보기가 비칠 때)에도 3:1 이다. 타일이 충분히 짙어야 한다.
  {
    const tile = rgba(D1.get("--gi-tile")), bg = tile ? over(tile.c, tile.a, over([234, 240, 250], 0.28, [255, 255, 255])) : null;
    const low = bg ? NAMES.filter((n) => { const c = hex(D1.get("--gi-c-" + n)); return !c || ratio(c, bg) < 3; }) : ["타일"];
    ok(low.length === 0, "P6 다크: 뒤 화면이 흰색이어도 3:1 이상", low.join(","));
  }
  // 경계: 3:1 에 못 미치는 색을 넣으면 이 검사가 잡는다(검사 자신이 도는지 본다)
  const probe = new Map(L); probe.set("--gi-c-src", "#E08A1E");
  ok(check(probe, "라이트", [255, 255, 255], [21, 35, 59]).some((s) => s.includes(" src ")), "P6 경계: 밝은 호박색(#E08A1E)은 3:1 에 못 미쳐 걸린다");
}

// ── S. 획 ──
ok(/--ic-stroke:\s*1\.7\s*;/.test(strip(BASE)), "S1 --ic-stroke 가 1.7");
const css = (f) => strip(read("public/styles/" + f));
const rule = (sheet, sel) => { const m = new RegExp("(?:^|\\n)\\s*" + sel.replace(/[.#\[\]]/g, "\\$&") + " \\{[^}]*\\}").exec(sheet); return m ? m[0] : ""; };
const CLS = [["40-v2.css", "#v2-root .v2-ic"], ["47-v2-rail.css", ".v2-rail-ic"], ["42-v2-panes.css", ".pn-i"], ["50-mobile.css", ".v2-mtab-ic"], ["47-v2-rail.css", ".v2-ptl-ic"], ["40-v2.css", ".v2-dock-ic"], ["40-v2.css", ".v2-gi-glyph"], ["49-v2-ctx.css", ".pn-ctx-svg"]];
for (const [f, sel] of CLS) ok(/stroke-width:\s*var\(--ic-stroke\)/.test(rule(css(f), sel)), `S1 ${sel} 가 --ic-stroke 를 읽는다`);
// 종(알림)은 그 화면이 있는 가지에만 있다. 있으면 같은 토큰을 읽어야 한다.
{ const r = rule(css("40-v2.css"), ".v2-bell-ic"); ok(!r || /stroke-width:\s*var\(--ic-stroke\)/.test(r), "S1 .v2-bell-ic 가 있으면 --ic-stroke 를 읽는다"); }
{
  const left = [];
  for (const f of readdirSync(join(root, "public/styles")).filter((n) => /^(3[167]|4[0-9]|50)-.*\.css$/.test(n))) {
    for (const ln of css(f).split("\n")) {
      if (!/stroke-width:\s*1\.[78]\s*[;}]/.test(ln) || /data:image/.test(ln)) continue;
      if (/\.cxr-tl \.t-x path|pjv-status-ic/.test(ln)) continue;   // 그래프 표식 · 상태 고리: 아이콘이 아니다
      left.push(f + ": " + ln.trim().slice(0, 50));
    }
  }
  ok(left.length === 0, "S2 아이콘 클래스에 1.8 · 1.7 을 숫자로 적은 자리가 없다", left.slice(0, 6).join(" | ") + (left.length > 6 ? ` 외 ${left.length - 6}` : ""));
}

console.log(`\n#4233 아이콘 표 · 앱 아이콘 · 획: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
