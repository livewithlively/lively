// 곁칸 지식 읽기의 위키 링크 · 주소 도우미(web/lib/kn-links.ts) — #4443 원준(2026-10-05)
//  «곁칸에 있는 지식은 … 오른쪽에서 칸 튀어나오듯이 나오는데 이렇게 하지말고 그냥 곁칸에서 마크다운 이쁘게»
//  읽기 화면 자체(그 칸 안에서 열기 · 이어 읽기 · 뒤로)는 pane-shell-runtime.test.mjs 장면 K 가 실제 크롬에서 본다.
//
// 사양(엣지 표 — 행마다 단언 하나 이상):
//  KL1 [[이름]] → [이름](#/k/이름) · KL2 [[이름|라벨]] → [라벨](#/k/이름) · 한 줄에 여럿
//  KL3 코드 안(인라인 `…` · ``` 울타리 · ~~~ 울타리)의 [[…]] 는 그대로 — 울타리가 닫힌 뒤 줄은 다시 바꾼다
//  KL4 빈 본문 · null · [[ 가 없는 본문 — 던지지 않고 그대로(같은 문자열)
//  KL5 이름이 빈 [[ ]] · 닫히지 않은 [[a · 대괄호가 낀 [[a|x]y]] — 그대로
//  KL6 이름의 ( ) 는 %28 %29 — renderMarkdown 링크 파서가 첫 ')' 에서 주소를 끊지 않게 · 앞뒤 공백은 턴다
//  KL7 knHref ↔ knNameOfHref 왕복(한글 · 공백 · 괄호) · ?· # 꼬리는 버린다 · 지식 주소가 아니거나 % 가 깨졌으면 null
//  KL8 plainMd — **굵게** · `코드` 표식만 뗀다 · __ 는 그대로(mcp__lively__tool · __init__) · 짝 없는 표식 그대로 · 빈 값
//  KL9 dropTitleH1 — 맨 앞 H1 이 제목(짧은 · 원)을 되풀이할 때만 뗀다 · 다른 말이면 둔다 · 한 줄뿐인 본문(경계) · CRLF ·
//      맨 앞이 아니거나 H2 면 그대로 · 빈 본문 · 제목 칸이 비어도 던지지 않는다
//  KL10 wikiLinkAt — 지식 화면 렌더러가 자리마다 쓰는 토큰 판정(아래 표) · resolveWikiTarget — 서버가 이어 둔 이름으로 풀기
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const SRC = process.env.KN_LINKS_SRC || path.join(root, "web/lib/kn-links.ts");
const out = mkdtempSync(path.join(tmpdir(), "kn-links-"));
execFileSync(path.join(root, "node_modules/.bin/tsc"),
  [SRC, "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" });
const L = await import(path.join(out, path.basename(SRC).replace(/\.ts$/, ".js")));

let pass = 0, fail = 0;
const J = (v) => JSON.stringify(v);
const eq = (got, want, n) => { if (J(got) === J(want)) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — 기대 ${J(want)} · 실제 ${J(got)}`); } };
const W = (s) => L.wikiLinksToMd(s);

eq(W("앞 [[kn-a]] 뒤"), "앞 [kn-a](#/k/kn-a) 뒤", "KL1 [[이름]] → 지식 주소 링크(라벨 = 이름)");
eq(W("[[kn-a|문서 A]]와 [[kn-b]]"), "[문서 A](#/k/kn-a)와 [kn-b](#/k/kn-b)", "KL2 [[이름|라벨]] → 라벨 · 한 줄에 여럿");
eq(W("글 `[[kn-x]]` 와 [[kn-a]]"), "글 `[[kn-x]]` 와 [kn-a](#/k/kn-a)", "KL3a 인라인 코드 안은 그대로 — 바깥은 바꾼다");
eq(W("```\n[[kn-y]]\n```\n[[kn-a]]"), "```\n[[kn-y]]\n```\n[kn-a](#/k/kn-a)", "KL3b ``` 울타리 안은 그대로 — 닫힌 뒤 줄은 바꾼다");
eq(W("~~~md\n[[kn-y]]\n```\n[[kn-z]]\n~~~\n[[kn-a]]"), "~~~md\n[[kn-y]]\n```\n[[kn-z]]\n~~~\n[kn-a](#/k/kn-a)", "KL3c ~~~ 울타리는 ~~~ 로만 닫힌다(안의 ``` 는 글자)");
const plain = "평범한 글 [링크](https://x.y)";
eq([W(""), W(null), W(undefined), W(plain) === plain], ["", "", "", true], "KL4 빈 본문 · null · [[ 없는 본문 — 그대로");
eq([W("[[ ]]"), W("열림 [[kn-a"), W("[[a|x]y]]")], ["[[ ]]", "열림 [[kn-a", "[[a|x]y]]"], "KL5 빈 이름 · 안 닫힘 · 대괄호 낀 것은 그대로");
eq(W("[[ 회의 (10월) | 라벨 ]]"), "[라벨](#/k/%ED%9A%8C%EC%9D%98%20%2810%EC%9B%94%29)", "KL6 이름의 괄호는 %28 %29 · 앞뒤 공백은 턴다");
const names = ["kn-a", "회의 메모 (10월)", "a/b?c"];
eq(names.map((n) => L.knNameOfHref(L.knHref(n))), names, "KL7a knHref ↔ knNameOfHref 왕복(한글 · 공백 · 괄호 · / ?)");
eq([L.knNameOfHref("#/k/kn-a?x=1"), L.knNameOfHref("#/k/kn-a#sec"), L.knNameOfHref("#/p/7"), L.knNameOfHref("https://x.y"), L.knNameOfHref("#/k/%E0%A4%A"), L.knNameOfHref(""), L.knNameOfHref(null)],
  ["kn-a", "kn-a", null, null, null, null, null], "KL7b ?·# 꼬리는 버린다 · 지식 주소가 아니거나 % 가 깨졌으면 null");

const P = (x) => L.plainMd(x);
eq([P("이름 **굵게** · `코드`"), P("mcp__lively__tool 호출 규칙"), P("`__init__` 정리"), P("짝 없는 ** 별"), P(""), P(null)],
  ["이름 굵게 · 코드", "mcp__lively__tool 호출 규칙", "__init__ 정리", "짝 없는 ** 별", "", ""], "KL8 plainMd — ** · ` 표식만 · __ 는 그대로 · 짝 없는 표식 그대로 · 빈 값");
const D = (md, t) => L.dropTitleH1(md, t);
eq([D("# 문서 A\n\n본문", ["as-built: 문서 A — 설명", "문서 A"]), D("# **굵은** 제목\n본문", ["굵은 제목"]), D("# 문서 A #\n\n본문", ["문서 A"])],
  ["본문", "본문", "본문"], "KL9a 맨 앞 H1 이 제목(짧은 · 원 · 강조 표식 뗀 것)과 같으면 뗀다 · 닫는 # 도");
eq(D("# 개요 설명\n\n본문", ["제목 하나", "제목 하나"]), "# 개요 설명\n\n본문", "KL9b 제목과 다른 H1 은 둔다(긴 설명이 본문 첫 헤딩일 수 있다)");
eq([D("# 문서 A", ["문서 A"]), D("# 문서 A\r\n\r\n본문", ["문서 A"])], ["", "본문"], "KL9c 한 줄뿐인 본문(경계) · CRLF");
eq([D("본문\n# 문서 A", ["문서 A"]), D("## 문서 A\n본문", ["문서 A"]), D("", ["x"]), D("# 문서 A\n본문", [null, undefined, ""])],
  ["본문\n# 문서 A", "## 문서 A\n본문", "", "# 문서 A\n본문"], "KL9d 맨 앞이 아니거나 H2 면 그대로 · 빈 본문 · 제목 칸이 비어도 던지지 않는다");

// KL10 — [입력, 자리, 기대 토큰(null = 링크 아님), 이름]
const AT = [
  ["[[engineering-onboarding-guide]] 뒤", 0, { raw: "[[engineering-onboarding-guide]]", target: "engineering-onboarding-guide", label: "engineering-onboarding-guide" }, "하이픈 이름"],
  ["앞 [[회의 메모 (10월)|10월 회의]]", 2, { raw: "[[회의 메모 (10월)|10월 회의]]", target: "회의 메모 (10월)", label: "10월 회의" }, "한글 이름 · | 라벨"],
  ["[[ kn-a | 라벨 ]]", 0, { raw: "[[ kn-a | 라벨 ]]", target: "kn-a", label: "라벨" }, "앞뒤 공백은 턴다"],
  ["[[kn-a|]]", 0, { raw: "[[kn-a|]]", target: "kn-a", label: "kn-a" }, "빈 라벨은 이름(서버도 링크로 센다)"],
  ["[[doc#헤딩]]", 0, { raw: "[[doc#헤딩]]", target: "doc#헤딩", label: "doc#헤딩" }, "헤딩 링크는 target 에 # 를 남긴다(풀기에서 뗀다)"],
  ["[[a]][[b]]", 5, { raw: "[[b]]", target: "b", label: "b" }, "붙어 있는 두 번째"],
  ["[[a]]", 1, null, "[[ 자리가 아니다"],
  ["[[ ]]", 0, null, "빈 이름"],
  ["[[kn-a", 0, null, "안 닫힘"],
  ["[[a|x]y]]", 0, null, "라벨에 대괄호"],
  ["[[a `b` c]]", 0, null, "인라인 코드를 가로지르면 서버도 엣지로 안 센다"],
  ["[[a\nb]]", 0, null, "줄을 넘기면 아니다"],
];
for (const [src, i, want, n] of AT) eq(L.wikiLinkAt(src, i), want, `KL10a wikiLinkAt — ${n}`);
const known = new Set(["kn-a", "회의-메모-10월", "long-name-cut"]);
const R = [
  ["kn-a", known, { name: "kn-a", missing: false }, "그대로 이어져 있다"],
  ["회의 메모 (10월)", known, { name: "회의-메모-10월", missing: false }, "제목처럼 적은 것은 slug 로 푼다"],
  ["long-name-cut-", known, { name: "long-name-cut", missing: false }, "꼬리 '-' 를 뗀 slug"],
  ["kn-a#절", known, { name: "kn-a", missing: false }, "헤딩은 떼고 문서로"],
  ["no-such", known, { name: "no-such", missing: true }, "못 풀면 적힌 이름 그대로 · 없음"],
  ["no-such", null, { name: "no-such", missing: false }, "known 이 없으면 판정하지 않는다"],
  ["#절만", known, null, "문서 이름이 빈 헤딩 링크는 링크가 아니다"],
];
for (const [t, k, want, n] of R) eq(L.resolveWikiTarget(t, k), want, `KL10b resolveWikiTarget — ${n}`);

console.log(fail ? `\n${fail}건 실패 · ${pass}건 통과` : `\n${pass}건 통과`);
process.exit(fail ? 1 : 0);
