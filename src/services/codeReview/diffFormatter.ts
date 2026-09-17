import type {
    BitbucketDiffData,
    BitbucketDiffLine,
    BitbucketDiffSegment,
    BitbucketFileDiff,
    ReviewLineType,
    TruncatedValue,
} from '../../types/bitbucket.js';
import type { IncludedReviewFile, ReviewDiffChunk } from '../../types/review.js';

/**
 * Bitbucket PR diff JSON을 AI 코드리뷰 입력 청크(들)로 변환한다.
 *
 * 주요 책임:
 * - Bitbucket이 이미 truncate한 diff인지 nested 구조까지 검사
 * - ADD/REM/CTX 라인을 기존 프롬프트 형식으로 직렬화
 * - 큰 CONTEXT 구간과 저신호 파일이 문자 예산을 과하게 쓰지 않도록 압축/후순위 처리
 * - diff를 문자 예산 기준으로 여러 청크로 나눈다. 문자열 중간이 아니라 파일/라인 경계에서만 나누고,
 *   예산을 넘는다고 라인을 버리지 않는다(모든 라인은 반드시 어느 청크엔가 포함된다).
 */
const DEFAULT_MAX_CHARS = 40_000;
const DEFAULT_CONTEXT_LINES = 3;

type ReviewDiffChunksOptions = {
    maxChars?: number;
    contextLines?: number;
};

type SegmentType = ReviewLineType | string;

type FilePriority = {
    fileDiff: BitbucketFileDiff;
    index: number;
    path: string;
    priority: number;
};

type ContextEntry =
    | { kind: 'line'; source: BitbucketDiffLine }
    | { kind: 'context-marker'; text: string };

type RenderedLine =
    | { kind: 'line'; text: string; segmentType: SegmentType }
    | { kind: 'context-marker'; text: string; segmentType: SegmentType };

// 지금 채우고 있는 청크의 누적 상태.
// files: 파일 경로 → 이 청크에 담긴 실제 코드 라인 수.
// length: lines를 '\n'으로 이었을 때의 문자열 길이를 증분으로 추적한 값(매 append마다 join하지 않기 위함).
type ChunkAccumulator = {
    lines: string[];
    files: Map<string, number>;
    length: number;
};

const LOW_SIGNAL_FILE_PATTERNS: RegExp[] = [
    /(^|\/)package-lock\.json$/,
    /(^|\/)yarn\.lock$/,
    /(^|\/)pnpm-lock\.yaml$/,
    /(^|\/)Gemfile\.lock$/,
    /(^|\/)composer\.lock$/,
    /\.snap$/,
    /\.min\.(js|css)$/,
    /(^|\/)dist\//,
    /(^|\/)build\//,
    /generated/i,
    /\.generated\./i
];

const TRUNCATED_VALUE = new Set<TruncatedValue>([true, 'true']);

/**
 * Bitbucket diff 응답에서 boolean true 또는 string "true" truncate 값을 동일하게 판단한다.
 */
const isTruncatedValue = (value: unknown): value is true | 'true' =>
    TRUNCATED_VALUE.has(value as TruncatedValue);

/**
 * optional 배열 필드를 안전하게 순회하기 위한 작은 유틸리티다.
 * symbolReference.ts 등 다른 diff 순회 모듈도 재사용하도록 export한다.
 */
export const asArray = <T>(value: T[] | undefined): T[] => Array.isArray(value) ? value : [];

/**
 * Bitbucket file diff에서 리뷰 대상 파일 경로를 우선순위대로 추출한다.
 * commentVerifier.ts, symbolReference.ts 등 다른 diff 순회 모듈이 동일 경로 규칙을 쓰도록 export한다.
 */
export const getFilePath = (fileDiff: BitbucketFileDiff): string =>
    fileDiff?.destination?.toString ||
    fileDiff?.source?.toString ||
    fileDiff?.path?.toString ||
    'unknown';

/**
 * segment 유형에 맞춰 추가/삭제 라인의 실제 line number를 선택한다.
 */
export const getLineNumber = (segmentType: SegmentType, line: BitbucketDiffLine): number | '?' => {
    const value = segmentType === 'REMOVED' ? line?.source : line?.destination;
    return typeof value === 'number' && Number.isInteger(value) ? value : '?';
};

/**
 * Claude 프롬프트가 이해하는 `[ADD:N]`, `[REM:N]`, `[CTX:N]` prefix를 만든다.
 */
const getPrefix = (segmentType: SegmentType, lineNumber: number | '?'): string => {
    if (segmentType === 'ADDED') return `[ADD:${lineNumber}] +`;
    if (segmentType === 'REMOVED') return `[REM:${lineNumber}] -`;
    return `[CTX:${lineNumber}]  `;
};

/**
 * Bitbucket diff line 하나를 리뷰 입력용 한 줄 텍스트로 직렬화한다.
 */
const formatLine = (segmentType: SegmentType, line: BitbucketDiffLine): string => {
    const lineNumber = getLineNumber(segmentType, line);
    return `${getPrefix(segmentType, lineNumber)}${line?.line ?? ''}`;
};

/**
 * lockfile, 빌드 산출물, generated 파일처럼 리뷰 신호가 낮은 파일인지 판별한다.
 */
const isLowSignalFile = (path: string): boolean =>
    LOW_SIGNAL_FILE_PATTERNS.some((pattern) => pattern.test(path));

/**
 * 파일별 처리 순서를 정하기 위해 경로와 우선순위 metadata를 묶는다.
 */
const filePriority = (fileDiff: BitbucketFileDiff, index: number): FilePriority => ({
    fileDiff,
    index,
    path: getFilePath(fileDiff),
    priority: isLowSignalFile(getFilePath(fileDiff)) ? 1 : 0
});

/**
 * 소스 파일을 먼저, lock/generated 파일을 나중에 처리하도록 diff 파일 목록을 정렬한다.
 */
const sortFileDiffs = (diffs: BitbucketFileDiff[]): FilePriority[] =>
    diffs
        .map(filePriority)
        .sort((a, b) => a.priority - b.priority || a.index - b.index);

// 한 라인이 그 자체로 청크 예산보다 길 때(예: 커밋된 minified 한 줄, 긴 data URI/JSON) 붙이는 마커.
const LINE_CAP_MARKER = ' … [원본 라인이 너무 길어 잘림]';

/**
 * 라인 하나가 청크 예산(maxChars)보다 길면 예산에 맞게 잘라 마커를 붙인다.
 * 이런 초대형 단일 라인을 그대로 청크에 담으면 Claude 입력 컨텍스트를 초과해 그 PR 전체 리뷰가 실패하므로,
 * 라인 앞부분(라인 번호 prefix 포함)만 남기고 잘라 컨텍스트 초과를 막는다. 라인 자체는 여전히 청크에 남는다.
 */
const capLine = (text: string, maxChars: number): string => {
    if (text.length <= maxChars) return text;
    const keep = Math.max(0, maxChars - LINE_CAP_MARKER.length);
    return `${text.slice(0, keep)}${LINE_CAP_MARKER}`;
};

/**
 * 큰 CONTEXT segment는 앞/뒤 일부만 남기고 중간을 `[OMITTED]` marker로 압축한다.
 */
const compressContextLines = (lines: BitbucketDiffLine[], contextLines: number): {
    lines: ContextEntry[];
    omittedContextLineCount: number;
} => {
    if (contextLines < 0 || lines.length <= contextLines * 2 + 1) {
        return {
            lines: lines.map((line): ContextEntry => ({ kind: 'line', source: line })),
            omittedContextLineCount: 0
        };
    }

    const omittedCount = lines.length - contextLines * 2;
    const head = lines.slice(0, contextLines).map((line): ContextEntry => ({ kind: 'line', source: line }));
    const tail = lines.slice(lines.length - contextLines).map((line): ContextEntry => ({ kind: 'line', source: line }));

    return {
        lines: [
            ...head,
            { kind: 'context-marker', text: `[OMITTED] ${omittedCount} unchanged context lines omitted` },
            ...tail
        ],
        omittedContextLineCount: omittedCount
    };
};

/**
 * Bitbucket segment를 리뷰 입력 라인 목록으로 변환한다.
 * CONTEXT segment는 먼저 압축해 변경 라인이 입력 예산을 더 많이 쓰도록 한다.
 */
const renderSegmentLines = (segment: BitbucketDiffSegment, contextLines: number): RenderedLine[] => {
    const segmentType = segment?.type || 'CONTEXT';
    const lines = asArray(segment?.lines);

    if (segmentType === 'CONTEXT') {
        const compressed = compressContextLines(lines, contextLines);
        return compressed.lines.map((entry) => {
            if (entry.kind === 'context-marker') {
                return { kind: 'context-marker', text: entry.text, segmentType };
            }
            return { kind: 'line', text: formatLine(segmentType, entry.source), segmentType };
        });
    }

    return lines.map((line) => ({ kind: 'line', text: formatLine(segmentType, line), segmentType }));
};

/**
 * 파일 하나에 포함된 모든 hunk/segment를 리뷰 입력 라인으로 펼친다.
 */
const renderFileLines = (fileDiff: BitbucketFileDiff, contextLines: number): RenderedLine[] =>
    asArray(fileDiff?.hunks).flatMap((hunk) =>
        asArray(hunk?.segments).flatMap((segment) => renderSegmentLines(segment, contextLines))
    );

/**
 * Bitbucket diff 응답의 모든 계층에서 truncate 여부를 확인한다.
 * 최상위뿐 아니라 file/hunk/segment/line 단위 truncate도 리뷰 스킵 조건으로 사용한다.
 */
export const isBitbucketDiffTruncated = (diffData: BitbucketDiffData | null | undefined): boolean => {
    if (!diffData || typeof diffData !== 'object') return false;
    if (isTruncatedValue(diffData.truncated)) return true;

    return asArray(diffData.diffs).some((fileDiff) => {
        if (isTruncatedValue(fileDiff?.truncated)) return true;

        return asArray(fileDiff?.hunks).some((hunk) => {
            if (isTruncatedValue(hunk?.truncated)) return true;

            return asArray(hunk?.segments).some((segment) => {
                if (isTruncatedValue(segment?.truncated)) return true;

                return asArray(segment?.lines).some((line) => isTruncatedValue(line?.truncated));
            });
        });
    });
};

/**
 * diff의 ADDED/REMOVED 라인만 `file:line:lineType` 키로 모은다.
 * 게시 전 로컬 검증(commentVerifier.ts)이 AI가 만든 코멘트의 라인이 실제 diff에 존재하는지
 * 확인할 때 쓰는 정답 집합이다. CONTEXT 라인은 포함하지 않는다(코멘트는 ADD/REM에만 고정하는 규칙).
 */
export const collectValidLineKeys = (diffData: BitbucketDiffData | null | undefined): Set<string> => {
    const keys = new Set<string>();

    for (const fileDiff of asArray(diffData?.diffs)) {
        const path = getFilePath(fileDiff);

        for (const hunk of asArray(fileDiff?.hunks)) {
            for (const segment of asArray(hunk?.segments)) {
                const segmentType = segment?.type;
                if (segmentType !== 'ADDED' && segmentType !== 'REMOVED') continue;

                for (const line of asArray(segment?.lines)) {
                    const lineNumber = getLineNumber(segmentType, line);
                    if (lineNumber === '?') continue;
                    keys.add(`${path}:${lineNumber}:${segmentType}`);
                }
            }
        }
    }

    return keys;
};

/**
 * Bitbucket diff JSON을 Claude 리뷰 프롬프트용 청크 목록으로 변환한다.
 *
 * 파일 우선순위(소스파일 우선, lockfile/generated 후순위)를 유지하면서 `maxChars` 예산 단위로 청크를 나눈다.
 * - 한 파일이 예산보다 크면 그 파일의 남은 라인을 다음 청크로 이어 담고(라인 경계에서만 분할),
 *   이어지는 세그먼트 헤더에는 `(이어서)`를 붙여 Claude가 같은 파일임을 알 수 있게 한다.
 * - 어떤 라인도 버리지 않으므로, 작은 PR은 청크 1개, 큰 PR은 여러 개가 된다.
 */
export const buildReviewDiffChunks = (
    diffData: BitbucketDiffData | null | undefined,
    options: ReviewDiffChunksOptions = {}
): ReviewDiffChunk[] => {
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;

    const chunks: ChunkAccumulator[] = [];
    let current: ChunkAccumulator = { lines: [], files: new Map(), length: 0 };

    // 현재 청크에 라인을 추가하면서 누적 길이(length)를 증분으로 갱신한다.
    // 매번 lines.join('\n')을 다시 계산하지 않아 청크 빌드가 라인 수에 선형이다.
    const pushLine = (text: string): void => {
        current.length += (current.lines.length === 0 ? 0 : 1) + text.length;
        current.lines.push(text);
    };

    // 현재 청크를 확정하고 새 빈 청크를 연다. 비어 있으면 아무것도 하지 않는다.
    const flushCurrent = (): void => {
        if (current.lines.length === 0) return;
        chunks.push(current);
        current = { lines: [], files: new Map(), length: 0 };
    };

    // 파일의 렌더링된 라인들을 현재 청크부터 채우되, 예산을 넘으면 라인 경계에서 다음 청크로 이어 담는다.
    const packFile = (path: string, rendered: RenderedLine[]): void => {
        let index = 0;
        let continuation = false; // 같은 파일이 여러 청크에 걸칠 때, 두 번째 세그먼트부터 true

        while (index < rendered.length) {
            const headerLabel = `FILE: ${path}${continuation ? ' (이어서)' : ''}`;
            const firstLineText = capLine(rendered[index].text, maxChars);

            // 현재 청크에 이미 내용이 있고 (구분 빈 줄 + 헤더 + 첫 라인)을 넣으면 예산을 넘길 경우 먼저 flush한다.
            // 첫 라인 하나는 반드시 들어가야 진행이 보장되므로, 이 판단은 "현재 청크가 이미 차 있는지"만 본다.
            const projected =
                current.length +
                1 /* 파일 구분용 빈 줄 */ +
                headerLabel.length + 1 + '---'.length +
                1 + firstLineText.length;
            if (current.lines.length > 0 && projected > maxChars) {
                flushCurrent();
            }

            // 헤더를 쓴다. 같은 청크에서 앞 파일과 구분하기 위한 빈 줄을 먼저 넣는다.
            if (current.lines.length > 0) pushLine('');
            pushLine(headerLabel);
            pushLine('---');
            if (!current.files.has(path)) current.files.set(path, 0);

            // 예산이 허용하는 만큼 이 파일의 라인을 채운다.
            let placedInSegment = 0;
            while (index < rendered.length) {
                const entry = rendered[index];
                // 초대형 단일 라인은 잘라 담아 청크가 컨텍스트를 넘지 않게 한다(그 라인만 잘리고 나머지는 온전).
                const text = capLine(entry.text, maxChars);
                const projectedLength = current.lines.length === 0 ? text.length : current.length + 1 + text.length;
                const overBudget = projectedLength > maxChars;
                // 세그먼트에 최소 한 줄은 넣어 무한 루프를 막는다(캡을 거친 첫 줄은 항상 담긴다).
                if (overBudget && placedInSegment > 0) break;

                pushLine(text);
                if (entry.kind === 'line') {
                    current.files.set(path, (current.files.get(path) ?? 0) + 1);
                }
                placedInSegment += 1;
                index += 1;
            }

            // 아직 이 파일의 라인이 남았으면 새 청크로 넘어가 이어서 담는다.
            if (index < rendered.length) {
                flushCurrent();
                continuation = true;
            }
        }
    };

    for (const { fileDiff, path } of sortFileDiffs(asArray(diffData?.diffs))) {
        const rendered = renderFileLines(fileDiff, contextLines);
        if (rendered.length === 0) continue; // 리뷰할 ADD/REM/CTX 라인이 없는 파일은 건너뛴다.
        packFile(path, rendered);
    }

    flushCurrent();

    const totalChunks = chunks.length;
    return chunks.map((chunk, chunkIndex) => ({
        text: chunk.lines.join('\n'),
        includedFiles: [...chunk.files.entries()].map(([filePath, lineCount]): IncludedReviewFile => ({
            path: filePath,
            priority: isLowSignalFile(filePath) ? 1 : 0,
            lineCount,
        })),
        chunkIndex,
        totalChunks,
    }));
};
