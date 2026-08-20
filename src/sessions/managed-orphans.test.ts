// 상시세션 고아 판정(#1675 ⑥) — 레지스트리 1건인데 tmux 에 30개가 떠 있던 실측이 이 표의 근거다.
//  틀렸을 때: 못 걷으면 claude 프로세스 29개 = 5.7GB 가 그대로 남고(어니스트 실측),
//  잘못 걷으면 **일하고 있는 상시세션을 죽인다**(분류·증류가 멈춘다).
import { strict as assert } from "node:assert";
import { classifyManagedLive, managedSubpath } from "./managed-sessions.js";

const S = (id: string, dir: string, created = 0) => ({ id, dir, created });
const WS = "/srv/lively/shared/managed/knowledge-classify";

// ── 워크스페이스 경로 산출 ──
assert.equal(managedSubpath({ id: "knowledge-classify", workspace_subpath: null }), "managed/knowledge-classify",
  "등록값이 없을 때의 관례 경로가 틀렸다");
assert.equal(managedSubpath({ id: "x", workspace_subpath: "custom/place" }), "custom/place",
  "등록된 워크스페이스를 무시했다");

// ── 살아있는 게 없으면 아무것도 안 한다 ──
{
  const r = classifyManagedLive({ live: [], subpath: "managed/knowledge-classify", registered: "box-a" });
  assert.equal(r.keep, null);
  assert.deepEqual(r.orphans, []);
}

// ── 정상 1개 — 등록된 것을 유지, 걷을 것 없음 ──
{
  const r = classifyManagedLive({ live: [S("box-a", WS)], subpath: "managed/knowledge-classify", registered: "box-a" });
  assert.equal(r.keep, "box-a");
  assert.deepEqual(r.orphans, [], "정상 상태인데 걷으려 한다 — 일하는 세션이 죽는다");
}

// ── ★어니스트 실측 형태 — 30개 중 등록된 1개만 남기고 29개를 걷는다 ──
{
  const live = Array.from({ length: 30 }, (_, i) => S(`box-${i}`, WS, i));
  const r = classifyManagedLive({ live, subpath: "managed/knowledge-classify", registered: "box-7" });
  assert.equal(r.keep, "box-7", "레지스트리가 가리키는 세션을 안 남겼다 — 레지스트리가 권위다");
  assert.equal(r.orphans.length, 29, `고아 29개를 걷어야 하는데 ${r.orphans.length}개만 걷는다`);
  assert.ok(!r.orphans.includes("box-7"), "유지 대상을 고아 목록에 넣었다");
}

// ── 등록된 id 가 이미 죽었으면 가장 오래된 것을 승격한다(맥락이 쌓인 쪽) ──
{
  const live = [S("box-new", WS, 200), S("box-old", WS, 100), S("box-mid", WS, 150)];
  const r = classifyManagedLive({ live, subpath: "managed/knowledge-classify", registered: "box-dead" });
  assert.equal(r.keep, "box-old", "등록 id 가 죽었을 때 가장 오래된 세션을 안 남겼다");
  assert.deepEqual(r.orphans.sort(), ["box-mid", "box-new"]);
}
// 등록값 자체가 없을 때도 같다.
{
  const live = [S("box-new", WS, 200), S("box-old", WS, 100)];
  const r = classifyManagedLive({ live, subpath: "managed/knowledge-classify", registered: null });
  assert.equal(r.keep, "box-old");
}

// ── ★경로 경계 — 접두가 같은 다른 상시세션을 삼키면 안 된다 ──
{
  const live = [S("box-a", WS), S("box-b", WS + "-2"), S("box-c", "/srv/lively/shared/managed/other")];
  const r = classifyManagedLive({ live, subpath: "managed/knowledge-classify", registered: "box-a" });
  assert.deepEqual(r.orphans, [], "이름이 비슷한 다른 상시세션(-2)이나 무관한 세션을 고아로 잡았다 — 남의 세션을 죽인다");
  assert.equal(r.keep, "box-a");
}

// ── 경로 정보가 없는 세션은 대상이 아니다(모르면 안 건드린다) ──
{
  const live = [{ id: "box-x", created: 1 }, S("box-a", WS)];
  const r = classifyManagedLive({ live, subpath: "managed/knowledge-classify", registered: "box-a" });
  assert.deepEqual(r.orphans, [], "dir 을 모르는 세션을 고아로 판정했다");
}

// ── 후행 슬래시는 같은 경로다 ──
{
  const r = classifyManagedLive({ live: [S("box-a", WS + "/")], subpath: "managed/knowledge-classify", registered: null });
  assert.equal(r.keep, "box-a", "후행 슬래시 하나로 같은 워크스페이스를 못 알아봤다 — 중복 생성이 계속된다");
}

console.log("managed-orphans.test: ok");
