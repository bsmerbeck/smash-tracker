/**
 * The CHILD-READY MARKER shared by the child-process lifecycle harnesses and
 * the tests that drive them (owner/Codex hard gate #4, B10).
 *
 * WHY IT IS ITS OWN MODULE. A harness is an entry point: importing
 * `deriveTournamentRegistryHarness.ts` to reach a constant would also START
 * it — spawn its fake operator, arm its artificial open handle, and run a
 * whole lifecycle inside the test process. So the one literal both sides must
 * agree on lives here instead, in a module with no side effects at all. The
 * alternative, retyping the string in the test, is precisely the kind of
 * duplicate that drifts silently and turns a synchronization point back into
 * the sleep it replaced.
 *
 * WHAT IT IS FOR. A signal-delivery test has to know the child has reached the
 * state under test. The obvious implementation — sleep, then signal — encodes
 * a GUESS about how long `tsx` needs to compile and boot; that guess is wrong
 * exactly when the machine is loaded, i.e. when the file runs inside a full
 * targeted group rather than alone, and the child then dies of an unhandled
 * default SIGINT before the lifecycle handlers exist. The child printing this
 * line from inside the state it has reached removes the guess. Raising the
 * sleep would only have made the race rarer.
 */
export const HARNESS_READY_MARKER = 'harness-ready: first RTDB read is in flight and hanging';
