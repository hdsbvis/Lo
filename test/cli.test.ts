import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli/index.js';

describe('argument parsing', () => {
  test('long flags with separate values', () => {
    const a = parseArgs(['scan', '--max-mc', '100000', '--chains', 'solana']);
    assert.equal(a.cmd, 'scan');
    assert.equal(a.flags['max-mc'], '100000');
    assert.equal(a.flags['chains'], 'solana');
    assert.deepEqual(a.positional, []);
  });

  test('long flags with = values', () => {
    const a = parseArgs(['scan', '--max-mc=50000', '--social=off']);
    assert.equal(a.flags['max-mc'], '50000');
    assert.equal(a.flags['social'], 'off');
  });

  test('boolean long flags', () => {
    const a = parseArgs(['scan', '--only-watchable', '--json']);
    assert.equal(a.flags['only-watchable'], true);
    assert.equal(a.flags['json'], true);
  });

  /**
   * Regression: `-v` used to fall through to the positional list, so
   * `watch <addr> -v` resolved "-v" as a token symbol and silently watched
   * an unrelated coin alongside the requested one.
   */
  test('short flags are flags, not positionals', () => {
    const a = parseArgs(['watch', 'SoMeAddress', '-v']);
    assert.deepEqual(a.positional, ['SoMeAddress'],
      'a short flag must never be mistaken for a token to look up');
    assert.equal(a.flags['verbose'], true);
  });

  test('short flags expand to their long names and cluster', () => {
    const a = parseArgs(['check', 'X', '-vj']);
    assert.equal(a.flags['verbose'], true);
    assert.equal(a.flags['json'], true);
    assert.deepEqual(a.positional, ['X']);
  });

  test('addresses and symbols stay positional', () => {
    const a = parseArgs(['check', '0xAbC123', '--chain', 'base']);
    assert.deepEqual(a.positional, ['0xAbC123']);
    assert.equal(a.flags['chain'], 'base');
  });

  test('a flag at the end with no value is boolean', () => {
    const a = parseArgs(['scan', '--verbose']);
    assert.equal(a.flags['verbose'], true);
  });
});
