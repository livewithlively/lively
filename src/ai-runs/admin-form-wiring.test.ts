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
console.log("✓ admin-form-wiring — 관리탭 자격 폼 × 코어 ANTHROPIC_KEY_KIND (AF1~AF3)");
