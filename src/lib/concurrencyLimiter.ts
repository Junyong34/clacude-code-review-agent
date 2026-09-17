/**
 * 전역 동시 실행 개수를 제한하는 counting semaphore.
 *
 * AI 코드리뷰의 Claude 스트림 호출은 PR·청크 구분 없이 이 리미터 하나를 공유한다.
 * 개발자 여러 명이 동시에 PR을 올리거나 한 PR이 여러 청크로 나뉘어도, 동시에 열리는
 * Claude 커넥션 수가 상한을 넘지 않게 해 rate limit 폭증을 막는 안전장치다.
 *
 * 프로젝트에 동시성 제어 라이브러리가 없어 새 의존성 없이 카운터 + FIFO 대기열로 직접 구현한다.
 * 단일 프로세스 in-memory 구현이므로, 서버가 여러 인스턴스로 스케일되면 인스턴스별로 상한이 따로 적용된다.
 */
export interface ConcurrencyLimiter {
    /**
     * 슬롯을 하나 확보한다. 여유 슬롯이 없으면 앞선 작업이 끝날 때까지 대기했다가 resolve된다.
     * resolve 값은 슬롯을 반납하는 release 함수이며, 작업이 끝나면 반드시 호출해야 한다.
     */
    acquire(): Promise<() => void>;
    /**
     * acquire → fn 실행 → release 를 자동으로 처리한다.
     * fn이 throw하거나 reject해도 finally에서 슬롯을 반드시 반납한다.
     */
    run<T>(fn: () => Promise<T>): Promise<T>;
    /** 현재 슬롯을 점유하고 실행 중인 작업 수. */
    activeCount(): number;
    /** 슬롯을 기다리며 대기 중인 작업 수. */
    pendingCount(): number;
}

/**
 * 최대 동시 실행 수가 `maxConcurrent`인 리미터를 만든다.
 * 0·음수·NaN 같은 잘못된 값이 들어와도 최소 1은 보장해 데드락을 방지한다.
 */
export const createConcurrencyLimiter = (maxConcurrent: number): ConcurrencyLimiter => {
    const limit = Math.max(1, Math.floor(maxConcurrent) || 1);
    let active = 0;
    // 슬롯이 없어 대기 중인 작업들의 "실행 시작" 콜백 큐 (선입선출).
    const waiters: Array<() => void> = [];

    const acquire = (): Promise<() => void> =>
        new Promise((resolve) => {
            // 슬롯을 점유하고, 호출자에게 반납용 release 함수를 넘긴다.
            const grant = (): void => {
                active += 1;
                let released = false;
                const release = (): void => {
                    // 중복 호출돼도 카운터를 한 번만 되돌린다(방어적 처리).
                    if (released) return;
                    released = true;
                    active -= 1;
                    const next = waiters.shift();
                    if (next) next();
                };
                resolve(release);
            };

            if (active < limit) {
                grant();
            } else {
                waiters.push(grant);
            }
        });

    const run = async <T>(fn: () => Promise<T>): Promise<T> => {
        const release = await acquire();
        try {
            return await fn();
        } finally {
            release();
        }
    };

    return {
        acquire,
        run,
        activeCount: () => active,
        pendingCount: () => waiters.length,
    };
};
