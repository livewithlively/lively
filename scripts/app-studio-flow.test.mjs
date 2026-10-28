// 앱 만들기 흐름의 순수 부분(web/lib/studio-flow.ts) — AI 답의 표식을 읽고, 단계마다 보낼 글을 만든다(#4592 원준 2026-10-11).
//  컴파일된 모듈(public/app/lib/studio-flow.js)을 돌린다 — 빌드가 없으면 건너뛰고 그 사실을 적는다(CI 의 run-tests --build 가 돈다).
//  이게 틀리면: AI 가 기획 카드를 보냈는데 화면이 「쓰는 중」 에 멈추거나, 걸음 표시가 안 움직이거나, 점검 줄이 안 채워지거나,
//   사본 id 가 규칙(소문자 영숫자/- 32자)을 어겨 저장이 거부된다.
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
//  STUDIO_FLOW_JS — 다른 빌드(fail-first · 옛 트리)를 물릴 때. 없으면 이 트리의 빌드.
const mod = process.env.STUDIO_FLOW_JS || join(root, "public/app/lib/studio-flow.js");
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
check(/^\[\[기획카드\]\]\n앱 이름: 회의 안건\n/.test(txt) && /주요 기능: 더하기 · 회의별 보기 · 끝난 것 접기\n/.test(txt) && /\[\[\/기획카드\]\]$/.test(txt) && F.parseCard(txt).can.length === 3, "C4 카드 → 글 → 카드가 같다", txt);

// ══ L 줄 이름 · X 더한 항목(원준 2026-10-26 «무엇을 적나 이런거 좀 이상한데 … 명확하게» · «섹션 제목과 본문도 원한다면 더 추가해서») ══
{
  const NEW = ["앱 이름", "쓰는 사람", "저장하는 정보", "주요 기능", "넣지 않는 기능", "첫 화면", "알림", "참고한 서비스"];
  const OLD = /(^|\n)(이름|누가 쓰나|무엇을 적나|할 수 있는 것|안 하는 것|참고한 것):/;
  const t = F.cardText(card);
  check(JSON.stringify(t.split("\n").slice(1, -1).map((l) => l.split(":")[0])) === JSON.stringify(NEW) && !OLD.test(t), "L1 카드 글의 줄 이름 = 새 이름 여덟 · 옛 이름 없음", t);
  const nw = F.parseCard("[[기획카드]]\n앱 이름: 출장비\n쓰는 사람: 출장 다녀온 사람\n저장하는 정보: 날짜 · 금액\n주요 기능: 올리기 · 모아 보기 · 승인\n넣지 않는 기능: 송금\n첫 화면: 이번 달 목록\n알림: 승인되면 올린 사람에게\n참고한 서비스: 비즈플레이\n[[/기획카드]]");
  check(nw && nw.name === "출장비" && nw.who === "출장 다녀온 사람" && nw.items === "날짜 · 금액" && nw.can.length === 3 && nw.not === "송금" && nw.first === "이번 달 목록" && nw.notify === "승인되면 올린 사람에게" && nw.ref === "비즈플레이" && !nw.extra, "L2 새 이름으로 답한 카드를 읽는다(더한 항목으로 새지 않는다)", nw);
  check(card && card.who && card.items && card.not && !card.extra, "L3 옛 이름(누가 쓰나 · 무엇을 적나 · 할 수 있는 것 · 안 하는 것)도 그대로 읽는다", card);
  //  아래는 읽기(L2)와 따로 — 손으로 지은 같은 카드로(옛 트리에서 L2 가 못 읽어도 줄마다 따로 빨갛게).
  const NWC = { name: "출장비", who: "출장 다녀온 사람", items: "날짜 · 금액", can: ["올리기", "모아 보기", "승인"], not: "송금", first: "이번 달 목록", notify: "승인되면 올린 사람에게", ref: "비즈플레이" };
  const pb = F.planBrief("출장비 정리", "both", "출장비"), cb = F.checkBrief(NWC, "trip");
  check(NEW.every((n) => pb.includes("\n" + n + ": ")) && !OLD.test(pb) && !/할 수 있는 것|참고한 것/.test(pb) && /「주요 기능」을/.test(cb) && !/할 수 있는 것/.test(cb), "L4 planBrief 틀 · checkBrief 가 새 이름만", [pb.slice(-260), cb.split("\n")[1]]);
  const withX = { ...NWC, extra: [{ title: "결재 순서", body: "팀장 다음 재무" }, { title: "보관 기간", body: "5년" }] };
  const xt = F.cardText(withX), back = F.parseCard(xt);
  check(/\n참고한 서비스: 비즈플레이\n결재 순서: 팀장 다음 재무\n보관 기간: 5년\n\[\[\/기획카드\]\]$/.test(xt) && !!back && JSON.stringify(back.extra) === JSON.stringify(withX.extra) && back.ref === "비즈플레이", "X1 더한 항목 → 정해진 줄 뒤에 「제목: 본문」 · 다시 읽으면 순서 · 글 그대로", xt);
  const x2 = F.cardText({ ...NWC, extra: [{ title: "", body: "" }, { title: "", body: "영수증 사진 필수" }, { title: "메모", body: "" }, { title: "  ", body: " \n " }] });
  check(/\n추가 내용: 영수증 사진 필수\n메모: \n\[\[\/기획카드\]\]$/.test(x2), "X2 빈 쌍은 안 싣는다 · 본문만이면 「추가 내용」 · 제목만이면 「제목: 」", x2);
  const x3 = F.cardText({ ...NWC, extra: [{ title: "알림", body: "매주 월요일 요약" }] }), b3 = F.parseCard(x3);
  check(/\n추가 알림: 매주 월요일 요약\n\[\[/.test(x3) && !!b3 && b3.notify === "승인되면 올린 사람에게" && b3.extra && b3.extra[0].title === "추가 알림", "X3 정해진 줄 이름과 같은 제목은 「추가 …」 로 — 정해진 「알림」 을 덮지 않는다", x3);
  const b4 = F.parseCard("[[기획카드]]\n앱 이름: 회의록\n참고한 서비스: [Otter 블로그](https://otter.ai/blog), [Fireflies\nSkills](https://fireflies.ai/blog/), 앱스토어\n결재 순서: 팀장\n[[/기획카드]]");
  check(b4 && JSON.stringify(b4.extra) === JSON.stringify([{ title: "결재 순서", body: "팀장" }]), "X4 링크가 이어진 조각 줄은 더한 항목이 아니다(제목 꼴만)", b4 && b4.extra);
  //  격리 리뷰 — 한 줄에 주소만 둔 참고 목록(«https://…» · «- https://…»)이 «https» 항목으로 새던 것
  const b4b = F.parseCard("[[기획카드]]\n앱 이름: 회의록\n참고한 서비스: Otter\nhttps://otter.ai/blog\n- https://fireflies.ai/x\nHTTP://a.b/c\n[[/기획카드]]");
  check(b4b && b4b.ref === "Otter" && !b4b.extra, "X4 주소만 둔 줄(https://…)도 더한 항목이 아니다", b4b && b4b.extra);
  //  줄머리(- · 1.)가 붙은 «이름: 값» 은 위 줄의 하위 목록이다 — 더한 항목이 아니다(정해진 이름이면 종전대로 그 줄).
  const b6 = F.parseCard("[[기획카드]]\n앱 이름: 회의록\n주요 기능: 올리기 · 찾기 · 넣기\n- 올리기: 음성 업로드\n1. 찾기: 날짜와 낱말\n- 첫 화면: 목록\n결재 순서: 팀장\n[[/기획카드]]");
  check(b6 && b6.first === "목록" && b6.can.length === 3 && JSON.stringify(b6.extra) === JSON.stringify([{ title: "결재 순서", body: "팀장" }]), "X6 줄머리가 붙은 하위 목록은 더한 항목이 아니다 · 줄머리 붙은 정해진 줄은 종전대로", b6);
  //  쓴 제목은 다시 읽힌다 — 읽을 수 없는 글자(& / ( ) -)는 띄어쓰기로 바꿔 쓴다.
  const x7 = F.cardText({ ...NWC, extra: [{ title: "Q&A", body: "자주 묻는 것" }, { title: "결재(팀장)", body: "먼저" }, { title: "2단계-승인", body: "재무" }] }), b7 = F.parseCard(x7);
  check(!!b7 && JSON.stringify((b7.extra || []).map((x) => x.title)) === JSON.stringify(["Q A", "결재 팀장", "2단계 승인"]) && (b7.extra || []).length === 3, "X7 기호가 든 제목도 쓰고 다시 읽으면 남는다(기호는 띄어쓰기로)", x7);
  check(/기획 카드 앱 이름 줄에 그대로/.test(F.planBrief("출장비 정리", "both", "출장비")), "L4 planBrief 의 이름 줄도 새 이름(앱 이름)");
  const x5 = F.cardText({ name: "옛 앱", who: "", items: "", can: [], not: "", first: "" });
  check(/\n참고한 서비스: \n\[\[\/기획카드\]\]$/.test(x5) && !/undefined/.test(x5) && x5.split("\n").length === 10, "X5 옛 카드(더한 항목 없음) — 덧줄 · undefined 없음", x5);
}

// ══ R 「참고한 서비스」 보기(원준 2026-10-26 «주소 그냥 하이퍼링크로 … 줄바꿈 … 이쁘게» · «주소 일일이 복붙해야하더라») ══
{
  const prose = "Otter.ai에서는 회의 종류별 템플릿·제목과 참석자 규칙으로 템플릿을 저절로 고르는 방식·요약/전사/AI 채팅 탭 구성을, Fireflies.ai에서는 프롬프트로 만드는 맞춤 정리 형식, 전사문 옆 AI 패널을, 네이버 클로바노트에서는 요약·주요 주제·다음 할 일 정리와 그 결과를 고칠 수 있게 한 점, 말한 사람 구분, 검색을 가져왔습니다(출처: [Otter 블로그](https://otter.ai/blog/otter-meeting-types), [Otter 리뷰](https://kripeshadwani.com/otter-ai-review/), [Fireflies AI Skills](https://fireflies.ai/blog/fireflies-ai-apps/), [Fireflies Notepad 가이드](https://guide.fireflies.ai/articles/6653885315), [클로바노트 앱스토어](https://apps.apple.com/kr/app/%ED%81%B4/id1530010245)).";
  const RV = F.refView || (() => null);   // 옛 트리엔 없다 — 줄마다 따로 빨갛게
  const r1 = RV(prose);
  const names = r1 && r1.items.map((x) => x.name), texts = r1 ? r1.items.map((x) => x.text).join("|") : "";
  check(!!r1 && JSON.stringify(names) === JSON.stringify(["Otter.ai", "Fireflies.ai", "네이버 클로바노트"]) && !/가져왔|출처|https?:|\]\(|\(\s*,/.test(texts) && /검색$/.test(r1.items[2].text) && /탭 구성$/.test(r1.items[0].text), "R1 원준 화면의 산문 — 서비스 셋 · 끝말 · 출처 꼬리 · 주소 없음", r1);
  check(!!r1 && r1.links.length === 5 && r1.links[0].label === "Otter 블로그" && r1.links[4].url.startsWith("https://apps.apple.com/") && r1.links.every((l) => /^https:\/\//.test(l.url)), "R1 출처 링크 다섯(이름 · 주소)", r1 && r1.links);
  const r2 = RV("Otter: 회의 목록, 정리본 탭 ; 클로바노트: 말한 사람 구분 ; 출처: [Otter 블로그](https://otter.ai/blog), [앱스토어](https://apps.apple.com/x)");
  check(!!r2 && JSON.stringify(r2.items) === JSON.stringify([{ name: "Otter", text: "회의 목록, 정리본 탭" }, { name: "클로바노트", text: "말한 사람 구분" }]) && r2.links.length === 2, "R2 새 꼴(이름: 것 ; … ; 출처: 링크)", r2);
  const r3 = RV("노션 캘린더 보기 참고 https://www.notion.so/calendar");
  check(!!r3 && r3.links.length === 1 && r3.links[0].label === "notion.so" && r3.items.length === 1 && !/https/.test(r3.items[0].text), "R3 맨 주소는 호스트 이름 링크로", r3);
  const r4 = RV("애플 메모");
  check(!!r4 && JSON.stringify(r4) === JSON.stringify({ items: [{ name: "", text: "애플 메모" }], links: [] }), "R4 링크 없는 짧은 글 — 한 항목", r4);
  const r5 = RV("");
  check(!!r5 && r5.items.length === 0 && r5.links.length === 0, "R5 빈 글 — 아무것도 없음", r5);
  const r6 = RV("나쁜 것 [눌러](javascript:alert(1)) [그림](data:text/html,x)");
  check(!!r6 && r6.links.length === 0, "R6 javascript: · data: 는 링크로 만들지 않는다", r6);
  //  격리 리뷰 — 괄호가 든 주소 · 대괄호가 든 이름 · 문장 부호로 끝나는 맨 주소 · 다 걷고 남은 게 없을 때
  const r8 = RV("위키: 회의록 정의 ; 출처: [Wikipedia](https://en.wikipedia.org/wiki/Minutes_(document)), [B](https://b.com)");
  check(!!r8 && r8.links.length === 2 && r8.links[0].url === "https://en.wikipedia.org/wiki/Minutes_(document)" && JSON.stringify(r8.items) === JSON.stringify([{ name: "위키", text: "회의록 정의" }]), "R8 괄호가 든 주소가 잘리지 않고 남는 괄호 조각도 없다", r8);
  const r9 = RV("노트: 정리 ; 출처: [Foo [1]](https://a.com/x)");
  check(!!r9 && r9.links.length === 1 && r9.links[0].label === "Foo [1]" && r9.items.length === 1 && !/\[|\]/.test(r9.items[0].text), "R9 대괄호가 든 이름도 링크 하나로", r9);
  const r10 = RV("자세한 건 https://otter.ai/blog. 그리고 (https://a.com/b_(c)) 참고");
  check(!!r10 && r10.links.map((l) => l.url).join(" ") === "https://otter.ai/blog https://a.com/b_(c)", "R10 맨 주소 끝 마침표는 주소가 아니다 · 괄호 한 겹 주소는 통째로", r10 && r10.links);
  const r11 = RV("참고했습니다");
  check(!!r11 && JSON.stringify(r11.items) === JSON.stringify([{ name: "", text: "참고했습니다" }]), "R11 다 걷고 남은 게 없으면 원문 그대로(빈 칸 아님)", r11);
  check(/서비스 이름: 가져온 것/.test(F.planBrief("회의록 정리", "both", "회의록")) && /출처: \[이름\]\(주소\)/.test(F.planBrief("회의록 정리", "both", "회의록")), "R7 planBrief — 참고한 서비스를 «이름: 것 ; … ; 출처: [이름](주소)» 꼴로 청한다");
}

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
check(card && !card.ref && !/undefined/.test(F.cardText(oldCard)) && /\n참고한 서비스: \n\[\[\/기획카드\]\]/.test(F.cardText(oldCard)), "H2 옛 카드(참고 줄 없음)도 읽히고 cardText 에 undefined 가 없다", F.cardText(oldCard));
const pb2 = F.planBrief("회의록 정리", "both", "회의록");
check(/비슷한 앱 · 서비스/.test(pb2) && /\n참고한 서비스: \n\[\[\/기획카드\]\]/.test(pb2), "H3 planBrief — 비슷한 앱 · 서비스를 견주고 카드에 「참고한 서비스」 줄", pb2);
const db2 = F.draftBrief(refCard, "both", "meeting-notes");
check(/초안을 만들어/.test(db2) && db2.includes(F.WIREFRAME_PATH) && F.WIREFRAME_PATH === "studio/wireframe.html" && !/첫 판/.test(db2) && !/판/.test(db2.replace(/참고한 서비스[^\n]*/g, "")), "H4 draftBrief — 초안 · 와이어프레임 파일을 함께 저장 · 「판」 없음", db2);
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

// ══ L 초안은 기존 서비스의 꼴을 따라 — 우선순위 높게(#4632 원준 2026-10-16 «레거시 회사들이나 UI 조사해서 그거랑 비슷하게 · 높은 우선순위로») ══
{
  const db4 = F.draftBrief(refCard, "both", "meeting-notes");
  const L = db4.split("\n");
  const at = L.findIndex((l) => /우선순위 높음/.test(l)), cardAt = L.findIndex((l) => /^\[\[기획카드\]\]/.test(l));
  check(at >= 0 && /기존 서비스/.test(L[at]) && /UI/.test(L[at]) && /비슷하게/.test(L[at]) && /조사/.test(L[at]) && cardAt > at,
    "L1 draftBrief — 짜기 전에 기존 서비스의 화면 · 기능 · UI 를 조사해 비슷하게, 「우선순위 높음」 으로 카드보다 먼저 말한다", L.slice(0, 3));
  check(/회사 제품/.test(F.planBrief("회의록", "both")) && /조사/.test(F.planBrief("회의록", "both")), "L2 planBrief — 기획도 오래 쓰인 회사 제품을 조사해 견준다");
}

// ══ K 「판」 이 화면 글에 남지 않는다(#4632 원준 2026-10-15 «판 이라는 워딩 전면 금지 · 앱빌더 어디서도») — 주석을 걷은 소스에서 본다 ══
//  격리 리뷰: 글 함수만 보는 시험은 화면 곳곳의 하드코딩된 글을 못 잡는다. 「판단」 · 대시보드 소개의 「한 판에」 는 버전과 무관해 허용한다.
{
  const { readFileSync } = await import("node:fs");
  const files = ["web/v2/publish-preview.ts", "web/v2/app-studio.ts", "web/v2/app-review.ts", "web/v2/builder.ts", "web/v2/builder-model.ts", "web/v2/app-try-session.ts", "web/v2/apps.ts", "web/v2/app-versions.ts", "web/v2/session-app-pane.ts", "web/lib/app-menu.ts", "web/lib/studio-flow.ts", "web/lib/builder-flow.ts"];
  const left = [];
  for (const f of files) {
    const src = readFileSync(join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    for (const m of src.matchAll(/.{0,20}판.{0,10}/g)) if (!/판단|한 판에/.test(m[0])) left.push(f + ": " + m[0].trim());
  }
  check(left.length === 0, "K1 앱빌더 · 세션 사이드바 앱 머리줄 · 버전 메뉴 · 앱 찾기의 글에 「판」 이 없다", left);
}

// ══ M 앱빌더 화면 글 — 「지금 할 일:」 머리말 없이 바로 「~해주세요」 · 「—」 로 잇지 않는다(#4632 원준 2026-10-16 묶음 #12 «1.2.3.4.5. 전면에서 [지금 할 일: ]
//  이 멘트 없이» · ② 묶음 #1 «AI 풍의 어조» · «- 이런 하이픈? 이건 왜캐쓰는거야») — 주석을 걷은 소스의 한글 글자열에서 본다. AI 에게 가는 글(studio-flow)은 화면 글이 아니라 뺀다.
{
  const { readFileSync } = await import("node:fs");
  const files = ["web/v2/app-studio.ts", "web/v2/app-review.ts", "web/v2/wire-board.ts", "web/v2/builder.ts", "web/v2/app-try-session.ts", "web/v2/app-versions.ts", "web/v2/publish-preview.ts"];
  const dash = [], label = [];
  let seen = 0;
  for (const f of files) {
    const src = readFileSync(join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    for (const m of src.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*?[가-힣](?:\\.|(?!\1)[^\\\n])*?)\1/g)) {
      seen++;
      if (m[2].includes("—")) dash.push(f + ": " + m[2].slice(0, 60));
      if (/지금 할 일/.test(m[2])) label.push(f + ": " + m[2].slice(0, 60));
    }
  }
  check(seen > 300, "M1 배선 — 화면 글자열을 실제로 읽었다", seen);
  check(label.length === 0, "M2 「지금 할 일:」 머리말이 화면 글에 없다(단계 줄 · 둘러보기)", label);
  check(dash.length === 0, "M3 앱빌더 화면 글에 「—」 가 없다(문장은 마침표로 끊는다)", dash);
}

// ══ S 기획 카드 「알림」 줄(#4769 원준 2026-10-17 «알림에 대한 것도 앱 빌딩할 때 전반적으로 설정해야 하는 체계 … 기획 카드에도») ══
{
  const nc = F.parseCard("[[기획카드]]\n이름: 팀 채널\n할 수 있는 것: 올리기 · 답하기 · 찾기\n알림: 나를 언급하면 · 내 스레드에 답이 달리면\n참고한 것: 슬랙\n[[/기획카드]]");
  check(nc && nc.notify === "나를 언급하면 · 내 스레드에 답이 달리면" && nc.ref === "슬랙", "S1 카드의 「알림」 줄을 읽는다(참고한 것과 섞이지 않는다)", nc);
  const pb = F.planBrief("팀 대화", "side");
  check(/\n첫 화면: \n알림: \n참고한 서비스: \n\[\[\/기획카드\]\]/.test(pb) && /알림은 언제 누구에게/.test(pb), "S2 planBrief 틀에 「알림: 」 줄 — 첫 화면 뒤 · 참고한 것 앞", pb);
  const old = F.parseCard("[[기획카드]]\n이름: 옛 앱\n[[/기획카드]]");
  check(old && !old.notify && /\n알림: \n참고한 서비스: \n\[\[\/기획카드\]\]$/.test(F.cardText(old)) && !/undefined/.test(F.cardText(old)), "S3 옛 카드(알림 줄 없음)도 읽히고 cardText 에 빈 알림 줄 · undefined 없음", F.cardText(old));
  check(F.CARD_ROWS.some((r) => r.k === "notify" && r.label === "알림") && F.emptyCard().notify === "", "S4 CARD_ROWS 에 알림 줄 · 빈 카드에도 칸");
  const db = F.draftBrief(nc, "side", "talk");
  check(/permissions\.notifications: true/.test(db) && /app_notify/.test(db) && /\[나 ▸ 알림\]/.test(db) && /#\/open\//.test(db), "S5 draftBrief 가 알림 규칙(권한 선언 · app_notify · 앱 안 설정 · 전체 on/off 는 라이블리)을 싣는다", db);
}

// ══ N 단계 바 — 와 본 곳이면 앞으로도 간다(#4632 원준 2026-10-19 «다 저장했었으면 이전으로 가는거 말고 다음으로 가는것도 · 상단 탭을 클릭하는 방향으로도») ══
//  사양 표 N(스크래치패드 spec-side-foot-phone.md 사양 2). 이게 틀리면 ①로 돌아간 뒤 ③으로 다시 갈 길이 «이 내용으로 다시 기획»(AI 에게 다시 시키기)뿐이다.
{
  const has = typeof F.reachedOf === "function" && typeof F.stageTabs === "function" && typeof F.nextStageOpen === "function";
  check(has, "N0 단계 바 규칙(reachedOf · stageTabs · nextStageOpen)이 있다");
  if (has) {
    const R = F.reachedOf;
    check(R({ stage: "plan" }) === 1 && R({ stage: "fix", appId: "a" }) === 2 && R({ stage: "plan", appId: "a" }) === 2 && R({ stage: "put", done: true }) === 4 && R({ stage: "draft" }) === 2,
      "N1 옛 기록(reached 없음) — 지금 단계 · 앱이 있으면 ③ · 넣었으면 ⑤ · 첫 판 기다림(draft)은 ③", [R({ stage: "plan" }), R({ stage: "fix", appId: "a" }), R({ stage: "put", done: true }), R({ stage: "draft" })]);
    check(R({ stage: "plan", reached: 3 }) === 3 && R({ stage: "plan", reached: 9 }) === 4 && R({ stage: "check", reached: -1 }) === 3 && R({ stage: "check", reached: NaN }) === 3 && R({ stage: "check", reached: 0 }) === 3 && R({ stage: "plan", reached: 2.7 }) === 2,
      "N2 와 본 끝 — 적힌 값 · 끝(⑤)에서 자른다 · 틀린 값(음수 · NaN)은 버린다 · 지금 단계보다 작으면 지금 단계", [R({ stage: "plan", reached: 9 }), R({ stage: "check", reached: -1 }), R({ stage: "check", reached: 0 })]);
    const T = (c, r, m) => F.stageTabs(c, r, m).join(",");
    check(T(2, 3, "new") === "back,back,on,ahead,todo" && T(0, 2, "new") === "on,ahead,ahead,todo,todo" && T(2, 4, "copy") === "done,done,on,ahead,ahead" && T(4, 4, "new") === "back,back,back,back,on" && T(1, 1, "new") === "back,on,todo,todo,todo",
      "N3 칸마다 — 지난 곳 돌아가기 · 와 본 앞 곳 다시 가기 · 아직 안 간 곳은 못 누른다 · 사본 · 고치기의 ①②는 원본의 것", [T(2, 3, "new"), T(0, 2, "new"), T(2, 4, "copy")]);
    const N = F.nextStageOpen;
    check(N(0, 0, "new") === -1 && N(0, 2, "new") === 1 && N(1, 2, "new") === 2 && N(4, 4, "new") === -1 && N(2, 2, "new") === -1 && N(2, 3, "edit") === 3 && N(1, 4, "copy") === 2,
      "N4 「다음 →」 — 바로 다음이 와 본 곳일 때만 · 끝 단계엔 없다", [N(0, 0, "new"), N(1, 2, "new"), N(2, 2, "new"), N(2, 3, "edit")]);
  }
}

// ══ S 기다리던 AI 일이 멈췄나(원준 2026-10-26 «초안을 만들고 있어요(시작하는 중)에서 진전이 안 된다» — 세션이 돌던 노트북이 잠들어 턴이 끝났다) ══
{
  const RS = F.runStall || (() => "없음"), RB = F.resumeBrief || (() => "");
  const T = [
    [null, "ended", "S1 세션 줄이 없다 → 세션이 꺼짐"],
    [{ agentState: "offline", node: { online: false } }, "offline", "S2 세션이 돌던 컴퓨터가 꺼짐(잠듦)"],
    [{ agentState: "busy", working: true, node: { online: false } }, "offline", "S2 컴퓨터가 꺼졌으면 옛 «도는 중» 신호보다 먼저"],
    [{ restorable: true, agentState: "offline" }, "ended", "S3 되살릴 수 있는 줄 → 세션이 꺼짐"],
    [{ agentState: "waiting", awaiting: true }, "ask", "S4 확인을 기다림"],
    [{ agentState: "idle", awaiting: true }, "ask", "S4 awaiting 만 있어도"],
    [{ agentState: "offline", working: true }, null, "S5 도는 중(working) — 아무도 안 봐서 offline 이어도"],
    [{ agentState: "idle", background: true }, null, "S5 백그라운드 작업이 남음"],
    [{ agentState: "busy" }, null, "S5 agentState busy"],
    [{ agentState: "idle" }, "idle", "S6 턴이 끝났는데 결과가 없음"],
    [{ agentState: "offline", node: { online: true } }, "idle", "S6 탭에 안 열린 채 끝남"],
    [{ agentState: "offline", observed: false }, null, "S7 지어낸 줄 — 모르면 멈췄다 하지 않는다"],
  ];
  for (const [row, want, what] of T) check(RS(row) === want, what, { row, got: RS(row) });
  check(F.STALL_MS === 30000, "S8 멈춤이 30초 이어져야 말한다", F.STALL_MS);
  const d = RB("draft"), fx = RB("fix"), pl = RB("plan"), ck = RB("check");
  check(/이어서/.test(d) && /\[\[걸음 n\/4\]\]/.test(d) && /app_save/.test(d), "S9 초안 이어서 — 걸음 표식 · app_save 를 다시 일러 준다", d);
  check(/새 버전/.test(fx) && /app_save/.test(fx) && /기획 카드/.test(pl) && /\[\[대조\]\]/.test(ck), "S9 고침 · 기획 · 대조 이어서 — 저마다 화면이 읽는 꼴을 다시 일러 준다", [fx, pl, ck]);
}

// ══ I ④ 아이콘(원준 2026-10-28 «자동으로 만들어진 디자인 사항 · 아이콘 커스텀하는 창 · AI한테 그 아이콘 수정할 수 있는 창») ══
//  AI 가 [[아이콘]] 한 줄로 보낸 그림을 서버가 받는 꼴(path: SVG 명령 · 숫자 · 구분자 1~2000자 · 색 #RRGGBB)일 때만 받는다 — 틀린 것을 받으면 마무리 저장이 400 으로 막힌다.
{
  const PI = F.parseIcon || (() => "없음"), IS = F.iconSpec || (() => "없음"), IB = F.iconBrief || (() => "");
  const a = PI("네.\n[[아이콘]] path: M4 6h16 M4 12h10 | color: #118E6E | dark: #16B48C\n고르세요");
  check(a && a.path === "M4 6h16 M4 12h10" && a.color === "#118E6E" && a.color_dark === "#16B48C", "I1 [[아이콘]] 한 줄을 읽는다(앞뒤 말 무시)", a);
  const b = PI("[[아이콘]] path: M1 1 | color: #111111 | dark: #222222\n고쳤어요\n[[아이콘]] path: \"M2 2l3 3\" | color: #2D6BF0 | dark: #739DF5");
  check(b && b.path === "M2 2l3 3" && b.color === "#2D6BF0", "I2 여럿이면 마지막 · I3 따옴표는 뗀다", b);
  check(PI("[[아이콘]] path: <path d=M1 1/> | color: #111111 | dark: #222222") === null && PI("[[아이콘]] path: circle 12 | color: #111111") === null, "I4 path 에 허용 밖 글자면 버린다");
  check(PI("[[아이콘]] path: M1 1 | color: red | dark: #222222") === null && PI("[[아이콘]] path: M1 1 | color: #11111 | dark: #222222") === null, "I5 색이 #RRGGBB 가 아니면 버린다");
  const c = PI("[[아이콘]] path: M1 1 | color: #111111 | dark: blue");
  check(c && c.color === "#111111" && !("color_dark" in c), "I6 다크 색만 틀리면 그것만 뺀다", c);
  check(PI("아이콘을 그렸어요. path: M1 1 | color: #111111") === null && PI("") === null, "I7 표식이 없으면 null");
  check(PI("[[아이콘]] path:  | color: #111111 | dark: #222222") === null, "I8 path 가 비면 null");
  check(IS(null) === null && IS("M1 1") === null && IS({ path: "M1 1", color: "#ABCDEF", color_dark: "#000000" })?.color_dark === "#000000", "I9 iconSpec — 객체가 아니면 null · 맞으면 그대로");
  const long = (n) => "M" + "1".repeat(n - 1);
  check(IS({ path: long(2000), color: "#111111" }) !== null && IS({ path: long(2001), color: "#111111" }) === null, "I10 path 2000자는 받고 2001자는 버린다(서버 상한)");
  const ib = IB("회의록", "meeting-notes", "마이크와 메모지", { path: "M7 7h3", color: "#111111" });
  check(/meeting-notes/.test(ib) && /마이크와 메모지/.test(ib) && /M7 7h3/.test(ib) && /app_save 하지 마/.test(ib) && /\[\[아이콘\]\] path: .* \| color: #RRGGBB \| dark: #RRGGBB/.test(ib), "I11 iconBrief — 원하는 그림 · 지금 그림 · 앱은 저장 말고 [[아이콘]] 한 줄로", ib);
  const ib2 = IB("회의록", "meeting-notes", "   ", null);
  check(/앱이 하는 일/.test(ib2) && !/지금 아이콘/.test(ib2) && !/원하는 그림/.test(ib2), "I12 원하는 그림이 비고 지금 아이콘이 없으면 앱이 하는 일로", ib2);
  const db = F.draftBrief({ name: "회의록", who: "", items: "", can: ["a"], not: "", first: "" }, "both", "mn");
  check(/"icon": \{"path"/.test(db) && /"color"/.test(db) && /"color_dark"/.test(db), "I13 첫 판을 청하는 글이 아이콘도 그리라고 한다", db.slice(-400));
}

// ══ L 답 글이 «사용 한도에 걸렸다» 는 하네스 알림인가(원준 2026-10-28 — 고침을 받자마자 한도로 끝났는데 화면은 «멈췄어요» 만 말했다) ══
{
  const PL = F.parseLimit || (() => "없음");
  const T = [
    ["You've hit your weekly limit · resets 9am (Asia/Seoul)", "이번 주 AI 사용 한도에 걸려 멈췄어요. 오전 9시에 풀려요.", "L1 주간 한도 · 풀리는 때"],
    ["You\u2019ve hit your limit · resets 2:30pm (Asia/Seoul)", "AI 사용 한도에 걸려 멈췄어요. 오후 2시 30분에 풀려요.", "L2 굽은 따옴표 · 분까지"],
    ["You've hit your weekly limit · resets Nov 3, 12am (Asia/Seoul)", "이번 주 AI 사용 한도에 걸려 멈췄어요. 11월 3일 오전 12시에 풀려요.", "L3 날짜가 붙은 때"],
    ["Claude AI usage limit reached|1761613200", "AI 사용 한도에 걸려 멈췄어요.", "L4 옛 꼴 — 때를 못 읽으면 까닭만"],
    ["API 에 rate limit 이 걸리면 백오프하도록 고쳤어요. You've hit your limit 같은 글은 화면에 안 보여요.", null, "L5 AI 가 한도 이야기를 하는 보통 답은 아니다"],
    ["x".repeat(400) + " You've hit your weekly limit", null, "L6 긴 답 속 낱말은 아니다"],
    ["", null, "L7 빈 글"],
  ];
  for (const [t, want, what] of T) check(PL(t) === want, what, { got: PL(t) });
}


// ══ 점검 2-7 · 2-3 · 6-13 · 2-9 · 4-10 · 4-8 (원준 2026-10-29 «다 봤는데 그냥 싹 다 고쳐») — 스크래치패드 spec-forkC-flow.md 의 P · N · T · D · B 행 ══
{
  const V = (no, note) => ({ version_no: no, note });
  const VP = F.verPlan || (() => ({ base: -1, prev: -1 }));
  const vp = [
    [[V(1, "초안 · 회의록"), V(2, "글자를 키웠어요"), V(3, "마무리 · 회의록")], 3, { base: 2, prev: 1 }, "P1 마무리 판 위 — 내용 판은 그 아래 AI 판 · 되돌릴 곳은 그 앞 AI 판"],
    [[V(1, "초안"), V(2, "고침"), V(3, "마무리 · a"), V(4, "마무리 · b")], 4, { base: 2, prev: 1 }, "P2 마무리 판이 겹쳐도 건너뛴다"],
    [[V(1, "초안"), V(2, "고침"), V(3, "고침")], 3, { base: 3, prev: 2 }, "P3 마무리가 없으면 바로 앞 판"],
    [[V(1, "초안")], 1, { base: 1, prev: 0 }, "P4 판 하나 — 되돌릴 곳 없음"],
    [[], 0, { base: 0, prev: 0 }, "P5 판 목록이 비었다"],
    [[V(1, "초안"), V(2, "마무리 · 회의록")], 2, { base: 1, prev: 0 }, "P6 첫 판 위 마무리만 — 되돌릴 AI 판 없음"],
  ];
  for (const [vs, cur, want, what] of vp) { const got = VP(vs, cur); check(got.base === want.base && got.prev === want.prev, what, got); }
  const SN = F.systemNote || (() => null), PN = F.plainNote || ((x) => x);
  check(PN("되돌림 → 3판") === "V3 로 되돌렸어요" && SN("되돌림 → 3판") === true, "N1 되돌림 사건 — 화면 말 · 사람이 한 저장", { t: PN("되돌림 → 3판"), s: SN("되돌림 → 3판") });
  check(PN("5판 공개") === "V5 를 공개했어요" && SN("5판 공개") === true, "N2 공개 사건 — 화면 말 · 사람이 한 저장", { t: PN("5판 공개"), s: SN("5판 공개") });
  check(SN("마무리 · 회의록") === true, "N3 마무리 저장은 AI 고침이 아니다");
  const n4 = PN("1판 — 초안을 만들었어요");
  check(SN("글자를 키웠어요") === false && !/판|—/.test(n4) && /초안/.test(n4), "N4 AI 고침 — 「판」 「—」 없이", n4);
  check(SN("") === false && SN(null) === false && PN(null) === "" && PN("") === "", "N5 빈 note · null — AI 고침 · 빈 글");
  const PNo = F.parseNotify || (() => "없음");
  const t1 = PNo("[[알림]] 알렸어요"), t2 = PNo("[[알림]] 못 했어요: 슬랙이 연결되지 않았어요"), t3 = PNo("알렸어요"), t4 = PNo("앱을 다 만들고 나서 팀에 알렸어요. 그리고 이런 것도 했어요."), t5 = PNo("받았어요");
  check(t1 && t1.ok === true, "T1 [[알림]] 알렸어요 — 굳힌다", t1);
  check(t2 && t2.ok === false && /슬랙/.test(t2.why), "T2 못 했어요 — 까닭", t2);
  check(t3 && t3.ok === true && t4 === null && t5 === null, "T3 표식 없는 「알렸어요」 한 줄은 ok · 긴 답 속 낱말 · 다른 답은 아니다", { t3, t4, t5 });
  const U = (t) => JSON.stringify({ type: "user", message: { role: "user", content: t } });
  const A = (t) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
  const DA = F.draftAsked || (() => null);
  const asked = [U(F.planBrief("회의록", "both")), A("[[기획카드]]\n앱 이름: 회의록\n[[/기획카드]]"), U(F.draftBrief(card, "both", "app-1"))].join("\n");
  check(DA(asked) === true, "D1 사람 글에 초안 청함이 있다");
  check(DA([U(F.planBrief("회의록", "both")), A("카드")].join("\n")) === false && DA("") === false, "D2 기획만 청했거나 기록이 없다 — 아니다");
  const b1 = F.planBrief("회의록을 주제별로", "both", "회의록", card), b2 = F.planBrief("회의록", "both", "회의록");
  check(b1.includes(F.cardText(card)) && /바뀐 점만/.test(b1), "B1 ① 다시 기획 — 지난 카드 전문 + 「바뀐 점만」", b1.slice(-200));
  check(!/지난 기획 카드/.test(b2), "B2 지난 카드가 없으면 그 말도 없다");
}


// ══ 기록 없이 이어 열기 — 세션 기록에서 되짓기(원준 2026-10-29 실제 화면) · S 행 ══
{
  const PA = F.promptAppId || (() => "없음"), FR = F.fixRoundOf || (() => -1), ST = F.sessionTrace || (() => null);
  check(PA(F.fixBrief(3, [], "글자 크게", "both", "app-2csk6w")) === "app-2csk6w" && PA(F.draftBrief(card, "both", "res-9")) === "res-9" && PA(F.editBrief("memo", "메모", "both")) === "memo", "S1 우리 글에서 앱 id — 고침 · 초안(예약 id) · 고치기", [PA(F.fixBrief(3, [], "x", "both", "app-2csk6w")), PA(F.draftBrief(card, "both", "res-9"))]);
  check(PA("회의록 앱을 만들고 싶어") === "" && PA("") === "" && PA(null) === "", "S2 앱 id 가 없는 글 · 빈 글 — 빈 id");
  check(FR(F.fixBrief(4, [], "x", "both", "a1")) === 4 && FR("그냥 고쳐 줘") === 0 && FR(null) === 0, "S3 「N번째 고침이야」 의 N · 없으면 0");
  const U = (t) => JSON.stringify({ type: "user", message: { content: t } });
  const A = (t) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
  const T = (name, input) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
  const full = [U(F.planBrief("회의록", "both")), A(F.cardText(card)), U(F.draftBrief(card, "both", "res-1")),
    T("mcp__lively__app_save", { files: [{ path: "lively-app.json", content: JSON.stringify({ id: "app-2c" }) }] }), U(F.fixBrief(1, [], "x", "both", "app-2c")), U(F.fixBrief(2, [], "y", "both", "app-2c"))].join("\n");
  const tr = ST(full);
  check(tr && tr.card && tr.card.name === card.name && tr.asked === true && tr.appId === "app-2c" && tr.round === 2, "S4 카드 · 초안 청함 · 마지막으로 가리킨 앱(도구 부름 · 고침 글) · 가장 큰 고침 차례", tr);
  const tool = ST([U(F.planBrief("회의록", "both")), T("mcp__lively__app_save", { files: [{ path: "lively-app.json", content: JSON.stringify({ id: "memo-1" }) }] })].join("\n"));
  check(tool && tool.appId === "memo-1" && tool.card === null && tool.asked === false && tool.round === 0, "S5 AI 의 app_save 만 있어도", tool);
  const none = ST("");
  check(none && none.card === null && none.asked === false && none.appId === "" && none.round === 0, "S6 빈 기록 — 아무것도 없다", none);
  const bad = ST([T("mcp__lively__app_save", { files: [{ path: "lively-app.json", content: "{깨짐" }] }), T("mcp__lively__app_pull", { app_id: "../etc" }), "깨진 줄"].join("\n"));
  check(bad && bad.appId === "", "S7 깨진 매니페스트 · 이상한 id · 깨진 줄은 건너뛴다", bad);
}

// ══ G7 문구 규칙(#4632 원준 2026-10-29 «싹 다 고쳐» — 점검 7-1 · 7-2 · 7-3 · 6-13 후속) ══
{
  const J = typeof F.josa === "function" ? F.josa : () => null;
  const got = [J("「회의록」", "을"), J("「메모」", "을"), J("세션 위젯", "이"), J("둘 다", "이"), J("앱 화면", "으로"), J("「팀 채널」", "으로"), J("메모", "은"), J("V3", "을"), J("V2", "을"), J("V3", "으로"), J("V13", "으로"), J("V7", "으로"), J("R", "으로")];
  check(JSON.stringify(got) === JSON.stringify(["「회의록」을", "「메모」를", "세션 위젯이", "둘 다가", "앱 화면으로", "「팀 채널」로", "메모는", "V3을", "V2를", "V3으로", "V13으로", "V7로", "R로"]),
    "J1 josa — 끝 글자(닫는 「」 넘김) 받침으로 을/를 · 이/가 · 으로/로(ㄹ 은 로) · 은/는 · 숫자는 읽는 소리로", got);
  const VN = typeof F.versionNote === "function" ? F.versionNote : () => null;
  const P = "\uD310";
  const vn = [VN("20" + P + ": 알림을 눌러 들어온 자리로 — 목록이 바로 열려요"), VN("19" + P + " · 글자 크기 키움"), VN("  "), VN(null), VN("되돌림 → 3" + P), VN("마감일 칸 더함")];
  check(JSON.stringify(vn) === JSON.stringify(["알림을 눌러 들어온 자리로. 목록이 바로 열려요", "글자 크기 키움", "", "", "V3 로 되돌렸어요", "마감일 칸 더함"]),
    "V1 versionNote — 머리의 «n판:» · «n판 ·» 는 걷고(줄 앞에 버전 이름이 선다) «—» 는 마침표로 · 빈 글은 빈 글 · 사람 글은 그대로", vn);
  //  C1 — 앱빌더 · 앱 찾기 · 실행할 곳 화면 글에 «—» 와 합니다체가 없다. 주석을 걷은 소스의 따옴표 글(한글이 든 것)만 본다.
  //   AI 에게 가는 글(lib/studio-flow 의 brief)은 화면 글이 아니라 뺐다.
  const { readFileSync } = await import("node:fs");
  const files = ["web/v2/builder.ts", "web/v2/builder-model.ts", "web/v2/app-studio.ts", "web/v2/app-review.ts", "web/v2/wire-board.ts", "web/v2/app-try-session.ts", "web/v2/apps.ts",
    "web/v2/app-spec-page.ts", "web/v2/publish-preview.ts", "web/v2/app-instance.ts", "web/v2/run-prefs.ts", "web/v2/mobile.ts", "web/v2/notify-bell.ts", "web/v2/quick-session.ts", "web/lib/app-menu.ts",
    "web/v2/app-runtime.ts", "web/v2/app-session.ts"];
  const left = [];
  for (const f of files) {
    const src = readFileSync(join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    for (const m of src.matchAll(/'([^'\n]*)'|`([^`]*)`|"([^"\n]*)"/g)) {
      const t = m[1] ?? m[2] ?? m[3] ?? "";
      if (/[가-힣]/.test(t) && (/—/.test(t) || /(습니다|합니다|입니다|됩니다|뜹니다|봅니다|줍니다|엽니다|돕니다)/.test(t))) left.push(f + ": " + t.slice(0, 60));
    }
  }
  check(left.length === 0, "C1 앱빌더 화면 글에 «—» · 합니다체가 없다", left);
}


// ══ 격리 리뷰 #1591 B1 · 6 · 7 — 앱 id 는 우리 글의 머리에서만 · 다시 기획하면 초안 청함은 낡았다 · 나눠 읽어도 같다 ══
{
  const PA = F.promptAppId || (() => "없음"), ST = F.sessionTrace || (() => null), STC = F.sessionTraceChunked || (async () => null);
  const fixC = F.fixBrief(2, [], "이거 app_pull memo 처럼 해줘 (id 12)", "both", "app-2c");
  check(PA(fixC) === "app-2c", "B1a 고침 글의 코멘트 속 app_pull memo · (id 12) 는 안 잡는다 — 머리의 id", PA(fixC));
  check(PA("이거 app_pull memo 처럼 해줘") === "" && PA("나중에 (id 12) 로 바꿔") === "" && PA(F.talkBrief("app_pull memo 처럼", "app-2c", "both", false)) === "", "B1b 머리가 아닌 글(사람 말 · 대화 둘째 말) — 빈 id");
  check(PA(F.talkBrief("글자 크게", "app-2c", "both", true)) === "app-2c" && PA(F.copyBrief("memo-wj", "메모 · 원준", "메모", "sangmin-yoon", "both")) === "memo-wj" && PA(F.checkBrief(card, "app-2c")) === "app-2c", "B1c 대화 첫 말 · 사본 · 대조 글의 머리");
  const U = (t) => JSON.stringify({ type: "user", message: { content: t } });
  const T = (name, input) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
  const pull = ST([U(F.planBrief("회의록", "both")), T("mcp__lively__app_pull", { app_id: "memo-other" })].join("\n"));
  check(pull && pull.appId === "", "B1d AI 의 app_pull(남의 앱 읽기)은 이 만들기의 앱이 아니다", pull);
  const re = ST([U(F.draftBrief(card, "both", "res-1")), U(F.planBrief("회의록 다시", "both"))].join("\n"));
  check(re && re.asked === false, "B6 초안을 청한 뒤 다시 기획을 청했다 — 초안 청함은 낡았다", re);
  const big = Array.from({ length: 4000 }, (_, i) => (i % 3 ? JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(50) }] } }) : U(F.fixBrief(i, [], "x", "both", "app-2c")))).join("\n");
  const a1 = ST(big), a2 = await STC(big, 500);
  check(a2 && JSON.stringify(a1) === JSON.stringify(a2) && a1.round === 3999 && a1.appId === "app-2c", "B7 나눠 읽어도(chunk) 같은 결과", { a1, a2 });
}

console.log(`app-studio-flow: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
