// 소유가 넘어간 테넌트에서 tmux 를 안 묻고 답하는 두 판정 (#2600 T2 d6).
//   ① `hostOwnedSnapshot` — «지금 중앙(박스) tmux 에 무엇이 있나»(자기노드 판정·관리자 세션 뷰·백필이 묻는 것)
//   ② `remoteNodeCoordinate` — «이 좌표가 정말 다른 기계인가»(대화창·대화창 키·대화 파일 감시자가 묻는 것)
//
//  ── 무엇을 지키나 ──
//  2026-09-11 계수: 전 테넌트 켜기(#3749) 뒤에도 게이트웨이가 그 테넌트에 분당 ~70번 tmux 를 쳤다. 그 질문들을
//   세션 호스트 스냅샷으로 옮기는데, 옮길 때 틀리기 쉬운 곳은 **«모름» 을 «없음» 으로 답하는 것**이다 —
//   부분 관측을 전량으로 · 못 덮은 순간을 «0개» 로 · tmux 판정 실패를 «저쪽 기계» 로. 그래서 표의 절반이
//   «null(종전 경로)» 쪽에 몰려 있다. 값만 재면 우연히 통과할 수 있어 «tmux 를 물었나» 도 호출로 잰다.
//  엣지 표는 스크래치패드 `d6/spec.md` 의 A(C1~C9)·B(R1~R8) — 행마다 시험 하나.
import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_HOST_DEAD_MS, hostOwnedSnapshot, remoteNodeCoordinate, sessionHostVerdict } from "./self-node.js";

/** registry 의 `STATE_STALE_MS` 와 같은 값 — 소유 판정과 **같은 자**를 쓴다는 것이 사양이다. */
const STALE = 12_000;

type Node = { declared: boolean; online: boolean; stateAgeMs: number | null; sessions: readonly string[] };
/** 기본은 «자격 있는 세션 호스트» — 각 행은 **한 칸만** 뒤집어 그 칸이 무는지 본다. */
const node = (o: Partial<Node> = {}): Node => ({ declared: true, online: true, stateAgeMs: 1_000, sessions: ["box-a"], ...o });

// ── ① hostOwnedSnapshot ─────────────────────────────────────────────────────
test("C1 선언 호스트 둘이 다 자격이면 두 스냅샷의 합 — (노드, 테넌트) 축의 정상 상태", () => {
  const r = hostOwnedSnapshot([node({ sessions: ["box-a", "box-b"] }), node({ sessions: ["box-c"] })], STALE);
  assert.deepEqual(r, { rows: ["box-a", "box-b", "box-c"], why: "ok" });
});

test("C2 ★ 선언 호스트가 하나라도 낡았으면 null — 부분 관측을 전량으로 답하지 않는다", () => {
  //  이 칸이 안 물면 그 노드의 세션이 «중앙 tmux 에 없음» 이 된다 — 관리자 뷰·CP idle 에서 사라지고,
  //   자기노드 판정은 그 세션을 보고한 노드를 못 잡는다.
  const r = hostOwnedSnapshot([node({ sessions: ["box-a"] }), node({ sessions: ["box-b"], stateAgeMs: STALE + 1 })], STALE);
  assert.deepEqual(r, { rows: null, why: "stale" });
});

test("C3 ★ 멤버 PC 노드의 세션은 중앙 목록이 아니다 — 소유가 넘어가도 넣지 않는다", () => {
  const r = hostOwnedSnapshot([node({ declared: false, sessions: ["pc-1"] }), node({ sessions: ["box-a"] })], STALE);
  assert.deepEqual(r, { rows: ["box-a"], why: "ok" });
});

test("C4 ★★ 판정은 ok 인데 합이 비면 null(why=empty) — «0개» 가 아니라 «아직 못 덮었다»", () => {
  //  세션 호스트는 그 노드에 그 테넌트 세션이 있을 때만 선다. 그러니 «자격 호스트가 있는데 중앙 세션 0» 은
  //   정상 상태가 아니다. 이걸 0개로 답하면 CP idle 의 정지 판정이 «바쁜 세션 없음» 으로 읽는다.
  const r = hostOwnedSnapshot([node({ sessions: [] }), node({ sessions: [] })], STALE);
  assert.deepEqual(r, { rows: null, why: "empty" });
});

test("C5 선언 호스트 없음(멤버 PC 만) → null(undeclared) — 셀프호스트·멤버 PC 배포 무회귀", () => {
  assert.deepEqual(hostOwnedSnapshot([node({ declared: false })], STALE), { rows: null, why: "undeclared" });
});

test("C6 스코프에 노드 0 → null(no-hosts)", () => {
  assert.deepEqual(hostOwnedSnapshot([], STALE), { rows: null, why: "no-hosts" });
});

test("C7 ★ 죽은 호스트(지평선 너머)는 판정에서도 합에서도 빠진다", () => {
  const dead = node({ online: false, stateAgeMs: SESSION_HOST_DEAD_MS + 1, sessions: ["box-dead"] });
  assert.deepEqual(hostOwnedSnapshot([dead, node({ sessions: ["box-a"] })], STALE), { rows: ["box-a"], why: "ok" });
});

test("C8 신선도 경계는 **포함** — 정확히 staleMs 면 넣는다(소유 판정과 같은 자)", () => {
  assert.deepEqual(hostOwnedSnapshot([node({ stateAgeMs: STALE })], STALE), { rows: ["box-a"], why: "ok" });
});

test("C9 ★ 행을 내는 것은 소유 판정이 참일 때뿐이다 — 판정과 어긋나는 판이 없다", () => {
  const tables: Node[][] = [
    [], [node()], [node({ declared: false })], [node({ online: false })], [node({ stateAgeMs: null })],
    [node({ stateAgeMs: STALE + 1 })], [node(), node({ online: false })], [node({ sessions: [] })],
    [node({ declared: false, online: false, stateAgeMs: null }), node()],
  ];
  let producedRows = 0;
  for (const nodes of tables) {
    const r = hostOwnedSnapshot(nodes, STALE);
    if (!r.rows) continue;
    producedRows++;
    assert.equal(sessionHostVerdict(nodes, STALE).owns, true, `판정이 거짓인데 행을 냈다: ${JSON.stringify(nodes)}`);
  }
  //  배선 — 표가 전부 null 이면 위 단언은 한 번도 안 돈다(통과하면서 아무것도 안 본다).
  assert.ok(producedRows >= 2, `행을 낸 표가 ${producedRows}개뿐이다 — 이 교차 확인이 아무것도 안 보고 있다`);
});

// ── ② remoteNodeCoordinate ──────────────────────────────────────────────────
const HOST = "sesshost-acme-i-0abc";
const PC = "haruui-macbookair";
const isHost = (id: string): boolean => id === HOST;

/** tmux 판정 스텁 — 몇 번 물었는지 센다(«안 묻는다» 를 값이 아니라 호출로 잰다). */
function goneStub(answer: boolean | Error): { gone: (id: string) => Promise<boolean>; asked: string[] } {
  const asked: string[] = [];
  return {
    gone: async (id: string) => { asked.push(id); if (answer instanceof Error) throw answer; return answer; },
    asked,
  };
}

test("R1 좌표 없음 → null, tmux 를 안 묻는다", async () => {
  const g = goneStub(true);
  assert.equal(await remoteNodeCoordinate({ sessionId: "box-a", nodeId: null, isSessionHost: isHost, centralIds: null, gone: g.gone }), null);
  assert.deepEqual(g.asked, []);
});

test("R2 ★ 좌표가 선언된 세션 호스트 → null(같은 tmux), 소유 판정과 무관하게 tmux 를 안 묻는다", async () => {
  //  이 행이 전 테넌트 켜기 뒤 대화창의 분당 10번 has-session 을 없애고, 대화창 키의 409 를 푼다 —
  //   매니지드 세션엔 전부 호스트 좌표가 붙는다.
  //  ⚠ 소유가 안 넘어간 순간(centralIds=null)이고 tmux 가 «없다» 고 답할 판이어도 같다:
  //   «다른 기계인가» 는 생사가 아니라 선언의 문제다(#3745).
  const g = goneStub(true);
  assert.equal(await remoteNodeCoordinate({ sessionId: "box-a", nodeId: HOST, isSessionHost: isHost, centralIds: null, gone: g.gone }), null);
  assert.deepEqual(g.asked, [], "세션 호스트 좌표인데 tmux 에 물었다");
});

test("R3 ★ 멤버 PC 좌표 + 소유 넘어감 + 중앙 세션에 있음 → null(셀프 노드가 가로챈 모양 #2055), tmux 안 묻는다", async () => {
  const g = goneStub(true);
  assert.equal(await remoteNodeCoordinate({ sessionId: "box-a", nodeId: PC, isSessionHost: isHost, centralIds: new Set(["box-a"]), gone: g.gone }), null);
  assert.deepEqual(g.asked, []);
});

test("R4 ★ 멤버 PC 좌표 + 소유 넘어감 + 중앙 세션에 없음 → 그 PC, tmux 안 묻는다", async () => {
  const g = goneStub(false);
  assert.equal(await remoteNodeCoordinate({ sessionId: "pc-1", nodeId: PC, isSessionHost: isHost, centralIds: new Set(["box-a"]), gone: g.gone }), PC);
  assert.deepEqual(g.asked, []);
});

test("R5 멤버 PC 좌표 + 소유 안 넘어감 + tmux 가 «없다» 확답 → 그 PC(종전 그대로)", async () => {
  const g = goneStub(true);
  assert.equal(await remoteNodeCoordinate({ sessionId: "pc-1", nodeId: PC, isSessionHost: isHost, centralIds: null, gone: g.gone }), PC);
  assert.deepEqual(g.asked, ["pc-1"]);
});

test("R6 멤버 PC 좌표 + 소유 안 넘어감 + tmux 에 있다 → null(이 박스 것 — 종전 #2055)", async () => {
  const g = goneStub(false);
  assert.equal(await remoteNodeCoordinate({ sessionId: "box-a", nodeId: PC, isSessionHost: isHost, centralIds: null, gone: g.gone }), null);
  assert.deepEqual(g.asked, ["box-a"]);
});

test("R7 ★ tmux 판정이 던지면(모름) 이 박스 것으로 접는다 — 대화창이 빈 중앙 기록으로 물러나지 않게", async () => {
  const g = goneStub(new Error("relay down"));
  assert.equal(await remoteNodeCoordinate({ sessionId: "box-a", nodeId: PC, isSessionHost: isHost, centralIds: null, gone: g.gone }), null);
  assert.deepEqual(g.asked, ["box-a"], "배선 — 던지는 판정기를 실제로 불렀어야 이 행이 뜻이 있다");
});

test("R8 공백뿐인 좌표는 없는 좌표다 — 선언도 tmux 도 안 묻는다", async () => {
  const g = goneStub(true);
  const neverHost = (): boolean => { throw new Error("공백 좌표로 선언을 물었다"); };
  assert.equal(await remoteNodeCoordinate({ sessionId: "box-a", nodeId: "   ", isSessionHost: neverHost, centralIds: null, gone: g.gone }), null);
  assert.deepEqual(g.asked, []);
});
