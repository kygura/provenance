/**
 * Reading a web-search response: prose, citations, search count, and the error
 * a server tool reports in place of results.
 *
 * Separate from `analyst.ts` because both depths use it, and `anchor.ts`
 * importing the analyst closed a cycle (anchor -> analyst -> prompt -> anchor)
 * that left `ANCHOR_RULES` uninitialised when `prompt.ts` quoted it.
 */

import type Anthropic from '@anthropic-ai/sdk';

export interface Harvest {
  texts: string[];
  citations: string[];
  searches: number;
}

/**
 * Pull prose, source URLs and search count out of one response.
 *
 * Server-tool errors arrive as a 200 with an error object where the result list
 * would be, so the content of a `web_search_tool_result` is checked before it
 * is iterated — treating it as an array throws on exactly the responses that
 * most need reporting.
 */
export function harvest(message: Anthropic.Message): Harvest {
  const texts: string[] = [];
  const citations: string[] = [];
  let searches = 0;

  for (const block of message.content) {
    if (block.type === 'text') {
      texts.push(block.text);
      for (const citation of block.citations ?? []) {
        const url = (citation as { url?: string }).url;
        if (url) citations.push(url);
      }
    } else if (block.type === 'web_search_tool_result') {
      searches += 1;
      const content = block.content as unknown;
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        const url = (item as { url?: string }).url;
        if (url) citations.push(url);
      }
    }
  }

  return { texts, citations, searches };
}

/** Error code on a `web_search_tool_result` whose search did not run. */
export function searchErrorCode(message: Anthropic.Message): string | undefined {
  for (const block of message.content) {
    if (block.type !== 'web_search_tool_result') continue;
    const content = block.content as unknown;
    if (Array.isArray(content)) continue;
    const code = (content as { error_code?: string } | undefined)?.error_code;
    if (code) return code;
  }
  return undefined;
}
