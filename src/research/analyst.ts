/**
 * The LLM half: web research, then structured extraction.
 *
 * Split into two calls on purpose. The first runs with the web search server
 * tool and no output constraint, so the model can follow leads and change its
 * mind. The second reads those notes with no tools and produces the
 * schema-validated verdict. Forcing both jobs into one call makes the research
 * worse, because the model starts optimising for filling fields.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import type { ResearchConfig } from "../config.js";
import { log } from "../log.js";
import { ProvenanceVerdictSchema, type ProvenanceVerdict, type TokenDossier } from "../models.js";
import { extractionPrompt, renderDossier, researchPrompt, SYSTEM } from "./prompts.js";

/** Dynamic-filtering variant; requires Opus 4.6+ / Sonnet 4.6+. */
const WEB_SEARCH_TOOL_TYPE = "web_search_20260209" as const;

export interface ResearchResult {
  notes: string;
  citations: string[];
  verdict: ProvenanceVerdict | null;
  searchesRun: number;
}

interface Harvest {
  texts: string[];
  citations: string[];
  searches: number;
}

/**
 * Pull prose, source URLs and search count out of one response.
 *
 * Server-tool errors arrive as a 200 with an error object where the result list
 * would be, so the content of a web_search_tool_result is checked before it is
 * iterated.
 */
export function harvest(message: Anthropic.Message): Harvest {
  const texts: string[] = [];
  const citations: string[] = [];
  let searches = 0;

  for (const block of message.content) {
    if (block.type === "text") {
      texts.push(block.text);
      for (const citation of block.citations ?? []) {
        const url = (citation as { url?: string }).url;
        if (url) citations.push(url);
      }
    } else if (block.type === "web_search_tool_result") {
      searches += 1;
      const content = block.content;
      if (!Array.isArray(content)) {
        const code = (content as { error_code?: string } | undefined)?.error_code;
        if (code) log.info(`web search stopped: ${code}`);
        continue;
      }
      for (const item of content) {
        const url = (item as { url?: string }).url;
        if (url) citations.push(url);
      }
    }
  }

  return { texts, citations, searches };
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}

export class Analyst {
  private readonly client: Anthropic;

  constructor(
    apiKey: string | null,
    private readonly config: ResearchConfig,
  ) {
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  }

  async investigate(dossier: TokenDossier): Promise<ResearchResult> {
    const rendered = renderDossier(dossier);
    const result = await this.research(rendered);
    result.verdict = await this.extract(result.notes, rendered);
    return result;
  }

  // -- phase 1 ---------------------------------------------------------

  private async research(renderedDossier: string): Promise<ResearchResult> {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: researchPrompt(renderedDossier) },
    ];
    const tools: Anthropic.ToolUnion[] = [
      {
        type: WEB_SEARCH_TOOL_TYPE,
        name: "web_search",
        max_uses: this.config.maxWebSearches,
      },
    ];

    const notes: string[] = [];
    const citations: string[] = [];
    let searches = 0;
    let paused = true;

    // A web-search turn can stop with stop_reason "pause_turn" when it runs
    // long. Resuming means sending the paused assistant turn straight back.
    for (let attempt = 0; attempt <= this.config.maxPauseTurnRestarts; attempt++) {
      // Streaming so a long research turn cannot hit the HTTP timeout.
      const stream = this.client.messages.stream({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: SYSTEM,
        messages,
        tools,
        thinking: { type: "adaptive" },
        output_config: { effort: this.config.effort },
      });
      const message = await stream.finalMessage();

      const found = harvest(message);
      notes.push(...found.texts);
      citations.push(...found.citations);
      searches += found.searches;

      if (message.stop_reason !== "pause_turn") {
        paused = false;
        break;
      }
      messages.push({ role: "assistant", content: message.content });
    }

    if (paused) {
      log.warn(`research turn still paused after ${this.config.maxPauseTurnRestarts} restarts`);
    }

    return {
      notes: notes.filter((n) => n.trim()).join("\n\n"),
      citations: dedupe(citations),
      verdict: null,
      searchesRun: searches,
    };
  }

  // -- phase 2 ---------------------------------------------------------

  private async extract(notes: string, renderedDossier: string): Promise<ProvenanceVerdict | null> {
    if (!notes.trim()) {
      log.warn("no research notes produced - skipping extraction");
      return null;
    }

    try {
      const response = await this.client.messages.parse({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: SYSTEM,
        messages: [{ role: "user", content: extractionPrompt(notes, renderedDossier) }],
        thinking: { type: "adaptive" },
        output_config: { format: zodOutputFormat(ProvenanceVerdictSchema) },
      });
      // parsed_output is null when the response could not be parsed.
      return response.parsed_output ?? null;
    } catch (error) {
      if (error instanceof Anthropic.NotFoundError) {
        log.error(`model ${this.config.model} not available to this key`);
      } else if (error instanceof Anthropic.RateLimitError) {
        log.error("rate limited during extraction");
      } else if (error instanceof Anthropic.APIError) {
        log.error(`extraction failed: ${error.message}`);
      }
      throw error;
    }
  }
}
