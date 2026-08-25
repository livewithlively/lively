// v2/onboarding.ts — 처음 설정(#/welcome). 프로토타입 public/onboarding-proto/v2.html 의 가운데 화면을 v2 셸 안으로 옮긴 것(#1813).
//  노션 온보딩 실측(원준님 PDF 2026-08-24)의 3막 구조: 막1 이름만(사이드바 숨김) → 막2 질문 기둥 → 막3 리브와의 채팅.
//  사이드바는 실제 것(side.ts)이 그린다 — 여기선 막1에서 숨겨 달라고만 부탁한다(ctx.onBare).
//  문구는 원준님 교정 31건 반영본. 새로 쓴 연결부는 [새문구] 주석. 상태는 sessionStorage(진행)·localStorage(끝남 표식).
//  ⚠ 프로토타입에서 그대로 옮긴 코드라 타입을 붙이지 않았다(// @ts-nocheck) — 기능 배선(답 저장·실제 분류)을 붙일 때 정리한다.
// @ts-nocheck
export const OB_DONE_KEY = 'lively_ob_done';
export function onboardingDone() { try {
    return localStorage.getItem(OB_DONE_KEY) === '1';
}
catch (_) {
    return false;
} }
export function renderOnboarding(host, ctx = {}) {
    host.className = 'ob-root';
    host.innerHTML = `<div class="ob-crumb" id="crumb"><span class="ob-lm">L</span><span style="font-weight:600">리브</span><span class="ob-sep">/</span><span>처음 설정</span></div>
    <div class="ob-qwrap"><div class="ob-qcol" id="qcol"></div></div>
    <div class="ob-chat"><div class="ob-thread" id="thread"></div></div>
    <div class="ob-composer"><div class="ob-composer-in">
      <input id="composeIn" type="text" placeholder="직접 적으셔도 됩니다" aria-label="리브에게 쓰기">
      <div class="ob-composer-row"><span>＋</span><span>Auto</span><button class="ob-send" id="composeGo">↑</button></div>
    </div></div>
<div class="ob-toast" id="toast"></div>`;
    const DONE_KEY = OB_DONE_KEY;
    const setStage = (s) => { host.className = 'ob-root ob-' + s; ctx.onBare && ctx.onBare(s === 'stage-name'); };
    /* ══════════════ 데이터 — 기존 프로토(app.js)에서 그대로 추출한 확정본 ══════════════ */
    const DATA = {
        "STAGES": {
            "company": {
                "label": "회사·조직",
                "axis": "어느 부서에 가까우세요?",
                "opts": [
                    [
                        "제품·기획",
                        "기획·PO"
                    ],
                    [
                        "마케팅·브랜드",
                        "마케팅"
                    ],
                    [
                        "영업·고객",
                        "마케팅"
                    ],
                    [
                        "개발·데이터",
                        "개발"
                    ],
                    [
                        "디자인",
                        "기획·PO"
                    ],
                    [
                        "경영·전략",
                        "기획·PO"
                    ],
                    [
                        "재무·회계·법무",
                        "운영·재무"
                    ],
                    [
                        "인사·총무·운영",
                        "운영·재무"
                    ]
                ]
            },
            "solo": {
                "label": "1인·프리랜서",
                "axis": "어떤 일을 하고 계세요?",
                "opts": [
                    [
                        "컨설팅·자문",
                        "1인 사업"
                    ],
                    [
                        "개발·외주",
                        "개발"
                    ],
                    [
                        "디자인·크리에이티브",
                        "1인 사업"
                    ],
                    [
                        "콘텐츠·미디어",
                        "마케팅"
                    ],
                    [
                        "커머스",
                        "1인 사업"
                    ],
                    [
                        "교육·강의",
                        "1인 사업"
                    ],
                    [
                        "전문직",
                        "법무·계약"
                    ]
                ]
            },
            "academy": {
                "label": "학교·연구",
                "axis": "어느 단계이신가요?",
                "opts": [
                    [
                        "학부연구생",
                        "연구·대학원"
                    ],
                    [
                        "석사",
                        "연구·대학원"
                    ],
                    [
                        "박사",
                        "연구·대학원"
                    ],
                    [
                        "포닥·연구원",
                        "연구·대학원"
                    ],
                    [
                        "교원",
                        "연구·대학원"
                    ]
                ]
            },
            "student": {
                "label": "학생",
                "axis": "어떤 일에 주로 사용하실 예정인가요?",
                "opts": [
                    [
                        "수업·과제",
                        "학생"
                    ],
                    [
                        "외부 시험(자격 시험 등)",
                        "학생"
                    ],
                    [
                        "학회·동아리",
                        "학생"
                    ],
                    [
                        "창업·사이드 프로젝트",
                        "학생"
                    ],
                    [
                        "취업",
                        "학생"
                    ]
                ]
            }
        },
        "KINDS7": [
            [
                "기획·설계",
                "무엇을 만들지 정한 것"
            ],
            [
                "보고·분석",
                "결과를 정리해 알린 것"
            ],
            [
                "기록",
                "오간 말을 남긴 것"
            ],
            [
                "규정·계약",
                "지켜야 할 것을 못박은 것"
            ],
            [
                "산출물",
                "내보낸 결과물 자체"
            ],
            [
                "조사·자료",
                "남이 만든 것을 모아 둔 것"
            ],
            [
                "거래·정산",
                "돈이 오간 것"
            ]
        ],
        "NOW_KINDS": [
            "지난 자료를 찾아 확인하는 일",
            "문서를 처음부터 쓰는 일",
            "같은 양식을 매번 다시 채우는 일",
            "사람들과 맞추고 공유하는 일",
            "숫자를 모아 맞춰 보는 일",
            "길게 읽고 요약하는 일"
        ],
        "TALLY7": {
            "기획·PO": [
                [
                    "기획·설계",
                    18
                ],
                [
                    "기록",
                    13
                ],
                [
                    "보고·분석",
                    10
                ]
            ],
            "마케팅": [
                [
                    "산출물",
                    17
                ],
                [
                    "보고·분석",
                    12
                ],
                [
                    "기록",
                    12
                ]
            ],
            "연구·대학원": [
                [
                    "조사·자료",
                    23
                ],
                [
                    "기록",
                    12
                ],
                [
                    "기획·설계",
                    6
                ]
            ],
            "법무·계약": [
                [
                    "규정·계약",
                    21
                ],
                [
                    "기록",
                    11
                ],
                [
                    "보고·분석",
                    7
                ]
            ],
            "개발": [
                [
                    "산출물",
                    19
                ],
                [
                    "기획·설계",
                    12
                ],
                [
                    "기록",
                    10
                ]
            ],
            "운영·재무": [
                [
                    "보고·분석",
                    16
                ],
                [
                    "거래·정산",
                    13
                ],
                [
                    "규정·계약",
                    9
                ]
            ],
            "1인 사업": [
                [
                    "기획·설계",
                    14
                ],
                [
                    "거래·정산",
                    12
                ],
                [
                    "기록",
                    9
                ]
            ],
            "학생": [
                [
                    "조사·자료",
                    20
                ],
                [
                    "기록",
                    10
                ],
                [
                    "산출물",
                    8
                ]
            ],
            "default": [
                [
                    "기획·설계",
                    15
                ],
                [
                    "기록",
                    12
                ],
                [
                    "보고·분석",
                    9
                ]
            ]
        },
        "SOURCE_ROWS": [
            {
                "k": "문서·위키",
                "items": [
                    {
                        "id": "notion",
                        "label": "Notion",
                        "logo": "notion",
                        "live": true
                    },
                    {
                        "id": "gdrive",
                        "label": "Google Drive",
                        "logo": "googledrive",
                        "live": true
                    },
                    {
                        "id": "figma",
                        "label": "Figma",
                        "logo": "figma",
                        "live": true
                    }
                ]
            },
            {
                "k": "메신저·메일·일정",
                "items": [
                    {
                        "id": "slack",
                        "label": "Slack",
                        "logo": "slack",
                        "live": true
                    },
                    {
                        "id": "gmail",
                        "label": "Gmail",
                        "logo": "gmail",
                        "live": true,
                        "admin": true
                    },
                    {
                        "id": "gcal",
                        "label": "Google 캘린더",
                        "logo": "googlecalendar",
                        "live": true,
                        "admin": true
                    }
                ]
            },
            {
                "k": "일감·코드",
                "items": [
                    {
                        "id": "linear",
                        "label": "Linear",
                        "logo": "linear",
                        "live": true
                    },
                    {
                        "id": "clickup",
                        "label": "ClickUp",
                        "logo": "clickup",
                        "live": true
                    },
                    {
                        "id": "github",
                        "label": "GitHub",
                        "logo": "github",
                        "live": true
                    },
                    {
                        "id": "gitlab",
                        "label": "GitLab",
                        "logo": "gitlab",
                        "live": true
                    }
                ]
            },
            {
                "k": "내 컴퓨터",
                "items": [
                    {
                        "id": "folder",
                        "label": "내 컴퓨터 폴더",
                        "ic": "folder"
                    },
                    {
                        "id": "git",
                        "label": "로컬 깃 저장소",
                        "ic": "term"
                    }
                ]
            },
            {
                "k": "그 밖",
                "items": [
                    {
                        "id": "prometheus",
                        "label": "Prometheus",
                        "logo": "prometheus",
                        "live": true
                    },
                    {
                        "id": "none",
                        "label": "딱히 없어요, 대화로 시작",
                        "ic": "doc",
                        "none": true
                    }
                ]
            }
        ],
        "AIS": [
            "Claude",
            "ChatGPT",
            "Gemini",
            "Grok",
            "여러 개",
            "아직 없어요"
        ],
        "CAN": {
            "제품·기획": [
                [
                    "지난 분기 VOC를 전부 훑어서 세 번 넘게 나온 요구만 고르고, 이번 로드맵에 있는지 대조한 다음, 빠진 것마다 왜 빠졌는지 회의록에서 근거를 찾아 표로 만들어 줘",
                    "VOC 열어 세고 → 로드맵 대조하고 → 회의록 뒤지고 → 표로 정리. 네 번 왔다 갔다."
                ],
                [
                    "마케팅",
                    "그 요구 중에 우리가 이미 만들었는데 안 알린 게 있는지 지난 공지와 릴리스 노트에서 찾아 줘"
                ]
            ],
            "마케팅·브랜드": [
                [
                    "작년 같은 달 캠페인과 올해 것을 비교해서 나빠진 지표를 고르고, 각각 그때 쓴 소재를 붙이고, 회의에서 이유로 언급된 게 있으면 같이 정리해 줘",
                    "작년 리포트 찾고 → 올해와 비교하고 → 소재 뒤지고 → 회의록 검색. 네 번."
                ],
                [
                    "영업",
                    "그 캠페인으로 들어온 문의가 실제 계약까지 간 비율을 영업 자료에서 찾아 붙여 줘"
                ]
            ],
            "영업·고객": [
                [
                    "이번 분기에 떠난 고객들의 문의 기록과 계약서를 다 읽고 공통된 신호를 찾아서, 아직 남아 있는 고객 중 같은 신호가 보이는 곳을 알려 줘",
                    "이탈 목록 뽑고 → 고객별 문의 열고 → 계약 확인하고 → 남은 고객과 대조. 고객 수만큼 반복."
                ],
                [
                    "제품",
                    "그 신호가 제품의 어느 기능과 맞닿아 있는지 스펙에서 짚어 줘"
                ]
            ],
            "개발·데이터": [
                [
                    "이번 릴리스에서 바뀐 부분과 문서를 대조해서 설명이 안 맞는 것만 찾고, 그걸 쓰고 있는 쪽까지 짚어 줘",
                    "변경 목록 뽑고 → 문서 찾아 비교하고 → 사용처 검색. 항목마다 반복."
                ],
                [
                    "기획",
                    "그 변경 중에 스펙에 없던 것이 있으면 표시해 줘"
                ]
            ],
            "디자인": [
                [
                    "최근 시안 세 개에서 반복해서 지적받은 것을 뽑고, 그게 우리 디자인 규칙 중 어디와 어긋나는지 짚어 줘",
                    "시안별 코멘트 열고 → 겹치는 것 세고 → 규칙 문서 대조. 세 번 이상."
                ],
                [
                    "제품",
                    "그 지적이 실제로 스펙 변경까지 이어졌는지 확인해 줘"
                ]
            ],
            "경영·전략": [
                [
                    "지난 6개월 회의록에서 우리가 미룬 결정만 모아서, 각각 지금은 어떻게 됐는지 최근 자료로 확인해 줘",
                    "회의록 스무 건 훑고 → 미룬 것 표시하고 → 각각 후속 자료 찾기. 결정 수만큼 반복."
                ],
                [
                    "재무",
                    "그중 돈이 걸린 것만 골라 금액 규모를 붙여 줘"
                ]
            ],
            "재무·회계·법무": [
                [
                    "이번 달 계약서에서 표준과 다른 조항만 뽑고, 과거에 같은 조항으로 문제가 생긴 적이 있는지 지난 기록에서 찾아 줘",
                    "계약서 한 건씩 열고 → 표준본과 비교하고 → 과거 사례 검색. 계약 수만큼 반복."
                ],
                [
                    "영업",
                    "그 조항이 어느 고객과의 계약에 몰려 있는지 정리해 줘"
                ]
            ],
            "인사·총무·운영": [
                [
                    "지난 1년 채용 공고와 실제 입사자 이력을 비교해서, 공고와 다르게 뽑힌 패턴을 정리해 줘",
                    "공고 모으고 → 입사자 이력 대조하고 → 패턴 세기. 직무 수만큼 반복."
                ],
                [
                    "경영",
                    "그 패턴이 올해 조직 목표와 어긋나는 지점이 있으면 짚어 줘"
                ]
            ],
            "solo": [
                [
                    "지난 프로젝트 산출물 중에 이번 제안에 재활용할 수 있는 것을 찾아서, 이 고객 업종에 맞게 고친 제안서 초안을 만들어 줘",
                    "옛 프로젝트 폴더 뒤지고 → 쓸 것 고르고 → 업종에 맞게 고쳐 쓰기. 반나절."
                ],
                [
                    "정산",
                    "그 제안에 들어갈 견적을 지난 비슷한 건들 기준으로 잡아 줘"
                ]
            ],
            "academy": [
                [
                    "내가 읽은 논문 중에 이 가설을 반박하는 것을 찾고, 내 실험 결과와 어긋나는 지점을 짚고, 관련 연구 절 초안까지 써 줘",
                    "논문 스무 편 다시 훑고 → 반박 찾고 → 내 데이터와 대조하고 → 초안 쓰기. 며칠."
                ],
                [
                    "지도 미팅",
                    "다음 미팅 전에 교수님이 지난번에 지적하신 것 중 아직 반영 안 된 게 뭔지 알려 줘"
                ]
            ],
            "student": [
                [
                    "이번 학기 강의자료 전부에서 시험에 나올 만한 개념을 뽑고, 내 필기에서 빠진 것만 알려 줘",
                    "강의자료 열두 개 열고 → 정리하고 → 필기와 대조. 시험 전날 밤샘."
                ],
                [
                    "취업",
                    "내가 한 프로젝트들에서 이 공고의 요구사항과 맞는 경험만 뽑아 자기소개서 초안을 써 줘"
                ]
            ]
        },
        "FILES": {
            "기획·PO": [
                "스펙_결제개편_v3.docx",
                "VOC 정리 8월.xlsx"
            ],
            "마케팅": [
                "8/12 팀 회의.m4a",
                "7월 월간 보고서.pptx"
            ],
            "연구·대학원": [
                "Kim et al. 2025.pdf",
                "학위논문 2장 초안.docx"
            ],
            "법무·계약": [
                "표준 계약서 v4.docx",
                "검토 요청 계약서(18쪽).pdf"
            ],
            "개발": [
                "README.md",
                "API v2 마이그레이션 스펙.md"
            ],
            "운영·재무": [
                "8월 정산.xlsx",
                "7월 결산 보고.xlsx"
            ],
            "1인 사업": [
                "견적서_A사_v2.docx",
                "계약서_B사.pdf"
            ],
            "학생": [
                "강의노트_경영전략.pdf",
                "과제_3주차.docx"
            ]
        }
    };
    /* 서비스 로고·무대 아이콘 — v1 app.js 의 BRAND(인라인 SVG)를 그대로. 사람은 '내가 쓰는 그 서비스'를 로고로 알아본다. */
    const BRAND = { "slack": "<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#4A154B\"><path d=\"M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z\"/></svg>", "notion": "<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#000000\"><path d=\"M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z\"/></svg>", "linear": "<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#5E6AD2\"><path d=\"M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z\"/></svg>", "googledrive": "<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#4285F4\"><path d=\"M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z\"/></svg>", "github": "<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#181717\"><path d=\"M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12\"/></svg>", "gitlab": "<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#FC6D26\"><path d=\"m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z\"/></svg>", "clickup": "<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#7B68EE\"><path d=\"M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z\"/></svg>", "figma": "<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#F24E1E\"><path d=\"M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.515-2.014-4.515-4.49s2.014-4.49 4.49-4.49h4.588v4.441c0 2.503-2.047 4.539-4.563 4.539zm-.024-7.51a3.023 3.023 0 0 0-3.019 3.019c0 1.665 1.365 3.019 3.044 3.019 1.705 0 3.093-1.376 3.093-3.068v-2.97H8.148zm7.704 0h-.098c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h.098c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49zm-.097-7.509c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h.098c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-.098z\"/></svg>", "prometheus": "<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#E6522C\"><path d=\"M12 0C5.373 0 0 5.372 0 12c0 6.627 5.373 12 12 12s12-5.373 12-12c0-6.628-5.373-12-12-12zm0 22.46c-1.885 0-3.414-1.26-3.414-2.814h6.828c0 1.553-1.528 2.813-3.414 2.813zm5.64-3.745H6.36v-2.046h11.28v2.046zm-.04-3.098H6.391c-.037-.043-.075-.086-.111-.13-1.155-1.401-1.427-2.133-1.69-2.879-.005-.025 1.4.287 2.395.511 0 0 .513.119 1.262.255-.72-.843-1.147-1.915-1.147-3.01 0-2.406 1.845-4.508 1.18-6.207.648.053 1.34 1.367 1.387 3.422.689-.951.977-2.69.977-3.755 0-1.103.727-2.385 1.454-2.429-.648 1.069.168 1.984.894 4.256.272.854.237 2.29.447 3.201.07-1.892.395-4.652 1.595-5.605-.529 1.2.079 2.702.494 3.424.671 1.164 1.078 2.047 1.078 3.716a4.642 4.642 0 01-1.11 2.996c.792-.149 1.34-.283 1.34-.283l2.573-.502s-.374 1.538-1.81 3.019z\"/></svg>", "gmail": "<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#EA4335\"><path d=\"M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z\"/></svg>", "googlecalendar": "<svg class=\"ob-blogo\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"#4285F4\"><path d=\"M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z\"/></svg>" };
    const $ = (s, el) => (el || host).querySelector(s);
    const $$ = (s, el) => Array.from((el || host).querySelectorAll(s));
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let toastT = null;
    function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('ob-on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('ob-on'), 2600); }
    /* ── 상태 ── */
    const KEY = 'lively-ob-v2';
    const fresh = () => ({
        scene: 'name', name: '', nameSet: false, stage: null, job: null,
        sources: [], connected: [], ai: null, aiConnected: false, terminal: null, app: null,
        read: { total: 0, done: 0, finished: false }, drawersOn: false,
        b2: null, b3: null, nowline: null, firstOrder: null, decisions: [], notes: [],
        chatDone: [], // 막3에서 끝난 단계들
    });
    let S = fresh();
    try {
        const v = JSON.parse(sessionStorage.getItem(KEY));
        if (v && v.scene)
            S = Object.assign(fresh(), v);
    }
    catch (e) { }
    const save = () => { try {
        sessionStorage.setItem(KEY, JSON.stringify(S));
    }
    catch (e) { } };
    const stageOf = () => DATA.STAGES[S.stage] || DATA.STAGES.company;
    const jobOf = () => S.job || stageOf().opts[0][0];
    const personaOf = () => { const hit = stageOf().opts.find(([l]) => l === S.job); return hit ? hit[1] : stageOf().opts[0][1]; };
    const tally3 = () => DATA.TALLY7[jobOf()] || DATA.TALLY7[personaOf()] || DATA.TALLY7.default;
    const canOf = () => DATA.CAN[jobOf()] || DATA.CAN[S.stage] || DATA.CAN['제품·기획'];
    /* b2 는 '같은 양식 문서' 이야기 — 녹음·이미지 파일이 예시로 뽑히면 문장이 안 맞는다(실측: 8/12 팀 회의.m4a) */
    const fileOf = (i) => {
        const raw = DATA.FILES[personaOf()] || DATA.FILES['마케팅'] || [];
        const docs = raw.filter((f) => !/\.(m4a|mp3|wav|mp4|mov|png|jpe?g|gif)$/i.test(String(f)));
        return docs[i] || raw[i] || ['보고서', '문서'][i];
    };
    const nick = () => S.nameSet && S.name ? S.name : '';
    /* 자료 41건을 7갈래에 나눠 담는 목표치 — 상위 3개는 직무 표, 나머지는 잔량 */
    function drawerTargets() {
        const top = tally3();
        const t = {};
        DATA.KINDS7.forEach(([k]) => { t[k] = 0; });
        let sum = 0;
        top.forEach(([k, c]) => { t[k] = c; sum += c; });
        const rest = DATA.KINDS7.map(([k]) => k).filter((k) => !t[k]);
        let left = Math.max(0, 41 - sum);
        rest.forEach((k, i) => { const c = i < rest.length - 1 ? Math.min(left, [2, 1, 1][i] ?? 1) : left; t[k] = c; left -= c; });
        return t;
    }
    let pendingChips = null; // 지금 답을 기다리는 칩들 — 입력창 해석이 본다
    function renderSB() { }
    /* ══════════════ 장면 차례 ══════════════ */
    const ORDER = ['name', 'stage', 'role', 'sources', 'upload', 'ai', 'claude', 'terminal', 'app', 'read', 'b1', 'b2', 'b3', 'nowline', 'can', 'done'];
    const STEP_OF = Object.fromEntries(ORDER.map((k, i) => [k, i]));
    const CHAT_FROM = STEP_OF.read; // 여기부터 막3(채팅)
    const QPROG = ['stage', 'role', 'sources', 'upload', 'ai', 'claude', 'terminal', 'app']; // 막2 진행 눈금
    /* ── 막1·막2: 가운데 질문 기둥 ── */
    function qHead(prog, lead, title, help) {
        const at = QPROG.indexOf(prog);
        return `<div class="ob-q-ic">L</div>
      ${at >= 0 ? `<div class="ob-q-prog">${QPROG.map((_, i) => `<i class="${i <= at ? 'ob-on' : ''}"></i>`).join('')}</div>` : ''}
      ${lead ? `<p class="ob-q-lead">${lead}</p>` : ''}
      <h1 class="ob-q-title">${title}</h1>
      ${help ? `<p class="ob-q-help">${help}</p>` : ''}`;
    }
    function card(label, desc, ic, on) {
        return `<button class="ob-opt-card ${on ? 'ob-on' : ''}" data-opt="${esc(label)}">
      ${ic ? `<span class="ob-oc-ic">${ic}</span>` : ''}<span><span class="ob-oc-t">${esc(label)}</span>${desc ? `<span class="ob-oc-d">${esc(desc)}</span>` : ''}</span>
      <span class="ob-oc-chk">✓</span></button>`;
    }
    const SCENES = {
        /* 막1 — 민낯. 노션 p1: 이름 하나만, 가운데. */
        name: {
            html: () => qHead(null, '안녕하세요, 저는 리브예요. 이 워크스페이스를 계속 돌봐 드릴 담당자입니다.', '어떻게 불러 드릴까요?', '이름이든 별명이든 편한 대로 적어 주세요. 나중에 언제든 바꾸실 수 있어요.')
                + `<div class="ob-q-write"><input id="nameIn" type="text" placeholder="예: 원준" value="${esc(S.nameSet ? S.name : '')}"></div>
           <button class="ob-btn ob-btn-pri" id="nameGo">이렇게 불러 주세요</button>
           <button class="ob-q-skip" data-skip>그냥 넘어갈게요</button>`,
            bind: (el) => {
                const inp = $('#nameIn', el);
                const go = () => { const v = inp.value.trim(); if (v) {
                    S.name = v;
                    S.nameSet = true;
                } goScene('stage'); };
                $('#nameGo', el).onclick = go;
                inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing)
                    go(); });
                $('[data-skip]', el).onclick = () => goScene('stage');
                inp.focus();
            },
        },
        /* 막2 — 사이드바가 유령으로 등장. 노션 p2: 큰 질문 + 카드 선택지. */
        stage: {
            html: () => qHead('stage', `안녕하세요, 저는 리브예요. <b>이 워크스페이스를 계속 돌봐 드릴 담당자입니다.</b> 몇 가지만 여쭙고, 나머지는 자료를 보고 제가 알아서 세팅할게요.`, '어디에서 일하고 계세요?', '자세한 건 안 여쭙습니다. 두 번만 고르시면 됩니다.')
                /* [새문구] 카드 설명 4줄 — 노션 카드형에 맞춰 새로 씀 */
                + `<div class="ob-opt-cards">
            ${card('회사·조직', '팀과 함께 회사 일을 합니다', BRAND.company, S.stage === 'company')}
            ${card('1인·프리랜서', '내 이름으로 여러 일을 합니다', BRAND.solo, S.stage === 'solo')}
            ${card('학교·연구', '연구실·학교에서 연구합니다', BRAND.academy, S.stage === 'academy')}
            ${card('학생', '수업·시험·진로를 준비합니다', BRAND.student, S.stage === 'student')}
          </div><button class="ob-q-skip" data-skip>나중에 정할게요</button>`,
            bind: (el) => {
                const ID = { '회사·조직': 'company', '1인·프리랜서': 'solo', '학교·연구': 'academy', '학생': 'student' };
                $$('.ob-opt-card', el).forEach((c) => c.onclick = async () => {
                    $$('.ob-opt-card', el).forEach((x) => x.classList.remove('ob-on'));
                    c.classList.add('ob-on');
                    const id = ID[c.dataset.opt];
                    if (S.stage !== id) {
                        S.job = null;
                    }
                    S.stage = id;
                    save();
                    await sleep(200);
                    goScene('role');
                });
                $('[data-skip]', el).onclick = () => { S.stage = S.stage || 'company'; goScene('role'); };
            },
        },
        role: {
            html: () => qHead('role', `${esc(stageOf().label)}이시군요.`, esc(stageOf().axis), '고르신 것에 맞춰 자료를 읽습니다. 목록에 없으면 직접 적어 주세요.')
                + `<div class="ob-opt-cards">${stageOf().opts.map(([l]) => card(l, '', '', S.job === l)).join('')}</div>
           <div class="ob-q-write" hidden><input id="roleIn" type="text" placeholder="무슨 일을 하시는지 적어 주세요"><button class="ob-btn ob-btn-pri ob-btn-inline" id="roleInGo" style="margin-top:0">확인</button></div>
           <button class="ob-q-skip" data-other>목록에 없어요. 직접 적을게요</button>
           <button class="ob-q-skip" data-skip>나중에 정할게요</button>`,
            bind: (el) => {
                $$('.ob-opt-card', el).forEach((c) => c.onclick = async () => {
                    $$('.ob-opt-card', el).forEach((x) => x.classList.remove('ob-on'));
                    c.classList.add('ob-on');
                    S.job = c.dataset.opt;
                    save();
                    await sleep(200);
                    goScene('sources');
                });
                const wr = $('.ob-q-write', el), win = $('#roleIn', el);
                $('[data-other]', el).onclick = (e) => { wr.hidden = false; e.target.hidden = true; win.focus(); };
                const commit = () => { const v = win.value.trim(); if (!v)
                    return; S.job = v; save(); goScene('sources'); };
                $('#roleInGo', el).onclick = commit;
                win.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing)
                    commit(); });
                $('[data-skip]', el).onclick = () => goScene('sources');
            },
        },
        sources: {
            html: () => qHead('sources', `고맙습니다. 나머지는 <b>조금 뒤에 올려주시는 자료를 보고</b> 제가 알아서 세팅할게요.`, '지금까지의 맥락을 주로 어디에 쌓아 두셨나요?', '연결해 두시면 라이블리가 그 서비스의 자료를 계속 모아 정리해서, 쓰시는 AI에 자동으로 실어 줍니다. 여러 개 골라도 됩니다.')
                + DATA.SOURCE_ROWS.map((r) => `<p class="ob-opt-group">${esc(r.k)}</p><div class="ob-opt-grid">
            ${r.items.map((it) => card(it.label, '', BRAND[it.logo] || '', S.sources.includes(it.id))).join('')}</div>`).join('')
                + `<button class="ob-btn ob-btn-pri" id="srcGo" disabled>계속</button>
           <button class="ob-q-skip" data-skip>건너뛰기. 파일은 나중에 올릴게요</button>`,
            bind: (el) => {
                const all = DATA.SOURCE_ROWS.flatMap((r) => r.items);
                const idOf = (label) => (all.find((s) => s.label === label) || {}).id;
                const go = $('#srcGo', el);
                const sync = () => { const n = $$('.ob-opt-card.ob-on', el).length; go.disabled = !n; go.textContent = n ? `${n}개 연결하고 계속` : '계속'; };
                sync();
                $$('.ob-opt-card', el).forEach((c) => c.onclick = () => {
                    c.classList.toggle('ob-on');
                    S.sources = $$('.ob-opt-card.ob-on', el).map((x) => idOf(x.dataset.opt)).filter(Boolean);
                    save();
                    renderSB();
                    sync();
                });
                go.onclick = () => goScene('upload');
                $('[data-skip]', el).onclick = () => { S.sources = ['none']; save(); goScene('ai'); };
            },
        },
        upload: {
            html: () => {
                const all = DATA.SOURCE_ROWS.flatMap((r) => r.items);
                const names = S.sources.map((id) => (all.find((s) => s.id === id) || {}).label).filter(Boolean);
                return qHead('upload', `${esc(names.join('·'))}은 한 번 연결하면 계속 새 자료가 따라옵니다.`, '자료를 넘겨주세요.', '파일을 가지고 계시면 그냥 끌어다 놓으시면 됩니다.')
                    + `<div class="ob-opt-cards">${S.sources.map((id) => {
                        const it = all.find((s) => s.id === id) || { label: id };
                        const on = S.connected.includes(id);
                        return `<button class="ob-opt-card ${on ? 'ob-on' : ''}" data-conn="${esc(id)}"><span class="ob-oc-ic">${BRAND[it.logo] || ''}</span><span class="ob-oc-st"><span class="v2-dot ${on ? 'done' : 'off'}" style="margin:0"></span></span>
                <span><span class="ob-oc-t">${esc(it.label)}</span><span class="ob-oc-d">${on ? '연결됐어요. 새 자료가 따라옵니다.' : '눌러서 연결 (새 탭에서 허용 1번)'}</span></span></button>`;
                    }).join('')}</div>
          <button class="ob-btn ob-btn-pri" id="upGo" ${S.connected.length ? '' : 'disabled'}>다 넣었어요, 계속</button>
          <button class="ob-q-skip" data-skip>지금은 건너뛰기</button>`;
            },
            bind: (el) => {
                $$('[data-conn]', el).forEach((c) => c.onclick = async () => {
                    const id = c.dataset.conn;
                    if (S.connected.includes(id))
                        return;
                    c.querySelector('.ob-oc-st').innerHTML = '<span class="v2-dot busy" style="margin:0"></span>';
                    c.querySelector('.ob-oc-d').textContent = '새 탭에서 허용을 기다리는 중';
                    await sleep(1100);
                    S.connected.push(id);
                    if (!S.read.total)
                        S.read.total = 41;
                    save();
                    renderSB();
                    renderScene('upload', false);
                });
                $('#upGo', el).onclick = () => goScene('ai');
                $('[data-skip]', el).onclick = () => goScene('ai');
            },
        },
        ai: {
            html: () => qHead('ai', S.read.total ? '자료를 읽는 동안 하나 더요.' : '이제 AI 차례예요.', '평소 어떤 AI를 쓰세요?', '')
                + `<div class="ob-opt-cards">${DATA.AIS.map((a) => card(a, '', '', S.ai === a)).join('')}</div>
           <button class="ob-q-skip" data-skip>나중에 정할게요</button>`,
            bind: (el) => {
                $$('.ob-opt-card', el).forEach((c) => c.onclick = async () => {
                    $$('.ob-opt-card', el).forEach((x) => x.classList.remove('ob-on'));
                    c.classList.add('ob-on');
                    S.ai = c.dataset.opt;
                    save();
                    renderSB();
                    await sleep(200);
                    goScene(S.ai === '아직 없어요' ? 'terminal' : 'claude');
                });
                $('[data-skip]', el).onclick = () => goScene('terminal');
            },
        },
        claude: {
            html: () => qHead('claude', `연결한 뒤에는 제(리브)가 일할 때도 ${esc(nick() || '당신')}님의 ${esc(S.ai || 'AI')} 사용량을 씁니다. 얼마나 썼는지는 언제든 보여 드릴게요.`, `${esc(S.ai || 'AI')} 계정을 연결해 주세요.`, '새 탭에서 로그인하고 짧은 코드를 가져오면 됩니다 · 1분')
                + `<button class="ob-btn ob-btn-pri" id="cGo">${S.aiConnected ? '연결됐어요, 계속' : '연결 확인'}</button>
           <button class="ob-btn ob-btn-sub" data-skip>나중에 할게요</button>`,
            bind: (el) => {
                $('#cGo', el).onclick = async (e) => {
                    if (!S.aiConnected) {
                        e.target.textContent = '연결 확인 중…';
                        await sleep(900);
                        S.aiConnected = true;
                        save();
                        renderSB();
                        toast(`${S.ai} 연결됐어요.`);
                    }
                    goScene('terminal');
                };
                $('[data-skip]', el).onclick = () => goScene('terminal');
            },
        },
        /* 노션 p4(데스크톱 앱 유도)와 같은 자리 — 우리는 터미널 질문 */
        terminal: {
            html: () => qHead('terminal', S.ai === '아직 없어요' ? `AI 구독이 아직 없으셔도 괜찮아요. 자료 쌓기·정리·검색은 지금부터 됩니다. 첫 질문 <b>3회</b>는 라이블리 계정으로 열어 드릴게요.` : (S.aiConnected ? '연결됐어요. 거의 끝났습니다.' : '거의 끝났습니다.'), '터미널에서 Claude Code나 Codex 등을 쓰시나요?', '쓰신다면 거기에도 같은 자료가 실리게 할 수 있어요.')
                + `<div class="ob-benefits">
            <p class="ob-benefit">터미널의 AI도 같은 자료함을 봅니다</p>
            <p class="ob-benefit">여기서 정리한 맥락이 코드 작업에도 실립니다</p>
          </div>
          <button class="ob-btn ob-btn-pri" id="tYes">네, 씁니다</button>
          <button class="ob-btn ob-btn-sub" id="tNo">아니요</button>`,
            bind: (el) => {
                $('#tYes', el).onclick = () => { S.terminal = 'yes'; S.decisions.push('내 컴퓨터 노드 연결, 터미널의 Claude Code에도 같은 자료'); save(); renderSB(); toast('홈에서 한 줄 설치를 안내할게요 (lively node --daemon)'); goScene('app'); };
                $('#tNo', el).onclick = () => { S.terminal = 'no'; save(); goScene('app'); };
            },
        },
        /* 노션 p4 '앱 유도' 그대로의 자리 — 질문이 끝나고 채팅(컨설팅)에 들어가기 직전. [새문구] 전체 */
        app: {
            html: () => qHead('app', S.terminal === 'yes' ? '터미널 연결까지 받아 뒀어요. 마지막으로 하나 권해 드릴게요.' : '마지막으로 하나 권해 드릴게요.', '라이블리 앱을 받아 두시면 더 편해요.', '웹으로도 전부 됩니다. 앱은 이런 게 더해져요.')
                + `<div class="ob-benefits">
            <p class="ob-benefit">더 빠르게 열리고, 로그인이 유지돼요</p>
            <p class="ob-benefit">리브가 확인이 필요할 때 알림으로 바로 알려 드려요</p>
            <p class="ob-benefit">내 컴퓨터 폴더와 로컬 깃 저장소를 앱이 직접 이어 줘요</p>
          </div>
          <button class="ob-btn ob-btn-pri" id="appGet">앱 받기</button>
          <button class="ob-btn ob-btn-sub" id="appSkip">지금은 웹으로 할게요</button>`,
            bind: (el) => {
                $('#appGet', el).onclick = () => { S.app = 'yes'; S.decisions.push('데스크톱 앱 받기'); save(); renderSB(); toast('실제 서비스에서는 여기서 내려받기가 시작됩니다.'); goScene('read'); };
                $('#appSkip', el).onclick = () => { S.app = 'web'; save(); goScene('read'); };
            },
        },
    };
    /* ══════════════ 막3 — 컨설팅 채팅 (노션 p5·p6 구조) ══════════════ */
    let seqToken = 0;
    function msgLiv(html) { const el = document.createElement('div'); el.className = 'ob-msg'; el.innerHTML = `<span class="ob-ava">L</span><div class="ob-body">${html}</div>`; $('#thread').appendChild(el); keepChipsLast(); scrollChat(); return el; }
    function msgUser(text) { const el = document.createElement('div'); el.className = 'ob-msg ob-user'; el.innerHTML = `<div class="ob-body">${esc(text)}</div>`; $('#thread').appendChild(el); keepChipsLast(); scrollChat(); return el; }
    function chipsRow(items) {
        const el = document.createElement('div');
        el.className = 'ob-chips';
        const list = items.map(({ label, cta, ghost, cb }) => {
            const b = document.createElement('button');
            b.className = 'ob-chip' + (cta ? ' ob-cta' : '') + (ghost ? ' ob-ghost' : '');
            b.textContent = label;
            b.onclick = () => { pendingChips = null; el.remove(); renderSB(); cb && cb(label); };
            el.appendChild(b);
            return { label, cta, ghost, fire: b.onclick };
        });
        pendingChips = { el, list };
        $('#composeIn').placeholder = '또는 여기에 적어 주세요';
        $('#thread').appendChild(el);
        renderSB();
        scrollChat();
        return el;
    }
    /* 새 말풍선이 붙으면 답 칩을 다시 맨 아래로 — 예시 카드를 누르고 나면 칩이 위로 밀려 '다음으로 가는 길'이 안 보였다(원준님 2026-08-25). */
    function keepChipsLast() { if (pendingChips && pendingChips.el.isConnected) {
        $('#thread').appendChild(pendingChips.el);
    } }
    /* 입력창에 친 글을 답으로 해석 — "응·네·어" 는 긍정 칩, "아니" 는 부정 칩, "다음·넘어가·계속·끝" 은 진행 칩, 그 밖엔 보기 낱말 맞춤 */
    function matchChip(v) {
        if (!pendingChips)
            return null;
        const L = pendingChips.list;
        const t = v.replace(/\s+/g, '').toLowerCase();
        const yes = /^(응|웅|네|넵|예|어|ㅇㅇ|ㅇㅋ|오케이|ok|yes|좋아요?|맞아요?|그래요?|이대로|해주세요|해줘)/.test(t);
        const no = /^(아니|아뇨|노|no|없어요?|안)/.test(t);
        const go = /(다음|넘어가|넘어갈|계속|끝|정리|준비|됐어|됐음|시작)/.test(t);
        if (no)
            return L.find((c) => /아니|없어/.test(c.label)) || null;
        if (yes)
            return L.find((c) => c.cta) || L.find((c) => /^네|맞아|이대로|응/.test(c.label)) || L[0];
        if (go)
            return L.find((c) => c.cta) || L.find((c) => !c.ghost) || null;
        const norm = (x) => x.replace(/[\s,.·]+/g, '').toLowerCase();
        // 라벨 낱말 맞춤 — 회색 칩(건너뛰기·직접 적기)도 글로 부를 수 있어야 한다
        const exact = L.find((c) => norm(c.label) === t || norm(c.label).includes(t));
        if (exact)
            return exact;
        const hit = L.filter((c) => !c.ghost).find((c) => t.includes(norm(c.label).slice(0, 4)));
        return hit || null;
    }
    function fineRow(text) { const el = document.createElement('div'); el.className = 'ob-fine'; el.textContent = text; $('#thread').appendChild(el); scrollChat(); return el; }
    function scrollChat() { const c = $('.ob-chat'); c.scrollTop = c.scrollHeight; }
    /* 아래 입력창 — 지금 받는 자유 입력이 있으면 그리로, 없으면 부드럽게 안내 */
    let freeHandler = null;
    function armCompose(placeholder, fn) { freeHandler = fn; $('#composeIn').placeholder = placeholder || '직접 적으셔도 됩니다'; $('#composeIn').focus(); }
    function composeSend() {
        const inp = $('#composeIn');
        const v = inp.value.trim();
        if (!v)
            return;
        inp.value = '';
        msgUser(v);
        if (freeHandler) {
            const fn = freeHandler;
            freeHandler = null;
            fn(v);
            return;
        }
        const hit = matchChip(v);
        if (hit) {
            hit.fire();
            return;
        }
        S.notes.push(v);
        save();
        if (pendingChips)
            msgLiv(`적어 두었어요. 지금 질문은 위 보기에서 골라 주시면 돼요. 적어 주신 건 기억해 뒀다가 설정에 반영합니다.`); /* [새문구] */
        else
            msgLiv(`적어 두었어요.`);
    }
    /* 읽기 진행 — 사이드바 서랍 숫자가 실시간으로 올라간다 */
    let readTimer = null, readBarEl = null, readNEl = null;
    function startReading() {
        if (!S.read.total)
            S.read.total = 41;
        if (S.read.finished)
            return;
        clearInterval(readTimer);
        const targets = drawerTargets();
        readTimer = setInterval(() => {
            S.read.done = Math.min(S.read.total, S.read.done + 1);
            const p = S.read.done / S.read.total;
            S._counts = {};
            let shown = 0;
            DATA.KINDS7.forEach(([k]) => { const c = Math.round((targets[k] || 0) * p); S._counts[k] = c || ''; shown += c; });
            const sub = $('#sb .v2-ss .sub');
            if (sub && /^자료 읽는 중/.test(sub.textContent))
                sub.textContent = `자료 읽는 중 ${S.read.done}/${S.read.total}`;
            if (readBarEl)
                readBarEl.style.width = Math.round(p * 100) + '%';
            if (readNEl)
                readNEl.textContent = `${S.read.done} / ${S.read.total}`;
            if (S.read.done >= S.read.total) {
                S.read.finished = true;
                save();
                clearInterval(readTimer);
                renderSB();
                document.dispatchEvent(new Event('read-done'));
            }
            save();
        }, 240);
    }
    const CHAT_STEPS = ['b1', 'b2', 'b3', 'nowline', 'can', 'done'];
    async function chatStep(step, token) {
        if (token !== seqToken)
            return;
        const doneStep = (s) => { if (!S.chatDone.includes(s))
            S.chatDone.push(s); save(); renderSB(); };
        if (step === 'b1') {
            await sleep(500);
            msgLiv(`${S.read.finished ? '' : `읽으면서 `}${esc(nick() || '')}${nick() ? '님' : ''} 자료를 종류별로 세어 봤어요.
        <div class="ob-tags">${tally3().map(([n, c]) => `<span class="ob-tag">${esc(n)} <b>${c}</b></span>`).join('')}</div>
        <p style="margin-top:8px"><b>자료함을 이렇게 나눠 둘까요?</b> 옆의 숫자는 그 종류로 본 자료 수예요. 이대로 서랍을 만들어 두면 다음부터 새 자료가 알아서 제자리로 들어갑니다.</p>`);
            await sleep(300);
            chipsRow([
                { label: '네, 이대로 나눠 주세요', cta: true, cb: (l) => { msgUser(l); S.drawersOn = true; S.decisions.push(`자료함 7갈래로 나눔`); doneStep('b1'); renderSB(); chatStep('b2', token); } },
                { label: '빠진 종류가 있어요', cb: (l) => {
                        msgUser(l);
                        msgLiv('어떤 종류인가요? 아래 입력창에 적어 주세요. 서랍을 하나 더 만들어 둘게요.'); /* [새문구] */
                        armCompose('예: 고객 인터뷰', (v) => {
                            S.drawersOn = true;
                            S.decisions.push(`갈래 추가: ${v}`);
                            doneStep('b1');
                            renderSB();
                            msgLiv(`<b>${esc(v)}</b> 서랍을 더해 뒀어요.`);
                            chatStep('b2', token);
                        });
                    } },
            ]);
        }
        if (step === 'b2') {
            await sleep(600);
            msgLiv(`같은 양식 문서가 여러 달치 있네요. ${esc(fileOf(0) || '보고서')} 같은 것들이요.<p style="margin-top:6px"><b>정해진 주기로 만드시거나 만들고 싶으신 문서가 있나요?</b> 주기가 있으면 다음 것을 미리 만들어 둘 수 있습니다.</p>`);
            await sleep(300);
            const pickB2 = (id, label) => { msgUser(label); S.b2 = id; if (id !== 'no')
                S.decisions.push(id === 'month' ? '매달 반복 작업으로 봄' : '매주 반복 작업으로 봄'); doneStep('b2'); chatStep('b3', token); };
            chipsRow([
                { label: '네, 매달', cb: () => pickB2('month', '네, 매달') },
                { label: '네, 매주', cb: () => pickB2('week', '네, 매주') },
                { label: '아니요', ghost: true, cb: () => pickB2('no', '아니요') },
            ]);
        }
        if (step === 'b3') {
            await sleep(600);
            msgLiv(`문서에 같은 이름이 반복해서 나와요.<p style="margin-top:6px"><b>같이 보는 팀이 있나요?</b> 있으면 팀이 볼 것과 나만 볼 것을 갈라 둡니다.</p>`);
            await sleep(300);
            const pickB3 = (id, label, dec) => { msgUser(label); S.b3 = id; S.decisions.push(dec); doneStep('b3'); renderSB(); chatStep('nowline', token); };
            chipsRow([
                { label: '나만 봐요', cb: () => pickB3('me', '나만 봐요', '나만 보는 자료로 봄') },
                { label: '우리 팀이 같이 봐요', cb: () => pickB3('team', '우리 팀이 같이 봐요', '팀과 함께 보는 자료로 봄') },
                { label: '회사의 여러 부서와 나눠요', cb: () => pickB3('dept', '회사의 여러 부서와 나눠요', '여러 부서와 나누는 자료로 봄') },
                { label: '고객·외부에 냅니다', cb: () => pickB3('ext', '고객·외부에 냅니다', '고객·외부로 나가는 자료로 봄') },
            ]);
        }
        if (step === 'nowline') {
            await sleep(600);
            msgLiv(`마지막 하나예요.<p style="margin-top:6px"><b>평소에 시간을 가장 많이 쓰시는 일은 무엇인가요?</b> 한 주를 놓고 볼 때 제일 자주, 제일 오래 붙잡고 계신 일이요. 여기부터 제가 손을 보탭니다.</p>`);
            await sleep(300);
            const pickNow = (label) => { msgUser(label); S.nowline = label; S.decisions.push(`시간을 가장 많이 쓰는 일: ${label}`); doneStep('nowline'); waitRead(token); };
            chipsRow(DATA.NOW_KINDS.map((t) => ({ label: t, cb: () => pickNow(t) }))
                .concat([{ label: '직접 적을게요', ghost: true, cb: () => {
                        msgUser('직접 적을게요');
                        msgLiv('아래 입력창에 한 줄로 적어 주세요.'); /* [새문구] */
                        armCompose('예: 매주 실적 자료 만드는 일', (v) => { S.nowline = v; S.decisions.push(`시간을 가장 많이 쓰는 일: ${v}`); doneStep('nowline'); waitRead(token); });
                    } }, { label: '지금은 건너뛰기', ghost: true, cb: () => { msgUser('지금은 건너뛰기'); doneStep('nowline'); waitRead(token); } }]));
        }
        if (step === 'can') {
            await sleep(500);
            const C = canOf();
            msgLiv(`다 읽었어요.${S.nowline ? ` <b>${esc(S.nowline)}</b>에 시간을 제일 많이 쓰신다고 하셨죠.` : (nick() ? ` ${esc(nick())}님이 하시는 일이라면,` : '')}
        <p style="margin-top:6px"><b>이런 것까지 저한테 맡기실 수 있어요.</b> 보통은 몇 번씩 왔다 갔다 해야 하는 일이에요. 여기서는 한 문장이면 됩니다.</p>
        <div class="ob-excard" data-ex="0"><div class="ob-xt">“${esc(C[0][0])}”</div><div class="ob-xd"><b>보통은</b> ${esc(C[0][1])}</div></div>
        <div class="ob-excard" data-ex="1"><div class="ob-xt">“${esc(C[1][1])}”</div><div class="ob-xd"><b>${esc(C[1][0])} 쪽도</b> 이런 것까지 이어서 물으실 수 있어요.</div></div>`);
            $$('.ob-excard').forEach((c) => c.onclick = () => {
                if (c.dataset.taken)
                    return;
                c.dataset.taken = '1';
                const t = $('.ob-xt', c).textContent.replace(/^“|”$/g, '');
                msgUser(t);
                S.firstOrder = t;
                S.decisions.push(`첫 지시: ${t.slice(0, 40)}…`);
                save();
                renderSB();
                msgLiv('이 문장으로 세션을 하나 열어 뒀어요. 왼쪽에 보이죠? 온보딩이 끝나면 바로 시작됩니다. 다 됐으면 아래 <b>준비 끝, 정리해 주세요</b>를 눌러 주세요.'); /* [새문구] */
            });
            await sleep(400);
            chipsRow([{ label: '준비 끝, 정리해 주세요', cta: true, cb: (l) => { msgUser(l); doneStep('can'); chatStep('done', token); } }]);
            fineRow('지금 시키지 않으셔도 됩니다. 홈에서 언제든 그대로 말씀하시면 돼요.');
        }
        if (step === 'done') {
            await sleep(600);
            msgLiv(`정리했어요. 지금까지 정해 주신 것들이에요.
        <div class="ob-tags" style="margin-top:8px">${S.decisions.slice(0, 8).map((d) => `<span class="ob-tag">${esc(d)}</span>`).join('')}</div>
        <p style="margin-top:10px">자료 <b>${S.read.total}건</b>이 서랍 <b>7개</b>에 정리돼 있고, 새 자료는 이제 알아서 제자리로 갑니다.</p>
        <p>이제부터는 <b>아래 입력창에 그대로 말씀하시면 됩니다.</b> 제가 자료를 들고 움직일게요.</p>`); /* [새문구] 요약 연결부 */
            S.scene = 'done';
            save();
            renderSB();
            try {
                localStorage.setItem(DONE_KEY, '1');
            }
            catch (e) { }
            ctx.onDone && ctx.onDone();
            armCompose('여기에 그대로 말씀하시면 됩니다', (v) => { S.notes.push(v); save(); msgLiv('네. 실제 서비스에서는 여기서 바로 시작됩니다. 프로토타입은 여기까지예요.'); });
            await sleep(300);
            chipsRow([{ label: '처음부터 다시 보기', ghost: true, cb: () => { sessionStorage.removeItem(KEY); localStorage.removeItem(DONE_KEY); location.reload(); } }]);
        }
    }
    function waitRead(token) {
        if (S.read.finished) {
            chatStep('can', token);
            return;
        }
        const m = msgLiv(`<div class="ob-readline"><span>자료를 읽고 있어요.</span><span class="ob-readbar"><i></i></span><span id="readN">${S.read.done} / ${S.read.total}</span></div>`); /* [새문구] 읽기+사이드바 연결 */
        readBarEl = $('.ob-readbar i', m);
        readNEl = $('#readN', m);
        readBarEl.style.width = Math.round(100 * S.read.done / Math.max(1, S.read.total)) + '%';
        document.addEventListener('read-done', () => { setTimeout(() => chatStep('can', token), 400); }, { once: true });
    }
    /* 채팅 시작(read 장면) — 노션 p5의 첫 인사에 대응 */
    async function enterChat(token) {
        setStage('stage-chat');
        $('#thread').innerHTML = '';
        if (!S.read.total)
            S.read.total = 41;
        startReading();
        await sleep(300);
        msgLiv(`${nick() ? esc(nick()) + '님, ' : ''}연결까지 끝났어요.<p style="margin-top:6px">지금 자료 <b>${S.read.total}건</b>을 읽고 있어요. 읽는 동안 몇 가지만 확인할게요.</p>`); /* [새문구] 채팅 도입부 */
        chatStep('b1', token);
    }
    /* ══════════════ 장면 전환 ══════════════ */
    function renderScene(key, animate) {
        const sc = SCENES[key];
        if (!sc)
            return;
        setStage(key === 'name' ? 'stage-name' : 'stage-q');
        const col = $('#qcol');
        col.style.animation = 'none';
        if (animate !== false) {
            void col.offsetWidth;
            col.style.animation = '';
        }
        col.classList.toggle('ob-wide', key === 'sources');
        col.innerHTML = sc.html();
        sc.bind && sc.bind(col);
    }
    function goScene(key) {
        S.scene = key;
        save();
        renderSB();
        seqToken++;
        if (STEP_OF[key] >= CHAT_FROM) {
            replayChatTo(key, seqToken);
        }
        else {
            renderScene(key, true);
        }
    }
    /* 채팅 단계로 점프·복원 — 앞 단계 문답을 압축해 깔아 놓고 그 단계부터 산다 */
    function replayChatTo(key, token) {
        setStage('stage-chat');
        $('#thread').innerHTML = '';
        // 막2 답이 비어 있으면 기본값으로 채움 (장면 점프용)
        if (!S.nameSet) {
            S.name = '원준';
            S.nameSet = true;
        }
        S.stage = S.stage || 'company';
        S.job = S.job || stageOf().opts[1][0];
        if (!S.sources.length)
            S.sources = ['gdrive', 'notion'];
        if (!S.connected.length)
            S.connected = S.sources.filter((x) => x !== 'none');
        S.ai = S.ai || 'Claude';
        S.aiConnected = S.ai !== '아직 없어요';
        S.terminal = S.terminal || 'no';
        S.app = S.app || 'web';
        if (!S.read.total)
            S.read.total = 41;
        const past = [];
        const target = key === 'read' ? 'b1' : key;
        const upto = CHAT_STEPS.indexOf(target);
        if (key !== 'read' && upto > 0) {
            // 지나간 단계들을 요약 문답으로 재생
            if (upto > CHAT_STEPS.indexOf('b1')) {
                past.push([`자료함을 이렇게 나눠 둘까요?`, '네, 이대로 나눠 주세요']);
                S.drawersOn = true;
            }
            if (upto > CHAT_STEPS.indexOf('b2'))
                past.push([`정해진 주기로 만드시거나 만들고 싶으신 문서가 있나요?`, S.b2 === 'week' ? '네, 매주' : S.b2 === 'no' ? '아니요' : '네, 매달']);
            if (upto > CHAT_STEPS.indexOf('b3'))
                past.push([`같이 보는 팀이 있나요?`, S.b3 === 'me' ? '나만 봐요' : '우리 팀이 같이 봐요']), S.b3 = S.b3 || 'team';
            if (upto > CHAT_STEPS.indexOf('nowline')) {
                S.nowline = S.nowline || DATA.NOW_KINDS[2];
                past.push([`평소에 시간을 가장 많이 쓰시는 일은 무엇인가요?`, S.nowline]);
            }
            if (upto > CHAT_STEPS.indexOf('can'))
                past.push([`이런 것까지 저한테 맡기실 수 있어요.`, '준비 끝, 정리해 주세요']);
            Object.assign(S.read, { done: S.read.total, finished: true });
            const targets = drawerTargets();
            S._counts = {};
            DATA.KINDS7.forEach(([k]) => { S._counts[k] = targets[k] || ''; });
        }
        save();
        renderSB();
        if (key === 'read') {
            enterChat(token);
            return;
        }
        past.forEach(([q, a]) => { msgLiv(`<b>${esc(q)}</b>`); msgUser(a); });
        if (!S.read.finished)
            startReading();
        chatStep(target, token);
    }
    /* ── 부팅 ── */
    $('#composeGo').onclick = composeSend;
    $('#composeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing)
        composeSend(); });
    // 장면 바로 열기 — 셸에선 질의가 해시 뒤에 붙는다(#/welcome?scene=b1). 검토용.
    const want = new URLSearchParams(location.search).get('scene') || new URLSearchParams((location.hash.split('?')[1] || '')).get('scene');
    if (want && STEP_OF[want] != null) {
        goScene(want);
    }
    else {
        renderSB();
        goScene(S.scene || 'name');
    }
    return { destroy() { clearInterval(readTimer); clearTimeout(toastT); ctx.onBare && ctx.onBare(false); } };
}
