import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StageOption, stageAbbreviation } from './StageOption';

describe('stageAbbreviation', () => {
  it('initials multi-word names', () => {
    expect(stageAbbreviation('Battlefield')).toBe('BAT');
    expect(stageAbbreviation('Final Destination')).toBe('FD');
    expect(stageAbbreviation('New Donk City Hall')).toBe('NDC');
  });

  it("strips punctuation before abbreviating (e.g. Yoshi's Story)", () => {
    expect(stageAbbreviation("Yoshi's Story")).toBe('YS');
  });
});

describe('StageOption', () => {
  it('renders an image thumbnail when the stage has art', () => {
    const { container } = render(
      <StageOption stage={{ id: 1, name: 'Battlefield', url: '/assets/stages/1.jpg' }} />,
    );
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', '/assets/stages/1.jpg');
    expect(screen.getByText('Battlefield')).toBeInTheDocument();
  });

  it('renders a fallback tile with an abbreviation when the stage has no art', () => {
    const { container } = render(
      <StageOption stage={{ id: 2, name: 'Big Battlefield', url: '' }} />,
    );
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByText('BB')).toBeInTheDocument();
    expect(screen.getByText('Big Battlefield')).toBeInTheDocument();
  });
});
