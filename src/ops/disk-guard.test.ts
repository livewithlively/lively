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
  const st = await diskState([os.tmpdir()], { warnPct: 1, criticalPct: 2 });
  assert.ok(st, "tmpdir 은 잴 수 있어야");
  assert.equal(st.level, "critical", "임계 1/2% 면 어떤 디스크든 위험");

  invalidateDiskState();
  await assert.rejects(
    () => assertDiskWritable("새 세션", [os.tmpdir()], { warnPct: 1, criticalPct: 2 }),
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
  const st = await diskState([os.tmpdir()], { warnPct: 1, criticalPct: 100 });
  assert.ok(st);
  assert.equal(st.level, "warn", "1% 경고 / 100% 위험 → 경고 상태");

  invalidateDiskState();
  await assertDiskWritable("새 세션", [os.tmpdir()], { warnPct: 1, criticalPct: 100 });
  assert.ok(true, "경고 상태에선 통과해야 한다(막으면 자해)");
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

console.log("disk-guard.test.ts ok — 위험이면 507 차단 · 경고/측정실패면 통과(과잉차단 금지) · ENOSPC 인식(errno + git stderr)");
