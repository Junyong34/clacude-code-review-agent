---
status: accepted
---

> 이 문서는 결정 당시의 배경 기록입니다. 현재 실행 방법과 수치는 [README](../../README.md) 및 [개발 가이드](../ai-code-review-pr-flow.md)를 기준으로 합니다.

# AI 코드리뷰 Claude 호출을 Batch 대신 Streaming으로 전환

ADR-0001에서 Message Batches API 전면 전환을 결정했으나, 재검토 결과 실시간성 손실(최대 24시간 SLA, 작은 PR도 비동기 대기)이 감수할 수 없는 리스크로 판단되어 Streaming(`stream: true`)으로 방향을 바꾼다.

`@anthropic-ai/sdk`의 `fetchWithTimeout()`(`client.ts:795`)은 `fetch()` Promise가 resolve되는 즉시 클라이언트 타임아웃 타이머를 해제한다. Non-streaming 호출은 Anthropic 서버가 전체 응답을 완성할 때까지 응답을 시작하지 않아 `timeout`(현재 600,000ms)이 "생성 완료까지 전체 시간"에 적용되지만, streaming 호출은 서버가 `message_start`를 거의 즉시 보내 `fetch()`가 빠르게 resolve되고, 이후 SSE 조각을 읽는 과정에는 별도의 idle timeout 로직이 없다(SDK 소스 확인). 즉 streaming은 지금 겪는 "600초 초과로 강제 종료" 실패 모드를 실질적으로 없앤다.

단, streaming은 다음 두 가지는 해결하지 못한다 — 이후 작업 계획에서 별도로 다뤄야 한다:

- diff가 모델 컨텍스트 윈도우를 초과하면 `400 invalid_request_error`가 발생 (streaming 여부와 무관)
- `MAX_OUTPUT_TOKENS`(4096) 한도로 인한 출력 잘림 (streaming은 잘리는 과정을 실시간으로 볼 수 있게 할 뿐, 잘림 자체를 막지 못함)

## Consequences

- ADR-0001에서 전제했던 polling/batch 상태 관리 인프라는 불필요해진다.
- diff 크기를 제한하지 않는 현재 설계(`noLimit: true`)의 컨텍스트 초과·출력 잘림 위험은 이 결정과 별개로 남아있다.
