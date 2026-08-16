import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Printer, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useIsDemoAccount } from '@/hooks/useIsDemoAccount';
import type { EvidencePacket } from '../evidencePacket';
import { packetToText } from '../evidencePacket';

const COPY_FEEDBACK_MS = 2000;

/**
 * "Export H2H" controls: a Print button (triggers `window.print()`, which
 * shows only `<PrintableEvidencePacket>` per the `.print-packet-root`
 * print-media rule) and a "Copy as text" fallback for when printing/saving a
 * PDF isn't convenient — e.g. pasting the packet straight into a Discord
 * message to a teammate before a set.
 *
 * Phase 30.3 (Gate 6): both disabled-with-explanation for a demo/research
 * account (owner/Codex hard gate) — print/copy is a data-export affordance,
 * the same class of control CSV export and the AI report's download/print
 * buttons are gated for.
 */
export function ExportH2HButton({ packet }: { packet: EvidencePacket }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const isDemoAccount = useIsDemoAccount();

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
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => window.print()}
        disabled={isDemoAccount}
        title={isDemoAccount ? t('demo.disabledReason') : undefined}
      >
        <Printer />
        {t('opponents.export.print')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleCopy}
        disabled={isDemoAccount}
        title={isDemoAccount ? t('demo.disabledReason') : undefined}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? t('opponents.export.copied') : t('opponents.export.copy')}
      </Button>
    </div>
  );
}
