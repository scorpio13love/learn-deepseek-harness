/**
 * 应用授权（s20 版本）。
 *
 * 真实 DSH 的授权状态比这里复杂得多：`CuaApplicationGrant`、
 * 持久授权（profile storage）与会话授权分开、拒绝记录、撤销代际……
 * 本课先实现「未授权拒绝」这一条主干，s21 再拆持久/会话两级。
 */

import { CuaError } from './types.ts'

export class ApplicationAccess {
  private readonly granted = new Set<string>()

  /** 允许某应用；重复授权幂等。 */
  grant(appId: string): void {
    if (typeof appId !== 'string' || appId.length === 0) {
      throw new CuaError('INVALID_ARGUMENT', 'appId must be a non-empty string')
    }
    this.granted.add(appId)
  }

  /** 撤销授权；返回撤销前是否已授权。 */
  revoke(appId: string): boolean {
    return this.granted.delete(appId)
  }

  isGranted(appId: string): boolean {
    return this.granted.has(appId)
  }

  /** 已授权应用列表（排序后，便于断言）。 */
  list(): readonly string[] {
    return [...this.granted].sort()
  }

  /** 在任何 AX 读取、截图或输入之前调用；拒绝时 fail closed。 */
  require(appId: string): void {
    if (!this.granted.has(appId)) {
      throw new CuaError(
        'APP_ACCESS_REQUIRED',
        `application "${appId}" is not authorized; ask the user before reading or controlling it`,
      )
    }
  }
}
