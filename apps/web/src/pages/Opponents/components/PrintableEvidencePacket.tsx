import type { EvidencePacket } from '../evidencePacket';

/**
 * On-screen-hidden, print-only rendering of the H2H evidence packet (see
 * `apps/web/src/index.css`'s `.print-packet-root` rule, which hides
 * everything else on the page when `window.print()` fires). Plain black-on-
 * white styling — this is meant to be legible on paper, not themed to match
 * the app's dark UI.
 */
export function PrintableEvidencePacket({ packet }: { packet: EvidencePacket }) {
  return (
    <div className="print-packet-root hidden print:block">
      <h1 className="text-2xl font-bold">
        H2H Evidence Packet: {packet.preparedBy} vs {packet.opponent}
      </h1>
      <p className="mt-1 text-sm">Generated {new Date(packet.generatedAt).toLocaleString()}</p>
      <p className="text-sm">
        Date range: {new Date(packet.dateRange.firstPlayedAt).toLocaleDateString()} –{' '}
        {new Date(packet.dateRange.lastPlayedAt).toLocaleDateString()}
      </p>

      <h2 className="mt-4 text-lg font-semibold">Overall record</h2>
      <p>
        {packet.record.wins}-{packet.record.losses} ({packet.record.winRate}% over{' '}
        {packet.record.total} game{packet.record.total === 1 ? '' : 's'})
      </p>

      <h2 className="mt-4 text-lg font-semibold">Their characters</h2>
      {packet.byTheirCharacter.length === 0 ? (
        <p>No character data recorded.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="border border-black/30 p-1 text-left">Character</th>
              <th className="border border-black/30 p-1 text-left">Record</th>
              <th className="border border-black/30 p-1 text-left">Win Rate</th>
              <th className="border border-black/30 p-1 text-left">Games</th>
            </tr>
          </thead>
          <tbody>
            {packet.byTheirCharacter.map((row) => (
              <tr key={row.name}>
                <td className="border border-black/30 p-1">{row.name}</td>
                <td className="border border-black/30 p-1">
                  {row.wins}-{row.losses}
                </td>
                <td className="border border-black/30 p-1">{row.winRate}%</td>
                <td className="border border-black/30 p-1">{row.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="mt-4 text-lg font-semibold">Stages</h2>
      {packet.byStage.length === 0 ? (
        <p>No stage data recorded.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="border border-black/30 p-1 text-left">Stage</th>
              <th className="border border-black/30 p-1 text-left">Record</th>
              <th className="border border-black/30 p-1 text-left">Win Rate</th>
            </tr>
          </thead>
          <tbody>
            {packet.byStage.map((row) => (
              <tr key={row.name}>
                <td className="border border-black/30 p-1">{row.name}</td>
                <td className="border border-black/30 p-1">
                  {row.wins}-{row.losses}
                </td>
                <td className="border border-black/30 p-1">{row.winRate}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="mt-4 text-lg font-semibold">Tournament encounters</h2>
      {packet.tournamentEncounters.length === 0 ? (
        <p>No tournament sets recorded.</p>
      ) : (
        <ul>
          {packet.tournamentEncounters.map((encounter) => (
            <li key={`${encounter.displayName}-${encounter.date}-${encounter.roundLabel}`}>
              {encounter.date} — {encounter.displayName} ({encounter.roundLabel}):{' '}
              {encounter.result}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
