export interface AvatarMeta {
  userid: string;
  source_url?: string;
  etag?: string | null;
  last_modified?: string | null;
  content_type?: string;
  bytes?: number;

  fetched_at?: string;
  last_resolve_at?: string | null;
  next_revalidate_at?: string;
  error_count?: number;
  cooldown_until?: string | null;
  last_access_at?: string;
}


