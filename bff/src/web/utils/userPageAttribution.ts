// Prefer current attributions; deleted pages may use only their last live snapshot.
// Scanning older attribution holders could restore deliberately removed authors.
export const USER_PAGE_ATTRIBUTION_JOIN = `
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN EXISTS (
        SELECT 1 FROM "Attribution" current_attrs
        WHERE current_attrs."pageVerId" = effective_pv.id
      ) THEN effective_pv.id
      WHEN COALESCE(p."isDeleted", effective_pv."isDeleted", false) THEN (
        SELECT last_live.id
        FROM "PageVersion" last_live
        WHERE last_live."pageId" = p.id AND NOT last_live."isDeleted"
        ORDER BY last_live."validFrom" DESC NULLS LAST, last_live.id DESC
        LIMIT 1
      )
      ELSE effective_pv.id
    END AS id
  ) attribution_pv ON TRUE
`;

