/**
 * @fileoverview Asserts the MCP annotation triple on every registered tool. Every tool reads
 * the live ORCID Public API, so each one is read-only, idempotent, and open-world (#38).
 * Driven off the definitions barrel `src/index.ts` registers, so a new tool is covered the
 * moment it ships.
 * @module tests/tools/annotations.tool.test
 */

import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

describe('tool annotations', () => {
  it('registers the full tool set', () => {
    expect(allToolDefinitions).toHaveLength(9);
  });

  it.each(allToolDefinitions.map((definition) => [definition.name, definition] as const))(
    '%s is read-only, idempotent, and open-world',
    (_, definition) => {
      expect(definition.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    },
  );
});
