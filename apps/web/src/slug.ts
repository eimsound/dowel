/** 由组名 / 项目名自动推导标识：转小写、非字母数字（含空格和下划线）替换为 -、去首尾 -、最多 39 位 */
export const slugify = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 39)
    .replace(/-+$/, '');
