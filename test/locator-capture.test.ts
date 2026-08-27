// @vitest-environment jsdom
// B5 ?? DOM ?? + ???????spec �2.2.1 / ????????
// ??? jsdom ????????????????????
//   - ???? span/i ? ???????? + ? css ???
//   - ??? input ????? fill
//   - ???????????
//   - ????? PICK_INJECT ????

import { describe, it, expect, beforeEach } from 'vitest';
import { RECORD_INJECT, RECORD_DRAIN, PICK_INJECT, PICK_DRAIN, PICK_STOP, REC_BUF, PICK_RESULT } from '../src/recorder/inject';

function setupNestedButton() {
  // ?????button > span.icon > i??? i ???? button?
  const btn = document.createElement('button');
  btn.id = 'submit-btn';
  btn.setAttribute('aria-label', '??');
  const span = document.createElement('span');
  span.className = 'icon';
  const i = document.createElement('i');
  i.textContent = 'ok';
  span.appendChild(i);
  btn.appendChild(span);
  document.body.appendChild(btn);
  return { btn, span, i };
}

// ? new Function ?????????????jsdom ? window.eval ????
// ????? IIFE ???????????helpers ? recorder ?????????
function runInWindow(code: string): void {
  // eslint-disable-next-line no-new-func
  new Function(code)();
}

// ????????? DRAIN ??????? IIFE??
function evalInWindow(code: string): unknown {
  // eslint-disable-next-line no-new-func
  return new Function('return ' + code)();
}

function fireClick(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function fireInput(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

describe('B5 ??????????�2.2.1?', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // ????????? __recInstalled / __atgLocatorHelpers ??
    // ????????????? return???????? RECORD_INJECT ????????
    // ???????????????????????? guard ???????
    (window as any)[REC_BUF] = [];
  });

  it('?? DOM ?????? <i> ? locator ??? button ?? + ? css', () => {
    const { i } = setupNestedButton();
    runInWindow(RECORD_INJECT);
    fireClick(i);
    const events = evalInWindow(RECORD_DRAIN) as any[];
    expect(events).toHaveLength(1);
    const loc = events[0].locator;
    // name ?? button ? aria-label
    expect(loc.name).toBe('??');
    // button ? id?css ?????? #id???????
    expect(loc.css).toBe('#submit-btn');
  });

  it('???????? input?n?ni?ni ????????? fill?value=??', () => {
    const inp = document.createElement('input');
    inp.id = 'msg';
    inp.setAttribute('aria-label', '??');
    document.body.appendChild(inp);
    runInWindow(RECORD_INJECT);
    fireInput(inp, 'n');
    fireInput(inp, 'ni');
    fireInput(inp, 'ni ');
    fireInput(inp, '??');
    const events = evalInWindow(RECORD_DRAIN) as any[];
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('fill');
    expect(events[0].params.value).toBe('??');
    expect(events[0].locator.name).toBe('??');
    expect(events[0].locator.css).toBeTruthy();
  });

  it('??????????? A ?? B ? ?? fill?css ???', () => {
    const a = document.createElement('input');
    a.id = 'a'; a.setAttribute('aria-label', 'A');
    const b = document.createElement('input');
    b.id = 'b'; b.setAttribute('aria-label', 'B');
    document.body.appendChild(a);
    document.body.appendChild(b);
    runInWindow(RECORD_INJECT);
    fireInput(a, 'aa');
    fireInput(b, 'bb');
    const events = evalInWindow(RECORD_DRAIN) as any[];
    expect(events).toHaveLength(2);
    expect(events[0].locator.name).toBe('A');
    expect(events[1].locator.name).toBe('B');
  });

  it('????????click ? fill ?? click ??', () => {
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', '??');
    const inp = document.createElement('input');
    inp.id = 'x'; inp.setAttribute('aria-label', 'X');
    document.body.appendChild(btn);
    document.body.appendChild(inp);
    runInWindow(RECORD_INJECT);
    fireClick(btn);
    fireInput(inp, 'hi');
    const events = evalInWindow(RECORD_DRAIN) as any[];
    expect(events.map((e) => e.type)).toEqual(['click', 'fill']);
  });

  it('PICK_INJECT ???????? <i> ? ?? button?locator ? css ? name', () => {
    const { i } = setupNestedButton();
    runInWindow(PICK_INJECT);
    fireClick(i);
    const res = evalInWindow(PICK_DRAIN) as any;
    expect(res).toBeTruthy();
    expect(res.name).toBe('??');
    expect(res.css).toBe('#submit-btn');
    // ????????????
    expect((window as any)[PICK_RESULT]).toBeNull();
  });

  it('PICK_STOP ?????', () => {
    runInWindow(PICK_INJECT);
    runInWindow(PICK_STOP);
    expect((window as any)[PICK_RESULT]).toBeNull();
  });
});
