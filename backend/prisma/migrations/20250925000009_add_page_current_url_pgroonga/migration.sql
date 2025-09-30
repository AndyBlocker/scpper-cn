-- Add PGroonga index for fast URL matching in unified search
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_page_current_url_pgroonga
ON "Page" USING pgroonga ("currentUrl");
