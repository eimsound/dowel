// UUIDv7：前 48 位是毫秒时间戳，按创建时间有序。
export const newId = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/**
 * Object.prototype 上的属性名（constructor、toString、__proto__ 等）不能当对象 ID：
 * 模型对象表是普通对象，这些名字会和继承属性混淆，__proto__ 还会改写原型。
 */
export const isReservedId = (id: string): boolean => id in Object.prototype;
