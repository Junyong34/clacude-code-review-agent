import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureMasterWorktreeReady, refreshMasterWorktreeGit } from '../src/services/contextClone/index.js';
import { addCommitToRemote, createFakeContextClone, isCodeReviewGraphAvailable, snapshotCloneState } from './helpers/gitFixtures.js';

// 이 파일의 테스트는 실제 git subprocess를 띄우므로 순수 함수 테스트보다 느리다(수백ms~초 단위).

test('refreshMasterWorktreeGit: 최초 호출 시 마스터 워크트리를 만들고 origin/master 내용을 그대로 담는다', async () => {
    const fixture = createFakeContextClone();
    const masterWorktreeDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'crb-worktree-')), 'master');

    try {
        const resolvedPath = await refreshMasterWorktreeGit({ contextClonePath: fixture.clonePath, masterWorktreeDir });

        assert.equal(resolvedPath, masterWorktreeDir);
        assert.ok(existsSync(path.join(masterWorktreeDir, 'a.ts')));
        assert.equal(readFileSync(path.join(masterWorktreeDir, 'a.ts'), 'utf-8'), 'export const a = 1;\n');
    } finally {
        rmSync(fixture.tmpRoot, { recursive: true, force: true });
        rmSync(masterWorktreeDir, { recursive: true, force: true });
    }
});

test('refreshMasterWorktreeGit: 원격에 새 커밋이 생기면 재호출 시 reset --hard로 최신 내용을 반영한다', async () => {
    const fixture = createFakeContextClone();
    const masterWorktreeDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'crb-worktree-')), 'master');

    try {
        await refreshMasterWorktreeGit({ contextClonePath: fixture.clonePath, masterWorktreeDir });
        assert.ok(!existsSync(path.join(masterWorktreeDir, 'b.ts')));

        addCommitToRemote(fixture, 'b.ts', 'export const b = 2;\n');
        await refreshMasterWorktreeGit({ contextClonePath: fixture.clonePath, masterWorktreeDir });

        assert.ok(existsSync(path.join(masterWorktreeDir, 'b.ts')));
        assert.equal(readFileSync(path.join(masterWorktreeDir, 'b.ts'), 'utf-8'), 'export const b = 2;\n');
    } finally {
        rmSync(fixture.tmpRoot, { recursive: true, force: true });
        rmSync(masterWorktreeDir, { recursive: true, force: true });
    }
});

test('refreshMasterWorktreeGit: 기존 컨텍스트 클론의 체크아웃 브랜치/미커밋 변경을 건드리지 않는다', async () => {
    const fixture = createFakeContextClone();
    const masterWorktreeDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'crb-worktree-')), 'master');
    const before = snapshotCloneState(fixture.clonePath);

    try {
        await refreshMasterWorktreeGit({ contextClonePath: fixture.clonePath, masterWorktreeDir });
        const after = snapshotCloneState(fixture.clonePath);

        assert.equal(before.branch, 'feature/local-work');
        assert.deepEqual(after, before);
    } finally {
        rmSync(fixture.tmpRoot, { recursive: true, force: true });
        rmSync(masterWorktreeDir, { recursive: true, force: true });
    }
});

test('ensureMasterWorktreeReady: 동시에 호출해도 안전하게 하나의 마스터 워크트리로 귀결된다', async (t) => {
    if (!isCodeReviewGraphAvailable()) {
        t.skip('code-review-graph CLI가 설치되어 있지 않아 스킵');
        return;
    }

    const fixture = createFakeContextClone();
    const masterWorktreeDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'crb-worktree-')), 'master');

    try {
        const overrides = { contextClonePath: fixture.clonePath, masterWorktreeDir };
        const [first, second] = await Promise.all([
            ensureMasterWorktreeReady(overrides),
            ensureMasterWorktreeReady(overrides),
        ]);

        assert.equal(first, masterWorktreeDir);
        assert.equal(second, masterWorktreeDir);
        assert.ok(existsSync(path.join(masterWorktreeDir, '.code-review-graph', 'graph.db')));
    } finally {
        rmSync(fixture.tmpRoot, { recursive: true, force: true });
        rmSync(masterWorktreeDir, { recursive: true, force: true });
    }
});
