// 사람 수를 세는 잣대는 한 벌이다 (#3872 전면 점검, 2026-09-14)
//
//  원준(2026-09-14): *"사람수 카운트하는 모든 로직에서 쟤는 사람 아니니까 빠지게 해야돼. 전면점검해줘"* — «쟤» 는 매니지드가
//   모든 워크스페이스에 심는 플랫폼 운영 계정(admin / ops@lvly.io).
//  점검에서 잣대(store/members.ts 의 WORKSPACE_PERSON_SQL)를 안 쓰고 사람을 세던 자리가 넷 나왔다 — 조직 셋업 체크리스트 «구성원»
//   (종류 무관 전 행 · 토큰 쥔 전 행), 관리 ▸ 구성원 «총 N명»(전 행), 스킬·훅 «대상 구성원» 요약(전 행), 셀프호스트 박스 구성원 창
//   (kind 만 봐서 미러된 사람 행까지). 매니지드에서 앞의 셋은 운영 계정·세션 호스트를 사람으로 셌다.
//   잣대를 쓰던 처음 설정 팀 소개는 **보는 사람 자신**을 세어, 혼자 쓰던 워크스페이스에 들어온 사람에게 «구성원 2명» 이라고 했다.
//  같은 일이 새 자리에서 다시 나지 않게 소스로 잠근다. SQL 동작 자체는 DB 가 있어야 재진다 — 여기서 잠그는 것은 «어느 잣대를 쓰나» 다.
//
//  엣지 표:
//   S1 서버 코드에서 org_member 를 count(*) 로 세는 자리는 잣대 파일(store/members.ts) 하나뿐
//   S2 listMembers() 의 길이로 사람을 세는 서버 코드가 없다
//   S3 체크리스트 «구성원» 은 잣대 함수로 센다(사람 수 · 토큰 보유 사람 수)
//   S4 명부 응답·자산 구성원 응답이 행마다 잣대에서 온 is_person 을 싣는다
//   S5 관리 ▸ 구성원 합계 · 자산 대상 요약 · 셀프호스트 구성원 창이 is_person 으로 센다
//   S6 팀 소개의 수는 나를 뺀 수 — 서버가 except: userId 로 세어 others_count 로 싣는다(화면 쪽은 invitee-onboarding C5)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const SRC_ROOT = new URL("../../", import.meta.url).pathname.replace("/dist/", "/src/");
const REPO_ROOT = path.resolve(SRC_ROOT, "..");
/** 주석 줄을 뺀 소스 — 설명문에 옛 패턴이 인용돼도 검사가 흔들리지 않게. */
const code = (rel: string): string =>
  readFileSync(path.join(REPO_ROOT, rel), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

function serverSources(): string[] {
  return (readdirSync(SRC_ROOT, { recursive: true }) as string[])
    .filter((p) => p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts"))
    .map((p) => path.join("src", p))
    .sort();
}

test("S1 서버에서 org_member 를 count(*) 로 세는 자리는 잣대 파일 하나뿐이다", () => {
  const files = serverSources();
  // [배선] 소스를 못 찾으면 아래 단언은 빈 목록끼리 비교하며 통과한다.
  assert.ok(files.length > 200, `서버 소스를 ${files.length}개밖에 못 찾았다 — 검사가 헛돈다`);
  assert.ok(files.includes("src/org/store/members.ts"), "잣대 파일을 목록에서 못 찾았다 — 경로 계산이 틀렸다");
  const hits = files.filter((f) => /count\(\*\)[^;`]{0,80}?\bFROM\s+org_member\b/i.test(code(f)));
  assert.deepEqual(hits, ["src/org/store/members.ts"],
    "잣대(countWorkspacePeople) 밖에서 명부 행을 센다 — 매니지드 운영 계정·세션 호스트·미러 행이 사람으로 세어진다");
});

test("S2 listMembers() 의 길이로 사람을 세는 서버 코드가 없다", () => {
  const hits = serverSources().filter((f) => /listMembers\(\)[^;\n]*\.length/.test(code(f)));
  assert.deepEqual(hits, [], "명부 전체 길이를 사람 수로 쓴다");
});

test("S3 체크리스트 «구성원» 은 잣대 함수로 센다 — 사람 수와 토큰 보유 사람 수", () => {
  const src = code("src/org/delivery/onboarding.ts");
  assert.match(src, /countWorkspacePeople\(\{ managed \}\)/, "체크리스트가 사람 수를 잣대로 안 센다");
  assert.match(src, /countWorkspacePeople\(\{ managed, withActiveToken: true \}\)/,
    "토큰 보유를 사람 중에서 안 센다 — 운영 계정·세션 호스트도 토큰을 쥔다");
  assert.doesNotMatch(src, /FROM org_member/, "체크리스트가 명부 행을 직접 센다");
});

test("S4 명부·자산 구성원 응답이 행마다 잣대에서 온 사람 표식(is_person)을 싣는다", () => {
  const members = code("src/capabilities/delivery/members.ts");
  assert.match(members, /workspacePersonIds\(\{ managed: managedMode\(\) \}\)/, "명부 응답이 잣대를 안 쓴다");
  assert.equal((members.match(/is_person: persons\.has\(m\.id\)/g) ?? []).length, 2,
    "admin·비-admin 명부 응답 둘 다에 is_person 이 실려야 한다 — 셀프호스트 구성원 창은 비-admin 응답으로도 센다");
  const assets = code("src/capabilities/delivery/harness-assets.ts");
  assert.match(assets, /workspacePersonIds\(\{ managed: managedMode\(\) \}\)/, "자산 구성원 응답이 잣대를 안 쓴다");
  assert.match(assets, /is_person: persons\.has\(m\.id\)/, "자산 구성원 행에 is_person 이 없다");
});

test("S5 화면의 사람 수는 is_person 으로 센다 — 관리 ▸ 구성원 · 자산 대상 요약 · 셀프호스트 구성원 창", () => {
  const adminMembers = code("web/admin-members.ts");
  assert.match(adminMembers, /members\.filter\(\(m\) => m\.is_person && m\.state === 'active'\)\.length/, "관리 ▸ 구성원 합계가 사람을 안 센다");
  assert.doesNotMatch(adminMembers, /\(총 ' \+ members\.length/, "명부 행 수를 «총 N명» 으로 말한다");

  const widgets = code("web/admin-widgets.ts");
  assert.match(widgets, /rows\.filter\(\(r\) => r\.is_person && r\.state === 'active'\)\.length/, "자산 대상 요약이 사람을 안 센다");
  assert.doesNotMatch(widgets, /구성원 \$\{rows\.length - inactive\}명/, "표의 전 행을 구성원으로 센다");

  const people = code("web/v2/ws-people.ts");
  const at = people.indexOf("async function loadBoxView");
  const end = people.indexOf("function inviteBlock", at);
  assert.ok(at >= 0 && end > at, "loadBoxView 를 못 찾았다 — 검사가 헛돈다");
  const box = people.slice(at, end);
  assert.match(box, /m\.is_person === true && m\.state === 'active'/, "셀프호스트 구성원 창이 사람만 싣지 않는다");
  assert.doesNotMatch(box, /m\.kind === 'human' && m\.state === 'active'/, "셀프호스트 구성원 창이 kind 만 본다(미러된 사람 행이 구성원이 된다)");
});

test("S6 팀 소개의 수는 나를 뺀 수다 — 서버가 except: userId 로 세어 others_count 로 싣는다", () => {
  const welcome = code("src/capabilities/delivery/welcome.ts");
  assert.match(welcome, /countWorkspacePeople\(\{ managed: managedMode\(\), except: userId \}\)/, "보는 사람을 빼고 세지 않는다");
  assert.match(welcome, /others_count: Number\(others\) \|\| 0/, "나를 뺀 수를 joining 에 싣지 않는다");
});
