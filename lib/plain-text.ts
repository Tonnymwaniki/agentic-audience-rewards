/**
 * YouTube returns comment text HTML-encoded ("didn&#39;t", <br>, timestamp links).
 * Plain text for display. A plain module (not a client component file) so server
 * components can call it.
 */
export function plainText(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}
