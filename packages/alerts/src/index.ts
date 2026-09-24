/**
 * Public surface of @provenance/alerts. Other packages depend on these names.
 */

// Scoring
export {
  assertWeights,
  assessRisk,
  capTier,
  createScorer,
  DEFAULT_WEIGHTS,
  EXTREME_CONCENTRATION_PCT,
  FORCED_PENALTY,
  LIQUIDITY_DEEP_USD,
  LIQUIDITY_FLOOR_USD,
  LOW_CONFIDENCE_THRESHOLD,
  MEMETIC_DURABILITY_WEIGHT,
  NEUTRAL,
  priceWindowScore,
  scoreAuthenticity,
  scoreComponents,
  scoreDistribution,
  scoreLiquidity,
  scoreMemetic,
  scoreMomentum,
  scoreRecycling,
  scoreToken,
  SINGLE_HOLDER_DOMINANCE_PCT,
  TIER_CUTS,
  tierFor,
  turnoverScore,
  txnBalanceScore,
  VERDICT_BASE,
  VERDICT_EVIDENCE_MULTIPLIER,
  type RiskAssessment,
  type ScoreOptions,
  type ScoreWeights,
} from './scoring';

// Alert bodies
export {
  renderAlertBody,
  renderAnchorLine,
  renderComponents,
  renderMarketLines,
  renderPriorCycles,
  renderRiskFlags,
  stripMarkdown,
  type AlertBodyOptions,
} from './format';

// Rules
export {
  attachClusterContext,
  buildClusterContexts,
  canonicalImpostorRule,
  cleanRevivalRule,
  CLUSTER_HEAT_MIN_TOKENS,
  createAlerts,
  defaultRules,
  highScoreRule,
  IMPOSTOR_MAX_AUTHENTICITY,
  IMPOSTOR_MIN_MEMETIC,
  narrativeClusterHeatRule,
  previousObservation,
  rugRiskRule,
  RUG_RISK_MIN_SCORE,
  scoreSurgeRule,
  SURGE_DELTA_POINTS,
  SURGE_MAX_BASELINE_AGE_HOURS,
  type ExtendedAlertRuleInput,
  type NarrativeClusterContext,
} from './rules';

// Launch lane
export { gateLaunchChain, gateLaunchMarket, launchAnchoredAlert, launchExpressedAlert } from './launches';

// Channels
export {
  buildDiscordPayload,
  buildTelegramMessage,
  ConsoleSink,
  DISCORD_MAX_CONTENT,
  DISCORD_MAX_EMBED_DESCRIPTION,
  DiscordSink,
  escapeMarkdownV2,
  FileSink,
  formatForConsole,
  isTransientStatus,
  MARKDOWN_V2_SPECIALS,
  parseRetryAfterMs,
  TELEGRAM_MAX_CHARS,
  TelegramSink,
  truncateMarkdownV2,
  WebhookSink,
  type BaseSinkOptions,
  type DiscordPayload,
  type FetchLike,
  type SinkDeliveryResult,
} from './channels';

// Delivery
export { createSinks, dispatchAlerts, type CreateSinksOptions, type DispatchOptions } from './dispatch';
