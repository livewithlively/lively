// 작업 컨테이너 정책(#4490 앱 v2-11 · 보존 #4828) — 값 해석 · 범위 · 축 사이 관계 · env 시드 · 출처 · 고치기 검증. 사양 엣지 표 Q 의 모든 행.
//
//  왜 이 파일이 있나: 이 값들이 워크스페이스가 노드 자리를 얼마나 쓰는지 · 한 사람의 구독을 몇 갈래로 먹는지를 정한다.
//   «사람당 동시 ≤ 워크스페이스 동시» 가 깨지면 사람당 상한이 장식이 되고, 기본 실행 시간이 최대를 넘으면 기본값이 최대를 뚫는다.
//   그리고 관리자가 어긋난 조합을 적었을 때 **조용히 접어 저장하면** 나중에 동시 상한을 올려도 그 값이 되살아나지 않는다(Q7).
import assert from "node:assert/strict";
import {
  DEFAULT_AGENT_JOB_POLICY as D, AGENT_JOB_POLICY_RANGE as R, agentJobPolicyPatchError, agentJobPolicySource, normalizeAgentJobPolicy,
  resolveAgentJobPolicy,
} from "./agent-job-policy.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  try { fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};
const ENV = ["LIVELY_AGENT_JOB_MAX_RUNNING", "LIVELY_AGENT_JOB_MAX_RUNNING_PER_MEMBER", "LIVELY_AGENT_JOB_MAX_QUEUED", "LIVELY_AGENT_JOB_DEFAULT_TIMEOUT_MIN", "LIVELY_AGENT_JOB_MAX_TIMEOUT_MIN",
  "LIVELY_AGENT_JOB_KEEP_DAYS"];
const withEnv = <T>(vals: Record<string, string>, fn: () => T): T => {
  const old = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, vals);
  try { return fn(); } finally { for (const k of ENV) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
};

t("Q1 기본값 — 상민 2026-10-16 결정(동시 2 · 대기 20 · 대기 30분 · 실행 15/60분 · 무응답 90초) + 시작 상한 180초 · 보존 90일(2026-10-19 결정)", () => withEnv({}, () => {
  assert.deepEqual(resolveAgentJobPolicy({}), {
    max_running: 2, max_running_per_member: 2, max_running_per_service_seat: 2, max_queued: 20, queue_wait_min: 30,
    default_timeout_min: 15, max_timeout_min: 60, silent_sec: 90, start_timeout_sec: 180, keep_days: 90,
  });
  assert.deepEqual(resolveAgentJobPolicy(null), D);
}));

t("Q2 범위 — 정확히 경계는 그대로 · 밖이면 경계로 접고 · 숫자가 아니면 기본값(노브 clampInt 규칙)", () => withEnv({}, () => {
  for (const k of Object.keys(R) as Array<keyof typeof R>) {
    const [lo, hi] = R[k];
    //  사람당 동시는 축 사이 관계(≤ 워크스페이스 동시 2)가 뒤따라 접으므로 따로 본다(Q3).
    if (k === "max_running_per_member" || k === "max_running_per_service_seat") continue;   // #5081 공용 시트 상한도 같은 관계(Q9)
    assert.equal(normalizeAgentJobPolicy({ [k]: lo })[k], lo, `${k} 최소 ${lo}`);
    assert.equal(normalizeAgentJobPolicy({ [k]: lo - 1 })[k], lo, `${k} 최소 밑은 최소로`);
    if (k !== "default_timeout_min") assert.equal(normalizeAgentJobPolicy({ [k]: hi + 1 })[k], hi, `${k} 최대 위는 최대로`);
    assert.equal(normalizeAgentJobPolicy({ [k]: "abc" as unknown as number })[k], D[k], `${k} 숫자 아님은 기본값`);
    assert.equal(normalizeAgentJobPolicy({ [k]: Number.NaN })[k], D[k], `${k} NaN 은 기본값`);
  }
  assert.equal(normalizeAgentJobPolicy({ max_queued: 0 }).max_queued, 0, "대기열 0 = 대기열 없음(유효한 선택)");
}));

t("Q3 읽을 때의 불변식 — 사람당 동시 ≤ 워크스페이스 동시 · 기본 시간 ≤ 최대 시간", () => withEnv({}, () => {
  const a = resolveAgentJobPolicy({ max_running: 3, max_running_per_member: 7 });
  assert.equal(a.max_running_per_member, 3);
  const b = resolveAgentJobPolicy({ default_timeout_min: 90, max_timeout_min: 30 });
  assert.equal(b.default_timeout_min, 30);
  const c = resolveAgentJobPolicy({ max_running: 5, max_running_per_member: 4, default_timeout_min: 10, max_timeout_min: 20 });
  assert.equal(c.max_running_per_member, 4, "지키는 값은 그대로");
  assert.equal(c.default_timeout_min, 10);
}));

t("Q4 env 시드 — DB 에 키가 없을 때만 · DB 가 이긴다 · 범위 밖 시드는 경계로 · 숫자 아닌 시드는 기본으로", () => {
  withEnv({ LIVELY_AGENT_JOB_MAX_RUNNING: "5" }, () => {
    assert.equal(resolveAgentJobPolicy({}).max_running, 5);
    assert.equal(resolveAgentJobPolicy({ max_running: 3 }).max_running, 3);
  });
  withEnv({ LIVELY_AGENT_JOB_MAX_RUNNING: "999" }, () => assert.equal(resolveAgentJobPolicy({}).max_running, R.max_running[1]));
  withEnv({ LIVELY_AGENT_JOB_MAX_RUNNING: "많이" }, () => assert.equal(resolveAgentJobPolicy({}).max_running, D.max_running));
});

t("Q5 출처 — 관리 설정 · env 시드 · 코드 기본값", () => {
  withEnv({}, () => {
    assert.equal(agentJobPolicySource({}), "default");
    assert.equal(agentJobPolicySource({ max_queued: 5 }), "db");
  });
  withEnv({ LIVELY_AGENT_JOB_MAX_QUEUED: "50" }, () => assert.equal(agentJobPolicySource({}), "env"));
});

t("Q6 고치기 검증 — 지키는 조합은 통과(안 적은 칸은 지금 쓰는 값으로 견준다)", () => withEnv({}, () => {
  assert.equal(agentJobPolicyPatchError({}), null);
  assert.equal(agentJobPolicyPatchError({ max_running: 6, max_running_per_member: 6 }), null, "같아도 된다");
  assert.equal(agentJobPolicyPatchError({ max_running: 4 }), null);
  assert.equal(agentJobPolicyPatchError({ max_timeout_min: 120, default_timeout_min: 120 }), null);
}));

t("Q7 고치기 검증 — 어긋난 조합은 거절한다(조용히 접어 저장하지 않는다)", () => withEnv({}, () => {
  //  사람당 5 만 적으면 지금 동시 상한(2)을 넘는다 → 거절. 접어서 2 로 저장하면 나중에 동시를 올려도 5 가 안 돌아온다.
  assert.match(agentJobPolicyPatchError({ max_running_per_member: 5 }) ?? "", /max_running_per_member\(5\).*max_running\(2\)/);
  assert.match(agentJobPolicyPatchError({ max_running: 3, max_running_per_member: 4 }) ?? "", /이하/);
  assert.match(agentJobPolicyPatchError({ default_timeout_min: 90 }) ?? "", /default_timeout_min\(90\).*max_timeout_min\(60\)/);
  //  env 시드가 동시 상한을 올려 두었으면 그 값으로 견준다.
  withEnv({ LIVELY_AGENT_JOB_MAX_RUNNING: "8" }, () => assert.equal(agentJobPolicyPatchError({ max_running_per_member: 5 }), null));
}));

t("Q8 보존 일수(#4828) — 0 은 무기한(유효한 선택) · 범위 0~3650 · env 시드 · 다른 축과 엮이지 않는다", () => withEnv({}, () => {
  assert.equal(normalizeAgentJobPolicy({ keep_days: 0 }).keep_days, 0, "0 = 지우지 않는다");
  assert.deepEqual([R.keep_days[0], R.keep_days[1]], [0, 3650]);
  assert.equal(normalizeAgentJobPolicy({ keep_days: 7 }).keep_days, 7);
  withEnv({ LIVELY_AGENT_JOB_KEEP_DAYS: "30" }, () => {
    assert.equal(resolveAgentJobPolicy({}).keep_days, 30, "env 시드");
    assert.equal(resolveAgentJobPolicy({ keep_days: 0 }).keep_days, 0, "DB 의 0(무기한)이 env 를 이긴다");
  });
  assert.equal(agentJobPolicyPatchError({ keep_days: 3650 }), null, "다른 축과 관계가 없다");
}));

t("Q9 공용 시트 상한(#5081) — 기본 2 · 범위 1~20 · ≤ 워크스페이스 동시(읽을 때 접고 · 고칠 때 거절) · 같아도 된다(경계)", () => withEnv({}, () => {
  assert.equal(D.max_running_per_service_seat, 2);
  assert.deepEqual(R.max_running_per_service_seat, [1, 20]);
  assert.equal(resolveAgentJobPolicy({ max_running: 3, max_running_per_service_seat: 7 }).max_running_per_service_seat, 3, "읽을 때 워크스페이스 동시로 접는다");
  assert.equal(resolveAgentJobPolicy({ max_running: 20, max_running_per_service_seat: 21 }).max_running_per_service_seat, 20, "범위 위는 최대로");
  assert.equal(resolveAgentJobPolicy({ max_running_per_service_seat: 0 }).max_running_per_service_seat, 1, "범위 밑은 최소로");
  assert.match(agentJobPolicyPatchError({ max_running_per_service_seat: 3 }) ?? "", /max_running_per_service_seat\(3\).*max_running\(2\)/, "기본 동시 2 보다 크면 거절");
  assert.equal(agentJobPolicyPatchError({ max_running: 4, max_running_per_service_seat: 4 }), null, "같으면 된다(경계)");
  assert.match(agentJobPolicyPatchError({ max_running: 4, max_running_per_service_seat: 5 }) ?? "", /이하/, "하나 넘으면 거절(경계)");
  withEnv({ LIVELY_AGENT_JOB_MAX_RUNNING_PER_SERVICE_SEAT: "6", LIVELY_AGENT_JOB_MAX_RUNNING: "8" }, () => assert.equal(resolveAgentJobPolicy({}).max_running_per_service_seat, 6, "env 시드"));
}));

console.log(`# ${pass} pass`);
