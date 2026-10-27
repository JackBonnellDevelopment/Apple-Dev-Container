export function applyDockerFormat(template: string, value: unknown): string {
  const withEscapes = template.replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  return withEscapes.replace(/\{\{\s*(json\s+)?(\.[A-Za-z0-9_.]*)\s*\}\}/g, (_match, jsonPrefix: string | undefined, path: string) => {
    const parts = path.split('.').filter(Boolean);
    let current: unknown = value;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[part];
    }
    if (jsonPrefix) {
      return JSON.stringify(current ?? null);
    }
    if (current == null) {
      return '';
    }
    if (typeof current === 'string') {
      return current;
    }
    if (typeof current === 'object') {
      return JSON.stringify(current);
    }
    return String(current);
  });
}
