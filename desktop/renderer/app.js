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
          // 토큰은 있는데 게이트웨이가 거부했다(만료·회수) — 웹 창이 401 을 만나면 메인이 이 축을 세운다(web-shell).
          : s.tokenRejected ? "로그인이 만료되었습니다 — 다시 로그인하세요"
            : !s.kitInstalled ? "키트 설치가 필요합니다"
              : s.nodeRunning ? "노드 실행 중" : s.nodeRegistered ? "노드 정지됨" : "설치 완료";
  $("status").textContent = label;
  $("sub").textContent = s?.gatewayUrl || "";
  $("dot").className = "dot " + (s?.nodeRunning ? "on" : s?.loggedIn ? "warn" : "off");
  // 설치가 끝났나 — 이 한 줄이 마법사와 평상시 화면을 가른다.
  // ⚠ 판정은 **메인이 한다**(web-shell.appReady → state.ready). 렌더러가 식을 따로 적으면 한 축(계약 지원·토큰 거부)이
  //  빠진 채 '설치 완료' 화면이 뜨고 버튼은 조용히 아무 일도 안 한다(실측: 구 CLI 인 PC 가 그랬다).
  const ready = !!s?.ready;
  // 아직 안 끝났을 때만 묻는다 — 다 됐는데 또 물으면 사용자가 '뭘 잘못했나' 한다.
  //  두 카드는 **배타**다(#2044): 처음이면 시작 카드(클라우드 우선), 고쳐야 할 때(구 CLI·재로그인)는
  //  주소 카드. 고칠 땐 주소를 **이미 알고 있으므로** 클라우드 선택지를 다시 보여줄 이유가 없다.
  const needsFix = s?.cliOutdated || s?.cliBroken || s?.tokenRejected;
  show($("start-card"), !ready && !s?.busy && !needsFix);
  show($("gw-card"), !ready && !s?.busy && !!needsFix);
  // 업데이트·재로그인이 필요한 경우엔 **주소를 이미 안다** — 다시 치게 하지 않고 채워 두고, 무엇을 할지 문구로 바꾼다.
  //  (사람이 편집 중이면 건드리지 않는다 — 입력을 덮어쓰는 화면만큼 짜증나는 게 없다.)
  const gwIn = $("gw-fix");
  if (needsFix && s?.gatewayUrl && !gwIn.value && document.activeElement !== gwIn) { gwIn.value = s.gatewayUrl; void previewFix(); }
  $("gw-title").textContent = s?.cliBroken ? "라이블리 CLI 다시 설치" : s?.cliOutdated ? "라이블리 CLI 업데이트" : s?.tokenRejected ? "다시 로그인" : "워크스페이스 주소";
  // 실패 이유를 그대로 보여준다 — 'spawn EINVAL' 같은 원문이 있어야 제보가 진단이 된다(숨기면 우리도 모른다).
  $("gw-fix-hint").textContent = s?.cliBroken
    ? `설치된 CLI 를 실행할 수 없습니다(${s.cliBroken}). 아래 주소에서 다시 받아 이어서 진행합니다.`
    : s?.cliOutdated
      ? "설치된 CLI 가 이 앱보다 오래돼 앱이 진행 상황을 읽지 못합니다. 아래 주소에서 최신으로 받아 이어서 진행합니다."
      : s?.tokenRejected
        ? "게이트웨이가 이 PC 의 로그인 토큰을 거부했습니다(만료 또는 회수). 다시 로그인하면 이어서 진행합니다."
        : "";
  $("gw-fix-go").textContent = s?.cliBroken ? "다시 설치" : s?.cliOutdated ? "업데이트" : "다시 로그인";
  show($("done-card"), ready && !s?.busy && justFinished);
  // 라이블리 화면(웹 UI 창) — 갖춰졌을 때만 열 수 있다. 못 실은 사유(webError)가 있으면 그대로 적는다(메인이 준다).
  show($("app-card"), ready && !justFinished);
  $("app-note").textContent = s?.webError || "웹과 같은 화면을 이 앱 안에서 씁니다 — 세션·프로젝트·WIKI 전부.";
  $("app-note").classList.toggle("err", !!s?.webError);
  $("app-open").textContent = s?.webError ? "다시 시도" : "라이블리 열기";
  $("app-open").disabled = !!s?.busy;
  show($("node-card"), ready);
  show($("tools-card"), ready);
  show($("stale-card"), !!s?.staleInstall);
  $("stale-note").textContent = s?.staleInstall || "";
  $("stale-clean").disabled = !!s?.busy;
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
  // 프로세스는 도는데 게이트웨이엔 안 붙어 있음(절전 뒤 좀비 — 실측 3시간·나흘). '실행 중' 이라 그리면 거짓말이라 따로 말한다.
  const zombie = running && s?.nodeConnected === false;
  $("node-state").textContent = !s?.nodeRegistered ? "아직 이 PC 는 노드로 등록되지 않았습니다."
    : s?.nodeRunning === null ? `노드 ${s?.nodeId || ""} — 실행 여부를 확인하지 못했습니다.`
      : zombie ? `노드 ${s?.nodeId || ""} — 프로세스는 돌지만 게이트웨이에 연결돼 있지 않습니다. 다시 시작하세요.`
        : running ? `노드 ${s?.nodeId || ""} 실행 중${s?.nodeDaemon ? " · PC 켤 때 자동 시작" : " · 이 세션만"}`
          : `노드 ${s?.nodeId || ""} 정지됨`;
  // #1849 — 잠자기로 추정되면 원인·조치를 그대로 띄운다(서버가 만든 문구). 재시작 버튼만 있으면
  //  사용자는 자는 PC 를 계속 재시작하게 된다 — 그건 고쳐지지 않는다.
  const sleepEl = $("node-sleep");
  if (sleepEl) {
    sleepEl.textContent = s?.nodeSleepNote || "";
    sleepEl.classList.toggle("hidden", !s?.nodeSleepNote);
  }
  $("node-start").textContent = zombie ? "노드 다시 시작" : "노드 시작";
  $("node-start").disabled = !!s?.busy || (running && !zombie);
  $("node-stop").disabled = !!s?.busy || stopped || !s?.nodeRegistered;
  const al = $("app-autolaunch");
  al.closest("label").classList.toggle("hidden", s?.appAutoLaunch === null || s?.appAutoLaunch === undefined);
  al.checked = !!s?.appAutoLaunch; al.disabled = !!s?.busy;
  $("gw-go").disabled = !!s?.busy;
  $("gw-fix-go").disabled = !!s?.busy;
  $("cloud-go").disabled = !!s?.busy;
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
//  ⚠ 정규화·판정을 여기서 다시 적지 않는다(#2044) — 메인이 정본이고 렌더러는 받은 문자열을 그린다.
//  종전엔 이 함수가 자기 정규식으로 판정해서, 스킴 없이 친 주소는 미리보기가 **아무 말도 안 하다가**
//  [연결]에서야 "형식이 올바르지 않습니다" 로 튕겼다(같은 값에 두 판정 = 사람이 원인을 못 찾는다).
let previewSeq = 0;
const preview = async () => {
  const seq = ++previewSeq;
  const a = await window.lively.gatewayAdvice($("gw").value);
  if (seq !== previewSeq) return;                       // 더 최근 입력이 있다 — 옛 답으로 덮지 않는다
  $("gw-preview").textContent = a?.cmd ? a.cmd + "  → 이어서 로그인·설치" : "";
  // 타이핑 중의 오류는 **막는 게 아니라 알려주는 것**이다 — [연결]을 눌러도 같은 판정이 나온다(메인이 같은 자를 쓴다).
  //  ⚠ 힌트(gw-hint)는 건드리지 않는다 — 그건 상태(구 CLI·재로그인)가 주도하는 자리다(renderState).
  $("gw-err").textContent = a?.error || "";
};
$("gw").addEventListener("input", () => { $("gw-err").textContent = ""; void preview(); });
// 고치기 카드(구 CLI·재로그인)의 주소칸 — 같은 판정을 쓰되 자기 자리에 그린다.
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
$("gw-fix-go").addEventListener("click", async () => {
  $("gw-fix-err").textContent = "";
  const r = await window.lively.setGateway($("gw-fix").value.trim());
  if (!r?.ok && r?.error) { $("gw-fix-err").textContent = r.error; log("✗ " + r.error); }
});
// ★ 클라우드 로그인(#2044) — 주소를 묻지 않는다. 브라우저 승인 한 번으로 워크스페이스·자격이 온다.
$("cloud-go").addEventListener("click", async () => {
  $("start-err").textContent = "";
  const r = await window.lively.run("setup-cloud");
  if (r?.error) { $("start-err").textContent = r.error; log("✗ " + r.error); }
});
$("gw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("gw-go").click(); });
$("gw-go").addEventListener("click", async () => {
  const url = $("gw").value.trim();
  $("gw-err").textContent = "";
  const r = await window.lively.setGateway(url);
  if (!r?.ok && r?.error) { $("gw-err").textContent = r.error; log("✗ " + r.error); }
});
$("done-web").addEventListener("click", () => { if (state?.gatewayUrl) window.lively.openExternal(state.gatewayUrl); });
$("app-web").addEventListener("click", () => { if (state?.gatewayUrl) window.lively.openExternal(state.gatewayUrl); });
// 라이블리 화면 = 웹 UI 창(메인이 연다 — 준비 안 됐으면 사유를 돌려준다). 못 열면 카드에 사유가 남는다.
const openApp = async () => { const r = await window.lively.openApp(); if (r?.error) { $("app-note").textContent = r.error; log("✗ " + r.error); } };
$("app-open").addEventListener("click", openApp);
$("done-open").addEventListener("click", openApp);
/* «온보딩 도와줘» 를 눌러 복사 (#1879). 클립보드가 막힌 자리(권한 거부 등)에서는 **글자를 선택해 준다** —
   조용히 실패하면 사람은 복사가 안 된 줄도 모르고 붙여넣기를 시도한다. */
$("onboard-say").addEventListener("click", async () => {
  const el = $("onboard-say"); const note = $("onboard-copied");
  try {
    await navigator.clipboard.writeText(el.textContent.trim());
    note.hidden = false; setTimeout(() => { note.hidden = true; }, 1800);
  } catch {
    const r = document.createRange(); r.selectNodeContents(el);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  }
});
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
$("stale-clean").addEventListener("click", async () => {
  $("stale-clean").disabled = true;
  const r = await window.lively.cleanupStale();
  if (r?.error) { log("✗ " + r.error); $("stale-clean").disabled = false; }
  else log("이전 버전을 제거합니다 — 관리자 확인 창이 뜨면 '예'를 누르세요. 끝나면 앱이 다시 열립니다.");
});
$("apply-update").addEventListener("click", async () => {
  $("apply-update").disabled = true;
  $("upd-note").textContent = "앱을 다시 시작해서 적용합니다…";
  const r = await window.lively.applyUpdate();
  if (r?.error) { $("upd-note").textContent = r.error; $("apply-update").disabled = false; }
});
$("check-update").addEventListener("click", async () => {
  // 문구는 **상태(state.updateNote)가 주도**한다 — 메인이 확인 중·받는 중(진행률)·준비됨을 순서대로 밀어준다.
  //  종전엔 여기서 IPC 응답의 문구를 다시 써서, 그 사이 도착한 진행률 문구를 옛 문구로 덮었다.
  //  IPC 는 '확인'이 끝나면 돌아온다(다운로드는 뒤에서 계속) — 그동안 버튼만 잠근다.
  const btn = $("check-update");
  btn.disabled = true; const label = btn.textContent; btn.textContent = "확인 중…";
  try { const r = await window.lively.checkUpdate(); if (r?.error) $("upd-note").textContent = r.error; }
  finally { btn.disabled = false; btn.textContent = label; }
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

// frameless(#1541): macOS 신호등이 헤더 왼쪽에 얹힌다 — CSS 가 여백으로 비키게 몸통에 표식을 단다.
if (/Mac/.test(navigator.platform || "")) document.body.classList.add("mac");
window.lively.onState(renderState);
window.lively.onProgress(renderProgress);
window.lively.onLog((l) => log(l.line));
window.lively.getState().then(({ state: s, progress: p }) => { renderState(s); renderProgress(p); });
