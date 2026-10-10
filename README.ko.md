# Notework AI 한국어 빠른 시작

선택한 Obsidian 노트에 질문하고 **Source notes**에서 원문을 열어 답변의 근거를 확인합니다. 화면의 메뉴와 버튼은 영어이며, 노트와 질문에는 한국어를 사용할 수 있습니다.

[공식 Community Plugins에서 설치](https://community.obsidian.md/plugins/notework-ai) · [영문 안내](README.md) · [상세 시작 안내](docs/getting-started.md)

**0.4.8 alpha · 데스크톱 전용 · Obsidian 1.11.4 이상.** 모바일은 개발 중이며 현재 비활성화되어 있습니다.

## 설치와 답변 연결

1. 공식 설치 페이지에서 **Add to Obsidian**을 선택한 다음 **Notework AI**를 설치하고 활성화합니다. 수동 설치가 필요하면 [영문 설치 안내](README.md#installation-and-first-use)의 같은 버전 파일 세 개를 사용합니다.
2. **Settings → Notework AI → Setup**에서 답변 연결을 준비합니다. 별도로 설치한 공식 Codex 또는 Claude Code 로그인, 본인 API 키, 로컬 Ollama chat 중 사용할 경로를 선택합니다. Notework가 외부 도구를 대신 설치하지 않습니다.
3. 이미 답변 연결이 준비되어 있다면 그대로 사용합니다. **Connected**는 인증과 모델 목록 확인 상태이며, 남은 사용량이나 다음 답변의 성공을 보장하지 않습니다.

## 가상 노트 세 개로 첫 질문

[예제 폴더](docs/examples/first-question/)의 아래 파일 내용을 새 vault 폴더 `Notework First Question`에 Markdown 노트로 저장합니다. 실제 업무 자료가 아닌, 날짜와 인물·작업을 모두 지어낸 예제입니다.

- [01-pilot-brief.md](docs/examples/first-question/01-pilot-brief.md): 처음 작성한 파일럿 계획.
- [02-pilot-decisions.md](docs/examples/first-question/02-pilot-decisions.md): 나중에 변경한 검토 날짜와 이유.
- [03-pilot-checklist.md](docs/examples/first-question/03-pilot-checklist.md): 아직 남은 작업과 미정 사항.

**Settings → Notework AI → Scope**에서 이번 체험에는 이 폴더만 선택하고 **Apply scope**를 누릅니다. 기존 태그 조건과 제외 설정이 예제를 걸러내지 않는지도 확인합니다.

**Build → Build settings**에서 **Retrieval route → Keyword search**, **Category, hierarchy and relation analysis → Local structure only**를 선택하고 **Build knowledge**를 실행합니다. 저장이 끝날 때까지 기다립니다. 이 검색·구조 경로에는 embedding 모델 다운로드나 Jev 키가 필요하지 않습니다. 답변 생성에는 앞서 준비한 AI 연결이 필요합니다.

**Notework AI: Open Notework**를 실행합니다. 예제는 영문 노트이므로 첫 질문은 다음 문구를 그대로 넣고 **Send question**을 누릅니다.

> What is the Harbor pilot review date, why did it change, and what must be ready before the review? Cite the notes and say what is still undecided.

## 답변보다 원문을 먼저 확인하기

**Source notes → Inspect retrieved excerpt**에서 사용한 발췌문을 보고, 노트 경로 버튼으로 원문을 엽니다. **Retrieval details**에서는 검색 경로, 일치한 문단과 유효 출처, 적용된 범위 조건을 확인합니다.

원문에서 확인할 내용은 다음과 같습니다.

- `01-pilot-brief → Original plan`: 처음 검토 날짜는 **2026년 11월 13일**입니다.
- `02-pilot-decisions → Review-date decision`: 피드백 수집 후 요약을 검토하기 위해 **11월 16일**로 변경했습니다.
- `03-pilot-checklist → Open tasks / Not yet decided`: 피드백 열 건 수집과 Mira의 요약 전달은 아직 할 일이며, 확대 시행 날짜는 승인되지 않았습니다.

이는 제공한 가상 원문을 읽고 확인한 기준입니다. 실제 AI 답변 실행 결과를 제공하거나 성공을 보장하는 예제가 아닙니다. 출처가 빠졌거나 답변과 원문이 다르면 범위와 구축 완료 상태를 확인하고, 노트를 고친 경우 다시 구축합니다.

## 비용·보안·다음 단계

플러그인 사용료는 없지만 구독 사용량과 API 과금은 별개입니다. 답변이 완료되면 같은 답변 모델로 대화 구조화 요청이 추가됩니다. Jev는 구축 중 분류·계층·관계 분석을 위한 선택 사항이며 별도 키와 공급자 사용량이 적용됩니다.

클라우드 답변에는 질문, 관련 발췌문과 노트 경로, 허용된 대화 이력, 명시적으로 첨부한 텍스트가 전달됩니다. 키는 vault 로컬 **Obsidian SecretStorage**를 사용하며 OS 키체인이 아닙니다. 색인에는 암호화되지 않은 발췌문과 벡터가 포함됩니다. 민감한 노트를 선택하기 전에 [보안 안내](SECURITY.md)와 [연결·비용 안내](docs/provider-boundaries.md)를 읽습니다.

첫 질문을 확인한 뒤에는 자신의 작은 노트 폴더로 범위를 바꾸고 **Show knowledge graph**에서 연결을 탐색할 수 있습니다. local knowledge, RAG, 선택적 Jev 분석과 ontology-style organization의 차이는 [영문 README](README.md#from-local-knowledge-to-insights)에 설명되어 있습니다.
