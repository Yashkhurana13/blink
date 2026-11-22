export function extractHtml(text: string): string | null {
  const start = text.search(/<!doctype\s+html\s*>|<html\b/i);
  const end = text.toLowerCase().lastIndexOf('</html>');
  return start >= 0 && end >= start ? text.slice(start, end + 7) : null;
}

export function extractTitle(html: string) {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1].trim();
  if (!title) return 'Untitled app';
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return title.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name: string) => {
    if (!name.startsWith('#')) return entities[name.toLowerCase()] ?? entity;
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}
