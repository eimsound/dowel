/** 编辑操作不合法（对象不存在、名字冲突、违反约束等）。同步层据此拒绝修改，而不是当作程序错误 */
export class EditError extends Error {}
