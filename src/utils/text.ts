// 按用户可感知的字符拆分，避免 emoji 或组合字符被拆坏。
export function splitIntoSegments(text: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });

    return Array.from(segmenter.segment(text), (item) => item.segment);
  }

  return Array.from(text);
}

// 统一换行符，避免不同系统里的 CRLF/CR 影响逐字输出节奏。
export function normalizeSourceText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function reindentMultilineText(text: string, baseIndent: string): string {
  const normalizedText = normalizeSourceText(text);
  if (!baseIndent || !normalizedText.includes("\n")) {
    return normalizedText;
  }

  const lines = normalizedText.split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^[\t ]*/)?.[0].length ?? 0);

  if (indents.length === 0) {
    return normalizedText;
  }

  const smallestIndent = Math.min(...indents);

  return lines
    .map((line) => {
      if (line.trim().length === 0) {
        return "";
      }

      return `${baseIndent}${line.slice(smallestIndent)}`;
    })
    .join("\n");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
