// 아웃바운드 푸시 원샷 CLI — external_outbox(pending) → ClickUp. run-sync(인바운드)의 역방향.
//  스케줄러 action='connector_push' 가 서브프로세스로 호출(검증된 CLI만 실행 — 임의 셸 금지 정책).
//  사용: node --env-file-if-exists=.env dist/connectors/run-push.js clickup
//  필요 env: ITEMS_DATABASE_URL, CLICKUP_API_TOKEN, CLICKUP_CONTAINER_LIST_ID
//  멱등: 드레인이 현재 project 행을 재읽기해 upsert — 두 번 돌려도 같은 ClickUp 상태로 수렴(external_id 링크백 후 update).
import { pushOutbox } from "./clickup-push.js";
import { exitCodeForPush } from "./push-budget.js";
import { logger } from "../log.js";

const name = process.argv[2];
if (name !== "clickup") {
  logger.error("사용: run-push clickup");
  process.exit(1);
}

const res = await pushOutbox({ startedAtMs: performance.timeOrigin });
logger.info(res, "run-push 완료");
// 부모(scheduler/actions/connector.ts)가 이 줄을 파싱해 정체 감시의 입력으로 쓴다(sync-outcome.childDrainSummary).
//  ⚠ logger 로만 내보내면 LOG_LEVEL 이 warn 이상일 때 마지막 줄이 요약이 아니게 되어 **감시가 조용히 눈먼다**
//   — 판정 입력은 로그 레벨에 종속되면 안 된다. 사람이 읽는 로그는 위 줄, 기계가 읽는 값은 이 줄이다.
process.stdout.write(JSON.stringify(res) + "\n");
process.exit(exitCodeForPush(res));
