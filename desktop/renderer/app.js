// 렌더러 (#1541 T2 · #5650) — 상태를 그리고 사람의 답을 메인에 넘긴다. **판단은 메인에 있다**(여긴 표시만).
//  window.lively 는 preload 가 노출한 함수 묶음뿐이다(ipcRenderer 원본은 안 넘어온다).
//
// 화면은 두 갈래다.
//  · 새 시작 흐름(#5650): 시작 → (회사 서버 주소) → 승인 대기 → 이 컴퓨터 설정 → 설정 중 → 완료 / 일부 실패.
//    메인이 setup 상태(screen·rows·account·found)를 보내고, 여기는 그걸 그린다. 로그인 버튼은 로그인만 한다.
//  · 평상시(설치 끝)와 «고쳐야 할 때»(구 CLI·토큰 거부): 종전 카드들(라이블리 화면·노드·점검·로그).
"use strict";

const $ = (id) => document.getElementById(id);
const show = (el, on) => el.classList.toggle("hidden", !on);
let state = {}, setup = {}, prompt = null, progress = null;
// 화면 안에서만 움직이는 자리 — 메인에 묻지 않는다(시작 ↔ 회사 서버 주소, 완료 화면을 닫음).
let localScreen = null;          // "server" | null
let doneDismissed = false;       // 완료·일부 실패 화면을 닫고 평상시로 갔나
// 고른 AI 도구 — 처음 그릴 때 «찾음» 을 모두 체크한다. 다시 찾기로 새로 찾은 도구도 체크에 더한다.
const picked = new Set();
const seenFound = new Set();
// 이미 답한 프롬프트 id — **다시 그리지 않는다**(답한 카드가 경쟁으로 되살아나는 걸 막는다). 새 실행이 시작되면 비운다.
const answeredPrompts = new Set();

const TOOLS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex", big: true },
  { id: "antigravity", label: "Antigravity" },
  { id: "cursor", label: "Cursor" },
  { id: "grok", label: "Grok Build" },
  { id: "opencode", label: "OpenCode" },
];

// ── 어느 화면인가 ────────────────────────────────────────────────────────────
// 판단 재료는 메인이 준다(state.ready · setup.screen). 여기선 그 둘을 화면 이름 하나로 접는다.
function currentScreen() {
  const needsFix = state.cliOutdated || state.cliBroken || state.tokenRejected;
  const v = setup.screen;
  if (v === "running") return "running";
  if ((v === "done" || v === "partial") && !doneDismissed) return v;
  if (v === "wait" || v === "setup") return v;
  if (state.ready) return "home";
  if (needsFix || state.busy) return "home";       // 고쳐야 할 때·종전 흐름 진행은 평상시 카드 자리에서
  if (localScreen === "server" || v === "server") return "server";
  return "start";
}

function render() {
  const scr = currentScreen();
  for (const id of ["start", "server", "wait", "setup", "running", "done", "partial", "home"]) show($("scr-" + id), scr === id);
  renderSide(scr);
  if (scr === "start") renderStart();
  if (scr === "server") $("gw-err").textContent = setup.screen === "server" ? (setup.error || "") : $("gw-err").textContent;
  if (scr === "wait") $("wait-code").textContent = setup.code || "";
  if (scr === "setup") renderSetup();
  if (scr === "running") renderRows($("run-rows"), setup.rows, true);
  if (scr === "partial") renderRows($("partial-rows"), setup.rows, false);
  if (scr === "done") renderDone();
  if (scr === "home") renderHome();
}

function renderSide(scr) {
  const step = { start: 1, server: 1, wait: 1, setup: 2, running: 2, partial: 2, done: 3, home: 4 }[scr] || 1;
  for (const li of $("vsteps").children) {
    const n = Number(li.dataset.step);
    li.className = n < step ? "done" : n === step ? "on" : "";
  }
  const acc = setup.account;
  const email = acc?.email || acc?.name || (state.ready ? "" : "");
  const ws = acc?.workspace || (state.gatewayUrl ? hostOf(state.gatewayUrl) : "");
  show($("acct"), !!(acc || state.ready));
  $("acct-email").textContent = email || ws || "";
  $("acct-ws").textContent = email ? ws : "";
  $("acct-av").textContent = (email || ws || "L").trim().charAt(0).toUpperCase();
  // 설정을 시작하기 전까지만 계정을 바꿀 수 있다 — 설정 중에 바꾸면 반쯤 깔린 채 남는다.
  show($("notme"), !!acc && (scr === "setup" || scr === "wait"));
  $("ver").textContent = `앱 ${state.appVersion || "알 수 없음"} · ${state.kitVersion ? "키트 " + state.kitVersion : "키트 없음"}`;
  $("upd-note").textContent = state.updateNote || "";
  show($("apply-update"), !!state.updateReady);
  $("apply-update").disabled = !!state.busy;
}
const hostOf = (u) => { try { return new URL(u).host; } catch { return u || ""; } };

function renderStart() {
  $("start-err").textContent = setup.screen === "start" ? (setup.error || "") : $("start-err").textContent;
  $("go-cloud").disabled = !!state.busy;
  $("go-server").disabled = !!state.busy;
}

function renderSetup() {
  const found = new Set(setup.found || []);
  for (const id of found) if (!seenFound.has(id)) { seenFound.add(id); picked.add(id); }
  $("tools-desc").textContent = found.size
    ? "연결할 AI 도구를 고르세요. 설치되지 않은 도구를 고르면 설치한 뒤 연결합니다."
    : "AI 도구를 찾지 못했습니다. 고른 도구는 설치한 뒤 연결합니다.";
  $("tools").replaceChildren(...TOOLS.map((t) => {
    const on = picked.has(t.id), has = found.has(t.id);
    const el = document.createElement("label");
    el.className = "tc " + (on ? "on" : has ? "" : "off");
    const logo = document.createElement("span"); logo.className = "hlogo" + (t.big ? " big" : "");
    const img = document.createElement("img"); img.src = `logos/${t.id}.svg`; img.alt = ""; logo.append(img);
    const tn = document.createElement("span"); tn.className = "tn";
    const b = document.createElement("b"); b.textContent = t.label;
    const st = document.createElement("span");
    if (has) { st.className = "ts ok"; st.append(document.createElement("i"), "찾음"); }
    else if (on) { st.className = "ts pk"; st.textContent = "설치 후 연결"; }
    else { st.className = "ts no"; st.textContent = "설치 안 됨"; }
    tn.append(b, st);
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = on;
    cb.addEventListener("change", () => { if (cb.checked) picked.add(t.id); else picked.delete(t.id); $("setup-err").textContent = ""; renderSetup(); });
    el.append(logo, tn, cb);
    return el;
  }));
  $("wr-path").textContent = setup.workRoot || "~/workspace";
  $("wr-path").title = setup.workRoot || "";
  show($("node-note"), setup.platform === "darwin" && $("opt-node").checked);
  $("setup-go").disabled = !!state.busy || picked.size === 0;
  $("setup-err").textContent = picked.size === 0 ? "AI 도구를 하나 이상 고르세요." : ($("setup-err").dataset.msg || "");
}

const ROW_ICON = { done: "✓", fail: "!", run: "", wait: "" };
function renderRows(box, rows, withBar) {
  const list = rows || [];
  box.replaceChildren(...list.map((r) => {
    const el = document.createElement("div"); el.className = "st " + (r.status || "wait");
    const ic = document.createElement("span"); ic.className = "ic"; ic.textContent = ROW_ICON[r.status] || "";
    const sx = document.createElement("span"); sx.className = "sx"; sx.textContent = r.label;
    if (r.status === "fail" && (r.reason || r.docs)) {
      const why = document.createElement("span"); why.className = "why"; why.textContent = r.reason || "";
      if (r.docs) {
        const a = document.createElement("button"); a.className = "linkbtn"; a.textContent = " 공식 설치 안내 열기";
        a.addEventListener("click", () => window.lively.openExternal(r.docs));
        why.append(a);
      }
      sx.append(why);
    }
    el.append(ic, sx);
    return el;
  }));
  if (withBar) {
    const doneN = list.filter((r) => r.status === "done" || r.status === "fail").length;
    $("run-bar").style.width = list.length ? Math.round((doneN / list.length) * 100) + "%" : "0%";
  }
}

function renderDone() {
  const items = [...(setup.installed || [])];
  if ((setup.rows || []).some((r) => r.id === "node" && r.status === "done")) items.push("웹에서 이 컴퓨터 쓰기");
  $("done-chips").replaceChildren(...items.map((t) => { const c = document.createElement("span"); c.className = "chip"; c.textContent = t; return c; }));
}

// ── 평상시 · 고쳐야 할 때 ────────────────────────────────────────────────────
function renderHome() {
  const s = state;
  const label = !s.cliFound ? "라이블리 명령어가 없습니다"
    : s.cliOutdated ? "라이블리 명령어 업데이트가 필요합니다"
      : s.cliBroken ? "라이블리 명령어를 실행할 수 없습니다"
        : !s.loggedIn ? "로그인이 필요합니다"
          : s.tokenRejected ? "로그인이 만료되었습니다. 다시 로그인하세요."
            : !s.kitInstalled ? "설치가 끝나지 않았습니다"
              : s.nodeState === "running" ? "웹에서 이 컴퓨터를 쓸 수 있습니다"
                : s.nodeState === "zombie" ? "웹 연결이 끊겼습니다"
                  : s.nodeState === "unknown" ? "연결 상태를 확인하는 중입니다"
                    : "설치를 마쳤습니다";
  $("status").textContent = state.busy && !s.ready ? "진행 중입니다" : label;
  $("sub").textContent = s.gatewayUrl || "";
  const ready = !!s?.ready;
  const needsFix = s.cliOutdated || s.cliBroken || s.tokenRejected;
  show($("gw-card"), !ready && !s.busy && !!needsFix);
  const gwIn = $("gw-fix");
  if (needsFix && s.gatewayUrl && !gwIn.value && document.activeElement !== gwIn) { gwIn.value = s.gatewayUrl; void previewFix(); }
  $("gw-title").textContent = s.cliBroken ? "라이블리 명령어 다시 설치" : s.cliOutdated ? "라이블리 명령어 업데이트" : s.tokenRejected ? "다시 로그인" : "워크스페이스 주소";
  // 실패 이유를 그대로 보여 준다 — 원문이 있어야 제보가 진단이 된다.
  $("gw-fix-hint").textContent = s.cliBroken
    ? `설치된 명령어를 실행할 수 없습니다. (${s.cliBroken}) 아래 주소에서 다시 받아 이어서 진행합니다.`
    : s.cliOutdated
      ? "설치된 명령어가 이 앱보다 오래돼 진행 상황을 읽지 못합니다. 아래 주소에서 최신으로 받아 이어서 진행합니다."
      : s.tokenRejected
        ? "서버가 이 컴퓨터의 로그인을 거부했습니다. 만료되었거나 회수되었습니다. 다시 로그인하면 이어서 진행합니다."
        : "";
  $("gw-fix-go").textContent = s.cliBroken ? "다시 설치" : s.cliOutdated ? "업데이트" : "다시 로그인";
  $("gw-fix-go").disabled = !!s.busy;
  show($("app-card"), ready);
  $("app-note").textContent = s?.webError || "웹과 같은 화면을 이 앱 안에서 씁니다.";
  $("app-note").classList.toggle("err", !!s?.webError);
  $("app-open").textContent = s?.webError ? "다시 시도" : "라이블리 열기";
  $("app-open").disabled = !!s.busy;
  show($("node-card"), ready);
  show($("tools-card"), ready);
  show($("stale-card"), !!s.staleInstall);
  $("stale-note").textContent = s.staleInstall || "";
  $("stale-clean").disabled = !!s.busy;
  for (const id of ["doctor", "kit-update", "logout"]) $(id).disabled = !!s.busy;
  // 노드 상태 문구 — 판정은 메인 한 자리(state.nodeState, #2215). 모를 때는 버튼을 잠그지 않는다.
  const ns = s.nodeState, zombie = ns === "zombie", running = ns === "running", stopped = ns === "stopped";
  $("node-state").textContent = ns === "unregistered" ? "아직 켜지 않았습니다."
    : zombie ? "실행 중이지만 서버에 연결돼 있지 않습니다. 다시 켜세요."
      : running ? `켜져 있습니다${s.nodeDaemon ? " · 컴퓨터를 켜면 자동으로 시작" : ""}`
        : ns === "unknown" ? "실행 여부를 확인하지 못했습니다."
          : "꺼져 있습니다.";
  const sleepEl = $("node-sleep");
  sleepEl.textContent = s.nodeSleepNote || "";
  sleepEl.classList.toggle("hidden", !s.nodeSleepNote);
  $("node-start").textContent = zombie ? "다시 켜기" : "켜기";
  $("node-start").disabled = !!s.busy || (running && !zombie);
  $("node-stop").disabled = !!s.busy || stopped || !s.nodeRegistered;
  const al = $("app-autolaunch");
  al.closest("label").classList.toggle("hidden", s.appAutoLaunch === null || s.appAutoLaunch === undefined);
  al.checked = !!s.appAutoLaunch; al.disabled = !!s.busy;
  renderProgress(progress);
}

// 종전 흐름의 진행(노드·진단·고쳐야 할 때·구 게이트웨이) — 평상시 카드 자리에 그린다.
function renderProgress(p) {
  show($("progress-card"), !!p && (!p.done || p.ok === false) && setup.screen !== "running");
  // null = 새 실행의 시작 — 지난 실행의 질문·답 기억을 치운다(D6b).
  if (!p) { answeredPrompts.clear(); return; }
  $("progress-title").textContent = p.done ? (p.ok ? "완료" : "실패했습니다") : "진행 중";
  const pct = Number.isFinite(p.i) && Number.isFinite(p.n) && p.n > 0 ? Math.round((p.i / p.n) * 100) : null;
  $("bar-fill").style.width = pct === null ? "0%" : pct + "%";
  $("bar-fill").classList.toggle("indeterminate", pct === null && !p.done);
  const failed = !!(p.done && p.ok === false);
  show($("retry"), failed && !!state.retryable);
  show($("cancel"), !p.done);
  $("steps").replaceChildren(...(p.steps || []).map((st) => {
    const li = document.createElement("li");
    li.className = "step " + st.status;
    li.textContent = (st.status === "done" ? "✓ " : st.status === "fail" ? "✗ " : "· ") + st.label;
    return li;
  }));
}

function renderPrompt(p) {
  if (p && answeredPrompts.has(p.id)) p = null;
  prompt = p || null;
  show($("prompt-card"), !!p);
  if (!p) { show($("prompt-device"), false); show($("prompt-confirm"), false); return; }
  $("prompt-label").textContent = p.label || (p.kind === "device-code" ? "브라우저에서 승인하세요" : "확인이 필요합니다");
  show($("prompt-device"), p.kind === "device-code");
  show($("prompt-confirm"), p.kind === "confirm");
  if (p.kind === "device-code") {
    $("device-code").textContent = p.user_code || "";
    const url = p.verification_uri_complete || p.verification_uri || "";
    $("device-link").textContent = url;
    $("device-link").dataset.url = url;
  }
}

function log(line) {
  for (const id of ["log", "run-log"]) {
    const el = $(id);
    el.textContent += line + "\n";
    el.scrollTop = el.scrollHeight;
  }
}

// ── 배선: 새 시작 흐름 ───────────────────────────────────────────────────────
async function call(p, errEl) {
  if (errEl) errEl.textContent = "";
  const r = await p;
  if (r && !r.ok && r.error) { if (errEl) errEl.textContent = r.error; log("✗ " + r.error); }
  return r;
}
$("go-cloud").addEventListener("click", () => { localScreen = null; void call(window.lively.loginStart("cloud"), $("start-err")); });
$("go-server").addEventListener("click", () => { localScreen = "server"; $("gw-err").textContent = ""; render(); $("gw").focus(); });
$("server-back").addEventListener("click", () => { localScreen = null; setup = { ...setup, screen: null, error: null }; render(); });
// 입력 중 되비추기(#2044) — 정규화·판정은 메인이 한다. 오류는 막지 않고 알려 준다.
let previewSeq = 0;
$("gw").addEventListener("input", async () => {
  const seq = ++previewSeq;
  const a = await window.lively.gatewayAdvice($("gw").value);
  if (seq === previewSeq) $("gw-err").textContent = a?.error || "";
});
$("gw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("gw-go").click(); });
$("gw-go").addEventListener("click", () => { void call(window.lively.loginStart("gateway", $("gw").value.trim()), $("gw-err")); });
$("wait-cancel").addEventListener("click", () => window.lively.loginCancel());
$("wait-reopen").addEventListener("click", () => window.lively.loginReopen());
$("notme").addEventListener("click", () => { picked.clear(); seenFound.clear(); localScreen = null; void window.lively.loginReset(); });
$("redetect").addEventListener("click", () => window.lively.redetect());
$("wr-pick").addEventListener("click", (e) => { e.preventDefault(); void window.lively.pickFolder(); });
$("opt-node").addEventListener("change", () => renderSetup());
$("setup-go").addEventListener("click", async () => {
  $("setup-err").dataset.msg = "";
  doneDismissed = false;
  const r = await window.lively.applySetup({ harnesses: TOOLS.map((t) => t.id).filter((id) => picked.has(id)), workRoot: $("opt-workroot").checked, node: $("opt-node").checked });
  if (r && !r.ok && r.error && setup.screen === "setup") { $("setup-err").dataset.msg = r.error; renderSetup(); }
});
$("setup-skip").addEventListener("click", () => { void call(window.lively.skipSetup(), $("setup-err")); });
$("run-detail").addEventListener("click", () => { const el = $("run-log"); show(el, el.classList.contains("hidden")); });
$("run-cancel").addEventListener("click", () => window.lively.cancel());
$("partial-retry").addEventListener("click", () => { doneDismissed = false; void window.lively.applySetup({ retry: true }); });
$("partial-skip").addEventListener("click", () => { doneDismissed = true; render(); if (state.ready) void openApp(); });
const openApp = async () => { const r = await window.lively.openApp(); if (r?.error) { $("app-note").textContent = r.error; log("✗ " + r.error); } };
$("done-open").addEventListener("click", () => { doneDismissed = true; render(); void openApp(); });
// «온보딩 도와줘» 복사(#1879). 클립보드가 막히면 글자를 선택해 준다 — 조용히 실패하면 복사된 줄 안다.
$("onboard-say").addEventListener("click", async () => {
  const el = $("onboard-say"), note = $("onboard-copied");
  try { await navigator.clipboard.writeText(el.textContent.trim()); note.textContent = "복사했습니다"; setTimeout(() => { note.textContent = "누르면 복사됩니다"; }, 1800); }
  catch { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
});

// ── 배선: 평상시 · 고쳐야 할 때 ───────────────────────────────────────────────
let previewFixSeq = 0;
const previewFix = async () => {
  const seq = ++previewFixSeq;
  const a = await window.lively.gatewayAdvice($("gw-fix").value);
  if (seq !== previewFixSeq) return;
  $("gw-fix-preview").textContent = a?.cmd ? a.cmd + "  → 이어서 로그인·설치" : "";
  $("gw-fix-err").textContent = a?.error || "";
};
$("gw-fix").addEventListener("input", () => { $("gw-fix-err").textContent = ""; void previewFix(); });
$("gw-fix").addEventListener("keydown", (e) => { if (e.key === "Enter") $("gw-fix-go").click(); });
$("gw-fix-go").addEventListener("click", () => { void call(window.lively.setGateway($("gw-fix").value.trim()), $("gw-fix-err")); });
$("app-open").addEventListener("click", openApp);
$("app-web").addEventListener("click", () => { if (state.gatewayUrl) window.lively.openExternal(state.gatewayUrl); });
$("cancel").addEventListener("click", () => window.lively.cancel());
const answer = (v) => { if (!prompt) return; answeredPrompts.add(prompt.id); window.lively.answer(prompt.id, v); renderPrompt(null); };
$("prompt-yes").addEventListener("click", () => answer(true));
$("prompt-no").addEventListener("click", () => answer(false));
$("device-link").addEventListener("click", (e) => { const u = e.currentTarget.dataset.url; if (u) window.lively.openExternal(u); });
$("node-start").addEventListener("click", () => void call(window.lively.run("node-start")));
$("node-stop").addEventListener("click", () => void call(window.lively.run("node-stop")));
$("app-autolaunch").addEventListener("change", (e) => window.lively.setAppAutoLaunch(e.target.checked));
$("retry").addEventListener("click", () => void call(window.lively.retry()));
$("doctor").addEventListener("click", () => void call(window.lively.run("doctor")));
$("kit-update").addEventListener("click", () => void call(window.lively.run("update")));
// 로그아웃은 되돌리기 어렵다(토큰이 지워지고 다시 로그인해야 한다) — 한 번 묻는다.
$("logout").addEventListener("click", async () => {
  if (!window.confirm("로그아웃하면 이 컴퓨터의 로그인 정보가 지워지고 다시 로그인해야 합니다.\n웹에서 이 컴퓨터 쓰기는 계속 켜져 있습니다.\n\n계속할까요?")) return;
  doneDismissed = false; picked.clear(); seenFound.clear();
  void call(window.lively.run("logout"));
});
$("stale-clean").addEventListener("click", async () => {
  $("stale-clean").disabled = true;
  const r = await window.lively.cleanupStale();
  if (r?.error) { log("✗ " + r.error); $("stale-clean").disabled = false; }
  else log("이전 버전을 제거합니다. 관리자 확인 창이 뜨면 «예»를 누르세요. 끝나면 앱이 다시 열립니다.");
});
$("apply-update").addEventListener("click", async () => {
  $("apply-update").disabled = true;
  $("upd-note").textContent = "앱을 다시 시작해서 적용합니다.";
  const r = await window.lively.applyUpdate();
  if (r?.error) { $("upd-note").textContent = r.error; $("apply-update").disabled = false; }
});
$("check-update").addEventListener("click", async () => {
  // 문구는 상태(state.updateNote)가 주도한다 — IPC 응답으로 덮으면 그 사이 도착한 진행률 문구를 옛 문구로 덮는다.
  const btn = $("check-update");
  btn.disabled = true; const label = btn.textContent; btn.textContent = "확인 중";
  try { const r = await window.lively.checkUpdate(); if (r?.error) $("upd-note").textContent = r.error; }
  finally { btn.disabled = false; btn.textContent = label; }
});

// ── 로그 두 축 ── '이번 작업'(CLI 가 지금 뱉는 것)과 '노드 로그'(파일)는 다른 축이다.
function setLogTab(tab) {
  $("tab-run").classList.toggle("on", tab === "run");
  $("tab-file").classList.toggle("on", tab === "file");
  show($("log"), tab === "run");
  show($("filelog"), tab === "file");
  show($("log-reload"), tab === "file");
  if (tab === "file") void loadFileLog(); else $("filelog-note").textContent = "";
}
async function loadFileLog() {
  $("filelog").textContent = "읽는 중";
  const r = await window.lively.readLog("node");
  if (!r?.ok) { $("filelog").textContent = ""; $("filelog-note").textContent = r?.error || "읽지 못했습니다."; return; }
  if (r.missing) { $("filelog").textContent = ""; $("filelog-note").textContent = "아직 로그가 없습니다. 웹에서 이 컴퓨터 쓰기를 한 번도 켜지 않았습니다."; return; }
  $("filelog").textContent = r.text || "(비어 있음)";
  $("filelog-note").textContent = r.truncated ? `마지막 ${r.lines}줄만 표시했습니다 · ${r.path}` : r.path;
  $("filelog").scrollTop = $("filelog").scrollHeight;
}
$("tab-run").addEventListener("click", () => setLogTab("run"));
$("tab-file").addEventListener("click", () => setLogTab("file"));
$("log-reload").addEventListener("click", () => void loadFileLog());

// frameless(#1541): macOS 신호등이 왼쪽 칸 위에 얹힌다 — CSS 가 여백으로 비키게 몸통에 표식을 단다.
if (/Mac/.test(navigator.platform || "")) document.body.classList.add("mac");
window.lively.onState((s) => { state = s || {}; render(); });
window.lively.onSetup((v) => { setup = v || {}; if (setup.screen) localScreen = null; render(); });
window.lively.onProgress((p) => {
  progress = p; renderProgress(p); renderPrompt(p?.prompt); render();
});
window.lively.onLog((l) => log(l.line));
window.lively.getState().then(({ state: s, progress: p, setup: v }) => { state = s || {}; setup = v || {}; progress = p; render(); renderPrompt(p?.prompt); });
