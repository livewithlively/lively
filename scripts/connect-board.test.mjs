// [외부 앱 연결] «앱 × 구성원» 현황판 판정(web/lib/connect-board.ts) — 값으로 지킨다(#4213 T13, 상민님 2026-10-15 To-Be §7).
//
//  사양 — 칸·줄·고치기 판정. 엣지 표 행마다 한 단언(각 단언은 서로 다른 관측):
//   B1  구성원이 Claude 로 앱을 연결했다             → 칸 «Claude로 연결됨» · 그 앱 줄의 연결 구성원 수 · 팀이 쓰는 앱
//   B2  팀이 쓰는 앱인데 다른 구성원은 잰 결과 없음      → «○○님 연결 필요»(이름이 들어간다)
//   B3  한 번도 안 잰 구성원                         → «확인 전»(연결 필요라고 단정하지 않는다)
//   B4  잰 것이 실패(행 없음)                        → «확인 못 함» + 사유 코드
//   B5  다시 로그인 필요 상태                         → «다시 로그인 필요»
//   B6  라이블리 수집기만 모으는 앱(아무도 Claude 로 안 이음) → 팀이 Claude 로 쓰는 앱이 아니다 → 칸 «안 씀» · 줄에 수집기 표시
//   B7  정책 막힘                                   → 모든 칸 «쓰지 않음»
//   B8  Claude Docs 같은 일 자료 아닌 커넥터            → 줄을 세우지 않는다
//   B9  끊은(removed) 커넥터                          → 줄도 칸도 만들지 않는다
//   B10 리브가 직접 연결한 단위(liv_direct)             → 줄에 «리브가 연결함»
//   B11 명부에 없는 구성원(내보낸 사람)의 기록           → 세지 않는다
//   B12 꺼진 수집기 · 단위로 안 풀리는 프리셋            → 줄을 세우지 않는다
//   B13 아무도 Claude 로 안 이었지만 구성원 경로 단위를 모으는 중 → 팀이 쓰는 앱(연결 필요)
//   B14 줄 순서 — 팀이 쓰는 앱 먼저 · 구성원 열은 나 먼저
//   B15 단위 — 모으는 중 → 후보 → 뺌 순서 · 상태별 수
//   P1~P4 열(boardPeople) — 들어오는 사람(is_person)·활성만 · 미러된 사람 행은 빼고 · 보는 사람은 늘 · 명부를 못 읽으면 커넥터 기록으로
//   T1~T4 읽은 때(unitReadText) — 겉줄엔 말하지 않는다(서버가 안 준다) · 다 보는 줄은 읽은 때 · 모으는 중인데 안 읽었으면 «아직 안 읽음»
//   N1~N4 단위 이름(unitDisplayName) — «가려졌다» 는 서버가 가린 때(겉줄·비공개 종류)뿐
//   K0~K1 계약 — 웹 판정(canEditUnit · visibilityChoices)이 서버 규칙(unit-plan canEditUnit · visibilityChangeError)과 모든 조합에서 같다
//   E1~E3 고칠 수 있나(서버 canEditUnit 과 같은 규칙) · V1~V6 공개범위 선택지(서버 visibilityChangeError 와 같은 규칙) · W 넓히기 · A 모으는 사람 말
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const eq = (got, want, what) => { assert.deepEqual(got, want, what); pass++; };
const ok = (cond, what) => { assert.ok(cond, what); pass++; };

const B = await import(join(root, "public/app/lib/connect-board.js"));
ok(typeof B.buildBoard === "function" && typeof B.canEditUnit === "function" && typeof B.visibilityChoices === "function", "W0 배선 — 판정 셋을 불러왔다");

const people = [{ id: "sumin", name: "수민" }, { id: "me", name: "상민" }, { id: "jiwoo", name: "지우" }];
const scanned = (id, apps, ok_ = true, error = null) => ({ member_id: id, scan: { ok: ok_, error }, connectors: apps.map(([app, status]) => ({ app, status })) });
const unit = (o) => ({ id: 1, app: "slack", kind: "channel", name: "general", route: "member_ai", state: "active", visibility: "all", access: "full", candidates: [], ...o });
const board = (o) => B.buildBoard({ me: "me", isAdmin: false, members: people, policy: "allowed", connectorMembers: [], units: [], collectors: [], ...o });
const cellOf = (b, app, member) => b.apps.find((a) => a.key === app)?.cells.find((c) => c.member === member);

// B1 · B2 · B3 · B5
{
  const b = board({ connectorMembers: [scanned("me", [["Slack", "connected"], ["Gmail", "needs-auth"]]), scanned("sumin", [])] });
  const slack = b.apps.find((a) => a.key === "slack");
  eq([cellOf(b, "slack", "me").state, cellOf(b, "slack", "me").label], ["connected", "Claude로 연결됨"], "B1 연결한 칸");
  eq([slack.claudeMembers, slack.teamUses], [1, true], "B1 줄 — 연결 구성원 1 · 팀이 쓰는 앱");
  eq([cellOf(b, "slack", "sumin").state, cellOf(b, "slack", "sumin").label], ["need", "수민님 연결 필요"], "B2 연결 필요(이름)");
  eq(cellOf(b, "slack", "jiwoo").state, "unchecked", "B3 안 잰 사람은 확인 전");
  eq([cellOf(b, "gmail", "me").state, cellOf(b, "gmail", "me").label], ["needs-auth", "다시 로그인 필요"], "B5 다시 로그인");
}
// B4
{
  const b = board({ connectorMembers: [scanned("me", [["Slack", "connected"]]), scanned("sumin", [], false, "timeout")] });
  eq([cellOf(b, "slack", "sumin").state, cellOf(b, "slack", "sumin").scanError], ["scan-failed", "timeout"], "B4 확인 못 함 + 사유");
}
// B6
{
  const b = board({ connectorMembers: [scanned("me", []), scanned("sumin", [])], collectors: [{ preset_key: "github", enabled: true }],
    units: [unit({ app: "github", route: "lively_collector", kind: "repo", name: "lively" })] });
  const gh = b.apps.find((a) => a.key === "github");
  eq([gh.collector, gh.teamUses, cellOf(b, "github", "me").state, cellOf(b, "github", "me").label], [true, false, "off", "안 씀"], "B6 수집기만 — 연결 필요가 아니다");
}
// B7
{
  const b = board({ policy: "blocked", connectorMembers: [scanned("me", [["Slack", "connected"]])] });
  eq(b.apps.find((a) => a.key === "slack").cells.map((c) => c.state), ["blocked", "blocked", "blocked"], "B7 정책 막힘");
}
// B8 · B9
{
  const b = board({ connectorMembers: [scanned("me", [["Claude Docs", "connected"], ["Notion", "removed"]])] });
  eq(b.apps.map((a) => a.key), [], "B8·B9 일 자료 아닌 커넥터·끊은 커넥터는 줄이 없다");
}
// B10
{
  const b = board({ units: [unit({ app: "jandi", route: "liv_direct", name: "전사 공지" })] });
  eq(b.apps.find((a) => a.key === "jandi").livDirect, true, "B10 리브가 연결함");
}
// B11
{
  const b = board({ connectorMembers: [scanned("gone", [["Slack", "connected"]])] });
  eq(b.apps.length, 0, "B11 명부 밖 구성원의 기록은 세지 않는다");
}
// B12
{
  const b = board({ collectors: [{ preset_key: "notion", enabled: false }, { preset_key: "domain-wiki", enabled: true }] });
  eq(b.apps.length, 0, "B12 꺼진 수집기·단위로 안 풀리는 프리셋은 줄이 없다");
}
// B13
{
  const b = board({ connectorMembers: [scanned("me", []), scanned("sumin", [])], units: [unit({ app: "notion", kind: "page", name: "위키", candidates: [{ member_id: "me", verified: true }] })] });
  eq([b.apps[0].teamUses, cellOf(b, "notion", "sumin").state], [true, "need"], "B13 구성원 경로 단위를 모으면 팀이 쓰는 앱");
}
// B14
{
  const b = board({ connectorMembers: [scanned("me", [["Slack", "connected"]]), scanned("sumin", [["Slack", "connected"]])],
    collectors: [{ preset_key: "github", enabled: true }] });
  eq(b.apps.map((a) => a.key), ["slack", "github"], "B14 팀이 쓰는 앱 먼저");
  eq(b.members[0].id, "me", "B14 나 먼저");
}
// B15
{
  const b = board({ units: [unit({ id: 3, state: "excluded", name: "알림" }), unit({ id: 2, state: "candidate", name: "디자인" }), unit({ id: 1, state: "active", name: "결정" })] });
  const a = b.apps[0];
  eq(a.units.list.map((u) => u.id), [1, 2, 3], "B15 모으는 중 → 후보 → 뺌");
  eq([a.units.active, a.units.candidate, a.units.excluded], [1, 1, 1], "B15 상태별 수");
}

// E — 고칠 수 있나
eq(B.canEditUnit(unit({ access: "coarse" }), "me", true), false, "E1 겉만 보이는 줄은 못 고친다(관리자여도)");
eq(B.canEditUnit(unit({ candidates: [{ member_id: "me", verified: true }] }), "me", false), true, "E2 구성원 경로 — 확인된 나");
eq(B.canEditUnit(unit({ candidates: [{ member_id: "me", verified: false }] }), "me", true), false, "E2′ 구성원 경로 — 관리자라도 확인 안 됐으면 못 고친다");
eq(B.canEditUnit(unit({ route: "lively_collector" }), "me", true), true, "E3 수집기 경로 — 관리자");
eq(B.canEditUnit(unit({ route: "lively_collector", candidates: [{ member_id: "me", verified: true }] }), "me", false), true, "E3′ 수집기 경로 — 확인된 구성원");
eq(B.canEditUnit(unit({ route: "lively_collector" }), "me", false), false, "E3″ 수집기 경로 — 그 밖");

// V — 공개범위 선택지
const mine = [{ member_id: "me", verified: true }];
eq(B.visibilityChoices(unit({ candidates: [] }), "me", false), ["all"], "V1 못 고치면 지금 값만");
eq(B.visibilityChoices(unit({ visibility: "viewers", candidates: mine }), "me", false), ["me", "viewers", "all"], "V2 확인된 나 — 셋 다");
eq(B.visibilityChoices(unit({ visibility: "me", owner_member: "sumin", candidates: [...mine, { member_id: "sumin", verified: true }] }), "me", false),
  ["me", "viewers"], "V3 남이 정한 «나만» — «볼 수 있는 사람만» 까지만");
eq(B.visibilityChoices(unit({ visibility: "me", owner_member: "sumin", candidates: [...mine, { member_id: "sumin", verified: true, active: false }] }), "me", false),
  ["me", "viewers", "all"], "V4 정한 사람이 빠졌으면 확인된 내가 넘겨받는다");
eq(B.visibilityChoices(unit({ route: "lively_collector", visibility: "me", owner_member: "sumin", candidates: [{ member_id: "sumin", verified: true }] }), "me", true),
  ["me"], "V5 확인 안 된 관리자는 남의 «나만» 을 못 바꾼다");
eq(B.visibilityChoices(unit({ route: "lively_collector", visibility: "viewers", candidates: [] }), "me", true), ["viewers", "all"], "V6 확인 안 된 관리자는 «나만» 을 못 고른다");

// W — 넓히기
eq([B.widens("me", "viewers"), B.widens("viewers", "all"), B.widens("all", "viewers"), B.widens("viewers", "viewers")], [true, true, false, false], "W 넓히기");

// A — 모으는 사람
const nameOf = (id) => ({ me: "상민" })[id] || id;
eq(B.assigneeText(unit({ assignee: { kind: "collector" } }), nameOf), "라이블리 수집기", "A1 수집기");
eq(B.assigneeText(unit({ assignee: { kind: "member", member_id: "me" } }), nameOf), "상민님 Claude", "A2 구성원");
eq(B.assigneeText(unit({ assignee: null }), nameOf), "모을 사람 없음", "A3 모으는 중인데 담당 없음");
eq(B.assigneeText(unit({ access: "coarse", assignee_kind: "member", state: "active" }), nameOf), "구성원 Claude", "A4 겉줄은 이름 없이");

// P — 열(boardPeople)
{
  const roster = [
    { id: "me", display_name: "상민", is_person: true, state: "active" },
    { id: "wj", display_name: "원준", is_person: true, state: "active" },
    { id: "liv-arin", display_name: "아린", is_person: false, state: "active" },
    { id: "gone", display_name: "나간 사람", is_person: true, state: "inactive" },
  ];
  const av = { me: "상민(아바타)" };
  const nameOf = (id) => av[id] ?? null;
  eq(B.boardPeople(roster, [], "me", nameOf), [{ id: "me", name: "상민(아바타)" }, { id: "wj", name: "원준" }],
    "P1 들어오는 사람·활성만 — 미러된 사람 행(is_person 아님)·비활성은 열이 아니다 · 이름은 아바타 명부 먼저");
  eq(B.boardPeople(roster, [], "ops", nameOf).map((m) => m.id), ["me", "wj", "ops"], "P2 보는 사람은 사람 표식이 없어도 늘 넣는다");
  eq(B.boardPeople(null, ["wj", "me"], "me", nameOf), [{ id: "wj", name: "wj" }, { id: "me", name: "상민(아바타)" }], "P3 명부를 못 읽으면 커넥터 기록이 있는 구성원으로");
  eq(B.boardPeople([], [], "", nameOf), [], "P4 빈 명부 · 보는 사람 모름 → 열 없음");
}

// T — 읽은 때
{
  const rel = (iso) => `«${iso}»`;
  eq(B.unitReadText({ access: "coarse", state: "active", read_at: null }, rel), "", "T1 겉줄 — 읽은 위치를 안 받으니 말하지 않는다");
  eq(B.unitReadText({ access: "full", state: "active", read_at: null }, rel), "아직 안 읽음", "T2 다 보는 줄 · 모으는 중 · 안 읽음");
  eq(B.unitReadText({ access: "full", state: "candidate", read_at: "2026-10-17T00:00:00Z" }, rel), "«2026-10-17T00:00:00Z» 읽음", "T3 읽은 때");
  eq(B.unitReadText({ access: "full", state: "candidate", read_at: null }, rel), "", "T4 후보 · 안 읽음 — 말할 것 없음");
}
// N — 단위 이름
eq(B.unitDisplayName({ name: "#dev", kind: "channel", access: "full" }), "#dev", "N1 이름이 있으면 그 이름");
eq(B.unitDisplayName({ name: null, kind: "private_channel", access: "coarse" }), "이름이 가려진 비공개 채널", "N2 겉줄 · 비공개 종류 → 가려졌다");
eq(B.unitDisplayName({ name: null, kind: "channel", access: "coarse" }), "이름 없는 공개 채널", "N3 공개 채널은 서버가 가리지 않는다 — 이름이 빈 것");
eq(B.unitDisplayName({ name: null, kind: "mailbox", access: "full" }), "이름 없는 메일함", "N4 다 보는 줄의 빈 이름은 가려진 것이 아니다");
// K — 계약: 웹 판정 ≡ 서버 규칙(경로 3 × 공개범위 3 × 주인 3 × 나·남의 상태 4×4 × 관리자 2). 격리 리뷰(2026-10-17)의 점검 스크립트를 시험으로 옮겼다.
//  ⚠ 서버 쪽이 정본이다 — 여기서 어긋나면 웹이 서버가 거절할 선택지를 보이거나(사람이 골랐다가 403·409 를 본다) 할 수 있는 것을 숨긴다.
{
  const S = await import(join(root, "dist/org/collect/unit-plan.js"));
  ok(typeof S.canEditUnit === "function" && typeof S.visibilityChangeError === "function", "K0 [배선] 서버 규칙 둘을 불러왔다");
  const mk = (id, st) => st === "absent" ? null : ({ member_id: id, verified: st !== "reported", active: st !== "inactive" });
  let n = 0;
  const bad = [];
  for (const route of ["member_ai", "lively_collector", "liv_direct"]) for (const v of ["me", "viewers", "all"]) for (const owner of [null, "me", "other"])
    for (const meSt of ["absent", "reported", "verified", "inactive"]) for (const otSt of ["absent", "reported", "verified", "inactive"]) for (const isAdmin of [false, true]) {
      if ((v === "me") !== !!owner) continue;          // 주인은 «나만» 일 때만 있다
      const members = [mk("me", meSt), mk("other", otSt)].filter(Boolean);
      const serverU = { route, members, visibility: v, owner };
      const webU = unit({ route, visibility: v, owner_member: owner, candidates: members.map((m) => ({ member_id: m.member_id, verified: m.verified, active: m.active })) });
      const canEdit = S.canEditUnit({ route, members }, "me", isAdmin);
      if (B.canEditUnit(webU, "me", isAdmin) !== canEdit) bad.push({ kind: "canEdit", route, v, owner, meSt, otSt, isAdmin });
      const choices = B.visibilityChoices(webU, "me", isAdmin);
      for (const next of ["me", "viewers", "all"]) {
        n++;
        if (next === v) continue;                          // 웹은 지금 값을 늘 넣는다(칸이 비지 않게)
        const serverOk = canEdit && S.visibilityChangeError(serverU, next, "me", isAdmin) == null;
        if (serverOk !== choices.includes(next)) bad.push({ route, v, owner, meSt, otSt, isAdmin, next, serverOk });
      }
    }
  ok(n > 300, `K0 [배선] 조합을 실제로 돌았다(${n})`);
  eq(bad.slice(0, 5), [], `K1 웹·서버 판정 불일치 0 — ${bad.length}건`);
}

console.log(`connect-board: ${pass} passed`);
