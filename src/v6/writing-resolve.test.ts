// 홈 경로 정규화·시간 표현 줄 추출·시간 앵커·허용 날짜·안내 문구와 재작성 게이트의 날짜·홈 경로 예외를 사양대로 잠근다.
// 실행: 빌드 후 node dist/v6/writing-resolve.test.js
import assert from "node:assert/strict";
import {
  normalizeHomePaths, countHomePaths, normalizeHomePathsCounted, changedLineFilter, timeReferenceLines, timeAnchors, allowedAnchorDates, anchorHint, dateIn, shiftDate,
  type TimeAnchor,
} from "./writing-resolve.js";
import { checkInvariants } from "./writing-rewrite-gate.js";
import { lintWriting } from "./writing-lint.js";
import { resolveWritingFormat } from "../org/policies/writing-format.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>) => { await fn(); pass++; console.log(`ok  ${name}`); };

const fmt = resolveWritingFormat({ enabled: true });
const TITLE = "결제 재시도 정책";
const doc = (body_md: string) => ({ title: TITLE, body_md });
const kinds = (vs: Array<{ kind: string }>) => vs.map((v) => v.kind);
const anchor = (rules: TimeAnchor["rules"], basis: TimeAnchor["basis"], date: string) =>
  ({ line: "오늘 배포했다.", rules, date, basis }) as TimeAnchor;

const NOW = new Date("2026-11-24T16:30:00Z");
const SEOUL = "Asia/Seoul";

await t("A /Users/<계정>/ 접두는 $HOME 으로 바뀌고 뒤 경로는 그대로다", () => {
  for (const [input, want] of [
    ["설정은 /Users/bob/app.conf 에 둔다.", "설정은 $HOME/app.conf 에 둔다."],
    ["/Users/john.doe_1-x/a/b.txt", "$HOME/a/b.txt"],
    ["경로 /Users/Bob99/work/my-app/src/index.ts 를 본다.", "경로 $HOME/work/my-app/src/index.ts 를 본다."],
  ]) assert.equal(normalizeHomePaths(input), want, input);
});

await t("A 계정 뒤에 하위 경로가 없는 /Users/<x> 는 그대로 — API 경로의 id·문장 끝과 구별할 수 없다", () => {
  for (const s of ["홈은 /Users/bob 이다.", "/Users/bob", "경로는 /Users/carol.", "GET /Users/2819c223-7f76 로 조회", "`GET /Users/me`"]) {
    assert.equal(normalizeHomePaths(s), s, s);
    assert.ok(!lintWriting({ title: "제목", body_md: `결론이다.\n${s}` }, fmt, "knowledge").some((f) => f.rule === "local_path"), `lint 도 잡지 않는다: ${s}`);
  }
});

await t("A /Users/Shared 공용 폴더는 그대로", () => {
  const s = "공용 파일은 /Users/Shared/team/a.txt 에 있다.";
  assert.equal(normalizeHomePaths(s), s);
});

await t("A ~/ 는 바꾸지 않는다 — 탐지가 위반으로 보지 않는 관례 표기다(셸 밖에서는 $HOME 과 뜻이 다르다)", () => {
  for (const s of [
    "~/work/a.conf 에 둔다.",
    "설정은 `~/.ssh/config` 에 둔다.",
    "```\nIdentityFile ~/.ssh/id_ed25519\n```",
    "설정 파일을 둔다(~/work/a.conf).",
  ]) {
    assert.equal(normalizeHomePaths(s), s, s);
    assert.equal(countHomePaths(s), 0, s);
  }
});

await t("A 단어 중간·따옴표 바로 뒤·URL 경로 안의 ~/ 는 그대로", () => {
  for (const s of [
    "값은 a~/b 이다.",
    "설정은 \"~/x\" 로 적는다.",
    "문서는 https://h/~/a 에 있다.",
  ]) assert.equal(normalizeHomePaths(s), s, s);
});

await t("A 홈 경로가 아닌 «/Users/»·«~/» 는 그대로 — API·URL·저장소 경로, 어림 표기, 공용 Windows 폴더", () => {
  for (const s of [
    "GET /scim/v2/Users/2819c223 로 조회한다.",
    "저장소는 https://gitlab.example.com/Users/alice/repo 다.",
    "원본은 s3://bucket/Users/bob/x.csv 에 있다.",
    "용량은 약 ~/day 로 는다.",
    "문서는 C:\\Users\\Public\\Docs 에 있다.",
    "기본 프로필은 C:\\Users\\Default\\AppData 다.",
    "공용 폴더 C:\\Users\\Public 을 쓴다.",
    "형식은 C:\\Users\\<계정>\\ 처럼 적는다.",
  ]) {
    assert.equal(normalizeHomePaths(s), s, s);
    assert.ok(!lintWriting({ title: "제목", body_md: `결론이다.\n${s}` }, fmt, "knowledge").some((f) => f.rule === "local_path"), `lint 도 잡지 않는다: ${s}`);
  }
});

await t("A Windows C:\\Users\\<계정>\\ 는 %USERPROFILE%\\ 로", () => {
  assert.equal(
    normalizeHomePaths("설정은 C:\\Users\\bob\\app\\a.conf 에 둔다."),
    "설정은 %USERPROFILE%\\app\\a.conf 에 둔다.",
  );
  const spaced = "문서는 C:\\Users\\John Doe\\Docs\\a.txt 에 있다.";
  assert.equal(normalizeHomePaths(spaced), "문서는 %USERPROFILE%\\Docs\\a.txt 에 있다.", "계정 이름에 공백이 있어도 바꾼다");
  assert.ok(lintWriting({ title: "제목", body_md: `결론이다.\n${spaced}` }, fmt, "knowledge").some((f) => f.rule === "local_path"), "lint 도 같은 자리를 잡는다");
});

await t("A 코드 펜스 안·URL 안의 홈 경로는 바꾸지 않는다 — 로그·설정 파일·PowerShell·주소는 $HOME 이 풀리지 않는 글자 그대로다", () => {
  for (const s of [
    "설정은 아래와 같다.\n\n```\ncat /Users/bob/app.conf\n```",
    "설정은 아래와 같다.\n\n~~~json\n{ \"path\": \"/Users/bob/app\" }\n~~~",
    "```powershell\nSet-Location C:\\Users\\bob\\proj\n```",
    "주소는 https://example.com/open?file=/Users/bob/a.txt 다.",
  ]) {
    assert.equal(normalizeHomePaths(s), s, s);
    assert.equal(countHomePaths(s), 0, s);
  }
  // 펜스 밖은 그대로 바꾼다 — 같은 글 안에서도 펜스 안만 남는다.
  const mixed = "경로는 /Users/bob/a.txt 다.\n\n```\ncat /Users/bob/a.txt\n```\n\n다시 /Users/bob/b.txt 를 본다.";
  assert.equal(normalizeHomePaths(mixed), "경로는 $HOME/a.txt 다.\n\n```\ncat /Users/bob/a.txt\n```\n\n다시 $HOME/b.txt 를 본다.");
  assert.equal(countHomePaths(mixed), 2);
});

await t("A 한 글에 같은 계열(맥·윈도)의 계정이 둘 이상이면 그 계열은 바꾸지 않는다 — 다른 사람 경로가 같은 $HOME 으로 합쳐지지 않게", () => {
  const two = "복사는 /Users/alice/data/a.csv 에서 /Users/bob/data/a.csv 로 한다.";
  assert.equal(normalizeHomePaths(two), two);
  assert.equal(countHomePaths(two), 0);
  // 같은 계정이 여러 번이면 바꾼다(대소문자는 같은 계정으로 본다).
  assert.equal(normalizeHomePaths("/Users/bob/a.txt 와 /Users/Bob/b.txt"), "$HOME/a.txt 와 $HOME/b.txt");
  // 계열은 따로 본다 — 맥 계정이 둘이어도 윈도 계정이 하나면 윈도 쪽은 바꾼다.
  assert.equal(normalizeHomePaths(`${two} 윈도는 C:\\Users\\bob\\x.txt 다.`), `${two} 윈도는 %USERPROFILE%\\x.txt 다.`);
});

await t("A 탐지가 공용 폴더로 보는 «/Users/Shared…» 는 바꾸지 않는다 — 탐지(LOCAL_PATH_RE)와 같은 경계", () => {
  const s = "옛 공용 폴더는 /Users/Shared.bak/team/a.txt 에 있다.";
  assert.ok(!lintWriting({ title: "제목", body_md: `결론이다.\n${s}` }, fmt, "knowledge").some((f) => f.rule === "local_path"), "탐지는 잡지 않는다");
  assert.equal(normalizeHomePaths(s), s, "탐지가 잡지 않는 자리를 바꾸지 않는다");
});

await t("A 줄 선택 — touch 가 참인 줄만 바꾸고, changedLineFilter 는 원문에 없던 줄만 고른다", () => {
  const before = "옛 줄은 /Users/bob/old.sh 다.\n가운데 줄.";
  const after = "옛 줄은 /Users/bob/old.sh 다.\n가운데 줄.\n새 줄은 /Users/bob/new.sh 다.";
  const r = normalizeHomePathsCounted(after, changedLineFilter(after, before));
  assert.equal(r.text, "옛 줄은 /Users/bob/old.sh 다.\n가운데 줄.\n새 줄은 $HOME/new.sh 다.");
  assert.equal(r.replaced, 1);
  // 원문에 한 번 있던 줄을 두 번 쓰면 두 번째는 새 줄이다(다중집합).
  const dup = "옛 줄은 /Users/bob/old.sh 다.\n옛 줄은 /Users/bob/old.sh 다.";
  assert.equal(normalizeHomePaths(dup, changedLineFilter(dup, before)), "옛 줄은 /Users/bob/old.sh 다.\n옛 줄은 $HOME/old.sh 다.");
});

await t("A /home/<계정>/ 은 바꾸지 않는다", () => {
  const s = "서비스 계정 경로는 /home/deploy/app.conf 이다.";
  assert.equal(normalizeHomePaths(s), s);
});

await t("A 두 번 적용해도 한 번 적용과 같다", () => {
  for (const s of [
    "설정은 /Users/bob/app.conf 에 둔다.",
    "홈은 /Users/bob 이다.",
    "~/work/a.conf 와 (~/b) 와 `~/c` 를 본다.",
    "설정은 C:\\Users\\bob\\a.conf 에 둔다.",
    "a~/b \"~/x\" https://h/~/a /Users/Shared/x /home/deploy/y",
  ]) {
    const once = normalizeHomePaths(s);
    assert.equal(normalizeHomePaths(once), once, s);
  }
});

await t("A 정규화 결과는 /home 이 없으면 local_path 가 나오지 않는다", () => {
  const hasLocalPath = (body: string) =>
    lintWriting({ title: TITLE, body_md: body }, fmt, "knowledge").some((f) => f.rule === "local_path");
  const homeless = [
    "설정 파일은 /Users/bob/app.conf 에 둔다.",
    "",
    "로그는 ~/logs/app.log 에 쌓이고 백업은 (~/backup) 에 둔다.",
    "",
    "윈도에서는 C:\\Users\\bob\\app.conf 를 연다.",
  ].join("\n");
  assert.ok(hasLocalPath(homeless));
  assert.ok(!hasLocalPath(normalizeHomePaths(homeless)));
  // 코드 펜스 안의 경로는 바꾸지 않는다(로그·설정 파일·PowerShell 처럼 $HOME 이 풀리지 않는 글자다) — local_path 로 남아 사람 확인이 된다.
  const fenced = `${homeless}\n\n\`\`\`\ntype C:\\Users\\bob\\app.conf\n\`\`\``;
  assert.ok(hasLocalPath(normalizeHomePaths(fenced)), "펜스 안 경로는 그대로 남는다");
  // /home/<계정>/ 은 바꾸지 않으므로 개인 계정이면 위반으로 남는다(서비스 계정 deploy·ubuntu 등은 탐지가 빼는 관례 위치다).
  assert.ok(hasLocalPath(normalizeHomePaths(`${homeless}\n\n작업 경로는 /home/alice/app.conf 이다.`)));
  assert.ok(!hasLocalPath(normalizeHomePaths(`${homeless}\n\n서버 경로는 /home/deploy/app.conf 이다.`)));
});

await t("B relative_time 낱말마다 그 줄을 relative_time 으로 돌려준다", () => {
  for (const w of ["오늘", "어제", "내일", "그저께", "엊그제", "지난주", "이번 주", "이번주", "다음 주", "다음주", "이번 세션", "지난 세션"]) {
    const line = `${w} 설정을 바꿨다.`;
    assert.deepEqual(timeReferenceLines(`머리 문장이다.\n\n${line}`), [{ line, rules: ["relative_time"] }], w);
  }
});

await t("B '안내일' 의 내일은 relative_time 이 아니다", () => {
  assert.deepEqual(timeReferenceLines("배포 안내일 공지를 보냈다."), []);
});

await t("B undated_status 낱말마다 그 줄을 undated_status 로 돌려준다", () => {
  for (const w of ["아직", "진행 중", "진행중", "대기 중", "대기중", "배포 대기", "머지 대기", "미배포", "미머지", "예정이다", "예정입니다", "예정임"]) {
    const line = `결제 모듈 교체는 ${w} 상태로 둔다.`;
    assert.deepEqual(timeReferenceLines(line), [{ line, rules: ["undated_status"] }], w);
  }
});

await t("B 같은 줄에 YYYY-MM 또는 YYYY-MM-DD 가 있으면 undated_status 가 아니다", () => {
  for (const line of ["결제 모듈 교체는 2026-11-20 기준 진행 중이다.", "결제 모듈 교체는 2026-11 기준 아직이다."]) {
    assert.deepEqual(timeReferenceLines(line), [], line);
  }
});

await t("B relative_time 은 같은 줄에 날짜가 있어도 잡는다", () => {
  const line = "2026-11-20 오늘 배포했다.";
  assert.deepEqual(timeReferenceLines(line), [{ line, rules: ["relative_time"] }]);
});

await t("B 한 줄에 둘 다 있으면 relative_time 먼저 두 규칙 모두", () => {
  const line = "아직 오늘 배포하지 못했다.";
  assert.deepEqual(timeReferenceLines(line), [{ line, rules: ["relative_time", "undated_status"] }]);
});

await t("B 줄은 trim 해 돌려주고 같은 줄은 처음 나온 순서로 한 번만", () => {
  const body = ["머리 문장이다.", "  오늘 배포했다.  ", "설정은 그대로다.", "결제는 아직이다.", "오늘 배포했다."].join("\n");
  assert.deepEqual(timeReferenceLines(body), [
    { line: "오늘 배포했다.", rules: ["relative_time"] },
    { line: "결제는 아직이다.", rules: ["undated_status"] },
  ]);
});

await t("B 펜스 코드·인라인 코드·URL·따옴표·인용줄 안은 빼고 본다", () => {
  for (const body of [
    "```\n오늘 배포했다.\n결제는 아직이다.\n```",
    "~~~\n오늘 배포했다.\n결제는 아직이다.\n~~~",
    "상수 이름은 `오늘` 과 `아직` 이다.",
    "링크는 https://example.com/오늘/아직 이다.",
    "그는 \"오늘 배포\" 라고 말했다.",
    "그는 “오늘 배포” 라고 말했다.",
    "그는 「오늘 배포」 라고 말했다.",
    "그는 『아직 대기 중』 이라고 썼다.",
    "그는 ‘오늘 배포’ 라고 말했다.",
    "> 오늘 배포했고 아직 진행 중이다.",
  ]) assert.deepEqual(timeReferenceLines(body), [], body);
});

await t("C 앵커의 line·rules 는 timeReferenceLines 와 같다", async () => {
  const body = "머리 문장이다.\n오늘 배포했다.\n결제는 아직이다.\n아직 오늘 못 했다.";
  const anchors = await timeAnchors({ body, now: NOW, tz: SEOUL });
  assert.deepEqual(anchors.map((a) => ({ line: a.line, rules: a.rules })), timeReferenceLines(body));
});

await t("C 저장 전 본문에 없던 줄(신규 문서 null 포함)은 this_save·now 의 tz 날짜이고 firstSeen 을 부르지 않는다", async () => {
  for (const beforeBody of ["다른 문장이다.", null]) {
    let calls = 0;
    const anchors = await timeAnchors({
      body: "오늘 배포했다.", beforeBody, now: NOW, tz: SEOUL,
      firstSeen: async () => { calls++; return "2026-01-01T00:00:00Z"; },
    });
    assert.deepEqual(anchors, [{ line: "오늘 배포했다.", rules: ["relative_time"], date: "2026-11-25", basis: "this_save" }], String(beforeBody));
    assert.equal(calls, 0, String(beforeBody));
  }
});

await t("C 읽기 또는 이미 있던 줄은 firstSeen 값으로 first_version·그 시각의 tz 날짜", async () => {
  for (const [beforeBody, seen] of [
    [undefined, "2026-11-10T20:00:00Z"],
    ["머리 문장이다.\n   오늘 배포했다.   ", new Date("2026-11-10T20:00:00Z")],
  ] as Array<[string | undefined, Date | string]>) {
    const asked: string[] = [];
    const anchors = await timeAnchors({
      body: "머리 문장이다.\n오늘 배포했다.", beforeBody, now: NOW, tz: SEOUL,
      firstSeen: async (line: string) => { asked.push(line); return seen; },
    });
    assert.deepEqual(anchors, [{ line: "오늘 배포했다.", rules: ["relative_time"], date: "2026-11-11", basis: "first_version" }], String(beforeBody));
    assert.deepEqual(asked, ["오늘 배포했다."]);
  }
});

await t("C firstSeen 이 null·예외·없음이면 no_later_than·updatedAt 의 tz 날짜", async () => {
  const cases: Array<[string, ((line: string) => Promise<Date | string | null>) | undefined, Date | string]> = [
    ["null", async () => null, new Date("2026-11-20T15:30:00Z")],
    ["예외", async () => { throw new Error("boom"); }, "2026-11-20T15:30:00Z"],
    ["없음", undefined, "2026-11-20T15:30:00Z"],
  ];
  for (const [name, firstSeen, updatedAt] of cases) {
    const anchors = await timeAnchors({ body: "결제는 아직이다.", now: NOW, tz: SEOUL, updatedAt, firstSeen });
    assert.deepEqual(anchors, [{ line: "결제는 아직이다.", rules: ["undated_status"], date: "2026-11-21", basis: "no_later_than" }], name);
  }
});

await t("C updatedAt 이 없으면 no_later_than 날짜는 now 의 tz 날짜", async () => {
  for (const updatedAt of [undefined, null]) {
    const anchors = await timeAnchors({ body: "결제는 아직이다.", now: NOW, tz: SEOUL, updatedAt });
    assert.equal(anchors[0].basis, "no_later_than");
    assert.equal(anchors[0].date, "2026-11-25", String(updatedAt));
  }
});

await t("C firstSeen 은 한 번에 최대 12회, 넘는 줄은 no_later_than", async () => {
  const lines = Array.from({ length: 15 }, (_, i) => `오늘 ${i + 1}번 작업을 했다.`);
  let calls = 0;
  const anchors = await timeAnchors({
    body: lines.join("\n"), now: NOW, tz: SEOUL, updatedAt: "2026-11-20T15:30:00Z",
    firstSeen: async () => { calls++; return "2026-11-10T20:00:00Z"; },
  });
  assert.equal(calls, 12);
  assert.equal(anchors.length, 15);
  assert.deepEqual(anchors.map((a) => a.basis), [...Array(12).fill("first_version"), ...Array(3).fill("no_later_than")]);
  assert.deepEqual(anchors.slice(12).map((a) => a.date), ["2026-11-21", "2026-11-21", "2026-11-21"]);
});

await t("C dateIn 은 tz 달력일, 틀린 tz 는 UTC", () => {
  for (const [tz, want] of [
    [SEOUL, "2026-11-25"],
    ["UTC", "2026-11-24"],
    ["America/Los_Angeles", "2026-11-24"],
    ["Not/AZone", "2026-11-24"],
  ]) assert.equal(dateIn(NOW, tz), want, tz);
});

await t("C shiftDate 는 달·해·윤년 경계를 넘는다", () => {
  for (const [d, n, want] of [
    ["2026-11-24", 0, "2026-11-24"],
    ["2026-11-30", 1, "2026-12-01"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2026-01-01", -2, "2025-12-30"],
    ["2024-02-28", 1, "2024-02-29"],
    ["2023-02-28", 1, "2023-03-01"],
    ["2024-03-01", -1, "2024-02-29"],
  ] as Array<[string, number, string]>) assert.equal(shiftDate(d, n), want, `${d} ${n}`);
});

await t("D relative_time 이고 first_version·this_save 면 date-2·date-1·date·date+1", () => {
  for (const basis of ["first_version", "this_save"] as const) {
    assert.deepEqual(
      [...allowedAnchorDates([anchor(["relative_time"], basis, "2026-12-01")])].sort(),
      ["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"],
      basis,
    );
  }
});

await t("D no_later_than 이거나 relative_time 이 없으면 date 만", () => {
  for (const a of [
    anchor(["relative_time"], "no_later_than", "2026-12-01"),
    anchor(["relative_time", "undated_status"], "no_later_than", "2026-12-01"),
    anchor(["undated_status"], "first_version", "2026-12-01"),
    anchor(["undated_status"], "this_save", "2026-12-01"),
  ]) assert.deepEqual([...allowedAnchorDates([a])], ["2026-12-01"], `${a.rules} ${a.basis}`);
});

await t("D 여러 앵커의 날짜를 합친다(빈 입력은 빈 집합)", () => {
  assert.equal(allowedAnchorDates([]).size, 0);
  assert.deepEqual(
    [...allowedAnchorDates([
      anchor(["undated_status"], "no_later_than", "2026-10-05"),
      anchor(["relative_time"], "this_save", "2026-11-24"),
    ])].sort(),
    ["2026-10-05", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25"],
  );
});

await t("E first_version·this_save 안내는 date·어제 날짜·그대로 둔다 를 담는다", () => {
  for (const basis of ["first_version", "this_save"] as const) {
    const h = anchorHint(anchor(["relative_time"], basis, "2026-12-01"));
    for (const s of ["2026-12-01", "2026-11-30", "그대로 둔다"]) assert.ok(h.includes(s), `${basis}: ${s} 없음 — ${h}`);
  }
});

await t("E no_later_than 안내는 「<date> 이전」 과 그대로 둔다 를 담는다", () => {
  const h = anchorHint(anchor(["undated_status"], "no_later_than", "2026-12-01"));
  for (const s of ["2026-12-01 이전", "그대로 둔다"]) assert.ok(h.includes(s), `${s} 없음 — ${h}`);
});

await t("F allowAddedDates 에 든 날짜가 새로 생긴 것은 숫자 위반이 아니다", () => {
  const vs = checkInvariants(doc("결제 모듈은 오늘 배포했다."), doc("결제 모듈은 2026-11-24 배포했다."),
    { allowAddedDates: new Set(["2026-11-23", "2026-11-24"]) });
  assert.ok(!kinds(vs).includes("invariant:numbers"), JSON.stringify(vs));
});

await t("F 제목 날짜 허용과 기준 날짜 허용을 함께 써서 본문 날짜를 바꿔치기하면 위반이다", () => {
  const before = { title: "배포 2026-10-01 기록", body_md: "배포일은 2026-10-01 이다.\n검증은 아직 안 했다." };
  const after = { title: "배포 2026-10-01 기록", body_md: "배포일은 2026-11-05 이다.\n검증은 아직 안 했다." };
  assert.ok(kinds(checkInvariants(before, after, { allowAddedDates: new Set(["2026-11-05"]) })).includes("invariant:numbers"));
});

await t("F 집합 밖 날짜·옵션 없음·다른 숫자 추가·숫자 변경은 여전히 숫자 위반", () => {
  const allow = { allowAddedDates: new Set(["2026-11-24"]) };
  const cases: Array<[string, string, string, Parameters<typeof checkInvariants>[2]]> = [
    ["집합 밖 날짜", "결제 모듈은 오늘 배포했다.", "결제 모듈은 2026-11-24 배포했다.", { allowAddedDates: new Set(["2026-11-23"]) }],
    ["옵션 없음", "결제 모듈은 오늘 배포했다.", "결제 모듈은 2026-11-24 배포했다.", undefined],
    ["다른 숫자 추가", "결제 모듈은 오늘 배포했다.", "결제 모듈은 2026-11-24 배포했고 재시도는 3회다.", allow],
    ["숫자 변경", "재시도는 5회다. 결제 모듈은 오늘 배포했다.", "재시도는 6회다. 결제 모듈은 2026-11-24 배포했다.", allow],
  ];
  for (const [name, before, after, opts] of cases) {
    assert.ok(kinds(checkInvariants(doc(before), doc(after), opts)).includes("invariant:numbers"), name);
  }
});

await t("F 홈 경로 접두만 바꾼 것은 서술·인라인 코드 안이라도 위반이 아니다", () => {
  for (const [before, after] of [
    ["설정은 /Users/bob/app.conf 에 둔다.", "설정은 $HOME/app.conf 에 둔다."],
    ["설정은 `/Users/bob/app.conf` 에 둔다.", "설정은 `$HOME/app.conf` 에 둔다."],
    ["설정은 `C:\\Users\\bob\\app.conf` 에 둔다.", "설정은 `%USERPROFILE%\\app.conf` 에 둔다."],
  ]) assert.deepEqual(checkInvariants(doc(before), doc(after)), [], before);
});

await t("F 코드 블록 안의 홈 경로를 바꾸면 코드 블록 위반 — 서버도 펜스 안은 바꾸지 않는다(글자 그대로인 로그·설정·명령)", () => {
  for (const [before, after] of [
    ["설정은 아래와 같다.\n\n```\ncat /Users/bob/app.conf\n```", "설정은 아래와 같다.\n\n```\ncat $HOME/app.conf\n```"],
    ["설정은 아래와 같다.\n\n```\ntype C:\\Users\\bob\\app.conf\n```", "설정은 아래와 같다.\n\n```\ntype %USERPROFILE%\\app.conf\n```"],
  ]) assert.ok(kinds(checkInvariants(doc(before), doc(after))).includes("invariant:codeBlocks"), before);
});

await t("F 홈 경로의 계정을 바꾸거나 원문에 없던 계정 경로를 넣으면 위반 — 정규화하면 같아 보여도 다른 사람의 경로다", () => {
  for (const [before, after] of [
    ["설정은 `/Users/alice/app.conf` 에 둔다.", "설정은 `/Users/bob/app.conf` 에 둔다."],
    ["설정은 `$HOME/app.conf` 에 둔다.", "설정은 `/Users/bob/app.conf` 에 둔다."],
    ["설정은 `C:\\Users\\alice\\app.conf` 에 둔다.", "설정은 `C:\\Users\\bob\\app.conf` 에 둔다."],
  ]) assert.ok(kinds(checkInvariants(doc(before), doc(after))).includes("invariant:homePaths"), `${before} → ${after}`);
  // 같은 계정의 경로를 그대로 두는 것은 위반이 아니다.
  assert.deepEqual(checkInvariants(doc("설정은 `/Users/bob/app.conf` 에 둔다."), doc("설정은 `/Users/bob/app.conf` 에 **둔다**.")), []);
});

await t("F 계정이 둘인 글에서 경로를 $HOME 으로 합치면 위반 — 두 경로가 같은 자리처럼 읽힌다", () => {
  const before = "복사는 `/Users/alice/data/a.csv` 에서 `/Users/bob/data/a.csv` 로 한다.";
  const after = "복사는 `$HOME/data/a.csv` 에서 `$HOME/data/a.csv` 로 한다.";
  assert.ok(kinds(checkInvariants(doc(before), doc(after))).includes("invariant:inlineCode"), JSON.stringify(checkInvariants(doc(before), doc(after))));
});

await t("F 접두 뒤 경로가 바뀌면 인라인 코드·코드 블록 위반", () => {
  for (const [before, after, kind] of [
    ["설정은 `/Users/bob/app.conf` 에 둔다.", "설정은 `$HOME/main.conf` 에 둔다.", "invariant:inlineCode"],
    ["설정은 아래와 같다.\n\n```\ncat /Users/bob/app.conf\n```", "설정은 아래와 같다.\n\n```\ncat $HOME/main.conf\n```", "invariant:codeBlocks"],
  ]) assert.ok(kinds(checkInvariants(doc(before), doc(after))).includes(kind), kind);
});

console.log(`writing-resolve: ${pass} passed`);
