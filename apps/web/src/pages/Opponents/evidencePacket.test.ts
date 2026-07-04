import { describe, expect, it } from 'vitest';
import type { OpponentProfile } from '@/lib/stats';
import type { TournamentBlock, TournamentSet } from './tournamentHistory';
import { buildEvidencePacket, packetToText } from './evidencePacket';

function makeSet(overrides: Partial<TournamentSet> = {}): TournamentSet {
  return {
    setId: 's1',
    games: [],
    wins: 2,
    losses: 0,
    roundLabel: 'Winners Semi-Final',
    time: 1000,
    isLosersSide: false,
    ...overrides,
  };
}

function makeBlock(overrides: Partial<TournamentBlock> = {}): TournamentBlock {
  return {
    displayName: 'The Big House 9',
    eventName: 'Ultimate Singles',
    tournamentName: 'The Big House 9',
    sets: [makeSet()],
    startTime: 1000,
    endTime: 2000,
    wins: 2,
    losses: 0,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<OpponentProfile> = {}): OpponentProfile {
  return {
    opponent: 'rival',
    record: { wins: 2, losses: 1, total: 3, winRate: 67 },
    firstPlayedAt: Date.parse('2024-01-01T00:00:00Z'),
    lastPlayedAt: Date.parse('2024-06-01T00:00:00Z'),
    byTheirFighter: [
      { opponentFighterId: 10, wins: 1, losses: 0, totalMatches: 1, ratio: 100, wilson: 0.2 },
      { opponentFighterId: 15, wins: 1, losses: 1, totalMatches: 2, ratio: 50, wilson: 0.1 },
    ],
    byStage: [
      { stageId: 1, wins: 1, losses: 0, total: 1, winRate: 100 },
      { stageId: 3, wins: 1, losses: 1, total: 2, winRate: 50 },
    ],
    recent: [],
    ...overrides,
  };
}

describe('buildEvidencePacket', () => {
  it('carries over the opponent name, prepared-by, generated-at, and overall record', () => {
    const packet = buildEvidencePacket(makeProfile(), [], 'me@example.com', 555);

    expect(packet.opponent).toBe('rival');
    expect(packet.preparedBy).toBe('me@example.com');
    expect(packet.generatedAt).toBe(555);
    expect(packet.record).toEqual({ wins: 2, losses: 1, total: 3, winRate: 67 });
  });

  it('carries over the first/last played date range', () => {
    const profile = makeProfile();
    const packet = buildEvidencePacket(profile, [], 'me', 555);

    expect(packet.dateRange).toEqual({
      firstPlayedAt: profile.firstPlayedAt,
      lastPlayedAt: profile.lastPlayedAt,
    });
  });

  it('resolves their-character rows to display names, preserving profile ordering', () => {
    const packet = buildEvidencePacket(makeProfile(), [], 'me', 555);

    expect(packet.byTheirCharacter).toEqual([
      { name: 'Luigi', wins: 1, losses: 0, winRate: 100, total: 1 },
      { name: 'Daisy', wins: 1, losses: 1, winRate: 50, total: 2 },
    ]);
  });

  it('falls back to "Unknown" for an unrecognized fighter id', () => {
    const packet = buildEvidencePacket(
      makeProfile({
        byTheirFighter: [
          {
            opponentFighterId: 99999,
            wins: 1,
            losses: 0,
            totalMatches: 1,
            ratio: 100,
            wilson: 0.2,
          },
        ],
      }),
      [],
      'me',
      555,
    );

    expect(packet.byTheirCharacter[0]!.name).toBe('Unknown');
  });

  it('resolves stage rows to names, using "unknown" for the id-0 sentinel', () => {
    const packet = buildEvidencePacket(
      makeProfile({
        byStage: [
          { stageId: 1, wins: 1, losses: 0, total: 1, winRate: 100 },
          { stageId: 0, wins: 0, losses: 1, total: 1, winRate: 0 },
        ],
      }),
      [],
      'me',
      555,
    );

    expect(packet.byStage.map((s) => s.name)).toEqual(['Battlefield', 'unknown']);
  });

  it('flattens tournament blocks into one encounter line per set, carrying the losers-side tag', () => {
    const blocks = [
      makeBlock({
        displayName: 'The Big House 9',
        sets: [
          makeSet({ setId: 's1', roundLabel: 'Winners Semi-Final', wins: 2, losses: 0, time: 100 }),
          makeSet({
            setId: 's2',
            roundLabel: 'Losers Final',
            wins: 1,
            losses: 2,
            isLosersSide: true,
            time: 200,
          }),
        ],
      }),
    ];
    const packet = buildEvidencePacket(makeProfile(), blocks, 'me', 555);

    expect(packet.tournamentEncounters).toHaveLength(2);
    expect(packet.tournamentEncounters[0]).toMatchObject({
      displayName: 'The Big House 9',
      roundLabel: 'Winners Semi-Final',
      result: '2-0',
    });
    expect(packet.tournamentEncounters[1]).toMatchObject({
      displayName: 'The Big House 9',
      roundLabel: 'Losers Final',
      result: '1-2 (Losers)',
    });
  });

  it('returns an empty tournamentEncounters array when there are no blocks', () => {
    const packet = buildEvidencePacket(makeProfile(), [], 'me', 555);
    expect(packet.tournamentEncounters).toEqual([]);
  });
});

describe('packetToText', () => {
  it('includes both names, the header, and the generated/date-range lines', () => {
    const packet = buildEvidencePacket(
      makeProfile(),
      [],
      'me@example.com',
      Date.parse('2024-07-01'),
    );
    const text = packetToText(packet);

    expect(text).toContain('H2H Evidence Packet: me@example.com vs rival');
    expect(text).toContain('Generated:');
    expect(text).toContain('Date range:');
  });

  it('includes the overall record line', () => {
    const packet = buildEvidencePacket(makeProfile(), [], 'me', 555);
    const text = packetToText(packet);

    expect(text).toContain('2-1 (67% over 3 games)');
  });

  it('renders a their-characters table with header + rows', () => {
    const packet = buildEvidencePacket(makeProfile(), [], 'me', 555);
    const text = packetToText(packet);

    expect(text).toContain('## Their characters');
    expect(text).toContain('| Character | Record | Win Rate | Games |');
    expect(text).toContain('| Luigi | 1-0 | 100% | 1 |');
    expect(text).toContain('| Daisy | 1-1 | 50% | 2 |');
  });

  it('renders a stages table with header + rows', () => {
    const packet = buildEvidencePacket(makeProfile(), [], 'me', 555);
    const text = packetToText(packet);

    expect(text).toContain('## Stages');
    expect(text).toContain('| Stage | Record | Win Rate |');
    expect(text).toContain('| Battlefield | 1-0 | 100% |');
  });

  it('renders "No ... recorded" fallbacks when a section is empty', () => {
    const packet = buildEvidencePacket(
      makeProfile({ byTheirFighter: [], byStage: [] }),
      [],
      'me',
      555,
    );
    const text = packetToText(packet);

    expect(text).toContain('No character data recorded.');
    expect(text).toContain('No stage data recorded.');
    expect(text).toContain('No tournament sets recorded.');
  });

  it('renders tournament encounters as a bulleted list', () => {
    const blocks = [makeBlock()];
    const packet = buildEvidencePacket(makeProfile(), blocks, 'me', 555);
    const text = packetToText(packet);

    expect(text).toContain('## Tournament encounters');
    expect(text).toMatch(/- .+ — The Big House 9 \(Winners Semi-Final\): 2-0/);
  });
});
