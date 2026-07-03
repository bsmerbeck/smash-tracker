# @smash-tracker/shared

Zod schemas and inferred TypeScript types shared by `apps/api` and `apps/web`.

## RTDB data model (derived from legacy)

This package's schemas are reverse-engineered from `legacy/src` so that field
names match exactly what the legacy CRA app already wrote to production
Firebase Realtime Database. **Do not rename fields** — existing data depends
on these exact keys.

Provenance (legacy source files read to derive this):
- `legacy/src/screens/Dashboard/components/DashboardToolbar/components/AddMatchForm/AddMatchForm.js` — match create, opponent write
- `legacy/src/screens/MatchData/components/MatchTable/MatchTable.js` and `components/EditMatchForm/EditMatchForm.js` — match read/update/delete
- `legacy/src/screens/CharacterSelect/PrimarySelect/PrimarySelect.js` and `SecondarySelect/SecondarySelect.js` — fighter selection writes
- `legacy/src/screens/Dashboard/DashboardContainer.js`, `legacy/src/screens/Matchups/*`, `legacy/src/screens/FighterAnalysis/*` — read patterns
- `legacy/src/components/Sprites/SpriteList.js`, `legacy/src/components/Stages/StageList.js` — fighter/stage reference data (static, bundled client-side, never stored in RTDB)
- Deleted `functions/index.js` (recovered via `git log`/`git show`) — the `onCreate` auth trigger that used to populate `users/{uid}`

### `users/{uid}`

```ts
{ email: string }
```

Previously written by a Cloud Function's `functions.auth.user().onCreate`
handler (`admin.database().ref('/users/${uid}').set({ email: userRecord.email })`).
That function is deleted; `PUT /api/users/me` now performs the same idempotent
upsert, using the email claim from the verified Firebase ID token.

### `primaryFighters/{uid}` / `secondaryFighters/{uid}`

```ts
number[] // SpriteList ids, e.g. [1, 8, 41]
```

Each path is a flat array of fighter ids (`SpriteList[].id`). Legacy always
`.set()`s the whole array (full overwrite) from `PrimarySelect.js` /
`SecondarySelect.js` — there is no per-id add/remove RTDB call.

### `matches/{uid}/{pushKey}`

```ts
{
  fighter_id: number;      // SpriteList id of the tracked user's own fighter
  opponent_id: number;     // SpriteList id of the opponent's in-game fighter (character)
  time: number;            // epoch ms, written via ServerValue.TIMESTAMP
  map?: { id: number; name: string }; // id: 0 means "no selection"
  opponent?: string;       // free-text human opponent name, lowercased client-side
  notes?: string;          // free text
  matchType?: '' | 'none' | 'quickplay' | 'online-friendly' | 'online-tourney' | 'offline-friendly' | 'offline-tourney';
  win: boolean;
}
```

Both create (`AddMatchForm.js`) and edit (`EditMatchForm.js`) use `.set()` —
legacy never issued a partial `.update()` against a match record. `map`,
`opponent`, `notes`, and `matchType` are optional in the stored schema
because older records may be missing them entirely; every legacy reader
defensively coalesces these (`m.map ? m.map : {...}`, etc.). Delete is a
plain `.remove()` on the push-key path — no tombstone/soft-delete.

The API surfaces the RTDB push key as `id` on every match it returns.

### `opponents/{uid}/{opponentName}`

```ts
{ [lowercasedOpponentName: string]: true }
```

A set-membership map, not a list of ids: legacy does
`firebase.set('/opponents/${uid}/${opponent}', true)` on every match
create/edit. The opponent's identity *is* the lowercased name string; there's
no numeric id and no dedup logic beyond "same string is the same key" (an
idempotent set write). `GET /api/opponents` returns `Object.keys(...)` of
this map as a flat string array.

### Fighter / Stage reference data

`SpriteList.js` (`{ id: number; name: string; url: string }[]`) and
`StageList.js` (same shape) are static, bundled client-side lists — never
stored in RTDB (confirmed via `database.rules.json`, which has a `sprites`
rule that no client code actually reads/writes). They are not re-derived
here as RTDB-backed schemas; `fighterSchema` / `stageSchema` in this package
exist so `apps/web` can validate/type the bundled lists it will port from
`legacy/src/components/Sprites/SpriteList.js` and `.../Stages/StageList.js`
in a later phase.
