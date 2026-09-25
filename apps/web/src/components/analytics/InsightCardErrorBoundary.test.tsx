import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InsightCardErrorBoundary } from './InsightCardErrorBoundary';

function Bomb({ message }: { message: string }): never {
  throw new Error(message);
}

describe('InsightCardErrorBoundary', () => {
  it('a throwing child renders nothing for its slot and onError fires exactly once with the template id', () => {
    const onError = vi.fn();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <InsightCardErrorBoundary templateId="formNow:account:last30" onError={onError}>
        <Bomb message="boom" />
      </InsightCardErrorBoundary>,
    );
    expect(container.firstChild).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('formNow:account:last30');
    consoleSpy.mockRestore();
  });

  it('renders children normally when nothing throws', () => {
    render(
      <InsightCardErrorBoundary templateId="formNow" onError={vi.fn()}>
        <p>fine</p>
      </InsightCardErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeInTheDocument();
  });

  it("the boundary's own log line names only the template id — never the thrown error's own text", () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <InsightCardErrorBoundary templateId="formNow:account:last30" onError={vi.fn()}>
        <Bomb message="vs opponentTagXYZ, contact them at leaker@example.com" />
      </InsightCardErrorBoundary>,
    );

    // React's own dev-mode logging for a caught error is unavoidable noise
    // from the framework itself, not from this component — this assertion
    // targets the boundary's OWN log line, identified by the template id it
    // (uniquely, deterministically) carries.
    const ownLogCall = consoleSpy.mock.calls.find((args) =>
      args.some((arg) => typeof arg === 'string' && arg.includes('formNow:account:last30')),
    );
    expect(ownLogCall).toBeDefined();
    const joined = ownLogCall!.join(' ');
    expect(joined).not.toContain('opponentTagXYZ');
    expect(joined).not.toContain('leaker@example.com');
    consoleSpy.mockRestore();
  });
});
