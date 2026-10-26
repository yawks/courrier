// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import { localizeTeamsError } from './teamsError';

describe('Teams creation diagnostics', () => {
  it.each(['fr', 'en'])('distinguishes Microsoft failures in %s through transport wrapping', async language => {
    await i18n.changeLanguage(language);
    const cases = [
      ['teams_auth_failed_http_400:invalid_grant:AADSTS65001', 'teamsConsentError'],
      ['teams_auth_failed_http_400:invalid_scope:AADSTS70011', 'teamsAppPermissionError'],
      ['teams_auth_failed_http_400:invalid_grant:AADSTS700082', 'teamsAuthError'],
      ['teams_creation_failed_http_403:Forbidden', 'teamsForbiddenError'],
      ['teams_creation_failed_http_429:TooManyRequests', 'teamsThrottledError'],
      ['teams_auth_failed_http_503:unknown', 'teamsServiceError'],
      ['teams_request_failed', 'teamsNetworkError'],
      ['teams_missing_link', 'teamsResponseError'],
      ['teams_creation_failed_http_403', 'teamsForbiddenError'],
    ];
    for (const [code, key] of cases) {
      const result = localizeTeamsError(`HTTP 502: {"error":"${code}"}`);
      const translated = i18n.t(`createEvent.${key}`);
      expect(translated).not.toBe(`createEvent.${key}`);
      expect(result).toBe(`${translated} ${i18n.t('createEvent.teamsDiagnostic', { code })}`);
    }
  });

  it('does not display raw response details or translate other providers', () => {
    const result = localizeTeamsError('teams_creation_failed_http_403:Forbidden private@example.com access_token=secret');
    expect(result).not.toContain('private@example.com');
    expect(result).not.toContain('secret');
    expect(localizeTeamsError('Google calendar error')).toBeUndefined();
  });
});
