// 앱 만들기 흐름의 순수 부분(web/lib/studio-flow.ts) — AI 답의 표식을 읽고, 단계마다 보낼 글을 만든다(#4592 원준 2026-10-11).
//  컴파일된 모듈(public/app/lib/studio-flow.js)을 돌린다 — 빌드가 없으면 건너뛰고 그 사실을 적는다(CI 의 run-tests --build 가 돈다).
//  이게 틀리면: AI 가 기획 카드를 보냈는데 화면이 「쓰는 중」 에 멈추거나, 걸음 표시가 안 움직이거나, 점검 줄이 안 채워지거나,
//   사본 id 가 규칙(소문자 영숫자/- 32자)을 어겨 저장이 거부된다.
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = join(root, "public/app/lib/studio-flow.js");
if (!existsSync(mod)) { console.log("app-studio-flow: 빌드 없음(public/app/lib/studio-flow.js) — 건너뜀"); process.exit(0); }
const F = await import(mod);
let pass = 0, fail = 0;
const check = (ok, what, extra) => { if (ok) pass++; else { fail++; console.log("FAIL ", what, extra == null ? "" : JSON.stringify(extra)); } };

// 기획 카드 — 블록 안의 「이름: 값」 줄. 앞뒤 말이 있어도, 번호 · 점이 붙어도, 마지막 블록만.
const card = F.parseCard("네, 정리했어요.\n[[기획카드]]\n이름: 회의 안건\n누가 쓰나: 회의를 준비하는 사람\n- 무엇을 적나: 안건 제목 · 날짜\n3. 할 수 있는 것: 더하기 · 회의별 보기 · 끝난 것 접기\n안 하는 것: 회의록\n첫 화면: 이번 회의 목록\n[[/기획카드]]\n틀린 줄이 있으면 말해 주세요.");
check(card && card.name === "회의 안건" && card.who === "회의를 준비하는 사람" && card.items === "안건 제목 · 날짜" && card.can.length === 3 && card.can[2] === "끝난 것 접기" && card.not === "회의록" && card.first === "이번 회의 목록", "C1 기획 카드를 읽는다(앞뒤 말 · 번호 · 점 무시)", card);
check(F.parseCard("이름: 없음 블록 없음") === null && F.parseCard("[[기획카드]]\n누가 쓰나: 나\n[[/기획카드]]") === null, "C2 블록이 없거나 이름이 없으면 카드가 아니다");
const two = F.parseCard("[[기획카드]]\n이름: 첫째\n[[/기획카드]] 고쳤어요 [[기획카드]]\n이름: 둘째\n할 수 있는 것: a, b\n[[/기획카드]]");
check(two && two.name === "둘째" && two.can.join("|") === "a|b", "C3 블록이 여럿이면 마지막 · 쉼표로 나눈 목록도", two);
const txt = F.cardText(card);
check(/^\[\[기획카드\]\]\n이름: 회의 안건\n/.test(txt) && /할 수 있는 것: 더하기 · 회의별 보기 · 끝난 것 접기\n/.test(txt) && /\[\[\/기획카드\]\]$/.test(txt) && F.parseCard(txt).can.length === 3, "C4 카드 → 글 → 카드가 같다", txt);

// 걸음 · 점검
check(F.parseStep("[[걸음 1/4]] 기획 읽음 … [[걸음 3/4]] 자료 표") === 3 && F.parseStep("아직") === 0 && F.parseStep("[[걸음 4/4]] 저장 [[걸음 2/4]]") === 4 && F.parseStep("[[걸음 9/4]]") === 4, "S1 걸음은 가장 큰 n(1~4)");
const ck = F.parseCheck("봤어요.\n[[대조]] 있음: 더하기 · 회의별 보기 | 빠짐: 끝난 것 접기");
check(ck && ck.have.length === 2 && ck.missing.length === 1 && ck.missing[0] === "끝난 것 접기", "K1 대조 줄 — 있음 · 빠짐", ck);
const ck2 = F.parseCheck("[[대조]] 있음: a · b · c | 빠짐: 없음");
check(ck2 && ck2.have.length === 3 && ck2.missing.length === 0 && F.parseCheck("대조 없음") === null, "K2 「빠짐: 없음」 은 빈 목록", ck2);

// 세션 기록(ndjson) — AI 답만, 글 블록만
const nd = [JSON.stringify({ type: "user", message: { content: "[[기획카드]] 가짜" } }), "", "깨진 줄", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "앞" }, { type: "tool_use", name: "x" }, { type: "text", text: "뒤" }] } }), JSON.stringify({ type: "assistant", message: { content: "문자열 답" } }), JSON.stringify({ type: "system", subtype: "turn_duration" })].join("\n");
const at = F.assistantTexts(nd);
check(at.length === 2 && at[0] === "앞\n뒤" && at[1] === "문자열 답", "T1 AI 답의 글만 — 사람 줄 · 도구 블록 · 깨진 줄은 뺀다", at);

// 새 앱 · 사본 id
check(F.freshApps(["a", "b"], [{ id: "a" }, { id: "c", status: "active" }, { id: "d", status: "removed" }]).join() === "c", "A1 시작할 때 없던 활성 앱만");
const cid = F.copyId("meeting-agenda", "Wonjoon.Jang");
check(/^[a-z0-9][a-z0-9-]{1,31}$/.test(cid) && cid === "meeting-agenda-wonjoon-jang", "A2 사본 id = 원본-내 id(소문자 · 32자 안)", cid);
check(F.copyId("a-very-long-app-identifier-here-xx", "sangmin-yoon").length <= 32, "A3 길면 자른다");

// 단계 글 — 표식 약속이 들어 있다 · 핀은 비율 좌표와 자리 글로
check(/\[\[기획카드\]\]/.test(F.planBrief("할 일", "side")) && /아직 만들지 말고/.test(F.planBrief("할 일", "side")) && /사이드바/.test(F.planBrief("할 일", "side")) && !/곁칸/.test(F.planBrief("할 일", "side")), "B1 기획 글 — 만들지 말고 카드만 · 자리 말(「곁칸」 은 안 쓴다)");
const db = F.draftBrief(card, "full");
check(/\[\[걸음 1\/4\]\]/.test(db) && /app-build-quickstart/.test(db) && /이름: 회의 안건/.test(db) && /넓게/.test(db) && !/미리 잡아/.test(db), "B2 시안 글 — 걸음 · 지식 · 카드 · 자리(예약 id 가 없으면 id 말은 없다)", db);
//  #4667 「만들기 시작」 이 예약한 앱 id — 그 id 로 저장하라 · 공개는 사람이 정한다(AI 가 app_visibility_set 을 부르지 않는다)
const dbr = F.draftBrief(card, "side", "app-k3x9qa");
check(/id 를 꼭 app-k3x9qa/.test(dbr) && /app_visibility_set 은 부르지 마/.test(dbr) && /\[\[걸음 4\/4\]\]/.test(dbr), "B2r 시안 글 — 예약한 앱 id 로 저장 · 공개는 하지 않는다", dbr);
const fb = F.fixBrief(2, [{ x: 0.304, y: 0.12, where: "<h1 「제목」>", note: "날짜도" }, { x: 0.5, y: 0.5, where: "", note: "  " }], "글자 크게", "side", "meeting-agenda");
check(/2번째/.test(fb) && /왼쪽에서 30% · 위에서 12% 자리 · <h1 「제목」> → 날짜도/.test(fb) && !/50%/.test(fb) && /\[앱 전체\] 글자 크게/.test(fb) && /app_pull meeting-agenda/.test(fb), "B3 고침 글 — 빈 핀은 빼고 · 비율 자리 · 전체 의견", fb);
check(/\[\[대조\]\]/.test(F.checkBrief(card, "x")) && /app_pull x/.test(F.checkBrief(card, "x")), "B4 점검 글");
check(/슬랙 채널 #p/.test(F.notifyBrief("회의 안건", "글", " #p ")) && !/슬랙/.test(F.notifyBrief("회의 안건", "글", "")) && /앱 소개 · 회의 안건/.test(F.notifyBrief("회의 안건", "글", "")), "B5 알림 글 — 슬랙은 적었을 때만");
check(/원본은 건드리지 말고/.test(F.copyBrief("a-me", "A · 나", "A", "상민", "both")) && /app_pull a-me/.test(F.copyBrief("a-me", "A · 나", "A", "상민", "both")), "B6 사본 글");
check(/있던 것은 그대로/.test(F.editBrief("a", "A", "side")), "B7 원본 고치기 글");
check(F.whereText({ tag: "h1", text: "이번 회의 안건" }) === "<h1 「이번 회의 안건」>" && F.whereText(null) === "" && F.whereText({ tag: "div", text: "" }) === "<div>", "W1 찍은 자리 글");
check(typeof F.PROBE_JS === "string" && /elementFromPoint/.test(F.PROBE_JS) && /__studio/.test(F.PROBE_JS) && !/`/.test(F.PROBE_JS), "P1 탐침 스크립트 — 백틱 없음(스크립트 태그 안에 그대로 들어간다)");

// ══ F 버전 이름 — 「판」 금지(#4632 원준 2026-10-15 · 사양 표 F) ══
check(F.verName(0) === "" && F.verName(-1) === "" && F.verName(NaN) === "" && F.verName(1) === "초안" && F.verName(2) === "V2" && F.verName(10) === "V10" && F.verName(11) === "V11" && F.verName(2.7) === "V2", "F1 verName — 없음 '' · 1 초안 · 2 이상 Vn · 소수는 내림");
check(F.verJ(1, "을") === "초안을" && F.verJ(1, "으로") === "초안으로" && F.verJ(1, "은") === "초안은" && F.verJ(1, "이") === "초안이" && F.verJ(0, "으로") === "초안으로", "F2 verJ — 초안은 받침 꼴(을 · 으로 · 은 · 이)");
check(F.verJ(2, "을") === "V2 를" && F.verJ(2, "으로") === "V2 로" && F.verJ(3, "은") === "V3 는" && F.verJ(4, "이") === "V4 가", "F3 verJ — Vn 은 띄어 받침 없는 꼴(를 · 로 · 는 · 가)");
check(F.verArrived(0) === "초안이 나왔어요" && F.verArrived(1) === "초안이 나왔어요" && F.verArrived(NaN) === "초안이 나왔어요" && F.verArrived(-3) === "초안이 나왔어요" && F.verArrived(2) === "두 번째 버전이 나왔어요" && F.verArrived(3) === "세 번째 버전이 나왔어요" && F.verArrived(10) === "열 번째 버전이 나왔어요" && F.verArrived(2.7) === "두 번째 버전이 나왔어요", "F4 verArrived — 초안 · 두 번째 … 열 번째 · 소수는 내림");
//  원준 2026-10-16 «그 뒤도 열한 번째 버전이 나왔어요 <- 이렇게» — 열 번째 뒤도 우리말 서수(스무는 불규칙) · 백부터는 숫자.
check(F.verArrived(11) === "열한 번째 버전이 나왔어요" && F.verArrived(19) === "열아홉 번째 버전이 나왔어요" && F.verArrived(20) === "스무 번째 버전이 나왔어요" && F.verArrived(21) === "스물한 번째 버전이 나왔어요" && F.verArrived(30) === "서른 번째 버전이 나왔어요" && F.verArrived(45) === "마흔다섯 번째 버전이 나왔어요" && F.verArrived(99) === "아흔아홉 번째 버전이 나왔어요" && F.verArrived(100) === "100번째 버전이 나왔어요" && F.verArrived(101) === "101번째 버전이 나왔어요", "F5 verArrived — 열한 번째 · 스무 번째 · 스물한 번째 · 아흔아홉 번째 · 100번째", [11, 20, 21, 99, 100].map(F.verArrived));
{
  const bad = []; for (let n = 2; n <= 150; n++) { const t = F.verArrived(n); if (/V\s?\d/.test(t) || !/번째 버전이 나왔어요$/.test(t)) bad.push(n + ": " + t); }
  //  2~99 전부를 글자 그대로 — 십의 자리(쉰 · 예순 · 일흔 · 여든 …) 어느 하나가 틀려도 잡힌다.
  const ONE = ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉"], TEN = ["", "열", "스물", "서른", "마흔", "쉰", "예순", "일흔", "여든", "아흔"];
  for (let n = 2; n <= 99; n++) { const want = (n === 20 ? "스무" : TEN[Math.floor(n / 10)] + ONE[n % 10]) + " 번째 버전이 나왔어요"; if (F.verArrived(n) !== want) bad.push(n + ": " + F.verArrived(n) + " ≠ " + want); }
  check(bad.length === 0 && F.verOrdinal(0) === "첫 번째" && F.verOrdinal(1) === "첫 번째" && F.verOrdinal(NaN) === "첫 번째", "F6 2~150 어디에도 V 숫자 꼴이 없다 · verOrdinal 은 빈 글을 내지 않는다", bad.slice(0, 5));
}
// ══ H 기획 카드 「참고한 것」 · 벤치마크 · 와이어프레임(사양 표 H) ══
const refCard = F.parseCard("[[기획카드]]\n이름: 회의록\n할 수 있는 것: 올리기 · 정리 · 넣기\n참고한 것: Otter 의 회의 목록 + 정리본 탭\n[[/기획카드]]");
check(refCard && refCard.ref === "Otter 의 회의 목록 + 정리본 탭", "H1 카드의 「참고한 것」 줄을 읽는다", refCard);
const oldCard = { name: "회의 안건", who: "준비하는 사람", items: "제목", can: ["더하기"], not: "", first: "목록" };   // 기록 · 매니페스트에 남은 옛 카드(ref 칸이 아예 없다)
check(card && !card.ref && !/undefined/.test(F.cardText(oldCard)) && /\n참고한 것: \n\[\[\/기획카드\]\]/.test(F.cardText(oldCard)), "H2 옛 카드(참고 줄 없음)도 읽히고 cardText 에 undefined 가 없다", F.cardText(oldCard));
const pb2 = F.planBrief("회의록 정리", "both", "회의록");
check(/비슷한 앱 · 서비스/.test(pb2) && /\n참고한 것: \n\[\[\/기획카드\]\]/.test(pb2), "H3 planBrief — 비슷한 앱 · 서비스를 견주고 카드에 「참고한 것」 줄", pb2);
const db2 = F.draftBrief(refCard, "both", "meeting-notes");
check(/초안을 만들어/.test(db2) && db2.includes(F.WIREFRAME_PATH) && F.WIREFRAME_PATH === "studio/wireframe.html" && !/첫 판/.test(db2) && !/판/.test(db2.replace(/참고한 것[^\n]*/g, "")), "H4 draftBrief — 초안 · 와이어프레임 파일을 함께 저장 · 「판」 없음", db2);
const fb2 = F.fixBrief(2, [{ x: 0.1, y: 0.2, where: "", note: "크게", kind: "pin" }], "", "both", "meeting-notes");
check(/새 버전으로 저장/.test(fb2) && fb2.includes(F.WIREFRAME_PATH) && !/판/.test(fb2), "H5 fixBrief — 새 버전 · 와이어프레임도 맞춰 · 「판」 없음", fb2);
const wb2 = F.wireframeBrief("meeting-notes");
check(/app_pull meeting-notes/.test(wb2) && wb2.includes(F.WIREFRAME_PATH) && /앱 화면은 그대로/.test(wb2), "H6 wireframeBrief — 받아서 그림 파일만 더해 저장", wb2);
const tb2 = F.tryBrief("회의록", "meeting-notes");
check(/시험해 보는 세션/.test(tb2) && /meeting-notes/.test(tb2) && /app_save 금지/.test(tb2), "H7 tryBrief — 써 보는 세션 · 앱 코드는 고치지 않는다", tb2);
{
  //  시험 세션은 첫 지시의 머리로도 알아본다(기록만 남은 줄 — lib/builder-flow isTrySessionTitle). 첫 지시 글을 바꾸면 그 판정이 깨진다 — 짝을 맞춰 둔다.
  const B = await import(join(root, "public/app/lib/builder-flow.js"));
  check(B.isTrySessionTitle(tb2) && B.isTrySessionTitle(F.tryBrief("메모 · 원준", "memo-wonjoon-jang").slice(0, 120)), "H8 tryBrief 의 머리 = 시험 세션 대화 제목 판정(120자로 잘린 제목도)", tb2.slice(0, 80));
}

// ══ W 와이어프레임 보드(#4632 원준 2026-10-16 묶음 #8) — 보드에서 짚은 곳은 그 그림의 자리로 AI 에게 간다 · 그림은 늘 있다 ══
{
  const pins = [
    { kind: "pin", x: 0.3, y: 0.4, where: "<div 「목록」>", note: "글자 크게", on: "wire" },
    { kind: "pick", x: 0.1, y: 0.2, w: 0.2, h: 0.05, where: "<button 「세션에 넣기」>", note: "더 눈에 띄게" },
    { kind: "box", x: 0.5, y: 0.1, w: 0.3, h: 0.3, where: "", note: "비어 보여요", on: "wire" },
  ];
  const fb = F.fixBrief(2, pins, "", "both", "meeting-notes");
  const L = fb.split("\n");
  check(/^\[핀 1\] 와이어프레임\(studio\/wireframe\.html\)의 왼쪽에서 30% · 위에서 40% 자리/.test(L[1]) && /^\[선택한 요소 2\] <button 「세션에 넣기」> — 화면의 왼쪽에서 10%/.test(L[2]) && /^\[영역 3\] 와이어프레임\(studio\/wireframe\.html\)의 왼쪽에서 50%/.test(L[3]),
    "W1 fixBrief — 보드에서 짚은 곳(on:wire)은 「와이어프레임의 … 자리」, 앱 화면에서 짚은 곳은 「화면의 … 자리」", L.slice(1));
  check(/그 파일이 아직 없으면 이번에 함께 그려/.test(fb), "W2 fixBrief — 그림이 없는 앱이면 이번 고침에 함께 그리게 한다(«한 장만 나와도 와이어프레임은 그냥 있는 거지»)", fb.slice(0, 200));
  const db3 = F.draftBrief(refCard, "both", "meeting-notes");
  check(/피그마 보드처럼/.test(db3) && /단추 하나하나마다/.test(db3) && /얇은 선/.test(db3) && /화면이 하나여도 한 장/.test(db3), "W3 draftBrief — 그림은 피그마 보드처럼 · 얇은 선 · 단추마다 이어지는 화살표 · 화면이 하나여도 한 장", db3.slice(0, 120));
}

// ══ K 「판」 이 화면 글에 남지 않는다(#4632 원준 2026-10-15 «판 이라는 워딩 전면 금지 · 앱빌더 어디서도») — 주석을 걷은 소스에서 본다 ══
//  격리 리뷰: 글 함수만 보는 시험은 화면 곳곳의 하드코딩된 글을 못 잡는다. 「판단」 · 대시보드 소개의 「한 판에」 는 버전과 무관해 허용한다.
{
  const { readFileSync } = await import("node:fs");
  const files = ["web/v2/publish-preview.ts", "web/v2/app-studio.ts", "web/v2/app-review.ts", "web/v2/builder.ts", "web/v2/app-try-session.ts", "web/v2/apps.ts", "web/v2/app-versions.ts", "web/v2/session-app-pane.ts", "web/lib/app-menu.ts", "web/lib/studio-flow.ts", "web/lib/builder-flow.ts"];
  const left = [];
  for (const f of files) {
    const src = readFileSync(join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    for (const m of src.matchAll(/.{0,20}판.{0,10}/g)) if (!/판단|한 판에/.test(m[0])) left.push(f + ": " + m[0].trim());
  }
  check(left.length === 0, "K1 앱빌더 · 세션 사이드바 앱 머리줄 · 버전 메뉴 · 앱 찾기의 글에 「판」 이 없다", left);
}

console.log(`app-studio-flow: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
