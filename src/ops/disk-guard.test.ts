// 디스크 가드 테스트 (#813 T5).
//
//  회귀 대상은 **양방향**이다 — 둘 다 서비스를 죽인다:
//   ① 못 막으면: 디스크가 100% 가 되고 Postgres 가 죽어 전 기능이 500 + 수동 복구(2026-07-13 사고).
//   ② 과잉 차단하면: 멀쩡한 박스에서 세션·클론·업로드가 막힌다 = 자해. 특히 **디스크를 못 재는 상황에서 막으면 안 된다.**
//  그래서 '경고(85%)에선 통과, 위험(95%)에서만 차단, 측정 실패면 통과'를 못 박는다.
import assert from "node:assert/strict";
import os from "node:os";
import { assertDiskWritable, diskState, invalidateDiskState, isDiskFullError, isDiskFullText, diskFullError } from "./disk-guard.js";
import { HttpError } from "../http-error.js";

const NOPE = "/nonexistent-path-for-disk-guard-test";

// 시험을 돌리는 자리가 판정에 새지 않게 두 가지를 고정한다(#5029).
//  ① 게이트웨이 문구가 기본이다 — 노드 에이전트가 띄운 세션(맥미니 등)은 LIVELY_NODE_TOKEN 을 물려줘 onNode() 가 참이 되고,
//     안내가 «노드 컴퓨터…» 로 바뀐다. 그래서 비우고 시작한다(노드 문구는 아래 «문구» 절이 값을 넣어 따로 본다).
//  ② 실제 디스크가 얼마나 찼는지에 기대지 않는다 — gVisor 컨테이너(중앙 박스)는 8.0E 중 수백 KB 를 써 0.0% 로 보고한다.
//     그래서 «어떤 디스크든 위험» 을 만들 때 임계를 0% 로 둔다(0% 도 «0% 이상» 이다).
delete process.env.LIVELY_NODE_TOKEN;

// ── 측정 실패 → **통과**(가드가 못 잰다는 이유로 서비스를 막으면 안 된다) ──
{
  invalidateDiskState();
  const st = await diskState([NOPE], { warnPct: 1, criticalPct: 2 });
  assert.equal(st, null, "없는 경로는 못 잼 → null");

  invalidateDiskState();
  await assertDiskWritable("테스트 작업", [NOPE], { warnPct: 1, criticalPct: 2 });
  // throw 하지 않으면 통과 — 이 줄에 도달하는 것 자체가 단언이다.
  assert.ok(true, "측정 실패 시 통과해야 한다");
}

// ── 임계치를 극단으로 낮추면 실제 디스크가 위험으로 잡히고 → 차단(507) ──
{
  invalidateDiskState();
  const st = await diskState([os.tmpdir()], { warnPct: 0, criticalPct: 0 });
  assert.ok(st, "tmpdir 은 잴 수 있어야");
  assert.equal(st.level, "critical", "임계 0% 면 어떤 디스크든 위험");

  invalidateDiskState();
  await assert.rejects(
    () => assertDiskWritable("새 세션", [os.tmpdir()], { warnPct: 0, criticalPct: 0 }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError, "HttpError 여야");
      assert.equal(err.status, 507, "507 Insufficient Storage — 정체불명 500 이 아니라");
      assert.match(err.message, /새 세션/, "무엇이 막혔는지 말해야");
      assert.match(err.message, /저장소·로그/, "무엇을 해야 하는지 말해야");
      return true;
    },
    "위험 임계를 넘으면 차단해야 한다",
  );
}

// ── 경고(85%)에선 **막지 않는다** — 아직 쓸 수 있다. 여기서 막으면 과잉 차단이다 ──
{
  invalidateDiskState();
  const st = await diskState([os.tmpdir()], { warnPct: 0, criticalPct: 100 });
  assert.ok(st);
  assert.equal(st.level, "warn", "0% 경고 / 100% 위험 → 경고 상태");

  invalidateDiskState();
  await assertDiskWritable("새 세션", [os.tmpdir()], { warnPct: 0, criticalPct: 100 });
  assert.ok(true, "경고 상태에선 통과해야 한다(막으면 자해)");
}

// ── #4780 여유 바닥 — 비율이 위험이어도 바닥 이상 남았으면 **통과**(경고). 바닥 아래면 차단하고 기준을 말한다 ──
{
  // 1바이트 바닥: 어떤 디스크든 그보다는 남아 있다 → 위험 비율(0%)을 넘었어도 막지 않아야 한다(큰 디스크 회귀).
  invalidateDiskState();
  const st = await diskState([os.tmpdir()], { warnPct: 0, criticalPct: 0, criticalFreeBytes: 1 });
  assert.ok(st);
  assert.equal(st.level, "warn", "비율은 위험이지만 바닥보다 넉넉하면 경고");
  invalidateDiskState();
  await assertDiskWritable("새 세션", [os.tmpdir()], { warnPct: 0, criticalPct: 0, criticalFreeBytes: 1 });
  assert.ok(true, "바닥보다 많이 남았으면 통과해야 한다");

  //  «바닥 아래» 는 지금 남은 양보다 큰 바닥으로 만든다 — 상수(MAX_SAFE_INTEGER ≈ 9.0e15 바이트)로 두면 남은 양을 8.0E(≈ 9.2e18)로
  //   보고하는 gVisor 디스크(중앙 박스)에선 바닥보다 많이 남은 것이 되어 막지 않았다(#5029). 2배 + 1 — 큰 수에선 +1 이 묻힌다.
  invalidateDiskState();
  const room = (await diskState([os.tmpdir()], { warnPct: 0, criticalPct: 0 }))!.availBytes;
  invalidateDiskState();
  await assert.rejects(
    () => assertDiskWritable("새 세션", [os.tmpdir()], { warnPct: 0, criticalPct: 0, criticalFreeBytes: room * 2 + 1 }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 507);
      assert.match(err.message, /사용률이 0% 이상이고 남은 공간이 .+보다 적으면 새 작업을 막습니다/, "막는 기준을 말해야 얼마나 비울지 셈한다");
      return true;
    },
  );
  invalidateDiskState();
}

// ── 문구: 노드(사람 컴퓨터)에선 그 컴퓨터를 이름으로 가리킨다 — 관리 ▸ 저장소·로그 는 서버 디스크라 헛걸음이다 ──
{
  const G = 1024 ** 3;
  const st = { usedPct: 97.9, level: "critical" as const, path: "/Users/me/workspace", availBytes: 4.2 * G };
  const t = { warnPct: 85, criticalPct: 95, criticalFreeBytes: 5 * G };
  const gw = diskFullError("새 세션", st, t);
  assert.match(gw.message, /4\.2GB 남음/);
  assert.match(gw.message, /남은 공간이 5GB보다 적으면/, "바닥은 5GB 로 읽혀야 한다(5.0GB 아님)");
  assert.match(gw.message, /저장소·로그/, "게이트웨이에선 관리탭 정리로 안내");
  const prev = process.env.LIVELY_NODE_TOKEN;
  process.env.LIVELY_NODE_TOKEN = "test-node";
  try {
    const onNodeMsg = diskFullError("새 세션", st, t).message;
    assert.ok(onNodeMsg.includes(`노드 컴퓨터(${os.hostname()})의 디스크에서 공간을 비우세요`), `노드에선 그 컴퓨터를 이름으로: ${onNodeMsg}`);
    assert.doesNotMatch(onNodeMsg, /저장소·로그/, "노드에서 서버 관리 화면으로 보내면 헛걸음이다");
  } finally {
    if (prev === undefined) delete process.env.LIVELY_NODE_TOKEN; else process.env.LIVELY_NODE_TOKEN = prev;
  }
}

// ── 여유로우면 당연히 통과 ──
{
  invalidateDiskState();
  await assertDiskWritable("새 세션", [os.tmpdir()], { warnPct: 99, criticalPct: 100 });
  assert.ok(true);
}

// ── ENOSPC 인식 — Node errno 와 **자식 프로세스 stderr 문구** 둘 다 (git clone 은 후자로 온다) ──
{
  const enospc = Object.assign(new Error("write failed"), { code: "ENOSPC" });
  assert.equal(isDiskFullError(enospc), true);
  assert.equal(isDiskFullError(Object.assign(new Error("x"), { code: "EDQUOT" })), true, "쿼터 초과도 디스크 부족");
  assert.equal(isDiskFullError(new Error("fatal: could not write: No space left on device")), true, "git stderr 문구");
  assert.equal(isDiskFullError(new Error("connection refused")), false, "무관한 에러를 디스크 탓으로 오인하면 안 된다");
  assert.equal(isDiskFullError(null), false);

  assert.equal(isDiskFullText("error: No space left on device"), true);
  assert.equal(isDiskFullText("Permission denied"), false);
  assert.equal(isDiskFullText(null), false);
}

// ── 에러 메시지에 행동 가능한 정보가 담기나 ──
{
  const e = diskFullError("레포 클론", { usedPct: 97.2, level: "critical", path: "/srv/lively/shared", availBytes: 500 * 1024 * 1024 });
  assert.equal(e.status, 507);
  assert.match(e.message, /97\.2%/, "얼마나 찼는지");
  assert.match(e.message, /500MB/, "얼마나 남았는지");
  assert.match(e.message, /레포 클론/, "무엇이 막혔는지");
}

console.log("disk-guard.test.ts ok — 위험이면 507 차단 · 경고/측정실패면 통과(과잉차단 금지) · 여유 바닥 이상이면 통과(#4780) · 노드는 그 컴퓨터를 가리킴 · ENOSPC 인식(errno + git stderr)");
