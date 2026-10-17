import { CodeSource } from '../../types';
import { ChangeAttributionClassifier } from '../ChangeAttributionClassifier';

describe('ChangeAttributionClassifier', () => {
  const classifier = new ChangeAttributionClassifier();

  it('classifies active-editor deletions as neutral', () => {
    expect(classifier.classifyEditorChange({
      text: '',
      rangeLength: 5000,
      languageId: 'html',
      isActiveEditor: true,
    })).toMatchObject({
      source: CodeSource.Neutral,
      detectionMethod: 'manual-deletion',
    });
  });

  it('classifies closing tags as neutral editor assistance', () => {
    expect(classifier.classifyEditorChange({
      text: '</div>',
      rangeLength: 0,
      languageId: 'html',
      isActiveEditor: true,
    })).toMatchObject({
      source: CodeSource.Neutral,
      detectionMethod: 'editor-assisted-change',
    });
  });

  it('does not classify inactive-file edits as editor assistance', () => {
    expect(classifier.classifyEditorChange({
      text: '<div></div>',
      rangeLength: 0,
      languageId: 'html',
      isActiveEditor: false,
    })).toBeNull();
  });

  it('does not classify a large HTML paste as editor assistance', () => {
    const pastedHtml = Array.from({ length: 672 }, (_, index) =>
      `<div class="row-${index}">content</div>`,
    ).join('\n');

    expect(classifier.classifyEditorChange({
      text: pastedHtml,
      rangeLength: 0,
      languageId: 'html',
      isActiveEditor: true,
    })).toBeNull();
  });
});