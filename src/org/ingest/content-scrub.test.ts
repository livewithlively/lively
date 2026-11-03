// @lively-test exclusive — D1·D2 가 시간을 잰다(제곱 비용 회귀를 잡는 상한이라, 병렬 부하에서 재면 흔들린다).
// 수집 가림(#5308) 사양 시험 — 엣지 표의 행마다 단언(행 번호 = 사양의 번호). 값은 전부 지어낸 것이다(실 고객 값 없음).
//  실행: npm run build && node dist/org/ingest/content-scrub.test.js
//
//  사양(요약): 연락처(메일·전화·주민번호·카드)와 비밀번호·비밀값을 «[가림: 종류]» 로 바꾼다. 형식이 강한 것은 문맥 없이,
//   약한 것은 키가 붙을 때만. 설명·자리표시자·환경변수 참조·URL 안의 숫자·뼈대 키는 그대로 둔다. 두 번 돌려도 같다.
//  배선(미러·소급 스윕·이력)은 실 DB 시험 src/v6/mirror/mirror-scrub.pg-test.mjs 가 본다.
import assert from "node:assert/strict";
import {
  scrubText, scrubDeep, minimizeRaw, scrubSnapshot, classifyKey, emptyScrubCounts, totalScrubCounts,
  SCRUB_LABELS, CONTENT_SCRUB_VERSION,
} from "./content-scrub.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const M = SCRUB_LABELS;
const eq = (input: string, want: string): void => assert.equal(scrubText(input), want);
const same = (input: string): void => assert.equal(scrubText(input), input);

// ════════ 연락처 ════════
t("C1 문장 속 메일", () => eq("담당 kim.h@example-shop.co.kr 로 회신", `담당 ${M.email} 로 회신`));
t("C2 mailto 링크는 링크째 한 번", () => eq("[kim@a.io](mailto:kim@a.io) 참고", `${M.email} 참고`));
t("C3 이미지 이름(icon@2x.png)은 메일이 아니다", () => same("![](assets/icon@2x.png) logo@3x.jpg"));
t("C4 휴대폰 하이픈", () => eq("연락: 010-1234-5678.", `연락: ${M.phone}.`));
t("C5 휴대폰 붙여 쓰기", () => eq("번호 01012345678 입니다", `번호 ${M.phone} 입니다`));
t("C6 +82 휴대폰·지역번호", () => {
  eq("+82 10-1234-5678", M.phone);
  eq("본사 +82-2-1234-5678", `본사 ${M.phone}`);
});
t("C7 지역번호(구분자 있음)", () => {
  eq("02-123-4567", M.phone);
  eq("031-123-4567", M.phone);
  eq("(02) 123-4567", M.phone);
  eq("대표 02)123-4567", `대표 ${M.phone}`);
  eq("0505-123-4567", M.phone);
});
t("C8 구분자 없는 지역번호 꼴은 그대로(다른 번호일 수 있다)", () => same("코드 0212345678"));
t("C9 URL 안의 숫자는 식별자 — 전화·카드로 안 본다", () => {
  same("https://acme.slack.com/archives/C0BLJKT7534/p1785377560030869");
  same("https://www.notion.so/01012345678-1a2b3c4d5e6f");
  same("https://x.io/q?n=4532-1234-5678-9014");
});
t("C10 주민번호(하이픈) — 체크섬 없이(2020-10 이후 번호)", () => eq("900101-1234567", M.rrn));
t("C11 하이픈 없는 13자리는 키가 붙을 때만", () => {
  same("9001011234568");
  eq("주민번호 9001011234568", `주민번호 ${M.rrn}`);
  eq("주민등록번호: 900101 - 2234567", `주민등록번호: ${M.rrn}`);
});
t("C12 날짜·타임스탬프·버전·IP 는 그대로", () => same("2026-11-03 1793691764448 v1.2.3 10.0.0.1 2023.01.12 02.12.2026"));
t("C13 카드 — 구분자 + Luhn 만", () => {
  eq("카드 4532-1234-5678-9014", `카드 ${M.card}`);
  same("4532-1234-5678-9015");          // Luhn 실패
  same("4532123456789014");            // 붙여 쓴 16자리 — 식별자와 구분 불가
});
t("C14 국제번호", () => eq("US +1 415-555-1234", `US ${M.phone}`));
t("C15 사업자등록번호는 공개 정보 — 그대로", () => same("사업자 123-45-67890"));
t("C16 키가 붙은 이상한 모양의 전화", () => {
  eq("Tel. 02)1234-5678", `Tel. ${M.phone}`);
  eq("휴대폰: 010 1234 5678 (본인)", `휴대폰: ${M.phone} (본인)`);
  same("Hotel 3 nights");
});

// ════════ 비밀번호 · 비밀값 ════════
t("P1 PW: 값(끝의 !도 값이다)", () => eq("PW: qwer1234!", `PW: ${M.password}`));
t("P2 값 뒤에 붙은 어미·조사는 남는다", () => eq("비밀번호: abc123입니다", `비밀번호: ${M.password}입니다`));
t("P3 비밀번호는 값", () => eq("비밀번호는 qwer1234 입니다", `비밀번호는 ${M.password} 입니다`));
t("P4 구분자 없는 꼴은 숫자·기호가 섞일 때만", () => {
  eq("비번 1234", `비번 ${M.password}`);
  eq("공용 비밀번호 1q2w3e4r! 로 통일", `공용 비밀번호 ${M.password} 로 통일`);
  same("비밀번호 변경 주기는 90일");
  same("비밀번호 reset 링크");
});
t("P5 KEY=값", () => {
  eq("POSTGRES_PASSWORD=s3cr3t", `POSTGRES_PASSWORD=${M.password}`);
  eq("DB_PASS=abc", `DB_PASS=${M.password}`);
  eq("spring.datasource.password = Prod#2024", `spring.datasource.password = ${M.password}`);
});
t("P6 JSON — 따옴표는 남긴다", () => eq('{"password": "p@ss1!"}', `{"password": "${M.password}"}`));
t("P7 YAML 따옴표 안 공백까지", () => eq("password: 'abc 123'", `password: '${M.password}'`));
t("P8 인라인 코드", () => eq("PW: `abc123`", `PW: \`${M.password}\``));
t("P9 자리표시자·환경변수·타입·이미 가린 것은 그대로", () => {
  same("password: ${DB_PASSWORD}");
  same("password=process.env.DB_PW");
  same("password: <비밀번호>");
  same("password: string");
  same("pw: ****");
  same("PW: [REDACTED]");
});
t("P10 낱말 안의 키는 키가 아니다", () => same("password_policy: strict / passport: M1234567 / bypass: on / compass: north"));
t("P11 암호화는 암호가 아니다", () => {
  same("암호화: AES256");
  eq("암호: 1q2w3e", `암호: ${M.password}`);
});
t("P12 비밀값(토큰·키) — 짧은 수는 아니다", () => {
  same("token: 4096");
  eq("api_key: abcd1234efgh5678", `api_key: ${M.secret}`);
  eq("x-api-key: abcdef123456", `x-api-key: ${M.secret}`);
  eq("SECRET_KEY=django-insecure-xyz123", `SECRET_KEY=${M.secret}`);
});
t("P13 접속 문자열 — 비번만, 사용자·호스트는 남긴다", () => {
  eq("postgres://admin:S3cret!@db.example.com:5432/app", `postgres://admin:${M.password}@db.example.com:5432/app`);
  same("postgres://app:${DB_PW}@db:5432/app");
  eq("mongodb+srv://u:p%40ss12@cluster0.x.mongodb.net", `mongodb+srv://u:${M.password}@cluster0.x.mongodb.net`);
});
t("P14 mysql -p 값(붙여 쓴 것만)", () => {
  eq("mysql -h db -u root -pS3cret app", `mysql -h db -u root -p${M.password} app`);
  same("mysql -h db -u root -p");
});
t("P15 --password", () => {
  eq("pg_dump --password=abc123", `pg_dump --password=${M.password}`);
  eq("cli --password abc123 --verbose", `cli --password ${M.password} --verbose`);
});
t("P16 sshpass -p", () => eq("sshpass -p 'abc123' ssh u@h", `sshpass -p '${M.password}' ssh u@h`));
t("P17 curl -u", () => eq("curl -u user:abc123 https://api.x.io", `curl -u user:${M.password} https://api.x.io`));
t("P18 Authorization: Basic", () => eq("Authorization: Basic dXNlcjpwYXNz", `Authorization: Basic ${M.secret}`));
t("P19 XML", () => eq("<password>abc123</password>", `<password>${M.password}</password>`));
t("P20 ID/PW 짝 — 비번만", () => {
  eq("ID/PW: admin / pass1234", `ID/PW: admin / ${M.password}`);
  eq("ID/PW: pass1234", `ID/PW: ${M.password}`);
});
t("P21 계정: 메일 / 비번", () => eq("계정: kim@x.io / qwer1234", `계정: ${M.email} / ${M.password}`));
t("P22 URL 쿼리의 token=값 — 다음 매개변수는 남긴다", () =>
  eq("https://x.io/book?token=abcdef1234567890&x=1", `https://x.io/book?token=${M.secret}&x=1`));
t("P23 시험 결과(Pass: 12 · Pass: OK)는 비밀번호가 아니다", () => same("Pass: 12, Fail: 3, Pass: OK"));
t("P24 카멜 키", () => {
  eq('userPassword: "abc123"', `userPassword: "${M.password}"`);
  eq("apiKey: 'abcdefgh1234'", `apiKey: '${M.secret}'`);
});
t("P25 다음 줄 첫 낱말을 값으로 읽지 않는다", () => same("Password:\nSome heading"));

// ════════ 표 ════════
t("T1 노션 속성 표 — 키 칸이 종류를 말한다", () => {
  const md = ["| 속성 | 값 |", "| --- | --- |", "| 비밀번호 | qwer1234 |", "| 이메일 | a@b.co |", "| 연락처 | 010 1234 5678 |", "| 회사 | 예시상사 |"].join("\n");
  const want = ["| 속성 | 값 |", "| --- | --- |", `| 비밀번호 | ${M.password} |`, `| 이메일 | ${M.email} |`, `| 연락처 | ${M.phone} |`, "| 회사 | 예시상사 |"].join("\n");
  eq(md, want);
});
t("T2 계정 표 — 머리 칸으로 열을 가린다(아이디는 남긴다)", () => {
  const md = ["| 서비스 | 아이디 | 비밀번호 |", "| --- | --- | --- |", "| 인스타 | brand_official | Insta#2024 |", "| AWS | admin | 1q2w3e4r |"].join("\n");
  const want = ["| 서비스 | 아이디 | 비밀번호 |", "| --- | --- | --- |", `| 인스타 | brand_official | ${M.password} |`, `| AWS | admin | ${M.password} |`].join("\n");
  eq(md, want);
});
t("T3 전화 열 — 형식이 제멋대로여도(7자리 미만은 번호가 아니다)", () => {
  const md = ["| 이름 | 전화 |", "| --- | --- |", "| 홍길동 | +82 10 1234 5678 |", "| 김철수 | 1588 |"].join("\n");
  const want = ["| 이름 | 전화 |", "| --- | --- |", `| 홍길동 | ${M.phone} |`, "| 김철수 | 1588 |"].join("\n");
  eq(md, want);
});
t("T4 비밀번호 칸의 한글 메모는 남긴다", () => {
  const md = ["| 계정 | PW |", "| --- | --- |", "| 공용 | abc123 (변경됨) |"].join("\n");
  eq(md, ["| 계정 | PW |", "| --- | --- |", `| 공용 | ${M.password} (변경됨) |`].join("\n"));
});
t("T5 머리 줄·구분 줄은 값이 아니다", () => same(["| PW | 비고 |", "| --- | --- |"].join("\n")));
t("T6 스키마 표(password | string | 설명)는 그대로", () =>
  same(["| 필드 | 타입 | 설명 |", "| --- | --- | --- |", "| password | string | 사용자 비밀번호 |"].join("\n")));

// ════════ 성질 · 경계 ════════
const COMPOSITE = [
  "고객 kim@x.io 010-1234-5678 / 900101-1234567 / 카드 4532-1234-5678-9014",
  "PW: qwer1234! · postgres://a:b1c2d3@h/db · mysql -u r -pzz99zz",
  "| 서비스 | 비밀번호 |", "| --- | --- |", "| 인스타 | Insta#2024 |",
].join("\n");
t("I1 두 번 돌려도 같다(가림 표시는 어떤 탐지기에도 안 걸린다)", () => {
  const once = scrubText(COMPOSITE);
  assert.notEqual(once, COMPOSITE);
  assert.equal(scrubText(once), once);
  for (const k of Object.keys(M) as Array<keyof typeof M>) assert.equal(scrubText(M[k]), M[k]);
});
t("K1 종류별 건수", () => {
  const c = emptyScrubCounts();
  scrubText(COMPOSITE, c);
  assert.deepEqual(c, { email: 1, phone: 1, rrn: 1, card: 1, password: 4, secret: 0 });
  assert.equal(totalScrubCounts(c), 8);
});
t("B1 경계 — 비번 1자/2자 · 숫자 3자/4자 · 비밀값 7자/8자 · 전화 칸 6자리/7자리", () => {
  same("PW: a");
  eq("PW: ab", `PW: ${M.password}`);
  same("PW: 123");
  eq("PW: 1234", `PW: ${M.password}`);
  same("api_key: abcdefg");
  eq("api_key: abcdefgh", `api_key: ${M.secret}`);
  const tbl = (v: string): string => ["| 이름 | 연락처 |", "| --- | --- |", `| 갑 | ${v} |`].join("\n");
  same(tbl("12-3456"));
  eq(tbl("123-4567"), tbl(M.phone));
});
t("E1 빈 글·문자열 아님은 그대로", () => {
  assert.equal(scrubText(""), "");
  assert.equal(scrubText(undefined as unknown as string), undefined);
  assert.equal(scrubDeep(null), null);
  assert.equal(scrubDeep(42), 42);
});
t("V1 규칙 판은 양의 정수", () => assert.ok(Number.isInteger(CONTENT_SCRUB_VERSION) && CONTENT_SCRUB_VERSION >= 1));

// ════════ 키 분류 ════════
t("L1 키 분류", () => {
  assert.equal(classifyKey("DB_PASSWORD"), "password");
  assert.equal(classifyKey("userPassword"), "password");
  assert.equal(classifyKey("계정 비밀번호"), "password");
  assert.equal(classifyKey("ID/PW"), "password");
  assert.equal(classifyKey("x-api-key"), "secret");
  assert.equal(classifyKey("담당자 연락처"), "phone");
  assert.equal(classifyKey("고객 이메일"), "email");
  assert.equal(classifyKey("주민등록번호"), "rrn");
  assert.equal(classifyKey("계정"), "account");
  assert.equal(classifyKey("account"), null);              // 영문 API 키 이름은 짝이 아니다
  for (const k of ["passport", "bypass", "암호화", "비밀번호변경", "연락여부", "이메일 수신 동의", "cells", "pinned_to", ""]) assert.equal(classifyKey(k), null, k);
});

// ════════ 구조값 ════════
t("S1 노션 정규화 속성 — 키가 비밀번호면 text·value 를, type 은 남긴다", () => {
  const v = { 비밀번호: { type: "rich_text", text: "`qwer1234`", value: "qwer1234" }, 메모: { type: "rich_text", text: "PW: abc123", value: "PW: abc123" } };
  assert.deepEqual(scrubDeep(v), {
    비밀번호: { type: "rich_text", text: `\`${M.password}\``, value: M.password },
    메모: { type: "rich_text", text: `PW: ${M.password}`, value: `PW: ${M.password}` },
  });
});
t("S2 type=phone_number 는 속성 이름과 무관하게 전화", () => {
  const v = { 담당: { type: "phone_number", text: "+82 10 1234 5678", value: "+82 10 1234 5678", phone_number: "+82 10 1234 5678" } };
  assert.deepEqual(scrubDeep(v), { 담당: { type: "phone_number", text: M.phone, value: M.phone, phone_number: M.phone } });
});
t("S3 뼈대 키(id · 시각)는 건드리지 않는다", () => {
  const v = { id: "010-1234-5678", page_id: "010-1234-5678", last_edited_time: "2026-11-03T00:00:00.000Z", created_at: "x", ts: "1785377560.030869" };
  assert.deepEqual(scrubDeep(v), v);
});
t("S4 메일 키 — TLD 없는 값도", () => assert.deepEqual(scrubDeep({ author_email: "kim@company" }), { author_email: M.email }));
t("S5 배열·중첩 · 입력은 그대로", () => {
  const v = { list: [{ text: "kim@x.io" }, "010-1234-5678", 3, null, true] };
  const before = JSON.stringify(v);
  assert.deepEqual(scrubDeep(v), { list: [{ text: M.email }, M.phone, 3, null, true] });
  assert.equal(JSON.stringify(v), before);
});
t("S6 한국어 «계정» 키만 짝으로 본다", () => {
  assert.deepEqual(scrubDeep({ account: "org/team" }), { account: "org/team" });
  assert.deepEqual(scrubDeep({ 계정: "kim / abc123" }), { 계정: `kim / ${M.password}` });
});

t("S7 뼈대 키라도 값이 메일이면 메일이다(메일함은 보낸 사람 메일을 id 로 쓴다)", () => {
  const v = { author_external_id: "kim@x.io", id: "m-123", labelIds: ["INBOX", "kim@x.io"], internetMessageId: "<CA1@mail.example.com>", thread_ts: "1785.0001" };
  assert.deepEqual(scrubDeep(v), { author_external_id: M.email, id: "m-123", labelIds: ["INBOX", M.email], internetMessageId: M.email, thread_ts: "1785.0001" });
});

// ════════ 원장 줄이기 ════════
t("R1 노션 — 블록·댓글·속성 원문은 빼고 원장 시각은 남긴다(입력 불변)", () => {
  const raw = { page: { id: "p", last_edited_time: "2026-11-01T00:00:00.000Z", properties: { PW: {} } }, blocks: [1], comments: [2], property_items: {} };
  const out = minimizeRaw("notion", raw) as Record<string, unknown>;
  assert.deepEqual(out, { page: { id: "p", last_edited_time: "2026-11-01T00:00:00.000Z" } });
  assert.ok(raw.blocks && raw.page.properties, "입력이 바뀌면 안 된다");
});
t("R2 슬랙 — blocks 만 뺀다", () => assert.deepEqual(minimizeRaw("slack", { text: "hi", blocks: [{}], ts: "1" }), { text: "hi", ts: "1" }));
t("R3 그 밖의 앱·원장 없음은 그대로", () => {
  const r = { a: 1 };
  assert.equal(minimizeRaw("linear", r), r);
  assert.equal(minimizeRaw("notion", null), null);
  assert.deepEqual(minimizeRaw("notion", { database: { id: "d" } }), { database: { id: "d" } });
});

t("R4 지메일 — base64 본문·머리를 담은 payload 는 빼고 식별자·미리보기는 남긴다", () => {
  const raw = { id: "m1", threadId: "t1", labelIds: ["INBOX"], snippet: "회신 kim@x.io", payload: { headers: [{ name: "From", value: "kim@x.io" }], parts: [{ body: { data: "UFc6IHF3ZXIxMjM0" } }] } };
  assert.deepEqual(minimizeRaw("gmail", raw), { id: "m1", threadId: "t1", labelIds: ["INBOX"], snippet: "회신 kim@x.io" });
  assert.deepEqual(scrubDeep(minimizeRaw("gmail", raw)), { id: "m1", threadId: "t1", labelIds: ["INBOX"], snippet: `회신 ${M.email}` });
});

// ════════ 감사 스냅샷 ════════
t("N1 이력 스냅샷 — 글 칸만 가리고, 바뀐 게 없으면 같은 객체", () => {
  const snap = { name: "notion-x", title: "고객", body_md: "PW: abc123", provenance: "observed" };
  const r = scrubSnapshot(snap);
  assert.equal(r.changed, true);
  assert.deepEqual(r.value, { name: "notion-x", title: "고객", body_md: `PW: ${M.password}`, provenance: "observed" });
  const clean = { title: "회의록", body_md: "안건 정리" };
  const r2 = scrubSnapshot(clean);
  assert.equal(r2.changed, false);
  assert.equal(r2.value, clean);
  assert.deepEqual(scrubSnapshot(null), { value: null, changed: false });
});

// ════════ 시간 상한(ReDoS) ════════
t("D1 적대 입력도 선형에 가깝다(각 1초 미만)", () => {
  const inputs = [
    "a_".repeat(50_000) + "x",
    "a".repeat(200_000) + "@",
    "|".repeat(20_000) + "\n" + "| a ".repeat(5_000) + "|",
    "0".repeat(100_000),
    "PW: " + "x".repeat(100_000),
    ("비밀번호 " + "가".repeat(10)).repeat(5_000),
    "postgres://" + "a".repeat(50_000) + ":" + "b".repeat(50_000),
    "010-".repeat(30_000),
  ];
  for (const s of inputs) {
    const t0 = Date.now();
    scrubText(s);
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `${ms}ms — ${s.slice(0, 20)}…`);
  }
});

t("D2 일치가 8만 개인 글(고객 명단 내보내기)도 1.5초 미만 — 위치 모음이 제곱으로 커지지 않는다", () => {
  //  실측(맥미니): 이분 탐색 판 ~0.36초 · 선형 스캔 판 ~2.8초 — 상한은 그 사이다(옛 판은 여기서 빨개진다).
  const rows = Array.from({ length: 40_000 }, (_, i) => `| 고객${i} | u${i}@ex.com | 010-1234-${String(i % 10_000).padStart(4, "0")} |`);
  const big = ["| 이름 | 메일 | 전화 |", "| --- | --- | --- |", ...rows].join("\n");
  const c = emptyScrubCounts();
  const t0 = Date.now();
  const out = scrubText(big, c);
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `${ms}ms`);
  assert.equal(c.email + c.phone, 80_000);
  assert.ok(!out.includes("@ex.com") && !out.includes("010-1234-"));
});

console.log(`\ncontent-scrub: ${pass} ok`);
