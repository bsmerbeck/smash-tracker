import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RULESET_CONTRACT_VERSION,
  stageIdKey,
  type RulesetOverrideStored,
  type TournamentEntry,
} from '@smash-tracker/shared';
import { RulesetOverrideSection } from './RulesetOverrideSection';

const setRulesetOverride = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      tournaments: {
        ...actual.api.tournaments,
        setRulesetOverride: (...args: unknown[]) => setRulesetOverride(...args),
      },
    },
  };
});

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

function renderSection(entry: Pick<TournamentEntry, 'entryKey' | 'rulesetOverride'>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RulesetOverrideSection entry={entry} />
    </QueryClientProvider>,
  );
}

/** The stage row element labelled `stageName` (Label + ToggleGroup pair) — wrap in `within()` at the call site. */
function stageRow(stageName: string): HTMLElement {
  const label = screen.getByText(stageName);
  return label.parentElement as HTMLElement;
}

describe('RulesetOverrideSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the using-default line and no override badge when the entry carries no override', () => {
    renderSection({ entryKey: 'entry-1', rulesetOverride: null });

    expect(screen.getByText('Using the house default ruleset.')).toBeInTheDocument();
    expect(screen.queryByText('Event override')).not.toBeInTheDocument();
  });

  it('renders the using-override line when the entry carries a stored override', () => {
    renderSection({
      entryKey: 'entry-1',
      rulesetOverride: { contractVersion: RULESET_CONTRACT_VERSION, dsr: 'none' },
    });

    expect(screen.getByText('Using a custom ruleset for this event.')).toBeInTheDocument();
    expect(screen.getByText('Event override')).toBeInTheDocument();
  });

  it('renders both the ignored-override line and the using-default line when the stored contractVersion exceeds the running one', () => {
    renderSection({
      entryKey: 'entry-1',
      rulesetOverride: { contractVersion: RULESET_CONTRACT_VERSION + 1, dsr: 'none' },
    });

    expect(screen.getByText('Using the house default ruleset.')).toBeInTheDocument();
    expect(
      screen.getByText(
        "This event's saved ruleset was written by a newer version of the app and is not being applied.",
      ),
    ).toBeInTheDocument();
  });

  it('the rendered detail line contains the preset strikeOrder string verbatim', () => {
    renderSection({ entryKey: 'entry-1', rulesetOverride: null });
    expect(screen.getByText(/Game 1: 1-2-1 stage strike/)).toBeInTheDocument();
  });

  it('moving one stage from starter to counterpick and saving calls the mutation exactly once with the expected payload', async () => {
    const user = userEvent.setup();
    setRulesetOverride.mockResolvedValue({ entryKey: 'entry-1', rulesetOverride: null });
    renderSection({ entryKey: 'entry-1', rulesetOverride: null });

    await user.click(screen.getByRole('button', { name: 'Edit ruleset for this event' }));
    await user.click(within(stageRow('Battlefield')).getByRole('radio', { name: 'Counterpick' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(setRulesetOverride).toHaveBeenCalledTimes(1);
    const [, payload] = setRulesetOverride.mock.calls[0] as [string, RulesetOverrideStored];
    expect(payload.contractVersion).toBe(RULESET_CONTRACT_VERSION);
    expect(payload.starterStageIds?.[stageIdKey(1)]).toBeUndefined();
    expect(payload.counterpickStageIds?.[stageIdKey(1)]).toBe(true);
  });

  it('the submitted payload omits strikeOrder — a member this editor exposes no field for', async () => {
    const user = userEvent.setup();
    setRulesetOverride.mockResolvedValue({ entryKey: 'entry-1', rulesetOverride: null });
    renderSection({ entryKey: 'entry-1', rulesetOverride: null });

    await user.click(screen.getByRole('button', { name: 'Edit ruleset for this event' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(setRulesetOverride).toHaveBeenCalledTimes(1);
    const [, payload] = setRulesetOverride.mock.calls[0] as [string, RulesetOverrideStored];
    expect('strikeOrder' in payload).toBe(false);
  });

  // WR-02: an untouched member must stay OMITTED even when a sibling member
  // in the SAME save is edited — the payload used to always snapshot every
  // stage's role on every save, freezing the whole stage-legality split the
  // instant a user touched an unrelated field like DSR.
  it('editing only DSR submits a payload with dsr as the only ruleset member (WR-02)', async () => {
    const user = userEvent.setup();
    setRulesetOverride.mockResolvedValue({ entryKey: 'entry-1', rulesetOverride: null });
    renderSection({ entryKey: 'entry-1', rulesetOverride: null });

    await user.click(screen.getByRole('button', { name: 'Edit ruleset for this event' }));
    // DEFAULT_RULESET.dsr is 'modified' — switch to a different variant.
    await user.click(screen.getByRole('radio', { name: 'no DSR' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(setRulesetOverride).toHaveBeenCalledTimes(1);
    const [, payload] = setRulesetOverride.mock.calls[0] as [string, RulesetOverrideStored];
    expect(payload).toEqual({ contractVersion: RULESET_CONTRACT_VERSION, dsr: 'none' });
  });

  it('editing only the starter list (never touching a counterpick-role stage) omits counterpickStageIds (WR-02)', async () => {
    const user = userEvent.setup();
    setRulesetOverride.mockResolvedValue({ entryKey: 'entry-1', rulesetOverride: null });
    renderSection({ entryKey: 'entry-1', rulesetOverride: null });

    await user.click(screen.getByRole('button', { name: 'Edit ruleset for this event' }));
    // Battlefield is a DEFAULT_RULESET starter; demoting it to "not legal"
    // changes only the derived starter set — no counterpick-role stage is
    // touched, so the counterpick set is byte-for-byte unchanged from baseline.
    await user.click(within(stageRow('Battlefield')).getByRole('radio', { name: 'Not legal' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(setRulesetOverride).toHaveBeenCalledTimes(1);
    const [, payload] = setRulesetOverride.mock.calls[0] as [string, RulesetOverrideStored];
    expect(payload.contractVersion).toBe(RULESET_CONTRACT_VERSION);
    expect(payload.starterStageIds?.[stageIdKey(1)]).toBeUndefined();
    expect('counterpickStageIds' in payload).toBe(false);
    expect('dsr' in payload).toBe(false);
    expect('banCounts' in payload).toBe(false);
    expect('setFormat' in payload).toBe(false);
  });

  it('opening the dialog and saving with no edits at all submits a payload with only contractVersion (WR-02)', async () => {
    const user = userEvent.setup();
    setRulesetOverride.mockResolvedValue({ entryKey: 'entry-1', rulesetOverride: null });
    renderSection({ entryKey: 'entry-1', rulesetOverride: null });

    await user.click(screen.getByRole('button', { name: 'Edit ruleset for this event' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(setRulesetOverride).toHaveBeenCalledTimes(1);
    const [, payload] = setRulesetOverride.mock.calls[0] as [string, RulesetOverrideStored];
    expect(payload).toEqual({ contractVersion: RULESET_CONTRACT_VERSION });
  });

  it('a mutation rejection leaves the dialog open, keeps the edited field, and triggers the error toast', async () => {
    const user = userEvent.setup();
    setRulesetOverride.mockRejectedValue(new Error('boom'));
    renderSection({ entryKey: 'entry-1', rulesetOverride: null });

    await user.click(screen.getByRole('button', { name: 'Edit ruleset for this event' }));
    await user.click(within(stageRow('Battlefield')).getByRole('radio', { name: 'Counterpick' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(
      within(stageRow('Battlefield')).getByRole('radio', { name: 'Counterpick' }),
    ).toHaveAttribute('data-state', 'on');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('the reset control calls the mutation exactly once with the clearing payload', async () => {
    const user = userEvent.setup();
    setRulesetOverride.mockResolvedValue({ entryKey: 'entry-1', rulesetOverride: null });
    renderSection({
      entryKey: 'entry-1',
      rulesetOverride: { contractVersion: RULESET_CONTRACT_VERSION, dsr: 'none' },
    });

    await user.click(screen.getByRole('button', { name: 'Reset to house default' }));

    expect(setRulesetOverride).toHaveBeenCalledTimes(1);
    expect(setRulesetOverride).toHaveBeenCalledWith('entry-1', null);
  });
});
