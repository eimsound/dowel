// 会话：QueryClient 与当前用户。路由的 beforeLoad 直接 ensureQueryData，页面用 useMe。
import type { Me } from '@dowel/api';
import { QueryClient, queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';

import { ApiError, api } from './api.ts';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

/** 未登录时返回 null（401 不是错误，是“没有会话”） */
export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: async (): Promise<Me | null> => {
    try {
      return await api<Me>('GET', '/api/auth/me');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
});

export const useMe = () => useQuery(meQuery);

export const fetchMe = () => queryClient.ensureQueryData(meQuery);

/**
 * 退出登录：清空整个查询缓存再回登录页。
 * 账户菜单和“吊销当前会话”共用（后者服务端已经把 cookie 清掉了，再调一次 logout 也没影响）。
 * 一定要先 clear() 再跳转：缓存里还有上一个用户的项目 / 组 / 会话，不清理会在登录页闪一下。
 */
export const useSignOut = () => {
  const qc = useQueryClient();
  const nav = useNavigate();
  return useCallback(async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    qc.clear();
    await nav({ to: '/login' });
  }, [qc, nav]);
};
