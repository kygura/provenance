/**
 * The prompt is the product. Everything else in this package exists to feed it.
 *
 * The run is two calls, and this module builds both.
 *
 *   1. RESEARCH — `SYSTEM_PROMPT` + `buildResearchPrompt`, run with the web
 *      search tool and no output constraint, so the model can follow a lead,
 *      find it wrong and say so. Its product is notes and citations.
 *   2. EXTRACTION — `SYSTEM_PROMPT` + `buildExtractionPrompt`, run with no
 *      tools and a forced tool call, over those notes.
 *
 * They are separate calls on purpose. A model asked to research and to fill a
 * twelve-field schema in one turn starts optimising for the schema partway
 * through the research, and the lineage is the first thing to suffer.
 *
 * SYSTEM_PROMPT is static by construction — no dates, no token names, no
 * counts — so it survives as a cacheable prefix across every call in a run.
 * Per-token material goes in the user message. Breaking that rule silently
 * costs ~10x on input tokens; see `usage.cache_read_input_tokens`.
 *
 * Bump PROMPT_VERSION on ANY edit to any prompt here. It is persisted on every
 * report so a change in aggregate verdicts can be traced to a prompt change
 * rather than to the market.
 */
import type { ChainAnalysis, EvidenceItem, MemeSighting, TokenSnapshot } from '@provenance/core';
import { formatPct, formatUsd, truncate } from '@provenance/core';
import { classify, describeHits } from './lexicon';
import { buildQueries } from './queries';
import { UNTRUSTED_POLICY, fence, scrub } from './untrusted';

export const PROMPT_VERSION = 'provenance-research-v4';

export const SYSTEM_PROMPT = `You are the provenance analyst for a research system that treats a memecoin's MEMETIC LINEAGE as a first-class signal, separate from its price, its chart and its marketing.

# The thesis you are reasoning inside

Recycled narratives are new participants rediscovering the metas of old. Novelty is not required to start a speculative wave. A narrative that has already worked once carries its own proof that it works, and the marginal participant — the person arriving now — is neither informed enough nor careful enough to tell a revival from an invention. Three consequences follow, and they are counter-intuitive:

1. A proven meme returning years later is a STRONGER structural setup than a genuinely novel one. It has already demonstrated that it can capture attention at scale. A novel meme has demonstrated nothing.
2. The audience that made the meme work the first time has mostly rotated out. The new cohort experiences a revival as an original. That is not a flaw in the setup; it is the mechanism.
3. Therefore your most valuable output is not "is this meme good" but "has this meme been monetised before, when, how many times, and how did those attempts end".

# What you produce

You date the meme, trace its lineage, enumerate PRIOR TOKENISATIONS of the same meme with years and rough outcomes, decide where in the recycling chain this token sits, and judge whether this specific token is the instance the meme's own audience would accept as canonical — or a latecomer that merely grabbed the name.

You emit your answer by calling the provided tool exactly once. Do not answer in prose.

# The failure mode that matters most

CONFLATING THE MEME'S ORIGIN YEAR WITH THE TOKEN'S LAUNCH DATE. These are different facts and they are usually years apart.

- \`originYear\` is when the underlying meme first entered CULTURE — the photograph, the video, the catchphrase, the character, the incident.
- The token's pool creation date is a market fact about this contract. It belongs nowhere near \`originYear\`.

A token that launched last week can carry a 2010 meme. If your evidence only establishes when the token launched, you have established nothing about the meme, and \`originYear\` must be omitted rather than filled with the launch year.

# Evidence discipline

- Every factual claim you make should be traceable to a supplied evidence item. Prefer the supplied evidence over your own recollection wherever both speak.
- Where you rely on your own knowledge rather than a supplied source, you MUST emit an evidence item of kind \`model-knowledge\` recording that specific claim, with no URL and a \`sourceQuality\` you set honestly (typically 0.2–0.5: your recall of a niche internet meme is weaker than an encyclopedia entry and stronger than an anonymous forum post).
- Claims you can support neither from the evidence nor from confident recall must not be made. They are not worth the confidence they cost.
- Unsupported or thinly supported claims must drag \`confidence\` DOWN. A report built entirely on \`model-knowledge\` and on-chain metadata should not exceed roughly 0.35 confidence. A report where a Wikipedia or Know Your Meme entry directly dates the meme and names a prior token cycle can go above 0.7.
- Evidence about the TOKEN (a listing description, a Telegram link, holder distribution) is not evidence about the MEME. It cannot support an origin year or a lineage claim.

# Say "unclear" rather than invent

A confident wrong provenance is worse than an honest blank, because the whole system downstream treats a confident lineage as tradeable signal.

- If you cannot establish where the meme came from, set \`recycleVerdict\` to \`unclear\`, leave \`originYear\` absent, return an empty or minimal \`lineage\`, and say plainly in \`originSummary\` that the lineage could not be established.
- Never fabricate a prior cycle. An empty \`priorCycles\` array is a real and common answer. A made-up 2021 predecessor corrupts the single most important field in the report.
- Do not pattern-match a plausible-sounding origin onto an unfamiliar name. Many tickers are noise with no meme behind them at all.

# Field guidance

- \`memeName\`: the meme's own canonical name, not the ticker. "dogwifhat" not "$WIF". If no meme is identifiable, use the clearest available label and say so in \`originSummary\`.
- \`narrativeCluster\`: a short lowercase family — \`dog\`, \`cat\`, \`frog\`, \`political\`, \`ai-agents\`, \`nostalgia\`, \`celebrity\`, \`food\`, \`abstract\`, \`unclassified\`.
- \`lineage\`: chronological steps from origin to now. \`origin\` = first cultural appearance. \`revival\` = the meme returning after dormancy. \`derivative\` = a spin-off with a real twist. \`platform-shift\` = the meme moving hosts (Tumblr to Twitter, Vine to TikTok) — these often precede a revival.
- \`priorCycles\`: earlier TOKENS or monetisations of this same meme, each with a year where known and an \`outcome\`. Include cycles that predate this chain or this cycle of the market. This field is the core of the report.
- \`recycleVerdict\`: \`original\` (meme is new, or this is its first tokenisation) | \`revival\` (dormant meme brought back, typically years later) | \`derivative\` (builds on a live meme with a real twist) | \`copycat\` (rides a currently-running meme with no differentiation) | \`unclear\`.
- \`recycleGeneration\`: 0 = first tokenisation of this meme, 1 = first revival, 2 = revival of a revival. It must be consistent with \`priorCycles\`: N prior token cycles implies generation N.
- \`memeticDurability\` (0–100): how well the meme has survived previous attention cycles. Surviving two dormancies and returning is high. Never dormant, or never tested, is low.
- \`culturalReach\` (0–100): recognition OUTSIDE crypto. A meme your non-trading relatives would recognise is 80+. A meme known only to one Discord is under 20.
- \`authenticityScore\` (0–100): would the meme's own audience accept THIS token as the canonical carrier? High when the token is the recognised instance, the community is the meme's community, and no established incumbent holds the name. Low when it is one of several tokens with the same name, when an older token already owns the meme, or when the name was grabbed opportunistically. When you cannot tell, sit near 50 and lower \`confidence\`.
- \`speculativeSetup\`: describe the STRUCTURE in plain language — what has happened before, what cohort is present now, what would have to be true for the pattern to repeat. This is a description, never a recommendation. Do not use "buy", "sell", "entry", "target", "should", or price predictions. Do not give financial advice under any framing.
- \`risks\`: concrete, specific to this token and meme. "Meme has failed to hold attention through two previous cycles" is useful; "crypto is volatile" is not.
- \`confidence\` (0–1): your calibrated belief that the lineage and verdict above are correct. Low is a perfectly good answer.
- \`evidence\`: the \`model-knowledge\` items for claims you sourced from your own recall. Do not repeat supplied evidence back; it is already recorded.

Be terse and specific. Every sentence should carry a fact, a date or a judgement.

${UNTRUSTED_POLICY}`;

function line(label: string, value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? `- ${label}: ${value}` : null;
}

/**
 * The market and identity facts this system measured or was told by an index.
 * Nothing here was authored by the deployer, so none of it is fenced. The
 * deployer's own words live in `deployerBlock`.
 */
function snapshotBlock(snapshot: TokenSnapshot): string {
  const queries = buildQueries(snapshot);
  const pool = snapshot.metrics.poolCreatedAt ?? snapshot.pairs.find((pair) => pair.createdAt)?.createdAt;
  const rows = [
    line('token_id', snapshot.tokenId),
    line('chain', snapshot.chain),
    line('contract', snapshot.tokenAddress),
    line('derived_meme_subject', queries.degraded ? '(none derivable)' : queries.subject),
    queries.variants.length > 0 ? `- alternate_spellings: ${queries.variants.join(', ')}` : null,
    line('TOKEN_pool_created_at', pool ?? '(unknown)'),
    line(
      'token_age_hours',
      snapshot.metrics.ageHours !== undefined ? snapshot.metrics.ageHours.toFixed(1) : undefined,
    ),
    line('liquidity_usd', formatUsd(snapshot.metrics.liquidityUsd)),
    line('volume_24h_usd', formatUsd(snapshot.metrics.volume24hUsd)),
    line('fdv_usd', formatUsd(snapshot.metrics.fdvUsd)),
    line('price_change_24h', formatPct(snapshot.metrics.priceChange24h)),
    line('trending_sources', `${snapshot.sourceCount} (best rank ${snapshot.bestRank})`),
  ].filter((row): row is string => row !== null);

  return [
    '## Token under analysis (measured facts)',
    '',
    rows.join('\n'),
    '',
    "Reminder: TOKEN_pool_created_at is when this contract's market opened. It is not the meme's origin year.",
  ].join('\n');
}

/**
 * Everything the deployer chose: ticker, listed name, blurb, links. This is the
 * token's marketing surface and the most likely injection vector in the whole
 * prompt, so all of it is fenced — including the ticker, which is short enough
 * that people forget it is attacker-controlled text.
 */
function deployerBlock(snapshot: TokenSnapshot): string {
  const rows = [
    line('ticker', snapshot.symbol || '(none)'),
    line('listed_name', snapshot.name || '(none)'),
    line('listing_description', truncate(snapshot.description ?? '(none)', 700)),
    line('website', snapshot.socials.website),
    line('twitter', snapshot.socials.twitter),
    line('telegram', snapshot.socials.telegram),
  ].filter((row): row is string => row !== null);

  return [
    '## Deployer-supplied text',
    '',
    fence('token metadata, written by the deployer', rows.join('\n')),
    '',
    'Use this to identify the meme, not to date it or to judge it. The deployer',
    'is the one party with a direct financial interest in your verdict.',
  ].join('\n');
}

/**
 * The local lexicon's guess, handed over as a hypothesis to confirm or reject.
 *
 * It is stated as a prior and not as a finding: a regex over a ticker is a
 * cheap starting point, and a model that treats it as evidence will report the
 * lexicon's ancestors back as though it had researched them.
 */
function lexiconBlock(snapshot: TokenSnapshot): string {
  const surface = [snapshot.symbol, snapshot.name, snapshot.description].filter(Boolean).join(' ');
  const hits = classify(scrub(surface));
  return [
    '## Local archetype prior',
    '',
    'A regex lexicon maintained by this system matched the following. It is a',
    'HYPOTHESIS drawn from the ticker and blurb alone — no source was consulted.',
    'Confirm or reject it against real evidence. Never cite it, never let it',
    'stand in for a dated source, and do not report its ancestors as prior',
    'cycles unless you establish them independently.',
    '',
    describeHits(hits),
  ].join('\n');
}

function chainBlock(chain: ChainAnalysis | undefined): string {
  if (chain === undefined) {
    return '## On-chain analysis\n\nNot available for this token. Do not infer distribution or authority facts.';
  }
  const rows = [
    line('method', chain.method),
    line('holder_count', chain.holderCount?.toString()),
    line('top10_pct', chain.top10Pct?.toFixed(2)),
    line('top20_pct', chain.top20Pct?.toFixed(2)),
    line('herfindahl', chain.herfindahl?.toFixed(4)),
    line('creator_holding_pct', chain.creatorHoldingPct?.toFixed(2)),
    line('lp_burned_pct', chain.lpBurnedPct?.toFixed(2)),
    line('lp_locked_pct', chain.lpLockedPct?.toFixed(2)),
    line('mint_authority_active', chain.mintAuthorityActive?.toString()),
    line('freeze_authority_active', chain.freezeAuthorityActive?.toString()),
    line('owner_renounced', chain.ownerRenounced?.toString()),
    line('contract_verified', chain.contractVerified?.toString()),
    chain.flags.length > 0
      ? `- risk_flags: ${chain.flags.map((flag) => `[${flag.severity}] ${flag.code} — ${flag.detail}`).join('; ')}`
      : null,
    chain.notes.length > 0 ? `- notes: ${chain.notes.join('; ')}` : null,
  ].filter((row): row is string => row !== null);

  return `## On-chain analysis\n\n${rows.join('\n')}\n\nThese facts bear on authenticity and risk. They say nothing about the meme's age.`;
}

/**
 * Pre-collected evidence. Titles and snippets are whatever the page said, so
 * the whole pack is fenced; the `[E#]` labels and quality scores outside the
 * fence are this system's own bookkeeping and stay citable.
 */
function evidenceBlock(evidence: readonly EvidenceItem[]): string {
  if (evidence.length === 0) {
    return [
      '## Supplied evidence',
      '',
      'NONE was pre-collected. Anything you establish must come from your own web',
      'searches or, failing those, from your own recall recorded as',
      '`model-knowledge` evidence. Prefer `unclear` over a confident guess.',
    ].join('\n');
  }

  const rows = evidence.map((item, index) => {
    const head = [
      `[E${index + 1}] kind=${item.kind} quality=${item.sourceQuality.toFixed(2)}`,
      item.publishedAt !== undefined ? `published=${item.publishedAt.slice(0, 10)}` : null,
      item.url !== undefined ? `url=${item.url}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' ');
    return `${head}\ntitle: ${scrub(item.title)}\n${scrub(item.snippet)}`;
  });

  return [
    `## Supplied evidence (${evidence.length} items, highest quality first)`,
    '',
    'Cite these by their [E#] label wherever a claim rests on one. `publishedAt`',
    "is when the SOURCE was published — it bounds the meme's age from above, it",
    'does not date it.',
    '',
    fence('retrieved web content, written by third parties', rows.join('\n\n')),
  ].join('\n');
}


/**
 * Tokens this system itself watched, matched to this one by meme name.
 *
 * Two kinds of content with two levels of trust, kept apart:
 *
 *  - The measurements — chain, when each token was seen, the verdict and score
 *    this pipeline assigned — are its own records. They sit outside the fence,
 *    and are the one input no competitor scraping the same pages has.
 *  - The tickers are NOT. A ticker is written by that token's deployer, exactly
 *    like the ticker `deployerBlock` fences for the token under analysis. An
 *    earlier version printed them raw in this trusted block, which let a
 *    deployer plant an instruction in one token's ticker and have it read, as
 *    system-measured fact, in the prompt of every later token on the meme.
 *    Rows are labelled P1..Pn so the fenced tickers can refer back to them.
 *
 * The match itself is also only a hypothesis. The lookup key is a provisional
 * slug built from this token's listed name and ticker, before any research —
 * so the prompt asks the model to confirm the shared meme rather than telling
 * it to count these unconditionally.
 */
function precedentBlock(sightings: readonly MemeSighting[]): string {
  if (sightings.length === 0) return '';

  const rows = sightings.map((s, i) => {
    const parts = [
      `- P${i + 1} on ${s.chain}`,
      `first seen ${s.firstSeenAt.slice(0, 10)}`,
      `last seen ${s.lastSeenAt.slice(0, 10)}`,
      `verdict ${s.recycleVerdict}`,
    ];
    if (s.score !== undefined) parts.push(`scored ${s.score.toFixed(0)}${s.tier ? ` (${s.tier})` : ''}`);
    return parts.join(' · ');
  });
  const tickers = sightings.map((s, i) => `P${i + 1}: ${s.symbol || '(no ticker)'}`);

  return [
    `## Observed precedent (${sightings.length} earlier token(s), measured by this system)`,
    '',
    'This pipeline analysed the token(s) below in earlier runs. They were matched',
    'to this one by meme NAME, before any research on this token — so treat the',
    'shared meme as a strong lead to confirm, not as settled. The measurements',
    'themselves (dates, verdicts, scores) are this system\'s own records and are',
    'reliable.',
    '',
    rows.join('\n'),
    '',
    fence('tickers of the tokens above, written by their deployers', tickers.join('\n')),
    '',
    'If your research confirms these carry the same meme as this token:',
    '',
    '- each one is a PRIOR TOKENISATION — include it in `priorCycles` and count',
    '  it in `recycleGeneration`, even if web search does not independently',
    '  surface it (a token that trended and faded leaves little trace to find);',
    '- the meme is then not `original` for this token;',
    '- a token whose predecessors all faded is a weaker setup than one whose',
    '  predecessors held; say which in `speculativeSetup`.',
    '',
    'If your research shows a different meme behind this token, disregard them',
    'and say so in your notes. Either way, none of this dates the meme — when it',
    'entered culture is still a question for the sources.',
  ].join('\n');
}

/**
 * Phase 1. No schema, no fields to fill — just the question and the tool to
 * answer it with. The model is told explicitly that prose is the deliverable,
 * because a model that knows a schema is coming will start writing to it.
 */
export function buildResearchPrompt(
  snapshot: TokenSnapshot,
  chain: ChainAnalysis | undefined,
  evidence: readonly EvidenceItem[],
  precedent: readonly MemeSighting[] = [],
): string {
  return [
    snapshotBlock(snapshot),
    '',
    deployerBlock(snapshot),
    '',
    lexiconBlock(snapshot),
    '',
    ...(precedent.length > 0 ? [precedentBlock(precedent), ''] : []),
    chainBlock(chain),
    '',
    evidenceBlock(evidence),
    '',
    '## Task: research, in prose',
    '',
    'Establish this meme\'s provenance. Use web search freely — the supplied',
    'evidence is a starting point, not a boundary. Work the order:',
    '',
    '1. Identify the meme behind the ticker. The ticker is a marketing surface;',
    '   search for the MEME.',
    '2. Date its first appearance in culture from a source, not from the token.',
    '3. Find every PRIOR tokenisation of the same meme and what became of each.',
    '4. Decide where in the recycling chain this token sits.',
    '5. Judge whether this token is the instance the meme\'s audience would call',
    '   canonical, or a latecomer wearing the name.',
    '',
    'Write your findings as notes. Say what you searched, what you found, what',
    'contradicted what, and what you could not establish. Where a search',
    'returned nothing useful, say that too — an absence is a finding.',
    '',
    'Do NOT call a tool in this turn and do NOT produce a structured report. The',
    'structuring happens in a second pass over these notes. If step 1 or 2 fails,',
    'say so plainly rather than compensating with invention.',
  ].join('\n');
}

/**
 * Phase 2. The notes are this system's own text — the model wrote them under
 * the fencing policy above — so they are not re-fenced. The measured facts come
 * along because several schema fields are about the token rather than the meme.
 */
export function buildExtractionPrompt(
  snapshot: TokenSnapshot,
  chain: ChainAnalysis | undefined,
  notes: string,
  citations: readonly string[],
  precedent: readonly MemeSighting[] = [],
): string {
  const sources =
    citations.length > 0
      ? ['', '## Sources consulted', '', citations.map((url, i) => `[S${i + 1}] ${url}`).join('\n')].join('\n')
      : '';
  return [
    snapshotBlock(snapshot),
    '',
    chainBlock(chain),
    '',
    ...(precedent.length > 0 ? [precedentBlock(precedent), ''] : []),
    '## Research notes from the previous pass',
    '',
    notes,
    sources,
    '',
    '## Task: structure the above',
    '',
    'Call the provenance tool exactly once. Every field must be supported by the',
    'notes above. Do not add a lineage step, a prior cycle or an origin year that',
    'the notes do not support — the research pass is finished and nothing new can',
    'be verified now. Where the notes are thin or contradictory, that is what',
    '`confidence` is for, and `unclear` is a real answer.',
    '',
    'Record as `model-knowledge` evidence any claim you are carrying from your own',
    'recall rather than from a source named in the notes.',
  ].join('\n');
}
