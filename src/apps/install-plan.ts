// 앱 설치 전개 계획 — 순수(#1780, design D2). 매니페스트 → 전개할 구성요소(component) 목록 + 업데이트 diff.
//  왜 순수로 뺐나: 저널드 2-phase(design R2-1)의 정확성은 "무엇을 심고 무엇을 회수하나"에 달렸는데,
//  그 판정은 DB 없이 결정된다 → 순수 함수로 두고 fail-first 로 검증(설치 오케스트레이터는 이 계획을 실행만).
//
// 계획 가능 범위: 매니페스트가 **직접 선언**한 것(ui·jobs·data·sections·hosts·mcp_servers·http_tools).
//  harness_asset(스킬·에이전트·커맨드)은 플러그인 트리 FS 스캔이 필요해 여기서 계획하지 않는다 —
//  오케스트레이터가 스캔 결과를 component 로 추가한다(kind='harness_asset', ref=appAssetId).
import { HttpError } from "../http-error.js";
import type { LivelyAppManifest } from "./manifest.js";
import { appAssetId } from "./manifest.js";

// 전개될 구성요소 한 개. kind 는 schema/apps.ts APP_COMPONENT_KINDS 와 일치(문자열로 느슨하게 — 순환 import 회피).
export interface AppComponentRef {
  kind: string;
  ref: string;        // 대상 행의 자연키(문자열)
  orig_name?: string; // 자산 번들 내 원명(물질화 시 복원, design R1-F4)
}

/**
 * 매니페스트에서 순수 계획 가능한 component 목록. harness_asset 제외(FS 스캔 필요).
 *  - ui.pages/widgets → ui_page/ui_widget (ref = key)
 *  - jobs → cron (ref = 앱 스코프 잡 키 `app:<appId>:<jobKey>` — 실제 cron id 는 오케스트레이터가 매핑)
 *  - data.tables → data_table (ref = 테이블명)
 *  - sections → section (ref = appAssetId(앱,섹션key) — 물질화 경로에서 원명 복원)
 *  - permissions.hosts → host (ref = 호스트)
 *  - tools.mcp_servers → mcp_server (ref = 서버 name)  / tools.http_tools → tool (ref = 툴 name)
 */
export function planDeclaredComponents(m: LivelyAppManifest): AppComponentRef[] {
  const out: AppComponentRef[] = [];

  for (const p of m.ui.pages) out.push({ kind: "ui_page", ref: p.key });
  for (const w of m.ui.widgets) out.push({ kind: "ui_widget", ref: w.key });
  for (const j of m.jobs) out.push({ kind: "cron", ref: `app:${m.id}:${j.key}`, orig_name: j.key });
  for (const t of m.data.tables) out.push({ kind: "data_table", ref: t.name });
  for (const s of m.sections) out.push({ kind: "section", ref: appAssetId(m.id, s.key), orig_name: s.key });
  for (const host of m.permissions.hosts) out.push({ kind: "host", ref: host.toLowerCase() });

  for (const s of m.tools.mcp_servers) {
    const name = extractName(s, "tools.mcp_servers");
    out.push({ kind: "mcp_server", ref: appAssetId(m.id, name), orig_name: name });
  }
  for (const t of m.tools.http_tools) {
    const name = extractName(t, "tools.http_tools");
    out.push({ kind: "tool", ref: appAssetId(m.id, name), orig_name: name });
  }
  assertNoDupComponents(out);
  return out;
}

function extractName(o: Record<string, unknown>, where: string): string {
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) throw new HttpError(400, `매니페스트 오류 [${where}]: 각 항목에 name 이 필요합니다`);
  return name;
}

function assertNoDupComponents(refs: AppComponentRef[]): void {
  const seen = new Set<string>();
  for (const r of refs) {
    const k = `${r.kind}\0${r.ref}`;
    if (seen.has(k)) throw new HttpError(400, `설치 계획 오류: 구성요소 중복 ${r.kind}/${r.ref}`);
    seen.add(k);
  }
}

// ── 업데이트 diff(design R2-5) ────────────────────────────────────────────────
export interface ComponentDiff {
  add: AppComponentRef[];   // 새로 전개할 것
  keep: AppComponentRef[];  // 유지(upsert — 내용이 바뀌었을 수 있으므로 다시 씀)
  drop: AppComponentRef[];  // 매니페스트에서 빠짐/이름 바뀜 → **disable**(비파괴; 삭제 아님)
}

/**
 * 구 component 집합 vs 신 계획 → add/keep/drop. 동일성 키 = (kind, ref).
 *  drop 은 삭제가 아니라 disable 대상(시드 규약엔 자동 삭제가 없으므로 명시 diff 필요 — 안 하면 죽은 자산이
 *  계속 물질화되고 크론이 계속 발화한다, design R2-5).
 */
export function diffComponents(oldRefs: AppComponentRef[], nextRefs: AppComponentRef[]): ComponentDiff {
  const key = (r: AppComponentRef): string => `${r.kind}\0${r.ref}`;
  const oldMap = new Map(oldRefs.map((r) => [key(r), r]));
  const nextMap = new Map(nextRefs.map((r) => [key(r), r]));
  const add: AppComponentRef[] = [];
  const keep: AppComponentRef[] = [];
  const drop: AppComponentRef[] = [];
  for (const [k, r] of nextMap) (oldMap.has(k) ? keep : add).push(r);
  for (const [k, r] of oldMap) if (!nextMap.has(k)) drop.push(r);
  return { add, keep, drop };
}
