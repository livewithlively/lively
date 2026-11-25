// 프로젝트·태스크 본문 수정의 서술 형식 판정(checkProjectText) — 2026-10-14 리뷰 H(꺼진 조직의 조회) · D(입력만으로 판정 생략).
//  실행: npm run build && node dist/capabilities/projects-v6-writing-format.test.js
//  형식과 이전 본문은 주입한다(DB 없음) — «무엇을 읽었나 · 무엇을 거부했나» 로 단언한다.
//
//  회귀 대상 H: 형식을 켜지 않은 조직(기본값)에서도 본문 전체 교체마다 이전 본문(getNodeRow)을 읽었다.
//  회귀 대상 D: 이어쓰기 조각에 `## 첫 지시(원문)` 헤딩이나 자동 생성 표식이 있기만 하면 판정을 통째로 건너뛰었다 —
//   헤딩 한 줄로 형식 검사를 비껴갈 수 있었다. 이제는 사람의 지시 인용(그 절)과 껍데기 안내 문구만 빼고 나머지는 본다.
//
//  엣지 표(입력 조합 × 기대):
//   H1 | 꺼진 조직 · 전체 교체                                   | 이전 본문을 안 읽는다 · 판정 없음
//   H2 | project 표면을 뺀 조직 · 전체 교체                       | 이전 본문을 안 읽는다 · 판정 없음
//   H3 | 본문을 안 건드린 수정(이름만)                            | 형식도 안 읽는다
//   H4 | 켠 조직 · 전체 교체에 새 위반                            | 이전 본문을 한 번 읽고 거부
//   H5 | 형식 조회가 던짐                                        | 판정 없음(fail-open) · 이전 본문 안 읽음
//   D1 | 첫 지시 절 + 뒤에 에이전트 절(새 위반)                    | 거부 — 에이전트 절의 위반만(사람 지시의 경로는 안 센다)
//   D2 | 껍데기 본문을 통째로 옮김(안내 줄 + 첫 지시 + 표식)        | 판정 없음 — 사람의 지시는 고칠 글이 아니다
//   D3 | 옮긴 껍데기의 지시 안에 `## ` 헤딩이 있다                  | 판정 없음 — 표식까지가 지시다
//   D4 | 옮긴 껍데기 뒤에 에이전트 메모(새 위반)                     | 거부
//   D5 | 자동 생성 표식만 붙인 에이전트 글                          | 거부 — 표식은 통행증이 아니다
//   D6 | 첫 지시 없는 껍데기(«세션을 열 때 자동 생성») 본문을 옮김    | 판정 없음(안내 문구의 «이 세션» 을 상대시간으로 세지 않는다)
//   D7 | 전체 교체: 이전 본문의 사람 지시에만 경로가 있었고 에이전트가 경로를 새로 씀 | 거부(사람 지시 속 경로를 «원래 있던 위반» 으로 치지 않는다)
//   D8 | 전체 교체: 껍데기 본문 + 위반 없는 에이전트 절               | 판정 없음
//   D9 | 사람의 웹 편집(세션)이 D1 조각                             | 거부 없이 안내만
import assert from "node:assert/strict";
import { checkProjectText } from "./projects-v6.js";
import { resolveWritingFormat, type WritingFormat } from "../org/policies/writing-format.js";
import { AUTO_CREATED_MARK, FIRST_PROMPT_HEADING, shellProjectFromPrompt, unnamedShellProject } from "../project/first-prompt-project.js";
import type { LivelyUser } from "../context.js";

const AGENT = { userId: "agent-1", email: "", scopes: ["memory"], projects: ["*"], tokenSource: "db" } as LivelyUser;
const HUMAN = { ...AGENT, userId: "human-1", tokenSource: "session" } as LivelyUser;
const ON = resolveWritingFormat({ enabled: true, rules: { local_path: "reject", relative_time: "reject" } });
const OFF = resolveWritingFormat({});
const NO_PROJECT = resolveWritingFormat({ enabled: true, apply_to: ["knowledge", "activity"], rules: { local_path: "reject" } });

function deps(fmt: WritingFormat, row: { description?: string | null } | null = { description: "" }) {
  const calls = { format: 0, row: 0 };
  return {
    calls,
    d: {
      loadFormat: async () => { calls.format++; return fmt; },
      loadRow: async () => { calls.row++; return row; },
    },
  };
}
type Check = Awaited<ReturnType<typeof checkProjectText>>;
const rejected = (r: Check): string[] => [...new Set(r.rejects.map((f) => f.rule))].sort();
const shell = (prompt: string): string => String(shellProjectFromPrompt(prompt)?.description);

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

async function main(): Promise<void> {
  await t("H1 꺼진 조직의 전체 교체는 이전 본문을 읽지 않는다", async () => {
    const { calls, d } = deps(OFF, { description: "옛 본문" });
    const r = await checkProjectText({ description: "/Users/alice/x 를 고쳤다." }, 1, AGENT, d);
    assert.equal(calls.row, 0, "형식이 꺼졌는데 이전 본문을 읽었다");
    assert.deepEqual(r.rejects, []);
    assert.deepEqual(r.info, {});
  });

  await t("H2 project 표면을 뺀 조직도 이전 본문을 읽지 않는다", async () => {
    const { calls, d } = deps(NO_PROJECT, { description: "옛 본문" });
    const r = await checkProjectText({ description: "/Users/alice/x 를 고쳤다." }, 1, AGENT, d);
    assert.equal(calls.row, 0);
    assert.deepEqual(r.rejects, []);
  });

  await t("H3 본문을 안 건드린 수정은 형식도 읽지 않는다", async () => {
    const { calls, d } = deps(ON);
    const r = await checkProjectText({}, 1, AGENT, d);
    assert.equal(calls.format, 0);
    assert.equal(calls.row, 0);
    assert.deepEqual(r.rejects, []);
  });

  await t("H4 켠 조직의 전체 교체는 이전 본문을 한 번 읽고 새 위반을 거부한다", async () => {
    const { calls, d } = deps(ON, { description: "옛 본문이다." });
    const r = await checkProjectText({ description: "/Users/alice/x 를 고쳤다." }, 1, AGENT, d);
    assert.equal(calls.row, 1);
    assert.deepEqual(rejected(r), ["local_path"]);
  });

  await t("H5 형식을 못 읽으면 판정하지 않는다(fail-open) — 던지지 않고 이전 본문도 안 읽는다", async () => {
    const { calls, d } = deps(ON, { description: "옛 본문" });
    const r = await checkProjectText({ description: "/Users/alice/x 를 고쳤다." }, 1, AGENT,
      { ...d, loadFormat: async () => { throw new Error("db down"); } });
    assert.equal(calls.row, 0);
    assert.deepEqual(r.rejects, []);
  });

  await t("D1 첫 지시 절 뒤의 에이전트 절은 판정한다 — 사람 지시의 경로는 안 센다", async () => {
    const frag = [FIRST_PROMPT_HEADING, "", "/Users/bob/notes 를 정리해줘", "", "## 메모", "", "에이전트가 /Users/alice/y 를 확인했다."].join("\n");
    const { d } = deps(ON);
    const r = await checkProjectText({ append_description: frag }, 1, AGENT, d);
    assert.deepEqual(rejected(r), ["local_path"], "헤딩이 있다고 판정을 통째로 건너뛰면 안 된다");
    const lp = r.rejects.find((f) => f.rule === "local_path");
    assert.equal(lp?.count, 1, "사람 지시 속 경로까지 셌다");
    assert.match(String(lp?.sample), /alice/);
  });

  await t("D2 껍데기 본문을 통째로 옮긴 이어쓰기는 판정하지 않는다", async () => {
    const { d } = deps(ON);
    const r = await checkProjectText({ append_description: shell("어제 /Users/bob/x 에서 본 오류 고쳐줘") }, 1, AGENT, d);
    assert.deepEqual(r.rejects, []);
    assert.deepEqual(r.info, {}, "사람 지시와 안내 문구는 안내 대상도 아니다");
  });

  await t("D3 옮긴 껍데기의 지시 안에 `## ` 헤딩이 있어도 표식까지가 지시다", async () => {
    const { d } = deps(ON);
    const r = await checkProjectText({ append_description: shell("이거 해줘\n\n## 단계\n\n어제 /Users/bob/y 를 열어 봐") }, 1, AGENT, d);
    assert.deepEqual(r.rejects, []);
  });

  await t("D4 옮긴 껍데기 뒤의 에이전트 메모는 판정한다", async () => {
    const { d } = deps(ON);
    const frag = `${shell("정리해줘")}\n\n이관 메모: 오늘 /Users/alice/z 를 옮겼다.`;
    const r = await checkProjectText({ append_description: frag }, 1, AGENT, d);
    assert.deepEqual(rejected(r), ["local_path", "relative_time"]);
  });

  await t("D5 자동 생성 표식만 붙인 에이전트 글은 판정한다", async () => {
    const { d } = deps(ON);
    const r = await checkProjectText({ append_description: `에이전트가 /Users/alice/z 를 봤다.\n\n${AUTO_CREATED_MARK}` }, 1, AGENT, d);
    assert.deepEqual(rejected(r), ["local_path"]);
  });

  await t("D6 첫 지시 없는 껍데기 본문을 옮긴 이어쓰기는 판정하지 않는다", async () => {
    const { d } = deps(ON);
    const r = await checkProjectText({ append_description: unnamedShellProject().description }, 1, AGENT, d);
    assert.deepEqual(r.rejects, [], "안내 문구의 «이 세션» 을 에이전트의 상대시간으로 셌다");
  });

  await t("D7 전체 교체 — 사람 지시 속 경로를 «원래 있던 위반» 으로 치지 않는다", async () => {
    const before = shell("/Users/bob/notes 를 정리해줘");
    const { d } = deps(ON, { description: before });
    const r = await checkProjectText({ description: `${before}\n\n## 범위\n\n에이전트가 /Users/alice/w 를 정리했다.` }, 1, AGENT, d);
    assert.deepEqual(rejected(r), ["local_path"]);
  });

  await t("D8 전체 교체 — 껍데기 본문 + 위반 없는 에이전트 절은 판정 없음", async () => {
    const before = shell("/Users/bob/notes 를 정리해줘");
    const { d } = deps(ON, { description: before });
    const r = await checkProjectText({ description: `${before}\n\n## 범위\n\n노트 정리 규칙을 2026-11-25 에 정했다.` }, 1, AGENT, d);
    assert.deepEqual(r.rejects, []);
  });

  await t("D9 사람의 웹 편집은 거부 없이 안내만", async () => {
    const frag = [FIRST_PROMPT_HEADING, "", "정리해줘", "", "## 메모", "", "/Users/alice/y 를 확인했다."].join("\n");
    const { d } = deps(ON);
    const r = await checkProjectText({ append_description: frag }, 1, HUMAN, d);
    assert.deepEqual(r.rejects, []);
    assert.ok("style" in r.info, "안내는 실린다");
  });

  console.log(`projects-v6-writing-format: ${pass} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
