import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createDiagnosticFetch,
    createDiagnosticId,
    formatErrorDiagnostics,
    safeRequestUrl,
} from '../src/services/codeReview/anthropicDiagnostics.js';

test('formatErrorDiagnostics: Connection error의 중첩 DNS cause와 code를 보존한다', () => {
    const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), {
        code: 'ENOTFOUND',
        errno: -3008,
        syscall: 'getaddrinfo',
        hostname: 'api.anthropic.com',
    });
    const fetchError = new TypeError('fetch failed', { cause: dnsError });
    const sdkError = new Error('Connection error.', { cause: fetchError });
    sdkError.name = 'APIConnectionError';

    const diagnostic = JSON.parse(formatErrorDiagnostics(sdkError));

    assert.equal(diagnostic.chain.name, 'APIConnectionError');
    assert.equal(diagnostic.chain.cause.name, 'TypeError');
    assert.equal(diagnostic.chain.cause.cause.code, 'ENOTFOUND');
    assert.equal(diagnostic.chain.cause.cause.hostname, 'api.anthropic.com');
});

test('formatErrorDiagnostics: SDK status/request id와 API 오류 요약을 포함하되 인증정보는 마스킹한다', () => {
    const secret = 'sk-12345678901234567890';
    const apiError = Object.assign(new Error(`401 invalid x-api-key: ${secret}`), {
        status: 401,
        type: 'authentication_error',
        requestID: 'req_diagnostic_123',
        error: {
            type: 'error',
            error: {
                type: 'authentication_error',
                message: 'invalid x-api-key',
            },
        },
    });

    const diagnostic = JSON.parse(formatErrorDiagnostics(apiError));

    assert.equal(diagnostic.chain.status, 401);
    assert.equal(diagnostic.chain.type, 'authentication_error');
    assert.equal(diagnostic.chain.requestID, 'req_diagnostic_123');
    assert.equal(diagnostic.chain.apiError.type, 'authentication_error');
    assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(secret));
});

test('safeRequestUrl: userinfo/query/fragment를 제거하고 대상 경로만 반환한다', () => {
    assert.equal(
        safeRequestUrl('https://user:password@example.com/v1/messages?api_key=secret#fragment'),
        'https://example.com/v1/messages',
    );
});

test('createDiagnosticId: 로그 상관관계용 짧은 id를 만든다', () => {
    assert.match(createDiagnosticId(), /^cr-[0-9a-f]{8}$/);
});

test('createDiagnosticFetch: 실제 fetch 실패 시 재시도별 원본 cause를 로그에 남기고 요청 비밀값은 남기지 않는다', async () => {
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const originalError = console.error;
    const logs: string[] = [];
    const secret = 'sk-12345678901234567890';
    const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), {
        code: 'ENOTFOUND',
        hostname: 'api.anthropic.com',
    });

    globalThis.fetch = async () => {
        throw new TypeError('fetch failed', { cause: dnsError });
    };
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    console.error = (...args: unknown[]) => logs.push(args.join(' '));

    try {
        const diagnosticFetch = createDiagnosticFetch('cr-test');
        await assert.rejects(
            diagnosticFetch('https://api.anthropic.com/v1/messages?api_key=secret', {
                method: 'POST',
                headers: { authorization: `Bearer ${secret}` },
            }),
            /fetch failed/,
        );
    } finally {
        globalThis.fetch = originalFetch;
        console.log = originalLog;
        console.error = originalError;
    }

    const logText = logs.join('\n');
    assert.match(logText, /ENOTFOUND/);
    assert.match(logText, /api\.anthropic\.com\/v1\/messages/);
    assert.doesNotMatch(logText, new RegExp(secret));
    assert.doesNotMatch(logText, /api_key=secret/);
});
