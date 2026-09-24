import { describe, it, expect } from 'vitest';
import { sanitizeResponseText } from '../../../src/browser/ui-driver.js';

describe('sanitizeResponseText', () => {
  it('returns empty string for empty input', () => {
    expect(sanitizeResponseText('')).toBe('');
  });

  it('preserves clean answer text', () => {
    const text = 'Hello! This is a complete assistant response.';
    expect(sanitizeResponseText(text)).toBe(text);
  });

  it('strips <think> blocks completely', () => {
    const input = '<think>\nLet me solve this math problem.\nFirst 2+2=4.\n</think>\nThe answer is 4.';
    expect(sanitizeResponseText(input)).toBe('The answer is 4.');
  });

  it('strips <thought> blocks completely', () => {
    const input = '<thought>User is asking for code.</thought>```python\nprint("hello")\n```';
    expect(sanitizeResponseText(input)).toBe('```python\nprint("hello")\n```');
  });

  it('strips <reasoning> blocks completely', () => {
    const input = '<reasoning>Step by step breakdown...</reasoning>Final verdict: Success.';
    expect(sanitizeResponseText(input)).toBe('Final verdict: Success.');
  });

  it('silences in-progress streaming thoughts', () => {
    const inProgress = '<think>I am currently pondering the question';
    expect(sanitizeResponseText(inProgress)).toBe('');
  });

  it('strips status prefixes like Thought for X seconds and Thinking Process', () => {
    expect(sanitizeResponseText('Thought for 8 seconds\nHere is your response.')).toBe('Here is your response.');
    expect(sanitizeResponseText('Thinking Process:\nHere is your response.')).toBe('Here is your response.');
    expect(sanitizeResponseText('Constructing preview...\nHere is your response.')).toBe('Here is your response.');
  });
});
