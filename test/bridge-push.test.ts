// 测试先行：M3-R1 WS 桥主动推送通道 + 边界兜底。
// 重点：sanitizeArgs 把 JSON 序列化产生的 null 还原为 undefined（防 null.target 崩溃）；
// serializeBuffers 把 Buffer 转 base64（跨 WS 安全）。

import { describe, it, expect } from 'vitest';
import { sanitizeArgs, serializeBuffers } from '../src/ui/bridge-server';

describe('sanitizeArgs — WS 边界兜底', () => {
  it('把 null 元素还原为 undefined，其余透传', () => {
    expect(sanitizeArgs([null, { a: 1 }, 'x'])).toEqual([undefined, { a: 1 }, 'x']);
  });
  it('空数组返回空数组', () => {
    expect(sanitizeArgs([])).toEqual([]);
  });
  it('undefined 不会变成 null（保持 undefined）', () => {
    // JSON 序列化时 undefined 元素直接消失，这里验证兜底对已有 undefined 不动
    expect(sanitizeArgs([undefined, 2])).toEqual([undefined, 2]);
  });
});

describe('serializeBuffers — 跨 WS 序列化安全', () => {
  it('Buffer 转为 { __base64 }', () => {
    const r = serializeBuffers(Buffer.from('abc'));
    expect(r).toEqual({ __base64: Buffer.from('abc').toString('base64') });
  });
  it('嵌套数组/对象中的 Buffer 递归转换', () => {
    const r = serializeBuffers({ a: [Buffer.from('x')], b: 1 });
    expect(r).toEqual({ a: [{ __base64: Buffer.from('x').toString('base64') }], b: 1 });
  });
  it('null / 普通值原样返回', () => {
    expect(serializeBuffers(null)).toBeNull();
    expect(serializeBuffers('hi')).toBe('hi');
  });
});
