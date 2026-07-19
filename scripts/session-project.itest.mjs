// 세션↔프로젝트 시간구간(temporal) 귀속 — 통합검증 시나리오(#905 C1).
//  ⚠ 수동 실행(docker 필요). 도커 pg 기동/스텁테이블/dist 로드는 하니스가, 이 파일은 **행위만** 검증한다.
//  실행:  cd <repo> && npm run build && node scripts/session-project.itest.mjs   (docker 데몬 필요, 라이브 DB 무접촉)
//  근거: scratchpad/spec-session-project.md (B1~B6, E1~E2). 구현 무관 — 사양(행위)만 보고 짬.
//  시간 결정성: 구간귀속(B2·B3·E1·E2)은 bindAt(명시 valid_from)+addActivity(명시 atISO)로 세팅(now() 비의존).
//               recordBind(B1·B5·B6)은 now() 를 쓰므로 '바뀔 때만 구간 증가/멱등'·구간개수·프로젝트순서만 본다.
import assert from "node:assert/strict";
import {
  setup, teardown, mkProject, recordBind, bindAt, addActivity, timeline, rawBindings,
} from "./session-project-itest-harness.mjs";

let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };

await setup();
try {
  // ── B1. 단일 바인딩 → 세션 작업이 전부 그 프로젝트에 귀속 ──
  {
    const A = await mkProject("B1-A");
    const S = "b1-s";
    await recordBind(S, A);                                    // valid_from=now() → 열린 구간 [now, ∞)
    assert.equal((await rawBindings(S)).length, 1, "단일 바인딩 → 구간 1개");
    // 바인딩(now) 이후 시각의 작업 3건 — 전부 열린 구간 안이라 A 로 귀속돼야.
    await addActivity({ sessionId: S, title: "b1-a1", atISO: "2099-01-01T00:00:01Z" });
    await addActivity({ sessionId: S, title: "b1-a2", atISO: "2099-01-01T00:00:02Z" });
    await addActivity({ sessionId: S, title: "b1-a3", atISO: "2099-01-01T00:00:03Z" });
    const tl = await timeline(A);
    assert.ok(["b1-a1", "b1-a2", "b1-a3"].every((t) => tl.includes(t)), "3건 모두 A 타임라인에");
    ok("B1 단일 바인딩 → 세션 작업 3건 전부 그 프로젝트에 귀속");
  }

  // ── B2. 🔴 재바인딩은 과거를 옮기지 않는다 (이 슬라이스의 존재 이유) ──
  {
    const A = await mkProject("B2-A");
    const B = await mkProject("B2-B");
    const S = "b2-s";
    await bindAt(S, A, "2025-01-01T00:00:00Z");                                          // t1: A
    await addActivity({ sessionId: S, title: "b2-a1", atISO: "2025-02-01T00:00:00Z" }); // t2>t1: a1 은 A 밑
    await bindAt(S, B, "2025-03-01T00:00:00Z");                                          // t3: 재바인딩 → B
    await addActivity({ sessionId: S, title: "b2-a2", atISO: "2025-04-01T00:00:00Z" }); // t4>t3: a2 는 B 밑
    const tlA = await timeline(A), tlB = await timeline(B);
    assert.deepEqual(tlA, ["b2-a1"], "🔴 A 타임라인 = [a1] 만 (a1 사라지거나 a2 유입되면 버그)");
    assert.deepEqual(tlB, ["b2-a2"], "🔴 B 타임라인 = [a2] 만 (과거 a1 이 B 로 넘어오면 버그)");
    ok("B2 재바인딩 후 A=[a1]·B=[a2] — 과거는 옮겨가지 않음");
  }

  // ── B3. 구간 귀속 — 작업 발생시각이 어느 구간에 떨어지느냐로 갈린다 ──
  {
    const A = await mkProject("B3-A");
    const B = await mkProject("B3-B");
    const C = await mkProject("B3-C");
    const S = "b3-s";
    await bindAt(S, A, "2025-01-01T00:00:00Z"); // T0
    await bindAt(S, B, "2025-03-01T00:00:00Z"); // T2
    await bindAt(S, C, "2025-05-01T00:00:00Z"); // T4
    await addActivity({ sessionId: S, title: "b3-inA", atISO: "2025-02-01T00:00:00Z" }); // T0<=t<T2 → A
    await addActivity({ sessionId: S, title: "b3-inB", atISO: "2025-04-01T00:00:00Z" }); // T2<=t<T4 → B
    await addActivity({ sessionId: S, title: "b3-inC", atISO: "2025-06-01T00:00:00Z" }); // t>=T4    → C
    assert.deepEqual(await timeline(A), ["b3-inA"], "구간A 시각 작업만 A");
    assert.deepEqual(await timeline(B), ["b3-inB"], "구간B 시각 작업만 B");
    assert.deepEqual(await timeline(C), ["b3-inC"], "구간C 시각 작업만 C");
    ok("B3 작업 발생시각이 구간을 결정 → A/B/C 로 정확히 갈림");
  }

  // ── B4. 명시적 project_id 는 언제나 이긴다(세션 추론을 누른다) ──
  {
    const A = await mkProject("B4-A");
    const B = await mkProject("B4-B");
    const S = "b4-s";
    await bindAt(S, A, "2025-01-01T00:00:00Z"); // 세션은 A 에 바인딩
    // 작업엔 projectId=B 명시 + 발생시각은 A 구간 안(추론만이라면 A 로 갈 상황).
    await addActivity({ sessionId: S, projectId: B, title: "b4-e", atISO: "2025-02-01T00:00:00Z" });
    const tlA = await timeline(A), tlB = await timeline(B);
    assert.ok(tlB.includes("b4-e"), "명시된 B 타임라인에 나온다");
    assert.ok(!tlA.includes("b4-e"), "명시가 권위 — 세션이 바인딩된 A 에는 안 나온다");
    ok("B4 명시적 project_id 가 세션추론을 이긴다(B 에만 귀속)");
  }

  // ── B5. recordBind 는 실제로 바뀔 때만 구간을 늘린다(멱등/중복억제) ──
  {
    const A = await mkProject("B5-A");
    const B = await mkProject("B5-B");
    const S = "b5-s";
    await recordBind(S, A);
    await recordBind(S, A);
    await recordBind(S, A);                        // 같은 (S,A) 반복 → 멱등이어야
    let bs = await rawBindings(S);
    assert.deepEqual(bs.map((b) => b.projectId), [A], "같은 (S,A) 반복 → 구간 1개(중복 억제)");
    await recordBind(S, B);                        // 실제 변경 → 구간 추가
    bs = await rawBindings(S);
    assert.deepEqual(bs.map((b) => b.projectId), [A, B], "B 로 바뀜 → 구간 2개 [A,B]");
    await recordBind(S, A);                        // 핑퐁 — 실제 변경 → 또 추가
    bs = await rawBindings(S);
    assert.deepEqual(bs.map((b) => b.projectId), [A, B, A], "다시 A(핑퐁) → 구간 3개 [A,B,A]");
    ok("B5 recordBind — 바뀔 때만 구간 증가([A,B,A]), 같은값 반복은 멱등");
  }

  // ── B6. 여러 세션이 한 프로젝트에 → 타임라인에 둘의 작업이 모두 ──
  {
    const A = await mkProject("B6-A");
    const S1 = "b6-s1", S2 = "b6-s2";
    await recordBind(S1, A);
    await recordBind(S2, A);
    await addActivity({ sessionId: S1, title: "b6-fromS1", atISO: "2099-01-01T00:00:01Z" });
    await addActivity({ sessionId: S2, title: "b6-fromS2", atISO: "2099-01-01T00:00:02Z" });
    const tl = await timeline(A);
    assert.ok(tl.includes("b6-fromS1") && tl.includes("b6-fromS2"), "두 세션 작업 모두 A 에");
    ok("B6 서로 다른 세션 S1·S2 의 작업이 같은 프로젝트 타임라인에 모두");
  }

  // ── E1. 바인딩 없는 세션의 작업(명시 project_id 없음) → 어디에도 안 나온다 ──
  {
    const P = await mkProject("E1-P");
    const X = "e1-x";  // 어떤 프로젝트에도 바인딩된 적 없음
    await addActivity({ sessionId: X, title: "e1-orphan", atISO: "2025-02-01T00:00:00Z" }); // projectId 미명시
    const tl = await timeline(P);
    assert.ok(!tl.includes("e1-orphan"), "바인딩 없는 세션 작업은 귀속 불가");
    assert.equal(tl.length, 0, "P 타임라인엔 아무것도 안 붙는다");
    ok("E1 바인딩·명시 둘 다 없는 작업 → 어느 타임라인에도 안 나옴");
  }

  // ── E2. 재바인딩 후에도 옛 작업은 옛 프로젝트에 잔존(B2 의 대칭 — 시점 아닌 저장이 불변) ──
  {
    const A = await mkProject("E2-A");
    const B = await mkProject("E2-B");
    const S = "e2-s";
    await bindAt(S, A, "2025-01-01T00:00:00Z");
    await addActivity({ sessionId: S, title: "e2-a1", atISO: "2025-02-01T00:00:00Z" }); // A 구간에서 발생
    await bindAt(S, B, "2025-03-01T00:00:00Z");                                          // 재바인딩 → B
    // 재바인딩 '후'에 A 를 조회해도 a1 은 그대로 있어야 한다.
    const tlA = await timeline(A);
    assert.ok(tlA.includes("e2-a1"), "재바인딩 후 조회해도 a1 은 여전히 A 에");
    ok("E2 재바인딩 후에도 옛 작업은 옛 프로젝트에 잔존");
  }

  console.log(`\n${pass} passed`);
} finally {
  await teardown();
}
