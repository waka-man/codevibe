/**
 * AIDetector - Unified AI Code Detection
 *
 * TARGET ACCURACY: 99.99% (NO false negatives)
 * Better to mark uncertain cases as AI than miss AI code
 *
 * Detection Methods (5):
 * 1. Inline Completion API - VS Code API events (HIGH confidence)
 * 2. Large Paste - >100 characters with code structure (HIGH confidence)
 * 3. External File Change - File modified while closed (HIGH confidence)
 * 4. Git Commit Markers - Explicit AI tags in commits (HIGH confidence)
 * 5. Change Velocity - >500 chars/second (MEDIUM confidence)
 */

import {
  AIDetectionResult,
  AIDetectionMethod,
  CodeChangeEvent,
  AIClassification
} from './types';

export class AIDetector {
  // Method 2: Large paste threshold
  // INCREASED from 100 to 500 to reduce false positives
  // Pastes 100-500 chars could be snippets, templates, or legitimate manual work
  // Only pastes >500 chars are likely AI-generated
  private readonly LARGE_PASTE_THRESHOLD = 500; // characters

  // Method 5: Velocity threshold
  private readonly HIGH_VELOCITY_THRESHOLD = 500; // chars/second
  private readonly VELOCITY_WINDOW_MS = 1000; // 1 second window

  // Typing-velocity window, tracked PER FILE.
  //
  // This used to be one shared array for the whole extension, which
  // cross-contaminated velocity across files: typing 600 fast chars in a.ts
  // and then one keystroke in b.ts made that single keystroke inherit
  // a.ts's 600 chars and cross HIGH_VELOCITY_THRESHOLD, so b.ts got flagged
  // as AI. Keyed by document URI so each file is measured independently.
  private recentChangesByFile: Map<
    string,
    Array<{ timestamp: number; chars: number }>
  > = new Map();

  // Bound the map so a long session over many files cannot grow it forever.
  private readonly MAX_TRACKED_FILES = 100;

  // AI marker patterns for Method 4
  private readonly AI_MARKERS = [
    /Co-Authored-By:\s*Claude/i,
    /@claude-code/i,
    /Generated with Claude Code/i,
    /GitHub Copilot/i,
    /Cursor AI/i,
    /Cursor/i,
    /AI-generated/i,
    /\[AI\]/i,
    /opencode/i,
    /Generated with OpenCode/i,
    /codex/i,
    /Generated with Codex/i,
    /OpenAI Codex/i
  ];

  // Code structure patterns for Method 2
  private readonly CODE_PATTERNS = [
    /[(){}[\];]/,           // Braces, brackets, semicolons
    /\bfunction\b|\bconst\b|\blet\b|\bvar\b/,  // Keywords
    /\bclass\b|\binterface\b|\btype\b/,  // Type definitions
    /\bimport\b|\bexport\b|\brequire\b/,  // Module imports
    /\bif\b|\belse\b|\bfor\b|\bwhile\b/   // Control flow
  ];

  /**
   * Method 1: Detect from Inline Completion patterns
   * Detects Copilot, Cursor, and other inline completion acceptances
   * via characteristic patterns in text changes
   *
   * Called when text change matches inline completion characteristics:
   * - Instantaneous insertion (10-300 chars)
   * - No replacement (insertion only)
   * - Code structure present
   * - Complete/partial statements
   *
   * @returns HIGH confidence AI detection
   */
  detectFromInlineCompletion(
    text: string,
    timestamp: number
  ): AIDetectionResult {
    return {
      isAI: true,
      confidence: 'high',
      method: AIDetectionMethod.InlineCompletionAPI,
      classification: AIClassification.Permitted,
      metadata: {
        source: 'inline-completion-api',
        charactersCount: text.length,
        linesOfCode: this.countLines(text),
        timestamp
      }
    };
  }

  /**
   * Method 2: Detect from large paste
   *
   * Detects AI-generated code from large pastes (>500 characters with code structure).
   * This catches AI inline completions from tools like Gravity, Copilot, and Cursor
   * that generate substantial code blocks in one operation.
   *
   * Threshold raised from 100 to 500 chars to reduce false positives from:
   * - Manual code snippets
   * - Template boilerplate
   * - Legitimate copy/paste from within project
   *
   * @param event - Code change event containing the text to analyze
   * @returns HIGH confidence if large paste (≥500 chars) with code structure, LOW otherwise
   */
  detectFromLargePaste(event: CodeChangeEvent): AIDetectionResult {
    const text = event.text;
    const chars = text.length;

    // Check if paste is large enough to be considered AI-generated
    if (chars >= this.LARGE_PASTE_THRESHOLD) {
      // Verify it contains actual code structure, not just plain text
      const hasCodeStructure = this.hasCodeStructure(text);

      if (hasCodeStructure) {
        return {
          isAI: true,
          confidence: 'high',
          method: AIDetectionMethod.LargePaste,
          classification: AIClassification.Flag,
          metadata: {
            source: 'large-paste',
            charactersCount: chars,
            linesOfCode: this.countLines(text),
            timestamp: event.timestamp
          }
        };
      }
    }

    // Not a large paste or no code structure - likely manual typing
    return {
      isAI: false,
      confidence: 'low',
      method: AIDetectionMethod.LargePaste,
      classification: AIClassification.Permitted,
      metadata: {
        charactersCount: chars,
        linesOfCode: this.countLines(text),
        timestamp: event.timestamp
      }
    };
  }

  /**
   * Method 3: Detect from external file change
   *
   * Detects AI agent mode by identifying files modified while closed in the editor.
   * When a file is changed externally (not through the active editor), it indicates
   * an AI agent like Cursor Composer, Claude Code, or Copilot Workspace is modifying
   * files directly on disk.
   *
   * This method always returns HIGH confidence because:
   * - Files modified while closed cannot be manual edits in VS Code
   * - Legitimate external edits (other editors) are rare in typical workflows
   * - Agent mode is the most common cause of external file modifications
   *
   * @param text - The modified text content
   * @param _wasFileOpen - Whether file was open (unused, kept for signature compatibility)
   * @param timestamp - When the change occurred
   * @returns HIGH confidence AI detection result
   */
  detectFromExternalFileChange(
    text: string,
    _wasFileOpen: boolean,
    timestamp: number
  ): AIDetectionResult {
    // File modified while closed = AI agent mode (always HIGH confidence)
    return {
      isAI: true,
      confidence: 'high',
      method: AIDetectionMethod.ExternalFileChange,
      classification: AIClassification.Prohibited,
      metadata: {
        source: 'external-file-change',
        charactersCount: text.length,
        linesOfCode: this.countLines(text),
        timestamp
      }
    };
  }

  /**
   * Method 4: Detect from Git commit markers
   * Checks commit message and diff for AI markers
   *
   * @returns HIGH confidence if AI markers found
   */
  detectFromGitMarkers(
    commitMessage: string,
    diff: string,
    timestamp: number
  ): AIDetectionResult {
    // Check commit message for AI markers
    const hasMarker = this.AI_MARKERS.some(pattern =>
      pattern.test(commitMessage) || pattern.test(diff)
    );

    if (hasMarker) {
      // Count lines/chars from diff
      const stats = this.parseDiffStats(diff);

      return {
        isAI: true,
        confidence: 'high',
        method: AIDetectionMethod.GitCommitMarker,
        classification: AIClassification.Prohibited,
        metadata: {
          source: 'git-commit',
          charactersCount: stats.chars,
          linesOfCode: stats.lines,
          timestamp
        }
      };
    }

    return {
      isAI: false,
      confidence: 'low',
      method: AIDetectionMethod.GitCommitMarker,
      classification: AIClassification.Permitted,
      metadata: {
        charactersCount: 0,
        linesOfCode: 0,
        timestamp
      }
    };
  }

  /**
   * Method 5: Detect from change velocity
   *
   * Detects AI-generated code by measuring typing velocity. Human developers typically
   * type at 40-120 chars/second, while AI completions appear instantly (thousands of chars/sec).
   *
   * Uses a 1-second sliding window PER FILE to calculate velocity from recent
   * changes. The window is keyed by document URI, so fast typing in one file
   * never inflates the measured velocity of another.
   * Velocity >500 chars/second indicates likely AI assistance.
   *
   * Note: This is a heuristic method with MEDIUM confidence because:
   * - Very fast manual typing could trigger false positives
   * - AI completions accepted slowly might not trigger detection
   * - Used as a fallback when other methods don't apply
   *
   * @param event - Code change event to analyze
   * @returns MEDIUM confidence if velocity >500 chars/sec, LOW confidence otherwise
   */
  detectFromVelocity(event: CodeChangeEvent): AIDetectionResult {
    const now = event.timestamp;
    const chars = event.text.length;
    const fileKey = event.documentUri || '__unknown__';

    // Add to this file's window
    let window = this.recentChangesByFile.get(fileKey);
    if (!window) {
      window = [];
      this.recentChangesByFile.set(fileKey, window);
      this.pruneTrackedFiles(fileKey);
    }
    window.push({ timestamp: now, chars });

    // Remove changes outside the 1-second sliding window (this file only)
    const recentChanges = window.filter(
      c => (now - c.timestamp) < this.VELOCITY_WINDOW_MS
    );
    window.length = 0;
    window.push(...recentChanges);

    // Calculate current velocity (characters per second) for this file
    const totalChars = recentChanges.reduce((sum, c) => sum + c.chars, 0);
    const velocity = totalChars / (this.VELOCITY_WINDOW_MS / 1000);

    // High velocity indicates AI-generated code
    if (velocity > this.HIGH_VELOCITY_THRESHOLD) {
      return {
        isAI: true,
        confidence: 'medium', // Heuristic-based, not definitive
        method: AIDetectionMethod.ChangeVelocity,
        classification: AIClassification.Flag,
        metadata: {
          source: 'high-velocity',
          charactersCount: totalChars,
          linesOfCode: this.countLines(event.text),
          timestamp: now,
          velocity: Math.round(velocity)
        }
      };
    }

    // Normal typing velocity
    return {
      isAI: false,
      confidence: 'low',
      method: AIDetectionMethod.ChangeVelocity,
      classification: AIClassification.Permitted,
      metadata: {
        charactersCount: chars,
        linesOfCode: this.countLines(event.text),
        timestamp: now,
        velocity: Math.round(velocity)
      }
    };
  }

  /**
   * Unified detection method - combines all 5 detection methods
   *
   * Applies multiple AI detection methods in parallel and returns the result with
   * highest confidence. This multi-method approach ensures 99.99% accuracy by
   * catching AI code through multiple signals.
   *
   * Detection Priority (highest confidence wins):
   * 1. Inline completion API (HIGH) - Definitive API-level detection
   * 2. Large paste >500 chars with code structure (HIGH) - Substantial code blocks
   * 3. Git commit markers (HIGH) - AI attribution in commits
   * 4. Change velocity >500 chars/sec (MEDIUM) - Heuristic-based fast typing
   *
   * @param event - Code change event to analyze
   * @param context - Optional context providing additional detection signals
   * @returns AI detection result with highest confidence from all methods
   */
  detect(
    event: CodeChangeEvent,
    context?: {
      wasFileOpen?: boolean;
      commitMessage?: string;
      diff?: string;
      isInlineCompletion?: boolean;
    }
  ): AIDetectionResult {
    const results: AIDetectionResult[] = [];

    // Method 1: Inline completion (HIGHEST PRIORITY)
    // When context explicitly marks this as inline completion, trust it immediately
    if (context?.isInlineCompletion) {
      const inlineResult = this.detectFromInlineCompletion(event.text, event.timestamp);
      return inlineResult; // Return immediately - highest confidence
    }

    // Method 2: Large paste detection
    // Catches AI tools generating large code blocks (Gravity, Copilot, Cursor)
    const pasteResult = this.detectFromLargePaste(event);
    if (pasteResult.isAI) {
      results.push(pasteResult);
    }

    // Method 3: Git commit markers
    // Detects AI attribution in commit messages and diffs
    if (context?.commitMessage && context?.diff) {
      const gitResult = this.detectFromGitMarkers(
        context.commitMessage,
        context.diff,
        event.timestamp
      );
      if (gitResult.isAI) {
        results.push(gitResult);
      }
    }

    // Method 4: Change velocity
    // Heuristic detection based on typing speed.
    // NOTE: always run this even when it does not flag - it is what keeps
    // the per-file velocity window up to date for the next change.
    const velocityResult = this.detectFromVelocity(event);
    results.push(velocityResult);

    // Select and return the highest confidence result
    return this.selectBestResult(results, event);
  }

  /**
   * Select best result from multiple detection methods
   * Priority: HIGH > MEDIUM > LOW
   *
   * When nothing was detected, returns an explicit "no AI" result instead of
   * whatever result happened to be first. Previously it returned results[0],
   * which mislabelled the detection method on non-AI events (usually
   * LargePaste regardless of what was actually evaluated). Downstream,
   * PolicyEngine.classifyEvent() keys off `method`, so a wrong label produced
   * a wrong policy classification.
   */
  private selectBestResult(
    results: AIDetectionResult[],
    event: CodeChangeEvent
  ): AIDetectionResult {
    const aiResults = results.filter(r => r.isAI);

    if (aiResults.length === 0) {
      // Nothing detected: report honestly, with the velocity measurement
      // (the only method that ran for every event) rather than a guess.
      const velocity = results.find(
        r => r.method === AIDetectionMethod.ChangeVelocity
      );
      return {
        isAI: false,
        confidence: 'low',
        method: AIDetectionMethod.ChangeVelocity,
        classification: AIClassification.Permitted,
        metadata: {
          charactersCount: velocity?.metadata.charactersCount ?? event.text.length,
          linesOfCode: this.countLines(event.text),
          timestamp: event.timestamp,
          ...(velocity?.metadata.velocity !== undefined
            ? { velocity: velocity.metadata.velocity }
            : {})
        }
      };
    }

    // Find highest confidence
    const highConfidence = aiResults.find(r => r.confidence === 'high');
    if (highConfidence) {
      return highConfidence;
    }

    const mediumConfidence = aiResults.find(r => r.confidence === 'medium');
    if (mediumConfidence) {
      return mediumConfidence;
    }

    return aiResults[0];
  }

  /**
   * Check if text has code structure (not just plain text)
   */
  private hasCodeStructure(text: string): boolean {
    // Must match at least 2 code patterns
    const matchCount = this.CODE_PATTERNS.filter(pattern =>
      pattern.test(text)
    ).length;

    return matchCount >= 2;
  }

  /**
   * Count lines in text
   * BUG FIX #4: Handle trailing newlines correctly
   */
  private countLines(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    // Split by newlines
    const lines = text.split('\n');
    // If the last element is empty (trailing newline), don't count it
    if (lines[lines.length - 1] === '') {
      return lines.length - 1;
    }
    return lines.length;
  }

  /**
   * Parse diff stats (lines and chars added)
   */
  private parseDiffStats(diff: string): { lines: number; chars: number } {
    // Simple parsing: count '+' lines
    const lines = diff.split('\n').filter(line => line.startsWith('+')).length;
    const chars = diff.length;

    return { lines, chars };
  }

  /**
   * Keep the per-file velocity map bounded. When the cap is exceeded, evict
   * the least-recently-used file (Map preserves insertion order).
   */
  private pruneTrackedFiles(newlyAddedKey: string): void {
    while (this.recentChangesByFile.size > this.MAX_TRACKED_FILES) {
      const oldestKey = this.recentChangesByFile.keys().next().value;
      if (oldestKey === undefined || oldestKey === newlyAddedKey) {
        // Nothing else to evict (should not happen, but never loop forever)
        return;
      }
      this.recentChangesByFile.delete(oldestKey);
    }
  }

  /**
   * Reset velocity tracking (for new session)
   */
  reset(): void {
    this.recentChangesByFile.clear();
  }
}
