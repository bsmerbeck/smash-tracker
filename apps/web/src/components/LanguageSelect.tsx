import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SUPPORTED_LANGUAGES } from '@/i18n';

/**
 * V15: the language bar. Changing the value persists to localStorage via
 * i18next's detector cache, so the choice sticks across sessions and always
 * beats browser-language detection afterwards. Language names are shown in
 * their own language (Español, not "Spanish") — the one string that must
 * never be translated away from the reader.
 */
export function LanguageSelect({ className }: { className?: string }) {
  const { i18n, t } = useTranslation();
  const current = SUPPORTED_LANGUAGES.find((l) => i18n.resolvedLanguage === l.code)?.code ?? 'en';

  return (
    <Select value={current} onValueChange={(code) => void i18n.changeLanguage(code)}>
      <SelectTrigger size="sm" className={className} aria-label={t('chrome.language')}>
        <Languages className="size-4" aria-hidden="true" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {SUPPORTED_LANGUAGES.map((lang) => (
          <SelectItem key={lang.code} value={lang.code}>
            {lang.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
