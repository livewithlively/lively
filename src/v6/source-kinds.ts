// 자료 종류(source.kind) 표준 목록 — import 0 의 잎(leaf). 자료 도구(capabilities/source.ts)의 입력 스키마와
//  앱 매니페스트의 맥락 범위(apps/manifest.ts context.source_kinds, #5100)가 같은 목록을 쓴다 — 매니페스트는 DB·도구 계층을 끌어오면 안 돼서 여기 둔다.
//  미러는 이 목록 밖의 종류를 'other' 로 접는다(v6/mirror/mirror-source.ts) — 그래서 이 목록이 곧 자료가 가질 수 있는 종류 전부다.
export const SOURCE_KINDS = ["transcript", "minutes", "email", "slack", "discord", "notion_doc", "clickup_doc", "drive_file", "local_file", "figma_comment", "github_issue", "gitlab_issue", "linear_issue", "zotero_item", "other"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
