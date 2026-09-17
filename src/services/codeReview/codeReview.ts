import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, CLAUDE_STREAM_CONCURRENCY, CLAUDE_MODEL } from '../../config/env.js';
import { CODE_REVIEW_SYSTEM_PROMPT } from '../../prompts/codeReview.js';
import { createConcurrencyLimiter } from '../../lib/concurrencyLimiter.js';
import { normalizeReviewData } from './reviewOutput.js';
import { toHttpErrorLike } from '../../types/http.js';
import {
    ANTHROPIC_DIAGNOSTIC_PREFIX,
    createDiagnosticFetch,
    createDiagnosticId,
    formatErrorDiagnostics,
    safeRequestUrl,
} from './anthropicDiagnostics.js';
import type { NormalizedReviewData, ReviewCodeResult } from '../../types/review.js';

type GuardrailMatch = {
    match: string;
    type: string;
};

type GuardrailPolicyErrorOptions = {
    guardrailMatches?: GuardrailMatch[];
    rawMessage?: string;
};

type ParseReviewOptions = {
    stopReason?: string | null;
};

type TextContentBlock = {
    type: 'text';
    text: string;
};

export class GuardrailPolicyError extends Error {
    guardrailMatches: GuardrailMatch[];
    rawMessage: string;

    constructor(message: string, { guardrailMatches = [], rawMessage = '' }: GuardrailPolicyErrorOptions = {}) {
        super(message);
        this.name = 'GuardrailPolicyError';
        this.guardrailMatches = guardrailMatches;
        this.rawMessage = rawMessage;
    }
}

/**
 * LiteLLM 프록시의 예산(budget) 초과로 Claude 호출이 막힌 경우 전용 에러다.
 * 재시도해도 예산이 복구되기 전까지는 계속 실패하므로, 상위 리뷰 플로우가 일반 실패와 다르게
 * (CRG 결과만 게시하는 등) 처리할 수 있게 구분한다.
 */
export class ClaudeBudgetExceededError extends Error {
    rawMessage: string;

    constructor(message: string, rawMessage = '') {
        super(message);
        this.name = 'ClaudeBudgetExceededError';
        this.rawMessage = rawMessage;
    }
}

/**
 * Claude/Anthropic guardrail 에러 메시지에서 탐지된 match/type 정보를 추출한다.
 * SDK가 구조화된 필드를 주지 않는 경우가 있어 메시지 문자열을 방어적으로 파싱한다.
 */
const parseGuardrailMatches = (errorMessage: string): GuardrailMatch[] => {
    const matchValues = [...errorMessage.matchAll(/'match':\s*'([^']+)'/g)].map(m => m[1]);
    const typeValues  = [...errorMessage.matchAll(/'type':\s*'([^']+)'/g)].map(m => m[1]);
    return matchValues.map((match, i) => ({ match, type: typeValues[i] ?? 'UNKNOWN' }));
};

const MAX_OUTPUT_TOKENS = 8192;
const MODEL = CLAUDE_MODEL;

const client = new Anthropic({
    apiKey: ANTHROPIC_API_KEY,
    // 스트리밍 호출에서는 fetch()가 message_start 수신 즉시 resolve되므로, 이 timeout은
    // 사실상 "커넥션 수립까지"의 상한으로만 작동한다. 생성 전체 시간에는 걸리지 않는다.
    timeout: 600_000
});

// Claude 스트림 호출의 전역 동시 실행 상한. PR·청크 구분 없이 모든 reviewCode 호출이 이 리미터를 공유한다.
const claudeStreamLimiter = createConcurrencyLimiter(CLAUDE_STREAM_CONCURRENCY);
const hasEnvironmentVariable = (...names: string[]): boolean => names.some((name) => Boolean(process.env[name]));

const MASK_RULES: Array<{ pattern: RegExp; replacement: string }> = [
    { pattern: /[\w.-]+@[\w.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL]' },
    { pattern: /010[-\s]?\d{4}[-\s]?\d{4}/g, replacement: '[PHONE]' },
    { pattern: /\d{6}[-]\d{7}/g, replacement: '[SSN]' },
    { pattern: /Basic\s+[A-Za-z0-9+/=]{10,}/g, replacement: '[AUTH]' },
    { pattern: /Bearer\s+[A-Za-z0-9\-._~+/=]{10,}/g, replacement: '[TOKEN]' },
    { pattern: /sk-[A-Za-z0-9]{20,}/g, replacement: '[API_KEY]' },
    { pattern: /ATATT[A-Za-z0-9+/=_-]{20,}/g, replacement: '[ATLASSIAN_TOKEN]' },
];

// Bitbucket PR 생성 시 기본으로 채워지는 설명 템플릿의 헤딩과 안내 placeholder 문구다.
// 사용자가 안내 문구를 지우지 않고 그대로 둔 섹션은 실제 작성 내용이 아니므로 리뷰 프롬프트에서 제외한다.
const PR_DESCRIPTION_TEMPLATE_SECTIONS: Array<{ heading: string; placeholder: string }> = [
    { heading: '🛠 변경 내용', placeholder: '이 PR 에서 수행한 변경 사항을 가능하면 목록으로 작성해주세요. 리뷰어에게 도움이 될 것입니다.' },
    { heading: '✨ 변경 사항의 배경', placeholder: '변경 사항과 관련된 이슈나 풀 리퀘스트가 있나요? (있다면 이슈넘버나 링크를 추가해주세요)' },
    { heading: '📑 추가 리뷰 요청 (선택 사항)', placeholder: '리뷰어가 꼭 봐줬으면 하는 부분이 있다면 해당 부분을 정리해주세요.' },
    { heading: '📸 스크린샷 (선택 사항)', placeholder: 'UI 변경 사항이 있다면 이전과 이후의 스크린샷을 제공하세요. 스크린샷은 변경 사항의 시각적인 영향을 리뷰어가 이해하는 데 도움이 될 수 있습니다.' },
];

/**
 * `## 제목` 형태든 맨 텍스트 줄이든 상관없이 헤딩 텍스트만 비교할 수 있게 정규화한다.
 */
const normalizeHeadingLine = (line: string): string => line.replace(/^#+\s*/, '').trim();

// `#`~`######`로 시작하는 마크다운 ATX 헤딩 줄인지 판별한다. 우리가 아는 4개 헤딩이 아니더라도
// 사용자가 템플릿 바깥에 직접 추가한 섹션(예: PR별 리뷰 안내)의 경계를 잡기 위해 사용한다.
const MARKDOWN_HEADING_PATTERN = /^#{1,6}\s+\S/;

/**
 * PR 설명에서 Bitbucket 기본 템플릿의 안내 placeholder가 그대로 남아있는 섹션을 제거하고,
 * 사용자가 실제로 고쳐 쓴 섹션만 남긴다. 알고 있는 템플릿 헤딩이 하나도 없으면 자유 형식 설명으로 보고 그대로 둔다.
 *
 * 템플릿 4개 섹션이 아닌 마크다운 헤딩(예: 사용자가 템플릿 뒤에 직접 붙인 섹션)은 placeholder와 비교할 대상이
 * 없으므로, 비어있지 않으면 항상 사용자가 추가한 내용으로 보고 유지한다. 이렇게 헤딩 단위로 경계를 나눠야
 * 안 고친 마지막 템플릿 섹션의 안내문이 그 뒤에 붙은 실제 내용과 뒤섞여 함께 살아남는 것을 막을 수 있다.
 */
export const extractUserWrittenPrDescription = (description: string): string => {
    const lines = description.split('\n');
    const sectionsByHeading = new Map(PR_DESCRIPTION_TEMPLATE_SECTIONS.map((section) => [section.heading, section.placeholder]));

    const hasKnownHeading = lines.some((line) => sectionsByHeading.has(normalizeHeadingLine(line)));
    if (!hasKnownHeading) return description.trim();

    const keptParts: string[] = [];
    let currentHeading: string | null = null;
    let currentIsKnownSection = false;
    let currentBodyLines: string[] = [];

    const flushCurrentSection = () => {
        const body = currentBodyLines.join('\n').trim();
        if (currentHeading === null) {
            // 첫 헤딩 이전에 사용자가 자유롭게 추가한 내용이 있다면 그대로 보존한다.
            if (body) keptParts.push(body);
            return;
        }
        if (!body) return;

        if (currentIsKnownSection) {
            if (body !== sectionsByHeading.get(currentHeading)) keptParts.push(`${currentHeading}\n${body}`);
        } else {
            keptParts.push(`${currentHeading}\n${body}`);
        }
    };

    for (const line of lines) {
        const normalized = normalizeHeadingLine(line);
        const isKnownHeadingLine = sectionsByHeading.has(normalized);
        const isExtraHeadingLine = !isKnownHeadingLine && MARKDOWN_HEADING_PATTERN.test(line.trim());

        if (isKnownHeadingLine || isExtraHeadingLine) {
            flushCurrentSection();
            currentHeading = normalized;
            currentIsKnownSection = isKnownHeadingLine;
            currentBodyLines = [];
        } else {
            currentBodyLines.push(line);
        }
    }
    flushCurrentSection();

    return keptParts.join('\n\n').trim();
};

/**
 * Claude에 diff를 보내기 전에 개인정보/토큰으로 오탐되기 쉬운 문자열을 마스킹한다.
 * 원문 secret을 로그에 남기지 않고 치환 건수만 출력한다.
 */
const maskSensitiveData = (text: string): string => {
    let masked = text;
    for (const { pattern, replacement } of MASK_RULES) {
        const matches = text.match(pattern);
        if (matches) {
            console.log(`[code-review] 마스킹 적용 ${replacement}: ${matches.length}건`);
        }
        masked = masked.replace(pattern, replacement);
    }
    return masked;
};

/**
 * AI 리뷰에 전달할 diff 본문을 준비한다.
 * 민감정보로 오탐되기 쉬운 문자열을 마스킹한다. 입력 크기는 상위 청크 분할 단계에서 이미 예산 이하로 보장되므로,
 * 여기서 별도 길이 제한은 두지 않는다.
 */
export const prepareDiffForReview = (diffText: string): string => maskSensitiveData(diffText);

/**
 * Anthropic 응답 content 배열에서 text block만 합쳐 리뷰 원문 문자열로 만든다.
 */
const extractTextBlocks = (content: unknown): string => {
    if (!Array.isArray(content)) return '';

    return content
        .filter((block): block is TextContentBlock => {
            return Boolean(block) && typeof block === 'object' && (block as TextContentBlock).type === 'text' && typeof (block as TextContentBlock).text === 'string';
        })
        .map((block) => block.text)
        .join('\n')
        .trim();
};

/**
 * Claude가 JSON fence로 감싸서 응답한 경우 내부 JSON 문자열만 꺼낸다.
 */
const extractJsonString = (raw: string): string => {
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
    return jsonMatch ? jsonMatch[1].trim() : raw.trim();
};

/**
 * JSON 파싱 실패가 단순 형식 오류인지, 출력 토큰 한도 때문에 잘린 응답인지 추정한다.
 */
const isLikelyIncompleteJson = (jsonStr: string): boolean => {
    const text = jsonStr.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) return false;

    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (const char of text) {
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
        } else if (char === '{' || char === '[') {
            stack.push(char);
        } else if (char === '}' || char === ']') {
            const opening = stack.pop();
            if ((char === '}' && opening !== '{') || (char === ']' && opening !== '[')) {
                return false;
            }
        }
    }

    return inString || stack.length > 0;
};

/**
 * Claude 리뷰 응답을 정규화된 리뷰 데이터로 파싱한다.
 * JSON 파싱이 실패해도 PR 코멘트에 원문 JSON을 노출하지 않고 안전한 fallback 요약을 만든다.
 */
export const parseClaudeReviewResponse = (raw: string, options: ParseReviewOptions = {}): {
    reviewData: NormalizedReviewData;
    isOutputTruncated: boolean;
} => {
    const jsonStr = extractJsonString(raw);

    try {
        return {
            reviewData: normalizeReviewData(JSON.parse(jsonStr)),
            isOutputTruncated: false,
        };
    } catch (error) {
        const parsedError = toHttpErrorLike(error);
        const isOutputTruncated = options.stopReason === 'max_tokens' || isLikelyIncompleteJson(jsonStr);
        const changeSummary = isOutputTruncated
            ? 'AI 코드리뷰 응답이 출력 토큰 한도에서 잘려 구조화된 리뷰를 만들 수 없습니다.'
            : 'AI 코드리뷰 응답을 JSON으로 파싱하지 못했습니다.';

        console.error('[code-review] JSON 파싱 실패:', parsedError.message);
        if (isOutputTruncated) {
            console.error('[code-review] Claude 응답이 출력 토큰 한도에서 잘렸을 가능성이 높습니다.');
        }

        return {
            reviewData: normalizeReviewData({
                changeSummary,
                comments: []
            }),
            isOutputTruncated,
        };
    }
};

/**
 * diff 텍스트(청크 하나)를 Claude에 스트리밍으로 보내고, 응답을 리뷰 데이터로 변환한다.
 *
 * 스트리밍(`messages.stream`)을 쓰는 이유는 diff가 커서 생성이 오래 걸려도 클라이언트 타임아웃으로
 * 강제 종료되지 않게 하기 위해서다. finalMessage()로 스트림을 끝까지 누적한 뒤, 기존 non-streaming
 * 응답과 동일한 형태(content/stop_reason)로 파싱한다.
 *
 * 전역 동시성 리미터로 감싸 동시에 열리는 Claude 커넥션 수를 제한한다.
 * guardrail 차단은 전용 에러로 감싸 상위 리뷰 플로우가 Slack 차단 알림을 보낼 수 있게 한다.
 */
export const reviewCode = async (diffText: string, logLabel = '', prDescription?: string, referenceHint?: string): Promise<ReviewCodeResult> => {
    const diff = prepareDiffForReview(diffText);
    const userWrittenDescription = prDescription ? extractUserWrittenPrDescription(prDescription) : '';
    const description = userWrittenDescription ? maskSensitiveData(userWrittenDescription).trim() : '';
    const descriptionSection = description ? `PR 설명:\n${description}\n\n` : '';
    const referenceHintSection = referenceHint ? `${referenceHint}\n\n` : '';
    const tag = logLabel ? `${logLabel} ` : '';
    const diagnosticId = createDiagnosticId();
    const requestClient = client.withOptions({ fetch: createDiagnosticFetch(diagnosticId) });

    console.log(`${ANTHROPIC_DIAGNOSTIC_PREFIX} [${diagnosticId}] 요청 컨텍스트 ${JSON.stringify({
        logLabel: logLabel || null,
        model: MODEL,
        baseUrl: safeRequestUrl(client.baseURL),
        timeoutMs: client.timeout,
        maxRetries: client.maxRetries,
        inputChars: diff.length,
        descriptionChars: description.length,
        referenceHintChars: referenceHint?.length ?? 0,
        apiKeyConfigured: Boolean(ANTHROPIC_API_KEY),
        runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
        },
        networkEnvironment: {
            httpProxyConfigured: hasEnvironmentVariable('HTTP_PROXY', 'http_proxy'),
            httpsProxyConfigured: hasEnvironmentVariable('HTTPS_PROXY', 'https_proxy'),
            allProxyConfigured: hasEnvironmentVariable('ALL_PROXY', 'all_proxy'),
            noProxyConfigured: hasEnvironmentVariable('NO_PROXY', 'no_proxy'),
            nodeTlsRejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? 'default',
        },
    })}`);

    // 스트림 호출 직전 동시성 리미터 상태를 찍어, 슬롯이 없어 대기했는지(개발자 여러 명 동시 PR 등)를 볼 수 있게 한다.
    console.log(`[code-review] ${tag}Claude 스트림 호출 준비 (입력 ${diff.length}자, model=${MODEL}, max_tokens=${MAX_OUTPUT_TOKENS})`);
    console.log(`[code-review] ${tag}동시성 상태: 실행 중 ${claudeStreamLimiter.activeCount()}/${CLAUDE_STREAM_CONCURRENCY}, 대기 ${claudeStreamLimiter.pendingCount()}`);

    const startedAt = Date.now();
    let stream: ReturnType<typeof client.messages.stream> | undefined;
    let streamPhase: 'not-created' | 'created' | 'connected' | 'ended' | 'error' | 'aborted' = 'not-created';
    let streamEventCount = 0;
    let lastStreamEvent: string | null = null;
    let streamConnectedAt: number | undefined;
    let message: Awaited<ReturnType<ReturnType<typeof client.messages.stream>['finalMessage']>>;
    try {
        message = await claudeStreamLimiter.run(async () => {
            // 여기 로그는 슬롯을 확보한 "직후"에 찍힌다. 위 '동시성 상태' 로그와 시간 간격이 벌어져 있으면 대기가 있었다는 뜻.
            console.log(`[code-review] ${tag}▶ 스트림 시작 (슬롯 확보)`);
            const currentStream = requestClient.messages.stream({
                model: MODEL,
                max_tokens: MAX_OUTPUT_TOKENS,
                thinking: { type: 'adaptive' },
                output_config: { effort: 'low' },
                system: [
                    {
                        type: 'text',
                        text: CODE_REVIEW_SYSTEM_PROMPT,
                        cache_control: { type: 'ephemeral' }
                    }
                ],
                messages: [
                    {
                        role: 'user',
                        content: `${descriptionSection}${referenceHintSection}다음 PR diff를 리뷰해 주세요:\n\n\`\`\`diff\n${diff}\n\`\`\``
                    }
                ]
            });
            stream = currentStream;
            streamPhase = 'created';
            currentStream
                .on('connect', () => {
                    streamPhase = 'connected';
                    streamConnectedAt = Date.now();
                    console.log(`${ANTHROPIC_DIAGNOSTIC_PREFIX} [${diagnosticId}] 스트림 연결 ${JSON.stringify({
                        status: stream?.response?.status ?? null,
                        statusText: stream?.response?.statusText || null,
                        requestId: stream?.request_id ?? stream?.response?.headers.get('request-id') ?? null,
                        elapsedMs: Date.now() - startedAt,
                    })}`);
                })
                .on('streamEvent', (event: { type: string }) => {
                    streamEventCount += 1;
                    lastStreamEvent = event.type;
                    // 이벤트 본문에는 응답 내용이 들어갈 수 있으므로 타입/개수만 남긴다.
                    if (streamEventCount <= 2 || event.type === 'message_stop') {
                        console.log(`${ANTHROPIC_DIAGNOSTIC_PREFIX} [${diagnosticId}] 스트림 이벤트 ${JSON.stringify({
                            eventType: event.type,
                            eventCount: streamEventCount,
                            elapsedMs: Date.now() - startedAt,
                        })}`);
                    }
                })
                .on('error', (streamError: unknown) => {
                    streamPhase = 'error';
                    console.error(`${ANTHROPIC_DIAGNOSTIC_PREFIX} [${diagnosticId}] 스트림 error 이벤트 ${JSON.stringify({
                        eventCount: streamEventCount,
                        lastEvent: lastStreamEvent,
                        responseStatus: stream?.response?.status ?? null,
                        requestId: stream?.request_id ?? stream?.response?.headers.get('request-id') ?? null,
                        error: JSON.parse(formatErrorDiagnostics(streamError)),
                    })}`);
                })
                .on('abort', (abortError: unknown) => {
                    streamPhase = 'aborted';
                    console.error(`${ANTHROPIC_DIAGNOSTIC_PREFIX} [${diagnosticId}] 스트림 abort 이벤트 ${JSON.stringify({
                        eventCount: streamEventCount,
                        lastEvent: lastStreamEvent,
                        error: JSON.parse(formatErrorDiagnostics(abortError)),
                    })}`);
                })
                .on('end', () => {
                    if (streamPhase !== 'error' && streamPhase !== 'aborted') streamPhase = 'ended';
                    console.log(`${ANTHROPIC_DIAGNOSTIC_PREFIX} [${diagnosticId}] 스트림 종료 이벤트 ${JSON.stringify({
                        phase: streamPhase,
                        eventCount: streamEventCount,
                        lastEvent: lastStreamEvent,
                        elapsedMs: Date.now() - startedAt,
                    })}`);
            });
            // 스트림을 끝까지 누적한 최종 Message를 반환한다(에러 발생 시 여기서 reject된다).
            const finalMessage = await currentStream.finalMessage();
            return finalMessage;
        });
    } catch (error) {
        const apiError = toHttpErrorLike(error);
        // 스트림 에러는 원본 에러가 cause로 감싸지는 경우가 있어, message와 cause.message를 함께 검사한다.
        const causeMessage = (error as { cause?: { message?: string } })?.cause?.message ?? '';
        const combinedMessage = `${apiError.message ?? ''} ${causeMessage}`.trim();
        const sdkError = error as { status?: number; requestID?: string | null; request_id?: string | null; type?: string | null };
        const responseStatus = sdkError.status ?? stream?.response?.status ?? apiError.response?.status;
        const requestId = sdkError.requestID ?? sdkError.request_id ?? stream?.request_id ?? stream?.response?.headers.get('request-id') ?? null;

        console.error(`[code-review] ${tag}✖ 스트림 실패 (${Date.now() - startedAt}ms):`, apiError.message);
        // Anthropic SDK는 Axios처럼 error.response.status가 아니라 error.status를 사용한다.
        console.error(`[code-review] ${tag}API 응답 상태:`, responseStatus ?? null);
        console.error(`${ANTHROPIC_DIAGNOSTIC_PREFIX} [${diagnosticId}] 스트림 실패 컨텍스트 ${JSON.stringify({
            phase: streamPhase,
            eventCount: streamEventCount,
            lastEvent: lastStreamEvent,
            connectedElapsedMs: streamConnectedAt ? streamConnectedAt - startedAt : null,
            responseStatus: responseStatus ?? null,
            responseStatusText: stream?.response?.statusText || null,
            requestId,
            sdkErrorType: sdkError.type ?? null,
            message: apiError.message ?? null,
        })}`);
        // APIConnectionError의 cause뿐 아니라 MessageStream/undici가 추가한 중첩 cause와 AggregateError까지 남긴다.
        console.error(`${ANTHROPIC_DIAGNOSTIC_PREFIX} [${diagnosticId}] 오류 체인 ${formatErrorDiagnostics(error)}`);
        if (combinedMessage.includes('Violated guardrail policy')) {
            const guardrailMatches = parseGuardrailMatches(combinedMessage);
            throw new GuardrailPolicyError('사내 보안정책 위반으로 AI 코드리뷰가 차단되었습니다.', {
                guardrailMatches,
                rawMessage: combinedMessage,
            });
        }
        if (sdkError.type === 'budget_exceeded' || combinedMessage.includes('budget_exceeded')) {
            throw new ClaudeBudgetExceededError('Claude API 예산이 초과되어 리뷰를 실행할 수 없습니다.', combinedMessage);
        }
        throw error;
    }

    const elapsedMs = Date.now() - startedAt;
    const usage = message.usage;
    console.log(`[code-review] ${tag}◀ 스트림 종료 (${elapsedMs}ms, stop_reason=${message.stop_reason})`);
    if (usage) {
        // 캐시 읽기(cache_read)가 0보다 크면 프롬프트 캐싱이 청크 간에 재사용되고 있다는 신호다.
        console.log(`[code-review] ${tag}토큰: 입력 ${usage.input_tokens}, 출력 ${usage.output_tokens}, 캐시생성 ${usage.cache_creation_input_tokens ?? 0}, 캐시읽기 ${usage.cache_read_input_tokens ?? 0}`);
    }

    const raw = extractTextBlocks(message.content);

    const { reviewData, isOutputTruncated } = parseClaudeReviewResponse(raw, {
        stopReason: message.stop_reason
    });

    console.log(`[code-review] ${tag}파싱된 인라인 코멘트 수: ${reviewData.comments?.length ?? 0}${isOutputTruncated ? ' (출력 토큰 한도로 잘림)' : ''}`);
    return { reviewData, isOutputTruncated };
};
