"""Parsing third-party payloads. These shapes drift, so the tests assert the
tolerant behaviour as much as the happy path."""

from provenance.enrich import goplus
from provenance.sources import dexscreener, geckoterminal


class TestDexScreener:
    def test_ref(self, dexscreener_pair):
        ref = dexscreener.ref_from_pair(dexscreener_pair)
        assert ref is not None
        assert ref.chain == "solana"
        assert ref.symbol == "PEPE2"
        assert ref.dex == "raydium"

    def test_market(self, dexscreener_pair):
        market = dexscreener.market_from_pair(dexscreener_pair)
        assert market.liquidity_usd == 310_000
        assert market.volume_24h_usd == 1_850_000
        assert market.price_usd == 0.00042
        assert market.pair_created_at is not None
        # 1.85M traded against a 310K pool.
        assert round(market.volume_to_liquidity, 1) == 6.0
        assert round(market.liquidity_to_fdv, 4) == 0.0738

    def test_socials(self, dexscreener_pair):
        socials = dexscreener.socials_from_pair(dexscreener_pair)
        assert socials.twitter == "https://x.com/example"
        assert socials.telegram == "https://t.me/example"
        assert socials.website == "https://example.invalid"
        # Unrecognised platforms are kept rather than dropped.
        assert any("github" in line for line in socials.other)

    def test_missing_fields_do_not_raise(self):
        market = dexscreener.market_from_pair({"baseToken": {}})
        assert market.liquidity_usd is None
        assert market.age_hours is None
        assert market.volume_to_liquidity is None

    def test_unknown_chain_yields_no_ref(self, dexscreener_pair):
        assert dexscreener.ref_from_pair({**dexscreener_pair, "chainId": "nonesuch"}) is None


class TestGeckoTerminal:
    def test_ref(self, geckoterminal_pool):
        ref = geckoterminal._ref_from_pool(geckoterminal_pool, "solana")
        assert ref is not None
        assert ref.address == "TOKEN222"
        assert ref.symbol == "WIF2"
        assert ref.dex == "meteora"

    def test_market(self, geckoterminal_pool):
        market = geckoterminal.market_from_pool(geckoterminal_pool)
        assert market.liquidity_usd == 890_000.12
        assert market.market_cap_usd is None
        assert market.pair_created_at is not None
        assert market.pair_created_at.tzinfo is not None

    def test_malformed_token_id(self, geckoterminal_pool):
        pool = {**geckoterminal_pool, "relationships": {"base_token": {"data": {"id": "nounderscore"}}}}
        assert geckoterminal._ref_from_pool(pool, "solana") is None


class TestGoPlus:
    def test_evm_holders_exclude_locked_and_burned(self, goplus_evm):
        holders = goplus.holders_from_evm(goplus_evm)
        assert holders.holder_count == 4821
        # 21% + 9% + 5% circulating; the 40% lock and 12% burn are excluded.
        assert holders.top10_pct == 35.0
        assert len(holders.excluded_addresses) == 2
        assert holders.creator_pct == 3.1

    def test_evm_security(self, goplus_evm):
        security = goplus.security_from_evm(goplus_evm)
        assert security.is_honeypot is False
        assert security.buy_tax_pct == 3.0
        assert security.sell_tax_pct == 5.0
        assert "hidden owner" in security.flags
        assert "mintable" not in security.flags
        # 95% of LP sits at the null address.
        assert security.lp_burned is True
        assert security.lp_locked_pct == 95.0

    def test_solana(self, goplus_solana):
        holders = goplus.holders_from_solana(goplus_solana)
        security = goplus.security_from_solana(goplus_solana)
        assert holders.top10_pct == 33.0
        assert holders.creator_pct == 2.0
        assert security.mint_authority_active is False
        assert security.freeze_authority_active is True
        assert "freeze authority live" in security.flags
        assert "metadata mutable" in security.flags

    def test_gini_bounds(self):
        assert goplus._gini([5, 5, 5, 5]) == 0.0
        assert goplus._gini([1]) is None
        assert goplus._gini([]) is None
        assert goplus._gini([99, 1, 1, 1]) > 0.5
