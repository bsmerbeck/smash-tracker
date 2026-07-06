import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { ParryggSearchResult } from '@smash-tracker/shared';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import {
  useParryggLoginComplete,
  useParryggLoginSearch,
  useParryggLoginStart,
} from '@/hooks/useParryggLogin';
import { ApiError } from '@/lib/api';

type Step = 'search' | 'code' | 'signing-in';

function resetableState() {
  return {
    step: 'search' as Step,
    query: '',
    candidate: null as ParryggSearchResult | null,
    checkError: null as string | null,
  };
}

/**
 * "Continue with parry.gg" dialog wizard (V8-B): gamer-tag search -> pick
 * your account -> paste the bio code -> verify. Mirrors the trust model of
 * the linked-account verification flow (ParryggCard's VerifyDialog) but for
 * signing IN rather than linking an already-authenticated account — parry.gg
 * has no OAuth, so the bio code is the sole proof of ownership here too.
 *
 * On success the API hands back a Firebase custom token directly in the
 * response body (no URL-fragment redirect needed — that pattern in
 * StartggAuthPage exists only because start.gg's login is an OAuth
 * callback; this flow never leaves the SPA).
 */
export function ParryggLoginDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { signInWithToken } = useAuth();
  const [state, setState] = useState(resetableState);
  const [copied, setCopied] = useState(false);

  const search = useParryggLoginSearch();
  const start = useParryggLoginStart();
  const complete = useParryggLoginComplete();

  function handleOpenChange(next: boolean) {
    if (!next) {
      setState(resetableState());
      setCopied(false);
      search.reset();
      start.reset();
      complete.reset();
    }
    onOpenChange(next);
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!state.query.trim()) {
      return;
    }
    search.mutate(
      { query: state.query.trim() },
      {
        onError: () => {
          /* surfaced inline below via search.isError */
        },
      },
    );
  }

  async function handlePick(candidate: ParryggSearchResult) {
    setState((s) => ({ ...s, candidate }));
    try {
      await start.mutateAsync({ parryUserId: candidate.id });
      setState((s) => ({ ...s, step: 'code' }));
    } catch {
      // start.isError renders the message; stay on the search step.
    }
  }

  async function handleCopy() {
    if (!start.data) {
      return;
    }
    await navigator.clipboard.writeText(start.data.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleRestart() {
    setState(resetableState());
    start.reset();
    complete.reset();
  }

  async function handleVerify() {
    if (!state.candidate) {
      return;
    }
    setState((s) => ({ ...s, checkError: null }));
    try {
      const { token } = await complete.mutateAsync({ parryUserId: state.candidate.id });
      setState((s) => ({ ...s, step: 'signing-in' }));
      await signInWithToken(token);
      handleOpenChange(false);
    } catch (err) {
      const expired =
        err instanceof ApiError && /expired|no login code is pending/i.test(err.message);
      setState((s) => ({
        ...s,
        step: 'code',
        checkError: expired
          ? 'That code expired. Start over to get a new one.'
          : err instanceof Error
            ? err.message
            : 'Verification failed. Please try again.',
      }));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        {state.step === 'search' && (
          <>
            <DialogHeader>
              <DialogTitle>Continue with parry.gg</DialogTitle>
              <DialogDescription>
                Enter your parry.gg gamer tag to find your account.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSearch} className="flex flex-col gap-3">
              <Input
                placeholder="Your parry.gg gamer tag..."
                value={state.query}
                onChange={(e) => setState((s) => ({ ...s, query: e.target.value }))}
                aria-label="parry.gg gamer tag"
                autoFocus
              />
              <Button type="submit" disabled={search.isPending || !state.query.trim()}>
                {search.isPending ? 'Searching…' : 'Search'}
              </Button>
            </form>
            {search.isError && (
              <p className="text-sm text-destructive">
                Couldn&apos;t search parry.gg right now. Please try again.
              </p>
            )}
            {search.data && (
              <div className="flex flex-col divide-y rounded-md border">
                {search.data.length > 0 ? (
                  search.data.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      className="flex w-full items-center justify-between gap-2 p-2 text-left hover:bg-accent disabled:opacity-50"
                      onClick={() => handlePick(candidate)}
                      disabled={start.isPending}
                    >
                      <div className="flex items-center gap-2">
                        <Avatar size="sm">
                          <AvatarImage src={candidate.avatarUrl} alt="" />
                          <AvatarFallback>
                            {candidate.gamerTag.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{candidate.gamerTag}</span>
                          {(candidate.sponsorName || candidate.locationCountry) && (
                            <span className="text-xs text-muted-foreground">
                              {[candidate.sponsorName, candidate.locationCountry]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  ))
                ) : (
                  <p className="p-3 text-sm text-muted-foreground">
                    No matching parry.gg accounts.
                  </p>
                )}
              </div>
            )}
            {start.isError && (
              <p className="text-sm text-destructive">
                Couldn&apos;t start verification for that account. Please try again.
              </p>
            )}
          </>
        )}

        {state.step === 'code' && start.data && (
          <>
            <DialogHeader>
              <DialogTitle>Verify it&apos;s you</DialogTitle>
              <DialogDescription>
                Add this code anywhere in your parry.gg profile bio, then click Verify. You can
                remove it right after.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-muted px-3 py-2 text-center font-mono text-lg tracking-wider">
                {start.data.code}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleCopy}
                aria-label="Copy login code"
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
            {state.checkError && (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-destructive">{state.checkError}</p>
                {state.checkError.includes('expired') && (
                  <Button type="button" variant="outline" size="sm" onClick={handleRestart}>
                    Start over
                  </Button>
                )}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={handleVerify} disabled={complete.isPending}>
                {complete.isPending ? 'Verifying…' : 'Verify'}
              </Button>
            </DialogFooter>
          </>
        )}

        {state.step === 'signing-in' && (
          <div className="py-8 text-center text-muted-foreground">Signing you in…</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
