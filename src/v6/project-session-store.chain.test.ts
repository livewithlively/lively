// 이어받기 소속 승계(#1867) — 어느 축을 어떤 순서로 보나. DB 는 lookup 주입으로 대신한다(순서·건너뜀이 사양이다).
//  엣지: ①실행 id 에 소속이 있으면 그게 답 ②없으면 대화 uuid ③빈 축은 조회조차 안 한다 ④둘 다 없으면 null.
import assert from "node:assert/strict";
import test from "node:test";
import { latestProjectForSessionChain } from "./project-session-store.js";

const P = (id: number) => ({ id, folder: `project/${id}` });
/** 호출된 id 를 기록하는 가짜 조회 — 표에 있는 id 만 소속이 있다. */
function fake(table: Record<string, { id: number; folder: string }>): { lookup: (id: string) => Promise<{ id: number; folder: string } | null>; seen: string[] } {
  const seen: string[] = [];
  return { seen, lookup: async (id: string) => { seen.push(id); return table[id] ?? null; } };
}

test("실행 세션 id 의 소속이 이긴다 — 옮긴 뒤의 정답은 실행 축이고 대화 축은 낡을 수 있다", async () => {
  const f = fake({ "box-a": P(2015), "conv-1": P(1867) });
  assert.deepEqual(await latestProjectForSessionChain(["box-a", "conv-1"], f.lookup), P(2015));
  assert.deepEqual(f.seen, ["box-a"], "이겼으면 대화 축은 조회하지 않는다");
});

// ★ 실측(2026-08-25): 대화 1bf015ec… 가 #1867 에 붙어 있었는데, 그 대화를 이어받은 box-yoon-6178a7c3 은
//  실행 id 로 아무 소속도 못 찾아 훅이 새 프로젝트 #2015 를 만들었다. 이 줄이 그 재발을 막는다.
test("실행 id 에 소속이 없으면 이어받은 대화의 마지막 소속을 승계한다", async () => {
  const f = fake({ "conv-1": P(1867) });
  assert.deepEqual(await latestProjectForSessionChain(["box-new", "conv-1"], f.lookup), P(1867));
  assert.deepEqual(f.seen, ["box-new", "conv-1"], "실행 축을 먼저 보고 나서 대화 축");
});

test("빈 축(대화 uuid 없음)은 조회하지 않는다 · 아무 데도 없으면 null", async () => {
  const f = fake({});
  assert.equal(await latestProjectForSessionChain(["box-new", null, undefined, "  "], f.lookup), null);
  assert.deepEqual(f.seen, ["box-new"], "null·빈문자는 DB 를 때리지 않는다");
});
