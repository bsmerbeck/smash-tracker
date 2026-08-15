import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TournamentEntry } from '@smash-tracker/shared';
import { ImportedSnapshotNotice } from './ImportedSnapshotNotice';

function makeEntry(overrides: Record<string, unknown> = {}): TournamentEntry {
  return {
    eventId: 42,
    eventName: 'Ultimate Singles',
    firstSetAt: Date.UTC(2024, 5, 10),
    lastSetAt: Date.UTC(2024, 5, 10),
    setsPlayed: 5,
    entryKey: '42',
    ...overrides,
  } as TournamentEntry;
}

describe('ImportedSnapshotNotice', () => {
  it('renders nothing for a manual/linked entry', () => {
    const { container } = render(<ImportedSnapshotNotice entry={makeEntry()} />);
    expect(container.firstChild).toBeNull();
  });

  it('states the imported-snapshot nature and the public-data source', () => {
    render(
      <ImportedSnapshotNotice
        entry={makeEntry({ origin: 'admin-imported', provider: 'startgg' })}
      />,
    );
    expect(screen.getByTestId('imported-snapshot-notice')).toBeInTheDocument();
    expect(screen.getByText('Imported event snapshot')).toBeInTheDocument();
    expect(
      screen.getByText(/imported from public start\.gg data\. It's a snapshot, not a live-synced/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Source: start\.gg \(public data\)/)).toBeInTheDocument();
  });

  it('shows imported-at and as-of freshness when the provenance recorded them', () => {
    render(
      <ImportedSnapshotNotice
        entry={makeEntry({
          origin: 'admin-imported',
          provider: 'startgg',
          provenance: {
            source: 'research-import',
            importedAtMs: Date.UTC(2026, 7, 1, 12),
            asOfMs: Date.UTC(2026, 6, 15, 12),
          },
        })}
      />,
    );
    expect(screen.getByText(/Imported Aug 1, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Data as of Jul 15, 2026/)).toBeInTheDocument();
  });

  it('omits freshness lines entirely when the import recorded no provenance', () => {
    render(<ImportedSnapshotNotice entry={makeEntry({ origin: 'admin-imported' })} />);
    expect(screen.queryByText(/Imported [A-Z]/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Data as of/)).not.toBeInTheDocument();
  });
});
