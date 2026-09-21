"""Settings. Everything tunable lives in config/provenance.toml; everything secret
lives in the environment."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = REPO_ROOT / "config" / "provenance.toml"


def _env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


@dataclass(slots=True)
class Secrets:
    anthropic_api_key: str | None = None
    dextools_api_key: str | None = None
    helius_api_key: str | None = None
    etherscan_api_key: str | None = None
    birdeye_api_key: str | None = None
    telegram_bot_token: str | None = None
    telegram_chat_id: str | None = None
    discord_webhook_url: str | None = None
    github_token: str | None = None
    github_repository: str | None = None

    @classmethod
    def from_env(cls) -> Secrets:
        load_dotenv(REPO_ROOT / ".env", override=False)
        return cls(
            anthropic_api_key=_env("ANTHROPIC_API_KEY"),
            dextools_api_key=_env("DEXTOOLS_API_KEY"),
            helius_api_key=_env("HELIUS_API_KEY"),
            etherscan_api_key=_env("ETHERSCAN_API_KEY"),
            birdeye_api_key=_env("BIRDEYE_API_KEY"),
            telegram_bot_token=_env("TELEGRAM_BOT_TOKEN"),
            telegram_chat_id=_env("TELEGRAM_CHAT_ID"),
            discord_webhook_url=_env("DISCORD_WEBHOOK_URL"),
            github_token=_env("GITHUB_TOKEN"),
            github_repository=_env("GITHUB_REPOSITORY"),
        )


@dataclass(slots=True)
class SourceConfig:
    chains: list[str] = field(default_factory=lambda: ["solana", "ethereum", "base", "bsc"])
    dextools_plan: str = "trial"
    dextools_enabled: bool = True
    dexscreener_enabled: bool = True
    geckoterminal_enabled: bool = True
    per_source_limit: int = 30


@dataclass(slots=True)
class FilterConfig:
    min_liquidity_usd: float = 25_000
    min_volume_24h_usd: float = 50_000
    max_age_hours: float | None = 24 * 21
    min_age_hours: float = 1.0
    max_top10_pct: float | None = 92.0
    require_socials: bool = False


@dataclass(slots=True)
class ResearchConfig:
    model: str = "claude-opus-5"
    effort: str = "high"
    max_tokens: int = 16_000
    max_web_searches: int = 8
    max_tokens_per_run: int = 6
    max_pause_turn_restarts: int = 4


@dataclass(slots=True)
class AlertConfig:
    min_recycle_confidence: int = 55
    novelty_allowlist: list[str] = field(
        default_factory=lambda: ["pure-rerun", "remix", "novel"]
    )
    realert_after_hours: float = 72.0
    write_markdown_report: bool = True
    reports_dir: str = "reports"


@dataclass(slots=True)
class Config:
    sources: SourceConfig = field(default_factory=SourceConfig)
    filters: FilterConfig = field(default_factory=FilterConfig)
    research: ResearchConfig = field(default_factory=ResearchConfig)
    alerts: AlertConfig = field(default_factory=AlertConfig)
    state_path: str = "state/provenance.sqlite3"
    secrets: Secrets = field(default_factory=Secrets.from_env)

    @classmethod
    def load(cls, path: Path | str | None = None) -> Config:
        path = Path(path) if path else DEFAULT_CONFIG
        raw: dict = {}
        if path.exists():
            raw = tomllib.loads(path.read_text())
        return cls(
            sources=SourceConfig(**raw.get("sources", {})),
            filters=FilterConfig(**raw.get("filters", {})),
            research=ResearchConfig(**raw.get("research", {})),
            alerts=AlertConfig(**raw.get("alerts", {})),
            state_path=raw.get("state_path", "state/provenance.sqlite3"),
            secrets=Secrets.from_env(),
        )

    def resolved_state_path(self) -> Path:
        p = Path(self.state_path)
        return p if p.is_absolute() else REPO_ROOT / p
