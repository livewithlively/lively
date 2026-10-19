// lib/tool-explain.ts — 앱 동의 창의 «도구» 이름을 **처음 보는 사람도 알아듣는 말**로(#4632, 원준 2026-10-19).
//
//  원준 «이런 화면 뜨는거 너무 마음에 드는데, 일반인 입장에서 저 도구가 각각 뭐하는건지 모르겠음. 저 도구의 이름 … 위에 호버하면 고등학생도 이해할 수 있는 수준으로 내용을 좀 뜨게 해줘.»
//  동의 창(v2/app-session.ts appConsent)은 앱이 선언한 도구 이름(store_query · app_notify …)을 그대로 칩으로 세운다 — 이름은 그대로 두고(무엇에 동의하는지 정확해야 한다),
//   올려 두면 이 글이 뜬다. 글은 «이 앱이 내 이름으로 무엇을 하나» 를 한두 문장으로 · 읽기만 하는지 바꾸는지 · 서비스 말투(~해요).
//  표에 없는 이름은 앞머리(store_ · knowledge_ …)로 갈래를 말하고, 그것도 모르면 일반 문장을 낸다 — 빈 칸은 없다.
//  시험: scripts/tool-explain.test.mjs

/** 도구 이름 → 설명. 앱이 실제로 선언하는 도구(워크스페이스 · 기본 앱 매니페스트 실측 2026-10-19)와 자주 쓰일 것.
 *  ⚠ 동의 창은 권한을 알리는 자리다 — 설명이 실제 권한보다 좁으면 안 된다(격리 리뷰: store_sql 은 지우기까지 · whoami 는 이메일까지 · file_url 은 올리기까지).
 *   코어에 그 이름의 도구가 없는 것(실측 link_preview — 앱이 선언만 했다)은 표에 넣지 않는다(무엇을 하는지 단정하지 않는다 → 일반 문장). */
export const TOOL_EXPLAIN: Readonly<Record<string, string>> = {
  //  이 앱의 기록(앱 데이터 표) — 앱마다 따로라 다른 앱의 기록은 아니다.
  store_query: '이 앱에 저장된 기록에서 필요한 것을 찾아 읽어요. 읽기만 하고 바꾸지는 않아요.',
  store_insert: '이 앱의 기록에 새 내용을 더해요. 새 글이나 새 항목을 저장할 때 써요.',
  store_update: '이 앱에 저장된 기록의 내용을 고쳐요.',
  store_delete: '이 앱에 저장된 기록을 지워요.',
  store_tables: '이 앱이 어떤 기록 표를 갖고 있는지 목록을 봐요.',
  store_sql: '이 앱의 기록을 조건에 맞게 찾고, 더하고, 고치고, 지울 수 있어요.',
  //  나 · 알림 · 링크 · 파일
  whoami: '지금 이 앱을 쓰는 사람이 누구인지(이름, 이메일, 프로필 사진) 알아봐요. 화면에 내 이름을 띄울 때 써요.',
  app_notify: '나나 다른 구성원에게 알림을 보내요. 이 앱을 쓰기로 한 사람에게만 가고, 알림을 꺼 둔 사람에게는 가지 않아요.',
  file_url: '파일을 올리거나 내려받을 수 있는 주소를 만들어요.',
  me_notifications: '나에게 온 알림을 읽어요.',
  me_notifications_read: '나에게 온 알림을 읽음으로 표시해요.',
  //  AI 세션 · 자료
  app_chat_send: '이 앱에서 내가 단추를 누르면 그 내용을 이 앱이 붙은 AI 세션에 메시지로 넣어요. 앱이 혼자 보내지는 않아요.',
  app_project_files: '이 앱이 붙은 AI 세션의 프로젝트 자료 파일을 읽어요. 고치지는 못해요.',
  app_workspace_files: '내가 볼 수 있는 모든 프로젝트의 자료 파일을 읽어요. 고치지는 못해요.',
  agent_job_run: '이 앱 화면에서 내가 보낸 지시를 AI가 내 이름으로 따로 맡아 처리해요.',
  app_ai_run: '이 앱이 AI에게 일을 시켜요. 내가 이 앱 화면에서 보낸 요청만 처리해요.',
  source_list: '자료(올린 파일과 모아 온 글)의 목록을 봐요.',
  source_get: '자료 하나를 열어 내용을 읽어요.',
  source_tree: '자료가 어떤 폴더에 들어 있는지 폴더 구조를 봐요.',
  //  위키(지식) · 분류
  knowledge_list: '위키 문서의 목록을 봐요.',
  knowledge_search: '위키에서 관련된 문서를 찾아요.',
  knowledge_get: '위키 문서 하나를 열어 읽어요.',
  knowledge_save: '위키에 문서를 새로 쓰거나 고쳐요.',
  category_list: '위키 문서를 나누는 분류의 목록을 봐요.',
  category_create: '위키에 새 분류를 만들어요.',
  category_update: '위키 분류의 이름이나 설명을 고쳐요.',
  category_delete: '위키 분류를 지워요.',
  category_group_list: '분류를 묶어 둔 묶음의 목록을 봐요.',
  category_group_upsert: '분류 묶음을 새로 만들거나 고쳐요.',
  category_group_remove: '분류 묶음을 지워요.',
  //  프로젝트 · 코드
  project_list_index_v6: '프로젝트를 담아 두는 리스트(폴더)의 목록을 봐요.',
  repo_list: '워크스페이스에 연결된 코드 저장소의 목록을 봐요.',
};

/** 표에 없는 이름 — 앞머리로 갈래를 말한다(긴 앞머리가 먼저). */
const PREFIX: ReadonlyArray<readonly [string, string]> = [
  ['category_group_', '위키 분류를 묶은 묶음을 다뤄요.'],
  ['store_', '이 앱의 기록을 다뤄요.'],
  ['knowledge_', '위키 문서를 다뤄요.'],
  ['category_', '위키 분류를 다뤄요.'],
  ['source_', '자료(올린 파일과 모아 온 글)를 다뤄요.'],
  ['project_', '프로젝트를 다뤄요.'],
  ['task_', '프로젝트의 할 일을 다뤄요.'],
  ['session_', 'AI 세션을 다뤄요.'],
  ['me_', '내 계정의 정보를 다뤄요.'],
  ['app_', '이 앱이 라이블리에서 쓰는 기능이에요.'],
];
/** 바깥 서비스 — 이름 머리(slack_ · ext__notion_ …)로 알아본다. 바깥 서비스는 내 계정으로 닿는다. */
const SERVICE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:ext__)?slack[_-]/, '슬랙'], [/^(?:ext__)?notion[_-]/, '노션'], [/^(?:ext__)?(?:google|gmail|gdrive)[_-]/, '구글'],
  [/^(?:ext__)?github[_-]/, '깃허브'], [/^(?:ext__)?gitlab[_-]/, '깃랩'], [/^(?:ext__)?figma[_-]/, '피그마'],
  [/^(?:ext__)?linear[_-]/, '리니어'], [/^(?:ext__)?clickup[_-]/, '클릭업'], [/^(?:ext__)?discord[_-]/, '디스코드'],
];
/** 무엇인지 모르는 도구 — 빈 칸 대신 이 말. 이름 자체는 칩에 그대로 있다. */
export const TOOL_EXPLAIN_UNKNOWN = '라이블리의 기능 하나예요. 이 앱이 내 이름으로 이 기능을 써요.';

/** 받침이 있으면 «을», 없으면 «를» — 슬랙을 · 피그마를. */
function objJ(w: string): string {
  const c = w.charCodeAt(w.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0 ? '을' : '를';
}
/** 도구 이름 하나의 설명 — 늘 비지 않은 한두 문장. */
export function toolExplain(name: string | null | undefined): string {
  const n = String(name || '').trim();
  if (!n) return TOOL_EXPLAIN_UNKNOWN;
  if (Object.prototype.hasOwnProperty.call(TOOL_EXPLAIN, n)) return TOOL_EXPLAIN[n];
  const low = n.toLowerCase();
  for (const [re, who] of SERVICE) if (re.test(low)) return who + objJ(who) + ' 내 계정으로 써요. 이 앱이 ' + who + '에서 내가 볼 수 있는 것을 읽거나 보낼 수 있어요.';
  for (const [p, t] of PREFIX) if (low.startsWith(p)) return t;
  return TOOL_EXPLAIN_UNKNOWN;
}
