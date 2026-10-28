// #5011 — 앱 찾기의 「+ 새 앱」 칸은 파란색을 쓰지 않는다(원준 2026-10-26 «새 앱 호버하면 파란색으로 색칠되면서 … 파란색 전부다 안 이뻐 · 점선도 파란색»).
//  다른 앱 아이콘과 같은 유리 타일 토큰(--gi-tile · --gi-tile-line)과 잉크 색만 쓰고, 점선 · 흰 글자 채우기를 걷었다.
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
let pass = 0, fail = 0;
const check = (cond, n) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n}`); } };
const css = readFileSync(path.join(root, "public/styles/40-v2.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = css.split("}").filter((r) => /v2-pad-(ico|item)--new/.test(r.split("{")[0]));

check(rules.length >= 4, "N1 「새 앱」 칸 규칙이 있다");
check(rules.every((r) => !/--blue|#fff\b|dashed/.test(r)), "N2 ★★ 「새 앱」 칸 규칙에 파란색 · 흰 글자 채우기 · 점선이 없다");
check(rules.some((r) => /var\(--gi-tile\)/.test(r) && /var\(--gi-tile-line\)/.test(r)), "N3 ★ 다른 앱 아이콘과 같은 유리 타일 토큰을 쓴다");
check(rules.some((r) => /prefers-reduced-motion/.test(css) && /rotate\(90deg\)/.test(r)), "N4 호버에 ＋ 가 돈다(움직임 줄이기 설정이면 멈춘다)");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
