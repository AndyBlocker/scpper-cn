export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  if (!header) return {};
  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const eqIdx = part.indexOf('=');
      if (eqIdx === -1) {
        acc[part] = '';
        return acc;
      }
      const key = part.slice(0, eqIdx).trim();
      const value = part.slice(eqIdx + 1).trim();
      if (!key) return acc;
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}
