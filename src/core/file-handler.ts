import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';

export interface FileAttachment {
  name: string;
  type: string;
  data?: string; // base64 or text
  path?: string; // local file path if available
  size?: number;
}

export interface ProcessedPrompt {
  promptText: string;
  files: FileAttachment[];
  wasAutoConvertedToFile: boolean;
  originalWordCount: number;
}

// Word count threshold for auto-creating a prompt document file (25,000 words)
export const PROMPT_AUTO_FILE_WORD_THRESHOLD = 25000;

/**
 * Count words in a string.
 */
export function countWords(text: string): number {
  if (!text || typeof text !== 'string') return 0;
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

/**
 * Ensures temporary directory for web-model-bridge files exists.
 */
export function getTempDirectory(): string {
  const dir = join(tmpdir(), 'web-model-bridge-files');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Write a file attachment to disk if it only has base64 data, returning the absolute path.
 */
export function persistFileToDisk(file: FileAttachment): string {
  if (file.path && existsSync(file.path)) {
    return file.path;
  }

  const tempDir = getTempDirectory();
  const safeName = (file.name || `file_${Date.now()}`).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const targetPath = join(tempDir, `${crypto.randomUUID().slice(0, 8)}_${safeName}`);

  if (file.data) {
    // Check if data is base64 data URI (e.g. data:image/png;base64,...)
    const matches = file.data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (matches) {
      const buffer = Buffer.from(matches[2], 'base64');
      writeFileSync(targetPath, buffer);
    } else {
      // Raw string or base64
      try {
        const buffer = Buffer.from(file.data, 'base64');
        writeFileSync(targetPath, buffer);
      } catch {
        writeFileSync(targetPath, file.data, 'utf-8');
      }
    }
  } else {
    writeFileSync(targetPath, '', 'utf-8');
  }

  file.path = targetPath;
  return targetPath;
}

/**
 * Pre-processes a user prompt.
 * If word count exceeds PROMPT_AUTO_FILE_WORD_THRESHOLD (25,000 words),
 * writes the prompt to a file, attaches it, and replaces the prompt text
 * with a comment instruction to analyze the attached document.
 */
export function processPromptAndFiles(
  prompt: string,
  existingFiles: FileAttachment[] = [],
  threshold: number = PROMPT_AUTO_FILE_WORD_THRESHOLD,
): ProcessedPrompt {
  const wordCount = countWords(prompt);
  const files: FileAttachment[] = [...existingFiles];

  // Persist any existing base64 files
  for (const f of files) {
    if (!f.path) {
      persistFileToDisk(f);
    }
  }

  if (wordCount >= threshold) {
    const tempDir = getTempDirectory();
    const fileName = `prompt_document_${Date.now()}.txt`;
    const filePath = join(tempDir, fileName);

    writeFileSync(filePath, prompt, 'utf-8');

    const promptFile: FileAttachment = {
      name: fileName,
      type: 'text/plain',
      path: filePath,
      size: Buffer.byteLength(prompt, 'utf-8'),
    };

    files.unshift(promptFile);

    const summarySnippet = prompt.trim().slice(0, 150).replace(/\n+/g, ' ');
    const shortComment = `[Document Analysis Request] I have attached the complete document (${wordCount.toLocaleString()} words). Please analyze the attached document and answer thoroughly based on its contents. Context preview: "${summarySnippet}..."`;

    return {
      promptText: shortComment,
      files,
      wasAutoConvertedToFile: true,
      originalWordCount: wordCount,
    };
  }

  return {
    promptText: prompt,
    files,
    wasAutoConvertedToFile: false,
    originalWordCount: wordCount,
  };
}
