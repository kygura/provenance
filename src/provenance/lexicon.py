"""A seed table of narrative archetypes and the things they are reruns of.

The premise the whole project rests on: a launch rarely invents a story. It
re-runs one that already paid, in front of an audience that was not there the
first time. This table is the cheap, deterministic half of detecting that - it
costs nothing to run over every token, and it gives the LLM a starting hypothesis
instead of a blank page.

It is deliberately incomplete and deliberately editable. Add rows as metas come
back around; the pipeline reads it at import time.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Archetype:
    key: str
    label: str
    # Matched case-insensitively against symbol, name, and the project blurb.
    patterns: tuple[str, ...]
    # Prior runs of this story, oldest first. Names, not tickers, where the
    # name is what people remember.
    ancestors: tuple[str, ...]
    note: str = ""
    # How strongly a match here suggests a recycled narrative rather than a new one.
    weight: float = 1.0
    _compiled: list[re.Pattern] = field(default_factory=list, compare=False, repr=False)

    def matches(self, text: str) -> list[str]:
        """The literal substrings that matched, not the patterns that matched them -
        these go into a prompt, where raw regex reads as noise."""
        found: list[str] = []
        for pattern in self.patterns:
            hit = re.search(pattern, text, re.IGNORECASE)
            if hit and hit.group(0).strip():
                found.append(hit.group(0).strip())
        return list(dict.fromkeys(found))


ARCHETYPES: tuple[Archetype, ...] = (
    Archetype(
        key="explicit_revival",
        label="Explicit revival",
        patterns=(r"\b2\.0\b", r"\bv2\b", r"\bredux\b", r"\brebor", r"\brevival\b",
                  r"\bresurrect", r"\bclassic\b", r"\breturn of\b", r"\bthe og\b",
                  r"\b3\.0\b", r"\brevenge\b", r"\bcomeback\b"),
        ancestors=("the thing it is naming",),
        note="The token says outright that it is a sequel. Cheapest signal there is, "
             "and the one where the ancestor is named for you.",
        weight=2.0,
    ),
    Archetype(
        key="dog",
        label="Dog coin",
        patterns=(r"\bdoge?\b", r"shib", r"\binu\b", r"floki", r"bonk", r"\bwif\b",
                  r"\bdog\b", r"akita", r"corgi", r"husky", r"\bpup", r"shiba", r"\bmutt\b"),
        ancestors=("Dogecoin (2013)", "Shiba Inu (2020)", "Floki (2021)",
                   "BONK (2022)", "dogwifhat (2023)"),
        note="The oldest recycled narrative in the asset class. Each cycle's dog is "
             "sold to people who missed the last one.",
        weight=1.4,
    ),
    Archetype(
        key="cat",
        label="Cat coin",
        patterns=(r"\bcat\b", r"meow", r"\bmew\b", r"popcat", r"kitty", r"nyan",
                  r"\bpaw\b", r"feline"),
        ancestors=("Nyan Cat (2011 meme, 2021 NFT)", "MOG (2023)", "Popcat (2024)",
                   "MEW (2024)"),
        note="The standing counter-trade to dog coins; revives on the same schedule.",
        weight=1.3,
    ),
    Archetype(
        key="frog",
        label="Frog / Wojak lineage",
        patterns=(r"pepe", r"\bfrog\b", r"\bapu\b", r"brett", r"wojak", r"\bkek\b",
                  r"\btoad\b", r"furie"),
        ancestors=("Pepecoin (2016)", "PEPE (2023)", "Brett (2024)", "Apu Apustaja (2024)"),
        note="Matt Furie's characters have been retokenised in every cycle since 2016.",
        weight=1.4,
    ),
    Archetype(
        key="ai_agent",
        label="AI agent",
        patterns=(r"\bai\b", r"agent", r"\bgpt\b", r"\bllm\b", r"terminal", r"swarm",
                  r"neural", r"sentient", r"\basi\b", r"autonom", r"\bbot\b", r"oracle"),
        ancestors=("SingularityNET / Fetch.ai (2017-18)", "Truth Terminal & GOAT (2024)",
                   "ai16z / Virtuals (2024-25)"),
        note="The 2017 'AI blockchain' pitch, relaunched once the word agent started "
             "carrying the story instead.",
        weight=1.2,
    ),
    Archetype(
        key="political",
        label="Political",
        patterns=(r"trump", r"\bmaga\b", r"biden", r"boden", r"kamala", r"harris",
                  r"\bpotus\b", r"election", r"vance", r"\bgop\b", r"president",
                  r"patriot", r"libert"),
        ancestors=("2020 election coins", "BODEN / TREMP (2024)", "TRUMP (2025)"),
        note="Strictly seasonal. Off-cycle launches are reruns aimed at people who "
             "remember the last cycle paying.",
        weight=1.3,
    ),
    Archetype(
        key="absurdist",
        label="Absurdist / anti-utility",
        patterns=(r"\bfart", r"\bpoop", r"\bretard", r"\bdumb\b", r"useless",
                  r"\bnothing\b", r"\bscam\b", r"\brug\b", r"\bstupid\b", r"\bjeet\b"),
        ancestors=("Useless Ethereum Token (2017)", "Fartcoin (2024)"),
        note="The joke that the joke is the product. Recurs whenever utility claims "
             "have just finished discrediting themselves.",
        weight=1.2,
    ),
    Archetype(
        key="yield_cosplay",
        label="Yield / mechanism cosplay",
        patterns=(r"rebase", r"olympus", r"\bohm\b", r"ve\(?3,?3\)?", r"reflect",
                  r"\btomb\b", r"\bsafe\s?moon", r"\bapy\b", r"auto.?stak",
                  r"\bnode\b", r"\btreasury\b", r"\bbond"),
        ancestors=("SafeMoon (2021)", "OlympusDAO forks (2021)", "Titan / Iron (2021)",
                   "node-as-a-service tokens (2021-22)"),
        note="A mechanism sold as a reason. Every version of this has ended the "
             "same way; the mechanism's name is what changes.",
        weight=1.5,
    ),
    Archetype(
        key="standard_revival",
        label="Token-standard novelty",
        patterns=(r"\b404\b", r"ordinal", r"inscrip", r"\bbrc.?20\b", r"\brune",
                  r"\bsrc.?20\b", r"hybrid", r"semi.?fungible"),
        ancestors=("Ordinals & BRC-20 (2023)", "ERC-404 (2024)", "Runes (2024)"),
        note="The novelty is the standard, not the meme. These rhyme with each other "
             "rather than with any single ancestor.",
        weight=1.1,
    ),
    Archetype(
        key="rwa",
        label="Real-world assets",
        patterns=(r"\brwa\b", r"tokeni[sz]", r"treasur", r"\bbond\b", r"\bgold\b",
                  r"\bsilver\b", r"real.?world", r"\bequit", r"\byield.?bearing\b"),
        ancestors=("Security token offerings (2018)", "RWA summer (2023-24)"),
        note="The 2018 STO pitch with the compliance language removed.",
        weight=1.2,
    ),
    Archetype(
        key="gamefi",
        label="GameFi / metaverse",
        patterns=(r"\bplay\b", r"\bgame", r"\bp2e\b", r"metaverse", r"\bland\b",
                  r"\bquest\b", r"\barena\b", r"\bguild\b"),
        ancestors=("Axie Infinity (2021)", "metaverse land (2021-22)"),
        note="Dormant since 2022. A launch here is betting the audience has turned over.",
        weight=1.3,
    ),
    Archetype(
        key="celebrity",
        label="Celebrity / influencer",
        patterns=(r"\bcoin\b.*\bofficial\b", r"\bhawk\b", r"jenner", r"\bdrake\b",
                  r"kanye", r"\bye\b", r"\bmrbeast\b", r"\bstream", r"\bcelebrit"),
        ancestors=("celebrity NFT drops (2021)", "HAWK (2024)"),
        note="Distribution is the entire product. Check whether the named person has "
             "actually acknowledged it.",
        weight=1.1,
    ),
    Archetype(
        key="chain_tribal",
        label="Chain mascot",
        patterns=(r"\bbase\b", r"\bsol(ana)?\b", r"\bton\b", r"\bblast\b",
                  r"\bhyper", r"\bmonad\b", r"\bberachain\b", r"\bl2\b"),
        ancestors=("BNB-chain mascots (2021)", "Base season (2024)"),
        note="Bets on a chain's incentive programme rather than on the meme.",
        weight=1.0,
    ),
)


def classify(text: str) -> list[tuple[Archetype, list[str]]]:
    """Every archetype whose patterns appear in the given text."""
    hits = []
    for archetype in ARCHETYPES:
        matched = archetype.matches(text)
        if matched:
            hits.append((archetype, matched))
    return hits


def describe_hits(hits: list[tuple[Archetype, list[str]]]) -> str:
    """A compact brief for the LLM: what matched, and what it has matched before."""
    if not hits:
        return "No archetype in the local lexicon matched. Treat the lineage question as open."
    lines = []
    for archetype, matched in hits:
        ancestors = "; ".join(archetype.ancestors)
        lines.append(
            f"- {archetype.label} (matched: {', '.join(repr(m) for m in matched)}). "
            f"Prior runs: {ancestors}. {archetype.note}"
        )
    return "\n".join(lines)
