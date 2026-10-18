import { describe, expect, test } from 'bun:test';
import { PROVENANCE_TOOL_SCHEMA, buildDegradedReport, validateReportDraft } from './schema';

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    anchor: {
      verdict: 'anchored',
      type: 'historical-meme',
      subject: 'Nyan Cat animation',
      anchorDate: '2011',
      summary: 'A 2011 animation.',
      confidence: 'high',
    },
    organic: {
      verdict: 'organic',
      outsideTraction: 55,
      signals: [{ kind: 'community-effort', organic: true, detail: 'Community takeover after the dev left.' }],
      rivals: [],
      summary: 'Carried by a community takeover.',
    },
    memeName: 'Nyan Cat',
    narrativeCluster: 'cat',
    originSummary: 'A 2011 animation.',
    lineage: [{ kind: 'origin', year: 2011, label: 'Nyan Cat published' }],
    priorCycles: [],
    recycleVerdict: 'unclear',
    recycleGeneration: 0,
    memeticDurability: 60,
    culturalReach: 70,
    authenticityScore: 50,
    speculativeSetup: 'Description only.',
    risks: [],
    confidence: 0.6,
    evidence: [],
    ...overrides,
  };
}

describe('anchor in the provenance tool', () => {
  test('is required and listed first', () => {
    expect(PROVENANCE_TOOL_SCHEMA.required?.[0]).toBe('anchor');
    expect(Object.keys(PROVENANCE_TOOL_SCHEMA.properties as object)[0]).toBe('anchor');
  });

  test('a valid anchor passes without repairs', () => {
    const outcome = validateReportDraft(draft());
    expect(outcome.ok).toBe(true);
    expect(outcome.draft?.anchor.verdict).toBe('anchored');
    expect(outcome.draft?.anchor.confidence).toBe('high');
  });

  test('a missing anchor is a repair that degrades to unclear, not a rejection', () => {
    const { anchor: _dropped, ...rest } = draft();
    const outcome = validateReportDraft(rest);
    expect(outcome.draft).not.toBeNull();
    expect(outcome.draft?.anchor).toMatchObject({ verdict: 'unclear', type: 'none', confidence: 'low' });
    expect(outcome.repairs.join(' ')).toContain('anchor missing');
  });

  test('an out-of-contract anchor is coerced and recorded', () => {
    const outcome = validateReportDraft(draft({ anchor: { verdict: 'probably', type: 'meme', subject: 'x', summary: 'y' } }));
    expect(outcome.draft?.anchor.verdict).toBe('unclear');
    expect(outcome.draft?.anchor.confidence).toBe('low');
    expect(outcome.repairs.some((repair) => repair.startsWith('anchor '))).toBe(true);
  });

  test('anchored with nothing under it is kept, one step less confident', () => {
    const outcome = validateReportDraft(draft({ lineage: [] }));
    expect(outcome.draft?.anchor.verdict).toBe('anchored');
    expect(outcome.draft?.anchor.confidence).toBe('medium');
    expect(outcome.repairs.join(' ')).toContain('anchor confidence high -> medium');

    const low = validateReportDraft(draft({ lineage: [], anchor: { ...(draft().anchor as object), confidence: 'low' } }));
    expect(low.draft?.anchor.confidence).toBe('low');
  });

  test('a prior cycle or a recycling verdict is enough support', () => {
    expect(validateReportDraft(draft({ lineage: [], recycleVerdict: 'revival' })).draft?.anchor.confidence).toBe('high');
    const withCycle = validateReportDraft(draft({ lineage: [], priorCycles: [{ name: 'NYAN 2021' }], recycleGeneration: 1 }));
    expect(withCycle.draft?.anchor.confidence).toBe('high');
  });

  test('the degraded report carries an unresolved anchor with the reason', () => {
    const report = buildDegradedReport({ tokenId: 't', memeName: 'm', model: 'x', promptVersion: 'v', reason: 'boom' });
    expect(report.anchor).toMatchObject({ verdict: 'unclear', type: 'none', subject: '', confidence: 'low' });
    expect(report.anchor?.summary).toContain('boom');
  });
});

describe('organic read in the provenance tool', () => {
  test('is required and sits right after the anchor', () => {
    expect(PROVENANCE_TOOL_SCHEMA.required?.[1]).toBe('organic');
    expect(Object.keys(PROVENANCE_TOOL_SCHEMA.properties as object)[1]).toBe('organic');
  });

  test('a backed verdict passes without repairs', () => {
    const outcome = validateReportDraft(draft());
    expect(outcome.ok).toBe(true);
    expect(outcome.draft?.organic).toMatchObject({ verdict: 'organic', outsideTraction: 55 });
  });

  test('a missing organic read degrades to unclear', () => {
    const { organic: _dropped, ...rest } = draft();
    const outcome = validateReportDraft(rest);
    expect(outcome.draft?.organic).toMatchObject({ verdict: 'unclear', outsideTraction: 0, signals: [], rivals: [] });
    expect(outcome.repairs.join(' ')).toContain('organic missing');
  });

  test('a verdict with no signal on its side falls back to unclear', () => {
    const outcome = validateReportDraft(
      draft({
        organic: {
          verdict: 'manufactured',
          outsideTraction: 10,
          signals: [{ kind: 'listing', organic: true, detail: 'HTX spot listing.' }],
          rivals: [],
          summary: 'x',
        },
      }),
    );
    expect(outcome.draft?.organic.verdict).toBe('unclear');
    expect(outcome.repairs.join(' ')).toContain('no signal on its side');
  });

  test('keeps rivals and drops malformed signals', () => {
    const outcome = validateReportDraft(
      draft({
        organic: {
          verdict: 'manufactured',
          outsideTraction: 140,
          signals: [
            { kind: 'sniped-launch', organic: false, detail: 'Most of supply bought in the first block.', date: '2024-08-01' },
            { kind: 'listing', detail: 'no organic flag' },
            { kind: 'rumour', organic: false, detail: 'Unknown kind.' },
          ],
          rivals: [{ name: 'First Neiro On Ethereum', chain: 'ethereum', note: 'Earlier deploy, community takeover.' }, { ticker: 'X' }],
          summary: 'Sniped twin of an organic token.',
        },
      }),
    );
    const organic = outcome.draft?.organic;
    expect(organic?.verdict).toBe('manufactured');
    expect(organic?.outsideTraction).toBe(100);
    expect(organic?.signals.map((s) => s.kind)).toEqual(['sniped-launch', 'other']);
    expect(organic?.rivals).toHaveLength(1);
    expect(outcome.repairs.join(' ')).toContain('dropped 1 malformed organic signal');
    expect(outcome.repairs.join(' ')).toContain('dropped 1 malformed rival');
  });

  test('the degraded report carries an unresolved organic read', () => {
    const report = buildDegradedReport({ tokenId: 't', memeName: 'm', model: 'x', promptVersion: 'v', reason: 'boom' });
    expect(report.organic).toMatchObject({ verdict: 'unclear', outsideTraction: 0 });
    expect(report.organic?.summary).toContain('boom');
  });
});
