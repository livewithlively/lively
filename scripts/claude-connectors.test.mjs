// 구성원 Claude 커넥터의 화면 말·매핑(web/lib/claude-connectors.ts) — 서버와 한 벌인지 값으로 지킨다(#4213 T13).
//
//  사양(scratchpad spec.md §G):
//   C1 Claude 커넥터 이름(대소문자·앞뒤 공백 무관) → 수집 단위·자료의 앱 키: Slack·Notion·Gmail·Google Drive·Microsoft 365 → slack·notion·gmail·gdrive·outlook
//   C2 표에 없는 이름은 슬러그로 접는다(새 커넥터도 화면이 깨지지 않게) · C3 빈 값은 빈 값
//   C4 서버의 앱 키 → 커넥터 이름(unit-store connectorOfApp)을 거꾸로 하면 원래 앱 키로 돌아온다(두 표가 어긋나면 현황판 칸이 엉뚱한 앱에 붙는다)
//   C5 화면이 «모을 수 있는 앱» 으로 아는 것 = 서버 수집 실행이 아는 앱(collect-plan CLAUDE_COLLECT_APPS)
//   C6 모르는 확인 실패 사유는 내부 코드를 보이지 않고 «확인하지 못했어요.»
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const eq = (got, want, what) => { assert.deepEqual(got, want, what); pass++; };

const web = await import(join(root, "public/app/lib/claude-connectors.js"));
const { connectorOfApp } = await import(join(root, "dist/org/collect/connector-names.js"));
const { CLAUDE_COLLECT_APPS } = await import(join(root, "dist/org/collect/collect-plan.js"));

// 배선 — 셋 다 실제로 불러왔다(관측 장치가 죽어 있으면 아래는 통과하면서 아무것도 안 본다).
eq([typeof web.appKeyOfConnector, typeof connectorOfApp, typeof CLAUDE_COLLECT_APPS], ["function", "function", "object"], "W0 배선");

// C1
for (const [name, key] of [["Slack", "slack"], ["notion", "notion"], ["GMAIL", "gmail"], ["Google Drive", "gdrive"], ["  Microsoft 365 ", "outlook"]]) {
  eq(web.appKeyOfConnector(name), key, `C1 ${JSON.stringify(name)}`);
}
// C2 · C3
eq(web.appKeyOfConnector("Acme CRM"), "acme-crm", "C2 표 밖 이름은 슬러그");
eq(web.appKeyOfConnector(""), "", "C3 빈 값");
eq(web.appKeyOfConnector(null), "", "C3 null");
// C4 — 서버 표의 역
for (const app of ["slack", "notion", "gmail", "gdrive", "outlook"]) {
  eq(web.appKeyOfConnector(connectorOfApp(app)), app, `C4 ${app} → ${connectorOfApp(app)} → ${app}`);
}
// C5
eq([...web.CLAUDE_COLLECT_APP_KEYS].sort(), Object.keys(CLAUDE_COLLECT_APPS).sort(), "C5 모을 수 있는 앱이 서버와 같다");
// C6
eq(web.scanErrorText("weird-new-code"), "확인하지 못했어요.", "C6 모르는 사유");
eq(web.scanErrorText("not-logged-in"), "Claude 에 로그인돼 있지 않아요.", "C6′ 아는 사유는 사람 말로");
// 이름표 — 앱 키의 이름, 표 밖이면 받은 대체 이름
eq(web.appLabel("gdrive"), "Google Drive", "L1");
eq(web.appLabel("acme-crm", "Acme CRM"), "Acme CRM", "L2 표 밖은 대체 이름");
eq(web.NOT_WORK_APPS.has(web.appKeyOfConnector("Claude Docs")), true, "L3 Claude Docs 는 일 자료 앱이 아니다");

console.log(`claude-connectors: ${pass} passed`);
