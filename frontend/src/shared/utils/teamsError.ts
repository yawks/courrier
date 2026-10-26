import i18n from 'i18next';

/** Keep Microsoft diagnostics useful without displaying upstream response bodies. */
export function localizeTeamsError(message: string): string | undefined {
  const match = /\bteams_(?:auth_failed_http_\d{3}|creation_failed_http_\d{3})(?::[A-Za-z0-9_.-]{1,80})?(?::AADSTS\d+)?\b|\bteams_(?:auth_required|request_failed|invalid_response|missing_link)\b/.exec(message);
  if (!match) return message.includes('teams_') ? i18n.t('createEvent.teamsError') : undefined;
  const code = match[0];
  let key = 'teamsError';
  if (code === 'teams_request_failed') key = 'teamsNetworkError';
  else if (/http_429/.test(code)) key = 'teamsThrottledError';
  else if (/http_5\d\d/.test(code)) key = 'teamsServiceError';
  else if (/invalid_scope|unauthorized_client|invalid_client|AADSTS(?:65002|65004|70011|700016)\b/.test(code)) key = 'teamsAppPermissionError';
  else if (/consent_required|access_denied|AADSTS(?:65001|90094)\b/.test(code)) key = 'teamsConsentError';
  else if (/^teams_auth_|http_401/.test(code)) key = 'teamsAuthError';
  else if (/http_403/.test(code)) key = 'teamsForbiddenError';
  else if (/invalid_response|missing_link/.test(code)) key = 'teamsResponseError';
  return `${i18n.t(`createEvent.${key}`)} ${i18n.t('createEvent.teamsDiagnostic', { code })}`;
}
