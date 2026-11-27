// 数据库连接串与结构化字段双向同步单测：覆盖 4 种方言、特殊字符密码、IPv6 与半截输入保护。
import { describe, expect, test } from 'vitest';

import { emptyDbUrlFields, formatDbUrl, parseDbUrl } from '../src/db-url.ts';

describe('parseDbUrl 与 formatDbUrl', () => {
  test('PostgreSQL 连接串：postgres://、postgresql://、无端口与查询参数往返无损', () => {
    const standard = 'postgres://app_user:secret@db.example.com:5432/orders?sslmode=require';
    const f1 = parseDbUrl(standard, 'pg');
    expect(f1).toEqual({
      scheme: 'postgres',
      user: 'app_user',
      password: 'secret',
      host: 'db.example.com',
      port: '5432',
      database: 'orders',
      params: 'sslmode=require',
      filePath: '',
    });
    expect(formatDbUrl(f1!, 'pg')).toBe(standard);

    const alt = 'postgresql://readonly@db.internal/analytics';
    const f2 = parseDbUrl(alt, 'pg');
    expect(f2?.scheme).toBe('postgresql');
    expect(f2?.port).toBe('');
    expect(f2?.password).toBe('');
    expect(formatDbUrl(f2!, 'pg')).toBe(alt);
  });

  test('MySQL 连接串：端口与 TLS 参数往返无损', () => {
    const url = 'mysql://root:pass@mysql.local:3306/shop?ssl-mode=REQUIRED';
    const fields = parseDbUrl(url, 'mysql');
    expect(fields).toEqual({
      scheme: 'mysql',
      user: 'root',
      password: 'pass',
      host: 'mysql.local',
      port: '3306',
      database: 'shop',
      params: 'ssl-mode=REQUIRED',
      filePath: '',
    });
    expect(formatDbUrl(fields!, 'mysql')).toBe(url);
  });

  test('SQL Server 连接串：mssql://、sqlserver://、host\\instance 与查询参数保留反斜杠', () => {
    const url =
      'sqlserver://sa:Strong!Pass@win-host\\SQLEXPRESS/ledger?encrypt=true&trustServerCertificate=true';
    const fields = parseDbUrl(url, 'mssql');
    expect(fields).toEqual({
      scheme: 'sqlserver',
      user: 'sa',
      password: 'Strong!Pass',
      host: 'win-host\\SQLEXPRESS',
      port: '',
      database: 'ledger',
      params: 'encrypt=true&trustServerCertificate=true',
      filePath: '',
    });
    expect(formatDbUrl(fields!, 'mssql')).toBe(url);
  });

  test('SQLite 连接串：sqlite:///绝对路径与含空格路径往返无损，缺前导斜杠时自动补齐', () => {
    const url = 'sqlite:///var/lib/dowel/my%20app.db';
    const fields = parseDbUrl(url, 'sqlite');
    expect(fields?.filePath).toBe('/var/lib/dowel/my app.db');
    expect(formatDbUrl(fields!, 'sqlite')).toBe(url);

    const noLeadingSlash = { ...emptyDbUrlFields('sqlite'), filePath: 'data/app.db' };
    expect(formatDbUrl(noLeadingSlash, 'sqlite')).toBe('sqlite:///data/app.db');
  });

  test('密码含 @ : / # ? % 等保留字符时编码与解码往返无损', () => {
    const base = {
      ...emptyDbUrlFields('pg'),
      host: 'localhost',
      port: '5432',
      database: 'my db',
      user: 'u:1@corp',
      password: 'p@ss:1/2?3#4%5',
    };
    const url = formatDbUrl(base, 'pg');
    expect(url).toBe('postgres://u%3A1%40corp:p%40ss%3A1%2F2%3F3%234%255@localhost:5432/my%20db');
    expect(parseDbUrl(url, 'pg')).toEqual(base);
  });

  test('IPv6 主机与端口往返无损', () => {
    const url = 'postgres://user:pw@[::1]:5432/app';
    const fields = parseDbUrl(url, 'pg');
    expect(fields?.host).toBe('::1');
    expect(fields?.port).toBe('5432');
    expect(formatDbUrl(fields!, 'pg')).toBe(url);
  });

  test('空串清空全部字段，半截或协议不匹配连接串返回 null 且不抛错', () => {
    expect(parseDbUrl('   ', 'pg')).toEqual(emptyDbUrlFields('pg'));
    expect(formatDbUrl(emptyDbUrlFields('pg'), 'pg')).toBe('');
    expect(formatDbUrl(emptyDbUrlFields('sqlite'), 'sqlite')).toBe('');

    expect(parseDbUrl('postgres', 'pg')).toBeNull();
    expect(parseDbUrl('mysql://localhost:3306/db', 'pg')).toBeNull();
    expect(parseDbUrl('postgres://[::1/db', 'pg')).toBeNull();
    expect(parseDbUrl('sqlite:///data/app.db?foo=bar', 'sqlite')).toBeNull();
    expect(parseDbUrl('postgres://%E0%A4%A@localhost/db', 'pg')).not.toBeNull();
  });
});
