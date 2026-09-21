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
import type {
  EvidenceItem,
  EvidenceKind,
  LineageNode,
  PriorCycle,
  ProvenanceReport,
  RecycleVerdict,
} from '@provenance/core';
import { clamp, nowIso, truncate } from '@provenance/core';

export const PROVENANCE_TOOL_NAME = 'emit_provenance_report';

const RECYCLE_VERDICTS: readonly RecycleVerdict[] = [
  'original',
  'revival',
  'derivative',
  'copycat',
  'unclear',
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
 * values we already hold.
 */
export type ReportDraft = Omit<
  ProvenanceReport,
  'tokenId' | 'model' | 'promptVersion' | 'generatedAt' | 'usage'
>;

/** JSON schema mirroring ReportDraft field for field. */
export const PROVENANCE_TOOL_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
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

export function provenanceTool(cacheable = true): Anthropic.Tool {
  const tool: Anthropic.Tool = {
    name: PROVENANCE_TOOL_NAME,
    description:
      'Record the provenance analysis for one token. Call exactly once. Every field is required unless marked optional; omit originYear rather than guessing it.',
    input_schema: PROVENANCE_TOOL_SCHEMA,
  };
  // Tools render before system and messages, so a cache breakpoint here covers
  // the whole static prefix.
  if (cacheable) tool.cache_control = { type: 'ephemeral' };
  return tool;
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

  const rawConfidence = typeof raw.confidence === 'number' ? raw.confidence : undefined;
  if (rawConfidence === undefined) repairs.push('confidence missing or not a number; defaulted low');
  else if (rawConfidence < 0 || rawConfidence > 1) {
    repairs.push(`confidence ${rawConfidence} out of range 0-1; clamped`);
  }

  const draft: ReportDraft = {
    memeName: truncate(memeName, 160),
    narrativeCluster: truncate(narrativeCluster ?? 'unclassified', 64),
    originSummary: originSummary ?? 'The model returned no origin summary; the meme could not be dated here.',
    lineage,
    priorCycles,
    recycleVerdict: verdict ?? 'unclear',
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
  evidence?: readonly EvidenceItem[];
  generatedAt?: string;
}): ProvenanceReport {
  return {
    tokenId: params.tokenId,
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
