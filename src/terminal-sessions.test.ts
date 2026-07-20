// 단위 체크(node:assert) — '확인 필요'(waiting) pane 판정. 픽스처는 tmux capture-pane 실측(#853).
// 실행: npm run build && node dist/terminal-sessions.test.js
import assert from "node:assert/strict";
import { detectAwaiting, sessionVisibleTo, sessionAttachableBy, type SessionAcl } from "./terminal-sessions.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// 입력창(모드 푸터 포함) — 다이얼로그가 없을 때 pane 하단에 늘 있는 것.
const INPUT_BOX = [
  "─".repeat(120),
  "❯ ",
  "─".repeat(120),
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

t("끝난 대화 + 하단 입력창 → 대기 아님", () => {
  assert.equal(detectAwaiting(["⏺ 답변입니다.", "", INPUT_BOX].join("\n")), false);
});

// #853 회귀: Claude Code 는 과거 사용자 메시지도 '❯ ' 로 그린다 → 번호목록을 보낸 세션의 전사에
// "❯ 1. …" 이 남아 승인 커서로 오인됐다(끝난 대화가 영구 '확인 필요' 빨강).
t("전사에 남은 사용자의 번호목록 메시지 → 대기 아님(#853 오탐)", () => {
  const pane = [
    "❯ 1. 최근에 위키를 열어보셨던 때에는 무엇을 하려고 들어가셨나요?",
    "",
    "  2. 노션에서는 늘 하는데 라이블리 위키에서는 안 되거나 훨씬 번거로운 것 2~3개만 꼽아주신다면?",
    "",
    "⏺ 비나용 2차 질문 세트입니다 — 확정하신 1차 5문항과 겹치지 않는 각도로 6문항입니다.",
    "",
    "✻ Baked for 2m 17s",
    INPUT_BOX,
  ].join("\n");
  assert.equal(detectAwaiting(pane), false);
});

t("사용자가 입력창에 번호목록을 타이핑 중 → 대기 아님", () => {
  const pane = ["⏺ 네.", "─".repeat(120), "❯ 1. 첫째 2. 둘째", "─".repeat(120), "  ⏸ manual mode on · ? for shortcuts"].join("\n");
  assert.equal(detectAwaiting(pane), false);
});

// 실측: Write 툴 승인 다이얼로그. 문구가 "Do you want to proceed?" 가 아니라 툴별로 다르다.
t("승인 다이얼로그(파일 생성) → 대기", () => {
  const pane = [
    "❯ Create a file named hello.txt containing the word hi, in the current directory.",
    "",
    "⏺ Write(hello.txt)",
    "─".repeat(120),
    " Create file",
    " hello.txt",
    "╌".repeat(120),
    "  1 hi",
    "╌".repeat(120),
    " Do you want to create hello.txt?",
    " ❯ 1. Yes",
    "   2. Yes, allow all edits during this session (shift+tab)",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend",
  ].join("\n");
  assert.equal(detectAwaiting(pane), true);
});

// 실측: AskUserQuestion 선택 메뉴.
t("질문 선택 메뉴 → 대기", () => {
  const pane = [
    "❯ Ask me which color I prefer.",
    " ☐ Color",
    "Which color do you prefer, red or blue?",
    "",
    "❯ 1. Red",
    "     Warm, bold, high-energy.",
    "  2. Blue",
    "     Cool, calm, steady.",
    "  3. Type something.",
    "  4. Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  assert.equal(detectAwaiting(pane), true);
});

t("Bash 승인 다이얼로그(Do you want to proceed?) → 대기", () => {
  const pane = [
    "⏺ Bash(rm -rf build)",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No, and tell Claude what to do differently (esc)",
    "",
    " Esc to cancel",
  ].join("\n");
  assert.equal(detectAwaiting(pane), true);
});

t("빈 pane → 대기 아님", () => {
  assert.equal(detectAwaiting(""), false);
});

// ── #1015 세션 접근 모델(가시성·입장) — 사양 기반 블라인드 테스트(spec-blind-test) ──
// ── Axis 1: sessionVisibleTo ──────────────────────────────────────────

t("visible: owner sees their own private session", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: true, projectFolder: false };
  assert.equal(sessionVisibleTo("alice", s), true); // clause 1
});

t("visible: invited member sees a private session they're invited to", () => {
  const s: SessionAcl = { owner: "alice", invites: ["bob"], private: true, projectFolder: false };
  assert.equal(sessionVisibleTo("bob", s), true); // clause 2
});

t("visible: project-folder session is visible to an unrelated viewer", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: false, projectFolder: true };
  assert.equal(sessionVisibleTo("carol", s), true); // clause 3
});

t("visible: project-folder session visible to unrelated viewer even if marked private", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: true, projectFolder: true };
  assert.equal(sessionVisibleTo("carol", s), true); // clause 3 overrides 5
});

t("visible: public personal session is visible to a non-owner non-invited viewer", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: false, projectFolder: false };
  assert.equal(sessionVisibleTo("carol", s), true); // clause 4 (KEY: visible half)
});

t("visible: private personal session NOT visible to non-owner non-invited viewer", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: true, projectFolder: false };
  assert.equal(sessionVisibleTo("carol", s), false); // clause 5
});

t("visible: private session with an unrelated invitee stays hidden from someone else", () => {
  const s: SessionAcl = { owner: "alice", invites: ["bob"], private: true, projectFolder: false };
  assert.equal(sessionVisibleTo("carol", s), false); // clause 5 (carol not owner/invited)
});

t("visible: viewer=null sees a private non-project session", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: true, projectFolder: false };
  assert.equal(sessionVisibleTo(null, s), true); // clause 6
});

t("visible: viewer=null sees a public personal session", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: false, projectFolder: false };
  assert.equal(sessionVisibleTo(null, s), true); // clause 6
});

t("visible: viewer=null sees a project-folder session", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: true, projectFolder: true };
  assert.equal(sessionVisibleTo(null, s), true); // clause 6
});

// ── Axis 2: sessionAttachableBy ───────────────────────────────────────

t("attach: owner can attach their own private session", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: true, projectFolder: false };
  assert.equal(sessionAttachableBy("alice", s), true); // clause 2 (owner)
});

t("attach: invited member can attach a private session they're invited to", () => {
  const s: SessionAcl = { owner: "alice", invites: ["bob"], private: true, projectFolder: false };
  assert.equal(sessionAttachableBy("bob", s), true); // clause 2 (invited)
});

t("attach: unrelated viewer can attach a project-folder session", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: false, projectFolder: true };
  assert.equal(sessionAttachableBy("carol", s), true); // clause 1
});

t("attach: unrelated viewer can attach a project-folder session even if marked private", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: true, projectFolder: true };
  assert.equal(sessionAttachableBy("carol", s), true); // clause 1 (public/private irrelevant to project folder)
});

t("attach: public personal session NOT attachable by non-owner non-invited viewer", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: false, projectFolder: false };
  assert.equal(sessionAttachableBy("carol", s), false); // clause 2 & 3 (KEY: attach half)
});

t("attach: private personal session NOT attachable by non-owner non-invited viewer", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: true, projectFolder: false };
  assert.equal(sessionAttachableBy("carol", s), false); // clause 2
});

t("attach: public flag does not grant attach to an unrelated viewer", () => {
  const s: SessionAcl = { owner: "alice", invites: ["bob"], private: false, projectFolder: false };
  assert.equal(sessionAttachableBy("carol", s), false); // clause 3
});

t("attach: viewer=null cannot attach a personal session", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: false, projectFolder: false };
  assert.equal(sessionAttachableBy(null, s), false); // clause 4
});

t("attach: viewer=null cannot attach a private personal session", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: true, projectFolder: false };
  assert.equal(sessionAttachableBy(null, s), false); // clause 4
});

t("attach: viewer=null can attach a project-folder session", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: true, projectFolder: true };
  assert.equal(sessionAttachableBy(null, s), true); // clause 4 exception (clause 1)
});

// ── Core edges: both axes together ────────────────────────────────────

t("edge: public other's personal session — visible but NOT attachable (KEY)", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: false, projectFolder: false };
  assert.equal(sessionVisibleTo("carol", s), true);
  assert.equal(sessionAttachableBy("carol", s), false);
});

t("edge: private other's personal session (no invite) — NOT visible and NOT attachable", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: true, projectFolder: false };
  assert.equal(sessionVisibleTo("carol", s), false);
  assert.equal(sessionAttachableBy("carol", s), false);
});

t("edge: private other's session I'm invited to — visible and attachable", () => {
  const s: SessionAcl = { owner: "alice", invites: ["bob"], private: true, projectFolder: false };
  assert.equal(sessionVisibleTo("bob", s), true);
  assert.equal(sessionAttachableBy("bob", s), true);
});

t("edge: my own private session — visible and attachable", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: true, projectFolder: false };
  assert.equal(sessionVisibleTo("alice", s), true);
  assert.equal(sessionAttachableBy("alice", s), true);
});

t("edge: project-folder session (I'm not owner/invited) — visible and attachable", () => {
  const s: SessionAcl = { owner: "alice", invites: [], private: false, projectFolder: true };
  assert.equal(sessionVisibleTo("carol", s), true);
  assert.equal(sessionAttachableBy("carol", s), true);
});

t("edge: viewer=null — all visible; personal not attachable, project folder attachable", () => {
  const personal: SessionAcl = { owner: "alice", invites: [], private: true, projectFolder: false };
  const folder: SessionAcl = { owner: "alice", invites: [], private: true, projectFolder: true };
  assert.equal(sessionVisibleTo(null, personal), true);
  assert.equal(sessionVisibleTo(null, folder), true);
  assert.equal(sessionAttachableBy(null, personal), false);
  assert.equal(sessionAttachableBy(null, folder), true);
});

console.log(`\n${pass} passed`);
