import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { CODE_REVIEW_CONTEXT_CLONE_PATH, CODE_REVIEW_MASTER_WORKTREE_DIR } from '../../config/env.js';
import { createConcurrencyLimiter } from '../../lib/concurrencyLimiter.js';

/**
 * 심볼 참조 힌트(symbolReference.ts)가 쓰는 마스터 워크트리를 관리한다.
 *
 * example-app은 이미 로컬에 clone돼 있다(컨텍스트 클론, CODE_REVIEW_CONTEXT_CLONE_PATH). 이 clone은
 * 사용자가 일상적으로 쓰는 작업 디렉토리이므로 절대 건드리지 않는다 — fetch만 실행한다(working tree 무관).
 *
 * 이 서비스 자신의 디렉토리 아래에 마스터 워크트리 하나를 상시 유지한다. 재리뷰마다
 * 새로 만들고 지우는 게 아니라 계속 재사용하며, 매번 최신 master로 강제 동기화(reset --hard)한다.
 * 이 워크트리는 항상 detached HEAD이고 로컬 커밋을 절대 만들지 않으므로 hard reset이 안전하다.
 *
 * 그 안의 .code-review-graph/graph.db도 함께 최신화한다(최초엔 build, 이후는 증분 update).
 */

const execFileAsync = promisify(execFile);

export interface ContextCloneConfig {
    contextClonePath: string;
    masterWorktreeDir: string;
}

const resolveConfig = (overrides: Partial<ContextCloneConfig> = {}): ContextCloneConfig => {
    const contextClonePath = overrides.contextClonePath ?? CODE_REVIEW_CONTEXT_CLONE_PATH;
    if (!contextClonePath) {
        throw new Error('CODE_REVIEW_CONTEXT_CLONE_PATH가 설정되지 않았습니다.');
    }

    const masterWorktreeDir = overrides.masterWorktreeDir ?? CODE_REVIEW_MASTER_WORKTREE_DIR;
    return {
        contextClonePath: path.resolve(contextClonePath),
        masterWorktreeDir: path.resolve(masterWorktreeDir),
    };
};

const runGit = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, { maxBuffer: 1024 * 1024 * 10 });
    return stdout.trim();
};

// git worktree add로 만든 워크트리인지 확인한다(일반 디렉토리와 구분).
const isGitWorktree = (worktreePath: string): boolean => existsSync(path.join(worktreePath, '.git'));

/**
 * git 부분만 담당: 컨텍스트 클론에서 origin/master를 fetch(작업 디렉토리는 절대 안 건드림)하고,
 * 마스터 워크트리가 없으면 새로 만들고, 있으면 최신 master로 강제 동기화한다.
 * code-review-graph 호출과 분리되어 있어 git 부분만 단독으로 테스트할 수 있다.
 */
export const refreshMasterWorktreeGit = async (overrides: Partial<ContextCloneConfig> = {}): Promise<string> => {
    const { contextClonePath, masterWorktreeDir } = resolveConfig(overrides);

    await runGit(['-C', contextClonePath, 'fetch', 'origin', 'master']);

    if (!isGitWorktree(masterWorktreeDir)) {
        mkdirSync(path.dirname(masterWorktreeDir), { recursive: true });
        await runGit(['-C', contextClonePath, 'worktree', 'add', '--detach', masterWorktreeDir, 'origin/master']);
    } else {
        await runGit(['-C', masterWorktreeDir, 'reset', '--hard', 'origin/master']);
    }

    return masterWorktreeDir;
};

/**
 * code-review-graph 부분만 담당: <worktreePath>/.code-review-graph/graph.db가 없으면 최초 build(느릴 수
 * 있음), 있으면 git diff 기반 증분 update로 최신화한다. child_process로 code-review-graph CLI를 shell-out한다.
 */
export const refreshCodeReviewGraph = async (worktreePath: string): Promise<void> => {
    const graphDbPath = path.join(worktreePath, '.code-review-graph', 'graph.db');
    const command = existsSync(graphDbPath) ? 'update' : 'build';
    await execFileAsync('code-review-graph', [command, '--repo', worktreePath, '--quiet'], {
        maxBuffer: 1024 * 1024 * 10,
    });
};

// 동시에 여러 재리뷰가 들어와도 마스터 워크트리 refresh 사이클(git + code-review-graph) 전체를 직렬화한다.
const masterWorktreeLimiter = createConcurrencyLimiter(1);

/**
 * prReview.ts가 실제로 호출하는 진입점. git 갱신 + code-review-graph 최신화를 하나의 mutex 안에서
 * 원자적으로 실행하고, 완성된 마스터 워크트리 경로를 반환한다.
 */
export const ensureMasterWorktreeReady = (overrides: Partial<ContextCloneConfig> = {}): Promise<string> =>
    masterWorktreeLimiter.run(async () => {
        const worktreePath = await refreshMasterWorktreeGit(overrides);
        await refreshCodeReviewGraph(worktreePath);
        return worktreePath;
    });
