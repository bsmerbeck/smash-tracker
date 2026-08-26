import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { serializeCitationToken } from '@smash-tracker/shared';
import { CitationTextarea } from './CitationTextarea';

function renderTextarea(value: string, onChange = vi.fn()) {
  const utils = render(
    <CitationTextarea
      value={value}
      onChange={onChange}
      ariaLabel="Section body"
      testId="section-summary"
    />,
  );
  return { ...utils, onChange };
}

function getMirror(container: HTMLElement) {
  return container.querySelector('[data-testid="section-summary-mirror"]');
}

describe('CitationTextarea', () => {
  it('mirrors textContent as value + trailing newline for a body with a token', () => {
    const raw = serializeCitationToken({ sourceVodRef: 'm1', seconds: 32, label: 'clip' });
    const value = `before ${raw} after`;
    const { container } = renderTextarea(value);

    expect(getMirror(container)?.textContent).toBe(`${value}\n`);
  });

  it('mirrors textContent as value + trailing newline for a body with no tokens', () => {
    const value = 'just plain prose, no tokens here';
    const { container } = renderTextarea(value);

    expect(getMirror(container)?.textContent).toBe(`${value}\n`);
  });

  it('mirrors textContent as value + trailing newline for a body already ending in a newline', () => {
    const value = 'ends with a newline\n';
    const { container } = renderTextarea(value);

    expect(getMirror(container)?.textContent).toBe(`${value}\n`);
  });

  it('the mirror is aria-hidden so a screen reader hears the textarea value once', () => {
    const { container } = renderTextarea('hello');

    expect(getMirror(container)).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders one marked token element per located span — valid and invalid distinguished', () => {
    const validRaw = serializeCitationToken({ sourceVodRef: 'm1', seconds: 32, label: 'clip' });
    const overLongLabel = encodeURIComponent('x'.repeat(210));
    const invalidRaw = `{{cite:matchId=m1;seconds=10;label=${overLongLabel}}}`;
    const value = `${validRaw} middle ${invalidRaw} end`;
    const { container } = renderTextarea(value);

    const tokenEls = container.querySelectorAll('[data-citation-valid]');
    expect(tokenEls).toHaveLength(2);
    expect(tokenEls[0]).toHaveAttribute('data-citation-valid', 'true');
    expect(tokenEls[1]).toHaveAttribute('data-citation-valid', 'false');
  });

  it('produces no marked token elements for a body with no tokens', () => {
    const { container } = renderTextarea('no tokens in this one');

    expect(container.querySelectorAll('[data-citation-valid]')).toHaveLength(0);
  });

  it("a marked token element's own textContent equals the raw token string exactly", () => {
    const raw = serializeCitationToken({ sourceVodRef: 'm1', seconds: 32, label: 'clip label' });
    const { container } = renderTextarea(`before ${raw} after`);

    const tokenEl = container.querySelector('[data-citation-valid="true"]');
    expect(tokenEl?.textContent).toBe(raw);
  });

  it('typing fires onChange with the full native value; keeps accessible name and value prop', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderTextarea('hi', onChange);

    const textarea = screen.getByLabelText('Section body');
    expect(textarea).toHaveValue('hi');

    await user.type(textarea, '!');

    expect(onChange).toHaveBeenCalledWith('hi!');
  });
});
