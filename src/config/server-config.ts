/**
 * @fileoverview Server-specific environment variable configuration for orcid-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  orcidApiBaseUrl: z
    .string()
    .url()
    .default('https://pub.orcid.org/v3.0')
    .describe('ORCID Public API base URL (default: https://pub.orcid.org/v3.0)'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

/** Returns the parsed server configuration, lazily initialized on first call. */
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    orcidApiBaseUrl: 'ORCID_API_BASE_URL',
  });
  return _config;
}
