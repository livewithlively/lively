// 일회성 등록기 — '관련 지식 자동 회수'(UserPromptSubmit) 커스텀 훅(org_hook)을 DB 에 upsert.
//  소스는 kit/hooks/examples/knowledge-recall.org-hook.mjs 에서 읽어 content_hash(sha256)와 함께 박는다
//  (런너 run-custom.mjs 가 content_hash 무결성 게이트로 검증하므로 정확히 일치해야 한다).
//  토큰이 runtime 권한이 없을 때의 DB 직접 경로 — 평상시 등록·토글은 관리탭 ▸ 커스텀 훅 UI 로 한다.
//
//  사용: node --env-file=.env scripts/register-knowledge-recall-hook.mjs            # 등록(비활성, 기본)
//        node --env-file=.env scripts/register-knowledge-recall-hook.mjs --enable   # 활성화(롤아웃)
//        node --env-file=.env scripts/register-knowledge-recall-hook.mjs --disable  # 비활성화
//  ⚠ enabled=true 면 모든 멤버 세션의 UserPromptSubmit 에서 실행된다(런너가 업데이트된 멤버만 실제 주입).
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "kit", "hooks", "examples", "knowledge-recall.org-hook.mjs");
const source = fs.readFileSync(SRC, "utf8");
const hash = crypto.createHash("sha256").update(source).digest("hex");
const enabled = process.argv.includes("--enable");   // 미지정·--disable → false
const ID = "knowledge-recall";

if (!process.env.ITEMS_DATABASE_URL) { console.error("ITEMS_DATABASE_URL 미설정 — --env-file=.env 로 실행하세요"); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.ITEMS_DATABASE_URL, max: 2 });
const r = await pool.query(
  `INSERT INTO org_hook(id,label,harness,event,matcher,source_code,timeout_sec,note,enabled,sort,version,content_hash,created_by,updated_at,updated_by)
     VALUES($1,$2,'claude','UserPromptSubmit',NULL,$3,5,$4,$5,20,1,$6,'system',now(),'system')
   ON CONFLICT (id) DO UPDATE SET
     label=EXCLUDED.label, harness=EXCLUDED.harness, event=EXCLUDED.event, source_code=EXCLUDED.source_code,
     timeout_sec=EXCLUDED.timeout_sec, note=EXCLUDED.note, enabled=EXCLUDED.enabled,
     content_hash=EXCLUDED.content_hash, version=org_hook.version+1, updated_at=now()
   RETURNING id, enabled, version, content_hash`,
  [ID, "관련 지식 자동 회수 (#172)", source,
   "프롬프트와 의미적으로 가까운 팀 지식 인덱스를 주입(벡터검색 #172). knowledge_similar min_score 게이팅·fail-open·본문 미주입.",
   enabled, hash]);
console.log("org_hook upsert:", r.rows[0]);
await pool.end();
