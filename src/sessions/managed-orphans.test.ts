// 상시세션 고아 판정(#1675 ⑥ / #2170) — 레지스트리 1건인데 tmux 에 30개가 떠 있던 실측이 이 표의 근거다.
//  틀렸을 때 양쪽 다 실제 사고다:
//   · 못 걷으면 claude 프로세스 29개 = 5.7GB 가 그대로 남는다(어니스트 2026-08-12 실측).
//   · 잘못 걷으면 일하고 있는 세션이 죽는다 — 그리고 #2170 에서 확인했듯 그 사거리는 상시세션 자기 것에
//     그치지 않았다. 작업 폴더 문자열만 겹치면 **남의 프로젝트 세션**까지 닿았다(뒤에 막아 줄 자리가 없다).
//  엣지 표: 스크래치패드 spec.md — 아래 A1~A14 · B1~B9 · C1~C9 주석이 그 행 번호다.
import { strict as assert } from "node:assert";
import {
  classifyManagedLive, managedSubpath, shouldAdoptLegacy, normalizeManagedSubpath, isProjectSubpath,
} from "./managed-sessions.js";
import { HttpError } from "../http-error.js";

const MID = "knowledge-classify";
const WS = "/srv/lively/shared/managed/knowledge-classify";
const SUB = "managed/knowledge-classify";
/** 표식이 박힌 세션(= 정리기가 만든 것). 기본은 이 상시세션 것. */
const S = (id: string, dir: string, created = 0, managed: string | null = MID) => ({ id, dir, created, managed, owner: "daon" });
/** 표식이 없는 세션(= 사람이 열었거나 표식 도입 이전의 것). */
const U = (id: string, dir: string, created = 0, owner = "yoon") => ({ id, dir, created, owner });

// ── 워크스페이스 경로 산출 ──
assert.equal(managedSubpath({ id: MID, workspace_subpath: null }), SUB, "등록값이 없을 때의 관례 경로가 틀렸다");
assert.equal(managedSubpath({ id: "x", workspace_subpath: "custom/place" }), "custom/place", "등록된 워크스페이스를 무시했다");

// A1 — 살아있는 게 없으면 아무것도 안 한다
{
  const r = classifyManagedLive({ live: [], managedId: MID, subpath: SUB, registered: "box-a" });
  assert.equal(r.keep, null);
  assert.deepEqual(r.orphans, []);
  assert.deepEqual(r.unmarked, []);
}

// A2 — 정상 1개: 등록된 것을 유지, 걷을 것 없음
{
  const r = classifyManagedLive({ live: [S("box-a", WS)], managedId: MID, subpath: SUB, registered: "box-a" });
  assert.equal(r.keep, "box-a");
  assert.deepEqual(r.orphans, [], "정상 상태인데 걷으려 한다 — 일하는 세션이 죽는다");
}

// A3 — ★어니스트 실측 형태: 30개 중 등록된 1개만 남기고 29개를 걷는다
{
  const live = Array.from({ length: 30 }, (_, i) => S(`box-${i}`, WS, i));
  const r = classifyManagedLive({ live, managedId: MID, subpath: SUB, registered: "box-7" });
  assert.equal(r.keep, "box-7", "레지스트리가 가리키는 세션을 안 남겼다 — 레지스트리가 권위다");
  assert.equal(r.orphans.length, 29, `고아 29개를 걷어야 하는데 ${r.orphans.length}개만 걷는다`);
  assert.ok(!r.orphans.includes("box-7"), "유지 대상을 고아 목록에 넣었다");
}

// A4 — ★★#2170 회귀: 작업 폴더를 프로젝트 폴더로 등록해도 그 폴더의 남의 세션을 걷지 않는다.
//  종전 판정(dir suffix 만)이면 여기서 orphans 가 3개였고, keep-alive 는 2분마다 돈다.
//  프로젝트 폴더 세션은 소유자와 무관하게 전원에게 보이고(canSeeSession) 회수는 소유자를 안 묻는다 —
//  이 판정을 통과하면 그 뒤에 막아 줄 자리가 하나도 없다. 여기가 유일한 방벽이다.
{
  const PF = "/srv/lively/shared/project/2170";
  const live = [
    U("box-yoon-1", PF, 100, "yoon"), U("box-yoon-2", PF, 200, "yoon"),
    U("box-won-1", PF, 300, "won"), U("box-daon-1", PF, 400, "daon"),
  ];
  const r = classifyManagedLive({ live, managedId: "map-agent", subpath: "project/2170", registered: null });
  assert.deepEqual(r.orphans, [], "★프로젝트 폴더의 남의 세션을 고아로 잡았다 — 등록 한 번에 그 프로젝트가 전멸한다");
  assert.equal(r.keep, null, "★내가 만들지 않은 세션을 '내 상시세션'으로 입양했다");
  assert.equal(r.unmarked.length, 4, "걷지 않더라도 보이기는 해야 한다(관리탭 unmarked_count)");
}

// A5 — 표식 없는 세션은 같은 워크스페이스에 있어도 절대 고아가 아니다(모르면 안 건드린다)
{
  const live = [S("box-mine", WS, 10), U("box-human", WS, 20, "yoon")];
  const r = classifyManagedLive({ live, managedId: MID, subpath: SUB, registered: "box-mine" });
  assert.equal(r.keep, "box-mine");
  assert.deepEqual(r.orphans, [], "표식 없는 세션을 걷었다 — 사람이 같은 폴더에서 연 세션이 죽는다");
  assert.deepEqual(r.unmarked, ["box-human"], "안 걷은 세션을 보고도 안 했다");
}

// A6 — 다른 상시세션의 표식이 박힌 세션은 내 것이 아니고, '표식 없음'도 아니다
{
  const live = [S("box-mine", WS, 10), S("box-other", WS, 20, "other-agent")];
  const r = classifyManagedLive({ live, managedId: MID, subpath: SUB, registered: "box-mine" });
  assert.deepEqual(r.orphans, [], "남의 상시세션을 걷었다");
  assert.deepEqual(r.unmarked, [], "표식이 있는데 '표식 없음'으로 셌다");
}

// A7 — 등록된 id 가 이미 죽었으면 가장 오래된 것을 승격한다(맥락이 쌓인 쪽)
{
  const live = [S("box-new", WS, 200), S("box-old", WS, 100), S("box-mid", WS, 150)];
  const r = classifyManagedLive({ live, managedId: MID, subpath: SUB, registered: "box-dead" });
  assert.equal(r.keep, "box-old", "등록 id 가 죽었을 때 가장 오래된 세션을 안 남겼다");
  assert.deepEqual(r.orphans.sort(), ["box-mid", "box-new"]);
}

// A8 — 등록값 자체가 없을 때도 같다
{
  const live = [S("box-new", WS, 200), S("box-old", WS, 100)];
  const r = classifyManagedLive({ live, managedId: MID, subpath: SUB, registered: null });
  assert.equal(r.keep, "box-old");
}

// A9 — ★경로 경계: 접두가 같은 다른 상시세션을 삼키면 안 된다
{
  const live = [S("box-a", WS), S("box-b", WS + "-2", 0, "knowledge-classify-2"), S("box-c", "/srv/lively/shared/managed/other", 0, "other")];
  const r = classifyManagedLive({ live, managedId: MID, subpath: SUB, registered: "box-a" });
  assert.deepEqual(r.orphans, [], "이름이 비슷한 다른 상시세션(-2)이나 무관한 세션을 고아로 잡았다 — 남의 세션을 죽인다");
  assert.equal(r.keep, "box-a");
}

// A10 — 워크스페이스를 옮긴 뒤 옛 자리에 남은 내 세션도 걷지 않는다(표식 AND 경로).
//  사람이 workspace_subpath 를 바꾼 것이라, 그 세션에 쌓인 맥락을 정책 변경이 조용히 죽이면 안 된다.
{
  const live = [S("box-old-place", WS, 10)];
  const r = classifyManagedLive({ live, managedId: MID, subpath: "managed/moved", registered: null });
  assert.deepEqual(r.orphans, [], "워크스페이스를 옮겼다고 옛 자리 세션을 죽였다");
  assert.equal(r.keep, null);
}

// A11 — 경로 정보가 없는 세션은 대상이 아니다(모르면 안 건드린다)
{
  const live = [{ id: "box-x", created: 1, managed: MID }, S("box-a", WS)];
  const r = classifyManagedLive({ live, managedId: MID, subpath: SUB, registered: "box-a" });
  assert.deepEqual(r.orphans, [], "dir 을 모르는 세션을 고아로 판정했다");
}

// A12 — 후행 슬래시는 같은 경로다
{
  const r = classifyManagedLive({ live: [S("box-a", WS + "/")], managedId: MID, subpath: SUB, registered: null });
  assert.equal(r.keep, "box-a", "후행 슬래시 하나로 같은 워크스페이스를 못 알아봤다 — 중복 생성이 계속된다");
}

// A13 — 표식 필드가 비어 있는 세 가지 꼴("" · null · 없음)은 전부 '표식 없음'이다.
//  tmux 는 미설정 user-option 을 빈 문자열로 준다 — "" 를 표식으로 오해하면 그 순간 남의 세션이 내 것이 된다.
{
  const live = [
    { id: "box-empty", dir: WS, created: 1, managed: "", owner: "yoon" },
    { id: "box-null", dir: WS, created: 2, managed: null, owner: "yoon" },
    { id: "box-undef", dir: WS, created: 3, owner: "yoon" },
  ];
  const r = classifyManagedLive({ live, managedId: MID, subpath: SUB, registered: null });
  assert.deepEqual(r.orphans, [], "빈 표식을 표식으로 인정했다");
  assert.equal(r.keep, null);
  assert.deepEqual(r.unmarked.sort(), ["box-empty", "box-null", "box-undef"], "빈 표식 세 꼴 중 일부를 안 셌다");
}

// A14 — ★상시세션 id 자체가 빈 값이면 아무도 내 것이 아니다.
//  이 가드가 없으면 `(s.managed || "") === managedId` 가 빈 값끼리 일치해 **표식 없는 세션 전부**가 고아가 된다.
{
  const live = [U("box-human-1", WS, 10, "yoon"), U("box-human-2", WS, 20, "yoon")];
  const r = classifyManagedLive({ live, managedId: "", subpath: SUB, registered: null });
  assert.deepEqual(r.orphans, [], "★상시세션 id 가 비었는데 표식 없는 세션을 전부 고아로 잡았다");
  assert.equal(r.keep, null);
}

// ── B. 이행 입양(#2170) ─────────────────────────────────────────────────────
//  스텁: 절대경로가 공유 워크스페이스의 프로젝트 폴더인가(실물은 project-fs.isProjectSessionDir).
const isProjectDir = (dir: string) => dir.includes("/shared/project/") || dir.includes("/shared/legacy-project/");

// B1 — 레지스트리가 가리키는 그 세션이면 입양한다(안 그러면 살아 있는 상시세션 옆에 새 세션이 하나 더 뜬다)
{
  const live = [U("box-legacy", WS, 10, "daon")];
  assert.equal(shouldAdoptLegacy({ live, registered: "box-legacy", subpath: SUB, account: "daon", isProjectDir }),
    "box-legacy", "표식 이전에 만들어진 등록 세션을 입양하지 않았다 — 배포 직후 중복이 하나 뜬다");
}
// B2 — 소유자가 다르면 사람이 연 세션이다(입양은 '앞으로 걷어도 된다'는 선언이라 절대 넓히지 않는다)
{
  const live = [U("box-legacy", WS, 10, "yoon")];
  assert.equal(shouldAdoptLegacy({ live, registered: "box-legacy", subpath: SUB, account: "daon", isProjectDir }),
    null, "계정이 다른 세션을 입양했다 — 다음 tick 이 사람의 세션을 걷는다");
}
// B3 — 프로젝트 폴더면 입양하지 않는다(전원 공동 세션이라 정리기의 소유물일 수 없다)
{
  const live = [U("box-legacy", "/srv/lively/shared/project/2170", 10, "daon")];
  assert.equal(shouldAdoptLegacy({ live, registered: "box-legacy", subpath: "project/2170", account: "daon", isProjectDir }),
    null, "★프로젝트 폴더 세션을 입양했다 — 그 순간 그 세션이 정리 대상이 된다");
}
// B4 — 레지스트리 근거가 없으면 입양하지 않는다(경로만으로 입양하면 이 이슈의 사고 그대로다)
{
  const live = [U("box-legacy", WS, 10, "daon")];
  assert.equal(shouldAdoptLegacy({ live, registered: null, subpath: SUB, account: "daon", isProjectDir }), null,
    "레지스트리 근거 없이 경로만 보고 입양했다");
}
// B5 — 다른 워크스페이스의 세션은 입양하지 않는다
{
  const live = [U("box-legacy", WS, 10, "daon")];
  assert.equal(shouldAdoptLegacy({ live, registered: "box-legacy", subpath: "managed/elsewhere", account: "daon", isProjectDir }), null,
    "다른 워크스페이스의 세션을 입양했다");
}
// B6 — 이미 다른 상시세션 표식이 박혀 있으면 남의 것이다
{
  assert.equal(shouldAdoptLegacy({ live: [S("box-legacy", WS, 10, "other-agent")], registered: "box-legacy", subpath: SUB, account: "daon", isProjectDir }), null,
    "남의 상시세션 표식이 박힌 세션을 입양했다");
}
// B7 — 등록 id 가 살아있는 목록에 아예 없으면(이미 죽었다) 입양할 대상이 없다
{
  assert.equal(shouldAdoptLegacy({ live: [U("box-other", WS, 10, "daon")], registered: "box-legacy", subpath: SUB, account: "daon", isProjectDir }), null,
    "죽은 등록 id 를 입양했다");
}
// B8 — 작업 폴더를 모르는 세션은 입양하지 않는다
{
  const live = [{ id: "box-legacy", created: 10, owner: "daon" }];
  assert.equal(shouldAdoptLegacy({ live, registered: "box-legacy", subpath: SUB, account: "daon", isProjectDir }), null,
    "dir 을 모르는 세션을 입양했다");
}
// B9 — ★계정이 빈 값이면 입양하지 않는다(빈 값끼리 일치해 소유자 미상 세션이 통과하면 안 된다)
{
  const live = [{ id: "box-legacy", dir: WS, created: 10, owner: "" }];
  assert.equal(shouldAdoptLegacy({ live, registered: "box-legacy", subpath: SUB, account: "", isProjectDir }), null,
    "★계정이 빈 값인데 소유자 미상 세션을 입양했다");
}

// ── C. 가드레일 ②: workspace_subpath 등록 검증(#2170) ────────────────────────
assert.equal(isProjectSubpath("project/2170"), true);
assert.equal(isProjectSubpath("legacy-project/2170"), true);
assert.equal(isProjectSubpath("project"), true, "C5 — 프로젝트 루트 자체도 막아야 한다");
assert.equal(isProjectSubpath("projects/2170"), false, "C6 — 이름이 비슷할 뿐인 폴더까지 막았다(세그먼트로 끊어야 한다)");
assert.equal(isProjectSubpath("managed/x"), false);

assert.equal(normalizeManagedSubpath(""), null, "C1 — 빈 값은 관례 경로(managed/<id>)로 떨어져야 한다");
assert.equal(normalizeManagedSubpath(null), null, "C1");
assert.equal(normalizeManagedSubpath("///"), null, "C8 — 슬래시뿐인 값이 경로로 남았다");
assert.equal(normalizeManagedSubpath("  /agents/foo/  "), "agents/foo", "C2 — 앞뒤 공백·슬래시를 정규화하지 않았다");
assert.equal(normalizeManagedSubpath("agents\\foo"), "agents/foo", "C3 — 역슬래시를 정규화하지 않았다");
assert.equal(normalizeManagedSubpath("projects/2170"), "projects/2170", "C6 — 이름만 비슷한 폴더를 막았다");
// C4 — 프로젝트 폴더는 등록 자체가 거절된다(#2170 사고의 방아쇠). 표기 변형까지 전부.
for (const bad of ["project/2170", "legacy-project/2170", "/project/2170", "project\\2170", "project"]) {
  assert.throws(() => normalizeManagedSubpath(bad), (e: unknown) => e instanceof HttpError && e.status === 400,
    `★프로젝트 폴더(${bad})를 상시세션 작업 폴더로 등록할 수 있었다 — #2170 사고의 방아쇠다`);
}
// C7·C9 — '..' 로 프로젝트 폴더로 빠져나가는 것도, '.' 도 막는다
assert.throws(() => normalizeManagedSubpath("agents/../project/2170"), (e: unknown) => e instanceof HttpError && e.status === 400, "C7");
assert.throws(() => normalizeManagedSubpath("."), (e: unknown) => e instanceof HttpError && e.status === 400, "C9");

console.log("managed-orphans.test: ok");
