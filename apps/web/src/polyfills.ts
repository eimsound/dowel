// 按需加载 polyfill：只在浏览器不支持时加载（兼容目标是 Baseline Widely available）
export const loadPolyfills = async () => {
  const tasks: Promise<unknown>[] = [];
  if (!Object.hasOwn(HTMLElement.prototype, 'popover')) tasks.push(import('@oddbird/popover-polyfill'));
  if (!Object.hasOwn(HTMLElement.prototype, 'focusGroup'))
    tasks.push(import('@microsoft/focusgroup-polyfill').then((m) => m.polyfillBodyAndObserve()));
  await Promise.all(tasks);
};
