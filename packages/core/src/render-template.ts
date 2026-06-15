/**
 * Substitutes {{var}} placeholders in `body` with values from `vars`.
 * Unknown vars render as "" and are logged (never throws — a bad template
 * must not break a send).
 */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    if (key in vars) return vars[key]!;
    console.warn(`renderTemplate: unknown variable {{${key}}} -> empty`);
    return "";
  });
}
