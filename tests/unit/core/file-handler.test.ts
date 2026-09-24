import { describe, it, expect } from 'vitest';
import { countWords, processPromptAndFiles } from '../../../src/core/file-handler.js';
import { readFileSync, existsSync } from 'node:fs';

describe('file-handler', () => {
  it('accurately counts words', () => {
    expect(countWords('hello world')).toBe(2);
    expect(countWords('   one   two   three   ')).toBe(3);
    expect(countWords('')).toBe(0);
    expect(countWords('\n\nmulti\nline\ttext\n')).toBe(3);
  });

  it('keeps short prompt as text without converting to file', () => {
    const prompt = 'What is the speed of light?';
    const result = processPromptAndFiles(prompt, [], 25000);
    expect(result.wasAutoConvertedToFile).toBe(false);
    expect(result.promptText).toBe(prompt);
    expect(result.files).toHaveLength(0);
    expect(result.originalWordCount).toBe(6);
  });

  it('auto-converts prompts >= 25,000 words into a document file', () => {
    // Generate 25,050 words
    const words = Array.from({ length: 25050 }, (_, i) => `word${i}`);
    const longPrompt = words.join(' ');

    const result = processPromptAndFiles(longPrompt, [], 25000);
    expect(result.wasAutoConvertedToFile).toBe(true);
    expect(result.originalWordCount).toBe(25050);
    expect(result.files).toHaveLength(1);

    const attachedFile = result.files[0];
    expect(attachedFile.name).toContain('prompt_document_');
    expect(attachedFile.type).toBe('text/plain');
    expect(attachedFile.path).toBeDefined();
    expect(existsSync(attachedFile.path!)).toBe(true);

    const savedContent = readFileSync(attachedFile.path!, 'utf-8');
    expect(savedContent).toBe(longPrompt);

    expect(result.promptText).toContain('[Document Analysis Request]');
    expect(result.promptText).toContain('25,050 words');
  });

  it('preserves existing attachments when auto-converting long prompt', () => {
    const words = Array.from({ length: 25000 }, () => 'test').join(' ');
    const existingFile = { name: 'sample.png', type: 'image/png', data: 'dGVzdA==' };

    const result = processPromptAndFiles(words, [existingFile], 25000);
    expect(result.wasAutoConvertedToFile).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].name).toContain('prompt_document_');
    expect(result.files[1].name).toBe('sample.png');
  });
});
