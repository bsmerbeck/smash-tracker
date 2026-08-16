import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiquipediaCharacterEvidence } from './LiquipediaCharacterEvidence';
import { SpriteList } from '@/data/sprites';

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;

describe('LiquipediaCharacterEvidence', () => {
  it('renders nothing when no characters evidence is supplied', () => {
    const { container } = render(<LiquipediaCharacterEvidence characters={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders subject-first "X vs Y" with sprites and localized names when both ids resolve', () => {
    render(
      <LiquipediaCharacterEvidence
        characters={{
          subjectRaw: 'Mario',
          opponentRaw: 'Luigi',
          subjectFighterId: mario.id,
          opponentFighterId: luigi.id,
        }}
      />,
    );
    const evidence = screen.getByTestId('liquipedia-character-evidence');
    const images = evidence.querySelectorAll('img');
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute('src', mario.url);
    expect(images[1]).toHaveAttribute('src', luigi.url);
    expect(evidence.textContent).toContain('Mario');
    expect(evidence.textContent).toContain('vs');
    expect(evidence.textContent).toContain('Luigi');
  });

  it('falls back to the raw source text, with no sprite, when a side is unmapped', () => {
    render(
      <LiquipediaCharacterEvidence
        characters={{
          subjectRaw: 'Some Unrecognized Tag',
          opponentRaw: 'Luigi',
          opponentFighterId: luigi.id,
        }}
      />,
    );
    const evidence = screen.getByTestId('liquipedia-character-evidence');
    expect(screen.getByTestId('liquipedia-character-raw')).toHaveTextContent(
      'Some Unrecognized Tag',
    );
    expect(evidence.querySelectorAll('img')).toHaveLength(1);
  });

  it('renders the characters attribution badge, clearly marked as from Liquipedia', () => {
    render(
      <LiquipediaCharacterEvidence characters={{ subjectRaw: 'Mario', opponentRaw: 'Luigi' }} />,
    );
    expect(screen.getByText('Character data from Liquipedia')).toBeInTheDocument();
  });

  it('never renders raw source text as markup', () => {
    render(
      <LiquipediaCharacterEvidence
        characters={{ subjectRaw: '<img src=x onerror=alert(1)>', opponentRaw: 'Luigi' }}
      />,
    );
    expect(document.querySelectorAll('img')).toHaveLength(0);
    const [subject] = screen.getAllByTestId('liquipedia-character-raw');
    expect(subject!.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
