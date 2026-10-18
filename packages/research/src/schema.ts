/**
 * Structured output is obtained with a forced tool call, not by asking for JSON
 * in prose — the API guarantees a JSON object for a tool input, and guarantees
 * nothing about prose that claims to be JSON.
 *
 * It does NOT guarantee the object means anything. So everything the model
 * returns is re-validated here against the same contract, and anything wrong is
 * either repaired (with the repair recorded and paid for in `confidence`) or
 * rejected outright. A malformed response degrades to a low-confidence report;
 * it never throws and never reaches the store as if it were sound.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolSpec } from './llm/types';
import type {
  Anchor,
  AnchorConfidence,
  EvidenceItem,
  EvidenceKind,
  LineageNode,
  OrganicRead,
  OrganicVerdict,
  PriorCycle,
  ProvenanceReport,
  RecycleVerdict,
  RivalInstance,
  TractionSignal,
  TractionSignalKind,
} from '@provenance/core';
import { clamp, nowIso, truncate } from '@provenance/core';
import { anchorSchema, parseAnchor, unresolvedAnchor } from './anchor';

export const PROVENANCE_TOOL_NAME = 'emit_provenance_report';

const RECYCLE_VERDICTS: readonly RecycleVerdict[] = [
  'original',
  'revival',
  'derivative',
  'copycat',
  'unclear',
];
const ORGANIC_VERDICTS: readonly OrganicVerdict[] = ['organic', 'manufactured', 'mixed', 'unclear'];
const SIGNAL_KINDS: readonly TractionSignalKind[] = [
  'listing',
  'notable-attention',
  'community-effort',
  'media',
  'anchor-acknowledgement',
  'sniped-launch',
  'insider-cluster',
  'paid-promotion',
  'fast-tracked-listing',
  'other',
];
const LINEAGE_KINDS: readonly LineageNode['kind'][] = ['origin', 'revival', 'derivative', 'platform-shift'];
const OUTCOMES: readonly NonNullable<PriorCycle['outcome']>[] = ['still-alive', 'faded', 'rugged', 'unknown'];
const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  'web',
  'wiki',
  'knowyourmeme',
  'reddit',
  'social',
  'news',
  'onchain',
  'model-knowledge',
];

/**
 * The model-authored half of `ProvenanceReport`. `tokenId`, `model`,
 * `promptVersion`, `generatedAt` and `usage` are bookkeeping the caller owns —
 * putting them in the schema would spend tokens inviting the model to invent
 * values we already hold. `anchor` is optional on stored reports only because
 * old ones predate it; every new draft carries one.
 */
export type ReportDraft = Omit<
  ProvenanceReport,
  'tokenId' | 'model' | 'promptVersion' | 'generatedAt' | 'usage' | 'anchor' | 'organic'
> & { anchor: Anchor; organic: OrganicRead };

/** JSON schema for the `organic` object. */
function organicSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'outsideTraction', 'signals', 'rivals', 'summary'],
    properties: {
      verdict: { type: 'string', enum: [...ORGANIC_VERDICTS] },
      outsideTraction: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Effort and attention from outside the launch. Paid or insider attention does not count.',
      },
      signals: {
        type: 'array',
        description: 'Each dated, sourced fact behind the verdict. organic=false for signs of manufacture.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'organic', 'detail'],
          properties: {
            kind: { type: 'string', enum: [...SIGNAL_KINDS] },
            organic: { type: 'boolean' },
            detail: { type: 'string' },
            date: { type: 'string' },
            url: { type: 'string' },
          },
        },
      },
      rivals: {
        type: 'array',
        description: 'Other tokens carrying the same meme. Empty array when there are none.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string' },
            ticker: { type: 'string' },
            chain: { type: 'string' },
            address: { type: 'string' },
            note: { type: 'string' },
          },
        },
      },
      summary: { type: 'string', description: 'One or two sentences: why, and against which rivals.' },
    },
  };
}

/** JSON schema mirroring ReportDraft field for field. */
export const PROVENANCE_TOOL_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'anchor',
    'organic',
    'memeName',
    'narrativeCluster',
    'originSummary',
    'lineage',
    'priorCycles',
    'recycleVerdict',
    'recycleGeneration',
    'memeticDurability',
    'culturalReach',
    'authenticityScore',
    'speculativeSetup',
    'risks',
    'confidence',
    'evidence',
  ],
  properties: {
    // First, because it is the headline and the model fills fields in order.
    // `precedesLaunch` is deliberately absent: code computes it.
    anchor: anchorSchema(),
    // Second: the anchor says the meme is real, this says the token is.
    organic: organicSchema(),
    memeName: {
      type: 'string',
      description: "Canonical name of the underlying meme, not the ticker. 'dogwifhat', not '$WIF'.",
    },
    narrativeCluster: {
      type: 'string',
      description:
        "Short lowercase family: dog, cat, frog, political, ai-agents, nostalgia, celebrity, food, abstract, unclassified.",
    },
    originYear: {
      type: 'integer',
      description:
        'Year the MEME entered culture. Omit entirely if the evidence only dates the token. Never the pool creation year.',
    },
    originSummary: {
      type: 'string',
      description:
        "Two to four sentences on where the meme came from, citing supplied evidence by [E#]. Say plainly if it could not be established.",
    },
    lineage: {
      type: 'array',
      description: 'Chronological steps from cultural origin to now.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'kind'],
        properties: {
          label: { type: 'string' },
          year: { type: 'integer' },
          kind: { type: 'string', enum: [...LINEAGE_KINDS] },
          note: { type: 'string' },
        },
      },
    },
    priorCycles: {
      type: 'array',
      description:
        'Earlier tokens or monetisations of this SAME meme. Empty array is a real answer; never invent an entry.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string' },
          ticker: { type: 'string' },
          chain: { type: 'string' },
          year: { type: 'integer' },
          peakMarketCapUsd: { type: 'number' },
          outcome: { type: 'string', enum: [...OUTCOMES] },
          note: { type: 'string' },
        },
      },
    },
    recycleVerdict: { type: 'string', enum: [...RECYCLE_VERDICTS] },
    recycleGeneration: {
      type: 'integer',
      minimum: 0,
      description: '0 = first tokenisation, 1 = first revival, 2 = revival of a revival. Must match priorCycles.',
    },
    memeticDurability: { type: 'integer', minimum: 0, maximum: 100 },
    culturalReach: { type: 'integer', minimum: 0, maximum: 100 },
    authenticityScore: { type: 'integer', minimum: 0, maximum: 100 },
    speculativeSetup: {
      type: 'string',
      description: 'Description of the structure. Never a recommendation; no prices, targets or advice.',
    },
    risks: { type: 'array', items: { type: 'string' } },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Calibrated belief in the lineage and verdict above. Thin evidence means a low number.',
    },
    evidence: {
      type: 'array',
      description:
        "Only items of kind 'model-knowledge' for claims drawn from your own recall. Supplied evidence is already recorded.",
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'title', 'snippet', 'sourceQuality'],
        properties: {
          kind: { type: 'string', enum: [...EVIDENCE_KINDS] },
          url: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: 'string' },
          publishedAt: { type: 'string' },
          sourceQuality: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

export function provenanceTool(cacheable = true): ToolSpec {
  return {
    name: PROVENANCE_TOOL_NAME,
    description:
      'Record the provenance analysis for one token, leading with the anchor verdict and then the organic read. Call exactly once. Every field is required unless marked optional; omit originYear and anchor dates rather than guessing them.',
    schema: PROVENANCE_TOOL_SCHEMA as unknown as Record<string, unknown>,
    // Anthropic renders tools before system and messages, so a cache
    // breakpoint here covers the whole static prefix.
    cacheable,
  };
}

export interface ValidationOutcome {
  /** True when the response validated with zero repairs. */
  ok: boolean;
  /** Null means rejected outright: the caller must build a degraded report. */
  draft: ReportDraft | null;
  /** Hard problems, including the reason for a rejection. */
  issues: string[];
  /** Fields that were coerced, clamped, defaulted or dropped. */
  repairs: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function intIn(value: unknown, min: number, max: number): number | undefined {
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(raw)) return undefined;
  return Math.round(clamp(raw, min, max));
}

/** Absolute bounds on a plausible meme origin year. */
const MIN_ORIGIN_YEAR = 1800;

function validateLineage(raw: unknown, repairs: string[]): LineageNode[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) repairs.push('lineage was not an array; dropped');
    return [];
  }
  const out: LineageNode[] = [];
  let dropped = 0;
  const maxYear = new Date().getUTCFullYear() + 1;
  for (const entry of raw) {
    if (!isRecord(entry)) {
      dropped++;
      continue;
    }
    const label = str(entry.label);
    if (label === undefined) {
      dropped++;
      continue;
    }
    const kindRaw = str(entry.kind);
    const kind = LINEAGE_KINDS.find((candidate) => candidate === kindRaw);
    if (kind === undefined) {
      // A step with an unrecognised kind is still a dated step; keep it as a
      // derivative rather than losing the date.
      repairs.push(`lineage step "${truncate(label, 40)}" had kind "${kindRaw ?? 'missing'}"; set to derivative`);
    }
    const year = intIn(entry.year, MIN_ORIGIN_YEAR, maxYear);
    const note = str(entry.note);
    const node: LineageNode = { label: truncate(label, 200), kind: kind ?? 'derivative' };
    if (year !== undefined) node.year = year;
    if (note !== undefined) node.note = truncate(note, 400);
    out.push(node);
  }
  if (dropped > 0) repairs.push(`dropped ${dropped} malformed lineage step(s)`);
  return out;
}

function validatePriorCycles(raw: unknown, repairs: string[]): PriorCycle[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) repairs.push('priorCycles was not an array; dropped');
    return [];
  }
  const out: PriorCycle[] = [];
  let dropped = 0;
  const maxYear = new Date().getUTCFullYear() + 1;
  for (const entry of raw) {
    if (!isRecord(entry)) {
      dropped++;
      continue;
    }
    const name = str(entry.name);
    if (name === undefined) {
      dropped++;
      continue;
    }
    const cycle: PriorCycle = { name: truncate(name, 160) };
    const ticker = str(entry.ticker);
    const chain = str(entry.chain);
    const note = str(entry.note);
    const year = intIn(entry.year, MIN_ORIGIN_YEAR, maxYear);
    const outcomeRaw = str(entry.outcome);
    const outcome = OUTCOMES.find((candidate) => candidate === outcomeRaw);
    const peak = typeof entry.peakMarketCapUsd === 'number' && Number.isFinite(entry.peakMarketCapUsd)
      ? Math.max(0, entry.peakMarketCapUsd)
      : undefined;
    if (ticker !== undefined) cycle.ticker = truncate(ticker, 32);
    if (chain !== undefined) cycle.chain = truncate(chain, 32);
    if (year !== undefined) cycle.year = year;
    if (peak !== undefined) cycle.peakMarketCapUsd = peak;
    if (outcomeRaw !== undefined && outcome === undefined) {
      repairs.push(`prior cycle "${truncate(name, 40)}" had outcome "${outcomeRaw}"; set to unknown`);
    }
    cycle.outcome = outcome ?? 'unknown';
    if (note !== undefined) cycle.note = truncate(note, 400);
    out.push(cycle);
  }
  if (dropped > 0) repairs.push(`dropped ${dropped} malformed prior cycle(s)`);
  return out;
}

function validateEvidence(raw: unknown, repairs: string[], retrievedAt: string): EvidenceItem[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) repairs.push('evidence was not an array; dropped');
    return [];
  }
  const out: EvidenceItem[] = [];
  let dropped = 0;
  for (const entry of raw) {
    if (!isRecord(entry)) {
      dropped++;
      continue;
    }
    const title = str(entry.title);
    const snippet = str(entry.snippet);
    if (title === undefined || snippet === undefined) {
      dropped++;
      continue;
    }
    const kindRaw = str(entry.kind);
    const kind = EVIDENCE_KINDS.find((candidate) => candidate === kindRaw);
    const qualityRaw = typeof entry.sourceQuality === 'number' ? entry.sourceQuality : Number.NaN;
    const url = str(entry.url);
    const publishedAt = str(entry.publishedAt);

    const item: EvidenceItem = {
      // An unrecognised kind from the model is, by definition, the model
      // talking — which is exactly what model-knowledge means.
      kind: kind ?? 'model-knowledge',
      title: truncate(title, 200),
      snippet: truncate(snippet, 1_400),
      retrievedAt,
      sourceQuality: Number.isFinite(qualityRaw) ? Number(clamp(qualityRaw, 0, 1).toFixed(3)) : 0.25,
    };
    if (!Number.isFinite(qualityRaw)) repairs.push(`evidence "${truncate(title, 40)}" had no numeric sourceQuality`);
    if (url !== undefined) item.url = url;
    if (publishedAt !== undefined) item.publishedAt = publishedAt;
    out.push(item);
  }
  if (dropped > 0) repairs.push(`dropped ${dropped} malformed evidence item(s)`);
  return out;
}

function validateSignals(raw: unknown, repairs: string[]): TractionSignal[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) repairs.push('organic.signals was not an array; dropped');
    return [];
  }
  const out: TractionSignal[] = [];
  let dropped = 0;
  for (const entry of raw) {
    const detail = isRecord(entry) ? str(entry.detail) : undefined;
    if (!isRecord(entry) || detail === undefined || typeof entry.organic !== 'boolean') {
      dropped++;
      continue;
    }
    const kindRaw = str(entry.kind);
    const kind = SIGNAL_KINDS.find((candidate) => candidate === kindRaw);
    if (kind === undefined) repairs.push(`signal "${truncate(detail, 40)}" had kind "${kindRaw ?? 'missing'}"; set to other`);
    const signal: TractionSignal = { kind: kind ?? 'other', organic: entry.organic, detail: truncate(detail, 400) };
    const date = str(entry.date);
    const url = str(entry.url);
    if (date !== undefined) signal.date = truncate(date, 32);
    if (url !== undefined) signal.url = url;
    out.push(signal);
  }
  if (dropped > 0) repairs.push(`dropped ${dropped} malformed organic signal(s)`);
  return out;
}

function validateRivals(raw: unknown, repairs: string[]): RivalInstance[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) repairs.push('organic.rivals was not an array; dropped');
    return [];
  }
  const out: RivalInstance[] = [];
  let dropped = 0;
  for (const entry of raw) {
    const name = isRecord(entry) ? str(entry.name) : undefined;
    if (!isRecord(entry) || name === undefined) {
      dropped++;
      continue;
    }
    const rival: RivalInstance = { name: truncate(name, 160) };
    for (const key of ['ticker', 'chain', 'address'] as const) {
      const value = str(entry[key]);
      if (value !== undefined) rival[key] = truncate(value, 64);
    }
    const note = str(entry.note);
    if (note !== undefined) rival.note = truncate(note, 400);
    out.push(rival);
  }
  if (dropped > 0) repairs.push(`dropped ${dropped} malformed rival(s)`);
  return out;
}

/** An organic read that says nothing: what a missing or failed one becomes. */
export function unresolvedOrganic(summary: string): OrganicRead {
  return { verdict: 'unclear', outsideTraction: 0, signals: [], rivals: [], summary };
}

/**
 * The organic block. Like the anchor, never rejects the report. A verdict
 * with no signal on its side is a guess, so it falls back to `unclear`:
 * "organic" with nothing organic behind it is exactly the confident blank
 * the prompt forbids.
 */
function validateOrganic(raw: unknown, repairs: string[]): OrganicRead {
  if (!isRecord(raw)) {
    repairs.push('organic missing; set to unclear');
    return unresolvedOrganic('The model returned no organic read.');
  }
  const verdictRaw = str(raw.verdict);
  let verdict = ORGANIC_VERDICTS.find((candidate) => candidate === verdictRaw);
  if (verdict === undefined) repairs.push(`organic verdict "${verdictRaw ?? 'missing'}" not recognised; set to unclear`);

  const traction = intIn(raw.outsideTraction, 0, 100);
  if (traction === undefined) repairs.push('organic.outsideTraction missing or not a number; set to 0');

  const signals = validateSignals(raw.signals, repairs);
  const rivals = validateRivals(raw.rivals, repairs);

  const backing =
    verdict === 'organic' ? signals.some((s) => s.organic)
    : verdict === 'manufactured' ? signals.some((s) => !s.organic)
    : true;
  if (!backing) {
    repairs.push(`organic verdict ${verdict} with no signal on its side; set to unclear`);
    verdict = 'unclear';
  }

  return {
    verdict: verdict ?? 'unclear',
    outsideTraction: traction ?? 0,
    signals,
    rivals,
    summary: truncate(str(raw.summary) ?? 'No organic summary was returned.', 600),
  };
}

const CONFIDENCE_STEPS: readonly AnchorConfidence[] = ['high', 'medium', 'low'];

function lowerOneStep(confidence: AnchorConfidence): AnchorConfidence {
  return CONFIDENCE_STEPS[Math.min(CONFIDENCE_STEPS.indexOf(confidence) + 1, CONFIDENCE_STEPS.length - 1)] ?? 'low';
}

/**
 * The anchor block. Never rejects the report: a lineage worth keeping should
 * not be thrown away because the headline was malformed, so a missing or
 * out-of-contract anchor degrades to `unclear` and is recorded as a repair.
 */
function validateAnchor(raw: unknown, repairs: string[]): Anchor {
  if (!isRecord(raw)) {
    repairs.push('anchor missing; set to unclear');
    return unresolvedAnchor('The model returned no anchor verdict.');
  }
  const anchor = parseAnchor(raw);
  const coerced = (['verdict', 'type', 'confidence'] as const).filter((key) => raw[key] !== anchor[key]);
  if (coerced.length > 0) repairs.push(`anchor ${coerced.join(', ')} out of contract; coerced`);
  return anchor;
}

/**
 * Confidence after repairs. Deliberately aggressive: a report that needed
 * patching is a report whose author was not paying attention, and the composite
 * score downstream weights confidence.
 */
export function degradeConfidence(raw: number | undefined, repairCount: number): number {
  const base = raw !== undefined && Number.isFinite(raw) ? clamp(raw, 0, 1) : 0.2;
  if (repairCount === 0) return Number(base.toFixed(3));
  // Any repair caps confidence at 0.45, then each one costs a further 0.05.
  const capped = Math.min(base, 0.45) - 0.05 * repairCount;
  return Number(clamp(capped, 0.05, 1).toFixed(3));
}

/**
 * Validate a tool-use input against the report contract.
 *
 * Rejects (draft === null) only for the two failures that leave nothing to
 * build on: a non-object response, and a missing meme name. Everything else is
 * repaired, because a report that names the meme and dates it is still useful
 * with a mangled `risks` array.
 */
export function validateReportDraft(raw: unknown, now: string = nowIso()): ValidationOutcome {
  const issues: string[] = [];
  const repairs: string[] = [];

  if (!isRecord(raw)) {
    issues.push(`tool input was ${Array.isArray(raw) ? 'an array' : typeof raw}, expected an object`);
    return { ok: false, draft: null, issues, repairs };
  }

  const memeName = str(raw.memeName);
  if (memeName === undefined) {
    issues.push('memeName missing or empty — nothing identifies the subject of the report');
    return { ok: false, draft: null, issues, repairs };
  }

  const narrativeCluster = str(raw.narrativeCluster);
  if (narrativeCluster === undefined) repairs.push('narrativeCluster missing; set to unclassified');

  const originSummary = str(raw.originSummary);
  if (originSummary === undefined) repairs.push('originSummary missing; replaced with an explicit blank');

  const maxYear = new Date().getUTCFullYear() + 1;
  let originYear: number | undefined;
  if (raw.originYear !== undefined && raw.originYear !== null) {
    originYear = intIn(raw.originYear, MIN_ORIGIN_YEAR, maxYear);
    const asNumber = typeof raw.originYear === 'number' ? raw.originYear : Number(raw.originYear);
    if (originYear === undefined) {
      repairs.push(`originYear "${String(raw.originYear)}" was not a year; dropped`);
    } else if (Number.isFinite(asNumber) && (asNumber < MIN_ORIGIN_YEAR || asNumber > maxYear)) {
      repairs.push(`originYear ${asNumber} out of range; clamped to ${originYear}`);
    }
  }

  const verdictRaw = str(raw.recycleVerdict);
  const verdict = RECYCLE_VERDICTS.find((candidate) => candidate === verdictRaw);
  if (verdict === undefined) {
    repairs.push(`recycleVerdict "${verdictRaw ?? 'missing'}" not recognised; set to unclear`);
  }

  const generation = intIn(raw.recycleGeneration, 0, 20);
  if (generation === undefined) repairs.push('recycleGeneration missing or not a number; set to 0');
  else if (typeof raw.recycleGeneration === 'number' && (raw.recycleGeneration < 0 || raw.recycleGeneration > 20)) {
    repairs.push(`recycleGeneration ${raw.recycleGeneration} out of range; clamped to ${generation}`);
  }

  // Missing 0-100 scores default to 0, not to a midpoint: the composite score
  // downstream treats high as attractive, so failing to 0 fails safe.
  const score = (key: 'memeticDurability' | 'culturalReach' | 'authenticityScore'): number => {
    const value = intIn(raw[key], 0, 100);
    if (value === undefined) {
      repairs.push(`${key} missing or not a number; set to 0`);
      return 0;
    }
    const asNumber = typeof raw[key] === 'number' ? (raw[key] as number) : Number(raw[key]);
    if (Number.isFinite(asNumber) && (asNumber < 0 || asNumber > 100)) {
      repairs.push(`${key} ${asNumber} out of range 0-100; clamped to ${value}`);
    }
    return value;
  };

  const memeticDurability = score('memeticDurability');
  const culturalReach = score('culturalReach');
  const authenticityScore = score('authenticityScore');

  const speculativeSetup = str(raw.speculativeSetup);
  if (speculativeSetup === undefined) repairs.push('speculativeSetup missing; replaced with an explicit blank');

  let risks: string[] = [];
  if (Array.isArray(raw.risks)) {
    risks = raw.risks.map((risk) => str(risk)).filter((risk): risk is string => risk !== undefined);
    if (risks.length !== raw.risks.length) repairs.push('dropped non-string entries from risks');
  } else if (raw.risks !== undefined) {
    repairs.push('risks was not an array; dropped');
  }

  const lineage = validateLineage(raw.lineage, repairs);
  const priorCycles = validatePriorCycles(raw.priorCycles, repairs);
  const evidence = validateEvidence(raw.evidence, repairs, now);

  // Internal consistency: the generation claim must match the enumerated prior
  // cycles, because downstream scoring trusts the number over the array.
  if (priorCycles.length > 0 && (generation ?? 0) === 0) {
    repairs.push(
      `recycleGeneration 0 contradicts ${priorCycles.length} prior cycle(s); raised to ${priorCycles.length}`,
    );
  }
  const resolvedGeneration = Math.max(generation ?? 0, priorCycles.length > 0 ? priorCycles.length : 0);

  // An anchor with nothing under it: the model says the meme has a history,
  // yet traced none and could not place it in the recycling chain. Possible
  // for an inciting event, so it is kept — but believed one step less.
  const anchor = validateAnchor(raw.anchor, repairs);
  const organic = validateOrganic(raw.organic, repairs);
  const verdictResolved = verdict ?? 'unclear';
  if (
    anchor.verdict === 'anchored' &&
    verdictResolved === 'unclear' &&
    lineage.length === 0 &&
    priorCycles.length === 0
  ) {
    const lowered = lowerOneStep(anchor.confidence);
    repairs.push(
      `anchored with no lineage, no prior cycles and recycleVerdict unclear; anchor confidence ${anchor.confidence} -> ${lowered}`,
    );
    anchor.confidence = lowered;
  }

  const rawConfidence = typeof raw.confidence === 'number' ? raw.confidence : undefined;
  if (rawConfidence === undefined) repairs.push('confidence missing or not a number; defaulted low');
  else if (rawConfidence < 0 || rawConfidence > 1) {
    repairs.push(`confidence ${rawConfidence} out of range 0-1; clamped`);
  }

  const draft: ReportDraft = {
    anchor,
    organic,
    memeName: truncate(memeName, 160),
    narrativeCluster: truncate(narrativeCluster ?? 'unclassified', 64),
    originSummary: originSummary ?? 'The model returned no origin summary; the meme could not be dated here.',
    lineage,
    priorCycles,
    recycleVerdict: verdictResolved,
    recycleGeneration: resolvedGeneration,
    memeticDurability,
    culturalReach,
    authenticityScore,
    speculativeSetup:
      speculativeSetup ?? 'No structural description was returned. Not a recommendation either way.',
    risks,
    confidence: degradeConfidence(rawConfidence, repairs.length),
    evidence,
  };
  if (originYear !== undefined) draft.originYear = originYear;

  return { ok: repairs.length === 0 && issues.length === 0, draft, issues, repairs };
}

/**
 * The floor of the system: a syntactically valid, honestly empty report used
 * when the model response is unusable, the API call failed, or the run is out of
 * budget. Confidence is near zero and the reason is in `risks`, so nothing
 * downstream can mistake it for an analysis.
 */
export function buildDegradedReport(params: {
  tokenId: string;
  memeName: string;
  model: string;
  promptVersion: string;
  reason: string;
  /** The error behind it, when a call failed rather than finding nothing. */
  failed?: string;
  evidence?: readonly EvidenceItem[];
  generatedAt?: string;
}): ProvenanceReport {
  return {
    tokenId: params.tokenId,
    anchor: unresolvedAnchor(`Anchor not established: ${params.reason}`, params.failed),
    organic: unresolvedOrganic(`Organic read not established: ${params.reason}`),
    memeName: params.memeName,
    narrativeCluster: 'unclassified',
    originSummary: `Provenance could not be established: ${params.reason}. No lineage is claimed here; treat this token as unresearched rather than as researched-and-clean.`,
    lineage: [],
    priorCycles: [],
    recycleVerdict: 'unclear',
    recycleGeneration: 0,
    memeticDurability: 0,
    culturalReach: 0,
    authenticityScore: 0,
    speculativeSetup:
      'No structural read is available for this token. This is a description of missing data, not a recommendation.',
    risks: [`Provenance analysis failed: ${params.reason}.`, 'Every score in this report is a placeholder, not a judgement.'],
    confidence: 0,
    evidence: [...(params.evidence ?? [])],
    model: params.model,
    promptVersion: params.promptVersion,
    generatedAt: params.generatedAt ?? nowIso(),
  };
}
