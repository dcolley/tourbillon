/**
 * TB-HOTFIX-REDACT §2: thin re-export of the ONE redactor from @tourbillon/shared.
 *
 * The web notice path re-applies redaction defensively (MUST-4), but there must never be
 * two implementations: this file must stay a re-export. (#364/#370's FailureBlock imports
 * from this path too — keep it stable.)
 */
export {
  redactErrorText,
  stripNoticeDirectives,
  registerKnownSecrets,
  clearKnownSecrets,
  TECHNICAL_MAX_CHARS,
  TRUNCATION_MARKER,
} from '@tourbillon/shared/redact-error';
