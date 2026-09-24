import { describe, expect, test } from 'bun:test';
import {
  disassemble,
  ERC20_CORE_SELECTORS,
  minimalProxyTarget,
  PRIVILEGED_SELECTORS,
  scanPrivilegedFunctions,
} from './bytecode';

/** A Solidity-shaped dispatcher: `DUP1 PUSH4 <sel> EQ PUSH1 <dest> JUMPI` per function. */
function dispatcher(selectors: readonly string[]): string {
  const body = selectors.map((selector) => `8063${selector}14605c57`).join('');
  // JUMPDEST padding keeps even a two-function dispatcher above the short-code cutoff.
  return `0x60806040526004361060585760003560e01c${body}${'5b'.repeat(40)}600080fd5b00fe`;
}

const TOKEN = [ERC20_CORE_SELECTORS.transfer, ERC20_CORE_SELECTORS.balanceOf, '18160ddd', '313ce567'];

describe('disassemble', () => {
  test('a 0x63 inside a PUSH immediate is data, and the walk stays aligned after it', () => {
    // PUSH1 0x63, then a real PUSH4. A byte-level search would also "find"
    // 0x63112233 starting inside the PUSH1.
    expect(disassemble('0x60636311223344').push4).toEqual(['11223344']);
  });

  test('a PUSH32 hiding a selector-shaped byte run is skipped whole', () => {
    const push32 = `7f${'00'.repeat(11)}6340c10f19${'00'.repeat(16)}`;
    expect(disassemble(`0x${push32}63a9059cbb`).push4).toEqual(['a9059cbb']);
  });

  test('a PUSH4 truncated by the end of code is not collected', () => {
    expect(disassemble('0x6311223344').push4).toEqual(['11223344']);
    expect(disassemble('0x63112233').push4).toEqual([]);
  });

  test('PUSH0 (0x5f) carries no immediate', () => {
    expect(disassemble('0x5f6311223344').push4).toEqual(['11223344']);
  });

  test('solc metadata is not walked as code', () => {
    // Trailer {"ipfs": h'6340c10f19'}: walked as code, 0x64 is PUSH5 and the
    // bytes after it decode as PUSH4 mint(address,uint256).
    const trailer = 'a1646970667345' + '6340c10f19';
    const code = `${dispatcher(TOKEN)}${trailer}000c`;
    expect(disassemble(code).push4).not.toContain('40c10f19');
    // The same bytes without a valid length suffix are code, and are walked.
    expect(disassemble(`${dispatcher(TOKEN)}${trailer}`).push4).toContain('40c10f19');
  });

  test('records DELEGATECALL', () => {
    expect(disassemble('0x5af4').hasDelegateCall).toBe(true);
    expect(disassemble('0x5a00').hasDelegateCall).toBe(false);
  });
});

describe('scanPrivilegedFunctions', () => {
  test('a plain ERC-20 reads as none found, not as undetermined', () => {
    const scan = scanPrivilegedFunctions(dispatcher(TOKEN));
    expect(scan.privilegedFunctions).toEqual([]);
    expect(scan.note).toBeUndefined();
  });

  test('maps selectors to kinds in a stable order, deduplicated', () => {
    const scan = scanPrivilegedFunctions(
      dispatcher([...TOKEN, 'c647b20e', '8456cb59', 'a0712d68', '40c10f19', 'ec28438a', 'f9f92be4']),
    );
    expect(scan.privilegedFunctions).toEqual(['mint', 'blacklist', 'pause', 'fee', 'max-tx']);
    expect(scan.matches).toContainEqual({ selector: '0xa0712d68', kind: 'mint' });
  });

  test('an EIP-1167 minimal proxy is undetermined, with the implementation named', () => {
    const impl = 'bebebebebebebebebebebebebebebebebebebebe';
    const code = `0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`;
    expect(minimalProxyTarget(code)).toBe(`0x${impl}`);
    const scan = scanPrivilegedFunctions(code);
    expect(scan.privilegedFunctions).toBeUndefined();
    expect(scan.note).toContain('EIP-1167');
    expect(scan.note).toContain(impl);
  });

  test('a delegating proxy without its own ERC-20 dispatch is undetermined', () => {
    const scan = scanPrivilegedFunctions(`${dispatcher(['3659cfe6', '5c60da1b'])}5af4`);
    expect(scan.privilegedFunctions).toBeUndefined();
    expect(scan.note).toContain('proxy');
  });

  test('empty and very short code are undetermined', () => {
    expect(scanPrivilegedFunctions('0x').privilegedFunctions).toBeUndefined();
    const short = scanPrivilegedFunctions('0x63a9059cbb6370a0823100');
    expect(short.privilegedFunctions).toBeUndefined();
    expect(short.note).toContain('too short');
  });

  test('malformed hex is a note, not a throw', () => {
    const scan = scanPrivilegedFunctions(`0x${'zz'.repeat(80)}`);
    expect(scan.privilegedFunctions).toBeUndefined();
    expect(scan.note).toContain('unreadable');
  });
});

describe('selector table', () => {
  test('matches published values', () => {
    expect(ERC20_CORE_SELECTORS.transfer).toBe('a9059cbb'); // transfer(address,uint256)
    expect(ERC20_CORE_SELECTORS.balanceOf).toBe('70a08231'); // balanceOf(address)
    expect(PRIVILEGED_SELECTORS['40c10f19']).toBe('mint'); // mint(address,uint256)
    expect(PRIVILEGED_SELECTORS['8456cb59']).toBe('pause'); // pause()
  });

  test('every key is a 4-byte lowercase selector', () => {
    for (const key of Object.keys(PRIVILEGED_SELECTORS)) expect(key).toMatch(/^[0-9a-f]{8}$/);
  });

  test("omits the Uniswap pair's mint(address), which tokens call out to", () => {
    expect(PRIVILEGED_SELECTORS['6a627842']).toBeUndefined();
  });
});
