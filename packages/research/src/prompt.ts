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
 * With `LLM_SEARCH_MODEL` set the same two calls split by model instead
 * (`buildGatherPrompt`, `buildJudgePrompt`): a cheap model searches and
 * gathers without deciding, and the strong model judges from its notes.
 *
 * They are separate calls on purpose. A model asked to research and to fill a
 * twelve-field schema in one turn starts optimising for the schema partway
 * through the research, and the lineage is the first thing to suffer.
 *
 * Both calls lead with two questions. The anchor — anchored, forced or
 * unclear — quotes `ANCHOR_RULES` from `anchor.ts` verbatim, so the full
 * report and the launch-time check cannot drift apart on what the verdicts
 * mean. The organic read — organic, manufactured, mixed or unclear — asks
 * whether the token carrying a real meme is itself real, or a sniped and
 * promoted twin of the one that is; Neiro (2024) is the case it is built on.
 * The lineage and prior cycles are supporting detail and evidence for both.
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
import type { ChainAnalysis, EvidenceItem, TokenSnapshot } from '@provenance/core';
import { formatPct, formatUsd, truncate } from '@provenance/core';
import { ANCHOR_RULES } from './anchor';
import { classify, describeHits } from './lexicon';
import { buildQueries } from './queries';
import { UNTRUSTED_POLICY, fence, scrub } from './untrusted';

export const PROMPT_VERSION = 'provenance-research-v5';
/**
 * Reports from the gather/judge split carry this instead: same system prompt
 * and schema, but the verdict is reached by a different model from different
 * notes, so the two populations must stay tellable apart.
 */
export const SPLIT_PROMPT_VERSION = 'provenance-research-v5-split';

export const SYSTEM_PROMPT = `You are the provenance analyst for a research system that reads every trending memecoin and answers two questions before anything else:

1. Is the meme real? Does it have an ANCHOR — something that existed before the token and outside it — or is it being FORCED because the token exists?
2. Is the token organic? Is its attention coming from people outside its own launch who did real work for it, or was it MANUFACTURED — sniped, bundled, insider-held, paid for, fast-tracked?

A real meme carried by a staged token is the most common trap in this market, and catching it is what this system is for. Price, chart and volume are not evidence for either question: manufactured tokens produce all three on purpose.

${ANCHOR_RULES}

# The organic question

## The reference case: Neiro, 2024

In mid-2024 Atsuko Sato, whose Shiba Inu Kabosu was the dog behind Doge, adopted a new Shiba named Neiro. The anchor was as real as anchors get, and "the next Doge" sold itself. Within days several tokens took the name. Two on Ethereum mattered:

- One drew on-chain analysts' warnings that most of its supply was sniped at launch and spread across linked wallets, with insiders still holding most of it. It reached Binance perpetual futures fast. A perps listing needs open interest, not an organic holder base.
- The other, deployed earlier and abandoned by its developer, was carried by a community takeover. It earned attention its holders did not pay for: Justin Sun backed it publicly and HTX listed it. In September 2024 Binance listed it for spot trading, and Binance's co-founder said other candidates had failed review on compliance and token concentration.

Same anchor, same name, same chain. One was manufactured, one was organic, and the venues that do diligence sorted them accordingly. Every report you write should be able to tell those two apart.

## Signs a token is organic

- A community takeover, or other unpaid effort that kept the token alive after its deployer left.
- Attention from people who hold no allocation and were not paid: well-known figures, the anchor's own subject or owner, media outside crypto.
- Listings won on review: spot listings on major venues, especially after a period of open trading.
- Independent work: art, video, merchandise, translations, other communities picking the meme up without being asked to.
- Supply that dispersed through trading rather than staying with the deployer and wallets funded alongside it.

## Signs a token is manufactured

- A sniped or bundled launch: a large share of supply bought in the first blocks, often across fresh wallets funded from one source.
- An insider cluster: deployer, early buyers and funding wallets linked, and still holding most of the supply.
- Paid promotion: coordinated influencer posts, shill rounds, "partnerships" that are ads.
- A listing that arrived faster than any community could form, above all a derivatives listing on a token days or weeks old.
- Holder and volume growth that follows the promotion schedule rather than independent attention.
- Attention that ends where the launch apparatus ends: every mention traces back to the team, its paid accounts, or wallets that profit.

Neither an earlier deploy nor a listing settles it alone. Ask who did the work, and who held the supply while they did it. A sniped token with a real anchor is more dangerous than a forced one, not less, because the anchor lends it credibility it did not earn.

## Rivals

When more than one token carries the meme, name them. For each, give chain, deploy order, distribution and listings where the evidence has them, and say which one the meme's audience and outside observers converged on. If this token is the staged twin of an organic one, or the organic twin of a staged one, that is the finding.

## Outside traction

Separately from the verdict, judge how much effort and attention from outside the launch is keeping the narrative alive: listings, notable figures, media, community work, the anchor's subject acknowledging it. That is what keeps a narrative going once the launch money stops. Paid or insider attention does not count here, however loud it is.

# How the lineage serves both verdicts

The meme's history is the evidence the anchor stands on, and it is context for the organic read:

- A dated cultural origin that predates the token and does not mention it is what makes a meme \`anchored\`. So are earlier tokenisations of the same meme: a meme that has already been monetised had a life before this contract.
- A token whose only sources are its own site, socials, launch posts or paid promotion is \`forced\`, however elaborate its lore. The deployer's description is a claim, never an anchor.
- The anchor verdict, the organic verdict and \`recycleVerdict\` answer different questions. A copycat of a live meme can be anchored (the meme is real; this token is not its canonical carrier). A reaction to an inciting event can be anchored with no lineage and no prior cycles at all. An anchored meme can sit on a manufactured token.
- If you call a meme \`anchored\` but can give it neither a lineage, a prior cycle nor a dated source, the verdict is probably \`unclear\`.

# Why recycling matters

Recycled narratives are new participants rediscovering old metas. A narrative that has already worked once carries its own proof, and the person arriving now rarely knows a revival from an invention. So a proven meme returning years later is a stronger setup than a novel one, and the useful question is not "is this meme good" but "has it been monetised before, when, how many times, and how did those attempts end". Prior cycles also show what the manufactured versions of this meme looked like last time.

# What you produce

The anchor first: verdict, type, subject, the earliest independent source and its date. Then the organic read: verdict, outside traction, the dated signals behind it, and the rival tokens. Then the supporting detail: date the meme, trace its lineage, enumerate PRIOR TOKENISATIONS with years and rough outcomes, place this token in the recycling chain, and judge whether it is the instance the meme's own audience would accept as canonical.

You emit your answer by calling the provided tool exactly once. Do not answer in prose.

# The failure mode that matters most

CONFLATING THE MEME'S ORIGIN YEAR WITH THE TOKEN'S LAUNCH DATE. These are different facts and they are usually years apart.

- \`originYear\` is when the underlying meme first entered CULTURE — the photograph, the video, the catchphrase, the character, the incident.
- The token's pool creation date is a market fact about this contract. It belongs nowhere near \`originYear\`.

A token that launched last week can carry a 2010 meme. If your evidence only establishes when the token launched, you have established nothing about the meme, and \`originYear\` must be omitted rather than filled with the launch year.

The same holds for \`anchor.anchorDate\` and \`anchor.earliestSource\`: they date the anchor, from a source about the anchor. A page about the token — its launch post, its listing, its chart — is never the earliest source, and its date is never the anchor date.

The organic read has its own version of this mistake: treating the token's own marketing as outside attention. A post by the team, a paid account or a holder talking up their bag is the launch apparatus, not traction.

# Evidence discipline

- Every factual claim you make should be traceable to a supplied evidence item or a source you searched. Prefer the supplied evidence over your own recollection wherever both speak.
- Where you rely on your own knowledge rather than a source, you MUST emit an evidence item of kind \`model-knowledge\` recording that specific claim, with no URL and a \`sourceQuality\` you set honestly (typically 0.2–0.5).
- Claims you can support neither from evidence nor from confident recall must not be made.
- Unsupported or thinly supported claims must drag \`confidence\` DOWN. A report built entirely on \`model-knowledge\` and on-chain metadata should not exceed roughly 0.35 confidence. A report where a Wikipedia or Know Your Meme entry dates the meme, names a prior token cycle and an independent source documents the launch can go above 0.7.
- Evidence about the TOKEN (a listing, holder distribution, a sniping report) is not evidence about the MEME, and cannot support an origin year or a lineage claim. It is exactly the evidence the organic read needs.
- On-chain facts supplied below (concentration, creator holding, authorities) are measured, not reported. Cite them in organic signals as such. A sniping or bundling claim needs a named source: an analytics firm, an explorer trace, a news report.

# Say "unclear" rather than invent

A confident wrong read is worse than an honest blank, because everything downstream treats a confident verdict as signal.

- If you cannot establish where the meme came from, set \`recycleVerdict\` to \`unclear\`, leave \`originYear\` absent, return an empty or minimal \`lineage\`, and say so in \`originSummary\`.
- If you cannot tell who is behind the token's attention, the organic verdict is \`unclear\`. Do not call a token organic because you found nothing bad; absence of a sniping report is not a clean launch.
- Never fabricate a prior cycle, a rival, a listing or a notable figure's attention. Empty arrays are real and common answers.
- Do not pattern-match a plausible-sounding origin onto an unfamiliar name. Many tickers are noise with no meme behind them at all.

# Field guidance

- \`anchor\`: the headline, filled first. \`verdict\` and \`type\` as defined above; \`subject\` names the anchor in a few words (empty when there is none); \`anchorDate\` and \`earliestSource\` come from the earliest source about the anchor that does not mention the token; \`summary\` is one or two sentences on what the anchor is, or why there is none. \`confidence\` is \`high\` only when a dated independent source you actually read establishes the anchor, \`low\` when you are working from recall or thin notes. Do not decide whether the anchor precedes the launch; the system computes that from the dates.
- \`organic\`: filled second.
  - \`verdict\`: \`organic\` | \`manufactured\` | \`mixed\` (both present, neither dominates) | \`unclear\`. An \`organic\` verdict needs at least one organic signal; a \`manufactured\` verdict needs at least one manufactured signal.
  - \`outsideTraction\` (0–100): 80+ means listings won on review, attention from figures with no stake, and community work that outlived the deployer. Under 20 means nobody outside the launch has noticed. Paid or insider attention adds nothing.
  - \`signals\`: one entry per fact, with \`organic\` true or false, a date where known and the source URL. Kinds: \`listing\`, \`notable-attention\`, \`community-effort\`, \`media\`, \`anchor-acknowledgement\` (the anchor's subject or owner acknowledging the token) for organic; \`sniped-launch\`, \`insider-cluster\`, \`paid-promotion\`, \`fast-tracked-listing\` for manufactured; \`other\` otherwise. Name the venue and whether a listing was spot or derivatives.
  - \`rivals\`: other tokens carrying the same meme, with chain, ticker, address and a note on how they differ (deploy order, distribution, listings). Empty when there are none.
  - \`summary\`: one or two sentences: why, and against which rival.
- \`memeName\`: the meme's own canonical name, not the ticker. "dogwifhat" not "$WIF". If no meme is identifiable, use the clearest available label and say so in \`originSummary\`.
- \`narrativeCluster\`: a short lowercase family — \`dog\`, \`cat\`, \`frog\`, \`political\`, \`ai-agents\`, \`nostalgia\`, \`celebrity\`, \`food\`, \`abstract\`, \`unclassified\`.
- \`lineage\`: chronological steps from origin to now. \`origin\` = first cultural appearance. \`revival\` = the meme returning after dormancy. \`derivative\` = a spin-off with a real twist. \`platform-shift\` = the meme moving hosts (Tumblr to Twitter, Vine to TikTok).
- \`priorCycles\`: earlier TOKENS or monetisations of this same meme, each with a year where known and an \`outcome\`. Current rivals go in \`organic.rivals\`, not here.
- \`recycleVerdict\`: \`original\` (meme is new, or this is its first tokenisation) | \`revival\` (dormant meme brought back, typically years later) | \`derivative\` (builds on a live meme with a real twist) | \`copycat\` (rides a currently-running meme with no differentiation) | \`unclear\`.
- \`recycleGeneration\`: 0 = first tokenisation of this meme, 1 = first revival, 2 = revival of a revival. It must be consistent with \`priorCycles\`: N prior token cycles implies generation N.
- \`memeticDurability\` (0–100): how well the meme has survived previous attention cycles. Surviving two dormancies and returning is high. Never dormant, or never tested, is low.
- \`culturalReach\` (0–100): recognition OUTSIDE crypto. A meme your non-trading relatives would recognise is 80+. A meme known only to one Discord is under 20.
- \`authenticityScore\` (0–100): would the meme's own audience accept THIS token as the canonical carrier? High when the token is organic, the recognised instance among its rivals, and its community is the meme's community. A manufactured token should not score above 30 here, however strong its anchor. When rivals split the audience and you cannot tell which leads, sit near 50 and lower \`confidence\`.
- \`speculativeSetup\`: describe the STRUCTURE in plain language — what has happened before, who is holding now, whether the attention comes from outside the launch, what would have to be true for the pattern to repeat. This is a description, never a recommendation. Do not use "buy", "sell", "entry", "target", "should", or price predictions. Do not give financial advice under any framing.
- \`risks\`: concrete, specific to this token and meme. "An earlier same-name token holds the exchange listings and the community" is useful; "crypto is volatile" is not.
- \`confidence\` (0–1): your calibrated belief that the anchor, the organic read, the lineage and the recycling verdict above are correct. Low is a perfectly good answer.
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
    chain.sniping !== undefined
      ? `- early_buying: ${chain.sniping.earlyBuyPct.toFixed(2)}% of supply bought by ${chain.sniping.earlyBuyers} wallet(s) in the first ${chain.sniping.windowBlocks} block(s) of trading, ${chain.sniping.sameBlockBuyers} in the opening block${
          chain.sniping.stillHeldPct !== undefined ? `; they still hold ${chain.sniping.stillHeldPct.toFixed(2)}%` : ''
        }`
      : null,
    chain.flags.length > 0
      ? `- risk_flags: ${chain.flags.map((flag) => `[${flag.severity}] ${flag.code} — ${flag.detail}`).join('; ')}`
      : null,
    chain.notes.length > 0 ? `- notes: ${chain.notes.join('; ')}` : null,
  ].filter((row): row is string => row !== null);

  return `## On-chain analysis\n\n${rows.join('\n')}\n\nThese facts bear on the organic read and on risk: heavy concentration, a large creator holding or heavy early buying is what a sniped or insider-held launch looks like. They say nothing about the meme's age.`;
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
 * Phase 1. No schema, no fields to fill — just the question and the tool to
 * answer it with. The model is told explicitly that prose is the deliverable,
 * because a model that knows a schema is coming will start writing to it.
 */
export function buildResearchPrompt(
  snapshot: TokenSnapshot,
  chain: ChainAnalysis | undefined,
  evidence: readonly EvidenceItem[],
): string {
  return [
    snapshotBlock(snapshot),
    '',
    deployerBlock(snapshot),
    '',
    lexiconBlock(snapshot),
    '',
    chainBlock(chain),
    '',
    evidenceBlock(evidence),
    '',
    '## Task: research, in prose',
    '',
    'Decide whether this meme is anchored or forced, then whether this token is',
    'organic or manufactured, then establish its provenance. Use web search',
    'freely — the supplied evidence is a starting point, not a boundary. Work',
    'the order:',
    '',
    'The anchor',
    '1. Identify what the ticker or name refers to OUTSIDE this token. The ticker',
    '   is a marketing surface; search for the THING, not for the token.',
    '2. Find the EARLIEST INDEPENDENT SOURCE: the earliest page about that thing',
    '   that does not mention the token. Note its title, URL and publication date.',
    '   That date is the anchor date; it comes from a source, never from the pool.',
    '3. If the only sources you can find are the token\'s own site, socials, launch',
    '   posts or paid promotion, say so plainly: that is the finding, and it means',
    '   forced.',
    '',
    'The organic read',
    '4. Find every OTHER token carrying the same meme or name, on any chain. Note',
    '   deploy order, which one holds the listings, and which one the meme\'s',
    '   audience talks about.',
    '5. Search for signs this token was manufactured: sniping or bundling reports',
    '   (on-chain analytics firms, explorer traces), linked insider wallets, paid',
    '   influencer rounds, a derivatives listing that came within days of launch.',
    '   Read the on-chain facts above with this in mind.',
    '6. Search for attention from outside the launch: listings and whether they',
    '   are spot or derivatives, notable figures with no stake, a community',
    '   takeover, media outside crypto, the anchor\'s subject acknowledging it.',
    '   Check who is speaking: the team and its paid accounts are not outside.',
    '7. Decide organic, manufactured, mixed or unclear, and how much outside',
    '   traction there is. Finding nothing bad is not the same as organic.',
    '',
    'The lineage',
    '8. Date the meme\'s first appearance in culture and trace its lineage.',
    '9. Find every PRIOR tokenisation of the same meme and what became of each.',
    '10. Decide where in the recycling chain this token sits, and whether it is',
    '    the instance the meme\'s audience would call canonical, or a latecomer',
    '    wearing the name.',
    '',
    'End the notes with two lines: anchored, forced or unclear, and the source',
    'that decides it; organic, manufactured, mixed or unclear, and the signal that',
    'decides it.',
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
 * Split mode, phase 1 (`LLM_SEARCH_MODEL`): the cheap model searches and
 * writes evidence, and is told not to reach either verdict. Same blocks and
 * the same search order as `buildResearchPrompt`, so the judge sees the
 * evidence a full research pass would have gathered; only the conclusion
 * moves to the stronger model. The system prompt stays `SYSTEM_PROMPT`, so the
 * gatherer knows which signals each verdict turns on.
 */
export function buildGatherPrompt(
  snapshot: TokenSnapshot,
  chain: ChainAnalysis | undefined,
  evidence: readonly EvidenceItem[],
): string {
  return [
    snapshotBlock(snapshot),
    '',
    deployerBlock(snapshot),
    '',
    lexiconBlock(snapshot),
    '',
    chainBlock(chain),
    '',
    evidenceBlock(evidence),
    '',
    '## Task: gather evidence, in prose. Do not decide.',
    '',
    'You are the first of two passes. A second analyst will read your notes and',
    'decide both verdicts; your job is to give them the evidence, dated and',
    'sourced, on both sides of each question. Use web search freely; the',
    'supplied evidence is a starting point, not a boundary.',
    '',
    'For the anchor',
    '1. Identify what the ticker or name refers to OUTSIDE this token. Search for',
    '   the THING, not for the token.',
    '2. Find the EARLIEST INDEPENDENT SOURCE: the earliest page about that thing',
    '   that does not mention the token. Record its title, URL and publication',
    '   date exactly as the page gives them.',
    '3. If the only sources are the token\'s own site, socials, launch posts or',
    '   paid promotion, say so plainly.',
    '',
    'For the organic read',
    '4. Find every OTHER token carrying the same meme or name, on any chain:',
    '   deploy order, who holds the listings, which one the meme\'s audience',
    '   talks about.',
    '5. Search for signs of manufacture: sniping or bundling reports (analytics',
    '   firms, explorer traces), linked insider wallets, paid influencer rounds,',
    '   a derivatives listing within days of launch.',
    '6. Search for attention from outside the launch: listings (spot or',
    '   derivatives), notable figures with no stake, a community takeover, media',
    '   outside crypto, the anchor\'s subject acknowledging it. Note who is',
    '   speaking in each case.',
    '',
    'For the lineage',
    '7. Date the meme\'s first appearance in culture and trace its lineage.',
    '8. Find every PRIOR tokenisation of the same meme and what became of each.',
    '',
    'Write one line per finding: the fact, its date, its URL, and who is speaking.',
    'Keep findings that cut against each other side by side; do not reconcile',
    'them. Say what you searched and found nothing for: an absence is a finding.',
    '',
    'Do NOT state an anchored/forced or organic/manufactured verdict, a',
    'confidence, or a score, and do NOT call a tool or produce a structured',
    'report. Where you know something from recall rather than a page you read,',
    'mark the line "(recall)".',
  ].join('\n');
}

/**
 * Split mode, phase 2: the strong model reads the gatherer's notes and makes
 * the calls the gatherer was told not to. Unlike extraction this is the
 * judgement itself, so the caller asks for full reasoning.
 */
export function buildJudgePrompt(
  snapshot: TokenSnapshot,
  chain: ChainAnalysis | undefined,
  notes: string,
  citations: readonly string[],
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
    '## Evidence gathered by the search pass',
    '',
    'A cheaper model searched and wrote these notes. It was told to gather, not',
    'to judge. Treat its lines as leads with sources, not as conclusions: weigh',
    'who is speaking in each, and discount lines marked "(recall)".',
    '',
    notes,
    sources,
    '',
    '## Task: judge, then structure',
    '',
    'Decide whether the meme is anchored, forced or unclear, and whether this',
    'token is organic, manufactured, mixed or unclear, from the evidence above',
    'and the measured on-chain facts. Then call the provenance tool exactly once.',
    '',
    'Fill `anchor` first. Its `earliestSource` must be a source the notes name,',
    'and the notes must date it; if they do not, omit the date rather than',
    'supplying one. Do not judge whether the anchor precedes the launch: record',
    'the date and the system compares.',
    '',
    'Fill `organic` second. Each signal and each rival must come from the notes,',
    'with the date and URL the notes give. A verdict with no signal on its side',
    'is `unclear`; finding nothing bad is not organic.',
    '',
    'Do not add an anchor, a signal, a rival, a lineage step, a prior cycle or an',
    'origin year the notes do not support. Nothing new can be verified now. Thin',
    'or contradictory notes are what `confidence` and `unclear` are for.',
    '',
    'Record as `model-knowledge` evidence any claim you carry from recall,',
    'including lines the notes mark "(recall)".',
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
    '## Research notes from the previous pass',
    '',
    notes,
    sources,
    '',
    '## Task: structure the above',
    '',
    'Call the provenance tool exactly once. Fill `anchor` first: it is the',
    'headline, and the lineage and prior cycles below it are its evidence. Its',
    '`earliestSource` must be a source the notes name, and the notes must date it;',
    'if they do not, omit the date rather than supplying one. Do not judge whether',
    'the anchor precedes the launch — record the date and the system compares.',
    '',
    'Fill `organic` second. Each signal and each rival must come from the notes,',
    'with the date and URL the notes give. A verdict with no signal on its side',
    'is `unclear`.',
    '',
    'Every field must be supported by the notes above. Do not add an anchor, a',
    'signal, a rival, a lineage step, a prior cycle or an origin year that the',
    'notes do not support —',
    'the research pass is finished and nothing new can be verified now. Where the',
    'notes are thin or contradictory, that is what `confidence` is for, and',
    '`unclear` is a real answer.',
    '',
    'Record as `model-knowledge` evidence any claim you are carrying from your own',
    'recall rather than from a source named in the notes.',
  ].join('\n');
}
