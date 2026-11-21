export function extractHtml(text: string): string | null {
  const start = text.search(/<!doctype\s+html\s*>|<html\b/i);
  const end = text.toLowerCase().lastIndexOf('</html>');
  return start >= 0 && end >= start ? text.slice(start, end + 7) : null;
}
