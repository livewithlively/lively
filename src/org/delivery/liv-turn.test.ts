// 리브 턴의 **안전 자세**(#1631 v1) — 이 파일이 지키는 건 하나다: 리브가 사람 앞에서 무엇을 못 하는가.
//
// 왜 이 단언들이 필요한가: 실측(2026-08-14, claude 2.1.232)에서 `--allowedTools` 와 `--permission-mode plan`
// 은 **둘 다 도구를 못 막았다**(Bash 가 그대로 실행됨). 실제 경계는 `--disallowedTools` 하나뿐이다.
// 그래서 이 축이 조용히 약해지는 것을 막는 게 전부다 — 약해져도 화면엔 아무 증상이 없다(리브는 잘 대답한다).
//
// | # | 조건 | 기대 |
// |---|---|---|
// | L1 | 첫 턴 | `--session-id <uuid>` (`--resume` 아님) |
// | L2 | 이어가는 턴 | `--resume <uuid>` (`--session-id` 아님) |
// | L3 | 언제나 | `--disallowedTools` 가 있고 그 뒤에 목록이 붙는다 |
// | L4 | 언제나 | 셸·파일·바깥·하위에이전트 도구가 **전부** 거부 목록에 있다 |
// | L5 | 언제나 | 라이블리 MCP·Skill 은 거부하지 않는다(그걸 막으면 리브가 아무것도 못 한다) |
// | L6 | uuid 가 아닌 세션 id | **던진다**(헤드리스라 그냥 두면 '아무 말도 안 나옴'이 된다) |
// | L7 | 인자 순서 | 거부 목록 **다음**이 `--resume`/`--session-id` 다 — 가변인자가 거기서 끊긴다 |
// | L8 | 거부 목록 | 비어 있지 않다(빈 목록 = 안전선 없음 = 우회와 같다) |
// | L9 | 우회 플래그 | 리브 인자에 **절대** 섞이지 않는다 |
import { strict as assert } from "node:assert";
import { LIV_DENIED_TOOLS, livTurnArgs } from "./liv-turn.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

t("L1 첫 턴은 --session-id 로 세션을 만든다", () => {
  const a = livTurnArgs({ sessionId: UUID, resume: false });
  assert.ok(a.includes("--session-id"), "첫 턴에 세션 id 를 안 주면 이어갈 id 가 안 생긴다");
  assert.ok(!a.includes("--resume"), "첫 턴에 --resume 을 주면 없는 대화를 이어받으려다 죽는다");
  assert.equal(a[a.length - 1], UUID);
});

t("L2 이어가는 턴은 --resume 으로 같은 대화를 잇는다", () => {
  const a = livTurnArgs({ sessionId: UUID, resume: true });
  assert.ok(a.includes("--resume"), "--resume 이 빠지면 매 턴이 첫 대화가 된다(리브가 방금 한 말을 잊는다)");
  assert.ok(!a.includes("--session-id"), "이미 있는 id 로 새 세션을 만들려 하면 충돌한다");
  assert.equal(a[a.length - 1], UUID);
});

t("L3 거부 플래그와 목록이 함께 실린다", () => {
  const a = livTurnArgs({ sessionId: UUID, resume: false });
  const i = a.indexOf("--disallowedTools");
  assert.ok(i >= 0, "거부 플래그가 없으면 리브가 무제한이다");
  assert.ok(a.length > i + 1 && !a[i + 1].startsWith("--"), "플래그만 있고 목록이 없으면 아무것도 안 막는다");
});

t("L4 기계·파일·바깥·하위에이전트 도구가 전부 막힌다", () => {
  const a = livTurnArgs({ sessionId: UUID, resume: false });
  // 하나라도 빠지면 리브가 사람 앞에서 승인 없이 그걸 쓴다 — 화면엔 증상이 없다.
  for (const tool of ["Bash", "BashOutput", "KillShell", "Write", "Edit", "NotebookEdit",
    "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task"]) {
    assert.ok(a.includes(tool), `${tool} 이 거부 목록에 없다 — 리브가 승인 없이 이걸 쓸 수 있다`);
  }
});

t("L5 라이블리 MCP·Skill 은 막지 않는다(막으면 리브가 아무것도 못 한다)", () => {
  for (const keep of ["Skill", "mcp__lively__org_collector_upsert", "mcp__lively__me_liv_ask_choice"]) {
    assert.ok(!LIV_DENIED_TOOLS.includes(keep), `${keep} 을 막으면 리브는 말만 하고 아무것도 못 한다`);
  }
  assert.ok(!LIV_DENIED_TOOLS.some((x) => x.startsWith("mcp__")), "MCP 도구를 통째로 막으면 리브의 손이 사라진다");
});

t("L6 uuid 가 아닌 세션 id 는 그 자리에서 거절한다", () => {
  // 헤드리스라 잘못된 id 는 조용히 죽는다 — 사람에겐 '아무 말도 안 나옴'으로 보인다.
  for (const bad of ["liv-yoon-1", "", "3f2504e0", "not-a-uuid-at-all-really-nope"]) {
    assert.throws(() => livTurnArgs({ sessionId: bad, resume: false }), /UUID/, `거절해야 한다: ${JSON.stringify(bad)}`);
  }
});

t("L7 가변인자 거부 목록 뒤에 곧바로 다음 플래그가 온다", () => {
  // 지키는 것은 **끊기는 자리**이지 그 뒤에 무엇이 오느냐가 아니다 — 목록과 다음 `--플래그` 사이에
  //  다른 게 끼면 그게 도구 이름으로 먹혀 안전선이 조용히 반쪽이 된다(그래도 실행은 되고 답도 나온다).
  //  그래서 '다음 토큰이 플래그다'만 고정한다. 새 플래그를 끼워도 이 단언은 계속 유효하다.
  for (const resume of [true, false]) {
    const a = livTurnArgs({ sessionId: UUID, resume });
    const i = a.indexOf("--disallowedTools");
    const after = i + 1 + LIV_DENIED_TOOLS.length;
    assert.ok(a[after]?.startsWith("--"),
      `거부 목록 바로 뒤가 플래그가 아니다(resume=${resume}): ${JSON.stringify(a[after])}`);
    // 목록 안에 플래그가 섞여 있으면 거기서 일찍 끊겨 뒤쪽 도구가 안 막힌다.
    for (let k = i + 1; k < after; k++) {
      assert.ok(!a[k].startsWith("--"), `거부 목록 안에 플래그가 섞였다: ${a[k]}`);
    }
  }
});

t("L10 이어가기 축은 언제나 마지막 두 자리다(uuid 가 플래그에 안 먹힌다)", () => {
  for (const [resume, flag] of [[true, "--resume"], [false, "--session-id"]] as const) {
    const a = livTurnArgs({ sessionId: UUID, resume });
    assert.equal(a[a.length - 2], flag, "이어가기 플래그가 제자리에 없다");
    assert.equal(a[a.length - 1], UUID, "uuid 가 그 플래그 바로 뒤가 아니면 다른 플래그의 값으로 먹힌다");
  }
});

t("L8 거부 목록이 비어 있지 않다", () => {
  assert.ok(LIV_DENIED_TOOLS.length > 0, "빈 거부 목록은 제한 없음과 같다 — 우회와 구별되지 않는다");
});

t("L9 승인 우회 플래그가 리브 인자에 섞이지 않는다", () => {
  const a = livTurnArgs({ sessionId: UUID, resume: false }).join(" ");
  for (const bypass of ["--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox",
    "--always-approve", "bypassPermissions"]) {
    assert.ok(!a.includes(bypass), `리브 인자에 ${bypass} 가 있다 — 사람 앞에서 승인 없이 도는 것과 같다`);
  }
});

console.log(`liv-turn.test: ok (${pass})`);
