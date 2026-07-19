// 위키 아웃바운드 드레인 원샷 CLI — 등록 노션 feed_target → 지식 피드 카드. run-sync(인바운드)의 역방향, run-push(프로젝트)의 위키판.
//  스케줄러 action='wiki_push' 가 서브프로세스로 호출(검증된 CLI만 실행 — 임의 셸 금지 정책).
//  사용: node --env-file-if-exists=.env dist/connectors/run-wiki-push.js
//  필요 env: ITEMS_DATABASE_URL, NOTION_TOKEN(관리탭 또는 .env). 멱등(content_hash 무변경 skip — 두 번 돌려도 같은 상태로 수렴).
import { drainWikiFeeds } from "./notion-push.js";
import { logger } from "../log.js";

const res = await drainWikiFeeds();
logger.info(res, "run-wiki-push 완료");
process.exit(res.failed > 0 ? 1 : 0);
