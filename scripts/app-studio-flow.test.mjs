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
check(/\[\[걸음 1\/4\]\]/.test(db) && /app-build-quickstart/.test(db) && /이름: 회의 안건/.test(db) && /넓게/.test(db), "B2 시안 글 — 걸음 · 지식 · 카드 · 자리", db);
const fb = F.fixBrief(2, [{ x: 0.304, y: 0.12, where: "<h1 「제목」>", note: "날짜도" }, { x: 0.5, y: 0.5, where: "", note: "  " }], "글자 크게", "side", "meeting-agenda");
check(/2번째/.test(fb) && /왼쪽에서 30% · 위에서 12% 자리 · <h1 「제목」> → 날짜도/.test(fb) && !/50%/.test(fb) && /\[앱 전체\] 글자 크게/.test(fb) && /app_pull meeting-agenda/.test(fb), "B3 고침 글 — 빈 핀은 빼고 · 비율 자리 · 전체 의견", fb);
check(/\[\[대조\]\]/.test(F.checkBrief(card, "x")) && /app_pull x/.test(F.checkBrief(card, "x")), "B4 점검 글");
check(/슬랙 채널 #p/.test(F.notifyBrief("회의 안건", "글", " #p ")) && !/슬랙/.test(F.notifyBrief("회의 안건", "글", "")) && /앱 소개 · 회의 안건/.test(F.notifyBrief("회의 안건", "글", "")), "B5 알림 글 — 슬랙은 적었을 때만");
check(/원본은 건드리지 말고/.test(F.copyBrief("a-me", "A · 나", "A", "상민", "both")) && /app_pull a-me/.test(F.copyBrief("a-me", "A · 나", "A", "상민", "both")), "B6 사본 글");
check(/있던 것은 그대로/.test(F.editBrief("a", "A", "side")), "B7 원본 고치기 글");
check(F.whereText({ tag: "h1", text: "이번 회의 안건" }) === "<h1 「이번 회의 안건」>" && F.whereText(null) === "" && F.whereText({ tag: "div", text: "" }) === "<div>", "W1 찍은 자리 글");
check(typeof F.PROBE_JS === "string" && /elementFromPoint/.test(F.PROBE_JS) && /__studio/.test(F.PROBE_JS) && !/`/.test(F.PROBE_JS), "P1 탐침 스크립트 — 백틱 없음(스크립트 태그 안에 그대로 들어간다)");

console.log(`app-studio-flow: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
