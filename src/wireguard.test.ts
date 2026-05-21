import { describe, expect, it } from 'vitest';
import { InMemoryWireGuardController, parseTransferOutput } from './wireguard';

describe('parseTransferOutput', () => {
  it('parses the `wg show wg0 transfer` format', () => {
    const out = parseTransferOutput(
      [
        'abc123\t1024\t2048',
        'def456\t5000\t10000',
        '   ',
      ].join('\n'),
    );
    expect(out).toEqual([
      { pubkey: 'abc123', rx: 1024, tx: 2048 },
      { pubkey: 'def456', rx: 5000, tx: 10000 },
    ]);
  });

  it('skips lines that don’t parse as numbers', () => {
    const out = parseTransferOutput('abc\tNaN\t1');
    expect(out).toEqual([]);
  });
});

describe('InMemoryWireGuardController', () => {
  it('tracks peers and their cumulative transfer', async () => {
    const wg = new InMemoryWireGuardController();
    await wg.addPeer({ pubkey: 'A', assignedIp: '10.42.0.2' });
    await wg.addPeer({ pubkey: 'B', assignedIp: '10.42.0.3' });
    wg.bumpTransfer('A', 100, 200);
    wg.bumpTransfer('A', 50, 50);
    wg.bumpTransfer('B', 1, 1);
    const transfers = await wg.showTransfer();
    expect(transfers).toEqual([
      { pubkey: 'A', rx: 150, tx: 250 },
      { pubkey: 'B', rx: 1, tx: 1 },
    ]);
    await wg.removePeer('A');
    expect((await wg.showTransfer()).map((t) => t.pubkey)).toEqual(['B']);
  });
});
