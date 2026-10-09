import { afterEach, describe, expect, test } from 'bun:test';
import { silentLogger } from '@provenance/core';

import { RpcClient, RpcError, resetRpcCooldowns, type RpcTransport, type TransportRequest } from './rpc';

const KEYED = 'https://eth-mainnet.g.alchemy.com/v2/key';
const OPEN = 'https://ethereum-rpc.publicnode.com';

/** Keyed node refuses eth_getLogs with a 400; the open node answers everything. */
function transport(log: string[]): RpcTransport {
  return {
    async send(request: TransportRequest) {
      log.push(`${request.endpoint} ${request.calls[0]?.method}`);
      if (request.endpoint === KEYED && request.calls[0]?.method === 'eth_getLogs') {
        throw new RpcError(`HTTP 400 from ${KEYED}`, { endpoint: KEYED, code: 400 });
      }
      return request.calls.map(() => ({ result: '0x1' }));
    },
  };
}

function client(log: string[]): RpcClient {
  return new RpcClient({ endpoints: [KEYED, OPEN], transport: transport(log), logger: silentLogger, attempts: 3 });
}

afterEach(() => resetRpcCooldowns());

describe('RpcClient failover', () => {
  test('a 4xx fails over at once instead of retrying the same node', async () => {
    const log: string[] = [];
    expect(await client(log).call<string>('eth_getLogs', [])).toBe('0x1');
    expect(log).toEqual([`${KEYED} eth_getLogs`, `${OPEN} eth_getLogs`]);
  });

  test('a refused method goes to the back of the line for the next client', async () => {
    await client([]).call('eth_getLogs', []);
    const log: string[] = [];
    await client(log).call('eth_getLogs', []);
    expect(log).toEqual([`${OPEN} eth_getLogs`]);
  });

  test('the cooldown is per method: the keyed node still leads for eth_call', async () => {
    await client([]).call('eth_getLogs', []);
    const log: string[] = [];
    await client(log).call('eth_call', []);
    expect(log).toEqual([`${KEYED} eth_call`]);
  });
});
