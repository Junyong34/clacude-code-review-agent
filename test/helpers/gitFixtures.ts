import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const git = (args: string[], cwd: string): void => {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
};

export interface FakeContextClone {
    tmpRoot: string;
    /** "이미 준비된 example-app clone" 역할 — production 코드가 fetch만 실행하는 대상. */
    clonePath: string;
    /** origin이 가리키는 가짜 원격(bare repo). */
    remotePath: string;
    /** 원격에 새 커밋을 밀어넣기 위한 별도 작업 디렉토리. */
    seedPath: string;
}

/**
 * "이미 준비된 example-app clone" 상태를 재현하는 fixture를 만든다.
 * 가짜 원격(bare repo)을 만들고 그걸 실제로 clone해서, production 코드가 기대하는
 * "origin이 설정된 기존 clone"을 그대로 재현한다. clonePath는 실제 example-app처럼
 * master가 아닌 다른 브랜치를 체크아웃하고 미커밋 변경을 남긴 상태로 만든다.
 */
export const createFakeContextClone = (): FakeContextClone => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'crb-git-fixture-'));
    const remotePath = path.join(tmpRoot, 'remote.git');
    const seedPath = path.join(tmpRoot, 'seed');
    const clonePath = path.join(tmpRoot, 'clone');

    mkdirSync(remotePath);
    git(['init', '--bare', '-b', 'master', remotePath], tmpRoot);

    mkdirSync(seedPath);
    git(['init', '-b', 'master', seedPath], tmpRoot);
    git(['config', 'user.email', 'test@example.com'], seedPath);
    git(['config', 'user.name', 'test'], seedPath);
    writeFileSync(path.join(seedPath, 'a.ts'), 'export const a = 1;\n');
    git(['add', '.'], seedPath);
    git(['commit', '-m', 'initial'], seedPath);
    git(['remote', 'add', 'origin', remotePath], seedPath);
    git(['push', 'origin', 'master'], seedPath);

    git(['clone', remotePath, clonePath], tmpRoot);
    git(['checkout', '-b', 'feature/local-work'], clonePath);
    // 실제 example-app처럼 미커밋 변경을 남겨둔다 — refresh가 이걸 건드리면 안 된다.
    writeFileSync(path.join(clonePath, 'a.ts'), 'export const a = 1; // local wip\n');

    return { tmpRoot, clonePath, remotePath, seedPath };
};

/** 가짜 원격에 새 커밋을 추가한다(다음 fetch가 반영해야 할 변경). */
export const addCommitToRemote = (fixture: FakeContextClone, fileName: string, content: string): void => {
    writeFileSync(path.join(fixture.seedPath, fileName), content);
    git(['add', '.'], fixture.seedPath);
    git(['commit', '-m', `add ${fileName}`], fixture.seedPath);
    git(['push', 'origin', 'master'], fixture.seedPath);
};

/** clonePath(기존 clone 역할)의 현재 체크아웃 브랜치와 git status 출력을 스냅샷한다. */
export const snapshotCloneState = (clonePath: string): { branch: string; status: string } => ({
    branch: execFileSync('git', ['-C', clonePath, 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim(),
    status: execFileSync('git', ['-C', clonePath, 'status', '--short']).toString().trim(),
});

/** code-review-graph CLI가 로컬에 설치돼 있는지 확인한다(없으면 관련 테스트를 스킵). */
export const isCodeReviewGraphAvailable = (): boolean => {
    try {
        execFileSync('code-review-graph', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};
