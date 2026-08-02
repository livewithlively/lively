// desired-state 백필 결정 로직 (#1059 F 후속). 주입 seam 으로 tmux·DB 없이 검증한다.
//
// 왜 이 테스트가 값이 있나 — 백필은 **회수의 전제**다. 잘못되면 두 방향으로 다 위험하다:
//  🔴 너무 좁으면(역산 실패) 구세션이 계속 회수 면역 → F 를 켜도 메모리 압박이 안 풀리고 earlyoom 이 일하는 세션을 죽인다.
//  🔴 너무 넓으면(허용 루트 밖 경로에 레코드를 만들면) 회수는 되는데 복원이 실패한다 = 불변식 ④("회수 ⊆ 복원가능") 붕괴.
//     사용자 자산이 복원 불가로 사라진다 — 이게 더 나쁘다.
//  🔴 경계를 헐겁게 잡으면(`startsWith(base)`만) `/srv/lively/shared-old` 가 `/srv/lively/shared` 로 잡혀
//     **전혀 다른 폴더에서** 세션이 복원된다.
import assert from "node:assert/strict";
import { splitByBases, backfillSessionStates } from "./session-state-backfill.js";
import type { SessionInfo } from "../terminal/terminal-sessions.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };

// 고객사 A 실측 경로 그대로 — 공유는 격리 베이스, 개인은 멤버 홈.
const BASES = [
  { key: "shared", base: "/srv/lively/shared" },
  { key: "personal", base: "/home/box_yoon/box" },
];

// ── splitByBases: dir → 복원 좌표 역산 ──
{
  assert.deepEqual(splitByBases("/srv/lively/shared/project/1059/context-ontology", BASES),
    { rootKey: "shared", subpath: "project/1059/context-ontology" });
  ok("공유 루트 하위 → rootKey+subpath");
}
{
  assert.deepEqual(splitByBases("/srv/lively/shared", BASES), { rootKey: "shared", subpath: "" });
  ok("루트 자신 → subpath 빈 문자열");
}
{
  assert.deepEqual(splitByBases("/home/box_yoon/box/scratch", BASES), { rootKey: "personal", subpath: "scratch" });
  ok("개인 폴더(격리 홈) 하위");
}
{
  // 허용 루트 밖 — 레코드를 만들면 복원이 실패한다. null 이어야 한다.
  assert.equal(splitByBases("/home/box_test/lively/projects/1059", BASES), null, "허용 루트 밖은 null");
  assert.equal(splitByBases("/etc", BASES), null);
  assert.equal(splitByBases("/", BASES), null);
  assert.equal(splitByBases("", BASES), null);
  ok("허용 루트 밖·빈 경로는 백필하지 않는다(null)");
}
{
  // 🔴 경계 오인 — 이게 뚫리면 전혀 다른 폴더에서 복원된다.
  assert.equal(splitByBases("/srv/lively/shared-old/x", BASES), null, "형제 디렉터리를 하위로 오인하면 안 된다");
  assert.equal(splitByBases("/home/box_yoonother/box", BASES), null, "다른 멤버 홈을 오인하면 안 된다");
  ok("경계는 base 자신 또는 base + '/' 만 인정");
}
{
  // 중첩 루트 — 긴 base 가 이겨야 subpath 가 맞다.
  const nested = [{ key: "outer", base: "/srv" }, { key: "inner", base: "/srv/lively/shared" }];
  assert.deepEqual(splitByBases("/srv/lively/shared/a", nested), { rootKey: "inner", subpath: "a" });
  ok("중첩 루트는 긴 base 우선(짧은 쪽이 이기면 subpath 가 어긋난다)");
}
{
  assert.deepEqual(splitByBases("/srv/lively/shared/./a/../b", BASES), { rootKey: "shared", subpath: "b" },
    "경로 정규화 후 판정");
  ok("`.`·`..` 가 섞인 dir 도 정규화해 판정");
}

// ── backfillSessionStates: 무엇을 만들고 무엇을 건너뛰나 ──
function sess(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "box-yoon-1", label: "라벨", harness: "claude", dir: "/srv/lively/shared/w", autoApprove: true,
    owner: "yoon", owned: true, created: 1_000, attached: false, invites: ["mike"], flags: { "--model": "opus" },
    agentState: "offline", projectId: 7, lastActive: 2_000, ...over,
  };
}
async function run(opts: { live: SessionInfo[]; states?: string[]; managed?: string[] }): Promise<{
  res: Awaited<ReturnType<typeof backfillSessionStates>>; upserts: any[];
}> {
  const upserts: any[] = [];
  const res = await backfillSessionStates({
    listLive: async () => opts.live,
    listStates: async () => (opts.states ?? []).map((id) => ({ id })),
    listManaged: async () => (opts.managed ?? []).map((id) => ({ session_id: id })),
    resolveRoot: (async (_u: unknown, key: string) => {
      const b = BASES.find((x) => x.key === key);
      if (!b) throw new Error("unknown root");
      return { base: b.base, abs: b.base };
    }) as never,
    upsert: (async (row: unknown) => { upserts.push(row); }) as never,
  });
  return { res, upserts };
}

{
  const { res, upserts } = await run({ live: [sess()] });
  assert.deepEqual(res.added, ["box-yoon-1"]);
  const r = upserts[0];
  assert.equal(r.root_key, "shared"); assert.equal(r.subpath, "w");
  assert.equal(r.owner, "yoon"); assert.equal(r.harness, "claude"); assert.equal(r.label, "라벨");
  assert.equal(r.auto_approve, true); assert.deepEqual(r.invites, ["mike"]);
  assert.deepEqual(r.flags, { "--model": "opus" });
  assert.equal(r.project_id, 7); assert.equal(r.project_src, "v6");
  assert.equal(r.created, 1_000); assert.equal(r.last_busy, 2_000);
  assert.equal(r.read_only, false); assert.equal(r.incognito, false); // tmux 에 없는 필드 = 기본값(문서화된 한계)
  ok("레코드 없는 세션에 tmux 메타를 그대로 미러링(복원 좌표 역산 포함)");
}
{
  const { res, upserts } = await run({ live: [sess()], states: ["box-yoon-1"] });
  assert.deepEqual(res.added, []); assert.equal(res.skipped.hasState, 1); assert.equal(upserts.length, 0);
  ok("이미 레코드가 있으면 건드리지 않는다(사용자가 편집한 값을 tmux 값으로 되돌리지 않게)");
}
{
  const { res, upserts } = await run({ live: [sess()], managed: ["box-yoon-1"] });
  assert.deepEqual(res.added, []); assert.equal(res.skipped.managed, 1); assert.equal(upserts.length, 0);
  ok("managed(상시) 세션은 제외 — keep-alive 가 영속을 소유한다");
}
{
  // 허용 루트 밖 → 레코드를 만들면 '회수 가능하지만 복원 불가' 가 된다. 반드시 건너뛴다.
  const { res, upserts } = await run({ live: [sess({ id: "box-yoon-out", dir: "/home/box_test/lively/x" })] });
  assert.deepEqual(res.added, []); assert.equal(res.skipped.noRoot, 1); assert.equal(upserts.length, 0);
  ok("허용 루트 밖 세션은 백필하지 않는다(불변식 ④ 보호)");
}
{
  // 소유자 없는 이상 레코드는 만들지 않는다(owner 는 복원 신원이라 비면 복원이 불가능).
  const { res, upserts } = await run({ live: [sess({ id: "box-noowner", owner: "" })] });
  assert.deepEqual(res.added, []); assert.equal(res.skipped.failed, 1); assert.equal(upserts.length, 0);
  ok("소유자 미상 세션은 건너뛴다");
}
{
  const { res, upserts } = await run({ live: [sess({ id: "box-yoon-np", projectId: 0 })] });
  assert.deepEqual(res.added, ["box-yoon-np"]);
  assert.equal(upserts[0].project_id, null); assert.equal(upserts[0].project_src, null);
  ok("프로젝트 세션이 아니면 project_* 는 null");
}
{
  // upsert 가 터져도 나머지 세션은 계속 처리한다(한 건 실패가 전체를 막지 않는다).
  const upserts: any[] = [];
  const res = await backfillSessionStates({
    listLive: async () => [sess({ id: "boom" }), sess({ id: "fine" })],
    listStates: async () => [],
    listManaged: async () => [],
    resolveRoot: (async (_u: unknown, key: string) => {
      const b = BASES.find((x) => x.key === key); if (!b) throw new Error("x");
      return { base: b.base, abs: b.base };
    }) as never,
    upsert: (async (row: any) => { if (row.id === "boom") throw new Error("db down"); upserts.push(row); }) as never,
  });
  assert.deepEqual(res.added, ["fine"]); assert.equal(res.skipped.failed, 1);
  ok("한 건이 실패해도 나머지는 계속 백필한다");
}

console.log(`\nsession-state-backfill: ${pass} passed`);
