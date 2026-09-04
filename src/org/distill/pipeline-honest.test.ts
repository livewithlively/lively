// 수집 → 증류가 실제로 이어지고, 초록불이 거짓말하지 않는다 (#1631, 원준님 2026-08-31)
//
//  신고: 노션·슬랙·피그마·클릭업을 연결해 자료 12건이 들어왔는데 **증류가 한 번도 안 돌았다.**
//   그런데 증류 잡은 매 주기 `status: "ok"` + `"미증류 자료 없음"` 으로 찍혔다.
//   그 문장이 실제로 아는 것은 «켜진 레인들의 인박스가 비었다» 뿐인데 «세상에 미증류 자료가 없다» 로 말했다.
//
//  왜 인박스가 비었나: 증류기 7개 중 2개만 켜져 있었고, 12건은 꺼진 5개 몫이었다.
//   그리고 폴백(전역 인박스)은 **켜진 증류기가 하나도 없을 때만** 돌아서, 반만 켠 상태가 아예 안 켠 상태보다 나빴다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const r = (p: string): string => readFileSync(new URL(p, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const ACTION = r("../../scheduler/actions/distill.ts");
const DISTILLER = r("./distiller.ts");
const CONNECTOR = r("../../scheduler/actions/connector.ts");
const PIPELINE = r("../store/pipeline.ts");
const TASK_STORE = r("../../node/task-store.ts");
const SLACK = r("../../connectors/slack.ts");

test("① «미증류 자료 없음» 을 세지 않고 말하지 않는다", () => {
  //  종전엔 배치가 없으면 무조건 그 문장이었다. 이제는 실제 수를 세고 0일 때만 말한다.
  assert.match(ACTION, /async function idleSummary\(/, "«할 일 없음» 을 판단하는 자리가 없다");
  assert.match(ACTION, /const \{ countUndistilled \} = await import/, "실제 미증류 수를 세지 않는다");
  assert.match(ACTION, /if \(undistilled === 0\) return \{ status: "ok", summary: \{ skipped: "미증류 자료 없음"/,
    "0 을 확인하지 않고 «없음» 이라고 말한다");
  //  못 셌을 때 정상으로 접지 않는다 — 0 이 «없다» 인지 «못 봤다» 인지 구분되지 않으면 상태 표시가 아니다.
  assert.match(ACTION, /undistilled < 0[\s\S]{0,200}status: "error"/, "못 셌는데 «정상» 으로 보고한다");
  //  옛 문장이 조건 없이 남아 있으면 안 된다.
  const bare = ACTION.split("\n").filter((l) => !l.trim().startsWith("//"))
    .filter((l) => /skipped: "미증류 자료 없음"/.test(l));
  assert.equal(bare.length, 1, `«미증류 자료 없음» 을 말하는 자리가 ${bare.length}군데다 — 센 뒤 한 곳이어야 한다`);
});

test("② 아무 켜진 레인도 안 집는 자료를 폴백이 받는다 — 반만 켠 상태가 최악이면 안 된다", () => {
  assert.match(DISTILLER, /export function buildStrandedQuery\(/, "방치 자료를 재는 질의가 없다");
  assert.match(DISTILLER, /export async function listStrandedSources\(/, "방치 자료를 가져오는 자리가 없다");
  assert.match(ACTION, /const stranded = await listStrandedSources\(enabled/, "폴백이 방치 자료를 안 받는다");
  //  ⚠ «인박스가 비었다» 가 아니라 «스코프에 안 든다» 로 재야 이중 증류가 안 난다.
  assert.match(DISTILLER, /NOT \(\$\{claimed\.join\(" OR "\)\}\)/,
    "켜진 레인의 스코프로 재지 않는다 — 처리 중인 자료까지 방치로 세면 두 번 증류한다");
});

test("②-b 방치 배치도 판정을 기록하고 그 기록을 빼야 인박스가 전진한다", () => {
  //  #1631 이 폴백을 상시화하면서 seen 짝을 안 붙였다. 그래서 방치 자료는 판정 흔적이 없어
  //  **매 tick 같은 집합**이 다시 올라왔다(레인 인박스는 org_distiller_seen 이 막던 병).
  //  왜·실측 = org_stranded_seen DDL 주석.
  assert.match(DISTILLER, /NOT EXISTS \(SELECT 1 FROM org_stranded_seen ss WHERE ss\.source_id = s\.id AND ss\.seen_at >= s\.updated_at\)/,
    "방치 질의가 판정 기록을 빼지 않는다 — 보고 버린 자료가 매 배치 다시 올라온다");
  assert.match(DISTILLER, /export async function markStrandedSeen\(/, "방치 자료의 판정을 기록하는 자리가 없다");
  //  기록이 없으면 빼도 소용없고, 빼지 않으면 기록해도 소용없다 — 둘이 짝이다.
  assert.match(ACTION, /await markStrandedSeenSafe\(b\.ids/, "방치 배치가 판정을 기록하지 않는다");
  //  수렴 규약 — DO NOTHING 이면 수정된 자료가 다시 올라와도 seen_at 이 옛 시각에 머물러 매 배치 반복된다.
  assert.match(DISTILLER, /ON CONFLICT \(source_id\) DO UPDATE SET seen_at=now\(\)/,
    "재판정이 판정 시각을 전진시키지 않는다");
  //  배치 실패 시 되돌리기 — 안 그러면 아무도 안 본 자료가 인박스에서 영구히 빠진다(유실).
  assert.match(TASK_STORE, /DELETE FROM org_stranded_seen WHERE task_id=\$1/,
    "실패한 방치 배치의 기록을 되돌리지 않는다 — 자료가 유실된다");
  //  되돌릴 수 없는 기록은 남기지 않는다 — 재독(비용)보다 유실(무증상)이 나쁘다.
  //   중첩 스킵은 task_id 가 이전 태스크의 것이고, 생성 실패는 task_id 가 없다. 둘 다 되돌리기가 안 걸린다.
  assert.match(ACTION, /const accepted = r\.status === "ok" && !sum\?\.skipped && tid != null/,
    "접수 여부를 가리지 않는다 — 중첩 스킵·생성 실패까지 기록하면 되돌릴 열쇠가 없어 자료가 영구히 숨는다");
  assert.match(ACTION, /else if \(accepted\) await markStrandedSeenSafe\(/, "그 게이트를 방치 기록에 걸지 않는다");
});

test("③ 기준이 자리표뿐인 뼈대를 «설정됨» 으로 세지 않는다", () => {
  assert.match(PIPELINE, /const isDraft = /, "미완성 레인을 가르지 않는다");
  assert.match(PIPELINE, /configured: distillers\.length - draftCount/, "미완성까지 설정된 것으로 센다");
  assert.match(PIPELINE, /draft: draftCount/, "미완성 수를 화면에 안 내보낸다");
  assert.match(r("../liv/lane-skeleton.ts"), /export const PLACEHOLDER_MARK = /,
    "자리표 표식이 공유 상수가 아니다 — 문구가 갈리면 집계가 조용히 틀린다");
});

test("④ 수집이 끝나면 증류를 지금 민다", () => {
  assert.match(CONNECTOR, /void nudgeDistillNow\(\);/, "수집 완료가 증류로 이어지지 않는다");
  assert.match(CONNECTOR, /action IN \('distill_sources_headless','distill_sources'\)/, "증류 잡을 찾지 않는다");
  //  수집의 성패를 증류가 좌우하면 안 된다.
  assert.match(CONNECTOR, /async function nudgeDistillNow\(\): Promise<void> \{\s*\n\s*try \{/,
    "증류 실패가 수집 잡을 깬다");
});

test("⑤ 권한 부족은 사유와 갈 길을 함께 말한다", () => {
  assert.match(SLACK, /function scopeHint\(method: string, err: unknown\): string/, "권한 안내가 없다");
  assert.match(SLACK, /"search\.messages": "search:read/, "이 신고의 그 메서드가 표에 없다");
  assert.match(SLACK, /\[외부 앱 연결 ▸ Slack\]에서 다시 연결/, "갈 길을 안 준다");
  //  ⚠ 모르는 메서드에 스코프를 지어내면 엉뚱한 권한을 켜게 한다.
  assert.match(SLACK, /const need = SCOPE_BY_METHOD\[method\];/, "표에 없는 메서드도 단정한다");
});
