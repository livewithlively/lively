// 아웃바운드 푸시 원샷 CLI — external_outbox(pending) → ClickUp. run-sync(인바운드)의 역방향.
//  스케줄러 action='connector_push' 가 서브프로세스로 호출(검증된 CLI만 실행 — 임의 셸 금지 정책).
//  사용: node --env-file-if-exists=.env dist/connectors/run-push.js clickup
//  필요 env: ITEMS_DATABASE_URL, CLICKUP_API_TOKEN, CLICKUP_CONTAINER_LIST_ID
//  멱등: 드레인이 현재 project 행을 재읽기해 upsert — 두 번 돌려도 같은 ClickUp 상태로 수렴(external_id 링크백 후 update).
import { pushOutbox } from "./clickup-push.js";
import { logger } from "../log.js";

const name = process.argv[2];
if (name !== "clickup") {
  logger.error("사용: run-push clickup");
  process.exit(1);
}

const res = await pushOutbox();
logger.info(res, "run-push 완료");
process.exit(res.failed > 0 ? 1 : 0);
