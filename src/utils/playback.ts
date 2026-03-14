import { normalizeSourceText, splitIntoSegments } from "./text";

const STRUCTURED_LANGUAGE_IDS = new Set([
  "html",
  "css",
  "javascript",
  "typescript",
]);

export function buildPlaybackSteps(text: string, languageId: string): string[] {
  const normalizedText = normalizeSourceText(text);
  const normalizedLanguageId = normalizeLanguageId(languageId);

  if (!STRUCTURED_LANGUAGE_IDS.has(normalizedLanguageId)) {
    return splitIntoSegments(normalizedText);
  }

  const lines = normalizedText.split("\n");
  const steps: string[] = [];

  for (const [index, line] of lines.entries()) {
    const indent = line.match(/^[\t ]+/)?.[0] ?? "";
    const content = line.slice(indent.length);

    if (indent) {
      steps.push(indent);
    }

    steps.push(...splitIntoSegments(content));

    if (index < lines.length - 1) {
      steps.push("\n");
    }
  }

  return steps;
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
