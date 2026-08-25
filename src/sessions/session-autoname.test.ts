// 세션 자동 이름 (#1808) — 엣지 표의 각 행 = 시나리오 1개.
//  🔴 이 판정이 틀리면 **사람이 지은 세션 이름을 기계가 덮어쓴다**(되돌릴 방법이 화면에 없다).
import assert from "node:assert/strict";
import { autoNameUnnamedSession, type AutoNameDeps, type AutoNameTarget } from "./session-autoname.js";

function mk(target: AutoNameTarget | null, opts?: { renameThrows?: boolean }) {
  const calls = { renameLocal: [] as string[], renameNode: [] as string[], saveLabel: [] as string[] };
  const deps: AutoNameDeps = {
    lookup: async () => target,
    renameLocal: async (_o, id, label) => { if (opts?.renameThrows) throw new Error("no such session"); calls.renameLocal.push(`${id}=${label}`); },
    renameNode: async (n, _o, id, label) => { if (opts?.renameThrows) throw new Error("node offline"); calls.renameNode.push(`${n}/${id}=${label}`); },
    saveLabel: async (id, label) => { calls.saveLabel.push(`${id}=${label}`); },
  };
  return { deps, calls };
}
const box = (label: string | null, node?: string): AutoNameTarget => ({ id: "box-yoon-1a2b3c4d", label, owner: "yoon", node_id: node ?? null });

// ① 이름 없는 박스(label=id) — 첫 지시로 이름이 붙고 tmux·desired-state 둘 다 간다.
{
  const { deps, calls } = mk(box("box-yoon-1a2b3c4d"));
  assert.equal(await autoNameUnnamedSession("uuid", "랜딩 카피를 고쳐 줘", deps), "랜딩 카피를 고쳐 줘");
  assert.deepEqual(calls.renameLocal, ["box-yoon-1a2b3c4d=랜딩 카피를 고쳐 줘"]);
  assert.deepEqual(calls.saveLabel, ["box-yoon-1a2b3c4d=랜딩 카피를 고쳐 줘"]);
}
// ② ★사람이 지은 이름은 절대 안 덮는다 — 아무것도 안 부른다.
{
  const { deps, calls } = mk(box("랜딩 카피 수정"));
  assert.equal(await autoNameUnnamedSession("uuid", "다른 지시", deps), null);
  assert.deepEqual([...calls.renameLocal, ...calls.saveLabel], []);
}
// ③ ★멱등 — 한 번 붙으면 label 이 더는 id 가 아니라 다음 호출이 ②로 떨어진다(중복 개명 없음).
{
  const t = box("box-yoon-1a2b3c4d");
  const { deps, calls } = mk(t);
  await autoNameUnnamedSession("uuid", "첫 지시", deps);
  t.label = "첫 지시";
  assert.equal(await autoNameUnnamedSession("uuid", "첫 지시", deps), null);
  assert.equal(calls.saveLabel.length, 1, "두 번째 호출은 아무것도 안 한다");
}
// ④ 노드 세션 — 그 노드에 relay 한다(tmux 가 그 컴퓨터에 있다).
{
  const { deps, calls } = mk(box("box-yoon-1a2b3c4d", "hammurabi"));
  await autoNameUnnamedSession("uuid", "윈도우 노드 확인", deps);
  assert.deepEqual(calls.renameNode, ["hammurabi/box-yoon-1a2b3c4d=윈도우 노드 확인"]);
  assert.deepEqual(calls.renameLocal, []);
}
// ⑤ ★죽은 세션(복원 대기)·노드 오프라인 — tmux 반영은 실패해도 desired-state 이름은 남는다.
//   이게 없으면 멈춘 세션은 영영 id 가 이름이라 '지난 세션' 목록에서 구분이 안 된다.
{
  const { deps, calls } = mk(box("box-yoon-1a2b3c4d"), { renameThrows: true });
  assert.equal(await autoNameUnnamedSession("uuid", "중단된 그 작업", deps), "중단된 그 작업");
  assert.deepEqual(calls.saveLabel, ["box-yoon-1a2b3c4d=중단된 그 작업"]);
}
// ⑥ 매핑이 없다(그 대화를 돌린 박스를 모른다) — 아무것도 안 한다. 추측하지 않는다.
{
  const { deps, calls } = mk(null);
  assert.equal(await autoNameUnnamedSession("uuid", "지시", deps), null);
  assert.deepEqual(calls.saveLabel, []);
}
// ⑦ 이름 지을 거리가 없으면(빈 title) lookup 조차 안 한다.
{
  let looked = false;
  const deps: AutoNameDeps = { lookup: async () => { looked = true; return null; }, renameLocal: async () => {}, renameNode: async () => {}, saveLabel: async () => {} };
  assert.equal(await autoNameUnnamedSession("uuid", "   ", deps), null);
  assert.equal(looked, false);
}
console.log("ok  세션 자동 이름 7갈래");
