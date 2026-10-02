# CRG가 보완하는 리뷰 맥락

diff에는 이번 PR에서 바뀐 코드와 주변 문맥이 들어 있습니다. 변경된 함수를 다른 파일에서 어떻게 쓰는지는 그 파일이 PR에 포함되지 않으면 보이지 않습니다. CRG의 참조 관계와 master 호출부 코드를 추가하면 Claude가 새 계약과 기존 사용 방식을 함께 읽을 수 있습니다.

## 참조 관계, 인터페이스 판정, 리뷰 판단

| 담당 | 하는 일 |
|---|---|
| CRG CLI | master 소스의 심볼과 관계를 분석해 SQLite 그래프 생성 |
| 리뷰 서비스 | 그래프에서 참조 조회, 변경 전후 인터페이스 판정, 호출부 파일 읽기 |
| Claude | diff와 제공된 증거에서 구체적인 문제를 판단하고 리뷰 작성 |

CRG 자체가 모든 호출의 정상 여부를 검증하거나 리뷰 문장을 만드는 것은 아닙니다. 서비스는 외부 CLI를 실행하고 DB를 직접 읽습니다. CRG MCP 서버나 Claude의 파일 탐색 도구는 이 경로에서 사용하지 않습니다.

## 1. master 소스와 그래프 준비

[`ensureMasterWorktreeReady()`](../../src/services/contextClone/index.ts)는 다음 순서로 로컬 자료를 준비합니다.

1. 운영자가 준비한 컨텍스트 clone에서 `git fetch origin master` 실행
2. 봇 전용 detached 워크트리를 생성하거나 `origin/master`로 갱신
3. `.code-review-graph/graph.db`가 없으면 `build`, 있으면 `update` 실행

원본 clone에는 fetch만 수행합니다. 강제 동기화는 봇 전용 워크트리에서만 합니다. 워크트리와 그래프는 다음 리뷰에서도 재사용합니다. 경로와 CLI 설치는 [CRG 설정 가이드](../crg-symbol-reference.md)를 참고하세요.

## 2. 변경된 함수와 참조하는 쪽 찾기

[`collectChangedBaseLineRanges()`](../../src/services/codeReview/symbolReference.ts)는 삭제 라인의 `source`와 추가 위치 바로 앞뒤 CONTEXT 한 줄씩으로 변경 전 라인 범위를 만듭니다. 넓은 문맥 전체를 변경 범위에 넣지 않습니다. 변경 전 앵커가 없는 순수 삽입은 건너뜁니다.

`findUnupdatedReferenceFiles()`는 이 범위와 겹치는 CRG `Function` 노드를 찾고, 그 심볼을 향하는 `CALLS`와 `REFERENCES` 관계를 조회합니다. 이번 PR에서 변경한 파일은 추가 참조 목록에서 제외합니다.

호출부 위치는 관계의 `source_qualified`를 참조 쪽 노드의 `qualified_name`에 연결해 얻습니다. SQL의 핵심 조건은 다음과 같습니다.

```sql
LEFT JOIN nodes n
  ON n.qualified_name = e.source_qualified
```

참조 쪽 `Function`과 `Test` 노드에서 함수 이름, 파일과 시작·끝 라인을 얻습니다. File/Class 노드는 범위가 넓어 호출부 스니펫 대상으로 쓰지 않습니다. 조인에 필요한 컬럼이 없는 구형 스키마에서는 참조 파일만 조회합니다. 노드 위치를 찾지 못한 참조도 파일 목록에는 남을 수 있습니다.

## 3. 서비스가 인터페이스 변경 판정

[`analyzeChangedSymbolInterface()`](../../src/services/codeReview/interfaceChange.ts)는 master의 변경 전 파일을 읽고 Bitbucket diff를 메모리에서 적용합니다. TypeScript 구문 분석으로 변경 전후 인자, props 등 타입 형태와 반환 계약을 비교합니다. PR 브랜치를 checkout해서 비교하는 방식은 아닙니다.

| 판정 | 처리 |
|---|---|
| `parameter-breaking`, `props-breaking`, `return-breaking`, `return-potentially-breaking` | 참조 안내와 Claude 증거에 포함, 스니펫 우선 수집 |
| `unknown` | 자동 확인이 제한된 항목으로 포함, 남은 예산에서 스니펫 수집 |
| `implementation-only`, `compatible-interface-change` | 참조 안내와 Claude 증거에서 제외 |

master와 diff 기준이 맞지 않거나 함수 대응을 찾지 못하면 `unknown`입니다. 판정은 정적 비교 결과이며 모든 호출자의 실행 결과를 증명하지는 않습니다.

## 4. 호출부를 코드로 읽기

`readCallerSnippet()`은 그래프가 알려준 함수 범위를 master 파일에서 읽고 각 줄에 `N|` 라인 번호를 붙입니다. `attachCallerSnippets()`가 우선순위와 개수·문자 수 상한을 적용합니다. 제한을 넘으면 항목 자체를 지우지 않고 스니펫 없이 남깁니다. [제한 설명](limits-and-failure-handling.md)에 25개 호출부 예제가 있습니다.

## 같은 변경을 두 종류의 정보로 보기

`src/users.ts`의 10번째 줄에서 필수 인자 `tenantId`를 추가했다고 가정합니다. 함수 선언부만 발췌한 예시입니다.

```diff
-export function getUser(id: string) {
+export function getUser(id: string, tenantId: string) {
```

master의 `src/profile.ts` 5~7번째 줄에는 아래 호출이 남아 있습니다. 이 파일은 이번 PR에 포함되지 않았다고 가정합니다.

```ts
export function loadProfile(id: string) {
    return getUser(id);
}
```

`buildSymbolReferenceHintText()`가 만드는 Claude 입력은 다음 형태입니다.

```text
[REF] getUser(src/users.ts) [판정: parameter-breaking] 필수 인자 tenantId가 추가됨 — 참조하지만 이번 PR에서 변경되지 않은 파일: src/profile.ts
[REF-CALLER] src/profile.ts:5-7 loadProfile (master 기준, getUser 사용부)
5| export function loadProfile(id: string) {
6|     return getUser(id);
7| }
[/REF-CALLER]
```

`[REF]`는 판정과 참조 파일 목록, `[REF-CALLER]`는 실제 사용 코드를 담습니다. 예제의 변경 요약 문구는 설명용이며 자동 판정의 실제 문구와 다를 수 있습니다.

파일 이름만 있으면 기존 호출에서 어떤 인자를 전달하는지 알 수 없습니다. 호출부 코드까지 있으면 필수 인자를 추가한 diff와 여전히 인자 하나만 전달하는 사용을 함께 확인할 수 있습니다. 프롬프트는 이 불일치로 실패가 증명되면 P1·P2도 허용합니다. `unknown` 판정은 최대 P5입니다. 이 규칙은 모델에게 주는 지시이며 서버가 등급을 강제로 낮추는 검사는 아닙니다.

의견은 `src/users.ts`의 ADD/REM 라인에 고정하고 `src/profile.ts:6`은 본문 근거로 인용합니다. 호출부의 master 라인 번호를 댓글 anchor로 쓰도록 지시하지 않습니다.

## 사람에게 남기는 CRG 안내

`buildSymbolReferenceMarkdown()`은 스니펫 유무와 관계없이 댓글 대상 참조 파일을 순회해 아래처럼 안내합니다.

```markdown
### 호출부 확인이 필요합니다

- 확인할 파일: `src/profile.ts`
  - `src/users.ts` 파일에서 **getUser 함수**가 변경되었습니다. (변경 내용: 필수 인자 tenantId가 추가됨)
  - 위 함수를 사용하고 있어, 이번 변경이 해당 파일의 동작에 영향을 주는지 확인해 주세요.
```

이 안내는 파일별로 묶으며 실제 결함을 확정한 인라인 지적과 다릅니다. `unknown`은 별도의 자동 확인 제한 섹션에 넣습니다. 스니펫 수집 상한 때문에 참조 파일 목록을 자르지는 않지만 그래프가 찾지 못한 관계까지 포함하지는 않습니다.

CRG는 선택 기능이고 스니펫은 master 기준입니다. 이 구조는 기존 사용 코드를 판단 근거로 추가하지만 전체 호출부 검증과 리뷰 품질 향상을 보장하지 않습니다. 실측 품질 수치는 아직 없습니다.

[문서 목차](README.md) · [다음: Claude 입력과 스트리밍](claude-input-and-streaming.md)
