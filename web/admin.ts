// admin.ts — 관리탭 재수출 배럴 (#1313 R37~R40 분해 완료). **여기에 로직을 두지 마라.**
//  원래 이 파일은 관리탭 전부(그룹 표·셸·패널 30여 개)를 담은 4,400줄짜리였다. 네 항목에 걸쳐 축을 따라
//  갈랐고(R37 레지스트리·위젯/설치·자족 패널 → R38 자격 금고·[내 설정] → R39 도메인 패널 A → R40 도메인 패널 B·셸),
//  지금 남은 역할은 하나뿐이다: **옛 import 경로 './admin.js' 를 그대로 살려 두는 것.**
//  화면 진입점(renderSystem)과 정보구조는 admin-shell.ts 에, 각 화면은 admin-*.ts / me-*.ts 에 산다.
//  새 심볼을 여기 추가하지 말고 소비자가 실체 모듈에서 직접 받게 하라 — 이 배럴은 줄어드는 방향으로만 간다.
export { hasScope } from './core.js';
export { confirmDialog, copyButton, copyText, field, fieldWithHelp, overlay } from './ui-primitives.js';
export { loadAdmin, registerPanel, rerenderPanel } from './admin-rerender.js';
export { allowlistCard, fmtBytes, fmtElapsed, mcpFieldsEl, psBlock, psInputStyle, sectionHead, sectionTitle, segTabs, targetMembersField } from './admin-widgets.js';
export { deployCommands, installCmd, installMinterBlock } from './admin-install.js';
export { dbAuditEditor, orgAuditPanel, toolUsagePanel, tuPageNumbers } from './admin-audit.js';
export { cronPanel, managedSessionsPanel } from './admin-automation.js';
export { previewEnvsPanel } from './admin-preview.js';
export { AWS_REGIONS, CRED_KINDS, awsRoleCard, catalogStatusCard, credVaultCard, credentialsEditor, openGitCredentialManager, svcTokenForm } from './admin-credentials.js';
export { PROF_DEV, PROF_LANG, PROF_TONE, applyMyProfileSaved, avatarEditor, changePasswordModal, openMyProfileModal, parseMyProfile, profChips } from './me-profile.js';
export { myAiSection } from './me-ai.js';
export { CH_TYPE_LABEL, LOGIN_SERVICES, channelRuleExplainer, myLoginsSection, renderServices, slackChannelPolicyCard } from './me-logins.js';
export { myAssetsSection } from './me-assets.js';
export { memberForm, memberRead, membersEditor, openMemberModal, profileEditor, profilesEditor, teamsPanel, tokensPanel } from './admin-members.js';
export { reposPanel } from './admin-repos.js';
export { injectionMap } from './admin-injection.js';
export { storageEditor } from './admin-storage.js';
export { logsEditor, sessionShareEditor, sessionsAdminEditor } from './admin-ops.js';
export { embeddingsEditor } from './admin-embeddings.js';
// 화면 진입점 — 라우터(main.ts)가 './admin.js' 에서 받는다. 실체는 admin-shell.ts.
export { renderSystem } from './admin-shell.js';
