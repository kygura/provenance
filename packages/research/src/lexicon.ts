/**
 * A seed table of narrative archetypes and the things they are reruns of.
 *
 * The premise the whole project rests on: a launch rarely invents a story. It
 * re-runs one that already paid, in front of an audience that was not there the
 * first time. This table is the cheap, deterministic half of detecting that -
 * it costs nothing to run over every token, and it gives the model a starting
 * hypothesis instead of a blank page.
 *
 * It is deliberately incomplete and deliberately editable. Add rows as metas
 * come back around; the prompt builder reads it at import time.
 *
 * Patterns carry no `/g` flag on purpose: a global regex holds `lastIndex`
 * between calls, which would make `classify()` order-dependent.
 */

export interface Archetype {
  key: string;
  label: string;
  /** Matched case-insensitively against symbol, name, and the project blurb. */
  patterns: RegExp[];
  /** Prior runs of this story, oldest first. Names, not tickers, where the name is what people remember. */
  ancestors: string[];
  note: string;
  /** How strongly a match here suggests a recycled narrative rather than a new one. */
  weight: number;
}

export const ARCHETYPES: Archetype[] = [
  {
    key: "explicit_revival",
    label: "Explicit revival",
    patterns: [
      /\b2\.0\b/i, /\bv2\b/i, /\bredux\b/i, /\brebor/i, /\brevival\b/i,
      /\bresurrect/i, /\bclassic\b/i, /\breturn of\b/i, /\bthe og\b/i,
      /\b3\.0\b/i, /\brevenge\b/i, /\bcomeback\b/i,
    ],
    ancestors: ["the thing it is naming"],
    note:
      "The token says outright that it is a sequel. Cheapest signal there is, " +
      "and the one where the ancestor is named for you.",
    weight: 2.0,
  },
  {
    key: "dog",
    label: "Dog coin",
    patterns: [
      /\bdoge?\b/i, /shib/i, /\binu\b/i, /floki/i, /bonk/i, /\bwif\b/i,
      /\bdog\b/i, /akita/i, /corgi/i, /husky/i, /\bpup/i, /shiba/i, /\bmutt\b/i,
    ],
    ancestors: [
      "Dogecoin (2013)", "Shiba Inu (2020)", "Floki (2021)",
      "BONK (2022)", "dogwifhat (2023)",
    ],
    note:
      "The oldest recycled narrative in the asset class. Each cycle's dog is " +
      "sold to people who missed the last one.",
    weight: 1.4,
  },
  {
    key: "cat",
    label: "Cat coin",
    patterns: [/\bcat\b/i, /meow/i, /\bmew\b/i, /popcat/i, /kitty/i, /nyan/i, /\bpaw\b/i, /feline/i],
    ancestors: ["Nyan Cat (2011 meme, 2021 NFT)", "MOG (2023)", "Popcat (2024)", "MEW (2024)"],
    note: "The standing counter-trade to dog coins; revives on the same schedule.",
    weight: 1.3,
  },
  {
    key: "frog",
    label: "Frog / Wojak lineage",
    patterns: [/pepe/i, /\bfrog\b/i, /\bapu\b/i, /brett/i, /wojak/i, /\bkek\b/i, /\btoad\b/i, /furie/i],
    ancestors: ["Pepecoin (2016)", "PEPE (2023)", "Brett (2024)", "Apu Apustaja (2024)"],
    note: "Matt Furie's characters have been retokenised in every cycle since 2016.",
    weight: 1.4,
  },
  {
    key: "ai_agent",
    label: "AI agent",
    patterns: [
      /\bai\b/i, /agent/i, /\bgpt\b/i, /\bllm\b/i, /terminal/i, /swarm/i,
      /neural/i, /sentient/i, /\basi\b/i, /autonom/i, /\bbot\b/i, /oracle/i,
    ],
    ancestors: [
      "SingularityNET / Fetch.ai (2017-18)",
      "Truth Terminal & GOAT (2024)",
      "ai16z / Virtuals (2024-25)",
    ],
    note:
      "The 2017 'AI blockchain' pitch, relaunched once the word agent started " +
      "carrying the story instead.",
    weight: 1.2,
  },
  {
    key: "political",
    label: "Political",
    patterns: [
      /trump/i, /\bmaga\b/i, /biden/i, /boden/i, /kamala/i, /harris/i,
      /\bpotus\b/i, /election/i, /vance/i, /\bgop\b/i, /president/i,
      /patriot/i, /libert/i,
    ],
    ancestors: ["2020 election coins", "BODEN / TREMP (2024)", "TRUMP (2025)"],
    note:
      "Strictly seasonal. Off-cycle launches are reruns aimed at people who " +
      "remember the last cycle paying.",
    weight: 1.3,
  },
  {
    key: "absurdist",
    label: "Absurdist / anti-utility",
    patterns: [
      /\bfart/i, /\bpoop/i, /\bretard/i, /\bdumb\b/i, /useless/i,
      /\bnothing\b/i, /\bscam\b/i, /\brug\b/i, /\bstupid\b/i, /\bjeet\b/i,
    ],
    ancestors: ["Useless Ethereum Token (2017)", "Fartcoin (2024)"],
    note:
      "The joke that the joke is the product. Recurs whenever utility claims " +
      "have just finished discrediting themselves.",
    weight: 1.2,
  },
  {
    key: "yield_cosplay",
    label: "Yield / mechanism cosplay",
    patterns: [
      /rebase/i, /olympus/i, /\bohm\b/i, /ve\(?3,?3\)?/i, /reflect/i,
      /\btomb\b/i, /\bsafe\s?moon/i, /\bapy\b/i, /auto.?stak/i,
      /\bnode\b/i, /\btreasury\b/i, /\bbond/i,
    ],
    ancestors: [
      "SafeMoon (2021)", "OlympusDAO forks (2021)", "Titan / Iron (2021)",
      "node-as-a-service tokens (2021-22)",
    ],
    note:
      "A mechanism sold as a reason. Every version of this has ended the same " +
      "way; the mechanism's name is what changes.",
    weight: 1.5,
  },
  {
    key: "standard_revival",
    label: "Token-standard novelty",
    patterns: [
      /\b404\b/i, /ordinal/i, /inscrip/i, /\bbrc.?20\b/i, /\brune/i,
      /\bsrc.?20\b/i, /hybrid/i, /semi.?fungible/i,
    ],
    ancestors: ["Ordinals & BRC-20 (2023)", "ERC-404 (2024)", "Runes (2024)"],
    note:
      "The novelty is the standard, not the meme. These rhyme with each other " +
      "rather than with any single ancestor.",
    weight: 1.1,
  },
  {
    key: "rwa",
    label: "Real-world assets",
    patterns: [
      /\brwa\b/i, /tokeni[sz]/i, /treasur/i, /\bbond\b/i, /\bgold\b/i,
      /\bsilver\b/i, /real.?world/i, /\bequit/i, /\byield.?bearing\b/i,
    ],
    ancestors: ["Security token offerings (2018)", "RWA summer (2023-24)"],
    note: "The 2018 STO pitch with the compliance language removed.",
    weight: 1.2,
  },
  {
    key: "gamefi",
    label: "GameFi / metaverse",
    patterns: [/\bplay\b/i, /\bgame/i, /\bp2e\b/i, /metaverse/i, /\bland\b/i, /\bquest\b/i, /\barena\b/i, /\bguild\b/i],
    ancestors: ["Axie Infinity (2021)", "metaverse land (2021-22)"],
    note: "Dormant since 2022. A launch here is betting the audience has turned over.",
    weight: 1.3,
  },
  {
    key: "celebrity",
    label: "Celebrity / influencer",
    patterns: [
      /\bcoin\b.*\bofficial\b/i, /\bhawk\b/i, /jenner/i, /\bdrake\b/i,
      /kanye/i, /\bye\b/i, /\bmrbeast\b/i, /\bstream/i, /\bcelebrit/i,
    ],
    ancestors: ["celebrity NFT drops (2021)", "HAWK (2024)"],
    note:
      "Distribution is the entire product. Check whether the named person has " +
      "actually acknowledged it.",
    weight: 1.1,
  },
  {
    key: "chain_tribal",
    label: "Chain mascot",
    patterns: [
      /\bbase\b/i, /\bsol(ana)?\b/i, /\bton\b/i, /\bblast\b/i,
      /\bhyper/i, /\bmonad\b/i, /\bberachain\b/i, /\bl2\b/i,
    ],
    ancestors: ["BNB-chain mascots (2021)", "Base season (2024)"],
    note: "Bets on a chain's incentive programme rather than on the meme.",
    weight: 1.0,
  },
];

export interface ArchetypeHit {
  archetype: Archetype;
  /**
   * The literal substrings that matched, not the patterns that matched them -
   * these go into a prompt, where raw regex reads as noise.
   */
  matched: string[];
}

export function classify(text: string): ArchetypeHit[] {
  const hits: ArchetypeHit[] = [];
  for (const archetype of ARCHETYPES) {
    const matched: string[] = [];
    for (const pattern of archetype.patterns) {
      const found = pattern.exec(text)?.[0]?.trim();
      if (found && !matched.includes(found)) matched.push(found);
    }
    if (matched.length > 0) hits.push({ archetype, matched });
  }
  return hits;
}

/** A compact brief for the LLM: what matched, and what it has matched before. */
export function describeHits(hits: ArchetypeHit[]): string {
  if (hits.length === 0) {
    return "No archetype in the local lexicon matched. Treat the lineage question as open.";
  }
  return hits
    .map(({ archetype, matched }) => {
      const quoted = matched.map((m) => `'${m}'`).join(", ");
      return `- ${archetype.label} (matched: ${quoted}). Prior runs: ${archetype.ancestors.join("; ")}. ${archetype.note}`;
    })
    .join("\n");
}
