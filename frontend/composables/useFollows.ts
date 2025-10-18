import { useNuxtApp } from 'nuxt/app';

export interface FollowEntry {
  id: number;
  targetUserId: number;
  wikidotId: number | null;
  displayName: string | null;
}

interface FollowsResponse { ok: boolean; follows: FollowEntry[] }
interface FollowResult { ok: boolean; id?: number | null; followerId?: number; targetUserId?: number; error?: string }
interface UnfollowResult { ok: boolean; deleted: number }

export function useFollows() {
  const { $bff } = useNuxtApp();
  const follows = useState<FollowEntry[]>('follows/list', () => []);
  const loading = useState('follows/loading', () => false);

  async function fetchFollows(force = false) {
    if (loading.value && !force) return follows.value;
    loading.value = true;
    try {
      const res = await $bff<FollowsResponse>('/follows', { method: 'GET' });
      if (res?.ok && Array.isArray(res.follows)) {
        follows.value = res.follows;
      } else {
        follows.value = [];
      }
    } catch (e) {
      console.warn('[follows] fetch failed', e);
      follows.value = [];
    } finally {
      loading.value = false;
    }
    return follows.value;
  }

  async function followUser(targetWikidotId: number) {
    try {
      const res = await $bff<FollowResult>('/follows', { method: 'POST', body: { targetWikidotId } });
      await fetchFollows(true);
      return res;
    } catch (e) {
      console.warn('[follows] follow failed', e);
      throw e;
    }
  }

  async function unfollowUser(targetWikidotId: number) {
    try {
      const res = await $bff<UnfollowResult>(`/follows/${targetWikidotId}`, { method: 'DELETE' });
      await fetchFollows(true);
      return res;
    } catch (e) {
      console.warn('[follows] unfollow failed', e);
      throw e;
    }
  }

  function isFollowing(wikidotId?: number | null): boolean {
    if (!wikidotId) return false;
    return follows.value.some(f => f.wikidotId === wikidotId);
    }

  return { follows, loading, fetchFollows, followUser, unfollowUser, isFollowing };
}

