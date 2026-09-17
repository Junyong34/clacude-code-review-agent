import { randomUUID } from 'node:crypto';

/**
 * Anthropic SDK가 `Connection error.`로 감싸기 전의 원본 네트워크 오류를 추적하기 위한 로그 접두사.
 * 운영 로그에서 한 번에 검색할 수 있도록 모든 진단 로그에 같은 접두사를 붙인다.
 */
export const ANTHROPIC_DIAGNOSTIC_PREFIX = '[DEBUG-ANTHROPIC]';

type FetchInput = string | URL | Request;
type AnthropicFetch = (input: FetchInput, init?: RequestInit) => Promise<Response>;
type UnknownRecord = Record<string, unknown>;

const MAX_DIAGNOSTIC_STRING_LENGTH = 1_600;
const MAX_DIAGNOSTIC_DEPTH = 6;
const MAX_DIAGNOSTIC_ARRAY_ITEMS = 5;

/**
 * 오류 메시지/stack에 섞여 들어올 수 있는 인증정보와 개인정보를 로그 전에 제거한다.
 * 요청 본문은 애초에 진단 로그에 포함하지 않지만, 라이브러리/네트워크 오류가 URL이나 헤더를
 * 메시지에 포함하는 경우까지 방어한다.
 */
const DIAGNOSTIC_REDACTION_RULES: Array<{ pattern: RegExp; replacement: string }> = [
    { pattern: /Basic\s+[A-Za-z0-9+/=]{8,}/gi, replacement: 'Basic <REDACTED>' },
    { pattern: /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi, replacement: 'Bearer <REDACTED>' },
    { pattern: /sk-[A-Za-z0-9]{12,}/g, replacement: '[API_KEY]' },
    { pattern: /ATATT[A-Za-z0-9+/=_-]{12,}/g, replacement: '[ATLASSIAN_TOKEN]' },
    { pattern: /[\w.-]+@[\w.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL]' },
    { pattern: /010[-\s]?\d{4}[-\s]?\d{4}/g, replacement: '[PHONE]' },
    { pattern: /\d{6}[-]\d{7}/g, replacement: '[SSN]' },
    {
        pattern: /([?&](?:api[_-]?key|token|access[_-]?token|auth|signature|secret|password)=)[^&\s]+/gi,
        replacement: '$1<REDACTED>',
    },
    {
        pattern: /((?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*)[^\s,;]+/gi,
        replacement: '$1<REDACTED>',
    },
    {
        pattern: /(https?:\/\/)([^/\s:@]+):([^@\s]+)@/gi,
        replacement: '$1<REDACTED>@',
    },
    {
        pattern: /(x-api-key|authorization|proxy-authorization)\s*[:=]\s*[^\s,;]+/gi,
        replacement: '$1: <REDACTED>',
    },
];

const redactDiagnosticText = (value: string): string => {
    let redacted = value;
    for (const { pattern, replacement } of DIAGNOSTIC_REDACTION_RULES) {
        redacted = redacted.replace(pattern, replacement);
    }
    return redacted;
};

const truncateDiagnosticText = (value: string): string => {
    const redacted = redactDiagnosticText(value);
    return redacted.length > MAX_DIAGNOSTIC_STRING_LENGTH
        ? `${redacted.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH)}…`
        : redacted;
};

const isRecord = (value: unknown): value is UnknownRecord => Boolean(value) && typeof value === 'object';

const readProperty = (value: unknown, key: string): unknown => {
    if (!isRecord(value)) return undefined;

    try {
        return value[key];
    } catch {
        return undefined;
    }
};

const readStringProperty = (value: unknown, key: string): string | undefined => {
    const property = readProperty(value, key);
    return typeof property === 'string' ? truncateDiagnosticText(property) : undefined;
};

const readNumberOrStringProperty = (value: unknown, key: string): number | string | undefined => {
    const property = readProperty(value, key);
    return typeof property === 'number' || typeof property === 'string' ? property : undefined;
};

const readConstructorName = (value: unknown): string => {
    const constructor = readProperty(value, 'constructor');
    if (typeof constructor === 'function' && typeof constructor.name === 'string') {
        return constructor.name;
    }

    return readStringProperty(constructor, 'name') ?? 'unknown';
};

const getOwnPropertyNames = (value: unknown): string[] => {
    if (!isRecord(value)) return [];

    try {
        return Object.getOwnPropertyNames(value).sort();
    } catch {
        return [];
    }
};

const getHeaderNames = (headers: unknown): string[] => {
    if (!headers) return [];

    try {
        if (headers instanceof Headers) {
            return [...headers.keys()].sort();
        }

        if (isRecord(headers)) {
            return Object.keys(headers).map((name) => name.toLowerCase()).sort();
        }
    } catch {
        return [];
    }

    return [];
};

const getHeaderValue = (headers: unknown, name: string): string | undefined => {
    if (!headers) return undefined;

    try {
        if (headers instanceof Headers) {
            return headers.get(name) ?? undefined;
        }

        if (isRecord(headers)) {
            const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
            const value = matchingKey ? headers[matchingKey] : undefined;
            return typeof value === 'string' ? truncateDiagnosticText(value) : undefined;
        }
    } catch {
        return undefined;
    }

    return undefined;
};

const summarizeApiErrorBody = (value: unknown): UnknownRecord | string | undefined => {
    if (typeof value === 'string') return truncateDiagnosticText(value);
    if (!isRecord(value)) return value === undefined ? undefined : String(value);

    const nestedError = readProperty(value, 'error');
    const nestedErrorRecord = isRecord(nestedError) ? nestedError : undefined;
    const nestedApiError = readProperty(nestedErrorRecord, 'error');
    const nestedApiErrorRecord = isRecord(nestedApiError) ? nestedApiError : undefined;
    const summary: UnknownRecord = {
        keys: Object.keys(value).slice(0, 20).sort(),
    };

    // Anthropic 응답 body는 보통 { type: 'error', error: { type, message } } 형태다.
    // 가장 안쪽의 실제 API 오류 type/message를 우선해, 바깥 envelope의 'error'와 구분한다.
    const type = readStringProperty(nestedApiErrorRecord, 'type')
        ?? readStringProperty(nestedErrorRecord, 'type')
        ?? readStringProperty(value, 'type');
    const message = readStringProperty(nestedApiErrorRecord, 'message')
        ?? readStringProperty(nestedErrorRecord, 'message')
        ?? readStringProperty(value, 'message');
    if (type) summary.type = type;
    if (message) summary.message = message;

    return summary;
};

const serializeErrorNode = (value: unknown, depth: number, seen: Set<object>): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return truncateDiagnosticText(String(value));
    if (depth > MAX_DIAGNOSTIC_DEPTH) return { truncated: 'maximum error depth reached' };
    if (seen.has(value)) return { circular: true };

    seen.add(value);

    const node: UnknownRecord = {
        depth,
        constructor: readConstructorName(value),
        ownProperties: getOwnPropertyNames(value),
    };

    for (const key of ['name', 'message', 'code', 'errno', 'syscall', 'hostname', 'address', 'port', 'status', 'statusText', 'type', 'requestID', 'request_id']) {
        const property = readNumberOrStringProperty(value, key);
        if (property !== undefined) {
            node[key] = typeof property === 'string' ? truncateDiagnosticText(property) : property;
        }
    }

    const stack = readStringProperty(value, 'stack');
    if (stack) node.stack = stack;

    const headers = readProperty(value, 'headers');
    const headerNames = getHeaderNames(headers);
    if (headerNames.length > 0) {
        node.headerNames = headerNames;
        const requestId = getHeaderValue(headers, 'request-id');
        if (requestId) node.headerRequestId = requestId;
    }

    const apiErrorBody = summarizeApiErrorBody(readProperty(value, 'error'));
    if (apiErrorBody !== undefined) node.apiError = apiErrorBody;

    const response = readProperty(value, 'response');
    if (isRecord(response)) {
        node.response = {
            status: readNumberOrStringProperty(response, 'status') ?? null,
            statusText: readStringProperty(response, 'statusText') ?? null,
            requestId: getHeaderValue(readProperty(response, 'headers'), 'request-id') ?? null,
        };
    }

    const cause = readProperty(value, 'cause');
    if (cause !== undefined) node.cause = serializeErrorNode(cause, depth + 1, seen);

    const errors = readProperty(value, 'errors');
    if (Array.isArray(errors)) {
        node.errors = errors
            .slice(0, MAX_DIAGNOSTIC_ARRAY_ITEMS)
            .map((item) => serializeErrorNode(item, depth + 1, seen));
    }

    return node;
};

/**
 * Error 객체의 비열거 속성(`cause`, `code`, `status`, `requestID`)까지 포함한 안전한 JSON 진단 문자열을 만든다.
 * `console.error(error)`는 환경에 따라 cause를 생략하거나 전체 객체를 출력할 수 있어 이 함수로 고정한다.
 */
export const formatErrorDiagnostics = (error: unknown): string => {
    try {
        return JSON.stringify({ chain: serializeErrorNode(error, 0, new Set<object>()) });
    } catch (serializationError) {
        return JSON.stringify({
            chain: {
                message: '오류 객체 직렬화 실패',
                serializationError: truncateDiagnosticText(String(serializationError)),
            },
        });
    }
};

export const createDiagnosticId = (): string => `cr-${randomUUID().slice(0, 8)}`;

const getInputUrl = (input: FetchInput): string => {
    if (typeof input === 'string' || input instanceof URL) return input.toString();
    return typeof input.url === 'string' ? input.url : '';
};

/** URL query/fragment와 userinfo를 제거해 네트워크 대상만 로그에 남긴다. */
export const safeRequestUrl = (input: FetchInput | string): string => {
    const rawUrl = typeof input === 'string' ? input : getInputUrl(input);
    if (!rawUrl) return '<unknown-url>';

    try {
        const url = new URL(rawUrl);
        return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
        return truncateDiagnosticText(rawUrl).replace(/[?#].*$/, '');
    }
};

const getRequestMethod = (input: FetchInput, init?: RequestInit): string => {
    if (typeof init?.method === 'string' && init.method) return init.method.toUpperCase();
    if (isRecord(input) && typeof input.method === 'string' && input.method) return input.method.toUpperCase();
    return 'GET';
};

const getRequestTimeoutHeader = (input: FetchInput, init?: RequestInit): string | undefined => {
    try {
        const initHeaders = init?.headers ? new Headers(init.headers) : undefined;
        const inputHeaders = isRecord(input) && input.headers ? new Headers(input.headers as RequestInit['headers']) : undefined;
        return initHeaders?.get('x-stainless-timeout') ?? inputHeaders?.get('x-stainless-timeout') ?? undefined;
    } catch {
        return undefined;
    }
};

/**
 * SDK가 내부적으로 수행하는 fetch를 감싸 각 재시도 시도와 원본 fetch 예외를 기록한다.
 * body/header 값은 기록하지 않으므로 diff와 인증정보가 로그로 새지 않는다.
 */
export const createDiagnosticFetch = (diagnosticId: string): AnthropicFetch => {
    let attempt = 0;

    return async (input, init) => {
        const attemptNumber = ++attempt;
        const request = {
            attempt: attemptNumber,
            method: getRequestMethod(input, init),
            url: safeRequestUrl(input),
            timeoutHeaderSeconds: getRequestTimeoutHeader(input, init) ?? null,
        };
        const startedAt = Date.now();

        console.log(`${ANTHROPIC_DIAGNOSTIC_PREFIX} [${diagnosticId}] fetch 시작 ${JSON.stringify(request)}`);

        try {
            const response = await globalThis.fetch(input, init);
            console.log(`${ANTHROPIC_DIAGNOSTIC_PREFIX} [${diagnosticId}] fetch 응답 ${JSON.stringify({
                ...request,
                status: response.status,
                statusText: response.statusText || null,
                requestId: response.headers.get('request-id'),
                elapsedMs: Date.now() - startedAt,
            })}`);
            return response;
        } catch (error) {
            console.error(`${ANTHROPIC_DIAGNOSTIC_PREFIX} [${diagnosticId}] fetch 실패 ${JSON.stringify({
                ...request,
                elapsedMs: Date.now() - startedAt,
                error: JSON.parse(formatErrorDiagnostics(error)),
            })}`);
            throw error;
        }
    };
};
