// #4488 — 관리탭 «서비스 로그인» 통합 자격 폼이 코어가 읽는 워크스페이스 Anthropic 키 kind 를 그대로 고를 수 있어야 한다.
//  (처음 판엔 이 줄이 없어 사람이 등록할 화면이 없었다 — MCP org_credential_set 만 있었다.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANTHROPIC_KEY_KIND } from "./live.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const form = readFileSync(path.join(ROOT, "web/admin-credentials.ts"), "utf8");
const row = form.split("\n").find((l) => l.includes(`kind: '${ANTHROPIC_KEY_KIND}'`));
assert.ok(row, `AF1 관리탭 자격 폼에 kind '${ANTHROPIC_KEY_KIND}' 줄이 있다`);
assert.ok(!/memberOnly:\s*true/.test(row!), "AF2 조직 통합(owner=gateway) 자격이라 개인 전용이 아니다 — 통합 자격 카드에 보여야 한다");
assert.match(row!, /secretPh: 'sk-ant-/, "AF3 키 모양 안내");
// AF4 워크스페이스에 묶이지 않은 키를 위한 부속 칸 — meta.workspace_id(코어 live.ts workspaceAnthropicWorkspaceId 가 읽는 키 이름과 같아야 한다)
const start = form.indexOf(row!); const rowBlock = form.slice(start, form.indexOf("\n  {", start + 1) > 0 ? form.indexOf("\n  // #1101", start) : form.length);
assert.match(rowBlock, /metaField: \{ key: 'workspace_id'/, "AF4 폼의 부속 칸 key = workspace_id");
const live = readFileSync(path.join(ROOT, "src/ai-runs/live.ts"), "utf8");
assert.match(live, /meta\?\.workspace_id/, "AF4 코어가 같은 meta 키를 읽는다");
// AF5 폼이 부속 칸 값을 meta 에 실어 보낸다(값이 있을 때만)
assert.match(form, /if \(spec\.metaField && metaIn\.value\.trim\(\)\) payload\.meta = \{ \.\.\.\(payload\.meta \|\| \{\}\), \[spec\.metaField\.key\]: metaIn\.value\.trim\(\) \}/, "AF5 저장 payload.meta[key]");
console.log("✓ admin-form-wiring — 관리탭 자격 폼 × 코어 ANTHROPIC_KEY_KIND (AF1~AF5)");
