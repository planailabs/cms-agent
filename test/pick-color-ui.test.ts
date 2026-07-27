/** pick_color question UI — native color input seeded from `current`. */
import { describe, expect, it } from 'vitest';
import { renderQuestionUI } from '@/components/chat/ui/chat/prompts';

const mc = (input: Record<string, unknown>) =>
  ({
    phase: 'question',
    clientPrompt: { toolName: 'pick_color', input },
  }) as never;

const modeLocale = { cancelLabel: 'Skip' } as never;

describe('renderQuestionUI pick_color', () => {
  it('renders the question, a color input seeded with current, and confirm', () => {
    const { questionLabel, questionButtons } = renderQuestionUI(
      mc({ question: 'Accent color?', current: '#12a594' }),
      modeLocale,
    );
    expect(questionLabel).toContain('Accent color?');
    expect(questionButtons).toContain('type="color"');
    expect(questionButtons).toContain('value="#12a594"');
    expect(questionButtons).toContain('mc-color-confirm');
    expect(questionButtons).toContain('mc-question-cancel');
  });

  it('falls back to a sane default when current is missing or malformed', () => {
    const { questionButtons } = renderQuestionUI(mc({ question: 'x', current: 'red' }), modeLocale);
    expect(questionButtons).toContain('value="#7852ee"');
  });
});
