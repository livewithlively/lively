// 앱빌더 ④ 「다른 색」 팔레트의 색 계산(web/lib/icon-color.ts, #4632 원준 2026-10-28 «다른 색을 훨씬 더 다양하게 · 연속적 컬러팔레트»).
//  컴파일된 모듈(public/app/lib/icon-color.js)을 돌린다 — 빌드가 없으면 건너뛰고 그 사실을 적는다(CI 의 run-tests --build 가 돈다).
//  이게 틀리면: 팔레트에서 고른 색과 저장되는 색이 다르거나, 어두운 화면에서 아이콘이 안 보이거나, 틀린 색 코드가 마무리 저장을 400 으로 막는다.
//
// 엣지 표:
//  N1 #abc → #AABBCC · N2 # 없이 · 앞뒤 공백 · 소문자 · N3 네 자리 · 일곱 자리 · 16진 밖 · 빈 글 → null
//  H1 색상 띠 0 · 120 · 240 의 가장 진한 색 · H2 검정 · 흰색 · H3 360 = 0 · 음수는 감는다 · H4 채도 · 밝기가 0~1 밖이면 끝에 붙인다
//  R1 색 코드 → 자리 → 색 코드가 그대로 돈다 · R2 회색은 채도 0 · R3 틀린 코드 → null
//  C1 대비 — 검정 · 흰색 21 · 같은 색 1
//  D1 어두운 화면 짝은 어두운 타일 위 대비 4 이상(9색 · 아주 어두운 색) · D2 짝은 원래보다 밝다 · D3 아주 밝은 색 · 틀린 코드도 색 코드를 낸다
//  L1 흐림 판정 = 밝은 타일 위 대비 3 미만(회색 띠 전체로 경계 확인) · L2 9색은 흐리지 않다 · L3 틀린 코드는 흐림이 아니다
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = process.env.ICON_COLOR_JS || join(root, "public/app/lib/icon-color.js");
if (!existsSync(mod)) { console.log("icon-color: 빌드 없음(public/app/lib/icon-color.js) — 건너뜀"); process.exit(0); }
const C = await import(mod);
const SF = existsSync(join(root, "public/app/lib/studio-flow.js")) ? await import(join(root, "public/app/lib/studio-flow.js")) : null;
let pass = 0, fail = 0;
const check = (ok, what, extra) => { if (ok) pass++; else { fail++; console.log("FAIL ", what, extra == null ? "" : JSON.stringify(extra)); } };
const N = C.normHex || (() => "없음"), H = C.hsvToHex || (() => "없음"), V = C.hexToHsv || (() => "없음"), K = C.contrast || (() => 0), D = C.darkPair || (() => "없음"), L = C.tooLight || (() => "없음");

check(N("#abc") === "#AABBCC", "N1 세 자리를 펼친다", N("#abc"));
check(N("a1b2c3") === "#A1B2C3" && N("  #a1b2c3 ") === "#A1B2C3", "N2 # 없이 · 앞뒤 공백 · 소문자", [N("a1b2c3"), N("  #a1b2c3 ")]);
check([N("#abcd"), N("#1234567"), N("#ggg000"), N(""), N(null)].every((x) => x === null), "N3 틀린 꼴은 null");

check(H({ h: 0, s: 1, v: 1 }) === "#FF0000" && H({ h: 120, s: 1, v: 1 }) === "#00FF00" && H({ h: 240, s: 1, v: 1 }) === "#0000FF", "H1 색상 띠의 진한 색", [H({ h: 0, s: 1, v: 1 }), H({ h: 120, s: 1, v: 1 })]);
check(H({ h: 77, s: 0.4, v: 0 }) === "#000000" && H({ h: 200, s: 0, v: 1 }) === "#FFFFFF", "H2 검정 · 흰색");
check(H({ h: 360, s: 1, v: 1 }) === "#FF0000" && H({ h: -120, s: 1, v: 1 }) === "#0000FF", "H3 360 = 0 · 음수는 감는다", [H({ h: 360, s: 1, v: 1 }), H({ h: -120, s: 1, v: 1 })]);
check(H({ h: 0, s: 2, v: 1.5 }) === "#FF0000" && H({ h: 0, s: -1, v: -1 }) === "#000000", "H4 0~1 밖은 끝에 붙인다");

const ROUND = ["#3A7BD5", "#118E6E", "#B0323F", "#D6457A", "#576889", "#0D88A7", "#FFFFFF", "#000000", "#7F7F7F", "#FF8800"];
const bad = ROUND.filter((x) => { const v = V(x); return !v || H(v) !== x; });
check(bad.length === 0, "R1 색 코드 → 자리 → 색 코드가 그대로", bad);
check(V("#808080") && V("#808080").s === 0, "R2 회색은 채도 0", V("#808080"));
check(V("zz") === null, "R3 틀린 코드 → null");

check(Math.abs(K("#000000", "#FFFFFF") - 21) < 0.01 && Math.abs(K("#3A7BD5", "#3A7BD5") - 1) < 1e-9, "C1 대비 21 · 1", K("#000000", "#FFFFFF"));

const NINE = SF && Array.isArray(SF.ICON_COLORS) ? SF.ICON_COLORS.map((c) => c.color) : ["#118E6E", "#2D6BF0", "#8A3FD1"];
const darks = [...NINE, "#000000", "#101020", "#3A1010", "#7F7F7F"];
const weak = darks.filter((x) => K(D(x), C.DARK_TILE) < 4);
check(weak.length === 0, "D1 어두운 화면 짝은 어두운 타일 위 대비 4 이상", weak.map((x) => [x, D(x), K(D(x), C.DARK_TILE).toFixed(2)]));
const lum = (x) => K(x, "#000000");
const notBrighter = darks.filter((x) => !(lum(D(x)) > lum(x)));
check(notBrighter.length === 0, "D2 짝은 원래 색보다 밝다", notBrighter);
check(/^#[0-9A-F]{6}$/.test(D("#FFFFFF")) && /^#[0-9A-F]{6}$/.test(D("zz")), "D3 아주 밝은 색 · 틀린 코드도 색 코드를 낸다(마무리 저장이 막히지 않게)", [D("#FFFFFF"), D("zz")]);

const grays = Array.from({ length: 256 }, (_, i) => "#" + i.toString(16).padStart(2, "0").repeat(3).toUpperCase());
const miss = grays.filter((g) => L(g) !== (K(g, C.LIGHT_TILE) < 3));
const edge = grays.findIndex((g) => L(g));
check(miss.length === 0 && edge > 0 && L(grays[edge]) && !L(grays[edge - 1]), "L1 흐림 판정 = 밝은 타일 위 대비 3 미만(경계 앞뒤)", { miss: miss.slice(0, 3), edge: grays[edge] });
check(NINE.every((x) => L(x) === false), "L2 9색은 흐리지 않다", NINE.filter((x) => L(x)));
check(L("zz") === false && L("#FFF8E0") === true, "L3 틀린 코드는 흐림 아님 · 연한 크림색은 흐림");

console.log(`icon-color: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
