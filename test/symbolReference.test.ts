import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    buildSymbolReferenceHintText,
    buildSymbolReferenceMarkdown,
    collectChangedBaseLineRanges,
    findUnupdatedReferenceFiles,
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

test('collectChangedBaseLineRanges: REMOVED/CONTEXT의 source만 사용해 base 라인 범위를 만든다', () => {
    const ranges = collectChangedBaseLineRanges({
        diffs: [
            fileDiff('src/a.ts', [
                { type: 'CONTEXT', lines: [line({ source: 10, destination: 10, text: 'ctx' })] },
                { type: 'REMOVED', lines: [line({ source: 11, destination: null, text: 'old' })] },
                { type: 'ADDED', lines: [line({ source: null, destination: 11, text: 'new' })] },
            ])
        ]
    });

    assert.deepEqual(ranges.get('src/a.ts'), [{ start: 10, end: 11 }]);
});

test('collectChangedBaseLineRanges: REMOVED/CONTEXT가 전혀 없는 순수 삽입 hunk는 건너뛴다', () => {
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

    insertEdge.run('CALLS', 'x', fnQualifiedName, path.join(worktreePath, 'src/pages/ProfilePage.tsx'));
    insertEdge.run('CALLS', 'x', fnQualifiedName, path.join(worktreePath, 'src/hooks/useProfile.ts'));
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
    assert.match(buildSymbolReferenceHintText(entries), /^\[REF\] fetchUserProfile/);
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
