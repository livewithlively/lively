// 홈 경로 정규화와 재작성 게이트의 홈 경로 예외를 사양대로 잠근다.
// 실행: 빌드 후 node dist/v6/writing-resolve.test.js
import assert from "node:assert/strict";
import { normalizeHomePaths, countHomePaths } from "./writing-resolve.js";
import { checkInvariants } from "./writing-rewrite-gate.js";
import { lintWriting } from "./writing-lint.js";
import { resolveWritingFormat } from "../org/policies/writing-format.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>) => { await fn(); pass++; console.log(`ok  ${name}`); };

const fmt = resolveWritingFormat({ enabled: true });
const TITLE = "결제 재시도 정책";
const doc = (body_md: string) => ({ title: TITLE, body_md });
const kinds = (vs: Array<{ kind: string }>) => vs.map((v) => v.kind);

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
    "```",
    "type C:\\Users\\bob\\app.conf",
    "cat /Users/bob",
    "```",
  ].join("\n");
  assert.ok(hasLocalPath(homeless));
  assert.ok(!hasLocalPath(normalizeHomePaths(homeless)));
  // /home/<계정>/ 은 바꾸지 않으므로 개인 계정이면 위반으로 남는다(서비스 계정 deploy·ubuntu 등은 탐지가 빼는 관례 위치다).
  assert.ok(hasLocalPath(normalizeHomePaths(`${homeless}\n\n작업 경로는 /home/alice/app.conf 이다.`)));
  assert.ok(!hasLocalPath(normalizeHomePaths(`${homeless}\n\n서버 경로는 /home/deploy/app.conf 이다.`)));
});

await t("F 홈 경로 접두만 바꾼 것은 인라인 코드·코드 블록 안이라도 위반이 아니다", () => {
  for (const [before, after] of [
    ["설정은 /Users/bob/app.conf 에 둔다.", "설정은 $HOME/app.conf 에 둔다."],
    ["설정은 `/Users/bob/app.conf` 에 둔다.", "설정은 `$HOME/app.conf` 에 둔다."],
    ["설정은 아래와 같다.\n\n```\ncat /Users/bob/app.conf\n```", "설정은 아래와 같다.\n\n```\ncat $HOME/app.conf\n```"],
    ["설정은 아래와 같다.\n\n```\ntype C:\\Users\\bob\\app.conf\n```", "설정은 아래와 같다.\n\n```\ntype %USERPROFILE%\\app.conf\n```"],
  ]) assert.deepEqual(checkInvariants(doc(before), doc(after)), [], before);
});

await t("F 접두 뒤 경로가 바뀌면 인라인 코드·코드 블록 위반", () => {
  for (const [before, after, kind] of [
    ["설정은 `/Users/bob/app.conf` 에 둔다.", "설정은 `$HOME/main.conf` 에 둔다.", "invariant:inlineCode"],
    ["설정은 아래와 같다.\n\n```\ncat /Users/bob/app.conf\n```", "설정은 아래와 같다.\n\n```\ncat $HOME/main.conf\n```", "invariant:codeBlocks"],
  ]) assert.ok(kinds(checkInvariants(doc(before), doc(after))).includes(kind), kind);
});

console.log(`writing-resolve: ${pass} passed`);
