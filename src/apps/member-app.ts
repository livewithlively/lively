// 구성원이 저장하는 앱 (#4225, 상민 2026-09-30) — 앱은 라이블리 팀이 아니라 **그 워크스페이스가** 마음에 안 드는 곳을 바로
//  고쳐 쓰는 것이다. 그래서 `app_save` 는 관리자가 아니어도 된다. 대신 두 가지를 가른다(여기 두 순수 함수가 정본):
//
//  ① 무엇을 담을 수 있나 — **화면 + 데이터** 까지. 앱 화면은 샌드박스(불투명 오리진·네트워크 0)에서 돌고, 데이터는 그 앱의
//     테이블뿐이고, 라이블리 도구는 쓰는 사람이 동의한 만큼만 쓴다 — 그래서 누가 저장해도 다른 사람에게 새는 것이 없다.
//     그 바깥(구성원 컴퓨터에서 도는 스킬·훅 · 정기 작업 · MCP·HTTP 도구 · 서버 worker · 서버가 나갈 호스트 · 앱 화면의 직접
//     네트워크 · 조직 섹션 · 시스템 렌더러)은 **다른 사람의 자리에서 실행되거나 밖으로 나가는 것**이라 관리자 설치(org_app_install)로만.
//  ② 누가 고칠 수 있나 — 앱마다 `edit_mode`: 'all'(기본 — 구성원 전원) · 'members'(지정한 사람 + 관리자). 빌트인(코드 소유)은
//     아무도 못 고친다(릴리스로만). 관리자가 넓게 설치한 앱(①을 벗어난 것)도 app_save 로는 못 고친다 — 저장하면 그 전개물이 걷힌다.
import type { LivelyAppManifest } from "./manifest.js";
import type { OrgApp } from "../org/store/apps.js";
import { isBuiltinSource } from "./store-ddl.js";

/** 구성원 저장 앱에서 허용하지 않는 선언들 — 사람이 읽을 이름으로. 비었으면 통과. 순수. */
export function memberAppViolations(m: LivelyAppManifest): string[] {
  const out: string[] = [];
  if (m.harness) out.push("harness(구성원 컴퓨터에 까는 스킬·훅)");
  if ((m.tools?.mcp_servers ?? []).length) out.push("tools.mcp_servers");
  if ((m.tools?.http_tools ?? []).length) out.push("tools.http_tools");
  if ((m.permissions?.ext_tools ?? []).length) out.push("permissions.ext_tools");
  if ((m.permissions?.hosts ?? []).length) out.push("permissions.hosts(서버가 나갈 곳)");
  if ((m.permissions?.db_sources ?? []).length) out.push("permissions.db_sources");
  if (m.runtime) out.push("runtime(서버 worker)");
  if ((m.jobs ?? []).length) out.push("jobs(정기 작업)");
  if ((m.sections ?? []).length) out.push("sections(조직 섹션)");
  if (m.system) out.push("system(셸 렌더러)");
  if ((m.csp?.connect_domains ?? []).length) out.push("csp.connect_domains(앱 화면의 직접 네트워크)");
  return out;
}

export interface Editor { userId: string; scopes?: string[] }

/**
 * 이 사람이 **이미 있는** 이 앱을 app_save 로 고칠 수 있나. 순수.
 *  반환 null = 된다 · 문자열 = 안 되는 이유(사람에게 그대로 보인다).
 */
export function editDenial(app: OrgApp, who: Editor, currentManifest: LivelyAppManifest | null): string | null {
  if (isBuiltinSource(app.source)) return `「${app.title || app.id}」 은(는) 라이블리가 함께 싣는 기본 앱이라 여기서 고칠 수 없습니다 — 같은 모양의 앱을 새 id 로 저장해 쓰세요`;
  //  저장된 매니페스트를 못 읽으면 확장 앱인지 알 수 없다 — 모르면 막는다(저장하면 모르는 전개물이 걷힐 수 있다).
  if (!currentManifest) return `「${app.title || app.id}」 의 저장된 설명을 읽지 못해 app_save 로 고칠 수 없습니다 — 관리자에게 부탁하세요`;
  if (memberAppViolations(currentManifest).length) {
    return `「${app.title || app.id}」 은(는) 관리자가 확장 기능과 함께 설치한 앱이라 app_save 로 고칠 수 없습니다 — 관리자에게 부탁하세요`;
  }
  if (app.edit_mode === "all") return null;
  if ((who.scopes ?? []).includes("admin")) return null;
  if (app.edit_members.includes(who.userId)) return null;
  return `「${app.title || app.id}」 은(는) 지정한 사람만 고칠 수 있습니다 — 워크스페이스 관리자에게 부탁하세요`;
}
