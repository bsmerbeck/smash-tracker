import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSeo } from './useSeo';

/** Rebuilds the static index.html `<head>` tags this hook is meant to mutate in place. */
function seedStaticHead() {
  document.head.innerHTML = `
    <link rel="canonical" href="https://grandfinals.gg/" />
    <title>Static Title</title>
    <meta name="description" content="Static description" />
    <meta property="og:title" content="Static Title" />
    <meta property="og:description" content="Static description" />
    <meta property="og:url" content="https://grandfinals.gg/" />
    <meta name="twitter:title" content="Static Title" />
    <meta name="twitter:description" content="Static description" />
  `;
}

describe('useSeo', () => {
  beforeEach(() => {
    seedStaticHead();
  });

  afterEach(() => {
    document.head.innerHTML = '';
  });

  it('updates existing tags in place without duplicating them', () => {
    renderHook(() =>
      useSeo({
        title: 'FAQ | Smash Tracker',
        description: 'Answers to common questions.',
        canonicalPath: '/faq',
      }),
    );

    expect(document.title).toBe('FAQ | Smash Tracker');
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://grandfinals.gg/faq',
    );
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute(
      'content',
      'Answers to common questions.',
    );
    expect(document.head.querySelector('meta[property="og:title"]')).toHaveAttribute(
      'content',
      'FAQ | Smash Tracker',
    );
    expect(document.head.querySelector('meta[property="og:description"]')).toHaveAttribute(
      'content',
      'Answers to common questions.',
    );
    expect(document.head.querySelector('meta[property="og:url"]')).toHaveAttribute(
      'content',
      'https://grandfinals.gg/faq',
    );
    expect(document.head.querySelector('meta[name="twitter:title"]')).toHaveAttribute(
      'content',
      'FAQ | Smash Tracker',
    );
    expect(document.head.querySelector('meta[name="twitter:description"]')).toHaveAttribute(
      'content',
      'Answers to common questions.',
    );
  });

  it('creates missing tags rather than silently skipping them', () => {
    document.head.innerHTML = '<title>Empty head</title>';

    renderHook(() => useSeo({ title: 'New Page', description: 'New description' }));

    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute(
      'content',
      'New description',
    );
    expect(document.head.querySelectorAll('meta[property="og:title"]')).toHaveLength(1);
  });

  it('toggles robots noindex on and off', () => {
    const { rerender } = renderHook(
      ({ noindex }: { noindex: boolean }) => useSeo({ title: 'Not Found', noindex }),
      {
        initialProps: { noindex: true },
      },
    );

    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex',
    );

    rerender({ noindex: false });
    expect(document.head.querySelector('meta[name="robots"]')).not.toBeInTheDocument();
  });

  it('does not create a robots tag when noindex is never set', () => {
    renderHook(() => useSeo({ title: 'Home' }));
    expect(document.head.querySelector('meta[name="robots"]')).not.toBeInTheDocument();
  });

  it('leaves description/canonical untouched when omitted', () => {
    renderHook(() => useSeo({ title: 'Only Title Update' }));

    expect(document.title).toBe('Only Title Update');
    expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute(
      'content',
      'Static description',
    );
    expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://grandfinals.gg/',
    );
  });
});
