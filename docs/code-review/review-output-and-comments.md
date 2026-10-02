# 리뷰 출력에서 Bitbucket 댓글까지

Claude 응답은 청크 하나의 리뷰 JSON입니다. 서비스는 이를 내부 데이터로 정리한 뒤 모든 청크 결과를 병합하고, 인라인 의견과 최상위 요약을 각각 댓글 API에 보냅니다.

## 1. 출력 JSON

[`시스템 프롬프트`](../../src/prompts/codeReview.ts)는 아래 구조의 JSON만 출력하도록 요청합니다. 이 예제는 `src/users.ts:10`에 필수 인자를 추가했지만 master의 `src/profile.ts:6` 호출은 그대로인 가상 상황입니다.

```json
{
  "changeSummary": "사용자 조회 함수에 필수 인자 tenantId를 추가했습니다.",
  "flowRisks": [
    "기존 호출자가 변경된 함수 시그니처에 맞게 수정되지 않았습니다."
  ],
  "testPoints": [
    "loadProfile 호출 경로에서 tenantId를 전달하도록 수정하고 타입 검사를 실행하세요."
  ],
  "comments": [
    {
      "file": "src/users.ts",
      "line": 10,
      "lineType": "ADDED",
      "severity": "P2",
      "text": "🟠 필수 tenantId 인자가 추가됐지만 src/profile.ts:6에서는 id만 전달해 타입 검사가 실패합니다. 호출부에도 tenantId를 전달하도록 수정해 주세요."
    }
  ]
}
```

| 필드 | 사용하는 곳 |
|---|---|
| `changeSummary` | 최상위 댓글의 변경 요약 |
| `flowRisks` | 최상위 댓글의 흐름상 체크할 점 |
| `testPoints` | 최상위 댓글의 머지 전 확인 포인트 |
| `comments` | 특정 변경 라인의 인라인 댓글 |

청크별 프롬프트는 `flowRisks`와 `testPoints` 각각 최대 3개, 인라인 의견 최대 5개, 의견 본문 200자 이내를 요구합니다. 이는 모델 지시입니다. 서버가 이 개수와 길이를 강제로 자르지는 않습니다. 여러 청크를 병합하면 의견 합계가 5개를 넘을 수 있습니다.

## 2. 파싱과 정규화

[`codeReview.ts`](../../src/services/codeReview/codeReview.ts)는 SDK의 최종 Message에서 `type: 'text'` 블록만 합칩니다. thinking 등의 다른 블록은 리뷰 JSON으로 사용하지 않습니다. 응답이 ` ```json `으로 감싸져 있으면 내부 문자열을 꺼내 `JSON.parse()`합니다.

[`normalizeReviewData()`](../../src/services/codeReview/reviewOutput.ts)는 다음 규칙으로 결과를 정리합니다.

- 새 `changeSummary`를 우선 사용하고 없으면 레거시 `summary`를 사용합니다. 둘 다 없으면 기본 요약을 넣습니다.
- `flowRisks`와 `testPoints`는 비어 있지 않은 문자열만 남깁니다.
- `comments`는 배열이며 항목의 `lineType`이 `ADDED` 또는 `REMOVED`인 경우만 남깁니다.

현재 정규화는 모든 필드의 파일 경로, 숫자 라인, 심각도까지 검증하는 엄격한 JSON 스키마 검사는 아닙니다. 자동 리뷰의 위치 검증과 혼동하지 않아야 합니다.

JSON 파싱에 실패하면 원문을 PR에 그대로 노출하지 않습니다. 파싱 실패 또는 출력 잘림 안내 요약과 `comments: []`로 대체합니다. 잘림 추정은 파싱 실패 경로에서 `stop_reason === 'max_tokens'`와 닫히지 않은 JSON 등을 확인합니다. 파싱 가능한 JSON이면 이 함수는 `isOutputTruncated: false`를 반환합니다.

## 3. 청크 결과 병합

`mergeChunkReviewData()`는 추가 Claude 호출 없이 결과를 합칩니다. 하나의 청크면 그 결과를 그대로 사용합니다. 여러 청크면:

| 내용 | 병합 방식 |
|---|---|
| 요약 | 같은 문자열은 한 번만 남기고 문단으로 연결 |
| 리스크와 확인 포인트 | 청크 순서대로 연결 |
| 인라인 의견 | `file:line:lineType` 중복 제거, 먼저 나온 의견 유지 |

이 병합은 청크 사이의 의미를 다시 분석하는 종합 리뷰가 아닙니다. 서로 다른 청크의 코드 전체를 Claude가 한 번에 다시 읽는 단계는 없습니다.

## 4. 게시 전 중복 제거와 위치 검증

[`prReview.ts`](../../src/services/codeReview/prReview.ts)는 Bitbucket `/activities?limit=100`을 다시 조회합니다. 봇 작성자의 기존 anchor에서 `path:line:lineType`을 모으고 같은 위치의 새 의견을 제외합니다. 본문이 달라도 위치가 같으면 제외합니다.

| 단계 | 자동 리뷰 | 수동 재리뷰 |
|---|---|---|
| 청크 결과의 같은 위치 의견 병합 | 적용 | 적용 |
| 기존 봇 댓글과 같은 위치 제외 | 적용 | 적용 |
| 실제 diff ADD/REM 위치 대조 | 비활성 | 활성 |

수동 재리뷰의 [`verifyComments()`](../../src/services/codeReview/commentVerifier.ts)는 실제 diff의 유효 위치 집합과 의견의 키를 대조합니다. 검증에서 제외한 개수는 최종 댓글에 안내하며 Claude를 재호출하지 않습니다.

## 5. 인라인 댓글 API

`comments` 배열을 순회하며 [`postInlineComment()`](../../src/services/bitbucket/index.ts)를 호출합니다. 위 JSON 의견은 아래 요청으로 바뀝니다.

```http
POST PR_BASE/{id}/comments
```

```json
{
  "text": "🟠 필수 tenantId 인자가 추가됐지만 src/profile.ts:6에서는 id만 전달해 타입 검사가 실패합니다. 호출부에도 tenantId를 전달하도록 수정해 주세요.",
  "anchor": {
    "line": 10,
    "lineType": "ADDED",
    "fileType": "TO",
    "path": "src/users.ts"
  }
}
```

`file`은 `anchor.path`, `line`과 `lineType`은 같은 이름의 anchor 필드로 옮깁니다. `REMOVED`는 `fileType: 'FROM'`, 그 외는 `'TO'`입니다. 댓글 본문에는 master 호출부 `src/profile.ts:6`을 인용하지만 anchor는 변경된 정의 파일의 10번째 줄입니다.

`severity`는 API 본문에 별도 필드로 보내지 않습니다. 프롬프트는 P1=🔴, P2=🟠, P3=🟡, P4=🔵, P5=💬를 요구합니다. 이 경로는 승인이나 반려 상태를 바꾸는 API를 호출하지 않습니다.

## 6. 최상위 댓글과 Slack 요약

`postPRComment()`는 같은 `/comments` API에 `{ "text": "..." }`만 보냅니다. anchor가 없으므로 PR 최상위 댓글입니다. 자동 리뷰의 기본 구성은 다음과 같습니다.

```text
🤖 AI Code Review

변경 요약                 ← changeSummary
흐름상 체크할 점           ← flowRisks, 값이 있을 때
머지 전 확인 포인트        ← testPoints, 값이 있을 때
호출부 확인 / 자동 확인 제한 ← CRG에서 계산한 참조 안내
인라인 의견 개수와 처리 안내 ← 서비스가 구성
```

CRG 안내는 모델 JSON에 포함된 결과가 아니라 서비스가 미리 계산한 Markdown입니다. 수동 재리뷰는 `🤖 AI Re-Review` 시그니처와 해당 라우터의 문구를 사용합니다.

최종 댓글 게시 후 자동 리뷰와 `/pr/comment` 재리뷰는 QA Slack에 변경 요약과 첫 리스크, 첫 확인 포인트를 보냅니다. `/pr/reviewers` 재리뷰는 요약 전송을 생략합니다. 댓글 게시 실패와 완료 시그니처의 예외는 [실패 처리](limits-and-failure-handling.md)에 정리했습니다.

[문서 목차](README.md) · [다음: 제한과 실패 처리](limits-and-failure-handling.md)
