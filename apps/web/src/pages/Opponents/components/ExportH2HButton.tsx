import { useState } from 'react';
import { Printer, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { EvidencePacket } from '../evidencePacket';
import { packetToText } from '../evidencePacket';

const COPY_FEEDBACK_MS = 2000;

/**
 * "Export H2H" controls: a Print button (triggers `window.print()`, which
 * shows only `<PrintableEvidencePacket>` per the `.print-packet-root`
 * print-media rule) and a "Copy as text" fallback for when printing/saving a
 * PDF isn't convenient — e.g. pasting the packet straight into a Discord
 * message to a teammate before a set.
 */
export function ExportH2HButton({ packet }: { packet: EvidencePacket }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const text = packetToText(packet);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Clipboard access can fail (permissions, insecure context); no
      // secondary fallback is provided beyond the button reverting silently.
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => window.print()}>
        <Printer />
        Export H2H
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
        {copied ? <Check /> : <Copy />}
        {copied ? 'Copied!' : 'Copy as text'}
      </Button>
    </div>
  );
}
