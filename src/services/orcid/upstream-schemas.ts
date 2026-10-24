/**
 * @fileoverview Consumed ORCID fields validated before normalization; null leaves mean absent.
 * @module services/orcid/upstream-schemas
 */
import { z } from '@cyanheads/mcp-ts-core';
import type {
  RawActivities,
  RawBulkWorksResponse,
  RawExpandedSearchResponse,
  RawFundingDetail,
  RawFundingsResponse,
  RawPeerReviewsResponse,
  RawPerson,
  RawResearchResourceDetail,
  RawResearchResourcesResponse,
  RawWorksResponse,
} from './types.js';

/** ORCID represents unset fields with either omission or null. */
const optional = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);
const text = optional(z.string());
const number = optional(z.number());
const value = optional(z.object({ value: text }));
const date = optional(z.object({ year: value, month: value, day: value }));
const ref = optional(z.object({ uri: text, path: text, host: text }));
const source = optional(
  z.object({
    'source-orcid': ref,
    'source-client-id': ref,
    'source-name': value,
    'assertion-origin-orcid': ref,
    'assertion-origin-client-id': ref,
    'assertion-origin-name': value,
  }),
);
const organization = z.object({
  name: text,
  address: optional(z.object({ city: text, region: text, country: text })),
  'disambiguated-organization': optional(
    z.object({
      'disambiguated-organization-identifier': text,
      'disambiguation-source': text,
    }),
  ),
});
const externalId = z.object({
  'external-id-type': text,
  'external-id-value': text,
  'external-id-url': value,
  'external-id-normalized': optional(z.object({ value: text, transient: optional(z.boolean()) })),
  'external-id-relationship': text,
});
const externalIds = optional(z.object({ 'external-id': optional(z.array(externalId)) }));
const title = optional(z.object({ title: value, subtitle: value, 'translated-title': value }));
const common = {
  'put-code': number,
  title,
  type: text,
  source,
  url: value,
  'start-date': date,
  'end-date': date,
  'external-ids': externalIds,
};
const work = z.object({
  ...common,
  'publication-date': date,
  'journal-title': value,
  'short-description': text,
  'language-code': text,
  citation: optional(z.object({ 'citation-type': text, 'citation-value': text })),
  contributors: optional(
    z.object({
      contributor: optional(
        z.array(
          z.object({
            'credit-name': value,
            'contributor-orcid': optional(z.object({ path: text })),
            'contributor-attributes': optional(
              z.object({ 'contributor-role': text, 'contributor-sequence': text }),
            ),
          }),
        ),
      ),
    }),
  ),
});
const affiliation = optional(
  z.object({
    ...common,
    organization: optional(organization),
    'department-name': text,
    'role-title': text,
  }),
);
const section = optional(
  z.object({
    'affiliation-group': optional(
      z.array(
        z.object({
          summaries: optional(
            z.array(
              z.object({
                'employment-summary': affiliation,
                'education-summary': affiliation,
                'invited-position-summary': affiliation,
                'distinction-summary': affiliation,
                'membership-summary': affiliation,
                'qualification-summary': affiliation,
                'service-summary': affiliation,
              }),
            ),
          ),
        }),
      ),
    ),
  }),
);
const funding = z.object({ ...common, organization: optional(organization) });
const hosts = optional(z.object({ organization: optional(z.array(organization)) }));
const resource = z.object({
  'put-code': number,
  source,
  proposal: optional(
    z.object({
      title,
      hosts,
      'external-ids': externalIds,
      'start-date': date,
      'end-date': date,
      url: value,
    }),
  ),
  'resource-item': optional(
    z.array(
      z.object({
        'resource-name': text,
        'resource-type': text,
        hosts,
        'external-ids': externalIds,
        url: value,
      }),
    ),
  ),
});

/**
 * Error documents are not empty records. Unknown fields remain allowed, including on
 * sparse records; these markers distinguish ORCID's error envelope from record data.
 */
const envelope = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({
      ...shape,
      'response-code': z.never().optional(),
      'error-code': z.never().optional(),
      'developer-message': z.never().optional(),
      'user-message': z.never().optional(),
    })
    .passthrough()
    .refine(
      (record) => Object.keys(shape).some((key) => Object.hasOwn(record, key)),
      'Missing endpoint envelope.',
    );

/** Endpoint-specific consumed response schemas, with unknown metadata ignored. */
export const upstreamSchemas: {
  search: z.ZodType<RawExpandedSearchResponse>;
  person: z.ZodType<RawPerson>;
  works: z.ZodType<RawWorksResponse>;
  activities: z.ZodType<RawActivities>;
  fundings: z.ZodType<RawFundingsResponse>;
  fundingDetail: z.ZodType<RawFundingDetail>;
  peerReviews: z.ZodType<RawPeerReviewsResponse>;
  bulkWorks: z.ZodType<RawBulkWorksResponse>;
  resources: z.ZodType<RawResearchResourcesResponse>;
  resourceDetail: z.ZodType<RawResearchResourceDetail>;
} = {
  search: envelope({
    'num-found': number,
    'expanded-result': optional(
      z.array(
        z.object({
          'orcid-id': text,
          'given-names': text,
          'family-names': text,
          'credit-name': text,
          'other-name': optional(z.array(z.string())),
          email: optional(z.array(z.string())),
          'institution-name': optional(z.array(z.string())),
        }),
      ),
    ),
  }),
  person: envelope({
    name: optional(z.object({ 'given-names': value, 'family-name': value, 'credit-name': value })),
    'other-names': optional(
      z.object({
        'other-name': optional(z.array(z.object({ content: text, 'display-index': number }))),
      }),
    ),
    biography: optional(z.object({ content: text })),
    keywords: optional(z.object({ keyword: optional(z.array(z.object({ content: text }))) })),
    'researcher-urls': optional(
      z.object({ 'researcher-url': optional(z.array(z.object({ 'url-name': text, url: value }))) }),
    ),
    'external-identifiers': optional(
      z.object({ 'external-identifier': optional(z.array(externalId)) }),
    ),
    emails: optional(
      z.object({
        email: optional(
          z.array(
            z.object({
              email: text,
              primary: optional(z.boolean()),
              verified: optional(z.boolean()),
            }),
          ),
        ),
      }),
    ),
    addresses: optional(
      z.object({
        address: optional(z.array(z.object({ country: value, primary: optional(z.boolean()) }))),
      }),
    ),
  }),
  works: envelope({
    group: optional(
      z.array(
        z
          .object({ 'work-summary': optional(z.array(work)), 'external-ids': externalIds })
          .refine(
            (group) => Object.hasOwn(group, 'work-summary'),
            'Missing work summary envelope.',
          ),
      ),
    ),
  }),
  activities: envelope({
    employments: section,
    educations: section,
    'invited-positions': section,
    distinctions: section,
    memberships: section,
    qualifications: section,
    services: section,
  }),
  fundings: envelope({
    group: optional(
      z.array(
        z
          .object({ 'funding-summary': optional(z.array(funding)) })
          .refine(
            (group) => Object.hasOwn(group, 'funding-summary'),
            'Missing funding summary envelope.',
          ),
      ),
    ),
  }),
  fundingDetail: envelope({
    ...funding.shape,
    'put-code': z.number().int().positive().safe(),
    'short-description': text,
    amount: optional(z.object({ value: text, 'currency-code': text })),
  }),
  peerReviews: envelope({
    group: optional(
      z.array(
        z
          .object({
            'external-ids': externalIds,
            'peer-review-group': optional(
              z.array(
                z.object({
                  'peer-review-summary': optional(
                    z.array(
                      z.object({
                        'put-code': number,
                        source,
                        'reviewer-role': text,
                        'review-type': text,
                        'completion-date': date,
                        'convening-organization': optional(organization),
                        'review-url': value,
                      }),
                    ),
                  ),
                }),
              ),
            ),
          })
          .refine(
            (group) => Object.hasOwn(group, 'peer-review-group'),
            'Missing peer review group envelope.',
          ),
      ),
    ),
  }),
  bulkWorks: envelope({
    bulk: optional(
      z.array(
        z.union([
          z.object({ work, error: z.never().optional() }),
          z.object({
            error: z.object({
              'put-code': number,
              'response-code': number,
              'error-code': number,
              'developer-message': text,
            }),
            work: z.never().optional(),
          }),
        ]),
      ),
    ),
  }),
  resources: envelope({
    group: optional(
      z.array(
        z
          .object({ 'research-resource-summary': optional(z.array(resource)) })
          .refine(
            (group) => Object.hasOwn(group, 'research-resource-summary'),
            'Missing research resource summary envelope.',
          ),
      ),
    ),
  }),
  resourceDetail: envelope({ ...resource.shape, 'put-code': z.number().int().positive().safe() }),
};
