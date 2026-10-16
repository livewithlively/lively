// 앱 키(수집 단위·자료의 외부 시스템 키) → claude.ai 커넥터 이름(«claude.ai » 뒤) — 순수 표(#4213 T10 → T13 에서 떼어 냄).
//  unit-store 가 단위에 connector 가 비었을 때 쓰고, 화면 쪽 역매핑(web/lib/claude-connectors.ts)이 이 표와 맞는지
//  계약 시험(scripts/claude-connectors.test.mjs)이 본다. DB·로거를 끌어오지 않게 따로 둔다(시험이 이 파일만 불러온다).

/** 측정한 claude.ai 커넥터 이름(«claude.ai » 뒤) — 단위에 connector 가 비었을 때만 쓴다. 목록 반영이 정확한 이름을 남긴다. */
export const CONNECTOR_OF_APP: Readonly<Record<string, string>> = {
  slack: "Slack", notion: "Notion", gmail: "Gmail", gdrive: "Google Drive", outlook: "Microsoft 365",
};

export function connectorOfApp(app: string): string {
  return CONNECTOR_OF_APP[app] ?? app;
}
