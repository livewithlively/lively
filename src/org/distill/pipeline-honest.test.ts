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
import { readFileSync, readdirSync } from "node:fs";

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
  assert.match(ACTION, /const stranded = await listStrandedSources\(claiming/, "폴백이 방치 자료를 안 받는다");
  //  자격 실패로 자동 정지된 레인은 «맡은» 레인으로 남는다 — 빠지면 그 몫이 방치로 세어져 잡 계정·기본 기준으로 증류된다.
  assert.match(ACTION, /const claiming = all\.filter\(\(d\) => d\.enabled \|\| isAutoDisabledLane\(d\)\)/,
    "자동 정지 레인이 방치 판정에서 빠진다");
  assert.match(ACTION, /if \(!claiming\.length\) \{/, "레인이 전부 자동 정지되면 전역 폴백이 조직 전체를 증류한다");
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
  assert.match(DISTILLER, /DO UPDATE SET seen_at=now\(\)/, "재판정이 판정 시각을 전진시키지 않는다");
  //  🔴 추론을 **컬럼이 아니라 제약 이름**으로 — 멀티테넌트에서 tenant-column 레이어가 이 표의 PK 를
  //   (tenant_id, source_id) 로 재작성하면 `ON CONFLICT (source_id)` 는 부분집합이라 42P10 으로 죽는다
  //   (2026-09-04 prod 실측: 행이 계속 0, 호출부 삼킴 때문에 로그도 없었다).
  assert.match(DISTILLER, /ON CONFLICT ON CONSTRAINT org_stranded_seen_pkey/,
    "컬럼 추론이면 테넌시 PK 재작성 환경에서 매 INSERT 가 죽는다");
  //  조용한 실패 금지 — 기록 실패가 로그를 안 남기면 '고쳤는데 안 듣는다'의 원인을 밖에서 알 수 없다.
  assert.match(ACTION, /markStrandedSeenSafe[\s\S]{0,400}?logger\.warn/,
    "방치 판정 기록 실패를 조용히 삼킨다 — 최소 한 줄은 남겨야 한다");
  //  배치 실패 시 되돌리기 — 안 그러면 아무도 안 본 자료가 인박스에서 영구히 빠진다(유실).
  assert.match(TASK_STORE, /DELETE FROM org_stranded_seen WHERE task_id=\$1/,
    "실패한 방치 배치의 기록을 되돌리지 않는다 — 자료가 유실된다");
  //  되돌릴 수 없는 기록은 남기지 않는다 — 재독(비용)보다 유실(무증상)이 나쁘다.
  //   중첩 스킵은 task_id 가 이전 태스크의 것이고, 생성 실패는 task_id 가 없다. 둘 다 되돌리기가 안 걸린다.
  //  판정은 한 자리에서(headless-accept) — 분류기도 같은 규칙을 쓴다. 인라인으로 각자 쓰면 둘이 갈라진다(#3994 T5-A).
  assert.match(ACTION, /const \{ acceptedTaskId \} = await import\("\.\/headless-accept\.js"\)/,
    "접수 판정을 공용 자리에서 안 가져온다 — 규칙이 호출부마다 갈라진다");
  assert.match(ACTION, /const acceptedId = acceptedTaskId\(r\)/,
    "접수 여부를 가리지 않는다 — 중첩 스킵·생성 실패까지 기록하면 되돌릴 열쇠가 없어 자료가 영구히 숨는다");
  assert.match(ACTION, /else if \(acceptedId != null\) await markStrandedSeenSafe\(/, "그 게이트를 방치 기록에 걸지 않는다");
  //  레인도 같은 게이트 — 종전엔 판정을 계산해 두고 레인 기록엔 안 걸어, 접수 실패한 배치의 자료가 인박스에서 사라졌다.
  assert.match(ACTION, /if \(b\.distillerId\) \{ if \(acceptedId != null\) await markSeenSafe\(/,
    "레인 배치가 접수 여부를 안 가린다 — 접수 실패한 배치의 자료가 숨는다");
});

test("②-c 방치 배치는 대상을 못박는다 — 기록하는 집합과 다루는 집합이 같아야 한다", () => {
  //  🔴 유실 경로: 서버는 listStrandedSources 로 고른 id 를 '판정함'으로 기록하는데, 본문 프롬프트가
  //   source_undistilled(조직 전체)를 부르게 하면 에이전트는 **다른 집합**을 본다. 그러면 아무도 안 본
  //   자료가 판정 기록돼 인박스에서 영구히 빠진다. 켜진 레인 몫 침범도 같이 일어난다.
  assert.match(DISTILLER, /export function buildStrandedTargeting\(/, "방치 배치의 대상 지정부가 없다");
  assert.match(DISTILLER, /source_undistilled 를 부르지 마/, "전역 목록 재조회를 금지하지 않는다");
  assert.match(ACTION, /const strandedTargeting = buildStrandedTargeting\(stranded, lockEnforced\)/, "방치 배치가 대상 지정을 안 만든다");
  //  override 없는 배치는 composeDistillPrompt 가 targeting 을 붙이지 않으므로 프롬프트에 직접 얹어야 한다.
  assert.match(ACTION, /prompt: strandedTargeting \+ "\\n\\n" \+ buildDistillPrompt\(stranded\.length, policySummary, true, lockEnforced\)/,
    "대상 지정을 프롬프트에 얹지 않는다 — targeting 필드만 채우면 override 없는 배치엔 안 붙는다");
  //  본문 ② 단계가 여전히 전역 조회를 지시하면 대상 지정과 모순된다.
  assert.match(ACTION, /targeted\s*\?\s*`② 위에 지정된 대상 자료만 다뤄/, "지정 배치에서도 전역 조회를 지시한다");
  //  0-레인 폴백(켜진 증류기 0개)은 전역 조회가 맞다 — 종전 동작을 지워선 안 된다.
  assert.match(ACTION, /② source_undistilled 로 아직 지식화 안 된 자료 목록을 가져와/, "0-레인 폴백의 전역 조회를 없앴다");
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
  assert.match(SLACK, /function scopeHint\(method: string, err: unknown, needed\?: string\): string/, "권한 안내가 없다");
  assert.match(SLACK, /"search\.messages": "search:read/, "이 신고의 그 메서드가 표에 없다");
  assert.match(SLACK, /\[외부 앱 연결 ▸ Slack\]에서 다시 연결/, "갈 길을 안 준다");
  //  ⚠ 모르는 메서드에 스코프를 지어내면 엉뚱한 권한을 켜게 한다. 슬랙이 응답에 실어 준 «모자란 권한»(needed)은
  //   지어낸 것이 아니라 슬랙의 말이라 표보다 먼저 쓴다(#5040) — 둘 다 없으면 아무 권한도 단정하지 않는다.
  assert.match(SLACK, /const need = needed\?\.trim\(\) \|\| SCOPE_BY_METHOD\[method\];/, "표에 없는 메서드도 단정한다");
});

test("⑳ 자동 정지 표식 — 사람이 스위치를 바꿀 때만 지우고, 실행 기록은 지우지 않는다", () => {
  const INGEST = r("../store/ingest.ts");
  const AUTH = r("../../node/auth-failure-response.ts");
  //  부분 갱신(스위치 미지정)이 표식을 지우면 자동 정지 레인이 «사람이 끈 레인» 이 되어 그 몫이 샌다.
  assert.match(INGEST, /CASE WHEN \$34::boolean AND jsonb_typeof\(last_summary\)='object' THEN last_summary - 'auto_disabled'/,
    "스위치를 명시하지 않은 저장도 자동 정지 표식을 지운다");
  //  관리탭 폼은 바꾸지 않은 스위치 값도 늘 보낸다 — «명시» 가 아니라 «변경» 이어야 폼 저장 한 번에 표식이 안 지워진다.
  assert.match(INGEST, /input\.enabled !== undefined && Boolean\(input\.enabled\) !== Boolean\(before\.enabled\)\]\);/,
    "표식 삭제 조건($34)이 «스위치 변경» 이 아니다");
  //  실행 기록이 last_summary 를 통째로 덮으면 같은 경쟁 구간에서 표식이 사라진다.
  assert.match(INGEST, /THEN \$3::jsonb \|\| jsonb_build_object\('auto_disabled', last_summary->'auto_disabled', 'auto_disabled_reason', last_summary->'auto_disabled_reason'\)/,
    "실행 기록이 자동 정지 표식을 덮어쓴다");
  //  레인 정지는 켜진 레인만, 실패한 그 레인 또는 같은 계정을 명시한 레인만 건드린다.
  //   계정은 앞뒤 공백을 걷고 비교한다 — 분류·관리 레인은 저장 때 계정을 다듬지 않아, 그대로 비교하면 형제 레인이 안 꺼진다.
  assert.match(AUTH, /WHERE enabled=true AND \(key=\$1 OR btrim\(requester\)=\$2\) RETURNING key/,
    "레인 정지 범위가 바뀌었다(또는 계정을 다듬지 않고 비교한다 — 공백 섞인 형제 레인이 다음 주기에 하나씩 죽는다)");
  assert.match(AUTH, /\|\| \$3::jsonb,/, "레인 정지가 last_summary 를 병합하지 않고 덮는다");
});

test("⑳-b 자격 실패 대응이 취소한 대기 위탁의 판정 기록을 되돌린다 — markFinished(실패)·스키마와 같은 표", async () => {
  const AUTH = r("../../node/auth-failure-response.ts");
  const { TASK_SEEN_TABLES } = await import("../../node/auth-failure-response.js");
  const body = (fn: string): string => {
    const at = AUTH.indexOf(`async function ${fn}(`);
    assert.ok(at >= 0, `${fn} 를 못 찾았다 — 시험이 헛돈다`);
    return AUTH.slice(at, AUTH.indexOf("\n}\n", at));
  };
  //  두 취소 경로(크론 정지판·레인 격리판) 모두 걷은 id 를 받아 판정 기록을 되돌린다. 빠지면 그 배치가 «봤음» 으로 찍은
  //   자료는 크론·레인을 다시 켜도 인박스에 안 돌아온다(인박스가 seen_at >= updated_at 으로 거른다 — 무증상 유실).
  for (const fn of ["cancelQueuedForCron", "cancelQueuedForRequester"]) {
    assert.match(body(fn), /RETURNING id`/, `${fn} 가 걷은 위탁 id 를 받지 않는다`);
    assert.match(body(fn), /await releaseSeen\(/, `${fn} 가 판정 기록을 되돌리지 않는다 — 취소분 자료가 다시 켜도 인박스에 안 돌아온다`);
  }
  //  레인 격리판은 **그 크론 · 그 계정** 의 대기만 걷는다 — 계정 조건이 빠지면 같은 크론의 멀쩡한 계정 위탁까지 날아간다.
  assert.match(body("cancelQueuedForRequester"), /WHERE status='queued' AND split_part\(requester_session, '#', 1\) = \$1 AND requester = \$2 RETURNING id`/,
    "레인 격리판 취소 범위가 «그 크론 · 그 계정» 이 아니다");
  //  되돌리는 표 = 실패 종결(markFinished)이 되돌리는 표 = 스키마에서 task_id 를 가진 판정 표 전부.
  const fin = TASK_STORE.slice(TASK_STORE.indexOf("export async function markFinished("));
  const finTables = [...fin.slice(0, fin.indexOf("\n}\n")).matchAll(/DELETE FROM (\w+_seen) WHERE task_id=/g)].map((m) => m[1]).sort();
  assert.deepEqual([...TASK_SEEN_TABLES].sort(), finTables, "취소 경로와 실패 종결(markFinished)이 되돌리는 판정 표가 다르다");
  const schemaDir = new URL("../schema/", import.meta.url).pathname.replace("/dist/", "/src/");
  const ddl = readdirSync(schemaDir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(schemaDir + f, "utf8")).join("\n");
  const seenWithTask = [...ddl.matchAll(/CREATE TABLE IF NOT EXISTS (\w+_seen)\(([\s\S]*?)\);/g)]
    .filter((m) => /\btask_id\b/.test(m[2])).map((m) => m[1]).sort();
  assert.ok(seenWithTask.length >= 3, `스키마에서 판정 표를 못 읽었다(${seenWithTask.join(", ")}) — 시험이 헛돈다`);
  assert.deepEqual([...TASK_SEEN_TABLES].sort(), seenWithTask, "task_id 를 가진 판정 표가 새로 생겼는데 취소 경로가 되돌리지 않는다");
});

test("⑳-c 커버리지는 자동 정지 레인의 잔량을 센다 — 0 이면 붙잡힌 자료가 화면에서 사라진다", () => {
  //  자동 정지 레인의 몫은 사각지대(방치)에도 다른 레인 잔량에도 안 잡힌다(맡은 레인). 그 레인의 잔량까지 0 이면
  //   관리탭은 «0건 켜면 읽음» 을 보이고, 계정이 죽은 채 쌓이는 자료가 어느 숫자에도 안 나온다.
  const cov = DISTILLER.slice(DISTILLER.indexOf("export async function distillerCoverage("));
  assert.match(cov, /backlog: \(d\.enabled \|\| isAutoDisabledLane\(d\)\) \? await countDistillerBacklog\(d, all\) : 0,/,
    "자동 정지 레인의 잔량을 0 으로 센다 — 붙잡힌 몫이 커버리지 어디에도 안 보인다");
  //  사각지대 계산도 같은 «맡은 레인» 집합이어야 한다(폴백과 단일 출처).
  assert.match(cov, /const enabled = all\.filter\(\(d\) => d\.enabled \|\| isAutoDisabledLane\(d\)\);/, "사각지대가 맡은 레인 기준이 아니다");
});

test("㉑ 분류·관리 레인도 자동 정지 표식을 같은 규칙으로 다룬다", () => {
  const CLS = r("../store/classifiers.ts");
  const MGR = r("../store/managers.ts");
  const AUTH = r("../../node/auth-failure-response.ts");
  const KEEP = /THEN \$3::jsonb \|\| jsonb_build_object\('auto_disabled', last_summary->'auto_disabled', 'auto_disabled_reason', last_summary->'auto_disabled_reason'\)/;
  //  실행 기록이 last_summary 를 덮으면 같은 틱에 형제 레인의 401 로 붙은 표식이 사라진다.
  assert.match(CLS, KEEP, "분류 실행 기록이 자동 정지 표식을 덮어쓴다 — 그 레인 몫이 다른 레인·전역 폴백으로 샌다");
  assert.match(MGR, KEEP, "관리 실행 기록이 자동 정지 표식을 덮어쓴다 — 사람이 끈 관리기와 구분이 안 된다");
  //  표식 해제는 스위치를 «바꾼» 저장에서만.
  assert.match(CLS, /CASE WHEN \$26::boolean AND jsonb_typeof\(last_summary\)='object' THEN last_summary - 'auto_disabled'/, "분류 저장이 표식을 조건 없이 지우거나 안 지운다");
  assert.match(CLS, /\[\.\.\.vals, cur\.id, input\.enabled !== undefined && Boolean\(input\.enabled\) !== Boolean\(cur\.enabled\)\]\);/,
    "분류 표식 해제 조건($26)이 «스위치 변경» 이 아니다 — 폼 저장 한 번에 자동 정지 레인이 «사람이 끈 레인» 이 된다");
  assert.match(MGR, /CASE WHEN \$23::boolean AND jsonb_typeof\(last_summary\)='object' THEN last_summary - 'auto_disabled'/, "관리 저장이 표식을 조건 없이 지우거나 안 지운다");
  assert.match(MGR, /\[\.\.\.vals, cur\.id, input\.enabled !== undefined && Boolean\(input\.enabled\) !== Boolean\(cur\.enabled\)\]\);/,
    "관리 표식 해제 조건($23)이 «스위치 변경» 이 아니다");
  //  레인 정지는 맵에서 온 테이블만 식별자로 쓴다.
  assert.match(AUTH, /if \(!\(Object\.values\(LANE_TABLES\) as string\[\]\)\.includes\(table\)\) throw/, "맵 밖 테이블 이름이 SQL 식별자로 들어갈 수 있다");
  assert.match(AUTH, /`UPDATE \$\{table\} SET enabled=false, last_status='error',/, "레인 정지가 액션의 레인 테이블을 쓰지 않는다");
});

test("㉒ 자동 정지된 카테고리 붙이기 레인은 몫을 계속 맡는다 — 배타 배정·사각지대·폴백 판정", () => {
  const CLS = r("../store/classifiers.ts");
  const ACT = r("../../scheduler/actions/classify.ts");
  //  앞선 레인 = 맡은 레인(켜짐 ∪ 자동 정지). SQL 은 enabled 로 거르지 않고(상위집합) JS 판정 하나로 좁힌다.
  const inbox = CLS.slice(CLS.indexOf("async function inboxWhere("), CLS.indexOf("export async function classifierInbox("));
  assert.ok(!/enabled=true/.test(inbox), "앞선 레인을 enabled=true 로만 고른다 — 자동 정지 레인 몫이 뒤 레인으로 샌다");
  assert.match(inbox, /WHERE target <> 'low_confidence' AND \(priority > \$1 OR \(priority = \$1 AND id < \$2\)\)/, "앞선 레인의 순서·폐지 모드 조건이 바뀌었다");
  assert.match(inbox, /as ClassifierRow\[\]\)\.filter\(isClaimingLane\);/, "앞선 레인을 맡은 레인 판정으로 좁히지 않는다");
  //  사각지대·레인 목록도 같은 집합.
  assert.match(CLS, /const on = all\.filter\(isClaimingLane\);/, "커버리지가 자동 정지 레인 몫을 사각지대로 센다");
  assert.match(CLS, /const uq = uncoveredQuery\(on\);/);
  //  크론 — 위탁은 일하는 레인만, 폴백 판정은 맡은 레인으로.
  assert.match(ACT, /targets = all\.filter\(isActiveLane\);/, "자동 정지 레인이 위탁을 낸다 — 죽은 자격으로 다시 401");
  assert.match(ACT, /claiming = all\.filter\(isClaimingLane\)\.length;/, "폴백 판정이 맡은 레인을 세지 않는다");
  assert.match(ACT, /if \(!targets\.length && claiming\) \{\s*return \{ status: "ok"/, "레인이 전부 자동 정지되면 레거시 전역 폴백이 조직 전체를 잡 계정으로 분류한다");
  assert.ok(ACT.indexOf("if (!targets.length && claiming)") < ACT.indexOf("// ── 레거시 전역 경로"), "폴백 차단이 레거시 경로보다 뒤에 있다");
  //  전용 잡이 자동 정지 레인을 가리키면 오류가 아니라 대기 — 오류로 세면 크론 차단기가 전용 잡까지 끈다.
  assert.match(ACT, /if \(one && isAutoDisabledLane\(one\)\) return \{ status: "ok", summary: \{ skipped:/, "자동 정지 레인 전용 잡이 대기로 끝나지 않는다");
});
