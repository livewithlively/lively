// 수집기 자동 정지 — «모으는 중» 이 거짓이던 자리 (#5040, 셀프호스트 실측 2026-10-26)
//
//  신고: 셀프호스트 박스에서 슬랙 두 수집기와 리니어 수집기의 주기 잡이 «연속 실패 5회 — 자동 정지» 로 꺼져 있었는데,
//   연결 화면은 «수집 중» 이었다(수집기 enabled 만 봤다). 관리자가 슬랙 수집기를 저장하자 잡은 켜졌지만
//   fail_streak 이 임계 위에 남아 20초 뒤 한 번 실패로 곧바로 다시 꺼졌다.
//  사양:
//   S1 멈춤 = 수집기 켜짐 ∧ 잡 꺼짐 ∧ 자동 정지 표시. 사람이 끈 잡·꺼진 수집기·흔적만 남은 켜진 잡·잡 없음은 멈춤이 아니다.
//   S2 멈춤 안내는 무엇이(이름) 몇 번 실패했고 마지막 오류가 무엇인지, 다시 켜는 길을 말한다(모르는 오류는 지어내지 않는다).
//   S3 수집기를 켜는 저장은 주기 잡의 서킷 브레이커(fail_streak · auto_disabled_*)를 함께 푼다 — 본 잡과 full 잡 둘 다.
//   S4 주기 full 스윕: notion 매일(종전 그대로) · slack 매주는 셀프호스트만 · 그 밖엔 없음.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { collectorStalled, collectorStallNote, fullSweepOf, type CollectorView } from "./collectors.js";

type C = Pick<CollectorView, "enabled" | "sync_job" | "label" | "last_run">;
const job = (o: Partial<NonNullable<CollectorView["sync_job"]>> = {}): NonNullable<CollectorView["sync_job"]> => ({
  enabled: false, interval_sec: 1800, fail_streak: 6,
  auto_disabled_at: "2026-10-26 08:31:22+00", auto_disabled_reason: "연속 실패 6회 — 자동 정지(마지막 상태: error)", ...o,
});
const run = (error: string | null): NonNullable<CollectorView["last_run"]> => ({
  id: 7, status: error ? "error" : "ok", mode: "incremental", started_at: "2026-10-26 08:31:19+00", finished_at: "2026-10-26 08:31:21+00", error,
});
const c = (o: Partial<C> = {}): C =>
  ({ enabled: true, label: "Slack — 팀 공개 채널", sync_job: job(), last_run: run("slack search.messages error: missing_scope"), ...o });

test("S1 멈춤 판정 — 켜진 수집기의 잡이 자동 정지로 꺼졌을 때만", () => {
  assert.equal(collectorStalled(c()), true, "실측한 슬랙 검색 수집기 모양");
  assert.equal(collectorStalled(c({ sync_job: job({ enabled: true }) })), false, "잡이 다시 켜졌는데 흔적만 남은 행");
  assert.equal(collectorStalled(c({ enabled: false })), false, "사람이 수집기를 껐다");
  assert.equal(collectorStalled(c({ sync_job: job({ auto_disabled_at: null, auto_disabled_reason: null }) })), false, "사람이 잡만 껐다");
  assert.equal(collectorStalled(c({ sync_job: null })), false, "잡이 없다(org_cron 미생성)");
});

test("S2 멈춤 안내 — 이름 · 연속 실패 횟수 · 마지막 오류 · 다시 켜는 길", () => {
  const n = collectorStallNote(c());
  assert.ok(n, "멈췄는데 안내가 없다");
  assert.match(n!, /«Slack — 팀 공개 채널»/);
  assert.match(n!, /연속 6회/);
  assert.match(n!, /마지막 오류: slack search\.messages error: missing_scope/);
  assert.match(n!, /다시 켜면/);
  assert.equal(collectorStallNote(c({ enabled: false })), null, "멈춤이 아니면 null");
  assert.doesNotMatch(collectorStallNote(c({ last_run: null }))!, /마지막 오류/, "오류를 모르면 지어내지 않는다");
});

const SRC = readFileSync(new URL("./collectors.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const JOB = SRC.slice(SRC.indexOf("async function syncCollectorJob"), SRC.indexOf("export async function removeCollector"));

test("S3 켜는 저장이 서킷 브레이커를 푼다 — 본 잡과 full 잡 둘 다", () => {
  assert.ok(JOB.length > 200, "배선: syncCollectorJob 본문을 찾았다");
  const resets = JOB.match(/ON CONFLICT \(tenant_id, id\) DO UPDATE SET[^`]*fail_streak=0, auto_disabled_at=NULL, auto_disabled_reason=NULL/g) ?? [];
  assert.equal(resets.length, 2, `켜면서 실패 횟수·자동 정지 표시를 안 지우는 잡이 있다(${resets.length}/2) — 한 번만 더 실패해도 곧바로 다시 꺼진다`);
});

test("S4 주기 full 스윕 — notion 매일 · slack 매주 셀프호스트만 · 그 밖엔 없음", () => {
  assert.deepEqual(fullSweepOf("notion", false), { intervalSec: 86_400, label: "일일 전체 스윕(아카이브·완결성)" });
  assert.deepEqual(fullSweepOf("notion", true), { intervalSec: 86_400, label: "일일 전체 스윕(아카이브·완결성)" }, "매니지드 노션도 종전대로");
  assert.equal(fullSweepOf("slack", false)?.intervalSec, 604_800, "셀프호스트 슬랙은 주 1회");
  assert.equal(fullSweepOf("slack", true), null, "매니지드 슬랙엔 두지 않는다(배포 앱 기록 API 제한)");
  assert.equal(fullSweepOf("linear", false), null);
  assert.match(JOB, /fullSweepOf\(spec\.presetKey, managedMode\(\)\)/, "잡 등록이 판정을 쓰지 않는다");
});
