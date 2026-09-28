import { describe, expect, it } from 'vitest';
import { stripCredentials } from './run.js';

describe('stripCredentials', () => {
  it('removes known credential keys from environment', () => {
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      ANTHROPIC_AUTH_TOKEN: 'auth-token-xxx',
      CODEX_API_KEY: 'codex-key-xxx',
      OPENAI_API_KEY: 'openai-key-xxx',
      GOOGLE_API_KEY: 'google-key-xxx',
      GEMINI_API_KEY: 'gemini-key-xxx',
      MISTRAL_API_KEY: 'mistral-key-xxx',
      COHERE_API_KEY: 'cohere-key-xxx',
      AZURE_OPENAI_API_KEY: 'azure-openai-key-xxx',
      AZURE_API_KEY: 'azure-key-xxx',
      AWS_ACCESS_KEY_ID: 'aws-access-key-xxx',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-key-xxx',
      CUSTOM_VAR: 'custom-value',
    };

    const stripped = stripCredentials(env);

    expect(stripped.PATH).toBe('/usr/bin:/bin');
    expect(stripped.HOME).toBe('/home/user');
    expect(stripped.CUSTOM_VAR).toBe('custom-value');
    expect(stripped.ANTHROPIC_API_KEY).toBeUndefined();
    expect(stripped.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(stripped.CODEX_API_KEY).toBeUndefined();
    expect(stripped.OPENAI_API_KEY).toBeUndefined();
    expect(stripped.GOOGLE_API_KEY).toBeUndefined();
    expect(stripped.GEMINI_API_KEY).toBeUndefined();
    expect(stripped.MISTRAL_API_KEY).toBeUndefined();
    expect(stripped.COHERE_API_KEY).toBeUndefined();
    expect(stripped.AZURE_OPENAI_API_KEY).toBeUndefined();
    expect(stripped.AZURE_API_KEY).toBeUndefined();
    expect(stripped.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(stripped.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('preserves non-credential keys', () => {
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      NODE_ENV: 'production',
    };

    const stripped = stripCredentials(env);

    expect(stripped.PATH).toBe('/usr/bin:/bin');
    expect(stripped.HOME).toBe('/home/user');
    expect(stripped.NODE_ENV).toBe('production');
  });

  it('handles empty environment', () => {
    const env = {};
    const stripped = stripCredentials(env);
    expect(stripped).toEqual({});
  });
});
