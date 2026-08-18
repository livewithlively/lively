// 렌더러 (#1541 T2) — 상태를 그리고 사람의 답을 메인에 넘긴다. **판단은 메인에 있다**(여긴 표시만).
//  window.lively 는 preload 가 노출한 함수 묶음뿐이다(ipcRenderer 원본은 안 넘어온다).
"use strict";

const $ = (id) => document.getElementById(id);
const show = (el, on) => el.classList.toggle("hidden", !on);
let state = null, prompt = null;
// 이번 실행에서 설치를 **방금 마쳤나** — 완료 화면은 그때만 띄운다.
//  앱을 다시 열 때마다 "설치가 끝났습니다" 가 뜨면 그건 안내가 아니라 소음이다.
let justFinished = false;
// 이미 답한 프롬프트 id — **다시 그리지 않는다.**
//  메인도 답을 받으면 progress.prompt 를 비우지만, 그 사이에 다음 step 이벤트가 먼저 도착하면
//  옛 prompt 를 든 진행 상태가 한 번 더 그려진다(실측: 답한 카드가 잠깐 되살아났다). 양쪽에서 막는다.
const answeredPrompts = new Set();

function renderState(s) {
  state = s || {};
  const label = !s?.cliFound ? "라이블리 CLI 없음"
    // '있다'와 '쓸 수 있다'는 다르다 — 구 CLI 는 앱의 이벤트 계약을 몰라 앱이 아무 말도 못 듣는다.
    : s.cliOutdated ? "라이블리 CLI 업데이트가 필요합니다"
      : s.cliBroken ? "라이블리 CLI 를 실행할 수 없습니다"
        : !s.loggedIn ? "로그인이 필요합니다"
          : !s.kitInstalled ? "키트 설치가 필요합니다"
            : s.nodeRunning ? "노드 실행 중" : s.nodeRegistered ? "노드 정지됨" : "설치 완료";
  $("status").textContent = label;
  $("sub").textContent = s?.gatewayUrl || "";
  $("dot").className = "dot " + (s?.nodeRunning ? "on" : s?.loggedIn ? "warn" : "off");
  // 설치가 끝났나 — 이 한 줄이 마법사와 평상시 화면을 가른다.
  // ⚠ ready 에 **계약 지원**을 넣는다. 빠뜨리면 구 CLI 인 PC 에서 '설치 완료' 화면이 뜨는데
  //  버튼은 전부 조용히 아무 일도 안 한다(사람은 앱이 고장났다고 본다).
  const ready = !!(s?.cliFound && !s?.cliOutdated && !s?.cliBroken && s?.loggedIn && s?.kitInstalled);
  // 게이트웨이 카드는 아직 끝나지 않았을 때만 — 다 됐는데 또 물으면 사용자가 '뭘 잘못했나' 한다.
  show($("gw-card"), !ready && !s?.busy);
  // 업데이트가 필요한 경우엔 **주소를 이미 안다** — 다시 치게 하지 않고 채워 두고, 무엇을 할지 문구로 바꾼다.
  //  (사람이 편집 중이면 건드리지 않는다 — 입력을 덮어쓰는 화면만큼 짜증나는 게 없다.)
  const gwIn = $("gw");
  const needsFix = s?.cliOutdated || s?.cliBroken;
  if (needsFix && s?.gatewayUrl && !gwIn.value && document.activeElement !== gwIn) { gwIn.value = s.gatewayUrl; preview(); }
  $("gw-title").textContent = s?.cliBroken ? "라이블리 CLI 다시 설치" : s?.cliOutdated ? "라이블리 CLI 업데이트" : "회사 게이트웨이 주소";
  // 실패 이유를 그대로 보여준다 — 'spawn EINVAL' 같은 원문이 있어야 제보가 진단이 된다(숨기면 우리도 모른다).
  $("gw-hint").textContent = s?.cliBroken
    ? `설치된 CLI 를 실행할 수 없습니다(${s.cliBroken}). 아래 주소에서 다시 받아 이어서 진행합니다.`
    : s?.cliOutdated
      ? "설치된 CLI 가 이 앱보다 오래돼 앱이 진행 상황을 읽지 못합니다. 아래 주소에서 최신으로 받아 이어서 진행합니다."
      : "관리자에게 받은 주소를 넣으면 브라우저로 로그인합니다.";
  $("gw-go").textContent = s?.cliBroken ? "다시 설치" : s?.cliOutdated ? "업데이트" : "연결";
  show($("done-card"), ready && !s?.busy && justFinished);
  show($("node-card"), ready);
  show($("tools-card"), ready);
  // 버전은 늘 보인다 — 제보할 때 가장 먼저 묻는 값이다. 앱과 키트는 갱신 주기가 달라 따로 적는다.
  $("ver").textContent = `앱 ${s?.appVersion || "알 수 없음"} · ${s?.kitVersion ? "키트 " + s.kitVersion : "키트 미설치"}`;
  $("upd-note").textContent = s?.updateNote || "";
  // 받아 둔 업데이트가 있으면 **적용 버튼**을 준다 — 앱이 스스로 닫고·설치하고·다시 뜬다. 종전 "다시 켜면 적용" 은
  //  사람과 설치기를 경쟁시켰다(두 번 재시작·바로가기 오류). 창을 닫아 두면 자동으로도 적용된다.
  show($("apply-update"), !!s?.updateReady);
  $("apply-update").disabled = !!s?.busy;
  for (const id of ["doctor", "kit-update", "logout"]) $(id).disabled = !!s?.busy;
  // 실행 여부를 **모를 때**(측정 실패)는 버튼을 잠그지 않는다 — 모른다고 사용자를 가두면 안 된다.
  const running = s?.nodeRunning === true, stopped = s?.nodeRunning === false;
  $("node-state").textContent = !s?.nodeRegistered ? "아직 이 PC 는 노드로 등록되지 않았습니다."
    : s?.nodeRunning === null ? `노드 ${s?.nodeId || ""} — 실행 여부를 확인하지 못했습니다.`
      : running ? `노드 ${s?.nodeId || ""} 실행 중${s?.nodeDaemon ? " · PC 켤 때 자동 시작" : " · 이 세션만"}`
        : `노드 ${s?.nodeId || ""} 정지됨`;
  $("node-start").disabled = !!s?.busy || running;
  $("node-stop").disabled = !!s?.busy || stopped || !s?.nodeRegistered;
  const al = $("app-autolaunch");
  al.closest("label").classList.toggle("hidden", s?.appAutoLaunch === null || s?.appAutoLaunch === undefined);
  al.checked = !!s?.appAutoLaunch; al.disabled = !!s?.busy;
  $("gw-go").disabled = !!s?.busy;
}

function renderProgress(p) {
  // 실패는 화면에 남긴다 — 성공만 사라지고 실패가 조용히 없어지면 사람은 무슨 일이 났는지 모른다.
  show($("progress-card"), !!p && (!p.done || p.ok === false));
  if (!p) return;
  if (p.done && p.ok) justFinished = true;
  $("progress-title").textContent = p.done ? (p.ok ? "완료" : "실패") : "진행 중";
  // 진행률을 모르면(i/n 없음) 바를 채우지 않는다 — 가짜 퍼센트는 멈춘 것처럼 보인다.
  const pct = Number.isFinite(p.i) && Number.isFinite(p.n) && p.n > 0 ? Math.round((p.i / p.n) * 100) : null;
  $("bar-fill").style.width = pct === null ? "0%" : pct + "%";
  $("bar-fill").classList.toggle("indeterminate", pct === null && !p.done);
  // 실패했을 때만 '다시 시도'. 취소는 도는 동안만 의미가 있다 — 둘을 함께 보여주면 어느 쪽이 유효한지 모른다.
  const failed = !!(p.done && p.ok === false);
  show($("retry"), failed && !!state?.retryable);
  show($("cancel"), !p.done);
  $("steps").replaceChildren(...(p.steps || []).map((st) => {
    const li = document.createElement("li");
    li.className = "step " + st.status;
    li.textContent = (st.status === "done" ? "✓ " : st.status === "fail" ? "✗ " : "· ") + st.label;
    return li;
  }));
  renderPrompt(p.prompt);
}

function renderPrompt(p) {
  if (p && answeredPrompts.has(p.id)) p = null;   // 이미 답했다 — 경쟁으로 되살아난 것
  prompt = p || null;
  show($("prompt-card"), !!p);
  // 안쪽 블록도 함께 접는다 — 안 그러면 다음에 다른 kind 가 와도 옛 블록이 같이 보인다.
  if (!p) { show($("prompt-device"), false); show($("prompt-confirm"), false); return; }
  $("prompt-label").textContent = p.label || (p.kind === "device-code" ? "브라우저에서 승인" : "확인이 필요합니다");
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
  const el = $("log");
  el.textContent += line + "\n";
  el.scrollTop = el.scrollHeight;
}

// ── 배선 ────────────────────────────────────────────────────────────────────
// 무엇을 실행할지 **입력하는 동안** 보여준다(설치는 원격 코드 실행이다 — 숨기지 않는다).
const preview = () => {
  const gw = $("gw").value.trim().replace(/\/+$/, "");
  const win = /win/i.test(navigator.userAgent || "");
  $("gw-preview").textContent = /^https?:\/\/\S+$/i.test(gw)
    ? (win ? `irm ${gw}/cli.ps1 | iex` : `curl -fsSL ${gw}/cli | sh`) + "  → 이어서 로그인·설치"
    : "";
};
$("gw").addEventListener("input", () => { $("gw-err").textContent = ""; preview(); });
$("gw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("gw-go").click(); });
$("gw-go").addEventListener("click", async () => {
  const url = $("gw").value.trim();
  $("gw-err").textContent = "";
  const r = await window.lively.setGateway(url);
  if (!r?.ok && r?.error) { $("gw-err").textContent = r.error; log("✗ " + r.error); }
});
$("done-web").addEventListener("click", () => { if (state?.gatewayUrl) window.lively.openExternal(state.gatewayUrl); });
$("cancel").addEventListener("click", () => window.lively.cancel());
const answer = (v) => { if (!prompt) return; answeredPrompts.add(prompt.id); window.lively.answer(prompt.id, v); renderPrompt(null); };
$("prompt-yes").addEventListener("click", () => answer(true));
$("prompt-no").addEventListener("click", () => answer(false));
$("device-link").addEventListener("click", (e) => { e.preventDefault(); const u = e.target.dataset.url; if (u) window.lively.openExternal(u); });
$("node-start").addEventListener("click", async () => { const r = await window.lively.run("node-start"); if (r?.error) log("✗ " + r.error); });
$("node-stop").addEventListener("click", async () => { const r = await window.lively.run("node-stop"); if (r?.error) log("✗ " + r.error); });
$("app-autolaunch").addEventListener("change", (e) => window.lively.setAppAutoLaunch(e.target.checked));
$("retry").addEventListener("click", async () => { const r = await window.lively.retry(); if (r?.error) log("✗ " + r.error); });
$("doctor").addEventListener("click", async () => { const r = await window.lively.run("doctor"); if (r?.error) log("✗ " + r.error); });
$("kit-update").addEventListener("click", async () => { const r = await window.lively.run("update"); if (r?.error) log("✗ " + r.error); });
// 로그아웃은 되돌리기 어렵다(토큰이 지워지고 다시 로그인해야 한다) — 한 번 묻는다.
//  ⚠ confirm() 은 렌더러를 멈추는 모달이라 진행 중엔 쓰지 않는다. busy 면 버튼 자체가 잠겨 있다.
$("logout").addEventListener("click", async () => {
  if (!window.confirm("로그아웃하면 이 PC 의 토큰이 지워지고 다시 로그인해야 합니다.\n노드는 계속 실행됩니다.\n\n계속할까요?")) return;
  const r = await window.lively.run("logout");
  if (r?.error) log("✗ " + r.error);
});
$("apply-update").addEventListener("click", async () => {
  $("apply-update").disabled = true;
  $("upd-note").textContent = "앱을 다시 시작해서 적용합니다…";
  const r = await window.lively.applyUpdate();
  if (r?.error) { $("upd-note").textContent = r.error; $("apply-update").disabled = false; }
});
$("check-update").addEventListener("click", async () => {
  $("upd-note").textContent = "확인 중…";
  const r = await window.lively.checkUpdate();
  if (r?.note) $("upd-note").textContent = r.note;
});

// ── 로그 두 축 ──────────────────────────────────────────────────────────────
// '이번 작업'(CLI 가 지금 뱉는 것)과 '노드 로그'(파일에 쌓인 것)는 다른 축이다 — 섞으면 원인을 못 가린다.
let logTab = "run";
function setLogTab(tab) {
  logTab = tab;
  $("tab-run").classList.toggle("on", tab === "run");
  $("tab-file").classList.toggle("on", tab === "file");
  show($("log"), tab === "run");
  show($("filelog"), tab === "file");
  show($("log-reload"), tab === "file");
  if (tab === "file") void loadFileLog();
  else $("filelog-note").textContent = "";
}
async function loadFileLog() {
  $("filelog").textContent = "읽는 중…";
  const r = await window.lively.readLog("node");
  if (!r?.ok) { $("filelog").textContent = ""; $("filelog-note").textContent = r?.error || "읽지 못했습니다."; return; }
  // 파일이 아예 없는 것과 비어 있는 것은 다르다 — 사람에게 그 차이를 말한다(노드를 한 번도 안 켰나?).
  if (r.missing) { $("filelog").textContent = ""; $("filelog-note").textContent = "아직 로그가 없습니다(노드를 한 번도 실행하지 않았습니다)."; return; }
  $("filelog").textContent = r.text || "(비어 있음)";
  $("filelog-note").textContent = r.truncated ? `마지막 ${r.lines}줄만 표시했습니다 · ${r.path}` : r.path;
  $("filelog").scrollTop = $("filelog").scrollHeight;
}
$("tab-run").addEventListener("click", () => setLogTab("run"));
$("tab-file").addEventListener("click", () => setLogTab("file"));
$("log-reload").addEventListener("click", () => void loadFileLog());

window.lively.onState(renderState);
window.lively.onProgress(renderProgress);
window.lively.onLog((l) => log(l.line));
window.lively.getState().then(({ state: s, progress: p }) => { renderState(s); renderProgress(p); });
