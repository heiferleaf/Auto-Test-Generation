import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { isNonActionableName, isNonActionableRole, sanitizeLocator, actionableName } from '../src/recorder/inject';

describe('isNonActionableName', () => {
  it('过长文案、屏幕阅读器说明、带快捷键的长帮助不当 name', () => {
    expect(isNonActionableName('x'.repeat(81))).toBe(true);
    expect(isNonActionableName('The editor is not accessible. To enable screen reader optimized mode, use Shift+Alt+F1')).toBe(true);
    expect(isNonActionableName('Press Ctrl+K to enable the command palette overlay')).toBe(true);
    expect(isNonActionableName('Chat')).toBe(false);
    expect(isNonActionableName('Save')).toBe(false);
    expect(isNonActionableName('发送 (Ctrl+Enter)')).toBe(false);
    expect(isNonActionableName(undefined)).toBe(false);
  });

  it('负例：某段 overlay 长文案不得被当成可操作 name（不是中文词表）', () => {
    const overlay = '现在无法访问编辑器。 若要启用屏幕阅读器优化模式，请使用 Shift+Alt+F1';
    expect(isNonActionableName(overlay)).toBe(true);
  });

  it('sanitizeLocator 去掉帮助文案 name，保留 role/css', () => {
    const overlay = '现在无法访问编辑器。 若要启用屏幕阅读器优化模式，请使用 Shift+Alt+F1';
    const out = sanitizeLocator({ role: 'textbox', name: overlay, css: 'div > div' });
    expect(out?.name).toBeUndefined();
    expect(out?.role).toBe('textbox');
    expect(out?.css).toBe('div > div');
    expect(sanitizeLocator({ role: 'button', name: 'Save' })?.name).toBe('Save');
    expect(sanitizeLocator({ role: 'presentation', css: 'div > span' })?.role).toBeUndefined();
    expect(actionableName('发送\r\n[Alt] 发送到新聊天 (Ctrl+Shift+Enter)')).toBe('发送');
  });
});

describe('isNonActionableRole', () => {
  it('presentation / none 不可作为回放 role', () => {
    expect(isNonActionableRole('presentation')).toBe(true);
    expect(isNonActionableRole('none')).toBe(true);
    expect(isNonActionableRole('button')).toBe(false);
    expect(isNonActionableRole('textbox')).toBe(false);
  });
});

describe('fillOnPage 不得绑定某一款 App 的 class', () => {
  it('targets.ts 不含 monaco / 聊天框专用选择器', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../src/cdp/targets.ts'), 'utf8');
    expect(src).not.toMatch(/monaco-editor|interactive-input-part|native-edit-context|textarea\.inputarea|view-lines/);
    expect(src).not.toMatch(/fillCandidateCss|VISIBLE_FILL_CSS|isA11yOverlayName/);
  });

  it('clickOnPage 在 name 不可用时把 css 放在 role 前面，且不 getByRole(presentation)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../src/cdp/targets.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function clickOnPage'), src.indexOf('export async function fillOnPage'));
    expect(fn.indexOf('if (l.css)')).toBeGreaterThan(-1);
    expect(fn.indexOf('if (l.css)')).toBeLessThan(fn.indexOf('roleOk && text'));
    expect(fn).toMatch(/isNonActionableRole/);
    expect(fn).not.toMatch(/getByRole\(\s*['"]presentation['"]/);
  });
});
