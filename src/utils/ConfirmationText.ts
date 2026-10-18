/** Keep the words exact while accepting punctuation, spacing, width and case variants. */
export function matchesConfirmationText(value: string, expected: string): boolean {
  const normalize = (text: string) =>
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '')
  return normalize(value) === normalize(expected)
}
