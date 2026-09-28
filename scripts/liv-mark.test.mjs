// #4135 코멘트 4 · 리브 표시 1안 — «리브가 세팅한 것» 표시(원준 2026-09-28 «1안으로 구현하자»).
//
//  S — 요약의 셈과 문구(web/lib/liv-mark.ts)를 값으로.  W — 화면이 공통 부품을 실제로 지나는지 소스로.
//  사양의 입력 조합 표(S1 ~ S11) 한 줄마다 단언이 하나 이상 있다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
//  주석은 빼고 본다 — 머리말에 적힌 낱말이 단언을 통과시키면 그 시험은 아무것도 안 잡는다.
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/\s.*$/, "")).join("\n");
const css = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name}${JSON.stringify(got) === JSON.stringify(want) ? "" : ` — got ${JSON.stringify(got)}`}`);

// ───────────────────────── S. 셈과 문구 ─────────────────────────
let lib = null;
try { lib = await import(pathToFileURL(join(root, "public/app/lib/liv-mark.js")).href); } catch { /* 없으면 S0 이 빨간불 */ }
ok(!!lib, "S0 잎 모듈(lib/liv-mark.ts)이 있다");
if (lib) {
  const { LIV_MARK_TEXT, livSummary, livSummaryParts, livSummaryText, countLiv } = lib;
  const text = (t, l) => livSummaryText(livSummary(t, l));
  eq(LIV_MARK_TEXT, "리브가 세팅", "S 이름표의 글자");

  eq(text(4, 3), "4개 중 3개를 리브가 세팅했어요", "S1 일부");
  eq(livSummaryParts(livSummary(4, 3)), { pre: "4개 중 ", strong: "3개", post: "를 리브가 세팅했어요" }, "S1 굵게 서는 것은 리브 수");
  eq(text(8, 8), "8개 모두 리브가 세팅했어요", "S2 전부 — «8개 중 8개»라고 하지 않는다");
  eq([livSummary(5, 0).kind, text(5, 0), livSummaryParts(livSummary(5, 0))], ["none", "", null], "S3 리브 것이 없으면 요약 없음");
  eq([livSummary(0, 0).kind, text(0, 0)], ["none", ""], "S4 목록이 비면 요약 없음");
  eq([livSummary(1, 1).kind, text(1, 1)], ["one", "1개를 리브가 세팅했어요"], "S5 하나뿐이면 «모두»라고 하지 않는다");
  eq([livSummary(2, 1).kind, text(2, 1)], ["some", "2개 중 1개를 리브가 세팅했어요"], "S6 경계 — 최소 일부");
  eq([livSummary(2, 2).kind, text(2, 2)], ["all", "2개 모두 리브가 세팅했어요"], "S7 경계 — «모두»가 되는 최소");
  eq([livSummary(3, 5).liv, text(3, 5)], [3, "3개 모두 리브가 세팅했어요"], "S8 리브 수가 전체보다 크면 전체로 본다");
  eq([text(NaN, 3), text(4, NaN), text(-4, 3), text(4, -1), text(null, null), text(undefined, 2)], ["", "", "", "", "", ""], "S9 셀 수 없는 값은 0");
  eq([text(4.9, 3.9), text("4", "3")], ["4개 중 3개를 리브가 세팅했어요", "4개 중 3개를 리브가 세팅했어요"], "S9 소수는 내림 · 숫자 글자는 수로");

  const isLiv = (x) => x.liv === true;
  eq([countLiv(null, isLiv), countLiv(undefined, isLiv), countLiv([], isLiv)], [0, 0, 0], "S10 목록이 없거나 비면 0");
  eq(countLiv([{ liv: true }, { liv: false }, { liv: true }, {}], isLiv), 2, "S10 리브 것만 센다");
  eq(countLiv([{ liv: true }, null, { liv: true }], (x) => x.liv === true), 2, "S11 판정이 던지는 항목은 세지 않고 나머지는 센다");
}

// ───────────────────────── W. 배선 (소스) ─────────────────────────
const PART = code(read("web/liv-mark.ts")), COL = code(read("web/context-collectors.ts")), DIS = code(read("web/distillers.ts"));
ok(PART.length > 800 && COL.length > 5000 && DIS.length > 5000, "W0 소스를 실제로 읽었다");
ok(/export function livMark\(/.test(PART) && /export function madeBy\(/.test(PART) && /export function livSum\(/.test(PART), "W1 공통 부품이 이름표 · 누가 만들었나 · 머리 요약을 낸다");
ok(/livSummary\(total, liv\)/.test(PART) && /LIV_MARK_TEXT/.test(PART), "W1 부품의 글자와 셈은 잎 모듈에서 온다");
ok(!/리브가 만듦/.test(COL + DIS) && !/cxc-liv/.test(COL + DIS), "W2 화면 파일이 제 배지를 따로 그리지 않는다");
ok(/madeBy\(liv, /.test(COL) && (DIS.match(/madeBy\(liv, /g) || []).length === 2, "W3 수집기 행 · 증류기 카드 · 꺼 둔 증류기 행이 같은 부품을 부른다");
ok(/\(liv \? ' ' \+ LIV_ROW : ''\)/.test(COL) && /\(liv \? ' ' \+ LIV_CARD : ''\)/.test(DIS) && /\(liv \? ' ' \+ LIV_ROW : ''\)/.test(DIS), "W4 리브 것인 행 · 카드에만 리브 바탕이 붙는다");
ok(/livSum\(collectors\.length, countLiv\(collectors, isLivMade\)\)/.test(COL), "W5 수집기 머리 요약은 제목 옆 개수와 같은 목록에서 센다");
ok(/livSum\(distillers\.length \+ lanes\.length, countLiv\(distillers, isLivMadeDistiller\)\)/.test(DIS), "W5 증류기 머리 요약은 두 종류를 합친 수에서 센다");

const C03 = css(read("public/styles/03-components.css")), C31 = css(read("public/styles/31-context-pipeline.css"));
const BASE = css(read("public/styles/01-base.css")), DARK = css(read("public/styles/90-dark.css"));
ok(/\.liv-row \{[^}]*--liv-bg:[^}]*inset 4px 0 0 var\(--mint\)/.test(C03) && /\.liv-card \{[^}]*--liv-bg:[^}]*inset 4px 0 0 var\(--mint\)/.test(C03), "W6 행 · 카드 = 바탕 + 왼쪽 띠");
ok(/\.liv-mark \{[^}]*background: var\(--liv-fill\)[^}]*color: var\(--on-fill\)/.test(C03), "W6 이름표 = 채운 초록 위 흰 글자");
ok(/\.cxc-row\.liv-row:hover[^{]*\{[^}]*background: var\(--liv-bg\)/.test(C31) && /\.cxc-row\.liv-row\.is-editing[^{]*\{[^}]*background: var\(--liv-bg\)/.test(C31), "W7 올리거나 편집 중이어도 리브 바탕이 남는다");
ok(C31.indexOf(".cxc-row.liv-row:hover") > C31.indexOf(".cxc-row:hover {"), "W7 그 규칙이 행의 hover 규칙 뒤에 선다(같은 무게라 뒤가 이긴다)");
ok(!/\.cxc-liv\b/.test(C31), "W8 종전 배지의 스타일이 남아 있지 않다");
const tokens = ["--liv-tint", "--liv-tint-2", "--liv-sum-bg", "--liv-sum-ink"];
ok(tokens.every((t) => new RegExp(t + ":\\s*#").test(BASE)) && /--liv-fill:\s*#/.test(BASE), "W9 색은 토큰이다");
ok(tokens.every((t) => (DARK.match(new RegExp(t + ":", "g")) || []).length === 2), "W9 어두운 테마에도 값이 있다(두 블록 모두)");

console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
