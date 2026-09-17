import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { BitbucketDiffData, BitbucketDiffLine, BitbucketFileDiff } from '../../types/bitbucket.js';
import { asArray, getFilePath } from './diffFormatter.js';

export type InterfaceChangeKind =
    | 'parameter-breaking'
    | 'props-breaking'
    | 'return-breaking'
    | 'return-potentially-breaking'
    | 'compatible-interface-change'
    | 'implementation-only'
    | 'unknown';

export type InterfaceChangeConfidence = 'high' | 'medium' | 'low';

export interface InterfaceChange {
    kind: InterfaceChangeKind;
    confidence: InterfaceChangeConfidence;
    summary: string;
}

export interface ChangedSymbolForInterfaceAnalysis {
    symbol: string;
    definitionFile: string;
    definitionLineStart?: number;
    definitionLineEnd?: number;
}

type FunctionLikeDeclaration =
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction;

type ParsedFunction = {
    name: string;
    node: FunctionLikeDeclaration;
    startLine: number;
    endLine: number;
};

type ParameterShape = {
    required: boolean;
    rest: boolean;
    typeText: string;
    bindingText: string;
    initializerText: string;
};

type PropertyShape = {
    required: boolean;
    typeText: string;
};

type TypeShape = {
    properties: Map<string, PropertyShape>;
};

type ChangePart = {
    kind: InterfaceChangeKind;
    confidence: InterfaceChangeConfidence;
    detail: string;
};

const normalizeTypeText = (text: string | undefined): string => (text ?? '').replace(/\s+/g, '');

const normalizeExpressionText = (text: string | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();

const isFunctionLike = (node: ts.Node): node is FunctionLikeDeclaration =>
    ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessor(node)
    || ts.isSetAccessor(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node);

const hasModifier = (node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }, kind: ts.SyntaxKind): boolean =>
    node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;

const getFunctionName = (node: FunctionLikeDeclaration, sourceFile: ts.SourceFile): string | undefined => {
    if (node.name) return node.name.getText(sourceFile);

    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
        return parent.name.getText(sourceFile);
    }

    if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
        return parent.name.getText(sourceFile);
    }

    return undefined;
};

const getNodeLineRange = (node: ts.Node, sourceFile: ts.SourceFile): { startLine: number; endLine: number } => {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    return { startLine: start, endLine: end };
};

const parseSourceFile = (source: string, filePath: string): ts.SourceFile | undefined => {
    try {
        const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
        const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
        const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
        return parseDiagnostics && parseDiagnostics.length > 0 ? undefined : sourceFile;
    } catch {
        return undefined;
    }
};

const collectFunctions = (sourceFile: ts.SourceFile): ParsedFunction[] => {
    const functions: ParsedFunction[] = [];

    const visit = (node: ts.Node): void => {
        if (isFunctionLike(node)) {
            const name = getFunctionName(node, sourceFile);
            if (name) {
                const { startLine, endLine } = getNodeLineRange(node, sourceFile);
                functions.push({ name, node, startLine, endLine });
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return functions;
};

const getSimpleSymbolName = (symbol: string): string => {
    const namespaceParts = symbol.split('::');
    const lastNamespacePart = namespaceParts[namespaceParts.length - 1] ?? symbol;
    const memberParts = lastNamespacePart.split('.');
    return memberParts[memberParts.length - 1] ?? lastNamespacePart;
};

const findFunction = (
    sourceFile: ts.SourceFile,
    symbol: string,
    lineStart?: number,
    lineEnd?: number,
): ParsedFunction | undefined => {
    const simpleSymbolName = getSimpleSymbolName(symbol);
    const candidates = collectFunctions(sourceFile)
        .filter((fn) => fn.name === symbol || fn.name === simpleSymbolName);

    if (candidates.length === 0) return undefined;

    if (lineStart === undefined || lineEnd === undefined) {
        return candidates.length === 1 ? candidates[0] : undefined;
    }

    const overlapping = candidates.filter((fn) => fn.startLine <= lineEnd && fn.endLine >= lineStart);
    return overlapping.length === 1 ? overlapping[0] : undefined;
};

const getParameterShape = (parameter: ts.ParameterDeclaration, sourceFile: ts.SourceFile): ParameterShape => ({
    required: !parameter.dotDotDotToken && !parameter.questionToken && !parameter.initializer,
    rest: Boolean(parameter.dotDotDotToken),
    typeText: normalizeTypeText(parameter.type?.getText(sourceFile)),
    // 단순 식별자 이름은 호출부 계약이 아니므로 비교하지 않는다. 구조 분해 패턴은 계약에 해당한다.
    bindingText: ts.isIdentifier(parameter.name) ? '' : normalizeTypeText(parameter.name.getText(sourceFile)),
    initializerText: normalizeTypeText(parameter.initializer?.getText(sourceFile)),
});

const getParameterShapes = (fn: ParsedFunction, sourceFile: ts.SourceFile): ParameterShape[] =>
    fn.node.parameters.map((parameter) => getParameterShape(parameter, sourceFile));

const getTypeParameterText = (fn: ParsedFunction, sourceFile: ts.SourceFile): string =>
    normalizeTypeText(fn.node.typeParameters?.map((typeParameter) => typeParameter.getText(sourceFile)).join('|'));

const compareParameters = (
    before: ParsedFunction,
    after: ParsedFunction,
    beforeSourceFile: ts.SourceFile,
    afterSourceFile: ts.SourceFile,
): ChangePart | undefined => {
    const beforeParams = getParameterShapes(before, beforeSourceFile);
    const afterParams = getParameterShapes(after, afterSourceFile);
    const details: string[] = [];
    let breaking = false;
    let compatible = false;

    if (getTypeParameterText(before, beforeSourceFile) !== getTypeParameterText(after, afterSourceFile)) {
        breaking = true;
        details.push('제네릭 타입 매개변수 변경');
    }

    if (beforeParams.length !== afterParams.length) {
        if (afterParams.length < beforeParams.length) {
            breaking = true;
        } else {
            const addedParams = afterParams.slice(beforeParams.length);
            const hasRequiredAddedParameter = addedParams.some((parameter) => parameter.required);
            breaking = breaking || hasRequiredAddedParameter;
            compatible = compatible || !hasRequiredAddedParameter;
        }
        details.push(`인자 ${beforeParams.length}개 → ${afterParams.length}개`);
    }

    const commonLength = Math.min(beforeParams.length, afterParams.length);
    for (let index = 0; index < commonLength; index += 1) {
        const beforeParam = beforeParams[index];
        const afterParam = afterParams[index];
        if (!beforeParam || !afterParam) continue;

        if (beforeParam.rest !== afterParam.rest) {
            breaking = true;
            details.push(`${index + 1}번째 인자의 rest 여부 변경`);
        }

        if (!beforeParam.required && afterParam.required) {
            breaking = true;
            details.push(`${index + 1}번째 인자가 선택 인자에서 필수 인자로 변경`);
        } else if (beforeParam.required && !afterParam.required) {
            compatible = true;
            details.push(`${index + 1}번째 인자가 선택 인자로 완화`);
        }

        if (beforeParam.typeText !== afterParam.typeText) {
            breaking = true;
            details.push(`${index + 1}번째 인자 타입 변경`);
        }

        if (beforeParam.bindingText !== afterParam.bindingText) {
            breaking = true;
            details.push(`${index + 1}번째 구조 분해 인자 변경`);
        }

        if (beforeParam.initializerText && afterParam.initializerText && beforeParam.initializerText !== afterParam.initializerText) {
            breaking = true;
            details.push(`${index + 1}번째 인자의 기본값 변경`);
        } else if (!beforeParam.initializerText && afterParam.initializerText) {
            compatible = true;
            details.push(`${index + 1}번째 인자에 기본값 추가`);
        }
    }

    if (details.length === 0) return undefined;

    return {
        kind: breaking ? 'parameter-breaking' : 'compatible-interface-change',
        confidence: 'high',
        detail: details.join(', '),
    };
};

const getPropertyName = (name: ts.PropertyName, sourceFile: ts.SourceFile): string => {
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isIdentifier(name)) {
        return name.text;
    }
    return name.getText(sourceFile);
};

const getTypeShapeFromMembers = (members: ts.NodeArray<ts.TypeElement>, sourceFile: ts.SourceFile): TypeShape => {
    const properties = new Map<string, PropertyShape>();
    for (const member of members) {
        if (!ts.isPropertySignature(member) || !member.name) continue;
        properties.set(getPropertyName(member.name, sourceFile), {
            required: !member.questionToken,
            typeText: normalizeTypeText(member.type?.getText(sourceFile)),
        });
    }
    return { properties };
};

const collectTypeShapes = (sourceFile: ts.SourceFile): Map<string, TypeShape> => {
    const shapes = new Map<string, TypeShape>();
    const visit = (node: ts.Node): void => {
        if (ts.isInterfaceDeclaration(node)) {
            shapes.set(node.name.text, getTypeShapeFromMembers(node.members, sourceFile));
        } else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
            shapes.set(node.name.text, getTypeShapeFromMembers(node.type.members, sourceFile));
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return shapes;
};

const getInlineOrReferencedTypeShape = (parameter: ts.ParameterDeclaration, sourceFile: ts.SourceFile): TypeShape | undefined => {
    const typeNode = parameter.type;
    if (!typeNode) return undefined;

    if (ts.isTypeLiteralNode(typeNode)) {
        return getTypeShapeFromMembers(typeNode.members, sourceFile);
    }

    if (ts.isTypeReferenceNode(typeNode)) {
        const typeName = typeNode.typeName.getText(sourceFile);
        return collectTypeShapes(sourceFile).get(typeName);
    }

    return undefined;
};

const comparePropertyShapes = (beforeShape: TypeShape, afterShape: TypeShape): ChangePart | undefined => {
    const propertyNames = new Set([...beforeShape.properties.keys(), ...afterShape.properties.keys()]);
    const breakingDetails: string[] = [];
    const compatibleDetails: string[] = [];

    for (const propertyName of propertyNames) {
        const beforeProperty = beforeShape.properties.get(propertyName);
        const afterProperty = afterShape.properties.get(propertyName);

        if (!beforeProperty && afterProperty) {
            if (afterProperty.required) breakingDetails.push(`필수 Props '${propertyName}' 추가`);
            else compatibleDetails.push(`선택 Props '${propertyName}' 추가`);
            continue;
        }

        if (beforeProperty && !afterProperty) {
            if (beforeProperty.required) breakingDetails.push(`필수 Props '${propertyName}' 삭제`);
            else compatibleDetails.push(`선택 Props '${propertyName}' 삭제`);
            continue;
        }

        if (!beforeProperty || !afterProperty) continue;

        if (beforeProperty.typeText !== afterProperty.typeText) {
            breakingDetails.push(`Props '${propertyName}' 타입 변경`);
        }

        if (beforeProperty.required !== afterProperty.required) {
            if (afterProperty.required) breakingDetails.push(`Props '${propertyName}'가 필수로 변경`);
            else compatibleDetails.push(`Props '${propertyName}'가 선택으로 완화`);
        }
    }

    if (breakingDetails.length > 0) {
        return {
            kind: 'props-breaking',
            confidence: 'high',
            detail: breakingDetails.join(', '),
        };
    }

    if (compatibleDetails.length > 0) {
        return {
            kind: 'compatible-interface-change',
            confidence: 'high',
            detail: compatibleDetails.join(', '),
        };
    }

    return undefined;
};

const compareTypeShapes = (
    before: ParsedFunction,
    after: ParsedFunction,
    beforeSourceFile: ts.SourceFile,
    afterSourceFile: ts.SourceFile,
): ChangePart | undefined => {
    const changes: ChangePart[] = [];
    const commonLength = Math.min(before.node.parameters.length, after.node.parameters.length);

    for (let index = 0; index < commonLength; index += 1) {
        const beforeParameter = before.node.parameters[index];
        const afterParameter = after.node.parameters[index];
        if (!beforeParameter || !afterParameter) continue;

        const beforeShape = getInlineOrReferencedTypeShape(beforeParameter, beforeSourceFile);
        const afterShape = getInlineOrReferencedTypeShape(afterParameter, afterSourceFile);
        if (!beforeShape || !afterShape) continue;

        const change = comparePropertyShapes(beforeShape, afterShape);
        if (change) changes.push(change);
    }

    if (changes.length === 0) return undefined;
    const breaking = changes.filter((change) => change.kind === 'props-breaking');
    if (breaking.length > 0) {
        return {
            kind: 'props-breaking',
            confidence: 'high',
            detail: breaking.map((change) => change.detail).join(', '),
        };
    }

    return {
        kind: 'compatible-interface-change',
        confidence: 'high',
        detail: changes.map((change) => change.detail).join(', '),
    };
};

const collectReturnExpressions = (fn: ParsedFunction, sourceFile: ts.SourceFile): string[] => {
    const expressions: string[] = [];
    const body = fn.node.body;
    if (!body) return expressions;

    const visit = (node: ts.Node): void => {
        if (node !== body && isFunctionLike(node)) return;
        if (ts.isReturnStatement(node)) {
            expressions.push(normalizeExpressionText(node.expression?.getText(sourceFile)));
        }
        ts.forEachChild(node, visit);
    };

    visit(body);
    return expressions.sort();
};

const compareReturnContract = (
    before: ParsedFunction,
    after: ParsedFunction,
    beforeSourceFile: ts.SourceFile,
    afterSourceFile: ts.SourceFile,
): ChangePart | undefined => {
    const beforeReturnType = normalizeTypeText(before.node.type?.getText(beforeSourceFile));
    const afterReturnType = normalizeTypeText(after.node.type?.getText(afterSourceFile));
    const beforeAsync = hasModifier(before.node, ts.SyntaxKind.AsyncKeyword);
    const afterAsync = hasModifier(after.node, ts.SyntaxKind.AsyncKeyword);

    if (beforeReturnType !== afterReturnType) {
        return {
            kind: 'return-breaking',
            confidence: 'high',
            detail: '반환 타입 변경',
        };
    }

    if (beforeAsync !== afterAsync) {
        return {
            kind: 'return-breaking',
            confidence: 'high',
            detail: 'Promise 반환 여부 변경',
        };
    }

    if (beforeReturnType || afterReturnType) return undefined;

    const beforeExpressions = collectReturnExpressions(before, beforeSourceFile);
    const afterExpressions = collectReturnExpressions(after, afterSourceFile);
    if (JSON.stringify(beforeExpressions) !== JSON.stringify(afterExpressions)) {
        return {
            kind: 'return-potentially-breaking',
            confidence: 'medium',
            detail: '반환 표현식 변경',
        };
    }

    return undefined;
};

const choosePrimaryChange = (changes: ChangePart[]): InterfaceChange => {
    const priority: InterfaceChangeKind[] = [
        'parameter-breaking',
        'props-breaking',
        'return-breaking',
        'return-potentially-breaking',
        'compatible-interface-change',
    ];
    const primary = priority.map((kind) => changes.find((change) => change.kind === kind)).find(Boolean);
    if (!primary) {
        return {
            kind: 'implementation-only',
            confidence: 'high',
            summary: '외부 인터페이스 변경 없음',
        };
    }

    const details = [...new Set(changes.map((change) => change.detail).filter(Boolean))];
    return {
        kind: primary.kind,
        confidence: changes.some((change) => change.confidence === 'low') ? 'low' : primary.confidence,
        summary: details.join(', '),
    };
};

const unknownChange = (summary: string): InterfaceChange => ({
    kind: 'unknown',
    confidence: 'low',
    summary,
});

export interface CompareFunctionInterfaceInput {
    filePath: string;
    symbol: string;
    beforeSource: string;
    afterSource: string;
    definitionLineStart?: number;
    definitionLineEnd?: number;
}

/**
 * 같은 함수의 변경 전/후 AST를 비교해 호출부에 영향을 줄 수 있는 인터페이스 변화를 분류한다.
 * 명시적 타입뿐 아니라 타입 리터럴/로컬 Props의 필수 필드 변화와 추론 반환식 변화도 확인한다.
 */
export const compareFunctionInterface = (input: CompareFunctionInterfaceInput): InterfaceChange => {
    const beforeSourceFile = parseSourceFile(input.beforeSource, input.filePath);
    const afterSourceFile = parseSourceFile(input.afterSource, input.filePath);
    if (!beforeSourceFile || !afterSourceFile) return unknownChange('변경 전후 소스를 구문 분석하지 못했습니다.');

    const before = findFunction(beforeSourceFile, input.symbol, input.definitionLineStart, input.definitionLineEnd);
    const after = findFunction(afterSourceFile, input.symbol);
    if (!before || !after) return unknownChange('변경 전후 함수 위치를 대응하지 못했습니다.');

    const changes: ChangePart[] = [];
    const typeShapeChange = compareTypeShapes(before, after, beforeSourceFile, afterSourceFile);
    if (typeShapeChange) changes.push(typeShapeChange);

    const parameterChange = compareParameters(before, after, beforeSourceFile, afterSourceFile);
    if (parameterChange) changes.push(parameterChange);

    const returnChange = compareReturnContract(before, after, beforeSourceFile, afterSourceFile);
    if (returnChange) changes.push(returnChange);

    return choosePrimaryChange(changes);
};

const splitSourceLines = (source: string): { lines: string[]; trailingNewline: boolean } => {
    const normalized = source.replace(/\r\n/g, '\n');
    const trailingNewline = normalized.endsWith('\n');
    const content = trailingNewline ? normalized.slice(0, -1) : normalized;
    return {
        lines: content.length > 0 ? content.split('\n') : [],
        trailingNewline,
    };
};

const getLineNumber = (line: BitbucketDiffLine, segmentType: string): number | undefined => {
    const value = segmentType === 'ADDED' ? line.destination : line.source;
    return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
};

const getHunkStartLine = (hunk: NonNullable<BitbucketFileDiff['hunks']>[number], baseCursor: number): number | undefined => {
    const sourceNumbers: number[] = [];
    const destinationNumbers: number[] = [];

    for (const segment of asArray(hunk?.segments)) {
        for (const line of asArray(segment?.lines)) {
            const sourceNumber = getLineNumber(line, segment.type ?? '');
            if (segment.type === 'REMOVED' || segment.type === 'CONTEXT') {
                if (sourceNumber !== undefined) sourceNumbers.push(sourceNumber);
            } else if (segment.type === 'ADDED') {
                const destinationNumber = getLineNumber(line, segment.type);
                if (destinationNumber !== undefined) destinationNumbers.push(destinationNumber);
            }
        }
    }

    return sourceNumbers.length > 0
        ? Math.min(...sourceNumbers)
        : destinationNumbers.length > 0
            ? Math.min(...destinationNumbers)
            : baseCursor;
};

/**
 * Bitbucket diff를 base 소스에 적용해 PR 쪽 소스를 복원한다.
 * context/removed 라인이 base와 다르면 master가 PR base와 달라진 것으로 보고 undefined를 반환한다.
 */
export const applyBitbucketFileDiff = (baseSource: string | undefined, fileDiff: BitbucketFileDiff): string | undefined => {
    const base = splitSourceLines(baseSource ?? '');
    const output: string[] = [];
    let baseCursor = 1;

    for (const hunk of asArray(fileDiff?.hunks)) {
        const hunkStart = getHunkStartLine(hunk, baseCursor);
        if (hunkStart === undefined || hunkStart < baseCursor || hunkStart > base.lines.length + 1) return undefined;

        output.push(...base.lines.slice(baseCursor - 1, hunkStart - 1));
        baseCursor = hunkStart;

        for (const segment of asArray(hunk?.segments)) {
            for (const line of asArray(segment?.lines)) {
                const segmentType = segment.type ?? '';
                const lineText = line.line ?? '';

                if (segmentType === 'ADDED') {
                    output.push(lineText);
                    continue;
                }

                if (segmentType !== 'REMOVED' && segmentType !== 'CONTEXT') continue;
                const sourceLineNumber = getLineNumber(line, segmentType);
                const baseLine = base.lines[baseCursor - 1];
                if (sourceLineNumber !== baseCursor || baseLine === undefined || baseLine !== lineText) return undefined;

                if (segmentType === 'CONTEXT') output.push(lineText);
                baseCursor += 1;
            }
        }
    }

    output.push(...base.lines.slice(baseCursor - 1));
    const content = output.join('\n');
    return base.trailingNewline ? `${content}\n` : content;
};

/**
 * 현재 master 워크트리와 Bitbucket diff를 이용해 CRG가 찾은 심볼의 인터페이스 변화를 분석한다.
 * base 파일과 diff context가 맞지 않으면 unknown으로 분류해 안전하게 경고를 보존한다.
 */
export const analyzeChangedSymbolInterface = (
    masterWorktreePath: string,
    diffData: BitbucketDiffData | null | undefined,
    symbol: ChangedSymbolForInterfaceAnalysis,
): InterfaceChange => {
    const fileDiff = asArray(diffData?.diffs).find((candidate) => getFilePath(candidate) === symbol.definitionFile);
    if (!fileDiff) return unknownChange('해당 심볼의 diff를 찾지 못했습니다.');

    let beforeSource: string;
    try {
        beforeSource = readFileSync(path.join(masterWorktreePath, symbol.definitionFile), 'utf8');
    } catch {
        return unknownChange('변경 전 파일을 읽지 못했습니다.');
    }

    const afterSource = applyBitbucketFileDiff(beforeSource, fileDiff);
    if (afterSource === undefined) return unknownChange('현재 master와 PR diff의 기준 소스가 일치하지 않습니다.');

    return compareFunctionInterface({
        filePath: symbol.definitionFile,
        symbol: symbol.symbol,
        beforeSource,
        afterSource,
        definitionLineStart: symbol.definitionLineStart,
        definitionLineEnd: symbol.definitionLineEnd,
    });
};
