// MCP 入参跨 JSON 边界：null ≠ 省略。函数默认参数对 null 无效，必须在体内 ?? {}。

export function asArgs(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export function omitted(v: unknown): boolean {
  return v === null || v === undefined;
}

export function asOptionalString(v: unknown): string | undefined {
  if (omitted(v)) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

export function asOptionalNumber(v: unknown): number | undefined {
  if (omitted(v)) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
