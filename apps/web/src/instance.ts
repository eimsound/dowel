// 登录页需要、但不需要登录就能读的实例信息（名称、能不能用密码登录、是否需要初始化）。
import type { InstanceInfo } from '@dowel/api';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { api } from './api.ts';

export const instanceQuery = queryOptions({
  queryKey: ['instance'],
  queryFn: () => api<InstanceInfo>('GET', '/api/instance'),
  // 初始化状态会在 setup 之后变化，但页面跳转时重新读一次就够，不必定时轮询
  staleTime: 30_000,
});

export const useInstance = () => useQuery(instanceQuery);
