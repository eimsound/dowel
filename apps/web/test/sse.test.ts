// SSE 帧解析：多行 data、CRLF、注释、结尾没有空行的最后一帧、分块边界
import { describe, expect, test } from 'vitest';

import { parseSseFrame, readSse } from '../src/sse.ts';

const responseOf = (chunks: string[]) => {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const x of chunks) c.enqueue(enc.encode(x));
        c.close();
      },
    }),
  );
};
const read = async (chunks: string[]) => {
  const out: string[] = [];
  await readSse(responseOf(chunks), (d) => out.push(d));
  return out;
};

describe('parseSseFrame', () => {
  test('data 冒号后的空格可有可无；其他字段和注释忽略', () => {
    expect(parseSseFrame('data: {"a":1}')).toBe('{"a":1}');
    expect(parseSseFrame('data:{"a":1}')).toBe('{"a":1}');
    expect(parseSseFrame('event: x\nid: 3\ndata: y')).toBe('y');
    expect(parseSseFrame(': keep-alive')).toBeNull();
    expect(parseSseFrame('event: ping')).toBeNull();
  });
  test('多行 data 用换行连起来', () => {
    expect(parseSseFrame('data: a\ndata: b\ndata:\ndata:  c')).toBe('a\nb\n\n c');
  });
});

describe('readSse', () => {
  test('按空行分帧；一个事件被切成多块也能拼起来', async () => {
    expect(await read(['data: {"s":"a"}\n\ndata: {"s', '":"b"}\n\n'])).toEqual(['{"s":"a"}', '{"s":"b"}']);
  });
  test('CRLF 和 CR 换行；CRLF 被切在两块之间', async () => {
    expect(await read(['data: 1\r\n\r\ndata: 2\r', '\n\r\ndata: 3\r\r'])).toEqual(['1', '2', '3']);
  });
  test('多行 data 合成一条', async () => {
    expect(await read(['data: {"a":\ndata: 1}\n\n'])).toEqual(['{"a":\n1}']);
  });
  test('结尾缓冲没有空行的最后一帧也要处理', async () => {
    expect(await read(['data: 1\n\ndata: 2'])).toEqual(['1', '2']);
  });
  test('注释（心跳）不产生事件；多字节字符被切开也不乱码', async () => {
    const bytes = new TextEncoder().encode('data: 你好\n\n');
    const mid = bytes.length - 6;
    const res = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(': hb\n\n'));
          c.enqueue(bytes.slice(0, mid));
          c.enqueue(bytes.slice(mid));
          c.close();
        },
      }),
    );
    const out: string[] = [];
    await readSse(res, (d) => out.push(d));
    expect(out).toEqual(['你好']);
  });
});
