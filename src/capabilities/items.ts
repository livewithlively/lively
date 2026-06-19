// item 폐기·ku 흡수(2026-06): search_items / get_item 은 폐기되었다 — ku(knowledge_unit)가 단일 캐노니컬
// 표면이고, 구 활동검색(type/system/since)과 단건상세/스레드는 ctx_* 가 흡수했다:
//   · search_items → ctx_ls / ctx_grep (system·since·source·type 필터 추가, fields._item_type 보존)
//   · get_item.thread → ctx_cat(thread:true) (parent_name 자기참조 재귀)
// item 물리 테이블/UI fn(searchItemsUi/getItemUi/getItemThread)은 레거시로 남아 있으나(드랍 미실행),
// MCP/REST 표면에서는 제거됐다. 이 파일은 빈 capability 배열만 export 한다(import 경계 보존).
import type { Capability } from "./types.js";

export const itemCapabilities: Capability[] = [];
