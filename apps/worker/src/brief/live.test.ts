/**
 * Live smoke test for the two keyless sources the brief reads, through the
 * same code path the command uses. Off by default: `BRIEF_LIVE=1 bun test
 * apps/worker/src/brief/live.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { fetchDexScreenerMarket } from './ledger';
import { fetchBtcRegime } from './regime';

const live = process.env.BRIEF_LIVE === '1';

describe.skipIf(!live)('live sources', () => {
  test('hl-cycles vector.json parses to a BTC regime', async () => {
    const regime = await fetchBtcRegime();
    console.log('hl-cycles:', JSON.stringify(regime));
    expect(regime.gap).toBeUndefined();
    expect(regime.state).toMatch(/risk_(on|off)|neutral/);
  }, 30_000);

  test('DexScreener tokens endpoint yields mcap and liquidity for BONK', async () => {
    const market = await fetchDexScreenerMarket('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'solana');
    console.log('dexscreener:', JSON.stringify(market));
    expect(market.gap).toBeUndefined();
    expect(market.mcapUsd).toBeGreaterThan(0);
    expect(market.liquidityUsd).toBeGreaterThan(0);
  }, 30_000);
});
