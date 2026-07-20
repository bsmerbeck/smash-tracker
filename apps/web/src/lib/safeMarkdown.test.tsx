import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SAFE_MARKDOWN_DOC_MAX_LENGTH } from '@smash-tracker/shared';
import { SafeMarkdown } from './safeMarkdown';

describe('SafeMarkdown', () => {
  it('renders a citation token as a real, focusable button chip and activates it with matchId/seconds', async () => {
    const user = userEvent.setup();
    const onActivateCitation = vi.fn();
    render(
      <SafeMarkdown
        body="Missed it {{cite:matchId=m1;seconds=222;label=missed%20ledgetrap}} again"
        onActivateCitation={onActivateCitation}
      />,
    );

    const chip = screen.getByRole('button', { name: /missed ledgetrap/i });
    expect(chip.tagName).toBe('BUTTON');
    expect(chip).toHaveAttribute('type', 'button');

    await user.click(chip);
    expect(onActivateCitation).toHaveBeenCalledWith('m1', 222);
  });

  it('appends the resolved source label to a cross-VOD citation chip', () => {
    render(
      <SafeMarkdown
        body="{{cite:matchId=other;seconds=10;label=clip}}"
        resolveCitationSource={(matchId) =>
          matchId === 'other' ? { label: 'vs Zain' } : undefined
        }
      />,
    );

    expect(screen.getByRole('button', { name: /vs Zain/i })).toBeInTheDocument();
  });

  it('renders a malformed citation token as inert literal text, never a chip or a crash', () => {
    render(<SafeMarkdown body="broken {{cite:matchId=;seconds=abc;label=x}} token" />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/broken/)).toBeInTheDocument();
  });

  it('renders raw HTML/script text as inert text, never live markup', () => {
    const { container } = render(<SafeMarkdown body={'before <script>alert(1)</script> after'} />);

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('truncates input beyond SAFE_MARKDOWN_DOC_MAX_LENGTH rather than rendering it in full', () => {
    const oversized = 'a'.repeat(SAFE_MARKDOWN_DOC_MAX_LENGTH + 500);
    const { container } = render(<SafeMarkdown body={oversized} />);

    expect(container.textContent?.length).toBe(SAFE_MARKDOWN_DOC_MAX_LENGTH);
  });

  it('never crashes on a pathological run of emphasis markers and stays bounded', () => {
    const pathological = '*'.repeat(5000);
    expect(() => render(<SafeMarkdown body={pathological} />)).not.toThrow();
  });

  it('caps the number of rendered blocks rather than parsing unbounded paragraph counts', () => {
    const manyBlocks = Array.from({ length: 500 }, (_, i) => `paragraph ${i}`).join('\n\n');
    const { container } = render(<SafeMarkdown body={manyBlocks} />);

    expect(container.querySelectorAll('p').length).toBeLessThanOrEqual(100);
  });

  it('renders headings, unordered lists, and emphasis through the fixed grammar', () => {
    render(<SafeMarkdown body={'# Title\n\n- one\n- two\n\nSome **bold** and *italic* text.'} />);

    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getByText('two')).toBeInTheDocument();
    expect(screen.getByText('bold')).toHaveProperty('tagName', 'STRONG');
    expect(screen.getByText('italic')).toHaveProperty('tagName', 'EM');
  });

  it('renders nothing for an empty body', () => {
    const { container } = render(<SafeMarkdown body="" />);
    expect(container).toBeEmptyDOMElement();
  });
});
