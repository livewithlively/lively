// admin-collector-presets.ts — [설정 ▸ 수집 방식](#1419 T7). 커스텀 프리셋 정의 화면.
//
//  수집기(맥락 관리 ▸ 수집)가 '무엇을 연결할지 고르는' 자리라면, 여기는 **고를 수 있는 것 자체를 만드는** 자리다.
//  라이블리가 모르는 소스(사내 API·공개 피드·웹훅)를 **코드 배포 없이** 붙인다.
//
//  왜 [맥락 관리]가 아니라 [설정]에 있나: 수집기는 상시 업무(팀이 자기 채널을 붙였다 뗐다 한다)지만,
//  수집 '방식'을 정의하는 건 드물게 한 번 하는 조직 설정이고 admin 권한이다. 게다가 파서는 코드를 쓰는
//  자리라 일상 화면에 두면 위험 반경이 넓어진다.
//
//  화면 설계: 드라이버를 먼저 고르면 그에 맞는 폼만 보인다(HTTP 폼과 RSS 폼은 공통 항목이 거의 없다).
import { api, cardHead, el, toast, uiText } from './core.js';
// ⚠ confirmDialog 는 **정의처(ui-primitives)에서 직접** 가져온다 — admin.ts 배럴을 거치면
//  admin → admin-shell → 이 패널로 순환이 생긴다(셸이 이 패널을 등록하므로). 셸↔패널 순환 절단 규칙과 같은 이유.
import { confirmDialog } from './ui-primitives.js';
import { sectionHead } from './admin-widgets.js';

let editingKey: string | null = null;
let creating = false;

const DRIVER_LABEL: Record<string, string> = {
  http: 'HTTP·REST API', rss: 'RSS · Atom 피드', webhook: '웹훅 수신', clone: '기본 제공 변형',
};
const DRIVER_WHAT: Record<string, string> = {
  http: '사내 API 처럼 우리가 주기적으로 호출해 가져오는 소스입니다. 주소·인증·목록 위치·필드 짝을 정해 주면 됩니다.',
  rss: '블로그·릴리스 노트 같은 공개 피드입니다. 주소만 있으면 됩니다.',
  webhook: '외부가 우리에게 밀어넣는 소스입니다. 저장하면 받을 주소가 생기고, 그 주소를 보내는 쪽에 등록합니다.',
  clone: '기본 제공(슬랙·노션 등)을 복제해 이름·기본값만 바꾼 템플릿입니다. 수집 방식 자체는 같습니다.',
};

export async function collectorPresetEditor(detail: HTMLElement, _data?: unknown): Promise<void> {
  detail.replaceChildren(head(), el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '불러오는 중…' })));
  let d: any;
  try { d = await api('/api/ui/org/collectors'); }
  catch (e) {
    detail.replaceChildren(head(), el('div', { class: 'card' },
      el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + (e as Error).message })));
    return;
  }
  const presets: any[] = d.presets || [];
  const custom = presets.filter((p) => !p.builtin);
  const builtin = presets.filter((p) => p.builtin);
  const collectors: any[] = d.collectors || [];
  const reload = () => { void collectorPresetEditor(detail); };

  const body = el('div', {});
  body.append(el('p', { class: 'admin-hint' },
    ...uiText('라이블리가 기본으로 아는 도구(슬랙·노션 등) 외에, 사내 API·공개 피드·웹훅을 코드 없이 붙일 수 있습니다. 여기서 만든 방식은 [맥락 관리 ▸ 수집]에서 수집기를 만들 때 고를 수 있게 됩니다.')));

  // 기본 제공은 목록만(읽기 전용) — 무엇이 이미 있는지 알아야 중복을 안 만든다.
  const bcard = el('div', { class: 'card' }, cardHead('기본 제공', '코드에 내장된 방식입니다. 수정·삭제할 수 없고, 변형이 필요하면 아래에서 복제하세요.'));
  bcard.append(el('div', { class: 'ctx-cov-row' },
    ...builtin.map((p) => el('span', { class: 'ctx-tag', text: p.label }))));
  body.append(bcard);

  if (!custom.length && !creating) {
    body.append(el('div', { class: 'card ctx-empty' },
      el('p', { class: 'ctx-empty-t', text: '직접 만든 수집 방식이 없습니다' }),
      el('p', { class: 'admin-hint', text: '사내 시스템의 API 나 팀 블로그 피드처럼 기본 제공에 없는 소스를 붙이려면 여기서 방식을 정의하세요.' })));
  }

  for (const p of custom) {
    const used = collectors.filter((c) => c.preset_key === p.key).length;
    body.append(editingKey === p.key ? presetForm(p, builtin, reload) : presetSummary(p, used, reload));
  }

  if (creating) body.append(presetForm(null, builtin, reload));
  else {
    const add = el('button', { class: 'btn btn-primary', text: '+ 수집 방식 만들기' });
    add.addEventListener('click', () => { creating = true; editingKey = null; reload(); });
    body.append(el('div', { class: 'ctx-actions' }, add));
  }
  detail.replaceChildren(head(), body);
}

function head() {
  return sectionHead('수집 방식',
    '기본 제공에 없는 소스를 코드 없이 붙입니다. 여기서 정의한 방식으로 [맥락 관리 ▸ 수집]에서 수집기를 만듭니다.');
}

function presetSummary(p: any, used: number, reload: () => void) {
  const card = el('div', { class: 'card ctx-row' });
  card.append(el('div', { class: 'ctx-row-head' },
    el('span', { class: 'ctx-row-title', text: p.label }),
    el('span', { class: 'ctx-tag', text: DRIVER_LABEL[p.driver] || p.driver }),
    el('span', { class: 'ctx-state' },
      el('span', { class: 'ctxp-dot ' + (p.enabled ? 'ctxp-dot-ok' : 'ctxp-dot-off'), 'aria-hidden': 'true' }),
      el('span', { text: p.enabled ? '사용' : '미사용' })),
    used ? el('span', { class: 'ctx-tag', text: `수집기 ${used}개가 사용 중` }) : null,
    p.parser_script ? el('span', { class: 'ctx-tag', title: '응답을 변환하는 스크립트가 붙어 있습니다', text: '커스텀 파서' }) : null));
  if (p.description) card.append(el('div', { class: 'ctx-row-meta', text: p.description }));

  const acts = el('div', { class: 'ctx-row-acts' });
  const edit = el('button', { class: 'btn btn-ghost btn-sm', text: '설정 열기' });
  edit.addEventListener('click', () => { editingKey = p.key; creating = false; reload(); });
  const del = el('button', { class: 'btn-text btn-text-danger', text: '삭제' });
  del.addEventListener('click', async () => {
    if (used) { toast(`이 방식으로 만든 수집기가 ${used}개 있습니다 — 먼저 정리하세요`, true); return; }
    const ok = await confirmDialog({
      title: `‘${p.label}’ 수집 방식을 삭제할까요?`,
      lines: ['이 방식으로 새 수집기를 만들 수 없게 됩니다.'], confirmText: '삭제', danger: true,
    });
    if (!ok) return;
    try { await api(`/api/ui/org/collector-presets/${p.id}/remove`, { method: 'POST', body: '{}' }); toast('삭제했습니다'); reload(); }
    catch (e) { toast((e as Error).message, true); }
  });
  acts.append(edit, del);
  card.append(acts);
  return card;
}

function presetForm(p: any | null, builtin: any[], reload: () => void) {
  const isNew = !p;
  const card = el('div', { class: 'card ctx-editor' });
  const S = 'width:100%;padding:7px 9px;font:inherit;box-sizing:border-box';
  const F = (label: string, hint: string | null, ctrl: any) => el('div', { class: 'ctx-field' },
    el('div', { class: 'field-label', text: label }),
    hint ? el('p', { class: 'admin-hint ctx-field-hint', text: hint }) : null, ctrl);
  const cfg = (p?.driverConfig ?? {}) as any;
  const map = (cfg.map ?? {}) as any;

  const driverSel = el('select', { style: S, ...(isNew ? {} : { disabled: true }) }) as HTMLSelectElement;
  for (const [k, l] of Object.entries(DRIVER_LABEL)) driverSel.append(el('option', { value: k, text: l }));
  driverSel.value = p?.driver ?? 'http';
  const driverWhat = el('p', { class: 'admin-hint ctx-field-hint', text: DRIVER_WHAT[driverSel.value] });

  const keyIn = el('input', { type: 'text', style: S, value: p?.key ?? '', placeholder: 'intra-notice' }) as HTMLInputElement;
  const labelIn = el('input', { type: 'text', style: S, value: p?.label ?? '', placeholder: '사내 공지 API' }) as HTMLInputElement;
  const descIn = el('input', { type: 'text', style: S, value: p?.description ?? '', placeholder: '목록에 보일 한 줄 설명' }) as HTMLInputElement;
  const enabledChk = el('input', { type: 'checkbox' }) as HTMLInputElement;
  enabledChk.checked = p ? p.enabled !== false : true;

  // ── clone ──
  const baseSel = el('select', { style: S }) as HTMLSelectElement;
  baseSel.append(el('option', { value: '', text: '— 복제할 기본 제공 선택 —' }));
  for (const b of builtin) baseSel.append(el('option', { value: b.key, text: b.label }));
  if (p?.basePreset) baseSel.value = p.basePreset;
  const cloneBox = el('div', {}, F('무엇을 복제할까', '수집 방식은 이 기본 제공과 같고, 이름·설명만 달라집니다.', baseSel));

  // ── HTTP ──
  const urlIn = el('input', { type: 'text', style: S, value: cfg.url ?? '',
    placeholder: 'https://intra.example.com/api/posts?page={page}' }) as HTMLInputElement;
  const authKindSel = el('select', { style: S }) as HTMLSelectElement;
  for (const [v, t] of [['none', '없음'], ['bearer', 'Bearer 토큰'], ['header', '헤더에 토큰'], ['basic', '아이디·비밀번호'], ['query', '주소에 토큰']] as Array<[string, string]>) {
    authKindSel.append(el('option', { value: v, text: t }));
  }
  authKindSel.value = cfg.auth?.kind ?? 'none';
  const authNameIn = el('input', { type: 'text', style: S, value: cfg.auth?.name ?? '', placeholder: 'X-Api-Key (헤더 방식)' }) as HTMLInputElement;
  const pagKindSel = el('select', { style: S }) as HTMLSelectElement;
  for (const [v, t] of [['none', '한 번만 호출'], ['page', '쪽 번호 (?page=1,2,3…)'], ['offset', '건너뛴 개수'], ['cursor', '다음 커서를 응답에서'], ['link', '다음 주소를 응답에서']] as Array<[string, string]>) {
    pagKindSel.append(el('option', { value: v, text: t }));
  }
  pagKindSel.value = cfg.pagination?.kind ?? 'none';
  const pagNextIn = el('input', { type: 'text', style: S, value: cfg.pagination?.nextPath ?? cfg.pagination?.nextUrlPath ?? '',
    placeholder: '$.paging.next' }) as HTMLInputElement;
  const itemsIn = el('input', { type: 'text', style: S, value: cfg.itemsPath ?? '', placeholder: '$.data.items — 비우면 응답 자체가 목록' }) as HTMLInputElement;
  const privChk = el('input', { type: 'checkbox' }) as HTMLInputElement;
  privChk.checked = cfg.allowPrivateNetwork === true;
  const incChk = el('input', { type: 'checkbox' }) as HTMLInputElement;
  incChk.checked = cfg.incremental === true;

  // 필드 매핑 — external_id 는 필수임을 화면이 말한다(비면 항목이 전부 버려진다).
  const mapIn: Record<string, HTMLInputElement> = {};
  const MAP_FIELDS: Array<[string, string, string]> = [
    ['external_id', '고유 id *', '이 소스 안에서 항목을 구분하는 값. 비면 그 항목은 버려집니다 — 사실상 필수입니다.'],
    ['title', '제목', ''], ['body', '본문', ''], ['url', '원문 주소', ''],
    ['occurred_at', '작성 시각', ''], ['updated_at', '수정 시각', ''],
    ['author_name', '작성자 이름', ''], ['author_email', '작성자 이메일', ''],
    ['container_name', '채널·분류 이름', '어느 채널의 글인지 — 나중에 증류·검색에서 맥락으로 쓰입니다.'],
  ];
  const mapRows = el('div', { class: 'ctx-map' });
  for (const [k, label, hint] of MAP_FIELDS) {
    const i = el('input', { type: 'text', style: S, value: map[k] ?? '', placeholder: `$.${k}` }) as HTMLInputElement;
    mapIn[k] = i;
    mapRows.append(el('div', { class: 'ctx-map-row' },
      el('div', { class: 'ctx-map-k' }, el('span', { text: label }),
        hint ? el('span', { class: 'ctx-map-h', text: hint }) : null),
      i));
  }
  const httpBox = el('div', {},
    F('호출 주소', '{page}·{offset}·{cursor} 와 설정값 {config.키} 를 넣을 수 있습니다.', urlIn),
    F('인증 방식', '토큰 값 자체는 여기 적지 않습니다 — 수집기마다 따로 넣습니다(계정이 다를 수 있으니까).', authKindSel),
    F('헤더·파라미터 이름', 'header·query 방식일 때만. 비우면 Authorization / access_token.', authNameIn),
    F('여러 쪽 가져오기', '', pagKindSel),
    F('다음 쪽 위치', 'cursor·link 방식일 때, 응답에서 다음 값을 찾을 경로.', pagNextIn),
    F('목록 위치', '응답에서 항목 배열이 있는 곳. 비우면 응답 전체를 목록으로 봅니다.', itemsIn),
    el('label', { class: 'admin-check' }, incChk,
      ' 바뀐 것만 가져오기 — 주소에 {cursor} 를 넣으면 마지막으로 가져온 시각이 들어갑니다(예: ?since={cursor}).'),
    el('p', { class: 'admin-hint ctx-field-hint' },
      ...uiText('끄면 매번 전체를 다시 읽습니다. 같은 항목은 덮어써지므로 중복은 안 생기지만, 항목이 많으면 낭비입니다. 켜려면 위 짝짓기에서 수정 시각(또는 작성 시각)도 채워야 합니다 — 그 값으로 어디까지 읽었는지 기억합니다.')),
    el('label', { class: 'admin-check' }, privChk,
      ' 사내망 주소 허용 — ⚠ 기본은 사설·내부 주소를 막습니다(실수로 내부 시스템을 긁지 않게). 사내 API 를 붙일 때만 켜세요.'));

  // ── RSS ──
  const rssUrlIn = el('input', { type: 'text', style: S, value: cfg.url ?? '', placeholder: 'https://blog.example.com/feed.xml' }) as HTMLInputElement;
  const rssPrivChk = el('input', { type: 'checkbox' }) as HTMLInputElement;
  rssPrivChk.checked = cfg.allowPrivateNetwork === true;
  const rssBox = el('div', {},
    F('피드 주소', 'RSS 2.0 · Atom 둘 다 됩니다. 제목·본문·작성자·시각은 자동으로 알아냅니다.', rssUrlIn),
    el('label', { class: 'admin-check' }, rssPrivChk, ' 사내망 주소 허용 — 사내 피드일 때만 켜세요.'));

  // ── webhook ──
  const sigKindSel = el('select', { style: S }) as HTMLSelectElement;
  sigKindSel.append(el('option', { value: 'hmac-sha256', text: 'HMAC-SHA256 서명 검증 (권장)' }));
  sigKindSel.append(el('option', { value: 'none', text: '검증 안 함 — 주소를 아는 누구나 보낼 수 있습니다' }));
  sigKindSel.value = cfg.signature?.kind ?? 'hmac-sha256';
  const sigHeaderIn = el('input', { type: 'text', style: S, value: cfg.signature?.header ?? '', placeholder: 'X-Hub-Signature-256' }) as HTMLInputElement;
  const sigPrefixIn = el('input', { type: 'text', style: S, value: cfg.signature?.prefix ?? '', placeholder: 'sha256=' }) as HTMLInputElement;
  const whItemsIn = el('input', { type: 'text', style: S, value: cfg.itemsPath ?? '', placeholder: '$.events — 비우면 본문 전체가 항목 1건' }) as HTMLInputElement;
  const webhookBox = el('div', {},
    el('p', { class: 'admin-hint ctx-field-hint' },
      ...uiText('저장하고 수집기를 만들면 받을 주소가 생깁니다 — [맥락 관리 ▸ 수집]의 그 수집기 설정에서 확인해 보내는 쪽에 등록하세요.')),
    F('서명 검증', '보내는 쪽과 공유 비밀을 나눠 갖고 서명을 확인합니다. 끄면 주소만 알면 누구나 우리 저장소에 넣을 수 있습니다.', sigKindSel),
    F('서명 헤더 이름', '보내는 쪽 문서에 적혀 있습니다.', sigHeaderIn),
    F('서명 접두어', 'sha256= 처럼 값 앞에 붙는 것이 있으면 적으세요.', sigPrefixIn),
    F('목록 위치', '한 번에 여러 건이 오면 그 배열의 경로. 비우면 본문 전체가 한 건입니다.', whItemsIn));

  // 매핑 표는 http·webhook 공용이다 — **노드는 하나**고 자리만 옮긴다(같은 표를 두 벌 만들면 입력이 갈린다).
  const mapHint = el('p', { class: 'admin-hint ctx-field-hint' });
  const mapHost = el('div', { class: 'ctx-field' },
    el('div', { class: 'field-label', text: '가져온 값을 우리 항목에 짝짓기' }), mapHint, mapRows);

  // ── 커스텀 파서 ──
  const parserIn = el('textarea', { style: S + ';min-height:150px;resize:vertical;font-family:ui-monospace,monospace;font-size:12.5px',
    placeholder: '// 예: 목록을 걸러 내거나 합치기\\nfunction parse(input) {\\n  return input.filter(x => x.type === "notice");\\n}' }) as HTMLTextAreaElement;
  parserIn.value = p?.parserScript ?? '';
  const parserBox = el('details', { class: 'ctx-guide', ...(p?.parserScript ? { open: '' } : {}) },
    el('summary', { text: '커스텀 파서 (선택) — 짝짓기만으로 안 될 때' }));
  parserBox.append(
    el('p', { class: 'admin-hint' },
      ...uiText('응답을 우리 항목으로 바꾸는 코드를 직접 씁니다. 한 응답에 종류가 섞여 있어 갈라야 하거나, 본문이 조각나 있어 합쳐야 할 때 씁니다. parse(input) 함수를 정의하면 그 반환값이 항목 목록이 됩니다.')),
    el('p', { class: 'ctx-danger-note' },
      ...uiText('⚠ 이 코드는 서버에서 실행됩니다. 파일·다른 프로그램 접근은 막혀 있고 10초 안에 끝나야 하지만, 네트워크는 막지 못합니다 — 받은 데이터를 밖으로 보낼 수 있다는 뜻입니다. 신뢰하는 코드만 넣으세요.')),
    parserIn);

  const boxes: Record<string, HTMLElement> = { http: httpBox, rss: rssBox, webhook: webhookBox, clone: cloneBox };
  const syncDriver = () => {
    driverWhat.textContent = DRIVER_WHAT[driverSel.value];
    for (const [k, box] of Object.entries(boxes)) box.hidden = k !== driverSel.value;
    // 매핑·파서는 http·webhook 에서만 의미가 있다(rss 는 규격이 정해져 있고, clone 은 원본 방식을 그대로 쓴다).
    const needsMap = driverSel.value === 'http' || driverSel.value === 'webhook';
    mapHost.hidden = !needsMap;
    mapHint.textContent = driverSel.value === 'webhook'
      ? '받은 본문의 어느 값이 제목·본문·작성자인지 경로로 적습니다.'
      : '응답의 어느 값이 제목·본문·작성자인지 경로로 적습니다. 예: $.data[0].title · $.author.email';
    parserBox.hidden = driverSel.value === 'clone';
  };
  driverSel.addEventListener('change', syncDriver);

  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '수집 방식 만들기' : '저장' }) as HTMLButtonElement;
  saveBtn.addEventListener('click', async () => {
    const driver = driverSel.value;
    const key = keyIn.value.trim();
    if (!key) { toast('식별자를 입력하세요', true); return; }
    if (driver === 'clone' && !baseSel.value) { toast('복제할 기본 제공을 고르세요', true); return; }
    if ((driver === 'http' || driver === 'rss') && !(driver === 'http' ? urlIn : rssUrlIn).value.trim()) {
      toast('주소를 입력하세요', true); return;
    }
    // 고유 id 매핑은 http·webhook 에서 사실상 필수 — 비면 수집은 도는데 0건이 된다(가장 흔한 함정).
    if ((driver === 'http' || driver === 'webhook') && !mapIn.external_id.value.trim()) {
      toast('고유 id 경로를 입력하세요 — 비우면 가져온 항목이 전부 버려집니다', true); return;
    }

    const buildMap = () => {
      const m: Record<string, string> = {};
      for (const [k, i] of Object.entries(mapIn)) if (i.value.trim()) m[k] = i.value.trim();
      return m;
    };
    let driver_config: Record<string, unknown> = {};
    if (driver === 'http') {
      driver_config = {
        url: urlIn.value.trim(),
        auth: authKindSel.value === 'none' ? { kind: 'none' }
          : { kind: authKindSel.value, tokenField: 'token', name: authNameIn.value.trim() || undefined,
              userField: 'username', passField: 'password' },
        pagination: pagKindSel.value === 'none' ? { kind: 'none' }
          : pagKindSel.value === 'cursor' ? { kind: 'cursor', nextPath: pagNextIn.value.trim() }
          : pagKindSel.value === 'link' ? { kind: 'link', nextUrlPath: pagNextIn.value.trim() }
          : { kind: pagKindSel.value },
        itemsPath: itemsIn.value.trim() || undefined,
        map: buildMap(),
        incremental: incChk.checked,
        allowPrivateNetwork: privChk.checked,
      };
    } else if (driver === 'rss') {
      driver_config = { url: rssUrlIn.value.trim(), allowPrivateNetwork: rssPrivChk.checked };
    } else if (driver === 'webhook') {
      driver_config = {
        signature: sigKindSel.value === 'none' ? { kind: 'none' }
          : { kind: 'hmac-sha256', header: sigHeaderIn.value.trim() || 'x-signature',
              secretField: 'webhook_secret', prefix: sigPrefixIn.value.trim() || undefined },
        itemsPath: whItemsIn.value.trim() || undefined,
        map: buildMap(),
      };
    }

    // 프리셋이 수집기에게 물어볼 항목 — 드라이버가 참조하는 설정 키에서 파생한다(사람이 또 정의하지 않게).
    const fields: Array<Record<string, unknown>> = [];
    if (driver === 'http') {
      if (authKindSel.value === 'bearer' || authKindSel.value === 'header' || authKindSel.value === 'query') {
        fields.push({ key: 'token', label: '토큰', secret: true, required: true, hint: '수집기마다 따로 넣습니다' });
      } else if (authKindSel.value === 'basic') {
        fields.push({ key: 'username', label: '아이디', secret: false, required: true });
        fields.push({ key: 'password', label: '비밀번호', secret: true, required: true });
      }
    } else if (driver === 'webhook' && sigKindSel.value !== 'none') {
      fields.push({ key: 'webhook_secret', label: '공유 비밀', secret: true, required: true, hint: '보내는 쪽과 나눠 갖는 값' });
    }

    saveBtn.disabled = true;
    try {
      await api('/api/ui/org/collector-presets', { method: 'POST', body: JSON.stringify({
        ...(p ? { id: p.id } : {}),
        key, label: labelIn.value.trim() || key, driver,
        base_preset: driver === 'clone' ? baseSel.value : null,
        description: descIn.value.trim() || null,
        fields, driver_config,
        parser_script: driver === 'clone' ? null : (parserIn.value.trim() || null),
        enabled: enabledChk.checked,
      }) });
      toast(isNew ? '수집 방식을 만들었습니다 — [맥락 관리 ▸ 수집]에서 수집기를 만들 수 있습니다' : '저장했습니다');
      editingKey = null; creating = false; reload();
    } catch (e) { toast('실패 — ' + (e as Error).message, true); saveBtn.disabled = false; }
  });
  const cancelBtn = el('button', { class: 'btn-text', text: '닫기' });
  cancelBtn.addEventListener('click', () => { editingKey = null; creating = false; reload(); });

  card.append(
    el('div', { class: 'ctx-row-head' },
      el('span', { class: 'ctx-row-title', text: isNew ? '새 수집 방식' : `설정 — ${p.label}` })),
    F('어떤 방식인가', null, el('div', {}, driverSel, driverWhat,
      // ⚠ raw append 에 null 을 넘기면 DOM 이 문자열 "null" 노드를 만든다(el() 과 달리 안 걸러 준다).
      //  그래서 조건부 요소는 el() 안에 넣는다 — el() 이 null 자식을 무시한다.
      isNew ? null : el('p', { class: 'admin-hint ctx-field-hint', text: '방식은 만든 뒤 바꾸지 않습니다 — 설정 항목이 통째로 달라집니다.' }))),
    F('식별자', '영문·숫자 슬러그. 기본 제공 이름(slack·notion 등)은 쓸 수 없습니다.', keyIn),
    F('이름', '수집기를 만들 때 목록에 보일 이름입니다.', labelIn),
    F('설명', '', descIn),
    cloneBox, httpBox, rssBox, webhookBox, mapHost,
    parserBox,
    el('label', { class: 'admin-check' }, enabledChk, ' 이 방식 사용 — 끄면 새 수집기를 만들 때 목록에 안 보입니다'),
    el('div', { class: 'ctx-actions' }, saveBtn, cancelBtn));

  syncDriver();
  return card;
}
