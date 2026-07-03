import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

describe('App', () => {
  it('renders the placeholder heading and button', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: /smash tracker/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /smash tracker — modernization in progress/i }),
    ).toBeInTheDocument();
  });
});
