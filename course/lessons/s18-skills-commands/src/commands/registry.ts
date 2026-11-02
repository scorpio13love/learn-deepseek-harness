/**
 * s18 的 slash command 注册表。
 *
 * 命令是确定性的 UI / host 操作：切换模型、压缩上下文、显示帮助。
 * 它们由 host 直接分派，**不产生模型轮次**，因此也不应该进入消息历史。
 */

export interface Command {
  name: string
  description: string
  run(args: string): string | Promise<string>
}

export interface CommandResult {
  /** 输入是否是命令（无论命令是否存在）。 */
  handled: boolean
  output?: string
}

export class CommandRegistry {
  #commands = new Map<string, Command>()

  register(command: Command): () => void {
    if (this.#commands.has(command.name)) {
      throw new Error(`command "${command.name}" is already registered`)
    }
    this.#commands.set(command.name, command)
    return () => {
      if (this.#commands.get(command.name) === command) this.#commands.delete(command.name)
    }
  }

  list(): Command[] {
    return [...this.#commands.values()]
  }

  /** 非 `/` 开头 → handled: false，交给 agent；`/` 开头 → host 直接处理。 */
  async dispatch(input: string): Promise<CommandResult> {
    if (!input.startsWith('/')) return { handled: false }
    const match = /^\/([A-Za-z0-9_-]+)\s*([\s\S]*)$/.exec(input)
    if (match === null) return { handled: true, output: 'invalid command' }
    const command = this.#commands.get(match[1]!)
    if (command === undefined) return { handled: true, output: `unknown command: /${match[1]}` }
    return { handled: true, output: await command.run(match[2] ?? '') }
  }
}
