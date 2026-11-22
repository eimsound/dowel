// 登录页需要、但不需要登录就能读的实例信息（名称、能不能用密码登录、外部登录方式）。
import type { InstanceInfo } from '@dowel/api';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { api } from './api.ts';

export const instanceQuery = queryOptions({
  queryKey: ['instance'],
  queryFn: () => api<InstanceInfo>('GET', '/api/instance'),
  // 实例设置可能会被管理员修改，但页面跳转时重新读一次就够，不必定时轮询
  staleTime: 30_000,
});

export const useInstance = () => useQuery(instanceQuery);
