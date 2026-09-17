import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BitbucketDiffData, BitbucketDiffLine } from '../../types/bitbucket.js';
import { asArray, getFilePath } from './diffFormatter.js';
import type { InterfaceChange } from './interfaceChange.js';

/**
 * "미갱신 참조 파일" 힌트: diff에서 변경된 함수/컴포넌트를 마스터 워크트리의 code-review-graph
 * (.code-review-graph/graph.db)에서 조회해, 그 심볼을 참조하지만 이번 PR의 변경 파일 목록에는
 * 없는 파일을 찾는다. 참조 카운트가 아니라 "호출부 정리가 이 PR에 빠졌을 가능성"이라는 확인된
 * 사실을 전달하는 게 목적이다.
 */

export interface LineRange {
    start: number;
    end: number;
}

/**
 * REMOVED/CONTEXT 라인의 source(base 라인 번호)만 사용한다. ADDED 라인은 base에 존재하지 않으므로
 * (source=null) 쓰지 않는다. CONTEXT를 포함하는 이유는, REMOVED가 없는 순수 삽입 hunk에서도 주변
 * CONTEXT 라인으로 base 파일에서의 삽입 위치를 앵커링할 수 있기 때문이다.
 */
const getBaseLineNumber = (line: BitbucketDiffLine): number | undefined => {
    const value = line?.source;
    return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
};

/**
 * diff의 hunk마다 REMOVED/CONTEXT 라인의 base 라인 번호로 "이번 diff가 건드린 base 라인 범위"를 만든다.
 * REMOVED/CONTEXT가 전혀 없는 hunk(base 라인 앵커가 없는 순수 삽입)는 건너뛴다.
 */
export const collectChangedBaseLineRanges = (diffData: BitbucketDiffData | null | undefined): Map<string, LineRange[]> => {
    const result = new Map<string, LineRange[]>();

    for (const fileDiff of asArray(diffData?.diffs)) {
        const filePath = getFilePath(fileDiff);
        const ranges: LineRange[] = [];

        for (const hunk of asArray(fileDiff?.hunks)) {
            const baseLineNumbers: number[] = [];

            for (const segment of asArray(hunk?.segments)) {
                if (segment?.type !== 'REMOVED' && segment?.type !== 'CONTEXT') continue;
                for (const line of asArray(segment?.lines)) {
                    const lineNumber = getBaseLineNumber(line);
                    if (lineNumber !== undefined) baseLineNumbers.push(lineNumber);
                }
            }

            if (baseLineNumbers.length === 0) continue;
            ranges.push({ start: Math.min(...baseLineNumbers), end: Math.max(...baseLineNumbers) });
        }

        if (ranges.length > 0) result.set(filePath, ranges);
    }

    return result;
};

export interface UnupdatedReferenceFile {
    symbol: string;
    definitionFile: string;
    definitionLineStart?: number;
    definitionLineEnd?: number;
    referencingFiles: string[];
    interfaceChange?: InterfaceChange;
}

type FunctionNodeRow = { qualified_name: string; name: string; line_start: number; line_end: number };
type ReferencingFileRow = { file_path: string };

// 단순 참조 카운트가 아니라 "누가 이 심볼을 쓰는가"를 보는 것이므로 CALLS(호출)와 REFERENCES(그 외 참조)만 본다.
// CONTAINS(소속 관계)/IMPORTS_FROM(파일 단위 import)/HANDLES/INJECTS/INHERITS/TESTED_BY는 다른 목적의 엣지라 제외한다.
const REFERENCE_EDGE_KINDS = ['CALLS', 'REFERENCES'] as const;

/**
 * masterWorktreePath/.code-review-graph/graph.db를 read-only로 열어 미갱신 참조 파일을 찾는다.
 * 그래프가 없거나 쿼리가 실패해도 throw하지 않고 []를 반환한다 — 리뷰 전체를 절대 막지 않는다.
 */
export const findUnupdatedReferenceFiles = async (
    masterWorktreePath: string,
    diffData: BitbucketDiffData | null | undefined
): Promise<UnupdatedReferenceFile[]> => {
    const graphDbPath = path.join(masterWorktreePath, '.code-review-graph', 'graph.db');
    if (!existsSync(graphDbPath)) {
        console.log('[code-review] code-review-graph DB가 없어 심볼 참조 힌트를 건너뜁니다.');
        return [];
    }

    const changedBaseLineRanges = collectChangedBaseLineRanges(diffData);
    if (changedBaseLineRanges.size === 0) return [];

    const changedFiles = new Set(asArray(diffData?.diffs).map((fileDiff) => getFilePath(fileDiff)));

    let db: DatabaseSync | undefined;
    try {
        db = new DatabaseSync(graphDbPath, { readOnly: true });

        const findFunctionsStmt = db.prepare(
            `SELECT qualified_name, name FROM nodes WHERE kind = 'Function' AND file_path = ? AND line_start <= ? AND line_end >= ?`
        );
        const findReferencingFilesStmt = db.prepare(
            `SELECT DISTINCT file_path FROM edges WHERE kind IN (${REFERENCE_EDGE_KINDS.map(() => '?').join(',')}) AND target_qualified = ?`
        );

        const entries: UnupdatedReferenceFile[] = [];
        const seenSymbols = new Set<string>();

        for (const [relativeFilePath, ranges] of changedBaseLineRanges) {
            const absoluteFilePath = path.join(masterWorktreePath, relativeFilePath);

            for (const range of ranges) {
                const rows = findFunctionsStmt.all(absoluteFilePath, range.end, range.start) as FunctionNodeRow[];

                for (const row of rows) {
                    if (seenSymbols.has(row.qualified_name)) continue;
                    seenSymbols.add(row.qualified_name);

                    const refRows = findReferencingFilesStmt.all(...REFERENCE_EDGE_KINDS, row.qualified_name) as ReferencingFileRow[];
                    const referencingFiles = refRows
                        .map((refRow) => path.relative(masterWorktreePath, refRow.file_path))
                        .filter((relPath) => !changedFiles.has(relPath));

                    if (referencingFiles.length > 0) {
                        entries.push({
                            symbol: row.name,
                            definitionFile: relativeFilePath,
                            definitionLineStart: row.line_start,
                            definitionLineEnd: row.line_end,
                            referencingFiles,
                        });
                    }
                }
            }
        }

        return entries;
    } catch (error) {
        console.error('[code-review] 심볼 참조 힌트 쿼리 실패(무시):', (error as Error).message);
        return [];
    } finally {
        db?.close();
    }
};

const ACTIONABLE_INTERFACE_CHANGE_KINDS = new Set<InterfaceChange['kind']>([
    'parameter-breaking',
    'props-breaking',
    'return-breaking',
    'return-potentially-breaking',
]);

const NON_ACTIONABLE_INTERFACE_CHANGE_KINDS = new Set<InterfaceChange['kind']>([
    'implementation-only',
    'compatible-interface-change',
]);

const getInterfaceChange = (entry: UnupdatedReferenceFile): InterfaceChange => entry.interfaceChange ?? {
    kind: 'unknown',
    confidence: 'low',
    summary: '외부 인터페이스 변경 여부를 자동으로 확인하지 못했습니다.',
};

type ReferenceDetail = {
    symbol: string;
    definitionFile: string;
    summary: string;
};

const buildReferenceGroups = (entries: UnupdatedReferenceFile[]): Map<string, ReferenceDetail[]> => {
    const referencesByFile = new Map<string, ReferenceDetail[]>();
    for (const entry of entries) {
        const change = getInterfaceChange(entry);
        if (NON_ACTIONABLE_INTERFACE_CHANGE_KINDS.has(change.kind)) continue;

        for (const referencingFile of entry.referencingFiles) {
            const references = referencesByFile.get(referencingFile) ?? [];
            const detail = {
                symbol: entry.symbol,
                definitionFile: entry.definitionFile,
                summary: change.summary,
            };
            const isDuplicate = references.some(
                (reference) => reference.symbol === detail.symbol
                    && reference.definitionFile === detail.definitionFile
                    && reference.summary === detail.summary,
            );
            if (!isDuplicate) references.push(detail);
            referencesByFile.set(referencingFile, references);
        }
    }
    return referencesByFile;
};

const buildReferenceLines = (entries: UnupdatedReferenceFile[]): string => {
    const referencesByFile = buildReferenceGroups(entries);
    return [...referencesByFile.entries()].map(([referencingFile, references]) => [
        `- 확인할 파일: \`${referencingFile}\``,
        ...references.map((reference) => `  - \`${reference.definitionFile}\` 파일에서 **${reference.symbol} 함수**가 변경되었습니다. (변경 내용: ${reference.summary})`),
        `  - 위 함수${references.length > 1 ? '들을' : '를'} 사용하고 있어, 이번 변경이 해당 파일의 동작에 영향을 주는지 확인해 주세요.`,
    ].join('\n')).join('\n');
};

const buildReferenceSection = (
    entries: UnupdatedReferenceFile[],
    heading: string,
    description: string,
): string => {
    if (entries.length === 0) return '';
    const lines = buildReferenceLines(entries);
    if (!lines) return '';

    return [heading, '', description, '', lines].join('\n');
};

/** Tier 1: 최종 PR 코멘트에 항상 붙는 결정론적 섹션. entries가 비면 빈 문자열. */
export const buildSymbolReferenceMarkdown = (entries: UnupdatedReferenceFile[]): string => {
    if (entries.length === 0) return '';

    const actionableEntries = entries.filter((entry) => ACTIONABLE_INTERFACE_CHANGE_KINDS.has(getInterfaceChange(entry).kind));
    const uncertainEntries = entries.filter((entry) => getInterfaceChange(entry).kind === 'unknown');
    return [
        buildReferenceSection(
            actionableEntries,
            '### 호출부 확인이 필요합니다',
            '이번 PR에서 변경된 함수 또는 컴포넌트를 사용하지만, 이번 PR에는 포함되지 않은 파일입니다.\n아래 파일에 이번 변경으로 인한 영향이 있는지 확인해 주세요.',
        ),
        buildReferenceSection(
            uncertainEntries,
            '### 자동 확인이 제한된 항목',
            '변경된 함수 또는 컴포넌트를 사용하는 파일이지만, 변경 영향 여부를 자동으로 확정하지 못했습니다. 필요한 경우 호출부를 확인해 주세요.',
        ),
    ].filter(Boolean).join('\n\n');
};

/** Tier 2: Claude 프롬프트에 실험적으로 주입하는 힌트. 파일 경로만(라인/스니펫 없음). entries가 비면 빈 문자열. */
export const buildSymbolReferenceHintText = (entries: UnupdatedReferenceFile[]): string => {
    if (entries.length === 0) return '';

    return entries
        .filter((entry) => !NON_ACTIONABLE_INTERFACE_CHANGE_KINDS.has(getInterfaceChange(entry).kind))
        .map((entry) => `[REF] ${entry.symbol}(${entry.definitionFile}): ${getInterfaceChange(entry).summary} — 참조하지만 이번 PR에서 변경되지 않은 파일: ${entry.referencingFiles.join(', ')}`)
        .join('\n');
};
