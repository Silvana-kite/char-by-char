import * as path from "path";
import * as vscode from "vscode";
import { ON_TYPE_FORMAT_TRIGGER_CHARACTERS } from "../constants";
import { restoreInsertionCursor } from "./document";
import { normalizeSourceText } from "./text";

const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export interface ResolvedSourceText {
  text: string;
  wasFormatted: boolean;
}

export function formatTextForLanguage(
  text: string,
  languageId: string,
  indentUnit = "  ",
): string | null {
  const normalizedLanguageId = normalizeLanguageId(languageId);

  if (normalizedLanguageId === "html") {
    return formatHtmlText(text, indentUnit);
  }

  if (normalizedLanguageId === "css") {
    return formatCssText(text, indentUnit);
  }

  if (
    normalizedLanguageId === "javascript"
    || normalizedLanguageId === "typescript"
  ) {
    return formatJavaScriptText(text, indentUnit);
  }

  return null;
}

export function choosePreferredFormattedTextForTest(
  languageId: string,
  originalText: string,
  providerText: string | null,
  fallbackText: string | null,
): string | null {
  return choosePreferredFormattedText(
    languageId,
    originalText,
    providerText,
    fallbackText,
  );
}

// 只有结构性字符才值得尝试一次按键格式化，避免每个字符都触发 provider。
export function shouldAttemptOnTypeFormatting(segment: string): boolean {
  return ON_TYPE_FORMAT_TRIGGER_CHARACTERS.has(segment);
}

// 格式化会改动文档长度，这里负责把旧光标偏移量映射到新文档上。
export function translateOffsetThroughEdits(
  document: vscode.TextDocument,
  offset: number,
  edits: readonly vscode.TextEdit[],
): number {
  const orderedEdits = Array.from(edits).sort((left, right) => {
    const leftStart = document.offsetAt(left.range.start);
    const rightStart = document.offsetAt(right.range.start);

    if (leftStart !== rightStart) {
      return leftStart - rightStart;
    }

    return document.offsetAt(left.range.end) - document.offsetAt(right.range.end);
  });

  let nextOffset = offset;

  for (const edit of orderedEdits) {
    const startOffset = document.offsetAt(edit.range.start);
    const endOffset = document.offsetAt(edit.range.end);
    const replacementLength = edit.newText.length;

    if (nextOffset < startOffset) {
      continue;
    }

    if (nextOffset <= endOffset) {
      nextOffset = startOffset + replacementLength;
      continue;
    }

    nextOffset += replacementLength - (endOffset - startOffset);
  }

  return nextOffset;
}

// 把 TextEdit 应用到内存字符串上，用于“先格式化源文本，再逐字输出”。
export function applyTextEditsToContent(
  document: vscode.TextDocument,
  edits: readonly vscode.TextEdit[],
): string {
  const orderedEdits = Array.from(edits).sort((left, right) => {
    const leftStart = document.offsetAt(left.range.start);
    const rightStart = document.offsetAt(right.range.start);

    if (leftStart !== rightStart) {
      return rightStart - leftStart;
    }

    return document.offsetAt(right.range.end) - document.offsetAt(left.range.end);
  });

  let nextText = document.getText();

  for (const edit of orderedEdits) {
    const startOffset = document.offsetAt(edit.range.start);
    const endOffset = document.offsetAt(edit.range.end);
    nextText =
      `${nextText.slice(0, startOffset)}${edit.newText}${nextText.slice(endOffset)}`;
  }

  return nextText;
}

// 供测试和兜底格式化直接调用：把单行 HTML 拆成可读的层级结构。
export function formatHtmlText(text: string, indentUnit = "  "): string {
  const normalizedText = normalizeSourceText(text).trim();
  if (normalizedText.length === 0) {
    return normalizedText;
  }

  const tokens = normalizedText.match(/<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?[a-zA-Z][^>]*?>|[^<]+/gi);
  if (!tokens) {
    return normalizedText;
  }

  const lines: string[] = [];
  let indentLevel = 0;

  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (!token) {
      continue;
    }

    if (/^<!doctype/i.test(token)) {
      lines.push("<!doctype html>");
      continue;
    }

    if (/^<!--/.test(token)) {
      lines.push(`${indentUnit.repeat(indentLevel)}${token}`);
      continue;
    }

    if (/^<\//.test(token)) {
      indentLevel = Math.max(0, indentLevel - 1);
      lines.push(`${indentUnit.repeat(indentLevel)}${token}`);
      continue;
    }

    if (/^</.test(token)) {
      const formattedTag = formatHtmlOpeningTag(token, indentLevel, indentUnit);
      lines.push(formattedTag);

      if (!isSelfClosingHtmlTag(token)) {
        indentLevel += 1;
      }

      continue;
    }

    const textContent = token.replace(/\s+/g, " ").trim();
    if (textContent) {
      lines.push(`${indentUnit.repeat(indentLevel)}${textContent}`);
    }
  }

  return lines.join("\n");
}

// 供测试和兜底格式化直接调用：把单行 JS/TS 拆成分号、花括号驱动的多行结构。
export function formatJavaScriptText(text: string, indentUnit = "  "): string {
  const normalizedText = normalizeSourceText(text).trim();
  if (normalizedText.length === 0) {
    return normalizedText;
  }

  const lines: string[] = [];
  let currentLine = "";
  let indentLevel = 0;
  let index = 0;

  while (index < normalizedText.length) {
    const currentChar = normalizedText[index];
    const nextChar = normalizedText[index + 1] ?? "";

    if (isWhitespace(currentChar)) {
      appendSpaceIfNeeded();
      index += 1;
      continue;
    }

    if (currentChar === "'" || currentChar === "\"" || currentChar === "`") {
      currentLine += readStringLiteral(normalizedText, index);
      index = advancePastStringLiteral(normalizedText, index);
      continue;
    }

    if (currentChar === "/" && nextChar === "/") {
      const comment = readLineComment(normalizedText, index);
      appendSpaceIfNeeded();
      currentLine += comment;
      pushCurrentLine();
      index += comment.length;
      continue;
    }

    if (currentChar === "/" && nextChar === "*") {
      const comment = readBlockComment(normalizedText, index);
      const commentLines = normalizeSourceText(comment).split("\n");

      if (currentLine.trim()) {
        pushCurrentLine();
      }

      for (const commentLine of commentLines) {
        lines.push(`${indentUnit.repeat(indentLevel)}${commentLine.trimEnd()}`);
      }

      index += comment.length;
      continue;
    }

    if (currentChar === "{") {
      trimCurrentLineEnd();
      if (currentLine && !currentLine.endsWith(" ")) {
        currentLine += " ";
      }

      currentLine += "{";
      pushCurrentLine();
      indentLevel += 1;
      index += 1;
      continue;
    }

    if (currentChar === "}") {
      if (currentLine.trim()) {
        pushCurrentLine();
      }

      indentLevel = Math.max(0, indentLevel - 1);
      currentLine = "}";

      const nextSignificantIndex = findNextSignificantIndex(normalizedText, index + 1);
      const nextSignificantChar = nextSignificantIndex >= 0
        ? normalizedText[nextSignificantIndex]
        : "";

      if (nextSignificantChar === ";" || nextSignificantChar === ",") {
        currentLine += nextSignificantChar;
        index = nextSignificantIndex + 1;
      } else {
        index += 1;
      }

      pushCurrentLine();
      continue;
    }

    if (currentChar === ";") {
      trimCurrentLineEnd();
      currentLine += ";";
      pushCurrentLine();
      index += 1;
      continue;
    }

    if (currentChar === ",") {
      trimCurrentLineEnd();
      currentLine += ", ";
      index += 1;
      continue;
    }

    currentLine += currentChar;
    index += 1;
  }

  if (currentLine.trim()) {
    pushCurrentLine();
  }

  return lines
    .filter((line, lineIndex, allLines) => {
      return !(line === "" && allLines[lineIndex - 1] === "");
    })
    .join("\n");

  function appendSpaceIfNeeded(): void {
    if (!currentLine || currentLine.endsWith(" ")) {
      return;
    }

    currentLine += " ";
  }

  function trimCurrentLineEnd(): void {
    currentLine = currentLine.replace(/[ \t]+$/g, "");
  }

  function pushCurrentLine(): void {
    const trimmedLine = normalizeJavaScriptLine(currentLine);
    lines.push(`${indentUnit.repeat(indentLevel)}${trimmedLine}`.trimEnd());
    currentLine = "";
  }
}

export function formatCssText(text: string, indentUnit = "  "): string {
  const normalizedText = normalizeSourceText(text).trim();
  if (normalizedText.length === 0) {
    return normalizedText;
  }

  const lines: string[] = [];
  let currentLine = "";
  let indentLevel = 0;
  let index = 0;

  while (index < normalizedText.length) {
    const currentChar = normalizedText[index];
    const nextChar = normalizedText[index + 1] ?? "";

    if (isWhitespace(currentChar)) {
      appendSpaceIfNeeded();
      index += 1;
      continue;
    }

    if (currentChar === "'" || currentChar === "\"" || currentChar === "`") {
      currentLine += readStringLiteral(normalizedText, index);
      index = advancePastStringLiteral(normalizedText, index);
      continue;
    }

    if (currentChar === "/" && nextChar === "*") {
      const comment = readBlockComment(normalizedText, index);
      const commentLines = normalizeSourceText(comment).split("\n");

      if (currentLine.trim()) {
        pushCurrentLine();
      }

      for (const commentLine of commentLines) {
        lines.push(`${indentUnit.repeat(indentLevel)}${commentLine.trimEnd()}`);
      }

      index += comment.length;
      continue;
    }

    if (currentChar === "{") {
      const selector = normalizeCssSelector(currentLine);
      if (selector) {
        lines.push(`${indentUnit.repeat(indentLevel)}${selector} {`);
      } else {
        lines.push(`${indentUnit.repeat(indentLevel)}{`);
      }

      currentLine = "";
      indentLevel += 1;
      index += 1;
      continue;
    }

    if (currentChar === "}") {
      if (currentLine.trim()) {
        pushCurrentLine();
      }

      indentLevel = Math.max(0, indentLevel - 1);
      lines.push(`${indentUnit.repeat(indentLevel)}}`);
      currentLine = "";
      index += 1;
      continue;
    }

    if (currentChar === ";") {
      const declaration = normalizeCssDeclaration(currentLine);
      if (declaration) {
        lines.push(`${indentUnit.repeat(indentLevel)}${declaration};`);
      }

      currentLine = "";
      index += 1;
      continue;
    }

    if (currentChar === ":") {
      currentLine = currentLine.replace(/[ \t]+$/g, "");
      currentLine += ": ";
      index += 1;

      while (isWhitespace(normalizedText[index] ?? "")) {
        index += 1;
      }

      continue;
    }

    if (currentChar === ",") {
      currentLine = currentLine.replace(/[ \t]+$/g, "");
      currentLine += ", ";
      index += 1;

      while (isWhitespace(normalizedText[index] ?? "")) {
        index += 1;
      }

      continue;
    }

    currentLine += currentChar;
    index += 1;
  }

  if (currentLine.trim()) {
    pushCurrentLine();
  }

  return lines
    .filter((line, lineIndex, allLines) => {
      return !(line === "" && allLines[lineIndex - 1] === "");
    })
    .join("\n");

  function appendSpaceIfNeeded(): void {
    if (!currentLine || currentLine.endsWith(" ")) {
      return;
    }

    currentLine += " ";
  }

  function pushCurrentLine(): void {
    const normalizedLine = normalizeCssLine(currentLine);
    if (!normalizedLine) {
      currentLine = "";
      return;
    }

    lines.push(`${indentUnit.repeat(indentLevel)}${normalizedLine}`.trimEnd());
    currentLine = "";
  }
}

// 优先走 VS Code 自带格式化；失败时再进入本地兜底格式化。
export async function tryResolveFormattedSourceText(
  document: vscode.TextDocument,
): Promise<ResolvedSourceText> {
  const providerResult = await tryResolveFormattedSourceTextWithProvider(document);
  const fallbackText = tryResolveFormattedSourceTextWithFallback(document);
  const preferredText = choosePreferredFormattedText(
    resolveDocumentLanguageId(document),
    document.getText(),
    providerResult.wasFormatted ? providerResult.text : null,
    fallbackText,
  );

  if (preferredText !== null && preferredText !== document.getText()) {
    return {
      text: preferredText,
      wasFormatted: true,
    };
  }

  if (providerResult.wasFormatted) {
    return providerResult;
  }

  return {
    text: document.getText(),
    wasFormatted: false,
  };
}

// 只有用户显式开启时，才会在输入后补一次按键级格式化。
export async function tryFormatOnType(
  editor: vscode.TextEditor,
  triggerCharacter: string,
): Promise<number | null> {
  if (!shouldAttemptOnTypeFormatting(triggerCharacter)) {
    return null;
  }

  const activePosition = editor.selection.active;
  const cursorOffset = editor.document.offsetAt(activePosition);

  try {
    const edits = await vscode.commands.executeCommand<
      vscode.TextEdit[] | undefined
    >(
      "vscode.executeFormatOnTypeProvider",
      editor.document.uri,
      activePosition,
      triggerCharacter,
      getFormattingOptionsForEditor(editor),
    );

    if (!edits || edits.length === 0) {
      return null;
    }

    const nextOffset = translateOffsetThroughEdits(
      editor.document,
      cursorOffset,
      edits,
    );
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(editor.document.uri, edits);

    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (!applied) {
      return null;
    }

    restoreInsertionCursor(editor, nextOffset);
    return nextOffset;
  } catch {
    return null;
  }
}

// 演示完成后补一次整篇格式化，主要用于最终收尾。
export async function tryFormatDocument(
  editor: vscode.TextEditor,
): Promise<boolean> {
  const cursorOffset = editor.document.offsetAt(editor.selection.active);

  try {
    const edits = await vscode.commands.executeCommand<
      vscode.TextEdit[] | undefined
    >(
      "vscode.executeFormatDocumentProvider",
      editor.document.uri,
      getFormattingOptionsForEditor(editor),
    );

    if (!edits) {
      return false;
    }

    if (edits.length === 0) {
      return true;
    }

    const nextOffset = translateOffsetThroughEdits(
      editor.document,
      cursorOffset,
      edits,
    );
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(editor.document.uri, edits);

    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (!applied) {
      return false;
    }

    restoreInsertionCursor(editor, nextOffset);
    return true;
  } catch {
    return false;
  }
}

async function tryResolveFormattedSourceTextWithProvider(
  document: vscode.TextDocument,
): Promise<ResolvedSourceText> {
  try {
    const edits = await vscode.commands.executeCommand<
      vscode.TextEdit[] | undefined
    >(
      "vscode.executeFormatDocumentProvider",
      document.uri,
      getFormattingOptionsForDocument(document),
    );

    if (!edits || edits.length === 0) {
      return {
        text: document.getText(),
        wasFormatted: false,
      };
    }

    return {
      text: applyTextEditsToContent(document, edits),
      wasFormatted: true,
    };
  } catch {
    return {
      text: document.getText(),
      wasFormatted: false,
    };
  }
}

// 当宿主环境没有 formatter 时，使用扩展内置的 HTML / JS 兜底格式化。
function tryResolveFormattedSourceTextWithFallback(
  document: vscode.TextDocument,
): string | null {
  const languageId = resolveDocumentLanguageId(document);
  const indentUnit = getIndentUnitForDocument(document);

  return formatTextForLanguage(document.getText(), languageId, indentUnit);
}

export function resolveDocumentLanguageId(document: vscode.TextDocument): string {
  if (document.languageId && document.languageId !== "plaintext") {
    return normalizeLanguageId(document.languageId);
  }

  const extension = path.extname(document.uri.fsPath).toLowerCase();
  if (extension === ".html" || extension === ".htm") {
    return "html";
  }

  if (extension === ".css" || extension === ".scss" || extension === ".less") {
    return "css";
  }

  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return "javascript";
  }

  if (extension === ".ts" || extension === ".tsx") {
    return "typescript";
  }

  if (extension === ".jsx") {
    return "javascript";
  }

  return normalizeLanguageId(document.languageId);
}

function isSelfClosingHtmlTag(token: string): boolean {
  if (/\/>$/.test(token)) {
    return true;
  }

  const tagName = token.match(/^<\s*([^\s/>]+)/)?.[1]?.toLowerCase();
  return Boolean(tagName && VOID_HTML_TAGS.has(tagName));
}

function formatHtmlOpeningTag(
  token: string,
  indentLevel: number,
  indentUnit: string,
): string {
  const tagIndent = indentUnit.repeat(indentLevel);
  const selfClosing = isSelfClosingHtmlTag(token);
  const tagBody = token
    .replace(/^</, "")
    .replace(/\/?>$/, "")
    .trim();
  const firstSpaceIndex = tagBody.search(/\s/);

  if (firstSpaceIndex < 0) {
    return `${tagIndent}<${tagBody}${selfClosing ? " />" : ">"}`;
  }

  const tagName = tagBody.slice(0, firstSpaceIndex);
  const attributeSource = tagBody.slice(firstSpaceIndex).trim();
  const attributes =
    attributeSource.match(/[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g)
    ?? [];

  if (attributes.length <= 1) {
    return `${tagIndent}<${tagName} ${attributes[0] ?? ""}${selfClosing ? " />" : ">"}`.trimEnd();
  }

  const attributeIndent = `${tagIndent}${indentUnit}`;
  return [
    `${tagIndent}<${tagName}`,
    ...attributes.map((attribute) => `${attributeIndent}${attribute}`),
    `${tagIndent}${selfClosing ? "/>" : ">"}`,
  ].join("\n");
}

function normalizeJavaScriptLine(line: string): string {
  return line
    .replace(/\s+/g, " ")
    .replace(/\b(if|for|while|switch|catch)\(/g, "$1 (")
    .replace(/\)\{/g, ") {")
    .replace(/\{\s+/g, "{ ")
    .replace(/\s+\}/g, " }")
    .replace(/\s+;/g, ";")
    .trim();
}

function normalizeCssSelector(line: string): string {
  return line
    .replace(/\s+/g, " ")
    .replace(/\s*([>+~])\s*/g, " $1 ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

function normalizeCssDeclaration(line: string): string {
  return line
    .replace(/\s+/g, " ")
    .replace(/\s*:\s*/g, ": ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*!important/g, " !important")
    .trim();
}

function normalizeCssLine(line: string): string {
  const collapsed = line.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return collapsed;
  }

  return collapsed.includes(":")
    ? normalizeCssDeclaration(collapsed)
    : normalizeCssSelector(collapsed);
}

function choosePreferredFormattedText(
  languageId: string,
  originalText: string,
  providerText: string | null,
  fallbackText: string | null,
): string | null {
  const candidates = [providerText, fallbackText]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .filter((value) => value !== originalText);

  if (candidates.length === 0) {
    return null;
  }

  if (!isStructuredLanguage(languageId)) {
    return candidates[0];
  }

  let bestCandidate = candidates[0];
  let bestScore = getStructuredTextScore(bestCandidate);

  for (const candidate of candidates.slice(1)) {
    const score = getStructuredTextScore(candidate);
    if (score > bestScore) {
      bestCandidate = candidate;
      bestScore = score;
    }
  }

  return bestCandidate;
}

function isStructuredLanguage(languageId: string): boolean {
  const normalizedLanguageId = normalizeLanguageId(languageId);
  return normalizedLanguageId === "html"
    || normalizedLanguageId === "css"
    || normalizedLanguageId === "javascript"
    || normalizedLanguageId === "typescript";
}

function getStructuredTextScore(text: string): number {
  const normalizedText = normalizeSourceText(text);
  const lines = normalizedText.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0).length;
  const maxLineLength = lines.reduce((max, line) => Math.max(max, line.length), 0);

  return nonEmptyLines * 1000 - maxLineLength;
}

function readStringLiteral(text: string, startIndex: number): string {
  return text.slice(startIndex, advancePastStringLiteral(text, startIndex));
}

function advancePastStringLiteral(text: string, startIndex: number): number {
  const quote = text[startIndex];
  let index = startIndex + 1;

  while (index < text.length) {
    const currentChar = text[index];

    if (currentChar === "\\") {
      index += 2;
      continue;
    }

    if (currentChar === quote) {
      return index + 1;
    }

    index += 1;
  }

  return text.length;
}

function readLineComment(text: string, startIndex: number): string {
  let index = startIndex;

  while (index < text.length && text[index] !== "\n") {
    index += 1;
  }

  return text.slice(startIndex, index);
}

function readBlockComment(text: string, startIndex: number): string {
  let index = startIndex + 2;

  while (index < text.length) {
    if (text[index] === "*" && text[index + 1] === "/") {
      return text.slice(startIndex, index + 2);
    }

    index += 1;
  }

  return text.slice(startIndex);
}

function findNextSignificantIndex(text: string, startIndex: number): number {
  let index = startIndex;

  while (index < text.length) {
    if (!isWhitespace(text[index])) {
      return index;
    }

    index += 1;
  }

  return -1;
}

function normalizeLanguageId(languageId: string): string {
  if (languageId === "javascriptreact") {
    return "javascript";
  }

  if (languageId === "typescriptreact") {
    return "typescript";
  }

  if (languageId === "scss" || languageId === "less") {
    return "css";
  }

  return languageId;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

// 兜底格式化统一输出空格缩进，避免 HTML / JS 再次出现 tab 累积。
function getIndentUnitForDocument(document: vscode.TextDocument): string {
  const options = getFormattingOptionsForDocument(document);
  const size = typeof options.tabSize === "number" && options.tabSize > 0
    ? options.tabSize
    : 2;

  return " ".repeat(size);
}

// 源文档还没显示在编辑器里时，只能从语言配置里推断缩进选项。
function getFormattingOptionsForDocument(
  document: vscode.TextDocument,
): vscode.FormattingOptions {
  const editorConfiguration = vscode.workspace.getConfiguration("editor", document);
  const tabSize = editorConfiguration.get<number | "auto">("tabSize", 2);
  const insertSpaces = editorConfiguration.get<boolean | "auto">(
    "insertSpaces",
    true,
  );

  return {
    tabSize: typeof tabSize === "number" ? tabSize : 2,
    insertSpaces: typeof insertSpaces === "boolean" ? insertSpaces : true,
  };
}

// 目标编辑器已存在时，优先使用它当前的实际缩进配置。
function getFormattingOptionsForEditor(
  editor: vscode.TextEditor,
): vscode.FormattingOptions {
  const documentOptions = getFormattingOptionsForDocument(editor.document);

  return {
    tabSize: typeof editor.options.tabSize === "number"
      ? editor.options.tabSize
      : documentOptions.tabSize,
    insertSpaces: typeof editor.options.insertSpaces === "boolean"
      ? editor.options.insertSpaces
      : documentOptions.insertSpaces,
  };
}
