import { CodeSource } from "../types";

export interface EditorChangeInput {
  text: string;
  rangeLength: number;
  languageId: string;
  isActiveEditor: boolean;
}

export interface EditorChangeClassification {
  source: CodeSource;
  detectionMethod: "editor-assisted-change" | "manual-deletion";
  reason: string;
}

export class ChangeAttributionClassifier {
  private readonly LARGE_PASTE_THRESHOLD = 500;

  classifyEditorChange(
    change: EditorChangeInput,
  ): EditorChangeClassification | null {
    if (!change.isActiveEditor) {
      return null;
    }

    if (change.text.length === 0 && change.rangeLength > 0) {
      return {
        source: CodeSource.Neutral,
        detectionMethod: "manual-deletion",
        reason: "Deletion made in the active editor",
      };
    }

    if (this.looksEditorAssisted(change.text, change.languageId)) {
      return {
        source: CodeSource.Neutral,
        detectionMethod: "editor-assisted-change",
        reason: "Markup inserted by an editor-assisted feature",
      };
    }

    return null;
  }

  private looksEditorAssisted(text: string, languageId: string): boolean {
    // Large markup blocks must reach the AI detector first. This keeps Emmet
    // and auto-closing tags neutral without allowing a large HTML paste to
    // bypass authorship detection.
    if (text.length >= this.LARGE_PASTE_THRESHOLD) {
      return false;
    }

    if (!/^(html|handlebars|razor|vue|svelte|xml)$/.test(languageId)) {
      return false;
    }

    return /<\/[-\w]+\s*>/.test(text) ||
      (/<[-\w]+[^>]*>/.test(text) && /<\/[-\w]+\s*>/.test(text));
  }
}