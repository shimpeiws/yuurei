import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openCodeConfigDir, openCodeDataDir, openCodeEnv, realOpenCodeDataDir } from './paths.js';

describe('OpenCode paths', () => {
  it('redirects every XDG root and TMPDIR into the cell', () => {
    expect(openCodeEnv('/cell')).toEqual({
      XDG_CONFIG_HOME: join('/cell', '.config'),
      XDG_DATA_HOME: join('/cell', '.local', 'share'),
      XDG_STATE_HOME: join('/cell', '.local', 'state'),
      XDG_CACHE_HOME: join('/cell', '.cache'),
      TMPDIR: join('/cell', 'tmp'),
    });
  });

  it('derives the config and data dirs from the cell root', () => {
    expect(openCodeConfigDir('/cell')).toBe(join('/cell', '.config', 'opencode'));
    expect(openCodeDataDir('/cell')).toBe(join('/cell', '.local', 'share', 'opencode'));
  });

  it('derives the real (operator) data dir from a real HOME for the bridge source', () => {
    expect(realOpenCodeDataDir('/home/op')).toBe(join('/home/op', '.local', 'share', 'opencode'));
  });
});
