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
  const error = useState<string | null>('follows/error', () => null);
  /** 是否至少成功加载过一次。isFollowing 靠它区分「确实没关注」与「还不知道」 */
  const loaded = useState<boolean>('follows/loaded', () => false);
  /**
   * 身份世代号。只清空状态挡不住**已经在飞的请求**：
   * A 的 /follows 还没回来时换成 B 登录，resetState 把列表清了，
   * 随后 A 的响应照样写进共享状态 —— B 会看到 A 关注了谁。
   * 每次请求记下当时的世代，回来比对，不一致就整个丢弃。
   */
  const identityEpoch = useState<number>('follows/epoch', () => 0);
  /** 请求世代：同账号内的并发请求也要保证「只有最新一次能写回」 */
  const requestGeneration = useState<number>('follows/reqGen', () => 0);

  async function fetchFollows(force = false) {
    if (loading.value && !force) return follows.value;
    loading.value = true;
    const myEpoch = identityEpoch.value;
    const myRequest = requestGeneration.value + 1;
    requestGeneration.value = myRequest;
    try {
      const res = await $bff<FollowsResponse>('/follows', { method: 'GET' });
      // 期间换过身份 → 本次结果作废，绝不写回
      if (identityEpoch.value !== myEpoch) return follows.value;
      // 已有更新的请求发出 → 本次是旧数据
      if (requestGeneration.value !== myRequest) return follows.value;
      if (res?.ok && Array.isArray(res.follows)) {
        follows.value = res.follows;
        loaded.value = true;
        error.value = null;
      } else {
        // 保留已有列表：清空会让 isFollowing 恒返回 false，用户页的星标随之熄灭 ——
        // 界面等于在撒谎「你没关注他」。
        error.value = '加载关注列表失败';
      }
    } catch (e) {
      console.warn('[follows] fetch failed', e);
      if (identityEpoch.value === myEpoch && requestGeneration.value === myRequest) {
        error.value = '网络异常，未能刷新关注列表';
      }
    } finally {
      if (requestGeneration.value === myRequest) loading.value = false;
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

  /** 登出时必须清空**并作废在途请求**：否则同一标签页换人登录后，会看到上一个人的关注态 */
  function resetState() {
    identityEpoch.value += 1;
    requestGeneration.value += 1;
    follows.value = [];
    loading.value = false;
    error.value = null;
    loaded.value = false;
  }

  return { follows, loading, error, loaded, fetchFollows, followUser, unfollowUser, isFollowing, resetState };
}

