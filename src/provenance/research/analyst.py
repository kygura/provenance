"""The LLM half: web research, then structured extraction.

Split into two calls on purpose. The first runs with the web search server tool
and no output constraint, so the model can follow leads and change its mind. The
second reads those notes with no tools and produces the schema-validated verdict.
Forcing both jobs into one call makes the research worse, because the model
starts optimising for filling fields.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import anthropic
from anthropic import APIStatusError, NotFoundError, RateLimitError

from provenance.config import ResearchConfig
from provenance.models import ProvenanceVerdict, TokenDossier
from provenance.research import prompts

log = logging.getLogger(__name__)

# Dynamic-filtering variant; requires Opus 4.6+ / Sonnet 4.6+.
WEB_SEARCH_TOOL_TYPE = "web_search_20260209"


@dataclass
class ResearchResult:
    notes: str
    citations: list[str] = field(default_factory=list)
    verdict: ProvenanceVerdict | None = None
    searches_run: int = 0


class Analyst:
    def __init__(self, api_key: str | None, config: ResearchConfig) -> None:
        self.config = config
        self.client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()

    # -- public ----------------------------------------------------------

    def investigate(self, dossier: TokenDossier) -> ResearchResult:
        rendered = prompts.render_dossier(dossier)
        result = self._research(rendered)
        result.verdict = self._extract(result.notes, rendered)
        return result

    # -- phase 1 ---------------------------------------------------------

    def _research(self, rendered_dossier: str) -> ResearchResult:
        messages: list[dict] = [
            {
                "role": "user",
                "content": prompts.RESEARCH_TEMPLATE.format(dossier=rendered_dossier),
            }
        ]
        tools = [
            {
                "type": WEB_SEARCH_TOOL_TYPE,
                "name": "web_search",
                "max_uses": self.config.max_web_searches,
            }
        ]

        notes: list[str] = []
        citations: list[str] = []
        searches = 0

        # A web-search turn can stop with stop_reason "pause_turn" when it runs
        # long. Resuming means sending the paused assistant turn straight back.
        for _ in range(self.config.max_pause_turn_restarts + 1):
            message = self._stream(
                messages=messages,
                system=prompts.SYSTEM,
                tools=tools,
                max_tokens=self.config.max_tokens,
                effort=self.config.effort,
            )
            text, cites, used = _harvest(message)
            notes.extend(text)
            citations.extend(cites)
            searches += used

            if message.stop_reason != "pause_turn":
                break
            messages.append({"role": "assistant", "content": message.content})
        else:
            log.warning("research turn still paused after %d restarts", self.config.max_pause_turn_restarts)

        return ResearchResult(
            notes="\n\n".join(n for n in notes if n.strip()),
            citations=_dedupe(citations),
            searches_run=searches,
        )

    # -- phase 2 ---------------------------------------------------------

    def _extract(self, notes: str, rendered_dossier: str) -> ProvenanceVerdict | None:
        if not notes.strip():
            log.warning("no research notes produced - skipping extraction")
            return None
        try:
            response = self.client.messages.parse(
                model=self.config.model,
                max_tokens=self.config.max_tokens,
                system=prompts.SYSTEM,
                messages=[
                    {
                        "role": "user",
                        "content": prompts.EXTRACTION_TEMPLATE.format(
                            notes=notes, dossier=rendered_dossier
                        ),
                    }
                ],
                thinking={"type": "adaptive"},
                output_format=ProvenanceVerdict,
            )
        except NotFoundError:
            log.error("model %s not available to this key", self.config.model)
            raise
        except RateLimitError:
            log.error("rate limited during extraction")
            raise
        except APIStatusError as exc:
            log.error("extraction failed: %s", exc)
            raise
        return response.parsed_output

    # -- transport -------------------------------------------------------

    def _stream(
        self,
        *,
        messages: list[dict],
        system: str,
        tools: list[dict],
        max_tokens: int,
        effort: str,
    ):
        """Streaming so a long research turn cannot hit the HTTP timeout."""
        with self.client.messages.stream(
            model=self.config.model,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
            tools=tools,
            thinking={"type": "adaptive"},
            output_config={"effort": effort},
        ) as stream:
            return stream.get_final_message()


def _harvest(message) -> tuple[list[str], list[str], int]:
    """Pull prose, source URLs and search count out of one response.

    Server-tool errors arrive as a 200 with an error object where the result list
    would be, so the content of a `web_search_tool_result` is type-checked before
    it is iterated.
    """
    texts: list[str] = []
    citations: list[str] = []
    searches = 0

    for block in message.content:
        kind = getattr(block, "type", None)
        if kind == "text":
            texts.append(block.text)
            for citation in getattr(block, "citations", None) or []:
                url = getattr(citation, "url", None)
                if url:
                    citations.append(url)
        elif kind == "web_search_tool_result":
            searches += 1
            content = getattr(block, "content", None)
            if not isinstance(content, list):
                # {"error_code": "max_uses_exceeded"} and friends.
                code = getattr(content, "error_code", None)
                if code:
                    log.info("web search stopped: %s", code)
                continue
            for item in content:
                url = getattr(item, "url", None)
                if url:
                    citations.append(url)

    return texts, citations, searches


def _dedupe(urls: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for url in urls:
        if url not in seen:
            seen.add(url)
            out.append(url)
    return out
