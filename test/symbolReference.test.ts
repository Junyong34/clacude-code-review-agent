import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    attachCallerSnippets,
    buildSymbolReferenceHintText,
    buildSymbolReferenceMarkdown,
    collectChangedBaseLineRanges,
    findUnupdatedReferenceFiles,
    MAX_CALLER_SNIPPET_LINES,
    MAX_CALLER_SNIPPETS_PER_PR,
    readCallerSnippet,
} from '../src/services/codeReview/symbolReference.js';
import type { BitbucketDiffLine, BitbucketDiffSegment, BitbucketFileDiff } from '../src/types/bitbucket.js';

const line = ({ source, destination, text }: { source: number | null; destination: number | null; text: string }): BitbucketDiffLine => ({
    source,
    destination,
    line: text,
});

const fileDiff = (filePath: string, segments: BitbucketDiffSegment[]): BitbucketFileDiff => ({
    source: { toString: filePath },
    destination: { toString: filePath },
    hunks: [{ segments }],
});

// ---- collectChangedBaseLineRanges (순수 함수, graph.db 불필요) ----

test('collectChangedBaseLineRanges: REMOVED 라인과 ADDED 바로 앞뒤 CONTEXT 한 줄로 base 라인 범위를 만든다', () => {
    const ranges = collectChangedBaseLineRanges({
        diffs: [
            fileDiff('src/a.ts', [
                { type: 'CONTEXT', lines: [line({ source: 10, destination: 10, text: 'ctx' })] },
                { type: 'REMOVED', lines: [line({ source: 11, destination: null, text: 'old' })] },
                { type: 'ADDED', lines: [line({ source: null, destination: 11, text: 'new' })] },
            ])
        ]
    });

    // ADDED 앞 segment가 REMOVED라 CONTEXT 앵커는 쓰지 않는다.
    assert.deepEqual(ranges.get('src/a.ts'), [{ start: 11, end: 11 }]);
});

test('collectChangedBaseLineRanges: 넓은 CONTEXT가 있어도 변경되지 않은 인접 함수까지 범위를 넓히지 않는다', () => {
    const contextBefore = Array.from({ length: 25 }, (_, index) => line({ source: index + 1, destination: index + 1, text: 'before' }));
    const contextAfter = Array.from({ length: 25 }, (_, index) => line({ source: index + 26, destination: index + 27, text: 'after' }));
    const ranges = collectChangedBaseLineRanges({
        diffs: [
            fileDiff('src/a.ts', [
                { type: 'CONTEXT', lines: contextBefore },
                { type: 'ADDED', lines: [line({ source: null, destination: 26, text: 'new' })] },
                { type: 'CONTEXT', lines: contextAfter },
            ])
        ]
    });

    assert.deepEqual(ranges.get('src/a.ts'), [{ start: 25, end: 26 }]);
});

test('collectChangedBaseLineRanges: base 라인 앵커가 없는 순수 삽입 hunk는 건너뛴다', () => {
    const ranges = collectChangedBaseLineRanges({
        diffs: [
            fileDiff('src/a.ts', [
                { type: 'ADDED', lines: [line({ source: null, destination: 1, text: 'new' })] },
            ])
        ]
    });

    assert.equal(ranges.has('src/a.ts'), false);
});

// ---- findUnupdatedReferenceFiles (실제 스키마와 동일한 구조의 작은 graph.db를 씨딩) ----

const createTestGraphDb = (worktreePath: string): void => {
    const graphDir = path.join(worktreePath, '.code-review-graph');
    mkdirSync(graphDir, { recursive: true });
    const db = new DatabaseSync(path.join(graphDir, 'graph.db'));

    db.exec(`
        CREATE TABLE nodes (
            id INTEGER PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT UNIQUE,
            file_path TEXT, line_start INTEGER, line_end INTEGER
        );
        CREATE TABLE edges (
            id INTEGER PRIMARY KEY, kind TEXT, source_qualified TEXT, target_qualified TEXT, file_path TEXT
        );
    `);

    const insertNode = db.prepare('INSERT INTO nodes (kind, name, qualified_name, file_path, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?)');
    const insertEdge = db.prepare('INSERT INTO edges (kind, source_qualified, target_qualified, file_path) VALUES (?, ?, ?, ?)');

    const aTsPath = path.join(worktreePath, 'src/a.ts');
    const fnQualifiedName = `${aTsPath}::fetchUserProfile`;
    insertNode.run('Function', 'fetchUserProfile', fnQualifiedName, aTsPath, 10, 15);
    insertNode.run('Type', 'UserProfile', `${aTsPath}::UserProfile`, aTsPath, 1, 5);

    const useProfilePath = path.join(worktreePath, 'src/hooks/useProfile.ts');
    const useProfileQualifiedName = `${useProfilePath}::useProfile`;
    insertNode.run('Function', 'useProfile', useProfileQualifiedName, useProfilePath, 3, 6);

    insertEdge.run('CALLS', 'x', fnQualifiedName, path.join(worktreePath, 'src/pages/ProfilePage.tsx'));
    insertEdge.run('CALLS', useProfileQualifiedName, fnQualifiedName, useProfilePath);
    insertEdge.run('REFERENCES', 'x', fnQualifiedName, path.join(worktreePath, 'src/pages/AdminUserView.tsx'));

    db.close();
};

const ctxLine = (n: number): BitbucketDiffSegment => ({ type: 'CONTEXT', lines: [line({ source: n, destination: n, text: 'x' })] });

test('findUnupdatedReferenceFiles: 참조 파일이 diff 변경 목록에 없으면 미갱신 참조로 잡는다', async () => {
    const worktreePath = mkdtempSync(path.join(os.tmpdir(), 'crb-graph-'));
    try {
        createTestGraphDb(worktreePath);

        const diffData = {
            diffs: [
                fileDiff('src/a.ts', [
                    { type: 'REMOVED', lines: [line({ source: 12, destination: null, text: 'old' })] },
                    { type: 'ADDED', lines: [line({ source: null, destination: 12, text: 'new' })] },
                ]),
                fileDiff('src/pages/ProfilePage.tsx', [ctxLine(1)]), // 이미 이번 PR에서 변경됨
            ],
        };

        const entries = await findUnupdatedReferenceFiles(worktreePath, diffData);

        assert.equal(entries.length, 1);
        assert.equal(entries[0].symbol, 'fetchUserProfile');
        assert.deepEqual(entries[0].referencingFiles.sort(), ['src/hooks/useProfile.ts', 'src/pages/AdminUserView.tsx']);
        // source_qualified가 Function 노드와 이어지는 참조만 호출부로 잡힌다('x'는 노드가 없어 위치를 모름).
        assert.deepEqual(entries[0].callers, [
            { file: 'src/hooks/useProfile.ts', name: 'useProfile', lineStart: 3, lineEnd: 6 },
        ]);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
    }
});

test('findUnupdatedReferenceFiles: 참조 파일이 전부 diff에 포함돼 있으면 결과가 비어야 한다', async () => {
    const worktreePath = mkdtempSync(path.join(os.tmpdir(), 'crb-graph-'));
    try {
        createTestGraphDb(worktreePath);

        const diffData = {
            diffs: [
                fileDiff('src/a.ts', [{ type: 'REMOVED', lines: [line({ source: 12, destination: null, text: 'old' })] }]),
                fileDiff('src/pages/ProfilePage.tsx', [ctxLine(1)]),
                fileDiff('src/hooks/useProfile.ts', [ctxLine(1)]),
                fileDiff('src/pages/AdminUserView.tsx', [ctxLine(1)]),
            ],
        };

        const entries = await findUnupdatedReferenceFiles(worktreePath, diffData);
        assert.equal(entries.length, 0);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
    }
});

test('findUnupdatedReferenceFiles: kind가 Function이 아닌 노드(Type)가 겹치는 라인은 대상에서 빠진다', async () => {
    const worktreePath = mkdtempSync(path.join(os.tmpdir(), 'crb-graph-'));
    try {
        createTestGraphDb(worktreePath);

        // UserProfile(Type, 1~5행)만 건드리는 diff — kind='Function'이 아니므로 매칭되면 안 된다.
        const diffData = {
            diffs: [fileDiff('src/a.ts', [{ type: 'REMOVED', lines: [line({ source: 2, destination: null, text: 'old' })] }])],
        };

        const entries = await findUnupdatedReferenceFiles(worktreePath, diffData);
        assert.equal(entries.length, 0);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
    }
});

test('findUnupdatedReferenceFiles: edges에 source_qualified가 없는 스키마면 호출부 없이 참조 파일만 반환한다', async () => {
    const worktreePath = mkdtempSync(path.join(os.tmpdir(), 'crb-graph-'));
    try {
        const graphDir = path.join(worktreePath, '.code-review-graph');
        mkdirSync(graphDir, { recursive: true });
        const db = new DatabaseSync(path.join(graphDir, 'graph.db'));
        db.exec(`
            CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT, line_start INTEGER, line_end INTEGER);
            CREATE TABLE edges (id INTEGER PRIMARY KEY, kind TEXT, target_qualified TEXT, file_path TEXT);
        `);
        const aTsPath = path.join(worktreePath, 'src/a.ts');
        db.prepare('INSERT INTO nodes (kind, name, qualified_name, file_path, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?)')
            .run('Function', 'fetchUserProfile', `${aTsPath}::fetchUserProfile`, aTsPath, 10, 15);
        db.prepare('INSERT INTO edges (kind, target_qualified, file_path) VALUES (?, ?, ?)')
            .run('CALLS', `${aTsPath}::fetchUserProfile`, path.join(worktreePath, 'src/b.ts'));
        db.close();

        const entries = await findUnupdatedReferenceFiles(worktreePath, {
            diffs: [fileDiff('src/a.ts', [{ type: 'REMOVED', lines: [line({ source: 12, destination: null, text: 'old' })] }])],
        });

        assert.equal(entries.length, 1);
        assert.deepEqual(entries[0].referencingFiles, ['src/b.ts']);
        assert.deepEqual(entries[0].callers, []);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
    }
});

test('findUnupdatedReferenceFiles: graph.db가 없으면 크래시 없이 빈 배열을 반환한다', async () => {
    const worktreePath = mkdtempSync(path.join(os.tmpdir(), 'crb-graph-'));
    try {
        const entries = await findUnupdatedReferenceFiles(worktreePath, { diffs: [] });
        assert.deepEqual(entries, []);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
    }
});

// ---- 마크다운/힌트 포맷터 ----

test('buildSymbolReferenceMarkdown/buildSymbolReferenceHintText: 빈 배열이면 빈 문자열', () => {
    assert.equal(buildSymbolReferenceMarkdown([]), '');
    assert.equal(buildSymbolReferenceHintText([]), '');
});

test('buildSymbolReferenceMarkdown/buildSymbolReferenceHintText: 값이 있으면 형식에 맞게 렌더링한다', () => {
    const entries = [{
        symbol: 'fetchUserProfile',
        definitionFile: 'src/a.ts',
        referencingFiles: ['src/b.ts'],
        interfaceChange: {
            kind: 'parameter-breaking' as const,
            confidence: 'high' as const,
            summary: '인자 1개 → 2개',
        },
    }];

    assert.match(buildSymbolReferenceMarkdown(entries), /### 호출부 확인이 필요합니다/);
    assert.match(buildSymbolReferenceMarkdown(entries), /fetchUserProfile/);
    assert.match(buildSymbolReferenceHintText(entries), /^\[REF\] fetchUserProfile\(src\/a\.ts\) \[판정: parameter-breaking\] 인자 1개 → 2개/);
    assert.doesNotMatch(buildSymbolReferenceHintText(entries), /\[REF-CALLER\]/);
});

// ---- 호출부 스니펫 ----

const writeWorktreeFile = (worktreePath: string, relativePath: string, content: string): void => {
    const absolutePath = path.join(worktreePath, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
};

test('readCallerSnippet: 호출 함수 본문을 master 라인 번호와 함께 읽는다', () => {
    const worktreePath = mkdtempSync(path.join(os.tmpdir(), 'crb-snippet-'));
    try {
        writeWorktreeFile(worktreePath, 'src/b.ts', ['import x;', '', 'export const load = () => {', '  return fetchUserProfile(id);', '};', ''].join('\n'));

        const snippet = readCallerSnippet(worktreePath, { file: 'src/b.ts', name: 'load', lineStart: 3, lineEnd: 5 }, 'fetchUserProfile');

        assert.deepEqual(snippet, {
            startLine: 3,
            endLine: 5,
            text: ['3| export const load = () => {', '4|   return fetchUserProfile(id);', '5| };'].join('\n'),
        });
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
    }
});

test('readCallerSnippet: 상한보다 긴 함수는 심볼 사용 라인을 포함하도록 잘라낸다', () => {
    const worktreePath = mkdtempSync(path.join(os.tmpdir(), 'crb-snippet-'));
    try {
        const body = Array.from({ length: 200 }, (_, index) => (index === 149 ? '  fetchUserProfile(id);' : `  step${index + 1}();`));
        writeWorktreeFile(worktreePath, 'src/long.ts', body.join('\n'));

        const snippet = readCallerSnippet(worktreePath, { file: 'src/long.ts', name: 'long', lineStart: 1, lineEnd: 200 }, 'fetchUserProfile');

        assert.ok(snippet);
        assert.equal(snippet.endLine - snippet.startLine + 1, MAX_CALLER_SNIPPET_LINES);
        assert.ok(snippet.startLine <= 150 && snippet.endLine >= 150);
        assert.match(snippet.text, /150\|\s+fetchUserProfile\(id\);/);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
    }
});

test('readCallerSnippet: 워크트리 밖 경로나 없는 파일은 읽지 않는다', () => {
    const worktreePath = mkdtempSync(path.join(os.tmpdir(), 'crb-snippet-'));
    try {
        assert.equal(readCallerSnippet(worktreePath, { file: '../outside.ts', name: 'x', lineStart: 1, lineEnd: 2 }, 'x'), undefined);
        assert.equal(readCallerSnippet(worktreePath, { file: 'src/missing.ts', name: 'x', lineStart: 1, lineEnd: 2 }, 'x'), undefined);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
    }
});

test('attachCallerSnippets: breaking 판정을 먼저 채우고, 구현만 바뀐 심볼은 건너뛰며, PR당 상한을 지킨다', () => {
    const worktreePath = mkdtempSync(path.join(os.tmpdir(), 'crb-snippet-'));
    try {
        const callers = Array.from({ length: 30 }, (_, index) => {
            const file = `src/caller${index}.ts`;
            writeWorktreeFile(worktreePath, file, `export const c${index} = () => target();\n`);
            return { file, name: `c${index}`, lineStart: 1, lineEnd: 1 };
        });
        const entries = [
            { symbol: 'unknownTarget', definitionFile: 'src/u.ts', referencingFiles: ['src/x.ts'], callers: callers.slice(0, 10),
                interfaceChange: { kind: 'unknown' as const, confidence: 'low' as const, summary: '판정 실패' } },
            { symbol: 'internalOnly', definitionFile: 'src/i.ts', referencingFiles: ['src/x.ts'], callers: callers.slice(10, 12),
                interfaceChange: { kind: 'implementation-only' as const, confidence: 'high' as const, summary: '내부 변경' } },
            ...Array.from({ length: 5 }, (_, index) => ({
                symbol: `breaking${index}`, definitionFile: `src/b${index}.ts`, referencingFiles: ['src/x.ts'],
                callers: callers.slice(12 + index * 3, 15 + index * 3),
                interfaceChange: { kind: 'parameter-breaking' as const, confidence: 'high' as const, summary: '인자 변경' },
            })),
        ];

        const result = attachCallerSnippets(worktreePath, entries);
        const snippetCount = (entry: (typeof result)[number]) => (entry.callers ?? []).filter((caller) => caller.snippet).length;

        assert.equal(result.reduce((sum, entry) => sum + snippetCount(entry), 0), MAX_CALLER_SNIPPETS_PER_PR);
        assert.ok(result.slice(2).every((entry) => snippetCount(entry) === 3), 'breaking 판정 심볼은 모든 호출부 스니펫을 받는다');
        assert.equal(snippetCount(result[1]), 0, '구현만 바뀐 심볼은 스니펫을 읽지 않는다');
        assert.equal(snippetCount(result[0]), MAX_CALLER_SNIPPETS_PER_PR - 15, 'unknown 판정은 남은 예산(심볼당 상한 이내)만 받는다');

        const hint = buildSymbolReferenceHintText(result);
        assert.match(hint, /\[REF\] breaking0\(src\/b0\.ts\) \[판정: parameter-breaking\]/);
        assert.match(hint, /\[REF-CALLER\] src\/caller12\.ts:1-1 c12 \(master 기준, breaking0 사용부\)\n1\| export const c12 = \(\) => target\(\);\n\[\/REF-CALLER\]/);
        assert.doesNotMatch(hint, /internalOnly/);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
    }
});

test('buildSymbolReferenceMarkdown: 같은 참조 파일을 하나로 묶고 변경 항목을 하위 목록으로 표시한다', () => {
    const markdown = buildSymbolReferenceMarkdown([
        {
            symbol: 'ComponentA',
            definitionFile: 'src/ComponentA.tsx',
            referencingFiles: ['src/pages/index.tsx'],
            interfaceChange: { kind: 'props-breaking', confidence: 'high', summary: '필수 Props \'id\' 추가' },
        },
        {
            symbol: 'ComponentB',
            definitionFile: 'src/ComponentB.tsx',
            referencingFiles: ['src/pages/index.tsx'],
            interfaceChange: { kind: 'parameter-breaking', confidence: 'high', summary: '인자 1개 → 2개' },
        },
        {
            symbol: 'ComponentA',
            definitionFile: 'src/ComponentA.tsx',
            referencingFiles: ['src/pages/index.tsx'],
            interfaceChange: { kind: 'props-breaking', confidence: 'high', summary: '필수 Props \'id\' 추가' },
        },
    ]);

    assert.equal((markdown.match(/`src\/pages\/index\.tsx`/g) ?? []).length, 1);
    assert.match(markdown, /\*\*ComponentA 함수\*\*/);
    assert.match(markdown, /\*\*ComponentB 함수\*\*/);
    assert.equal((markdown.match(/이번 PR에서 변경된 함수 또는 컴포넌트를 사용하지만/g) ?? []).length, 1);
    assert.match(markdown, /`src\/ComponentA\.tsx` 파일에서 \*\*ComponentA 함수\*\*가 변경되었습니다/);
    assert.match(markdown, /위 함수들을 사용하고 있어, 이번 변경이 해당 파일의 동작에 영향을 주는지 확인해 주세요/);
});

test('buildSymbolReferenceMarkdown: 내부 로직만 변경된 심볼은 참조 파일을 표시하지 않는다', () => {
    const markdown = buildSymbolReferenceMarkdown([{
        symbol: 'getCouponLabel',
        definitionFile: 'src/Coupon.ts',
        referencingFiles: ['src/pages/index.tsx'],
        interfaceChange: {
            kind: 'implementation-only',
            confidence: 'high',
            summary: '외부 인터페이스 변경 없음',
        },
    }]);

    assert.equal(markdown, '');
});
