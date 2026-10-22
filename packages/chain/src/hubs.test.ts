import { describe, expect, test } from 'bun:test';
import { findHubFunders, HUB_MIN_NONCE } from './evm';
import { MockRpcTransport } from './mock';
import { Budget, RpcClient } from './rpc';
import { silentLogger } from '@provenance/core';

const hex = (n: number) => `0x${n.toString(16)}`;

function client(state: Record<string, { nonce?: number; code?: string; fail?: boolean }>, budget = new Budget(60_000)) {
  const transport = new MockRpcTransport({
    handlers: {
      eth_getTransactionCount: ({ call }) => {
        const entry = state[call.params[0] as string];
        if (!entry || entry.fail) return { error: { code: -32000, message: 'node down' } };
        return { result: hex(entry.nonce ?? 0) };
      },
      eth_getCode: ({ call }) => ({ result: state[call.params[0] as string]?.code ?? '0x' }),
    },
  });
  return new RpcClient({ endpoints: ['mock://a'], transport, logger: silentLogger, attempts: 1, budget });
}

describe('findHubFunders', () => {
  const funders = new Map<string, string | undefined>([
    ['0xa1', '0xeoa'],
    ['0xa2', '0xeoa'],
    ['0xb1', '0xexchange'],
    ['0xb2', '0xexchange'],
    ['0xc1', '0xbridge'],
    ['0xc2', '0xbridge'],
    ['0xd1', '0xflaky'],
    ['0xd2', '0xflaky'],
    ['0xe1', '0xsolo'],
    ['0xf1', undefined],
  ]);

  test('busy EOAs, contracts and unreadable funders are hubs; a quiet shared EOA is not', async () => {
    const hubs = await findHubFunders(
      client({
        '0xeoa': { nonce: 3 },
        '0xexchange': { nonce: HUB_MIN_NONCE },
        '0xbridge': { nonce: 1, code: '0x6080' },
        '0xflaky': { fail: true },
      }),
      funders,
      new Budget(60_000),
    );
    expect(hubs).toEqual(new Set(['0xexchange', '0xbridge', '0xflaky']));
  });

  test('an exhausted budget yields no read, not a cluster of everyone', async () => {
    const spent = new Budget(0);
    expect(await findHubFunders(client({ '0xeoa': { nonce: 3 } }, spent), funders, spent)).toBeUndefined();
  });
});
