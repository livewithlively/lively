// #4211 Outlook 커넥터 — 순수 변환 계층(네트워크·DB 없음).
//   실행: npm run build && node dist/connectors/outlook.test.js
//   엣지 표(spec F): O1 메일→자료 · O2 HTML/빈 본문 · O3 임시보관·건너뛸 폴더 · O4 첫 쪽 URL · O5 nextLink · O6 보낸 사람 없음
import assert from "node:assert/strict";
import { toRawItem, outlookBodyText, outlookKeep, firstPageUrl, safeNextLink, OUTLOOK_SKIP_FOLDERS, type GraphMessage } from "./outlook.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const msg = (over: Partial<GraphMessage> = {}): GraphMessage => ({
  id: "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AUBtbmmYs1UKu9",
  subject: "  3분기 견적서  ",
  from: { emailAddress: { name: "김철수", address: "Kim@Contoso.COM" } },
  toRecipients: [{ emailAddress: { address: "Me@Contoso.com" } }],
  ccRecipients: [{ emailAddress: { address: "" } }, { emailAddress: { address: "Boss@contoso.com" } }],
  receivedDateTime: "2026-09-20T01:02:03Z",
  sentDateTime: "2026-09-20T01:02:00Z",
  conversationId: "AAQkAGI2TG93AAA=",
  parentFolderId: "INBOX-ID",
  webLink: "https://outlook.office365.com/owa/?ItemID=abc",
  body: { contentType: "text", content: "  견적서 첨부합니다.\n확인 부탁드립니다.  " },
  bodyPreview: "견적서 첨부합니다.",
  isDraft: false,
  internetMessageId: "<abc@contoso.com>",
  hasAttachments: true,
  ...over,
});

t("O1 메일 → 자료 — 출처·작성자(소문자)·제목·본문·시각·채널·대화 묶음, 원본엔 본문을 두 번 두지 않는다", () => {
  const r = toRawItem(msg(), { folderName: "받은 편지함" });
  assert.equal(r.type, "message");
  assert.equal(r.provenance.system, "outlook");
  assert.equal(r.provenance.instance, "default");
  assert.equal(r.provenance.external_id, "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AUBtbmmYs1UKu9");
  assert.equal(r.provenance.external_url, "https://outlook.office365.com/owa/?ItemID=abc");
  assert.deepEqual(r.actor, { external_id: "kim@contoso.com", display_name: "김철수", email: "kim@contoso.com" }, "이메일이 사람 매칭 열쇠다 — 대소문자가 섞이면 같은 사람이 둘이 된다");
  assert.equal(r.title, "3분기 견적서");
  assert.equal(r.body, "견적서 첨부합니다.\n확인 부탁드립니다.");
  assert.equal(r.occurred_at, "2026-09-20T01:02:03Z");
  assert.equal(r.updated_at, "2026-09-20T01:02:03Z", "커서는 받은 시각을 따른다 — 보낸 시각이면 늦게 도착한 메일을 건너뛴다");
  assert.equal(r.container_name, "받은 편지함");
  const f = r.fields as Record<string, unknown>;
  assert.equal(f.thread_ts, "AAQkAGI2TG93AAA=", "증류기가 같은 대화를 한 스레드로 판정하는 열쇠");
  assert.deepEqual(f.to, ["me@contoso.com"]);
  assert.deepEqual(f.cc, ["boss@contoso.com"], "빈 주소는 버린다");
  assert.equal(f.hasAttachments, true);
  assert.ok(!("body" in (r.raw as Record<string, unknown>)), "본문을 원본에 한 벌 더 두면 자료 크기가 두 배다");
  assert.equal((r.raw as Record<string, unknown>).id, msg().id, "원본의 나머지는 보존한다");
  // 폴더 이름을 모르면 채널을 지어내지 않는다
  assert.equal(toRawItem(msg()).container_name, undefined);
  // 대화 id 가 없으면 thread_ts 를 비운다(증류기는 자기 id 로 폴백)
  assert.equal((toRawItem(msg({ conversationId: undefined })).fields as Record<string, unknown>).thread_ts, undefined);
});

t("O2 본문 — HTML 이면 태그를 벗기고, 비어 있으면 미리보기", () => {
  assert.equal(outlookBodyText({ body: { contentType: "html", content: "<html><style>p{}</style><p>안녕&nbsp;하세요</p><br>끝</html>" } }), "안녕 하세요\n\n끝");
  assert.equal(outlookBodyText({ body: { contentType: "HTML", content: "<b>굵게</b>" } }), "굵게", "대소문자 무관");
  assert.equal(outlookBodyText({ body: { contentType: "text", content: "   " }, bodyPreview: " 미리보기 " }), "미리보기");
  assert.equal(outlookBodyText({ body: null, bodyPreview: undefined }), "");
  assert.equal(toRawItem(msg({ body: null, bodyPreview: "" })).body, undefined, "본문이 아예 없으면 빈 문자열이 아니라 없음");
});

t("O3 받지 않는 메일 — 임시 보관함 메일·건너뛸 폴더(지운 편지함·정크)", () => {
  const skip = new Set(["DELETED-ID", "JUNK-ID"]);
  assert.equal(outlookKeep({ isDraft: true, parentFolderId: "INBOX-ID" }, skip), false, "쓰다 만 메일은 자료가 아니다");
  assert.equal(outlookKeep({ isDraft: false, parentFolderId: "DELETED-ID" }, skip), false, "지운 메일이 팀 자료함에 쌓이면 안 된다");
  assert.equal(outlookKeep({ isDraft: false, parentFolderId: "JUNK-ID" }, skip), false);
  assert.equal(outlookKeep({ isDraft: false, parentFolderId: "INBOX-ID" }, skip), true);
  assert.equal(outlookKeep({ isDraft: undefined, parentFolderId: undefined }, skip), true, "모르면 받는다(폴더 정보 없는 메일을 조용히 버리지 않는다)");
  assert.deepEqual([...OUTLOOK_SKIP_FOLDERS].sort(), ["deleteditems", "drafts", "junkemail", "outbox"]);
});

t("O4 첫 쪽 URL — 받은 시각 하한 + 같은 속성 오름차순(Graph InefficientFilter 규칙), 공백은 %20", () => {
  const u = firstPageUrl("2026-09-01T00:00:00+09:00");
  assert.ok(u.startsWith("https://graph.microsoft.com/v1.0/me/messages?"));
  assert.ok(!u.includes("+"), "`+` 는 Graph 가 공백으로 안 읽을 수 있다 — %20 이어야 한다");
  const q = new URL(u).searchParams;
  assert.equal(q.get("$filter"), "receivedDateTime ge 2026-08-31T15:00:00.000Z", "시간대를 UTC 로 바로잡아 넘긴다");
  assert.equal(q.get("$orderby"), "receivedDateTime asc", "오름차순이어야 커서가 끝까지 전진한다");
  assert.ok(Number(q.get("$top")) > 0 && Number(q.get("$top")) <= 100);
  for (const k of ["id", "receivedDateTime", "conversationId", "parentFolderId", "body", "isDraft", "webLink"]) {
    assert.ok((q.get("$select") ?? "").split(",").includes(k), `$select 에 ${k} 가 없다`);
  }
  assert.equal(new URL(firstPageUrl(undefined)).searchParams.get("$filter"), "receivedDateTime ge 1900-01-01T00:00:00Z", "커서가 없으면 전체 — 그래도 $filter 는 있어야 $orderby 가 산다");
  assert.equal(new URL(firstPageUrl("not a date")).searchParams.get("$filter"), "receivedDateTime ge 1900-01-01T00:00:00Z", "깨진 날짜로 요청을 망치지 않는다");
});

t("O5 다음 쪽 — Graph 가 준 주소만 따른다(토큰을 싣고 나가는 요청이다)", () => {
  assert.equal(safeNextLink("https://graph.microsoft.com/v1.0/me/messages?$skip=50"), "https://graph.microsoft.com/v1.0/me/messages?$skip=50");
  assert.equal(safeNextLink("https://evil.example.com/steal"), null);
  assert.equal(safeNextLink("https://graph.microsoft.com.evil.example/x"), null, "접미 위장");
  assert.equal(safeNextLink("not a url"), null);
  assert.equal(safeNextLink(undefined), null, "없으면 끝");
});

t("O6 보낸 사람이 없으면 작성자를 지어내지 않는다", () => {
  assert.equal(toRawItem(msg({ from: null })).actor, undefined);
  assert.equal(toRawItem(msg({ from: { emailAddress: { name: "이름만" } } })).actor, undefined, "이메일 없는 이름은 사람 매칭 열쇠가 못 된다");
});

console.log(`\noutlook tests: ${pass} passed`);
