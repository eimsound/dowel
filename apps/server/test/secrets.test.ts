// 脱敏：任意文本用 scrubSecrets；已知连接串的显示用 maskUrl（URL.password），scrubUrl 两者都用并替换单独出现的密码
import { describe, expect, test } from 'vitest';
import { maskUrl, scrubSecrets } from '../src/secrets.ts';
import { scrubUrl } from '../src/targets.ts';

describe('scrubSecrets', () => {
  test.each([
    ['postgres://u:pw@h:5432/db', 'postgres://u:***@h:5432/db'],
    ['postgresql://dowel:secret@db.internal/shop', 'postgresql://dowel:***@db.internal/shop'],
    // 密码里有没转义的 @：userinfo 一直匹配到 host 前面最后一个 @
    ['postgres://dowel:p@ss@db:5432/shop', 'postgres://dowel:***@db:5432/shop'],
    ['postgres://dowel:a@b@c@db/shop', 'postgres://dowel:***@db/shop'],
    ['postgres://dowel:p%40ss@db:5432/shop', 'postgres://dowel:***@db:5432/shop'],
    ['postgres://u:@h/db', 'postgres://u:***@h/db'],
    // 密码里有斜杠（base64 密码很常见）：整段 userinfo 照样遮掉
    ['postgres://u:ab/cd@h/db', 'postgres://u:***@h/db'],
    ['postgres://u:a/b@c@h:5432/db', 'postgres://u:***@h:5432/db'],
    // 查询串、错误正文里的 @ 不是 userinfo：主机、库名和失败原因保持原样
    [
      'postgres://app:pw@db.internal:5432/shop?application_name=dowel@ci',
      'postgres://app:***@db.internal:5432/shop?application_name=dowel@ci',
    ],
    ['postgres://db:5432/shop?options=a@b', 'postgres://db:5432/shop?options=a@b'],
    [
      'could not connect to postgres://h:5432/db: role "a@b" does not exist',
      'could not connect to postgres://h:5432/db: role "a@b" does not exist',
    ],
    // 没有密码的不动
    ['postgres://u@h/db', 'postgres://u@h/db'],
    ['postgres://h:5432/db', 'postgres://h:5432/db'],
    // 一段文字里的多个连接串、后面还跟着别的话
    [
      'connect postgres://a:1@x/db then postgres://b:2@y/db failed',
      'connect postgres://a:***@x/db then postgres://b:***@y/db failed',
    ],
    ['could not connect to postgres://u:p@ss@h:5432', 'could not connect to postgres://u:***@h:5432'],
    // 一行里的两个连接串：第一个的密码也必须遮掉（带斜杠的也一样）
    [
      'postgres://a:1/x@h1/db and postgres://b:2/y@h2/db',
      'postgres://a:***@h1/db and postgres://b:***@h2/db',
    ],
    // 跨行的两个连接串：每行各自处理，不会把两行吃成一个
    [
      'line1 postgres://a:1@h1/db\nline2 postgres://b:2@h2/db',
      'line1 postgres://a:***@h1/db\nline2 postgres://b:***@h2/db',
    ],
    ['postgres://a:p/w@h1/db\npostgres://b:q/r@h2/db', 'postgres://a:***@h1/db\npostgres://b:***@h2/db'],
    // conninfo 写法
    ['host=h password=hunter2 user=u', 'host=h password=*** user=u'],
    ["password = 'a b' dbname=x", 'password = *** dbname=x'],
  ])('%s', (input, expected) => {
    expect(scrubSecrets(input)).toBe(expected);
  });

  test('密码里有 @ 时，host 前面的密码部分不会残留', () => {
    const out = scrubSecrets('postgres://dowel:p@ss@db:5432/shop');
    expect(out).not.toContain('ss@db');
    expect(out).not.toContain('p@ss');
    expect(out).toContain('@db:5432/shop');
  });
});

describe('maskUrl / scrubUrl 复用 scrubSecrets', () => {
  test('maskUrl：能解析的和 scrubSecrets 结果一致；查询串里的 @ 不受影响；无法解析的给提示', () => {
    expect(maskUrl('postgres://app:pw@db.internal:5432/shop?application_name=dowel@ci')).toBe(
      'postgres://app:***@db.internal:5432/shop?application_name=dowel@ci',
    );
    expect(maskUrl('postgres://db:5432/shop?options=a@b')).toBe('postgres://db:5432/shop?options=a@b');
    for (const url of [
      'postgres://u:pw@h:5432/db',
      'postgres://dowel:p@ss@db:5432/shop',
      'postgresql://u@h/db',
    ]) {
      expect(maskUrl(url)).toBe(scrubSecrets(url));
    }
    expect(maskUrl('postgres://u:p%40ss@h:5432/db')).toBe('postgres://u:***@h:5432/db');
    expect(maskUrl('不是连接串')).toBe('（无效的连接串）');
    // 回归：密码里有空格 / 没编码的 / 时，maskUrl 也不能泄露（能解析的用 URL.password 遮；解析不了的不原样显示）
    expect(maskUrl('postgres://u:p w@h/db')).toBe('postgres://u:***@h/db');
    expect(maskUrl('postgres://u:ab/cd@h/db')).toBe('（无效的连接串）');
    for (const url of ['postgres://u:p w@h/db', 'postgres://u:ab/cd@h/db', 'postgres://dowel:p@ss@db/shop'])
      expect(maskUrl(url)).not.toMatch(/p w|ab\/cd|p@ss|\bpw\b/);
  });

  test('scrubUrl：密码含非法百分号转义时，单独出现的原样密码仍然遮掉', () => {
    const url = 'postgres://u:p%zz@h:5432/db';
    expect(scrubUrl('auth failed for password p%zz', url)).toBe('auth failed for password ***');
  });

  test('scrubUrl：密码里有空格时（scrubSecrets 不覆盖），已知连接串和单独的密码照样遮掉', () => {
    const url = 'postgres://u:p w@h/db';
    const out = scrubUrl(`connect ${url} failed`, url);
    expect(out).not.toContain('p w');
    expect(out).not.toContain('p%20w');
  });

  test('scrubUrl：消息里的整串连接串、单独出现的密码都遮掉', () => {
    const url = 'postgres://u:pw1234@h:5432/db';
    expect(scrubUrl(`connect ${url} failed: password pw1234 wrong`, url)).toBe(
      'connect postgres://u:***@h:5432/db failed: password *** wrong',
    );
  });
});
