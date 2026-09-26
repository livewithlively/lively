// #4233 — 셸 우패널 손님(iframe)의 수명. 격리 리뷰(#1109 머지 2cab7be6)의 막힘 지적을 잠근다.
//
//  #1109 는 [우측 사이드바에 고정](원준 «일하며 옆에 띄워 둘 문서»)을 위해 손님을 셸에 하나로 옮겼는데, 그 바람에
//  **모든** 손님이 셸 전체에 남게 됐다: 프로젝트 상세 · 관리탭의 미리보기, 타임라인 산출물 링크가 연 탭을 닫아도 떠 있고,
//  우패널이 없는 화면(noAside)에서도 우패널을 억지로 열었다.
//  손님은 두 가지다.
//   · 고정 문서(sticky) — 위키 덧창의 [우측 사이드바에 고정]만. 셸에 하나, 화면을 옮겨도 · 탭을 닫아도 남는다.
//     클래식 앱 액자 화면(관리 · 맥락 관리 · 문서 화면 같은 옛 전폭 화면)에서는 물러났다가 떠나면 돌아온다.
//     ⚠ noAside 전체가 아니다: 홈 · 위키 · AI 세션 · 세션 화면까지 거의 모든 화면이 noAside 라, 거기서 숨기면 고정한 그 자리(위키)에서부터 안 보인다.
//   · 미리보기(나머지 openInAside) — #1109 이전 규칙 그대로. 연 탭(주인)의 것이고 그 탭이 보일 때만 보이며, 주인 탭을 닫으면 걷힌다.
//     다른 탭의 우패널을 열지 않는다.
//
//  L — 장부(web/lib/aside-guests.ts)를 값으로.  W — 셸(main.ts)과 부르는 쪽이 그 장부를 실제로 지나는지 소스로.
//  ⚠ 단언을 하나씩 끝까지 센다 — origin/main(fa8dafbe3)에서 L · W 가 빨간불인 것을 먼저 보고 고쳤다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
//  주석은 빼고 본다 — 머리말에 적힌 낱말이 단언을 통과시키면 그 시험은 아무것도 안 잡는다.
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/\s.*$/, "")).join("\n");
const cut = (src, from, to) => { const a = src.indexOf(from); if (a < 0) return ""; const b = to ? src.indexOf(to, a + 1) : -1; return src.slice(a, b > a ? b : undefined); };

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name}${JSON.stringify(got) === JSON.stringify(want) ? "" : ` — got ${JSON.stringify(got)}`}`);

// ───────────────────────── L. 장부 (web/lib/aside-guests.ts) ─────────────────────────
let lib = null;
try { lib = await import(pathToFileURL(join(root, "public/app/lib/aside-guests.js")).href); } catch { /* 없으면 L0 이 빨간불 */ }
ok(!!lib, "L0 손님 장부가 잎 모듈(lib/aside-guests.ts)에 있다");
if (lib) {
  const { STICKY, EMPTY_BOOK, openGuest, closeTabGuests, closeSlot, shownSlot } = lib;
  const pv = (key, owner) => ({ key, owner, sticky: false });
  const pin = (key, owner) => ({ key, owner, sticky: true });
  const on = (id, frame = false) => ({ id, frame });
  const book = (...asks) => asks.reduce((b, a) => openGuest(b, a).book, EMPTY_BOOK);

  // L1 주인 탭을 닫으면 그 미리보기가 걷힌다
  {
    const b = book(pv("preview:env1", "A"), pin("kdoc:doc", "A"));
    const r = closeTabGuests(b, "A");
    eq([r.drop, r.book.A, r.book[STICKY]], [true, undefined, "kdoc:doc"], "L1 주인 탭(A)을 닫으면 A 의 미리보기는 걷히고 고정 문서는 남는다");
    eq(shownSlot(r.book, on("B")), STICKY, "L1 닫은 뒤 다른 탭에는 고정 문서만");
  }
  // L2 다른 탭으로 옮기면 미리보기는 안 보이고, 돌아오면 다시 보인다
  {
    const b = book(pv("preview:env1", "A"));
    eq([shownSlot(b, on("B")), shownSlot(b, on("A"))], [null, "A"], "L2 미리보기는 주인 탭(A)에서만 · 다른 탭(B)은 우패널을 안 연다");
  }
  // L3 고정 문서는 화면을 옮겨도 · 탭을 닫아도 남는다
  {
    let b = book(pin("kdoc:doc", "W"));
    eq([shownSlot(b, on("W")), shownSlot(b, on("H")), shownSlot(b, on("S"))], [STICKY, STICKY, STICKY], "L3 고정 문서는 고정한 탭 · 홈 · 세션 어디서나");
    const r = closeTabGuests(b, "W");
    b = r.book;
    eq([r.drop, shownSlot(b, on("H"))], [false, STICKY], "L3 고정한 탭(W)을 닫아도 남는다");
  }
  // L4 클래식 앱 액자 화면은 억지로 열리지 않는다
  {
    const b = book(pin("kdoc:doc", "W"), pv("preview:env1", "A"));
    eq(shownSlot(b, on("F", true)), null, "L4 고정 문서도 남의 미리보기도 액자 화면(F)의 우패널을 열지 않는다");
    eq(shownSlot(b, on("H")), STICKY, "L4 액자 화면을 떠나면 고정 문서가 돌아온다");
  }
  // L5 액자 화면이라도 제 미리보기는 보인다(#1109 이전 그대로 — 미리보기 단추가 사는 곳이 관리탭 · 클래식 프로젝트 상세다)
  eq(shownSlot(book(pv("preview:env1", "A")), on("A", true)), "A", "L5 주인 탭이 액자 화면이어도 제 미리보기는 연다");
  // L6 주인 탭에서는 제 미리보기가 고정 문서보다 앞, 미리보기를 닫으면 고정 문서가 돌아온다
  {
    const b = book(pin("kdoc:doc", "W"), pv("preview:env1", "A"));
    eq(shownSlot(b, on("A")), "A", "L6 주인 탭에서는 제 미리보기가 앞");
    const r = closeSlot(b, "A");
    eq([r.drop, shownSlot(r.book, on("A"))], [true, STICKY], "L6 미리보기를 닫으면 고정 문서가 그 자리로");
  }
  // L7 같은 자리에 같은 key 는 다시 쓰고(다시 읽지 않는다), 다른 key 는 갈아 끼운다
  {
    const b = book(pv("preview:env1", "A"));
    const same = openGuest(b, pv("preview:env1", "A"));
    const other = openGuest(b, pv("preview:env2", "A"));
    eq([same.reuse, same.drop, same.slot], [true, false, "A"], "L7 같은 미리보기를 다시 부르면 다시 쓴다");
    eq([other.reuse, other.drop, other.book.A], [false, true, "preview:env2"], "L7 다른 미리보기는 그 탭의 것을 갈아 끼운다");
  }
  // L8 B 에서 연 미리보기가 A 의 미리보기를 걷지 않는다
  {
    const r = openGuest(book(pv("preview:env1", "A")), pv("out:https://x", "B"));
    eq([r.drop, r.book.A, r.book.B], [false, "preview:env1", "out:https://x"], "L8 탭마다 제 미리보기 하나 — 남의 탭 것을 조용히 버리지 않는다");
  }
  // L9 다른 문서를 고정하면 고정 문서가 바뀐다(셸에 하나)
  {
    const r = openGuest(book(pin("kdoc:a", "W")), pin("kdoc:b", "X"));
    eq([r.slot, r.drop, r.book[STICKY]], [STICKY, true, "kdoc:b"], "L9 고정 문서는 하나 — 새로 고정하면 갈아 끼운다");
  }
  // L10 경계: 빈 장부 · 활성 탭 없음 · 고정 자리 이름으로 닫기
  eq([shownSlot(EMPTY_BOOK, on("A")), closeTabGuests(EMPTY_BOOK, "A").drop], [null, false], "L10 빈 장부 = 우패널 안 연다 · 닫을 것 없음");
  eq(shownSlot(book(pin("kdoc:a", "W")), null), null, "L10 활성 탭이 없으면 아무것도 안 보인다");
  eq(closeTabGuests(book(pin("kdoc:a", "W")), STICKY).drop, false, "L10 탭 닫기는 고정 자리를 건드리지 않는다");
  eq(Object.keys(EMPTY_BOOK).length, 0, "L10 장부는 값이다(부르는 쪽이 새 장부를 받는다)");
}

// ───────────────────────── W. 배선 (소스) ─────────────────────────
const main = code(read("web/v2/main.ts"));
const slot = code(read("web/v2/aside-slot.ts"));
const onClose = cut(main, "onClose: (tab) =>", "\n    },");
ok(/dropTabGuest\(tab\)/.test(onClose) && /closeTabGuests\(guestBook, tab\.id\)/.test(cut(main, "function dropTabGuest(", "\n}")), "W1 탭을 닫으면 그 탭의 미리보기를 걷는다(onClose → dropTabGuest)");
const chrome = cut(main, "function applyTabChrome(", "\n}");
ok(/const shown = shownGuestSlot\(tab\);/.test(chrome) && /shownSlot\(guestBook, tab \? \{ id: tab\.id, frame: frameTabs\.has\(tab\) \}/.test(main) && /no-aside', tab\.noAside && !shown/.test(chrome),
  "W2 우패널을 여는지는 이 탭에 보일 손님(shownSlot)으로 — 장부에 손님이 있다는 것만으로 열지 않는다");
ok(/\.hidden = s !== shown/.test(chrome), "W2 손님 화면은 이 탭에 보일 것 하나만 보인다");
const oag = cut(main, "function openAsideGuest(", "\nfunction ");
ok(/openGuest\(guestBook, \{ key: g\.key, sticky: !!g\.sticky, owner: tab\.id \}\)/.test(oag), "W3 손님을 열 때 주인 탭과 종류(고정 · 미리보기)를 장부에 적는다");
ok(/sticky\?: boolean/.test(slot), "W4 AsideGuest 에 sticky 가 있다");
ok(/sticky: true/.test(code(read("web/lib/wiki-list.ts"))) && /sticky: g\.sticky/.test(cut(code(read("web/v2/wiki-main.ts")), "function pinDoc(", "\n}")), "W4 [우측 사이드바에 고정]만 고정 문서다");
ok(!/sticky/.test(code(read("web/admin-preview.ts")) + code(read("web/projects/detail-preview.ts")) + code(read("web/v2/panes.ts"))), "W4 미리보기를 여는 다른 곳은 고정 문서가 아니다");
const rr = cut(main, "async function renderRoute(", "\nfunction markActive(");
ok(/frameTabs\.delete\(tab\)/.test(rr) && (rr.match(/frameTabs\.add\(tab\)/g) || []).length >= 2, "W5 renderRoute 가 클래식 앱 액자 화면을 적는다(두 갈래)");
ok(/active\(\) === tab\) applyTabChrome\(tab\);\s*\n\s*tabsApi\?\.routed\(tab\);\s*\n\}/.test(rr + "\n}"), "W5 화면을 다 그린 뒤 손님 보이기를 다시 맞춘다");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
