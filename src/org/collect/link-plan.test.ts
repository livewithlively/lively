// 링크 따라 읽기(#4213 T12 #4744) — 사양 엣지 표 X(링크 풀기) · M(링크 읽기 맞추기) · P(다음 판 지시 줄) · G(연결 제안) 행(순수).
//  거두기(같은 앱 링크 받아들이기)는 link-harvest.test.ts 의 A 행 · 저장 단계·연결 제안은 collect-links.pg-test.mjs.
//
//  엣지 표
//   X1 노션 주소 꼴 셋 → 대시 붙인 소문자 uuid   X2 데이터베이스 보기의 p= → 열어 본 페이지   X3 블록 앵커·대문자
//   X4 슬랙 메시지 주소 → 채널 · ts   X5 thread_ts → 읽을 스레드는 부모   X6 구글 문서·드라이브 파일·폴더·open?id
//   X7 셈만 하는 앱(깃허브·피그마·리니어·아틀라시안·잔디·두레이·네이버웍스·플렉스)   X8 앱이 아닌 주소(일반 웹·회의·달력)
//   X9 슬랙 <주소|글> · 마크다운 [글](주소) · 끝 문장부호   X10 같은 링크 두 번 → 한 번   X11 빈 글   X12 글 하나에 200개 상한
//   M1 노션 — 같은 페이지 링크면 맞음 · planned 가 먼저   M2 슬랙 — 스레드(부모) 또는 메시지 ts 가 같으면 맞음 · 다른 채널은 아님
//   P1 다음 판 지시 줄 — 노션 · 슬랙 · 모양 밖은 null   P2 마지막에 붙는 같은 앱 지시 — 노션·슬랙만 · 없으면 null
//   M3 thread_ts 없이 답글을 가리킨 링크 — 그 스레드에서 본 글 ts 로 맞춘다
import test from "node:test";
import assert from "node:assert/strict";
import {
  LINKS_PER_TEXT, classifyUrl, extractAppLinks, linkKey, matchLinkedRead, plannedLinkInstruction, sameAppLinkInstruction,
  type AppLink,
} from "./link-plan.js";

const HEX = "0123456789abcdef0123456789abcdef";
const UUID = "01234567-89ab-cdef-0123-456789abcdef";

test("X1 노션 주소 꼴 셋 → 대시 붙인 소문자 uuid", () => {
  for (const u of [`https://www.notion.so/acme/Launch-plan-${HEX}`, `https://www.notion.so/${HEX}`, `https://acme.notion.site/Launch-${HEX}`, `https://www.notion.so/acme/${UUID}`]) {
    const l = classifyUrl(u);
    assert.equal(l?.app, "notion", u);
    assert.equal(l?.ref, UUID, u);
    assert.equal(l?.kind, "page");
  }
});

test("X2 데이터베이스 보기의 p= 는 열어 본 페이지 · X3 블록 앵커 무시 · 대문자 hex", () => {
  const db = "fedcba9876543210fedcba9876543210";
  assert.equal(classifyUrl(`https://www.notion.so/acme/Tasks-${db}?v=aaaabbbbccccddddeeeeffff00001111&p=${HEX}&pm=s`)?.ref, UUID, "p 가 이긴다");
  assert.equal(classifyUrl(`https://www.notion.so/acme/Tasks-${db}?v=aaaabbbbccccddddeeeeffff00001111`)?.ref, "fedcba98-7654-3210-fedc-ba9876543210", "p 가 없으면 경로");
  assert.equal(classifyUrl(`https://www.notion.so/acme/T-${HEX.toUpperCase()}#9999aaaabbbbccccddddeeeeffff0000`)?.ref, UUID);
  assert.equal(classifyUrl("https://www.notion.so/acme/settings"), null, "페이지 id 가 없으면 링크가 아니다");
});

test("X4 슬랙 메시지 주소 → 채널 · ts · X5 thread_ts 면 부모 스레드", () => {
  const l = classifyUrl("https://acme.slack.com/archives/C0ABC1234/p1700000000123456");
  assert.deepEqual(l && { app: l.app, ref: l.ref, channel: l.channel, ts: l.ts, thread: l.thread, kind: l.kind },
    { app: "slack", ref: "C0ABC1234:1700000000.123456", channel: "C0ABC1234", ts: "1700000000.123456", thread: "1700000000.123456", kind: "message" });
  const r = classifyUrl("https://acme.slack.com/archives/C0ABC1234/p1700000000123456?thread_ts=1699999999.000100&cid=C0ABC1234");
  assert.equal(r?.thread, "1699999999.000100", "답글 링크는 부모 스레드를 읽는다");
  assert.equal(r?.ts, "1700000000.123456");
  assert.equal(classifyUrl("https://acme.slack.com/archives/C0ABC1234"), null, "채널 주소만은 메시지 링크가 아니다");
  assert.equal(classifyUrl("https://acme.slack.com/archives/x1/p1700000000123456"), null, "채널 id 꼴이 아니면 아니다");
  assert.equal(classifyUrl("https://acme.slack.com/archives/X12345678/p1700000000123456"), null, "대화 id 는 C·G·D 로 시작한다");
});

test("X6 구글 문서 · 드라이브 파일 · 폴더 · open?id", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUv";
  assert.deepEqual([
    classifyUrl(`https://docs.google.com/document/d/${id}/edit#heading=h.x`),
    classifyUrl(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=0`),
    classifyUrl(`https://drive.google.com/file/d/${id}/view?usp=sharing`),
    classifyUrl(`https://drive.google.com/drive/u/1/folders/${id}`),
    classifyUrl(`https://drive.google.com/open?id=${id}`),
  ].map((l) => l && [l.app, l.ref, l.kind]), [
    ["gdrive", id, "document"], ["gdrive", id, "document"], ["gdrive", id, "file"], ["gdrive", id, "folder"], ["gdrive", id, "file"],
  ]);
});

test("X7 셈만 하는 앱 — 이름표 · 대상 = 호스트 + 경로(소문자) · 경로 없는 첫 화면은 아니다", () => {
  const got = [
    "https://github.com/acme/web/pull/12", "https://www.figma.com/file/AbC/Design?node-id=1", "https://linear.app/acme/issue/ENG-1",
    "https://acme.atlassian.net/browse/K-1", "https://acme.jandi.com/app/#!/room/1", "https://acme.dooray.com/project/1",
    "https://works.naver.com/message", "https://flex.team/home",
  ].map((u) => classifyUrl(u)?.app);
  assert.deepEqual(got, ["github", "figma", "linear", "atlassian", "jandi", "dooray", "naverworks", "flex"]);
  assert.equal(classifyUrl("https://github.com/acme/web/pull/12")?.ref, "github.com/acme/web/pull/12");
  assert.equal(classifyUrl("https://github.com/"), null);
});

test("X8 앱이 아닌 주소 — 일반 웹 · 회의 · 달력 · 다른 꼴", () => {
  for (const u of ["https://example.com/a", "https://meet.google.com/abc-defg-hij", "https://zoom.us/j/123", "https://calendar.google.com/x", "ftp://x/y", "not a url"]) {
    assert.equal(classifyUrl(u), null, u);
  }
});

test("X9 글에서 주소 뽑기 — 슬랙 <주소|글> · 마크다운 [글](주소) · 끝 문장부호 · X10 같은 링크는 한 번", () => {
  const text = [
    `계획은 <https://www.notion.so/acme/Plan-${HEX}|여기> 참고.`,
    `[같은 문서](https://www.notion.so/${HEX}) 그리고 https://github.com/acme/web/pull/12).`,
    `슬랙 https://acme.slack.com/archives/C0ABC1234/p1700000000123456, 끝.`,
  ].join("\n");
  const ls = extractAppLinks(text);
  assert.deepEqual(ls.map((l) => [l.app, l.ref]), [["notion", UUID], ["github", "github.com/acme/web/pull/12"], ["slack", "C0ABC1234:1700000000.123456"]]);
  assert.equal(linkKey(ls[0]), `notion\u0001${UUID}`, "같은 링크의 열쇠 = 앱 + 대상");
});

test("X11 빈 글 · null · X12 글 하나에 상한", () => {
  assert.deepEqual(extractAppLinks(""), []);
  assert.deepEqual(extractAppLinks(null), []);
  const many = Array.from({ length: LINKS_PER_TEXT + 50 }, (_, i) => `https://github.com/acme/r/issues/${i}`).join(" ");
  assert.equal(extractAppLinks(many).length, LINKS_PER_TEXT, "앞 상한만큼만 본다");
});

test("M1 노션 — 같은 페이지 링크면 맞음 · planned 가 같은 판 링크보다 먼저", () => {
  const n = classifyUrl(`https://www.notion.so/${HEX}`)!;
  assert.deepEqual(matchLinkedRead({ app: "notion", ref: UUID }, { sameRun: [n], planned: [] }), { link: n, via: "same-run" });
  const p = { ...n, url: "planned" } as AppLink;
  assert.equal(matchLinkedRead({ app: "notion", ref: UUID }, { sameRun: [n], planned: [p] })?.via, "planned");
  assert.equal(matchLinkedRead({ app: "notion", ref: "ffffffff-ffff-ffff-ffff-ffffffffffff" }, { sameRun: [n], planned: [] }), null, "다른 페이지는 아니다");
});

test("M2 슬랙 — 부모 스레드 또는 메시지 ts 가 같으면 맞음 · 다른 채널은 아님", () => {
  const reply = classifyUrl("https://acme.slack.com/archives/C0ABC1234/p1700000000123456?thread_ts=1699999999.000100")!;
  const top = classifyUrl("https://acme.slack.com/archives/C0ABC1234/p1699999999000100")!;
  assert.equal(matchLinkedRead({ app: "slack", channel: "C0ABC1234", thread: "1699999999.000100" }, { sameRun: [reply], planned: [] })?.link, reply, "답글 링크 → 부모 스레드");
  assert.equal(matchLinkedRead({ app: "slack", channel: "C0ABC1234", thread: "1699999999.000100" }, { sameRun: [top], planned: [] })?.link, top, "부모 메시지 링크");
  assert.equal(matchLinkedRead({ app: "slack", channel: "C0ABC1234", thread: "1700000000.123456" }, { sameRun: [reply], planned: [] })?.link, reply,
    "모델이 답글 ts 로 스레드를 이어 읽어도(부모 머리가 없는 쪽) 그 답글 링크로 맞춘다");
  assert.equal(matchLinkedRead({ app: "slack", channel: "C0OTHER99", thread: "1699999999.000100" }, { sameRun: [reply, top], planned: [] }), null);
  assert.equal(matchLinkedRead({ app: "slack", channel: "C0ABC1234", thread: "1600000000.000000" }, { sameRun: [reply, top], planned: [] }), null);
});

test("M3 thread_ts 없이 답글을 가리킨 링크 — 그 스레드에서 본 글 ts 로 맞춘다", () => {
  const bare = classifyUrl("https://acme.slack.com/archives/C0ABC1234/p1700000000123456")!;   // 답글 ts, thread_ts 없음
  assert.equal(matchLinkedRead({ app: "slack", channel: "C0ABC1234", thread: "1699999999.000100" }, { sameRun: [bare], planned: [] }), null, "부모 ts 만으로는 못 맞춘다");
  assert.equal(matchLinkedRead({ app: "slack", channel: "C0ABC1234", thread: "1699999999.000100", tss: ["1699999999.000100", "1700000000.123456"] },
    { sameRun: [bare], planned: [] })?.link, bare, "스레드에서 본 글에 그 ts 가 있으면 맞다");
});

test("P1 다음 판 지시 줄 — 노션 · 슬랙 · 모양 밖은 null", () => {
  assert.equal(plannedLinkInstruction({ app: "notion", ref: UUID }), `· 링크로 찾은 노션 페이지: notion-fetch 를 id="${UUID}" 로 한 번 부른다.`);
  assert.match(plannedLinkInstruction({ app: "slack", ref: "C0ABC1234:1700000000.123456", channel: "C0ABC1234", thread: "1699999999.000100" }) ?? "",
    /slack_read_thread 를 channel_id="C0ABC1234", message_ts="1699999999\.000100"/);
  assert.equal(plannedLinkInstruction({ app: "notion", ref: "drop table" }), null);
  assert.equal(plannedLinkInstruction({ app: "slack", ref: "x", channel: "C0ABC1234\" ; x", thread: "1699999999.000100" }), null, "인자에 들어갈 값은 꼴이 맞아야");
  assert.equal(plannedLinkInstruction({ app: "gdrive", ref: "1AbC" }), null);
});

test("P2 마지막 같은 앱 지시 — 노션·슬랙만 · 없으면 null", () => {
  assert.equal(sameAppLinkInstruction(["gmail"]), null);
  const both = sameAppLinkInstruction(["slack", "notion", "gmail"]) ?? "";
  assert.match(both, /^· 마지막으로/);
  assert.match(both, /notion-fetch/);
  assert.match(both, /slack_read_thread/);
  assert.doesNotMatch(sameAppLinkInstruction(["notion"]) ?? "", /slack_read_thread/);
});
