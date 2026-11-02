/**
 * s18 的输入路由：命令走 host，普通文本才进入 agent。
 *
 * 这是“slash command 不产生模型轮次”的可测试边界：把 model turn 计数
 * 放在 AgentLike 上，命令路径永远不应该调用它。
 */

import type { CommandRegistry } from './commands/registry.ts'

export interface AgentLike {
  run(prompt: string): Promise<string>
}

export interface RouteResult {
  kind: 'command' | 'turn'
  output: string
  /** 是否真的启动了一次模型轮次。 */
  modelTurn: boolean
}

export async function routeInput(
  input: string,
  options: { commands: CommandRegistry; agent: AgentLike },
): Promise<RouteResult> {
  const dispatched = await options.commands.dispatch(input)
  if (dispatched.handled) {
    return {
      kind: 'command',
      output: dispatched.output ?? '',
      modelTurn: false,
    }
  }
  return {
    kind: 'turn',
    output: await options.agent.run(input),
    modelTurn: true,
  }
}
