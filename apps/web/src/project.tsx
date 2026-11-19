// 项目上下文：项目布局解析 /project/:owner/:project 后，子页面直接用 pid、项目信息和当前用户。
import type { Me, ProjectInfo } from '@dowel/api';
import { createContext, useContext } from 'react';

export interface ProjectContextValue {
  pid: string;
  project: ProjectInfo;
  me: Me;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export const ProjectProvider = ProjectContext.Provider;

export const useProject = () => {
  const v = useContext(ProjectContext);
  if (!v) throw new Error('useProject 必须在项目布局里使用');
  return v;
};
