// #4233 — [위키] 본문 목록을 셸이 직접 그린다(원준 2026-09-26 «A를 뼈대로 · C의 「새로 들어온 지식」 카드 줄만»,
//  «2안 사이드 피크를 기본으로, 덧창 머리의 [우측 사이드바에 고정]으로 3안으로 · 곁칸이라는 말은 사용자에게 보이지 않게»).
//
//  V — 잣대(web/lib/wiki-list.ts)를 값으로: 주소 → 범위, 묶기 다섯, 카드, 「이번 주」, 덧창 본문, 고정 손님.
//  S — 셸(main.ts)과 화면(wiki-main.ts)이 그 잣대를 실제로 지나는지 소스로: 목록 주소 가로채기, 행 = 덧창(이동 없음),
//      키(Esc · ↑ ↓), 고정 = 오른쪽 칸 손님 + 덧창 닫기, 화면을 옮겨도 손님이 남기, «곁칸» 이 화면 글에 없기.
//  ⚠ 단언을 하나씩 끝까지 센다(첫 실패에서 멈추지 않는다) — 수정 전 코드(origin/main)에서 V · S 전부 빨간불인 것을 확인했다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
//  주석은 빼고 본다 — 머리말에 적힌 낱말이 단언을 통과시키면 그 시험은 아무것도 안 잡는다.
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/\s.*$/, "")).join("\n");
/** 함수 하나만 잘라 본다 — 시작을 못 찾으면 빈 문자열(그 단언이 빨간불이 된다). */
const cut = (src, from, to) => { const a = src.indexOf(from); if (a < 0) return ""; const b = to ? src.indexOf(to, a + 1) : -1; return src.slice(a, b > a ? b : undefined); };
/** 문자열 리터럴만 — 화면에 나가는 글은 전부 여기 있다. */
const strings = (src) => [...code(src).matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name}${JSON.stringify(got) === JSON.stringify(want) ? "" : ` — got ${JSON.stringify(got)}`}`);

// ───────────────────────── V. 잣대 (web/lib/wiki-list.ts) ─────────────────────────
let lib = null;
try { lib = await import(pathToFileURL(join(root, "public/app/lib/wiki-list.js")).href); } catch { /* 없으면 아래 V0 가 빨간불 */ }
ok(!!lib, "V0 잣대가 잎 모듈(lib/wiki-list.ts)에 있다");
if (lib) {
  const { wikiScopeOf, groupWikiDocs, pickNewDocs, weekNewCount, peekBody, pinGuest, visibleDocs, WIKI_GROUP_BYS, WIKI_TYPE_LABEL, wikiDayLabel } = lib;
  const DAY = 86_400_000;
  const NOW = new Date(2026, 8, 26, 12, 0, 0).getTime();   // 토요일 낮 — 「오늘」 경계가 자정이다
  const iso = (ms) => new Date(ms).toISOString();
  const D = (name, o = {}) => ({ name, title: name.toUpperCase(), type: "decision", category_key: "a", category_name: "가", updated_by: "me1",
    created_at: iso(NOW - 60_000), updated_at: iso(NOW - 60_000), ...o });

  // R — 주소 → 범위
  eq(wikiScopeOf("#/knowledge"), { kind: "all", peek: "" }, "R1 #/knowledge = 전체 문서");
  eq(wikiScopeOf("#/app/knowledge"), { kind: "all", peek: "" }, "R1 #/app/knowledge(레일 착지) = 전체 문서");
  eq(wikiScopeOf("#/knowledge?all=1"), { kind: "all", peek: "" }, "R1 ?all=1 = 전체 문서");
  eq(wikiScopeOf("#/knowledge?indexed=1"), { kind: "index", peek: "" }, "R2 ?indexed=1 = 인덱스");
  eq(wikiScopeOf("#/knowledge?category=12"), { kind: "cat", cat: "12", peek: "" }, "R3 ?category=12");
  eq(wikiScopeOf("#/knowledge?category=none"), { kind: "cat", cat: "none", peek: "" }, "R3 ?category=none(분류 없음)");
  eq(wikiScopeOf("#/knowledge?category=ops"), { kind: "cat", cat: "ops", peek: "" }, "R3 ?category=<key>(옛 링크)");
  eq(wikiScopeOf("#/knowledge?category="), { kind: "all", peek: "" }, "R4 빈 category = 전체 문서");
  eq(wikiScopeOf("#/knowledge?category=12&peek=a%20b"), { kind: "cat", cat: "12", peek: "a b" }, "R5 peek 딥링크는 범위와 함께");
  for (const r of ["#/knowledge/new", "#/knowledge/review", "#/knowledge?cats=1", "#/knowledge?q=x", "#/knowledge?type=decision",
    "#/knowledge?category=1&folder=f", "#/k/x", "#/app/knowledge/k/x", "#/", "", null]) {
    eq(wikiScopeOf(r), null, `R6 ${JSON.stringify(r)} 는 클래식 그대로`);
  }

  // G — 묶기
  eq(WIKI_GROUP_BYS.map((b) => b.label), ["날짜", "분류", "유형", "사람", "묶지 않음"], "G0 드롭다운 칸 = 날짜 · 분류 · 유형 · 사람, 끝에 묶지 않음");
  const t0 = new Date(2026, 8, 26, 0, 0, 0).getTime();
  const g1 = groupWikiDocs([
    D("a", { updated_at: iso(NOW - 60_000) }),
    D("b", { updated_at: iso(t0 - 1000) }),                  // 어제 23:59:59
    D("c", { updated_at: iso(t0) }),                         // 오늘 00:00 정각
    D("d", { updated_at: iso(NOW - 3 * DAY) }),
  ], "day", NOW, "me1");
  eq(g1.map((g) => [g.label, g.rows.map((r) => r.name)]), [["오늘", ["a", "c"]], ["어제", ["b"]], ["9월 23일 (수)", ["d"]]], "G1 날짜: 오늘 → 어제 → 날짜(요일), 자정이 경계");
  eq(wikiDayLabel(new Date(2025, 0, 1, 9).getTime(), NOW), "2025년 1월 1일", "G2 다른 해는 연도까지");
  eq(wikiDayLabel(new Date(2026, 0, 1, 9).getTime(), NOW), "1월 1일 (목)", "G2 이 해는 월 · 일 (요일)");
  const g3 = groupWikiDocs([
    D("n", { category_key: null, category_name: null, updated_at: iso(NOW - 10_000) }),
    D("a", { category_key: "a", category_name: "가", updated_at: iso(NOW - DAY) }),
    D("b", { category_key: "b", category_name: "나", updated_at: iso(NOW - 60_000) }),
  ], "category", NOW, "me1");
  eq(g3.map((g) => [g.key, g.label]), [["b", "나"], ["a", "가"], ["", "분류 없음"]], "G3 분류: 최근 순, 분류 없음은 맨 끝");
  const g4 = groupWikiDocs([D("x", { type: null }), D("r", { type: "research" }), D("d", { type: "decision" }), D("w", { type: "weird" })], "type", NOW, "me1");
  eq(g4.map((g) => g.label), ["결정", "리서치", "weird", "유형 없음"], "G4 유형: 정한 순서 → 모르는 유형 → 유형 없음");
  const g5 = groupWikiDocs([
    D("m", { updated_by: "me1" }), D("p", { updated_by: "u2" }), D("q", { updated_by: "u3" }), D("r", { updated_by: "u3" }),
    D("s", { updated_by: "u2" }), D("z", { updated_by: null }),
  ], "person", NOW, "me1");
  eq(g5.map((g) => g.key), ["me1", "u2", "u3", ""], "G5 사람: 나 → 많은 순 → 같으면 id 순 → 모름");
  const mix = [D("a"), D("b", { type: "research", category_key: null, updated_by: "u2", updated_at: iso(NOW - 5 * DAY) }), D("c", { type: null, updated_at: "x" })];
  const set = (gs) => gs.flatMap((g) => g.rows.map((r) => r.name)).sort().join(",");
  eq(WIKI_GROUP_BYS.map((b) => set(groupWikiDocs(mix, b.key, NOW, "me1"))), WIKI_GROUP_BYS.map(() => "a,b,c"), "G6 묶기를 바꿔도 문서 집합은 같다");
  eq(groupWikiDocs([D("a"), D("b"), D("c")], "category", NOW, "me1")[0].rows.map((r) => r.name), ["a", "b", "c"], "G7 묶음 안은 입력 순서");
  eq(WIKI_GROUP_BYS.map((b) => groupWikiDocs([], b.key, NOW, "me1").length + groupWikiDocs(null, b.key, NOW, "me1").length), [0, 0, 0, 0, 0], "G8 문서 없음 = 묶음 없음");
  const g9 = groupWikiDocs([D("x", { updated_at: null }), D("a"), D("y", { updated_at: "x" })], "day", NOW, "me1");
  eq(g9.map((g) => [g.label, g.rows.map((r) => r.name)]), [["오늘", ["a"]], ["날짜 모름", ["x", "y"]]], "G9 못 읽는 날짜는 «날짜 모름» 한 묶음, 맨 끝");
  const gn = groupWikiDocs([D("a"), D("b")], "none", NOW, "me1");
  eq(gn.map((g) => [g.key, g.rows.length]), [["", 2]], "G10 묶지 않음 = 한 묶음");
  ok(WIKI_TYPE_LABEL["how-to"] === "How-to" && WIKI_TYPE_LABEL.research === "리서치", "G11 유형 이름은 클래식 위키와 같은 사전");

  // C — 「새로 들어온 지식」 카드
  const six = [0, 1, 2, 3, 4, 5].map((i) => D("k" + i, { created_at: iso(NOW - (i === 5 ? 0 : (i + 1)) * 3_600_000), updated_at: iso(NOW - i * 60_000) }));
  eq(pickNewDocs(six, 4).map((r) => r.name), ["k5", "k0", "k1", "k2"], "C1 만든 시각 최근 순 4장(고친 순서와 다르다)");
  eq(pickNewDocs([D("f", { is_folder: true, created_at: iso(NOW) }), D("h", { name: "category-home-ops", created_at: iso(NOW) }), D("t", { created_at: null }), D("a", { created_at: iso(NOW - DAY) })], 4).map((r) => r.name),
    ["a", "t"], "C2 폴더 · 대문 문서는 빼고, 만든 시각 없음은 맨 뒤");
  eq(pickNewDocs([], 4).length + pickNewDocs(null, 4).length, 0, "C3 문서 없음 = 카드 없음");
  eq(pickNewDocs(six.slice(0, 3), 4).length, 3, "C4 셋뿐이면 셋");
  eq(visibleDocs([D("a"), D("category-home-x"), null, D("b")]).map((r) => r.name), ["a", "b"], "C5 대문 문서는 목록에도 없다");

  // W — 「이번 주 +N」
  const d6 = new Date(2026, 8, 20, 0, 0, 0).getTime();       // 6일 전 00:00 — 셈
  const d7 = new Date(2026, 8, 19, 23, 59, 0).getTime();     // 7일 전 23:59 — 안 셈
  const wk = [D("a", { created_at: iso(d6), updated_at: iso(d6) }), D("b", { created_at: iso(d7), updated_at: iso(NOW - 10 * DAY) }), D("c")];
  eq(weekNewCount(wk, NOW, false), 2, "W1 경계: 6일 전 자정은 이번 주, 7일 전 23:59 는 아니다");
  eq(weekNewCount([D("a"), D("b", { updated_at: iso(NOW - 3 * DAY) })], NOW, true), null, "W2 불러온 창이 7일을 못 덮으면 숫자를 내지 않는다");
  eq(weekNewCount([D("a"), D("b", { updated_at: iso(NOW - 9 * DAY), created_at: iso(NOW - 9 * DAY) })], NOW, true), 1, "W3 창이 7일을 덮으면(더 있어도) 센다");

  // B — 덧창 본문
  eq(peekBody("", "T"), { md: "", empty: true }, "B1 본문 없음");
  eq(peekBody("  \n ", "T"), { md: "", empty: true }, "B1 공백만");
  eq(peekBody(null, "T"), { md: "", empty: true }, "B1 null");
  eq(peekBody("# 제목\n\n본문", "제목"), { md: "본문", empty: false }, "B2 제목과 같은 첫 H1 은 뺀다");
  eq(peekBody("# 다른 것\n본문", "제목"), { md: "# 다른 것\n본문", empty: false }, "B2 다른 H1 은 둔다");

  // P — 우측 사이드바에 고정(손님)
  eq(pinGuest("a b/한글", ""), { key: "kdoc:a b/한글", title: "a b/한글", hash: "k/" + encodeURIComponent("a b/한글"), label: "문서", sticky: true }, "P1 key · 주소 인코딩 · 제목 없으면 이름 · 고정 문서");
  eq(pinGuest("x", "제목").title, "제목", "P1 제목이 있으면 제목");
}

// ───────────────────────── S. 배선 (소스) ─────────────────────────
const mainSrc = code(read("web/v2/main.ts"));
const wikiSrc = read("web/v2/wiki-main.ts");
const wk = code(wikiSrc);
const slot = code(read("web/v2/aside-slot.ts"));

const rr = cut(mainSrc, "async function renderRoute(", "\nfunction markActive(");
const iWiki = rr.indexOf("isWikiListRoute(tab.route)");
ok(iWiki > 0, "S1 renderRoute 가 목록 주소를 가로챈다(isWikiListRoute)");
ok(iWiki > 0 && iWiki < rr.indexOf("} else if (page === 'app' && segs[1])") && iWiki < rr.indexOf("} else if (CLASSIC_PAGES[page])"),
  "S1 가로채기가 #/app/<key> · CLASSIC_PAGES 갈래보다 앞 — 사이드바 행이 클래식 액자로 새지 않는다");
ok(/const isWikiListRoute = \(route: string\): boolean => wikiScopeOf\(route\) !== null/.test(mainSrc), "S1 판정은 잣대 한 자리(wikiScopeOf)");
ok(/renderWikiMain\(tab\.center,/.test(mainSrc), "S1 셸이 위키 목록을 그린다");

const oag = cut(mainSrc, "function openAsideGuest(", "\nfunction ");
ok(/g\.label \|\| '미리보기'/.test(oag), "P2 손님 머리 이름을 부르는 쪽이 정한다(문서 · 미리보기)");
//  손님의 수명(고정 문서 = 셸에 하나 · 미리보기 = 연 탭)은 scripts/aside-guests.test.mjs 가 값과 배선으로 본다.
ok(/if \(!r\.reuse\)/.test(oag), "P2 같은 손님을 다시 부르면 다시 읽지 않는다");
ok(/label\?: string/.test(slot), "P2 AsideGuest 에 label 이 있다");
ok(/asideEl\.append\(guest\)/.test(oag) && !/host\.append\(guest\)/.test(oag), "P2 손님은 우패널 기둥에 판들과 나란히 — 화면마다 판을 비워도 떨어지지 않는다(iframe 을 다시 읽지 않는다)");

const pin = cut(wk, "function pinDoc(", "\n}");
ok(/openInAside\(/.test(pin) && /pinGuest\(/.test(pin), "P2 [우측 사이드바에 고정] = pinGuest 로 오른쪽 칸 손님을 연다");
ok(/ui\.peek = ''/.test(pin), "P2 고정하면 덧창을 닫는다");
const lits = strings(wikiSrc).concat(strings(read("web/lib/wiki-list.ts")));
ok(lits.some((s) => s === "우측 사이드바에 고정"), "P3 단추 글 «우측 사이드바에 고정»");
ok(lits.some((s) => s === "다른 화면으로 가도 오른쪽에 계속 띄워 둡니다"), "P3 툴팁 문구");
ok(lits.length > 0 && !lits.some((s) => s.includes("곁칸")), "P3 새 화면의 글 어디에도 «곁칸» 이 없다");

const row = cut(wk, "const rowOf = ", "\n  };");
ok(/openPeek\(/.test(row) && !/location\.hash\s*=/.test(row), "W1 행을 누르면 덧창 — 이동하지 않는다");
ok(/ev\.preventDefault\(\)/.test(row) && /metaKey/.test(row), "W1 제목 링크는 ⌘ · Ctrl 클릭만 브라우저 몫, 그냥 누르면 덧창");
const keys = cut(wk, "function bindWikiKeys(", "\n}");
ok(/'Escape'/.test(keys) && /ArrowDown/.test(keys) && /ArrowUp/.test(keys), "W2 Esc · ↑ ↓");
ok(/if \(i < 0\) return;/.test(keys), "W2 지금 문서가 그려진 순서에 없으면 ↑ ↓ 를 먹지 않는다");
ok(/textarea, input, select/.test(keys) && /\.pn-ctx/.test(keys), "W2 입력칸 · 메뉴 안에서는 키를 먹지 않는다");
ok(/renderMarkdown\(/.test(cut(wk, "function renderPeek(", "\n}")), "W3 덧창 본문은 기존 마크다운 렌더러");
ok(/showCtxMenu\(/.test(wk) && /WIKI_GROUP_BYS/.test(wk) && /sep: true/.test(wk), "W4 묶기 드롭다운: 네 기준, 구분선 아래 묶지 않음");
ok(/review-queue\/summary/.test(wk) && /검토 대기/.test(wikiSrc), "W5 「검토 대기 N」 칩");
ok(/#\/knowledge\/new/.test(wk), "W6 ＋ 새 문서 = 종전 새 문서 흐름");
ok(/#\/k\//.test(wk), "W7 편집 · 크게 = 종전 문서 화면");

const wd = code(read("web/wiki-data.ts"));
ok(/KN_TYPE_LABEL[^=\n]*= WIKI_TYPE_LABEL/.test(wd), "G11 유형 이름 사전은 한 벌(wiki-data 가 잎의 것을 쓴다)");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
