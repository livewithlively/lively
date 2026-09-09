// #2600 T2 d5 → **#3797 T7 로 축이 바뀌었다** — 세션 호스트는 (노드, 테넌트) 별로 하나다.
//
// ── 무엇이 달라졌나 ─────────────────────────────────────────────────────────
// d5 는 «테넌트당 하나» 였다: id 유도가 `sesshost-<slug>` 라 노드 성분이 없었고, 그래서 그 테넌트를
//  서빙하는 노드가 둘이면 **두 브로커가 같은 등록 행 하나를 두고 토큰을 서로 회전**시킨다. 그 모양이
//  2026-09-09 아침 사고의 뿌리였다 — 세션 호스트만 올라탄 노드는 오토스케일 계수에 «세션 0» 으로
//  보여 우선 회수됐고([[sesshost-node-scalein-orphan-3776]] §1), 그 노드와 함께 주인이 사라졌다.
// T7 은 축을 (노드, 테넌트)로 옮긴다: id 에 **노드 성분**이 들어가고, 각 호스트는 자기 노드 것만
//  보고한다. 그러면 세션 0 인 노드엔 호스트가 없어 그 사고가 **원리적으로** 불가능해진다.
//
// 엣지 표(N·C·D 행) — 행마다 시험 하나.
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  SESSION_HOST_MEMBER_ID, decideSessionHostNode, legacySessionHostNodes, sessionHostNodeId,
} from "./session-host-provision.js";

const ours = { owner_member: SESSION_HOST_MEMBER_ID, session_host: true };
const human = { owner_member: "sangmin-yoon", session_host: true };
const undeclared = { owner_member: SESSION_HOST_MEMBER_ID, session_host: false };

const SLUG = "lively-46e3";
const NODE = "i-02addbf327f377c99";      // 실측 노드 이름(AWS 인스턴스 id · 19자)

// ── 등록 행 처분(C1~C8) — 축이 바뀌어도 그대로다 ────────────────────────────
test("C1·C2 — 등록이 없으면 조회든 발급이든 create", () => {
  assert.equal(decideSessionHostNode({ existing: null, issue: false }), "create");
  assert.equal(decideSessionHostNode({ existing: null, issue: true }), "create");
});

test("★ C3·C5·C8 — issue=false(조회)는 **아무것도 바꾸지 않는다**", () => {
  assert.equal(decideSessionHostNode({ existing: ours, issue: false }), "keep");
  assert.equal(decideSessionHostNode({ existing: human, issue: false }), "keep", "주인이 틀려도 조회는 안 고친다");
  assert.equal(decideSessionHostNode({ existing: undeclared, issue: false }), "keep");
});

test("C4 — 이미 우리 것이고 발급 요청이면 회전만", () => {
  assert.equal(decideSessionHostNode({ existing: ours, issue: true }), "rotate");
});

test("★★ C6 — 사람 소유 등록은 발급 때 **주인부터 옮긴다**", () => {
  assert.equal(decideSessionHostNode({ existing: human, issue: true }), "fix-and-rotate");
});

test("★ C7 — 주인은 맞는데 세션 호스트 선언이 꺼져 있으면 그것도 고친다(#2592 면제 축)", () => {
  assert.equal(decideSessionHostNode({ existing: undeclared, issue: true }), "fix-and-rotate");
});

// ── ★★ N — id 유도에 **노드 성분**이 들어간다 (#3797 T7 의 핵심) ────────────
test("★★ N1 — id 는 (슬러그, 노드) 둘로 유도한다", () => {
  assert.equal(sessionHostNodeId(SLUG, NODE), `sesshost-${SLUG}-${NODE}`);
});

test("★★ N2 — **노드가 다르면 id 가 다르다**(같은 테넌트라도) — 이 한 줄이 T7 의 전부다", () => {
  //  이게 안 되면 두 노드의 브로커가 같은 등록 행 하나를 두고 토큰을 서로 회전시켜 죽인다.
  const a = sessionHostNodeId(SLUG, "i-0a7632ed53ebc4c1d");
  const b = sessionHostNodeId(SLUG, "i-02addbf327f377c99");
  assert.ok(a && b, "둘 다 유도돼야 한다");
  assert.notEqual(a, b, "🔴 노드가 달라도 같은 id 가 나왔다 — 축이 여전히 테넌트 하나다");
});

test("★ N3 — 노드 성분이 **없으면 지어내지 않는다**(null) — 옛 브로커의 nodeless 요청", () => {
  //  옛 브로커(#3797 이전)는 node 를 안 보낸다. 그때 «테넌트 하나» 짜리 행을 만들면 그게 곧 옛 축이다.
  assert.equal(sessionHostNodeId(SLUG, ""), null);
  assert.equal(sessionHostNodeId(SLUG, "   "), null);
});

test("★ N4 — 모양이 아니면 지어내지 않고 null(슬러그·노드 양쪽)", () => {
  assert.equal(sessionHostNodeId("", NODE), null, "빈 슬러그");
  assert.equal(sessionHostNodeId("Bad-Case", NODE), null, "대문자는 슬러그가 아니다");
  assert.equal(sessionHostNodeId("-leading", NODE), null, "첫 글자는 영숫자");
  assert.equal(sessionHostNodeId("has space", NODE), null, "공백");
  assert.equal(sessionHostNodeId(SLUG, "Node Name"), null, "노드 이름에 공백");
  assert.equal(sessionHostNodeId(SLUG, "-lead"), null, "노드 이름 첫 글자는 영숫자");
});

test("★★ N5 — 상한(64자)이 경계다: 넘으면 자르지 않고 null", () => {
  //  ⚠ **자르지 않는다.** 자른 이름은 다른 노드·다른 테넌트와 겹칠 수 있고, 그러면 두 브로커가
  //   같은 등록 행(=같은 토큰)을 쓴다 — 격리가 조용히 사라지느니 «못 한다» 가 맞는 답이다.
  const slug = "a".repeat(26), node = "b".repeat(28);      // 9 + 26 + 1 + 28 = 64
  assert.equal(sessionHostNodeId(slug, node)?.length, 64, "상한 안(정확히 64)");
  assert.equal(sessionHostNodeId(slug, `${node}c`), null, "65자면 store.normalizeNodeId 가 400 을 던진다");
});

test("N6 — 실측 좌표(슬러그 11 + 노드 19)는 상한 안에 넉넉히 든다", () => {
  assert.equal(sessionHostNodeId(SLUG, NODE)?.length, 40);
});

// ── ★★ D — **남의 노드 등록을 물려받지 않는다** (d5 §② 규율의 재작성) ───────
//  d5 는 «이름이 아니라 선언으로 찾아 물려받는다» 였다. 그 규칙은 «테넌트당 하나» 를 전제한다 —
//  (노드, 테넌트) 축에서는 같은 동작이 정확히 **남의 노드 주인을 빼앗는** 일이 된다.
const n = (id: string, session_host: boolean): { id: string; session_host: boolean } => ({ id, session_host });

test("★★ D1 — 옛 축의 잔재(`sesshost-<slug>` · 노드 성분 없음)를 **이름으로 짚는다**", () => {
  //  어느 노드도 그 행을 조정하지 않는다 → 영영 오프라인 → 그 동안 목록 소유가 안 넘어간다.
  //  물려받으면(d5 의 동작) 그 순간 두 노드가 같은 행을 두고 다시 싸운다. 남겨 두고 이름만 남긴다.
  const got = legacySessionHostNodes(
    [n(`sesshost-${SLUG}`, true), n(`sesshost-${SLUG}-${NODE}`, true), n("haruui-macbookair", false)],
    SLUG,
  );
  assert.deepEqual(got, [`sesshost-${SLUG}`], "🔴 잔재를 못 짚었거나 형제를 잔재로 봤다");
});

test("★★ D2 — **형제는 잔재가 아니다** — 같은 테넌트의 다른 노드 호스트는 새 축의 정상이다", () => {
  //  이걸 걸면 노드 N 대에서 매 조정(5분)마다 N-1 건의 경고가 전 노드에서 돈다 — 아무도 안 보는 줄이 된다.
  const got = legacySessionHostNodes(
    [n(`sesshost-${SLUG}-${NODE}`, true), n(`sesshost-${SLUG}-i-0a7632ed53ebc4c1d`, true)],
    SLUG,
  );
  assert.deepEqual(got, [], "🔴 형제 노드의 세션 호스트를 «남의 것»으로 봤다(정상 상태에서 경고가 쏟아진다)");
});

test("★ D3 — 다른 테넌트 이름을 단 행도 잔재다(사람이 손으로 만든 이름)", () => {
  assert.deepEqual(legacySessionHostNodes([n("sesshost-46e3", true)], SLUG), ["sesshost-46e3"]);
});

test("D4 — 선언 안 된 노드는 애초에 후보가 아니다", () => {
  assert.deepEqual(legacySessionHostNodes([n("haruui-macbookair", false), n("hammurabi", false)], SLUG), []);
});

test("★ D5 (한계를 명시) — 접두가 겹치는 다른 테넌트의 이름은 **형제로 보인다**", () => {
  //  슬러그 `lively` 로 볼 때 `sesshost-lively-46e3-i-0abc` 는 `sesshost-lively-` 로 시작하므로 형제로 읽힌다.
  //  ★ 그래도 안전한 이유: `listNodes()` 가 주는 행은 **그 테넌트 것뿐**이다(PK 가 `(tenant_id, id)` — db/tenant-column.ts).
  //   남의 테넌트 행이 이 목록에 섞일 길이 없으므로 이 겹침은 실제로 발생하지 않는다. 여기 적어 두는 것은,
  //   나중에 이 함수를 **테넌트 경계 밖** 목록에 쓰면 그 순간 이 가정이 깨지기 때문이다.
  assert.deepEqual(legacySessionHostNodes([n("sesshost-lively-46e3-i-0abc", true)], "lively"), []);
});
