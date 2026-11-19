// 读 SSE（text/event-stream）响应：新建项目向导和执行进度共用。
// 按 SSE 规范解析一帧：行以 LF / CRLF / CR 结尾，空行结束一帧；`data:` 行可以有多行（用换行连起来），
// 冒号后的一个空格可有可无，以冒号开头的行是注释（心跳），其他字段忽略。流结束时缓冲里没有以空行结尾的最后一帧也要处理。

/** 解析一帧（不含结尾的空行），返回 data 字段的内容；没有 data（注释 / 其他字段）返回 null */
export const parseSseFrame = (frame: string): string | null => {
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length ? data.join('\n') : null;
};

/** 逐帧读响应体，对每帧的 data 调用 onData（先 JSON.parse 由调用方做，这里给字符串） */
export const readSse = async (res: Response, onData: (data: string) => void): Promise<void> => {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const flush = (final: boolean) => {
    // 统一换行：CRLF / CR → LF。末尾的 CR 可能是 CRLF 被切开的前半，流没结束时先留着
    buf = buf.replace(/\r\n/g, '\n');
    if (!final && buf.endsWith('\r')) {
      const keep = buf.slice(-1);
      buf = buf.slice(0, -1).replace(/\r/g, '\n') + keep;
    } else buf = buf.replace(/\r/g, '\n');
    const frames = buf.split('\n\n');
    buf = final ? '' : (frames.pop() ?? '');
    for (const f of frames) {
      const data = parseSseFrame(f);
      if (data !== null) onData(data);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    flush(false);
  }
  buf += decoder.decode(); // 解码器里残留的字节
  flush(true); // 最后一帧没有以空行结尾也要处理
};
