import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildReviewDiffChunks,
    collectValidLineKeys,
    isBitbucketDiffTruncated
} from '../src/services/codeReview/diffFormatter.js';
import type { BitbucketDiffLine, BitbucketDiffSegment, BitbucketFileDiff } from '../src/types/bitbucket.js';

const line = ({ source, destination, text }: { source: number | null; destination: number | null; text: string }): BitbucketDiffLine => ({
    source,
    destination,
    line: text
});

const fileDiff = (path: string, segments: BitbucketDiffSegment[], extra: Partial<BitbucketFileDiff> = {}): BitbucketFileDiff => ({
    source: { toString: path },
    destination: { toString: path },
    hunks: [{ segments }],
    ...extra
});

// 청크 배열의 모든 text를 이어붙여, diff의 어떤 라인이 어디에든 포함됐는지 검사할 때 쓴다.
const joinedText = (chunks: ReturnType<typeof buildReviewDiffChunks>): string =>
    chunks.map((chunk) => chunk.text).join('\n');

test('isBitbucketDiffTruncated detects nested boolean and string true values', () => {
    assert.equal(isBitbucketDiffTruncated({ diffs: [] }), false);
    assert.equal(isBitbucketDiffTruncated({ truncated: true, diffs: [] }), true);
    assert.equal(isBitbucketDiffTruncated({ truncated: 'true', diffs: [] }), true);
    assert.equal(isBitbucketDiffTruncated({ truncated: 'false', diffs: [] }), false);

    assert.equal(isBitbucketDiffTruncated({
        diffs: [
            fileDiff('src/a.js', [
                {
                    type: 'CONTEXT',
                    lines: [line({ source: 1, destination: 1, text: 'const a = 1;' })]
                }
            ], { truncated: true })
        ]
    }), true);

    assert.equal(isBitbucketDiffTruncated({
        diffs: [
            {
                ...fileDiff('src/a.js', [
                    {
                        type: 'ADDED',
                        lines: [line({ source: null, destination: 2, text: 'const b = 2;' })],
                        truncated: 'true'
                    }
                ])
            }
        ]
    }), true);
});

test('buildReviewDiffChunks: 작은 diff는 청크 1개로, 파일/변경 라인 포맷을 보존한다', () => {
    const chunks = buildReviewDiffChunks({
        diffs: [
            fileDiff('src/user.js', [
                {
                    type: 'CONTEXT',
                    lines: [line({ source: 10, destination: 10, text: 'function name(user) {' })]
                },
                {
                    type: 'REMOVED',
                    lines: [line({ source: 11, destination: null, text: '  return user.name;' })]
                },
                {
                    type: 'ADDED',
                    lines: [line({ source: null, destination: 11, text: '  return user?.name ?? "";' })]
                },
                {
                    type: 'CONTEXT',
                    lines: [line({ source: 12, destination: 12, text: '}' })]
                }
            ])
        ]
    }, { maxChars: 1000 });

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].chunkIndex, 0);
    assert.equal(chunks[0].totalChunks, 1);
    assert.deepEqual(chunks[0].includedFiles.map((file) => file.path), ['src/user.js']);
    assert.match(chunks[0].text, /^FILE: src\/user\.js\n---/);
    assert.match(chunks[0].text, /\[CTX:10\]  function name\(user\) \{/);
    assert.match(chunks[0].text, /\[REM:11\] -  return user\.name;/);
    assert.match(chunks[0].text, /\[ADD:11\] \+  return user\?\.name \?\? "";/);
});

test('buildReviewDiffChunks: 예산을 넘으면 라인을 버리지 않고 여러 청크로 나눈다', () => {
    const manyLines: BitbucketDiffLine[] = Array.from({ length: 40 }, (_, index) =>
        line({ source: null, destination: index + 1, text: `const value${index} = ${index};` })
    );
    const chunks = buildReviewDiffChunks({
        diffs: [
            fileDiff('src/a.ts', [{ type: 'ADDED', lines: manyLines.slice(0, 20) }]),
            fileDiff('src/b.ts', [{ type: 'ADDED', lines: manyLines.slice(20) }])
        ]
    }, { maxChars: 300 });

    // 여러 청크로 나뉘어야 하고, 각 청크는 예산 이하여야 한다.
    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) {
        assert.ok(chunk.text.length <= 300, `chunk length ${chunk.text.length} <= 300`);
        assert.equal(chunk.totalChunks, chunks.length);
    }

    // 모든 변경 라인이 어느 청크엔가 정확히 남아 있어야 한다(생략 없음).
    const all = joinedText(chunks);
    for (let index = 0; index < 40; index += 1) {
        assert.match(all, new RegExp(`const value${index} = ${index};`));
    }
});

test('buildReviewDiffChunks: 소스 파일을 저신호 파일(lockfile)보다 먼저 배치한다', () => {
    const chunks = buildReviewDiffChunks({
        diffs: [
            fileDiff('package-lock.json', [
                { type: 'ADDED', lines: [line({ source: null, destination: 1, text: '"lockfileVersion": 3' })] }
            ]),
            fileDiff('src/app.ts', [
                { type: 'ADDED', lines: [line({ source: null, destination: 10, text: 'startServer();' })] }
            ])
        ]
    }, { maxChars: 1000 });

    const all = joinedText(chunks);
    assert.ok(all.indexOf('FILE: src/app.ts') < all.indexOf('FILE: package-lock.json'));
    assert.match(all, /\[ADD:10\] \+startServer\(\);/);
});

test('buildReviewDiffChunks: 한 파일이 예산보다 크면 라인 경계에서 나누고 (이어서) 헤더를 붙인다', () => {
    const bigFileLines: BitbucketDiffLine[] = Array.from({ length: 30 }, (_, index) =>
        line({ source: null, destination: index + 1, text: `line ${index} = ${'x'.repeat(20)};` })
    );
    const chunks = buildReviewDiffChunks({
        diffs: [fileDiff('src/big.ts', [{ type: 'ADDED', lines: bigFileLines }])]
    }, { maxChars: 200 });

    assert.ok(chunks.length >= 2);
    // 같은 파일이 여러 청크에 걸치면 두 번째 세그먼트부터 (이어서) 헤더가 등장한다.
    const all = joinedText(chunks);
    assert.match(all, /FILE: src\/big\.ts\n---/);
    assert.match(all, /FILE: src\/big\.ts \(이어서\)\n---/);
    // 라인 중간이 아니라 라인 경계에서만 잘려야 한다(온전한 라인만 존재).
    for (let index = 0; index < 30; index += 1) {
        assert.match(all, new RegExp(`\\[ADD:${index + 1}\\] \\+line ${index} = x{20};`));
    }
});

test('buildReviewDiffChunks: 단일 라인이 예산보다 길면 잘라서 청크가 예산을 크게 넘지 않게 한다', () => {
    const hugeLine = 'x'.repeat(5000); // 렌더 후 [ADD:1] + 접두까지 붙어 maxChars(500)를 훨씬 초과
    const chunks = buildReviewDiffChunks({
        diffs: [fileDiff('src/bundle.min.js', [
            { type: 'ADDED', lines: [line({ source: null, destination: 1, text: hugeLine })] }
        ])]
    }, { maxChars: 500 });

    assert.equal(chunks.length, 1);
    // 헤더(FILE 라인 + ---) + 잘린 라인 ≈ maxChars. 컨텍스트 초과를 막는 게 목적이므로 여유를 둬 검사.
    assert.ok(chunks[0].text.length <= 560, `chunk length ${chunks[0].text.length}`);
    assert.match(chunks[0].text, /원본 라인이 너무 길어 잘림/);
    // 라인이 통째로 버려지지 않고(라인 번호 prefix 보존) 청크에 남아 있어야 한다.
    assert.match(chunks[0].text, /\[ADD:1\] \+xxx/);
});

test('buildReviewDiffChunks: 큰 CONTEXT 구간은 변경 라인 앞에서 압축한다', () => {
    const contextLines = Array.from({ length: 12 }, (_, index) =>
        line({ source: index + 1, destination: index + 1, text: `context ${index + 1}` })
    );
    const chunks = buildReviewDiffChunks({
        diffs: [
            fileDiff('src/context.js', [
                { type: 'CONTEXT', lines: contextLines },
                { type: 'ADDED', lines: [line({ source: null, destination: 13, text: 'changed();' })] }
            ])
        ]
    }, { maxChars: 1000, contextLines: 2 });

    const all = joinedText(chunks);
    assert.match(all, /\[CTX:1\]  context 1/);
    assert.match(all, /\[CTX:2\]  context 2/);
    assert.match(all, /\[OMITTED\] 8 unchanged context lines omitted/);
    assert.match(all, /\[CTX:11\]  context 11/);
    assert.match(all, /\[CTX:12\]  context 12/);
    assert.match(all, /\[ADD:13\] \+changed\(\);/);
});

test('collectValidLineKeys: ADDED/REMOVED만 키로 모으고 CONTEXT는 제외한다', () => {
    const keys = collectValidLineKeys({
        diffs: [
            fileDiff('src/user.js', [
                { type: 'CONTEXT', lines: [line({ source: 10, destination: 10, text: 'function name(user) {' })] },
                { type: 'REMOVED', lines: [line({ source: 11, destination: null, text: '  return user.name;' })] },
                { type: 'ADDED', lines: [line({ source: null, destination: 11, text: '  return user?.name ?? "";' })] }
            ])
        ]
    });

    assert.equal(keys.size, 2);
    assert.ok(keys.has('src/user.js:11:REMOVED'));
    assert.ok(keys.has('src/user.js:11:ADDED'));
    assert.ok(!keys.has('src/user.js:10:CONTEXT'));
});

test('collectValidLineKeys: 라인 번호가 숫자가 아니면 제외한다', () => {
    const keys = collectValidLineKeys({
        diffs: [
            fileDiff('src/a.js', [
                { type: 'ADDED', lines: [{ source: null, destination: null, line: 'weird' }] }
            ])
        ]
    });

    assert.equal(keys.size, 0);
});

test('collectValidLineKeys: 여러 파일/hunk에 걸친 변경 라인을 전부 수집한다', () => {
    const keys = collectValidLineKeys({
        diffs: [
            fileDiff('src/a.ts', [
                { type: 'ADDED', lines: [line({ source: null, destination: 1, text: 'a1' })] }
            ]),
            fileDiff('src/b.ts', [
                { type: 'REMOVED', lines: [line({ source: 5, destination: null, text: 'b5' })] },
                { type: 'ADDED', lines: [line({ source: null, destination: 5, text: 'b5-new' })] }
            ])
        ]
    });

    assert.equal(keys.size, 3);
    assert.ok(keys.has('src/a.ts:1:ADDED'));
    assert.ok(keys.has('src/b.ts:5:REMOVED'));
    assert.ok(keys.has('src/b.ts:5:ADDED'));
});
