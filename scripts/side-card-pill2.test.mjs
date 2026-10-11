// #3870 · 세션 카드 처음 크기 줄이기 · 최소화는 언제나 최소 폭 · 비친 뒤 곁칸을 한 번 더 누르면 최소화 (원준 2026-10-11)
//  «곁칸 늘려서 팝업으로 뜰 때 사이즈가 너무 크게 뜨는 거 같음» · «투명해진 다음에 한 번 더 누르면 최소화되는 걸로» ·
//  «최소화될 때 가로 사이즈 유지하지 말고 가로 사이즈도 최소로 줄여 버려. 최소화하는 모든 과정에 적용»
//
//  사양 · 엣지 표(spec-failfirst) — 셈과 배선은 여기서, 누름 · 최소화 흐름은 side-card-pill2-runtime.test.mjs(실제 크롬)가 본다.
//   N1 창 900 → 320 × 243 · N1b 경계 815 → 220 · 600 → 220 · 1111 → 300 · 1400 → 300
//   N1c 옛 기억(card3)은 «바꾼 크기» 를 버리고 «옮긴 자리» · 세션 쪽만 잇는다 · N1d 새 기억(card4)이 있으면 그것만
//   N2~N5 · N8 · N9 최소화는 언제나 알약 폭(PILL_W = 260)에서 — 단추 · 되살림 · Home 모두, 알약을 넓혀도 카드 크기는 그대로
//   N6 비친 카드에서 곁칸 누름 → 최소화 · 누르는 순간의 상태로 판정 · 6px 넘게 끌면 누름 아님
//   N7 곁칸 안 액자로 초점이 들어가는 것은 최소화가 아니다(앱이 스스로 옮긴 초점과 구별 못 한다)
//   N10 알약 폭이 창보다 넓으면 창 안으로 줄인다
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${detail ? " : " + detail : ""}`); } };
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const load = async (src) => import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64")}`);
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) return ""; const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };

const lib = await load(read("web/lib/side-card-geom.ts"));
const { defaultCardSize, rectFromAnchor, PILL_W, CARD_MIN } = lib;
const s900 = defaultCardSize(900);
ok(s900.w === 320 && s900.h === 243, "N1 창 900 → 320 × 243", JSON.stringify(s900));
const hs = [815, 600, 1111, 1400].map((v) => defaultCardSize(v).h);
ok(JSON.stringify(hs) === JSON.stringify([220, 220, 300, 300]), "N1b 경계: 815 → 220(0.27 × 815 = 220.05) · 600 → 220 · 1111 → 300(299.97) · 1400 → 300", JSON.stringify(hs));
ok(PILL_W === 260 && PILL_W === (CARD_MIN && CARD_MIN.w), "N2a 알약 폭 = 카드의 가장 작은 폭(260)", String(PILL_W));
const narrow = typeof rectFromAnchor === "function" ? rectFromAnchor(260, 243, { corner: "bl", dx: 24, dy: 24 }, 200, 600, 44) : null;
ok(!!narrow && narrow.w <= 200 - 16 && narrow.r >= 8, "N10 알약 폭이 창보다 넓으면(창 200) 창 안으로 줄인다", JSON.stringify(narrow));

const card = code(read("web/v2/side-card.ts"));
ok(/const KEY_CARD = 'lively_v2_side_card4';/.test(card) && /const KEY_CARD_OLD = 'lively_v2_side_card3';/.test(card), "N1c·N1d 새 기억 키(card4) · 옛 키(card3)");
const pr = between(card, "const prefs = (", "let size:");
ok(/const cur = localStorage\.getItem\(KEY_CARD\);/.test(pr) && /if \(cur !== null\) return parsePrefs\(cur\);/.test(pr)
  && /return \{ \.\.\.parsePrefs\(localStorage\.getItem\(KEY_CARD_OLD\)\), sized: false, w: 0, h: 0 \};/.test(pr),
  "N1c·N1d 새 기억이 있으면 그것만 · 없으면 옛 기억에서 «바꾼 크기» 를 버리고 자리 · 세션 쪽만", pr.slice(0, 300));
ok(/let pillW: number = PILL_W;/.test(card), "N2b 알약 폭은 가장 작은 폭에서 시작한다(적지 않는다)");
const cr = between(card, "function currentRect(", "function placeAfterResize(");
ok(/const w = fold \? pillW : s\.w;/.test(cr) && /return rectFromAnchor\(w, s\.h, a, vw\(\), vh\(\), fh\);/.test(cr), "N2c 알약은 알약 폭으로 그린다(높이 · 자리는 카드 것)", cr);
const sf = between(card, "function setFold(", "let pillTimer");
ok(/if \(v\) pillW = PILL_W;/.test(sf) && sf.indexOf("pillW = PILL_W") < sf.indexOf("fold = v"), "N2d 최소화할 때마다 가장 작은 폭으로(단추 · 곁칸 누름 모두 setFold)", sf);
const rs = between(card, "function restore(", "function settleSoon(");
ok(/pillW = PILL_W;/.test(rs), "N5 되살린 알약(새로고침 · 세션 전환)도 가장 작은 폭");
const ds = between(card, "function dragStart(", "const headOf =");
ok(/if \(fold\) pillW = c\.w; else size = \{ w: c\.w, h: c\.h \};/.test(ds), "N4 알약을 넓히면 알약 폭만 — 카드 크기는 그대로");
const kd = between(card, "keyGrip.addEventListener('keydown'", "const onHeadDbl");
ok(/if \(fold\) pillW = next\.w; else size = \{ w: next\.w, h: next\.h \};/.test(kd), "N8 알약 상태 글쇠 화살표도 알약 폭만");
ok(/size = null; anchor = null; pillW = PILL_W;/.test(kd), "N9 Home 은 알약 폭도 처음으로");
const dn = between(card, "const seeThrough =", "document.addEventListener('pointerdown', onDownCap, true);");
ok(/const seeThrough = \(\): boolean => shown\(\) && !picked && !entering && !fold;/.test(dn), "N6a «비친 상태» = 보임 · 고르지 않음 · 막 떠오르는 중 아님 · 펼침", dn.slice(0, 200));
ok(/was: seeThrough\(\)/.test(dn) && dn.indexOf("was: seeThrough()") < dn.indexOf("pickFrom(t)"), "N6b 비친 상태는 누르는 순간(고름을 바꾸기 전)에 잰다 — 또렷할 때 누르면 비치기만");
ok(/if \(Math\.hypot\(e\.clientX - d\.x, e\.clientY - d\.y\) > SIDE_PRESS_PX\) return;/.test(dn) && /const SIDE_PRESS_PX = 6;/.test(card), "N6d·N6f 6px 넘게 끌고 놓으면 누름이 아니다(정확히 6px 은 누름)");
ok(/if \(d\.was && shown\(\) && !fold\) setFold\(true\);/.test(dn), "N6 · N6e 비친 카드였으면 최소화 · 이미 알약이면 그대로");
ok(/document\.addEventListener\('pointerup', onUpCap, true\);/.test(card) && /document\.removeEventListener\('pointerup', onUpCap, true\);/.test(card)
  && /document\.removeEventListener\('pointercancel', onCancelCap, true\);/.test(card), "N6g 놓기 · 취소를 듣고, 걷을 때 뗀다");
const blur = between(card, "const onWinBlur", "document.addEventListener('pointerdown'");
ok(!/setFold/.test(blur), "N7 곁칸 안 액자로 초점이 들어가는 것(창 blur)은 최소화하지 않는다", blur.slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
